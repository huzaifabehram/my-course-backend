// whatsapp.js
// ══════════════════════════════════════════════════════════════════════════════
// SELF-HOSTED WHATSAPP SERVER + META CLOUD API FALLBACK
// ══════════════════════════════════════════════════════════════════════════════
// All WhatsApp-related backend code for Super Admin → WhatsApp, pulled out of
// server.js into its own file — server.js and SuperAdminsDashboard.jsx had
// grown large enough to be unreliable to keep editing directly.
//
// HOW TO WIRE THIS INTO server.js:
//
// 1. Near the top of server.js, after `const app = express();` and after
//    `mongoose`, `SiteSettings`, and `getSiteSettings` are defined, add:
//
//      const setupWhatsApp = require("./whatsapp");
//      const whatsapp = setupWhatsApp(app, { mongoose, protect, adminOnly, getSiteSettings, SiteSettings, crypto });
//
//    This one call registers every WhatsApp route directly on `app` — no
//    further app.use() needed. `crypto` is Node's built-in module
//    (`const crypto = require("crypto");` — server.js almost certainly
//    already requires this; add it near the top if it doesn't yet).
//
//    NOTE: `protect` and `adminOnly` (the auth middleware) and
//    `getSiteSettings`/`SiteSettings` (site settings) must be defined
//    BEFORE this call — place the setupWhatsApp() call after all of those
//    exist, not at the very top of the file.
//
// 2. In the `mongoose.connection.once("open", ...)` startup block, replace
//
//      await startAllSelfHostedSessions();
//
//    with:
//
//      await whatsapp.startAllSelfHostedSessions();
//
// 3. In the Automation Workflow engine's `runAction` function, the
//    `case "send_whatsapp":` block references several things that now live
//    in this module. Replace these identifiers in that one case block:
//      WhatsAppSelfSession        → whatsapp.WhatsAppSelfSession
//      sendSelfHostedMessage(...) → whatsapp.sendSelfHostedMessage(...)
//      logWhatsAppMessage(...)    → whatsapp.logWhatsAppMessage(...)
//      normalizeWaNumber(...)     → whatsapp.normalizeWaNumber(...)
//      whatsappConfigured()       → whatsapp.whatsappConfigured()
//      sendWhatsAppRaw(...)       → whatsapp.sendWhatsAppRaw(...)
//
// 4. Remove from server.js (now living here instead):
//      - `let Baileys = null; try { ... } catch { ... }` near the top
//      - Everything from `const WhatsAppMessageSchema = ...` through the
//        end of `buildBotHistory(...)` (the self-hosted server + AI bot core)
//      - `getWhatsAppCredentials`, `whatsappConfigured`, `sendWhatsAppRaw`
//        (the Meta Cloud API fallback functions)
//      - Every `app.get/post/delete("/api/admin/whatsapp...")`,
//        `/api/admin/settings/whatsapp...`, `/api/admin/settings/openai...`,
//        and `/api/whatsapp-server/external/send` route
//      - The standalone `startAllSelfHostedSessions` function and
//        `function requireBaileys(...)` (both now internal to this file)
//    Leave everything else untouched — ContactSubmission, PackageInquiry,
//    Form, Tag, NewsletterSubscriber, PaymentScreenshotHash, and the auth
//    middleware (protect/adminOnly/etc.) all stay in server.js exactly
//    where they are; this file does not touch them.
//
// Needs `@whiskeysockets/baileys` installed (npm install @whiskeysockets/baileys)
// — if it isn't, every self-hosted route returns a clear 503 instead of
// crashing the server, same safety net as before.

let Baileys = null;
try {
  Baileys = require("@whiskeysockets/baileys");
} catch (err) {
  console.error("⚠️  @whiskeysockets/baileys not installed — self-hosted WhatsApp server disabled. Run: npm install @whiskeysockets/baileys");
}

