/**
 * AFI OPS Backend — server.js
 * Canon 2025-12-09
 *
 * Features:
 * - Healthcheck
 * - Microsoft Outlook OAuth2 (Authorization Code Flow)
 * - Fetch recent emails via Microsoft Graph
 *
 * Required ENV on Render:
 *  PORT=10000 (ou auto)
 *  NODE_ENV=production
 *  FRONTEND_ORIGINS=https://cdpn.io,https://codepen.io,https://afi-ops.onrender.com (ajuste)
 *
 *  MS_CLIENT_ID=xxxxx
 *  MS_CLIENT_SECRET=xxxxx
 *  MS_TENANT_ID=common  (ou ton tenant)
 *  MS_REDIRECT_URI=https://afi-ops-backend.onrender.com/api/outlook-callback
 *
 * Optional:
 *  MS_SCOPES="openid profile offline_access Mail.Read User.Read"
 */

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";
import qs from "qs";

dotenv.config();

const app = express();
app.use(express.json());

// -----------------------------
// 0) Config
// -----------------------------
const {
  PORT = 10000,
  NODE_ENV = "development",
  FRONTEND_ORIGINS = "https://codepen.io,https://cdpn.io",
  MS_CLIENT_ID,
  MS_CLIENT_SECRET,
  MS_TENANT_ID = "common",
  MS_REDIRECT_URI,
  MS_SCOPES = "openid profile offline_access Mail.Read User.Read",
} = process.env;

const origins = FRONTEND_ORIGINS.split(",").map(s => s.trim()).filter(Boolean);

// CORS (CodePen + futur AFI)
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // allow curl/postman
      if (origins.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS blocked origin: ${origin}`));
    },
    credentials: true,
  })
);

// -----------------------------
// 1) Mini token store (MVP)
//    => remplace par Redis/DB ensuite
// -----------------------------
const tokenStore = {
  access_token: null,
  refresh_token: null,
  expires_at: 0,
};

// -----------------------------
// 2) Helpers Microsoft OAuth
// -----------------------------
function assertMsEnv() {
  const missing = [];
  if (!MS_CLIENT_ID) missing.push("MS_CLIENT_ID");
  if (!MS_CLIENT_SECRET) missing.push("MS_CLIENT_SECRET");
  if (!MS_REDIRECT_URI) missing.push("MS_REDIRECT_URI");
  if (missing.length) {
    const msg = `[CONFIG] Missing env: ${missing.join(", ")}`;
    console.error(msg);
    throw new Error(msg);
  }
}

function buildAuthUrl() {
  const params = new URLSearchParams({
    client_id: MS_CLIENT_ID,
    response_type: "code",
    redirect_uri: MS_REDIRECT_URI,
    response_mode: "query",
    scope: MS_SCOPES,
    prompt: "select_account",
  });

  return `https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/authorize?${params.toString()}`;
}

async function exchangeCodeForToken(code) {
  const tokenUrl = `https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/token`;
  const data = {
    client_id: MS_CLIENT_ID,
    client_secret: MS_CLIENT_SECRET,
    grant_type: "authorization_code",
    code,
    redirect_uri: MS_REDIRECT_URI,
    scope: MS_SCOPES,
  };

  const res = await axios.post(tokenUrl, qs.stringify(data), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 15000,
  });

  return res.data;
}

async function refreshAccessToken() {
  if (!tokenStore.refresh_token) throw new Error("No refresh token in store");

  const tokenUrl = `https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/token`;
  const data = {
    client_id: MS_CLIENT_ID,
    client_secret: MS_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: tokenStore.refresh_token,
    redirect_uri: MS_REDIRECT_URI,
    scope: MS_SCOPES,
  };

  const res = await axios.post(tokenUrl, qs.stringify(data), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 15000,
  });

  return res.data;
}

async function getValidAccessToken() {
  const now = Date.now();
  if (tokenStore.access_token && now < tokenStore.expires_at - 60_000) {
    return tokenStore.access_token;
  }

  // try refresh
  const refreshed = await refreshAccessToken();
  tokenStore.access_token = refreshed.access_token;
  tokenStore.refresh_token = refreshed.refresh_token || tokenStore.refresh_token;
  tokenStore.expires_at = now + (refreshed.expires_in * 1000);

  return tokenStore.access_token;
}

// -----------------------------
// 3) Routes
// -----------------------------

// Healthcheck Render
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    env: NODE_ENV,
    time: new Date().toISOString(),
    outlookConnected: !!tokenStore.access_token,
  });
});

// FRONT → demander URL auth
app.post("/api/outlook-auth", (req, res) => {
  try {
    assertMsEnv();
    const url = buildAuthUrl();
    res.json({ ok: true, url });
  } catch (err) {
    console.error("[Outlook Auth] error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Microsoft redirect → échange code
app.get("/api/outlook-callback", async (req, res) => {
  try {
    assertMsEnv();
    const { code, error, error_description } = req.query;

    if (error) {
      console.error("[Outlook Callback] error:", error, error_description);
      return res.status(400).send("Outlook auth error. Check logs.");
    }

    if (!code) {
      return res.status(400).send("Missing code");
    }

    const tokenData = await exchangeCodeForToken(code);

    tokenStore.access_token = tokenData.access_token;
    tokenStore.refresh_token = tokenData.refresh_token || null;
    tokenStore.expires_at = Date.now() + (tokenData.expires_in * 1000);

    // small success page
    res.send(`
      <html>
        <head><title>AFI OPS Outlook Connected</title></head>
        <body style="font-family:system-ui; padding:24px;">
          <h2>✅ Outlook connecté</h2>
          <p>Tu peux fermer cette fenêtre et revenir dans AFI OPS.</p>
        </body>
      </html>
    `);
  } catch (err) {
    console.error("[Outlook Callback] fatal:", err.response?.data || err.message);
    res.status(500).send("Outlook callback failed. Check server logs.");
  }
});

// FRONT → fetch emails
app.get("/api/outlook-emails", async (req, res) => {
  try {
    assertMsEnv();
    const accessToken = await getValidAccessToken();

    // last 10 messages from inbox
    const graphUrl =
      "https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages?$top=10&$orderby=receivedDateTime DESC";

    const graphRes = await axios.get(graphUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 15000,
    });

    const messages = (graphRes.data?.value || []).map(m => ({
      id: m.id,
      subject: m.subject,
      from: m.from?.emailAddress?.address || "",
      fromName: m.from?.emailAddress?.name || "",
      receivedDateTime: m.receivedDateTime,
      preview: m.bodyPreview,
      webLink: m.webLink,
    }));

    res.json({ ok: true, messages });
  } catch (err) {
    const status = err.response?.status || 500;
    const payload = err.response?.data || err.message;
    console.error("[Outlook Emails] error:", status, payload);
    res.status(status).json({ ok: false, error: payload });
  }
});

// -----------------------------
// 4) 404 safe
// -----------------------------
app.use((req, res) => {
  res.status(404).json({ ok: false, error: "Route not found" });
});

// -----------------------------
// 5) Boot
// -----------------------------
app.listen(PORT, () => {
  console.log(`AFI OPS backend up on :${PORT} (${NODE_ENV})`);
  console.log("Allowed origins:", origins);
});
