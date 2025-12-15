/**
 * ============================================================
 * AFI OPS – Backend Central (Render / Local)
 * ============================================================
 * Fixes:
 * - Add /api/tickets (alias -> Monday tickets, normalized)
 * - Add /api/tickets/:id PATCH (status/assignee/group/column_values)
 * - Keep existing /api/monday/* endpoints
 * - Add urlencoded middleware (Twilio sends form-encoded)
 * - Outlook: folders + message detail + folderId support on /api/outlook/messages
 * ============================================================
 */

const express = require("express");
const twilio = require("twilio");
const axios = require("axios");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
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
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false })); // ✅ Twilio webhooks

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

  // Optional column ids for PATCH convenience
  MONDAY_STATUS_COLUMN_ID,
  MONDAY_ASSIGNEE_COLUMN_ID,

  /* Outlook */
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

const STATUS_COL = MONDAY_STATUS_COLUMN_ID || "status";
const ASSIGNEE_COL = MONDAY_ASSIGNEE_COLUMN_ID || "person";

const TWILIO_ENABLED =
  !!TWILIO_ACCOUNT_SID &&
  !!TWILIO_API_KEY &&
  !!TWILIO_API_SECRET &&
  !!TWILIO_TWIML_APP_SID;

const OUTLOOK_CONFIGURED =
  !!OUTLOOK_CLIENT_ID &&
  !!OUTLOOK_TENANT_ID &&
  !!OUTLOOK_CLIENT_SECRET &&
  !!OUTLOOK_REDIRECT_URI;

/* ============================================================
1.1) BUILD STAMP / RENDER DEBUG
============================================================ */
const STARTED_AT = new Date().toISOString();

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
      outlook: OUTLOOK_CONFIGURED ? "configured" : "not_configured",
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

const mondayCache = { data: null, expiresAt: 0 };

/* ============================================================
4.1) Monday -> Ticket normalisé (pour ton UI)
============================================================ */
function colMap(item) {
  const out = {};
  const cvs = item?.column_values || [];
  for (const cv of cvs) {
    const key = (cv?.column?.title || cv?.id || "").toString().toLowerCase();
    out[key] = cv?.text ?? "";
    if (cv?.id) out[`id:${cv.id}`] = cv?.text ?? "";
  }
  return out;
}

function pick(cols, candidates) {
  for (const c of candidates) {
    const k = c.toLowerCase();
    if (cols[k] != null && String(cols[k]).trim() !== "") return String(cols[k]).trim();
  }
  return "";
}

function normalizeTicketFromMondayItem(item) {
  const cols = colMap(item);
  const createdAt = item?.created_at ? Date.parse(item.created_at) : (item?.updated_at ? Date.parse(item.updated_at) : Date.now());

  const statusText =
    pick(cols, ["status", `id:${STATUS_COL}`, "statut"]) ||
    pick(cols, ["etat", "state"]) ||
    "open";

  const statusNorm = (() => {
    const s = statusText.toLowerCase();
    if (s.includes("urgent")) return "urgent";
    if (s.includes("attente") || s.includes("wait") || s.includes("pending")) return "wait";
    if (s.includes("résolu") || s.includes("resolu") || s.includes("done") || s.includes("closed")) return "closed";
    return "open";
  })();

  const serviceType = pick(cols, ["type service", "service", "type", "catégorie", "categorie"]) || (item?.group?.title || "SAV");
  const customerName = pick(cols, ["client", "nom", "customer", "customer name"]) || item?.name || "Client";
  const product = pick(cols, ["produit", "product", "modèle", "modele", "équipement", "equipement"]);
  const summary = pick(cols, ["problème", "probleme", "description", "résumé", "resume", "détails", "details"]) || item?.name || "";
  const phone = pick(cols, ["téléphone", "telephone", "phone"]);
  const email = pick(cols, ["courriel", "email", "e-mail"]);
  const location = pick(cols, ["adresse", "address", "ville", "city", "localisation", "location"]);

  const tagsRaw = pick(cols, ["tags", "labels", "étiquettes", "etiquettes"]);
  const tags = tagsRaw ? tagsRaw.split(/[,\|]/).map(x => x.trim()).filter(Boolean) : [];

  return {
    id: String(item?.id || ""),
    createdAt,
    serviceType,
    status: statusNorm,
    customerName,
    product,
    summary,
    phone,
    email,
    location,
    tags,
    monday: {
      boardId: DEFAULT_BOARD_ID,
      group: item?.group || null,
      updatedAt: item?.updated_at || null,
    }
  };
}