module.exports = function setupWhatsApp(app, deps) {
  const { mongoose, protect, adminOnly, getSiteSettings, SiteSettings, crypto } = deps;

const WhatsAppMessageSchema = new mongoose.Schema({
  instanceId: { type: String, required: true },
  direction:  { type: String, enum: ["outgoing", "incoming"], required: true },
  number:     { type: String, default: "" }, // the other party's number — recipient for outgoing, sender for incoming
  groupId:    { type: String, default: "" }, // set instead of number for group messages
  message:    { type: String, default: "" },
  status:     { type: String, enum: ["sent", "failed", "received"], default: "sent" },
  source:     { type: String, default: "" }, // "workflow" | "manual" | "webhook" | "history_sync"
  // NEW: Baileys' own message ID (msg.key.id) — lets history-sync avoid
  // re-importing a message that's already been logged (live, or from an
  // earlier sync), and matches WhatsApp's own de-duplication.
  waMessageId: { type: String, default: "" },
  // NEW: the exact WhatsApp identifier this message came from/went to —
  // either a real phone-number JID (...@s.whatsapp.net) or, for contacts
  // WhatsApp has moved to its newer privacy-ID system, a "LID"
  // (...@lid, an internal ID that looks like a random number). Replies
  // use this exact value rather than reconstructing one from `number`,
  // so a reply always reaches the same identifier the message came from —
  // this is what fixes sending failing on chats that started as an
  // incoming LID-based message.
  jid: { type: String, default: "" },
}, { timestamps: true });
const WhatsAppMessage = mongoose.model("WhatsAppMessage", WhatsAppMessageSchema);

async function logWhatsAppMessage(fields) {
  try { await WhatsAppMessage.create(fields); }
  catch (err) { console.error("[WhatsApp] failed to log message:", err.message); }
}

// ── AI Bot — auto-responds to incoming WhatsApp messages ────────────────────
// One shared configuration: "instructions" is what Super Admin → WhatsApp →
// AI Bot calls "training" — a system prompt describing your business, tone,
// what it should/shouldn't say, and when to hand off to a human instead of
// answering. enabledInstanceIds is an explicit opt-in list — the bot never
// auto-replies on a number unless you've turned it on for that number
// specifically, so connecting a new number never silently starts
// auto-responding on your behalf.
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
// SELF-HOSTED WHATSAPP SERVER — Super Admin → WhatsApp → Self-Hosted Server
// ══════════════════════════════════════════════════════════════════════════════
// A real WhatsApp Web connection built directly into this backend with
// Baileys, instead of depending on WaBulkify. Session credentials are
// stored in MongoDB (not local disk) specifically because Render wipes the
// filesystem on every redeploy — storing them in Mongo means a connected
// number survives a redeploy without needing to rescan its QR code.

const WhatsAppSelfSessionSchema = new mongoose.Schema({
  label:       { type: String, required: true, trim: true },
  sessionId:   { type: String, required: true, unique: true }, // our own generated ID — not a WaBulkify instance_id
  authState:   { type: String, default: "" }, // JSON-serialized Baileys creds+keys (via Baileys' own BufferJSON codec)
  status:      { type: String, enum: ["pending_qr", "connected", "disconnected"], default: "pending_qr" },
  phoneNumber: { type: String, default: "" },
  lastQr:      { type: String, default: "" }, // raw QR data string — rendered as an image client-side, not here
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

// A contact's saved name, synced from WhatsApp's own contacts.upsert/
// contacts.update events — this is what lets a chat show "Ali Khan"
// instead of a bare number, matching WhatsApp's own behavior: a name
// shows when that number is saved (in your phone's contacts, synced onto
// the account), and just the number shows when it isn't.
const WhatsAppContactSchema = new mongoose.Schema({
  instanceId: { type: String, required: true },
  jid:        { type: String, required: true },
  name:       { type: String, default: "" },
}, { timestamps: true });
WhatsAppContactSchema.index({ instanceId: 1, jid: 1 }, { unique: true });
const WhatsAppContact = mongoose.model("WhatsAppContact", WhatsAppContactSchema);

async function upsertWhatsAppContact(instanceId, jid, name) {
  if (!jid || !name) return;
  try {
    await WhatsAppContact.findOneAndUpdate({ instanceId, jid }, { name }, { upsert: true });
  } catch (err) { console.error("[Self-hosted WhatsApp] contact save failed:", err.message); }
}

// Live socket connections, keyed by our sessionId — this is in-memory, so it
// starts empty on every server restart; startAllSelfHostedSessions() below
// reconnects every previously-connected session automatically using its
// saved Mongo credentials (no QR rescan needed) once the server boots back
// up and the DB connection opens.
const activeSelfHostedSockets = new Map();

// Custom Baileys auth-state adapter backed by MongoDB instead of Baileys'
// default local-file storage (useMultiFileAuthState) — the whole point of
// this being different from the standard example is Render's ephemeral
// disk. Stores the entire creds+keys blob as one JSON field, rewritten in
// full on every change; simpler than a fully granular per-key store, and
// fine at the message volumes this is actually built for.
async function useMongoAuthState(sessionDoc) {
  const { BufferJSON, initAuthCreds } = Baileys;
  let stored = {};
  if (sessionDoc.authState) {
    try { stored = JSON.parse(sessionDoc.authState, BufferJSON.reviver); } catch { stored = {}; }
  }
  const creds = stored.creds || initAuthCreds();
  const keys = stored.keys || {};

  const saveState = async () => {
    const serialized = JSON.stringify({ creds, keys }, BufferJSON.replacer);
    await WhatsAppSelfSession.findByIdAndUpdate(sessionDoc._id, { authState: serialized });
  };

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const result = {};
          for (const id of ids) {
            const value = keys[type]?.[id];
            if (value !== undefined) result[id] = value;
          }
          return result;
        },
        set: async (data) => {
          for (const type in data) {
            keys[type] = keys[type] || {};
            for (const id in data[type]) {
              if (data[type][id] === null || data[type][id] === undefined) delete keys[type][id];
              else keys[type][id] = data[type][id];
            }
          }
          await saveState();
        },
      },
    },
    saveCreds: saveState,
  };
}

// Shared by the live incoming-message handler and the history-sync import
// below, so both always extract text the exact same way — broadened past
// just plain text/quoted-reply text, since real messages commonly arrive
// wrapped differently (an image/video caption, a button or list reply,
// disappearing-message mode, etc.).
function extractMessageText(msg) {
  let m = msg.message;
  if (!m) return "";
  if (m.ephemeralMessage) m = m.ephemeralMessage.message;
  if (m.viewOnceMessage) m = m.viewOnceMessage.message;
  if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message;
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    m.templateButtonReplyMessage?.selectedDisplayText ||
    ""
  );
}

