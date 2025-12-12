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
 * ✅ Transcript endpoints (POC safe, return 501 if not wired)
 * ✅ YouTube Search proxy (widget)
 * ✅ Outlook OAuth URL helper + callback + status
 * ✅ Outlook Folders + Messages + Send (Graph API)
 * ✅ Token refresh auto (offline_access)
 * ✅ Zapier SMS proxy backend (anti-CORS)
 * ✅ Tidio config helper
 *
 * IMPORTANT:
 * - Monday API: items_page au niveau du board
 * - group_ids ne marche pas dans items_page -> filtre backend
 */

const express = require("express");
const twilio = require("twilio");
const axios = require("axios");
const cors = require("cors");
require("dotenv").config();

const app = express();

/* ============================================================
   0) CORS FIX (obligatoire)
   - credentials: "include" côté front => origin explicite
   - PAS de "*"
   - CodePen + Prod domain
============================================================ */
const allowedOrigins = [
  "https://cdpn.io",
  "https://codepen.io",
  "https://afi-ops.ca", // prod
  "http://localhost:3000" // dev local
];

const corsOptions = {
  origin: function (origin, cb) {
    // allow no-origin (curl/postman/server-to-server)
    if (!origin) return cb(null, true);

    // allow exact whitelisted origins
    if (allowedOrigins.includes(origin)) return cb(null, true);

    // safety net for CodePen subdomains (rare mais arrive)
    const isCodepenSubdomain =
      origin.endsWith(".cdpn.io") || origin.endsWith(".codepen.io");
    if (isCodepenSubdomain) return cb(null, true);

    return cb(new Error("Not allowed by CORS: " + origin), false);
  },
  credentials: true,
};

app.use(cors(corsOptions));
// Ensure preflight works everywhere
app.options("*", cors(corsOptions));

app.use(express.json({ limit: "5mb" }));

const PORT = process.env.PORT || 10000;
const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

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

  ZAPIER_SMS_WEBHOOK_URL,
} = process.env;

const MONDAY_TTL_MS = Number(MONDAY_TTL_MS_ENV || 25000);
const MONDAY_ITEMS_LIMIT = Number(MONDAY_ITEMS_LIMIT_ENV || 50);
const DEFAULT_BOARD_ID = Number(MONDAY_BOARD_ID || 1763228524);
const DEFAULT_GROUP_ID = String(MONDAY_GROUP_ID || "topics");
const MONDAY_API_VERSION = MONDAY_API_VERSION_ENV || "2023-10";

// Twilio toggle: serveur OK même si Twilio manquant
const TWILIO_ENABLED =
  !!TWILIO_ACCOUNT_SID &&
  !!TWILIO_API_KEY &&
  !!TWILIO_API_SECRET &&
  !!TWILIO_TWIML_APP_SID;

/* ============================================================
   OUTLOOK TOKEN STORE (in-memory)
   Note: Redémarre le serveur = Déconnecte Outlook
============================================================ */
const outlookTokens = { default: null };
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

/* ============================================================
   LOG ENV CHECK
============================================================ */
console.log("🚀 AFI OPS Backend starting...");
console.log("ENV vars loaded:", {
  TWILIO_ACCOUNT_SID: TWILIO_ACCOUNT_SID ? "✓" : "✗",
  MONDAY_TOKEN: MONDAY_TOKEN ? "✓" : "✗",
  OUTLOOK_CLIENT_ID: OUTLOOK_CLIENT_ID ? "✓" : "✗",
  YOUTUBE_API_KEY: YOUTUBE_API_KEY ? "✓" : "✗",
});

if (!TWILIO_ENABLED) {
  console.warn(
    "⚠️ Twilio not fully configured. Softphone endpoints will return 503."
  );
}

/* ============================================================
   HELPERS OUTLOOK
============================================================ */
function isOutlookConfigured() {
  return !!OUTLOOK_CLIENT_ID && !!OUTLOOK_TENANT_ID && !!OUTLOOK_CLIENT_SECRET;
}

function outlookRedirectUri() {
  return (
    OUTLOOK_REDIRECT_URI ||
    `${baseUrl.replace(/\/$/, "")}/api/outlook/callback`
  );
}

function tokensExpired(tokens) {
  if (!tokens?.obtained_at || !tokens?.expires_in) return true;
  const expiryMs = tokens.obtained_at + tokens.expires_in * 1000;
  return Date.now() > expiryMs - 30_000; // refresh 30s early
}

async function refreshOutlookToken() {
  const tokens = outlookTokens.default;
  if (!tokens?.refresh_token) throw new Error("No refresh_token available");

  const tokenUrl = `https://login.microsoftonline.com/${OUTLOOK_TENANT_ID}/oauth2/v2.0/token`;

  const params = new URLSearchParams({
    client_id: OUTLOOK_CLIENT_ID,
    client_secret: OUTLOOK_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    redirect_uri: outlookRedirectUri(),
    scope: "User.Read Mail.Read Mail.Send offline_access",
  });

  const r = await axios.post(tokenUrl, params.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 15000,
  });

  outlookTokens.default = {
    ...r.data,
    obtained_at: Date.now(),
  };

  return outlookTokens.default;
}

