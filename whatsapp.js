// whatsapp.js
// ══════════════════════════════════════════════════════════════════════════════
// SELF-HOSTED WHATSAPP SERVER + META CLOUD API FALLBACK
// ══════════════════════════════════════════════════════════════════════════════
// All WhatsApp-related backend code for Super Admin → WhatsApp, pulled out of
// server.js into its own file.
//
// HOW TO WIRE THIS INTO server.js (unchanged from before):
//
// 1. After `const app = express();` and after `mongoose`, `SiteSettings`,
//    `getSiteSettings`, `protect`, `adminOnly` exist:
//
//      const setupWhatsApp = require("./whatsapp");
//      const whatsapp = setupWhatsApp(app, { mongoose, protect, adminOnly, getSiteSettings, SiteSettings, crypto });
//
// 2. In the `mongoose.connection.once("open", ...)` block:
//      await whatsapp.startAllSelfHostedSessions();
//
// 3. Automation Workflow `case "send_whatsapp":` uses
//      whatsapp.WhatsAppSelfSession, whatsapp.sendSelfHostedMessage(...),
//      whatsapp.logWhatsAppMessage(...), whatsapp.normalizeWaNumber(...),
//      whatsapp.whatsappConfigured(), whatsapp.sendWhatsAppRaw(...)
//
// 4. Dependencies — make sure these are installed and redeployed:
//      npm install @whiskeysockets/baileys qrcode pino ffmpeg-static
//
// ── WHAT CHANGED IN THIS VERSION ─────────────────────────────────────────────
// A. NO MORE AUTO-LOGOUT
//    The WhatsApp login used to be saved in /tmp/wa-sessions. Render wipes
//    /tmp every time the service restarts, sleeps or redeploys → the login
//    was lost → new QR needed. Now the login is saved in MongoDB
//    (collection: whatsappauthkeys), so it survives restarts, sleeps and
//    redeploys. Writes from an old/stopped socket are ignored.
//    Keep-awake ping (bottom of file) stops Render's free plan from sleeping.
//
// B. FULL OLD CHAT HISTORY WITH REAL NUMBERS / SAVED NAMES
//    Links as "Desktop" + syncFullHistory + shouldSyncHistoryMessage → true,
//    with an automatic fallback to the default link mode if no QR appears.
//
// C. CHAT FEATURES (this version) — login / QR / history code untouched
//    - Faster chat list & chats: `since` / `after` delta polling, paging,
//      cached profile photos (no more hundreds of requests per page load)
//    - Unread counts (synced with the phone), tags, clear chat, read ticks
//    - Media: stores what's needed to download images / videos / voice /
//      documents on demand → view, play, full-screen, download
//    - Send photos, videos, documents, voice notes, polls, events, contacts
//    - Contact info: common groups, block / unblock
//    New dependency:  npm install ffmpeg-static   (voice note conversion)
//    Media received BEFORE this update has no download info — to get it,
//    use Clear History + Reconnect once (optional).
//
// D. NEW — failed sends now record WHY. `WhatsAppMessage.error` stores the
//    real error text (e.g. "This number isn't connected right now") for any
//    row with status "failed" — from a workflow's Send WhatsApp Message
//    action, a manual send, or a bulk send — so the reason is visible
//    without digging through server logs.

let Baileys = null;
try {
  Baileys = require("@whiskeysockets/baileys");
} catch (err) {
  console.error("⚠️  @whiskeysockets/baileys not installed — self-hosted WhatsApp server disabled. Run: npm install @whiskeysockets/baileys");
}

// Renders the QR code locally as a data: URL image — removes the dependency
// on a reachable third-party image service to actually SEE the QR code.
let QRCode = null;
try {
  QRCode = require("qrcode");
} catch (err) {
  console.error("⚠️  qrcode package not installed — QR codes will fall back to an external image service (api.qrserver.com), which may not render on all networks. Run: npm install qrcode");
}
async function renderQrDataUrl(qrString) {
  if (!qrString || !QRCode) return "";
  try {
    return await QRCode.toDataURL(qrString, { width: 256, margin: 1 });
  } catch (err) {
    console.error("[Self-hosted WhatsApp] local QR render failed, will fall back to external service:", err.message);
    return "";
  }
}

const fs = require("fs");
const path = require("path");

// ── Small JID helpers (no dependencies) ─────────────────────────────────────
// "923001234567:12@s.whatsapp.net" → "923001234567@s.whatsapp.net"
function jidNorm(jid) {
  if (!jid || typeof jid !== "string" || !jid.includes("@")) return "";
  const [userPart, serverPart] = jid.split("@");
  const user = userPart.split(":")[0];
  const server = serverPart === "c.us" ? "s.whatsapp.net" : serverPart;
  return `${user}@${server}`;
}
const isPnJid = (j) => typeof j === "string" && j.endsWith("@s.whatsapp.net");
const isLidJid = (j) => typeof j === "string" && j.endsWith("@lid");
const digitsOf = (j) => String(j || "").split("@")[0].replace(/[^\d]/g, "");
const lidLabel = (lidJid) => `lid:${digitsOf(lidJid)}`;

// Baileys timestamps can be numbers or protobuf Long objects
function toDate(ts) {
  let n = 0;
  if (typeof ts === "number") n = ts;
  else if (ts && typeof ts.toNumber === "function") n = ts.toNumber();
  else if (ts && typeof ts.low === "number") n = ts.low;
  else n = Number(ts) || 0;
  return n > 0 ? new Date(n * 1000) : new Date();
}

const SYSTEM_TYPES = [
  "protocolMessage", "senderKeyDistributionMessage", "messageContextInfo",
  "reactionMessage", "pollUpdateMessage", "keepInChatMessage", "encReactionMessage",
];

// Returns { text, hasText } for a real message, or null for protocol/system
// traffic that should never show up in a chat.
function getMessageContent(msg) {
  let m = msg?.message;
  if (!m) return null;
  for (let i = 0; i < 5; i++) {
    const inner = m.ephemeralMessage?.message || m.viewOnceMessage?.message ||
      m.viewOnceMessageV2?.message || m.viewOnceMessageV2Extension?.message ||
      m.documentWithCaptionMessage?.message || m.editedMessage?.message;
    if (!inner) break;
    m = inner;
  }
  const type = (Baileys?.getContentType && Baileys.getContentType(m)) ||
    Object.keys(m).find((k) => !["senderKeyDistributionMessage", "messageContextInfo"].includes(k));
  if (!type || SYSTEM_TYPES.includes(type)) return null;

  const text =
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    m.templateButtonReplyMessage?.selectedDisplayText ||
    "";
  if (text) return { text, hasText: true };

  const placeholders = {
    imageMessage: "📷 Photo",
    videoMessage: "🎥 Video",
    audioMessage: "🎤 Voice message",
    stickerMessage: "Sticker",
    contactMessage: `👤 ${m.contactMessage?.displayName || "Contact"}`,
    contactsArrayMessage: "👤 Contacts",
    locationMessage: "📍 Location",
    liveLocationMessage: "📍 Live location",
    pollCreationMessage: "📊 Poll",
    pollCreationMessageV2: "📊 Poll",
    pollCreationMessageV3: "📊 Poll",
    documentMessage: `📄 ${m.documentMessage?.fileName || "Document"}`,
    ptvMessage: "🎥 Video",
    eventMessage: `📅 ${m.eventMessage?.name || "Event"}`,
  };
  if (type === "audioMessage" && m.audioMessage?.ptt) return { text: "🎤 Voice message", hasText: false };
  if (type === "pollCreationMessage" || type === "pollCreationMessageV2" || type === "pollCreationMessageV3") {
    const p = m[type];
    return { text: `📊 ${p?.name || "Poll"}`, hasText: false };
  }
  return { text: placeholders[type] || `[${type}]`, hasText: false };
}

// ── NEW: rich message details (media, polls, events, contacts, location) ────
function unwrapMessage(message) {
  let m = message;
  for (let i = 0; m && i < 5; i++) {
    const inner = m.ephemeralMessage?.message || m.viewOnceMessage?.message ||
      m.viewOnceMessageV2?.message || m.viewOnceMessageV2Extension?.message ||
      m.documentWithCaptionMessage?.message || m.editedMessage?.message;
    if (!inner) break;
    m = inner;
  }
  return m;
}

// Stores just enough of a media message to download it later on demand
// (no thumbnails / quoted messages → stays small in MongoDB).
function serializeMediaRaw(message) {
  try {
    const { proto } = Baileys;
    const obj = proto.Message.toObject(proto.Message.fromObject(message), { bytes: String, longs: String, enums: Number, defaults: false });
    const strip = (o) => {
      if (!o || typeof o !== "object") return;
      for (const k of Object.keys(o)) {
        if (["jpegThumbnail", "pngThumbnail", "contextInfo", "messageContextInfo", "thumbnail"].includes(k)) delete o[k];
        else strip(o[k]);
      }
    };
    strip(obj);
    return JSON.stringify(obj);
  } catch { return ""; }
}

function vcardNumber(vcard) {
  const m = String(vcard || "").match(/waid=(\d+)/) || String(vcard || "").match(/TEL[^:]*:([+\d\s-]+)/);
  return m ? m[1].replace(/[^\d]/g, "") : "";
}

const MEDIA_TYPES = { imageMessage: "image", videoMessage: "video", ptvMessage: "video", audioMessage: "audio", documentMessage: "document", stickerMessage: "sticker" };

function describeMessage(msg) {
  const out = { msgType: "text" };
  const m = unwrapMessage(msg?.message);
  if (!m) return out;
  const type = (Baileys?.getContentType && Baileys.getContentType(m)) ||
    Object.keys(m).find((k) => !["senderKeyDistributionMessage", "messageContextInfo"].includes(k));
  if (MEDIA_TYPES[type]) {
    const media = m[type] || {};
    out.msgType = MEDIA_TYPES[type];
    out.mimetype = media.mimetype || "";
    out.fileName = media.fileName || "";
    out.seconds = Number(media.seconds) || 0;
    out.ptt = !!media.ptt;
    out.mediaRaw = serializeMediaRaw(msg.message);
  } else if (type === "pollCreationMessage" || type === "pollCreationMessageV2" || type === "pollCreationMessageV3") {
    const p = m[type] || {};
    out.msgType = "poll";
    out.meta = { name: p.name || "", options: (p.options || []).map((o) => o.optionName || ""), selectableCount: p.selectableCount || 1 };
  } else if (type === "eventMessage") {
    const e = m.eventMessage || {};
    out.msgType = "event";
    out.meta = {
      name: e.name || "", description: e.description || "",
      startTime: e.startTime ? toDate(e.startTime).toISOString() : null,
      endTime: e.endTime ? toDate(e.endTime).toISOString() : null,
      location: e.location?.name || "",
    };
  } else if (type === "contactMessage") {
    out.msgType = "contact";
    out.meta = { contacts: [{ name: m.contactMessage?.displayName || "", number: vcardNumber(m.contactMessage?.vcard) }] };
  } else if (type === "contactsArrayMessage") {
    out.msgType = "contact";
    out.meta = { contacts: (m.contactsArrayMessage?.contacts || []).map((c) => ({ name: c.displayName || "", number: vcardNumber(c.vcard) })) };
  } else if (type === "locationMessage" || type === "liveLocationMessage") {
    const l = m[type] || {};
    out.msgType = "location";
    out.meta = { lat: l.degreesLatitude, lng: l.degreesLongitude, name: l.name || l.address || "" };
  }
  return out;
}

