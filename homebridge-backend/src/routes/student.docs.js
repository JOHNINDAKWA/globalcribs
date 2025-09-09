import { Router } from "express";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import crypto from "crypto";
import { authRequired } from "../middleware/auth.js";
import { query, tx } from "../db.js";

const router = Router();

/* ---------------- Paths / uploads ---------------- */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// server.js serves /uploads statically
const UPLOAD_DIR = path.join(__dirname, "..", "..", "uploads");
await fs.mkdir(UPLOAD_DIR, { recursive: true }).catch(() => {});

/* ---------------- Multer setup ---------------- */
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    cb(null, `${crypto.randomUUID()}${ext || ""}`);
  },
});
const fileFilter = (_req, file, cb) => {
  const okMimes = new Set([
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "image/heic",
    "image/heif",
  ]);
  if (okMimes.has(file.mimetype) || (file.mimetype || "").startsWith("image/")) {
    return cb(null, true);
  }
  return cb(new Error("Unsupported file type"), false);
};
const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 15 * 1024 * 1024, files: 10 },
});

/* ---------------- Helpers ---------------- */
const present = (d) => ({ ...d, name: d.filename });

function guessCategory(name = "") {
  const n = String(name).toLowerCase();
  if (/(passport|id|identity|national)/.test(n)) return "Passport/ID";
  if (/(admission|offer|acceptance)/.test(n)) return "Admission Letter";
  if (/(i-20|sevis)/.test(n)) return "I-20/SEVIS";
  if (/(bank|statement|sponsor|financial)/.test(n)) return "Financial/Bank";
  if (/(visa|permit)/.test(n)) return "Visa/Permit";
  return "Other";
}

async function getNonCancelledBookingsForUser(userId) {
  const { rows } = await query(
    `SELECT id, "docIds", "feePaidAt", status
     FROM "Booking"
     WHERE "studentId" = $1 AND status <> 'CANCELLED'`,
    [userId]
  );
  return rows;
}

function nextStatusAfterDocsChange(b, hasDocs) {
  if (["UNDER_REVIEW", "APPROVED", "REJECTED"].includes(b.status)) return b.status;
  if (!b.feePaidAt) return b.status || "PENDING_PAYMENT";
  return hasDocs ? "READY_TO_SUBMIT" : "PAYMENT_COMPLETE";
}
const uniq = (arr) => Array.from(new Set(arr || []));

/* ---------------- GET my docs ---------------- */
router.get("/", authRequired, async (req, res) => {
  const { rows } = await query(
    `SELECT * FROM "StudentDoc" WHERE "userId" = $1 ORDER BY "createdAt" DESC`,
    [req.user.id]
  );
  res.json({ docs: rows.map(present) });
});

/* ---------------- POST upload docs ---------------- */
router.post("/", authRequired, upload.array("files", 10), async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: "No files uploaded" });

  const toCreate = files.map((f) => ({
    userId: req.user.id,
    filename: f.originalname || "Document",
    mime: f.mimetype || null,
    size: f.size || 0,
    url: `/uploads/${path.basename(f.path)}`,
    category: guessCategory(f.originalname || ""),
    status: "none",
  }));

  const created = await tx(async (c) => {
    const out = [];
    for (const d of toCreate) {
      const { rows } = await c.query(
        `INSERT INTO "StudentDoc" (
           id, "userId", filename, mime, size, url, category, status, "createdAt"
         ) VALUES (
           gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, NOW()
         ) RETURNING *`,
        [d.userId, d.filename, d.mime, d.size, d.url, d.category, d.status]
      );
      out.push(rows[0]);
    }
    return out;
  });

  // Attach to non-cancelled bookings
  const bookings = await getNonCancelledBookingsForUser(req.user.id);
  const newIds = created.map((d) => d.id);

  if (bookings.length) {
    await tx(async (c) => {
      for (const b of bookings) {
        const nextDocIds = uniq([...(b.docIds || []), ...newIds]);
        const hasDocs = nextDocIds.length > 0;
        const status = nextStatusAfterDocsChange(b, hasDocs);
        await c.query(
          `UPDATE "Booking"
           SET "docIds" = $1::text[], "docsUpdatedAt" = NOW(), status = $2, "updatedAt" = NOW()
           WHERE id = $3`,
          [nextDocIds, status, b.id]
        );
      }
    });
  }

  res.status(201).json({ docs: created.map(present) });
});

