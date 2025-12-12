/**
 * ============================================================
 * AFI OPS – Backend Central (Render / Local)
 * ============================================================
 * Console OPS AFI – Backend unifié
 *
 * FEATURES MAJEURES:
 * - CORS ultra-robuste (subdomains + dev)
 * - Health check / + /api/health
 * - Version endpoint /api/version (debug Render deploy)
 * - Twilio Voice (JWT + TwiML)
 * - Monday.com (tickets: fetch / create / upsert / resolve)
 * - Cache TTL Monday
 * - Zapier SMS proxy (anti-CORS)
 * - Tidio config helper
 * - YouTube Search proxy (widget)
 * - GPT (OpenAI Responses API) – analyze ticket + generate wrap
 * - Transcript endpoints (POC safe – 501)
 *
 * IMPORTANT:
 * - Aucun endpoint supprimé
 * - Aucune intégration rompue
 * - Prêt à être versionné tel quel
 * ============================================================
 */

const express = require("express");
const twilio = require("twilio");
const axios = require("axios");
const cors = require("cors");
require("dotenv").config();

const app = express();

/* ============================================================
0) CORS FIX – ULTRA ROBUSTE
============================================================ */
const allowedOrigins = [
  "https://cdpn.io",
  "https://codepen.io",
  "https://afi-ops.ca",
  "http://localhost:3000",
  "http://localhost:5173",
];

function isAllowed(origin) {
  if (!origin) return true;

  if (allowedOrigins.includes(origin)) return true;
  if (origin.endsWith(".cdpn.io") || origin.endsWith(".codepen.io")) return true;

  try {
    const u = new URL(origin);
    const host = u.hostname || "";
    if (host === "afi-ops.ca" || host.endsWith(".afi-ops.ca")) return true;
  } catch {}

  return false;
}

const corsOptions = {
  origin(origin, cb) {
    if (isAllowed(origin)) return cb(null, true);
    return cb(new Error("Not allowed by CORS: " + origin), false);
  },
  credentials: true,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json({ limit: "1mb" }));

/* ============================================================
1) ENV / BASE CONFIG
============================================================ */
const PORT = process.env.PORT || 10000;
const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

const {
  /* Twilio */
  TWILIO_ACCOUNT_SID,
  TWILIO_API_KEY,
  TWILIO_API_SECRET,
  TWILIO_TWIML_APP_SID,
  TWILIO_PHONE_NUMBER,
  TWILIO_TOKEN_TTL,

  /* Monday */
  MONDAY_TOKEN,
  MONDAY_BOARD_ID,
  MONDAY_GROUP_ID,
  MONDAY_TTL_MS,
  MONDAY_ITEMS_LIMIT,
  MONDAY_API_VERSION,

  /* Outlook (non utilisé ici, conservé pour compat future) */
  OUTLOOK_CLIENT_ID,
  OUTLOOK_TENANT_ID,
  OUTLOOK_CLIENT_SECRET,
  OUTLOOK_REDIRECT_URI,

  /* Other */
  TIDIO_PROJECT_ID,
  YOUTUBE_API_KEY,
  ZAPIER_SMS_WEBHOOK_URL,

  /* GPT */
  OPENAI_API_KEY,
  OPENAI_MODEL,
} = process.env;

const DEFAULT_BOARD_ID = Number(MONDAY_BOARD_ID || 1763228524);
const DEFAULT_GROUP_ID = String(MONDAY_GROUP_ID || "topics");
const MONDAY_LIMIT = Number(MONDAY_ITEMS_LIMIT || 50);
const MONDAY_TTL = Number(MONDAY_TTL_MS || 25000);
const MONDAY_VERSION = MONDAY_API_VERSION || "2023-10";

const TWILIO_ENABLED =
  !!TWILIO_ACCOUNT_SID &&
  !!TWILIO_API_KEY &&
  !!TWILIO_API_SECRET &&
  !!TWILIO_TWIML_APP_SID;

/* ============================================================
1.1) BUILD STAMP / RENDER DEBUG
============================================================ */
const STARTED_AT = new Date().toISOString();

// Render exposes some envs depending on config. We read safely.
const BUILD = {
  startedAt: STARTED_AT,
  node: process.version,
  baseUrl,
  render: {
    externalUrl: process.env.RENDER_EXTERNAL_URL || null,
    serviceId: process.env.RENDER_SERVICE_ID || null,
    instanceId: process.env.RENDER_INSTANCE_ID || null,
    gitCommit: process.env.RENDER_GIT_COMMIT || null,
    gitBranch: process.env.RENDER_GIT_BRANCH || null,
  },
  app: {
    // Optional: you can set these in Render env manually if you want a stable marker.
    buildTag: process.env.AFI_BUILD_TAG || null,
  },
};

