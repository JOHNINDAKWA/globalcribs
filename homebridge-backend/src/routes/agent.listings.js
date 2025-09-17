import { Router } from "express";
import { query, tx } from "../db.js";
import { authRequired } from "../middleware/auth.js";
import { requireOnboardingUnlocked } from "../middleware/requireOnboardingUnlocked.js";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import multer from "multer";
import sharp from "sharp";

const router = Router();

const API_PUBLIC_URL = (process.env.API_PUBLIC_URL || "http://localhost:4000").replace(/\/$/, "");
const UPLOAD_ROOT = path.resolve(path.join(process.cwd(), "uploads", "listings"));

// ---------- pretty refs ----------
function shortFromUUID(id = "") {
  const s = String(id).replace(/-/g, "").toUpperCase();
  if (s.length < 12) return s || "XXXX";
  return `${s.slice(0,4)}-${s.slice(4,8)}-${s.slice(-4)}`;
}
function presentListing(l) {
  if (!l) return l;
  const ref = `LS-${shortFromUUID(l.id)}`;
  return { ...l, ref };
}
function publicUrlFor(filename) {
  return `${API_PUBLIC_URL}/uploads/listings/${filename}`;
}

// ---------- multer setup ----------
const MAX_IMAGES_PER_LISTING = 12;
const MAX_FILES_PER_UPLOAD = 5;
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_ROOT),
  filename: (_req, file, cb) => {
    const safeExt = (file.originalname.split(".").pop() || "jpg").toLowerCase();
    cb(null, `${Date.now()}_${Math.random().toString(36).slice(2)}.${safeExt}`);
  }
});
const fileFilter = (_req, file, cb) => {
  const ok = ["image/jpeg", "image/png", "image/webp", "image/avif"].includes(file.mimetype);
  cb(ok ? null : new Error("Unsupported file type"), ok);
};
const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE_BYTES, files: MAX_FILES_PER_UPLOAD }
});

// ---------- zod bodies ----------
const UnitSchema = z.object({
  id: z.string().optional(),
  label: z.string().optional().nullable(),
  type: z.string().optional().nullable(),
  price: z.number().int().optional().nullable(),
  availableFrom: z.string().optional().nullable(),
  leaseMonths: z.number().int().optional().nullable(),
  size: z.string().optional().nullable(),
  availableCount: z.number().int().optional().nullable(),
});

const BaseListingSchema = z.object({
  title: z.string().min(1),
  type: z.string().min(1),
  city: z.string().min(1),
  university: z.string().optional().nullable(),
  price: z.number().int().nonnegative(),

  description: z.string().min(1),
  highlights: z.array(z.string()).max(20).optional().default([]),
  amenities: z.array(z.string()).max(50).optional().default([]),
  policies: z.array(z.string()).max(50).optional().default([]),
  notes: z.string().optional().nullable(),

  address: z.string().optional().nullable(),
  latitude: z.string().optional().nullable(),
  longitude: z.string().optional().nullable(),
  transitMins: z.string().optional().nullable(),

  furnished: z.boolean().optional().default(false),
  verified: z.boolean().optional().default(false),

  coverImageId: z.string().optional().nullable(),
  units: z.array(UnitSchema).optional().default([]),
});
const CreateListingBody = BaseListingSchema;
const UpdateListingBody = BaseListingSchema.partial();

// ---------- helpers ----------
function ensureAgent(req, res) {
  const role = String(req.user.role || "").toUpperCase();
  if (role !== "AGENT" && role !== "SUPERADMIN") {
    res.status(403).json({ error: "Agent access only" });
    return false;
  }
  return true;
}

async function mustOwnListing(id, userId) {
  const { rows } = await query(
    `SELECT id, "agentId" FROM "Listing" WHERE id = $1`,
    [id]
  );
  const l = rows[0];
  if (!l) return { ok: false, status: 404, error: "Listing not found" };
  if (l.agentId !== userId) return { ok: false, status: 403, error: "Forbidden" };
  return { ok: true, listing: l };
}

// ---------- CRUD ----------

