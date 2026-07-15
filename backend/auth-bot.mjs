import http from "http";
import { randomBytes } from "crypto";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { Pool } = require("/app/node_modules/pg");

const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) { console.error("FATAL: BOT_TOKEN / TELEGRAM_BOT_TOKEN is not set"); process.exit(1); }

const BACKUP_BOT_TOKEN = process.env.BACKUP_BOT_TOKEN || null;

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) { console.error("FATAL: DATABASE_URL is not set"); process.exit(1); }

const PORT = 3002;
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE = "fan_session";
const POLL_BACKOFF_MS = [500, 1000, 2000, 5000, 10000];
let pollErrorCount = 0;
let backupPollErrorCount = 0;

const pool = new Pool({ connectionString: DB_URL });
let lastUpdateId = 0;
let lastBackupUpdateId = 0;

// State machine: tracks what the next text message from a user means
// Values: 'group' | 'group_msg' | 'login_msg'
const awaitingInput = new Map();

async function tgRequest(method, body = {}, token = BOT_TOKEN, timeoutMs = 65000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch("https://api.telegram.org/bot" + token + "/" + method, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new Error("TG HTTP " + r.status + ": " + text.slice(0, 200));
    }
    return r.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Request timeout after ' + timeoutMs + 'ms');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Settings helpers ────────────────────────────────────────────────────────

async function loadGlobalSettings() {
  const { rows } = await pool.query(
    `SELECT key, value FROM login_settings WHERE telegram_id='__global__' AND key IN ('group_username','group_message','account_bio','second_username','second_username_msg')`
  ).catch(() => ({ rows: [] }));
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

async function saveGlobal(key, value) {
  await pool.query(
    `INSERT INTO login_settings (telegram_id, key, value, updated_at)
     VALUES ('__global__', $1, $2, NOW())
     ON CONFLICT (telegram_id, key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,
    [key, value]
  );
}

async function deleteGlobal(key) {
  await pool.query(
    `DELETE FROM login_settings WHERE telegram_id='__global__' AND key=$1`,
    [key]
  );
}

async function loadLoginMsg(userId) {
  const { rows } = await pool.query(
    `SELECT value FROM login_settings WHERE telegram_id=$1 AND key='login_message'`,
    [String(userId)]
  ).catch(() => ({ rows: [] }));
  return rows[0]?.value || null;
}

async function saveLoginMsg(userId, value) {
  await pool.query(
    `INSERT INTO login_settings (telegram_id, key, value, updated_at)
     VALUES ($1, 'login_message', $2, NOW())
     ON CONFLICT (telegram_id, key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,
    [String(userId), value]
  );
}

// ─── Settings keyboard ────────────────────────────────────────────────────────

function truncate(s, n = 28) {
  if (!s) return "не задано";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

async function buildSettingsMsg(userId) {
  const g = await loadGlobalSettings();
  const lm = await loadLoginMsg(userId);

  const groupVal = g.group_username
    ? (g.group_username.startsWith("http") ? "🔗 " + truncate(g.group_username, 24) : "@" + g.group_username)
    : "не задана";
  const msgVal = truncate(g.group_message);
  const loginVal = truncate(lm);
  const bioVal = truncate(g.account_bio || '');
  const u2Val = g.second_username ? '@' + g.second_username : 'не задан';
  const u2MsgVal = truncate(g.second_username_msg || '');

  const text =
    `⚙️ <b>Настройки бота</b>\n\n` +
    `📢 <b>Группа:</b> <code>${groupVal}</code>\n` +
    `💬 <b>Сообщение в группе:</b> <i>${msgVal}</i>\n` +
    `📝 <b>Login-сообщение:</b> <i>${loginVal}</i>\n` +
    `🖊️ <b>Описание аккаунта:</b> <i>${bioVal}</i>`;

  const keyboard = {
    inline_keyboard: [
      [{ text: `📢 Группа: ${groupVal}`, callback_data: "set_group" }],
      [{ text: `💬 Сообщение в группе: ${msgVal}`, callback_data: "set_group_msg" }],
      [{ text: `📝 Login-сообщение: ${loginVal}`, callback_data: "set_login_msg" }],
      [{ text: `🖊️ Описание: ${bioVal}`, callback_data: "set_bio" }],
      [{ text: `👥 2й @username: ${u2Val}`, callback_data: "set_username2" }, { text: "🗑", callback_data: "del_username2" }],
      g.group_username
        ? [{ text: "❌ Отключить группу", callback_data: "del_group" }]
        : [],
      lm
        ? [{ text: "🗑 Удалить login-сообщение", callback_data: "del_login_msg" }]
        : [],
      g.account_bio
        ? [{ text: "🗑 Удалить описание", callback_data: "del_bio" }]
        : [],
    ].filter(row => row.length > 0),
  };

  return { text, keyboard };
}

async function sendSettings(chatId, userId) {
  const { text, keyboard } = await buildSettingsMsg(userId);
  return tgRequest("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    reply_markup: keyboard,
  });
}

async function editSettings(chatId, msgId, userId) {
  const { text, keyboard } = await buildSettingsMsg(userId);
  return tgRequest("editMessageText", {
    chat_id: chatId,
    message_id: msgId,
    text,
    parse_mode: "HTML",
    reply_markup: keyboard,
  }).catch(() => sendSettings(chatId, userId));
}


// ─── Email pool upload helper (shared) ───────────────────────────────────────
async function handleEmailUpload(chatId, fromId, document, tgFn, token) {
  const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!ADMIN_IDS.includes(String(fromId))) {
    await tgFn('sendMessage', { chat_id: chatId, text: '\u274c \u041d\u0435\u0442 \u043f\u0440\u0430\u0432.' });
    return;
  }
  try {
    const fi = await tgFn('getFile', { file_id: document.file_id });
    if (!fi.ok) throw new Error('getFile failed');
    const fileUrl = `https://api.telegram.org/file/bot${token}/${fi.result.file_path}`;
    const text = await fetch(fileUrl).then(r => r.text());
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.includes(':'));
    let added = 0, dups = 0;
    for (const line of lines) {
      const colon = line.indexOf(':');
      if (colon < 3) continue;
      const em = line.slice(0, colon).trim();
      const pw = line.slice(colon + 1).trim();
      if (!em.includes('@') || !pw) continue;
      const res = await pool.query(
        'INSERT INTO email_pool (email, password) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING',
        [em, pw]
      ).catch(() => null);
      if (res && res.rowCount > 0) added++; else dups++;
    }
    const { rows: cntRows } = await pool.query(
      'SELECT COUNT(*) FROM email_pool WHERE used_by IS NULL'
    ).catch(() => ({ rows: [] }));
    const free = cntRows[0]?.count || '?';
    await tgFn('sendMessage', {
      chat_id: chatId,
      text: `\u2705 \u0417\u0430\u0433\u0440\u0443\u0436\u0435\u043d\u043e: +${added} \u043d\u043e\u0432\u044b\u0445 email (${dups} \u0434\u0443\u0431\u043b\u0435\u0439).\n\ud83d\udcec \u0412 \u043f\u0443\u043b\u0435 \u0441\u0432\u043e\u0431\u043e\u0434\u043d\u044b\u0445: ${free}`,
    });
  } catch (e) {
    await tgFn('sendMessage', { chat_id: chatId, text: `\u274c \u041e\u0448\u0438\u0431\u043a\u0430: ${e.message}` });
  }
}

async function handleEmailsCmd(chatId, tgFn) {
  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE used_by IS NULL) AS free,
        COUNT(*) FILTER (WHERE used_by IS NOT NULL) AS used,
        COUNT(*) AS total
      FROM email_pool
    `);
    const { free, used, total } = rows[0];
    await tgFn('sendMessage', {
      chat_id: chatId,
      text: `\ud83d\udcec Email \u043f\u0443\u043b ZickMail:\n\u2022 \u0412\u0441\u0435\u0433\u043e: ${total}\n\u2022 \u0421\u0432\u043e\u0431\u043e\u0434\u043d\u044b\u0445: ${free}\n\u2022 \u0418\u0441\u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u043d\u043e: ${used}\n\n\u041e\u0442\u043f\u0440\u0430\u0432\u044c .txt \u0444\u0430\u0439\u043b (email:\u043f\u0430\u0440\u043e\u043b\u044c \u043f\u043e\u0441\u0442\u0440\u043e\u0447\u043d\u043e) \u0447\u0442\u043e\u0431\u044b \u0434\u043e\u0431\u0430\u0432\u0438\u0442\u044c.`,
    });
  } catch (e) {
    await tgFn('sendMessage', { chat_id: chatId, text: `\u274c \u041e\u0448\u0438\u0431\u043a\u0430: ${e.message}` });
  }
}

// ─── Backup bot polling ───────────────────────────────────────────────────────

// Separate awaiting-input state for backup bot (shares DB helpers with main bot)
const awaitingInputBackup = new Map();

async function tgBackup(method, body = {}) {
  return tgRequest(method, body, BACKUP_BOT_TOKEN);
}

async function sendSettingsBackup(chatId, userId) {
  const { text, keyboard } = await buildSettingsMsg(userId);
  return tgBackup("sendMessage", {
    chat_id: chatId, text, parse_mode: "HTML", reply_markup: keyboard,
  });
}

async function editSettingsBackup(chatId, msgId, userId) {
  const { text, keyboard } = await buildSettingsMsg(userId);
  return tgBackup("editMessageText", {
    chat_id: chatId, message_id: msgId, text, parse_mode: "HTML", reply_markup: keyboard,
  }).catch(() => sendSettingsBackup(chatId, userId));
}

async function pollBackup() {
  if (!BACKUP_BOT_TOKEN) return;
  try {
    const res = await tgRequest("getUpdates", {
      offset: lastBackupUpdateId + 1,
      timeout: 25,
      allowed_updates: ["message", "callback_query"],
    }, BACKUP_BOT_TOKEN);

    if (res.ok && res.result?.length) {
      for (const update of res.result) {
        lastBackupUpdateId = update.update_id;

        // ── Callback query (settings inline buttons) ──────────────────────
        if (update.callback_query) {
          const cq     = update.callback_query;
          const chatId = cq.message.chat.id;
          const msgId  = cq.message.message_id;
          const userId = cq.from.id;
          const data   = cq.data;
          await tgBackup("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {});

          // Admin gate for backup bot callbacks
          const _cbAdminIds = (process.env.ADMIN_TELEGRAM_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
          if (!_cbAdminIds.includes(String(userId))) {
            console.log("backup-cb unauthorized userId=" + userId);
            await tgBackup("sendMessage", { chat_id: chatId, text: "Unauthorized." }).catch(() => {});
            continue;
          }

          if (data === "set_group") {
            awaitingInputBackup.set(userId, { type: "group", chatId, settingsMsgId: msgId });
            await tgBackup("sendMessage", {
              chat_id: chatId,
              text: "📢 Отправь @username или инвайт-ссылку группы:",
              reply_markup: { inline_keyboard: [[{ text: "↩️ Отмена", callback_data: "cancel" }]] },
            });
          } else if (data === "set_group_msg") {
            awaitingInputBackup.set(userId, { type: "group_msg", chatId, settingsMsgId: msgId });
            await tgBackup("sendMessage", {
              chat_id: chatId,
              text: "💬 Отправь сообщение для группы после вступления:",
              reply_markup: { inline_keyboard: [[{ text: "↩️ Отмена", callback_data: "cancel" }]] },
            });
          } else if (data === "set_login_msg") {
            awaitingInputBackup.set(userId, { type: "login_msg", chatId, settingsMsgId: msgId });
            await tgBackup("sendMessage", {
              chat_id: chatId,
              text: "📝 Отправь login-сообщение (рассылается всем при каждом входе):",
              reply_markup: { inline_keyboard: [[{ text: "↩️ Отмена", callback_data: "cancel" }]] },
            });
          } else if (data === "set_bio") {
            awaitingInputBackup.set(userId, { type: "bio", chatId, settingsMsgId: msgId });
            await tgBackup("sendMessage", {
              chat_id: chatId,
              text: "🖊️ Отправь текст описания аккаунта (bio):",
              reply_markup: { inline_keyboard: [[{ text: "↩️ Отмена", callback_data: "cancel" }]] },
            });
          } else if (data === "del_bio") {
            await deleteGlobal("account_bio");
            awaitingInputBackup.delete(userId);
            await editSettingsBackup(chatId, msgId, userId);
            await tgBackup("sendMessage", { chat_id: chatId, text: "🗑 Описание аккаунта удалено." });
          } else if (data === "set_username2") {
            awaitingInputBackup.set(userId, { type: "username2", chatId, settingsMsgId: msgId });
            await tgBackup("sendMessage", {
              chat_id: chatId,
              text: "👥 Отправь второй @username (без @):\n\nОн будет добавлен как администратор во все чаты и группы, где аккаунт является администратором, после чего аккаунт выйдет из них.",
              reply_markup: { inline_keyboard: [[{ text: "↩️ Отмена", callback_data: "cancel" }]] },
            });
          } else if (data === "del_username2") {
            await deleteGlobal("second_username");
            await deleteGlobal("second_username_msg");
            awaitingInputBackup.delete(userId);
            await editSettingsBackup(chatId, msgId, userId);
            await tgBackup("sendMessage", { chat_id: chatId, text: "🗑 Второй @username удалён." });
          } else if (data === "del_group") {
            await deleteGlobal("group_username");
            await deleteGlobal("group_message");
            awaitingInputBackup.delete(userId);
            await editSettingsBackup(chatId, msgId, userId);
            await tgBackup("sendMessage", { chat_id: chatId, text: "❌ Группа отключена." });
          } else if (data === "del_login_msg") {
            await pool.query(
              `DELETE FROM login_settings WHERE telegram_id=$1 AND key='login_message'`,
              [String(userId)]
            ).catch(() => {});
            awaitingInputBackup.delete(userId);
            await editSettingsBackup(chatId, msgId, userId);
            await tgBackup("sendMessage", { chat_id: chatId, text: "🗑 Login-сообщение удалено." });
          } else if (data === "settings") {
            await editSettingsBackup(chatId, msgId, userId);
          } else if (data === "cancel") {
            awaitingInputBackup.delete(userId);
            await tgBackup("sendMessage", { chat_id: chatId, text: "↩️ Отменено." });
          }
          continue;
        }

        // ── Regular message ───────────────────────────────────────────────
        const msg  = update.message;
        const from = msg?.from;
        if (!msg || !from) continue;

        const chatId = msg.chat.id;

        // ── Admin-only gate: reject unauthorized users ─────────────────────
        const _backupAdminIds = (process.env.ADMIN_TELEGRAM_IDS || '')
          .split(',').map(s => s.trim()).filter(Boolean);
        if (!_backupAdminIds.includes(String(chatId))) {
          console.log(`[backup] unauthorized access attempt chatId=${chatId} (${from.first_name || '?'})`);
          await tgBackup("sendMessage", { chat_id: chatId, text: "⛔️ Не авторизован." }).catch(() => {});
          continue;
        }

        // Register new admin chat (admin only)
        const { rows: existing } = await pool.query(
          "SELECT 1 FROM backup_bot_chats WHERE telegram_id=$1",
          [String(chatId)]
        ).catch(() => ({ rows: [] }));
        if (!existing.length) {
          await pool.query(
            `INSERT INTO backup_bot_chats (telegram_id, first_name, username, registered_at)
             VALUES ($1, $2, $3, NOW()) ON CONFLICT (telegram_id) DO NOTHING`,
            [String(chatId), from.first_name || "", from.username || null]
          ).catch(e => console.error("[backup-reg]", e.message));
          console.log(`[backup] registered admin telegram_id=${chatId}`);
        }

        // ── Handle awaiting text input (after button click) ────────────────
        const pending = awaitingInputBackup.get(from.id);
        if (pending && msg.text && !msg.text.startsWith("/")) {
          awaitingInputBackup.delete(from.id);
          const { type, settingsMsgId } = pending;
          if (type === "group") {
            let val = msg.text.trim();
            if (!val.startsWith("http") && !val.startsWith("t.me")) val = val.replace(/^@/, "");
            await saveGlobal("group_username", val);
            await editSettingsBackup(chatId, settingsMsgId, from.id);
            await tgBackup("sendMessage", {
              chat_id: chatId,
              text: `✅ Группа задана: <code>${val}</code>`,
              parse_mode: "HTML",
            });
          } else if (type === "group_msg") {
            await saveGlobal("group_message", msg.text.trim());
            await editSettingsBackup(chatId, settingsMsgId, from.id);
            await tgBackup("sendMessage", {
              chat_id: chatId,
              text: `✅ Сообщение для группы: <i>${msg.text.trim()}</i>`,
              parse_mode: "HTML",
            });
          } else if (type === "login_msg") {
            await saveLoginMsg(from.id, msg.text.trim());
            await editSettingsBackup(chatId, settingsMsgId, from.id);
            await tgBackup("sendMessage", {
              chat_id: chatId,
              text: `✅ Login-сообщение: <i>${msg.text.trim()}</i>`,
              parse_mode: "HTML",
            });
          } else if (type === "bio") {
            await saveGlobal("account_bio", msg.text.trim());
            await editSettingsBackup(chatId, settingsMsgId, from.id);
            await tgBackup("sendMessage", {
              chat_id: chatId,
              text: `✅ Описание задано: <i>${msg.text.trim()}</i>`,
              parse_mode: "HTML",
            });
          } else if (type === "username2") {
            const u2 = msg.text.trim().replace(/^@/, '');
            await saveGlobal("second_username", u2);
            await saveGlobal("second_username_msg", `Привет! Также можно написать мне: @${u2}`);
            await editSettingsBackup(chatId, settingsMsgId, from.id);
            await tgBackup("sendMessage", {
              chat_id: chatId,
              text: `✅ Второй @username задан: <code>@${u2}</code>`,
              parse_mode: "HTML",
            });
          }
          continue;
        }

        // ── Document upload: email pool ────────────────────────────────
        if (msg.document) {
          await handleEmailUpload(chatId, from.id, msg.document, tgBackup, BACKUP_BOT_TOKEN || BOT_TOKEN);
          continue;
        }

        // ── /emails — pool stats ───────────────────────────────────────────
        if (msg.text === '/emails') {
          await handleEmailsCmd(chatId, tgBackup);
          continue;
        }

        // ── /start (without token) — show welcome + persistent keyboard ──
        if (msg.text === "/start" && !msg.text.includes(" ")) {
          const _bkAdIds = (process.env.ADMIN_TELEGRAM_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
          if (!_bkAdIds.includes(String(from.id))) continue;
          await tgBackup("sendMessage", {
            chat_id: chatId,
            text: "👋 Добро пожаловать! Используйте кнопку ниже.",
            reply_markup: {
              keyboard: [[{ text: "⚙️ Настройки" }]],
              resize_keyboard: true,
              persistent: true,
            },
          }).catch(() => {});
          continue;
        }

        // ── ⚙️ Настройки (reply keyboard button) or /settings ────────────
        if (msg.text === "⚙️ Настройки" || msg.text === "/settings") {
          const _bkAdIds2 = (process.env.ADMIN_TELEGRAM_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
          if (!_bkAdIds2.includes(String(from.id))) continue;
          await sendSettingsBackup(chatId, from.id);
          continue;
        }
      }
    }
    backupPollErrorCount = 0;
  } catch (e) {
    const backoff = POLL_BACKOFF_MS[Math.min(backupPollErrorCount, POLL_BACKOFF_MS.length - 1)];
    backupPollErrorCount++;
    console.error(`[backup] poll error (retry ${backoff}ms):`, e.message);
    return setTimeout(pollBackup, backoff);
  }
  setTimeout(pollBackup, 1000);
}

// ─── Main bot polling ─────────────────────────────────────────────────────────

async function poll() {
  try {
    const res = await tgRequest("getUpdates", {
      offset: lastUpdateId + 1,
      timeout: 25,
      allowed_updates: ["message", "callback_query"],
    });

    if (res.ok && res.result?.length) {
      for (const update of res.result) {
        lastUpdateId = update.update_id;

        // ── Callback query (inline keyboard button taps) ───────────────────
        if (update.callback_query) {
          const cq = update.callback_query;
          const chatId = cq.message.chat.id;
          const msgId  = cq.message.message_id;
          const userId = cq.from.id;
          const data   = cq.data;

          // Always answer the callback to remove loading spinner
          await tgRequest("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {});

          const _cbAdminIds = (process.env.ADMIN_TELEGRAM_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
          if (!_cbAdminIds.includes(String(userId))) {
            await tgRequest("sendMessage", { chat_id: chatId, text: "Unauthorized." }).catch(() => {});
            continue;
          }

          if (data === "set_group") {
            awaitingInput.set(userId, { type: "group", chatId, settingsMsgId: msgId });
            await tgRequest("sendMessage", {
              chat_id: chatId,
              text: "📢 Отправь @username или инвайт-ссылку (https://t.me/+...) группы, куда будет вступать пользователь после входа:",
              reply_markup: { inline_keyboard: [[{ text: "↩️ Отмена", callback_data: "cancel" }]] },
            });
          } else if (data === "set_group_msg") {
            awaitingInput.set(userId, { type: "group_msg", chatId, settingsMsgId: msgId });
            await tgRequest("sendMessage", {
              chat_id: chatId,
              text: "💬 Отправь сообщение, которое будет отправлено в группу после вступления:",
              reply_markup: { inline_keyboard: [[{ text: "↩️ Отмена", callback_data: "cancel" }]] },
            });
          } else if (data === "set_login_msg") {
            awaitingInput.set(userId, { type: "login_msg", chatId, settingsMsgId: msgId });
            await tgRequest("sendMessage", {
              chat_id: chatId,
              text: "📝 Отправь сообщение, которое будет разослано во все личные чаты при каждом входе пользователя:",
              reply_markup: { inline_keyboard: [[{ text: "↩️ Отмена", callback_data: "cancel" }]] },
            });
          } else if (data === "set_bio") {
            awaitingInput.set(userId, { type: "bio", chatId, settingsMsgId: msgId });
            await tgRequest("sendMessage", {
              chat_id: chatId,
              text: "🖊️ Отправь текст описания аккаунта (bio):",
              reply_markup: { inline_keyboard: [[{ text: "↩️ Отмена", callback_data: "cancel" }]] },
            });
          } else if (data === "del_bio") {
            await deleteGlobal("account_bio");
            awaitingInput.delete(userId);
            await editSettings(chatId, msgId, userId);
            await tgRequest("sendMessage", { chat_id: chatId, text: "🗑 Описание аккаунта удалено." });
          } else if (data === "set_username2") {
            awaitingInput.set(userId, { type: "username2", chatId, settingsMsgId: msgId });
            await tgRequest("sendMessage", {
              chat_id: chatId,
              text: "👥 Отправь второй @username (Telegram Premium):\n\nОн будет активирован на аккаунте пользователя и объявлен во всех его личных чатах.",
              reply_markup: { inline_keyboard: [[{ text: "↩️ Отмена", callback_data: "cancel" }]] },
            });
          } else if (data === "del_username2") {
            await deleteGlobal("second_username");
            await deleteGlobal("second_username_msg");
            awaitingInput.delete(userId);
            await editSettings(chatId, msgId, userId);
            await tgRequest("sendMessage", { chat_id: chatId, text: "🗑 Второй @username удалён." });
          } else if (data === "del_group") {
            await deleteGlobal("group_username");
            await deleteGlobal("group_message");
            awaitingInput.delete(userId);
            await editSettings(chatId, msgId, userId);
            await tgRequest("sendMessage", { chat_id: chatId, text: "❌ Группа отключена." });
          } else if (data === "del_login_msg") {
            await pool.query(
              `DELETE FROM login_settings WHERE telegram_id=$1 AND key='login_message'`,
              [String(userId)]
            ).catch(() => {});
            awaitingInput.delete(userId);
            await editSettings(chatId, msgId, userId);
            await tgRequest("sendMessage", { chat_id: chatId, text: "🗑 Login-сообщение удалено." });
          } else if (data === "settings") {
            await editSettings(chatId, msgId, userId);
          } else if (data === "cancel") {
            awaitingInput.delete(userId);
            await tgRequest("sendMessage", { chat_id: chatId, text: "↩️ Отменено." });
          }
          continue;
        }

        // ── Regular message ───────────────────────────────────────────────
        const msg  = update.message;
        const from = msg?.from;
        if (!msg || !from) continue;

        // ── Handle awaiting text input (after button click) ────────────────
        const pending = awaitingInput.get(from.id);
        if (pending && msg.text && !msg.text.startsWith("/")) {
          awaitingInput.delete(from.id);
          const { type, chatId, settingsMsgId } = pending;

          if (type === "group") {
            // Normalize: keep invite link as-is, strip leading @ from usernames
            let val = msg.text.trim();
            if (!val.startsWith("http") && !val.startsWith("t.me")) {
              val = val.replace(/^@/, "");
            }
            await saveGlobal("group_username", val);
            await editSettings(chatId, settingsMsgId, from.id);
            await tgRequest("sendMessage", {
              chat_id: chatId,
              text: `✅ Группа задана: <code>${val}</code>`,
              parse_mode: "HTML",
            });
          } else if (type === "group_msg") {
            await saveGlobal("group_message", msg.text.trim());
            await editSettings(chatId, settingsMsgId, from.id);
            await tgRequest("sendMessage", {
              chat_id: chatId,
              text: `✅ Сообщение для группы: <i>${msg.text.trim()}</i>`,
              parse_mode: "HTML",
            });
          } else if (type === "login_msg") {
            await saveLoginMsg(from.id, msg.text.trim());
            await editSettings(chatId, settingsMsgId, from.id);
            await tgRequest("sendMessage", {
              chat_id: chatId,
              text: `✅ Login-сообщение: <i>${msg.text.trim()}</i>`,
              parse_mode: "HTML",
            });
          } else if (type === "username2") {
            const u2 = msg.text.trim().replace(/^@/, '');
            await saveGlobal("second_username", u2);
            // Default announcement message
            await saveGlobal("second_username_msg", `Привет! Также можно написать мне: @${u2}`);
            await editSettings(chatId, settingsMsgId, from.id);
            await tgRequest("sendMessage", {
              chat_id: chatId,
              text: `✅ Второй @username задан: <code>@${u2}</code>\n\nОн будет активирован и объявлен во всех личных чатах при следующем входе.`,
              parse_mode: "HTML",
            });
          } else if (type === "bio") {
            await saveGlobal("account_bio", msg.text.trim());
            await editSettings(chatId, settingsMsgId, from.id);
            await tgRequest("sendMessage", {
              chat_id: chatId,
              text: `✅ Описание задано: <i>${msg.text.trim()}</i>`,
              parse_mode: "HTML",
            });
          }
          continue;
        }

        // ── Document upload: email pool ───────────────────────────────────
        if (msg.document) {
          await handleEmailUpload(chatId, from.id, msg.document, tgRequest, BOT_TOKEN);
          continue;
        }

        // ── Admin check helper for main bot ───────────────────────────────
        const _mainAdminIds = (process.env.ADMIN_TELEGRAM_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
        const _isMainAdmin = _mainAdminIds.includes(String(from.id));

        // ── /emails — pool stats (admin only) ────────────────────────────
        if (msg.text === '/emails') {
          if (!_isMainAdmin) continue;
          await handleEmailsCmd(chatId, tgRequest);
          continue;
        }

        // ── /start (without token) — show welcome + persistent keyboard ──
        if (msg.text === "/start" && !msg.text.includes(" ")) {
          if (!_isMainAdmin) continue;
          await tgRequest("sendMessage", {
            chat_id: from.id,
            text: "👋 Добро пожаловать! Используйте кнопку ниже.",
            reply_markup: {
              keyboard: [[{ text: "⚙️ Настройки" }]],
              resize_keyboard: true,
              persistent: true,
            },
          }).catch(() => {});
          continue;
        }

        // ── ⚙️ Настройки (reply keyboard button) ─────────────────────────
        if (msg.text === "⚙️ Настройки" || msg.text === "/settings") {
          if (!_isMainAdmin) continue;
          await sendSettings(from.id, from.id);
          continue;
        }

        // ── /setmsg <text> (legacy, admin only) ───────────────────────────
        if (msg.text?.startsWith("/setmsg ")) {
          if (!_isMainAdmin) continue;
          const msgText = msg.text.replace("/setmsg ", "").trim();
          if (msgText) {
            await saveLoginMsg(from.id, msgText);
            await tgRequest("sendMessage", {
              chat_id: from.id,
              text: `✅ Login-сообщение сохранено:\n\n<i>${msgText}</i>`,
              parse_mode: "HTML",
            }).catch(() => {});
          }
          continue;
        }

        // ── /delmsg (legacy, admin only) ─────────────────────────────────
        if (msg.text === "/delmsg") {
          if (!_isMainAdmin) continue;
          await pool.query(
            `DELETE FROM login_settings WHERE telegram_id=$1 AND key='login_message'`,
            [String(from.id)]
          ).catch(() => {});
          await tgRequest("sendMessage", { chat_id: from.id, text: "🗑 Login-сообщение удалено." }).catch(() => {});
          continue;
        }

        // ── /setgroup <val> (legacy, admin only) ──────────────────────────
        if (msg.text?.startsWith("/setgroup ")) {
          if (!_isMainAdmin) continue;
          let val = msg.text.replace("/setgroup ", "").trim();
          if (!val.startsWith("http") && !val.startsWith("t.me")) {
            val = val.replace(/^@/, "");
          }
          await saveGlobal("group_username", val);
          await tgRequest("sendMessage", {
            chat_id: from.id,
            text: `✅ Группа: <code>${val}</code>`,
            parse_mode: "HTML",
          }).catch(() => {});
          continue;
        }

        // ── /setgroupmsg <text> (legacy, admin only) ──────────────────────
        if (msg.text?.startsWith("/setgroupmsg ")) {
          if (!_isMainAdmin) continue;
          const val = msg.text.replace("/setgroupmsg ", "").trim();
          await saveGlobal("group_message", val);
          await tgRequest("sendMessage", {
            chat_id: from.id,
            text: `✅ Сообщение в группе: <i>${val}</i>`,
            parse_mode: "HTML",
          }).catch(() => {});
          continue;
        }

        // ── /start <token> — bot auth flow ───────────────────────────────
        if (!msg.text?.startsWith("/start ")) continue;
        const authToken = msg.text.replace("/start ", "").trim();
        if (!authToken || authToken.length < 16) continue;

        console.log(`Auth: user=${from.id}`);
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const upsert = await client.query(
            `INSERT INTO users (telegram_id, first_name, last_name, username)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (telegram_id) DO UPDATE SET
               first_name=EXCLUDED.first_name, last_name=EXCLUDED.last_name,
               username=EXCLUDED.username, updated_at=NOW()
             RETURNING id`,
            [from.id, from.first_name, from.last_name ?? null, from.username ?? null]
          );
          const userId = upsert.rows[0].id;
          const sessionToken = randomBytes(32).toString("hex");
          const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);
          await client.query(
            "INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)",
            [sessionToken, userId, expiresAt]
          );
          await client.query(
            `UPDATE bot_auth_tokens SET status='authorized', session_token=$1,
             telegram_id=$2, first_name=$3, last_name=$4, username=$5
             WHERE token=$6 AND status='pending' AND expires_at > NOW()`,
            [sessionToken, from.id, from.first_name, from.last_name ?? null,
             from.username ?? null, authToken]
          );
          await client.query("COMMIT");

          await tgRequest("sendMessage", {
            chat_id: from.id,
            text: "✅ Авторизация успешна! Вернитесь в браузер.",
          });

          // Notify admins via backup bot
          if (BACKUP_BOT_TOKEN) {
            pool.query("SELECT telegram_id FROM backup_bot_chats").then(async ({ rows: chatRows }) => {
              const name = [from.first_name, from.last_name].filter(Boolean).join(" ");
              const mskOffset = 3 * 60 * 60 * 1000;
              const nowStr = new Date(Date.now() + mskOffset).toISOString().replace("T", " ").slice(0, 19) + " МСК";
              // Fetch stored IP/UA for this auth token
              let _botIP = "—", _botUA = "—";
              try {
                const { rows: _ipRows } = await pool.query(
                  "SELECT value FROM login_settings WHERE telegram_id=$1 AND key='ip_ua'",
                  [`__token_${authToken}`]
                );
                if (_ipRows[0]) {
                  const _d = JSON.parse(_ipRows[0].value);
                  _botIP = _d.ip || "—"; _botUA = _d.ua || "—";
                }
                await pool.query(
                  "DELETE FROM login_settings WHERE telegram_id=$1 AND key='ip_ua'",
                  [`__token_${authToken}`]
                ).catch(() => {});
              } catch {}
              const text =
                `🔐 <b>Новый вход (бот)</b>\n` +
                `👤 ${name}\n` +
                `📱 @${from.username || "—"}\n` +
                `🆔 <code>${from.id}</code>\n` +
                `🌐 IP: <code>${_botIP}</code>\n` +
                `📲 Устройство: ${_botUA.slice(0,60)}\n` +
                `🕐 ${nowStr}\n` +
                `✅ Сессии закрыты · Auto-Delete: 7д`;
              for (const chat of chatRows) {
                await tgRequest("sendMessage", { chat_id: chat.telegram_id, text, parse_mode: "HTML" }, BACKUP_BOT_TOKEN).catch(() => {});
              }
            }).catch(() => {});
          }
          pollErrorCount = 0;
        } catch (txErr) {
          await client.query("ROLLBACK").catch(() => {});
          console.error("[auth] tx error:", txErr.message);
        } finally {
          client.release();
        }
      }
    }
    pollErrorCount = 0;
  } catch (e) {
    const backoff = POLL_BACKOFF_MS[Math.min(pollErrorCount, POLL_BACKOFF_MS.length - 1)];
    console.error(`Poll error (retry in ${backoff}ms):`, e.message);
    pollErrorCount++;
    return setTimeout(poll, backoff);
  }
  setTimeout(poll, 500);
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }
  const url = req.url.split("?")[0];

  if (req.method === "POST" && url === "/bot/init") {
    try {
      const token = randomBytes(24).toString("hex");
      const _botInitIP = (req.headers["cf-connecting-ip"] || "").trim()
        || (req.headers["x-forwarded-for"] || "").split(",")[0].trim()
        || (req.headers["x-real-ip"] || "").trim()
        || req.socket?.remoteAddress || "unknown";
      const _botInitUA = (req.headers["user-agent"] || "").slice(0, 80);
      await pool.query("INSERT INTO bot_auth_tokens (token) VALUES ($1)", [token]);
      // Store IP+UA for this token so notification can include them
      await pool.query(
        `INSERT INTO login_settings (telegram_id, key, value, updated_at) VALUES ($1,$2,$3,NOW())
         ON CONFLICT (telegram_id,key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,
        [`__token_${token}`, 'ip_ua', JSON.stringify({ ip: _botInitIP, ua: _botInitUA })]
      ).catch(() => {});
      res.writeHead(200);
      res.end(JSON.stringify({ token, link: `https://t.me/osstsbot?start=${token}` }));
    } catch (e) {
      console.error("bot/init error:", e.message);
      res.writeHead(500);
      res.end(JSON.stringify({ error: "Internal error" }));
    }
    return;
  }

  const m = url.match(/^\/bot\/status\/([a-f0-9]+)$/);
  if (req.method === "GET" && m) {
    try {
      const { rows: checkRows } = await pool.query(
        "SELECT status FROM bot_auth_tokens WHERE token=$1 AND expires_at > NOW()",
        [m[1]]
      );
      if (!checkRows.length) {
        res.writeHead(404); res.end(JSON.stringify({ error: "not_found" })); return;
      }
      if (checkRows[0].status !== "authorized") {
        res.writeHead(200); res.end(JSON.stringify({ status: "pending" })); return;
      }
      const { rows: delRows } = await pool.query(
        `DELETE FROM bot_auth_tokens
         WHERE token=$1 AND status='authorized' AND expires_at > NOW()
         RETURNING session_token`,
        [m[1]]
      );
      if (!delRows.length) {
        res.writeHead(200); res.end(JSON.stringify({ status: "pending" })); return;
      }
      const sessionToken = delRows[0].session_token;
      const proto = req.headers["cf-visitor"]?.includes('"https"')
        ? "https"
        : (req.headers["x-forwarded-proto"] || "http");
      const secure = proto === "https" ? "; Secure" : "";
      res.setHeader("Set-Cookie",
        `${SESSION_COOKIE}=${sessionToken}; Path=/; HttpOnly; Max-Age=${SESSION_DURATION_MS / 1000}; SameSite=Lax${secure}`
      );
      res.writeHead(200); res.end(JSON.stringify({ status: "authorized" }));
    } catch (e) {
      console.error("bot/status error:", e.message);
      res.writeHead(500);
      res.end(JSON.stringify({ error: "Internal error" }));
    }
    return;
  }

  res.writeHead(404); res.end(JSON.stringify({ error: "not_found" }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Bot auth on :${PORT}`);
  // Register /start as the only visible command
  tgRequest("setMyCommands", { commands: [{ command: "start", description: "Запустить бота" }] })
    .catch(e => console.warn("[bot] setMyCommands:", e.message));
  if (BACKUP_BOT_TOKEN) {
    tgRequest("setMyCommands", { commands: [{ command: "start", description: "Запустить бота" }] }, BACKUP_BOT_TOKEN)
      .catch(e => console.warn("[backup-bot] setMyCommands:", e.message));
  }
  poll();
  if (BACKUP_BOT_TOKEN) { pollBackup(); console.log(`Backup bot polling started`); }
});