/* ============================================================
2) HEALTH CHECKS + VERSION
============================================================ */
app.get("/", (req, res) => {
  res.json({
    status: "AFI OPS Backend OK",
    timestamp: new Date().toISOString(),
    baseUrl,
    build: BUILD,
  });
});

// New: version endpoint for “Render ne se met plus à jour”
app.get("/api/version", (req, res) => {
  res.json({
    ok: true,
    service: "afi-ops-backend",
    timestamp: new Date().toISOString(),
    build: BUILD,
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    timestamp: new Date().toISOString(),
    baseUrl,
    build: BUILD,
    services: {
      twilio: TWILIO_ENABLED ? "ready" : "disabled",
      monday: MONDAY_TOKEN ? "ready" : "missing_token",
      outlook:
        OUTLOOK_CLIENT_ID && OUTLOOK_TENANT_ID && OUTLOOK_CLIENT_SECRET
          ? "configured"
          : "not_configured",
      tidio: TIDIO_PROJECT_ID ? "ready" : "not_configured",
      youtube: YOUTUBE_API_KEY ? "ready" : "missing_key",
      zapier: ZAPIER_SMS_WEBHOOK_URL ? "ready" : "missing_webhook",
      gpt: OPENAI_API_KEY ? "ready" : "disabled",
      transcript: "poc_safe",
    },
  });
});

/* ============================================================
3) TWILIO – TOKEN + TWIML
============================================================ */
app.post("/api/twilio-token", (req, res) => {
  if (!TWILIO_ENABLED) {
    return res.status(503).json({
      errorCode: "TWILIO_CONFIG_INCOMPLETE",
      message: "Twilio env vars missing.",
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
    ttlSeconds: ttl,
    phoneNumber: TWILIO_PHONE_NUMBER || null,
    voiceUrl: `${baseUrl}/api/voice`,
  });
});

app.post("/api/voice", (req, res) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const response = new VoiceResponse();

  if (!TWILIO_ENABLED) {
    response.say("Service d'appel AFI OPS indisponible.");
    res.type("text/xml");
    return res.send(response.toString());
  }

  const { To } = req.body || {};
  if (To) {
    const dial = response.dial({
      callerId: TWILIO_PHONE_NUMBER,
      timeout: 30,
    });
    /^[\d\+\-\(\) ]+$/.test(To) ? dial.number(To) : dial.client(To);
  } else {
    response.say("Aucun destinataire spécifié.");
  }

  res.type("text/xml");
  res.send(response.toString());
});

/* ============================================================
4) MONDAY – HELPERS + CACHE
============================================================ */
const MONDAY_URL = "https://api.monday.com/v2";

function mondayHeaders() {
  if (!MONDAY_TOKEN) {
    const err = new Error("MONDAY_TOKEN_MISSING");
    err.code = "MONDAY_TOKEN_MISSING";
    throw err;
  }
  return {
    Authorization: `Bearer ${MONDAY_TOKEN}`,
    "Content-Type": "application/json",
    "API-Version": MONDAY_VERSION,
  };
}

async function mondayRequest(query, variables) {
  return axios.post(MONDAY_URL, { query, variables }, { headers: mondayHeaders(), timeout: 15000 });
}

const mondayCache = {
  data: null,
  expiresAt: 0,
};

