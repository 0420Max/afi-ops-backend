/**
 * AFI OPS Backend (Render / Local)
 * - Twilio Voice Token (JWT moderne)
 * - TwiML Voice endpoint
 * - Monday tickets proxy normalisé (avec cache TTL)
 * - Monday Create Item (group "topics") ready
 */

const express = require("express");
const twilio = require("twilio");
const axios = require("axios");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

console.log("🚀 AFI OPS Backend starting...");
console.log("ENV vars loaded:", {
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID ? "✓" : "✗",
  TWILIO_API_KEY: process.env.TWILIO_API_KEY ? "✓(SK...)" : "✗",
  TWILIO_API_SECRET: process.env.TWILIO_API_SECRET ? "✓" : "✗",
  TWILIO_TWIML_APP_SID: process.env.TWILIO_TWIML_APP_SID ? "✓(AP...)" : "✗",
  TWILIO_PHONE_NUMBER: process.env.TWILIO_PHONE_NUMBER ? "✓" : "✗",
  MONDAY_TOKEN: process.env.MONDAY_TOKEN ? "✓" : "✗",
  MONDAY_BOARD_ID: process.env.MONDAY_BOARD_ID ? "✓" : "⚠️ fallback",
  MONDAY_GROUP_ID: process.env.MONDAY_GROUP_ID ? "✓" : "⚠️ fallback topics",
  RENDER_EXTERNAL_URL: process.env.RENDER_EXTERNAL_URL ? "✓" : "⚠️ local",
});

/* ================================
   HEALTH CHECK
================================ */
app.get("/", (req, res) => {
  res.json({
    status: "AFI OPS Backend OK",
    timestamp: new Date().toISOString(),
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

    if (
      !TWILIO_ACCOUNT_SID ||
      !TWILIO_API_KEY ||
      !TWILIO_API_SECRET ||
      !TWILIO_TWIML_APP_SID
    ) {
      return res.status(500).json({
        error: "Missing Twilio env vars. Check TWILIO_* in Render.",
      });
    }

    const AccessToken = twilio.jwt.AccessToken;
    const VoiceGrant = AccessToken.VoiceGrant;

    const identity = req.body?.identity || "afi-agent";

    const token = new AccessToken(
      TWILIO_ACCOUNT_SID,
      TWILIO_API_KEY, // doit être SK...
      TWILIO_API_SECRET, // secret de la SK
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
      token: jwtToken,
      identity,
      accountSid: TWILIO_ACCOUNT_SID,
      phoneNumber: TWILIO_PHONE_NUMBER || null,
      voiceUrl: `${baseUrl}/api/voice`,
    });
  } catch (e) {
    console.error("[Twilio] ❌ Token Error:", e.message);
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
  }
});

/* ================================
   MONDAY TICKETS + CACHE TTL
   GET /api/monday/tickets
   ✅ Retourne { items: [...] }
   ✅ FILTRE SUR GROUP "topics"
================================ */

// Cache mémoire simple
const mondayCache = {
  data: null,
  expiresAt: 0,
};
const MONDAY_TTL_MS = Number(process.env.MONDAY_TTL_MS || 25000); // 25s par défaut
const MONDAY_ITEMS_LIMIT = Number(process.env.MONDAY_ITEMS_LIMIT || 50);

app.get("/api/monday/tickets", async (req, res) => {
  console.log("[API] 📅 Fetching tickets from Monday (Proxy)...");

  if (!process.env.MONDAY_TOKEN) {
    console.error("❌ MONDAY_TOKEN manquant !");
    return res
      .status(500)
      .json({ error: "Server misconfigured (missing MONDAY_TOKEN)" });
  }

  // Serve cache si valide
  const now = Date.now();
  if (mondayCache.data && mondayCache.expiresAt > now) {
    console.log("[API] 🧠 Monday cache HIT");
    return res.json(mondayCache.data);
  }

  const boardId = process.env.MONDAY_BOARD_ID || 1763228524;
  const groupId = process.env.MONDAY_GROUP_ID || "topics";

  const query = `
    query ($boardId: ID!, $limit: Int!, $groups: [String!]) {
      boards(ids: [$boardId]) {
        id
        name
        items_page(
          limit: $limit,
          query_params: { groups: $groups }
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
          groups: [groupId],
        },
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.MONDAY_TOKEN}`,
          "API-Version": "2023-10",
        },
        timeout: 15000,
      }
    );

    if (response.data.errors) {
      console.error("[API] ❌ Monday errors:", response.data.errors);
      return res.status(400).json({ errors: response.data.errors });
    }

    const board = response.data?.data?.boards?.[0];
    if (!board) {
      console.warn("[API] ⚠️ No board returned from Monday");
      const empty = { items: [] };
      mondayCache.data = empty;
      mondayCache.expiresAt = now + MONDAY_TTL_MS;
      return res.json(empty);
    }

    const rawItems = board.items_page?.items || [];

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
        group: item.group || null, // important pour debug UI
        column_values: colMap,
      };
    });

    const payload = { items };

    // Store cache
    mondayCache.data = payload;
    mondayCache.expiresAt = now + MONDAY_TTL_MS;

    console.log(
      `[API] ✅ Tickets normalized: ${items.length} items from group "${groupId}" (cache TTL ${MONDAY_TTL_MS}ms)`
    );
    res.json(payload);
  } catch (error) {
    console.error("[API] ❌ Fetch error:", error.message);
    res.status(500).json({ error: "Failed to fetch Monday tickets" });
  }
});

