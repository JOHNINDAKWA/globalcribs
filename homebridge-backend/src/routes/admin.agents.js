import { Router } from "express";
import { authRequired } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { z } from "zod";
import { query, tx } from "../db.js";

let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  const { default: Stripe } = await import("stripe");
  stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });
}




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
    contactName:
      [profile?.first, profile?.last].filter(Boolean).join(" ") ||
      user.name ||
      "—",
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



// zod schema near your other schemas
const PatchOnboardingOverrideSchema = z.object({
  waived: z.boolean(),
  reason: z.string().max(500).optional(),
});



const CreatePayoutBody = z.object({
  paymentIds: z.array(z.string()).optional(),  // if omitted => include all eligible
  feesCents: z.number().int().min(0).optional().default(0),
  note: z.string().max(1000).optional(),
  externalRef: z.string().max(200).optional(), // e.g., Stripe transfer id / bank ref
  periodStart: z.string().datetime().optional(),
  periodEnd: z.string().datetime().optional(),
});



/* ---------------- routes ---------------- */

// LIST agents
router.get(
  "/",
  authRequired,
  requireRole("ADMIN", "SUPERADMIN"),
  async (_req, res) => {
    const usersRes = await query(
      `SELECT
         u.id,
         u.email,
         u.role,
         u.status,
         u."createdAt"::timestamptz::text AS "createdAt",
         u."lastLoginAt"::timestamptz::text AS "lastLoginAt",
         ap.first,
         ap.last,
         ap.email AS "apEmail",
         ap.phone,
         ap.city,
         ap."orgName",
         ap."avatarUrl",
         ap."kycStatus",
         ap.rating
       FROM "User" u
       LEFT JOIN "AgentProfile" ap ON ap."userId" = u.id
       WHERE u.role = 'AGENT' AND u."deletedAt" IS NULL
       ORDER BY u."createdAt" DESC`
    );

    const users = usersRes.rows;
    if (!users.length) return res.json({ items: [] });

    const agentIds = users.map((u) => u.id);

    const listCounts = await query(
      `SELECT "agentId", COUNT(*)::int AS c
         FROM "Listing"
        WHERE "agentId" = ANY($1::text[])
        GROUP BY "agentId"`,
      [agentIds]
    );
    const listingsMap = new Map(listCounts.rows.map((r) => [r.agentId, r.c]));

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
  }
);

