// src/routes/stripe.webhook.js
import { Router } from "express";
import { query } from "../db.js";

const router = Router();
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";

let stripe;
if (process.env.STRIPE_SECRET_KEY) {
  const { default: Stripe } = await import("stripe");
  stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });
}

/* ========= NEW: helpers ========= */

function extractCardFromPI(pi) {
  const ch = pi?.charges?.data?.[0] || null;
  const pmd = ch?.payment_method_details || {};
  const card = pmd.card || {};
  return {
    chargeId: ch?.id || null,
    cardBrand: card?.brand || null,
    cardLast4: card?.last4 || null,
    receiptUrl: ch?.receipt_url || null,
    amountCents: pi?.amount_received ?? pi?.amount ?? 0,
    currency: (pi?.currency || "usd").toUpperCase(),
  };
}

async function recordStudentPayment({
  userId,
  bookingId,
  offerId = null,
  type,                // 'APP_FEE' | 'OFFER_NOW'
  status,              // 'succeeded'
  amountCents,
  currency,
  paymentIntentId = null,
  chargeId = null,
  checkoutSessionId = null,
  cardBrand = null,
  cardLast4 = null,
  receiptUrl = null,
}) {
  // idempotent insert on PI or CS id
  await query(
    `INSERT INTO "StudentPayment"(
        "userId","bookingId","offerId","type","amountCents","currency","status",
        "stripePaymentIntentId","stripeChargeId","stripeCheckoutSessionId",
        "cardBrand","cardLast4","receiptUrl"
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT ("stripePaymentIntentId") DO NOTHING`,
    [
      userId, bookingId, offerId, type, amountCents, currency, status,
      paymentIntentId, chargeId, checkoutSessionId,
      cardBrand, cardLast4, receiptUrl,
    ]
  );
}

async function finalizeAppFee({ userId, bookingId, pi, checkoutSessionId = null }) {
  const meta = extractCardFromPI(pi);
  // Flip booking flags (don’t downgrade an already-submitted booking)
  const { rows } = await query(
    `SELECT "docIds", status FROM "Booking" WHERE id=$1`,
    [bookingId]
  );
  const docs = Array.isArray(rows[0]?.docIds) ? rows[0].docIds.length : 0;
  const currentStatus = String(rows[0]?.status || "");
  const nextStatus =
    ["UNDER_REVIEW","SUBMITTED","SENT_TO_PARTNER","APPROVED","REJECTED"].includes(currentStatus)
      ? currentStatus
      : (docs > 0 ? "READY_TO_SUBMIT" : "PAYMENT_COMPLETE");

  await query(
    `UPDATE "Booking"
       SET "feePaidAt" = COALESCE("feePaidAt", NOW()),
           "paymentMethod" = COALESCE("paymentMethod", 'CARD'),
           status = $2,
           "updatedAt" = NOW()
     WHERE id = $1`,
    [bookingId, nextStatus]
  );

  await recordStudentPayment({
    userId,
    bookingId,
    type: "APP_FEE",
    status: "succeeded",
    amountCents: meta.amountCents,
    currency: meta.currency,
    paymentIntentId: pi.id,
    chargeId: meta.chargeId,
    checkoutSessionId,
    cardBrand: meta.cardBrand,
    cardLast4: meta.cardLast4,
    receiptUrl: meta.receiptUrl,
  });
}

async function finalizeOfferNow({ userId, bookingId, offerId, pi, checkoutSessionId = null }) {
  const meta = extractCardFromPI(pi);

  await query(
    `UPDATE "Offer"
       SET "paidNowAt" = COALESCE("paidNowAt", NOW()),
           "payMethod" = COALESCE("payMethod", 'CARD'),
           status = CASE WHEN status <> 'ACCEPTED' THEN 'ACCEPTED' ELSE status END,
           "acceptedAt" = CASE WHEN status <> 'ACCEPTED' THEN NOW() ELSE "acceptedAt" END,
           "updatedAt" = NOW()
     WHERE id = $1`,
    [offerId]
  );

  await recordStudentPayment({
    userId,
    bookingId,
    offerId,
    type: "OFFER_NOW",
    status: "succeeded",
    amountCents: meta.amountCents,
    currency: meta.currency,
    paymentIntentId: pi.id,
    chargeId: meta.chargeId,
    checkoutSessionId,
    cardBrand: meta.cardBrand,
    cardLast4: meta.cardLast4,
    receiptUrl: meta.receiptUrl,
  });
}