module.exports = function setupWhatsApp(app, deps) {
  const { mongoose, protect, adminOnly, getSiteSettings, SiteSettings, crypto } = deps;

const WhatsAppMessageSchema = new mongoose.Schema({
  instanceId: { type: String, required: true },
  direction:  { type: String, enum: ["outgoing", "incoming"], required: true },
  // The other party — ALWAYS the real phone number (digits only) when it can
  // be resolved; "lid:xxxx" only while WhatsApp hasn't revealed the number
  // yet (merged into the real number automatically once it does).
  number:     { type: String, default: "" },
  groupId:    { type: String, default: "" },
  message:    { type: String, default: "" },
  status:     { type: String, enum: ["sent", "failed", "received"], default: "sent" },
  // NEW — set only when status is "failed": the real reason the send
  // didn't go through (e.g. "This number isn't connected right now", or
  // whatever Baileys/WhatsApp itself reported), so it's visible in the
  // dashboard instead of only in server logs.
  error:      { type: String, default: "" },
  source:     { type: String, default: "" }, // "workflow" | "manual" | "mobile_app" | "self_hosted" | "history_sync" | "bulk" | "ai_bot" | "external_api"
  waMessageId: { type: String, default: "" },
  // Exact WhatsApp identifier the message came from / went to (phone JID or
  // LID) — replies are sent to this.
  jid: { type: String, default: "" },
  // NEW — rich messages
  msgType:  { type: String, default: "text" }, // text | image | video | audio | document | sticker | poll | event | contact | location
  mediaRaw: { type: String, default: "" },     // what's needed to download the media on demand
  mimetype: { type: String, default: "" },
  fileName: { type: String, default: "" },
  seconds:  { type: Number, default: 0 },
  ptt:      { type: Boolean, default: false },  // voice note
  meta:     { type: mongoose.Schema.Types.Mixed, default: null },
}, { timestamps: true });
WhatsAppMessageSchema.index({ instanceId: 1, createdAt: -1 });
WhatsAppMessageSchema.index({ instanceId: 1, updatedAt: -1 });
WhatsAppMessageSchema.index({ instanceId: 1, number: 1, createdAt: -1 });
WhatsAppMessageSchema.index(
  { instanceId: 1, waMessageId: 1 },
  { unique: true, partialFilterExpression: { waMessageId: { $gt: "" } } }
);
const WhatsAppMessage = mongoose.model("WhatsAppMessage", WhatsAppMessageSchema);

// Messages with a WhatsApp ID are upserted — so the dashboard's own log and
// WhatsApp's echo of the same message can never create two rows.
async function logWhatsAppMessage(fields) {
  try {
    if (fields.waMessageId) {
      const now = new Date();
      await WhatsAppMessage.updateOne(
        { instanceId: fields.instanceId, waMessageId: fields.waMessageId },
        { $setOnInsert: { groupId: "", jid: "", error: "", ...fields, createdAt: fields.createdAt || now, updatedAt: now } },
        { upsert: true, timestamps: false }
      );
    } else {
      await WhatsAppMessage.create(fields);
    }
  } catch (err) {
    if (err.code !== 11000) console.error("[WhatsApp] failed to log message:", err.message);
  }
}

// ── AI Bot — auto-responds to incoming WhatsApp messages ────────────────────
const WhatsAppBotSettingsSchema = new mongoose.Schema({
  enabled:            { type: Boolean, default: false },
  instructions:        { type: String, default: "" },
  model:               { type: String, default: "gpt-4o-mini" },
  enabledInstanceIds:  { type: [String], default: [] },
}, { timestamps: true });
const WhatsAppBotSettings = mongoose.model("WhatsAppBotSettings", WhatsAppBotSettingsSchema);

async function getBotSettings() {
  return WhatsAppBotSettings.findOneAndUpdate(
    {},
    { $setOnInsert: { enabled: false, instructions: "", model: "gpt-4o-mini", enabledInstanceIds: [] } },
    { new: true, upsert: true, sort: { _id: 1 } }
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// SELF-HOSTED WHATSAPP SERVER
// ══════════════════════════════════════════════════════════════════════════════

const WhatsAppSelfSessionSchema = new mongoose.Schema({
  label:       { type: String, required: true, trim: true },
  sessionId:   { type: String, required: true, unique: true },
  authState:   { type: String, default: "" }, // legacy, unused
  status:      { type: String, enum: ["pending_qr", "connected", "disconnected"], default: "pending_qr" },
  phoneNumber: { type: String, default: "" },
  lastQr:      { type: String, default: "" },
}, { timestamps: true });
const WhatsAppSelfSession = mongoose.model("WhatsAppSelfSession", WhatsAppSelfSessionSchema);

const WhatsAppBulkJobSchema = new mongoose.Schema({
  sessionId: { type: String, required: true },
  message:   { type: String, required: true },
  numbers:   { type: [String], default: [] },
  status:    { type: String, enum: ["running", "done"], default: "running" },
  results:   { type: [{ number: String, success: Boolean, error: String }], default: [] },
}, { timestamps: true });
const WhatsAppBulkJob = mongoose.model("WhatsAppBulkJob", WhatsAppBulkJobSchema);

// Contacts are keyed by the SAME `number` value messages use, so the name
// lookup always matches. `name` = saved in your phone's contacts;
// `notify` = the person's own WhatsApp profile name (shown only as a hint).
const WhatsAppContactSchema = new mongoose.Schema({
  instanceId: { type: String, required: true },
  number:     { type: String, required: true },
  jid:        { type: String, default: "" },
  name:       { type: String, default: "" },
  notify:     { type: String, default: "" },
}, { timestamps: true });
WhatsAppContactSchema.index({ instanceId: 1, number: 1 }, { unique: true });
const WhatsAppContact = mongoose.model("WhatsAppContact", WhatsAppContactSchema, "whatsappcontacts_v2");

// LID ↔ phone number mapping, persisted so it survives restarts/redeploys.
const WhatsAppLidMapSchema = new mongoose.Schema({
  instanceId: { type: String, required: true },
  lid:        { type: String, required: true }, // "12345@lid"
  pn:         { type: String, required: true }, // "923001234567"
}, { timestamps: true });
WhatsAppLidMapSchema.index({ instanceId: 1, lid: 1 }, { unique: true });
const WhatsAppLidMap = mongoose.model("WhatsAppLidMap", WhatsAppLidMapSchema);

// ── NEW: WhatsApp login (creds + signal keys) stored in MongoDB ─────────────
// One document per key → survives restarts, sleeps and redeploys.
const WhatsAppAuthKeySchema = new mongoose.Schema({
  sessionId: { type: String, required: true },
  key:       { type: String, required: true }, // "creds" or "<type>-<id>"
  value:     { type: String, default: "" },    // JSON (BufferJSON)
}, { timestamps: true });
WhatsAppAuthKeySchema.index({ sessionId: 1, key: 1 }, { unique: true });
const WhatsAppAuthKey = mongoose.model("WhatsAppAuthKey", WhatsAppAuthKeySchema);

// Mongo-backed replacement for useMultiFileAuthState. `canWrite()` is false
// once this socket has been replaced/stopped, so an old socket can never
// overwrite the login of a newer one.
async function useMongoAuthState(sessionId, canWrite = () => true) {
  const { BufferJSON, initAuthCreds, proto } = Baileys;
  const encode = (v) => JSON.stringify(v, BufferJSON.replacer);
  const decode = (s) => { try { return JSON.parse(s, BufferJSON.reviver); } catch { return null; } };

  const credsRow = await WhatsAppAuthKey.findOne({ sessionId, key: "creds" }).lean();
  const creds = (credsRow?.value && decode(credsRow.value)) || initAuthCreds();

  const runOps = async (ops) => {
    if (ops.length === 0 || !canWrite()) return;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await WhatsAppAuthKey.bulkWrite(ops, { ordered: false }); return; }
      catch (err) {
        if (err.code === 11000 && attempt === 0) continue; // concurrent upsert race → retry once
        console.error("[Self-hosted WhatsApp] auth key save failed:", err.message);
        return;
      }
    }
  };

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const result = {};
          if (!ids || ids.length === 0) return result;
          const rows = await WhatsAppAuthKey.find({ sessionId, key: { $in: ids.map((id) => `${type}-${id}`) } }).lean();
          const byKey = new Map(rows.map((r) => [r.key, r.value]));
          for (const id of ids) {
            const raw = byKey.get(`${type}-${id}`);
            if (!raw) continue;
            let value = decode(raw);
            if (value && type === "app-state-sync-key" && proto?.Message?.AppStateSyncKeyData) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            if (value !== null && value !== undefined) result[id] = value;
          }
          return result;
        },
        set: async (data) => {
          const ops = [];
          for (const type in data) {
            for (const id in data[type]) {
              const value = data[type][id];
              const key = `${type}-${id}`;
              if (value === null || value === undefined) ops.push({ deleteOne: { filter: { sessionId, key } } });
              else ops.push({ updateOne: { filter: { sessionId, key }, update: { $set: { value: encode(value) } }, upsert: true } });
            }
          }
          await runOps(ops);
        },
      },
    },
    saveCreds: async () => {
      await runOps([{ updateOne: { filter: { sessionId, key: "creds" }, update: { $set: { value: encode(creds) } }, upsert: true } }]);
    },
  };
}

// True when this session has a completed (scanned) login saved in Mongo.
async function hasSavedLogin(sessionId) {
  const row = await WhatsAppAuthKey.findOne({ sessionId, key: "creds" }).lean();
  if (!row?.value) return false;
  try { return !!JSON.parse(row.value)?.me?.id; } catch { return false; }
}