// NEW: WhatsApp/Baileys' internal protocol traffic — message deletions,
// ephemeral-timer changes, app-state sync keys, and similar — rides on the
// exact same event stream as real messages, but isn't a real message at
// all. This was showing up as literal "[protocolMessage]" bubbles in the
// chat view, which is genuinely confusing since it isn't something anyone
// actually sent. These are filtered out entirely now — not logged, not
// shown as a placeholder — in both the live handler and history import.
function isSystemMessageType(msg) {
  const type = Object.keys(msg.message || {})[0] || "";
  return ["protocolMessage", "senderKeyDistributionMessage", "messageContextInfo", "reactionMessage", "pollUpdateMessage"].includes(type);
}

async function startSelfHostedSession(sessionDoc) {
  if (!Baileys) throw new Error("Baileys isn't installed on the server yet");
  const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState } = Baileys;
  // TEMPORARY DIAGNOSTIC CHANGE: three targeted fixes in a row (session
  // staleness, syncFullHistory) didn't resolve total connection failure,
  // even on a genuinely fresh QR scan — so instead of guessing at another
  // specific setting, this eliminates the biggest single source of
  // uncertainty: the custom Mongo-backed session storage (useMongoAuthState
  // above), replaced here with Baileys' own official, battle-tested
  // useMultiFileAuthState. The real tradeoff: this writes to local disk,
  // which Render wipes on every redeploy — so every number will need a
  // fresh QR scan after each deploy again, same as before persistence was
  // added. That's a real downside during active back-and-forth deploys,
  // but a connection that works and needs rescanning sometimes is far
  // better than one that never works at all. If this fixes it, the bug was
  // in the custom Mongo adapter and that can be revisited properly once
  // everything else is confirmed solid; if it does NOT fix it, that's
  // equally valuable — it rules out the adapter and points at something
  // else (Render networking/resources) instead of more guessing.
  const sessionFolder = `/tmp/wa-sessions/${sessionDoc.sessionId}`;
  const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
  const { version } = await fetchLatestBaileysVersion();
  const pino = require("pino"); // installed transitively as a Baileys dependency
  // keepAliveIntervalMs tightened from Baileys' default — sends a ping
  // more frequently to help the connection survive longer without an
  // intervening idle-timeout.
  //
  // syncFullHistory: back on, one more genuinely different attempt rather
  // than repeating what already failed twice. New theory: a full history
  // for an account with a lot of chat history could spike memory usage
  // high enough that Render's infrastructure kills the whole process
  // outright — which looks exactly like a sudden disconnect, but is a
  // different failure than the slow-writes theory the batching fix
  // targeted last time. The history handler below now processes in small
  // paced chunks with memory logging around it instead of one giant batch,
  // which is what actually addresses a memory-spike cause specifically.
  const sock = makeWASocket({ version, auth: state, printQRInTerminal: false, keepAliveIntervalMs: 15000, syncFullHistory: true, logger: pino({ level: "silent" }) });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log(`[Self-hosted WhatsApp] "${sessionDoc.label}" — new QR issued`);
      await WhatsAppSelfSession.findByIdAndUpdate(sessionDoc._id, { lastQr: qr, status: "pending_qr" });
    }
    if (connection === "open") {
      const phoneNumber = sock.user?.id ? sock.user.id.split(":")[0] : "";
      console.log(`[Self-hosted WhatsApp] "${sessionDoc.label}" — connected (${phoneNumber})`);
      await WhatsAppSelfSession.findByIdAndUpdate(sessionDoc._id, { status: "connected", phoneNumber, lastQr: "" });
    }
    if (connection === "close") {
      activeSelfHostedSockets.delete(sessionDoc.sessionId);
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      // NEW: this is the log line that actually explains what's happening
      // on every redeploy — WHY it disconnected (statusCode 401 = logged
      // out for real, 428/440 = connection replaced by another session
      // using the same credentials, 515 = normal restart-required close,
      // etc.), so a repeated pattern here (rather than one clean
      // reconnect) is visible instead of silent.
      console.log(`[Self-hosted WhatsApp] "${sessionDoc.label}" — disconnected. statusCode=${statusCode}, loggedOut=${loggedOut}, reason=${lastDisconnect?.error?.message || "unknown"}`);
      await WhatsAppSelfSession.findByIdAndUpdate(sessionDoc._id, { status: "disconnected" });
      if (!loggedOut) {
        // Real disconnect (not an explicit logout) — try again shortly using
        // the same saved credentials.
        console.log(`[Self-hosted WhatsApp] "${sessionDoc.label}" — will attempt reconnect in 5s`);
        setTimeout(() => {
          WhatsAppSelfSession.findById(sessionDoc._id).then((fresh) => { if (fresh) startSelfHostedSession(fresh).catch((err) => console.error("[Self-hosted WhatsApp] reconnect failed:", err.message)); });
        }, 5000);
      } else {
        console.log(`[Self-hosted WhatsApp] "${sessionDoc.label}" — logged out for real (401); this needs a fresh QR scan, not a reconnect.`);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    console.log(`[Self-hosted WhatsApp] messages.upsert fired for "${sessionDoc.label}" — type=${type}, count=${messages.length}`);
    if (type !== "notify") return;
    for (const msg of messages) {
      try {
        if (!msg.message) continue;
        if (msg.key.remoteJid?.endsWith("@g.us")) continue; // skip group messages for the AI bot/logging path here
        if (isSystemMessageType(msg)) continue; // protocol traffic, not a real message — see isSystemMessageType above

        const { jid, displayNumber } = await resolveMessageIdentity(msg.key, sock);
        if (!jid) continue;
        const text = extractMessageText(msg);
        const messageType = Object.keys(msg.message)[0] || "unknown";
        const messageBody = text || `[${messageType}]`;

        if (msg.key.fromMe) {
          // NEW: this used to be unconditionally skipped, on the assumption
          // that every outgoing message was one the dashboard itself just
          // sent and already logged directly. That's wrong for anything
          // sent from the connected PHONE (or any other linked device) —
          // WhatsApp's multi-device sync reports those here too, and they
          // were being silently dropped entirely, which is why messages
          // sent from the phone never showed up in the dashboard. The
          // waMessageId check below is what avoids double-logging a
          // message the dashboard really did send (it's already saved by
          // the /send route itself, with the same ID, by the time this
          // event usually arrives).
          if (msg.key.id) {
            const already = await WhatsAppMessage.findOne({ waMessageId: msg.key.id });
            if (already) continue;
          }
          await logWhatsAppMessage({ instanceId: sessionDoc.sessionId, direction: "outgoing", number: displayNumber, jid, message: messageBody, status: "sent", source: "mobile_app", waMessageId: msg.key.id || "" });
          continue;
        }

        if (!text) {
          // Still log something rather than silently dropping it — an
          // unsupported message type (a sticker, a location pin, a poll
          // vote, etc.) shows up in the thread as this placeholder instead
          // of just vanishing.
          await logWhatsAppMessage({ instanceId: sessionDoc.sessionId, direction: "incoming", number: displayNumber, jid, message: messageBody, status: "received", source: "self_hosted", waMessageId: msg.key.id || "" });
          continue;
        }

        await logWhatsAppMessage({ instanceId: sessionDoc.sessionId, direction: "incoming", number: displayNumber, jid, message: text, status: "received", source: "self_hosted", waMessageId: msg.key.id || "" });

        const botSettings = await getBotSettings();
        if (botSettings.enabled && botSettings.enabledInstanceIds.includes(sessionDoc.sessionId)) {
          const history = await buildBotHistory(sessionDoc.sessionId, displayNumber, text);
          const reply = await callOpenAI({ systemPrompt: botSettings.instructions, history, model: botSettings.model });
          if (reply) {
            const replyId = await sock.sendMessage(jid, { text: reply });
            await logWhatsAppMessage({ instanceId: sessionDoc.sessionId, direction: "outgoing", number: displayNumber, jid, message: reply, status: "sent", source: "ai_bot", waMessageId: replyId?.key?.id || "" });
          }
        }
      } catch (err) { console.error("[Self-hosted WhatsApp] incoming message handling failed:", err.message); }
    }
  });

  // NEW: imports WhatsApp's own message history — this is what makes prior
  // conversations (that existed before this number connected here) show up
  // instead of the thread starting empty. Baileys fires this on initial
  // connect with whatever history WhatsApp's servers hand over now that
  // syncFullHistory is enabled again. waMessageId is used to avoid
  // importing the same message twice across multiple syncs/reconnects.
  // contacts arrives in this same event too — saved contact names, so
  // chats can show "Ali Khan" instead of a bare number wherever WhatsApp
  // itself would.
  sock.ev.on("messaging-history.set", async ({ messages, contacts, isLatest }) => {
    const memMB = (process.memoryUsage().rss / 1024 / 1024).toFixed(0);
    console.log(`[Self-hosted WhatsApp] history sync for "${sessionDoc.label}" — ${messages.length} message(s), ${contacts?.length || 0} contact(s), isLatest=${isLatest}, memory=${memMB}MB`);

    if (contacts?.length > 0) {
      const ops = [];
      for (const c of contacts) {
        const name = c.name || c.notify || c.verifiedName || "";
        if (!c.id || !name) continue;
        // NEW: resolves the contact's id through the same LID-mapping logic
        // as messages — a contact synced under a LID needs to end up keyed
        // by the same resolved identifier a message from that same person
        // gets stored under, or the name lookup silently never matches.
        const { jid: resolvedJid } = await resolveMessageIdentity({ remoteJid: c.id }, sock);
        if (!resolvedJid) continue;
        ops.push({ updateOne: { filter: { instanceId: sessionDoc.sessionId, jid: resolvedJid }, update: { $set: { name } }, upsert: true } });
      }
      if (ops.length > 0) {
        try { await WhatsAppContact.bulkWrite(ops, { ordered: false }); }
        catch (err) { console.error("[Self-hosted WhatsApp] bulk contact save failed:", err.message); }
      }
    }

    const candidates = [];
    for (const msg of messages) {
      if (!msg.message || !msg.key?.remoteJid) continue;
      if (msg.key.remoteJid.endsWith("@g.us")) continue; // groups skipped here too, same as the live handler
      if (isSystemMessageType(msg)) continue; // protocol traffic, not a real message
      const text = extractMessageText(msg);
      if (!text) continue; // history items with no plain text are skipped rather than filling the thread with placeholders
      const { jid, displayNumber } = await resolveMessageIdentity(msg.key, sock);
      if (!jid) continue;
      const direction = msg.key.fromMe ? "outgoing" : "incoming";
      candidates.push({
        instanceId: sessionDoc.sessionId, direction, number: displayNumber, jid, message: text,
        status: direction === "outgoing" ? "sent" : "received", source: "history_sync",
        waMessageId: msg.key.id || "",
        createdAt: msg.messageTimestamp ? new Date(Number(msg.messageTimestamp) * 1000) : new Date(),
      });
    }
    if (candidates.length === 0) return;

    // NEW: processed in small paced chunks instead of one giant batch —
    // if a memory spike from handling everything at once is what's
    // actually killing the process (Render's infrastructure force-killing
    // it looks identical to a sudden disconnect, unlike a normal Baileys-
    // reported one), spreading the work out over time with pauses between
    // chunks keeps peak memory far lower than doing it all in one go. The
    // memory logging here is what will confirm whether this was actually
    // the mechanism, if this needs to be looked at again.
    const CHUNK_SIZE = 200;
    let totalInserted = 0;
    for (let i = 0; i < candidates.length; i += CHUNK_SIZE) {
      const chunk = candidates.slice(i, i + CHUNK_SIZE);
      try {
        const ids = chunk.map((c) => c.waMessageId).filter(Boolean);
        const existing = ids.length > 0 ? await WhatsAppMessage.find({ waMessageId: { $in: ids } }).select("waMessageId") : [];
        const existingIds = new Set(existing.map((e) => e.waMessageId));
        const toInsert = chunk.filter((c) => !c.waMessageId || !existingIds.has(c.waMessageId));
        if (toInsert.length > 0) await WhatsAppMessage.insertMany(toInsert, { ordered: false });
        totalInserted += toInsert.length;
      } catch (err) { console.error("[Self-hosted WhatsApp] history chunk import error:", err.message); }
      if (i + CHUNK_SIZE < candidates.length) await new Promise((r) => setTimeout(r, 300)); // brief pause between chunks
    }
    const memAfterMB = (process.memoryUsage().rss / 1024 / 1024).toFixed(0);
    console.log(`[Self-hosted WhatsApp] history sync for "${sessionDoc.label}" — imported ${totalInserted} new message(s), memory now=${memAfterMB}MB`);
  });

  // Ongoing contact-name updates — someone getting newly saved in your
  // phone's contacts, or changing their WhatsApp display name, after the
  // initial history sync already ran.
  sock.ev.on("contacts.upsert", async (contacts) => {
    for (const contact of contacts || []) {
      const name = contact.name || contact.notify || contact.verifiedName || "";
      if (!contact.id || !name) continue;
      const { jid: resolvedJid } = await resolveMessageIdentity({ remoteJid: contact.id }, sock);
      if (resolvedJid) await upsertWhatsAppContact(sessionDoc.sessionId, resolvedJid, name);
    }
  });
  sock.ev.on("contacts.update", async (contacts) => {
    for (const contact of contacts || []) {
      const name = contact.name || contact.notify || contact.verifiedName || "";
      if (!contact.id || !name) continue;
      const { jid: resolvedJid } = await resolveMessageIdentity({ remoteJid: contact.id }, sock);
      if (resolvedJid) await upsertWhatsAppContact(sessionDoc.sessionId, resolvedJid, name);
    }
  });

  activeSelfHostedSockets.set(sessionDoc.sessionId, sock);
  return sock;
}

