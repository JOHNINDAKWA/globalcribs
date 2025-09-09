// src/routes/profile.js
import { Router } from "express";
import { query } from "../db.js";
import { authRequired } from "../middleware/auth.js";
import { z } from "zod";

const router = Router();

/* -------------------- STUDENT -------------------- */

const StudentUpdateSchema = z.object({
  fullName: z.string().optional(),
  email: z.string().email().optional(),
  avatarUrl: z.string().optional(),
  dob: z.string().optional(),
  nationality: z.string().optional(),
  passportNo: z.string().optional(),

  school: z.string().optional(),
  program: z.string().optional(),
  intake: z.string().optional(),
  targetCity: z.string().optional(),

  phone: z.string().optional(),
  whatsapp: z.string().optional(),

  addressLine1: z.string().optional(),
  addressLine2: z.string().optional(),
  addressCity: z.string().optional(),
  addressCountry: z.string().optional(),
  postal: z.string().optional(),

  emergencyName: z.string().optional(),
  emergencyRelation: z.string().optional(),
  emergencyPhone: z.string().optional(),

  commsEmail: z.boolean().optional(),
  commsSMS: z.boolean().optional(),
  commsWhatsApp: z.boolean().optional(),

  kycStatus: z.enum(["NOT_STARTED", "SUBMITTED", "VERIFIED", "FAILED"]).optional(),
  paymentMethods: z.any().optional(),
});

router.get("/students/me/profile", authRequired, async (req, res) => {
  const userId = req.user.id;

  let { rows } = await query(
    `SELECT * FROM "StudentProfile" WHERE "userId" = $1`,
    [userId]
  );
  let prof = rows[0];

  if (!prof) {
    // seed with user info
    const u = await query(`SELECT name, email FROM "User" WHERE id = $1`, [userId]);
    const name = u.rows[0]?.name || "";
    const email = u.rows[0]?.email || "";

    const insert = await query(
      `INSERT INTO "StudentProfile"
        (id, "userId", "fullName", email, "createdAt", "updatedAt")
       VALUES (gen_random_uuid()::text, $1, $2, $3, NOW(), NOW())
       RETURNING *`,
      [userId, name, email]
    );
    prof = insert.rows[0];
  }

  res.json({ profile: prof });
});

router.put("/students/me/profile", authRequired, async (req, res) => {
  const userId = req.user.id;
  const parsed = StudentUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const d = parsed.data;

  // Build param list EXACTLY in the order used by the VALUES placeholders.
  const vals = [
    userId,                               // $1
    d.fullName ?? null,                   // $2
    d.email ?? null,                      // $3
    d.avatarUrl ?? null,                  // $4
    d.dob ?? null,                        // $5
    d.nationality ?? null,                // $6
    d.passportNo ?? null,                 // $7
    d.school ?? null,                     // $8
    d.program ?? null,                    // $9
    d.intake ?? null,                     // $10
    d.targetCity ?? null,                 // $11
    d.phone ?? null,                      // $12
    d.whatsapp ?? null,                   // $13
    d.addressLine1 ?? null,               // $14
    d.addressLine2 ?? null,               // $15
    d.addressCity ?? null,                // $16
    d.addressCountry ?? null,             // $17
    d.postal ?? null,                     // $18
    d.emergencyName ?? null,              // $19
    d.emergencyRelation ?? null,          // $20
    d.emergencyPhone ?? null,             // $21
    d.commsEmail ?? false,                // $22
    d.commsSMS ?? false,                  // $23
    d.commsWhatsApp ?? false,             // $24
    d.kycStatus ?? "NOT_STARTED",         // $25
    d.paymentMethods ? JSON.stringify(d.paymentMethods) : null, // $26
  ];

  const { rows } = await query(
    `
    INSERT INTO "StudentProfile" (
      "id","userId","fullName","email","avatarUrl","dob","nationality","passportNo",
      "school","program","intake","targetCity","phone","whatsapp",
      "addressLine1","addressLine2","addressCity","addressCountry","postal",
      "emergencyName","emergencyRelation","emergencyPhone",
      "commsEmail","commsSMS","commsWhatsApp",
      "kycStatus","paymentMethods","createdAt","updatedAt"
    )
    VALUES (
      gen_random_uuid()::text,
      $1,$2,$3,$4,$5,$6,$7,
      $8,$9,$10,$11,$12,$13,
      $14,$15,$16,$17,$18,
      $19,$20,$21,
      $22,$23,$24,
      $25, CAST($26 AS JSONB), NOW(), NOW()
    )
    ON CONFLICT ("userId") DO UPDATE SET
      "fullName" = EXCLUDED."fullName",
      "email" = EXCLUDED."email",
      "avatarUrl" = EXCLUDED."avatarUrl",
      "dob" = EXCLUDED."dob",
      "nationality" = EXCLUDED."nationality",
      "passportNo" = EXCLUDED."passportNo",
      "school" = EXCLUDED."school",
      "program" = EXCLUDED."program",
      "intake" = EXCLUDED."intake",
      "targetCity" = EXCLUDED."targetCity",
      "phone" = EXCLUDED."phone",
      "whatsapp" = EXCLUDED."whatsapp",
      "addressLine1" = EXCLUDED."addressLine1",
      "addressLine2" = EXCLUDED."addressLine2",
      "addressCity" = EXCLUDED."addressCity",
      "addressCountry" = EXCLUDED."addressCountry",
      "postal" = EXCLUDED."postal",
      "emergencyName" = EXCLUDED."emergencyName",
      "emergencyRelation" = EXCLUDED."emergencyRelation",
      "emergencyPhone" = EXCLUDED."emergencyPhone",
      "commsEmail" = EXCLUDED."commsEmail",
      "commsSMS" = EXCLUDED."commsSMS",
      "commsWhatsApp" = EXCLUDED."commsWhatsApp",
      "kycStatus" = EXCLUDED."kycStatus",
      "paymentMethods" = EXCLUDED."paymentMethods",
      "updatedAt" = NOW()
    RETURNING *;
    `,
    vals
  );

  res.json({ profile: rows[0] });
});