/* ============================================================
5) MONDAY – FETCH TICKETS (raw)
============================================================ */
async function fetchMondayItems({ boardId, groupId, limit }) {
  const useGroup = !!groupId;

  const query = useGroup
    ? `
      query ($boardId: ID!, $groupId: String!, $limit: Int!) {
        boards(ids: [$boardId]) {
          groups(ids: [$groupId]) {
            id
            title
            items_page(limit: $limit) {
              items {
                id
                name
                created_at
                updated_at
                group { id title }
                column_values { id text type value column { title } }
              }
            }
          }
        }
      }
    `
    : `
      query ($boardId: ID!, $limit: Int!) {
        boards(ids: [$boardId]) {
          items_page(limit: $limit) {
            items {
              id
              name
              created_at
              updated_at
              group { id title }
              column_values { id text type value column { title } }
            }
          }
        }
      }
    `;

  const variables = useGroup
    ? { boardId, groupId, limit }
    : { boardId, limit };

  const r = await mondayRequest(query, variables);

  if (useGroup) {
    return r.data?.data?.boards?.[0]?.groups?.[0]?.items_page?.items || [];
  }
  return r.data?.data?.boards?.[0]?.items_page?.items || [];
}

app.get("/api/monday/tickets", async (req, res) => {
  try {
    const now = Date.now();
    if (mondayCache.data && mondayCache.expiresAt > now) return res.json(mondayCache.data);

    const boardId = Number(req.query.boardId || DEFAULT_BOARD_ID);
    const groupId = String(req.query.groupId || DEFAULT_GROUP_ID);
    const limit = Math.max(1, Math.min(200, Number(req.query.limit || MONDAY_LIMIT)));

    const items = await fetchMondayItems({ boardId, groupId, limit });

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
5.1) ✅ ALIAS UI – /api/tickets (normalized)
============================================================ */
app.get("/api/tickets", async (req, res) => {
  try {
    const boardId = Number(req.query.boardId || DEFAULT_BOARD_ID);
    const groupId = String(req.query.groupId || DEFAULT_GROUP_ID);
    const limit = Math.max(1, Math.min(200, Number(req.query.limit || MONDAY_LIMIT)));

    const items = await fetchMondayItems({ boardId, groupId, limit });
    const tickets = items.map(normalizeTicketFromMondayItem);

    res.json(tickets);
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
        change_simple_column_value(item_id: $itemId, board_id: ${DEFAULT_BOARD_ID}, column_id: "${STATUS_COL}", value: "Résolu") { id }
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
6.1) ✅ PATCH compat – /api/tickets/:id
============================================================ */
app.patch("/api/tickets/:id", async (req, res) => {
  const itemId = String(req.params.id || "");
  if (!itemId) return res.status(400).json({ ok: false, error: "MISSING_ID" });

  try {
    const ops = [];

    if (req.body?.column_values && typeof req.body.column_values === "object") {
      const mutation = `
        mutation ($itemId: ID!, $cols: JSON!) {
          change_multiple_column_values(item_id: $itemId, board_id: ${DEFAULT_BOARD_ID}, column_values: $cols) { id }
        }
      `;
      ops.push(mondayRequest(mutation, { itemId, cols: JSON.stringify(req.body.column_values) }));
    }

    if (req.body?.status) {
      const mutation = `
        mutation ($itemId: ID!, $val: String!) {
          change_simple_column_value(item_id: $itemId, board_id: ${DEFAULT_BOARD_ID}, column_id: "${STATUS_COL}", value: $val) { id }
        }
      `;
      ops.push(mondayRequest(mutation, { itemId, val: String(req.body.status) }));
    }

    if (req.body?.assigneeId) {
      const assigneeId = Number(req.body.assigneeId);
      if (!Number.isFinite(assigneeId)) {
        return res.status(400).json({ ok: false, error: "BAD_ASSIGNEE_ID" });
      }
      const cols = {};
      cols[ASSIGNEE_COL] = { personsAndTeams: [{ id: assigneeId, kind: "person" }] };

      const mutation = `
        mutation ($itemId: ID!, $cols: JSON!) {
          change_multiple_column_values(item_id: $itemId, board_id: ${DEFAULT_BOARD_ID}, column_values: $cols) { id }
        }
      `;
      ops.push(mondayRequest(mutation, { itemId, cols: JSON.stringify(cols) }));
    }

    if (req.body?.groupId) {
      const groupId = String(req.body.groupId);
      const mutation = `
        mutation ($itemId: ID!, $groupId: String!) {
          move_item_to_group(item_id: $itemId, group_id: $groupId) { id }
        }
      `;
      ops.push(mondayRequest(mutation, { itemId, groupId }));
    }

    if (!ops.length) {
      return res.json({ ok: true, message: "No changes requested." });
    }

    await Promise.allSettled(ops);
    mondayCache.data = null;

    res.json({ ok: true });
  } catch (e) {
    if (e.code === "MONDAY_TOKEN_MISSING") {
      return res.status(503).json({
        errorCode: "MONDAY_TOKEN_MISSING",
        message: "Missing MONDAY_TOKEN in env.",
      });
    }
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ============================================================
7) OUTLOOK – OAUTH2 + MICROSOFT GRAPH (FILE STORE)
============================================================ */
const TOKEN_FILE = "./outlook-tokens.json";

let outlookStore = {
  connected: false,
  access_token: null,
  refresh_token: null,
  expires_at: 0,
  last_error: null,
  last_connected_at: null,
  _pending_state: null,
};

try {
  if (fs.existsSync(TOKEN_FILE)) {
    outlookStore = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
    console.log("✅ Outlook: tokens restaurés depuis fichier");
  }
} catch (e) {
  console.error("⚠️ Outlook: erreur lecture tokens", e);
}

function saveOutlookTokens() {
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(outlookStore, null, 2));
  } catch (e) {
    console.error("⚠️ Outlook: erreur sauvegarde tokens", e);
  }
}

function outlookTokenEndpoint() {
  return `https://login.microsoftonline.com/${encodeURIComponent(OUTLOOK_TENANT_ID)}/oauth2/v2.0/token`;
}

function outlookAuthorizeEndpoint() {
  return `https://login.microsoftonline.com/${encodeURIComponent(OUTLOOK_TENANT_ID)}/oauth2/v2.0/authorize`;
}

function nowMs() {
  return Date.now();
}

function isOutlookTokenValid() {
  return !!outlookStore.access_token && outlookStore.expires_at > nowMs() + 60_000;
}

async function refreshOutlookTokenIfNeeded() {
  if (!OUTLOOK_CONFIGURED) return null;
  if (isOutlookTokenValid()) return outlookStore.access_token;
  if (!outlookStore.refresh_token) return null;

  try {
    const params = new URLSearchParams();
    params.set("client_id", OUTLOOK_CLIENT_ID);
    params.set("client_secret", OUTLOOK_CLIENT_SECRET);
    params.set("grant_type", "refresh_token");
    params.set("refresh_token", outlookStore.refresh_token);
    params.set("redirect_uri", OUTLOOK_REDIRECT_URI);
    params.set("scope", "offline_access Mail.Read User.Read");

    const r = await axios.post(outlookTokenEndpoint(), params.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 15000,
    });

    const data = r.data || {};
    outlookStore.access_token = data.access_token || null;
    if (data.refresh_token) outlookStore.refresh_token = data.refresh_token;
    outlookStore.expires_at = nowMs() + Number(data.expires_in || 0) * 1000;
    outlookStore.connected = !!outlookStore.access_token;
    outlookStore.last_error = null;
    outlookStore.last_connected_at = new Date().toISOString();

    saveOutlookTokens();
    return outlookStore.access_token;
  } catch (e) {
    outlookStore.last_error = e?.response?.data || e?.message || "refresh_failed";
    return null;
  }
}

function makeStateToken() {
  return crypto.randomBytes(18).toString("hex");
}

/* ================= OUTLOOK ROUTES ================= */
app.get("/api/outlook-status", async (req, res) => {
  if (!OUTLOOK_CONFIGURED) {
    return res.json({
      ok: true,
      configured: false,
      connected: false,
      message: "Outlook env not configured",
    });
  }

  await refreshOutlookTokenIfNeeded();

  res.json({
    ok: true,
    configured: true,
    connected: !!outlookStore.connected,
    lastConnectedAt: outlookStore.last_connected_at,
    lastError: outlookStore.last_error ? "present" : null,
  });
});

app.post("/api/outlook-auth", (req, res) => {
  if (!OUTLOOK_CONFIGURED) {
    return res.status(503).json({
      ok: false,
      error: "OUTLOOK_NOT_CONFIGURED",
      message: "Missing Outlook env vars.",
    });
  }

  const state = makeStateToken();
  outlookStore._pending_state = state;
  saveOutlookTokens();

  const url = new URL(outlookAuthorizeEndpoint());
  url.searchParams.set("client_id", OUTLOOK_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", OUTLOOK_REDIRECT_URI);
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", "offline_access Mail.Read User.Read");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");

  res.json({ ok: true, authUrl: url.toString() });
});

app.get("/api/outlook/callback", async (req, res) => {
  const code = req.query.code;
  const state = req.query.state;
  const err = req.query.error;
  const errDesc = req.query.error_description;

  if (err) {
    outlookStore.last_error = { error: err, error_description: errDesc || null };
    outlookStore.connected = false;
    saveOutlookTokens();
    return res.status(400).send(`<html><body><pre>Outlook OAuth error: ${escapeHtml(err)}\n${escapeHtml(errDesc || "")}</pre></body></html>`);
  }

  if (!code) {
    return res.status(400).send("<html><body><pre>Missing code.</pre></body></html>");
  }

  if (outlookStore._pending_state && state && outlookStore._pending_state !== state) {
    outlookStore.last_error = { error: "STATE_MISMATCH" };
    outlookStore.connected = false;
    saveOutlookTokens();
    return res.status(400).send("<html><body><pre>State mismatch.</pre></body></html>");
  }

  try {
    const params = new URLSearchParams();
    params.set("client_id", OUTLOOK_CLIENT_ID);
    params.set("client_secret", OUTLOOK_CLIENT_SECRET);
    params.set("grant_type", "authorization_code");
    params.set("code", String(code));
    params.set("redirect_uri", OUTLOOK_REDIRECT_URI);
    params.set("scope", "offline_access Mail.Read User.Read");

    const r = await axios.post(outlookTokenEndpoint(), params.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 15000,
    });

    const data = r.data || {};
    outlookStore.access_token = data.access_token || null;
    outlookStore.refresh_token = data.refresh_token || null;
    outlookStore.expires_at = nowMs() + Number(data.expires_in || 0) * 1000;
    outlookStore.connected = !!outlookStore.access_token;
    outlookStore.last_error = null;
    outlookStore.last_connected_at = new Date().toISOString();
    outlookStore._pending_state = null;

    saveOutlookTokens();

    res.send(`
      <html>
        <body style="font-family:system-ui;padding:16px">
          <h3>Outlook connecté ✅</h3>
          <script>
            try { if (window.opener) window.opener.postMessage({ type: "OUTLOOK_CONNECTED" }, "*"); } catch(e){}
            setTimeout(() => window.close(), 250);
          </script>
        </body>
      </html>
    `);
  } catch (e) {
    outlookStore.last_error = e?.response?.data || e?.message || "token_exchange_failed";
    outlookStore.connected = false;
    outlookStore.access_token = null;
    outlookStore.refresh_token = null;
    outlookStore.expires_at = 0;
    saveOutlookTokens();

    res.status(500).send(`<html><body><pre>Token exchange failed:\n${escapeHtml(JSON.stringify(outlookStore.last_error, null, 2))}</pre></body></html>`);
  }
});

/* ============================================================
7) OUTLOOK – MESSAGES (upgrade: folderId support)
============================================================ */
app.get("/api/outlook/messages", async (req, res) => {
  if (!OUTLOOK_CONFIGURED) {
    return res.status(503).json({ ok: false, error: "OUTLOOK_NOT_CONFIGURED" });
  }

  const token = await refreshOutlookTokenIfNeeded();
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: "OUTLOOK_NOT_CONNECTED",
      message: "Connect Outlook first.",
    });
  }

  try {
    const top = Math.max(5, Math.min(50, Number(req.query.top || 25)));
    const folderId = req.query.folderId || "Inbox";

    const basePath = folderId === "Inbox"
      ? "me/mailFolders/Inbox/messages"
      : `me/mailFolders/${encodeURIComponent(folderId)}/messages`;

    const graphUrl = new URL(`https://graph.microsoft.com/v1.0/${basePath}`);
    graphUrl.searchParams.set("$top", String(top));
    graphUrl.searchParams.set("$orderby", "receivedDateTime DESC");
    graphUrl.searchParams.set(
      "$select",
      "id,subject,receivedDateTime,from,bodyPreview,hasAttachments,importance,isRead"
    );

    const r = await axios.get(graphUrl.toString(), {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000,
    });

    res.json({ ok: true, messages: r.data?.value || [] });
  } catch (e) {
    const status = e?.response?.status || 500;
    const data = e?.response?.data || { error: e?.message || "graph_error" };

    if (status === 401 || status === 403) {
      outlookStore.connected = false;
      outlookStore.access_token = null;
      outlookStore.expires_at = 0;
      saveOutlookTokens();
    }

    res.status(status).json({ ok: false, error: "OUTLOOK_GRAPH_ERROR", details: data });
  }
});

