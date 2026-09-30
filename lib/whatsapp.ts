import { Client, LocalAuth, MessageMedia } from "whatsapp-web.js";
import type { Server as SocketServer } from "socket.io";
import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { ADMINS_ROOM, INBOX_ROOM, attachSocketAuth } from "@/lib/socket-auth";
import QRCode from "qrcode";
import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import mime from "mime-types";

export type ConnectionState =
  | "initializing"
  | "qr"
  | "authenticated"
  | "ready"
  | "disconnected"
  | "auth_failure";

interface WhatsAppServiceState {
  client: Client | null;
  state: ConnectionState;
  qrSvg: string | null;
  info: string;
  io: SocketServer | null;
  readyWatchdog: NodeJS.Timeout | null;
  initPromise: Promise<Client> | null;
  startedAt: string;
  ownPushname: string | null;
}

// The custom server (server.ts via tsx) and the Next.js API routes load this
// module through different bundlers, which would otherwise create two separate
// module instances with two independent state objects. The real WhatsApp client
// lives in the custom-server instance, so API routes like /api/send and
// /api/whatsapp/status would always see the initial "initializing" state.
// Anchoring the state on globalThis makes both instances share one state.
const globalForWhatsApp = globalThis as unknown as {
  __waControlState?: WhatsAppServiceState;
};

const state: WhatsAppServiceState = (globalForWhatsApp.__waControlState ??= {
  client: null,
  state: "initializing",
  qrSvg: null,
  info: "Initializing WhatsApp client...",
  io: null,
  readyWatchdog: null,
  initPromise: null,
  startedAt: new Date().toISOString(),
  ownPushname: null,
});

// App version, surfaced in the admin panel so the deployed build can be verified.
import pkg from "../package.json";
export const APP_VERSION: string = pkg.version;

const UPLOAD_DIR = path.join(process.cwd(), "public", "uploads");

async function ensureUploadDir() {
  try {
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
  } catch {
    // ignore
  }
}

async function upsertChat(
  remoteJid: string,
  name?: string | null,
  profilePicUrl?: string | null,
  lastMessageAt?: Date,
  phone?: string | null
) {
  const existing = await prisma.chat.findUnique({
    where: { remoteJid },
  });

  if (existing) {
    const updateData: any = { lastMessageAt: lastMessageAt || new Date() };
    if (name && !existing.name) updateData.name = name;
    if (profilePicUrl) updateData.profilePicUrl = profilePicUrl;
    if (phone && !existing.phone) updateData.phone = phone;
    return prisma.chat.update({ where: { remoteJid }, data: updateData });
  }

  return prisma.chat.create({
    data: {
      remoteJid,
      name: name || remoteJid.split("@")[0],
      phone: phone || null,
      profilePicUrl,
      lastMessageAt: lastMessageAt || new Date(),
    },
  });
}

// On WhatsApp Web 2.3000.1043x+ the serialized message id property was renamed
// from `_serialized` to `$1`. Support both so message dedupe and persistence
// keep working across WhatsApp Web versions.
function getMessageId(msg: any): string | null {
  return msg?.id?._serialized || msg?.id?.$1 || null;
}

