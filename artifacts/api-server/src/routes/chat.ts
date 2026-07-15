import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { db } from "../lib/db.js";
import { messagesTable, modelsTable } from "@workspace/db/schema";
import { requireAuth } from "../middlewares/auth.js";
import { z } from "zod";

const router = Router();
const ListMessagesParams = z.object({ modelSlug: z.string().min(1) });
const SendMessageBody = z.object({ content: z.string().min(1).max(2000) });
const MODEL_REPLIES = [
  "Hey! So glad you reached out 😊","That's really sweet!",
  "Want to see exclusive content? Check my latest posts!",
  "You always make me smile 💙","You're one of my favorites 💫"
];

router.get("/chat/:modelSlug/messages", requireAuth, async (req, res) => {
  const params = ListMessagesParams.safeParse({ modelSlug: req.params.modelSlug });
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const messages = await db.select().from(messagesTable)
    .where(and(eq(messagesTable.modelSlug, params.data.modelSlug), eq(messagesTable.userId, req.user!.id)))
    .orderBy(messagesTable.createdAt);
  res.json(messages.map(m => ({ id: m.id, modelSlug: m.modelSlug, content: m.content, fromUser: m.fromUser, createdAt: m.createdAt })));
});

router.post("/chat/:modelSlug/messages", requireAuth, async (req, res) => {
  const params = ListMessagesParams.safeParse({ modelSlug: req.params.modelSlug });
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const [model] = await db.select().from(modelsTable).where(eq(modelsTable.slug, params.data.modelSlug));
  if (!model) { res.status(404).json({ error: "Model not found" }); return; }
  const body = SendMessageBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  const [userMsg] = await db.insert(messagesTable).values({ modelSlug: params.data.modelSlug, userId: req.user!.id, content: body.data.content, fromUser: true }).returning();
  const reply = MODEL_REPLIES[Math.floor(Math.random() * MODEL_REPLIES.length)];
  const [botMsg] = await db.insert(messagesTable).values({ modelSlug: params.data.modelSlug, userId: req.user!.id, content: reply, fromUser: false }).returning();
  res.status(201).json([
    { id: userMsg.id, modelSlug: userMsg.modelSlug, content: userMsg.content, fromUser: userMsg.fromUser, createdAt: userMsg.createdAt },
    { id: botMsg.id, modelSlug: botMsg.modelSlug, content: botMsg.content, fromUser: botMsg.fromUser, createdAt: botMsg.createdAt },
  ]);
});

export default router;
