/**

* AFI OPS Backend (Render / Local)
* * Twilio Voice Token (JWT moderne)
* * TwiML Voice endpoint
* * Monday tickets proxy normalisé + cache TTL
    */

const express = require("express");
const twilio = require("twilio");
const axios = require("axios");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

console.log("🚀 AFI OPS Backend starting...");
console.log("ENV vars loaded:", {
TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID ? "✓" : "✗",
TWILIO_API_KEY: process.env.TWILIO_API_KEY ? "✓(SK...)" : "✗",
TWILIO_API_SECRET: process.env.TWILIO_API_SECRET ? "✓" : "✗",
TWILIO_TWIML_APP_SID: process.env.TWILIO_TWIML_APP_SID ? "✓(AP...)" : "✗",
TWILIO_PHONE_NUMBER: process.env.TWILIO_PHONE_NUMBER ? "✓" : "✗",
MONDAY_TOKEN: process.env.MONDAY_TOKEN ? "✓" : "✗",
MONDAY_BOARD_ID: process.env.MONDAY_BOARD_ID ? "✓" : "⚠️ fallback",
RENDER_EXTERNAL_URL: process.env.RENDER_EXTERNAL_URL ? "✓" : "⚠️ local",
});

/* ================================
SIMPLE CACHE (in-memory)

* 1 clé: "monday_tickets"
* TTL par défaut 15s (front refresh 15s)
  ================================ */
  const cache = new Map();
  const CACHE_TTL_MS = Number(process.env.MONDAY_CACHE_TTL_MS || 15000);

function cacheGet(key) {
const entry = cache.get(key);
if (!entry) return null;
const isExpired = Date.now() - entry.ts > entry.ttl;
if (isExpired) {
cache.delete(key);
return null;
}
return entry.value;
}

function cacheSet(key, value, ttl = CACHE_TTL_MS) {
cache.set(key, { value, ts: Date.now(), ttl });
}

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

```
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_API_KEY,
  TWILIO_API_SECRET,
  TWILIO_TWIML_APP_SID,
  TWILIO_PHONE_NUMBER,
} = process.env;

if (!TWILIO_ACCOUNT_SID || !TWILIO_API_KEY || !TWILIO_API_SECRET || !TWILIO_TWIML_APP_SID) {
  return res.status(500).json({
    error: "Missing Twilio env vars. Check TWILIO_* in Render.",
  });
}

const AccessToken = twilio.jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;

const identity = req.body?.identity || "afi-agent";

const token = new AccessToken(
  TWILIO_ACCOUNT_SID,
  TWILIO_API_KEY,     // SK...
  TWILIO_API_SECRET,  // secret SK
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

const baseUrl =
  process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 10000}`;

res.json({
  token: jwtToken,
  identity,
  accountSid: TWILIO_ACCOUNT_SID,
  phoneNumber: TWILIO_PHONE_NUMBER || null,
  voiceUrl: `${baseUrl}/api/voice`,
});
```

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

```
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
```

} catch (e) {
console.error("[Voice] ❌ TwiML Error:", e.message);
res.status(500).json({ error: e.message });
}
});

/* ================================
MONDAY TICKETS (GET - PROXY NORMALISÉ + CACHE)
GET /api/monday/tickets
Retourne { items: [...] }
================================ */
app.get("/api/monday/tickets", async (req, res) => {
console.log("[API] 📅 Fetching tickets from Monday (Proxy)...");

if (!process.env.MONDAY_TOKEN) {
console.error("❌ MONDAY_TOKEN manquant !");
return res
.status(500)
.json({ error: "Server misconfigured (missing MONDAY_TOKEN)" });
}

// 1) Cache hit?
const cached = cacheGet("monday_tickets");
if (cached) {
console.log(`[API] ⚡ Cache hit (${cached.items?.length || 0} items)`);
return res.json(cached);
}

const boardId = process.env.MONDAY_BOARD_ID || 8770068548;

const query = `     query ($boardId: ID!) {
      boards(ids: [$boardId]) {
        id
        name
        groups {
          id
          title
          items_page(limit: 100) {
            items {
              id
              name
              created_at
              updated_at
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
    }
  `;

try {
const response = await axios.post(
"[https://api.monday.com/v2](https://api.monday.com/v2)",
{ query, variables: { boardId } },
{
headers: {
"Content-Type": "application/json",
Authorization: `Bearer ${process.env.MONDAY_TOKEN}`,
"API-Version": "2023-10",
},
timeout: 15000,
}
);

```
if (response.data.errors) {
  console.error("[API] ❌ Monday errors:", response.data.errors);
  return res.status(400).json({ errors: response.data.errors });
}

const boards = response.data?.data?.boards || [];
const board = boards[0];

if (!board) {
  console.warn("[API] ⚠️ No board returned from Monday");
  const emptyPayload = { items: [] };
  cacheSet("monday_tickets", emptyPayload);
  return res.json(emptyPayload);
}

console.log("[API] Board:", board.id, board.name);

const items = [];

(board.groups || []).forEach((group) => {
  const groupItems = group.items_page?.items || [];
  groupItems.forEach((item) => {
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

    items.push({
      id: item.id,
      name: item.name,
      created_at: item.created_at,
      updated_at: item.updated_at,
      column_values: colMap,
      _group: { id: group.id, title: group.title },
    });
  });
});

const payload = { items };
console.log(`[API] ✅ Tickets normalized: ${items.length} items`);

// 2) Cache set
cacheSet("monday_tickets", payload);

res.json(payload);
```

} catch (error) {
console.error("[API] ❌ Fetch error:", error.message);
res.status(500).json({ error: "Failed to fetch Monday tickets" });
}
});

/* ================================
OUTLOOK TOKEN (OAuth)
================================ */
app.post("/api/outlook-auth", (req, res) => {
try {
console.log("[Outlook] 🔐 Generating OAuth URL...");

```
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
```

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

```
const projectId = process.env.TIDIO_PROJECT_ID;
if (!projectId) {
  return res.status(500).json({ error: "Missing TIDIO_PROJECT_ID" });
}

res.json({ projectId });
```

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
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
const baseUrl =
process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
console.log(`✅ Backend running on port ${PORT}`);
console.log(`📍 URL: ${baseUrl}`);
console.log(`📞 TwiML Voice URL: ${baseUrl}/api/voice`);
});
