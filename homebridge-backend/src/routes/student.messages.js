// src/routes/student.messages.js
import { Router } from "express";
import { query } from "../db.js";
import { authRequired } from "../middleware/auth.js";
import { z } from "zod";
import { notifyAdminsConversationEmail } from "../lib/mailer.js";

const router = Router();

function ensureStudent(req, res) {
  const role = String(req.user.role || "").toUpperCase();
  if (role !== "STUDENT" && role !== "SUPERADMIN") {
    res.status(403).json({ error: "Student access only" });
    return false;
  }
  return true;
}

/* ---- email recipients helper for admin notifications ---- */
async function getAdminRecipients() {
  // Prefer a configured inbox
  const envTo = process.env.ADMIN_NOTIFY_EMAIL || process.env.SUPPORT_EMAIL;
  if (envTo) return [envTo];

  // Fallback to first few admin users
  const r = await query(
    `SELECT email FROM "User" WHERE role IN ('ADMIN','SUPERADMIN') AND "deletedAt" IS NULL ORDER BY "createdAt" ASC LIMIT 5`
  );
  return r.rows.map((x) => x.email).filter(Boolean);
}

/* ---- helpers ---- */
async function getOrCreateThread({ studentId, bookingId }) {
  // Try to find existing
  const existing = await query(
    `SELECT id FROM "MessageThread" WHERE "studentId" = $1 AND "bookingId" = $2`,
    [studentId, bookingId]
  );
  if (existing.rows[0]) return existing.rows[0].id;

  const ins = await query(
    `INSERT INTO "MessageThread"(id, "studentId", "bookingId", "createdAt", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, $2, NOW(), NOW())
     RETURNING id`,
    [studentId, bookingId]
  );
  return ins.rows[0].id;
}

function presentThreadRow(r) {
  return {
    id: r.t_id,
    bookingId: r.b_id,
    bookingRef: r.b_ref,
    bookingDates:
      r.b_checkIn && r.b_checkOut ? `${r.b_checkIn} → ${r.b_checkOut}` : null,
    listing: r.l_id
      ? { id: r.l_id, title: r.l_title || r.l_id.slice(0, 8).toUpperCase() }
      : null,
    createdAt: r.t_createdAt,
    updatedAt: r.t_updatedAt,
    lastMessage: r.m_body || null,
    lastSenderRole: r.m_senderRole || null,
    lastAt: r.m_createdAt || null,
  };
}

/* ---- list all threads for this student ---- */
router.get("/", authRequired, async (req, res) => {
  if (!ensureStudent(req, res)) return;
  const studentId = req.user.id;

  const rows = await query(
    `
    WITH last AS (
      SELECT DISTINCT ON ("threadId")
        "threadId", id, "senderRole", body, "createdAt"
      FROM "Message"
      WHERE "threadId" IN (SELECT id FROM "MessageThread" WHERE "studentId" = $1)
      ORDER BY "threadId", "createdAt" DESC
    )
    SELECT
      t.id                       AS t_id,
      t."createdAt"::text        AS t_createdAt,
      t."updatedAt"::text        AS t_updatedAt,
      b.id                       AS b_id,
      CONCAT('BK-', UPPER(REPLACE(SUBSTRING(b.id FOR 8), '-', ''))) AS b_ref,
      b."checkIn"                AS b_checkIn,
      b."checkOut"               AS b_checkOut,
      l.id                       AS l_id,
      l.title                    AS l_title,
      lm.body                    AS m_body,
      lm."senderRole"            AS m_senderRole,
      lm."createdAt"::text       AS m_createdAt
    FROM "MessageThread" t
    LEFT JOIN "Booking" b ON b.id = t."bookingId"
    LEFT JOIN "Listing" l ON l.id = b."listingId"
    LEFT JOIN last lm ON lm."threadId" = t.id
    WHERE t."studentId" = $1
    ORDER BY COALESCE(lm."createdAt", t."updatedAt") DESC, t."createdAt" DESC
    `,
    [studentId]
  );

  res.json({ items: rows.rows.map(presentThreadRow) });
});

/* ---- get one thread with messages ---- */
router.get("/:threadId", authRequired, async (req, res) => {
  if (!ensureStudent(req, res)) return;

  // Verify ownership
  const owns = await query(
    `SELECT id FROM "MessageThread" WHERE id = $1 AND "studentId" = $2`,
    [req.params.threadId, req.user.id]
  );
  if (!owns.rows[0]) return res.status(404).json({ error: "Thread not found" });

  const header = await query(
    `
    SELECT
      t.id                 AS t_id,
      t."createdAt"::text  AS t_createdAt,
      t."updatedAt"::text  AS t_updatedAt,
      b.id                 AS b_id,
      b."checkIn"          AS b_checkIn,
      b."checkOut"         AS b_checkOut,
      l.id                 AS l_id,
      l.title              AS l_title
    FROM "MessageThread" t
    LEFT JOIN "Booking" b ON b.id = t."bookingId"
    LEFT JOIN "Listing" l ON l.id = b."listingId"
    WHERE t.id = $1
    `,
    [req.params.threadId]
  );
  const h = header.rows[0];

  const msgs = await query(
    `SELECT id, "senderRole", "senderId", body, "createdAt"::text AS "createdAt"
     FROM "Message" WHERE "threadId" = $1 ORDER BY "createdAt" ASC`,
    [req.params.threadId]
  );

  res.json({
    item: {
      id: h.t_id,
      bookingId: h.b_id,
      bookingDates:
        h.b_checkIn && h.b_checkOut ? `${h.b_checkIn} → ${h.b_checkOut}` : null,
      listing: h.l_id ? { id: h.l_id, title: h.l_title } : null,
      createdAt: h.t_createdAt,
      updatedAt: h.t_updatedAt,
      messages: msgs.rows,
    },
  });
});