// GET one agent detail
router.get(
  "/:id",
  authRequired,
  requireRole("ADMIN", "SUPERADMIN"),
  async (req, res) => {
    const uRes = await query(
      `SELECT
         u.id, u.email, u.role, u.status,
         u."createdAt"::timestamptz::text AS "createdAt",
         u."lastLoginAt"::timestamptz::text AS "lastLoginAt",
         ap.first, ap.last, ap.email AS "apEmail", ap.phone, ap.city,
         ap."orgName", ap."avatarUrl", ap."kycStatus", ap.rating,
         ap.notes,
         ap."onboardingWaived", ap."onboardingWaivedAt"::timestamptz::text AS "onboardingWaivedAt",
         ap."onboardingPaidAt"::timestamptz::text AS "onboardingPaidAt",
         ap."onboardingAmountCents", ap."onboardingCurrency",
         ap."stripeAccountId", ap."stripePayoutsEnabled", ap."stripeChargesEnabled",
         ap."stripeDetailsSubmitted", ap."stripeCountry", ap."stripeRequirements",
         ap."stripeUpdatedAt"::timestamptz::text AS "stripeUpdatedAt"
       FROM "User" u
       LEFT JOIN "AgentProfile" ap ON ap."userId" = u.id
       WHERE u.id = $1`,
      [req.params.id]
    );
    const u = uRes.rows[0];
    if (!u || u.role !== "AGENT") {
      return res.status(404).json({ error: "Agent not found" });
    }

    const [listings, applications, docs] = await Promise.all([
      query(`SELECT COUNT(*)::int AS c FROM "Listing" WHERE "agentId" = $1`, [
        u.id,
      ]),
      query(
        `SELECT COUNT(*)::int AS c
           FROM "Booking" b
           JOIN "Listing" l ON l.id = b."listingId"
          WHERE l."agentId" = $1`,
        [u.id]
      ),
      query(
        `SELECT id, filename, category, status, mime, size, url,
                "createdAt"::timestamptz::text AS "createdAt"
           FROM "AgentDoc"
          WHERE "userId" = $1
          ORDER BY "createdAt" DESC`,
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
          email: u.apEmail || u.email,
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
      onboardingWaived: !!u.onboardingWaived,
      onboardingWaivedAt: u.onboardingWaivedAt,
      onboardingPaidAt: u.onboardingPaidAt,
      onboardingAmountCents:
        typeof u.onboardingAmountCents === "number"
          ? u.onboardingAmountCents
          : null,
      onboardingCurrency: u.onboardingCurrency || "USD",

      // Stripe snapshot
      stripeAccountId: u.stripeAccountId || null,
      stripePayoutsEnabled: !!u.stripePayoutsEnabled,
      stripeChargesEnabled: !!u.stripeChargesEnabled,
      stripeDetailsSubmitted: !!u.stripeDetailsSubmitted,
      stripeCountry: u.stripeCountry || null,
      stripeRequirements: u.stripeRequirements || null,
      stripeUpdatedAt: u.stripeUpdatedAt,
    };

    res.json({ item });
  }
);



// PATCH general fields / notes
router.patch(
  "/:id",
  authRequired,
  requireRole("ADMIN", "SUPERADMIN"),
  async (req, res) => {
    const parsed = PatchNotesSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: parsed.error.flatten() });

    const uRes = await query(
      `SELECT id, role, "deletedAt", email FROM "User" WHERE id = $1`,
      [req.params.id]
    );
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
  }
);

// PATCH status
router.patch(
  "/:id/status",
  authRequired,
  requireRole("ADMIN", "SUPERADMIN"),
  async (req, res) => {
    const parsed = PatchStatusSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: parsed.error.flatten() });

    const uRes = await query(
      `SELECT id, role, "deletedAt" FROM "User" WHERE id = $1`,
      [req.params.id]
    );
    const user = uRes.rows[0];
    if (!user || user.role !== "AGENT" || user.deletedAt) {
      return res.status(404).json({ error: "Agent not found" });
    }

    const { rows } = await query(
      `UPDATE "User" SET status = $1, "updatedAt" = NOW() WHERE id = $2 RETURNING id, status`,
      [userStatusFromDisplay(parsed.data.status), user.id]
    );

    res.json({ user: rows[0] });
  }
);

// PATCH KYC status
router.patch(
  "/:id/kyc",
  authRequired,
  requireRole("ADMIN", "SUPERADMIN"),
  async (req, res) => {
    const parsed = PatchKycSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: parsed.error.flatten() });

    const uRes = await query(
      `SELECT id, role, "deletedAt" FROM "User" WHERE id = $1`,
      [req.params.id]
    );
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
  }
);

// PATCH a KYC document status
router.patch(
  "/:id/docs/:docId",
  authRequired,
  requireRole("ADMIN", "SUPERADMIN"),
  async (req, res) => {
    const parsed = PatchDocSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: parsed.error.flatten() });

    const uRes = await query(
      `SELECT id, role, "deletedAt" FROM "User" WHERE id = $1`,
      [req.params.id]
    );
    const user = uRes.rows[0];
    if (!user || user.role !== "AGENT" || user.deletedAt) {
      return res.status(404).json({ error: "Agent not found" });
    }

    const docRes = await query(`SELECT * FROM "AgentDoc" WHERE id = $1`, [
      req.params.docId,
    ]);
    const doc = docRes.rows[0];
    if (!doc || doc.userId !== user.id)
      return res.status(404).json({ error: "Document not found" });

    const { rows } = await query(
      `UPDATE "AgentDoc" SET status = $1 WHERE id = $2 RETURNING *`,
      [parsed.data.status, doc.id]
    );

    res.json({ doc: presentDoc(rows[0]) });
  }
);


