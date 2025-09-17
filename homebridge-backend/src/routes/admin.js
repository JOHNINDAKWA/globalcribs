import { Router } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { z } from "zod";
import { authRequired, adminOnly } from "../middleware/auth.js";
import { query, tx } from "../db.js";

const router = Router();

// ---------- helpers ----------
const AdminScope = z.enum(["SUPERADMIN", "ADMIN", "ANALYST", "READONLY"]);
function randomKey(bytes = 24) {
  return crypto.randomBytes(bytes).toString("hex");
}

// ---------- /api/admin/me ----------
router.get("/me", authRequired, adminOnly, async (req, res) => {
  const { rows } = await query(
    `SELECT id, email, name, role, status, "adminScope", "twoFA", "apiKey",
            to_char("createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
            to_char("lastLoginAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastLoginAt"
     FROM "User" WHERE id = $1`,
    [req.user.id]
  );
  res.json({ user: rows[0] || null });
});


router.put("/me", authRequired, adminOnly, async (req, res) => {
  const Body = z.object({
    name: z.string().min(1).optional(),
    twoFA: z.boolean().optional(),
  });
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const fields = [];
  const vals = [];
  let p = 1;
  if (parsed.data.name !== undefined) { fields.push(`name = $${p++}`); vals.push(parsed.data.name); }
  if (parsed.data.twoFA !== undefined) { fields.push(`"twoFA" = $${p++}`); vals.push(parsed.data.twoFA); }
  if (!fields.length) return res.json({ user: { id: req.user.id } });

  vals.push(req.user.id);
  const { rows } = await query(
    `UPDATE "User" SET ${fields.join(", ")}, "updatedAt" = NOW()
     WHERE id = $${p}
     RETURNING id, name, "twoFA"`,
    vals
  );
  res.json({ user: rows[0] });
});

router.post("/me/password", authRequired, adminOnly, async (req, res) => {
  const Body = z.object({ current: z.string().min(1), next: z.string().min(8) });
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const me = await query(`SELECT id, "passwordHash" FROM "User" WHERE id = $1`, [req.user.id]);
  const u = me.rows[0];
  const ok = await bcrypt.compare(parsed.data.current, u.passwordHash);
  if (!ok) return res.status(401).json({ error: "Current password incorrect" });

  await query(
    `UPDATE "User"
     SET "passwordHash" = $1, "tokenVersion" = "tokenVersion" + 1, "updatedAt" = NOW()
     WHERE id = $2`,
    [await bcrypt.hash(parsed.data.next, 10), u.id]
  );
  res.status(204).end();
});

router.post("/me/api-key", authRequired, adminOnly, async (req, res) => {
  const key = randomKey();
  const { rows } = await query(
    `UPDATE "User" SET "apiKey" = $1, "updatedAt" = NOW() WHERE id = $2 RETURNING "apiKey"`,
    [key, req.user.id]
  );
  res.json({ apiKey: rows[0].apiKey });
});

router.post("/me/revoke-sessions", authRequired, adminOnly, async (req, res) => {
  await query(
    `UPDATE "User" SET "tokenVersion" = "tokenVersion" + 1, "updatedAt" = NOW() WHERE id = $1`,
    [req.user.id]
  );
  res.status(204).end();
});

// ---------- /api/admin/team ----------
router.get("/team", authRequired, adminOnly, async (_req, res) => {
  const { rows } = await query(
    `SELECT id, name, email, role, status, "adminScope", "twoFA",
            to_char("createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
            to_char("lastLoginAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastLoginAt"
     FROM "User"
     WHERE role IN ('ADMIN','SUPERADMIN')
     ORDER BY "createdAt" DESC`
  );
  res.json({ team: rows });
});


router.post("/team/invite", authRequired, adminOnly, async (req, res) => {
  const Body = z.object({
    email: z.string().email(),
    name: z.string().min(1).optional(),
    adminScope: AdminScope.default("ADMIN"),
    password: z.string().min(8).optional(),
  });
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { email, name, adminScope, password } = parsed.data;

  const requester = await query(`SELECT role FROM "User" WHERE id = $1`, [req.user.id]);
  if (adminScope === "SUPERADMIN" && requester.rows[0]?.role !== "SUPERADMIN") {
    return res.status(403).json({ error: "Only superadmins can invite superadmins" });
  }

  const emailNorm = email.toLowerCase();
  const exists = await query(`SELECT 1 FROM "User" WHERE email = $1`, [emailNorm]);
  if (exists.rowCount) return res.status(409).json({ error: "Email already exists" });

  const pwd = password || randomKey(10);
  const role = adminScope === "SUPERADMIN" ? "SUPERADMIN" : "ADMIN";

  const { rows } = await query(
    `INSERT INTO "User" (
       id, name, email, "passwordHash", role, status, "adminScope",
       "invitedAt", "mustChangePassword", "createdAt", "updatedAt"
     ) VALUES (
       gen_random_uuid()::text, $1, $2, $3, $4, 'INVITED', $5,
       NOW(), TRUE, NOW(), NOW()
     )
     RETURNING id, name, email, role, status, "adminScope", "mustChangePassword", "invitedAt"`,
    [name || emailNorm.split("@")[0], emailNorm, await bcrypt.hash(pwd, 10), role, adminScope]
  );

  res.json({ invited: rows[0], tempPassword: password ? undefined : pwd });
});

