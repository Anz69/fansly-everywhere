import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes/index.js";
import { logger } from "./lib/logger.js";
import { initAdminPassword } from "./lib/adminAuth.js";

// Generate admin password on startup if ADMIN_PASSWORD_HASH not set
initAdminPassword();

const app = express();
if (process.env.NODE_ENV === "production") app.set("trust proxy", 1);

app.use(pinoHttp({ logger, serializers: { req: r => ({ id: r.id, method: r.method, url: r.url?.split("?")[0] }), res: r => ({ statusCode: r.statusCode }) } }));
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map(s => s.trim()).filter(Boolean)
  : [];
app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (same-origin, curl, server-to-server)
    if (!origin) return cb(null, true);
    // Return false (no CORS headers) for unlisted origins — browser will block
    cb(null, allowedOrigins.includes(origin));
  },
  credentials: true,
}));
// 50 MB limit to support bulk base64-encoded photo uploads
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(cookieParser());
app.use("/api", router);

export default app;