/* ---- start a thread for a booking (or reuse) + first message ---- */
router.post("/start", authRequired, async (req, res) => {
  if (!ensureStudent(req, res)) return;

  const Body = z.object({
    bookingId: z.string().min(1),
    body: z.string().min(1),
  });
  const parsed = Body.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: parsed.error.flatten() });

  // validate booking ownership
  const owns = await query(
    `SELECT id FROM "Booking" WHERE id = $1 AND "studentId" = $2`,
    [parsed.data.bookingId, req.user.id]
  );
  if (!owns.rows[0])
    return res.status(404).json({ error: "Booking not found" });

  const threadId = await getOrCreateThread({
    studentId: req.user.id,
    bookingId: parsed.data.bookingId,
  });

  await query(
    `INSERT INTO "Message"(id, "threadId", "senderRole", "senderId", body, "createdAt")
     VALUES (gen_random_uuid()::text, $1, 'STUDENT', $2, $3, NOW())`,
    [threadId, req.user.id, parsed.data.body]
  );
  await query(
    `UPDATE "MessageThread" SET "updatedAt" = NOW() WHERE id = $1`,
    [threadId]
  );

  res.status(201).json({ ok: true, threadId });

  // --- Fire-and-forget email to admins ---
  try {
    const toList = await getAdminRecipients();
    if (toList.length) {
      // Some context for subject (booking/listing)
      const bk = await query(
        `
        SELECT b.id, l.title
        FROM "MessageThread" t
        LEFT JOIN "Booking" b ON b.id = t."bookingId"
        LEFT JOIN "Listing" l ON l.id = b."listingId"
        WHERE t.id = $1
        `,
        [threadId]
      );
      const subj = bk.rows[0]?.title
        ? `New message about ${bk.rows[0].title}`
        : `New message from ${req.user.name || "Student"}`;
      notifyAdminsConversationEmail({
        to: toList.join(","),
        studentName: req.user.name || "",
        studentEmail: req.user.email || "",
        subject: subj,
        body: parsed.data.body,
        studentId: req.user.id,
        threadId,
      }).catch((e) =>
        console.warn("notifyAdminsConversationEmail failed:", e.message)
      );
    }
  } catch (e) {
    console.warn("Email dispatch (student start) failed:", e.message);
  }
});

/* ---- reply in an existing thread ---- */
router.post("/:threadId/reply", authRequired, async (req, res) => {
  if (!ensureStudent(req, res)) return;

  const Body = z.object({ body: z.string().min(1) });
  const parsed = Body.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: parsed.error.flatten() });

  // verify ownership
  const owns = await query(
    `SELECT id FROM "MessageThread" WHERE id = $1 AND "studentId" = $2`,
    [req.params.threadId, req.user.id]
  );
  if (!owns.rows[0]) return res.status(404).json({ error: "Thread not found" });

  await query(
    `INSERT INTO "Message"(id, "threadId", "senderRole", "senderId", body, "createdAt")
     VALUES (gen_random_uuid()::text, $1, 'STUDENT', $2, $3, NOW())`,
    [req.params.threadId, req.user.id, parsed.data.body]
  );
  await query(
    `UPDATE "MessageThread" SET "updatedAt" = NOW() WHERE id = $1`,
    [req.params.threadId]
  );

  res.status(201).json({ ok: true });

  // --- Fire-and-forget email to admins ---
  try {
    const toList = await getAdminRecipients();
    if (toList.length) {
      const th = await query(
        `SELECT subject, "studentId" FROM "MessageThread" WHERE id = $1`,
        [req.params.threadId]
      );
      const subj =
        th.rows[0]?.subject ||
        `New reply from ${req.user.name || "Student"}`;
      notifyAdminsConversationEmail({
        to: toList.join(","),
        studentName: req.user.name || "",
        studentEmail: req.user.email || "",
        subject: subj,
        body: parsed.data.body,
        studentId: req.user.id,
        threadId: req.params.threadId,
      }).catch((e) =>
        console.warn("notifyAdminsConversationEmail failed:", e.message)
      );
    }
  } catch (e) {
    console.warn("Email dispatch (student reply) failed:", e.message);
  }
});

export default router;
