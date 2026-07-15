import { Router } from "express";
import healthRouter from "./health.js";
import authRouter from "./auth.js";
import modelsRouter from "./models.js";
import adminRouter from "./admin.js";
import langRouter from "./lang.js";
import uploadRouter from "./upload.js";
import chatRouter from "./chat.js";

const router = Router();
router.use(healthRouter);
router.use(langRouter);
router.use(authRouter);
router.use(modelsRouter);
router.use(adminRouter);
router.use(uploadRouter);
router.use(chatRouter);
export default router;
