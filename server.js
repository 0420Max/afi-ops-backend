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
  TWILIO_API_KEY: process.env.TWILIO_API_KEY ? "✓" : "✗",
  TWILIO_API_SECRET: process.env.TWILIO_API_SECRET ? "✓" : "✗",
  TWILIO_TWIML_APP_SID: process.env.TWILIO_TWIML_APP_SID ? "✓" : "✗",
  TWILIO_PHONE_NUMBER: process.env.TWILIO_PHONE_NUMBER ? "✓" : "✗",
  MONDAY_TOKEN: process.env.MONDAY_TOKEN ? "✓" : "✗",
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
   ================================ */
app.post("/api/twilio-token", (req, res) => {
  try {
    console.log("[Twilio] 🔐 Generating token...");

    const AccessToken = twilio.jwt.AccessToken;
    const VoiceGrant = AccessToken.VoiceGrant;

    const token = new AccessToken(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_API_KEY,
      process.env.TWILIO_API_SECRET
    );

    token.addGrant(
      new VoiceGrant({
        outgoingApplicationSid: process.env.TWILIO_TWIML_APP_SID,
      })
    );

    const jwtToken = token.toJwt();
    console.log("[Twilio] ✅ Token generated successfully");

    res.json({
      token: jwtToken,
      accountSid: process.env.TWILIO_ACCOUNT_SID,
      phoneNumber: process.env.TWILIO_PHONE_NUMBER,
    });
  } catch (e) {
    console.error("[Twilio] ❌ Token Error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ================================
   TWIML VOICE (Logique d'appel)
   ✅ Gère les appels sortants depuis le navigateur
   ================================ */
app.post("/api/voice", (req, res) => {
  try {
    console.log("[Voice] 📞 Incoming TwiML request...");
    
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();
    const { To } = req.body;

    console.log(`[Voice] Dialing to: ${To}`);

    if (To) {
      // Crée un <Dial> vers le numéro de destination
      const dial = response.dial({
        callerId: process.env.TWILIO_PHONE_NUMBER, // Notre numéro Twilio
        timeout: 30,
      });

      // Vérifie si c'est un vrai numéro ou un client
      if (/^[\d\+\-\(\) ]+$/.test(To)) {
        // C'est un numéro: on appelle directement
        dial.number(To);
        console.log(`[Voice] ✅ Dialing phone number: ${To}`);
      } else {
        // C'est un client (identificateur texte)
        dial.client(To);
        console.log(`[Voice] ✅ Dialing client: ${To}`);
      }
    } else {
      response.say("Merci d'appeler AFI OPS. Aucun destinataire spécifié.");
      console.log("[Voice] ⚠️  No destination provided");
    }

    res.type("text/xml");
    res.send(response.toString());
  } catch (e) {
    console.error("[Voice] ❌ TwiML Error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ================================
   MONDAY TICKETS (POST - ANCIEN)
   ================================ */
app.post("/api/monday-tickets", async (req, res) => {
  try {
    console.log("[Monday] 📅 Fetching tickets (POST)...");

    const query = `
      query ($boardId: ID!) {
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
                }
              }
            }
          }
        }
      }
    `;

    const response = await axios.post("https://api.monday.com/v2", 
      {
        query,
        variables: { boardId: process.env.MONDAY_BOARD_ID },
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.MONDAY_TOKEN}`,
        },
      }
    );

    if (response.data.errors) {
      console.error("[Monday] ❌ GraphQL errors:", response.data.errors);
      return res.status(400).json({ errors: response.data.errors });
    }

    const board = response.data.data.boards[0];
    console.log(`[Monday] ✅ ${board.groups.length} groups fetched`);

    res.json({ board });
  } catch (e) {
    console.error("[Monday] ❌ Error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ================================
   MONDAY TICKETS (GET - SÉCURISÉ)
   ✅ Route proxy sécurisée - Token caché sur serveur
   ================================ */
app.get("/api/monday/tickets", async (req, res) => {
  console.log("[API] 📅 Fetching tickets from Monday (Proxy)...");

  if (!process.env.MONDAY_TOKEN) {
    console.error("❌ MONDAY_TOKEN manquant !");
    return res.status(500).json({ error: "Server misconfigured (missing MONDAY_TOKEN)" });
  }

  const boardId = process.env.MONDAY_BOARD_ID || 8770068548;
  
  const query = `
    query ($boardId: ID!) {
      boards(ids: [$boardId]) {
        id
        name
        groups {
          id
          title
          items_page(limit: 50) {
            items {
              id
              name
              created_at
              column_values {
                id
                text
                type
              }
            }
          }
        }
      }
    }
  `;

  try {
    const response = await axios.post(
      "https://api.monday.com/v2",
      { query, variables: { boardId } },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.MONDAY_TOKEN}`,
        },
      }
    );

    if (response.data.errors) {
      console.error("[API] ❌ Monday errors:", response.data.errors);
      return res.status(400).json({ errors: response.data.errors });
    }

    console.log("[API] ✅ Tickets fetched successfully");
    res.json(response.data);

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

    const clientId = process.env.OUTLOOK_CLIENT_ID;
    const tenantId = process.env.OUTLOOK_TENANT_ID;
    const redirectUri = process.env.OUTLOOK_REDIRECT_URI || "https://codepen.io";

    const authUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=Mail.Read Mail.Send offline_access`;

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

    console.log("[Tidio] ✅ Config ready");

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
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Backend running on port ${PORT}`);
  console.log(`📍 URL: http://localhost:${PORT}`);
  console.log(`📞 TwiML Voice URL: ${process.env.RENDER_EXTERNAL_URL || 'http://localhost:' + PORT}/api/voice`);
});