/* ================================
   MONDAY CREATE ITEM
   POST /api/monday/create-ticket
   Body: { full_name, phone, email, address, issue_description, intent, language }
   ✅ crée dans group "topics"
================================ */

function mapIntent(intentRaw = "") {
  const v = String(intentRaw).toLowerCase().trim();
  if (v === "service") return "🔧 Service";
  if (v === "warranty") return "🛡️ Garantie";
  if (v === "parts") return "🔩 Pièce";
  if (v === "quote") return "💰 Soumission";
  return "🔧 Service"; // fallback safe
}

function mapLanguage(langRaw = "") {
  const v = String(langRaw).toLowerCase().trim();
  if (v === "fr") return "🃏 Français";
  if (v === "en") return "🇬🇧 English";
  return "🃏 Français";
}

app.post("/api/monday/create-ticket", async (req, res) => {
  console.log("[API] 🆕 Creating Monday item (topics)...");

  if (!process.env.MONDAY_TOKEN) {
    return res
      .status(500)
      .json({ error: "Server misconfigured (missing MONDAY_TOKEN)" });
  }

  const boardId = process.env.MONDAY_BOARD_ID || 1763228524;
  const groupId = process.env.MONDAY_GROUP_ID || "topics";

  const {
    full_name = "",
    phone = "",
    email = "",
    address = "",
    issue_description = "",
    intent = "service",
    language = "fr",
  } = req.body || {};

  const mapped_intent = mapIntent(intent);
  const mapped_language = mapLanguage(language);

  const itemName = `Ticket AFI – ${full_name || "Client"} – ${intent || "service"}`;

  const column_values = {
    text_mkx51q5v: full_name,
    phone_mkx5xy3x: phone,
    email_mkx53410: email,
    text_mkx528gx: address,
    long_text_mkx59qsr: issue_description,
    status: mapped_intent,
    color_mkx5e9jt: mapped_language,
    date_mkx5asat: new Date().toISOString().slice(0, 10), // YYYY-MM-DD
  };

  const mutation = `
    mutation ($boardId: ID!, $groupId: String!, $itemName: String!, $columnVals: JSON!) {
      create_item (
        board_id: $boardId,
        group_id: $groupId,
        item_name: $itemName,
        column_values: $columnVals
      ) {
        id
      }
    }
  `;

  try {
    const response = await axios.post(
      "https://api.monday.com/v2",
      {
        query: mutation,
        variables: {
          boardId,
          groupId,
          itemName,
          columnVals: JSON.stringify(column_values),
        },
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.MONDAY_TOKEN}`,
          "API-Version": "2023-10",
        },
        timeout: 15000,
      }
    );

    if (response.data.errors) {
      console.error("[API] ❌ Monday create errors:", response.data.errors);
      return res.status(400).json({ errors: response.data.errors });
    }

    const newId = response.data?.data?.create_item?.id;
    console.log("[API] ✅ Monday item created:", newId);

    // Invalidate cache so UI sees it fast
    mondayCache.data = null;
    mondayCache.expiresAt = 0;

    res.json({ ok: true, id: newId });
  } catch (error) {
    console.error("[API] ❌ Create item error:", error.message);
    res.status(500).json({ error: "Failed to create Monday ticket" });
  }
});

/* ================================
   OUTLOOK TOKEN (OAuth)
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

/* ================================
   TIDIO CONFIG
================================ */
app.get("/api/tidio-config", (req, res) => {
  try {
    console.log("[Tidio] 🔧 Fetching config...");

    const projectId = process.env.TIDIO_PROJECT_ID;
    if (!projectId) {
      return res.status(500).json({ error: "Missing TIDIO_PROJECT_ID" });
    }

    res.json({ projectId });
  } catch (e) {
    console.error("[Tidio] ❌ Error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ================================
   ERROR HANDLING
================================ */
app.use((err, req, res, next) => {
  console.error("[Error]", err);
  res.status(500).json({ error: "Internal server error" });
});

/* ================================
   START SERVER
================================ */
app.listen(PORT, () => {
  console.log(`✅ Backend running on port ${PORT}`);
  console.log(`📍 URL: ${baseUrl}`);
  console.log(`📞 TwiML Voice URL: ${baseUrl}/api/voice`);
  console.log(
    `📅 Monday tickets URL: ${baseUrl}/api/monday/tickets (group topics)`
  );
  console.log(
    `🆕 Monday create URL: ${baseUrl}/api/monday/create-ticket`
  );
});