// NEW — per-chat state: unread count + tags
const WhatsAppChatStateSchema = new mongoose.Schema({
  instanceId:  { type: String, required: true },
  number:      { type: String, required: true },
  unreadCount: { type: Number, default: 0 },
  tags:        { type: [String], default: [] },
}, { timestamps: true });
WhatsAppChatStateSchema.index({ instanceId: 1, number: 1 }, { unique: true });
WhatsAppChatStateSchema.index({ instanceId: 1, updatedAt: -1 });
const WhatsAppChatState = mongoose.model("WhatsAppChatState", WhatsAppChatStateSchema);

async function setUnread(instanceId, number, value) {
  if (!number) return;
  try { await WhatsAppChatState.updateOne({ instanceId, number }, { $set: { unreadCount: Math.max(0, value) } }, { upsert: true }); }
  catch (err) { if (err.code !== 11000) console.error("[WhatsApp] unread update failed:", err.message); }
}
async function incUnread(instanceId, number) {
  if (!number) return;
  try { await WhatsAppChatState.updateOne({ instanceId, number }, { $inc: { unreadCount: 1 } }, { upsert: true }); }
  catch (err) { if (err.code !== 11000) console.error("[WhatsApp] unread update failed:", err.message); }
}

const lidCache = new Map(); // `${instanceId}|${lidJid}` → phone digits

// Records a LID ↔ number mapping and merges any "lid:xxxx" thread (messages
// + contact name) into the real number's thread.
async function rememberLid(instanceId, lidJid, pnJid) {
  const lid = jidNorm(lidJid);
  const pn = jidNorm(pnJid);
  if (!isLidJid(lid) || !isPnJid(pn)) return;
  const pnNumber = digitsOf(pn);
  const cacheKey = `${instanceId}|${lid}`;
  if (lidCache.get(cacheKey) === pnNumber) return;
  lidCache.set(cacheKey, pnNumber);
  try {
    await WhatsAppLidMap.updateOne({ instanceId, lid }, { $set: { pn: pnNumber } }, { upsert: true });
    const label = lidLabel(lid);
    const moved = await WhatsAppMessage.updateMany({ instanceId, number: label }, { $set: { number: pnNumber } });
    const lidContact = await WhatsAppContact.findOne({ instanceId, number: label });
    if (lidContact) {
      const pnContact = await WhatsAppContact.findOne({ instanceId, number: pnNumber });
      const set = { jid: pnContact?.jid || pn };
      if (!pnContact?.name && lidContact.name) set.name = lidContact.name;
      if (!pnContact?.notify && lidContact.notify) set.notify = lidContact.notify;
      await WhatsAppContact.deleteOne({ _id: lidContact._id });
      await WhatsAppContact.updateOne({ instanceId, number: pnNumber }, { $set: set }, { upsert: true });
    }
    const lidState = await WhatsAppChatState.findOne({ instanceId, number: label });
    if (lidState) {
      await WhatsAppChatState.deleteOne({ _id: lidState._id });
      await WhatsAppChatState.updateOne(
        { instanceId, number: pnNumber },
        { $inc: { unreadCount: lidState.unreadCount || 0 }, $addToSet: { tags: { $each: lidState.tags || [] } } },
        { upsert: true }
      );
    }
    if (moved.modifiedCount > 0) {
      console.log(`[Self-hosted WhatsApp] merged ${moved.modifiedCount} message(s) from ${label} into +${pnNumber}`);
    }
  } catch (err) {
    if (err.code !== 11000) console.error("[Self-hosted WhatsApp] LID mapping save failed:", err.message);
  }
}

async function lookupLid(instanceId, lidJid) {
  const lid = jidNorm(lidJid);
  const cacheKey = `${instanceId}|${lid}`;
  if (lidCache.has(cacheKey)) return lidCache.get(cacheKey);
  const row = await WhatsAppLidMap.findOne({ instanceId, lid }).lean();
  if (row?.pn) { lidCache.set(cacheKey, row.pn); return row.pn; }
  return "";
}

// After sending to a phone number, ask Baileys which LID belongs to it — so
// when the reply comes back from that LID, it lands in the SAME thread.
async function learnLidForPn(instanceId, sock, pnJid) {
  const pn = jidNorm(pnJid);
  if (!isPnJid(pn) || !sock) return;
  try {
    const lid = await sock.signalRepository?.lidMapping?.getLIDForPN?.(pn);
    if (lid) { await rememberLid(instanceId, lid, pn); return; }
  } catch { /* not available in this Baileys version */ }
  try {
    const results = await sock.onWhatsApp(pn);
    const hit = Array.isArray(results) ? results.find((r) => r?.lid) : null;
    if (hit?.lid) await rememberLid(instanceId, hit.lid, pn);
  } catch { /* ignore */ }
}

async function saveContacts(instanceId, sock, contacts) {
  const ops = [];
  for (const c of contacts || []) {
    const ids = [c.id, c.jid, c.lid, c.phoneNumber].map(jidNorm).filter(Boolean);
    const pnJid = ids.find(isPnJid);
    const lidJid = ids.find(isLidJid);
    if (pnJid && lidJid) await rememberLid(instanceId, lidJid, pnJid);

    let number = pnJid ? digitsOf(pnJid) : "";
    if (!number && lidJid) number = (await resolveMessageIdentity({ remoteJid: lidJid }, sock, instanceId)).displayNumber;
    if (!number) continue;

    const set = {};
    if (c.name) set.name = c.name;
    if (c.notify) set.notify = c.notify;
    if (Object.keys(set).length === 0) continue;
    ops.push({ updateOne: { filter: { instanceId, number }, update: { $set: set, $setOnInsert: { jid: pnJid || lidJid || "" } }, upsert: true } });
  }
  if (ops.length > 0) {
    try { await WhatsAppContact.bulkWrite(ops, { ordered: false }); }
    catch (err) { if (err.code !== 11000) console.error("[Self-hosted WhatsApp] contact save failed:", err.message); }
  }
}

// Live socket connections, keyed by sessionId.
const activeSelfHostedSockets = new Map();
// Each new socket for a session gets a new generation number. Events,
// auth writes and auto-reconnect timers from an OLDER socket are ignored.
const socketGenerations = new Map();

// QR SAFETY NET:
// - "desktop" link mode gives the full chat history, but on some Baileys /
//   WhatsApp versions it fails before a QR is ever issued. If a not-yet-
//   scanned session closes twice in a row WITHOUT producing a QR, it falls
//   back to the default (web) link mode, which is the confirmed-working one.
// - Unscanned (half-made) login data is wiped after such a failure so a bad
//   half-made login can never get stuck in MongoDB and block the QR forever.
const linkMode = new Map();        // sessionId → "desktop" | "default"
const noQrFailures = new Map();    // sessionId → consecutive closes with no QR

// Legacy folder (older versions stored the login here) — only cleaned up now.
function sessionFolderFor(sessionId) {
  return path.join("/tmp/wa-sessions", sessionId);
}
function wipeSessionFolder(sessionId) {
  try { fs.rmSync(sessionFolderFor(sessionId), { recursive: true, force: true }); }
  catch (err) { console.error("[Self-hosted WhatsApp] failed to wipe session folder:", err.message); }
}
// Deletes the saved WhatsApp login → next start shows a fresh QR.
async function wipeSessionAuth(sessionId) {
  wipeSessionFolder(sessionId);
  try { await WhatsAppAuthKey.deleteMany({ sessionId }); }
  catch (err) { console.error("[Self-hosted WhatsApp] failed to wipe saved login:", err.message); }
}

async function stopSelfHostedSocket(sessionId, { logout = false } = {}) {
  socketGenerations.set(sessionId, (socketGenerations.get(sessionId) || 0) + 1);
  const sock = activeSelfHostedSockets.get(sessionId);
  activeSelfHostedSockets.delete(sessionId);
  if (!sock) return;
  if (logout) { try { await sock.logout(); } catch { /* already closed */ } }
  try { sock.end(undefined); } catch { /* ignore */ }
}