// Reconnects every session that was connected (or briefly disconnected)
// before the last server restart — called once when the DB connection
// opens. pending_qr sessions are left alone; those need an explicit "Show
// QR" click since they never finished authenticating in the first place.
async function startAllSelfHostedSessions() {
  if (!Baileys) { console.log("[Self-hosted WhatsApp] Baileys not installed — skipping startup reconnect"); return; }
  try {
    const sessions = await WhatsAppSelfSession.find({ status: { $in: ["connected", "disconnected"] } });
    console.log(`[Self-hosted WhatsApp] startup — found ${sessions.length} session(s) to reconnect: ${sessions.map((s) => s.label).join(", ") || "(none)"}`);
    for (const s of sessions) startSelfHostedSession(s).catch((err) => console.error("[Self-hosted WhatsApp] startup reconnect failed for", s.label, ":", err.message));
  } catch (err) { console.error("[Self-hosted WhatsApp] startup scan failed:", err.message); }
}

// The one canonical number format used everywhere a number is stored on a
// WhatsAppMessage — digits only, no "+", no spaces/dashes. This is what
// fixes conversations splitting into two threads for the same person: an
// outgoing message used to store exactly whatever was typed (which could
// include a "+"), while an incoming reply's number came from WhatsApp's own
// JID (which never has one) — two different strings for the same contact.
// Every write path below now normalizes through this before storing.
function normalizeWaNumber(number) {
  return String(number).replace(/[^\d]/g, "");
}

