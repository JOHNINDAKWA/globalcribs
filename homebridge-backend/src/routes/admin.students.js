// src/routes/admin.students.js
import { Router } from "express";
import { authRequired } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { z } from "zod";
import { query } from "../db.js";
import { notifyStudentConversationEmail } from "../lib/mailer.js";

const router = Router();

const API_PUBLIC_URL = (
  process.env.API_PUBLIC_URL || "http://localhost:4000"
).replace(/\/$/, "");

// ---- helpers ----
const mapUserStatusOut = (s) =>
  s === "ACTIVE" ? "Active" : s === "SUSPENDED" ? "Suspended" : "Invited";
const mapUserStatusIn = (s) =>
  String(s || "").toUpperCase() === "ACTIVE" ? "ACTIVE" : "SUSPENDED";

const mapKycOut = (e) =>
  e === "VERIFIED" ? "Passed" : e === "FAILED" ? "Failed" : "Pending";
const mapKycIn = (s) => {
  const t = String(s || "").toLowerCase();
  if (t === "passed") return "VERIFIED";
  if (t === "failed") return "FAILED";
  return "SUBMITTED";
};

// LIST
router.get(
  "/",
  authRequired,
  requireRole("ADMIN", "SUPERADMIN"),
  async (req, res) => {
    const take = Math.min(Number(req.query.take || 50), 100);
    const skip = Math.max(Number(req.query.skip || 0), 0);

    const q = String(req.query.q || "").trim();
    const kyc = String(req.query.kyc || "");
    const status = String(req.query.status || "");
    const intake = String(req.query.intake || "");
    const sort = String(req.query.sort || "newest"); // newest | oldest | bookings | docs

    // Build WHERE
    const wh = [`u.role = 'STUDENT'`, `u."deletedAt" IS NULL`];
    const params = [];
    let p = 1;

    if (status) {
      wh.push(`u.status = $${p++}`);
      params.push(mapUserStatusIn(status));
    }
    if (kyc) {
      wh.push(`sp."kycStatus" = $${p++}`);
      params.push(mapKycIn(kyc));
    }
    if (intake) {
      wh.push(`sp.intake = $${p++}`);
      params.push(intake);
    }
    if (q) {
      params.push(`%${q}%`);
      const qp = `$${p++}`;
      wh.push(`(
        u.name ILIKE ${qp} OR u.email ILIKE ${qp} OR u.id = ${qp}
        OR sp.school ILIKE ${qp} OR sp.program ILIKE ${qp}
      )`);
    }
    const whereSql = wh.length ? `WHERE ${wh.join(" AND ")}` : "";

    const orderSql =
      sort === "oldest"
        ? `ORDER BY u."createdAt" ASC`
        : `ORDER BY u."createdAt" DESC`;

    // Base fetch with explicit aliases (no u.* to avoid collisions)
    params.push(take, skip);
    const base = await query(
      `
      SELECT
        u.id,
        u.name,
        u.email,
        u.phone,
        u.status,
        u."createdAt"::timestamptz::text           AS "u_createdAt",
        COALESCE(u."lastLoginAt", sp."updatedAt", u."updatedAt", u."createdAt")::timestamptz::text AS "u_lastActiveAt",
        sp."avatarUrl"   AS "sp_avatarUrl",
        sp.school        AS "sp_school",
        sp.program       AS "sp_program",
        sp.intake        AS "sp_intake",
        sp."targetCity"  AS "sp_targetCity",
        sp."adminNotes"  AS "sp_adminNotes",
        sp."kycStatus"   AS "sp_kycStatus",
        (SELECT COUNT(*)::int FROM "Booking" b WHERE b."studentId" = u.id) AS bookings
      FROM "User" u
      LEFT JOIN "StudentProfile" sp ON sp."userId" = u.id
      ${whereSql}
      ${orderSql}
      LIMIT $${p++} OFFSET $${p++}
      `,
      params
    );

    const total = (
      await query(
        `
        SELECT COUNT(*)::int AS c
        FROM "User" u
        LEFT JOIN "StudentProfile" sp ON sp."userId" = u.id
        ${whereSql}
        `,
        params.slice(0, p - 3) // same params except limit/offset
      )
    ).rows[0].c;

    const ids = base.rows.map((r) => r.id);

    // Verified docs count per student
    const docsAgg = ids.length
      ? await query(
          `
          SELECT "userId", COUNT(*)::int AS c
          FROM "StudentDoc"
          WHERE "userId" = ANY($1::text[]) AND status = 'Verified'
          GROUP BY "userId"
          `,
          [ids]
        )
      : { rows: [] };
    const docsMap = new Map(docsAgg.rows.map((r) => [r.userId, r.c]));

    const DOCS_REQUIRED = 4;
    let items = base.rows.map((u) => {
      const docsCount = docsMap.get(u.id) || 0;
      return {
        id: u.id,
        name: u.name || "",
        email: u.email,
        phone: u.phone || "",
        school: u.sp_school || "",
        program: u.sp_program || "",
        intake: u.sp_intake || "",
        region: u.sp_targetCity || "—",
        docsCount,
        docsRequired: DOCS_REQUIRED,
        kycStatus: mapKycOut(u.sp_kycStatus || "NOT_STARTED"),
        status: mapUserStatusOut(u.status),
        bookings: u.bookings || 0,
        createdAt: u.u_createdAt || null,
        lastActiveAt: u.u_lastActiveAt || null,
        avatar: u.sp_avatarUrl || null,
      };
    });

    // Secondary sorts (optional client-side re-sort on current page)
    if (sort === "bookings") {
      items.sort((a, b) => (b.bookings || 0) - (a.bookings || 0));
    } else if (sort === "docs") {
      const score = (r) => (r.docsRequired ? r.docsCount / r.docsRequired : 0);
      items.sort((a, b) => score(b) - score(a));
    }

    res.json({ items, total, take, skip });
  }
);

