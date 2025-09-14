import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { query, tx } from "../db.js";
import crypto from "crypto";
import { authRequired } from "../middleware/auth.js";

import { OAuth2Client } from "google-auth-library";

const JWT_SECRET = process.env.JWT_SECRET || "dev-insecure-secret";

// --- Google OAuth config ---
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
// Prefer explicit env, otherwise derive from API_PUBLIC_URL:
const GOOGLE_REDIRECT_URI  =
  process.env.GOOGLE_REDIRECT_URI ||
  `${String(process.env.API_PUBLIC_URL || "http://localhost:4000").replace(/\/+$/,"")}/api/auth/google/callback`;

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);

// Minimal signed state (avoid tampering / CSRF)
function makeState(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "10m", subject: "google-oauth" });
}
function readState(token) {
  try {
    return jwt.verify(token, JWT_SECRET, { subject: "google-oauth" });
  } catch {
    return {};
  }
}


const router = Router();

function signTokenFromUser(u) {
  return jwt.sign(
    { id: u.id, role: u.role, tv: u.tokenVersion ?? 0 },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().optional(),
  role: z.enum(["STUDENT", "AGENT"]).optional(),
});

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

/** POST /api/auth/register */
router.post("/register", async (req, res) => {
  try {
    const parsed = RegisterSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const { name, email, password } = parsed.data;
    const role = parsed.data.role || "STUDENT";
    const emailNorm = email.toLowerCase();

    // conflict if already exists
    const exist = await query(
      `SELECT id FROM "User" WHERE email = $1`,
      [emailNorm]
    );
    if (exist.rowCount) {
      return res.status(409).json({ error: "Email already in use" });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    // insert
    const result = await query(
      `INSERT INTO "User"
        (id, email, name, "passwordHash", role, status, "createdAt", "updatedAt", "tokenVersion", "mustChangePassword")
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 'ACTIVE', NOW(), NOW(), 0, false)
       RETURNING id, name, email, role, status, "createdAt", "tokenVersion", "mustChangePassword", "adminScope", "lastLoginAt"`,
      [emailNorm, name || emailNorm.split("@")[0], passwordHash, role]
    );
    const user = result.rows[0];

    const token = signTokenFromUser(user);
    res.json({ token, user });
  } catch (e) {
    console.error("Register error:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

/** POST /api/auth/login */
router.post("/login", async (req, res) => {
  const parsed = LoginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { email, password } = parsed.data;
  const emailNorm = email.toLowerCase();

  const { rows } = await query(
    `SELECT id, email, name, role, status, "passwordHash",
            "mustChangePassword", "adminScope", "deletedAt", "tokenVersion"
     FROM "User"
     WHERE email = $1`,
    [emailNorm]
  );
  const user = rows[0];
  if (!user) return res.status(401).json({ error: "Invalid credentials" });
  if (user.deletedAt) return res.status(403).json({ error: "Account deleted" });
  if (user.status === "SUSPENDED") return res.status(403).json({ error: "Account suspended" });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: "Invalid credentials" });

  await query(
    `UPDATE "User" SET "lastLoginAt" = NOW(), "updatedAt" = NOW() WHERE id = $1`,
    [user.id]
  );

  const token = signTokenFromUser(user);
  res.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      status: user.status,
      mustChangePassword: user.mustChangePassword,
      adminScope: user.adminScope,
    },
  });
});

/** GET /api/auth/me */
router.get("/me", authRequired, async (req, res) => {
  const { rows } = await query(
    `SELECT id, email, name, role, status, "createdAt", "lastLoginAt",
            "adminScope", "mustChangePassword", "tokenVersion"
     FROM "User"
     WHERE id = $1`,
    [req.user.id]
  );
  res.json({ user: rows[0] || null });
});