router.patch("/team/:id", authRequired, adminOnly, async (req, res) => {
  const Path = z.object({ id: z.string().min(1) });
  const Body = z.object({
    adminScope: AdminScope.optional(),
    status: z.enum(["ACTIVE", "SUSPENDED", "INVITED"]).optional(),
  });
  const pth = Path.safeParse(req.params);
  const bod = Body.safeParse(req.body);
  if (!pth.success || !bod.success) return res.status(400).json({ error: "Invalid request" });

  const { rows: trows } = await query(`SELECT id, role FROM "User" WHERE id = $1`, [pth.data.id]);
  const target = trows[0];
  if (!target) return res.status(404).json({ error: "User not found" });
  if (!["ADMIN", "SUPERADMIN"].includes(target.role)) {
    return res.status(400).json({ error: "Not an admin user" });
  }
  if (target.id === req.user.id) return res.status(400).json({ error: "Use /me for your own profile" });

  const { rows: superCountRows } = await query(
    `SELECT COUNT(*)::int AS c FROM "User" WHERE role='SUPERADMIN' AND id <> $1`,
    [target.id]
  );
  const isLastSuper = target.role === "SUPERADMIN" && superCountRows[0].c === 0;

  if (isLastSuper) {
    if (bod.data.adminScope && bod.data.adminScope !== "SUPERADMIN") {
      return res.status(400).json({ error: "Cannot change scope of the last superadmin" });
    }
    if (bod.data.status && bod.data.status !== "ACTIVE") {
      return res.status(400).json({ error: "Cannot suspend the last superadmin" });
    }
  }

  // Only supers can promote to superadmin
  if (bod.data.adminScope === "SUPERADMIN") {
    const me = await query(`SELECT role FROM "User" WHERE id = $1`, [req.user.id]);
    if (me.rows[0]?.role !== "SUPERADMIN") {
      return res.status(403).json({ error: "Only superadmins can promote to superadmin" });
    }
  }

  // Build update
  const role =
    bod.data.adminScope ? (bod.data.adminScope === "SUPERADMIN" ? "SUPERADMIN" : "ADMIN") : undefined;

  const fields = [];
  const vals = [];
  let p = 1;
  if (bod.data.adminScope !== undefined) { fields.push(`"adminScope" = $${p++}`); vals.push(bod.data.adminScope); }
  if (bod.data.status !== undefined) { fields.push(`status = $${p++}`); vals.push(bod.data.status); }
  if (role !== undefined) { fields.push(`role = $${p++}`); vals.push(role); }
  if (!fields.length) {
    const { rows } = await query(
      `SELECT id, name, email, role, status, "adminScope" FROM "User" WHERE id = $1`,
      [target.id]
    );
    return res.json({ user: rows[0] });
  }
  vals.push(target.id);
  const { rows } = await query(
    `UPDATE "User" SET ${fields.join(", ")}, "updatedAt" = NOW()
     WHERE id = $${p}
     RETURNING id, name, email, role, status, "adminScope"`,
    vals
  );
  res.json({ user: rows[0] });
});

router.post("/team/:id/reset-password", authRequired, adminOnly, async (req, res) => {
  const Path = z.object({ id: z.string().min(1) });
  const Body = z.object({ password: z.string().min(8).optional() });
  const pth = Path.safeParse(req.params);
  const bod = Body.safeParse(req.body);
  if (!pth.success || !bod.success) return res.status(400).json({ error: "Invalid request" });

  if (pth.data.id === req.user.id) return res.status(400).json({ error: "Use /me/password for yourself" });

  const { rows: trows } = await query(`SELECT id FROM "User" WHERE id = $1`, [pth.data.id]);
  if (!trows.length) return res.status(404).json({ error: "User not found" });

  const pwd = bod.data.password || randomKey(10);
  await query(
    `UPDATE "User"
     SET "passwordHash" = $1, "mustChangePassword" = TRUE, "tokenVersion" = "tokenVersion" + 1, "updatedAt" = NOW()
     WHERE id = $2`,
    [await bcrypt.hash(pwd, 10), pth.data.id]
  );

  res.json({ tempPassword: bod.data.password ? undefined : pwd });
});

router.delete("/team/:id", authRequired, adminOnly, async (req, res) => {
  const Path = z.object({ id: z.string().min(1) }).safeParse(req.params);
  if (!Path.success) return res.status(400).json({ error: "Invalid request" });

  const { rows: trows } = await query(`SELECT id, role FROM "User" WHERE id = $1`, [Path.data.id]);
  const target = trows[0];
  if (!target) return res.status(404).json({ error: "User not found" });
  if (!["ADMIN", "SUPERADMIN"].includes(target.role)) return res.status(400).json({ error: "Not an admin user" });
  if (target.id === req.user.id) return res.status(400).json({ error: "You cannot remove yourself" });

  const { rows: superCountRows } = await query(
    `SELECT COUNT(*)::int AS c FROM "User" WHERE role='SUPERADMIN' AND id <> $1`,
    [target.id]
  );
  if (target.role === "SUPERADMIN" && superCountRows[0].c === 0) {
    return res.status(400).json({ error: "Cannot remove the last superadmin" });
  }

  await tx(async (c) => {
    // If you want hard delete (as Prisma version): delete the row
    await c.query(`DELETE FROM "User" WHERE id = $1`, [target.id]);
  });

  res.status(204).end();
});

export default router;
