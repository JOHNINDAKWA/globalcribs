// src/routes/admin.inquiries.js
import { Router } from "express";
import { z } from "zod";
import { query } from "../db.js";
import { authRequired } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { sendSupportReplyEmail } from "../lib/mailer.js";

const router = Router();

const normalizeStatus = (s) => {
  const up = String(s || "").toUpperCase().replace(/\s+/g, "_");
  return ["OPEN", "IN_PROGRESS", "URGENT", "CLOSED"].includes(up) ? up : "OPEN";
};
const uiStatus = (db) =>
  ({ OPEN: "open", IN_PROGRESS: "in progress", URGENT: "urgent", CLOSED: "closed" }[db] || "open");

const presentTicket = (r) => ({
  id: r.id,
  name: r.name,
  email: r.email,
  topic: r.topic,
  subject: r.subject,
  message: r.message,
  listingUrl: r.listingUrl,
  status: uiStatus(r.status),
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  lastReplyAt: r.lastReplyAt,
  assignedTo: r.assignedTo,
});

router.use(authRequired, requireRole("ADMIN", "SUPERADMIN"));

/** GET /api/admin/inquiries */
router.get("/", async (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  const status = String(req.query.status || "").trim();
  const take = Math.max(1, Math.min(100, Number(req.query.take || 50)));
  const skip = Math.max(0, Number(req.query.skip || 0));
  const sort = String(req.query.sort || "newest"); // newest | oldest

  const params = [];
  const where = [`"deletedAt" IS NULL`];

  if (q) {
    params.push(`%${q}%`);
    const p = `$${params.length}`;
    where.push(`(LOWER(name) LIKE ${p} OR LOWER(email) LIKE ${p} OR LOWER(subject) LIKE ${p})`);
  }
  if (status) {
    params.push(normalizeStatus(status));
    where.push(`status = $${params.length}`);
  }

  const order = sort === "oldest" ? `"createdAt" ASC` : `"createdAt" DESC`;

  const countSql = `SELECT COUNT(*)::int AS c FROM "SupportTicket" WHERE ${where.join(" AND ")}`;
  const { rows: c } = await query(countSql, params);
  const total = c[0]?.c || 0;

  params.push(take, skip);
  const dataSql = `
    SELECT *
      FROM "SupportTicket"
     WHERE ${where.join(" AND ")}
     ORDER BY ${order}
     LIMIT $${params.length - 1} OFFSET $${params.length}`;
  const { rows } = await query(dataSql, params);

  res.json({
    items: rows.map(presentTicket),
    total,
  });
});

/** GET /api/admin/inquiries/:id */
router.get("/:id", async (req, res) => {
  const { rows } = await query(
    `SELECT * FROM "SupportTicket" WHERE id = $1 AND "deletedAt" IS NULL`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  res.json({ ticket: presentTicket(rows[0]) });
});

/** PATCH /api/admin/inquiries/:id  (status / assign) */
router.patch("/:id", async (req, res) => {
  const Body = z.object({
    status: z.string().optional(),
    assignedTo: z.string().uuid().optional().nullable(),
  });
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const sets = [];
  const vals = [];
  let p = 1;
  if (parsed.data.status !== undefined) {
    sets.push(`status = $${p++}`);
    vals.push(normalizeStatus(parsed.data.status));
  }
  if (parsed.data.assignedTo !== undefined) {
    sets.push(`"assignedTo" = $${p++}`);
    vals.push(parsed.data.assignedTo || null);
  }
  sets.push(`"updatedAt" = now()`);
  vals.push(req.params.id);

  const { rows } = await query(
    `UPDATE "SupportTicket" SET ${sets.join(", ")} WHERE id = $${p} AND "deletedAt" IS NULL RETURNING *`,
    vals
  );
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  res.json({ ticket: presentTicket(rows[0]) });
});

/** POST /api/admin/inquiries/:id/replies  (send email + log) */
router.post("/:id/replies", async (req, res) => {
  const Body = z.object({
    subject: z.string().min(1).max(180).optional(),
    body: z.string().min(1),
    setStatus: z.string().optional(), // optional: update status after reply
  });
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { rows: tks } = await query(
    `SELECT * FROM "SupportTicket" WHERE id = $1 AND "deletedAt" IS NULL`,
    [req.params.id]
  );
  const t = tks[0];
  if (!t) return res.status(404).json({ error: "Not found" });

  // Send email
  await sendSupportReplyEmail({
    to: t.email,
    subject: parsed.data.subject || `Re: ${t.subject}`,
    body: parsed.data.body,
  });

  // Log reply + touch ticket
  await query(
    `INSERT INTO "SupportReply"
       ("ticketId","adminUserId","toEmail",subject,body,"viaEmail","createdAt")
     VALUES ($1,$2,$3,$4,$5,true, now())`,
    [t.id, req.user.id, t.email, parsed.data.subject || null, parsed.data.body]
  );

  const nextStatus =
    parsed.data.setStatus !== undefined ? normalizeStatus(parsed.data.setStatus) : null;

  const sets = [`"lastReplyAt" = now()`, `"updatedAt" = now()`];
  const vals = [];
  let p = 1;
  if (nextStatus) {
    sets.push(`status = $${p++}`);
    vals.push(nextStatus);
  }
  vals.push(req.params.id);

  const { rows } = await query(
    `UPDATE "SupportTicket" SET ${sets.join(", ")} WHERE id = $${p} RETURNING *`,
    vals
  );

  res.json({ ticket: presentTicket(rows[0]) });
});

/** DELETE /api/admin/inquiries/:id  (soft delete) */
router.delete("/:id", async (req, res) => {
  await query(
    `UPDATE "SupportTicket" SET "deletedAt" = now(), "updatedAt" = now() WHERE id = $1`,
    [req.params.id]
  );
  res.json({ ok: true });
});

export default router;
