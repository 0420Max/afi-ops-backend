/**
 * AFI OPS Backend - server.js
 * - Express API
 * - Twilio Voice token + calls (stub)
 * - Monday.com proxy (stub)
 * - Outlook / MS Graph proxy (stub)
 * - Security / logging / health / rate limit
 *
 * IMPORTANT:
 * 1) Configure ton .env (voir bloc en bas)
 * 2) Aucun prix / donnée inventée: on ne fait que proxy/serve
 */

"use strict";

const path = require("path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const fetch = require("node-fetch"); // npm i node-fetch@2
const { Twilio } = require("twilio");
const twilioJwt = require("twilio").jwt;
const VoiceGrant = twilioJwt.AccessToken.VoiceGrant;
const AccessToken = twilioJwt.AccessToken;

require("dotenv").config();

// ----------------------
// ENV VALIDATION
// ----------------------
const requiredEnv = [
  "PORT",
  "NODE_ENV",
  // Twilio
  "TWILIO_ACCOUNT_SID",
  "TWILIO_API_KEY_SID",
  "TWILIO_API_KEY_SECRET",
  "TWILIO_APP_SID",
  // Monday
  "MONDAY_API_TOKEN",
  "MONDAY_BOARD_ID",
  // Outlook / Graph (si branché)
  "MS_GRAPH_CLIENT_ID",
  "MS_GRAPH_TENANT_ID",
  "MS_GRAPH_CLIENT_SECRET",
  // Front
  "FRONTEND_ORIGIN"
];

const missing = requiredEnv.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`❌ Missing ENV vars: ${missing.join(", ")}`);
  process.exit(1);
}

// ----------------------
// APP SETUP
// ----------------------
const app = express();
const PORT = Number(process.env.PORT || 8787);
const isProd = process.env.NODE_ENV === "production";

app.set("trust proxy", 1); // important si deploy sur render/vercel/etc

// Security headers
app.use(
  helmet({
    contentSecurityPolicy: false, // on laisse le front gérer CSP
    crossOriginEmbedderPolicy: false
  })
);

// CORS
app.use(
  cors({
    origin: process.env.FRONTEND_ORIGIN.split(",").map((s) => s.trim()),
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
  })
);

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// Logging
app.use(morgan(isProd ? "combined" : "dev"));

// Rate limit global
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 120, // 120 req/min
    standardHeaders: true,
    legacyHeaders: false
  })
);

// ----------------------
// HELPERS
// ----------------------
const safeJson = (res, code, payload) =>
  res.status(code).json({ ok: code < 400, ...payload });

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// ----------------------
// HEALTH / META
// ----------------------
app.get(
  "/health",
  asyncHandler(async (req, res) => {
    safeJson(res, 200, {
      service: "afi-ops-backend",
      env: process.env.NODE_ENV,
      time: new Date().toISOString()
    });
  })
);

// ----------------------
// TWILIO - VOICE TOKEN
// ----------------------
app.get(
  "/twilio/token",
  asyncHandler(async (req, res) => {
    const identity = req.query.identity || "afi_agent";

    const token = new AccessToken(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_API_KEY_SID,
      process.env.TWILIO_API_KEY_SECRET,
      { identity }
    );

    const voiceGrant = new VoiceGrant({
      outgoingApplicationSid: process.env.TWILIO_APP_SID,
      incomingAllow: true
    });

    token.addGrant(voiceGrant);

    safeJson(res, 200, { token: token.toJwt(), identity });
  })
);

// OPTIONAL: webhook Twilio status/calls (si tu veux logger)
app.post(
  "/twilio/webhook",
  asyncHandler(async (req, res) => {
    // Twilio enverra CallSid, CallStatus, From, To, etc.
    // Ici on log et on répond 200.
    console.log("📞 Twilio webhook:", req.body);
    res.status(200).send("ok");
  })
);

// ----------------------
// MONDAY.COM - PROXY
// ----------------------
const mondayHeaders = {
  Authorization: process.env.MONDAY_API_TOKEN,
  "Content-Type": "application/json"
};

