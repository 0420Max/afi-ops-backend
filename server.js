
/**
 * ============================================================
 * AFI OPS – Backend Central (Render / Local)
 * ============================================================
 * Added (Twilio Conversations Chat/SMS):
 * - POST /twilio/conversations-webhook (inbound events)
 * - GET  /api/conversations (list conversations)
 * - GET  /api/conversations/:sid/messages (list messages)
 * - POST /api/conversations/:sid/messages (send message)
 * - POST /api/conversations/start (create conversation + add sms participant)
 *
 * Notes:
 * - Webhook signature validation uses TWILIO_AUTH_TOKEN (recommended).
 *   If missing, webhook is accepted without signature validation (less secure).
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
0) CORS FIX – ULTRA ROBUSTE (with optional ALLOWED_ORIGINS merge)
============================================================ */
const defaultOrigins = [
  "https://cdpn.io",
  "https://codepen.io",
  "https://afi-ops.ca",
  "http://localhost:3000",
  "http://localhost:5173",
];

const envOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const allowedOrigins = [...new Set([...defaultOrigins, ...envOrigins])];

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
app.use(express.urlencoded({ extended: false })); // ✅ Twilio webhooks (form-encoded)

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
  TWILIO_AUTH_TOKEN, // ✅ recommended for webhook signature validation
  TWILIO_CONVERSATIONS_SERVICE_SID, // ✅ ISxxxx (AFI_OPS Service SID)

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

  /* Monday Multi-board normalized (OPS Map) */
  MONDAY_BOARD_SERVICES,
  MONDAY_BOARD_LIVRAISONS,
  MONDAY_COL_ADDRESS,
  MONDAY_COL_DATE,

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

  /* Vapi */
  VAPI_ASSISTANT_ID,
  VAPI_FORWARD_NUMBER,
  VAPI_DEFAULT_MODE,
  VAPI_WEBHOOK_SECRET,

} = process.env;

const DEFAULT_BOARD_ID = Number(MONDAY_BOARD_ID || 1763228524);
const DEFAULT_GROUP_ID = String(MONDAY_GROUP_ID || "topics");
const MONDAY_LIMIT = Number(MONDAY_ITEMS_LIMIT || 50);
const MONDAY_TTL = Number(MONDAY_TTL_MS || 25000);
const MONDAY_VERSION = MONDAY_API_VERSION || "2023-10";

/* ============================================================
2.5) VAPI – Webhook (assistant-request, tool-calls, end-of-call-report)
============================================================ */
const VAPI_MODE_FILE = process.env.VAPI_MODE_FILE || "./.vapi-mode.json";
let vapiMode = (VAPI_DEFAULT_MODE || "ai").toLowerCase() === "off" ? "off" : "ai";
try {
  if (fs.existsSync(VAPI_MODE_FILE)) {
    const raw = JSON.parse(fs.readFileSync(VAPI_MODE_FILE, "utf8"));
    if (raw?.mode === "off" || raw?.mode === "ai") vapiMode = raw.mode;
  }
} catch {}

const vapiCalls = []; // newest first
const vapiCallToTicket = new Map(); // callId -> ticketId

function persistVapiMode() {
  try { fs.writeFileSync(VAPI_MODE_FILE, JSON.stringify({ mode: vapiMode, updatedAt: new Date().toISOString() }, null, 2)); } catch {}
}

function vapiAuthOk(req) {
  if (!VAPI_WEBHOOK_SECRET) return true;
  const secret = String(VAPI_WEBHOOK_SECRET);
  const x = String(req.headers["x-vapi-secret"] || "");
  if (x && x === secret) return true;

  const auth = String(req.headers["authorization"] || "");
  if (auth) {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    const token = (m ? m[1] : auth).trim();
    if (token === secret) return true;
  }
  return false;
}

function pushVapiCall(update) {
  const id = String(update?.id || "");
  if (!id) return;
  const idx = vapiCalls.findIndex((c) => c.id === id);
  if (idx >= 0) vapiCalls[idx] = { ...vapiCalls[idx], ...update };
  else vapiCalls.unshift(update);
  if (vapiCalls.length > 50) vapiCalls.length = 50;
}