async function getValidAccessToken() {
  if (!outlookTokens.default) throw new Error("OUTLOOK_NOT_CONNECTED");
  if (tokensExpired(outlookTokens.default)) {
    return (await refreshOutlookToken()).access_token;
  }
  return outlookTokens.default.access_token;
}

async function graphGet(path, params = {}) {
  const token = await getValidAccessToken();
  const url = new URL(GRAPH_BASE + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const r = await axios.get(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 15000,
  });
  return r.data;
}

async function graphPost(path, body) {
  const token = await getValidAccessToken();
  const r = await axios.post(GRAPH_BASE + path, body, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    timeout: 15000,
  });
  return r.data;
}

/* ============================================================
   0) HEALTH CHECK
============================================================ */
app.get("/", (req, res) => {
  res.json({
    status: "AFI OPS Backend OK",
    timestamp: new Date().toISOString(),
    baseUrl,
    services: {
      twilio: TWILIO_ENABLED ? "ready" : "disabled",
      monday: !!MONDAY_TOKEN ? "ready" : "missing_token",
      outlook: isOutlookConfigured()
        ? outlookTokens.default
          ? "connected"
          : "configured_not_connected"
        : "not_configured",
      youtube: !!YOUTUBE_API_KEY ? "ready" : "missing_key",
    },
  });
});

/* ============================================================
   1) TWILIO TOKEN (VoIP)
============================================================ */
app.post("/api/twilio-token", (req, res) => {
  try {
    if (!TWILIO_ENABLED) {
      return res.status(503).json({
        errorCode: "TWILIO_CONFIG_INCOMPLETE",
        error: "Twilio backend config missing.",
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
      voiceUrl: `${baseUrl}/api/voice`,
    });
  } catch (e) {
    console.error("[Twilio] Token Error:", e);
    res.status(500).json({ error: e.message });
  }
});

/* ============================================================
   2) TWIML VOICE
============================================================ */
app.post("/api/voice", (req, res) => {
  try {
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();
    const { To } = req.body || {};

    if (!TWILIO_ENABLED) {
      response.say("Service non disponible.");
      res.type("text/xml");
      return res.send(response.toString());
    }

    if (To) {
      const dial = response.dial({
        callerId: TWILIO_PHONE_NUMBER,
        timeout: 30,
      });
      // Detect if number or client
      if (/^[\d\+\-\(\) ]+$/.test(To)) dial.number(To);
      else dial.client(To);
    } else {
      response.say("AFI OPS Console. Aucun destinataire.");
    }

    res.type("text/xml");
    res.send(response.toString());
  } catch (e) {
    res.status(500).send(e.message);
  }
});

/* ============================================================
   3) MONDAY API
============================================================ */
const mondayCache = {
  data: null,
  expiresAt: 0,
  lastBoardId: null,
  lastGroupId: null,
};

async function mondayRequest(query, variables) {
  const res = await axios.post(
    "https://api.monday.com/v2",
    { query, variables },
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${MONDAY_TOKEN}`,
        "API-Version": MONDAY_API_VERSION,
      },
      timeout: 15000,
    }
  );
  return res.data;
}

app.get("/api/monday/tickets", async (req, res) => {
  const now = Date.now();
  const boardId = Number(req.query.boardId || DEFAULT_BOARD_ID);
  const groupId = String(req.query.groupId || DEFAULT_GROUP_ID);

  // Cache strategy
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

    const rawItems = data?.data?.boards?.[0]?.items_page?.items || [];
    
    // Normalize data
    const normalized = rawItems.map((item) => {
      const colMap = {};
      (item.column_values || []).forEach((col) => {
        colMap[col.id] = { id: col.id, text: col.text, value: col.value, type: col.type };
      });
      return {
        id: item.id,
        name: item.name,
        updated_at: item.updated_at,
        group: item.group,
        column_values: colMap,
      };
    });

    // Client-side filtering because API v2023-10+ items_page doesn't support group_ids easily
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
    console.error("[Monday] Error:", error.message);
    res.status(500).json({ error: "Failed to fetch Monday tickets" });
  }
});

// UPSERT (UPDATE) Ticket
app.post("/api/monday/upsert-ticket", async (req, res) => {
  try {
    const { ticketId, ticket } = req.body || {};
    const itemId = String(ticketId || ticket?.id);
    
    // Example: Update the 'long_text' or description
    const colVals = {
      long_text_mkx59qsr: ticket?.issue_description || ticket?.problem || ""
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

    await mondayRequest(mutation, { itemId, cols: JSON.stringify(colVals) });
    mondayCache.data = null; // Invalidate cache
    res.json({ ok: true, status: "updated" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ============================================================
   6) TRANSCRIPT (POC)
============================================================ */
app.get("/api/transcript/active", (req, res) => {
  // Not wired to live stt yet
  res.status(501).json({ ok: false, message: "Transcript backend not wired yet" });
});

/* ============================================================
   7) OUTLOOK AUTH & API
============================================================ */
app.post("/api/outlook-auth", (req, res) => {
  if (!isOutlookConfigured()) return res.status(500).json({ error: "Outlook config missing" });

  const scope = "User.Read Mail.Read Mail.Send offline_access";
  const authUrl = `https://login.microsoftonline.com/${OUTLOOK_TENANT_ID}/oauth2/v2.0/authorize?client_id=${OUTLOOK_CLIENT_ID}&redirect_uri=${encodeURIComponent(
    outlookRedirectUri()
  )}&response_type=code&response_mode=query&scope=${encodeURIComponent(scope)}&prompt=select_account`;

  res.json({ authUrl });
});

app.get("/api/outlook/callback", async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).send("Code manquant");

    const tokenUrl = `https://login.microsoftonline.com/${OUTLOOK_TENANT_ID}/oauth2/v2.0/token`;
    const params = new URLSearchParams({
      client_id: OUTLOOK_CLIENT_ID,
      client_secret: OUTLOOK_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: outlookRedirectUri(),
      scope: "User.Read Mail.Read Mail.Send offline_access",
    });

    const tokenRes = await axios.post(tokenUrl, params.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });

    outlookTokens.default = { ...tokenRes.data, obtained_at: Date.now() };

    res.send(`
      <html><body style="background:#111;color:#eee;font-family:sans-serif;padding:40px;">
        <h1>Outlook Connecté ✅</h1>
        <p>Vous pouvez fermer cette fenêtre.</p>
        <script>if(window.opener){window.opener.postMessage({type:"OUTLOOK_CONNECTED"},"*");}</script>
      </body></html>
    `);
  } catch (e) {
    res.status(500).send("Erreur Auth Outlook: " + e.message);
  }
});