function toWhatsAppJid(number) {
  return `${normalizeWaNumber(number)}@s.whatsapp.net`;
}

// Resolves the real WhatsApp identifier and a human-readable display number
// from a message key. Some contacts use WhatsApp's newer "LID" privacy-ID
// system (remoteJid ending in @lid — an internal ID that looks like a
// random number) instead of their real phone number; Baileys exposes the
// actual phone-number JID for these via remoteJidAlt when it's available.
// jid is always the exact identifier to reply to — replying to the LID
// itself (the identifier the message actually came from) is what actually
// reaches the contact; displayNumber is the best-effort human-readable
// number, honestly labeled "lid:..." rather than shown as a fake phone
// number when a real one genuinely can't be determined.
async function resolveMessageIdentity(key, sock) {
  const jid = key.remoteJid;
  const altJid = key.remoteJidAlt;
  if (jid && jid.endsWith("@s.whatsapp.net")) {
    return { jid, displayNumber: normalizeWaNumber(jid.replace("@s.whatsapp.net", "")) };
  }
  if (altJid && altJid.endsWith("@s.whatsapp.net")) {
    return { jid, displayNumber: normalizeWaNumber(altJid.replace("@s.whatsapp.net", "")) };
  }
  // NEW: second resolution attempt, using Baileys' own internal LID<->phone-
  // number mapping store when it exists — a real, dedicated API for exactly
  // this, rather than another guess. Wrapped defensively since this is a
  // newer, less consistently-documented part of Baileys across versions;
  // if it's not present or throws, this just falls through to the honest
  // "lid:..." label below instead of breaking anything.
  if (jid && jid.endsWith("@lid") && sock?.signalRepository?.lidMapping?.getPNForLID) {
    try {
      const pn = await sock.signalRepository.lidMapping.getPNForLID(jid);
      if (pn) return { jid, displayNumber: normalizeWaNumber(String(pn).replace("@s.whatsapp.net", "")) };
    } catch { /* fall through to the lid: label below */ }
  }
  // Logs the full key whenever neither field resolves to a real phone-
  // number JID — this is the exact data needed to find the right field for
  // real if remoteJidAlt/lidMapping aren't where a given Baileys version
  // puts this, instead of guessing at another field name blind.
  console.log(`[Self-hosted WhatsApp] could not resolve a real number — raw key: ${JSON.stringify(key)}`);
  const lidDigits = jid ? jid.replace("@lid", "").replace(/[^\d]/g, "") : "";
  return { jid: jid || "", displayNumber: lidDigits ? `lid:${lidDigits}` : "" };
}

