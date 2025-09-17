// src/routes/agent.payouts.js
import { Router } from "express";
import { query, tx } from "../db.js";
import { authRequired } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { z } from "zod";

import Stripe from "stripe";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

const router = Router();

/* ---------- helpers ---------- */

// simple util to normalize date/timestamp values to ISO 8601 strings
const normalizeDate = (d) => (d ? new Date(d).toISOString() : null);



// gate: AGENT (see own payouts) or ADMIN/SUPERADMIN (can view any + record)
function ensureAgentOrAdmin(req, res, next) {
  const r = String(req.user?.role || "").toUpperCase();
  if (!req.user?.id) return res.status(401).json({ error: "Unauthorized" });
  if (!["AGENT", "ADMIN", "SUPERADMIN"].includes(r)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  next();
}

// sum of OFFER_NOW payments on this agent's listings that haven't gone into a payout yet
async function payableNowCents(agentId) {
  const { rows } = await query(
    `
    SELECT COALESCE(SUM(sp."amountCents")::bigint, 0) AS c
    FROM "StudentPayment" sp
    JOIN "Booking"  b ON b.id = sp."bookingId"
    JOIN "Listing"  l ON l.id = b."listingId"
    LEFT JOIN "AgentPayoutItem" api ON api."paymentId" = sp.id
    LEFT JOIN "RefundRequest" rr ON rr."paymentId" = sp.id
    WHERE l."agentId" = $1
      AND sp.type = 'OFFER_NOW'
      AND sp.status = 'succeeded'
      AND api.id IS NULL
      AND COALESCE(rr.status, 'NONE') NOT IN ('PENDING', 'REFUNDED')
  `,
    [agentId]
  );
  return Number(rows[0]?.c || 0);
}

async function paidLast30Cents(agentId) {
  const { rows } = await query(
    `
    SELECT COALESCE(SUM("netCents")::bigint,0) AS c
    FROM "AgentPayout"
    WHERE "agentId" = $1 AND "createdAt" >= NOW() - INTERVAL '30 days'
  `,
    [agentId]
  );
  return Number(rows[0]?.c || 0);
}

async function totalPaidCents(agentId) {
  const { rows } = await query(
    `SELECT COALESCE(SUM("netCents")::bigint,0) AS c
     FROM "AgentPayout"
     WHERE "agentId" = $1`,
    [agentId]
  );
  return Number(rows[0]?.c || 0);
}

async function payoutsCount(agentId) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS c FROM "AgentPayout" WHERE "agentId" = $1`,
    [agentId]
  );
  return rows[0]?.c || 0;
}

/* ---------- schemas ---------- */

const CreatePayoutSchema = z.object({
  agentId: z.string(),
  amountCents: z.number().int().positive(),
  currency: z.string().default("USD"),
  feesCents: z.number().int().default(0),
  netCents: z.number().int().positive(),
  txCount: z.number().int().default(0),
  periodStart: z.string().datetime().optional().nullable(),
  periodEnd: z.string().datetime().optional().nullable(),
  note: z.string().optional().nullable(),
  // externalRef: z.string().optional().nullable(),
  paymentIds: z.array(z.string()).optional().default([]), // link included StudentPayments
});

/* ---------- routes ---------- */

// GET /api/agent/payouts/summary   → KPIs for agent dashboard
router.get("/summary", authRequired, ensureAgentOrAdmin, async (req, res) => {
  try {
    const agentId =
      req.user.role === "AGENT" ? req.user.id : String(req.query.agentId || "");
    if (!agentId) return res.status(400).json({ error: "agentId required" });

    const [nowC, last30, total, count] = await Promise.all([
      payableNowCents(agentId),
      paidLast30Cents(agentId),
      totalPaidCents(agentId),
      payoutsCount(agentId),
    ]);

    res.json({
      payableNowCents: nowC,
      paidLast30Cents: last30,
      totalPaidCents: total,
      payoutsCount: count,
      currency: "USD",
    });
  } catch (e) {
    console.error("GET /agent/payouts/summary error:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/agent/payouts      → list all payouts for this agent
router.get("/", authRequired, ensureAgentOrAdmin, async (req, res) => {
  try {
    const agentId =
      req.user.role === "AGENT" ? req.user.id : String(req.query.agentId || "");
    if (!agentId) return res.status(400).json({ error: "agentId required" });

    const { rows } = await query(
      `
      SELECT
        id,
        "amountCents",
        currency,
        "feesCents",
        "netCents",
        "txCount",
        "periodStart",
        "periodEnd",
        COALESCE("externalRef",'') AS "externalRef",
        "createdAt"
      FROM "AgentPayout"
      WHERE "agentId" = $1
      ORDER BY "createdAt" DESC
      `,
      [agentId]
    );

    const items = rows.map((r) => ({
      id: r.id,
      date: normalizeDate(r.createdAt),
      status: "Paid",
      period:
        r.periodStart && r.periodEnd
          ? `${new Date(r.periodStart).toLocaleDateString()} – ${new Date(
              r.periodEnd
            ).toLocaleDateString()}`
          : "—",
      amountCents: r.amountCents,
      feesCents: r.feesCents,
      netCents: r.netCents,
      currency: (r.currency || "USD").toUpperCase(),
      txCount: r.txCount,
      method: r.externalRef ? `Ref ${r.externalRef}` : "Manual",
      createdAt: normalizeDate(r.createdAt),
    }));

    res.json({ items });
  } catch (e) {
    console.error("GET /agent/payouts error:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});


// GET /api/agent/payouts/:id  → payout + included payments
router.get("/:id", authRequired, ensureAgentOrAdmin, async (req, res) => {
  try {
    const agentId =
      req.user.role === "AGENT" ? req.user.id : String(req.query.agentId || "");
    const payoutId = req.params.id;

    const head = await query(
      `SELECT * FROM "AgentPayout" WHERE id = $1 AND "agentId" = $2`,
      [payoutId, agentId]
    );
    const p = head.rows[0];
    if (!p) return res.status(404).json({ error: "Not found" });

    const items = await query(
      `
      SELECT
        api.id,
        sp.id        AS "paymentId",
        sp."amountCents",
        sp.currency,
        sp.type,
        sp.status,
        sp."createdAt",
        b."checkIn",
        b."checkOut",
        l.title      AS "listingTitle"
      FROM "AgentPayoutItem" api
      JOIN "StudentPayment" sp ON sp.id = api."paymentId"
      JOIN "Booking" b ON b.id = sp."bookingId"
      JOIN "Listing" l ON l.id = b."listingId"
      WHERE api."payoutId" = $1
      ORDER BY sp."createdAt" DESC
      `,
      [payoutId]
    );

    // Only generate Stripe URL if externalRef looks like a transfer id
    const stripeUrl =
      p.externalRef && p.externalRef.startsWith("tr_")
        ? `https://dashboard.stripe.com/test/connect/transfers/${p.externalRef}`
        : null;

    res.json({
      payout: {
        ...p,
        createdAt: normalizeDate(p.createdAt),
        periodStart: normalizeDate(p.periodStart),
        periodEnd: normalizeDate(p.periodEnd),
        stripeUrl,
      },
      payments: items.rows.map((r) => ({
        ...r,
        createdAt: normalizeDate(r.createdAt),
        checkIn: normalizeDate(r.checkIn),
        checkOut: normalizeDate(r.checkOut),
      })),
    });
  } catch (e) {
    console.error("GET /agent/payouts/:id error:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/admin/payouts → record a new payout (ADMIN only)
router.post(
  "/admin/create",
  authRequired,
  requireRole("ADMIN", "SUPERADMIN"),
  async (req, res) => {
    const parsed = CreatePayoutSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const d = parsed.data;

    try {
      const { rows: agentRows } = await query(
        `SELECT "stripeAccountId" FROM "AgentProfile" WHERE "userId" = $1`,
        [d.agentId]
      );
      const stripeAccountId = agentRows[0]?.stripeAccountId;
      if (!stripeAccountId) {
        return res.status(400).json({ error: "Agent has no Stripe account" });
      }

      const transfer = await stripe.transfers.create({
        amount: d.netCents,
        currency: d.currency.toLowerCase(),
        destination: stripeAccountId,
        description: d.note || `Payout for agent ${d.agentId}`,
        metadata: {
          agentId: d.agentId,
          payoutItems: d.paymentIds.join(","),
        },
      });

      const out = await tx(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO "AgentPayout" (
             id,"agentId","amountCents",currency,"feesCents","netCents","txCount",
             "periodStart","periodEnd",note,"externalRef","status","createdAt"
           ) VALUES (
             gen_random_uuid()::text,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'paid',NOW()
           ) RETURNING *`,
          [
            d.agentId,
            d.amountCents,
            d.currency,
            d.feesCents,
            d.netCents,
            d.txCount,
            d.periodStart || null,
            d.periodEnd || null,
            d.note || null,
            transfer.id,
          ]
        );
        const payout = rows[0];

        for (const pid of d.paymentIds) {
          await client.query(
            `INSERT INTO "AgentPayoutItem"(id,"payoutId","paymentId","createdAt")
             VALUES (gen_random_uuid()::text,$1,$2,NOW())
             ON CONFLICT("paymentId") DO NOTHING`,
            [payout.id, pid]
          );
        }

        return payout;
      });

      res.status(201).json({
        payout: {
          ...out,
          createdAt: normalizeDate(out.createdAt),
          periodStart: normalizeDate(out.periodStart),
          periodEnd: normalizeDate(out.periodEnd),
        },
        transfer,
      });
    } catch (e) {
      console.error("POST /admin/payouts error:", e);
      res.status(500).json({ error: "Unable to create Stripe payout" });
    }
  }
);

export default router;
