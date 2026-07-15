import { Router } from "express";
import { ilike, sql, eq, desc } from "drizzle-orm";
import { db } from "../lib/db.js";
import { modelsTable } from "@workspace/db/schema";
import { z } from "zod";

const router = Router();

const ListQuery = z.object({
  page:   z.coerce.number().int().positive().optional(),
  limit:  z.coerce.number().int().min(1).max(100).optional(),
  search: z.string().optional(),
});
const SlugParam = z.object({ slug: z.string().min(1) });

function fmt(m: typeof modelsTable.$inferSelect) {
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

router.get("/models/featured", async (_req, res) => {
  try {
    const items = await db.select().from(modelsTable)
      .where(eq(modelsTable.isFeatured, true))
      .orderBy(desc(modelsTable.followerCount))
      .limit(10);
    res.json(items.map(fmt));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/models/suggestions", async (_req, res) => {
  try {
    const items = await db.select().from(modelsTable)
      .where(eq(modelsTable.isOnline, true))
      .orderBy(desc(modelsTable.followerCount))
      .limit(6);
    res.json(items.map(fmt));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/models", async (req, res) => {
  const parsed = ListQuery.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const { page = 1, limit = 20, search } = parsed.data;
  const offset = (page - 1) * limit;
  const whereClause = search ? ilike(modelsTable.name, `%${search}%`) : undefined;
  try {
    const countQ = db.select({ count: sql<number>`count(*)::int` }).from(modelsTable);
    const itemsQ = db.select().from(modelsTable).orderBy(desc(modelsTable.createdAt));
    const [countResult, items] = await Promise.all([
      whereClause ? countQ.where(whereClause) : countQ,
      whereClause
        ? itemsQ.where(whereClause).limit(limit).offset(offset)
        : itemsQ.limit(limit).offset(offset),
    ]);
    res.json({ items: items.map(fmt), total: countResult[0]?.count ?? 0, page, limit });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/models/:slug", async (req, res) => {
  const p = SlugParam.safeParse({ slug: req.params.slug });
  if (!p.success) { res.status(400).json({ error: p.error.message }); return; }
  try {
    const [model] = await db.select().from(modelsTable)
      .where(eq(modelsTable.slug, p.data.slug));
    if (!model) { res.status(404).json({ error: "Model not found" }); return; }
    res.json(fmt(model));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
