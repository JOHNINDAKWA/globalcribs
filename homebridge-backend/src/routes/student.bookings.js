// src/routes/student.bookings.js
import { Router } from "express";
import { query } from "../db.js";
import { authRequired } from "../middleware/auth.js";
import { z } from "zod";
import { sendMail } from "../lib/mailer.js";

const APP_NAME = process.env.APP_NAME || "GlobalCribs";
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "johnindakwa6@gmail.com";


const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || "";
const DEFAULT_CURRENCY = (process.env.DEFAULT_CURRENCY || "USD").toLowerCase();
const STUDENT_APP_FEE_CENTS = Number(process.env.STUDENT_APP_FEE_CENTS || 2500);
const BASE_URL = process.env.FRONTEND_URL || "http://localhost:5173";

let stripe;
if (STRIPE_SECRET_KEY) {
  const { default: Stripe } = await import("stripe");
  stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });
}

// util: current app-fee for booking (DB column optional; fallback to env)
async function getAppFeeCents(bookingId) {
  const { rows } = await query(
    `SELECT COALESCE("applicationFeeCents", $2)::int AS fee
     FROM "Booking" WHERE id = $1`,
    [bookingId, STUDENT_APP_FEE_CENTS]
  );
  return rows[0]?.fee ?? STUDENT_APP_FEE_CENTS;
}

// util: compute "due now" for latest offer (0 if none)
async function getOfferDueNow(bookingId) {
  const { rows } = await query(
    `SELECT id, currency, lines
       FROM "Offer"
      WHERE "bookingId" = $1
      ORDER BY "createdAt" DESC
      LIMIT 1`,
    [bookingId]
  );
  const o = rows[0];
  if (!o) return { offerId: null, dueNow: 0, currency: DEFAULT_CURRENCY };
  const lines = Array.isArray(o.lines) ? o.lines : [];
  let dueNow = 0;
  for (const l of lines) {
    const amt = Number(l?.amountCents ?? 0);
    const due = String(l?.dueType || "").toUpperCase();
    if (due === "NOW") dueNow += amt;
  }
  const currency = (o.currency || DEFAULT_CURRENCY).toLowerCase();
  return { offerId: o.id, dueNow, currency };
}

const router = Router();