function buildTransientVapiAssistant() {
  // Minimal assistant if you don't want to maintain a saved assistant in the dashboard.
  const sys = `
Tu es l’agent vocal SAV AFI.

Objectif:
1) Diagnostiquer et tenter 1 à 2 actions d’assistance rapides.
2) Dans TOUS les cas, créer un ticket de demande d’assistance.

Règles:
- Avant de terminer l’appel, tu DOIS obtenir: nom complet, courriel, téléphone, adresse de service.
- Résume le problème, les vérifications faites, et les infos techniques (type de bassin, modèle, numéro de série, etc.).
- Ensuite appelle l’outil create_support_ticket avec tous les champs.
- Si une info manque, insiste poliment et guide l’utilisateur pour la trouver.
`.trim();

  return {
    firstMessage: "Bonjour, ici le support AFI. Comment puis-je vous aider aujourd'hui ?",
    serverMessages: ["tool-calls", "end-of-call-report", "status-update", "transcript"],
    model: {
      provider: "openai",
      model: "gpt-4o",
      messages: [{ role: "system", content: sys }],
      functions: [
        {
          name: "create_support_ticket",
          description: "Crée un ticket SAV dans Monday et retourne l'id du ticket.",
          parameters: {
            type: "object",
            properties: {
              clientName: { type: "string" },
              email: { type: "string" },
              phone: { type: "string" },
              serviceAddress: { type: "string" },
              reason: { type: "string" },
              details: { type: "string" },
              poolType: { type: "string" },
              modelNumber: { type: "string" },
              serialNumber: { type: "string" },
              attemptedFixes: { type: "string" }
            },
            required: ["clientName", "email", "phone", "serviceAddress", "reason"]
          }
        }
      ]
    }
  };
}


const STATUS_COL = MONDAY_STATUS_COLUMN_ID || "status";
const ASSIGNEE_COL = MONDAY_ASSIGNEE_COLUMN_ID || "person";

const TWILIO_ENABLED =
  !!TWILIO_ACCOUNT_SID &&
  !!TWILIO_API_KEY &&
  !!TWILIO_API_SECRET &&
  !!TWILIO_TWIML_APP_SID;

const TWILIO_CONVERSATIONS_ENABLED =
  !!TWILIO_ACCOUNT_SID &&
  !!TWILIO_API_KEY &&
  !!TWILIO_API_SECRET &&
  !!TWILIO_CONVERSATIONS_SERVICE_SID;

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
      twilioConversations: TWILIO_CONVERSATIONS_ENABLED ? "ready" : "missing_env",
      vapi: VAPI_ASSISTANT_ID ? "ready" : "transient_ready",
      monday: MONDAY_TOKEN ? "ready" : "missing_token",
      outlook: OUTLOOK_CONFIGURED ? "configured" : "not_configured",
      tidio: TIDIO_PROJECT_ID ? "ready" : "not_configured",
      youtube: YOUTUBE_API_KEY ? "ready" : "missing_key",
      zapier: ZAPIER_SMS_WEBHOOK_URL ? "ready" : "missing_webhook",
      gpt: OPENAI_API_KEY ? "ready" : "disabled",
      transcript: "poc_safe",
      mondayMap:
        MONDAY_BOARD_SERVICES && MONDAY_BOARD_LIVRAISONS ? "configured" : "not_configured",
    },
  });
});

/* ============================================================
2.6) VAPI – Console controls + Webhook
============================================================ */
app.get("/api/vapi/status", (req, res) => {
  const last = vapiCalls[0] || null;
  res.json({
    ok: true,
    mode: vapiMode,
    assistantIdConfigured: Boolean(VAPI_ASSISTANT_ID),
    lastCall: last ? {
      id: last.id,
      from: last.from,
      to: last.to,
      startedAt: last.startedAt,
      endedAt: last.endedAt,
      endedReason: last.endedReason,
      ticketId: last.ticketId || vapiCallToTicket.get(last.id) || null
    } : null
  });
});

app.post("/api/vapi/mode", (req, res) => {
  const mode = String(req.body?.mode || "").toLowerCase();
  vapiMode = mode === "off" ? "off" : "ai";
  persistVapiMode();
  res.json({ ok: true, mode: vapiMode });
});

app.get("/api/vapi/calls", (req, res) => {
  res.json({ ok: true, calls: vapiCalls.slice(0, 25) });
});