// GET my listings (with simple pagination)
router.get("/", authRequired, async (req, res) => {
  if (!ensureAgent(req, res)) return;
  const take = Math.min(Number(req.query.take || 50), 100);
  const skip = Math.max(Number(req.query.skip || 0), 0);

  const [itemsRes, countRes] = await Promise.all([
    query(
      `SELECT *
       FROM "Listing"
       WHERE "agentId" = $1
       ORDER BY "createdAt" DESC
       LIMIT $2 OFFSET $3`,
      [req.user.id, take, skip]
    ),
    query(`SELECT COUNT(*)::int AS c FROM "Listing" WHERE "agentId" = $1`, [req.user.id]),
  ]);

  const ids = itemsRes.rows.map(r => r.id);
  let imagesByListing = {};
  let unitsByListing = {};
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

    const units = await query(
      `SELECT *
       FROM "ListingUnit"
       WHERE "listingId" = ANY($1)
       ORDER BY "id" ASC`,
      [ids]
    );
    units.rows.forEach(u => {
      (unitsByListing[u.listingId] ||= []).push(u);
    });
  }

  const items = itemsRes.rows.map(r => presentListing({
    ...r,
    images: imagesByListing[r.id] || [],
    units: unitsByListing[r.id] || [],
  }));

  res.json({ items, total: countRes.rows[0].c, take, skip });
});

// GET one (must own)
router.get("/:id", authRequired, async (req, res) => {
  if (!ensureAgent(req, res)) return;
  const chk = await mustOwnListing(req.params.id, req.user.id);
  if (!chk.ok) return res.status(chk.status).json({ error: chk.error });

  const [lRes, imgRes, unitRes] = await Promise.all([
    query(`SELECT * FROM "Listing" WHERE id = $1`, [req.params.id]),
    query(
      `SELECT id, url, "order", path, size, width, height
       FROM "ListingImage" WHERE "listingId" = $1 ORDER BY "order" ASC`,
      [req.params.id]
    ),
    query(`SELECT * FROM "ListingUnit" WHERE "listingId" = $1`, [req.params.id]),
  ]);

  const item = lRes.rows[0];
  item.images = imgRes.rows;
  item.units = unitRes.rows;
  res.json({ item: presentListing(item) });
});

// CREATE
router.post("/", authRequired, requireOnboardingUnlocked, async (req, res) => {
  if (!ensureAgent(req, res)) return;
  const parsed = CreateListingBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const d = parsed.data;

  const created = await tx(async (c) => {
    const ins = await c.query(
      `INSERT INTO "Listing" (
        id, "agentId", title, type, city, university, price,
        description, highlights, amenities, policies, notes,
        address, latitude, longitude, "transitMins",
        furnished, verified, published, featured, "needsReview", "reportsCount",
        "createdAt", "updatedAt"
      ) VALUES (
        gen_random_uuid()::text, $1, $2, $3, $4, $5, $6,
        $7, $8::text[], $9::text[], $10::text[], $11,
        $12, $13, $14, $15,
        $16, false, true, false, false, 0,
        NOW(), NOW()
      )
      RETURNING *`,
      [
        req.user.id,
        d.title, d.type, d.city, d.university ?? null, d.price,
        d.description, d.highlights || [], d.amenities || [], d.policies || [], d.notes ?? null,
        d.address ?? null, d.latitude ?? null, d.longitude ?? null, d.transitMins ?? null,
        !!d.furnished,
      ]
    );
    const listing = ins.rows[0];

    // units (optional)
    if (Array.isArray(d.units) && d.units.length) {
      const promises = d.units.map(u =>
        c.query(
          `INSERT INTO "ListingUnit" (
            id, "listingId", label, type, price, "availableFrom",
            "leaseMonths", size, "availableCount"
          ) VALUES (
            gen_random_uuid()::text, $1, $2, $3, $4, $5,
            $6, $7, $8
          )`,
          [
            listing.id,
            u.label ?? null, u.type ?? null, u.price ?? null, u.availableFrom ?? null,
            u.leaseMonths ?? null, u.size ?? null, u.availableCount ?? 0
          ]
        )
      );
      await Promise.all(promises);
    }

    return listing;
  });

  // hydrate images + units for response
  const [imgs, units] = await Promise.all([
    query(`SELECT id, url, "order" FROM "ListingImage" WHERE "listingId" = $1 ORDER BY "order" ASC`, [created.id]),
    query(`SELECT * FROM "ListingUnit" WHERE "listingId" = $1`, [created.id]),
  ]);
  created.images = imgs.rows;
  created.units = units.rows;

  res.status(201).json({ item: presentListing(created) });
});

