import { Router, Request, Response } from "express";
import { mkdirSync, promises as fsp } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import { requireAdmin } from "../middlewares/auth.js";

const router = Router();

// Persistent upload directory — survives dist/ rebuilds
const UPLOAD_DIR = "/var/www/fansly-everywhere/uploads";
mkdirSync(UPLOAD_DIR, { recursive: true });

// Allowed MIME types: bytes = magic signature, offset = where in file to check (default 0)
const MAGIC: Record<string, { bytes: number[]; offset?: number }[]> = {
  "image/jpeg": [{ bytes: [0xff, 0xd8, 0xff] }],
  "image/png":  [{ bytes: [0x89, 0x50, 0x4e, 0x47] }],
  "image/gif":  [{ bytes: [0x47, 0x49, 0x46] }],
  "image/webp": [{ bytes: [0x52, 0x49, 0x46, 0x46] }], // RIFF header
  // AVIF: ISO BMFF ftyp box — bytes 4–7 are always 'ftyp' (0x66 0x74 0x79 0x70)
  "image/avif": [{ bytes: [0x66, 0x74, 0x79, 0x70], offset: 4 }],
};
const ALLOWED_MIMES = new Set(Object.keys(MAGIC));
const EXT: Record<string, string> = {
  "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png",
  "image/webp": "webp", "image/gif": "gif", "image/avif": "avif",
};

function validateMagicBytes(buf: Buffer, mime: string): boolean {
  const candidates = MAGIC[mime];
  if (!candidates) return false;
  for (const { bytes, offset = 0 } of candidates) {
    if (bytes.length === 0) return true;
    if (buf.length < offset + bytes.length) return false;
    if (bytes.every((b, i) => buf[offset + i] === b)) return true;
  }
  return false;
}

// Per-file limit: 15 MB. Express body limit is 50 MB so this is safe for
// up to 3 files at once; for bulk (up to 50 files) the batch should be split
// on the client into groups (the UI enforces this via chunked requests).
const MAX_FILE_BYTES = 15 * 1024 * 1024;

/**
 * POST /api/admin/upload
 * Body: { files: [{ name: string, type: string, data: string (base64 or data-URL) }] }
 * Returns: { urls: string[] }
 */
router.post("/admin/upload", requireAdmin, async (req: Request, res: Response) => {
  try {
    const { files } = req.body as {
      files?: { name?: string; type?: string; data?: string }[];
    };
    if (!Array.isArray(files) || files.length === 0) {
      res.status(400).json({ error: "files[] обязателен" });
      return;
    }
    if (files.length > 50) {
      res.status(400).json({ error: "Максимум 50 файлов за раз" });
      return;
    }

    const urls: string[] = [];

    for (const f of files) {
      if (!f.data || typeof f.data !== "string") continue;

      const mime = (f.type ?? "image/jpeg").toLowerCase();
      if (!ALLOWED_MIMES.has(mime)) {
        res.status(415).json({ error: `Недопустимый тип файла: ${mime}` });
        return;
      }

      // Strip data URL prefix if present: "data:image/jpeg;base64,..."
      const raw = f.data.includes(",") ? f.data.split(",")[1] : f.data;
      const buf = Buffer.from(raw, "base64");

      if (buf.length > MAX_FILE_BYTES) {
        res.status(413).json({ error: `Файл слишком большой (максимум ${MAX_FILE_BYTES / 1024 / 1024}MB)` });
        return;
      }

      // Validate magic bytes to ensure file content matches the declared MIME
      if (!validateMagicBytes(buf, mime)) {
        res.status(400).json({ error: `Содержимое файла не соответствует типу ${mime}` });
        return;
      }

      const ext = EXT[mime] ?? "jpg";
      const filename = `${randomBytes(12).toString("hex")}.${ext}`;

      // Async write — does not block the event loop
      await fsp.writeFile(join(UPLOAD_DIR, filename), buf);

      urls.push(`/uploads/${filename}`);
    }

    res.json({ urls });
  } catch (e: any) {
    // Surface disk-full or permission errors clearly
    if (e.code === "ENOSPC") {
      res.status(507).json({ error: "Недостаточно места на диске" });
    } else if (e.code === "EACCES") {
      res.status(500).json({ error: "Нет прав записи в папку uploads" });
    } else {
      res.status(500).json({ error: e.message });
    }
  }
});

export default router;