/* ---------------- PATCH rename/category/status ---------------- */
router.patch("/:id", authRequired, async (req, res) => {
  const { name, filename, category, status } = req.body || {};
  const { rows: drows } = await query(`SELECT * FROM "StudentDoc" WHERE id = $1`, [req.params.id]);
  const doc = drows[0];
  if (!doc || doc.userId !== req.user.id) return res.status(404).json({ error: "Not found" });

  const fields = [];
  const vals = [];
  let p = 1;
  const newName = (typeof name === "string" && name.trim()) ? name.trim()
                 : (typeof filename === "string" && filename.trim()) ? filename.trim()
                 : undefined;
  if (newName !== undefined) { fields.push(`filename = $${p++}`); vals.push(newName); }
  if (typeof category === "string") { fields.push(`category = $${p++}`); vals.push(category); }
  if (typeof status === "string") { fields.push(`status = $${p++}`); vals.push(status); }
  if (!fields.length) return res.json({ doc: present(doc) });

  vals.push(doc.id);
  const { rows } = await query(
    `UPDATE "StudentDoc" SET ${fields.join(", ")}, "createdAt" = "createdAt"
     WHERE id = $${p} RETURNING *`,
    vals
  );

  res.json({ doc: present(rows[0]) });
});

/* ---------------- DELETE doc (and unlink from bookings) ---------------- */
router.delete("/:id", authRequired, async (req, res) => {
  const { rows: drows } = await query(`SELECT * FROM "StudentDoc" WHERE id = $1`, [req.params.id]);
  const doc = drows[0];
  if (!doc || doc.userId !== req.user.id) return res.status(404).json({ error: "Not found" });

  // Try to remove file; ignore if missing
  const abs = path.join(UPLOAD_DIR, path.basename(doc.url || ""));
  await fs.unlink(abs).catch(() => {});

  await tx(async (c) => {
    await c.query(`DELETE FROM "StudentDoc" WHERE id = $1`, [doc.id]);

    const bookings = await c.query(
      `SELECT id, "docIds", "feePaidAt", status
       FROM "Booking"
       WHERE "studentId" = $1 AND status <> 'CANCELLED'`,
      [req.user.id]
    );
    for (const b of bookings.rows) {
      const nextDocIds = (b.docIds || []).filter((x) => x !== doc.id);
      const hasDocs = nextDocIds.length > 0;
      const status = nextStatusAfterDocsChange(b, hasDocs);
      await c.query(
        `UPDATE "Booking"
         SET "docIds" = $1::text[], "docsUpdatedAt" = NOW(), status = $2, "updatedAt" = NOW()
         WHERE id = $3`,
        [nextDocIds, status, b.id]
      );
    }
  });

  res.status(204).end();
});

/* ---------------- POST /sync ---------------- */
router.post("/sync", authRequired, async (req, res) => {
  const { bookingId } = req.body || {};

  const [docsRes, bookingsRes] = await Promise.all([
    query(`SELECT id FROM "StudentDoc" WHERE "userId" = $1`, [req.user.id]),
    bookingId
      ? query(
          `SELECT id, "docIds", "feePaidAt", status
           FROM "Booking"
           WHERE id = $1 AND "studentId" = $2 AND status <> 'CANCELLED'`,
          [bookingId, req.user.id]
        )
      : query(
          `SELECT id, "docIds", "feePaidAt", status
           FROM "Booking"
           WHERE "studentId" = $1 AND status <> 'CANCELLED'`,
          [req.user.id]
        ),
  ]);

  const allDocIds = docsRes.rows.map((d) => d.id);
  let updated = 0;

  if (bookingsRes.rows.length) {
    await tx(async (c) => {
      for (const b of bookingsRes.rows) {
        const nextDocIds = uniq([...(b.docIds || []), ...allDocIds]);
        const hasDocs = nextDocIds.length > 0;
        const status = nextStatusAfterDocsChange(b, hasDocs);
        await c.query(
          `UPDATE "Booking"
           SET "docIds" = $1::text[], "docsUpdatedAt" = NOW(), status = $2, "updatedAt" = NOW()
           WHERE id = $3`,
          [nextDocIds, status, b.id]
        );
        updated++;
      }
    });
  }

  res.json({ ok: true, updated });
});

export default router;