async function startSelfHostedSession(sessionDoc) {
  if (!Baileys) throw new Error("Baileys isn't installed on the server yet");
  const {
    default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore, Browsers,
  } = Baileys;
  const instanceId = sessionDoc.sessionId;

  // Never let two sockets run for the same session (that causes 440
  // "connection replaced" loops and missing messages).
  await stopSelfHostedSocket(instanceId);
  const generation = (socketGenerations.get(instanceId) || 0) + 1;
  socketGenerations.set(instanceId, generation);
  const isCurrent = () => socketGenerations.get(instanceId) === generation;

  // Login is stored in MongoDB → no QR needed after restarts / sleeps / redeploys.
  const { state, saveCreds } = await useMongoAuthState(instanceId, isCurrent);
  let version;
  try { ({ version } = await fetchLatestBaileysVersion()); } catch { /* use Baileys' default */ }
  if (!isCurrent()) return null; // superseded while we were awaiting

  const pino = require("pino");
  const logger = pino({ level: "silent" });
  const useDesktop = linkMode.get(instanceId) !== "default";
  let gotQrThisSocket = false;
  console.log(`[Self-hosted WhatsApp] "${sessionDoc.label}" — starting socket (link mode: ${useDesktop ? "desktop / full history" : "default"}, saved login: ${state.creds?.me?.id ? "yes" : "no"})`);
  const sock = makeWASocket({
    ...(version ? { version } : {}),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore ? makeCacheableSignalKeyStore(state.keys, logger) : state.keys,
    },
    logger,
    printQRInTerminal: false,
    ...(useDesktop ? {
      // "Desktop" links receive the FULL chat history (web links get less)
      browser: Browsers?.macOS ? Browsers.macOS("Desktop") : ["Mac OS", "Desktop", "14.4.1"],
      // Newer Baileys skips the FULL history chunk by default — accept everything
      shouldSyncHistoryMessage: () => true,
    } : {}),
    syncFullHistory: true,
    keepAliveIntervalMs: 15000,
  });
  activeSelfHostedSockets.set(instanceId, sock);

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    if (!isCurrent()) return;
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      gotQrThisSocket = true;
      noQrFailures.delete(instanceId);
      console.log(`[Self-hosted WhatsApp] "${sessionDoc.label}" — new QR issued`);
      await WhatsAppSelfSession.findByIdAndUpdate(sessionDoc._id, { lastQr: qr, status: "pending_qr" });
    }
    if (connection === "open") {
      const phoneNumber = sock.user?.id ? sock.user.id.split(":")[0] : "";
      console.log(`[Self-hosted WhatsApp] "${sessionDoc.label}" — connected (${phoneNumber})`);
      await WhatsAppSelfSession.findByIdAndUpdate(sessionDoc._id, { status: "connected", phoneNumber, lastQr: "" });
    }
    if (connection === "close") {
      if (activeSelfHostedSockets.get(instanceId) === sock) activeSelfHostedSockets.delete(instanceId);
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log(`[Self-hosted WhatsApp] "${sessionDoc.label}" — disconnected. statusCode=${statusCode}, reason=${lastDisconnect?.error?.message || "unknown"}`);

      if (statusCode === DisconnectReason.loggedOut) {
        // Genuinely unlinked from the phone — wipe the saved login so the
        // next Reconnect shows a fresh QR instead of trying dead credentials.
        await stopSelfHostedSocket(instanceId); // blocks any late writes from this socket
        await wipeSessionAuth(instanceId);
        await WhatsAppSelfSession.findByIdAndUpdate(sessionDoc._id, { status: "disconnected", lastQr: "" });
        console.log(`[Self-hosted WhatsApp] "${sessionDoc.label}" — logged out from the phone; click Reconnect to scan a new QR.`);
        return;
      }
      if (statusCode === DisconnectReason.connectionReplaced) {
        await WhatsAppSelfSession.findByIdAndUpdate(sessionDoc._id, { status: "disconnected" });
        console.log(`[Self-hosted WhatsApp] "${sessionDoc.label}" — replaced by another connection using the same session; not auto-reconnecting.`);
        return;
      }
      // Not scanned yet and this socket never produced a QR → the half-made
      // login is useless: wipe it so the retry starts clean, and after two
      // such failures fall back to the default link mode.
      if (!state.creds?.me?.id && !gotQrThisSocket && statusCode !== DisconnectReason.restartRequired) {
        const fails = (noQrFailures.get(instanceId) || 0) + 1;
        noQrFailures.set(instanceId, fails);
        try { await WhatsAppAuthKey.deleteMany({ sessionId: instanceId }); } catch { /* ignore */ }
        if (fails >= 2 && useDesktop) {
          linkMode.set(instanceId, "default");
          console.log(`[Self-hosted WhatsApp] "${sessionDoc.label}" — no QR in desktop mode (statusCode=${statusCode}); switching to default link mode so the QR can show.`);
        }
      }
      // Any other close keeps retrying with the SAME saved login (no QR).
      // 515 (restartRequired) happens right after a successful QR scan.
      // While still waiting for a scan, keep the status "pending_qr" so the
      // QR window keeps waiting for the next QR instead of showing "expired".
      if (statusCode !== DisconnectReason.restartRequired) {
        await WhatsAppSelfSession.findByIdAndUpdate(sessionDoc._id, { status: state.creds?.me?.id ? "disconnected" : "pending_qr" });
      }
      setTimeout(async () => {
        if (!isCurrent()) return; // user clicked Reconnect/Remove meanwhile
        const fresh = await WhatsAppSelfSession.findById(sessionDoc._id);
        if (fresh) startSelfHostedSession(fresh).catch((err) => console.error("[Self-hosted WhatsApp] reconnect failed:", err.message));
      }, statusCode === DisconnectReason.restartRequired ? 500 : 5000);
    }
  });

  // ── Live messages (incoming + anything sent from the phone/other devices) ──
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (!isCurrent()) return;
    if (type !== "notify" && type !== "append") return;
    for (const msg of messages) {
      try {
        const remote = msg.key?.remoteJid || "";
        if (!msg.message || !remote) continue;
        if (remote.endsWith("@g.us") || remote.endsWith("@broadcast") || remote.endsWith("@newsletter")) continue;
        const content = getMessageContent(msg);
        if (!content) continue; // protocol/system traffic

        const { jid, displayNumber } = await resolveMessageIdentity(msg.key, sock, instanceId);
        if (!displayNumber) continue;

        if (!msg.key.fromMe && msg.pushName) {
          WhatsAppContact.updateOne(
            { instanceId, number: displayNumber },
            { $set: { notify: msg.pushName }, $setOnInsert: { jid } },
            { upsert: true }
          ).catch(() => {});
        }

        if (msg.key.id && await WhatsAppMessage.exists({ instanceId, waMessageId: msg.key.id })) continue;

        const fromMe = !!msg.key.fromMe;
        await logWhatsAppMessage({
          instanceId,
          direction: fromMe ? "outgoing" : "incoming",
          number: displayNumber,
          jid,
          message: content.text,
          status: fromMe ? "sent" : "received",
          source: fromMe ? "mobile_app" : "self_hosted",
          waMessageId: msg.key.id || "",
          createdAt: toDate(msg.messageTimestamp),
          ...describeMessage(msg),
        });
        if (type === "notify") {
          if (fromMe) await setUnread(instanceId, displayNumber, 0);
          else await incUnread(instanceId, displayNumber);
        }

        // AI bot: only for genuinely new incoming text messages
        if (!fromMe && type === "notify" && content.hasText) {
          const botSettings = await getBotSettings();
          if (botSettings.enabled && botSettings.enabledInstanceIds.includes(instanceId)) {
            const history = await buildBotHistory(instanceId, displayNumber, content.text);
            const reply = await callOpenAI({ systemPrompt: botSettings.instructions, history, model: botSettings.model });
            if (reply) {
              const sent = await sock.sendMessage(jid, { text: reply });
              await logWhatsAppMessage({ instanceId, direction: "outgoing", number: displayNumber, jid, message: reply, status: "sent", source: "ai_bot", waMessageId: sent?.key?.id || "" });
            }
          }
        }
      } catch (err) { console.error("[Self-hosted WhatsApp] incoming message handling failed:", err.message); }
    }
  });

  // ── Full history import (runs after a fresh QR scan) ─────────────────────
  sock.ev.on("messaging-history.set", async ({ chats, contacts, messages, isLatest, lidPnMappings, progress }) => {
    if (!isCurrent()) return;
    const memMB = (process.memoryUsage().rss / 1024 / 1024).toFixed(0);
    console.log(`[Self-hosted WhatsApp] history sync for "${sessionDoc.label}" — ${messages?.length || 0} message(s), ${contacts?.length || 0} contact(s), ${chats?.length || 0} chat(s), isLatest=${isLatest}, progress=${progress ?? "?"}, memory=${memMB}MB`);

    // 1) learn LID ↔ number mappings first, so messages below resolve to numbers
    for (const m of lidPnMappings || []) await rememberLid(instanceId, m?.lid, m?.pn);
    for (const c of chats || []) {
      const ids = [c.id, c.pnJid, c.lidJid].map(jidNorm).filter(Boolean);
      const pn = ids.find(isPnJid);
      const lid = ids.find(isLidJid);
      if (pn && lid) await rememberLid(instanceId, lid, pn);
    }
    // 2) contact names
    await saveContacts(instanceId, sock, contacts);
    // 2b) unread counts, as shown on the phone
    for (const c of chats || []) {
      if (!c?.id || c.id.endsWith("@g.us") || c.id.endsWith("@broadcast") || c.id.endsWith("@newsletter")) continue;
      if (typeof c.unreadCount !== "number") continue;
      const { displayNumber } = await resolveMessageIdentity({ remoteJid: c.id }, sock, instanceId);
      if (displayNumber) await setUnread(instanceId, displayNumber, c.unreadCount);
    }

    // 3) messages
    const ops = [];
    const now = new Date();
    for (const msg of messages || []) {
      const remote = msg.key?.remoteJid || "";
      if (!msg.message || !remote) continue;
      if (remote.endsWith("@g.us") || remote.endsWith("@broadcast") || remote.endsWith("@newsletter")) continue;
      const content = getMessageContent(msg);
      if (!content) continue;
      const { jid, displayNumber } = await resolveMessageIdentity(msg.key, sock, instanceId);
      if (!displayNumber || !msg.key.id) continue;
      const fromMe = !!msg.key.fromMe;
      ops.push({
        updateOne: {
          filter: { instanceId, waMessageId: msg.key.id },
          update: {
            $setOnInsert: {
              instanceId, direction: fromMe ? "outgoing" : "incoming", number: displayNumber, groupId: "",
              jid, message: content.text, status: fromMe ? "sent" : "received", source: "history_sync",
              waMessageId: msg.key.id, createdAt: toDate(msg.messageTimestamp), updatedAt: now,
              ...describeMessage(msg),
            },
          },
          upsert: true,
          timestamps: false,
        },
      });
    }
    if (ops.length === 0) return;

    // Small paced chunks keep memory low on Render.
    const CHUNK_SIZE = 200;
    let imported = 0;
    for (let i = 0; i < ops.length; i += CHUNK_SIZE) {
      if (!isCurrent()) return;
      try {
        const result = await WhatsAppMessage.bulkWrite(ops.slice(i, i + CHUNK_SIZE), { ordered: false });
        imported += result.upsertedCount || 0;
      } catch (err) {
        imported += err.result?.upsertedCount || err.result?.nUpserted || 0;
        if (err.code !== 11000) console.error("[Self-hosted WhatsApp] history chunk import error:", err.message);
      }
      if (i + CHUNK_SIZE < ops.length) await new Promise((r) => setTimeout(r, 300));
    }
    const memAfterMB = (process.memoryUsage().rss / 1024 / 1024).toFixed(0);
    console.log(`[Self-hosted WhatsApp] history sync for "${sessionDoc.label}" — imported ${imported} new message(s), memory now=${memAfterMB}MB`);
  });

  // Newer Baileys versions announce LID ↔ number mappings directly
  sock.ev.on("lid-mapping.update", async (update) => {
    if (!isCurrent()) return;
    for (const m of Array.isArray(update) ? update : [update]) await rememberLid(instanceId, m?.lid, m?.pn);
  });

  // Chat read / unread changes (e.g. you opened the chat on your phone)
  sock.ev.on("chats.update", async (updates) => {
    if (!isCurrent()) return;
    for (const u of updates || []) {
      if (!u?.id || u.unreadCount !== 0 || u.id.endsWith("@g.us")) continue;
      try {
        const { displayNumber } = await resolveMessageIdentity({ remoteJid: u.id }, sock, instanceId);
        if (!displayNumber) continue;
        if (u.unreadCount === 0) await setUnread(instanceId, displayNumber, 0); // read on another device
      } catch { /* ignore */ }
    }
  });

  // Saved-name changes after the initial sync
  sock.ev.on("contacts.upsert", async (contacts) => { if (isCurrent()) await saveContacts(instanceId, sock, contacts); });
  sock.ev.on("contacts.update", async (contacts) => { if (isCurrent()) await saveContacts(instanceId, sock, contacts); });

  return sock;
}