async function persistMessage(msg: any, fromMe: boolean, opts: { emit?: boolean } = {}) {
  const emit = opts.emit !== false;
  const msgId = getMessageId(msg);
  // Protocol/system noise (encryption notices, group events, call logs,
  // revoked-message shells) is not chat content — persisting it creates junk
  // chats and empty bubbles.
  const NOISE_TYPES = new Set(["e2e_notification", "notification_template", "gp2", "call_log", "revoked"]);
  if (NOISE_TYPES.has(msg.type)) return;
  console.log("[WhatsApp] persistMessage start", msgId, msg.type);
  try {
    // Avoid msg.getChat() — it goes through client.getChatById(), which crashes
    // with a minified "r: r" error on recent WhatsApp Web versions. Derive the
    // chat id from the message addressing fields instead.
    const rawJid: string = (msg.fromMe ? msg.to : msg.from) || "";
    if (!rawJid || rawJid.includes("broadcast")) return;
    const remoteJid = rawJid.includes("@") ? rawJid : `${rawJid}@c.us`;

    // Best-effort display name and phone number; all of these can fail on
    // newer WA Web versions. For @c.us chats the number is the jid user part.
    // For @lid chats we can't trust contact.number — under the LID system it
    // returns the LID itself, not the real phone number — so phone stays null.
    let name: string | undefined;
    const phone: string | undefined = remoteJid.endsWith("@c.us")
      ? remoteJid.split("@")[0]
      : undefined;
    try {
      const contact = await msg.getContact();
      name = contact?.pushname || contact?.name || undefined;
    } catch {
      // ignore
    }
    // For outgoing messages msg.getContact() can resolve to OUR OWN contact,
    // which stamped the account's pushname (e.g. the business name) onto
    // dozens of outgoing-only chats. Discard it when it matches.
    if (name && state.ownPushname && name === state.ownPushname) {
      name = undefined;
    }
    if (!name) {
      try {
        const chat = await msg.getChat();
        name = chat?.name || undefined;
      } catch {
        // ignore
      }
    }

    // Try to fetch profile picture for the chat once in a while
    let profilePicUrl: string | null = null;
    try {
      profilePicUrl = (await state.client?.getProfilePicUrl(remoteJid)) || null;
    } catch {
      profilePicUrl = null;
    }

    const msgTimestamp = msg.timestamp ? new Date(msg.timestamp * 1000) : new Date();
    const chatRecord = await upsertChat(remoteJid, name, profilePicUrl, msgTimestamp, phone);

    const type = getTypeMessageType(msg);
    let mediaUrl: string | null = null;
    let mediaMimeType: string | null = null;
    let mediaCaption: string | null = msg.body || null;

    if (msg.hasMedia) {
      try {
        const media = await msg.downloadMedia();
        if (media && media.data) {
          await ensureUploadDir();
          const ext = mime.extension(media.mimetype) || "bin";
          const filename = `${randomUUID()}.${ext}`;
          const filepath = path.join(UPLOAD_DIR, filename);
          await fs.writeFile(filepath, Buffer.from(media.data, "base64"));
          mediaUrl = `/uploads/${filename}`;
          mediaMimeType = media.mimetype;
          if (!mediaCaption && media.filename) mediaCaption = media.filename;
        }
      } catch (mediaErr) {
        console.error("[WhatsApp] downloadMedia failed:", mediaErr);
      }
    }

    const body = msg.body || (type !== "text" ? mediaCaption : null) || "";

    // Avoid duplicate messages when both sendMessage() and the message_create event fire
    if (msgId) {
      const existing = await prisma.message.findUnique({
        where: { whatsappMessageId: msgId },
      });
      if (existing) return;
    }

    const messageRecord = await prisma.message.create({
      data: {
        chatId: chatRecord.id,
        remoteJid,
        whatsappMessageId: msgId,
        fromMe,
        body,
        type,
        mediaUrl,
        mediaMimeType,
        mediaCaption,
        timestamp: msgTimestamp,
      },
    });

    if (emit) {
      // Inbox-scoped: only ADMIN/USER sockets may see message content
      // (lib/socket-auth.ts places sockets in the rooms).
      state.io?.to(INBOX_ROOM).emit("message", {
        ...messageRecord,
        chat: chatRecord,
      });

      state.io?.to(INBOX_ROOM).emit("chat_update", chatRecord);

      // Audit incoming messages (outgoing dashboard sends are already logged
      // as SEND_MESSAGE by /api/send; backfill batches are not logged).
      if (!fromMe) {
        const snippet = (body || `[${type}]`).slice(0, 120);
        writeAuditLog("MESSAGE_RECEIVED", null, `From ${name || phone || remoteJid}: ${snippet}`);
      }
    }
    console.log("[WhatsApp] persistMessage saved", messageRecord.id, remoteJid);
  } catch (err: any) {
    // P2002 = duplicate whatsappMessageId from the message_create + message
    // events racing each other; the message is already persisted, so benign.
    if (err?.code === "P2002") return;
    console.error("[WhatsApp] persistMessage error:", err);
  }
}

function getTypeMessageType(msg: any): string {
  if (msg.hasMedia) {
    if (msg.type === "ptt" || msg.type === "audio") return "voice";
    if (msg.type === "image") return "image";
    if (msg.type === "document") return "document";
    if (msg.type === "video") return "video";
    if (msg.type === "sticker") return "sticker";
    return "media";
  }
  if (msg.type === "chat" || msg.type === "text") return "text";
  return msg.type || "unknown";
}

export function setSocketServer(io: SocketServer) {
  state.io = io;
  // Authentication, origin checking, room scoping and revalidation live in
  // lib/socket-auth.ts; the state payloads are injected so that module stays
  // free of this file (dual-bundler cycle, AGENTS.md pitfall 1).
  attachSocketAuth(io, {
    getWhatsAppState: () => getWhatsAppState(),
    isConnected: () => state.state === "ready",
  });
}

