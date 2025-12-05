/**
 * AFI OPS Backend (Render / Local)
 * - Twilio Voice Token (JWT moderne)
 * - TwiML Voice endpoint
 * - Monday tickets proxy normalisé (avec cache TTL + filtre group)
 * - Outlook OAuth URL generator
 * - Tidio config endpoint
 */

const express = require("express");
const twilio = require("twilio");
const axios = require("axios");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

/* ================================
   CONFIG / ENV
================================ */
const PORT = process.env.PORT || 10000;
const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

const MONDAY_TTL_MS = Number(process.env.MONDAY_TTL_MS || 25000); // 25s par défaut
const MONDAY_ITEMS_LIMIT = Number(process.env.MONDAY_ITEMS_LIMIT || 50);
const MONDAY_DEFAULT_BOARD_ID = Number(process.env.MONDAY_BOARD_ID || 1763228524);
const MONDAY_DEFAULT_GROUP_ID = process.env.MONDAY_GROUP_ID || "topics"; // "Nouvelles demandes"

/* ================================
   BOOT LOGS
================================ */
console.log("🚀 AFI OPS Backend starting...");
console.log("ENV vars loaded:", {
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID ? "✓" : "✗",
  TWILIO_API_KEY: process.env.TWILIO_API_KEY ? "✓(SK...)" : "✗",
  TWILIO_API_SECRET: process.env.TWILIO_API_SECRET ? "✓" : "✗",
  TWILIO_TWIML_APP_SID: process.env.TWILIO_TWIML_APP_SID ? "✓(AP...)" : "✗",
  TWILIO_PHONE_NUMBER: process.env.TWILIO_PHONE_NUMBER ? "✓" : "✗",
  MONDAY_TOKEN: process.env.MONDAY_TOKEN ? "✓" : "✗",
  MONDAY_BOARD_ID: process.env.MONDAY_BOARD_ID ? "✓" : "⚠️ fallback",
  MONDAY_GROUP_ID: process.env.MONDAY_GROUP_ID ? "✓" : "⚠️ topics",
  OUTLOOK_CLIENT_ID: process.env.OUTLOOK_CLIENT_ID ? "✓" : "⚠️ none",
  OUTLOOK_TENANT_ID: process.env.OUTLOOK_TENANT_ID ? "✓" : "⚠️ none",
  TIDIO_PROJECT_ID: process.env.TIDIO_PROJECT_ID ? "✓" : "⚠️ none",
  RENDER_EXTERNAL_URL: process.env.RENDER_EXTERNAL_URL ? "✓" : "⚠️ local",
});

/* ================================
   HEALTH CHECK
================================ */
app.get("/", (req, res) => {
  res.json({
    status: "AFI OPS Backend OK",
    timestamp: new Date().toISOString(),
    baseUrl,
  });
});

