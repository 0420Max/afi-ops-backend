/**
 * AFI OPS Backend (Render / Local)
 * ------------------------------------------------------------
 * FEATURES:
 * ✅ Health check
 * ✅ Twilio Voice Token (JWT moderne, avec diagnostics)
 * ✅ TwiML Voice endpoint (outgoing + incoming)
 * ✅ Monday tickets proxy normalisé + cache TTL
 * ✅ Monday Create Ticket (group topics) selon mapping Paperform
 * ✅ Outlook OAuth URL helper (placeholder + callback + status)
 * ✅ Tidio config helper
 *
 * IMPORTANT:
 * - Monday API: on utilise items_page au niveau du board
 *   (items sur Board n'existe pas -> ton erreur 400)
 * - group_ids n'existe pas sur items_page -> on filtre côté backend
 */

const express = require("express");
const twilio = require("twilio");
const axios = require("axios");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 10000;
const baseUrl =
  process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

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
  MONDAY_TTL_MS: MONDAY_TTL_MS_ENV,
  MONDAY_ITEMS_LIMIT: MONDAY_ITEMS_LIMIT_ENV,
  RENDER_EXTERNAL_URL,
  MONDAY_API_VERSION: MONDAY_API_VERSION_ENV,
  OUTLOOK_CLIENT_ID,
  OUTLOOK_TENANT_ID,
  OUTLOOK_CLIENT_SECRET,
  OUTLOOK_REDIRECT_URI,
  TIDIO_PROJECT_ID,
  TWILIO_TOKEN_TTL,
} = process.env;

const MONDAY_TTL_MS = Number(MONDAY_TTL_MS_ENV || 25000);
const MONDAY_ITEMS_LIMIT = Number(MONDAY_ITEMS_LIMIT_ENV || 50);
const DEFAULT_BOARD_ID = Number(MONDAY_BOARD_ID || 1763228524);
const DEFAULT_GROUP_ID = process.env.MONDAY_GROUP_ID || "topics";
const MONDAY_API_VERSION = MONDAY_API_VERSION_ENV || "2023-10";

// Twilio toggle: on démarre le serveur même si Twilio est mal configuré,
// mais on désactive uniquement les routes Twilio.
const TWILIO_ENABLED =
  !!TWILIO_ACCOUNT_SID &&
  !!TWILIO_API_KEY &&
  !!TWILIO_API_SECRET &&
  !!TWILIO_TWIML_APP_SID;

/* ============================================================
   OUTLOOK TOKEN STORE (in-memory POC)
   - un seul agent
   - 90% solution dev, prêt pour upgrade DB/Redis plus tard
============================================================ */
const outlookTokens = {
  default: null,
};

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
  MONDAY_BOARD_ID: MONDAY_BOARD_ID ? "✓" : "⚠️ fallback",
  MONDAY_TTL_MS: MONDAY_TTL_MS_ENV ? `✓ (${MONDAY_TTL_MS_ENV})` : "default 25s",
  MONDAY_ITEMS_LIMIT: MONDAY_ITEMS_LIMIT_ENV
    ? `✓ (${MONDAY_ITEMS_LIMIT_ENV})`
    : "default 50",
  RENDER_EXTERNAL_URL: RENDER_EXTERNAL_URL ? "✓" : "⚠️ local",

  // Outlook (facultatif mais pratique)
  OUTLOOK_CLIENT_ID: OUTLOOK_CLIENT_ID ? "✓" : "✗",
  OUTLOOK_TENANT_ID: OUTLOOK_TENANT_ID ? "✓" : "✗",
  OUTLOOK_CLIENT_SECRET: OUTLOOK_CLIENT_SECRET ? "✓" : "✗",
  OUTLOOK_REDIRECT_URI:
    OUTLOOK_REDIRECT_URI || "⚠️ default /api/outlook/callback",

  TIDIO_PROJECT_ID: TIDIO_PROJECT_ID ? "✓" : "✗",
  TWILIO_TOKEN_TTL: TWILIO_TOKEN_TTL
    ? `✓ (${TWILIO_TOKEN_TTL}s)`
    : "default 3600s",
});