async function sendSelfHostedMessage(sessionId, target, text) {
  const sock = activeSelfHostedSockets.get(sessionId);
  if (!sock) throw new Error("This number isn't connected right now");
  // target can be a plain number (a phone-number JID gets constructed) or
  // an already-complete JID (used exactly as given) — replying within an
  // existing thread passes the exact stored jid, which is what makes
  // replies reach LID-based contacts correctly instead of assuming every
  // contact uses a phone-number JID.
  const jid = String(target).includes("@") ? target : toWhatsAppJid(target);
  const sent = await sock.sendMessage(jid, { text });
  // NEW: returns the real Baileys message ID for this send — this is what
  // lets the live message handler below recognize "this is an echo of a
  // message the dashboard itself already logged" and skip re-logging it,
  // while still logging every OTHER outgoing message (sent from the
  // connected phone directly, or any other linked device) that never went
  // through this function at all.
  return sent?.key?.id || "";
}

// Runs in the background (not awaited by the route that starts it) — sends
// with a randomized pause between each message. This isn't just politeness:
// sending many messages back-to-back is exactly the pattern WhatsApp's spam
// detection looks for, and pacing genuinely reduces (never eliminates) the
// chance of the number getting flagged.
async function runBulkJob(jobId, sessionId, numbers, message) {
  const results = [];
  for (const number of numbers) {
    try {
      const waMessageId = await sendSelfHostedMessage(sessionId, number, message);
      await logWhatsAppMessage({ instanceId: sessionId, direction: "outgoing", number: normalizeWaNumber(number), message, status: "sent", source: "bulk", waMessageId });
      results.push({ number, success: true, error: "" });
    } catch (err) {
      await logWhatsAppMessage({ instanceId: sessionId, direction: "outgoing", number: normalizeWaNumber(number), message, status: "failed", source: "bulk" });
      results.push({ number, success: false, error: err.message });
    }
    await WhatsAppBulkJob.findByIdAndUpdate(jobId, { results });
    await new Promise((r) => setTimeout(r, 2000 + Math.random() * 3000)); // 2–5s pace between sends
  }
  await WhatsAppBulkJob.findByIdAndUpdate(jobId, { status: "done", results });
}

// Real, documented OpenAI Chat Completions API —
// https://platform.openai.com/docs/api-reference/chat. Same "real,
// documented API, not a guess" reasoning as the Anthropic integration this
// replaces — swapped to OpenAI per request, since it's the cheaper option.
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

// Builds the last ~10 messages between this number and this instance as
// Anthropic-format conversation history, oldest first, alternating
// user/assistant — real prior context, not a blank slate every message.
async function buildBotHistory(instanceId, number, latestIncomingText) {
  const prior = await WhatsAppMessage.find({ instanceId, number, groupId: "" }).sort("-createdAt").limit(10);
  const history = prior.reverse().map((m) => ({ role: m.direction === "incoming" ? "user" : "assistant", content: m.message }));
  history.push({ role: "user", content: latestIncomingText });
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
      to: String(to).replace(/[^\d+]/g, ""), // WhatsApp Cloud API wants digits (with country code), no spaces/dashes
      type: "text",
      text: { body: text, preview_url: true },
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data?.error?.message || `WhatsApp API returned HTTP ${resp.status}`);
  return data;
}

// Super Admin → Settings → WhatsApp. GET never returns the actual access
// token back — only whether one is currently saved — same convention as any
// password field: you re-enter it to change it, you don't get to read it
// back out.
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

// ══════════════════════════════════════════════════════════════════════════════
// AI PROVIDER SETTINGS — Super Admin → WhatsApp → AI Bot
// ══════════════════════════════════════════════════════════════════════════════