app.post("/api/vapi/simulate", (req, res) => {
  // Dev helper: inject a fake end-of-call report for UI testing
  const id = "call_sim_" + Date.now();
  pushVapiCall({
    id,
    from: "+1 514-555-0101",
    to: "AFI",
    startedAt: new Date(Date.now() - 120000).toISOString(),
    endedAt: new Date().toISOString(),
    endedReason: "simulated",
    transcript: "Client: Ma pompe ne démarre plus. Agent: Avez-vous vérifié le disjoncteur et l'horloge? Client: Oui. Agent: Merci, je crée un ticket.",
    ticketId: null
  });
  res.json({ ok: true, id });
});

app.post("/api/vapi/webhook", async (req, res) => {
  if (!vapiAuthOk(req)) return res.status(401).json({ ok: false, error: "VAPI_UNAUTHORIZED" });

  const message = req.body?.message || {};
  const type = String(message?.type || "");

  try {
    // 1) assistant-request: choose assistant or transfer destination
    if (type === "assistant-request") {
      if (vapiMode === "off" && VAPI_FORWARD_NUMBER) {
        return res.json({
          destination: {
            type: "number",
            number: VAPI_FORWARD_NUMBER,
            message: "Transfert vers un agent."
          }
        });
      }

      if (VAPI_ASSISTANT_ID) return res.json({ assistantId: VAPI_ASSISTANT_ID });
      return res.json({ assistant: buildTransientVapiAssistant() });
    }

    // 2) tool-calls: execute custom tools
    if (type === "tool-calls") {
      const toolCalls = message.toolCallList || [];
      const results = [];

      for (const tc of toolCalls) {
        const name = String(tc?.name || "");
        const toolCallId = String(tc?.id || "");
        const p = tc?.parameters || {};
        let result = null;

        if (name === "create_support_ticket" || name === "createSupportTicket") {
          // Build ticket payload for Monday
          const payload = {
            clientName: p.clientName || p.name || p.fullName || "Inconnu",
            email: p.email || p.emailAddress || "",
            phone: p.phone || p.phoneNumber || "",
            serviceAddress: p.serviceAddress || p.address || "",
            reason: p.reason || p.problem || p.issue || "Appel SAV",
            details: p.details || "",
            poolType: p.poolType || "",
            modelNumber: p.modelNumber || "",
            serialNumber: p.serialNumber || "",
            attemptedFixes: p.attemptedFixes || ""
          };

          // Create item using existing endpoint helper: createTicketOnMonday()
          const created = await createSupportTicketFromVoice(payload, message);
          result = created;
          if (created?.itemId && message?.call?.id) {
            vapiCallToTicket.set(String(message.call.id), String(created.itemId));
            pushVapiCall({ id: String(message.call.id), ticketId: String(created.itemId) });
          }
        } else {
          result = { ok: false, error: "UNKNOWN_TOOL", name };
        }

        results.push({ name, toolCallId, result: JSON.stringify(result) });
      }

      return res.json({ results });
    }

    // 3) end-of-call-report: store transcript + create fallback ticket if missing
    if (type === "end-of-call-report") {
      const call = message.call || {};
      const artifact = message.artifact || {};
      const id = String(call.id || "");
      const from = call?.customer?.number || call?.phoneNumber?.number || call?.from || "";
      const to = call?.phoneNumber?.number || call?.to || "";
      const transcript = artifact.transcript || "";
      const endedAt = call?.endedAt || new Date().toISOString();

      pushVapiCall({
        id,
        from,
        to,
        startedAt: call?.startedAt || null,
        endedAt,
        endedReason: message?.endedReason || null,
        transcript: transcript ? String(transcript).slice(0, 12000) : null,
        ticketId: vapiCallToTicket.get(id) || null
      });

      // Fallback ticket creation if none yet
      if (id && MONDAY_TOKEN && !vapiCallToTicket.get(id)) {
        const fallback = {
          clientName: "Inconnu",
          email: "",
          phone: from,
          serviceAddress: "",
          reason: "Appel entrant (VAPI)",
          details: transcript ? `Transcript:\n${transcript}` : "Appel sans transcript.",
          attemptedFixes: ""
        };
        const created = await createSupportTicketFromVoice(fallback, message);
        if (created?.itemId) {
          vapiCallToTicket.set(id, String(created.itemId));
          pushVapiCall({ id, ticketId: String(created.itemId) });
        }
      }

      return res.json({ ok: true });
    }

    // Other events: store useful ones (status-update, transcript)
    if (type === "status-update") {
      const call = message.call || {};
      const id = String(call.id || "");
      pushVapiCall({
        id,
        from: call?.customer?.number || "",
        to: call?.phoneNumber?.number || "",
        startedAt: call?.startedAt || null,
        status: message.status || null
      });
      return res.json({ ok: true });
    }

    if (type === "transcript") {
      // optional: keep last partial transcript snippets
      const call = message.call || {};
      const id = String(call.id || "");
      if (id) {
        pushVapiCall({ id, lastUtterance: message.transcript || "" });
      }
      return res.json({ ok: true });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("[VAPI WEBHOOK ERROR]", e);
    return res.status(500).json({ ok: false, error: "VAPI_WEBHOOK_ERROR", details: String(e?.message || e) });
  }
});


/* ============================================================
3) TWILIO – TOKEN + TWIML (Voice)
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
3.1) TWILIO – CONVERSATIONS (Chat/SMS)
============================================================ */
function getTwilioClient() {
  // Use API Key auth (recommended for server-side)
  // twilio(apiKeySid, apiKeySecret, { accountSid })
  if (!TWILIO_CONVERSATIONS_ENABLED) return null;
  return twilio(TWILIO_API_KEY, TWILIO_API_SECRET, { accountSid: TWILIO_ACCOUNT_SID });
}

function validateTwilioSignature(req) {
  // If no auth token, we can't validate signature (accept but warn)
  if (!TWILIO_AUTH_TOKEN) return { ok: true, skipped: true };

  const signature = req.header("X-Twilio-Signature");
  if (!signature) return { ok: false, reason: "MISSING_SIGNATURE" };

  // Build the full URL Twilio requested (Render is HTTPS)
  const url = `https://${req.get("host")}${req.originalUrl}`;
  const ok = twilio.validateRequest(TWILIO_AUTH_TOKEN, signature, url, req.body);
  return { ok };
}

// Webhook called by Twilio Conversations for events (onMessageAdded, onDeliveryUpdated, etc.)
app.post("/twilio/conversations-webhook", async (req, res) => {
  const v = validateTwilioSignature(req);
  if (!v.ok) {
    return res.status(403).send("Invalid Twilio signature");
  }

  // ACK fast
  res.status(200).send("ok");

  // Process async (log / DB / ticketing)
  try {
    const eventType = req.body?.EventType || "";
    const conversationSid = req.body?.ConversationSid || "";
    const messageSid = req.body?.MessageSid || "";
    const author = req.body?.Author || "";
    const body = req.body?.Body || "";
    const participantSid = req.body?.ParticipantSid || "";
    const source = req.body?.Source || ""; // e.g. "SMS"
    const dateCreated = req.body?.DateCreated || null;

    console.log("[TWILIO][CONV_WEBHOOK]", {
      eventType,
      conversationSid,
      messageSid,
      author,
      participantSid,
      source,
      dateCreated,
      bodyPreview: (body || "").slice(0, 160),
      signatureValidation: v.skipped ? "skipped_no_auth_token" : "validated",
    });

    // TODO (next step): persist in DB + link to Monday ticket if needed
    // For now we just log; your UI can poll Twilio via /api/conversations endpoints.
  } catch (e) {
    console.error("[TWILIO][CONV_WEBHOOK][ERROR]", e?.message || e);
  }
});

// List conversations (for your OPS UI)
app.get("/api/conversations", async (req, res) => {
  const client = getTwilioClient();
  if (!client) {
    return res.status(503).json({
      ok: false,
      error: "TWILIO_CONVERSATIONS_DISABLED",
      message: "Missing env vars (TWILIO_CONVERSATIONS_SERVICE_SID / API key / account sid).",
    });
  }

  try {
    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));

    // Note: Twilio's list is account-wide; we can filter by serviceSid by fetching and filtering.
    // Some SDK versions support "services(serviceSid).conversations" (preferred).
    let conversations = [];
    if (client.conversations?.v1?.services) {
      const r = await client.conversations.v1
        .services(TWILIO_CONVERSATIONS_SERVICE_SID)
        .conversations.list({ limit });
      conversations = r || [];
    } else {
      // Fallback (older SDK)
      const r = await client.conversations.v1.conversations.list({ limit });
      conversations = (r || []).filter((c) => c.chatServiceSid === TWILIO_CONVERSATIONS_SERVICE_SID);
    }

    const payload = conversations.map((c) => ({
      sid: c.sid,
      friendlyName: c.friendlyName || null,
      state: c.state || null,
      dateCreated: c.dateCreated || null,
      dateUpdated: c.dateUpdated || null,
      uniqueName: c.uniqueName || null,
      chatServiceSid: c.chatServiceSid || null,
    }));

    res.json({ ok: true, count: payload.length, conversations: payload });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// List messages in a conversation
app.get("/api/conversations/:sid/messages", async (req, res) => {
  const client = getTwilioClient();
  if (!client) return res.status(503).json({ ok: false, error: "TWILIO_CONVERSATIONS_DISABLED" });

  const sid = String(req.params.sid || "").trim();
  if (!sid) return res.status(400).json({ ok: false, error: "MISSING_CONVERSATION_SID" });

  try {
    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));

    const msgs = await client.conversations.v1
      .services(TWILIO_CONVERSATIONS_SERVICE_SID)
      .conversations(sid)
      .messages.list({ limit });

    const payload = (msgs || []).map((m) => ({
      sid: m.sid,
      conversationSid: m.conversationSid,
      author: m.author,
      body: m.body,
      dateCreated: m.dateCreated,
      index: m.index,
      participantSid: m.participantSid || null,
    }));

    res.json({ ok: true, count: payload.length, messages: payload.reverse() }); // oldest -> newest
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// Send a message to a conversation
app.post("/api/conversations/:sid/messages", async (req, res) => {
  const client = getTwilioClient();
  if (!client) return res.status(503).json({ ok: false, error: "TWILIO_CONVERSATIONS_DISABLED" });

  const sid = String(req.params.sid || "").trim();
  if (!sid) return res.status(400).json({ ok: false, error: "MISSING_CONVERSATION_SID" });

  const body = String(req.body?.body || "").trim();
  const author = String(req.body?.author || "AFI_OPS").trim();

  if (!body) return res.status(400).json({ ok: false, error: "MISSING_BODY" });

  try {
    const msg = await client.conversations.v1
      .services(TWILIO_CONVERSATIONS_SERVICE_SID)
      .conversations(sid)
      .messages.create({ author, body });

    res.json({ ok: true, messageSid: msg.sid });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// Optional helper: start a conversation with an SMS participant (server-side)
app.post("/api/conversations/start", async (req, res) => {
  const client = getTwilioClient();
  if (!client) return res.status(503).json({ ok: false, error: "TWILIO_CONVERSATIONS_DISABLED" });

  const phone = String(req.body?.phone || "").trim(); // +1...
  if (!/^\+\d{10,15}$/.test(phone)) {
    return res.status(400).json({ ok: false, error: "BAD_PHONE", message: "Use E.164 format +1..." });
  }

  const friendlyName = String(req.body?.friendlyName || `SMS ${phone}`).trim();
  const uniqueName = String(req.body?.uniqueName || "").trim(); // optional stable key

  try {
    // Create conversation
    const conv = await client.conversations.v1
      .services(TWILIO_CONVERSATIONS_SERVICE_SID)
      .conversations.create({
        friendlyName,
        ...(uniqueName ? { uniqueName } : {}),
      });

    // Add SMS participant
    // messagingBinding.address = customer's phone
    // messagingBinding.proxyAddress = your Twilio number
    await client.conversations.v1
      .services(TWILIO_CONVERSATIONS_SERVICE_SID)
      .conversations(conv.sid)
      .participants.create({
        "messagingBinding.address": phone,
        "messagingBinding.proxyAddress": TWILIO_PHONE_NUMBER,
      });

    res.json({ ok: true, conversationSid: conv.sid });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
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
  const createdAt = item?.created_at
    ? Date.parse(item.created_at)
    : item?.updated_at
    ? Date.parse(item.updated_at)
    : Date.now();

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


async function createSupportTicketFromVoice(payload, vapiMessage) {
  if (!MONDAY_TOKEN) return { ok: false, error: "MONDAY_TOKEN_MISSING" };

  const callId = String(vapiMessage?.call?.id || "");
  const reason = String(payload?.reason || "Appel SAV").trim();
  const name = String(payload?.clientName || "Inconnu").trim();
  const itemName = `SAV • ${name} • ${reason}`.slice(0, 160);

  // Column IDs (override via ENV if your board differs)
  const COL = {
    email: process.env.MONDAY_COL_EMAIL || "email_mkctw7qd",
    phone: process.env.MONDAY_COL_PHONE || "phone_mkcrrn8p",
    address: process.env.MONDAY_COL_ADDRESS || "text_mkc4er9w",
    description: process.env.MONDAY_COL_DESC || "long_text_mkctw6z7",
    status: process.env.MONDAY_STATUS_COLUMN_ID || "status",
    source: process.env.MONDAY_COL_SOURCE || null,
    callId: process.env.MONDAY_COL_CALL_ID || null,
    model: process.env.MONDAY_COL_MODEL || null,
    serial: process.env.MONDAY_COL_SERIAL || null,
    poolType: process.env.MONDAY_COL_POOLTYPE || null
  };

  const columnValues = {};
  if (COL.email) columnValues[COL.email] = payload.email ? { email: payload.email, text: payload.email } : null;
  if (COL.phone) columnValues[COL.phone] = payload.phone ? { phone: payload.phone, countryShortName: "CA" } : null;
  if (COL.address) columnValues[COL.address] = payload.serviceAddress || "";
  if (COL.description) {
    const parts = [
      `Raison: ${payload.reason || ""}`,
      payload.details ? `Détails:\n${payload.details}` : "",
      payload.attemptedFixes ? `Tentatives:\n${payload.attemptedFixes}` : "",
      payload.poolType ? `Type bassin: ${payload.poolType}` : "",
      payload.modelNumber ? `Modèle: ${payload.modelNumber}` : "",
      payload.serialNumber ? `Série: ${payload.serialNumber}` : "",
      callId ? `VAPI callId: ${callId}` : ""
    ].filter(Boolean);
    columnValues[COL.description] = { text: parts.join("\n\n").slice(0, 8000) };
  }
  if (COL.model) columnValues[COL.model] = payload.modelNumber || "";
  if (COL.serial) columnValues[COL.serial] = payload.serialNumber || "";
  if (COL.poolType) columnValues[COL.poolType] = payload.poolType || "";
  if (COL.callId && callId) columnValues[COL.callId] = callId;
  if (COL.source) columnValues[COL.source] = "VAPI";

  // Clean nulls
  Object.keys(columnValues).forEach((k) => {
    if (columnValues[k] === null) delete columnValues[k];
  });

  const query = `
    mutation ($boardId: ID!, $groupId: String!, $itemName: String!, $columnValues: JSON!) {
      create_item(board_id: $boardId, group_id: $groupId, item_name: $itemName, column_values: $columnValues) {
        id
        name
      }
    }
  `;

  const variables = {
    boardId: Number(DEFAULT_BOARD_ID),
    groupId: DEFAULT_GROUP_ID,
    itemName,
    columnValues: JSON.stringify(columnValues),
  };

  const r = await axios.post(
    "https://api.monday.com/v2",
    { query, variables },
    {
      timeout: MONDAY_TTL,
      headers: {
        Authorization: MONDAY_TOKEN,
        "Content-Type": "application/json",
        "API-Version": MONDAY_VERSION,
      },
    }
  );

  const item = r.data?.data?.create_item;
  if (!item?.id) return { ok: false, error: "MONDAY_CREATE_FAILED", details: r.data };

  return { ok: true, itemId: String(item.id), itemName: item.name };
}
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
5.0) ✅ PATCH (non-breaking): /api/monday/tickets-normalized
============================================================ */
function mustEnv(name) {
  const v = process.env[name];
  if (!v) {
    const err = new Error(`Missing ENV: ${name}`);
    err.code = "MISSING_ENV";
    err.envName = name;
    throw err;
  }
  return v;
}

function pickColTextById(cols, id) {
  const c = (cols || []).find((x) => x?.id === id);
  return (c?.text || "").toString();
}

function pickLikelyById(cols, candidates) {
  for (const id of candidates) {
    const c = (cols || []).find((x) => x?.id === id);
    if (c && ((c.text && String(c.text).trim()) || c.value)) return (c.text || "").toString();
  }
  return "";
}

function normalizeTicketForOpsMap({ item, boardId, addressColId, dateColId }) {
  const cols = item?.column_values || [];
  const address = pickColTextById(cols, addressColId).trim();
  const date = pickColTextById(cols, dateColId).trim();

  const status = pickLikelyById(cols, ["status", "statut", "status_1", "status0"]).trim();
  const assignee = pickLikelyById(cols, ["people", "person", "assignee", "owner", "responsable"]).trim();

  const group = item?.group?.title || item?.group?.id || "";

  return {
    id: String(item?.id || ""),
    boardId: String(boardId || ""),
    title: item?.name || "",
    address,
    date,
    status,
    assignee,
    group,
  };
}

app.get("/api/monday/tickets-normalized", async (req, res) => {
  try {
    mustEnv("MONDAY_TOKEN");
    const boardServices = mustEnv("MONDAY_BOARD_SERVICES");
    const boardLivraisons = mustEnv("MONDAY_BOARD_LIVRAISONS");
    const addressColId = mustEnv("MONDAY_COL_ADDRESS");
    const dateColId = mustEnv("MONDAY_COL_DATE");

    const scope = String(req.query.scope || "all").toLowerCase();
    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit || "200", 10)));

    const boardIds =
      scope === "services"
        ? [boardServices]
        : scope === "livraisons"
        ? [boardLivraisons]
        : [boardServices, boardLivraisons];

    const query = `
      query ($boardIds: [ID!], $limit: Int!) {
        boards(ids: $boardIds) {
          id
          name
          items_page(limit: $limit) {
            items {
              id
              name
              group { id title }
              column_values { id text value }
            }
          }
        }
      }
    `;

    const r = await mondayRequest(query, { boardIds, limit });

    if (r.data?.errors?.length) {
      return res.status(500).json({ ok: false, errors: r.data.errors });
    }

    const boards = r.data?.data?.boards || [];
    const tickets = [];

    for (const b of boards) {
      const items = b.items_page?.items || [];
      for (const item of items) {
        tickets.push(
          normalizeTicketForOpsMap({
            item,
            boardId: b.id,
            addressColId,
            dateColId,
          })
        );
      }
    }

    tickets.sort((a, b) => {
      const da = a.date || "";
      const db = b.date || "";
      if (da !== db) return da.localeCompare(db);
      return (a.title || "").localeCompare(b.title || "");
    });

    res.json({
      ok: true,
      scope,
      count: tickets.length,
      tickets,
    });
  } catch (e) {
    if (e.code === "MONDAY_TOKEN_MISSING") {
      return res.status(503).json({
        ok: false,
        errorCode: "MONDAY_TOKEN_MISSING",
        message: "Missing MONDAY_TOKEN in env.",
      });
    }
    if (e.code === "MISSING_ENV") {
      return res.status(500).json({
        ok: false,
        errorCode: "MISSING_ENV",
        message: e.message,
        env: e.envName || null,
      });
    }
    res.status(500).json({ ok: false, error: e.message || String(e) });
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

// --- Monday: who am I (token owner) ---
app.get("/api/monday/me", async (req, res) => {
  try {
    const q = `query { me { id name email } }`;
    const r = await mondayRequest(q, {});
    res.json({ ok: true, me: r?.data?.me || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// --- Monday: add internal update/note to an item ---
app.post("/api/monday/add-update", async (req, res) => {
  try {
    const itemId = String(req.body.itemId || req.body.id || "").trim();
    const body = String(req.body.body || "").trim();

    if (!itemId || !body) {
      return res.status(400).json({ ok: false, error: "itemId and body are required" });
    }

    const m = `
      mutation ($itemId: ID!, $body: String!) {
        create_update(item_id: $itemId, body: $body) { id }
      }
    `;
    const r = await mondayRequest(m, { itemId, body });
    res.json({ ok: true, updateId: r?.data?.create_update?.id || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});


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
  console.log("   twilio.voice.enabled:", TWILIO_ENABLED);
  console.log("   twilio.conversations.enabled:", TWILIO_CONVERSATIONS_ENABLED);
  if (!TWILIO_AUTH_TOKEN) console.log("   ⚠️ TWILIO_AUTH_TOKEN missing (webhook signature validation skipped)");
});