// DETAIL
router.get(
  "/:id",
  authRequired,
  requireRole("ADMIN", "SUPERADMIN"),
  async (req, res) => {
    // User + profile with explicit aliases
    const uRes = await query(
      `
      SELECT
        u.id                    AS "u_id",
        u.name                  AS "u_name",
        u.email                 AS "u_email",
        u.phone                 AS "u_phone",
        u.status                AS "u_status",
        u."createdAt"::timestamptz::text           AS "u_createdAt",
        COALESCE(u."lastLoginAt", sp."updatedAt", u."updatedAt", u."createdAt")::timestamptz::text AS "u_lastActiveAt",
        sp."avatarUrl"          AS "sp_avatarUrl",
        sp.school               AS "sp_school",
        sp.program              AS "sp_program",
        sp.intake               AS "sp_intake",
        sp."targetCity"         AS "sp_targetCity",
        sp."adminNotes"         AS "sp_adminNotes",
        sp."kycStatus"          AS "sp_kycStatus"
      FROM "User" u
      LEFT JOIN "StudentProfile" sp ON sp."userId" = u.id
      WHERE u.id = $1

      `,
      [req.params.id]
    );

    // confirm student role & not deleted
    const roleRow = await query(
      `SELECT role, "deletedAt" FROM "User" WHERE id=$1`,
      [req.params.id]
    );
    const role = roleRow.rows[0];
    const u = uRes.rows[0];
    if (!u || !role || role.role !== "STUDENT" || role.deletedAt) {
      return res.status(404).json({ error: "Student not found" });
    }

    // Documents
    const docs = (
      await query(
        `
        SELECT
          id, filename, mime, size, url, category, status,
          "createdAt"::timestamptz::text AS "createdAt"
        FROM "StudentDoc"
        WHERE "userId" = $1
        ORDER BY "createdAt" DESC
        `,
        [u.u_id]
      )
    ).rows;

    // Bookings + listing info
    const bookings = (
      await query(
        `
        SELECT
          b.id                     AS "b_id",
          b.status                 AS "b_status",
          b."checkIn"::timestamptz::text   AS "b_checkIn",
          b."checkOut"::timestamptz::text  AS "b_checkOut",
          b."createdAt"::timestamptz::text AS "b_createdAt",
          b."docIds"               AS "b_docIds",
          l.id                     AS "l_id",
          l.title                  AS "l_title",
          l.city                   AS "l_city"
        FROM "Booking" b
        JOIN "Listing" l ON l.id = b."listingId"
        WHERE b."studentId" = $1
        ORDER BY b."createdAt" DESC
        `,
        [u.u_id]
      )
    ).rows;

    // Payments
    const payments = (
      await query(
        `
        SELECT
          p.id,
          p.type,
          p."bookingId",
          p."amountCents",
          p.currency,
          p.status,
          p."stripePaymentIntentId",
          p."receiptUrl",
          p."cardBrand",
          p."cardLast4",
          p."createdAt"::timestamptz::text AS "createdAt",
          l.title AS "listingTitle"
        FROM "StudentPayment" p
        LEFT JOIN "Booking" b ON b.id = p."bookingId"
        LEFT JOIN "Listing" l ON l.id = b."listingId"
        WHERE p."userId" = $1
        ORDER BY p."createdAt" DESC
        `,
        [u.u_id]
      )
    ).rows;

    // Refunds
    const refunds = (
      await query(
        `
        SELECT
          r.id,
          r."paymentId",
          r."amountCents",
          r.currency,
          r.reason,
          r.status,
          r."createdAt"::timestamptz::text   AS "createdAt",
          r."processedAt"::timestamptz::text AS "processedAt"
        FROM "RefundRequest" r
        WHERE r."userId" = $1
        ORDER BY r."createdAt" DESC
        `,
        [u.u_id]
      )
    ).rows;

    const DOCS_REQUIRED = 4;
    const docsVerified = docs.filter((d) => d.status === "Verified").length;

    const presentDoc = (d) => ({
      id: d.id,
      name: d.filename,
      mime: d.mime,
      size: d.size,
      url: d.url,
      downloadUrl: d.url?.startsWith("http")
        ? d.url
        : `${API_PUBLIC_URL}${d.url}`,
      category: d.category || "Other",
      status: d.status || "Pending",
      createdAt: d.createdAt,
    });

    const presentBooking = (r) => ({
      id: r.b_id,
      status: r.b_status,
      checkIn: r.b_checkIn,
      checkOut: r.b_checkOut,
      createdAt: r.b_createdAt,
      docsCount: Array.isArray(r.b_docIds) ? r.b_docIds.length : 0,
      listing: {
        id: r.l_id,
        title: r.l_title,
        city: r.l_city,
      },
    });

    const item = {
      id: u.u_id,
      name: u.u_name || "",
      email: u.u_email,
      phone: u.u_phone || "",
      avatar: u.sp_avatarUrl || null,
      region: u.sp_targetCity || "—",

      school: u.sp_school || "",
      program: u.sp_program || "",
      intake: u.sp_intake || "",

      kycStatus:
        u.sp_kycStatus === "VERIFIED"
          ? "Passed"
          : u.sp_kycStatus === "FAILED"
          ? "Failed"
          : "Pending",
      status: mapUserStatusOut(u.u_status),

      createdAt: u.u_createdAt || null,
      lastActiveAt: u.u_lastActiveAt || null,

      docsRequired: DOCS_REQUIRED,
      docsCount: Math.min(docsVerified, DOCS_REQUIRED),

      notes: u.sp_adminNotes || "",

      docs: docs.map(presentDoc),
      bookings: bookings.map(presentBooking),
      payments,
      refunds,
    };

    res.json({ item });
  }
);

