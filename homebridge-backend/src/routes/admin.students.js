// src/routes/admin.students.js
import { Router } from "express";
import { authRequired } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { z } from "zod";
import { query } from "../db.js";

const router = Router();

const API_PUBLIC_URL = (process.env.API_PUBLIC_URL || "http://localhost:4000").replace(/\/$/, "");

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
        u."createdAt"                                      AS "u_createdAt",
        COALESCE(u."lastLoginAt", u."updatedAt", u."createdAt") AS "u_lastActiveAt",

        sp.id            AS "spId",
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
        u."createdAt"           AS "u_createdAt",
        COALESCE(u."lastLoginAt", u."updatedAt", u."createdAt") AS "u_lastActiveAt",

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
    const roleRow = await query(`SELECT role, "deletedAt" FROM "User" WHERE id=$1`, [req.params.id]);
    const role = roleRow.rows[0];
    const u = uRes.rows[0];
    if (!u || !role || role.role !== "STUDENT" || role.deletedAt) {
      return res.status(404).json({ error: "Student not found" });
    }

    // Documents (include status; alias createdAt for consistency)
    const docs = (
      await query(
        `
        SELECT
          id, filename, mime, size, url, category, status,
          "createdAt" AS "createdAt"
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
          b."checkIn"              AS "b_checkIn",
          b."checkOut"             AS "b_checkOut",
          b."createdAt"            AS "b_createdAt",
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

    const DOCS_REQUIRED = 4;
    const docsVerified = docs.filter((d) => d.status === "Verified").length;

    const presentDoc = (d) => ({
      id: d.id,
      name: d.filename,
      mime: d.mime,
      size: d.size,
      url: d.url,
      downloadUrl: d.url?.startsWith("http") ? d.url : `${API_PUBLIC_URL}${d.url}`,
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
    const Body = z.object({ kycStatus: z.enum(["Passed", "Pending", "Failed"]) });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const usr = await query(`SELECT id, role, "deletedAt" FROM "User" WHERE id = $1`, [req.params.id]);
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
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const usr = await query(`SELECT id, role, "deletedAt" FROM "User" WHERE id = $1`, [req.params.id]);
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
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const usr = await query(`SELECT id, role, "deletedAt" FROM "User" WHERE id = $1`, [req.params.id]);
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
    const Body = z.object({ status: z.enum(["Verified", "Rejected", "Pending"]) });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const dRes = await query(`SELECT * FROM "StudentDoc" WHERE id = $1`, [req.params.docId]);
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
      downloadUrl: x.url?.startsWith("http") ? x.url : `${API_PUBLIC_URL}${x.url}`,
      category: x.category || "Other",
      status: x.status || "Pending",
      createdAt: x.createdAt,
    });

    res.json({ ok: true, doc: presentDoc(updated.rows[0]) });
  }
);

export default router;
