/**
 * ============================================================
 * AFI OPS – Backend Central (STABLE / FIGÉ)
 * ============================================================
 * Source de vérité backend
 * Compatible HTML / CSS / app.js fournis
 * ============================================================
 */

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
require("dotenv").config();

const app = express();

/* ============================================================
   0) CORS
============================================================ */

const allowedOrigins = [
  "https://cdpn.io",
  "https://codepen.io",
  "http://localhost:3000",
  "http://localhost:5173",
];

function isAllowed(origin) {
  if (!origin) return true;
  if (allowedOrigins.includes(origin)) return true;
  if (origin.endsWith(".codepen.io") || origin.endsWith(".cdpn.io")) return true;
  return false;
}

app.use(
  cors({
    origin(origin, cb) {
      return isAllowed(origin)
        ? cb(null, true)
        : cb(new Error("CORS blocked"), false);
    },
    credentials: true,
  })
);

app.use(express.json({ limit: "1mb" }));

/* ============================================================
   1) ENV
============================================================ */

const PORT = process.env.PORT || 10000;
const BASE_URL =
  process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

const {
  MONDAY_TOKEN,
  MONDAY_BOARD_ID,
  MONDAY_ITEMS_LIMIT,
  MONDAY_API_VERSION,

  OUTLOOK_CLIENT_ID,
  OUTLOOK_TENANT_ID,
  OUTLOOK_CLIENT_SECRET,
  OUTLOOK_REDIRECT_URI,

  YOUTUBE_API_KEY,
} = process.env;

const MONDAY_LIMIT = Number(MONDAY_ITEMS_LIMIT || 50);
const MONDAY_VERSION = MONDAY_API_VERSION || "2023-10";

/* ============================================================
   2) HEALTH / VERSION
============================================================ */

app.get("/api/health", (_, res) => {
  res.json({
    ok: true,
    timestamp: new Date().toISOString(),
    baseUrl: BASE_URL,
  });
});

/* ============================================================
   3) MONDAY – TICKETS
============================================================ */

const MONDAY_URL = "https://api.monday.com/v2";

function mondayHeaders() {
  if (!MONDAY_TOKEN) throw new Error("MONDAY_TOKEN missing");
  return {
    Authorization: `Bearer ${MONDAY_TOKEN}`,
    "Content-Type": "application/json",
    "API-Version": MONDAY_VERSION,
  };
}

app.get("/api/monday/tickets", async (_, res) => {
  try {
    const query = `
      query ($boardId: ID!, $limit: Int!) {
        boards(ids: [$boardId]) {
          items_page(limit: $limit) {
            items {
              id
              name
              updated_at
              column_values { id text type }
            }
          }
        }
      }
    `;

    const r = await axios.post(
      MONDAY_URL,
      {
        query,
        variables: {
          boardId: MONDAY_BOARD_ID,
          limit: MONDAY_LIMIT,
        },
      },
      { headers: mondayHeaders(), timeout: 15000 }
    );

    const items =
      r.data?.data?.boards?.[0]?.items_page?.items || [];

    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ============================================================
   4) OUTLOOK – OAUTH + MESSAGES
============================================================ */

const TOKEN_FILE = "./outlook-tokens.json";

let outlook = {
  connected: false,
  access_token: null,
  refresh_token: null,
  expires_at: 0,
  pending_state: null,
};

if (fs.existsSync(TOKEN_FILE)) {
  try {
    outlook = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
  } catch {}
}

function saveOutlook() {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(outlook, null, 2));
}

function tokenValid() {
  return outlook.access_token && outlook.expires_at > Date.now() + 60000;
}

async function refreshTokenIfNeeded() {
  if (tokenValid()) return outlook.access_token;
  if (!outlook.refresh_token) return null;

  const params = new URLSearchParams({
    client_id: OUTLOOK_CLIENT_ID,
    client_secret: OUTLOOK_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: outlook.refresh_token,
    redirect_uri: OUTLOOK_REDIRECT_URI,
    scope: "offline_access Mail.Read User.Read",
  });

  const r = await axios.post(
    `https://login.microsoftonline.com/${OUTLOOK_TENANT_ID}/oauth2/v2.0/token`,
    params.toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  outlook.access_token = r.data.access_token;
  outlook.refresh_token =
    r.data.refresh_token || outlook.refresh_token;
  outlook.expires_at = Date.now() + r.data.expires_in * 1000;
  outlook.connected = true;

  saveOutlook();
  return outlook.access_token;
}

app.get("/api/outlook-status", async (_, res) => {
  await refreshTokenIfNeeded();
  res.json({ connected: !!outlook.connected });
});

app.post("/api/outlook-auth", (_, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  outlook.pending_state = state;
  saveOutlook();

  const url = new URL(
    `https://login.microsoftonline.com/${OUTLOOK_TENANT_ID}/oauth2/v2.0/authorize`
  );
  url.searchParams.set("client_id", OUTLOOK_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", OUTLOOK_REDIRECT_URI);
  url.searchParams.set("scope", "offline_access Mail.Read User.Read");
  url.searchParams.set("state", state);

  res.json({ authUrl: url.toString() });
});

app.get("/api/outlook/callback", async (req, res) => {
  if (req.query.state !== outlook.pending_state) {
    return res.status(400).send("State mismatch");
  }

  const params = new URLSearchParams({
    client_id: OUTLOOK_CLIENT_ID,
    client_secret: OUTLOOK_CLIENT_SECRET,
    grant_type: "authorization_code",
    code: req.query.code,
    redirect_uri: OUTLOOK_REDIRECT_URI,
    scope: "offline_access Mail.Read User.Read",
  });

  const r = await axios.post(
    `https://login.microsoftonline.com/${OUTLOOK_TENANT_ID}/oauth2/v2.0/token`,
    params.toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  outlook.access_token = r.data.access_token;
  outlook.refresh_token = r.data.refresh_token;
  outlook.expires_at = Date.now() + r.data.expires_in * 1000;
  outlook.connected = true;
  outlook.pending_state = null;

  saveOutlook();

  res.send(
    `<script>window.opener.postMessage({type:"OUTLOOK_CONNECTED"},"*");window.close()</script>`
  );
});

app.get("/api/outlook/messages", async (_, res) => {
  try {
    const token = await refreshTokenIfNeeded();
    if (!token) return res.status(401).json({ error: "Not connected" });

    const r = await axios.get(
      "https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages?$top=25",
      { headers: { Authorization: `Bearer ${token}` } }
    );

    res.json({ messages: r.data.value || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ============================================================
   5) YOUTUBE
============================================================ */

app.get("/api/youtube/search", async (req, res) => {
  if (!YOUTUBE_API_KEY) return res.json({ items: [] });

  const url = new URL(
    "https://www.googleapis.com/youtube/v3/search"
  );
  url.searchParams.set("part", "snippet");
  url.searchParams.set("q", req.query.q || "");
  url.searchParams.set("key", YOUTUBE_API_KEY);
  url.searchParams.set("type", "video");
  url.searchParams.set("maxResults", "8");

  const r = await axios.get(url.toString());
  res.json({ items: r.data.items || [] });
});

/* ============================================================
   START
============================================================ */

app.listen(PORT, () => {
  console.log("AFI OPS backend running");
  console.log("Base URL:", BASE_URL);
});
