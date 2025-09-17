// routes/agent.stripe.connect.js
import { Router } from "express";
import { authRequired } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { query } from "../db.js";

const router = Router();

let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  const { default: Stripe } = await import("stripe");
  stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });
}

// Helper: where should Stripe send the agent back?
function clientOrigin(req) {
  // Prefer explicit client origin; else fall back to API_PUBLIC_URL host; else infer from request
  const envClient = (process.env.CLIENT_ORIGIN || process.env.WEB_ORIGIN || "").replace(/\/+$/, "");
  if (envClient) return envClient;

  const apiBase = (process.env.API_PUBLIC_URL || "").replace(/\/+$/, "");
  if (apiBase) return apiBase; // good enough if same host serves SPA in dev proxy

  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  return `${proto}://${req.get("host")}`;
}

// Look up/create the agent's Stripe account and persist acct_...
async function ensureStripeAccountId(userId, userEmail) {
  const res = await query(
    `SELECT "stripeAccountId" FROM "AgentProfile" WHERE "userId" = $1`,
    [userId]
  );

  let acctId = res.rows[0]?.stripeAccountId;

  if (!acctId) {
    // 👇 Add this log right before creating the Stripe account
    console.log("Creating Stripe account with:", {
      type: "express",
      email: userEmail || undefined,
      capabilities: {
        transfers: { requested: true },
        card_payments: { requested: true },
      },
      metadata: { userId: String(userId) },
    });

    // Create new account at Stripe
    const acct = await stripe.accounts.create({
      type: "express",
      email: userEmail || undefined,
      capabilities: {
        transfers: { requested: true },
        card_payments: { requested: true },
      },
      metadata: { userId: String(userId) },
    });
    acctId = acct.id;

    // Guarantee DB persistence
await query(
  `INSERT INTO "AgentProfile" ("userId", "stripeAccountId", "updatedAt")
   VALUES ($1, $2, NOW())
   ON CONFLICT ("userId")
   DO UPDATE SET 
     "stripeAccountId" = EXCLUDED."stripeAccountId",
     "updatedAt" = NOW()`,
  [userId, acctId]
);

    
  }

  return acctId;
}

/**
 * POST /api/agent/stripe/connect/start
 * Creates (if needed) the Connect Express account and returns a Stripe-hosted onboarding link.
 */
router.post("/start", authRequired, requireRole("AGENT"), async (req, res) => {
  if (!stripe) return res.status(501).json({ error: "Stripe not configured" });

  const userId = req.user.id;
  const userEmail = req.user.email;

  try {
    const acctId = await ensureStripeAccountId(userId, userEmail);

    const origin = clientOrigin(req);
    const link = await stripe.accountLinks.create({
      account: acctId,
      type: "account_onboarding",
      refresh_url: `${origin}/dashboard/agent/settings?onboarding=retry`,
      return_url:  `${origin}/dashboard/agent/settings?onboarding=done`,
    });

    res.json({ url: link.url });
  } catch (e) {
    console.error("connect/start error", e);
    res.status(500).json({ error: "Failed to start Stripe onboarding" });
  }
});

/**
 * POST /api/agent/stripe/connect/link
 * Returns a Stripe-hosted update link (for agents to edit payout/verification later).
 */
router.post("/link", authRequired, requireRole("AGENT"), async (req, res) => {
  if (!stripe) return res.status(501).json({ error: "Stripe not configured" });

  const userId = req.user.id;

  try {
    const row = await query(
      `SELECT "stripeAccountId" FROM "AgentProfile" WHERE "userId" = $1`,
      [userId]
    );
    if (!row.rows[0]?.stripeAccountId) {
      return res.status(400).json({ error: "Stripe account not found. Start onboarding first." });
    }
    const acctId = row.rows[0].stripeAccountId;

    const origin = clientOrigin(req);
    const link = await stripe.accountLinks.create({
      account: acctId,
      type: "account_update",
      refresh_url: `${origin}/dashboard/agent/settings?onboarding=retry`,
      return_url:  `${origin}/dashboard/agent/settings?onboarding=done`,
    });





    res.json({ url: link.url });
  } catch (e) {
    console.error("connect/link error", e);
    res.status(500).json({ error: "Failed to create update link" });
  }
});

/**
 * GET /api/agent/stripe/connect/status
 * Fetch live status from Stripe and (optionally) persist flags.
 */
router.get("/status", authRequired, requireRole("AGENT"), async (req, res) => {
  if (!stripe) return res.json({ connected: false });

  const userId = req.user.id;

  try {
    const row = await query(
      `SELECT "stripeAccountId" FROM "AgentProfile" WHERE "userId" = $1`,
      [userId]
    );
    const acctId = row.rows[0]?.stripeAccountId;
    if (!acctId) return res.json({ connected: false });

    const acct = await stripe.accounts.retrieve(acctId);

    // Persist a snapshot (optional but nice)
    await query(
      `UPDATE "AgentProfile" SET
        "stripePayoutsEnabled" = $2,
        "stripeChargesEnabled" = $3,
        "stripeDetailsSubmitted" = $4,
        "stripeRequirements" = $5,
        "stripeCountry" = $6,
        "stripeUpdatedAt" = NOW()
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

    res.json({
      connected: true,
      payoutsEnabled: !!acct.payouts_enabled,
      chargesEnabled: !!acct.charges_enabled,
      detailsSubmitted: !!acct.details_submitted,
      requirements:
        (acct.requirements?.currently_due || []).join(", ") ||
        (acct.requirements?.past_due || []).join(", ") ||
        null,
    });
  } catch (e) {
    console.error("connect/status error", e);
    res.status(500).json({ connected: false, error: "Failed to fetch status" });
  }
});

export default router;