/**
 * Pushes the current WhatsApp state to the rooms allowed to see it: the full
 * state (info + pairing qrSvg) goes to 'admins' only, while plain inbox users
 * only ever get availability as { connected }. The inbox room is emitted to
 * FIRST because ADMIN sockets sit in both rooms and must end up with the
 * full state as the last whatsapp_state they receive.
 */
function broadcastWhatsAppState() {
  if (!state.io) return;
  state.io.to(INBOX_ROOM).emit("whatsapp_state", { connected: state.state === "ready" });
  state.io.to(ADMINS_ROOM).emit("whatsapp_state", getWhatsAppState());
}

export function getWhatsAppState() {
  return {
    state: state.state,
    qrSvg: state.qrSvg,
    info: state.info,
    version: APP_VERSION,
    startedAt: state.startedAt,
  };
}

// Backfills recent chats and their last messages into the database after the
// client becomes ready. Fully guarded: if getChats()/fetchMessages() fail
// (known headless instability), real-time events keep working regardless.
const BACKFILL_CHAT_LIMIT = 20;
const BACKFILL_MESSAGE_LIMIT = 50;

async function backfillChats(client: Client) {
  let chats;
  try {
    chats = await client.getChats();
  } catch (e) {
    console.warn("[WhatsApp] backfill skipped: getChats() failed:", e);
    return;
  }

  const recent = chats
    .filter((c: any) => c?.id?._serialized && !c.id._serialized.includes("broadcast"))
    .sort((a: any, b: any) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, BACKFILL_CHAT_LIMIT);

  console.log(`[WhatsApp] backfill: syncing up to ${BACKFILL_MESSAGE_LIMIT} messages for ${recent.length} chats...`);
  let synced = 0;
  for (const chat of recent) {
    try {
      const messages = await chat.fetchMessages({ limit: BACKFILL_MESSAGE_LIMIT });
      for (const m of messages) {
        await persistMessage(m, m.fromMe, { emit: false });
      }
      synced++;
    } catch (e) {
      console.error("[WhatsApp] backfill: failed for chat", chat.id?._serialized, e);
    }
  }
  console.log(`[WhatsApp] backfill complete: ${synced}/${recent.length} chats synced.`);
  // Notify dashboards to refetch the chat list once, instead of per message.
  state.io?.to(INBOX_ROOM).emit("chat_update", { backfill: true });
}

// client.initialize() can fail transiently — most notably when the page
// reloads mid-injection and puppeteer reports "Execution context was
// destroyed". Retry with a fresh client each time instead of leaving the
// service dead until manual Reconnect.
const MAX_INIT_ATTEMPTS = 5;
const INIT_RETRY_DELAY_MS = 10_000;

export function initializeWhatsApp(): Promise<Client> {
  if (state.client) return Promise.resolve(state.client);
  // Server boot, the logout re-init timer, and the admin Reconnect action can
  // all trigger initialization concurrently — share one in-flight attempt
  // loop so they don't spawn competing browsers for the same profile.
  state.initPromise ??= (async () => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_INIT_ATTEMPTS; attempt++) {
      try {
        return await initializeOnce();
      } catch (e) {
        lastError = e;
        console.error(`[WhatsApp] initialize attempt ${attempt}/${MAX_INIT_ATTEMPTS} failed:`, e);
        if (attempt < MAX_INIT_ATTEMPTS) {
          state.info = `Initialization failed (attempt ${attempt}/${MAX_INIT_ATTEMPTS}). Retrying...`;
          broadcastWhatsAppState();
          await new Promise((r) => setTimeout(r, INIT_RETRY_DELAY_MS));
        }
      }
    }

    state.state = "disconnected";
    state.info = "Initialization failed after repeated attempts. Use Reconnect to try again.";
    broadcastWhatsAppState();
    throw lastError;
  })().finally(() => {
    state.initPromise = null;
  });
  return state.initPromise;
}