/* ================================
   TWILIO TOKEN (VoIP)
   POST /api/twilio-token
   Body optionnel: { identity: "max" }
================================ */
app.post("/api/twilio-token", (req, res) => {
  try {
    console.log("[Twilio] 🔐 Generating token...");

    const {
      TWILIO_ACCOUNT_SID,
      TWILIO_API_KEY,
      TWILIO_API_SECRET,
      TWILIO_TWIML_APP_SID,
      TWILIO_PHONE_NUMBER,
    } = process.env;

    if (!TWILIO_ACCOUNT_SID || !TWILIO_API_KEY || !TWILIO_API_SECRET || !TWILIO_TWIML_APP_SID) {
      return res.status(500).json({
        ok: false,
        error: "Missing Twilio env vars. Check TWILIO_* in Render.",
      });
    }

    const AccessToken = twilio.jwt.AccessToken;
    const VoiceGrant = AccessToken.VoiceGrant;

    const identity = req.body?.identity || "afi-agent";

    const token = new AccessToken(
      TWILIO_ACCOUNT_SID,
      TWILIO_API_KEY,     // SK...
      TWILIO_API_SECRET,  // secret de la SK
      { identity }
    );

    token.addGrant(
      new VoiceGrant({
        outgoingApplicationSid: TWILIO_TWIML_APP_SID, // AP...
        incomingAllow: true,
      })
    );

    const jwtToken = token.toJwt();
    console.log("[Twilio] ✅ Token generated for identity:", identity);

    res.json({
      ok: true,
      token: jwtToken,
      identity,
      accountSid: TWILIO_ACCOUNT_SID,
      phoneNumber: TWILIO_PHONE_NUMBER || null,
      voiceUrl: `${baseUrl}/api/voice`,
    });
  } catch (e) {
    console.error("[Twilio] ❌ Token Error:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ================================
   TWIML VOICE (Logique d'appel)
   POST /api/voice
================================ */
app.post("/api/voice", (req, res) => {
  try {
    console.log("[Voice] 📞 Incoming TwiML request...");

    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();
    const { To } = req.body || {};

    console.log(`[Voice] Dialing to: ${To}`);

    if (To) {
      const dial = response.dial({
        callerId: process.env.TWILIO_PHONE_NUMBER,
        timeout: 30,
      });

      if (/^[\d\+\-\(\) ]+$/.test(To)) {
        dial.number(To);
        console.log(`[Voice] ✅ Dialing phone number: ${To}`);
      } else {
        dial.client(To);
        console.log(`[Voice] ✅ Dialing client: ${To}`);
      }
    } else {
      response.say("Merci d'appeler AFI OPS. Aucun destinataire spécifié.");
      console.log("[Voice] ⚠️ No destination provided");
    }

    res.type("text/xml");
    res.send(response.toString());
  } catch (e) {
    console.error("[Voice] ❌ TwiML Error:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ================================
   MONDAY TICKETS + CACHE TTL
   GET /api/monday/tickets
   ✅ Retourne { ok:true, items:[...] }
   ✅ Filtre groupId = topics par défaut
================================ */

// Cache mémoire simple
const mondayCache = {
  data: null,
  expiresAt: 0,
};

app.get("/api/monday/tickets", async (req, res) => {
  console.log("[API] 📅 Fetching tickets from Monday (Proxy)...");

  const token = process.env.MONDAY_TOKEN;
  if (!token) {
    console.error("❌ MONDAY_TOKEN manquant !");
    return res.status(500).json({
      ok: false,
      error: "Server misconfigured (missing MONDAY_TOKEN)",
    });
  }

  // TTL Cache
  const now = Date.now();
  if (mondayCache.data && mondayCache.expiresAt > now) {
    console.log("[API] 🧠 Monday cache HIT");
    return res.json(mondayCache.data);
  }

  const boardId = Number(req.query.boardId || MONDAY_DEFAULT_BOARD_ID);
  const groupId = String(req.query.groupId || MONDAY_DEFAULT_GROUP_ID);

  // ✅ Query correcte Monday (items_page + group_ids)
  const query = `
    query ($boardId: ID!, $limit: Int!, $groupIds: [String!]) {
      boards(ids: [$boardId]) {
        id
        name
        items_page(
          limit: $limit,
          query_params: { group_ids: $groupIds }
        ) {
          items {
            id
            name
            updated_at
            group { id title }
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
    const response = await axios.post(
      "https://api.monday.com/v2",
      {
        query,
        variables: {
          boardId,
          limit: MONDAY_ITEMS_LIMIT,
          groupIds: [groupId],
        },
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: token, // pas Bearer sinon ok aussi
          "API-Version": "2023-10",
        },
        timeout: 15000,
      }
    );

    if (response.data.errors) {
      console.error("[API] ❌ Monday errors:", response.data.errors);
      return res.status(400).json({
        ok: false,
        errors: response.data.errors,
      });
    }

    const board = response.data?.data?.boards?.[0];
    if (!board) {
      console.warn("[API] ⚠️ No board returned from Monday");
      const empty = { ok: true, items: [] };
      mondayCache.data = empty;
      mondayCache.expiresAt = now + MONDAY_TTL_MS;
      return res.json(empty);
    }

    const rawItems = board.items_page?.items || [];

    // Normalisation: column_values -> map par id
    const items = rawItems.map((item) => {
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

    const payload = {
      ok: true,
      board: { id: board.id, name: board.name },
      groupId,
      items,
    };

    mondayCache.data = payload;
    mondayCache.expiresAt = now + MONDAY_TTL_MS;

    console.log(
      `[API] ✅ Tickets normalized: ${items.length} items (group ${groupId}, TTL ${MONDAY_TTL_MS}ms)`
    );
    res.json(payload);
  } catch (error) {
    console.error("[API] ❌ Fetch error:", error.response?.data || error.message);
    res.status(500).json({
      ok: false,
      error: "Failed to fetch Monday tickets",
      details: error.response?.data || error.message,
    });
  }
});

/* ================================
   OUTLOOK TOKEN (OAuth)
   POST /api/outlook-auth
================================ */
app.post("/api/outlook-auth", (req, res) => {
  try {
    console.log("[Outlook] 🔐 Generating OAuth URL...");

    const clientId = process.env.OUTLOOK_CLIENT_ID;
    const tenantId = process.env.OUTLOOK_TENANT_ID;
    const redirectUri =
      process.env.OUTLOOK_REDIRECT_URI || "https://codepen.io";

    if (!clientId || !tenantId) {
      return res.status(500).json({
        ok: false,
        error: "Missing OUTLOOK_CLIENT_ID or OUTLOOK_TENANT_ID",
      });
    }

    const authUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(
      redirectUri
    )}&response_type=code&scope=Mail.Read Mail.Send offline_access`;

    console.log("[Outlook] ✅ OAuth URL generated");
    res.json({ ok: true, authUrl });
  } catch (e) {
    console.error("[Outlook] ❌ Error:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ================================
   TIDIO CONFIG
   GET /api/tidio-config
================================ */
app.get("/api/tidio-config", (req, res) => {
  try {
    console.log("[Tidio] 🔧 Fetching config...");

    const projectId = process.env.TIDIO_PROJECT_ID;
    if (!projectId) {
      return res.status(500).json({
        ok: false,
        error: "Missing TIDIO_PROJECT_ID",
      });
    }

    res.json({ ok: true, projectId });
  } catch (e) {
    console.error("[Tidio] ❌ Error:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ================================
   ERROR HANDLING
================================ */
app.use((err, req, res, next) => {
  console.error("[Error]", err);
  res.status(500).json({
    ok: false,
    error: "Internal server error",
  });
});

/* ================================
   START SERVER
================================ */
app.listen(PORT, () => {
  console.log(`✅ Backend running on port ${PORT}`);
  console.log(`📍 URL: ${baseUrl}`);
  console.log(`📅 Monday tickets: ${baseUrl}/api/monday/tickets`);
  console.log(`📞 TwiML Voice URL: ${baseUrl}/api/voice`);
});
