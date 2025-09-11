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

  // 1) Make sure a row exists (no mass NULLs on first save)
  await query(
    `
    INSERT INTO "StudentProfile"(id, "userId", "createdAt", "updatedAt")
    VALUES (gen_random_uuid()::text, $1, NOW(), NOW())
    ON CONFLICT ("userId") DO NOTHING
    `,
    [userId]
  );

  // helper: only update if the key was present in the JSON body
  const has = (k) => Object.prototype.hasOwnProperty.call(d, k);

  const vals = [
    userId,                                       // $1
    has("fullName")       ? d.fullName       : null, // $2
    has("email")          ? d.email          : null, // $3
    has("avatarUrl")      ? d.avatarUrl      : null, // $4
    has("dob")            ? d.dob            : null, // $5
    has("nationality")    ? d.nationality    : null, // $6
    has("passportNo")     ? d.passportNo     : null, // $7
    has("school")         ? d.school         : null, // $8
    has("program")        ? d.program        : null, // $9
    has("intake")         ? d.intake         : null, // $10
    has("targetCity")     ? d.targetCity     : null, // $11
    has("phone")          ? d.phone          : null, // $12
    has("whatsapp")       ? d.whatsapp       : null, // $13
    has("addressLine1")   ? d.addressLine1   : null, // $14
    has("addressLine2")   ? d.addressLine2   : null, // $15
    has("addressCity")    ? d.addressCity    : null, // $16
    has("addressCountry") ? d.addressCountry : null, // $17
    has("postal")         ? d.postal         : null, // $18
    has("emergencyName")      ? d.emergencyName      : null, // $19
    has("emergencyRelation")  ? d.emergencyRelation  : null, // $20
    has("emergencyPhone")     ? d.emergencyPhone     : null, // $21
    has("commsEmail")     ? d.commsEmail     : null, // $22 (boolean ok)
    has("commsSMS")       ? d.commsSMS       : null, // $23
    has("commsWhatsApp")  ? d.commsWhatsApp  : null, // $24
    has("kycStatus")      ? d.kycStatus      : null, // $25
    has("paymentMethods") ? JSON.stringify(d.paymentMethods) : null, // $26
  ];

  // 2) Partial UPDATE — only touch fields whose param is NOT NULL
  const { rows } = await query(
    `
    UPDATE "StudentProfile" SET
      "fullName"       = COALESCE($2,  "fullName"),
      "email"          = COALESCE($3,  "email"),
      "avatarUrl"      = COALESCE($4,  "avatarUrl"),
      "dob"            = COALESCE($5,  "dob"),
      "nationality"    = COALESCE($6,  "nationality"),
      "passportNo"     = COALESCE($7,  "passportNo"),
      "school"         = COALESCE($8,  "school"),
      "program"        = COALESCE($9,  "program"),
      "intake"         = COALESCE($10, "intake"),
      "targetCity"     = COALESCE($11, "targetCity"),
      "phone"          = COALESCE($12, "phone"),
      "whatsapp"       = COALESCE($13, "whatsapp"),
      "addressLine1"   = COALESCE($14, "addressLine1"),
      "addressLine2"   = COALESCE($15, "addressLine2"),
      "addressCity"    = COALESCE($16, "addressCity"),
      "addressCountry" = COALESCE($17, "addressCountry"),
      "postal"         = COALESCE($18, "postal"),
      "emergencyName"      = COALESCE($19, "emergencyName"),
      "emergencyRelation"  = COALESCE($20, "emergencyRelation"),
      "emergencyPhone"     = COALESCE($21, "emergencyPhone"),
      "commsEmail"     = COALESCE($22, "commsEmail"),
      "commsSMS"       = COALESCE($23, "commsSMS"),
      "commsWhatsApp"  = COALESCE($24, "commsWhatsApp"),
      "kycStatus"      = COALESCE($25, "kycStatus"),
      "paymentMethods" = COALESCE(CAST($26 AS JSONB), "paymentMethods"),
      "updatedAt" = NOW()
    WHERE "userId" = $1
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

  try {
    // 1) Ensure a row exists (no accidental wipes on first save)
    await query(
      `
      INSERT INTO "AgentProfile"(id, "userId", "createdAt", "updatedAt")
      VALUES (gen_random_uuid()::text, $1, NOW(), NOW())
      ON CONFLICT ("userId") DO NOTHING
      `,
      [userId]
    );

    // Only update keys that were actually provided in this request
    const has = (k) => Object.prototype.hasOwnProperty.call(d, k);

    const vals = [
      userId,                                       // $1
      has("first")            ? d.first            : null, // $2
      has("last")             ? d.last             : null, // $3
      has("email")            ? d.email            : null, // $4
      has("phone")            ? d.phone            : null, // $5
      has("city")             ? d.city             : null, // $6
      has("orgName")          ? d.orgName          : null, // $7
      has("website")          ? d.website          : null, // $8
      has("supportEmail")     ? d.supportEmail     : null, // $9
      has("payoutMethod")     ? (d.payoutMethod || "BANK") : null, // $10
      has("bankName")         ? d.bankName         : null, // $11
      has("accountName")      ? d.accountName      : null, // $12
      has("accountNumber")    ? d.accountNumber    : null, // $13
      has("branch")           ? d.branch           : null, // $14
      has("prefsTimezone")    ? d.prefsTimezone    : null, // $15
      has("prefsCurrency")    ? d.prefsCurrency    : null, // $16
      has("prefsUnit")        ? d.prefsUnit        : null, // $17
      has("notifyNewInquiry") ? d.notifyNewInquiry : null, // $18
      has("notifyDocUploaded")? d.notifyDocUploaded: null, // $19
      has("notifyOfferEmailed")? d.notifyOfferEmailed: null, // $20
      has("notifyPayoutPaid") ? d.notifyPayoutPaid : null, // $21
      has("notifyWeeklyDigest")? d.notifyWeeklyDigest: null, // $22
    ];

    // 2) Partial update: keep existing values when param is NULL
    const { rows } = await query(
      `
      UPDATE "AgentProfile" SET
        first              = COALESCE($2,  first),
        last               = COALESCE($3,  last),
        email              = COALESCE($4,  email),
        phone              = COALESCE($5,  phone),
        city               = COALESCE($6,  city),
        "orgName"          = COALESCE($7,  "orgName"),
        website            = COALESCE($8,  website),
        "supportEmail"     = COALESCE($9,  "supportEmail"),
        "payoutMethod"     = COALESCE($10, "payoutMethod"),
        "bankName"         = COALESCE($11, "bankName"),
        "accountName"      = COALESCE($12, "accountName"),
        "accountNumber"    = COALESCE($13, "accountNumber"),
        branch             = COALESCE($14, branch),
        "prefsTimezone"    = COALESCE($15, "prefsTimezone"),
        "prefsCurrency"    = COALESCE($16, "prefsCurrency"),
        "prefsUnit"        = COALESCE($17, "prefsUnit"),
        "notifyNewInquiry" = COALESCE($18, "notifyNewInquiry"),
        "notifyDocUploaded"= COALESCE($19, "notifyDocUploaded"),
        "notifyOfferEmailed"= COALESCE($20, "notifyOfferEmailed"),
        "notifyPayoutPaid" = COALESCE($21, "notifyPayoutPaid"),
        "notifyWeeklyDigest"= COALESCE($22, "notifyWeeklyDigest"),
        "updatedAt" = NOW()
      WHERE "userId" = $1
      RETURNING *;
      `,
      vals
    );

    res.json({ profile: rows[0] });
  } catch (e) {
    console.error("PUT /agents/me/profile failed:", e);
    res.status(500).json({ error: e.message || "Internal server error" });
  }
});



export default router;
