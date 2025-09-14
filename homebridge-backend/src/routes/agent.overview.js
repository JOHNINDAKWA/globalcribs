// src/routes/agent.overview.js
import { Router } from "express";
import { query } from "../db.js";
import { authRequired } from "../middleware/auth.js";

const router = Router();

function ensureAgentOrAdmin(req, res) {
  const role = String(req.user?.role || "").toUpperCase();
  if (!req.user?.id) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  if (!["AGENT", "SUPERADMIN"].includes(role)) {
    res.status(403).json({ error: "Agent access only" });
    return false;
  }
  return true;
}

function shortFromUUID(id = "") {
  const s = String(id).replace(/-/g, "").toUpperCase();
  if (s.length < 12) return s || "XXXX";
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(-4)}`;
}

function stageFromRow(row) {
  if (row.status === "REJECTED") return "Rejected";
  if (row.status === "UNDER_REVIEW") return "Reviewing";
  if (row.status === "APPROVED") return row.has_offer ? "Offer Sent" : "Admin Approved";
  return "New";
}

/**
 * GET /api/agent/overview
 * Returns:
 * {
 *   kpis: { liveListings, applicationsTotal, offerSent, approved, rejected, reviewing, new, feePaid, docsPending },
 *   pipeline: [{stage, count}, ...],
 *   recent: [{ id, ref, studentName, studentEmail, listingTitle, moveIn, stage, createdAt }]
 * }
 */
router.get("/", authRequired, async (req, res) => {
  if (!ensureAgentOrAdmin(req, res)) return;
  const agentId = req.user.id;

  try {
    // Live listings (published)
    const liveListingsRes = await query(
      `SELECT COUNT(*)::int AS c FROM "Listing" WHERE "agentId" = $1 AND published = TRUE`,
      [agentId]
    );
    const liveListings = liveListingsRes.rows[0]?.c ?? 0;

    // Pipeline + totals (compute from bookings + latest-offer presence)
    const pipeRes = await query(
      `
      SELECT
        COUNT(*)::int AS total,
        SUM(CASE WHEN b.status = 'REJECTED' THEN 1 ELSE 0 END)::int AS rejected,
        SUM(CASE WHEN b.status = 'UNDER_REVIEW' THEN 1 ELSE 0 END)::int AS reviewing,
        SUM(CASE WHEN b.status = 'APPROVED' AND lo.has_offer = TRUE THEN 1 ELSE 0 END)::int AS offer_sent,
        SUM(CASE WHEN b.status = 'APPROVED' AND (lo.has_offer IS NULL OR lo.has_offer = FALSE) THEN 1 ELSE 0 END)::int AS approved,
        SUM(CASE WHEN b.status NOT IN ('REJECTED','UNDER_REVIEW','APPROVED') THEN 1 ELSE 0 END)::int AS new,
        SUM(CASE WHEN b."feePaidAt" IS NOT NULL THEN 1 ELSE 0 END)::int AS fee_paid,
        SUM(CASE WHEN (b."docIds" IS NULL OR array_length(b."docIds", 1) IS NULL OR array_length(b."docIds", 1) = 0) THEN 1 ELSE 0 END)::int AS docs_pending
      FROM "Booking" b
      JOIN "Listing" l ON l.id = b."listingId"
      LEFT JOIN LATERAL (
        SELECT TRUE AS has_offer
        FROM "Offer" o
        WHERE o."bookingId" = b.id
        ORDER BY o."createdAt" DESC
        LIMIT 1
      ) lo ON TRUE
      WHERE l."agentId" = $1
      `,
      [agentId]
    );

    const p = pipeRes.rows[0] || {};
    const kpis = {
      liveListings,
      applicationsTotal: p.total ?? 0,
      offerSent: p.offer_sent ?? 0,
      approved: p.approved ?? 0,
      rejected: p.rejected ?? 0,
      reviewing: p.reviewing ?? 0,
      new: p.new ?? 0,
      feePaid: p.fee_paid ?? 0,
      docsPending: p.docs_pending ?? 0,
    };

    // Recent applications (last 6)
    const recentRes = await query(
      `
      SELECT
        b.id, b.status, b."checkIn", b."createdAt",
        s.name AS student_name, s.email AS student_email,
        l.title AS listing_title,
        (lo.has_offer IS TRUE) AS has_offer
      FROM "Booking" b
      JOIN "Listing" l ON l.id = b."listingId"
      JOIN "User"    s ON s.id = b."studentId"
      LEFT JOIN LATERAL (
        SELECT TRUE AS has_offer
        FROM "Offer" o
        WHERE o."bookingId" = b.id
        ORDER BY o."createdAt" DESC
        LIMIT 1
      ) lo ON TRUE
      WHERE l."agentId" = $1
      ORDER BY b."createdAt" DESC
      LIMIT 6
      `,
      [agentId]
    );

    const recent = recentRes.rows.map((r) => ({
      id: r.id,
      ref: `APP-${shortFromUUID(r.id)}`,
      studentName: r.student_name || (r.student_email || "").split("@")[0] || "Student",
      studentEmail: r.student_email,
      listingTitle: r.listing_title || "Listing",
      moveIn: r.checkin || r.checkIn || null,
      stage: stageFromRow({ status: r.status, has_offer: r.has_offer }),
      createdAt: r.createdAt,
    }));

    // Pipeline array the UI can render directly
    const pipeline = [
      { stage: "New", count: kpis.new },
      { stage: "Reviewing", count: kpis.reviewing },
      { stage: "Offer Sent", count: kpis.offerSent },
      { stage: "Admin Approved", count: kpis.approved },
      { stage: "Rejected", count: kpis.rejected },
    ];

    res.json({ kpis, pipeline, recent });
  } catch (e) {
    console.error("GET /api/agent/overview error:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