/** POST /api/auth/password/change */
router.post("/password/change", authRequired, async (req, res) => {
  const Body = z.object({
    current: z.string().min(1).optional(),
    next: z.string().min(8),
  });
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { rows } = await query(
    `SELECT id, "passwordHash", "mustChangePassword" FROM "User" WHERE id = $1`,
    [req.user.id]
  );
  const u = rows[0];
  if (!u) return res.status(404).json({ error: "User not found" });

  if (!u.mustChangePassword) {
    if (!parsed.data.current) {
      return res.status(400).json({ error: "Current password required" });
    }
    const ok = await bcrypt.compare(parsed.data.current, u.passwordHash);
    if (!ok) return res.status(401).json({ error: "Current password incorrect" });
  }

  const newHash = await bcrypt.hash(parsed.data.next, 10);
  await query(
    `UPDATE "User"
     SET "passwordHash" = $1,
         "mustChangePassword" = false,
         "tokenVersion" = "tokenVersion" + 1,
         "updatedAt" = NOW()
     WHERE id = $2`,
    [newHash, u.id]
  );

  res.status(204).end();
});




// --- OTP RESET FLOW ---

const ForgotSchema = z.object({
  email: z.string().email(),
});

const VerifySchema = z.object({
  email: z.string().email(),
  code: z.string().regex(/^\d{6}$/),
});

const ResetSchema = z.object({
  resetToken: z.string().min(1),
  newPassword: z.string().min(8),
});

// helper: mask email for logs/UI if needed
function maskEmail(addr) {
  const [u, d] = addr.split("@");
  if (!u || !d) return addr;
  const head = u.slice(0, 2);
  return `${head}${"*".repeat(Math.max(1, u.length - 2))}@${d}`;
}

function genCode6() {
  // 6-digit, leading zeros allowed
  return String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
}

// naive mailer placeholder (wire nodemailer or transactional provider later)
import { sendPasswordResetEmail } from "../lib/mailer.js";
async function sendResetEmail({ to, code }) {
  // In dev you may still want a console log for convenience:
  if (process.env.NODE_ENV !== "production") {
    console.log(`[DEV] Password reset code for ${to}: ${code}`);
  }
  await sendPasswordResetEmail({ to, code });
}

/** POST /api/auth/forgot
 * Always returns 200 with a generic message.
 */
router.post("/forgot", async (req, res) => {
  const parsed = ForgotSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const emailNorm = parsed.data.email.toLowerCase();

  try {
    const { rows } = await query(
      `SELECT id, email, status, "deletedAt"
         FROM "User"
        WHERE email = $1`,
      [emailNorm]
    );
    const user = rows[0];

    // Don't reveal existence. Only create code if user is valid+active.
    if (user && !user.deletedAt && user.status !== "SUSPENDED") {
      // soft-clean old pending resets to keep it tidy (optional)
      await query(
        `DELETE FROM "PasswordReset"
          WHERE "userId" = $1 AND ("usedAt" IS NOT NULL OR "expiresAt" < NOW() - INTERVAL '1 day')`,
        [user.id]
      );

      const code = genCode6();
      const codeHash = await bcrypt.hash(code, 10);
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 min

      await query(
        `INSERT INTO "PasswordReset"
           ("userId", "codeHash", "expiresAt", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, NOW(), NOW())`,
        [user.id, codeHash, expiresAt]
      );

      await sendResetEmail({ to: emailNorm, code });
    }

    // Generic response (prevents user enumeration)
    res.json({ ok: true, message: "If that email exists, we sent a code." });
  } catch (e) {
    console.error("forgot error:", e);
    res.json({ ok: true, message: "If that email exists, we sent a code." });
  }
});

/** POST /api/auth/verify-otp
 * If valid, returns a short-lived resetToken JWT.
 */
