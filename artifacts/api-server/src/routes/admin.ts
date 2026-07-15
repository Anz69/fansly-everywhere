import { Router } from "express";
import { eq, sql } from "drizzle-orm";
import { db } from "../lib/db.js";
import { usersTable, modelsTable, messagesTable, subdomainsTable } from "@workspace/db/schema";
import { insertModelSchema, insertSubdomainSchema } from "@workspace/db/schema";
import { requireAdmin } from "../middlewares/auth.js";
import {
  verifyAdminPassword,
  createAdminSession,
  deleteAdminSession,
  isValidAdminSession,
} from "../lib/adminAuth.js";
import { z } from "zod";

const router = Router();

const GetByIdParams      = z.object({ id: z.number().int().positive() });
const GetSubdomainParams = z.object({ id: z.number().int().positive() });
const UpdateSubdomainBody = insertSubdomainSchema.partial().refine(
  (data) => Object.keys(data).length > 0,
  { message: "At least one field is required" }
);
const UpdateModelBody = insertModelSchema.partial().refine(
  (data) => Object.keys(data).length > 0,
  { message: "At least one field is required" }
);

function fmtModel(m: typeof modelsTable.$inferSelect) {
  return {
    id: m.id, slug: m.slug, name: m.name,
    coverUrl:      m.coverUrl,
    avatarUrl:     m.avatarUrl,
    bio:           m.bio ?? null,
    isVerified:    m.isVerified,
    followerCount: m.followerCount,
    likeCount:     m.likeCount ?? 0,
    photoCount:    m.photoCount ?? null,
    videoCount:    m.videoCount ?? 0,
    isOnline:      m.isOnline,
    viewerCount:   m.viewerCount ?? null,
    tags:          m.tags ?? [],
    photos:        m.photos ?? [],
    isFeatured:    m.isFeatured,
    createdAt:     m.createdAt,
  };
}

function fmtSub(s: typeof subdomainsTable.$inferSelect) {
  return {
    id: s.id, slug: s.slug, modelId: s.modelId, isActive: s.isActive,
    customTitle: s.customTitle, customDescription: s.customDescription ?? null,
    customColor: s.customColor ?? null, customLogoUrl: s.customLogoUrl ?? null,
    customBannerUrl: s.customBannerUrl ?? null, createdAt: s.createdAt,
  };
}

// ─── Admin Password Auth ──────────────────────────────────────────────────────

// In-memory sliding-window rate limiter for admin login attempts (per IP)
const _loginAttempts = new Map<string, number[]>();
function isLoginRateLimited(key: string, max = 5, windowMs = 10 * 60 * 1000): boolean {
  const now = Date.now();
  const arr = (_loginAttempts.get(key) ?? []).filter((t) => now - t < windowMs);
  arr.push(now);
  _loginAttempts.set(key, arr);
  return arr.length > max;
}

// POST /admin/login — password auth
router.post("/admin/login", (req, res) => {
  const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
  if (isLoginRateLimited(ip)) {
    res.status(429).json({ error: "Too many login attempts. Please try again later." }); return;
  }
  const { password } = req.body ?? {};
  if (!password || typeof password !== "string") {
    res.status(400).json({ error: "Password is required" }); return;
  }
  const expectedHash = process.env.ADMIN_PASSWORD_HASH ?? "";
  if (!expectedHash) {
    res.status(503).json({ error: "ADMIN_PASSWORD_HASH is not configured" }); return;
  }
  if (!verifyAdminPassword(password, expectedHash)) {
    res.status(401).json({ error: "Invalid password" }); return;
  }
  const token = createAdminSession();
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  res.cookie("admin_session", token, {
    httpOnly: true, path: "/", maxAge: 86400 * 1000,
    sameSite: "lax", secure,
  });
  res.json({ ok: true });
});

// POST /admin/logout-admin
router.post("/admin/logout-admin", (req, res) => {
  deleteAdminSession(req.cookies?.["admin_session"]);
  res.clearCookie("admin_session", { path: "/" });
  res.json({ ok: true });
});

// GET /admin/check — is admin session valid (password OR telegram)
router.get("/admin/check", async (req, res) => {
  if (isValidAdminSession(req.cookies?.["admin_session"])) {
    res.json({ ok: true, method: "password" }); return;
  }
  try {
    const { getSessionUser } = await import("../lib/session.js");
    const user = await getSessionUser(req);
    if (user?.role === "admin") { res.json({ ok: true, method: "telegram" }); return; }
  } catch { /* ignore */ }
  res.status(401).json({ ok: false });
});

