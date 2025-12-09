/**
 * AFI OPS Backend • server.js
 * Canon 2025-12-09
 *
 * Endpoints attendus par app.js:
 *  - POST /api/twilio-token
 *  - GET  /api/monday/tickets
 *  - POST /api/monday/upsert-ticket
 *  - POST /api/monday/resolve-ticket
 *  - GET  /api/transcript/active
 *  - GET  /api/transcript/by-sid?sid=
 *  - GET  /api/outlook-status
 *  - POST /api/outlook-auth
 *  - GET  /api/youtube/search?q=
 *  - POST /api/gpt/analyze-ticket
 *  - POST /api/gpt/generate-wrap
 *  - GET  /api/tidio-config
 *
 * Assumptions:
 *  - Monday board a un group "sav" et optionnellement "sales"
 *  - tes colonnes Monday sont déjà mappées côté front (mapMondayItemToTicket)
 *  - transcript "active" = dernier transcript en RAM ou DB (ici RAM)
 *  - visio/outlook: OAuth Graph standard, stock token en mémoire (swap Redis/DB quand tu veux)
 */

import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import fetch from "node-fetch";
import Twilio from "twilio";
import { google } from "googleapis";
import "dotenv/config";

// -------------------------
// 0) APP + MIDDLEWARE
// -------------------------

const app = express();
app.set("trust proxy", 1);

app.use(helmet());
app.use(
  cors({
    origin: (origin, cb) => cb(null, true), // open cors for now (CodePen + prod). Lock later.
    credentials: true,
  })
);
app.use(express.json({ limit: "2mb" }));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// Simple request logger
app.use((req, _res, next) => {
  const t = new Date().toISOString();
  console.log(`[${t}] ${req.method} ${req.path}`);
  next();
});

// -------------------------
// 1) ENV VALIDATION
// -------------------------

function needEnv(name, optional = false) {
  const v = process.env[name];
  if (!v && !optional) {
    console.warn(`⚠️ Missing ENV: ${name}`);
  }
  return v || "";
}

const PORT = process.env.PORT || 3000;

// Twilio
const TWILIO_ACCOUNT_SID = needEnv("TWILIO_ACCOUNT_SID", true);
const TWILIO_API_KEY_SID = needEnv("TWILIO_API_KEY_SID", true);
const TWILIO_API_KEY_SECRET = needEnv("TWILIO_API_KEY_SECRET", true);
const TWILIO_APP_SID = needEnv("TWILIO_APP_SID", true);

// Monday
const MONDAY_API_TOKEN = needEnv("MONDAY_API_TOKEN", true);
const MONDAY_BOARD_ID = needEnv("MONDAY_BOARD_ID", true);
const MONDAY_GROUP_SAV = needEnv("MONDAY_GROUP_SAV", true) || "sav";
const MONDAY_GROUP_SALES = needEnv("MONDAY_GROUP_SALES", true) || "sales";

// YouTube
const YT_API_KEY = needEnv("YT_API_KEY", true);

// Outlook (Graph OAuth)
const OUTLOOK_CLIENT_ID = needEnv("OUTLOOK_CLIENT_ID", true);
const OUTLOOK_CLIENT_SECRET = needEnv("OUTLOOK_CLIENT_SECRET", true);
const OUTLOOK_TENANT_ID = needEnv("OUTLOOK_TENANT_ID", true);
const OUTLOOK_REDIRECT_URI = needEnv("OUTLOOK_REDIRECT_URI", true);
const OUTLOOK_SCOPES =
  needEnv("OUTLOOK_SCOPES", true) ||
  "offline_access Mail.Read Mail.Send User.Read";

// OpenAI
const OPENAI_API_KEY = needEnv("OPENAI_API_KEY", true);
const OPENAI_MODEL =
  needEnv("OPENAI_MODEL", true) || "gpt-4.1-mini"; // ajuste si tu veux

// Tidio
const TIDIO_PROJECT_ID = needEnv("TIDIO_PROJECT_ID", true);

// -------------------------
// 2) HELPERS
// -------------------------

function ok(res, payload = {}) {
  res.json({ ok: true, ...payload });
}

function fail(res, status, message, extra = {}) {
  res.status(status).json({ ok: false, error: message, ...extra });
}

function assertBody(req, keys = []) {
  for (const k of keys) {
    if (req.body?.[k] == null || req.body?.[k] === "") {
      return `Missing body field: ${k}`;
    }
  }
  return null;
}