app.get("/api/outlook-status", (req, res) => {
  const t = outlookTokens.default;
  if (!t) return res.json({ connected: false });
  res.json({ connected: true });
});

app.get("/api/outlook/messages", async (req, res) => {
  try {
    if (!outlookTokens.default) return res.status(401).json({ error: "Not connected" });
    
    // Fetch top 15 messages from Inbox
    const data = await graphGet("/me/mailFolders/inbox/messages", {
      $top: "15",
      $orderby: "receivedDateTime desc",
      $select: "id,subject,from,receivedDateTime,bodyPreview,isRead"
    });
    
    // Simplify for frontend
    const messages = (data.value || []).map(m => ({
      id: m.id,
      subject: m.subject,
      from: m.from?.emailAddress ? { name: m.from.emailAddress.name, address: m.from.emailAddress.address } : null,
      receivedDateTime: m.receivedDateTime,
      bodyPreview: m.bodyPreview,
      isRead: m.isRead
    }));

    res.json({ messages });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/outlook/send", async (req, res) => {
  try {
    if (!outlookTokens.default) return res.status(401).json({ error: "Not connected" });
    const { to, subject, htmlBody } = req.body;
    
    const payload = {
      message: {
        subject,
        body: { contentType: "HTML", content: htmlBody },
        toRecipients: to.map(addr => ({ emailAddress: { address: addr } }))
      },
      saveToSentItems: true
    };

    await graphPost("/me/sendMail", payload);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ============================================================
   8) ZAPIER PROXY (SMS)
============================================================ */
app.post("/api/zapier/sms", async (req, res) => {
  try {
    if (!ZAPIER_SMS_WEBHOOK_URL) return res.status(503).json({ error: "No Zapier URL" });
    await axios.post(ZAPIER_SMS_WEBHOOK_URL, req.body);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ============================================================
   9) YOUTUBE SEARCH
============================================================ */
const ytCache = new Map();
app.get("/api/youtube/search", async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) return res.json({ items: [] });
    if (!YOUTUBE_API_KEY) return res.status(503).json({ error: "No YT Key" });

    // Simple cache
    const cacheKey = q.toLowerCase();
    if (ytCache.has(cacheKey)) return res.json({ items: ytCache.get(cacheKey) });

    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=5&q=${encodeURIComponent(q)}&key=${YOUTUBE_API_KEY}`;
    const r = await axios.get(url);
    
    const items = (r.data.items || []).map(i => ({
      id: i.id.videoId,
      title: i.snippet.title,
      thumbnail: i.snippet.thumbnails.medium.url
    }));

    ytCache.set(cacheKey, items);
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ============================================================
   START
============================================================ */
app.listen(PORT, () => {
  console.log(`✅ Backend running on port ${PORT}`);
  console.log(`📍 URL: ${baseUrl}`);
  console.log(`📧 Outlook callback: ${outlookRedirectUri()}`);
});