app.post(
  "/monday/query",
  asyncHandler(async (req, res) => {
    const { query, variables } = req.body || {};

    if (!query) return safeJson(res, 400, { error: "Missing query" });

    const r = await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: mondayHeaders,
      body: JSON.stringify({ query, variables })
    });

    const data = await r.json();
    if (!r.ok || data.errors) {
      console.error("Monday error:", data);
      return safeJson(res, 502, { error: "Monday API error", details: data });
    }

    safeJson(res, 200, { data });
  })
);

// Exemple endpoint: tickets SAV (items du board)
app.get(
  "/monday/tickets",
  asyncHandler(async (req, res) => {
    const boardId = Number(process.env.MONDAY_BOARD_ID);

    const query = `
      query ($boardId: [ID!]) {
        boards (ids: $boardId) {
          id
          name
          items_page (limit: 50) {
            items {
              id
              name
              state
              group { id title }
              column_values {
                id
                text
                value
              }
              updated_at
              created_at
            }
          }
        }
      }
    `;

    const r = await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: mondayHeaders,
      body: JSON.stringify({ query, variables: { boardId } })
    });

    const data = await r.json();
    if (!r.ok || data.errors) {
      console.error("Monday tickets error:", data);
      return safeJson(res, 502, { error: "Monday API error", details: data });
    }

    safeJson(res, 200, { data });
  })
);

// ----------------------
// OUTLOOK / MS GRAPH - PROXY (stub safe)
// ----------------------
const graphTokenCache = {
  token: null,
  exp: 0
};

async function getGraphToken() {
  const now = Date.now();
  if (graphTokenCache.token && graphTokenCache.exp > now + 60000) {
    return graphTokenCache.token;
  }

  const tenant = process.env.MS_GRAPH_TENANT_ID;
  const url = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;

  const params = new URLSearchParams();
  params.append("client_id", process.env.MS_GRAPH_CLIENT_ID);
  params.append("client_secret", process.env.MS_GRAPH_CLIENT_SECRET);
  params.append("grant_type", "client_credentials");
  params.append("scope", "https://graph.microsoft.com/.default");

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params
  });

  const data = await r.json();
  if (!r.ok) {
    console.error("Graph token error:", data);
    throw new Error("MS Graph token error");
  }

  graphTokenCache.token = data.access_token;
  graphTokenCache.exp = now + data.expires_in * 1000;
  return data.access_token;
}

app.get(
  "/outlook/emails",
  asyncHandler(async (req, res) => {
    // Tu peux passer un filtre ex: ?from=client@x.com
    const token = await getGraphToken();

    // TODO: adapte aux mailbox/endpoint exacts.
    // Exemple simple: 20 derniers emails de la boîte support
    const graphUrl =
      "https://graph.microsoft.com/v1.0/users/" +
      encodeURIComponent(process.env.OUTLOOK_SUPPORT_USER || "me") +
      "/messages?$top=20&$orderby=receivedDateTime desc";

    const r = await fetch(graphUrl, {
      headers: { Authorization: `Bearer ${token}` }
    });

    const data = await r.json();
    if (!r.ok) {
      console.error("Graph emails error:", data);
      return safeJson(res, 502, { error: "MS Graph API error", details: data });
    }

    safeJson(res, 200, { data });
  })
);

// ----------------------
// STATIC (si tu veux servir un build local)
// ----------------------
if (process.env.SERVE_STATIC === "true") {
  const publicDir = path.join(__dirname, "public");
  app.use(express.static(publicDir));
  app.get("*", (req, res) => res.sendFile(path.join(publicDir, "index.html")));
}

// ----------------------
// 404
// ----------------------
app.use((req, res) => safeJson(res, 404, { error: "Not found" }));

// ----------------------
// ERROR HANDLER
// ----------------------
app.use((err, req, res, next) => {
  console.error("🔥 Backend error:", err);
  safeJson(res, 500, {
    error: "Internal server error",
    message: !isProd ? err.message : undefined
  });
});

// ----------------------
// START
// ----------------------
app.listen(PORT, () => {
  console.log(`✅ AFI OPS backend up on port ${PORT} (${process.env.NODE_ENV})`);
});
