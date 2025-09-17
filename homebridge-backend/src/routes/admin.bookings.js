// src/routes/admin.bookings.js
import { Router } from "express";
import { authRequired } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { query } from "../db.js";
import { sendMail } from "../lib/mailer.js";

const router = Router();

const API_PUBLIC_URL = (process.env.API_PUBLIC_URL || "http://localhost:4000").replace(/\/$/, "");
const APP_NAME = process.env.APP_NAME || "GlobalCribs";
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

// Pretty refs
function prettyId(uuid = "", prefix = "BK") {
  const seg = (uuid.split("-")[0] || "").toUpperCase();
  return `${prefix}-${seg || "00000000"}`;
}
function prettyListingId(uuid = "") {
  const seg = (uuid.split("-")[0] || "").toUpperCase();
  return `LS-${seg || "00000000"}`;
}

// GET /api/admin/bookings
router.get(
  "/",
  authRequired,
  requireRole("ADMIN", "SUPERADMIN"),
  async (req, res) => {
    const take = Math.min(Number(req.query.take || 50), 100);
    const skip = Math.max(Number(req.query.skip || 0), 0);

    const rowsRes = await query(
      `
      SELECT
        b.id,
        b.status,
        b."checkIn",
        b."checkOut",
        b."createdAt"::text AS "createdAt",
        b."feePaidAt"::text AS "feePaidAt",
        b."submittedAt"::text AS "submittedAt",
        b."docIds", -- CHANGE 1: Select "docIds" instead of "docsCount"
        l.id AS "l_id",
        l.title AS "l_title",
        l.city AS "l_city",
        u.id AS "u_id",
        u.name AS "u_name",
        u.email AS "u_email"
      FROM "Booking" b
      JOIN "Listing" l ON l.id = b."listingId"
      JOIN "User" u ON u.id = b."studentId"
      ORDER BY b."createdAt" DESC
      LIMIT $1 OFFSET $2
      `,
      [take, skip]
    );
    const countRes = await query(`SELECT COUNT(*)::int AS c FROM "Booking"`);
    const total = countRes.rows[0].c;

    const items = rowsRes.rows.map((b) => ({
      id: b.id,
      displayId: prettyId(b.id, "BK"),
      status: b.status,
      checkIn: b.checkIn,
      checkOut: b.checkOut,
      createdAt: b.createdAt,
      feePaidAt: b.feePaidAt,
      submittedAt: b.submittedAt,
      docsCount: Array.isArray(b.docIds) ? b.docIds.length : 0, // CHANGE 2: Calculate docsCount from docIds
      listing: {
        id: b.l_id,
        displayId: prettyListingId(b.l_id),
        title: b.l_title,
        city: b.l_city,
      },
      student: {
        id: b.u_id,
        name: b.u_name || "",
        email: b.u_email || "",
      },
    }));

    res.json({ items, total, take, skip });
  }
);

// ... rest of the file remains the same