/* ============================================================
5) MONDAY – FETCH TICKETS
============================================================ */
app.get("/api/monday/tickets", async (req, res) => {
  try {
    const now = Date.now();
    if (mondayCache.data && mondayCache.expiresAt > now) {
      return res.json(mondayCache.data);
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

    const r = await mondayRequest(query, {
      boardId: DEFAULT_BOARD_ID,
      limit: MONDAY_LIMIT,
    });

    const items = r.data?.data?.boards?.[0]?.items_page?.items || [];

    const payload = { items };
    mondayCache.data = payload;
    mondayCache.expiresAt = now + MONDAY_TTL;

    res.json(payload);
  } catch (e) {
    if (e.code === "MONDAY_TOKEN_MISSING") {
      return res.status(503).json({
        errorCode: "MONDAY_TOKEN_MISSING",
        message: "Missing MONDAY_TOKEN in env.",
      });
    }
    res.status(500).json({ error: e.message });
  }
});

/* ============================================================
6) MONDAY – CREATE / UPSERT / RESOLVE
============================================================ */
app.post("/api/monday/create-ticket", async (req, res) => {
  try {
    const mutation = `
      mutation ($boardId: ID!, $groupId: String!, $itemName: String!, $cols: JSON!) {
        create_item(board_id: $boardId, group_id: $groupId, item_name: $itemName, column_values: $cols) { id }
      }
    `;

    const r = await mondayRequest(mutation, {
      boardId: DEFAULT_BOARD_ID,
      groupId: DEFAULT_GROUP_ID,
      itemName: req.body.item_name || "Ticket AFI",
      cols: JSON.stringify(req.body.column_values || {}),
    });

    mondayCache.data = null;
    res.json({ ok: true, item: r.data.data.create_item });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/monday/upsert-ticket", async (req, res) => {
  try {
    const mutation = `
      mutation ($itemId: ID!, $cols: JSON!) {
        change_multiple_column_values(item_id: $itemId, board_id: ${DEFAULT_BOARD_ID}, column_values: $cols) { id }
      }
    `;
    await mondayRequest(mutation, {
      itemId: String(req.body.itemId),
      cols: JSON.stringify(req.body.column_values || {}),
    });
    mondayCache.data = null;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/monday/resolve-ticket", async (req, res) => {
  try {
    const mutation = `
      mutation ($itemId: ID!) {
        change_simple_column_value(item_id: $itemId, board_id: ${DEFAULT_BOARD_ID}, column_id: "status", value: "Résolu") { id }
      }
    `;
    await mondayRequest(mutation, { itemId: String(req.body.itemId) });
    mondayCache.data = null;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ============================================================
7) GPT – ANALYZE TICKET / GENERATE WRAP
============================================================ */
async function callOpenAI(instructions, input) {
  const r = await axios.post(
    "https://api.openai.com/v1/responses",
    { model: OPENAI_MODEL || "gpt-5", instructions, input },
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }, timeout: 30000 }
  );
  return r.data?.output_text || "";
}

app.post("/api/gpt/analyze-ticket", async (req, res) => {
  if (!OPENAI_API_KEY) {
    return res.status(501).json({ error: "GPT disabled" });
  }
  const text = await callOpenAI("Analyse SAV et retourne JSON.", JSON.stringify(req.body));
  res.json({ ok: true, analysis: text });
});

app.post("/api/gpt/generate-wrap", async (req, res) => {
  if (!OPENAI_API_KEY) {
    return res.status(501).json({ error: "GPT disabled" });
  }
  const text = await callOpenAI("Génère un wrap SAV structuré.", JSON.stringify(req.body));
  res.json({ ok: true, wrap: text });
});

/* ============================================================
8) YOUTUBE SEARCH
============================================================ */
app.get("/api/youtube/search", async (req, res) => {
  if (!YOUTUBE_API_KEY) return res.json({ items: [] });

  const url = new URL("https://www.googleapis.com/youtube/v3/search");
  url.searchParams.set("part", "snippet");
  url.searchParams.set("q", req.query.q || "");
  url.searchParams.set("key", YOUTUBE_API_KEY);
  url.searchParams.set("type", "video");
  url.searchParams.set("maxResults", "8");

  const r = await axios.get(url.toString(), { timeout: 15000 });
  res.json({ items: r.data.items || [] });
});

/* ============================================================
9) ZAPIER SMS
============================================================ */
app.post("/api/zapier/sms", async (req, res) => {
  if (!ZAPIER_SMS_WEBHOOK_URL) {
    return res.status(503).json({ error: "Zapier webhook missing" });
  }

  await axios.post(ZAPIER_SMS_WEBHOOK_URL, req.body, { timeout: 15000 });
  res.json({ ok: true });
});

/* ============================================================
10) TIDIO CONFIG
============================================================ */
app.get("/api/tidio-config", (req, res) => {
  res.json({ projectId: TIDIO_PROJECT_ID || null });
});

/* ============================================================
11) TRANSCRIPT (POC SAFE)
============================================================ */
app.get("/api/transcript/active", (_, res) =>
  res.status(501).json({ error: "Not implemented" })
);
app.get("/api/transcript/by-sid", (_, res) =>
  res.status(501).json({ error: "Not implemented" })
);

/* ============================================================
12) ERROR HANDLER + START
============================================================ */
app.use((err, req, res, next) => {
  console.error("[ERROR]", err);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log("✅ AFI OPS Backend boot");
  console.log("   baseUrl:", baseUrl);
  console.log("   startedAt:", STARTED_AT);
  console.log("   render.gitCommit:", BUILD.render.gitCommit);
  console.log("   render.instanceId:", BUILD.render.instanceId);
});
