import { Router } from "express";
import { query } from "../db.js";
import { authRequired } from "../middleware/auth.js";
import multer from "multer";
import path from "path";
import fs from "fs";

const router = Router();

// Ensure uploads dir exists
const UPLOAD_DIR = path.resolve("uploads/agent_docs");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Multer storage (filename: <timestamp>__original.ext)
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const safe = (file.originalname || "file").replace(/[^\w.-]+/g, "_");
    const ts = Date.now();
    cb(null, `${ts}__${safe}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
  fileFilter: (_req, file, cb) => {
    const ok = /^image\//.test(file.mimetype) || file.mimetype === "application/pdf";
    cb(ok ? null : new Error("Unsupported file type"), ok);
  },
});

// Map to public URL (assuming you serve /uploads statically)
const publicUrlFor = (absPath) => {
  const rel = path.relative(path.resolve("."), absPath).replace(/\\/g, "/");
  return `/${rel}`; // e.g. "/uploads/agent_docs/123__file.pdf"
};

// LIST docs for current agent
router.get("/", authRequired, async (req, res) => {
  const role = String(req.user.role).toUpperCase();
  if (role !== "AGENT" && role !== "SUPERADMIN") {
    return res.status(403).json({ error: "Agent access only" });
  }
  const { rows } = await query(
    `SELECT id, "filename", "category", "status", "mime", "size", "url", "createdAt"
     FROM "AgentDoc" WHERE "userId" = $1 ORDER BY "createdAt" DESC`,
    [req.user.id]
  );
  const items = rows.map((d) => ({
    id: d.id,
    name: d.filename,
    category: d.category || "Other",
    status: d.status || "Pending",
    mime: d.mime || null,
    size: d.size || 0,
    url: d.url,
    downloadUrl: d.url,
    uploadedAt: d.createdAt,
  }));
  res.json({ items });
});

// UPLOAD a doc (supports multiple)
router.post("/", authRequired, upload.array("files", 10), async (req, res) => {
  const role = String(req.user.role).toUpperCase();
  if (role !== "AGENT" && role !== "SUPERADMIN") {
    return res.status(403).json({ error: "Agent access only" });
  }
  const category = (req.body?.category || "Other").toString().trim() || "Other";
  if (!req.files?.length) return res.status(400).json({ error: "No files uploaded" });

  const created = [];
  for (const f of req.files) {
    const url = publicUrlFor(f.path);
    const { rows } = await query(
      `INSERT INTO "AgentDoc"(id, "userId", "filename", "category", "status", "mime", "size", "url", "createdAt")
       VALUES (gen_random_uuid()::text, $1, $2, $3, 'Pending', $4, $5, $6, NOW())
       RETURNING id, "filename", "category", "status", "mime", "size", "url", "createdAt"`,
      [req.user.id, f.originalname || "Document", category, f.mimetype, f.size, url]
    );
    const row = rows[0];
    created.push({
      id: row.id,
      name: row.filename,
      category: row.category || "Other",
      status: row.status || "Pending",
      mime: row.mime,
      size: row.size,
      url: row.url,
      downloadUrl: row.url,
      uploadedAt: row.createdAt,
    });
  }
  res.status(201).json({ items: created });
});

// DELETE a doc
router.delete("/:docId", authRequired, async (req, res) => {
  const role = String(req.user.role).toUpperCase();
  if (role !== "AGENT" && role !== "SUPERADMIN") {
    return res.status(403).json({ error: "Agent access only" });
  }
  const { rows } = await query(
    `SELECT id, "userId", url FROM "AgentDoc" WHERE id = $1`,
    [req.params.docId]
  );
  const doc = rows[0];
  if (!doc || doc.userId !== req.user.id) return res.status(404).json({ error: "Document not found" });

  // best-effort unlink
  try {
    const abs = path.resolve("." + doc.url);
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
  } catch {}

  await query(`DELETE FROM "AgentDoc" WHERE id = $1`, [doc.id]);
  res.status(204).end();
});

export default router;