// PATCH /api/admin/agents/:id/onboarding
router.patch(
  "/:id/onboarding",
  authRequired,
  requireRole("ADMIN", "SUPERADMIN"),
  async (req, res) => {
    const parsed = PatchOnboardingOverrideSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: parsed.error.flatten() });

    const uRes = await query(
      `SELECT id, role, "deletedAt" FROM "User" WHERE id = $1`,
      [req.params.id]
    );
    const user = uRes.rows[0];
    if (!user || user.role !== "AGENT" || user.deletedAt) {
      return res.status(404).json({ error: "Agent not found" });
    }

    const { waived, reason } = parsed.data;

    const { rows } = await query(
      `
    INSERT INTO "AgentProfile" (
      id, "userId", "onboardingWaived", "onboardingWaivedAt", "onboardingWaivedBy", "onboardingWaiveReason", "createdAt", "updatedAt"
    ) VALUES (
      gen_random_uuid()::text, $1, $2, CASE WHEN $2 THEN NOW() ELSE NULL END, $3, $4, NOW(), NOW()
    )
    ON CONFLICT ("userId") DO UPDATE SET
      "onboardingWaived" = EXCLUDED."onboardingWaived",
      "onboardingWaivedAt" = CASE WHEN EXCLUDED."onboardingWaived" THEN NOW() ELSE NULL END,
      "onboardingWaivedBy" = CASE WHEN EXCLUDED."onboardingWaived" THEN $3 ELSE NULL END,
      "onboardingWaiveReason" = EXCLUDED."onboardingWaiveReason",
      "updatedAt" = NOW()
    RETURNING *`,
      [user.id, waived, req.user.id, reason ?? null]
    );

    res.json({
      profile: rows[0],
      message: waived
        ? "Onboarding fee waived; agent is unlocked."
        : "Waiver removed; agent must pay.",
    });
  }
);


// POST /api/admin/agents/:id/stripe/refresh
router.post(
  "/:id/stripe/refresh",
  authRequired,
  requireRole("ADMIN", "SUPERADMIN"),
  async (req, res) => {
    if (!stripe) return res.status(501).json({ error: "Stripe not configured" });

    // load agent & stripeAccountId
    const uRes = await query(
      `SELECT ap."stripeAccountId"
       FROM "User" u
       LEFT JOIN "AgentProfile" ap ON ap."userId" = u.id
       WHERE u.id = $1 AND u.role = 'AGENT' AND u."deletedAt" IS NULL`,
      [req.params.id]
    );
    const row = uRes.rows[0];
    if (!row) return res.status(404).json({ error: "Agent not found" });
    if (!row.stripeAccountId) {
      return res.status(400).json({ error: "Agent has no Stripe account yet." });
    }

    try {
      const acct = await stripe.accounts.retrieve(row.stripeAccountId);

      await query(
        `UPDATE "AgentProfile" SET
           "stripePayoutsEnabled"   = $2,
           "stripeChargesEnabled"   = $3,
           "stripeDetailsSubmitted" = $4,
           "stripeRequirements"     = $5,
           "stripeCountry"          = $6,
           "stripeUpdatedAt"        = NOW()
         WHERE "stripeAccountId" = $1`,
        [
          acct.id,
          !!acct.payouts_enabled,
          !!acct.charges_enabled,
          !!acct.details_submitted,
          acct.requirements || null,
          acct.country || null,
        ]
      );

      return res.json({
        connected: true,
        payoutsEnabled: !!acct.payouts_enabled,
        chargesEnabled: !!acct.charges_enabled,
        detailsSubmitted: !!acct.details_submitted,
        country: acct.country || null,
        requirements:
          (acct.requirements?.currently_due || []).join(", ") ||
          (acct.requirements?.past_due || []).join(", ") ||
          null,
        updatedAt: new Date().toISOString(),
      });
    } catch (e) {
      console.error("admin stripe refresh error", e);
      return res.status(500).json({ error: "Failed to refresh from Stripe" });
    }
  }
);


