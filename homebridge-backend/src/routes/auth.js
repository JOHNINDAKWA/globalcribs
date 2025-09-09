import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { query, tx } from "../db.js";
import { authRequired } from "../middleware/auth.js";

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || "dev-insecure-secret";

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

export default router;