// ACTIONS: KYC
router.patch(
  "/:id/kyc",
  authRequired,
  requireRole("ADMIN", "SUPERADMIN"),
  async (req, res) => {
    const Body = z.object({
      kycStatus: z.enum(["Passed", "Pending", "Failed"]),
    });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: parsed.error.flatten() });

    const usr = await query(
      `SELECT id, role, "deletedAt" FROM "User" WHERE id = $1`,
      [req.params.id]
    );
    const u = usr.rows[0];
    if (!u || u.role !== "STUDENT" || u.deletedAt) {
      return res.status(404).json({ error: "Student not found" });
    }

    const { rows } = await query(
      `
      INSERT INTO "StudentProfile"(id, "userId", "kycStatus", "createdAt", "updatedAt")
      VALUES (gen_random_uuid()::text, $1, $2, NOW(), NOW())
      ON CONFLICT ("userId") DO UPDATE SET "kycStatus" = EXCLUDED."kycStatus", "updatedAt" = NOW()
      RETURNING *
      `,
      [u.id, mapKycIn(parsed.data.kycStatus)]
    );

    res.json({ ok: true, profile: rows[0] });
  }
);

// ACTIONS: account status
router.patch(
  "/:id/status",
  authRequired,
  requireRole("ADMIN", "SUPERADMIN"),
  async (req, res) => {
    const Body = z.object({ status: z.enum(["Active", "Suspended"]) });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: parsed.error.flatten() });

    const usr = await query(
      `SELECT id, role, "deletedAt" FROM "User" WHERE id = $1`,
      [req.params.id]
    );
    const u = usr.rows[0];
    if (!u || u.role !== "STUDENT" || u.deletedAt) {
      return res.status(404).json({ error: "Student not found" });
    }

    const updated = await query(
      `UPDATE "User" SET status = $1, "updatedAt" = NOW() WHERE id = $2 RETURNING *`,
      [mapUserStatusIn(parsed.data.status), u.id]
    );
    res.json({ ok: true, user: updated.rows[0] });
  }
);