// ─── Stats ───────────────────────────────────────────────────────────────────

router.get("/admin/stats", requireAdmin, async (_req, res) => {
  try {
    const [[models], [subdomains], [messages], [users]] = await Promise.all([
      db.select({ count: sql`count(*)::int` }).from(modelsTable),
      db.select({ count: sql`count(*)::int` }).from(subdomainsTable),
      db.select({ count: sql`count(*)::int` }).from(messagesTable),
      db.select({ count: sql`count(*)::int` }).from(usersTable),
    ]);
    res.json({
      totalUsers:      users?.count ?? 0,
      totalModels:     models?.count ?? 0,
      totalSubdomains: subdomains?.count ?? 0,
      totalMessages:   messages?.count ?? 0,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Models CRUD ─────────────────────────────────────────────────────────────

router.get("/admin/models", requireAdmin, async (_req, res) => {
  try {
    const items = await db.select().from(modelsTable).orderBy(modelsTable.createdAt);
    res.json(items.map(fmtModel));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/admin/models", requireAdmin, async (req, res) => {
  const parsed = insertModelSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const [existing] = await db.select().from(modelsTable).where(eq(modelsTable.slug, parsed.data.slug));
    if (existing) { res.status(400).json({ error: "Slug already in use" }); return; }
    const [model] = await db.insert(modelsTable).values(parsed.data).returning();
    res.status(201).json(fmtModel(model));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/admin/models/:id", requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const params = GetByIdParams.safeParse({ id });
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  try {
    const [model] = await db.select().from(modelsTable).where(eq(modelsTable.id, params.data.id));
    if (!model) { res.status(404).json({ error: "Not found" }); return; }
    res.json(fmtModel(model));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.patch("/admin/models/:id", requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const params = GetByIdParams.safeParse({ id });
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const parsed = UpdateModelBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const [model] = await db.update(modelsTable)
      .set(parsed.data as Parameters<typeof db.update>[0] extends infer T ? any : never)
      .where(eq(modelsTable.id, params.data.id))
      .returning();
    if (!model) { res.status(404).json({ error: "Not found" }); return; }
    res.json(fmtModel(model));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/admin/models/:id", requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const params = GetByIdParams.safeParse({ id });
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  try {
    const [model] = await db.delete(modelsTable).where(eq(modelsTable.id, params.data.id)).returning();
    if (!model) { res.status(404).json({ error: "Not found" }); return; }
    res.sendStatus(204);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Subdomains CRUD ─────────────────────────────────────────────────────────

router.get("/admin/subdomains", requireAdmin, async (_req, res) => {
  try {
    const subdomains = await db.select().from(subdomainsTable).orderBy(subdomainsTable.createdAt);
    res.json(subdomains.map(fmtSub));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/admin/subdomains", requireAdmin, async (req, res) => {
  const parsed = insertSubdomainSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const [existing] = await db.select().from(subdomainsTable).where(eq(subdomainsTable.slug, parsed.data.slug));
    if (existing) { res.status(400).json({ error: "Slug already in use" }); return; }
    const [sub] = await db.insert(subdomainsTable).values(parsed.data).returning();
    res.status(201).json(fmtSub(sub));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/admin/subdomains/:id", requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const params = GetSubdomainParams.safeParse({ id });
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  try {
    const [sub] = await db.select().from(subdomainsTable).where(eq(subdomainsTable.id, params.data.id));
    if (!sub) { res.status(404).json({ error: "Not found" }); return; }
    res.json(fmtSub(sub));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.patch("/admin/subdomains/:id", requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const params = GetSubdomainParams.safeParse({ id });
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const parsed = UpdateSubdomainBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const [sub] = await db.update(subdomainsTable)
      .set(parsed.data as any)
      .where(eq(subdomainsTable.id, params.data.id))
      .returning();
    if (!sub) { res.status(404).json({ error: "Not found" }); return; }
    res.json(fmtSub(sub));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/admin/subdomains/:id", requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const params = GetSubdomainParams.safeParse({ id });
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  try {
    const [sub] = await db.delete(subdomainsTable).where(eq(subdomainsTable.id, params.data.id)).returning();
    if (!sub) { res.status(404).json({ error: "Not found" }); return; }
    res.sendStatus(204);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