/* -------------------- AGENT -------------------- */

const displayStatusFromUser = (userStatus) => {
  const s = String(userStatus || "").toUpperCase();
  if (s === "SUSPENDED") return "Suspended";
  if (s === "INVITED") return "Pending";
  return "Verified";
};
const displayKycFromProfile = (kyc) => {
  const s = String(kyc || "").toUpperCase();
  if (s === "PASSED" || s === "VERIFIED") return "Passed";
  if (s === "FAILED") return "Failed";
  return "Pending";
};
const presentDoc = (d) => ({
  id: d.id,
  name: d.filename,
  category: d.category || "Other",
  status: d.status || "Pending",
  mime: d.mime || null,
  size: d.size || 0,
  url: d.url,
  downloadUrl: d.url,
  uploadedAt: d.createdat || d.createdAt,
});

const AgentUpdateSchema = z.object({
  first: z.string().optional(),
  last: z.string().optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  city: z.string().optional(),

  orgName: z.string().optional(),
  website: z.string().optional(),
  supportEmail: z.string().optional(),

  payoutMethod: z.literal("BANK").optional(),
  bankName: z.string().optional(),
  accountName: z.string().optional(),
  accountNumber: z.string().optional(),
  branch: z.string().optional(),

  prefsTimezone: z.string().optional(),
  prefsCurrency: z.string().optional(),
  prefsUnit: z.enum(["IMPERIAL", "METRIC"]).optional(),

  notifyNewInquiry: z.boolean().optional(),
  notifyDocUploaded: z.boolean().optional(),
  notifyOfferEmailed: z.boolean().optional(),
  notifyPayoutPaid: z.boolean().optional(),
  notifyWeeklyDigest: z.boolean().optional(),
});

