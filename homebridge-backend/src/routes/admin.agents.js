import { Router } from "express";
import { authRequired } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { z } from "zod";
import { query, tx } from "../db.js";

const router = Router();

/* ---------------- helpers & mappers ---------------- */

const displayStatusFromUser = (userStatus) => {
  const s = String(userStatus || "").toUpperCase();
  if (s === "SUSPENDED") return "Suspended";
  if (s === "INVITED") return "Pending";
  return "Verified";
};
const userStatusFromDisplay = (display) => {
  const s = String(display || "").toUpperCase();
  if (s === "SUSPENDED") return "SUSPENDED";
  if (s === "PENDING") return "INVITED";
  return "ACTIVE";
};
const displayKycFromProfile = (kyc) => {
  const s = String(kyc || "").toUpperCase();
  if (s === "PASSED" || s === "VERIFIED") return "Passed";
  if (s === "FAILED") return "Failed";
  return "Pending";
};
const kycEnumFromDisplay = (display) => {
  const s = String(display || "").toUpperCase();
  if (s === "PASSED") return "PASSED";
  if (s === "FAILED") return "FAILED";
  return "PENDING";
};
const prettyAgentId = (id) => {
  const raw = String(id || "");
  const first = raw.includes("-") ? raw.split("-")[0] : raw.slice(0, 8);
  return `AG-${(first || "00000000").toUpperCase()}`;
};

function presentListRow({ user, profile, listings = 0, applications = 0 }) {
  return {
    id: user.id,
    displayId: prettyAgentId(user.id),
    company: profile?.orgName || "—",
    contactName: [profile?.first, profile?.last].filter(Boolean).join(" ") || user.name || "—",
    email: profile?.email || user.email,
    phone: profile?.phone || null,
    region: profile?.city || null,
    avatar: profile?.avatarUrl || null,
    status: displayStatusFromUser(user.status),
    kycStatus: displayKycFromProfile(profile?.kycStatus),
    listings,
    applications,
    rating: typeof profile?.rating === "number" ? profile.rating : 0,
    createdAt: user.createdAt,
    lastActiveAt: user.lastLoginAt || null,
  };
}

function presentDoc(d) {
  return {
    id: d.id,
    name: d.filename,
    category: d.category || "Other",
    status: d.status || "Pending",
    mime: d.mime || null,
    size: d.size || 0,
    url: d.url,
    downloadUrl: d.url,
    uploadedAt: d.createdAt,
  };
}

/* ---------------- zod bodies ---------------- */

const PatchNotesSchema = z.object({
  notes: z.string().optional(),
  company: z.string().optional(),
  contactFirst: z.string().optional(),
  contactLast: z.string().optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  city: z.string().optional(),
});

const PatchStatusSchema = z.object({
  status: z.enum(["Verified", "Pending", "Suspended"]),
});

const PatchKycSchema = z.object({
  kycStatus: z.enum(["Passed", "Pending", "Failed"]),
});

const PatchDocSchema = z.object({
  status: z.enum(["Pending", "Verified", "Rejected"]),
});

/* ---------------- routes ---------------- */