// GET /api/admin/agents/:id/payments
router.get(
  "/:id/payments",
  authRequired,
  requireRole("ADMIN", "SUPERADMIN"),
  async (req, res) => {
    // ensure agent exists
    const uRes = await query(
      `SELECT id FROM "User" WHERE id = $1 AND role = 'AGENT' AND "deletedAt" IS NULL`,
      [req.params.id]
    );
    if (!uRes.rows[0]) return res.status(404).json({ error: "Agent not found" });

    const { rows } = await query(
      `SELECT id, type, "amountCents", currency, status,
              "stripePaymentIntentId", "stripeCheckoutSessionId",
              "createdAt"
         FROM "AgentPayment"
        WHERE "userId" = $1
        ORDER BY "createdAt" DESC
        LIMIT 200`,
      [req.params.id]
    );

    // format a bit for UI
    const items = rows.map(r => ({
      id: r.id,
      type: r.type,                          // e.g. "ONBOARDING", later "DEPOSIT", "RENT", ...
      amountCents: r.amountCents,
      currency: r.currency || "USD",
      status: r.status,                      // e.g. "succeeded"
      pi: r.stripePaymentIntentId || null,
      cs: r.stripeCheckoutSessionId || null,
      createdAt: r.createdAt,
    }));

    res.json({ items });
  }
);



router.post("/:id/payouts",
  authRequired, requireRole("ADMIN", "SUPERADMIN"),
  async (req, res) => {
    const parsed = CreatePayoutBody.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const agentId = req.params.id;
    const agent = await query(
      `SELECT id FROM "User" WHERE id=$1 AND role='AGENT' AND "deletedAt" IS NULL`,
      [agentId]
    );
    if (!agent.rows[0]) return res.status(404).json({ error: "Agent not found" });

    // find eligible
    let baseEligible = await query(
      `
      SELECT sp.id, sp."amountCents", sp.currency, sp."createdAt"
      FROM "StudentPayment" sp
      JOIN "Booking" b ON b.id = sp."bookingId"
      JOIN "Listing" l ON l.id = b."listingId"
      LEFT JOIN "AgentPayoutItem" api ON api."paymentId" = sp.id
      LEFT JOIN "RefundRequest" rr ON rr."paymentId" = sp.id
      WHERE l."agentId" = $1
        AND sp.type = 'OFFER_NOW'
        AND sp.status = 'succeeded'
        AND api.id IS NULL
        AND COALESCE(rr.status, 'NONE') NOT IN ('PENDING','REFUNDED')
      ORDER BY sp."createdAt" ASC
      `,
      [agentId]
    );

    let picks = baseEligible.rows;
    if (parsed.data.paymentIds && parsed.data.paymentIds.length) {
      const set = new Set(parsed.data.paymentIds);
      picks = picks.filter(p => set.has(p.id));
    }
    if (!picks.length) return res.status(400).json({ error: "No eligible payments to include." });

    // compute totals
    const amountCents = picks.reduce((s, p) => s + Number(p.amountCents || 0), 0);
    let feesCents = 0;
    if (typeof parsed.data.feeCents === "number") feesCents = parsed.data.feeCents;
    else if (typeof parsed.data.feePercent === "number")
      feesCents = Math.round(amountCents * (parsed.data.feePercent / 100));
    const netCents = amountCents - feesCents;

    const currency = (picks[0].currency || "USD").toLowerCase(); // assume single currency
    const periodStart = picks[0].createdAt;
    const periodEnd = picks[picks.length - 1].createdAt;

    // atomic insert
    const out = await tx(async (db) => {
      const head = await db.query(
        `INSERT INTO "AgentPayout"
           (id,"agentId","amountCents",currency,"feesCents","netCents","txCount",
            "periodStart","periodEnd",note,"externalRef","createdAt")
         VALUES (gen_random_uuid()::text,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
         RETURNING *`,
        [
          agentId,
          amountCents,
          currency,
          feesCents,
          netCents,
          picks.length,
          periodStart,
          periodEnd,
          parsed.data.note || null,
          parsed.data.externalRef || null,
        ]
      );

      const payoutId = head.rows[0].id;

      // link each payment
      const values = picks
        .map((p, i) => `($1, $${i + 2})`)
        .join(", ");
      await db.query(
        `INSERT INTO "AgentPayoutItem"("payoutId","paymentId")
         VALUES ${values}`,
        [payoutId, ...picks.map((p) => p.id)]
      );

      return head.rows[0];
    });

    res.status(201).json({ payout: out, includedCount: picks.length });
  }
);