// GET /api/admin/bookings/:id
// GET /api/admin/bookings/:id
router.get(
  "/:id",
  authRequired,
  requireRole("ADMIN", "SUPERADMIN"),
  async (req, res) => {
    const base = await query(
      `
      SELECT
        b.id,
        b.status,
        b."checkIn",
        b."checkOut",
        b.note,
        b."feePaidAt"::text   AS "feePaidAt",
        b."submittedAt"::text AS "submittedAt",
        b."createdAt"::text   AS "createdAt",
        b."docsUpdatedAt"::text AS "docsUpdatedAt",
        b."docIds",
        l.id AS "l_id", l.title AS "l_title", l.city AS "l_city", l."coverImageId" AS "l_cover",
        u.id AS "u_id", u.name AS "u_name", u.email AS "u_email"
      FROM "Booking" b
      JOIN "Listing" l ON l.id = b."listingId"
      JOIN "User"   u ON u.id = b."studentId"
      WHERE b.id = $1
      `,
      [req.params.id]
    );

    const b = base.rows[0];
    if (!b) return res.status(404).json({ error: "Booking not found" });

    // listing images
    const imgsRes = await query(
      `SELECT id, url, "order" FROM "ListingImage" WHERE "listingId" = $1 ORDER BY "order" ASC`,
      [b.l_id]
    );

    // docs (id IN docIds and userId = studentId)
    const docIds = Array.isArray(b.docIds) ? b.docIds : [];
    const docsRaw = docIds.length
      ? (
          await query(
            `SELECT id, filename, mime, size, url, category, "createdAt"::text AS "createdAt"
             FROM "StudentDoc"
             WHERE "userId" = $1 AND id = ANY($2::text[])`,
            [b.u_id, docIds]
          )
        ).rows
      : [];

    const docs = docsRaw.map((d) => ({
      id: d.id,
      name: d.filename,
      mime: d.mime,
      size: d.size,
      url: d.url,
      downloadUrl: d.url?.startsWith("http") ? d.url : `${API_PUBLIC_URL}${d.url}`,
      category: d.category || "Other",
      createdAt: d.createdAt,
    }));

    // ---------- NEW: Payments scoped to THIS booking ----------
    const paymentsRaw = (
      await query(
        `
        SELECT
          p.*,
          p."createdAt"::text AS "createdAt",
          l.title AS "listingTitle"
        FROM "StudentPayment" p
        LEFT JOIN "Booking" b2 ON b2.id = p."bookingId"
        LEFT JOIN "Listing" l  ON l.id  = b2."listingId"
        WHERE p."userId" = $1 AND p."bookingId" = $2
        ORDER BY p."createdAt" DESC
        `,
        [b.u_id, b.id]
      )
    ).rows;

    const presentPayment = (p) => ({
      id: p.id,
      type: p.type,                    // 'APP_FEE' | 'OFFER_NOW'
      amountCents: p.amountCents,
      currency: p.currency,
      status: p.status,                // 'succeeded'
      createdAt: p.createdAt,
      bookingId: p.bookingId,
      offerId: p.offerId,
      receiptUrl: p.receiptUrl || null,
      listingTitle: p.listingTitle || b.l_title,
    });

    const payments = paymentsRaw.map(presentPayment);

    // ---------- NEW: Refund requests scoped to THIS booking ----------
    const refundsRaw = (
      await query(
        `
        SELECT
          r.*,
          r."createdAt"::text   AS "createdAt",
          r."processedAt"::text AS "processedAt",
          p."amountCents"       AS "p_amountCents",
          p.currency            AS "p_currency"
        FROM "RefundRequest" r
        LEFT JOIN "StudentPayment" p ON p.id = r."paymentId"
        WHERE r."userId" = $1 AND r."bookingId" = $2
        ORDER BY r."createdAt" DESC
        `,
        [b.u_id, b.id]
      )
    ).rows;

    const presentRefund = (r) => ({
      id: r.id,
      paymentId: r.paymentId,
      bookingId: r.bookingId,
      amountCents: r.amountCents,
      currency: r.currency,
      status: r.status,                // 'PENDING' | 'DECLINED' | 'REFUNDED'
      reason: r.reason || "",
      createdAt: r.createdAt,
      processedAt: r.processedAt,
      stripeRefundId: r.stripeRefundId || null,
    });

    const refunds = refundsRaw.map(presentRefund);

    const item = {
      id: b.id,
      displayId: prettyId(b.id, "BK"),
      status: b.status,
      checkIn: b.checkIn,
      checkOut: b.checkOut,
      note: b.note || null,
      feePaidAt: b.feePaidAt,
      submittedAt: b.submittedAt,
      createdAt: b.createdAt,
      docsCount: docs.length,
      docs,
      listing: {
        id: b.l_id,
        displayId: prettyListingId(b.l_id),
        title: b.l_title,
        city: b.l_city,
        coverImageId: b.l_cover,
        images: imgsRes.rows,
      },
      student: {
        id: b.u_id,
        name: b.u_name || "",
        email: b.u_email || "",
      },
      docsUpdatedAt: b.docsUpdatedAt,
      // NEW: include these in the payload
      payments,
      refunds,
    };

    res.json({ item });
  }
);