// Log Twilio readiness (diagnostic doux)
if (!TWILIO_ENABLED) {
  console.warn(
    "⚠️ Twilio not fully configured. Softphone endpoints will return 503 until env vars are fixed."
  );
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
      outlook:
        OUTLOOK_CLIENT_ID && OUTLOOK_TENANT_ID
          ? outlookTokens.default
            ? "connected"
            : "configured_not_connected"
          : "not_configured",
      tidio: !!TIDIO_PROJECT_ID ? "ready" : "not_configured",
    },
  });
});

/* ============================================================
   0.1) TWILIO HEALTH (debug uniquement)
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
   POST /api/twilio-token
   Body optionnel: { identity: "max" }
============================================================ */
app.post("/api/twilio-token", (req, res) => {
  try {
    console.log("[Twilio] 🔐 Token request received...");

    if (!TWILIO_ENABLED) {
      console.warn("[Twilio] ❌ Twilio not configured, rejecting token request.");
      return res.status(503).json({
        errorCode: "TWILIO_CONFIG_INCOMPLETE",
        error:
          "Twilio is not fully configured on the backend. Check TWILIO_* env vars.",
      });
    }

    const AccessToken = twilio.jwt.AccessToken;
    const VoiceGrant = AccessToken.VoiceGrant;

    const identity = req.body?.identity || "afi-agent";

    const ttl = Number(TWILIO_TOKEN_TTL || 3600); // 1h par défaut
    const token = new AccessToken(
      TWILIO_ACCOUNT_SID,
      TWILIO_API_KEY, // SK...
      TWILIO_API_SECRET,
      {
        identity,
        ttl,
      }
    );

    token.addGrant(
      new VoiceGrant({
        outgoingApplicationSid: TWILIO_TWIML_APP_SID, // AP...
        incomingAllow: true,
      })
    );

    const jwtToken = token.toJwt();

    // Log léger (sans exposer le token complet)
    console.log("[Twilio] ✅ Token generated", {
      identity,
      ttlSeconds: ttl,
    });

    res.json({
      token: jwtToken,
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
   POST /api/voice
============================================================ */
app.post("/api/voice", (req, res) => {
  try {
    console.log("[Voice] 📞 Incoming TwiML request...");

    if (!TWILIO_ENABLED) {
      console.warn("[Voice] ❌ Twilio not configured, replying with basic message.");
      const VoiceResponse = twilio.twiml.VoiceResponse;
      const response = new VoiceResponse();
      response.say("Le service d'appel AFI OPS n'est pas disponible pour le moment.");
      res.type("text/xml");
      return res.send(response.toString());
    }

    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();
    const { To } = req.body || {};

    console.log(`[Voice] Dialing to: ${To}`);

    if (To) {
      const dial = response.dial({
        callerId: TWILIO_PHONE_NUMBER,
        timeout: 30,
      });

      if (/^[\d\+\-\(\) ]+$/.test(To)) {
        dial.number(To);
        console.log(`[Voice] ✅ Dialing number: ${To}`);
      } else {
        dial.client(To);
        console.log(`[Voice] ✅ Dialing client: ${To}`);
      }
    } else {
      response.say(
        "Merci d'appeler AFI OPS. Aucun destinataire spécifié."
      );
      console.log("[Voice] ⚠️ No destination");
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
  if (!MONDAY_TOKEN) {
    throw new Error("Missing MONDAY_TOKEN");
  }
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
   GET /api/monday/tickets
   ✅ Retourne { items: [...] }
   - Utilise items_page (valide)
   - Ajoute group { id title }
   - Filtre sur topics si demandé
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

  // Cache HIT ?
  if (
    mondayCache.data &&
    mondayCache.expiresAt > now &&
    mondayCache.lastBoardId === boardId &&
    mondayCache.lastGroupId === groupId
  ) {
    console.log("[API] 🧠 Monday cache HIT");
    return res.json(mondayCache.data);
  }

  // Query VALIDÉE (items_page)
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
            group {
              id
              title
            }
            column_values {
              id
              text
              type
              value
            }
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

    if (data.errors) {
      console.error("[API] ❌ Monday errors:", data.errors);
      return res.status(400).json({ errors: data.errors });
    }

    const board = data?.data?.boards?.[0];
    if (!board) {
      console.warn("[API] ⚠️ No board returned");
      const empty = { items: [] };
      mondayCache.data = empty;
      mondayCache.expiresAt = now + MONDAY_TTL_MS;
      mondayCache.lastBoardId = boardId;
      mondayCache.lastGroupId = groupId;
      return res.json(empty);
    }

    const rawItems = board.items_page?.items || [];

    // Normalisation colMap
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

      return {
        id: item.id,
        name: item.name,
        updated_at: item.updated_at,
        group: item.group || null,
        column_values: colMap,
      };
    });

    // Filtre group topics (ou autre groupId)
    const items =
      groupId === "all"
        ? normalized
        : normalized.filter((it) => it.group?.id === groupId);

    const payload = { items };

    mondayCache.data = payload;
    mondayCache.expiresAt = now + MONDAY_TTL_MS;
    mondayCache.lastBoardId = boardId;
    mondayCache.lastGroupId = groupId;

    console.log(
      `[API] ✅ Tickets normalized: ${items.length}/${normalized.length} items (group=${groupId})`
    );
    res.json(payload);
  } catch (error) {
    console.error("[API] ❌ Fetch error:", error.message);
    res.status(500).json({
      error: "Failed to fetch Monday tickets",
      details: error.message,
    });
  }
});

/* ============================================================
   5) MONDAY CREATE TICKET (Paperform -> topics)
   POST /api/monday/create-ticket
   Body JSON reçu de Paperform:
     {
       full_name, phone, email, address,
       issue_description, intent, language,
       zap_meta_timestamp
     }
============================================================ */
const INTENT_MAP = {
  service: "🔧 Service",
  warranty: "🛡️ Garantie",
  parts: "🔩 Pièce",
  quote: "💰 Soumission",
};

const LANGUAGE_MAP = {
  fr: "🃏 Français",
  en: "🇬🇧 English",
};

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
      zap_meta_timestamp ||
      new Date().toISOString().split("T")[0],
  };

  const mutation = `
    mutation ($boardId: ID!, $groupId: String!, $itemName: String!, $cols: JSON!) {
      create_item(
        board_id: $boardId,
        group_id: $groupId,
        item_name: $itemName,
        column_values: $cols
      ) {
        id
        name
      }
    }
  `;

  try {
    const data = await mondayRequest(mutation, {
      boardId,
      groupId,
      itemName: item_name,
      cols: JSON.stringify(column_values),
    });

    if (data.errors) {
      console.error("[API] ❌ Monday create errors:", data.errors);
      return res.status(400).json({ errors: data.errors });
    }

    // bust cache
    mondayCache.data = null;

    const created = data?.data?.create_item;
    console.log("[API] ✅ Ticket created:", created?.id);

    res.json({
      ok: true,
      item: created,
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

/* ============================================================
   6) OUTLOOK TOKEN (OAuth) - helper URL
   POST /api/outlook-auth
============================================================ */
app.post("/api/outlook-auth", (req, res) => {
  try {
    console.log("[Outlook] 🔐 Generating OAuth URL...");

    const clientId = OUTLOOK_CLIENT_ID;
    const tenantId = OUTLOOK_TENANT_ID;
    const redirectUri =
      OUTLOOK_REDIRECT_URI ||
      `${baseUrl.replace(/\/$/, "")}/api/outlook/callback`;

    if (!clientId || !tenantId) {
      return res.status(500).json({
        errorCode: "OUTLOOK_CONFIG_INCOMPLETE",
        error: "Missing OUTLOOK_CLIENT_ID or OUTLOOK_TENANT_ID",
      });
    }

    const authUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(
      redirectUri
    )}&response_type=code&scope=Mail.Read Mail.Send offline_access`;

    console.log("[Outlook] ✅ OAuth URL generated");
    res.json({ authUrl });
  } catch (e) {
    console.error("[Outlook] ❌ Error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// 6.1) OUTLOOK CALLBACK  (Azure -> Backend)
// GET /api/outlook/callback?code=...&state=...
// ============================================================
app.get("/api/outlook/callback", async (req, res) => {
  try {
    const { code, error, error_description } = req.query;

    if (error) {
      console.error("[Outlook] Auth error:", error, error_description);
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
      console.error("[Outlook] Config incomplète côté backend.");
      return res
        .status(500)
        .send("<h1>Outlook non configuré côté backend.</h1>");
    }

    const tokenUrl = `https://login.microsoftonline.com/${OUTLOOK_TENANT_ID}/oauth2/v2.0/token`;

    const params = new URLSearchParams({
      client_id: OUTLOOK_CLIENT_ID,
      client_secret: OUTLOOK_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri:
        OUTLOOK_REDIRECT_URI ||
        `${baseUrl.replace(/\/$/, "")}/api/outlook/callback`,
    });

    const tokenRes = await axios.post(tokenUrl, params.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 15000,
    });

    outlookTokens.default = {
      ...tokenRes.data,
      obtained_at: Date.now(),
    };

    console.log("[Outlook] ✅ Tokens reçus (access + refresh).");

    // Mini page de succès + message au front
    res.send(`
      <html>
        <body style="background:#020617;color:#e5e7eb;font-family:-apple-system,system-ui;padding:32px">
          <h1>Outlook connecté ✅</h1>
          <p>Tu peux fermer cette fenêtre et revenir à AFI OPS Cockpit.</p>
          <script>
            if (window.opener) {
              window.opener.postMessage({ type: "OUTLOOK_CONNECTED" }, "*");
            }
          </script>
        </body>
      </html>
    `);
  } catch (e) {
    console.error("[Outlook] Callback error:", e.message);
    res
      .status(500)
      .send("<h1>Erreur lors de la récupération du token Outlook.</h1>");
  }
});

// ============================================================
// 6.2) OUTLOOK STATUS
// GET /api/outlook-status  -> { connected: bool, expiresInSeconds? }
// ============================================================
app.get("/api/outlook-status", (req, res) => {
  const tokens = outlookTokens.default;
  if (!tokens) {
    return res.json({ connected: false });
  }

  const expiresIn = tokens.expires_in
    ? Math.max(
        0,
        Math.floor(
          (tokens.obtained_at + tokens.expires_in * 1000 - Date.now()) / 1000
        )
      )
    : null;

  res.json({
    connected: true,
    expiresInSeconds: expiresIn,
  });
});

/* ============================================================
   7) TIDIO CONFIG
   GET /api/tidio-config
============================================================ */
app.get("/api/tidio-config", (req, res) => {
  try {
    console.log("[Tidio] 🔧 Fetching config...");
    const projectId = TIDIO_PROJECT_ID;
    if (!projectId) {
      return res.status(500).json({
        errorCode: "TIDIO_CONFIG_INCOMPLETE",
        error: "Missing TIDIO_PROJECT_ID",
      });
    }
    res.json({ projectId });
  } catch (e) {
    console.error("[Tidio] ❌ Error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ============================================================
   8) ERROR HANDLING
============================================================ */
app.use((err, req, res, next) => {
  console.error("[Error]", err);
  res.status(500).json({
    error: "Internal server error",
    details: err.message,
  });
});

/* ============================================================
   9) START SERVER
============================================================ */
app.listen(PORT, () => {
  console.log(`✅ Backend running on port ${PORT}`);
  console.log(`📍 URL: ${baseUrl}`);
  console.log(`📞 TwiML Voice URL: ${baseUrl}/api/voice`);
  console.log(`📧 Outlook callback URL: ${baseUrl}/api/outlook/callback`);
});