/* ======= Admin: Agent Payouts ======= */

// list recorded payouts for an agent
router.get(
  "/:id/payouts",
  authRequired,
  requireRole("ADMIN", "SUPERADMIN"),
  async (req, res) => {
    const agentId = req.params.id;
    // guard exists
    const ok = await query(`SELECT 1 FROM "User" WHERE id=$1 AND role='AGENT' AND "deletedAt" IS NULL`, [agentId]);
    if (!ok.rows[0]) return res.status(404).json({ error: "Agent not found" });

    const { rows } = await query(
      `SELECT * FROM "AgentPayout" WHERE "agentId"=$1 ORDER BY "createdAt" DESC LIMIT 200`,
      [agentId]
    );

    res.json({ items: rows });
  }
);

router.get(
  "/:id/payouts/eligible",
  authRequired,
  requireRole("ADMIN", "SUPERADMIN"),
  async (req, res) => {
    const agentId = req.params.id;

    const { rows } = await query(
      `
      WITH last_refund AS (
        SELECT DISTINCT ON ("paymentId")
               "paymentId", status
        FROM "RefundRequest"
        ORDER BY "paymentId", "createdAt" DESC
      )
      SELECT
        p.*,
        b.id    AS "bookingId",
        l.title AS "listingTitle",
        api.id  AS "payoutItemId",
        lr.status AS "refundStatus"
      FROM "StudentPayment" p
      JOIN "Booking" b ON b.id = p."bookingId"
      JOIN "Listing" l ON l.id = b."listingId"
      LEFT JOIN "AgentPayoutItem" api ON api."paymentId" = p.id
      LEFT JOIN last_refund lr ON lr."paymentId" = p.id
      WHERE l."agentId" = $1
        AND p.status = 'succeeded'
        AND p.type = 'OFFER_NOW'
      ORDER BY p."createdAt" DESC
      `,
      [agentId]
    );

    const eligible = rows.filter(r => !r.payoutItemId && r.refundStatus !== "PENDING" && r.refundStatus !== "REFUNDED");
    const onHold   = rows.filter(r => r.refundStatus === "PENDING");
    const excluded = rows.filter(r => r.payoutItemId);

    res.json({ eligible, onHold, excluded });
  }
);



// GET /api/admin/agents/:id/payments
router.get(
  "/:id/payments",
  authRequired,
  requireRole("ADMIN", "SUPERADMIN"),
  async (req, res) => {
    try {
      const { id } = req.params;

      const { rows } = await query(
        `SELECT 
           id,
           type,
           status,
           "amountCents",
           currency,
           "stripePaymentIntentId" AS pi,
           "stripeCheckoutSessionId" AS cs,
           "createdAt"
         FROM "AgentPayment"
         WHERE "userId" = $1
         ORDER BY "createdAt" DESC`,
        [id]
      );

      res.json({ items: rows });
    } catch (e) {
      console.error("GET /admin/agents/:id/payments error:", e);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);


export default router;
