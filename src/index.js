// src/index.js
import express from "express";
import cors from "cors";
import morgan from "morgan";
import bodyParser from "body-parser";

import {
  generateNewsletter,
  sendTestEmail,
  getEmailHealth,
  getSubscriberSummary,
  getHookStatus,
} from "./generator.js";

const app = express();

// ---------- Config ----------
const PORT = process.env.PORT || 3000;
const FRONTEND_ORIGINS = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// ---------- Middleware ----------
app.use(morgan("tiny"));
app.use(bodyParser.json({ limit: "1mb" }));

app.use(
  cors({
    origin: (origin, cb) => {
      // Allow non-browser tools and local dev if no CORS_ORIGINS set
      if (!origin) return cb(null, true);
      if (FRONTEND_ORIGINS.length === 0) return cb(null, true);
      return FRONTEND_ORIGINS.includes(origin)
        ? cb(null, true)
        : cb(new Error("CORS blocked: origin not in allow-list"));
    },
    credentials: false,
  })
);

// ---------- Health ----------
app.get("/", (_req, res) => {
  res.json({
    message: "SFP Newsletter Automation API v2.0",
    schedule: {
      scraping: "4:45 PM AEST daily",
      newsletter: "5:00 PM AEST daily",
    },
    endpoints: {
      health: "GET /",
      status: "GET /api/status",
      emailStatus: "GET /api/email-status",
      subscribers: "GET /api/subscribers",
      hooks: "GET /api/hooks",
      generate: "POST /api/newsletter/generate/:segment",
      test: "POST /api/newsletter/test",
    },
    timestamp: new Date().toISOString(),
  });
});

// ---------- Dashboard cards ----------
app.get("/api/status", (_req, res) => {
  res.json({
    success: true,
    uptimeSeconds: Math.floor(process.uptime()),
    node: process.version,
    env: {
      resendConfigured: !!process.env.RESEND_API_KEY,
      openaiConfigured: !!process.env.OPENAI_API_KEY,
      fromEmail: process.env.FROM_EMAIL || null,
      sheetsId: process.env.GOOGLE_SHEETS_ID || null,
    },
    now: new Date().toISOString(),
  });
});

app.get("/api/email-status", async (_req, res) => {
  try {
    const s = await getEmailHealth();
    res.json({ success: true, ...s });
  } catch (err) {
    res.status(200).json({
      success: false,
      error: err.message || "Unable to fetch email status",
    });
  }
});

app.get("/api/subscribers", async (_req, res) => {
  try {
    const s = await getSubscriberSummary();
    res.json({ success: true, ...s });
  } catch (err) {
    res.status(200).json({
      success: false,
      error: err.message || "Unable to fetch subscribers",
    });
  }
});

app.get("/api/hooks", (_req, res) => {
  res.json({ success: true, hooks: getHookStatus() });
});

// ---------- Generate (Preview) ----------
app.post("/api/newsletter/generate/:segment", async (req, res) => {
  try {
    const segment = String(req.params.segment || "pro");
    const limit = Number(req.body?.limit) || 12;
    const result = await generateNewsletter({ segment, dryRun: true, limit });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(err.statusCode || 500).json({
      success: false,
      error: err.publicMessage || err.message || "Generation failed",
      details: err.details || null,
      timestamp: new Date().toISOString(),
    });
  }
});

// ---------- Send Test Email ----------
app.post("/api/newsletter/test", async (req, res) => {
  try {
    const to = String(req.body?.to || "").trim();
    if (!to) return res.status(400).json({ success: false, error: "Missing 'to' email" });

    // Prefer provided payload; otherwise generate a fresh preview
    let { html, text, subject } = req.body || {};
    if (!html || !text || !subject) {
      const gen = await generateNewsletter({ segment: "pro", dryRun: true });
      html = gen.html; text = gen.text; subject = gen.subject;
    }

    const send = await sendTestEmail({ to, html, text, subject });
    res.json({ success: true, id: send?.id || null });
  } catch (err) {
    res.status(err.statusCode || 500).json({
      success: false,
      error: err.publicMessage || err.message || "Test send failed",
      details: err.details || null,
      timestamp: new Date().toISOString(),
    });
  }
});

// ---------- Fallback error handler ----------
app.use((err, _req, res, _next) => {
  res.status(500).json({
    success: false,
    error: err.message || "Unhandled error",
  });
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`SFP API listening on :${PORT}`);
});