async function initializeOnce() {
  if (state.client) return state.client;

  state.info = "Initializing WhatsApp client...";

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(process.cwd(), ".wwebjs_auth") }),
    // NOTE: pinning webVersion via wa-version snapshots was tried (upstream
    // workaround for the 2.3000.1043x breakage), but every alpha snapshot
    // stalls at app-state sync ("authenticated" never reaches "ready").
    // Instead we run the live version and patch the library's injected
    // getChats() at container start (scripts/patch-wwebjs.js).
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    },
  });

  client.on("qr", async (qr: string) => {
    console.log("[WhatsApp] QR code received — scan it with WhatsApp on your phone.");
    writeAuditLog("WA_QR", null, "QR code issued — waiting for phone scan.");
    state.state = "qr";
    try {
      const svg = await QRCode.toString(qr, { type: "svg", margin: 2, width: 256 });
      state.qrSvg = svg;
      state.info = "Scan the QR code with WhatsApp on your phone.";
    } catch {
      state.qrSvg = null;
      state.info = "Failed to generate QR code.";
    }
    broadcastWhatsAppState();
  });

  client.on("authenticated", () => {
    console.log("[WhatsApp] authenticated. Waiting for client to become ready...");
    state.state = "authenticated";
    state.qrSvg = null;
    state.info = "Authenticated. Loading chats...";
    broadcastWhatsAppState();

    // If the client stays in "authenticated" without reaching "ready", the
    // WhatsApp Web app-state sync has stalled — common after a plain restart
    // (a fresh QR pairing always syncs; a resumed session often hangs).
    // Reloading the page usually kicks the sync back into gear, so try that
    // once before telling the user to re-pair.
    if (state.readyWatchdog) clearTimeout(state.readyWatchdog);
    state.readyWatchdog = setTimeout(() => {
      if (state.state !== "authenticated") return;
      console.warn("[WhatsApp] not ready 90s after authentication — reloading the WhatsApp Web page to restart app-state sync...");
      (state.client as any)?.pupPage
        ?.reload({ timeout: 60_000 })
        .catch((e: unknown) => console.error("[WhatsApp] page reload failed:", e));
      state.readyWatchdog = setTimeout(() => {
        if (state.state === "authenticated") {
          console.warn(
            "[WhatsApp] still not ready after page reload. " +
              "The session may be stale — use Logout + Reconnect in the admin panel and scan the QR code again."
          );
        }
      }, 150_000);
    }, 90_000);
  });

  client.on("auth_failure", (msg: string) => {
    state.state = "auth_failure";
    state.info = `Authentication failure: ${msg}`;
    writeAuditLog("WA_AUTH_FAILURE", null, String(msg).slice(0, 200));
    broadcastWhatsAppState();
  });

  client.on("ready", async () => {
    if (state.readyWatchdog) {
      clearTimeout(state.readyWatchdog);
      state.readyWatchdog = null;
    }
    state.state = "ready";
    state.info = "WhatsApp client is ready.";
    state.qrSvg = null;
    await prisma.whatsAppSession.upsert({
      where: { sessionId: "default" },
      update: { connected: true, info: state.info },
      create: { sessionId: "default", connected: true, info: state.info },
    });
    broadcastWhatsAppState();
    state.ownPushname = (client.info as any)?.pushname || null;
    if (state.ownPushname) console.log("[WhatsApp] own pushname:", state.ownPushname);
    let waVersion = "unknown";
    try {
      waVersion = await client.getWWebVersion();
      console.log("[WhatsApp] running WhatsApp Web version:", waVersion);
    } catch {
      // ignore
    }
    writeAuditLog("WA_READY", null, `Client ready (WhatsApp Web ${waVersion}).`);
    console.log("[WhatsApp] client ready. Listening for new messages.");
    backfillChats(client).catch((e) => console.error("[WhatsApp] backfill error:", e));
  });

  client.on("disconnected", async (reason: any) => {
    console.log("[WhatsApp] disconnected:", reason);
    writeAuditLog("WA_DISCONNECTED", null, String(reason).slice(0, 200));
    if (state.readyWatchdog) {
      clearTimeout(state.readyWatchdog);
      state.readyWatchdog = null;
    }
    state.state = "disconnected";
    state.info = `Disconnected: ${reason}`;
    state.qrSvg = null;
    await prisma.whatsAppSession.upsert({
      where: { sessionId: "default" },
      update: { connected: false, info: state.info },
      create: { sessionId: "default", connected: false, info: state.info },
    });
    broadcastWhatsAppState();
  });

  client.on("message_create", async (msg: any) => {
    // Fires for both incoming and outgoing messages
    console.log("[WhatsApp] message_create fired", getMessageId(msg), msg.fromMe);
    await persistMessage(msg, msg.fromMe);
  });

  client.on("message", async (msg: any) => {
    // Incoming messages backup
    console.log("[WhatsApp] message event fired", getMessageId(msg), msg.fromMe);
    await persistMessage(msg, msg.fromMe);
  });

  client.on("change_state", (st: any) => {
    console.log("[WhatsApp] state change:", st);
  });

  state.client = client;
  try {
    await client.initialize();
  } catch (e) {
    // Tear down the half-initialized client so the next attempt starts clean.
    try {
      await client.destroy();
    } catch {
      // ignore
    }
    state.client = null;
    throw e;
  }
  return client;
}