// POST /api/admin/bookings/:id/decision
router.post(
  "/:id/decision",
  authRequired,
  requireRole("ADMIN", "SUPERADMIN"),
  async (req, res) => {
    const decision = String(req.body?.decision || "").toUpperCase();
    if (!["APPROVED", "REJECTED"].includes(decision)) {
      return res.status(400).json({ error: "decision must be APPROVED or REJECTED" });
    }

    const exists = await query(`SELECT id FROM "Booking" WHERE id = $1`, [req.params.id]);
    if (!exists.rows[0]) return res.status(404).json({ error: "Booking not found" });

    const up = await query(
      `UPDATE "Booking" SET status = $1, "updatedAt" = NOW() WHERE id = $2 RETURNING *`,
      [decision, req.params.id]
    );

    // If approved -> notify the agent to prepare/send an offer
    if (decision === "APPROVED") {
      (async () => {
        try {
          // Load booking + listing + student + agent (with AgentProfile email if set)
          const infoRes = await query(
            `
            SELECT
              b.id AS "b_id", b."checkIn", b."checkOut", b."feePaidAt"::text AS "feePaidAt",
              l.id AS "l_id", l.title AS "l_title", l.city AS "l_city", l."agentId" AS "agent_id",
              su.name AS "stu_name", su.email AS "stu_email",
              au.name AS "agent_name", au.email AS "agent_email",
              ap.email AS "agent_profile_email"
            FROM "Booking" b
            JOIN "Listing" l ON l.id = b."listingId"
            JOIN "User" su   ON su.id = b."studentId"
            LEFT JOIN "User" au ON au.id = l."agentId"
            LEFT JOIN "AgentProfile" ap ON ap."userId" = l."agentId"
            WHERE b.id = $1
            `,
            [req.params.id]
          );
          const row = infoRes.rows[0];
          if (!row) return;

          const agentEmail = row.agent_profile_email || row.agent_email || "";
          if (!agentEmail) return; // no agent email on file

          const ref = prettyId(row.b_id, "BK");
          const listingRef = prettyListingId(row.l_id);
          const when = `${row.checkIn || "—"} → ${row.checkOut || "—"}`;
          const feeStatus = row.feePaidAt ? "PAID" : "UNPAID";
          const agentUrl = `${FRONTEND_URL}/dashboard/agent/applications`;

          const subject = `${APP_NAME}: booking ${ref} approved — please send an offer`;
          const text = [
            `Hi ${row.agent_name || "there"},`,
            ``,
            `An admin has APPROVED booking ${ref}.`,
            `Student: ${row.stu_name || ""} <${row.stu_email || ""}>`,
            `Listing: ${row.l_title || listingRef} (${row.l_city || "—"})`,
            `Dates: ${when}`,
            `Application fee: ${feeStatus}`,
            ``,
            `Next step: please log in to your agent dashboard and prepare/send an offer to the student.`,
            `${agentUrl}`,
            ``,
            `— ${APP_NAME} Team`,
          ].join("\n");

          const html = `
            <p>Hi ${row.agent_name || "there"},</p>
            <p>An admin has <b>APPROVED</b> booking <b>${ref}</b>.</p>
            <ul>
              <li><b>Student:</b> ${row.stu_name || ""} &lt;${row.stu_email || ""}&gt;</li>
              <li><b>Listing:</b> ${row.l_title || listingRef} (${row.l_city || "—"})</li>
              <li><b>Dates:</b> ${when}</li>
              <li><b>Application fee:</b> ${feeStatus}</li>
            </ul>
            <p><b>Next step:</b> please log in to your agent dashboard and prepare/send an offer to the student.</p>
            <p><a href="${agentUrl}">Open Agent Dashboard</a></p>
            <p>— ${APP_NAME} Team</p>
          `;

          await sendMail({ to: agentEmail, subject, text, html });
        } catch (e) {
          console.error("email(agent on approval) failed:", e?.message || e);
        }
      })();
    }

    res.json({ item: up.rows[0] });
  }
);



// List payments explicitly (optional; detail already returns payments)
router.get(
  "/:id/payments",
  authRequired,
  requireRole("ADMIN", "SUPERADMIN"),
  async (req, res) => {
    const rows = (
      await query(
        `SELECT * FROM "StudentPayment" WHERE "userId" = $1 ORDER BY "createdAt" DESC`,
        [req.params.id]
      )
    ).rows;
    res.json({ items: rows });
  }
);