// On server start: every account with a saved login reconnects silently
// (no QR). Accounts that were never scanned are marked "disconnected" so
// the dashboard offers Reconnect instead of looping QR codes in the background.
async function startAllSelfHostedSessions() {
  if (!Baileys) { console.log("[Self-hosted WhatsApp] Baileys not installed — skipping startup reconnect"); return; }
  try {
    const sessions = await WhatsAppSelfSession.find({});
    const toStart = [];
    for (const s of sessions) {
      if (await hasSavedLogin(s.sessionId)) toStart.push(s);
      else if (s.status !== "disconnected") await WhatsAppSelfSession.findByIdAndUpdate(s._id, { status: "disconnected", lastQr: "" });
    }
    console.log(`[Self-hosted WhatsApp] startup — reconnecting ${toStart.length} saved session(s): ${toStart.map((s) => s.label).join(", ") || "(none)"}`);
    for (const s of toStart) startSelfHostedSession(s).catch((err) => console.error("[Self-hosted WhatsApp] startup reconnect failed for", s.label, ":", err.message));
  } catch (err) { console.error("[Self-hosted WhatsApp] startup scan failed:", err.message); }
}

// Digits only — the one canonical number format stored everywhere.
function normalizeWaNumber(number) {
  return String(number).replace(/[^\d]/g, "");
}

function toWhatsAppJid(number) {
  return `${normalizeWaNumber(number)}@s.whatsapp.net`;
}

// Returns { jid, displayNumber }:
//   jid           — exact identifier to reply to (phone JID or LID)
//   displayNumber — the real phone number (digits) whenever it can be found;
//                   "lid:xxxx" only as a temporary fallback; "" for things
//                   that aren't 1-to-1 chats.
async function resolveMessageIdentity(key, sock, instanceId) {
  const jid = jidNorm(key?.remoteJid);
  if (!jid) return { jid: "", displayNumber: "" };
  if (isPnJid(jid)) return { jid, displayNumber: digitsOf(jid) };
  if (!isLidJid(jid)) return { jid, displayNumber: "" };

  const alt = [key.remoteJidAlt, key.senderPn].map(jidNorm).find(isPnJid);
  if (alt) {
    await rememberLid(instanceId, jid, alt);
    return { jid, displayNumber: digitsOf(alt) };
  }

  const known = await lookupLid(instanceId, jid);
  if (known) return { jid, displayNumber: known };

  if (sock?.signalRepository?.lidMapping?.getPNForLID) {
    try {
      const pn = jidNorm(await sock.signalRepository.lidMapping.getPNForLID(jid));
      if (isPnJid(pn)) {
        await rememberLid(instanceId, jid, pn);
        return { jid, displayNumber: digitsOf(pn) };
      }
    } catch { /* not resolvable yet — merged automatically later */ }
  }
  return { jid, displayNumber: lidLabel(jid) };
}

async function sendSelfHostedMessage(sessionId, target, text) {
  const sock = activeSelfHostedSockets.get(sessionId);
  if (!sock) throw new Error("This number isn't connected right now");
  const jid = String(target).includes("@") ? target : toWhatsAppJid(target);
  const sent = await sock.sendMessage(jid, { text });
  // Learn this number's LID now, so the reply joins this same thread.
  learnLidForPn(sessionId, sock, jid).catch(() => {});
  return sent?.key?.id || "";
}

async function runBulkJob(jobId, sessionId, numbers, message) {
  const results = [];
  for (const number of numbers) {
    try {
      const waMessageId = await sendSelfHostedMessage(sessionId, number, message);
      await logWhatsAppMessage({ instanceId: sessionId, direction: "outgoing", number: normalizeWaNumber(number), jid: toWhatsAppJid(number), message, status: "sent", source: "bulk", waMessageId });
      results.push({ number, success: true, error: "" });
    } catch (err) {
      await logWhatsAppMessage({ instanceId: sessionId, direction: "outgoing", number: normalizeWaNumber(number), message, status: "failed", source: "bulk", error: err.message });
      results.push({ number, success: false, error: err.message });
    }
    await WhatsAppBulkJob.findByIdAndUpdate(jobId, { results });
    await new Promise((r) => setTimeout(r, 2000 + Math.random() * 3000)); // 2–5s pace between sends
  }
  await WhatsAppBulkJob.findByIdAndUpdate(jobId, { status: "done", results });
}

async function callOpenAI({ systemPrompt, history, model }) {
  const settings = await getSiteSettings();
  const apiKey = settings.openaiApiKey;
  if (!apiKey) throw new Error("No OpenAI API key saved — add one in Super Admin → WhatsApp → AI Bot");
  const messages = [{ role: "system", content: systemPrompt || "You are a helpful customer support assistant." }, ...history];
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || "gpt-4o-mini",
      max_tokens: 500,
      messages,
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data?.error?.message || `OpenAI API returned HTTP ${resp.status}`);
  return data.choices?.[0]?.message?.content || "";
}

async function buildBotHistory(instanceId, number, latestIncomingText) {
  const prior = await WhatsAppMessage.find({ instanceId, number, groupId: "" }).sort("-createdAt").limit(10);
  const history = prior.reverse().map((m) => ({ role: m.direction === "incoming" ? "user" : "assistant", content: m.message }));
  const last = history[history.length - 1];
  if (!(last && last.role === "user" && last.content === latestIncomingText)) {
    history.push({ role: "user", content: latestIncomingText });
  }
  return history;
}

async function getWhatsAppCredentials() {
  const settings = await getSiteSettings();
  return {
    phoneNumberId: settings.whatsappPhoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID || "",
    accessToken:   settings.whatsappAccessToken   || process.env.WHATSAPP_ACCESS_TOKEN   || "",
  };
}
async function whatsappConfigured() {
  const { phoneNumberId, accessToken } = await getWhatsAppCredentials();
  return !!(phoneNumberId && accessToken);
}
async function sendWhatsAppRaw({ to, text }) {
  const { phoneNumberId, accessToken } = await getWhatsAppCredentials();
  if (!phoneNumberId || !accessToken) throw new Error("WhatsApp not connected — add it in Super Admin → Settings");
  const resp = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: String(to).replace(/[^\d+]/g, ""),
      type: "text",
      text: { body: text, preview_url: true },
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data?.error?.message || `WhatsApp API returned HTTP ${resp.status}`);
  return data;
}