// ACTIONS: internal notes
router.patch(
  "/:id/notes",
  authRequired,
  requireRole("ADMIN", "SUPERADMIN"),
  async (req, res) => {
    const Body = z.object({ notes: z.string().optional().default("") });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: parsed.error.flatten() });

    const usr = await query(
      `SELECT id, role, "deletedAt" FROM "User" WHERE id = $1`,
      [req.params.id]
    );
    const u = usr.rows[0];
    if (!u || u.role !== "STUDENT" || u.deletedAt) {
      return res.status(404).json({ error: "Student not found" });
    }

    const { rows } = await query(
      `
      INSERT INTO "StudentProfile"(id, "userId", "adminNotes", "createdAt", "updatedAt")
      VALUES (gen_random_uuid()::text, $1, $2, NOW(), NOW())
      ON CONFLICT ("userId") DO UPDATE SET "adminNotes" = EXCLUDED."adminNotes", "updatedAt" = NOW()
      RETURNING *
      `,
      [u.id, parsed.data.notes || ""]
    );

    res.json({ ok: true, profile: rows[0] });
  }
);

// ACTIONS: document review status
router.patch(
  "/:id/docs/:docId",
  authRequired,
  requireRole("ADMIN", "SUPERADMIN"),
  async (req, res) => {
    const Body = z.object({
      status: z.enum(["Verified", "Rejected", "Pending"]),
    });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: parsed.error.flatten() });

    const dRes = await query(`SELECT * FROM "StudentDoc" WHERE id = $1`, [
      req.params.docId,
    ]);
    const d = dRes.rows[0];
    if (!d || d.userId !== req.params.id) {
      return res.status(404).json({ error: "Document not found" });
    }

    const updated = await query(
      `UPDATE "StudentDoc" SET status = $1 WHERE id = $2 RETURNING *`,
      [parsed.data.status, d.id]
    );

    const presentDoc = (x) => ({
      id: x.id,
      name: x.filename,
      mime: x.mime,
      size: x.size,
      url: x.url,
      downloadUrl: x.url?.startsWith("http")
        ? x.url
        : `${API_PUBLIC_URL}${x.url}`,
      category: x.category || "Other",
      status: x.status || "Pending",
      createdAt: x.createdAt,
    });

    res.json({ ok: true, doc: presentDoc(updated.rows[0]) });
  }
);

