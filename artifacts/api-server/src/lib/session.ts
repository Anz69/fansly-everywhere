import { createRequire } from 'module';
import type { Request } from 'express';

const _require = createRequire(import.meta.url);
const { Pool } = _require('pg');

let fanPool: any = null;
export function getPool() {
  if (fanPool) return fanPool;
  const url = process.env.FANDB_URL || process.env.DATABASE_URL;
  if (!url) return null;
  fanPool = new Pool({ connectionString: url });
  return fanPool;
}

export interface TelegramUser {
  id: number;
  telegramId: bigint;
  firstName: string;
  username: string | null;
  role: 'user' | 'admin';
  avatarUrl: string | null;
}

export async function getSessionUser(req: Request): Promise<TelegramUser | null> {
  const token = req.cookies?.['fan_session'];
  if (!token) return null;
  const pool = getPool();
  if (!pool) return null;
  const { rows: sessionRows } = await pool.query<{ user_id: number }>(
    'SELECT user_id FROM sessions WHERE token = $1 AND expires_at > NOW()',
    [token]
  );
  if (!sessionRows.length) return null;
  const userId = sessionRows[0].user_id;
  const { rows: userRows } = await pool.query<{
    id: number; telegram_id: string; first_name: string; username: string | null; photo_url: string | null;
  }>(
    'SELECT id, telegram_id, first_name, username, photo_url FROM users WHERE id = $1',
    [userId]
  );
  if (!userRows.length) return null;
  const u = userRows[0];
  const adminIds = (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(s => s.trim());
  return {
    id: u.id,
    telegramId: BigInt(u.telegram_id),
    firstName: u.first_name,
    username: u.username,
    role: adminIds.includes(u.telegram_id) ? 'admin' : 'user',
    avatarUrl: u.photo_url,
  };
}