// List refund requests for the student (optional; detail already returns refunds)
router.get(
  "/:id/refunds",
  authRequired,
  requireRole("ADMIN", "SUPERADMIN"),
  async (req, res) => {
    const rows = (
      await query(
        `SELECT * FROM "RefundRequest" WHERE "userId" = $1 ORDER BY "createdAt" DESC`,
        [req.params.id]
      )
    ).rows;
    res.json({ items: rows });
  }
);

// Approve & execute a refund
router.post(
  "/:id/refunds/:refundId/approve",
  authRequired,
  requireRole("ADMIN", "SUPERADMIN"),
  async (req, res) => {
    if (!stripe) return res.status(400).json({ error: "Stripe not configured" });

    const rrRes = await query(
      `SELECT r.*, p."stripeChargeId", p."stripePaymentIntentId"
         FROM "RefundRequest" r
         LEFT JOIN "StudentPayment" p ON p.id = r."paymentId"
        WHERE r.id = $1 AND r."userId" = $2`,
      [req.params.refundId, req.params.id]
    );
    const rr = rrRes.rows[0];
    if (!rr) return res.status(404).json({ error: "Refund request not found" });
    if (rr.status !== "PENDING")
      return res.status(400).json({ error: "Refund already processed" });

    try {
      // Prefer charge id, else payment_intent
      let refund;
      if (rr.stripeChargeId) {
        refund = await stripe.refunds.create({
          charge: rr.stripeChargeId,
          amount: rr.amountCents,
        });
      } else if (rr.stripePaymentIntentId) {
        refund = await stripe.refunds.create({
          payment_intent: rr.stripePaymentIntentId,
          amount: rr.amountCents,
        });
      } else {
        return res.status(400).json({ error: "No Stripe reference to refund" });
      }

      await query(
        `UPDATE "RefundRequest"
            SET status='REFUNDED',
                "stripeRefundId"=$2,
                "processedAt"=NOW(),
                "updatedAt"=NOW()
          WHERE id = $1`,
        [rr.id, refund.id]
      );

      res.json({ ok: true, refundId: refund.id });
    } catch (e) {
      console.error("Stripe refund failed:", e);
      res.status(500).json({ error: "Stripe refund failed" });
    }
  }
);

// Decline a refund request
router.post(
  "/:id/refunds/:refundId/decline",
  authRequired,
  requireRole("ADMIN", "SUPERADMIN"),
  async (req, res) => {
    const rr = await query(
      `UPDATE "RefundRequest"
          SET status='DECLINED', "processedAt"=NOW(), "updatedAt"=NOW()
        WHERE id = $1 AND "userId" = $2 AND status='PENDING'
        RETURNING *`,
      [req.params.refundId, req.params.id]
    );
    if (!rr.rows[0]) return res.status(404).json({ error: "Not found or already processed" });
    res.json({ ok: true });
  }
);

// Quick refund (admin-initiated) for a specific payment
router.post(
  "/:id/payments/:paymentId/refund",
  authRequired,
  requireRole("ADMIN", "SUPERADMIN"),
  async (req, res) => {
    const pRes = await query(
      `SELECT * FROM "StudentPayment" WHERE id=$1 AND "userId"=$2`,
      [req.params.paymentId, req.params.id]
    );
    const pm = pRes.rows[0];
    if (!pm) return res.status(404).json({ error: "Payment not found" });

    // Create an RR row first (for audit), then immediately approve it
    const { rows } = await query(
      `INSERT INTO "RefundRequest"
         (id,"userId","bookingId","paymentId","amountCents","currency",reason,status,
          "createdAt","updatedAt")
       VALUES (gen_random_uuid()::text,$1,$2,$3,$4,$5,$6,'PENDING',NOW(),NOW())
       RETURNING *`,
      [
        pm.userId,
        pm.bookingId,
        pm.id,
        pm.amountCents,
        pm.currency,
        String(req.body?.reason || "").slice(0, 1000) || null,
      ]
    );

    req.params.refundId = rows[0].id; // reuse approve logic
    return router.handle(req, res);   // fall through to route stack (will hit approve)
  }
);


export default router;