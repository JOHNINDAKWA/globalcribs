// src/routes/agent.billing.js
import { Router } from "express";
import { query } from "../db.js";
import { authRequired } from "../middleware/auth.js";

const router = Router();

const FRONTEND_URL = (process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/$/, "");

/* ---------------- helpers ---------------- */

function ensureAgent(req, res) {
  const role = String(req.user?.role || "").toUpperCase();
  if (role !== "AGENT" && role !== "SUPERADMIN") {
    res.status(403).json({ error: "Agent access only" });
    return false;
  }
  return true;
}

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const k of Object.keys(patch || {})) {
    const v = patch[k];
    if (
      v && typeof v === "object" && !Array.isArray(v) &&
      base?.[k] && typeof base[k] === "object" && !Array.isArray(base[k])
    ) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

const DEFAULTS = {
  fees: {
    currency: "USD",
    agentOnboardingFeeCents: 10000, // $100 default
    applicationFeeCents: 2500,
  },
};

// Normalize settings to always have fees.* even if older rows stored values at the root.
async function getSettings() {
  const row = await query(`SELECT data FROM "AppSetting" WHERE id = 'GLOBAL'`);
  const db = row.rows?.[0]?.data || {};

  // Merge with defaults first
  const merged = deepMerge(DEFAULTS, db);

  // Back-compat: if older shape stored fee fields at root, hoist them into fees.*
  if (typeof db.agentOnboardingFeeCents === "number") {
    merged.fees.agentOnboardingFeeCents = db.agentOnboardingFeeCents;
  }
  if (typeof db.applicationFeeCents === "number") {
    merged.fees.applicationFeeCents = db.applicationFeeCents;
  }
  if (db.currency && typeof db.currency === "string") {
    merged.fees.currency = db.currency;
  }

  return merged;
}

// Only load Stripe if a secret key is set (lets you run without installing stripe in dev)
let _stripe = undefined; // undefined=not checked, false=disabled, object=Stripe instance
let _stripePublishable = process.env.STRIPE_PUBLISHABLE_KEY || "";
async function getStripe() {
  if (_stripe !== undefined) return _stripe;
  const secret = process.env.STRIPE_SECRET_KEY || "";
  if (!secret) {
    _stripe = false;
    return _stripe;
  }
  // dynamic import so the app works even if 'stripe' package isn't installed
  const { default: Stripe } = await import("stripe");
  _stripe = new Stripe(secret, { apiVersion: "2024-06-20" });
  return _stripe;
}

/* ---------------- routes ---------------- */

/**
 * GET /api/agent/billing/onboarding/config
 * Public-to-agent config so the UI can always show the amount from the DB.
 * Returns: { paid:boolean, amountCents:number, currency:string }
 * (If you later record successful payments, compute a real `paid` here.)
 */
// GET /api/agent/billing/onboarding/config
router.get("/onboarding/config", authRequired, async (req, res) => {
  if (!ensureAgent(req, res)) return;

  const settings = await getSettings();
  const amountCents = Number(settings?.fees?.agentOnboardingFeeCents || 0);
  const currency = String(settings?.fees?.currency || "USD").toUpperCase();

  const r = await query(
    `SELECT "onboardingPaidAt", "onboardingWaived"
       FROM "AgentProfile" WHERE "userId" = $1`,
    [req.user.id]
  );

  const paid = !!r.rows?.[0]?.onboardingPaidAt;
  const waived = !!r.rows?.[0]?.onboardingWaived;
  const unlocked = paid || waived;

  res.json({ paid, waived, unlocked, amountCents, currency });
});


/**
 * POST /api/agent/billing/onboarding/intent
 * Returns: { clientSecret, publishableKey, amountCents, currency }
 * Always returns the amount/currency from DB even if Stripe is misconfigured.
 */
router.post("/onboarding/intent", authRequired, async (req, res) => {
  if (!ensureAgent(req, res)) return;

  // compute these up-front so we can still return them on failure
  const settings = await getSettings();
  const amountCents = Number(settings?.fees?.agentOnboardingFeeCents || 0);
  const currencyLower = String(settings?.fees?.currency || "USD").toLowerCase();
  const currency = currencyLower.toUpperCase();

  if (!amountCents || amountCents < 0) {
    return res.status(400).json({ error: "Invalid onboarding fee amount." });
  }

  try {
    const stripe = await getStripe();
    if (!stripe) {
      // Stripe not configured — still return quote so UI can render and optionally use Checkout fallback
      return res.json({
        clientSecret: "",
        publishableKey: "",
        amountCents,
        currency,
      });
    }

    const receiptEmail = req.user?.email || undefined;
    const pi = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: currencyLower,
      automatic_payment_methods: { enabled: true },
      receipt_email: receiptEmail,
      metadata: {
        type: "agent_onboarding",
        userId: String(req.user.id),
      },
    });

    return res.json({
      clientSecret: pi.client_secret,
      publishableKey: _stripePublishable,
      amountCents,
      currency,
    });
  } catch (e) {
    // If Stripe key is invalid or any Stripe error occurs, still return the DB quote.
    console.error("onboarding/intent error:", e);
    return res.json({
      clientSecret: "",
      publishableKey: "",
      amountCents,
      currency,
    });
  }
});

/**
 * POST /api/agent/billing/onboarding/checkout
 * Returns: { url } for Stripe Checkout
 */
router.post("/onboarding/checkout", authRequired, async (req, res) => {
  if (!ensureAgent(req, res)) return;

  try {
    const settings = await getSettings();
    const amountCents = Number(settings?.fees?.agentOnboardingFeeCents || 0);
    const currencyLower = String(settings?.fees?.currency || "USD").toLowerCase();

    const stripe = await getStripe();
    if (!stripe) {
      return res.status(400).json({ error: "Stripe is not configured." });
    }
    if (!amountCents || amountCents < 0) {
      return res.status(400).json({ error: "Invalid onboarding fee amount." });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card", "us_bank_account", "link"],
      customer_email: req.user?.email,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: currencyLower,
            unit_amount: amountCents,
            product_data: {
              name: "Agent Onboarding Fee",
              description: "One-time fee to activate your partner account.",
            },
          },
        },
      ],
      success_url: `${FRONTEND_URL}/dashboard/agent/settings?paid=1`,
      cancel_url: `${FRONTEND_URL}/dashboard/agent/settings?canceled=1`,
      metadata: {
        type: "agent_onboarding",
        userId: String(req.user.id),
      },
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error("onboarding/checkout error:", e);
    res.status(500).json({ error: "Failed to create checkout session." });
  }
});

export default router;