/* ========= webhook ========= */

router.post("/", async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.status(200).send("stripe not configured");

  let event;
  try {
    const sig = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature verification failed.", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    // === PaymentIntent path (Elements or Checkout both end here) ===
    if (event.type === "payment_intent.succeeded") {
      const pi = event.data.object;
      const meta = pi.metadata || {};

      // Agent onboarding (existing)
      if (meta.type === "agent_onboarding" && meta.userId) {
        await recordOnboardingSuccess({
          userId: meta.userId,
          amountCents: pi.amount_received ?? pi.amount,
          currency: (pi.currency || "usd").toUpperCase(),
          paymentIntentId: pi.id,
          checkoutSessionId: null,
          status: "succeeded",
        });
      }

      // NEW: Student app fee
      if (meta.type === "student_app_fee" && meta.userId && meta.bookingId) {
        await finalizeAppFee({ userId: meta.userId, bookingId: meta.bookingId, pi });
      }

      // NEW: Student offer "due now"
      if (meta.type === "student_offer_now" && meta.userId && meta.bookingId && meta.offerId) {
        await finalizeOfferNow({
          userId: meta.userId, bookingId: meta.bookingId, offerId: meta.offerId, pi
        });
      }
    }

    // === Checkout Session path (if you used redirect Checkout) ===
    if (event.type === "checkout.session.completed") {
      const cs = event.data.object;
      const meta = cs.metadata || {};
      const piId = cs.payment_intent;

      // pull PI to capture card/receipt details
      let pi = null;
      if (piId) {
        try { pi = await stripe.paymentIntents.retrieve(piId); } catch {}
      }

      // Agent onboarding (existing)
      if (meta.type === "agent_onboarding" && meta.userId) {
        const amountCents = cs.amount_total ?? 0;
        const currency = (cs.currency || "usd").toUpperCase();
        await recordOnboardingSuccess({
          userId: meta.userId,
          amountCents,
          currency,
          paymentIntentId: piId || null,
          checkoutSessionId: cs.id,
          status: "succeeded",
        });
      }

      // NEW: Student app fee
      if (meta.type === "student_app_fee" && meta.userId && meta.bookingId && pi) {
        await finalizeAppFee({
          userId: meta.userId,
          bookingId: meta.bookingId,
          pi,
          checkoutSessionId: cs.id,
        });
      }

      // NEW: Student offer "due now"
      if (meta.type === "student_offer_now" && meta.userId && meta.bookingId && meta.offerId && pi) {
        await finalizeOfferNow({
          userId: meta.userId,
          bookingId: meta.bookingId,
          offerId: meta.offerId,
          pi,
          checkoutSessionId: cs.id,
        });
      }
    }


    /* ======== NEW: auto-close refund requests when Stripe refunds ======== */

async function markRefundAsProcessed({ chargeId, paymentIntentId, amountCents, currency, refundStripeId = null }) {
  // 1) Find our StudentPayment row by chargeId or paymentIntentId
  const { rows: payRows } = await query(
    `SELECT id FROM "StudentPayment"
     WHERE ("stripeChargeId" = $1 AND $1 IS NOT NULL)
        OR ("stripePaymentIntentId" = $2 AND $2 IS NOT NULL)
     ORDER BY "createdAt" DESC
     LIMIT 1`,
    [chargeId || null, paymentIntentId || null]
  );
  const pm = payRows[0];
  if (!pm) return; // nothing to do

  // 2) Update the most recent PENDING RefundRequest for that payment
  const { rows: rrRows } = await query(
    `SELECT id FROM "RefundRequest"
     WHERE "paymentId" = $1 AND status = 'PENDING'
     ORDER BY "createdAt" DESC
     LIMIT 1`,
    [pm.id]
  );
  const rr = rrRows[0];

  if (rr) {
    // basic: set REFUNDED + amount + currency
    await query(
      `UPDATE "RefundRequest"
         SET status='REFUNDED',
             "amountCents" = COALESCE($2, "amountCents"),
             currency = COALESCE($3, currency),
             "updatedAt"=NOW()
       WHERE id=$1`,
      [rr.id, amountCents ?? null, currency ?? null]
    );

    // OPTIONAL niceties — only if you added these columns:
    // try { await query(`UPDATE "RefundRequest" SET "processedAt"=NOW(),"externalRef"=$2 WHERE id=$1`, [rr.id, refundStripeId]); } catch {}
  } else {
    // No request on file — create an already-processed record so history stays consistent
    await query(
      `INSERT INTO "RefundRequest"
        (id,"userId","bookingId","paymentId","amountCents","currency",reason,status,"createdAt","updatedAt")
       SELECT gen_random_uuid()::text, sp."userId", sp."bookingId", sp.id, $2, $3,
              'Refunded in Stripe dashboard', 'REFUNDED', NOW(), NOW()
       FROM "StudentPayment" sp
       WHERE sp.id = $1
       LIMIT 1`,
      [pm.id, amountCents ?? 0, currency || 'USD']
    );
  }
}

if (event.type === "charge.refunded") {
  const ch = event.data.object; // charge
  const amountCents = Number(ch.amount_refunded || 0);   // total refunded so far
  const currency = (ch.currency || "usd").toUpperCase();
  // Stripe also sends "refunds.data[0].id" etc.; use the latest if you want a specific id
  const refundStripeId = ch.refunds?.data?.[0]?.id || null;
  await markRefundAsProcessed({
    chargeId: ch.id,
    paymentIntentId: ch.payment_intent || null,
    amountCents,
    currency,
    refundStripeId
  });
}

if (event.type === "refund.succeeded") {
  const rf = event.data.object; // refund
  const amountCents = Number(rf.amount || 0);
  const currency = (rf.currency || "usd").toUpperCase();
  await markRefundAsProcessed({
    chargeId: rf.charge || null,
    paymentIntentId: rf.payment_intent || null,
    amountCents,
    currency,
    refundStripeId: rf.id
  });
}


    // === account.updated (existing) ===
    if (event.type === "account.updated") {
      const acct = event.data.object;
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
    }

    res.json({ received: true });
  } catch (e) {
    console.error("Webhook handling error:", e);
    res.status(500).send("Server error");
  }
});

/* existing helper kept as-is */
async function recordOnboardingSuccess({ userId, amountCents, currency, paymentIntentId, checkoutSessionId, status }) {
  await query(
    `INSERT INTO "AgentPayment"
     ("userId", type, "amountCents", currency, status, "stripePaymentIntentId", "stripeCheckoutSessionId")
     VALUES ($1, 'ONBOARDING', $2, $3, $4, $5, $6)`,
    [userId, amountCents, currency, status, paymentIntentId, checkoutSessionId]
  );

  await query(
    `UPDATE "AgentProfile" SET
       "onboardingPaidAt" = COALESCE("onboardingPaidAt", NOW()),
       "onboardingAmountCents" = COALESCE("onboardingAmountCents", $2),
       "onboardingCurrency" = COALESCE("onboardingCurrency", $3),
       "onboardingPaymentIntentId" = COALESCE("onboardingPaymentIntentId", $4),
       "updatedAt" = NOW()
     WHERE "userId" = $1`,
    [userId, amountCents, currency, paymentIntentId]
  );
}

export default router;
