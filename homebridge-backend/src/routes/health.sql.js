// src/routes/health.sql.js
import { Router } from "express";
import { query } from "../db.js";
const router = Router();
router.get("/", async (_req, res) => {
  const { rows } = await query("SELECT NOW() as now");
  res.json({ ok: true, dbTime: rows[0].now });
});
export default router;
