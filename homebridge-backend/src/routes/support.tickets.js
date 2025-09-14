// src/routes/support.tickets.js
import { Router } from "express";
import { z } from "zod";
import { query } from "../db.js";
import { sendSupportReceiptEmail } from "../lib/mailer.js";

const router = Router();

const CreateSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email(),
  topic: z.string().max(120).optional().nullable(),
  subject: z.string().min(1).max(180),
  message: z.string().min(1),
  listingUrl: z.string().url().max(1000).optional().nullable(),
});

const uiStatus = (db) =>
  ({ OPEN: "open", IN_PROGRESS: "in progress", URGENT: "urgent", CLOSED: "closed" }[db] || "open");

function presentTicket(r) {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    topic: r.topic,
    subject: r.subject,
    message: r.message,
    listingUrl: r.listingUrl,
    status: uiStatus(r.status),
 createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
 updatedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : null,
 lastReplyAt: r.lastReplyAt ? new Date(r.lastReplyAt).toISOString() : null,
  };
}

/** POST /api/support/tickets */
router.post("/tickets", async (req, res) => {
  const parsed = CreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const b = parsed.data;

  const { rows } = await query(
    `INSERT INTO "SupportTicket"
       (id, name, email, topic, subject, message, "listingUrl", status, source, "createdAt","updatedAt")
     VALUES (gen_random_uuid()::text, $1,$2,$3,$4,$5,$6,'OPEN','WEB', now(), now())
     RETURNING *`,
    [b.name, b.email.toLowerCase(), b.topic || null, b.subject, b.message, b.listingUrl || null]
  );
  const ticket = rows[0];

  // Fire and forget – but don't crash the request if email bounces.
  sendSupportReceiptEmail({
    to: ticket.email,
    ticketId: ticket.id,
    subject: ticket.subject,
  }).catch(() => {});

  res.json({ ticket: presentTicket(ticket) });
});

export default router;