// ==== Conversations (Admin ↔ Student) =======================================
const NewThreadBody = z.object({
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(5000),
  bookingId: z.string().optional().nullable(),
});

const ReplyBody = z.object({
  body: z.string().min(1).max(5000),
});

// List threads for a student (with last message + booking/listing summary)
router.get(
  "/:id/messages",
  authRequired,
  requireRole("ADMIN", "SUPERADMIN"),
  async (req, res) => {
    const studentId = req.params.id;

    const { rows } = await query(
      `
      SELECT
        t.id,
        t.subject,
        t.status,
        t."bookingId",
        t."createdAt",
        t."updatedAt",
        b.id            AS "bk_id",
        b."checkIn"     AS "bk_checkIn",
        b."checkOut"    AS "bk_checkOut",
        l.title         AS "listingTitle",
        l.city          AS "listingCity",
        lm."m_id",
        lm."m_body",
        lm."m_sender",
        lm."m_createdAt"
      FROM "MessageThread" t
      LEFT JOIN "Booking" b     ON b.id = t."bookingId"
      LEFT JOIN "Listing" l     ON l.id = b."listingId"
      LEFT JOIN LATERAL (
        SELECT m.id AS "m_id", m.body AS "m_body", m."senderType" AS "m_sender", m."createdAt" AS "m_createdAt"
        FROM "Message" m
        WHERE m."threadId" = t.id
        ORDER BY m."createdAt" DESC
        LIMIT 1
      ) lm ON TRUE
      WHERE t."studentId" = $1
      ORDER BY t."updatedAt" DESC
      `,
      [studentId]
    );

    const items = rows.map((r) => ({
      id: r.id,
      subject: r.subject || "General",
      status: r.status || "OPEN",
      booking: r.bk_id
        ? {
            id: r.bk_id,
            checkIn: r.bk_checkIn,
            checkOut: r.bk_checkOut,
            listingTitle: r.listingTitle || "",
            city: r.listingCity || "",
          }
        : null,
      lastMessage: r.m_id
        ? {
            id: r.m_id,
            sender: r.m_sender,
            body: r.m_body,
            createdAt: r.m_createdAt,
          }
        : null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));

    res.json({ items });
  }
);

// Get full thread (messages)
router.get(
  "/:id/messages/:threadId",
  authRequired,
  requireRole("ADMIN", "SUPERADMIN"),
  async (req, res) => {
    const studentId = req.params.id;
    const threadId = req.params.threadId;

    const t = await query(
      `SELECT * FROM "MessageThread" WHERE id = $1 AND "studentId" = $2`,
      [threadId, studentId]
    );
    const thread = t.rows[0];
    if (!thread) return res.status(404).json({ error: "Thread not found" });

    const msgs = (
      await query(
        `SELECT id, "senderType" AS sender, "senderId", body, "createdAt"
         FROM "Message"
         WHERE "threadId" = $1
         ORDER BY "createdAt" ASC`,
        [threadId]
      )
    ).rows;

    res.json({
      thread: {
        id: thread.id,
        subject: thread.subject || "General",
        status: thread.status || "OPEN",
        bookingId: thread.bookingId || null,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
      },
      messages: msgs,
    });
  }
);

// Reply inside a thread (ADMIN -> STUDENT) + email notify student
router.post(
  "/:id/messages/:threadId/reply",
  authRequired,
  requireRole("ADMIN", "SUPERADMIN"),
  async (req, res) => {
    const studentId = req.params.id;
    const threadId = req.params.threadId;

    const parsed = ReplyBody.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const t = await query(
      `SELECT id FROM "MessageThread" WHERE id = $1 AND "studentId" = $2`,
      [threadId, studentId]
    );
    if (!t.rows[0]) return res.status(404).json({ error: "Thread not found" });

    const { rows: mrows } = await query(
      `INSERT INTO "Message"(id, "threadId", "senderType", "senderRole", "senderId", body, "createdAt")
       VALUES (gen_random_uuid()::text, $1, 'ADMIN', 'ADMIN', $2, $3, NOW())
       RETURNING id, "senderType" AS sender, "senderId", body, "createdAt"`,
      [threadId, req.user.id, parsed.data.body]
    );

    await query(
      `UPDATE "MessageThread" SET "updatedAt" = NOW() WHERE id = $1`,
      [threadId]
    );

    res.status(201).json({ message: mrows[0] });

    // ---- Email notify the student (fire-and-forget) ----
    try {
      const stu = await query(
        `SELECT name, email FROM "User" WHERE id = $1 AND role='STUDENT' AND "deletedAt" IS NULL`,
        [studentId]
      );
      const student = stu.rows[0];

      const meta = await query(
        `
        SELECT t.subject, l.title AS "listingTitle"
        FROM "MessageThread" t
        LEFT JOIN "Booking" b ON b.id = t."bookingId"
        LEFT JOIN "Listing" l ON l.id = b."listingId"
        WHERE t.id = $1
        `,
        [threadId]
      );
      const subject =
        meta.rows[0]?.subject ||
        (meta.rows[0]?.listingTitle
          ? `Update about ${meta.rows[0].listingTitle}`
          : "New message from Support");

      if (student?.email) {
        notifyStudentConversationEmail({
          to: student.email,
          subject,
          body: parsed.data.body,
          threadId,
          studentName: student.name || "",
        }).catch((e) =>
          console.warn("notifyStudentConversationEmail failed:", e.message)
        );
      }
    } catch (e) {
      console.warn("Email dispatch (admin reply) failed:", e.message);
    }
  }
);

// Start a new thread for a student (optional bookingId) + email notify student
router.post(
  "/:id/messages",
  authRequired,
  requireRole("ADMIN", "SUPERADMIN"),
  async (req, res) => {
    const studentId = req.params.id;
    const parsed = NewThreadBody.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const { subject, body, bookingId } = parsed.data;

    // (Optional) validate booking belongs to the same student
    if (bookingId) {
      const ok = await query(
        `SELECT id FROM "Booking" WHERE id = $1 AND "studentId" = $2`,
        [bookingId, studentId]
      );
      if (!ok.rows[0])
        return res
          .status(400)
          .json({ error: "Invalid bookingId for this student" });
    }

    const t = await query(
      `INSERT INTO "MessageThread"(id, "studentId", "bookingId", subject, status, "createdAt", "updatedAt")
       VALUES (gen_random_uuid()::text, $1, $2, $3, 'OPEN', NOW(), NOW())
       RETURNING *`,
      [studentId, bookingId || null, subject]
    );
    const thread = t.rows[0];

    await query(
      `INSERT INTO "Message"(id, "threadId", "senderType", "senderRole", "senderId", body, "createdAt")
       VALUES (gen_random_uuid()::text, $1, 'ADMIN', 'ADMIN', $2, $3, NOW())`,
      [thread.id, req.user.id, body]
    );

    res.status(201).json({
      thread: {
        id: thread.id,
        subject: thread.subject || "General",
        status: thread.status || "OPEN",
        bookingId: thread.bookingId || null,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
      },
    });

    // ---- Email notify the student (fire-and-forget) ----
    try {
      const stu = await query(
        `SELECT name, email FROM "User" WHERE id = $1 AND role='STUDENT' AND "deletedAt" IS NULL`,
        [studentId]
      );
      const student = stu.rows[0];
      if (student?.email) {
        notifyStudentConversationEmail({
          to: student.email,
          subject: subject || "New message from Support",
          body,
          threadId: thread.id,
          studentName: student.name || "",
        }).catch((e) =>
          console.warn("notifyStudentConversationEmail failed:", e.message)
        );
      }
    } catch (e) {
      console.warn("Email dispatch (admin new thread) failed:", e.message);
    }
  }
);

export default router;