// OpenAI API key — powers the WhatsApp AI Bot. Same never-returned-once-
// saved convention as the other tokens above.
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

// ══════════════════════════════════════════════════════════════════════════════
// AI BOT — Super Admin → WhatsApp → AI Bot
// ══════════════════════════════════════════════════════════════════════════════

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

// Test the bot's current "training" without touching real WhatsApp at
// all — lets you refine the instructions and see exactly how it'll answer
// before turning it on for actual customers.
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
// SELF-HOSTED WHATSAPP SERVER ROUTES — Super Admin → WhatsApp → Self-Hosted Server
// ══════════════════════════════════════════════════════════════════════════════
// Every route here returns a clear 503 instead of crashing if Baileys isn't
// installed yet — see the require() at the top of this file.
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

// Poll this after creating a session (or after Reconnect) until it returns
// a QR, then again after scanning until status flips to "connected" —
// Baileys emits the QR as an event, so this is read from whatever the
// connection.update handler last saved rather than generated on demand.
app.get("/api/admin/whatsapp-server/sessions/:id/qr", protect, adminOnly, requireBaileys, async (req, res) => {
  try {
    const session = await WhatsAppSelfSession.findById(req.params.id).select("-authState");
    if (!session) return res.status(404).json({ message: "Session not found" });
    res.json({ qr: session.lastQr, status: session.status, phoneNumber: session.phoneNumber });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.post("/api/admin/whatsapp-server/sessions/:id/reconnect", protect, adminOnly, requireBaileys, async (req, res) => {
  try {
    const session = await WhatsAppSelfSession.findById(req.params.id);
    if (!session) return res.status(404).json({ message: "Session not found" });
    activeSelfHostedSockets.delete(session.sessionId);
    startSelfHostedSession(session).catch((err) => console.error("[Self-hosted WhatsApp] reconnect failed:", err.message));
    res.json({ started: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.delete("/api/admin/whatsapp-server/sessions/:id", protect, adminOnly, requireBaileys, async (req, res) => {
  try {
    const session = await WhatsAppSelfSession.findById(req.params.id);
    if (!session) return res.status(404).json({ message: "Session not found" });
    const sock = activeSelfHostedSockets.get(session.sessionId);
    if (sock) { try { await sock.logout(); } catch { /* ignore — removing our record either way */ } }
    activeSelfHostedSockets.delete(session.sessionId);
    await WhatsAppSelfSession.findByIdAndDelete(req.params.id);
    res.json({ deleted: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Wipes stored message history for one number WITHOUT disconnecting it —
// useful for clearing out old records that were saved before a fix (like
// the LID-resolution one), so a later history sync repopulates cleanly
// instead of mixing old, incorrectly-labeled rows with new correct ones.
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
    const displayNumber = normalizeWaNumber(to);
    // If this contact has messaged before, reply to the exact identifier
    // their messages came from rather than reconstructing a phone-number
    // JID — this is what makes replying work for contacts WhatsApp has
    // moved to its "LID" privacy-ID system, where a phone-number-based JID
    // simply doesn't reach them.
    const priorMessage = await WhatsAppMessage.findOne({ instanceId: session.sessionId, number: displayNumber, jid: { $ne: "" } }).sort("-createdAt");
    const sendTarget = priorMessage?.jid || to.trim();
    try {
      const waMessageId = await sendSelfHostedMessage(session.sessionId, sendTarget, message.trim());
      await logWhatsAppMessage({ instanceId: session.sessionId, direction: "outgoing", number: displayNumber, jid: sendTarget.includes("@") ? sendTarget : toWhatsAppJid(sendTarget), message: message.trim(), status: "sent", source: "manual", waMessageId });
    } catch (err) {
      await logWhatsAppMessage({ instanceId: session.sessionId, direction: "outgoing", number: displayNumber, message: message.trim(), status: "failed", source: "manual" });
      throw err;
    }
    res.json({ sent: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Starts a bulk send in the background and returns immediately with a job
// ID to poll — sending to many numbers one request at a time (with pacing
// between each) can easily take longer than a normal HTTP request should
// be left open for.
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

// Simple external API key so this can be called by another app/service you
// build or share with a partner, without needing a Super Admin login —
// stored the same way as the other secrets (Super Admin → WhatsApp →
// Self-Hosted Server).
app.post("/api/whatsapp-server/external/send", requireBaileys, async (req, res) => {
  try {
    const { apiKey, sessionId, to, message } = req.body || {};
    const settings = await getSiteSettings();
    if (!settings.whatsappServerApiKey || apiKey !== settings.whatsappServerApiKey)
      return res.status(401).json({ message: "Invalid API key" });
    if (!sessionId || !to?.trim() || !message?.trim()) return res.status(400).json({ message: "sessionId, to, and message are required" });
    const waMessageId = await sendSelfHostedMessage(sessionId, to.trim(), message.trim());
    await logWhatsAppMessage({ instanceId: sessionId, direction: "outgoing", number: normalizeWaNumber(to), message: message.trim(), status: "sent", source: "external_api", waMessageId });
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

// Message history for one number — real sent/received counts and the
// actual message list, for Super Admin → WhatsApp → Messages.
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
// CONVERSATIONS — Super Admin → Conversation (proper per-contact chat threads)
// ══════════════════════════════════════════════════════════════════════════════
// For now this only covers WhatsApp (via the self-hosted server) — the plan
// is for this tab to eventually also show email and Messenger threads in
// the same place, but that's a later step.

// One row per real contact (number) for the chosen number, with their most
// recent message, newest conversation first.
app.get("/api/admin/whatsapp/conversations", protect, adminOnly, async (req, res) => {
  try {
    const { instanceId } = req.query;
    if (!instanceId) return res.status(400).json({ message: "instanceId is required" });
    const threads = await WhatsAppMessage.aggregate([
      { $match: { instanceId, number: { $ne: "" }, groupId: "" } },
      { $sort: { createdAt: -1 } },
      { $group: { _id: "$number", jid: { $first: "$jid" }, lastMessage: { $first: "$message" }, lastDirection: { $first: "$direction" }, lastAt: { $first: "$createdAt" }, count: { $sum: 1 } } },
      { $sort: { lastAt: -1 } },
    ]);
    // Saved contact names — matches WhatsApp's own behavior: a name shows
    // when that number/jid is saved as a contact, otherwise just the
    // number shows (formatDisplayNumber on the frontend handles that part).
    const jids = threads.map((t) => t.jid).filter(Boolean);
    const contacts = jids.length > 0 ? await WhatsAppContact.find({ instanceId, jid: { $in: jids } }) : [];
    const nameByJid = Object.fromEntries(contacts.filter((c) => c.name).map((c) => [c.jid, c.name]));
    res.json(threads.map((t) => ({ number: t._id, name: nameByJid[t.jid] || "", lastMessage: t.lastMessage, lastDirection: t.lastDirection, lastAt: t.lastAt, count: t.count })));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Full back-and-forth with one specific contact, oldest first (natural chat order).
app.get("/api/admin/whatsapp/conversations/:instanceId/:number", protect, adminOnly, async (req, res) => {
  try {
    const { instanceId, number } = req.params;
    // NEW: no longer re-normalizing this — normalizeWaNumber strips
    // non-digit characters, which corrupts a "lid:12345" identifier
    // (stripping the "lid:" prefix) so it no longer matches what's
    // actually stored. The frontend already passes back the exact
    // `number` value the thread list gave it, which is already canonical.
    const messages = await WhatsAppMessage.find({ instanceId, number, groupId: "" }).sort("createdAt").limit(500);
    res.json({ messages });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Profile photo — real Baileys method (sock.profilePictureUrl). Pass
// number="me" for the connected business number's own photo. Baileys
// throws when there's no photo set or the person's privacy settings hide
// it from you — either way that's "no photo available", not a real error.
// Looks up the exact jid to use for a displayNumber (which might be a real
// phone number OR a "lid:xxxxx" label) by checking a prior message from
// that contact — same lookup the /send route uses. Falls back to
// constructing a phone-number JID only when there's no prior message to
// learn the real jid from.
async function resolveJidForNumber(instanceId, number) {
  const prior = await WhatsAppMessage.findOne({ instanceId, number, jid: { $ne: "" } }).sort("-createdAt");
  return prior?.jid || toWhatsAppJid(number);
}

app.get("/api/admin/whatsapp/profile-photo/:instanceId/:number", protect, adminOnly, async (req, res) => {
  try {
    const { instanceId, number } = req.params;
    const sock = activeSelfHostedSockets.get(instanceId);
    if (!sock) return res.status(404).json({ message: "This number isn't connected right now" });
    const jid = number === "me" ? sock.user?.id : await resolveJidForNumber(instanceId, number);
    if (!jid) return res.json({ url: null });
    try {
      const url = await sock.profilePictureUrl(jid, "image");
      res.json({ url });
    } catch {
      res.json({ url: null });
    }
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Last seen / online status — presence in Baileys arrives as a pushed
// event, not a plain request/response value, so this subscribes and waits
// briefly for one update. IMPORTANT, honest limitation: most people hide
// "last seen" in their WhatsApp privacy settings, especially from numbers
// they haven't saved — when that's the case, WhatsApp simply never sends
// an update at all, this times out, and the frontend shows "unavailable".
// That's expected WhatsApp behavior, not a bug to chase.
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
        resolve(update.presences?.[jid] || null);
      };
      sock.ev.on("presence.update", handler);
      sock.presenceSubscribe(jid).catch(() => { clearTimeout(timeout); resolve(null); });
    });
    res.json({ presence });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// WhatsApp "About" text — real Baileys method (sock.fetchStatus). Like the
// profile photo, this can come back empty if the contact hides it in their
// privacy settings — that's expected, not an error.
app.get("/api/admin/whatsapp/about/:instanceId/:number", protect, adminOnly, async (req, res) => {
  try {
    const { instanceId, number } = req.params;
    const sock = activeSelfHostedSockets.get(instanceId);
    if (!sock) return res.status(404).json({ message: "This number isn't connected right now" });
    const jid = await resolveJidForNumber(instanceId, number);
    try {
      const result = await sock.fetchStatus(jid);
      res.json({ status: result?.status || "", setAt: result?.setAt || null });
    } catch {
      res.json({ status: "", setAt: null });
    }
  } catch (err) { res.status(500).json({ message: err.message }); }
});

  // Everything server.js needs to reach from outside this file — the
  // Automation Workflow engine's send_whatsapp action, and the startup
  // reconnect call in the mongoose "open" handler. See the wiring notes
  // at the top of this file for exactly where each of these is used.
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