// UPDATE (must own)
router.put("/:id", authRequired, requireOnboardingUnlocked, async (req, res) => {
  if (!ensureAgent(req, res)) return;
  const parsed = UpdateListingBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const listingId = req.params.id;
  const chk = await mustOwnListing(listingId, req.user.id);
  if (!chk.ok) return res.status(chk.status).json({ error: chk.error });

  const d = parsed.data;

  // Verify coverImageId if being set
  let coverImageIdUpdate = undefined;
  if ("coverImageId" in d) {
    if (d.coverImageId == null) {
      coverImageIdUpdate = null;
    } else {
      const { rows: imgs } = await query(
        `SELECT id, "listingId" FROM "ListingImage" WHERE id = $1`,
        [d.coverImageId]
      );
      const img = imgs[0];
      if (!img || img.listingId !== listingId) {
        return res.status(400).json({ error: "coverImageId does not belong to this listing" });
      }
      coverImageIdUpdate = img.id;
    }
  }

  const updated = await tx(async (c) => {
    // Replace units (MVP)
    await c.query(`DELETE FROM "ListingUnit" WHERE "listingId" = $1`, [listingId]);
    if (Array.isArray(d.units)) {
      const promises = d.units.map(u =>
        c.query(
          `INSERT INTO "ListingUnit" (
            id, "listingId", label, type, price, "availableFrom",
            "leaseMonths", size, "availableCount"
          ) VALUES (
            gen_random_uuid()::text, $1, $2, $3, $4, $5,
            $6, $7, $8
          )`,
          [
            listingId,
            u.label ?? null, u.type ?? null, u.price ?? null, u.availableFrom ?? null,
            u.leaseMonths ?? null, u.size ?? null, u.availableCount ?? 0
          ]
        )
      );
      await Promise.all(promises);
    }

    // Build dynamic UPDATE set
    const fields = [];
    const vals = [];
    let p = 1;

    const set = (col, val, rawArray = false) => {
      if (val === undefined) return;
      if (rawArray) {
        fields.push(`"${col}" = $${p}::text[]`);
      } else {
        fields.push(`"${col}" = $${p}`);
      }
      vals.push(val);
      p++;
    };

    set("title", d.title);
    set("type", d.type);
    set("city", d.city);
    set("university", d.university ?? null);
    set("price", d.price);
    set("description", d.description);
    set("highlights", d.highlights ?? undefined, true);
    set("amenities", d.amenities ?? undefined, true);
    set("policies", d.policies ?? undefined, true);
    set("notes", d.notes ?? null);
    set("address", d.address ?? null);
    set("latitude", d.latitude ?? null);
    set("longitude", d.longitude ?? null);
    set("transitMins", d.transitMins ?? null);
    set("furnished", d.furnished);
    if ("coverImageId" in d) {
      set("coverImageId", coverImageIdUpdate);
    }
    fields.push(`"updatedAt" = NOW()`);

    const sql = `UPDATE "Listing" SET ${fields.join(", ")} WHERE id = $${p} RETURNING *`;
    vals.push(listingId);
    const up = await c.query(sql, vals);
    return up.rows[0];
  });

  // hydrate sub-objects
  const [imgs, units] = await Promise.all([
    query(`SELECT id, url, "order" FROM "ListingImage" WHERE "listingId" = $1 ORDER BY "order" ASC`, [listingId]),
    query(`SELECT * FROM "ListingUnit" WHERE "listingId" = $1`, [listingId]),
  ]);
  updated.images = imgs.rows;
  updated.units = units.rows;

  res.json({ item: presentListing(updated) });
});

// DELETE (must own) + delete files
router.delete("/:id", authRequired, requireOnboardingUnlocked, async (req, res) => {
  if (!ensureAgent(req, res)) return;
  const listingId = req.params.id;
  const chk = await mustOwnListing(listingId, req.user.id);
  if (!chk.ok) return res.status(chk.status).json({ error: chk.error });

  const imgs = await query(`SELECT path FROM "ListingImage" WHERE "listingId" = $1`, [listingId]);
  await tx(async (c) => {
    await c.query(`DELETE FROM "ListingImage" WHERE "listingId" = $1`, [listingId]);
    await c.query(`DELETE FROM "ListingUnit" WHERE "listingId" = $1`, [listingId]);
    await c.query(`DELETE FROM "Listing" WHERE id = $1`, [listingId]);
  });

  await Promise.allSettled(imgs.rows.map(i => fs.unlink(i.path).catch(() => {})));
  res.status(204).end();
});

// ---------- image management ----------

// upload images

