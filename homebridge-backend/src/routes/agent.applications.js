// src/routes/agent.applications.js
import { Router } from "express";
import { query } from "../db.js";

const router = Router();

/* ---------------- helpers ---------------- */

// Legacy note prefix (fallback only)
const OFFER_PREFIX = "OFFER::";
const safeJson = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};
const decodeOfferFromNote = (note) =>
  typeof note === "string" && note.startsWith(OFFER_PREFIX)
    ? safeJson(note.slice(OFFER_PREFIX.length))
    : null;

// gate: AGENT or ADMIN (SUPERADMIN counts as admin)
function ensureAgentOrAdmin(req, res, next) {
  const r = String(req.user?.role || "").toUpperCase();
  if (!req.user?.id) return res.status(401).json({ error: "Unauthorized" });
  if (!["AGENT", "ADMIN", "SUPERADMIN"].includes(r)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  next();
}

// Stage label (uses booking.status; “Offer Sent” if APPROVED + offer exists)
function stageLabelFromBooking(b) {
  const latestOffer = Array.isArray(b.offers) && b.offers[0] ? b.offers[0] : null;
  if (b.status === "REJECTED") return "Rejected";
  if (b.status === "APPROVED") return latestOffer ? "Offer Sent" : "Admin Approved";
  if (b.status === "UNDER_REVIEW") return "Reviewing";
  return "New";
}

function toListRow(b) {
  const latestOffer = Array.isArray(b.offers) && b.offers[0] ? b.offers[0] : null;
  return {
    id: b.id,
    ref: b.id.slice(0, 8).toUpperCase(),
    listing: {
      id: b.listing.id,
      title: b.listing.title,
      price: b.listing.price, // monthly (your schema)
    },
    listingRef: b.listing.id.slice(0, 8).toUpperCase(),
    listingId: b.listing.id,
    studentName: b.student.name || b.student.email.split("@")[0],
    studentEmail: b.student.email,
    studentPhone: b.student.phone || null,
    docCount: Array.isArray(b.docIds) ? b.docIds.length : 0,
    status: b.status,
    stageLabel: stageLabelFromBooking(b),
    createdAt: b.createdAt,
    hasOffer: Boolean(latestOffer) || Boolean(decodeOfferFromNote(b.note)), // legacy safe
    offerExpiresAt: latestOffer?.expiresAt || decodeOfferFromNote(b.note)?.expiresAt || null,
  };
}

function toDetail(b, docs = []) {
  const latestOffer = Array.isArray(b.offers) && b.offers[0] ? b.offers[0] : null;
  const legacy = decodeOfferFromNote(b.note);

  // prefer DB offer; fall back to legacy note
  const partnerOffer = latestOffer
    ? {
        id: latestOffer.id,
        status: latestOffer.status,
        currency: latestOffer.currency,
        note: latestOffer.note || "",
        lines: latestOffer.lines || [],
        sentAt: latestOffer.sentAt,
        expiresAt: latestOffer.expiresAt || null,
        acceptedAt: latestOffer.acceptedAt || null,
        declinedAt: latestOffer.declinedAt || null,
        paidNowAt: latestOffer.paidNowAt || null,
        payMethod: latestOffer.payMethod || null,
      }
    : legacy
    ? { status: legacy.status || "SENT", ...legacy }
    : null;

  return {
    id: b.id,
    ref: b.id.slice(0, 8).toUpperCase(),
    status: b.status,
    stageLabel: stageLabelFromBooking(b),
    createdAt: b.createdAt,
    submittedAt: b.submittedAt,
    feePaidAt: b.feePaidAt,
    docsUpdatedAt: b.docsUpdatedAt,
    checkIn: b.checkIn,
    checkOut: b.checkOut,
    studentId: b.student.id,
    studentName: b.student.name || b.student.email.split("@")[0],
    studentEmail: b.student.email,
    studentPhone: b.student.phone || null,
    listing: { id: b.listing.id, title: b.listing.title, price: b.listing.price },
    listingRef: b.listing.id.slice(0, 8).toUpperCase(),
    listingId: b.listing.id,
    docs: docs.map((d) => ({
      id: d.id,
      filename: d.filename,
      url: d.url,
      size: d.size,
      category: d.category,
      createdAt: d.createdAt,
    })),
    // expose both to be compatible with current FE
    partnerOffer,
    offer: partnerOffer,
  };
}

// quick guard that this booking belongs to this agent (via listing.agentId)
function ensureAgentOwnsBooking(agentId, booking) {
  return booking?.listing?.agentId === agentId;
}

/* ---------------- SQL helpers ---------------- */

// Load a booking with listing + student + latest offer (as array [latest])
async function loadBookingWithRelations(bookingId) {
  const { rows } = await query(
    `
    WITH base AS (
      SELECT
        b.*,
        row_to_json(l) AS listing,
        row_to_json(s) AS student
      FROM "Booking" b
      JOIN "Listing" l ON l.id = b."listingId"
      JOIN "User"    s ON s.id = b."studentId"
      WHERE b.id = $1
    ),
    latest_offer AS (
      SELECT *
      FROM "Offer"
      WHERE "bookingId" = $1
      ORDER BY "createdAt" DESC
      LIMIT 1
    )
    SELECT
      to_jsonb(base) AS bjson,
      (
        SELECT COALESCE(jsonb_agg(to_jsonb(o)), '[]'::jsonb)
        FROM latest_offer o
      ) AS offers
    FROM base
    `,
    [bookingId]
  );
  if (!rows[0]) return null;

  const b = rows[0].bjson;
  b.offers = rows[0].offers || [];
  return b;
}

/* ---------------- routes ---------------- */

// LIST (agent-only + super/admin)
router.get("/", ensureAgentOrAdmin, async (req, res) => {
  try {
    const agentId = req.user.id;
    const stage = String(req.query.stage || "").toUpperCase();

    // Filter by listing.agentId directly; get latest offer via LATERAL
    const { rows } = await query(
      `
      SELECT
        b.*,
        row_to_json(l) AS listing,
        row_to_json(s) AS student,
        COALESCE(
          jsonb_agg(lo.offer) FILTER (WHERE lo.offer IS NOT NULL),
          '[]'::jsonb
        ) AS offers
      FROM "Booking" b
      JOIN "Listing" l ON l.id = b."listingId"
      JOIN "User"    s ON s.id = b."studentId"
      LEFT JOIN LATERAL (
        SELECT to_jsonb(o) AS offer
        FROM "Offer" o
        WHERE o."bookingId" = b.id
        ORDER BY o."createdAt" DESC
        LIMIT 1
      ) lo ON TRUE
      WHERE l."agentId" = $1
        AND (
          $2 = '' OR
          ($2 = 'UNDER_REVIEW'     AND b.status = 'UNDER_REVIEW') OR
          ($2 = 'APPROVED'         AND b.status = 'APPROVED') OR
          ($2 = 'PARTNER_REJECTED' AND b.status = 'REJECTED')
        )
      GROUP BY b.id, l.id, s.id
      ORDER BY b."createdAt" DESC
      `,
      [agentId, stage]
    );

    const items = rows.map((r) => {
      const b = {
        ...r,
        listing: r.listing,
        student: r.student,
        offers: r.offers || [],
      };
      return toListRow(b);
    });

    res.json({ items });
  } catch (e) {
    console.error("GET /agent/applications error:", e.message, e.detail);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DETAIL
router.get("/:id", ensureAgentOrAdmin, async (req, res) => {
  try {
    const agentId = req.user.id;
    const id = req.params.id;

    const b = await loadBookingWithRelations(id);
    if (!b) return res.status(404).json({ error: "Not found" });
    if (!ensureAgentOwnsBooking(agentId, b)) return res.status(403).json({ error: "Forbidden" });

    // Load docs by docIds for that student
    let docs = [];
    if (Array.isArray(b.docIds) && b.docIds.length) {
      const { rows: drows } = await query(
        `
        SELECT id, filename, url, size, category, "createdAt"
        FROM "StudentDoc"
        WHERE "userId" = $1 AND id = ANY($2::text[])
        ORDER BY "createdAt" DESC
        `,
        [b.studentId, b.docIds]
      );
      docs = drows;
    }

    res.json({ item: toDetail(b, docs) });
  } catch (e) {
    console.error("GET /agent/applications/:id error:", e.message, e.detail);
    res.status(500).json({ error: "Internal server error" });
  }
});

// CONFIRM / SEND OFFER → create Offer row (+ set booking APPROVED for stage label)
router.post("/:id/confirm", ensureAgentOrAdmin, async (req, res) => {
  try {
    const agentId = req.user.id;
    const id = req.params.id;

    const b0 = await loadBookingWithRelations(id);
    if (!b0) return res.status(404).json({ error: "Not found" });
    if (!ensureAgentOwnsBooking(agentId, b0)) return res.status(403).json({ error: "Forbidden" });

    const draft = req.body || {};
    if (!Array.isArray(draft.lines) || draft.lines.length === 0) {
      return res.status(400).json({ error: "Offer must have at least one line item" });
    }

    // Create Offer
    await query(
      `
      INSERT INTO "Offer"
        (id, "bookingId", "agentId", status, currency, note, lines, "expiresAt", "createdAt", "updatedAt")
      VALUES
        (gen_random_uuid()::text, $1, $2, 'SENT', $3, $4, $5::jsonb, $6, NOW(), NOW())
      `,
      [
        b0.id,
        agentId,
        draft.currency || "USD",
        draft.note || "",
        JSON.stringify(draft.lines || []),
        draft.expiresAt ? new Date(draft.expiresAt) : null,
      ]
    );

    // Update booking status so UI shows "Offer Sent"
    await query(
      `UPDATE "Booking" SET status = 'APPROVED', "updatedAt" = NOW() WHERE id = $1`,
      [b0.id]
    );

    const b = await loadBookingWithRelations(b0.id);

    // hydrate docs again if needed
    let docs = [];
    if (Array.isArray(b.docIds) && b.docIds.length) {
      const { rows: drows } = await query(
        `SELECT id, filename, url, size, category, "createdAt"
         FROM "StudentDoc"
         WHERE "userId" = $1 AND id = ANY($2::text[])
         ORDER BY "createdAt" DESC`,
        [b.studentId, b.docIds]
      );
      docs = drows;
    }

    res.json({ item: toDetail(b, docs) });
  } catch (e) {
    console.error("POST /agent/applications/:id/confirm error:", e.message, e.detail);
    res.status(500).json({ error: "Internal server error" });
  }
});

// REQUEST DOCS (stub)
router.post("/:id/request-docs", ensureAgentOrAdmin, async (req, res) => {
  try {
    const agentId = req.user.id;
    const id = req.params.id;

    const b = await loadBookingWithRelations(id);
    if (!b) return res.status(404).json({ error: "Not found" });
    if (!ensureAgentOwnsBooking(agentId, b)) return res.status(403).json({ error: "Forbidden" });

    // TODO: send email/notification & record system note
    res.json({ item: toDetail(b) });
  } catch (e) {
    console.error("POST /agent/applications/:id/request-docs error:", e.message, e.detail);
    res.status(500).json({ error: "Internal server error" });
  }
});

// REJECT BOOKING
router.post("/:id/reject", ensureAgentOrAdmin, async (req, res) => {
  try {
    const agentId = req.user.id;
    const id = req.params.id;

    const b0 = await loadBookingWithRelations(id);
    if (!b0) return res.status(404).json({ error: "Not found" });
    if (!ensureAgentOwnsBooking(agentId, b0)) return res.status(403).json({ error: "Forbidden" });

    await query(
      `UPDATE "Booking" SET status = 'REJECTED', "updatedAt" = NOW() WHERE id = $1`,
      [id]
    );

    const b = await loadBookingWithRelations(id);
    res.json({ item: toDetail(b) });
  } catch (e) {
    console.error("POST /agent/applications/:id/reject error:", e.message, e.detail);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
