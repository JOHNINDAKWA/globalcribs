import { Router } from "express";
import { authRequired } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { z } from "zod";
import { query } from "../db.js";

const router = Router();

const API_PUBLIC_URL = (process.env.API_PUBLIC_URL || "http://localhost:4000").replace(/\/$/, "");

// helpers
const mapUserStatusOut = (s) => (s === "ACTIVE" ? "Active" : s === "SUSPENDED" ? "Suspended" : "Invited");
const mapUserStatusIn = (s) => (String(s || "").toUpperCase() === "ACTIVE" ? "ACTIVE" : "SUSPENDED");
const mapKycOut = (e) => (e === "VERIFIED" ? "Passed" : e === "FAILED" ? "Failed" : "Pending");
const mapKycIn = (s) => {
  const t = String(s || "").toLowerCase();
  if (t === "passed") return "VERIFIED";
  if (t === "failed") return "FAILED";
  return "SUBMITTED";
};

function relPickProfile(p) {
  return {
    phone: p?.phone || null,
    avatarUrl: p?.avatarUrl || null,
    school: p?.school || null,
    program: p?.program || null,
    intake: p?.intake || null,
    region: p?.targetCity || null,
    adminNotes: p?.adminNotes || null,
    kycStatus: mapKycOut(p?.kycStatus || "NOT_STARTED"),
  };
}
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
const presentBooking = (b) => ({
  id: b.id,
  status: b.status,
  listingId: b.listingId,
  checkIn: b.checkIn,
  checkOut: b.checkOut,
  docCount: Array.isArray(b.docIds) ? b.docIds.length : 0,
  createdAt: b.createdAt,
});

// LIST
router.get("/", authRequired, requireRole("ADMIN", "SUPERADMIN"), async (req, res) => {
  const take = Math.min(Number(req.query.take || 50), 100);
  const skip = Math.max(Number(req.query.skip || 0), 0);

  const q = String(req.query.q || "").trim();
  const kyc = String(req.query.kyc || "");
  const status = String(req.query.status || "");
  const intake = String(req.query.intake || "");
  const sort = String(req.query.sort || "newest");

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

  // Base fetch (profile + count(bookings))
  const orderSql = sort === "oldest" ? `ORDER BY u."createdAt" ASC` : `ORDER BY u."createdAt" DESC`;
  params.push(take, skip);
  const base = await query(
    `
    SELECT
      u.*,
      sp.id AS "spId", sp.phone, sp."avatarUrl", sp.school, sp.program, sp.intake, sp."targetCity",
      sp."adminNotes", sp."kycStatus",
      (SELECT COUNT(*)::int FROM "Booking" b WHERE b."studentId" = u.id) AS bookings
    FROM "User" u
    LEFT JOIN "StudentProfile" sp ON sp."userId" = u.id
    ${whereSql}
    ${orderSql}
    LIMIT $${p++} OFFSET $${p++}
    `,
    params
  );
  const total = (await query(
    `
    SELECT COUNT(*)::int AS c
    FROM "User" u
    LEFT JOIN "StudentProfile" sp ON sp."userId" = u.id
    ${whereSql}
    `,
    params.slice(0, p - 3) // same params except limit/offset
  )).rows[0].c;

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
    const pObj = {
      phone: u.phone,
      avatarUrl: u.avatarUrl,
      school: u.school,
      program: u.program,
      intake: u.intake,
      targetCity: u.targetCity,
      adminNotes: u.adminNotes,
      kycStatus: u.kycStatus,
    };
    const p = relPickProfile(pObj);
    const docsCount = docsMap.get(u.id) || 0;
    return {
      id: u.id,
      name: u.name || "",
      email: u.email,
      phone: p.phone || "",
      school: p.school || "",
      program: p.program || "",
      intake: p.intake || "",
      region: p.region || "—",
      docsCount,
      docsRequired: DOCS_REQUIRED,
      kycStatus: p.kycStatus,
      status: mapUserStatusOut(u.status),
      bookings: u.bookings || 0,
      createdAt: u.createdAt,
      lastActiveAt: u.lastLoginAt,
      avatar: p.avatarUrl || null,
    };
  });

  // Secondary sorts
  if (sort === "bookings") {
    items.sort((a, b) => (b.bookings || 0) - (a.bookings || 0));
  } else if (sort === "docs") {
    const score = (r) => (r.docsRequired ? r.docsCount / r.docsRequired : 0);
    items.sort((a, b) => score(b) - score(a));
  }

  res.json({ items, total, take, skip });
});