// upload images  (NOTE: put the unlock check BEFORE multer)
router.post("/:id/images",
  authRequired,
  requireOnboardingUnlocked,
  upload.array("images", MAX_FILES_PER_UPLOAD),
  async (req, res) => {

  if (!ensureAgent(req, res)) return;

  const listingId = req.params.id;
  const chk = await mustOwnListing(listingId, req.user.id);
  if (!chk.ok) {
    await Promise.allSettled(req.files.map(f => fs.unlink(f.path)));
    return res.status(chk.status).json({ error: chk.error });
  }

  const countRes = await query(`SELECT COUNT(*)::int AS c FROM "ListingImage" WHERE "listingId" = $1`, [listingId]);
  const count = countRes.rows[0].c;
  if (count >= MAX_IMAGES_PER_LISTING) {
    await Promise.allSettled(req.files.map(f => fs.unlink(f.path)));
    return res.status(400).json({ error: `You already have ${count} images. Limit is ${MAX_IMAGES_PER_LISTING}.` });
  }

  const roomLeft = MAX_IMAGES_PER_LISTING - count;
  const files = req.files.slice(0, roomLeft);

  const metas = await Promise.all(files.map(async f => {
    let width, height;
    try {
      const m = await sharp(f.path).metadata();
      width = m.width; height = m.height;
    } catch {}
    return { f, width, height };
  }));

  const maxOrderRes = await query(
    `SELECT COALESCE(MAX("order"), -1) AS m FROM "ListingImage" WHERE "listingId" = $1`,
    [listingId]
  );
  let orderStart = (maxOrderRes.rows[0].m ?? -1) + 1;

  const created = await tx(async (c) => {
    const inserted = [];
    for (const { f, width, height } of metas) {
      const ins = await c.query(
        `INSERT INTO "ListingImage"
          (id, "listingId", url, path, size, width, height, "order", "createdAt")
         VALUES
          (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, NOW())
         RETURNING *`,
        [
          listingId,
          publicUrlFor(path.basename(f.path)),
          f.path,
          f.size,
          width ?? null,
          height ?? null,
          orderStart++
        ]
      );
      inserted.push(ins.rows[0]);
    }
    return inserted;
  });

  // set default cover if missing
  const curr = await query(`SELECT "coverImageId" FROM "Listing" WHERE id = $1`, [listingId]);
  if (!curr.rows[0]?.coverImageId && created[0]) {
    await query(`UPDATE "Listing" SET "coverImageId" = $1, "updatedAt" = NOW() WHERE id = $2`,
      [created[0].id, listingId]
    );
  }

  res.status(201).json({ images: created });
});

// set cover
// set cover
router.patch("/:id/cover/:imageId", authRequired, requireOnboardingUnlocked, async (req, res) => {

  if (!ensureAgent(req, res)) return;

  const listingId = req.params.id;
  const chk = await mustOwnListing(listingId, req.user.id);
  if (!chk.ok) return res.status(chk.status).json({ error: chk.error });

  const { rows } = await query(`SELECT id, "listingId" FROM "ListingImage" WHERE id = $1`, [req.params.imageId]);
  const img = rows[0];
  if (!img || img.listingId !== listingId) return res.status(404).json({ error: "Image not found" });

  const up = await query(
    `UPDATE "Listing" SET "coverImageId" = $1, "updatedAt" = NOW() WHERE id = $2 RETURNING id, "coverImageId"`,
    [img.id, listingId]
  );
  const l = up.rows[0];
  res.json({ listing: { ...l, ref: `LS-${shortFromUUID(l.id)}` } });
});


// delete image
router.delete("/:id/images/:imageId", authRequired, requireOnboardingUnlocked, async (req, res) => {

  if (!ensureAgent(req, res)) return;

  const listingId = req.params.id;
  const chk = await mustOwnListing(listingId, req.user.id);
  if (!chk.ok) return res.status(chk.status).json({ error: chk.error });

  const { rows } = await query(`SELECT * FROM "ListingImage" WHERE id = $1`, [req.params.imageId]);
  const img = rows[0];
  if (!img || img.listingId !== listingId) return res.status(404).json({ error: "Image not found" });

  await tx(async (c) => {
    await c.query(`DELETE FROM "ListingImage" WHERE id = $1`, [img.id]);

    const cover = await c.query(`SELECT "coverImageId" FROM "Listing" WHERE id = $1`, [listingId]);
    if (cover.rows[0]?.coverImageId === img.id) {
      const next = await c.query(
        `SELECT id FROM "ListingImage" WHERE "listingId" = $1 ORDER BY "order" ASC LIMIT 1`,
        [listingId]
      );
      await c.query(
        `UPDATE "Listing" SET "coverImageId" = $1, "updatedAt" = NOW() WHERE id = $2`,
        [next.rows[0]?.id ?? null, listingId]
      );
    }
  });

  await fs.unlink(img.path).catch(() => {});
  res.status(204).end();
});

export default router;