export async function logoutWhatsApp() {
  if (!state.client) return;
  try {
    await state.client.logout();
    await state.client.destroy();
  } catch (e) {
    console.error("[WhatsApp] logout error:", e);
  }
  state.client = null;
  state.state = "disconnected";
  state.qrSvg = null;
  state.info = "Logged out. Re-initializing...";
  broadcastWhatsAppState();
}

// Tears down the current client (without logging out of WhatsApp) and
// re-initializes. Used by the admin "Reconnect" action — calling
// initializeWhatsApp() alone is a no-op while a client instance exists.
export async function restartWhatsApp() {
  if (state.readyWatchdog) {
    clearTimeout(state.readyWatchdog);
    state.readyWatchdog = null;
  }
  if (state.client) {
    try {
      await state.client.destroy();
    } catch (e) {
      console.error("[WhatsApp] destroy error:", e);
    }
    state.client = null;
  }
  state.state = "initializing";
  state.qrSvg = null;
  state.info = "Re-initializing WhatsApp client...";
  broadcastWhatsAppState();
  return initializeWhatsApp();
}

export async function sendWhatsAppMessage({
  remoteJid,
  body,
  type,
  mediaBase64,
  mediaMimeType,
  mediaFilename,
}: {
  remoteJid: string;
  body?: string;
  type: "text" | "image" | "voice" | "document";
  mediaBase64?: string;
  mediaMimeType?: string;
  mediaFilename?: string;
}) {
  console.log("[WhatsApp] sendWhatsAppMessage called", { remoteJid, type });
  if (!state.client) throw new Error("WhatsApp client not initialized");
  if (state.state !== "ready") throw new Error("WhatsApp client not ready");

  const chatId = remoteJid.includes("@") ? remoteJid : `${remoteJid}@c.us`;

  // Normalize number if needed
  let finalChatId = chatId;
  if (!chatId.includes("@g.us")) {
    let numberId: { _serialized: string } | null | undefined;
    try {
      numberId = await state.client.getNumberId(chatId.replace("@c.us", ""));
    } catch {
      // Lookup failed — fall back to the provided id silently.
    }
    if (numberId === null) {
      // getNumberId RESOLVES to null when the number is not registered on
      // WhatsApp — fail here with a readable message instead of a cryptic
      // downstream WA Web error.
      throw new Error("Not a WhatsApp number: " + chatId.split("@")[0]);
    }
    if (numberId?._serialized) {
      finalChatId = numberId._serialized;
      console.log("[WhatsApp] normalized number to", finalChatId);
    }
  }

  let message;
  if (type !== "text" && mediaBase64 && mediaMimeType) {
    const media = new MessageMedia(mediaMimeType, mediaBase64, mediaFilename || "file");
    message = await state.client.sendMessage(finalChatId, media, {
      caption: body || undefined,
      sendAudioAsVoice: type === "voice",
    });
  } else {
    message = await state.client.sendMessage(finalChatId, body || "");
  }

  // On newer WhatsApp Web versions sendMessage() can resolve to undefined even
  // though the message was delivered (the message_create event still fires and
  // persists it). Treat a missing return value as success.
  const sentId = getMessageId(message);
  console.log("[WhatsApp] sendWhatsAppMessage sent message id:", sentId);

  // When we dial a real phone number, WhatsApp may map it to an opaque @lid
  // jid (see finalChatId / message.to). We know the number we dialed, so
  // record it on every jid this send touched — the chat then displays
  // "+<number>" instead of "Number hidden by WhatsApp".
  const dialed = chatId.endsWith("@c.us") ? chatId.split("@")[0] : null;
  if (dialed) {
    const jids = new Set<string>([chatId, finalChatId]);
    const actualTo = message?.to;
    if (typeof actualTo === "string" && actualTo.includes("@")) jids.add(actualTo);
    for (const jid of Array.from(jids)) {
      if (jid.endsWith("@g.us")) continue;
      try {
        await prisma.chat.upsert({
          where: { remoteJid: jid },
          update: { phone: dialed },
          create: { remoteJid: jid, phone: dialed, name: null },
        });
        console.log("[WhatsApp] recorded dialed number", dialed, "for", jid);
      } catch (e) {
        console.error("[WhatsApp] failed to record dialed number for", jid, e);
      }
    }
  }

  return message || { id: sentId };
}

export async function markChatAsRead(remoteJid: string) {
  if (!state.client || state.state !== "ready") return;
  try {
    const chat = await state.client.getChatById(remoteJid);
    await chat.sendSeen();
  } catch (e) {
    console.error("[WhatsApp] markChatAsRead error:", e);
  }
}

export async function getChatById(client: Client, chatId: string) {
  return client.getChatById(chatId);
}
