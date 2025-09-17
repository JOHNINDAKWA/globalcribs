// src/routes/admin.refunds.js
import { Router } from "express";
import { z } from "zod";
import { authRequired } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { query } from "../db.js";

const router = Router();

/* ---------- helpers ---------- */
async function loadPayment(paymentId) {
  const { rows } = await query(
    `SELECT sp.*, b."studentId" AS "bookingStudentId", b."listingId"
       FROM "StudentPayment" sp
       LEFT JOIN "Booking" b ON b.id = sp."bookingId"
      WHERE sp.id = $1`,
    [paymentId]
  );
  return rows[0] || null;
}

/* ---------- create a refund request (admin-initiated) ---------- */
// POST /api/admin/refunds
const CreateBody = z.object({
  paymentId: z.string(),
  amountCents: z.number().int().positive().optional(), // default = full amount
  reason: z.string().max(1000).optional(),
});
router.post("/", authRequired, requireRole("ADMIN", "SUPERADMIN"), async (req, res) => {
  const parsed = CreateBody.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const pm = await loadPayment(parsed.data.paymentId);
  if (!pm) return res.status(404).json({ error: "Payment not found" });
  if (pm.status !== "succeeded") return res.status(400).json({ error: "Only successful payments can be refunded" });

  // block duplicates (pending/refunded)
  const dupe = await query(
    `SELECT 1 FROM "RefundRequest" WHERE "paymentId" = $1 AND status IN ('PENDING','REFUNDED') LIMIT 1`,
    [pm.id]
  );
  if (dupe.rows[0]) return res.status(400).json({ error: "Refund already requested or processed" });

  const amt = parsed.data.amountCents ?? pm.amountCents;

  const { rows } = await query(
    `INSERT INTO "RefundRequest"
       (id,"userId","bookingId","paymentId","amountCents",currency,reason,status,"createdAt","updatedAt")
     VALUES (gen_random_uuid()::text,$1,$2,$3,$4,$5,$6,'PENDING',NOW(),NOW())
     RETURNING *`,
    [pm.userId, pm.bookingId, pm.id, amt, pm.currency, parsed.data.reason ?? null]
  );

  res.status(201).json({ request: rows[0] });
});

/* ---------- approve/decline (mark only; refund is done in Stripe dashboard) ---------- */
// PATCH /api/admin/refunds/:id
const PatchBody = z.object({
  status: z.enum(["REFUNDED", "DECLINED"]),
  processedAmountCents: z.number().int().positive().optional(),
  processedNote: z.string().max(1000).optional(),
  externalRef: z.string().max(200).optional(), // optional Stripe refund id / bank ref
});
router.patch("/:id", authRequired, requireRole("ADMIN", "SUPERADMIN"), async (req, res) => {
  const parsed = PatchBody.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { rows } = await query(
    `SELECT * FROM "RefundRequest" WHERE id = $1`,
    [req.params.id]
  );
  const r = rows[0];
  if (!r) return res.status(404).json({ error: "Refund request not found" });
  if (r.status !== "PENDING") return res.status(400).json({ error: "Only pending requests can be updated" });

  const sets = [`status = $1`, `"updatedAt" = NOW()`];
  const vals = [parsed.data.status];
  let i = 2;

  if (parsed.data.status === "REFUNDED") {
    sets.push(`"processedAt" = NOW()`);
    sets.push(`"processedBy" = $${i++}`); vals.push(req.user.id);
    if (parsed.data.processedAmountCents) {
      sets.push(`"processedAmountCents" = $${i++}`); vals.push(parsed.data.processedAmountCents);
    }
    if (parsed.data.externalRef) {
      sets.push(`"externalRef" = $${i++}`); vals.push(parsed.data.externalRef);
    }
  }
  if (parsed.data.processedNote) {
    sets.push(`"processedNote" = $${i++}`); vals.push(parsed.data.processedNote);
  }

  const upd = await query(
    `UPDATE "RefundRequest" SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
    [...vals, req.params.id]
  );

  res.json({ request: upd.rows[0] });
});

export default router;