/* ---------- tiny helpers ---------- */
function shortFromUUID(id = "") {
  const s = String(id).replace(/-/g, "").toUpperCase();
  if (s.length < 12) return s || "XXXX";
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(-4)}`;
}
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

/* ---------- profile + payment syncing ---------- */

const ProfilePatchSchema = z
  .object({
    fullName: z.string().optional(),
    email: z.string().email().optional(),
    phone: z.string().optional(),
    whatsapp: z.string().optional(),
    addressLine1: z.string().optional(),
    addressLine2: z.string().optional(),
    addressCity: z.string().optional(),
    addressCountry: z.string().optional(),
    postal: z.string().optional(),
  })
  .partial();

// ensure StudentProfile exists; return current row
async function ensureProfile(userId) {
  const { rows } = await query(
    `SELECT * FROM "StudentProfile" WHERE "userId"=$1`,
    [userId]
  );
  if (rows[0]) return rows[0];
  const { rows: created } = await query(
    `INSERT INTO "StudentProfile"(id,"userId","createdAt","updatedAt")
     VALUES (gen_random_uuid()::text,$1,NOW(),NOW()) RETURNING *`,
    [userId]
  );
  return created[0];
}

// Save/merge a payment method into StudentProfile.paymentMethods (jsonb)
async function persistPaymentMethod(
  userId,
  method,
  details = {},
  setDefault = true
) {
  const prof = await ensureProfile(userId);
  const prev =
    prof.paymentMethods && typeof prof.paymentMethods === "object"
      ? prof.paymentMethods
      : {};
  const entry = {
    type: method, // "CARD" | "MPESA"
    ...details,
    savedAt: new Date().toISOString(),
  };
  const history = Array.isArray(prev.history) ? prev.history : [];
  const next = {
    ...prev,
    lastUsed: entry,
    history: [entry, ...history].slice(0, 10),
    card: method === "CARD" ? entry : prev.card,
    mpesa: method === "MPESA" ? entry : prev.mpesa,
    ...(setDefault ? { default: entry } : {}),
  };

  await query(
    `UPDATE "StudentProfile"
     SET "paymentMethods" = $2::jsonb, "updatedAt" = NOW()
     WHERE "userId" = $1`,
    [userId, JSON.stringify(next)]
  );
}

// Upsert small profile changes collected during checkout
async function upsertProfilePatch(userId, patch = {}) {
  if (!patch || Object.keys(patch).length === 0) return;
  // ensure exists
  await ensureProfile(userId);
  // only update provided keys
  const sets = [];
  const vals = [userId];
  let i = 2;
  for (const [k, v] of Object.entries(patch)) {
    sets.push(`"${k}" = $${i++}`);
    vals.push(v);
  }
  sets.push(`"updatedAt" = NOW()`);
  await query(
    `UPDATE "StudentProfile" SET ${sets.join(", ")} WHERE "userId" = $1`,
    vals
  );
}

/* ---------- offer helpers ---------- */

function offerTotals(offer) {
  if (!offer || !Array.isArray(offer.lines))
    return { dueNow: 0, dueLater: 0, all: 0 };
  const val = (n) => (Number.isFinite(n) ? n : 0);
  let dueNow = 0,
    dueLater = 0;
  for (const l of offer.lines) {
    const amt = val(l.amountCents);
    if (String(l.dueType).toUpperCase() === "NOW") dueNow += amt;
    else dueLater += amt;
  }
  return { dueNow, dueLater, all: dueNow + dueLater };
}

function presentOfferFromRow(o) {
  if (!o) return null;
  return {
    id: o.id,
    status: o.status,
    currency: o.currency,
    note: o.note || "",
    lines: Array.isArray(o.lines) ? o.lines : [],
    sentAt: o.sentAt,
    expiresAt: o.expiresAt || null,
    acceptedAt: o.acceptedAt || null,
    declinedAt: o.declinedAt || null,
    paidNowAt: o.paidNowAt || null,
    payMethod: o.payMethod || null,
    totals: offerTotals({ lines: o.lines }),
  };
}

function presentBooking(b, withListing = false, opts = { offer: "none" }) {
  if (!b) return b;
  const ref = `BK-${shortFromUUID(b.id)}`;
  const listingRef = `LS-${shortFromUUID(b.listingId)}`;
  let base = { ...b, ref, listingRef };
  if (withListing && b.listing)
    base = { ...base, listing: { ...b.listing, ref: listingRef } };

  const mode = opts.offer || "none";
  const latestOfferRow =
    Array.isArray(b.offers) && b.offers[0] ? b.offers[0] : null;

  if (mode === "summary") {
    const has = Boolean(latestOfferRow) || Boolean(decodeOfferFromNote(b.note));
    const exp =
      latestOfferRow?.expiresAt ||
      decodeOfferFromNote(b.note)?.expiresAt ||
      null;
    base.hasPartnerOffer = has;
    base.partnerOfferExpiresAt = exp;
    base.hasOffer = has;
    base.offerExpiresAt = exp;
  } else if (mode === "full") {
    const full = latestOfferRow
      ? presentOfferFromRow(latestOfferRow)
      : (() => {
          const legacy = decodeOfferFromNote(b.note);
          return legacy
            ? {
                status: legacy.status || "SENT",
                ...legacy,
                totals: offerTotals(legacy),
              }
            : null;
        })();
    base.partnerOffer = full;
    base.offer = full;
  }
  return base;
}

/* ---------- validation ---------- */

const CreateBookingBody = z.object({
  listingId: z.string().min(1),
  checkIn: z.string().min(1),
  checkOut: z.string().min(1),
  note: z.string().optional().nullable(),
  docIds: z.array(z.string()).optional().default([]),
  profilePatch: ProfilePatchSchema.optional(),
});

const UpdateBookingBody = z.object({
  checkIn: z.string().min(1).optional(),
  checkOut: z.string().min(1).optional(),
  note: z.string().optional().nullable(),
  docIds: z.array(z.string()).optional(),
  profilePatch: ProfilePatchSchema.optional(),
});

// students only (SUPERADMIN allowed for testing)
function ensureStudent(req, res) {
  const role = String(req.user.role || "").toUpperCase();
  if (role !== "STUDENT" && role !== "SUPERADMIN") {
    res.status(403).json({ error: "Student access only" });
    return false;
  }
  return true;
}

async function mustOwnBooking(id, userId) {
  const { rows } = await query(
    `SELECT id,"studentId" FROM "Booking" WHERE id=$1`,
    [id]
  );
  const b = rows[0];
  if (!b) return { ok: false, status: 404, error: "Booking not found" };
  if (b.studentId !== userId)
    return { ok: false, status: 403, error: "Forbidden" };
  return { ok: true, booking: b };
}

/* ---------- SQL helpers ---------- */

// Load booking with listing + latest offer (as array [latest])
async function loadBookingWithRelations(id) {
  const { rows } = await query(
    `
    WITH base AS (
      SELECT
        b.*,
        row_to_json(l) AS listing
      FROM "Booking" b
      JOIN "Listing" l ON l.id = b."listingId"
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
      to_jsonb(b) AS bjson,
      (
        SELECT COALESCE(jsonb_agg(to_jsonb(o)), '[]'::jsonb)
        FROM latest_offer o
      ) AS offers
    FROM base b
    `,
    [id]
  );
  if (!rows[0]) return null;
  const b = rows[0].bjson;
  b.offers = rows[0].offers || [];
  return b;
}

// List bookings for a student (with listing + latest offer)
async function listBookingsForStudent(studentId, take, skip) {
  const { rows } = await query(
    `
    SELECT
      b.*,
      row_to_json(l) AS listing,
      COALESCE(
        jsonb_agg(lo.offer) FILTER (WHERE lo.offer IS NOT NULL),
        '[]'::jsonb
      ) AS offers
    FROM "Booking" b
    JOIN "Listing" l ON l.id = b."listingId"
    LEFT JOIN LATERAL (
      SELECT to_jsonb(o) AS offer
      FROM "Offer" o
      WHERE o."bookingId" = b.id
      ORDER BY o."createdAt" DESC
      LIMIT 1
    ) lo ON TRUE
    WHERE b."studentId" = $1
    GROUP BY b.id, l.id
    ORDER BY b."createdAt" DESC
    LIMIT $2 OFFSET $3
    `,
    [studentId, take, skip]
  );
  return rows.map((r) => ({
    ...r,
    listing: r.listing,
    offers: r.offers || [],
  }));
}

/* ---------- routes ---------- */

// LIST: GET /api/student/bookings
router.get("/", authRequired, async (req, res) => {
  if (!ensureStudent(req, res)) return;

  const take = Math.min(Number(req.query.take || 50), 100);
  const skip = Math.max(Number(req.query.skip || 0), 0);

  try {
    const [itemsRaw, countRes] = await Promise.all([
      listBookingsForStudent(req.user.id, take, skip),
      query(`SELECT COUNT(*)::int AS c FROM "Booking" WHERE "studentId"=$1`, [
        req.user.id,
      ]),
    ]);

    const items = itemsRaw.map((b) =>
      presentBooking(b, true, { offer: "summary" })
    );
    res.json({ items, total: countRes.rows[0].c, take, skip });
  } catch (e) {
    console.error("GET /api/student/bookings error:", e.message, e.detail);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DETAIL: GET /api/student/bookings/:id
router.get("/:id", authRequired, async (req, res) => {
  if (!ensureStudent(req, res)) return;

  const chk = await mustOwnBooking(req.params.id, req.user.id);
  if (!chk.ok) return res.status(chk.status).json({ error: chk.error });

  try {
    const b = await loadBookingWithRelations(req.params.id);
    if (!b) return res.status(404).json({ error: "Booking not found" });
    res.json({ item: presentBooking(b, true, { offer: "full" }) });
  } catch (e) {
    console.error("GET /api/student/bookings/:id error:", e.message, e.detail);
    res.status(500).json({ error: "Internal server error" });
  }
});

// CREATE booking  — also sync profile if provided + email student to pay fee
router.post("/", authRequired, async (req, res) => {
  if (!ensureStudent(req, res)) return;
  const parsed = CreateBookingBody.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: parsed.error.flatten() });

  try {
    // listing exists?
    const { rows: lst } = await query(`SELECT id FROM "Listing" WHERE id=$1`, [
      parsed.data.listingId,
    ]);
    if (!lst[0]) return res.status(404).json({ error: "Listing not found" });

    if (parsed.data.profilePatch) {
      await upsertProfilePatch(req.user.id, parsed.data.profilePatch);
    }

    // create booking
    const docIds = parsed.data.docIds || [];
    const { rows } = await query(
      `INSERT INTO "Booking"
        (id, "studentId", "listingId", "checkIn", "checkOut", note, "docIds", "docsUpdatedAt",
         status, "createdAt", "updatedAt")
       VALUES
        (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6::text[], $7,
         'PENDING_PAYMENT', NOW(), NOW())
       RETURNING id`,
      [
        req.user.id,
        lst[0].id,
        parsed.data.checkIn,
        parsed.data.checkOut,
        parsed.data.note || null,
        docIds,
        docIds.length ? new Date() : null,
      ]
    );

    const b = await loadBookingWithRelations(rows[0].id);
    const item = presentBooking(b, true, { offer: "full" });

     // NEW: if the student sent a note, mirror it into the messaging system
 if (parsed.data.note && parsed.data.note.trim().length > 0) {
   try {
     // ensure (student, booking) thread exists
     const thr = await query(
       `INSERT INTO "MessageThread"(id, "studentId", "bookingId", "createdAt", "updatedAt")
        VALUES (gen_random_uuid()::text, $1, $2, NOW(), NOW())
        ON CONFLICT ("studentId","bookingId") WHERE "bookingId" IS NOT NULL
        DO UPDATE SET "updatedAt" = NOW()
        RETURNING id`,
       [req.user.id, item.id]
     );
     const threadId = thr.rows[0].id;
     await query(
      `INSERT INTO "Message"(id, "threadId", "senderRole", "senderId", body, "createdAt")
        VALUES (gen_random_uuid()::text, $1, 'STUDENT', $2, $3, NOW())`,
       [threadId, req.user.id, parsed.data.note]
     );
   } catch (e) {
     // don't block booking creation if messaging insert fails
     console.error("mirror note -> messages failed:", e?.message || e);
   }
 }

    // fire-and-forget student email (do not block the response)
    (async () => {
      try {
        const { rows: urows } = await query(
          `SELECT name, email FROM "User" WHERE id = $1`,
          [req.user.id]
        );
        const student = urows[0] || {};
        const ref = `BK-${shortFromUUID(item.id)}`;
        const listingTitle =
          item?.listing?.title || item.listingRef || "Your listing";
        const when = `${item.checkIn} → ${item.checkOut}`;
        const url = `${FRONTEND_URL}/dashboard/student/bookings/${item.id}`;

        const subject = `${APP_NAME}: booking received (${ref}) — action needed`;
        const text = [
          `Hi ${student.name || "there"},`,
          ``,
          `We’ve received your booking ${ref} for "${listingTitle}" (${when}).`,
          `To proceed, please pay the application/registration fee in your dashboard:`,
          `${url}`,
          ``,
          `We’ll notify you when it’s ready to submit to the partner.`,
          ``,
          `— ${APP_NAME} Team`,
        ].join("\n");

        const html = `
          <p>Hi ${student.name || "there"},</p>
          <p>We’ve received your booking <b>${ref}</b> for “${listingTitle}” (<b>${when}</b>).</p>
          <p><b>Next step:</b> please pay the application/registration fee in your dashboard.</p>
          <p><a href="${url}">Open your booking</a></p>
          <p>We’ll notify you when it’s ready to submit to the partner.</p>
          <p>— ${APP_NAME} Team</p>
        `;

        await sendMail({ to: student.email, subject, text, html });
      } catch (e) {
        console.error("email(student booking received) failed:", e);
      }
    })();

    return res.status(201).json({ item });
  } catch (e) {
    console.error("POST /api/student/bookings error:", e.message, e.detail);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH booking — also sync profile if provided
router.patch("/:id", authRequired, async (req, res) => {
  if (!ensureStudent(req, res)) return;
  const parsed = UpdateBookingBody.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: parsed.error.flatten() });

  const chk = await mustOwnBooking(req.params.id, req.user.id);
  if (!chk.ok) return res.status(chk.status).json({ error: chk.error });

  try {
    if (parsed.data.profilePatch) {
      await upsertProfilePatch(req.user.id, parsed.data.profilePatch);
    }

    // dynamic update
    const set = [];
    const vals = [];
    let i = 1;

    if ("checkIn" in parsed.data) {
      set.push(`"checkIn" = $${i++}`);
      vals.push(parsed.data.checkIn ?? null);
    }
    if ("checkOut" in parsed.data) {
      set.push(`"checkOut" = $${i++}`);
      vals.push(parsed.data.checkOut ?? null);
    }
    if ("note" in parsed.data) {
      set.push(`note = $${i++}`);
      vals.push(parsed.data.note ?? null);
    }
    if ("docIds" in parsed.data) {
      set.push(`"docIds" = $${i++}::text[]`);
      vals.push(parsed.data.docIds ?? null);
      set.push(`"docsUpdatedAt" = NOW()`);
    }
    set.push(`"updatedAt" = NOW()`);

    await query(`UPDATE "Booking" SET ${set.join(", ")} WHERE id = $${i}`, [
      ...vals,
      req.params.id,
    ]);

    const b = await loadBookingWithRelations(req.params.id);
    res.json({ item: presentBooking(b, true, { offer: "full" }) });
  } catch (e) {
    console.error(
      "PATCH /api/student/bookings/:id error:",
      e.message,
      e.detail
    );
    res.status(500).json({ error: "Internal server error" });
  }
});

// PAY application fee — also persist payment method to profile
router.post("/:id/pay", authRequired, async (req, res) => {
  if (!ensureStudent(req, res)) return;

  const PayBody = z.object({
    method: z.enum(["CARD", "MPESA"]),
    details: z
      .object({
        brand: z.string().optional(),
        last4: z
          .string()
          .regex(/^\d{2,4}$/)
          .optional(),
        expMonth: z.number().int().min(1).max(12).optional(),
        expYear: z.number().int().min(2000).max(2100).optional(),
        name: z.string().optional(),
        billingEmail: z.string().email().optional(),
        mpesaPhone: z.string().optional(),
      })
      .optional(),
    saveToProfile: z.boolean().optional().default(true),
  });
  const parsed = PayBody.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: parsed.error.flatten() });

  const chk = await mustOwnBooking(req.params.id, req.user.id);
  if (!chk.ok) return res.status(chk.status).json({ error: chk.error });

  try {
    const { rows } = await query(
      `SELECT "feePaidAt","docIds" FROM "Booking" WHERE id=$1`,
      [req.params.id]
    );
    const current = rows[0];

    if (!current.feePaidAt) {
      const docsCount = Array.isArray(current.docIds)
        ? current.docIds.length
        : 0;
      const nextStatus = docsCount > 0 ? "READY_TO_SUBMIT" : "PAYMENT_COMPLETE";
      await query(
        `UPDATE "Booking"
         SET "feePaidAt" = NOW(), "paymentMethod" = $2, status = $3, "updatedAt" = NOW()
         WHERE id = $1`,
        [req.params.id, parsed.data.method, nextStatus]
      );
      if (parsed.data.saveToProfile) {
        await persistPaymentMethod(
          req.user.id,
          parsed.data.method,
          parsed.data.details || {},
          true
        );
      }
    } else if (parsed.data.saveToProfile) {
      await persistPaymentMethod(
        req.user.id,
        parsed.data.method,
        parsed.data.details || {},
        false
      );
    }

    const b = await loadBookingWithRelations(chk.booking.id); // correct id
    const item = presentBooking(b, true, { offer: "full" });
    return res.json({ item });
  } catch (e) {
    console.error(
      "POST /api/student/bookings/:id/pay error:",
      e.message,
      e.detail
    );
    res.status(500).json({ error: "Internal server error" });
  }
});

// OFFER pay (mirror)
router.post("/:id/offer/pay", authRequired, async (req, res) => {
  if (!ensureStudent(req, res)) return;

  const PayBody = z.object({
    method: z.enum(["CARD", "MPESA"]),
    details: z
      .object({
        brand: z.string().optional(),
        last4: z
          .string()
          .regex(/^\d{2,4}$/)
          .optional(),
        expMonth: z.number().int().min(1).max(12).optional(),
        expYear: z.number().int().min(2000).max(2100).optional(),
        name: z.string().optional(),
        billingEmail: z.string().email().optional(),
        mpesaPhone: z.string().optional(),
      })
      .optional(),
    saveToProfile: z.boolean().optional().default(true),
  });
  const parsed = PayBody.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: parsed.error.flatten() });

  const chk = await mustOwnBooking(req.params.id, req.user.id);
  if (!chk.ok) return res.status(chk.status).json({ error: chk.error });

  try {
    const { rows: off } = await query(
      `SELECT * FROM "Offer" WHERE "bookingId"=$1 ORDER BY "createdAt" DESC LIMIT 1`,
      [chk.booking.id]
    );
    const latest = off[0];
    if (!latest) return res.status(400).json({ error: "No offer to pay." });

    await query(
      `UPDATE "Offer"
       SET "paidNowAt" = NOW(),
           "payMethod" = $2,
           status = CASE WHEN status <> 'ACCEPTED' THEN 'ACCEPTED' ELSE status END,
           "acceptedAt" = CASE WHEN status <> 'ACCEPTED' THEN NOW() ELSE "acceptedAt" END,
           "updatedAt" = NOW()
       WHERE id = $1`,
      [latest.id, parsed.data.method]
    );

    if (parsed.data.saveToProfile) {
      await persistPaymentMethod(
        req.user.id,
        parsed.data.method,
        parsed.data.details || {},
        false
      );
    }

    const b = await loadBookingWithRelations(chk.booking.id);
    res.json({ item: presentBooking(b, true, { offer: "full" }) });
  } catch (e) {
    console.error(
      "POST /api/student/bookings/:id/offer/pay error:",
      e.message,
      e.detail
    );
    res.status(500).json({ error: "Internal server error" });
  }
});

// SUBMIT booking (fee must be paid + at least 1 doc) — email admin
router.post("/:id/submit", authRequired, async (req, res) => {
  if (!ensureStudent(req, res)) return;

  const chk = await mustOwnBooking(req.params.id, req.user.id);
  if (!chk.ok) return res.status(chk.status).json({ error: chk.error });

  try {
    const { rows } = await query(
      `SELECT "feePaidAt","docIds" FROM "Booking" WHERE id=$1`,
      [chk.booking.id]
    );
    const b = rows[0];
    const docsCount = Array.isArray(b.docIds) ? b.docIds.length : 0;

    if (!b.feePaidAt)
      return res.status(400).json({ error: "Application fee not paid" });
    if (docsCount === 0)
      return res.status(400).json({ error: "Attach at least one document" });

    await query(
      `UPDATE "Booking"
       SET "submittedAt" = NOW(), status = 'UNDER_REVIEW', "updatedAt" = NOW()
       WHERE id = $1`,
      [chk.booking.id]
    );

    const out = await loadBookingWithRelations(chk.booking.id);
    const item = presentBooking(out, true, { offer: "full" });

    // fire-and-forget admin email
    (async () => {
      try {
        const { rows: urows } = await query(
          `SELECT name, email FROM "User" WHERE id = $1`,
          [out.studentId]
        );
        const student = urows[0] || {};
        const ref = `BK-${shortFromUUID(item.id)}`;
        const listingTitle =
          item?.listing?.title || item.listingRef || "Listing";
        const when = `${item.checkIn} → ${item.checkOut}`;
        const adminUrl = `${FRONTEND_URL}/admin/bookings/${item.id}`;

        const subject = `${APP_NAME}: new submitted booking (${ref}) — fee paid`;
        const text = [
          `A booking has been submitted for consideration.`,
          ``,
          `Ref: ${ref}`,
          `Student: ${student.name || ""} <${student.email || ""}>`,
          `Listing: ${listingTitle}`,
          `Dates: ${when}`,
          `Application fee: PAID`,
          ``,
          `Open admin: ${adminUrl}`,
        ].join("\n");

        const html = `
          <p><b>New submitted booking</b> (fee paid)</p>
          <ul>
            <li><b>Ref:</b> ${ref}</li>
            <li><b>Student:</b> ${student.name || ""} &lt;${
              student.email || ""
            }&gt;</li>
            <li><b>Listing:</b> ${listingTitle}</li>
            <li><b>Dates:</b> ${when}</li>
            <li><b>Application fee:</b> PAID</li>
          </ul>
          <p><a href="${adminUrl}">Open in Admin</a></p>
        `;

        await sendMail({ to: ADMIN_EMAIL, subject, text, html });
      } catch (e) {
        console.error("email(admin submit notice) failed:", e);
      }
    })();

    return res.json({ item });
  } catch (e) {
    console.error(
      "POST /api/student/bookings/:id/submit error:",
      e.message,
      e.detail
    );
    res.status(500).json({ error: "Internal server error" });
  }
});

// ACCEPT latest offer
router.post("/:id/offer/accept", authRequired, async (req, res) => {
  if (!ensureStudent(req, res)) return;

  const chk = await mustOwnBooking(req.params.id, req.user.id);
  if (!chk.ok) return res.status(chk.status).json({ error: chk.error });

  try {
    const { rows } = await query(
      `SELECT id, status FROM "Offer" WHERE "bookingId"=$1 ORDER BY "createdAt" DESC LIMIT 1`,
      [chk.booking.id]
    );
    const latest = rows[0];
    if (!latest) return res.status(400).json({ error: "No offer to accept." });

    if (latest.status !== "ACCEPTED") {
      await query(
        `UPDATE "Offer" SET status='ACCEPTED', "acceptedAt"=NOW(), "updatedAt"=NOW() WHERE id=$1`,
        [latest.id]
      );
    }

    const b = await loadBookingWithRelations(chk.booking.id);
    res.json({ item: presentBooking(b, true, { offer: "full" }) });
  } catch (e) {
    console.error(
      "POST /api/student/bookings/:id/offer/accept error:",
      e.message,
      e.detail
    );
    res.status(500).json({ error: "Internal server error" });
  }
});

// DECLINE latest offer
router.post("/:id/offer/decline", authRequired, async (req, res) => {
  if (!ensureStudent(req, res)) return;

  const chk = await mustOwnBooking(req.params.id, req.user.id);
  if (!chk.ok) return res.status(chk.status).json({ error: chk.error });

  try {
    const { rows } = await query(
      `SELECT id, status FROM "Offer" WHERE "bookingId"=$1 ORDER BY "createdAt" DESC LIMIT 1`,
      [chk.booking.id]
    );
    const latest = rows[0];
    if (!latest) return res.status(400).json({ error: "No offer to decline." });

    if (latest.status !== "DECLINED" && latest.status !== "CANCELLED") {
      await query(
        `UPDATE "Offer" SET status='DECLINED', "declinedAt"=NOW(), "updatedAt"=NOW() WHERE id=$1`,
        [latest.id]
      );
    }

    const b = await loadBookingWithRelations(chk.booking.id);
    res.json({ item: presentBooking(b, true, { offer: "full" }) });
  } catch (e) {
    console.error(
      "POST /api/student/bookings/:id/offer/decline error:",
      e.message,
      e.detail
    );
    res.status(500).json({ error: "Internal server error" });
  }
});



/* ---------------- Stripe-backed Student payments ---------------- */

// Create PaymentIntent for application fee
router.post("/:id/pay/app-fee/intent", authRequired, async (req, res) => {
  if (!ensureStudent(req, res)) return;
  if (!stripe || !STRIPE_PUBLISHABLE_KEY)
    return res.status(400).json({ error: "Stripe not configured" });

  const chk = await mustOwnBooking(req.params.id, req.user.id);
  if (!chk.ok) return res.status(chk.status).json({ error: chk.error });

  try {
    const amountCents = await getAppFeeCents(chk.booking.id);
    const currency = DEFAULT_CURRENCY;

    const pi = await stripe.paymentIntents.create({
      amount: amountCents,
      currency,
      automatic_payment_methods: { enabled: true },
      metadata: {
        type: "student_app_fee",
        userId: req.user.id,
        bookingId: chk.booking.id,
      },
      receipt_email: req.user.email || undefined,
    });

    return res.json({
      clientSecret: pi.client_secret,
      publishableKey: STRIPE_PUBLISHABLE_KEY,
      amountCents,
      currency: currency.toUpperCase(),
    });
  } catch (e) {
    console.error("app-fee intent error:", e);
    res.status(500).json({ error: "Unable to create PaymentIntent" });
  }
});

// Stripe Checkout for application fee
router.post("/:id/pay/app-fee/checkout", authRequired, async (req, res) => {
  if (!ensureStudent(req, res)) return;
  if (!stripe) return res.status(400).json({ error: "Stripe not configured" });

  const chk = await mustOwnBooking(req.params.id, req.user.id);
  if (!chk.ok) return res.status(chk.status).json({ error: chk.error });

  try {
    const amountCents = await getAppFeeCents(chk.booking.id);
    const currency = DEFAULT_CURRENCY;

    const successUrl = `${BASE_URL}/dashboard/student/bookings/${chk.booking.id}?paid=1`;
    const cancelUrl = `${BASE_URL}/dashboard/student/bookings/${chk.booking.id}/pay/app-fee`;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: req.user.email || undefined,
      line_items: [
        {
          price_data: {
            currency,
            unit_amount: amountCents,
            product_data: { name: "Application/Registration Fee" },
          },
          quantity: 1,
        },
      ],
      metadata: {
        type: "student_app_fee",
        userId: req.user.id,
        bookingId: chk.booking.id,
      },
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error("app-fee checkout error:", e);
    res.status(500).json({ error: "Unable to start Stripe Checkout" });
  }
});

// Create PaymentIntent for "offer due now"
router.post("/:id/pay/offer/intent", authRequired, async (req, res) => {
  if (!ensureStudent(req, res)) return;
  if (!stripe || !STRIPE_PUBLISHABLE_KEY)
    return res.status(400).json({ error: "Stripe not configured" });

  const chk = await mustOwnBooking(req.params.id, req.user.id);
  if (!chk.ok) return res.status(chk.status).json({ error: chk.error });

  try {
    const { offerId, dueNow, currency } = await getOfferDueNow(chk.booking.id);
    if (!offerId || dueNow <= 0)
      return res.status(400).json({ error: "No payable amount due now" });

    const pi = await stripe.paymentIntents.create({
      amount: dueNow,
      currency,
      automatic_payment_methods: { enabled: true },
      metadata: {
        type: "student_offer_now",
        userId: req.user.id,
        bookingId: chk.booking.id,
        offerId,
      },
      receipt_email: req.user.email || undefined,
    });

    return res.json({
      clientSecret: pi.client_secret,
      publishableKey: STRIPE_PUBLISHABLE_KEY,
      amountCents: dueNow,
      currency: currency.toUpperCase(),
    });
  } catch (e) {
    console.error("offer intent error:", e);
    res.status(500).json({ error: "Unable to create PaymentIntent" });
  }
});

// Stripe Checkout for "offer due now"
router.post("/:id/pay/offer/checkout", authRequired, async (req, res) => {
  if (!ensureStudent(req, res)) return;
  if (!stripe) return res.status(400).json({ error: "Stripe not configured" });

  const chk = await mustOwnBooking(req.params.id, req.user.id);
  if (!chk.ok) return res.status(chk.status).json({ error: chk.error });

  try {
    const { offerId, dueNow, currency } = await getOfferDueNow(chk.booking.id);
    if (!offerId || dueNow <= 0)
      return res.status(400).json({ error: "No payable amount due now" });

    const successUrl = `${BASE_URL}/dashboard/student/bookings/${chk.booking.id}?offerPaid=1`;
    const cancelUrl = `${BASE_URL}/dashboard/student/bookings/${chk.booking.id}/pay/offer`;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: req.user.email || undefined,
      line_items: [
        {
          price_data: {
            currency,
            unit_amount: dueNow,
            product_data: { name: "Housing offer - Due now" },
          },
          quantity: 1,
        },
      ],
      metadata: {
        type: "student_offer_now",
        userId: req.user.id,
        bookingId: chk.booking.id,
        offerId,
      },
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error("offer checkout error:", e);
    res.status(500).json({ error: "Unable to start Stripe Checkout" });
  }
});


// STUDENT -> request a refund for the most recent payment on this booking
router.post("/:id/refund/request", authRequired, async (req, res) => {
  if (!ensureStudent(req, res)) return;

  const chk = await mustOwnBooking(req.params.id, req.user.id);
  if (!chk.ok) return res.status(chk.status).json({ error: chk.error });

  try {
    // Try to find the latest successful payment on this booking
    const pRes = await query(
      `SELECT *
         FROM "StudentPayment"
        WHERE "bookingId" = $1 AND "userId" = $2 AND status = 'succeeded'
        ORDER BY "createdAt" DESC
        LIMIT 1`,
      [chk.booking.id, req.user.id]
    );
    const pm = pRes.rows[0];
    if (!pm) return res.status(400).json({ error: "No successful payment to refund." });

    // If there is already a PENDING/REFUNDED request for this payment, stop
    const existing = await query(
      `SELECT *
         FROM "RefundRequest"
        WHERE "paymentId" = $1 AND status IN ('PENDING','REFUNDED')
        ORDER BY "createdAt" DESC
        LIMIT 1`,
      [pm.id]
    );
    if (existing.rows[0]) {
      return res.status(400).json({ error: "A refund has already been requested or processed." });
    }

    const reason = String(req.body?.reason || "").slice(0, 1000);
    const { rows } = await query(
      `INSERT INTO "RefundRequest"
         (id, "userId","bookingId","paymentId","amountCents","currency", reason, status,
          "createdAt","updatedAt")
       VALUES (gen_random_uuid()::text, $1,$2,$3,$4,$5,$6,'PENDING', NOW(), NOW())
       RETURNING *`,
      [req.user.id, chk.booking.id, pm.id, pm.amountCents, pm.currency, reason || null]
    );

    res.status(201).json({ request: rows[0] });
  } catch (e) {
    console.error("refund request error:", e);
    res.status(500).json({ error: "Unable to submit refund request" });
  }
});



export default router;