// LIST agents
router.get("/", authRequired, requireRole("ADMIN", "SUPERADMIN"), async (_req, res) => {
  // users + profile
  const usersRes = await query(
    `SELECT
       u.*,
       ap.id AS "apId", ap."userId" AS "apUserId", ap.first, ap.last, ap.email AS "apEmail",
       ap.phone, ap.city, ap."orgName", ap."avatarUrl", ap."kycStatus", ap.rating
     FROM "User" u
     LEFT JOIN "AgentProfile" ap ON ap."userId" = u.id
     WHERE u.role = 'AGENT' AND u."deletedAt" IS NULL
     ORDER BY u."createdAt" DESC`
  );
  const users = usersRes.rows;
  if (!users.length) return res.json({ items: [] });

  const agentIds = users.map((u) => u.id);

  // listings count per agent
  const listCounts = await query(
    `SELECT "agentId", COUNT(*)::int AS c
     FROM "Listing"
     WHERE "agentId" = ANY($1::text[])
     GROUP BY "agentId"`,
    [agentIds]
  );
  const listingsMap = new Map(listCounts.rows.map((r) => [r.agentId, r.c]));

  // applications count (bookings on listings owned by agent)
  const apps = await query(
    `SELECT l."agentId", COUNT(b.id)::int AS c
     FROM "Booking" b
     JOIN "Listing" l ON l.id = b."listingId"
     WHERE l."agentId" = ANY($1::text[])
     GROUP BY l."agentId"`,
    [agentIds]
  );
  const appsMap = new Map(apps.rows.map((r) => [r.agentId, r.c]));

  const items = users.map((u) =>
    presentListRow({
      user: u,
      profile: {
        orgName: u.orgName,
        first: u.first,
        last: u.last,
        email: u.apEmail,
        phone: u.phone,
        city: u.city,
        avatarUrl: u.avatarUrl,
        kycStatus: u.kycStatus,
        rating: u.rating,
      },
      listings: listingsMap.get(u.id) || 0,
      applications: appsMap.get(u.id) || 0,
    })
  );

  res.json({ items, total: items.length });
});

// GET one agent detail
router.get("/:id", authRequired, requireRole("ADMIN", "SUPERADMIN"), async (req, res) => {
  const uRes = await query(
    `SELECT u.*, ap.*
     FROM "User" u
     LEFT JOIN "AgentProfile" ap ON ap."userId" = u.id
     WHERE u.id = $1`,
    [req.params.id]
  );
  const u = uRes.rows[0];
  if (!u || u.role !== "AGENT" || u.deletedAt) {
    return res.status(404).json({ error: "Agent not found" });
  }

  const [listings, applications, docs] = await Promise.all([
    query(`SELECT COUNT(*)::int AS c FROM "Listing" WHERE "agentId" = $1`, [u.id]),
    query(
      `SELECT COUNT(*)::int AS c
       FROM "Booking" b
       JOIN "Listing" l ON l.id = b."listingId"
       WHERE l."agentId" = $1`,
      [u.id]
    ),
    query(
      `SELECT * FROM "AgentDoc" WHERE "userId" = $1 ORDER BY "createdAt" DESC`,
      [u.id]
    ),
  ]);

  const item = {
    ...presentListRow({
      user: u,
      profile: {
        orgName: u.orgName,
        first: u.first,
        last: u.last,
        email: u.email, // from AgentProfile row alias is same as column
        phone: u.phone,
        city: u.city,
        avatarUrl: u.avatarUrl,
        kycStatus: u.kycStatus,
        rating: u.rating,
      },
      listings: listings.rows[0].c,
      applications: applications.rows[0].c,
    }),
    company: u.orgName || "—",
    contactFirst: u.first || "",
    contactLast: u.last || "",
    notes: u.notes || "",
    docs: docs.rows.map(presentDoc),
  };

  res.json({ item });
});

