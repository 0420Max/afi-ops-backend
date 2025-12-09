/**
 * AFI OPS Backend (Render / Local)
 * ------------------------------------------------------------
 * FEATURES:
 * ✅ Health check
 * ✅ Twilio Voice Token (JWT moderne, avec diagnostics)
 * ✅ TwiML Voice endpoint (outgoing + incoming)
 * ✅ Monday tickets proxy normalisé + cache TTL
 * ✅ Monday Create Ticket (Paperform -> topics)
 * ✅ Monday Upsert Ticket (front -> Monday)
 * ✅ Monday Resolve Ticket (front -> Monday)
 * ✅ Ticket lookup by AFI-ID or Hash
 * ✅ Transcript endpoints (POC safe, return 501 if not wired)
 * ✅ YouTube Search proxy (widget)
 * ✅ Outlook OAuth URL helper + callback + status (PKCE + session cookie)
 * ✅ Outlook emails fetch via Graph (+ optional filters)
 * ✅ Tidio config helper
 *
 * IMPORTANT:
 * - Monday API: items_page au niveau du board
 * - group_ids ne marche pas dans items_page -> filtre backend
 * - AFI Ticket ID est dérivé du monday item.id (Approche B)
 */

const express = require("express");
const twilio = require("twilio");
const axios = require("axios");
const cors = require("cors");
const crypto = require("crypto");
const session = require("express-session");
require("dotenv").config();

const app = express();

/* ============================================================
   CORS (FIX credentials + origins explicites)
============================================================ */
const allowedOrigins = [
  "https://cdpn.io",
  "https://codepen.io",
  "https://afi-ops-frontend.onrender.com",
  "http://localhost:5173",
  "http://localhost:3000",
];

function isAllowedOrigin(origin) {
  if (!origin) return true; // Postman / server-to-server / no-origin
  if (allowedOrigins.includes(origin)) return true;

  // allow CodePen hash subdomains like https://abc123.cdpn.io
  try {
    const u = new URL(origin);
    const host = u.hostname.toLowerCase();
    if (host.endsWith(".cdpn.io") || host.endsWith(".codepen.io")) return true;
  } catch (e) {}

  return false;
}

