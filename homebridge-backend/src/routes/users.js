import { Router } from "express";
import { z } from "zod";
import { authRequired } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { query } from "../db.js";

const router = Router();

// List users (ADMIN+)
router.get("/", authRequired, requireRole("ADMIN", "SUPERADMIN"), async (_req, res) => {
  const { rows } = await query(
    `SELECT id, email, name, role, status, "createdAt"
     FROM "User"
     WHERE "deletedAt" IS NULL
     ORDER BY "createdAt" DESC`
  );
  res.json({ users: rows });
});

// Get one
router.get("/:id", authRequired, requireRole("ADMIN", "SUPERADMIN"), async (req, res) => {
  const { rows } = await query(
    `SELECT id, email, name, role, status, "createdAt"
     FROM "User" WHERE id = $1`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  res.json({ user: rows[0] });
});

// Update (name, role, status)
const UpdateSchema = z.object({
  name: z.string().optional(),
  role: z.enum(["SUPERADMIN", "ADMIN", "AGENT", "STUDENT"]).optional(),
  status: z.enum(["ACTIVE", "SUSPENDED", "INVITED"]).optional(),
});

router.patch("/:id", authRequired, requireRole("ADMIN", "SUPERADMIN"), async (req, res) => {
  const parsed = UpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  // Disallow demoting last SUPERADMIN
  if (parsed.data.role && parsed.data.role !== "SUPERADMIN") {
    const { rows: isTargetSuper } = await query(
      `SELECT 1 FROM "User" WHERE id = $1 AND role = 'SUPERADMIN'`,
      [req.params.id]
    );
    if (isTargetSuper.length) {
      const { rows: others } = await query(
        `SELECT COUNT(*)::int AS c FROM "User" WHERE role = 'SUPERADMIN' AND id <> $1`,
        [req.params.id]
      );
      if (others[0].c === 0) return res.status(400).json({ error: "Cannot demote last SUPERADMIN" });
    }
  }

  // build UPDATE
  const fields = [];
  const vals = [];
  let p = 1;
  if (parsed.data.name !== undefined) { fields.push(`name = $${p++}`); vals.push(parsed.data.name); }
  if (parsed.data.role !== undefined) { fields.push(`role = $${p++}`); vals.push(parsed.data.role); }
  if (parsed.data.status !== undefined) { fields.push(`status = $${p++}`); vals.push(parsed.data.status); }
  if (!fields.length) {
    const { rows } = await query(`SELECT * FROM "User" WHERE id = $1`, [req.params.id]);
    return res.json({ user: rows[0] });
  }
  vals.push(req.params.id);

  const { rows } = await query(
    `UPDATE "User" SET ${fields.join(", ")}, "updatedAt" = NOW()
     WHERE id = $${p}
     RETURNING id, email, name, role, status, "createdAt"`,
    vals
  );
  res.json({ user: rows[0] });
});

// Soft delete
router.delete("/:id", authRequired, requireRole("ADMIN", "SUPERADMIN"), async (req, res) => {
  const { rows: t } = await query(`SELECT id, role FROM "User" WHERE id = $1`, [req.params.id]);
  const target = t[0];
  if (!target) return res.status(404).json({ error: "Not found" });

  if (target.role === "SUPERADMIN") {
    const { rows: others } = await query(
      `SELECT COUNT(*)::int AS c FROM "User" WHERE role='SUPERADMIN' AND id <> $1`,
      [req.params.id]
    );
    if (others[0].c === 0) return res.status(400).json({ error: "Cannot delete last SUPERADMIN" });
  }

  await query(
    `UPDATE "User" SET "deletedAt" = NOW(), status = 'SUSPENDED', "updatedAt" = NOW() WHERE id = $1`,
    [req.params.id]
  );
  res.json({ ok: true });
});

export default router;
