import { Router } from "express";
import path from "path";
import fs from "fs/promises";
import multer from "multer";
import { z } from "zod";
import { authRequired } from "../middleware/auth.js";
import { query } from "../db.js";

const router = Router();

const API_PUBLIC_URL = (process.env.API_PUBLIC_URL || "http://localhost:4000").replace(/\/$/, "");
const UPLOAD_ROOT = path.resolve(path.join(process.cwd(), "uploads", "org"));
await fs.mkdir(UPLOAD_ROOT, { recursive: true }).catch(() => {});

function ensureAdmin(req, res) {
  const role = String(req.user?.role || "").toUpperCase();
  if (role !== "ADMIN" && role !== "SUPERADMIN") {
    res.status(403).json({ error: "Admin access only" });
    return false;
  }
  return true;
}

const DEFAULTS = {
  org: { name: "HomeBridge", logo: "", supportEmail: "support@homebridge.test", supportPhone: "+1 (555) 010-2323", website: "https://homebridge.test", timezone: "UTC" },
  security: { twoFactorRequired: false, sessionTimeoutMins: 60, allowIpRanges: "" },
  fees: { currency: "USD", applicationFeeCents: 2500, escrowEnabled: true, escrowReleaseDays: 2 },
  kyc: { passport: true, admission: true, financial: true, i20: false, visa: false },
  notifications: { newBookingEmail: true, newBookingSMS: false, statusChangeEmail: true, statusChangeSMS: false },
};

const SettingsSchema = z.object({
  org: z.object({
    name: z.string().min(1),
    logo: z.string().url().or(z.literal("")).optional().default(""),
    supportEmail: z.string().email(),
    supportPhone: z.string().min(1),
    website: z.string().url(),
    timezone: z.string().min(1),
  }),
  security: z.object({
    twoFactorRequired: z.boolean(),
    sessionTimeoutMins: z.number().int().min(10).max(480),
    allowIpRanges: z.string().optional().default(""),
  }),
  fees: z.object({
    currency: z.enum(["USD", "KES", "EUR", "GBP"]),
    applicationFeeCents: z.number().int().min(0),
    escrowEnabled: z.boolean(),
    escrowReleaseDays: z.number().int().min(0).max(30),
  }),
  kyc: z.object({
    passport: z.boolean(),
    admission: z.boolean(),
    financial: z.boolean(),
    i20: z.boolean(),
    visa: z.boolean(),
  }),
  notifications: z.object({
    newBookingEmail: z.boolean(),
    newBookingSMS: z.boolean(),
    statusChangeEmail: z.boolean(),
    statusChangeSMS: z.boolean(),
  }),
});

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const k of Object.keys(patch || {})) {
    const v = patch[k];
    if (v && typeof v === "object" && !Array.isArray(v) && base?.[k] && typeof base[k] === "object" && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

async function getConfig() {
  const row = await query(`SELECT data FROM "AppSetting" WHERE id = 'GLOBAL'`);
  const data = row.rows[0]?.data ?? {};
  return deepMerge(DEFAULTS, data || {});
}

// GET
router.get("/", authRequired, async (req, res) => {
  if (!ensureAdmin(req, res)) return;
  const cfg = await getConfig();
  res.json({ settings: cfg });
});

// PATCH
router.patch("/", authRequired, async (req, res) => {
  if (!ensureAdmin(req, res)) return;

  const current = await getConfig();
  const merged = deepMerge(current, req.body || {});
  const parsed = SettingsSchema.safeParse(merged);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const saved = await query(
    `
    INSERT INTO "AppSetting"(id, data, "updatedById", "updatedAt")
    VALUES ('GLOBAL', $1::jsonb, $2, NOW())
    ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, "updatedById" = EXCLUDED."updatedById", "updatedAt" = NOW()
    RETURNING data
    `,
    [parsed.data, req.user.id]
  );

  res.json({ settings: saved.rows[0].data });
});

// Logo upload
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_ROOT),
  filename: (_req, file, cb) => {
    const ext = (file.originalname.split(".").pop() || "png").toLowerCase();
    cb(null, `logo_${Date.now()}.${ext}`);
  },
});
const fileFilter = (_req, file, cb) => {
  const ok = ["image/png", "image/jpeg", "image/webp", "image/avif", "image/svg+xml"].includes(file.mimetype);
  cb(ok ? null : new Error("Unsupported file type"), ok);
};
const upload = multer({ storage, fileFilter, limits: { fileSize: 4 * 1024 * 1024, files: 1 } });

// POST /logo
router.post("/logo", authRequired, upload.single("logo"), async (req, res) => {
  if (!ensureAdmin(req, res)) {
    if (req.file?.path) await fs.unlink(req.file.path).catch(() => {});
    return;
  }
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const publicUrl = `${API_PUBLIC_URL}/uploads/org/${path.basename(req.file.path)}`;

  const current = await getConfig();
  const next = deepMerge(current, { org: { logo: publicUrl } });
  const parsed = SettingsSchema.safeParse(next);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  await query(
    `
    INSERT INTO "AppSetting"(id, data, "updatedById", "updatedAt")
    VALUES ('GLOBAL', $1::jsonb, $2, NOW())
    ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, "updatedById" = EXCLUDED."updatedById", "updatedAt" = NOW()
    `,
    [parsed.data, req.user.id]
  );

  res.status(201).json({ logoUrl: publicUrl });
});

export default router;