app.use(
  cors({
    origin(origin, cb) {
      if (isAllowedOrigin(origin)) return cb(null, true);
      return cb(new Error("Origin non autorisée: " + origin));
    },
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.options("*", cors());

app.use(express.json({ limit: "1mb" }));

/* ============================================================
   Session (cookie) for Outlook tokens + PKCE verifier
============================================================ */
const PORT = process.env.PORT || 10000;
const baseUrl =
  process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
const isProd = !!process.env.RENDER_EXTERNAL_URL;

// IMPORTANT for Render HTTPS proxy
if (isProd) app.set("trust proxy", 1);

app.use(
  session({
    name: "afiops.sid",
    secret: process.env.SESSION_SECRET || "afi-ops-dev-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      // cross-site fetch (CodePen) needs SameSite=None + Secure
      sameSite: isProd ? "none" : "lax",
      secure: isProd,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  })
);

/* ============================================================
   ENV / CONFIG SNAPSHOT
============================================================ */
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_API_KEY,
  TWILIO_API_SECRET,
  TWILIO_TWIML_APP_SID,
  TWILIO_PHONE_NUMBER,

  MONDAY_TOKEN,
  MONDAY_BOARD_ID,
  MONDAY_GROUP_ID,
  MONDAY_TTL_MS: MONDAY_TTL_MS_ENV,
  MONDAY_ITEMS_LIMIT: MONDAY_ITEMS_LIMIT_ENV,
  MONDAY_API_VERSION: MONDAY_API_VERSION_ENV,

  OUTLOOK_CLIENT_ID,
  OUTLOOK_TENANT_ID,
  OUTLOOK_CLIENT_SECRET,
  OUTLOOK_REDIRECT_URI,

  TIDIO_PROJECT_ID,
  TWILIO_TOKEN_TTL,
  YOUTUBE_API_KEY,
} = process.env;

const MONDAY_TTL_MS = Number(MONDAY_TTL_MS_ENV || 25000);
const MONDAY_ITEMS_LIMIT = Number(MONDAY_ITEMS_LIMIT_ENV || 50);

const DEFAULT_BOARD_ID = Number(MONDAY_BOARD_ID || 18290169368);
const DEFAULT_GROUP_ID = String(MONDAY_GROUP_ID || "topics");
const MONDAY_API_VERSION = MONDAY_API_VERSION_ENV || "2023-10";

const TWILIO_ENABLED =
  !!TWILIO_ACCOUNT_SID &&
  !!TWILIO_API_KEY &&
  !!TWILIO_API_SECRET &&
  !!TWILIO_TWIML_APP_SID;

/* ============================================================
   UTIL: AFI ID DERIVATION (Approche B)
============================================================ */
function toAfiTicketId(mondayItemId) {
  const n = Number(mondayItemId || 0);
  const padded = String(n).padStart(4, "0");
  return `AFI-${padded}`;
}

/* ============================================================
   LOG ENV CHECK
============================================================ */
console.log("🚀 AFI OPS Backend starting...");
console.log("ENV vars loaded:", {
  TWILIO_ACCOUNT_SID: TWILIO_ACCOUNT_SID ? "✓" : "✗",
  TWILIO_API_KEY: TWILIO_API_KEY ? "✓(SK...)" : "✗",
  TWILIO_API_SECRET: TWILIO_API_SECRET ? "✓" : "✗",
  TWILIO_TWIML_APP_SID: TWILIO_TWIML_APP_SID ? "✓(AP...)" : "✗",
  TWILIO_PHONE_NUMBER: TWILIO_PHONE_NUMBER ? "✓" : "✗",

  MONDAY_TOKEN: MONDAY_TOKEN ? "✓" : "✗",
  MONDAY_BOARD_ID: MONDAY_BOARD_ID ? "✓" : "⚠️ fallback Services v3",
  MONDAY_GROUP_ID: MONDAY_GROUP_ID ? `✓ (${MONDAY_GROUP_ID})` : "default topics",
  MONDAY_TTL_MS: MONDAY_TTL_MS_ENV ? `✓ (${MONDAY_TTL_MS_ENV})` : "default 25s",
  MONDAY_ITEMS_LIMIT: MONDAY_ITEMS_LIMIT_ENV
    ? `✓ (${MONDAY_ITEMS_LIMIT_ENV})`
    : "default 50",
  MONDAY_API_VERSION: MONDAY_API_VERSION,

  OUTLOOK_CLIENT_ID: OUTLOOK_CLIENT_ID ? "✓" : "✗",
  OUTLOOK_TENANT_ID: OUTLOOK_TENANT_ID ? "✓" : "✗",
  OUTLOOK_CLIENT_SECRET: OUTLOOK_CLIENT_SECRET ? "✓" : "✗",
  OUTLOOK_REDIRECT_URI:
    OUTLOOK_REDIRECT_URI || "⚠️ default /api/outlook/callback",

  TIDIO_PROJECT_ID: TIDIO_PROJECT_ID ? "✓" : "✗",
  YOUTUBE_API_KEY: YOUTUBE_API_KEY ? "✓" : "✗",

  TWILIO_TOKEN_TTL: TWILIO_TOKEN_TTL
    ? `✓ (${TWILIO_TOKEN_TTL}s)`
    : "default 3600s",
  SAME_SITE: isProd ? "none" : "lax",
});

if (!TWILIO_ENABLED) {
  console.warn(
    "⚠️ Twilio not fully configured. Softphone endpoints will return 503 until env vars are fixed."
  );
}

/* ============================================================
   0) HEALTH CHECK
============================================================ */
app.get("/", (req, res) => {
  const tokens = req.session?.outlookTokens || null;

  res.json({
    status: "AFI OPS Backend OK",
    timestamp: new Date().toISOString(),
    baseUrl,
    services: {
      twilio: TWILIO_ENABLED ? "ready" : "disabled",
      monday: !!MONDAY_TOKEN ? "ready" : "missing_token",
      outlook:
        OUTLOOK_CLIENT_ID && OUTLOOK_TENANT_ID
          ? tokens?.access_token
            ? "connected"
            : "configured_not_connected"
          : "not_configured",
      tidio: !!TIDIO_PROJECT_ID ? "ready" : "not_configured",
      youtube: !!YOUTUBE_API_KEY ? "ready" : "missing_key",
      transcript: "poc_safe",
    },
  });
});

/* ============================================================
   0.1) TWILIO HEALTH (debug)
============================================================ */
app.get("/api/twilio/health", (req, res) => {
  if (!TWILIO_ENABLED) {
    return res.status(503).json({
      ok: false,
      errorCode: "TWILIO_CONFIG_INCOMPLETE",
      message:
        "Twilio env vars are incomplete. Check TWILIO_ACCOUNT_SID, TWILIO_API_KEY, TWILIO_API_SECRET, TWILIO_TWIML_APP_SID.",
    });
  }

  res.json({
    ok: true,
    twilio: {
      accountSid: TWILIO_ACCOUNT_SID.replace(/^(.{6}).+$/, "$1…"),
      twimlAppSid: TWILIO_TWIML_APP_SID.replace(/^(.{4}).+$/, "$1…"),
      tokenTtlSeconds: Number(TWILIO_TOKEN_TTL || 3600),
    },
  });
});

/* ============================================================
   1) TWILIO TOKEN (VoIP)
============================================================ */
app.post("/api/twilio-token", (req, res) => {
  try {
    console.log("[Twilio] 🔐 Token request received...");

    if (!TWILIO_ENABLED) {
      console.warn("[Twilio] ❌ Not configured, rejecting.");
      return res.status(503).json({
        errorCode: "TWILIO_CONFIG_INCOMPLETE",
        error:
          "Twilio is not fully configured on the backend. Check TWILIO_* env vars.",
      });
    }

    const AccessToken = twilio.jwt.AccessToken;
    const VoiceGrant = AccessToken.VoiceGrant;
    const identity = req.body?.identity || "afi-agent";

    const ttl = Number(TWILIO_TOKEN_TTL || 3600);
    const token = new AccessToken(
      TWILIO_ACCOUNT_SID,
      TWILIO_API_KEY,
      TWILIO_API_SECRET,
      { identity, ttl }
    );

    token.addGrant(
      new VoiceGrant({
        outgoingApplicationSid: TWILIO_TWIML_APP_SID,
        incomingAllow: true,
      })
    );

    res.json({
      token: token.toJwt(),
      identity,
      accountSid: TWILIO_ACCOUNT_SID,
      phoneNumber: TWILIO_PHONE_NUMBER || null,
      voiceUrl: `${baseUrl}/api/voice`,
      ttlSeconds: ttl,
    });
  } catch (e) {
    console.error("[Twilio] ❌ Token Error:", e);
    res.status(500).json({
      errorCode: "TWILIO_TOKEN_ERROR",
      error: e.message || "Failed to generate Twilio token",
    });
  }
});

/* ============================================================
   2) TWIML VOICE
============================================================ */
app.post("/api/voice", (req, res) => {
  try {
    console.log("[Voice] 📞 Incoming TwiML request...");

    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();
    const { To } = req.body || {};

    if (!TWILIO_ENABLED) {
      response.say(
        "Le service d'appel AFI OPS n'est pas disponible pour le moment."
      );
      res.type("text/xml");
      return res.send(response.toString());
    }

    if (To) {
      const dial = response.dial({
        callerId: TWILIO_PHONE_NUMBER,
        timeout: 30,
      });

      if (/^[\d\+\-\(\) ]+$/.test(To)) dial.number(To);
      else dial.client(To);
    } else {
      response.say("Merci d'appeler AFI OPS. Aucun destinataire spécifié.");
    }

    res.type("text/xml");
    res.send(response.toString());
  } catch (e) {
    console.error("[Voice] ❌ TwiML Error:", e);
    res.status(500).json({
      errorCode: "TWILIO_TWIML_ERROR",
      error: e.message || "Failed to generate TwiML",
    });
  }
});

/* ============================================================
   3) MONDAY HELPERS
============================================================ */
const MONDAY_URL = "https://api.monday.com/v2";

function mondayHeaders() {
  if (!MONDAY_TOKEN) throw new Error("Missing MONDAY_TOKEN");
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${MONDAY_TOKEN}`,
    "API-Version": MONDAY_API_VERSION,
  };
}

async function mondayRequest(query, variables) {
  const res = await axios.post(
    MONDAY_URL,
    { query, variables },
    { headers: mondayHeaders(), timeout: 15000 }
  );
  return res.data;
}

/* ============================================================
   4) MONDAY TICKETS PROXY + CACHE TTL
============================================================ */
const mondayCache = {
  data: null,
  expiresAt: 0,
  lastBoardId: null,
  lastGroupId: null,
};

app.get("/api/monday/tickets", async (req, res) => {
  console.log("[API] 📅 Fetching tickets from Monday...");

  const now = Date.now();
  const boardId = Number(req.query.boardId || DEFAULT_BOARD_ID);
  const groupId = String(req.query.groupId || DEFAULT_GROUP_ID);

  if (
    mondayCache.data &&
    mondayCache.expiresAt > now &&
    mondayCache.lastBoardId === boardId &&
    mondayCache.lastGroupId === groupId
  ) {
    return res.json(mondayCache.data);
  }

  const query = `
    query ($boardId: ID!, $limit: Int!) {
      boards(ids: [$boardId]) {
        id
        name
        items_page(limit: $limit) {
          items {
            id
            name
            updated_at
            group { id title }
            column_values { id text type value }
          }
        }
      }
    }
  `;

  try {
    const data = await mondayRequest(query, {
      boardId,
      limit: MONDAY_ITEMS_LIMIT,
    });

    if (data.errors) return res.status(400).json({ errors: data.errors });

    const board = data?.data?.boards?.[0];
    const rawItems = board?.items_page?.items || [];

    const normalized = rawItems.map((item) => {
      const cols = item.column_values || [];
      const colMap = {};
      cols.forEach((col) => {
        colMap[col.id] = {
          id: col.id,
          text: col.text,
          type: col.type,
          value: col.value,
        };
      });

      const afi_ticket_id = toAfiTicketId(item.id);

      return {
        id: item.id,
        afi_ticket_id,
        name: item.name,
        updated_at: item.updated_at,
        group: item.group || null,
        column_values: colMap,
      };
    });

    const items =
      groupId === "all"
        ? normalized
        : normalized.filter((it) => it.group?.id === groupId);

    const payload = { items };

    mondayCache.data = payload;
    mondayCache.expiresAt = now + MONDAY_TTL_MS;
    mondayCache.lastBoardId = boardId;
    mondayCache.lastGroupId = groupId;

    res.json(payload);
  } catch (error) {
    console.error("[API] ❌ Monday fetch error:", error.message);
    res.status(500).json({
      error: "Failed to fetch Monday tickets",
      details: error.message,
    });
  }
});

/* ============================================================
   4.1) LOOKUP BY AFI ID OR HASH
============================================================ */
app.get("/api/monday/ticket-by-key", async (req, res) => {
  try {
    const afiId = String(req.query.afiId || "").trim();
    const hash = String(req.query.hash || "").trim();

    if (!afiId && !hash) {
      return res.status(400).json({ error: "afiId or hash required" });
    }

    const query = `
      query ($boardId: ID!, $limit: Int!) {
        boards(ids: [$boardId]) {
          items_page(limit: $limit) {
            items {
              id
              name
              updated_at
              group { id title }
              column_values { id text type value }
            }
          }
        }
      }
    `;

    const data = await mondayRequest(query, {
      boardId: DEFAULT_BOARD_ID,
      limit: MONDAY_ITEMS_LIMIT,
    });

    if (data.errors) return res.status(400).json({ errors: data.errors });

    const rawItems = data?.data?.boards?.[0]?.items_page?.items || [];

    const normalized = rawItems.map((item) => {
      const cols = item.column_values || [];
      const colMap = {};
      cols.forEach((col) => {
        colMap[col.id] = col;
      });
      return {
        id: item.id,
        afi_ticket_id: toAfiTicketId(item.id),
        name: item.name,
        updated_at: item.updated_at,
        group: item.group || null,
        column_values: colMap,
      };
    });

    let found = null;

    if (afiId) {
      found = normalized.find(
        (it) => it.afi_ticket_id.toLowerCase() === afiId.toLowerCase()
      );
    }

    if (!found && hash) {
      found = normalized.find((it) => {
        const h = it.column_values?.text_mkx5q1ss?.text || "";
        return h.includes(hash);
      });
    }

    if (!found) return res.status(404).json({ error: "ticket not found" });

    res.json({ ok: true, ticket: found });
  } catch (e) {
    console.error("[API] ❌ ticket-by-key failed:", e.message);
    res.status(500).json({
      ok: false,
      error: "ticket-by-key failed",
      details: e.message,
    });
  }
});

/* ============================================================
   5) MONDAY CREATE / UPSERT / RESOLVE
============================================================ */
const INTENT_MAP = {
  service: "🔧 Service",
  warranty: "🛡️ Garantie",
  parts: "🔩 Pièce",
  quote: "💰 Soumission",
};
const LANGUAGE_MAP = { fr: "🃏 Français", en: "🇬🇧 English" };

app.post("/api/monday/create-ticket", async (req, res) => {
  console.log("[API] 🧾 Creating Monday ticket...");

  const boardId = Number(req.body.boardId || DEFAULT_BOARD_ID);
  const groupId = String(req.body.groupId || DEFAULT_GROUP_ID);

  const {
    full_name,
    phone,
    email,
    address,
    issue_description,
    intent,
    language,
    ticket_hash,
    zap_meta_timestamp,
  } = req.body || {};

  if (!full_name || !intent) {
    return res.status(400).json({
      error: "Missing required fields: full_name, intent",
    });
  }

  const mapped_intent = INTENT_MAP[intent] || intent;
  const mapped_language = LANGUAGE_MAP[language] || language;
  const item_name = `Ticket AFI – ${full_name} – ${intent}`;

  const column_values = {
    text_mkx51q5v: full_name || "",
    phone_mkx5xy3x: phone || "",
    email_mkx53410: email || "",
    text_mkx528gx: address || "",
    long_text_mkx59qsr: issue_description || "",
    status: mapped_intent,
    color_mkx5e9jt: mapped_language,
    date_mkx5asat:
      zap_meta_timestamp || new Date().toISOString().split("T")[0],
    text_mkx5q1ss: ticket_hash || "",
  };

  const mutation = `
    mutation ($boardId: ID!, $groupId: String!, $itemName: String!, $cols: JSON!) {
      create_item(
        board_id: $boardId,
        group_id: $groupId,
        item_name: $itemName,
        column_values: $cols
      ) { id name }
    }
  `;

  try {
    const data = await mondayRequest(mutation, {
      boardId,
      groupId,
      itemName: item_name,
      cols: JSON.stringify(column_values),
    });

    if (data.errors) return res.status(400).json({ errors: data.errors });
    mondayCache.data = null;

    const created = data?.data?.create_item;
    const afi_ticket_id = toAfiTicketId(created?.id);

    res.json({
      ok: true,
      item: created,
      afi_ticket_id,
      item_name,
      column_values,
      boardId,
      groupId,
    });
  } catch (e) {
    console.error("[API] ❌ Create ticket failed:", e.message);
    res.status(500).json({
      ok: false,
      error: "Failed to create Monday ticket",
      details: e.message,
    });
  }
});

app.post("/api/monday/upsert-ticket", async (req, res) => {
  console.log("[API] ♻️ Upserting Monday ticket...");

  try {
    const { ticket, ticketId } = req.body || {};
    if (!ticketId && !ticket?.id) {
      return res.status(400).json({ error: "ticketId missing" });
    }

    const itemId = String(ticket?.mondayItemId || ticketId || ticket?.id);

    const colVals = {
      long_text_mkx59qsr:
        ticket?.issue_description ||
        ticket?.problem ||
        ticket?.raw?.long_text_mkx59qsr ||
        "",
    };

    const mutation = `
      mutation ($itemId: ID!, $cols: JSON!) {
        change_multiple_column_values(
          item_id: $itemId,
          board_id: ${DEFAULT_BOARD_ID},
          column_values: $cols
        ) { id }
      }
    `;

    const data = await mondayRequest(mutation, {
      itemId,
      cols: JSON.stringify(colVals),
    });

    if (data.errors) return res.status(400).json({ errors: data.errors });
    mondayCache.data = null;

    res.json({
      ok: true,
      itemId,
      afi_ticket_id: toAfiTicketId(itemId),
      status: "updated",
    });
  } catch (e) {
    console.error("[API] ❌ Upsert failed:", e.message);
    res.status(500).json({
      ok: false,
      error: "Failed to upsert Monday ticket",
      details: e.message,
    });
  }
});

app.post("/api/monday/resolve-ticket", async (req, res) => {
  console.log("[API] ✅ Resolving Monday ticket...");

  try {
    const { ticketId, mondayItemId } = req.body || {};
    const itemId = String(mondayItemId || ticketId);
    if (!itemId) return res.status(400).json({ error: "ticketId missing" });

    const colVals = { color_mkx55mz3: "✅ Résolu" };

    const mutation = `
      mutation ($itemId: ID!, $cols: JSON!) {
        change_multiple_column_values(
          item_id: $itemId,
          board_id: ${DEFAULT_BOARD_ID},
          column_values: $cols
        ) { id }
      }
    `;

    const data = await mondayRequest(mutation, {
      itemId,
      cols: JSON.stringify(colVals),
    });

    if (data.errors) return res.status(400).json({ errors: data.errors });
    mondayCache.data = null;

    res.json({
      ok: true,
      itemId,
      afi_ticket_id: toAfiTicketId(itemId),
      status: "resolved",
    });
  } catch (e) {
    console.error("[API] ❌ Resolve failed:", e.message);
    res.status(500).json({
      ok: false,
      error: "Failed to resolve Monday ticket",
      details: e.message,
    });
  }
});

/* ============================================================
   6) TRANSCRIPT ENDPOINTS (POC SAFE)
============================================================ */
app.get("/api/transcript/active", (req, res) => {
  res.status(501).json({
    ok: false,
    errorCode: "TRANSCRIPT_NOT_IMPLEMENTED",
    message: "Transcript backend not wired yet.",
    text: "",
  });
});
app.get("/api/transcript/by-sid", (req, res) => {
  res.status(501).json({
    ok: false,
    errorCode: "TRANSCRIPT_NOT_IMPLEMENTED",
    message: "Transcript backend not wired yet.",
    text: "",
  });
});

/* ============================================================
   7) OUTLOOK AUTH (PKCE) + CALLBACK + STATUS + EMAILS
============================================================ */
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const OUTLOOK_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "Mail.Read",
  "Mail.Send",
].join(" ");

function base64UrlEncode(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
function sha256(verifier) {
  return crypto.createHash("sha256").update(verifier).digest();
}
function buildPkcePair() {
  const verifier = base64UrlEncode(crypto.randomBytes(32));
  const challenge = base64UrlEncode(sha256(verifier));
  return { verifier, challenge, method: "S256" };
}
function getRedirectUri() {
  return (
    OUTLOOK_REDIRECT_URI ||
    `${baseUrl.replace(/\/$/, "")}/api/outlook/callback`
  );
}
function outlookConfigured() {
  return !!OUTLOOK_CLIENT_ID && !!OUTLOOK_TENANT_ID;
}

async function refreshOutlookTokenIfNeeded(req) {
  const tokens = req.session?.outlookTokens;
  if (!tokens?.refresh_token) return null;

  const now = Date.now();
  const obtainedAt = tokens.obtained_at || 0;
  const expiresInMs = (tokens.expires_in || 0) * 1000;
  const stillValid = obtainedAt + expiresInMs - 60_000 > now;

  if (stillValid && tokens.access_token) return tokens;

  const tokenUrl = `https://login.microsoftonline.com/${OUTLOOK_TENANT_ID}/oauth2/v2.0/token`;
  const params = new URLSearchParams({
    client_id: OUTLOOK_CLIENT_ID,
    client_secret: OUTLOOK_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    redirect_uri: getRedirectUri(),
    scope: OUTLOOK_SCOPES,
  });

  const r = await axios.post(tokenUrl, params.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 15000,
  });

  const newTokens = {
    ...tokens,
    ...r.data,
    obtained_at: Date.now(),
  };

  req.session.outlookTokens = newTokens;
  return newTokens;
}

app.get("/api/outlook-auth", (req, res) => {
  try {
    console.log("[Outlook] 🔐 Building OAuth URL (PKCE)...");

    if (!outlookConfigured()) {
      return res.status(500).json({
        errorCode: "OUTLOOK_CONFIG_INCOMPLETE",
        error: "Missing OUTLOOK_CLIENT_ID or OUTLOOK_TENANT_ID",
      });
    }

    // Store returnUrl for UX after login (used by frontend)
    const returnUrl = String(req.query.returnUrl || "").trim();
    if (returnUrl) {
      req.session.outlookReturnUrl = returnUrl;
    }

    const { verifier, challenge, method } = buildPkcePair();
    req.session.pkce = { verifier, challenge, method, created_at: Date.now() };

    const redirectUri = getRedirectUri();
    const authUrl =
      `https://login.microsoftonline.com/${OUTLOOK_TENANT_ID}` +
      `/oauth2/v2.0/authorize?client_id=${OUTLOOK_CLIENT_ID}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&response_type=code` +
      `&response_mode=query` +
      `&scope=${encodeURIComponent(OUTLOOK_SCOPES)}` +
      `&code_challenge=${challenge}` +
      `&code_challenge_method=${method}`;

    if (req.query.redirect === "1") {
      return res.redirect(authUrl);
    }

    return res.json({ url: authUrl });
  } catch (e) {
    console.error("[Outlook] auth error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/outlook/callback", async (req, res) => {
  try {
    const { code, error, error_description } = req.query;

    if (error) {
      return res
        .status(400)
        .send(
          `<h1>Outlook - Erreur</h1><p>${error_description || error}</p>`
        );
    }
    if (!code) {
      return res.status(400).send("<h1>Outlook - Code manquant</h1>");
    }
    if (!OUTLOOK_CLIENT_ID || !OUTLOOK_CLIENT_SECRET || !OUTLOOK_TENANT_ID) {
      return res
        .status(500)
        .send("<h1>Outlook non configuré côté backend.</h1>");
    }

    const pkceVerifier = req.session?.pkce?.verifier;
    if (!pkceVerifier) {
      return res
        .status(400)
        .send("<h1>PKCE verifier manquant. Recommence le login.</h1>");
    }

    const tokenUrl = `https://login.microsoftonline.com/${OUTLOOK_TENANT_ID}/oauth2/v2.0/token`;
    const params = new URLSearchParams({
      client_id: OUTLOOK_CLIENT_ID,
      client_secret: OUTLOOK_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: getRedirectUri(),
      code_verifier: pkceVerifier,
      scope: OUTLOOK_SCOPES,
    });

    const tokenRes = await axios.post(tokenUrl, params.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 15000,
    });

    const rawTokens = {
      ...tokenRes.data,
      obtained_at: Date.now(),
    };

    let account = null;
    try {
      const meRes = await axios.get(`${GRAPH_BASE}/me`, {
        headers: { Authorization: `Bearer ${rawTokens.access_token}` },
        timeout: 12000,
      });
      const me = meRes.data || {};
      account = {
        displayName: me.displayName || "",
        mail: me.mail || me.userPrincipalName || "",
        userPrincipalName: me.userPrincipalName || "",
      };
    } catch (profileErr) {
      console.warn("[Outlook] ⚠️ Cannot fetch /me profile:", profileErr.message);
      account = { displayName: "", mail: "", userPrincipalName: "" };
    }

    req.session.outlookTokens = { ...rawTokens, account };
    req.session.pkce = null;

    const returnUrl = req.session.outlookReturnUrl || "";

    res.send(`
      <html>
        <body style="background:#020617;color:#e5e7eb;font-family:-apple-system,system-ui;padding:32px">
          <h1>Outlook connecté ✅</h1>
          <p>Tu peux fermer cette fenêtre et revenir à AFI OPS Cockpit.</p>

          ${
            returnUrl
              ? `<p><a href="${returnUrl}" style="color:#60a5fa">↩ Retour au cockpit</a></p>`
              : ""
          }

          <script>
            try {
              if (window.opener) {
                // NEW: bridge message for current frontend
                window.opener.postMessage({ type: "outlook_oauth_done" }, "*");
                // Legacy/compat
                window.opener.postMessage({ type: "OUTLOOK_CONNECTED" }, "*");
                window.close();
              }
            } catch (e) {}
          </script>
        </body>
      </html>
    `);
  } catch (e) {
    console.error("[Outlook] callback error:", e.message);
    res
      .status(500)
      .send("<h1>Erreur lors de la récupération du token Outlook.</h1>");
  }
});

app.get("/api/outlook-status", async (req, res) => {
  try {
    if (!outlookConfigured()) {
      return res.json({ connected: false, reason: "not_configured" });
    }

    const tokens = await refreshOutlookTokenIfNeeded(req);
    if (!tokens?.access_token) return res.json({ connected: false });

    const account = tokens.account || {
      displayName: "",
      mail: "",
      userPrincipalName: "",
    };

    return res.json({
      connected: true,
      account: {
        displayName: account.displayName,
        mail: account.mail || account.userPrincipalName,
      },
    });
  } catch (e) {
    console.error("[Outlook] status error:", e.message);
    res.status(500).json({ connected: false, error: e.message });
  }
});

async function handleOutlookEmails(req, res) {
  try {
    if (!outlookConfigured()) {
      return res.status(500).json({
        errorCode: "OUTLOOK_NOT_CONFIGURED",
        error: "Outlook env vars missing.",
        items: [],
      });
    }

    const tokens = await refreshOutlookTokenIfNeeded(req);
    if (!tokens?.access_token) {
      return res.status(401).json({
        errorCode: "OUTLOOK_NOT_CONNECTED",
        error: "No Outlook session token found. Call /api/outlook-auth first.",
        items: [],
      });
    }

    const clientEmail = String(req.query.email || "").trim();
    const ticketId = String(req.query.ticketId || "").trim();

    const filters = [];

    if (ticketId) {
      const safeTicket = ticketId.replace(/'/g, "''");
      filters.push(`contains(subject,'${safeTicket}')`);
    }

    if (clientEmail) {
      const safeEmail = clientEmail.replace(/'/g, "''");
      filters.push(
        `(from/emailAddress/address eq '${safeEmail}' or toRecipients/any(r:r/emailAddress/address eq '${safeEmail}'))`
      );
    }

    const params = new URLSearchParams({
      $top: "20",
      $select: "subject,from,receivedDateTime,bodyPreview,webLink",
      $orderby: "receivedDateTime desc",
    });
    if (filters.length > 0) params.set("$filter", filters.join(" and "));

    const url = `${GRAPH_BASE}/me/messages?${params.toString()}`;

    const graphRes = await axios.get(url, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
      timeout: 15000,
    });

    const items = (graphRes.data?.value || []).map((m) => {
      const fromName =
        m?.from?.emailAddress?.name ||
        m?.from?.emailAddress?.address ||
        "";
      return {
        id: m.id,
        subject: m.subject || "",
        from: fromName,
        preview: m.bodyPreview || "",
        receivedAt: m.receivedDateTime || "",
        link: m.webLink || "",
      };
    });

    return res.json(items);
  } catch (e) {
    console.error("[Outlook] emails error:", e.message);
    res.status(500).json({
      errorCode: "OUTLOOK_MESSAGES_ERROR",
      error: e.message || "Failed to fetch Outlook messages",
      items: [],
    });
  }
}

app.get("/api/outlook-emails", handleOutlookEmails);
app.get("/api/outlook-messages", handleOutlookEmails);

/* ============================================================
   8) TIDIO CONFIG
============================================================ */
app.get("/api/tidio-config", (req, res) => {
  try {
    if (!TIDIO_PROJECT_ID) {
      return res.status(500).json({
        errorCode: "TIDIO_CONFIG_INCOMPLETE",
        error: "Missing TIDIO_PROJECT_ID",
      });
    }
    res.json({ projectId: TIDIO_PROJECT_ID });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ============================================================
9) YOUTUBE SEARCH (widget)
============================================================ */

const YT_CACHE_TTL_MS = 60_000;
const ytCache = new Map();

async function handleYoutubeSearch(req, res) {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) return res.json({ items: [] });

    if (!YOUTUBE_API_KEY) {
      return res.status(503).json({
        errorCode: "YOUTUBE_KEY_MISSING",
        error: "Missing YOUTUBE_API_KEY in backend env.",
        items: [],
      });
    }

    const cacheKey = q.toLowerCase();
    const now = Date.now();
    const cached = ytCache.get(cacheKey);

    if (cached && cached.expiresAt > now) {
      return res.json({ items: cached.items, cached: true });
    }

    const url = new URL("https://www.googleapis.com/youtube/v3/search");
    url.searchParams.set("part", "snippet");
    url.searchParams.set("type", "video");
    url.searchParams.set("maxResults", "8");
    url.searchParams.set("q", q);
    url.searchParams.set("key", YOUTUBE_API_KEY);
    url.searchParams.set("safeSearch", "strict");

    const r = await axios.get(url.toString(), { timeout: 12000 });
    const data = r.data || {};

    const items = (data.items || [])
      .map((x) => {
        const id = x?.id?.videoId;
        const sn = x?.snippet || {};
        if (!id) return null;

        return {
          id,
          title: sn.title || "Video",
          thumb:
            sn.thumbnails?.medium?.url ||
            sn.thumbnails?.default?.url ||
            "",
          channelTitle: sn.channelTitle || "",
          publishedAt: sn.publishedAt || "",
        };
      })
      .filter(Boolean);

    ytCache.set(cacheKey, {
      items,
      expiresAt: now + YT_CACHE_TTL_MS,
    });

    res.json({ items });
  } catch (e) {
    console.error("[YouTube] search error:", e.message);
    res.status(500).json({
      errorCode: "YOUTUBE_SEARCH_ERROR",
      error: e.message || "YouTube search failed",
      items: [],
    });
  }
}

// Route principale utilisée par le front actuel
app.get("/api/youtube/search", handleYoutubeSearch);

// Alias routes pour l'ancien front si besoin
app.get("/api/youtube-search", handleYoutubeSearch);

// Alias Outlook pour compatibilité legacy
app.get("/api/outlook/auth-url", (req, res) =>
  res.redirect("/api/outlook-auth")
);
app.get("/api/outlook/messages", handleOutlookEmails);

/* ============================================================
   10) ERROR HANDLING
============================================================ */
app.use((err, req, res, next) => {
  console.error("[Error]", err);
  res.status(500).json({
    error: "Internal server error",
    details: err.message,
  });
});

/* ============================================================
   11) START SERVER
============================================================ */
app.listen(PORT, () => {
  console.log(`✅ Backend running on port ${PORT}`);
  console.log(`📍 URL: ${baseUrl}`);
  console.log(`📞 TwiML Voice URL: ${baseUrl}/api/voice`);
  console.log(`📧 Outlook callback URL: ${baseUrl}/api/outlook/callback`);
});
