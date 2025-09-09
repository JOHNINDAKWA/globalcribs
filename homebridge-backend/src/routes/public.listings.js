import { Router } from "express";
import { query } from "../db.js";

const router = Router();

// GET /api/public/listings
router.get("/", async (req, res) => {
  const take = Math.min(parseInt(req.query.take || "50", 10), 100);
  const skip = Math.max(parseInt(req.query.skip || "0", 10), 0);

  const featuredOnly = ["1", "true", "yes"].includes(
    String(req.query.featured || "").toLowerCase()
  );

  // Build ordering to prefer featured when not forced
  const orderParts = [];
  if (!featuredOnly) orderParts.push(`"featured" DESC`);
  orderParts.push(`"createdAt" DESC`);
  const orderBy = orderParts.join(", ");

  const whereClause = featuredOnly
    ? `WHERE published = TRUE AND "featured" = TRUE`
    : `WHERE published = TRUE`;

  // base listings
  const itemsRes = await query(
    `SELECT *
     FROM "Listing"
     ${whereClause}
     ORDER BY ${orderBy}
     LIMIT $1 OFFSET $2`,
    [take, skip]
  );

  const ids = itemsRes.rows.map(r => r.id);
  let imagesByListing = {};
  let unitPeekByListing = {};

  if (ids.length) {
    const imgs = await query(
      `SELECT id, "listingId", url, "order"
       FROM "ListingImage"
       WHERE "listingId" = ANY($1)
       ORDER BY "order" ASC`,
      [ids]
    );
    imgs.rows.forEach(i => {
      (imagesByListing[i.listingId] ||= []).push(i);
    });

    // one cheapest unit per listing
    const units = await query(
      `SELECT DISTINCT ON ("listingId") id, "listingId", size, price, "availableCount"
       FROM "ListingUnit"
       WHERE "listingId" = ANY($1)
       ORDER BY "listingId", price ASC NULLS LAST, id ASC`,
      [ids]
    );
    units.rows.forEach(u => {
      unitPeekByListing[u.listingId] = u;
    });
  }

  const items = itemsRes.rows.map(r => ({
    ...r,
    images: (imagesByListing[r.id] || []).map(({ id, url, order }) => ({ id, url, order })),
    units: unitPeekByListing[r.id] ? [unitPeekByListing[r.id]] : [],
  }));

  res.json({ items, take, skip });
});

// GET /api/public/listings/:id
router.get("/:id", async (req, res) => {
  const id = req.params.id;

  // listing
  const lRes = await query(`SELECT * FROM "Listing" WHERE id = $1`, [id]);
  const item = lRes.rows[0];
  if (!item) return res.status(404).json({ error: "Not found" });

  // images + units
  const [imgRes, unitRes] = await Promise.all([
    query(
      `SELECT id, url, "order"
       FROM "ListingImage"
       WHERE "listingId" = $1
       ORDER BY "order" ASC`,
      [id]
    ),
    query(`SELECT * FROM "ListingUnit" WHERE "listingId" = $1`, [id]),
  ]);

  // agent (user + agentProfile)
  const agentRes = await query(
    `SELECT u.id AS "userId", u.name AS "userName", u.email AS "userEmail",
            ap.phone, ap.city, ap."orgName", ap.website, ap."supportEmail"
     FROM "User" u
     LEFT JOIN "AgentProfile" ap ON ap."userId" = u.id
     WHERE u.id = $1`,
    [item.agentId]
  );
  const a = agentRes.rows[0];

  const agent = a
    ? {
        id: a.userId,
        name: a.userName,
        email: a.userEmail,
        phone: a.phone || null,
        city: a.city || null,
        orgName: a.orgName || null,
        website: a.website || null,
        supportEmail: a.supportEmail || null,
      }
    : null;

  res.json({
    item: {
      ...item,
      images: imgRes.rows,
      units: unitRes.rows,
      agent,
    }
  });
});

export default router;