router.post("/verify-otp", async (req, res) => {
  const parsed = VerifySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const emailNorm = parsed.data.email.toLowerCase();
  const { code } = parsed.data;

  const { rows: users } = await query(
    `SELECT id FROM "User" WHERE email = $1 AND "deletedAt" IS NULL`,
    [emailNorm]
  );
  const user = users[0];
  // Always generic on failure
  if (!user) return res.status(400).json({ error: "Invalid code." });

  const { rows: prRows } = await query(
    `SELECT id, "codeHash", attempts, "expiresAt", "consumedAt"
       FROM "PasswordReset"
      WHERE "userId" = $1
        AND "usedAt" IS NULL
        AND "expiresAt" > NOW()
      ORDER BY "createdAt" DESC
      LIMIT 1`,
    [user.id]
  );
  const pr = prRows[0];
  if (!pr || pr.consumedAt) {
    return res.status(400).json({ error: "Invalid code." });
  }

  if (pr.attempts >= 6) {
    return res.status(400).json({ error: "Too many attempts. Request a new code." });
  }

  const ok = await bcrypt.compare(code, pr.codeHash);
  if (!ok) {
    await query(
      `UPDATE "PasswordReset" SET attempts = attempts + 1, "updatedAt" = NOW() WHERE id = $1`,
      [pr.id]
    );
    return res.status(400).json({ error: "Invalid code." });
  }

  // Mark consumed (code verified). Next step uses resetToken.
  await query(
    `UPDATE "PasswordReset" SET "consumedAt" = NOW(), "updatedAt" = NOW() WHERE id = $1`,
    [pr.id]
  );

  const resetToken = jwt.sign(
    { pr: pr.id, uid: user.id, kind: "pwd-reset" },
    JWT_SECRET,
    { expiresIn: "15m", subject: "pwd-reset" }
  );

  res.json({ resetToken });
});

/** POST /api/auth/reset-password
 * Body: { resetToken, newPassword }
 */
router.post("/reset-password", async (req, res) => {
  const parsed = ResetSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  // verify token
  let payload;
  try {
    payload = jwt.verify(parsed.data.resetToken, JWT_SECRET);
  } catch {
    return res.status(400).json({ error: "Invalid or expired reset token." });
  }
  if (payload?.kind !== "pwd-reset" || !payload?.pr || !payload?.uid) {
    return res.status(400).json({ error: "Invalid or expired reset token." });
  }

  // load reset record and ensure not used & not expired
  const { rows: prRows } = await query(
    `SELECT id, "userId", "consumedAt", "usedAt", "expiresAt"
       FROM "PasswordReset"
      WHERE id = $1 AND "userId" = $2`,
    [payload.pr, payload.uid]
  );
  const pr = prRows[0];
  if (!pr || !pr.consumedAt || pr.usedAt || pr.expiresAt < new Date()) {
    return res.status(400).json({ error: "Reset token no longer valid." });
  }

  const newHash = await bcrypt.hash(parsed.data.newPassword, 10);

  await tx(async (client) => {
    await client.query(
      `UPDATE "User"
          SET "passwordHash" = $1,
              "mustChangePassword" = false,
              "tokenVersion" = "tokenVersion" + 1,
              "updatedAt" = NOW()
        WHERE id = $2`,
      [newHash, pr.userId]
    );
    await client.query(
      `UPDATE "PasswordReset"
          SET "usedAt" = NOW(),
              "updatedAt" = NOW()
        WHERE id = $1`,
      [pr.id]
    );
  });

  // 204: success, nothing to return
  res.status(204).end();
});



/** GET /api/auth/google
 * Redirects to Google consent. Carries `role` and `from` in a signed state token.
 */
router.get("/google", async (req, res) => {
  const role = String(req.query.role || "").toUpperCase() === "AGENT" ? "AGENT" : "STUDENT";
  const from = typeof req.query.from === "string" ? req.query.from : "";

  const state = makeState({ role, from });

  const url = googleClient.generateAuthUrl({
    access_type: "offline",
    prompt: "select_account",
    scope: ["openid", "email", "profile"],
    state,
  });

  res.redirect(url);
});