// ── Super Admin → Settings → WhatsApp (Meta Cloud API) ──────────────────────
app.get("/api/admin/settings/whatsapp", protect, adminOnly, async (req, res) => {
  try {
    const settings = await getSiteSettings();
    res.json({
      whatsappPhoneNumberId: settings.whatsappPhoneNumberId || "",
      whatsappConnected: !!(settings.whatsappPhoneNumberId && settings.whatsappAccessToken),
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.post("/api/admin/settings/whatsapp", protect, adminOnly, async (req, res) => {
  try {
    const { whatsappPhoneNumberId, whatsappAccessToken } = req.body || {};
    if (!whatsappPhoneNumberId?.trim() || !whatsappAccessToken?.trim())
      return res.status(400).json({ message: "Both the Phone Number ID and Access Token are required" });
    await SiteSettings.findOneAndUpdate(
      {},
      { whatsappPhoneNumberId: whatsappPhoneNumberId.trim(), whatsappAccessToken: whatsappAccessToken.trim() },
      { upsert: true, sort: { _id: 1 } }
    );
    res.json({ connected: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.delete("/api/admin/settings/whatsapp", protect, adminOnly, async (req, res) => {
  try {
    await SiteSettings.findOneAndUpdate({}, { whatsappPhoneNumberId: "", whatsappAccessToken: "" }, { sort: { _id: 1 } });
    res.json({ disconnected: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── OpenAI key — Super Admin → WhatsApp → Chatbot ───────────────────────────
app.get("/api/admin/settings/openai", protect, adminOnly, async (req, res) => {
  try {
    const settings = await getSiteSettings();
    res.json({ connected: !!settings.openaiApiKey });
  } catch (err) { res.status(500).json({ message: err.message }); }
});
app.post("/api/admin/settings/openai", protect, adminOnly, async (req, res) => {
  try {
    const { apiKey } = req.body || {};
    if (!apiKey?.trim()) return res.status(400).json({ message: "API key is required" });
    await SiteSettings.findOneAndUpdate({}, { openaiApiKey: apiKey.trim() }, { upsert: true, sort: { _id: 1 } });
    res.json({ connected: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});
app.delete("/api/admin/settings/openai", protect, adminOnly, async (req, res) => {
  try {
    await SiteSettings.findOneAndUpdate({}, { openaiApiKey: "" }, { sort: { _id: 1 } });
    res.json({ disconnected: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── AI Bot ──────────────────────────────────────────────────────────────────
app.get("/api/admin/whatsapp/bot-settings", protect, adminOnly, async (req, res) => {
  try {
    res.json(await getBotSettings());
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.post("/api/admin/whatsapp/bot-settings", protect, adminOnly, async (req, res) => {
  try {
    const { enabled, instructions, model, enabledInstanceIds } = req.body || {};
    const update = {};
    if (enabled !== undefined) update.enabled = !!enabled;
    if (instructions !== undefined) update.instructions = instructions;
    if (model !== undefined) update.model = model;
    if (enabledInstanceIds !== undefined) update.enabledInstanceIds = Array.isArray(enabledInstanceIds) ? enabledInstanceIds : [];
    const settings = await WhatsAppBotSettings.findOneAndUpdate({}, update, { new: true, upsert: true, sort: { _id: 1 } });
    res.json(settings);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.post("/api/admin/whatsapp/bot-test", protect, adminOnly, async (req, res) => {
  try {
    const { message, history } = req.body || {};
    if (!message?.trim()) return res.status(400).json({ message: "A message is required" });
    const settings = await getBotSettings();
    const conversation = [...(Array.isArray(history) ? history : []), { role: "user", content: message.trim() }];
    const reply = await callOpenAI({ systemPrompt: settings.instructions, history: conversation, model: settings.model });
    res.json({ reply });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// SELF-HOSTED WHATSAPP SERVER ROUTES
// ══════════════════════════════════════════════════════════════════════════════
function requireBaileys(req, res, next) {
  if (!Baileys) return res.status(503).json({ message: "The self-hosted WhatsApp server isn't installed yet — run `npm install @whiskeysockets/baileys` and redeploy." });
  next();
}

app.get("/api/admin/whatsapp-server/sessions", protect, adminOnly, requireBaileys, async (req, res) => {
  try {
    res.json(await WhatsAppSelfSession.find({}).select("-authState").sort("-createdAt"));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.post("/api/admin/whatsapp-server/sessions", protect, adminOnly, requireBaileys, async (req, res) => {
  try {
    const { label } = req.body || {};
    if (!label?.trim()) return res.status(400).json({ message: "A name for this number is required" });
    const sessionId = crypto.randomBytes(8).toString("hex");
    const session = await WhatsAppSelfSession.create({ label: label.trim(), sessionId, status: "pending_qr" });
    startSelfHostedSession(session).catch((err) => console.error("[Self-hosted WhatsApp] failed to start session:", err.message));
    res.status(201).json({ _id: session._id, label: session.label, sessionId: session.sessionId, status: session.status });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.get("/api/admin/whatsapp-server/sessions/:id/qr", protect, adminOnly, requireBaileys, async (req, res) => {
  try {
    const session = await WhatsAppSelfSession.findById(req.params.id).select("-authState");
    if (!session) return res.status(404).json({ message: "Session not found" });
    const qrImage = await renderQrDataUrl(session.lastQr);
    res.json({ qr: session.lastQr, qrImage, status: session.status, phoneNumber: session.phoneNumber });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Reconnect = full fresh link: log out the old link, wipe its saved login,
// start a new socket → a NEW QR code. Scanning it also re-imports history.
app.post("/api/admin/whatsapp-server/sessions/:id/reconnect", protect, adminOnly, requireBaileys, async (req, res) => {
  try {
    const session = await WhatsAppSelfSession.findById(req.params.id);
    if (!session) return res.status(404).json({ message: "Session not found" });
    await stopSelfHostedSocket(session.sessionId, { logout: true });
    await wipeSessionAuth(session.sessionId);
    const fresh = await WhatsAppSelfSession.findByIdAndUpdate(session._id, { status: "pending_qr", lastQr: "" }, { new: true });
    startSelfHostedSession(fresh).catch((err) => console.error("[Self-hosted WhatsApp] reconnect failed:", err.message));
    res.json({ _id: fresh._id, label: fresh.label, sessionId: fresh.sessionId, status: fresh.status });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.delete("/api/admin/whatsapp-server/sessions/:id", protect, adminOnly, requireBaileys, async (req, res) => {
  try {
    const session = await WhatsAppSelfSession.findById(req.params.id);
    if (!session) return res.status(404).json({ message: "Session not found" });
    await stopSelfHostedSocket(session.sessionId, { logout: true });
    await wipeSessionAuth(session.sessionId);
    await WhatsAppSelfSession.findByIdAndDelete(req.params.id);
    res.json({ deleted: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Wipes stored message history for one number WITHOUT disconnecting it.
// To re-import the full history afterwards, click Reconnect and scan the QR.
app.delete("/api/admin/whatsapp-server/sessions/:id/messages", protect, adminOnly, requireBaileys, async (req, res) => {
  try {
    const session = await WhatsAppSelfSession.findById(req.params.id);
    if (!session) return res.status(404).json({ message: "Session not found" });
    const result = await WhatsAppMessage.deleteMany({ instanceId: session.sessionId });
    res.json({ deletedCount: result.deletedCount });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.post("/api/admin/whatsapp-server/send", protect, adminOnly, requireBaileys, async (req, res) => {
  try {
    const { sessionDocId, to, message } = req.body || {};
    if (!sessionDocId || !to?.trim() || !message?.trim()) return res.status(400).json({ message: "A number and a message are required" });
    const session = await WhatsAppSelfSession.findById(sessionDocId);
    if (!session) return res.status(404).json({ message: "Session not found" });
    // Keep "lid:xxxx" thread keys intact; normalize real numbers to digits
    const displayNumber = to.trim().startsWith("lid:") ? to.trim() : normalizeWaNumber(to);
    const priorMessage = await WhatsAppMessage.findOne({ instanceId: session.sessionId, number: displayNumber, jid: { $ne: "" } }).sort("-createdAt");
    const sendTarget = priorMessage?.jid || (displayNumber.startsWith("lid:") ? `${displayNumber.slice(4)}@lid` : displayNumber);
    try {
      const waMessageId = await sendSelfHostedMessage(session.sessionId, sendTarget, message.trim());
      await logWhatsAppMessage({ instanceId: session.sessionId, direction: "outgoing", number: displayNumber, jid: sendTarget.includes("@") ? sendTarget : toWhatsAppJid(sendTarget), message: message.trim(), status: "sent", source: "manual", waMessageId });
    } catch (err) {
      await logWhatsAppMessage({ instanceId: session.sessionId, direction: "outgoing", number: displayNumber, message: message.trim(), status: "failed", source: "manual", error: err.message });
      throw err;
    }
    res.json({ sent: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.post("/api/admin/whatsapp-server/send-bulk", protect, adminOnly, requireBaileys, async (req, res) => {
  try {
    const { sessionDocId, numbers, message } = req.body || {};
    if (!sessionDocId || !Array.isArray(numbers) || numbers.length === 0 || !message?.trim())
      return res.status(400).json({ message: "A number list and a message are required" });
    const session = await WhatsAppSelfSession.findById(sessionDocId);
    if (!session) return res.status(404).json({ message: "Session not found" });
    const job = await WhatsAppBulkJob.create({ sessionId: session.sessionId, message: message.trim(), numbers, status: "running", results: [] });
    runBulkJob(job._id, session.sessionId, numbers, message.trim()).catch((err) => console.error("[Self-hosted WhatsApp] bulk job crashed:", err.message));
    res.status(201).json({ jobId: job._id });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.get("/api/admin/whatsapp-server/bulk-jobs/:id", protect, adminOnly, requireBaileys, async (req, res) => {
  try {
    const job = await WhatsAppBulkJob.findById(req.params.id);
    if (!job) return res.status(404).json({ message: "Job not found" });
    res.json(job);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.post("/api/whatsapp-server/external/send", requireBaileys, async (req, res) => {
  try {
    const { apiKey, sessionId, to, message } = req.body || {};
    const settings = await getSiteSettings();
    if (!settings.whatsappServerApiKey || apiKey !== settings.whatsappServerApiKey)
      return res.status(401).json({ message: "Invalid API key" });
    if (!sessionId || !to?.trim() || !message?.trim()) return res.status(400).json({ message: "sessionId, to, and message are required" });
    let waMessageId = "";
    try {
      waMessageId = await sendSelfHostedMessage(sessionId, to.trim(), message.trim());
      await logWhatsAppMessage({ instanceId: sessionId, direction: "outgoing", number: normalizeWaNumber(to), jid: toWhatsAppJid(to), message: message.trim(), status: "sent", source: "external_api", waMessageId });
    } catch (err) {
      await logWhatsAppMessage({ instanceId: sessionId, direction: "outgoing", number: normalizeWaNumber(to), message: message.trim(), status: "failed", source: "external_api", error: err.message });
      throw err;
    }
    res.json({ sent: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.get("/api/admin/settings/whatsapp-server-key", protect, adminOnly, async (req, res) => {
  try {
    const settings = await getSiteSettings();
    res.json({ apiKey: settings.whatsappServerApiKey || "" });
  } catch (err) { res.status(500).json({ message: err.message }); }
});
app.post("/api/admin/settings/whatsapp-server-key", protect, adminOnly, async (req, res) => {
  try {
    const apiKey = crypto.randomBytes(20).toString("hex");
    await SiteSettings.findOneAndUpdate({}, { whatsappServerApiKey: apiKey }, { upsert: true, sort: { _id: 1 } });
    res.json({ apiKey });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.get("/api/admin/whatsapp/messages", protect, adminOnly, async (req, res) => {
  try {
    const { instanceId } = req.query;
    if (!instanceId) return res.status(400).json({ message: "instanceId is required" });
    const messages = await WhatsAppMessage.find({ instanceId }).sort("-createdAt").limit(200);
    const sentCount = await WhatsAppMessage.countDocuments({ instanceId, direction: "outgoing", status: "sent" });
    const receivedCount = await WhatsAppMessage.countDocuments({ instanceId, direction: "incoming" });
    const failedCount = await WhatsAppMessage.countDocuments({ instanceId, direction: "outgoing", status: "failed" });
    res.json({ messages, sentCount, receivedCount, failedCount });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// CONVERSATIONS — one thread per contact
// ══════════════════════════════════════════════════════════════════════════════

// One row per contact, newest first. `name` = saved contact name (empty if
// the number isn't saved → the frontend shows the full number instead).
// NEW: `since` → only the chats that changed since then (fast polling);
// `v=2` → { threads, serverTime } response with unreadCount + tags.
app.get("/api/admin/whatsapp/conversations", protect, adminOnly, async (req, res) => {
  try {
    const { instanceId, since, v } = req.query;
    if (!instanceId) return res.status(400).json({ message: "instanceId is required" });
    const serverTime = new Date(Date.now() - 3000);
    const match = { instanceId, number: { $ne: "" }, groupId: "" };
    const sinceDate = since ? new Date(since) : null;
    if (sinceDate && !isNaN(sinceDate)) {
      const [changedMsgs, changedStates] = await Promise.all([
        WhatsAppMessage.distinct("number", { instanceId, groupId: "", updatedAt: { $gte: sinceDate } }),
        WhatsAppChatState.distinct("number", { instanceId, updatedAt: { $gte: sinceDate } }),
      ]);
      const changed = [...new Set([...changedMsgs, ...changedStates])].filter(Boolean);
      if (changed.length === 0) return res.json({ threads: [], serverTime, partial: true });
      match.number = { $in: changed };
    }
    const threads = await WhatsAppMessage.aggregate([
      { $match: match },
      { $sort: { createdAt: -1 } },
      { $group: { _id: "$number", jid: { $first: "$jid" }, lastMessage: { $first: "$message" }, lastDirection: { $first: "$direction" }, lastType: { $first: "$msgType" }, lastAt: { $first: "$createdAt" }, count: { $sum: 1 } } },
      { $sort: { lastAt: -1 } },
    ]).allowDiskUse(true);
    const numbers = threads.map((t) => t._id);
    const [contacts, states] = numbers.length > 0
      ? await Promise.all([
          WhatsAppContact.find({ instanceId, number: { $in: numbers } }).lean(),
          WhatsAppChatState.find({ instanceId, number: { $in: numbers } }).lean(),
        ])
      : [[], []];
    const byNumber = Object.fromEntries(contacts.map((c) => [c.number, c]));
    const stateByNumber = Object.fromEntries(states.map((c) => [c.number, c]));
    const list = threads.map((t) => {
      const c = byNumber[t._id];
      const st = stateByNumber[t._id];
      return {
        number: t._id,
        name: c?.name || "",
        pushName: c?.name ? "" : (c?.notify || ""),
        lastMessage: t.lastMessage,
        lastDirection: t.lastDirection,
        lastType: t.lastType || "text",
        lastAt: t.lastAt,
        count: t.count,
        unreadCount: st?.unreadCount || 0,
        tags: st?.tags || [],
      };
    });
    if (v === "2" || since) return res.json({ threads: list, serverTime, partial: !!since });
    res.json(list);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Chat with one contact, returned oldest-first.
//   default      → the LATEST `limit` messages
//   ?before=ISO  → older page (scrolling up)
//   ?after=ISO   → only messages added/changed since then (fast polling)
app.get("/api/admin/whatsapp/conversations/:instanceId/:number", protect, adminOnly, async (req, res) => {
  try {
    const { instanceId, number } = req.params;
    const limit = Math.min(Number(req.query.limit) || 1000, 5000);
    const serverTime = new Date(Date.now() - 3000);
    const q = { instanceId, number, groupId: "" };
    let rows;
    if (req.query.after) {
      q.updatedAt = { $gte: new Date(req.query.after) };
      rows = await WhatsAppMessage.find(q).sort("createdAt").limit(500).lean();
    } else {
      if (req.query.before) q.createdAt = { $lt: new Date(req.query.before) };
      rows = (await WhatsAppMessage.find(q).sort("-createdAt").limit(limit).lean()).reverse();
    }
    const messages = rows.map(({ mediaRaw, ...m }) => ({ ...m, hasMedia: !!mediaRaw }));
    res.json({ messages, serverTime, hasMore: !req.query.after && rows.length === limit });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

async function resolveJidForNumber(instanceId, number) {
  const prior = await WhatsAppMessage.findOne({ instanceId, number, jid: { $ne: "" } }).sort("-createdAt");
  if (prior?.jid) return prior.jid;
  if (String(number).startsWith("lid:")) return `${String(number).slice(4)}@lid`;
  return toWhatsAppJid(number);
}

// Profile photos are cached (6h, or 1h for "no photo") so opening the chat
// list doesn't fire hundreds of requests at WhatsApp every time.
const photoCache = new Map(); // `${instanceId}|${number}` → { url, at }
app.get("/api/admin/whatsapp/profile-photo/:instanceId/:number", protect, adminOnly, async (req, res) => {
  try {
    const { instanceId, number } = req.params;
    const cacheKey = `${instanceId}|${number}`;
    const cached = photoCache.get(cacheKey);
    if (cached && Date.now() - cached.at < (cached.url ? 6 : 1) * 60 * 60 * 1000) return res.json({ url: cached.url });
    const sock = activeSelfHostedSockets.get(instanceId);
    if (!sock) return res.status(404).json({ message: "This number isn't connected right now" });
    const jid = number === "me" ? sock.user?.id : await resolveJidForNumber(instanceId, number);
    if (!jid) return res.json({ url: null });
    let url = null;
    try { url = await sock.profilePictureUrl(jid, "image"); } catch { url = null; }
    photoCache.set(cacheKey, { url: url || null, at: Date.now() });
    res.json({ url: url || null });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.get("/api/admin/whatsapp/presence/:instanceId/:number", protect, adminOnly, async (req, res) => {
  try {
    const { instanceId, number } = req.params;
    const sock = activeSelfHostedSockets.get(instanceId);
    if (!sock) return res.status(404).json({ message: "This number isn't connected right now" });
    const jid = await resolveJidForNumber(instanceId, number);
    const presence = await new Promise((resolve) => {
      const timeout = setTimeout(() => { sock.ev.off("presence.update", handler); resolve(null); }, 4000);
      const handler = (update) => {
        if (update.id !== jid) return;
        clearTimeout(timeout);
        sock.ev.off("presence.update", handler);
        resolve(update.presences?.[jid] || Object.values(update.presences || {})[0] || null);
      };
      sock.ev.on("presence.update", handler);
      sock.presenceSubscribe(jid).catch(() => { clearTimeout(timeout); sock.ev.off("presence.update", handler); resolve(null); });
    });
    res.json({ presence });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.get("/api/admin/whatsapp/about/:instanceId/:number", protect, adminOnly, async (req, res) => {
  try {
    const { instanceId, number } = req.params;
    const sock = activeSelfHostedSockets.get(instanceId);
    if (!sock) return res.status(404).json({ message: "This number isn't connected right now" });
    const jid = await resolveJidForNumber(instanceId, number);
    try {
      const result = await sock.fetchStatus(jid);
      const row = Array.isArray(result) ? result[0]?.status : result; // newer Baileys returns an array
      res.json({ status: row?.status || "", setAt: row?.setAt || null });
    } catch {
      res.json({ status: "", setAt: null });
    }
  } catch (err) { res.status(500).json({ message: err.message }); }
});


// ══════════════════════════════════════════════════════════════════════════════
// NEW — CHAT FEATURES: unread, tags, clear, media, voice, polls, events,
// contacts, common groups, block / unblock
// ══════════════════════════════════════════════════════════════════════════════
const express = require("express");
const silentLogger = (() => { try { return require("pino")({ level: "silent" }); } catch { return undefined; } })();

let ffmpegPath = null;
try { ffmpegPath = require("ffmpeg-static"); } catch { /* optional */ }
if (!ffmpegPath) console.error("⚠️  ffmpeg-static not installed — voice messages recorded in Chrome may not play on phones. Run: npm install ffmpeg-static");

// WhatsApp voice notes must be OGG/Opus. Chrome records WebM → convert.
function toOggOpus(buf, mimetype) {
  if (/ogg/i.test(mimetype || "") || !ffmpegPath) return Promise.resolve(buf);
  return new Promise((resolve, reject) => {
    const { spawn } = require("child_process");
    const p = spawn(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vn", "-ac", "1", "-ar", "48000", "-c:a", "libopus", "-b:a", "32k", "-f", "ogg", "pipe:1"]);
    const chunks = [];
    let errText = "";
    p.stdout.on("data", (c) => chunks.push(c));
    p.stderr.on("data", (d) => { errText += d; });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 && chunks.length ? resolve(Buffer.concat(chunks)) : reject(new Error(`Voice conversion failed ${errText.slice(0, 200)}`))));
    p.stdin.on("error", () => {});
    p.stdin.end(buf);
  });
}

async function resolveSendTarget(session, to) {
  const raw = String(to || "").trim();
  const displayNumber = raw.startsWith("lid:") ? raw : normalizeWaNumber(raw);
  const prior = await WhatsAppMessage.findOne({ instanceId: session.sessionId, number: displayNumber, jid: { $ne: "" } }).sort("-createdAt");
  const jid = prior?.jid || (displayNumber.startsWith("lid:") ? `${displayNumber.slice(4)}@lid` : toWhatsAppJid(displayNumber));
  return { displayNumber, jid };
}

async function sendContentAndLog(session, to, content, logText) {
  const sock = activeSelfHostedSockets.get(session.sessionId);
  if (!sock) throw new Error("This number isn't connected right now");
  const { displayNumber, jid } = await resolveSendTarget(session, to);
  const sent = await sock.sendMessage(jid, content);
  learnLidForPn(session.sessionId, sock, jid).catch(() => {});
  await logWhatsAppMessage({
    instanceId: session.sessionId, direction: "outgoing", number: displayNumber, jid,
    message: logText, status: "sent", source: "manual", waMessageId: sent?.key?.id || "",
    ...(sent?.message ? describeMessage(sent) : {}),
  });
  await setUnread(session.sessionId, displayNumber, 0);
  return sent;
}

async function findSession(sessionDocId) {
  if (!sessionDocId || !mongoose.isValidObjectId(sessionDocId)) return null;
  return WhatsAppSelfSession.findById(sessionDocId);
}

// Mark a chat as read (dashboard + blue ticks on WhatsApp)
app.post("/api/admin/whatsapp/conversations/:instanceId/:number/read", protect, adminOnly, async (req, res) => {
  try {
    const { instanceId, number } = req.params;
    const state = await WhatsAppChatState.findOne({ instanceId, number }).lean();
    const unread = state?.unreadCount || 0;
    if (unread > 0) {
      await setUnread(instanceId, number, 0);
      const sock = activeSelfHostedSockets.get(instanceId);
      if (sock) {
        const rows = await WhatsAppMessage.find({ instanceId, number, direction: "incoming", waMessageId: { $gt: "" }, jid: { $gt: "" } })
          .sort("-createdAt").limit(Math.min(unread, 50)).lean();
        const keys = rows.map((m) => ({ remoteJid: m.jid, id: m.waMessageId, fromMe: false }));
        if (keys.length) sock.readMessages(keys).catch(() => {});
      }
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Tags for a chat
app.post("/api/admin/whatsapp/conversations/:instanceId/:number/tags", protect, adminOnly, async (req, res) => {
  try {
    const { instanceId, number } = req.params;
    const tags = [...new Set((Array.isArray(req.body?.tags) ? req.body.tags : []).map((t) => String(t).trim()).filter(Boolean))].slice(0, 20);
    await WhatsAppChatState.updateOne({ instanceId, number }, { $set: { tags } }, { upsert: true });
    res.json({ tags });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Clear chat (removes this chat's messages from the dashboard)
app.delete("/api/admin/whatsapp/conversations/:instanceId/:number/messages", protect, adminOnly, async (req, res) => {
  try {
    const { instanceId, number } = req.params;
    const result = await WhatsAppMessage.deleteMany({ instanceId, number });
    await setUnread(instanceId, number, 0);
    res.json({ deletedCount: result.deletedCount });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Saved contacts (for "Share contact")
app.get("/api/admin/whatsapp/contacts/:instanceId", protect, adminOnly, async (req, res) => {
  try {
    const contacts = await WhatsAppContact.find({ instanceId: req.params.instanceId, name: { $gt: "" }, number: { $not: /^lid:/ } })
      .select("number name").sort("name").limit(5000).lean();
    res.json(contacts.map((c) => ({ number: c.number, name: c.name })));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Download / stream a media message (image, video, voice, document)
const mediaCache = new Map(); // messageId → Buffer (small in-memory cache)
let mediaCacheBytes = 0;
const MEDIA_CACHE_MAX = 60 * 1024 * 1024;
app.get("/api/admin/whatsapp/media/:id", protect, adminOnly, requireBaileys, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: "Invalid id" });
    const row = await WhatsAppMessage.findById(req.params.id).lean();
    if (!row?.mediaRaw) return res.status(404).json({ message: "This media isn't available (it was imported before media support was added)." });
    let buf = mediaCache.get(String(row._id));
    if (!buf) {
      const sock = activeSelfHostedSockets.get(row.instanceId);
      const message = Baileys.proto.Message.fromObject(JSON.parse(row.mediaRaw));
      const waMsg = { key: { remoteJid: row.jid, id: row.waMessageId, fromMe: row.direction === "outgoing" }, message };
      buf = await Baileys.downloadMediaMessage(waMsg, "buffer", {}, sock ? { logger: silentLogger, reuploadRequest: sock.updateMediaMessage } : undefined);
      if (buf.length < 20 * 1024 * 1024) {
        mediaCache.set(String(row._id), buf);
        mediaCacheBytes += buf.length;
        for (const [k, v] of mediaCache) {
          if (mediaCacheBytes <= MEDIA_CACHE_MAX) break;
          mediaCache.delete(k);
          mediaCacheBytes -= v.length;
        }
      }
    }
    const type = (row.mimetype || "application/octet-stream").split(";")[0].trim();
    const name = row.fileName || `whatsapp-${row.waMessageId || row._id}`;
    res.set({
      "Content-Type": type,
      "Content-Length": buf.length,
      "Cache-Control": "private, max-age=86400",
      "Content-Disposition": `${req.query.download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(name)}`,
    });
    res.send(buf);
  } catch (err) {
    res.status(500).json({ message: "Couldn't download this media from WhatsApp — it may no longer be available on the phone." });
  }
});

// Send an image / video / document / audio file / voice note.
// Body = the raw file (Content-Type: application/octet-stream); details go in the query string.
app.post(
  "/api/admin/whatsapp-server/send-media",
  protect, adminOnly, requireBaileys,
  express.raw({ type: "application/octet-stream", limit: "64mb" }),
  async (req, res) => {
    try {
      const { sessionDocId, to, kind, fileName = "", mimetype = "", caption = "", seconds } = req.query;
      const buf = req.body;
      if (!Buffer.isBuffer(buf) || buf.length === 0) return res.status(400).json({ message: "No file received" });
      if (!to) return res.status(400).json({ message: "A number is required" });
      const session = await findSession(sessionDocId);
      if (!session) return res.status(404).json({ message: "Session not found" });

      let content;
      let logText;
      if (kind === "voice") {
        const ogg = await toOggOpus(buf, mimetype);
        content = { audio: ogg, mimetype: "audio/ogg; codecs=opus", ptt: true, ...(Number(seconds) > 0 ? { seconds: Math.round(Number(seconds)) } : {}) };
        logText = "🎤 Voice message";
      } else if (kind === "image") {
        content = { image: buf, caption: caption || undefined, ...(mimetype ? { mimetype } : {}) };
        logText = caption || "📷 Photo";
      } else if (kind === "video") {
        content = { video: buf, caption: caption || undefined, mimetype: mimetype || "video/mp4" };
        logText = caption || "🎥 Video";
      } else if (kind === "audio") {
        content = { audio: buf, mimetype: mimetype || "audio/mpeg" };
        logText = "🎵 Audio";
      } else {
        content = { document: buf, mimetype: mimetype || "application/octet-stream", fileName: fileName || "file", caption: caption || undefined };
        logText = caption || `📄 ${fileName || "Document"}`;
      }
      await sendContentAndLog(session, to, content, logText);
      res.json({ sent: true });
    } catch (err) { res.status(500).json({ message: err.message }); }
  }
);

// Send a poll, an event or a contact card
app.post("/api/admin/whatsapp-server/send-special", protect, adminOnly, requireBaileys, async (req, res) => {
  try {
    const { sessionDocId, to, kind, payload = {} } = req.body || {};
    if (!to) return res.status(400).json({ message: "A number is required" });
    const session = await findSession(sessionDocId);
    if (!session) return res.status(404).json({ message: "Session not found" });

    if (kind === "poll") {
      const name = String(payload.name || "").trim();
      const values = [...new Set((payload.options || []).map((o) => String(o).trim()).filter(Boolean))];
      if (!name || values.length < 2) return res.status(400).json({ message: "A poll needs a question and at least 2 options" });
      if (values.length > 12) return res.status(400).json({ message: "A poll can have at most 12 options" });
      await sendContentAndLog(session, to, { poll: { name, values, selectableCount: payload.multiple ? 0 : 1 } }, `📊 ${name}`);
      return res.json({ sent: true });
    }

    if (kind === "event") {
      const name = String(payload.name || "").trim();
      const start = payload.startTime ? new Date(payload.startTime) : null;
      if (!name || !start || isNaN(start)) return res.status(400).json({ message: "An event needs a name and a start date/time" });
      const end = payload.endTime ? new Date(payload.endTime) : null;
      const event = {
        name,
        description: String(payload.description || "").trim() || undefined,
        startDate: start,
        ...(end && !isNaN(end) ? { endDate: end } : {}),
        ...(payload.location ? { location: { name: String(payload.location).trim() } } : {}),
        isCancelled: false,
        extraGuestsAllowed: false,
      };
      try {
        await sendContentAndLog(session, to, { event }, `📅 ${name}`);
        return res.json({ sent: true });
      } catch (err) {
        // Older Baileys versions can't send native events → send it as a formatted message instead
        const lines = [`📅 *${name}*`, start.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })];
        if (end && !isNaN(end)) lines[1] += ` – ${end.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}`;
        if (payload.location) lines.push(`📍 ${payload.location}`);
        if (payload.description) lines.push("", String(payload.description));
        await sendContentAndLog(session, to, { text: lines.join("\n") }, lines.join("\n"));
        return res.json({ sent: true, fallback: true, reason: err.message });
      }
    }

    if (kind === "contact") {
      const list = (payload.contacts || [])
        .map((c) => ({ name: String(c.name || "").trim(), number: normalizeWaNumber(c.number || "") }))
        .filter((c) => c.number);
      if (list.length === 0) return res.status(400).json({ message: "Pick at least one contact" });
      const vcards = list.map((c) => ({
        vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:${c.name || "+" + c.number}\nTEL;type=CELL;type=VOICE;waid=${c.number}:+${c.number}\nEND:VCARD`,
      }));
      const displayName = list.length === 1 ? (list[0].name || `+${list[0].number}`) : `${list.length} contacts`;
      await sendContentAndLog(session, to, { contacts: { displayName, contacts: vcards } }, `👤 ${displayName}`);
      return res.json({ sent: true });
    }

    res.status(400).json({ message: "Unknown message type" });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// All identifiers (phone JID + known LIDs) for a chat number
async function identifiersFor(instanceId, number) {
  const ids = new Set();
  if (String(number).startsWith("lid:")) ids.add(`${String(number).slice(4)}@lid`);
  else {
    ids.add(`${number}@s.whatsapp.net`);
    const maps = await WhatsAppLidMap.find({ instanceId, pn: number }).lean();
    for (const m of maps) ids.add(jidNorm(m.lid));
  }
  return ids;
}

// Groups you and this contact are both in
const groupCache = new Map(); // instanceId → { at, groups }
app.get("/api/admin/whatsapp/common-groups/:instanceId/:number", protect, adminOnly, async (req, res) => {
  try {
    const { instanceId, number } = req.params;
    const sock = activeSelfHostedSockets.get(instanceId);
    if (!sock) return res.json({ groups: [] });
    let cached = groupCache.get(instanceId);
    if (!cached || Date.now() - cached.at > 10 * 60 * 1000) {
      const all = await sock.groupFetchAllParticipating().catch(() => ({}));
      cached = { at: Date.now(), groups: Object.values(all || {}) };
      groupCache.set(instanceId, cached);
    }
    const targets = await identifiersFor(instanceId, number);
    const groups = cached.groups
      .filter((g) => (g.participants || []).some((p) => [p.id, p.jid, p.phoneNumber, p.lid].map(jidNorm).some((j) => j && targets.has(j))))
      .map((g) => ({ id: g.id, subject: g.subject || "Group", size: (g.participants || []).length }));
    res.json({ groups });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Block / unblock
const blockCache = new Map(); // instanceId → { at, list:Set }
async function getBlocklist(instanceId, sock) {
  const cached = blockCache.get(instanceId);
  if (cached && Date.now() - cached.at < 60 * 1000) return cached.list;
  const raw = await sock.fetchBlocklist().catch(() => []);
  const list = new Set((raw || []).map((x) => jidNorm(typeof x === "string" ? x : x?.jid || x?.id)).filter(Boolean));
  blockCache.set(instanceId, { at: Date.now(), list });
  return list;
}
app.get("/api/admin/whatsapp/block-status/:instanceId/:number", protect, adminOnly, async (req, res) => {
  try {
    const { instanceId, number } = req.params;
    const sock = activeSelfHostedSockets.get(instanceId);
    if (!sock) return res.json({ blocked: false });
    const list = await getBlocklist(instanceId, sock);
    const targets = await identifiersFor(instanceId, number);
    res.json({ blocked: [...targets].some((t) => list.has(t)) });
  } catch (err) { res.status(500).json({ message: err.message }); }
});
app.post("/api/admin/whatsapp/block/:instanceId/:number", protect, adminOnly, async (req, res) => {
  try {
    const { instanceId, number } = req.params;
    const sock = activeSelfHostedSockets.get(instanceId);
    if (!sock) return res.status(404).json({ message: "This number isn't connected right now" });
    const jid = String(number).startsWith("lid:") ? `${String(number).slice(4)}@lid` : `${normalizeWaNumber(number)}@s.whatsapp.net`;
    await sock.updateBlockStatus(jid, req.body?.block ? "block" : "unblock");
    blockCache.delete(instanceId);
    res.json({ blocked: !!req.body?.block });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Keep-awake ping (stops Render's free plan from sleeping) ────────────────
// Render sets RENDER_EXTERNAL_URL automatically. Set WHATSAPP_KEEPALIVE_URL
// yourself (e.g. https://your-backend.onrender.com) if you host elsewhere.
app.get("/api/whatsapp-server/ping", (req, res) => res.json({ ok: true, at: Date.now() }));
const keepAliveBase = (process.env.WHATSAPP_KEEPALIVE_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, "");
if (keepAliveBase) {
  setInterval(() => {
    fetch(`${keepAliveBase}/api/whatsapp-server/ping`).catch(() => {});
  }, 10 * 60 * 1000);
  console.log(`[Self-hosted WhatsApp] keep-awake ping enabled → ${keepAliveBase}/api/whatsapp-server/ping every 10 min`);
}

  return {
    WhatsAppMessage,
    WhatsAppSelfSession,
    WhatsAppContact,
    sendSelfHostedMessage,
    logWhatsAppMessage,
    normalizeWaNumber,
    toWhatsAppJid,
    whatsappConfigured,
    sendWhatsAppRaw,
    startAllSelfHostedSessions,
  };
};