// PATCH general fields / notes
router.patch("/:id", authRequired, requireRole("ADMIN", "SUPERADMIN"), async (req, res) => {
  const parsed = PatchNotesSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const uRes = await query(`SELECT id, role, "deletedAt", email FROM "User" WHERE id = $1`, [
    req.params.id,
  ]);
  const user = uRes.rows[0];
  if (!user || user.role !== "AGENT" || user.deletedAt) {
    return res.status(404).json({ error: "Agent not found" });
  }

  const d = parsed.data;

  // upsert AgentProfile
  const { rows } = await query(
    `
    INSERT INTO "AgentProfile" (
      id, "userId", "orgName", first, last, email, phone, city, notes,
      "createdAt", "updatedAt"
    ) VALUES (
      gen_random_uuid()::text, $1, COALESCE($2,''), COALESCE($3,''), COALESCE($4,''),
      COALESCE($5,$6), COALESCE($7,''), COALESCE($8,''), COALESCE($9,''),
      NOW(), NOW()
    )
    ON CONFLICT ("userId") DO UPDATE SET
      "orgName" = COALESCE(EXCLUDED."orgName","AgentProfile"."orgName"),
      first = COALESCE(EXCLUDED.first,"AgentProfile".first),
      last = COALESCE(EXCLUDED.last,"AgentProfile".last),
      email = COALESCE(EXCLUDED.email,"AgentProfile".email),
      phone = COALESCE(EXCLUDED.phone,"AgentProfile".phone),
      city  = COALESCE(EXCLUDED.city,"AgentProfile".city),
      notes = COALESCE(EXCLUDED.notes,"AgentProfile".notes),
      "updatedAt" = NOW()
    RETURNING *`,
    [
      user.id,
      d.company ?? null,
      d.contactFirst ?? null,
      d.contactLast ?? null,
      d.email ?? null,
      user.email,
      d.phone ?? null,
      d.city ?? null,
      d.notes ?? null,
    ]
  );

  res.json({ profile: rows[0] });
});

// PATCH status
router.patch("/:id/status", authRequired, requireRole("ADMIN", "SUPERADMIN"), async (req, res) => {
  const parsed = PatchStatusSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const uRes = await query(`SELECT id, role, "deletedAt" FROM "User" WHERE id = $1`, [
    req.params.id,
  ]);
  const user = uRes.rows[0];
  if (!user || user.role !== "AGENT" || user.deletedAt) {
    return res.status(404).json({ error: "Agent not found" });
  }

  const { rows } = await query(
    `UPDATE "User" SET status = $1, "updatedAt" = NOW() WHERE id = $2 RETURNING id, status`,
    [userStatusFromDisplay(parsed.data.status), user.id]
  );

  res.json({ user: rows[0] });
});

// PATCH KYC status
router.patch("/:id/kyc", authRequired, requireRole("ADMIN", "SUPERADMIN"), async (req, res) => {
  const parsed = PatchKycSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const uRes = await query(`SELECT id, role, "deletedAt" FROM "User" WHERE id = $1`, [
    req.params.id,
  ]);
  const user = uRes.rows[0];
  if (!user || user.role !== "AGENT" || user.deletedAt) {
    return res.status(404).json({ error: "Agent not found" });
  }

  const { rows } = await query(
    `
    INSERT INTO "AgentProfile"(id, "userId", "kycStatus", "createdAt", "updatedAt")
    VALUES (gen_random_uuid()::text, $1, $2, NOW(), NOW())
    ON CONFLICT ("userId") DO UPDATE SET "kycStatus" = EXCLUDED."kycStatus", "updatedAt" = NOW()
    RETURNING *`,
    [user.id, kycEnumFromDisplay(parsed.data.kycStatus)]
  );

  res.json({ profile: rows[0] });
});

// PATCH a KYC document status
router.patch("/:id/docs/:docId", authRequired, requireRole("ADMIN", "SUPERADMIN"), async (req, res) => {
  const parsed = PatchDocSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const uRes = await query(`SELECT id, role, "deletedAt" FROM "User" WHERE id = $1`, [
    req.params.id,
  ]);
  const user = uRes.rows[0];
  if (!user || user.role !== "AGENT" || user.deletedAt) {
    return res.status(404).json({ error: "Agent not found" });
  }

  const docRes = await query(`SELECT * FROM "AgentDoc" WHERE id = $1`, [req.params.docId]);
  const doc = docRes.rows[0];
  if (!doc || doc.userId !== user.id) return res.status(404).json({ error: "Document not found" });

  const { rows } = await query(
    `UPDATE "AgentDoc" SET status = $1 WHERE id = $2 RETURNING *`,
    [parsed.data.status, doc.id]
  );

  res.json({ doc: presentDoc(rows[0]) });
});

export default router;