/** GET /api/auth/google/callback
 * Exchanges the code, verifies the ID token, links/creates a user,
 * issues your JWT, and redirects back to the SPA.
 */
router.get("/google/callback", async (req, res) => {
  try {
    const { code = "", state: stateParam = "" } = req.query;
    if (!code) return res.status(400).send("Missing code");

    const { role = "STUDENT", from = "" } = readState(String(stateParam));

    // Exchange code -> tokens
    const { tokens } = await googleClient.getToken({
      code: String(code),
      redirect_uri: GOOGLE_REDIRECT_URI,
    });
    if (!tokens?.id_token) return res.status(400).send("No id_token");

    // Verify ID token
    const ticket = await googleClient.verifyIdToken({
      idToken: tokens.id_token,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();

    const googleId = payload?.sub || "";
    const email = String(payload?.email || "").toLowerCase();
    const name = payload?.name || (email ? email.split("@")[0] : "User");

    if (!googleId || !email) {
      return res.status(400).send("Google profile missing id/email");
    }

    // Find or create (prefer googleId, then email)
    let userRow;
    const byGoogle = await query(
      `SELECT * FROM "User" WHERE "googleId" = $1 AND "deletedAt" IS NULL`,
      [googleId]
    );

    if (byGoogle.rowCount) {
      userRow = byGoogle.rows[0];
    } else {
      const byEmail = await query(
        `SELECT * FROM "User" WHERE email = $1 AND "deletedAt" IS NULL`,
        [email]
      );

      if (byEmail.rowCount) {
        // Link Google to existing account
        const up = await query(
          `UPDATE "User"
             SET "googleId" = $1,
                 "authProvider" = 'GOOGLE',
                 name = COALESCE($2, name),
                 "lastLoginAt" = NOW(),
                 "updatedAt" = NOW()
           WHERE id = $3
           RETURNING *`,
          [googleId, name, byEmail.rows[0].id]
        );
        userRow = up.rows[0];
      } else {
        // Create new user — IMPORTANT: include a random password hash
        const randomPass = `google:${googleId}:${crypto.randomUUID()}`;
        const passwordHash = await bcrypt.hash(randomPass, 10);

        const created = await query(
          `INSERT INTO "User"
             (id, email, name, "passwordHash", role, status,
              "createdAt","updatedAt","tokenVersion","mustChangePassword",
              "authProvider","googleId","lastLoginAt")
           VALUES
             (gen_random_uuid()::text, $1, $2, $3, $4, 'ACTIVE',
              NOW(), NOW(), 0, false,
              'GOOGLE', $5, NOW())
           RETURNING *`,
          [email, name, passwordHash, role === "AGENT" ? "AGENT" : "STUDENT", googleId]
        );
        userRow = created.rows[0];
      }
    }

    // Block suspended accounts (optional)
    if (userRow.status === "SUSPENDED") {
      const FRONTEND = String(process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/+$/, "");
      return res.redirect(`${FRONTEND}/login?error=account_suspended`);
    }

    // Touch last login
    await query(
      `UPDATE "User" SET "lastLoginAt" = NOW(), "updatedAt" = NOW() WHERE id = $1`,
      [userRow.id]
    );

    // Issue JWT
    const token = signTokenFromUser(userRow);

    // Decide target path
    const FRONTEND = String(process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/+$/, "");
    const to = from || (userRow.role === "AGENT" ? "/dashboard/agent" : "/dashboard/student");

    // Redirect with token in hash
    res.redirect(
      `${FRONTEND}/oauth/callback#token=${encodeURIComponent(token)}&to=${encodeURIComponent(to)}`
    );
  } catch (e) {
    // Temporary verbose logging to see DB issues like NOT NULL violations
    console.error("Google OAuth error:", e?.code, e?.detail, e);
    res.status(500).send("OAuth failed");
  }
});

export default router;
