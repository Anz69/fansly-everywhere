import { Router } from "express";
import { getSessionUser } from "../lib/session.js";
import { db } from "../lib/db.js";
import { sql } from "drizzle-orm";

const router = Router();

router.get("/auth/me", async (req, res) => {
  try {
    const user = await getSessionUser(req);
    if (!user) { res.status(401).json({ error: "Not authenticated" }); return; }
    res.json({
      id: user.id,
      telegramId: user.telegramId.toString(),
      firstName: user.firstName,
      username: user.username,
      role: user.role,
      avatarUrl: user.avatarUrl,
    });
  } catch { res.status(401).json({ error: "Not authenticated" }); }
});

router.post("/auth/logout", async (req, res) => {
  const token = req.cookies?.["fan_session"];
  if (token) {
    await db.execute(sql`DELETE FROM sessions WHERE token = ${token}`).catch(() => {});
  }
  res.clearCookie("fan_session", { path: "/" });
  res.json({ ok: true });
});

export default router;
