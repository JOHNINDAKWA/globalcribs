import { Router } from "express";
import { authRequired } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { query } from "../db.js";

const router = Router();

const API_PUBLIC_URL = (process.env.API_PUBLIC_URL || "http://localhost:4000").replace(/\/$/, "");

// Pretty refs
function prettyId(uuid = "", prefix = "BK") {
  const seg = (uuid.split("-")[0] || "").toUpperCase();
  return `${prefix}-${seg || "00000000"}`;
}
function prettyListingId(uuid = "") {
  const seg = (uuid.split("-")[0] || "").toUpperCase();
  return `LS-${seg || "00000000"}`;
}

// GET /api/admin/bookings
router.get("/", authRequired, requireRole("ADMIN", "SUPERADMIN"), async (req, res) => {
  const take = Math.min(Number(req.query.take || 50), 100);
  const skip = Math.max(Number(req.query.skip || 0), 0);

  const rowsRes = await query(
    `
    SELECT
      b.*,
      l.id   AS "l_id",
      l.title AS "l_title",
      l.city AS "l_city",
      u.id   AS "u_id",
      u.name AS "u_name",
      u.email AS "u_email"
    FROM "Booking" b
    JOIN "Listing" l ON l.id = b."listingId"
    JOIN "User" u ON u.id = b."studentId"
    ORDER BY b."createdAt" DESC
    LIMIT $1 OFFSET $2
    `,
    [take, skip]
  );
  const countRes = await query(`SELECT COUNT(*)::int AS c FROM "Booking"`);
  const total = countRes.rows[0].c;

  const items = rowsRes.rows.map((b) => ({
    id: b.id,
    displayId: prettyId(b.id, "BK"),
    status: b.status,
    checkIn: b.checkIn,
    checkOut: b.checkOut,
    createdAt: b.createdAt,
    feePaidAt: b.feePaidAt,
    submittedAt: b.submittedAt,
    docsCount: Array.isArray(b.docIds) ? b.docIds.length : 0,
    listing: {
      id: b.l_id,
      displayId: prettyListingId(b.l_id),
      title: b.l_title,
      city: b.l_city,
    },
    student: {
      id: b.u_id,
      name: b.u_name || "",
      email: b.u_email || "",
    },
  }));

  res.json({ items, total, take, skip });
});

// GET /api/admin/bookings/:id
router.get("/:id", authRequired, requireRole("ADMIN", "SUPERADMIN"), async (req, res) => {
  const base = await query(
    `
    SELECT
      b.*,
      l.id   AS "l_id", l.title AS "l_title", l.city AS "l_city", l."coverImageId" AS "l_cover",
      u.id   AS "u_id", u.name AS "u_name", u.email AS "u_email"
    FROM "Booking" b
    JOIN "Listing" l ON l.id = b."listingId"
    JOIN "User" u ON u.id = b."studentId"
    WHERE b.id = $1
    `,
    [req.params.id]
  );
  const b = base.rows[0];
  if (!b) return res.status(404).json({ error: "Booking not found" });

  // listing images
  const imgsRes = await query(
    `SELECT id, url, "order" FROM "ListingImage" WHERE "listingId" = $1 ORDER BY "order" ASC`,
    [b.l_id]
  );

  // docs (id IN docIds AND userId = studentId)
  const docIds = Array.isArray(b.docIds) ? b.docIds : [];
  const docsRaw = docIds.length
    ? (
        await query(
          `SELECT id, filename, mime, size, url, category, "createdAt"
           FROM "StudentDoc"
           WHERE "userId" = $1 AND id = ANY($2::text[])`,
          [b.studentId, docIds]
        )
      ).rows
    : [];

  const docs = docsRaw.map((d) => ({
    id: d.id,
    name: d.filename,
    mime: d.mime,
    size: d.size,
    url: d.url,
    downloadUrl: d.url?.startsWith("http") ? d.url : `${API_PUBLIC_URL}${d.url}`,
    category: d.category || "Other",
    createdAt: d.createdAt,
  }));

  const item = {
    id: b.id,
    displayId: prettyId(b.id, "BK"),
    status: b.status,
    checkIn: b.checkIn,
    checkOut: b.checkOut,
    note: b.note || null,
    feePaidAt: b.feePaidAt,
    submittedAt: b.submittedAt,
    createdAt: b.createdAt,
    docsCount: docs.length,
    docs,
    listing: {
      id: b.l_id,
      displayId: prettyListingId(b.l_id),
      title: b.l_title,
      city: b.l_city,
      coverImageId: b.l_cover,
      images: imgsRes.rows,
    },
    student: {
      id: b.u_id,
      name: b.u_name || "",
      email: b.u_email || "",
    },
  };

  res.json({ item });
});

// POST /api/admin/bookings/:id/decision
router.post("/:id/decision", authRequired, requireRole("ADMIN", "SUPERADMIN"), async (req, res) => {
  const decision = String(req.body?.decision || "").toUpperCase();
  if (!["APPROVED", "REJECTED"].includes(decision)) {
    return res.status(400).json({ error: "decision must be APPROVED or REJECTED" });
  }

  const exists = await query(`SELECT id FROM "Booking" WHERE id = $1`, [req.params.id]);
  if (!exists.rows[0]) return res.status(404).json({ error: "Booking not found" });

  const up = await query(
    `UPDATE "Booking" SET status = $1, "updatedAt" = NOW() WHERE id = $2 RETURNING *`,
    [decision, req.params.id]
  );

  res.json({ item: up.rows[0] });
});

export default router;
