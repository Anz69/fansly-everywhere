import { scryptSync, randomBytes, timingSafeEqual, createHmac } from "crypto";
import { logger } from "./logger.js";

// In-memory fallback (for current session, wiped on restart)
const adminSessions = new Map<string, number>();

function deriveSalt(): string {
  return ((process.env.SESSION_SECRET || "fallback-admin-salt")).slice(0, 32).padEnd(32, "0");
}

export function hashAdminPassword(password: string): string {
  const salt = deriveSalt();
  return scryptSync(password, salt, 32).toString("hex");
}

export function verifyAdminPassword(password: string, expectedHash: string): boolean {
  try {
    const hash = Buffer.from(hashAdminPassword(password), "hex");
    const expected = Buffer.from(expectedHash, "hex");
    if (hash.length !== expected.length) return false;
    return timingSafeEqual(hash, expected);
  } catch {
    return false;
  }
}

// ─── Stateless signed tokens (survive PM2 restarts) ──────────────────────────

function signData(expiry: number): string {
  const data = Buffer.from(String(expiry)).toString("base64url");
  const secret = process.env.SESSION_SECRET || "fallback-admin-secret";
  const sig = createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${sig}`;
}

function verifySignedToken(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [data, sig] = parts;
  try {
    const secret = process.env.SESSION_SECRET || "fallback-admin-secret";
    const expectedSig = createHmac("sha256", secret).update(data).digest("base64url");
    const sigBuf = Buffer.from(sig, "base64url");
    const expSigBuf = Buffer.from(expectedSig, "base64url");
    if (sigBuf.length !== expSigBuf.length) return false;
    if (!timingSafeEqual(sigBuf, expSigBuf)) return false;
    const expiry = parseInt(Buffer.from(data, "base64url").toString(), 10);
    return !isNaN(expiry) && expiry > Date.now();
  } catch {
    return false;
  }
}

export function createAdminSession(): string {
  const expiry = Date.now() + 24 * 60 * 60 * 1000; // 24h
  const token = signData(expiry);
  // Also keep in-memory for immediate isValidAdminSession check
  adminSessions.set(token, expiry);
  // Cleanup stale in-memory entries
  for (const [t, exp] of adminSessions) {
    if (exp < Date.now()) adminSessions.delete(t);
  }
  return token;
}

export function isValidAdminSession(token: string | undefined): boolean {
  if (!token) return false;
  // 1. Check signed token (stateless — survives restarts)
  if (token.includes(".") && verifySignedToken(token)) return true;
  // 2. Fallback: check in-memory (legacy tokens from old format)
  const exp = adminSessions.get(token);
  if (!exp || exp < Date.now()) {
    if (exp) adminSessions.delete(token);
    return false;
  }
  return true;
}

export function deleteAdminSession(token: string | undefined): void {
  if (token) adminSessions.delete(token);
  // Signed tokens are stateless — they expire by time; nothing to delete from DB.
  // The cookie will be cleared by the caller.
}

// On startup: generate password if ADMIN_PASSWORD_HASH not set
export function initAdminPassword(): void {
  if (!process.env.ADMIN_PASSWORD_HASH) {
    const pwd = randomBytes(12).toString("base64url");
    const hash = hashAdminPassword(pwd);
    process.env.ADMIN_PASSWORD_HASH = hash;
    logger.warn({ pwd, hash: hash.slice(0, 16) + "..." },
      "ADMIN_PASSWORD_HASH not set — generated one-time password (set it in .env to persist)");
  }
}
