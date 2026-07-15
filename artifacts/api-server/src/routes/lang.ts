import { Router } from "express";

const router = Router();

// Always return English — site is English-only
router.get("/lang", async (_req, res) => {
  res.json({ lang: "en" });
});

export default router;
