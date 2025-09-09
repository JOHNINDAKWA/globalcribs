import jwt from "jsonwebtoken";
import { query } from "../db.js";

export async function authOptional(req, _res, next) {
  const hdr = req.headers.authorization || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : "";
  if (!token) return next();

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const { rows } = await query(
      `SELECT id, role, "tokenVersion", "deletedAt", "adminScope"
       FROM "User"
       WHERE id = $1`,
      [payload.id]
    );
    const u = rows[0];
    if (!u || u.deletedAt) return next();

    if (typeof payload.tv === "number" && payload.tv !== u.tokenVersion) {
      return next(); // old/revoked token
    }

    req.user = { id: u.id, role: u.role, adminScope: u.adminScope };
    next();
  } catch {
    next();
  }
}

export function authRequired(req, res, next) {
  if (!req.user?.id) return res.status(401).json({ error: "Unauthorized" });
  next();
}

export function adminOnly(req, res, next) {
  const r = String(req.user?.role || "").toUpperCase();
  if (r !== "ADMIN" && r !== "SUPERADMIN") {
    return res.status(403).json({ error: "Admin only" });
  }
  next();
}

export function ensureSuper(req, res, next) {
  const r = String(req.user?.role || "").toUpperCase();
  if (r !== "SUPERADMIN") return res.status(403).json({ error: "Superadmin only" });
  next();
}
