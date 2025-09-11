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
        b."feePaidAt"::text AS "feePaidAt",
        b."submittedAt"::text AS "submittedAt",
        b."createdAt"::text AS "createdAt",
        b."docsUpdatedAt"::text AS "docsUpdatedAt",
        b."docIds",
        l.id AS "l_id", l.title AS "l_title", l.city AS "l_city", l."coverImageId" AS "l_cover",
        u.id AS "u_id", u.name AS "u_name", u.email AS "u_email"
      FROM "Booking" b
      JOIN "Listing" l ON l.id = b."listingId"
      JOIN "User" u ON u.id = b."studentId"
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
      docsUpdatedAt: b.docsUpdatedAt
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

export default router;