async function safeJson(res) {
  const text = await res.text().catch(() => "");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

// -------------------------
// 3) TWILIO TOKEN
// -------------------------

app.post("/api/twilio-token", async (req, res) => {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_API_KEY_SID || !TWILIO_API_KEY_SECRET) {
    return fail(res, 501, "Twilio env not configured");
  }

  const identity = String(req.body?.identity || "afi_agent").trim();

  try {
    const AccessToken = Twilio.jwt.AccessToken;
    const VoiceGrant = AccessToken.VoiceGrant;

    const token = new AccessToken(
      TWILIO_ACCOUNT_SID,
      TWILIO_API_KEY_SID,
      TWILIO_API_KEY_SECRET,
      { identity, ttl: 3600 }
    );

    const grant = new VoiceGrant({
      outgoingApplicationSid: TWILIO_APP_SID || undefined,
      incomingAllow: true,
    });

    token.addGrant(grant);
    ok(res, { token: token.toJwt() });
  } catch (e) {
    console.error("[twilio-token]", e);
    fail(res, 500, "Failed to mint Twilio token");
  }
});

// -------------------------
// 4) MONDAY PROXY
// -------------------------

async function mondayGraphQL(query, variables = {}) {
  if (!MONDAY_API_TOKEN) throw new Error("Monday token missing");

  const r = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: MONDAY_API_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  const data = await safeJson(r);
  if (!r.ok || data?.errors) {
    const msg =
      data?.errors?.[0]?.message ||
      data?.error ||
      data?.raw ||
      `Monday HTTP ${r.status}`;
    throw new Error(msg);
  }
  return data?.data;
}

app.get("/api/monday/tickets", async (req, res) => {
  if (!MONDAY_BOARD_ID) {
    return ok(res, { items: [] }); // frontend fallback demo
  }

  const groupId = String(req.query.groupId || MONDAY_GROUP_SAV);

  const query = `
    query ($boardId: [ID!], $groupId: [String!]) {
      boards(ids: $boardId) {
        id
        groups(ids: $groupId) {
          id
          title
          items_page(limit: 50) {
            items {
              id
              name
              updated_at
              column_values {
                id
                text
                value
                type
              }
            }
          }
        }
      }
    }
  `;

  try {
    const data = await mondayGraphQL(query, {
      boardId: MONDAY_BOARD_ID,
      groupId,
    });

    const items =
      data?.boards?.[0]?.groups?.[0]?.items_page?.items || [];
    ok(res, { items });
  } catch (e) {
    console.error("[monday/tickets]", e);
    fail(res, 500, "Monday tickets fetch failed", {
      details: e.message,
    });
  }
});

app.post("/api/monday/upsert-ticket", async (req, res) => {
  if (!MONDAY_BOARD_ID) return fail(res, 501, "Monday not configured");

  const err = assertBody(req, ["ticketId"]);
  if (err) return fail(res, 400, err);

  const ticketId = String(req.body.ticketId);
  const ticket = req.body.ticket || {};
  const groupId =
    String(req.body.groupId || req.body.ticket?.groupId || MONDAY_GROUP_SAV);

  // Minimal column mapping. Ajuste IDs si tu veux write des colonnes précises.
  // Ici je pousse name + long_text "description_probleme" si dispo
  const itemName =
    ticket?.clientName && ticket?.topic
      ? `${ticket.clientName} · ${ticket.topic}`
      : ticket?.listTitle || ticketId;

  const colVals = {};
  if (ticket?.wrap) colVals["long_text_mkx59qsr"] = ticket.wrap;
  if (ticket?.address) colVals["text_mkx528gx"] = ticket.address;
  if (ticket?.phone) colVals["phone_mksmhr3b"] = ticket.phone;
  if (ticket?.email) colVals["email_mkpfc74p"] = ticket.email;

  const mutationCreate = `
    mutation ($boardId: ID!, $groupId: String!, $itemName: String!, $colVals: JSON!) {
      create_item(board_id: $boardId, group_id: $groupId, item_name: $itemName, column_values: $colVals) {
        id
      }
    }
  `;

  const mutationUpdate = `
    mutation ($boardId: ID!, $itemId: ID!, $colVals: JSON!) {
      change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $colVals) {
        id
      }
    }
  `;

  try {
    let itemId = String(req.body.mondayItemId || ticket?.mondayItemId || "");

    // si itemId fourni -> update, sinon create
    if (itemId) {
      await mondayGraphQL(mutationUpdate, {
        boardId: MONDAY_BOARD_ID,
        itemId,
        colVals: JSON.stringify(colVals),
      });
      ok(res, { status: "updated", itemId });
      return;
    }

    const data = await mondayGraphQL(mutationCreate, {
      boardId: MONDAY_BOARD_ID,
      groupId,
      itemName,
      colVals: JSON.stringify(colVals),
    });

    itemId = data?.create_item?.id;
    ok(res, { status: "created", itemId });
  } catch (e) {
    console.error("[monday/upsert]", e);
    fail(res, 500, "Monday upsert failed", { details: e.message });
  }
});