// ============================================================
// 7.1) OUTLOOK – FOLDERS + MESSAGE DETAIL
// ============================================================

// Helper Graph générique
async function callGraph(token, url) {
  const r = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 15000,
  });
  return r.data || {};
}

// Liste des dossiers (colonne 1)
app.get("/api/outlook/folders", async (req, res) => {
  if (!OUTLOOK_CONFIGURED) {
    return res.status(503).json({ ok: false, error: "OUTLOOK_NOT_CONFIGURED" });
  }

  const token = await refreshOutlookTokenIfNeeded();
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: "OUTLOOK_NOT_CONNECTED",
      message: "Connect Outlook first.",
    });
  }

  try {
    const graphUrl = new URL("https://graph.microsoft.com/v1.0/me/mailFolders");
    graphUrl.searchParams.set("$top", "50");
    graphUrl.searchParams.set(
      "$select",
      "id,displayName,parentFolderId,childFolderCount,unreadItemCount,totalItemCount"
    );

    const data = await callGraph(token, graphUrl.toString());
    res.json({
      ok: true,
      folders: data.value || [],
    });
  } catch (e) {
    const status = e?.response?.status || 500;
    const details = e?.response?.data || { error: e?.message || "graph_error" };
    res.status(status).json({ ok: false, error: "OUTLOOK_GRAPH_ERROR", details });
  }
});

