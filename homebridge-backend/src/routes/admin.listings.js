import { Router } from "express";
import { authRequired } from "../middleware/auth.js";
import { z } from "zod";
import { query, tx } from "../db.js";

const router = Router();

/* ---------------- helpers ---------------- */

function ensureAdmin(req, res) {
  const r = String(req.user?.role || "").toUpperCase();
  if (!req.user?.id) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  if (!["ADMIN", "SUPERADMIN"].includes(r)) {
    res.status(403).json({ error: "Admin only" });
    return false;
  }
  return true;
}

function shortFromUUID(id = "") {
  const s = String(id).replace(/-/g, "").toUpperCase();
  if (s.length < 12) return s || "XXXX";
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(-4)}`;
}
function presentListing(l) {
  if (!l) return l;
  const ref = `LS-${shortFromUUID(l.id)}`;
  return { ...l, ref };
}

const PatchBody = z.object({
  published: z.boolean().optional(),
  featured: z.boolean().optional(),
  needsReview: z.boolean().optional(),
  note: z.string().max(2000).optional().nullable(), // maps to Listing.notes
});

/* ---------------- LIST ---------------- */
/**
 * GET /api/admin/listings?take&skip&q&status&flag&sort
 * status: "published" | "unpublished" | "needs-review"
 * flag:   "featured" | "flagged"
 * sort:   "newest" | "oldest" | "price-high" | "price-low" | "reports"
 */
router.get("/", authRequired, async (req, res) => {
  if (!ensureAdmin(req, res)) return;

  const take = Math.min(parseInt(req.query.take || "30", 10), 100);
  const skip = Math.max(parseInt(req.query.skip || "0", 10), 0);
  const q = String(req.query.q || "").trim();
  const status = String(req.query.status || "").toLowerCase();
  const flag = String(req.query.flag || "").toLowerCase();
  const sort = String(req.query.sort || "newest").toLowerCase();

  // WHERE builder
  const where = [];
  const params = [];
  let p = 1;

  if (status === "published") where.push(`l.published = TRUE`);
  else if (status === "unpublished") where.push(`l.published = FALSE`);
  else if (status === "needs-review") where.push(`l."needsReview" = TRUE`);

  if (flag === "featured") where.push(`l.featured = TRUE`);
  else if (flag === "flagged") where.push(`l."reportsCount" > 0`);

  if (q) {
    params.push(`%${q}%`);
    const qp = `$${p++}`;
    where.push(`(
      l.title ILIKE ${qp} OR l.city ILIKE ${qp} OR l.type ILIKE ${qp}
      OR u.name ILIKE ${qp} OR u.email ILIKE ${qp}
      OR ap."orgName" ILIKE ${qp}
    )`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  // ORDER BY
  let orderSql = `ORDER BY l."createdAt" DESC`;
  if (sort === "oldest") orderSql = `ORDER BY l."createdAt" ASC`;
  else if (sort === "price-high") orderSql = `ORDER BY l.price DESC, l."createdAt" DESC`;
  else if (sort === "price-low") orderSql = `ORDER BY l.price ASC, l."createdAt" DESC`;
  else if (sort === "reports") orderSql = `ORDER BY l."reportsCount" DESC, l."createdAt" DESC`;

  // total
  const countRes = await query(
    `SELECT COUNT(*)::int AS c
     FROM "Listing" l
     LEFT JOIN "User" u ON u.id = l."agentId"
     LEFT JOIN "AgentProfile" ap ON ap."userId" = u.id
     ${whereSql}`,
    params
  );
  const total = countRes.rows[0]?.c || 0;

  // items (with first image + agent)
  params.push(take, skip);
  const listRes = await query(
    `
    SELECT
      l.*,
      -- first image (id,url)
      (
        SELECT jsonb_build_object('id', li.id, 'url', li.url)
        FROM "ListingImage" li
        WHERE li."listingId" = l.id
        ORDER BY li."order" ASC
        LIMIT 1
      ) AS first_image,
      -- agent
      u.id      AS "agentId",
      u.name    AS "agentName",
      u.email   AS "agentEmail",
      ap."orgName"      AS "agentOrgName",
      ap."supportEmail" AS "agentSupportEmail"
    FROM "Listing" l
    LEFT JOIN "User" u ON u.id = l."agentId"
    LEFT JOIN "AgentProfile" ap ON ap."userId" = u.id
    ${whereSql}
    ${orderSql}
    LIMIT $${p++} OFFSET $${p++}
    `,
    params
  );

  const items = listRes.rows.map((r) => {
    const {
      first_image,
      agentId,
      agentName,
      agentEmail,
      agentOrgName,
      agentSupportEmail,
      ...l
    } = r;
    const images = first_image ? [{ id: first_image.id, url: first_image.url }] : [];
    const agent = agentId
      ? {
          id: agentId,
          name: agentName,
          email: agentEmail,
          orgName: agentOrgName || null,
          supportEmail: agentSupportEmail || null,
        }
      : null;
    return presentListing({ ...l, images });
  });

  // shape like before (flat agent block)
  const shaped = listRes.rows.map((r, i) => ({
    ...items[i],
    agent: r.agentId
      ? {
          id: r.agentId,
          name: r.agentName,
          email: r.agentEmail,
          orgName: r.agentOrgName || null,
          supportEmail: r.agentSupportEmail || null,
        }
      : null,
  }));

  res.json({ items: shaped, total, take, skip });
});



/* ---------------- DETAIL ---------------- */
router.get("/:id", authRequired, async (req, res) => {
  if (!ensureAdmin(req, res)) return;

  const id = req.params.id;

  // listing + agent + updatedBy
  const base = await query(
    `
    SELECT
      l.*,
      u.id    AS "agentId",
      u.name  AS "agentName",
      u.email AS "agentEmail",
      ap."orgName", ap.phone, ap.city, ap.website, ap."supportEmail",
      ub.id   AS "updatedById",
      ub.name AS "updatedByName",
      ub.email AS "updatedByEmail"
    FROM "Listing" l
    LEFT JOIN "User" u ON u.id = l."agentId"
    LEFT JOIN "AgentProfile" ap ON ap."userId" = u.id
    LEFT JOIN "User" ub ON ub.id = l."updatedById"
    WHERE l.id = $1
    `,
    [id]
  );


  const row = base.rows[0];
row.createdAt = row.createdAt?.toISOString?.() || null;
row.updatedAt = row.updatedAt?.toISOString?.() || null;



  if (!row) return res.status(404).json({ error: "Not found" });

  const [imagesRes, unitsRes, reportsRes] = await Promise.all([
    query(
      `SELECT id, url, "order"
       FROM "ListingImage"
       WHERE "listingId" = $1
       ORDER BY "order" ASC`,
      [id]
    ),
    query(
      `SELECT *
       FROM "ListingUnit"
       WHERE "listingId" = $1`,
      [id]
    ),
    query(
      `SELECT *
       FROM "ListingReport"
       WHERE "listingId" = $1
       ORDER BY "createdAt" DESC
       LIMIT 50`,
      [id]
    ),
  ]);

  const agent = row.agentId
    ? {
        id: row.agentId,
        name: row.agentName,
        email: row.agentEmail,
        orgName: row.orgName || null,
        phone: row.phone || null,
        city: row.city || null,
        website: row.website || null,
        supportEmail: row.supportEmail || null,
      }
    : null;

  const updatedBy = row.updatedById
    ? { id: row.updatedById, name: row.updatedByName, email: row.updatedByEmail }
    : null;

  // Strip helper-only fields
  const {
    agentName,
    agentEmail,
    orgName,
    phone,
    city,
    website,
    supportEmail,
    updatedById,
    updatedByName,
    updatedByEmail,
    ...listingCore
  } = row;

  const item = presentListing({
    ...listingCore,
    images: imagesRes.rows,
    units: unitsRes.rows,
    updatedBy,
  });

  res.json({
    item: {
      ...item,
      agent,
      reports: reportsRes.rows,
    },
  });
});


/* ---------------- PATCH ---------------- */
router.patch("/:id", authRequired, async (req, res) => {
  if (!ensureAdmin(req, res)) return;

  const parsed = PatchBody.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { published, featured, needsReview, note } = parsed.data;

  const fields = [`"updatedById" = $1`];
  const vals = [req.user.id];
  let p = 2;

  if (typeof published === "boolean") { fields.push(`published = $${p++}`); vals.push(published); }
  if (typeof featured === "boolean")  { fields.push(`featured = $${p++}`);  vals.push(featured); }
  if (typeof needsReview === "boolean"){ fields.push(`"needsReview" = $${p++}`); vals.push(needsReview); }
  if (typeof note === "string")       { fields.push(`notes = $${p++}`);     vals.push(note); }

  vals.push(req.params.id);

  try {
    // Update
    const upRes = await tx(async (c) => {
      const { rows } = await c.query(
        `UPDATE "Listing" SET ${fields.join(", ")}, "updatedAt" = NOW()
         WHERE id = $${p}
         RETURNING *`,
        vals
      );
      const up = rows[0];
      if (!up) return null;

      const [firstImage, agentRes, updatedByRes] = await Promise.all([
        c.query(
          `SELECT id, url FROM "ListingImage"
           WHERE "listingId" = $1 ORDER BY "order" ASC LIMIT 1`,
          [up.id]
        ),
        c.query(
          `SELECT u.id, u.name, u.email, ap."orgName", ap."supportEmail"
           FROM "User" u
           LEFT JOIN "AgentProfile" ap ON ap."userId" = u.id
           WHERE u.id = $1`,
          [up.agentId]
        ),
        c.query(`SELECT id, name, email FROM "User" WHERE id = $1`, [up.updatedById]),
      ]);

      return {
        up,
        firstImage: firstImage.rows[0] || null,
        agent: agentRes.rows[0] || null,
        updatedBy: updatedByRes.rows[0] || null,
      };
    });

    if (!upRes) return res.status(404).json({ error: "Not found" });

    const { up, firstImage, agent, updatedBy } = upRes;
    const shaped = {
      ...presentListing({
        ...up,
        images: firstImage ? [{ id: firstImage.id, url: firstImage.url }] : [],
        updatedBy,
      }),
      agent: agent
        ? {
            id: agent.id,
            name: agent.name,
            email: agent.email,
            orgName: agent.orgName || null,
            supportEmail: agent.supportEmail || null,
          }
        : null,
    };

    res.json({ item: shaped });
  } catch (e) {
    // Prisma's P2025 equivalent in pg-land is just "no rows updated"
    console.error("PATCH /api/admin/listings/:id error:", e);
    res.status(400).json({ error: "Bad Request" });
  }
});

export default router;
