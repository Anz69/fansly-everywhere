import type { Request, Response, NextFunction } from "express";
import { getSessionUser } from "../lib/session.js";
import { isValidAdminSession } from "../lib/adminAuth.js";

declare global {
  namespace Express {
    interface Request {
      user?: import("../lib/session.js").TelegramUser;
    }
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await getSessionUser(req);
    if (!user) { res.status(401).json({ error: "Not authenticated" }); return; }
    req.user = user;
    next();
  } catch { res.status(401).json({ error: "Not authenticated" }); }
}

export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  // 1. Check password-based admin session cookie
  const adminToken = req.cookies?.["admin_session"];
  if (isValidAdminSession(adminToken)) {
    next();
    return;
  }
  // 2. Fallback: Telegram role=admin
  try {
    const user = await getSessionUser(req);
    if (!user) { res.status(401).json({ error: "Not authenticated" }); return; }
    if (user.role !== "admin") { res.status(403).json({ error: "Forbidden" }); return; }
    req.user = user;
    next();
  } catch { res.status(401).json({ error: "Not authenticated" }); }
}

export async function optionalAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try { req.user = (await getSessionUser(req)) ?? undefined; } catch { /* ignore */ }
  next();
}