app.post("/api/monday/resolve-ticket", async (req, res) => {
  if (!MONDAY_BOARD_ID) return fail(res, 501, "Monday not configured");

  const err = assertBody(req, ["ticketId"]);
  if (err) return fail(res, 400, err);

  const ticketId = String(req.body.ticketId);
  const itemId = String(req.body.mondayItemId || ticketId);

  // Exemple: set un status "Résolu" sur colonne status principale.
  // Ajuste "status" -> ton id de colonne.
  const mutation = `
    mutation ($boardId: ID!, $itemId: ID!, $status: String!) {
      change_simple_column_value(board_id: $boardId, item_id: $itemId, column_id: "status", value: $status) {
        id
      }
    }
  `;

  try {
    await mondayGraphQL(mutation, {
      boardId: MONDAY_BOARD_ID,
      itemId,
      status: JSON.stringify({ label: "Résolu" }),
    });
    ok(res, { itemId });
  } catch (e) {
    console.error("[monday/resolve]", e);
    fail(res, 500, "Monday resolve failed", { details: e.message });
  }
});

// -------------------------
// 5) TRANSCRIPT (RAM v1)
// -------------------------

let activeTranscript = {
  sid: null,
  text: "",
  updatedAt: 0,
};

app.get("/api/transcript/active", (_req, res) => {
  if (!activeTranscript.text) {
    return ok(res, { text: "" });
  }
  ok(res, { ...activeTranscript });
});

app.get("/api/transcript/by-sid", (req, res) => {
  const sid = String(req.query.sid || "").trim();
  if (!sid) return fail(res, 400, "Missing sid");
  if (activeTranscript.sid !== sid) return ok(res, { text: "" });
  ok(res, { ...activeTranscript });
});

// Hook futur: POST /api/transcript/ingest (Twilio webhook, STT, etc.)
app.post("/api/transcript/ingest", (req, res) => {
  const { sid, text } = req.body || {};
  if (!sid || !text) return fail(res, 400, "Missing sid/text");

  activeTranscript = {
    sid: String(sid),
    text: String(text),
    updatedAt: Date.now(),
  };
  ok(res, { stored: true });
});

// -------------------------
// 6) YOUTUBE SEARCH PROXY
// -------------------------

app.get("/api/youtube/search", async (req, res) => {
  if (!YT_API_KEY) return fail(res, 501, "YT env not configured");

  const q = String(req.query.q || "").trim();
  if (!q) return ok(res, { items: [] });

  try {
    const url =
      "https://www.googleapis.com/youtube/v3/search" +
      `?part=snippet&type=video&maxResults=8&q=${encodeURIComponent(q)}` +
      `&key=${encodeURIComponent(YT_API_KEY)}`;

    const r = await fetch(url);
    const data = await safeJson(r);

    const items = (data.items || []).map((it) => ({
      videoId: it.id?.videoId,
      title: it.snippet?.title || "Video",
      thumbnail:
        it.snippet?.thumbnails?.medium?.url ||
        it.snippet?.thumbnails?.default?.url ||
        "",
    })).filter(x => x.videoId);

    ok(res, { items });
  } catch (e) {
    console.error("[youtube/search]", e);
    fail(res, 500, "YouTube search failed");
  }
});

// -------------------------
// 7) OUTLOOK (Graph OAuth v1)
// -------------------------

let outlookTokenStore = {
  accessToken: "",
  refreshToken: "",
  expiresAt: 0,
};

function isOutlookConnected() {
  return (
    outlookTokenStore.accessToken &&
    outlookTokenStore.expiresAt > Date.now() + 30_000
  );
}