router.get("/agents/me/profile", authRequired, async (req, res) => {
  const userId = req.user.id;

  let { rows: users } = await query(
    `SELECT u.id, u.email, u.name, u.status,
            ap.*
     FROM "User" u
     LEFT JOIN "AgentProfile" ap ON ap."userId" = u.id
     WHERE u.id = $1`,
    [userId]
  );
  let userRow = users[0];

  if (!userRow || !userRow.userId) {
    const u = await query(`SELECT name, email FROM "User" WHERE id = $1`, [userId]);
    const [first, ...rest] = (u.rows[0]?.name || "").split(" ");
    await query(
      `INSERT INTO "AgentProfile"
        (id, "userId", first, last, email, "createdAt", "updatedAt")
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, NOW(), NOW())`,
      [userId, first || "", rest.join(" "), u.rows[0]?.email || ""]
    );
    const refreshed = await query(
      `SELECT u.id, u.email, u.name, u.status, ap.*
       FROM "User" u
       LEFT JOIN "AgentProfile" ap ON ap."userId" = u.id
       WHERE u.id = $1`,
      [userId]
    );
    userRow = refreshed.rows[0];
  }

  const docsRes = await query(
    `SELECT *
     FROM "AgentDoc"
     WHERE "userId" = $1
     ORDER BY "createdAt" DESC`,
    [userId]
  );

  const account = {
    status: userRow.status || "ACTIVE",
    display: displayStatusFromUser(userRow.status),
  };
  const kyc = {
    status: userRow.kycStatus || "PENDING",
    display: displayKycFromProfile(userRow.kycStatus),
  };

  const prof = {
    id: userRow.id1 || userRow.id,
    userId,
    first: userRow.first,
    last: userRow.last,
    email: userRow.email1 || userRow.email,
    phone: userRow.phone,
    city: userRow.city,
    orgName: userRow.orgName,
    website: userRow.website,
    supportEmail: userRow.supportEmail,
    payoutMethod: userRow.payoutMethod,
    bankName: userRow.bankName,
    accountName: userRow.accountName,
    accountNumber: userRow.accountNumber,
    branch: userRow.branch,
    prefsTimezone: userRow.prefsTimezone,
    prefsCurrency: userRow.prefsCurrency,
    prefsUnit: userRow.prefsUnit,
    notifyNewInquiry: userRow.notifyNewInquiry,
    notifyDocUploaded: userRow.notifyDocUploaded,
    notifyOfferEmailed: userRow.notifyOfferEmailed,
    notifyPayoutPaid: userRow.notifyPayoutPaid,
    notifyWeeklyDigest: userRow.notifyWeeklyDigest,
    kycStatus: userRow.kycStatus || "PENDING",
    notes: userRow.notes,
    rating: userRow.rating,
    avatarUrl: userRow.avatarUrl,
    createdAt: userRow.createdAt,
    updatedAt: userRow.updatedAt,
  };

  res.json({
    profile: prof,
    account,
    kyc,
    docs: docsRes.rows.map(presentDoc),
  });
});

router.put("/agents/me/profile", authRequired, async (req, res) => {
  const userId = req.user.id;
  const parsed = AgentUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const d = parsed.data;

  const { rows } = await query(
    `
    INSERT INTO "AgentProfile" (
      id, "userId", first, last, email, phone, city,
      "orgName", website, "supportEmail",
      "payoutMethod", "bankName", "accountName", "accountNumber", branch,
      "prefsTimezone", "prefsCurrency", "prefsUnit",
      "notifyNewInquiry", "notifyDocUploaded", "notifyOfferEmailed",
      "notifyPayoutPaid", "notifyWeeklyDigest",
      "updatedAt", "createdAt"
    ) VALUES (
      gen_random_uuid()::text, $1, $2, $3, $4, $5, $6,
      $7, $8, $9,
      $10, $11, $12, $13, $14,
      $15, $16, $17,
      $18, $19, $20,
      $21, $22,
      NOW(), NOW()
    )
    ON CONFLICT ("userId") DO UPDATE SET
      first = EXCLUDED.first,
      last = EXCLUDED.last,
      email = EXCLUDED.email,
      phone = EXCLUDED.phone,
      city = EXCLUDED.city,
      "orgName" = EXCLUDED."orgName",
      website = EXCLUDED.website,
      "supportEmail" = EXCLUDED."supportEmail",
      "payoutMethod" = EXCLUDED."payoutMethod",
      "bankName" = EXCLUDED."bankName",
      "accountName" = EXCLUDED."accountName",
      "accountNumber" = EXCLUDED."accountNumber",
      branch = EXCLUDED.branch,
      "prefsTimezone" = EXCLUDED."prefsTimezone",
      "prefsCurrency" = EXCLUDED."prefsCurrency",
      "prefsUnit" = EXCLUDED."prefsUnit",
      "notifyNewInquiry" = EXCLUDED."notifyNewInquiry",
      "notifyDocUploaded" = EXCLUDED."notifyDocUploaded",
      "notifyOfferEmailed" = EXCLUDED."offerEmailed",
      "notifyPayoutPaid" = EXCLUDED."notifyPayoutPaid",
      "notifyWeeklyDigest" = EXCLUDED."notifyWeeklyDigest",
      "updatedAt" = NOW()
    RETURNING *;
    `,
    [
      userId,
      d.first ?? null, d.last ?? null, d.email ?? null, d.phone ?? null, d.city ?? null,
      d.orgName ?? null, d.website ?? null, d.supportEmail ?? null,
      d.payoutMethod ?? "BANK", d.bankName ?? null, d.accountName ?? null,
      d.accountNumber ?? null, d.branch ?? null,
      d.prefsTimezone ?? "Africa/Nairobi", d.prefsCurrency ?? "USD", d.prefsUnit ?? "IMPERIAL",
      d.notifyNewInquiry ?? true, d.notifyDocUploaded ?? true, d.notifyOfferEmailed ?? true,
      d.notifyPayoutPaid ?? true, d.notifyWeeklyDigest ?? false
    ]
  );

  res.json({ profile: rows[0] });
});

export default router;