// DETAIL
router.get("/:id", authRequired, requireRole("ADMIN", "SUPERADMIN"), async (req, res) => {
  const uRes = await query(
    `
    SELECT u.*, sp.*
    FROM "User" u
    LEFT JOIN "StudentProfile" sp ON sp."userId" = u.id
    WHERE u.id = $1
    `,
    [req.params.id]
  );
  const u = uRes.rows[0];
  if (!u || u.role !== "STUDENT" || u.deletedAt) {
    return res.status(404).json({ error: "Student not found" });
  }

  const docs = (
    await query(
      `SELECT * FROM "StudentDoc" WHERE "userId" = $1 ORDER BY "createdAt" DESC`,
      [u.id]
    )
  ).rows;

  const bookings = (
    await query(`SELECT * FROM "Booking" WHERE "studentId" = $1 ORDER BY "createdAt" DESC`, [u.id])
  ).rows;

  const DOCS_REQUIRED = 4;
  const docsVerified = docs.filter((d) => d.status === "Verified").length;

  const profile = relPickProfile({
    phone: u.phone,
    avatarUrl: u.avatarUrl,
    school: u.school,
    program: u.program,
    intake: u.intake,
    targetCity: u.targetCity,
    adminNotes: u.adminNotes,
    kycStatus: u.kycStatus,
  });

  const item = {
    id: u.id,
    name: u.name || "",
    email: u.email,
    phone: profile.phone || "",
    avatar: profile.avatarUrl || null,
    region: profile.region || "—",
    school: profile.school || "",
    program: profile.program || "",
    intake: profile.intake || "",
    kycStatus: profile.kycStatus,
    status: mapUserStatusOut(u.status),
    createdAt: u.createdAt,
    lastActiveAt: u.lastLoginAt,
    docsRequired: DOCS_REQUIRED,
    docsCount: Math.min(docsVerified, DOCS_REQUIRED),
    notes: profile.adminNotes || "",
    docs: docs.map(presentDoc),
    bookings: bookings.map(presentBooking),
  };

  res.json({ item });
});

// ACTIONS: KYC
router.patch("/:id/kyc", authRequired, requireRole("ADMIN", "SUPERADMIN"), async (req, res) => {
  const Body = z.object({ kycStatus: z.enum(["Passed", "Pending", "Failed"]) });
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const usr = await query(`SELECT id, role, "deletedAt" FROM "User" WHERE id = $1`, [req.params.id]);
  const u = usr.rows[0];
  if (!u || u.role !== "STUDENT" || u.deletedAt) return res.status(404).json({ error: "Student not found" });

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
});

// ACTIONS: account status
router.patch("/:id/status", authRequired, requireRole("ADMIN", "SUPERADMIN"), async (req, res) => {
  const Body = z.object({ status: z.enum(["Active", "Suspended"]) });
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const usr = await query(`SELECT id, role, "deletedAt" FROM "User" WHERE id = $1`, [req.params.id]);
  const u = usr.rows[0];
  if (!u || u.role !== "STUDENT" || u.deletedAt) return res.status(404).json({ error: "Student not found" });

  const updated = await query(
    `UPDATE "User" SET status = $1, "updatedAt" = NOW() WHERE id = $2 RETURNING *`,
    [mapUserStatusIn(parsed.data.status), u.id]
  );
  res.json({ ok: true, user: updated.rows[0] });
});

// ACTIONS: internal notes
router.patch("/:id/notes", authRequired, requireRole("ADMIN", "SUPERADMIN"), async (req, res) => {
  const Body = z.object({ notes: z.string().optional().default("") });
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const usr = await query(`SELECT id, role, "deletedAt" FROM "User" WHERE id = $1`, [req.params.id]);
  const u = usr.rows[0];
  if (!u || u.role !== "STUDENT" || u.deletedAt) return res.status(404).json({ error: "Student not found" });

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
});

// ACTIONS: document review status
router.patch("/:id/docs/:docId", authRequired, requireRole("ADMIN", "SUPERADMIN"), async (req, res) => {
  const Body = z.object({ status: z.enum(["Verified", "Rejected", "Pending"]) });
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const dRes = await query(`SELECT * FROM "StudentDoc" WHERE id = $1`, [req.params.docId]);
  const d = dRes.rows[0];
  if (!d || d.userId !== req.params.id) return res.status(404).json({ error: "Document not found" });

  const updated = await query(
    `UPDATE "StudentDoc" SET status = $1 WHERE id = $2 RETURNING *`,
    [parsed.data.status, d.id]
  );

  res.json({ ok: true, doc: presentDoc(updated.rows[0]) });
});

export default router;