function outlookAuthUrl() {
  const tenant = OUTLOOK_TENANT_ID || "common";
  const params = new URLSearchParams({
    client_id: OUTLOOK_CLIENT_ID,
    response_type: "code",
    redirect_uri: OUTLOOK_REDIRECT_URI,
    response_mode: "query",
    scope: OUTLOOK_SCOPES,
    prompt: "select_account",
  });
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize?${params.toString()}`;
}

async function exchangeOutlookCode(code) {
  const tenant = OUTLOOK_TENANT_ID || "common";
  const tokenUrl = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;

  const body = new URLSearchParams({
    client_id: OUTLOOK_CLIENT_ID,
    client_secret: OUTLOOK_CLIENT_SECRET,
    grant_type: "authorization_code",
    code,
    redirect_uri: OUTLOOK_REDIRECT_URI,
    scope: OUTLOOK_SCOPES,
  });

  const r = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const data = await safeJson(r);
  if (!r.ok) throw new Error(data?.error_description || "token exchange failed");

  outlookTokenStore = {
    accessToken: data.access_token || "",
    refreshToken: data.refresh_token || "",
    expiresAt: Date.now() + (data.expires_in || 0) * 1000,
  };
  return outlookTokenStore;
}

app.get("/api/outlook-status", (_req, res) => {
  ok(res, {
    connected: isOutlookConnected(),
    expiresInSeconds: outlookTokenStore.expiresAt
      ? Math.max(0, Math.floor((outlookTokenStore.expiresAt - Date.now()) / 1000))
      : 0,
  });
});

// Le front ouvre authUrl dans une popup
app.post("/api/outlook-auth", (_req, res) => {
  if (!OUTLOOK_CLIENT_ID || !OUTLOOK_REDIRECT_URI) {
    return fail(res, 501, "Outlook env not configured");
  }
  ok(res, { authUrl: outlookAuthUrl() });
});

// Callback OAuth (à mettre dans ton redirect uri)
app.get("/api/outlook-callback", async (req, res) => {
  const code = String(req.query.code || "").trim();
  if (!code) return fail(res, 400, "Missing code");

  try {
    await exchangeOutlookCode(code);

    // Poke le parent window (popup -> CodePen/prod)
    res.send(`
      <script>
        window.opener && window.opener.postMessage({ type: "OUTLOOK_CONNECTED" }, "*");
        window.close();
      </script>
      <p>Outlook connecté. Tu peux fermer cette fenêtre.</p>
    `);
  } catch (e) {
    console.error("[outlook/callback]", e);
    res.send(`<p>Erreur OAuth Outlook: ${e.message}</p>`);
  }
});

// -------------------------
// 8) GPT BACKEND (OpenAI proxy)
// -------------------------

async function openaiChat(messages, temperature = 0.2) {
  if (!OPENAI_API_KEY) throw new Error("OpenAI env missing");

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages,
      temperature,
    }),
  });

  const data = await safeJson(r);
  if (!r.ok) {
    throw new Error(data?.error?.message || "OpenAI HTTP error");
  }
  return data?.choices?.[0]?.message?.content || "";
}

app.post("/api/gpt/analyze-ticket", async (req, res) => {
  const wrapText = String(req.body?.wrapText || "").trim();

  try {
    const content = await openaiChat([
      {
        role: "system",
        content:
          "Tu es l'assistant AFI OPS. Analyse un wrap SAV et retourne un résumé actionnable en FR-CA.",
      },
      {
        role: "user",
        content: wrapText || "(wrap vide)",
      },
    ]);

    ok(res, { summary: content });
  } catch (e) {
    console.error("[gpt/analyze-ticket]", e);
    fail(res, 500, "GPT analyze failed", { details: e.message });
  }
});

app.post("/api/gpt/generate-wrap", async (req, res) => {
  const wrapText = String(req.body?.wrapText || "").trim();

  try {
    const content = await openaiChat(
      [
        {
          role: "system",
          content:
            "Tu es l'assistant AFI OPS. Transforme des notes brutes en WRAP SAV clair, structuré, avec étapes, modèle/série, urgence. FR-CA.",
        },
        {
          role: "user",
          content: wrapText || "(notes vides)",
        },
      ],
      0.35
    );

    ok(res, { wrap: content });
  } catch (e) {
    console.error("[gpt/generate-wrap]", e);
    fail(res, 500, "GPT wrap failed", { details: e.message });
  }
});

// -------------------------
// 9) TIDIO CONFIG
// -------------------------

app.get("/api/tidio-config", (_req, res) => {
  ok(res, { projectId: TIDIO_PROJECT_ID || "" });
});

// -------------------------
// 10) HEALTHCHECK
// -------------------------

app.get("/", (_req, res) => {
  res.send("AFI OPS backend OK");
});

// -------------------------
// 11) GLOBAL ERROR HANDLER
// -------------------------

app.use((err, _req, res, _next) => {
  console.error("[unhandled]", err);
  fail(res, 500, "Server error", { details: err?.message });
});

// -------------------------
// 12) START
// -------------------------

app.listen(PORT, () => {
  console.log(`🚀 AFI OPS backend listening on ${PORT}`);
});