// Détail d'un message (colonne 3)
app.get("/api/outlook/message/:id", async (req, res) => {
  if (!OUTLOOK_CONFIGURED) {
    return res.status(503).json({ ok: false, error: "OUTLOOK_NOT_CONFIGURED" });
  }

  const token = await refreshOutlookTokenIfNeeded();
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: "OUTLOOK_NOT_CONNECTED",
      message: "Connect Outlook first.",
    });
  }

  const msgId = String(req.params.id || "").trim();
  if (!msgId) {
    return res.status(400).json({ ok: false, error: "MISSING_MESSAGE_ID" });
  }

  try {
    const graphUrl = new URL(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(msgId)}`);
    graphUrl.searchParams.set(
      "$select",
      "id,subject,from,toRecipients,ccRecipients,replyTo,receivedDateTime,hasAttachments,importance,isRead,body"
    );

    const data = await callGraph(token, graphUrl.toString());
    res.json({ ok: true, message: data });
  } catch (e) {
    const status = e?.response?.status || 500;
    const details = e?.response?.data || { error: e?.message || "graph_error" };
    if (status === 401 || status === 403) {
      outlookStore.connected = false;
      outlookStore.access_token = null;
      outlookStore.expires_at = 0;
      saveOutlookTokens();
    }
    res.status(status).json({ ok: false, error: "OUTLOOK_GRAPH_ERROR", details });
  }
});

/* ============================================================
8) GPT – ANALYZE TICKET / GENERATE WRAP
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
  if (!OPENAI_API_KEY) return res.status(501).json({ error: "GPT disabled" });
  const text = await callOpenAI("Analyse SAV et retourne JSON.", JSON.stringify(req.body));
  res.json({ ok: true, analysis: text });
});

app.post("/api/gpt/generate-wrap", async (req, res) => {
  if (!OPENAI_API_KEY) return res.status(501).json({ error: "GPT disabled" });
  const text = await callOpenAI("Génère un wrap SAV structuré.", JSON.stringify(req.body));
  res.json({ ok: true, wrap: text });
});

/* ============================================================
9) YOUTUBE SEARCH (server-side => no CORS)
============================================================ */
app.get("/api/youtube/search", async (req, res) => {
  if (!YOUTUBE_API_KEY) return res.json({ items: [] });

  const url = new URL("https://www.googleapis.com/youtube/v3/search");
  url.searchParams.set("part", "snippet");
  url.searchParams.set("q", req.query.q || "");
  url.searchParams.set("key", YOUTUBE_API_KEY);
  url.searchParams.set("type", "video");
  url.searchParams.set("maxResults", "12");

  const r = await axios.get(url.toString(), { timeout: 15000 });
  res.json({ items: r.data.items || [] });
});

/* ============================================================
10) ZAPIER SMS
============================================================ */
app.post("/api/zapier/sms", async (req, res) => {
  if (!ZAPIER_SMS_WEBHOOK_URL) return res.status(503).json({ error: "Zapier webhook missing" });
  await axios.post(ZAPIER_SMS_WEBHOOK_URL, req.body, { timeout: 15000 });
  res.json({ ok: true });
});

/* ============================================================
11) TIDIO CONFIG
============================================================ */
app.get("/api/tidio-config", (req, res) => {
  res.json({ projectId: TIDIO_PROJECT_ID || null });
});

/* ============================================================
12) TRANSCRIPT (POC SAFE)
============================================================ */
app.get("/api/transcript/active", (_, res) => res.status(501).json({ error: "Not implemented" }));
app.get("/api/transcript/by-sid", (_, res) => res.status(501).json({ error: "Not implemented" }));

/* ============================================================
13) UTILS
============================================================ */
function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/* ============================================================
14) ERROR HANDLER + START
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
  console.log("   outlook.configured:", OUTLOOK_CONFIGURED);
});
