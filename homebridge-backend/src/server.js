import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";

import authRoutes from "./routes/auth.js";
import userRoutes from "./routes/users.js";
import profileRoutes from "./routes/profile.js";
import adminRoutes from "./routes/admin.js";
import listingsRoutes from "./routes/agent.listings.js";
import publicListingsRoutes from "./routes/public.listings.js";
import studentBookingsRoutes from "./routes/student.bookings.js";
import studentDocsRoutes from "./routes/student.docs.js";
import adminBookingsRouter from "./routes/admin.bookings.js";
import agentApplicationsRoutes from "./routes/agent.applications.js";
import adminStudentsRouter from "./routes/admin.students.js";
import adminAgentsRouter from "./routes/admin.agents.js";
import adminListingsRouter from "./routes/admin.listings.js";
import adminSettingsRouter from "./routes/admin.settings.js";
import healthSql from "./routes/health.sql.js";
import supportTicketsRoutes from "./routes/support.tickets.js";
import adminInquiriesRoutes from "./routes/admin.inquiries.js";
import agentOverviewRoutes from "./routes/agent.overview.js";
import studentMessagesRoutes from "./routes/student.messages.js";
import agentBilling from "./routes/agent.billing.js";
import agentPayouts from "./routes/agent.payouts.js";
import adminRefundsRouter from "./routes/admin.refunds.js";


/* NEW */
import stripeWebhook from "./routes/stripe.webhook.js";
import agentStripeConnect from "./routes/agent.stripe.connect.js";

/* NEW: agent KYC docs (upload/list/delete) */
import agentDocsRoutes from "./routes/agent.docs.js";

import { authOptional } from "./middleware/auth.js";

const app = express();

/* ---------- CORS ---------- */
const allowedOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins.length ? allowedOrigins : true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    // Add Stripe’s signature header (mostly harmless here; Stripe is not a browser)
    allowedHeaders: ["Content-Type", "Authorization", "Stripe-Signature"],
    optionsSuccessStatus: 204,
  })
);
app.options(/.*/, cors());

/* ---------- IMPORTANT: Stripe webhook BEFORE json body parsing ---------- */
app.use("/api/stripe/webhook", express.raw({ type: "application/json" }), stripeWebhook);

/* ---------- Body parsing (runs after the webhook) ---------- */
app.use(express.json({ limit: "5mb" }));

/* ---------- Static uploads ---------- */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, "..", "uploads");
await fs.mkdir(UPLOAD_DIR, { recursive: true });
await Promise.all([
  fs.mkdir(path.join(UPLOAD_DIR, "listings"), { recursive: true }),
  fs.mkdir(path.join(UPLOAD_DIR, "student-docs"), { recursive: true }),
  fs.mkdir(path.join(UPLOAD_DIR, "agent-docs"), { recursive: true }),
]);

app.use(
  "/uploads",
  express.static(UPLOAD_DIR, {
    maxAge: process.env.NODE_ENV === "production" ? "7d" : 0,
  })
);

/* ---------- Absolute URL normalizer for uploads ---------- */
app.use((req, res, next) => {
  const envBase = String(process.env.API_PUBLIC_URL || "").replace(/\/+$/, "");
  const inferredProto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const inferredBase = `${inferredProto}://${req.get("host")}`;
  const BASE = envBase || inferredBase;

  const _json = res.json.bind(res);
  const LOCAL_RE = /^https?:\/\/(localhost|127\.0\.0\.1):\d+\/uploads\//i;

  function fixValue(v) {
    if (typeof v !== "string") return v;
    if (v.startsWith("/uploads/")) return `${BASE}${v}`;
    if (LOCAL_RE.test(v)) return v.replace(/^https?:\/\/(localhost|127\.0\.0\.1):\d+/i, BASE);
    return v;
  }

  function deepFix(obj) {
    if (!obj || typeof obj !== "object") return obj;
    if (Array.isArray(obj)) return obj.map(deepFix);
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = v && typeof v === "object" ? deepFix(v) : fixValue(v);
    }
    return out;
  }

  res.json = (data) => _json(deepFix(data));
  next();
});

/* ---------- Attach req.user if present ---------- */
app.use(authOptional);

/* ---------- Routes ---------- */
app.get("/health", (_req, res) => res.json({ ok: true }));

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api", profileRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/agent/listings", listingsRoutes);
app.use("/api/public/listings", publicListingsRoutes);
app.use("/api/student/bookings", studentBookingsRoutes);
app.use("/api/student/docs", studentDocsRoutes);
app.use("/api/agents/me/docs", agentDocsRoutes);
app.use("/api/admin/bookings", adminBookingsRouter);
app.use("/api/agent/applications", agentApplicationsRoutes);
app.use("/api/admin/students", adminStudentsRouter);
app.use("/api/admin/agents", adminAgentsRouter);
app.use("/api/admin/listings", adminListingsRouter);
app.use("/api/admin/settings", adminSettingsRouter);
app.use("/api/agent/overview", agentOverviewRoutes);
app.use("/api/student/messages", studentMessagesRoutes);
app.use("/api/agent/billing", agentBilling);
app.use("/api/agent/payouts", agentPayouts);
app.use("/api/admin/refunds", adminRefundsRouter);



/* Connect endpoints */
app.use("/api/agent/stripe/connect", agentStripeConnect);

app.use("/api/support", supportTicketsRoutes);
app.use("/api/admin/inquiries", adminInquiriesRoutes);

app.use("/health-sql", healthSql);

/* ---------- Start ---------- */
const port = Number(process.env.PORT || 4000);
app.listen(port, () => {
  console.log(
    `API listening on http://localhost:${port} (public base: ${(process.env.API_PUBLIC_URL || "").replace(/\/+$/, "") || "inferred"})`
  );
});
