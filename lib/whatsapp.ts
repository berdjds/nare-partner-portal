import { Client, LocalAuth, MessageMedia } from "whatsapp-web.js";
import type { Server as SocketServer } from "socket.io";
import { prisma } from "@/lib/prisma";
import type { WhatsAppAccount } from "@prisma/client";
import { writeAuditLog } from "@/lib/audit";
import { MARHABA_ACCOUNT_KEY, ensureDefaultAccounts, getAccount } from "@/lib/whatsapp-accounts";
import { adminsRoom, attachSocketAuth, inboxRoom } from "@/lib/socket-auth";
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

/**
 * W3 (wa-multi): every WhatsApp business account gets its own client, state,
 * QR, watchdog and lifecycle. Nothing is shared between accounts, so a
 * failure, restart or logout in one account never touches the other.
 */
interface AccountRuntime {
  /** WhatsAppAccount.key (and id — the registry uses the same fixed strings). */
  key: string;
  client: Client | null;
  state: ConnectionState;
  qrSvg: string | null;
  info: string;
  readyWatchdog: NodeJS.Timeout | null;
  initPromise: Promise<Client> | null;
  startedAt: string;
  ownPushname: string | null;
}

interface WhatsAppServiceState {
  io: SocketServer | null;
  accounts: Map<string, AccountRuntime>;
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
  io: null,
  accounts: new Map<string, AccountRuntime>(),
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

function logPrefix(accountKey: string) {
  return `[WhatsApp:${accountKey}]`;
}

/** Lazily creates the runtime holder for an account; never starts a client. */
function getRuntime(accountKey: string): AccountRuntime {
  let rt = state.accounts.get(accountKey);
  if (!rt) {
    rt = {
      key: accountKey,
      client: null,
      state: "initializing",
      qrSvg: null,
      info: "Initializing WhatsApp client...",
      readyWatchdog: null,
      initPromise: null,
      startedAt: new Date().toISOString(),
      ownPushname: null,
    };
    state.accounts.set(accountKey, rt);
  }
  return rt;
}

async function upsertChat(
  accountId: string,
  remoteJid: string,
  name?: string | null,
  profilePicUrl?: string | null,
  lastMessageAt?: Date,
  phone?: string | null
) {
  // Chat identity is the composite (accountId, remoteJid): the same customer
  // can chat with both business accounts without mixing.
  const chatWhere = { accountId_remoteJid: { accountId, remoteJid } };
  const existing = await prisma.chat.findUnique({
    where: chatWhere,
  });

  if (existing) {
    const updateData: any = { lastMessageAt: lastMessageAt || new Date() };
    if (name && !existing.name) updateData.name = name;
    if (profilePicUrl) updateData.profilePicUrl = profilePicUrl;
    if (phone && !existing.phone) updateData.phone = phone;
    return prisma.chat.update({ where: chatWhere, data: updateData });
  }

  return prisma.chat.create({
    data: {
      accountId,
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

async function persistMessage(rt: AccountRuntime, msg: any, fromMe: boolean, opts: { emit?: boolean } = {}) {
  const emit = opts.emit !== false;
  const accountId = rt.key;
  const prefix = logPrefix(accountId);
  const msgId = getMessageId(msg);
  // Protocol/system noise (encryption notices, group events, call logs,
  // revoked-message shells) is not chat content — persisting it creates junk
  // chats and empty bubbles.
  const NOISE_TYPES = new Set(["e2e_notification", "notification_template", "gp2", "call_log", "revoked"]);
  if (NOISE_TYPES.has(msg.type)) return;
  console.log(prefix, "persistMessage start", msgId, msg.type);
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
    if (name && rt.ownPushname && name === rt.ownPushname) {
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
      profilePicUrl = (await rt.client?.getProfilePicUrl(remoteJid)) || null;
    } catch {
      profilePicUrl = null;
    }

    const msgTimestamp = msg.timestamp ? new Date(msg.timestamp * 1000) : new Date();
    const chatRecord = await upsertChat(accountId, remoteJid, name, profilePicUrl, msgTimestamp, phone);

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
          // Non-default accounts are namespaced (public/uploads/<accountId>/)
          // so the /uploads gate can enforce each account's own view
          // permission. Marhaba keeps the legacy flat path — its production
          // files and stored mediaUrls predate W3 and must keep resolving.
          const relDir = accountId === MARHABA_ACCOUNT_KEY ? "" : accountId;
          if (relDir) {
            await fs.mkdir(path.join(UPLOAD_DIR, relDir), { recursive: true });
          }
          const filepath = path.join(UPLOAD_DIR, relDir, filename);
          await fs.writeFile(filepath, Buffer.from(media.data, "base64"));
          mediaUrl = relDir ? `/uploads/${relDir}/${filename}` : `/uploads/${filename}`;
          mediaMimeType = media.mimetype;
          if (!mediaCaption && media.filename) mediaCaption = media.filename;
        }
      } catch (mediaErr) {
        console.error(prefix, "downloadMedia failed:", mediaErr);
      }
    }

    const body = msg.body || (type !== "text" ? mediaCaption : null) || "";

    // Avoid duplicate messages when both sendMessage() and the message_create event fire
    if (msgId) {
      const existing = await prisma.message.findUnique({
        where: { accountId_whatsappMessageId: { accountId, whatsappMessageId: msgId } },
      });
      if (existing) return;
    }

    const messageRecord = await prisma.message.create({
      data: {
        accountId,
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
      // Account-scoped: only sockets in this account's inbox room may see its
      // message content (lib/socket-auth.ts places sockets in the rooms).
      // Every payload carries accountKey so clients route it to the account.
      state.io?.to(inboxRoom(accountId)).emit("message", {
        ...messageRecord,
        accountKey: accountId,
        chat: chatRecord,
      });

      state.io?.to(inboxRoom(accountId)).emit("chat_update", { ...chatRecord, accountKey: accountId });

      // Audit incoming messages (outgoing dashboard sends are already logged
      // as SEND_MESSAGE by /api/send; backfill batches are not logged).
      if (!fromMe) {
        const snippet = (body || `[${type}]`).slice(0, 120);
        writeAuditLog("MESSAGE_RECEIVED", null, `[${accountId}] From ${name || phone || remoteJid}: ${snippet}`);
      }
    }
    console.log(prefix, "persistMessage saved", messageRecord.id, remoteJid);
  } catch (err: any) {
    // P2002 = duplicate whatsappMessageId from the message_create + message
    // events racing each other; the message is already persisted, so benign.
    if (err?.code === "P2002") return;
    console.error(prefix, "persistMessage error:", err);
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
    getWhatsAppState: (accountKey: string) => getWhatsAppState(accountKey),
    isConnected: (accountKey: string) => getRuntime(accountKey).state === "ready",
  });
}

/**
 * Pushes one account's state to the rooms allowed to see it: the full state
 * (info + pairing qrSvg) goes to the account's admins room only, while its
 * inbox room only ever gets availability as { connected, accountKey }. The
 * inbox room is emitted to FIRST because ADMIN sockets sit in both rooms and
 * must end up with the full state as the last whatsapp_state they receive.
 */
function broadcastWhatsAppState(rt: AccountRuntime) {
  if (!state.io) return;
  state.io.to(inboxRoom(rt.key)).emit("whatsapp_state", {
    accountKey: rt.key,
    connected: rt.state === "ready",
  });
  state.io.to(adminsRoom(rt.key)).emit("whatsapp_state", getWhatsAppState(rt.key));
}

export function getWhatsAppState(accountKey: string = MARHABA_ACCOUNT_KEY) {
  const rt = getRuntime(accountKey);
  return {
    accountKey,
    state: rt.state,
    qrSvg: rt.qrSvg,
    info: rt.info,
    version: APP_VERSION,
    startedAt: rt.startedAt,
  };
}

// Backfills recent chats and their last messages into the database after the
// client becomes ready. Fully guarded: if getChats()/fetchMessages() fail
// (known headless instability), real-time events keep working regardless.
const BACKFILL_CHAT_LIMIT = 20;
const BACKFILL_MESSAGE_LIMIT = 50;

async function backfillChats(rt: AccountRuntime, client: Client) {
  const prefix = logPrefix(rt.key);
  let chats;
  try {
    chats = await client.getChats();
  } catch (e) {
    console.warn(prefix, "backfill skipped: getChats() failed:", e);
    return;
  }

  const recent = chats
    .filter((c: any) => c?.id?._serialized && !c.id._serialized.includes("broadcast"))
    .sort((a: any, b: any) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, BACKFILL_CHAT_LIMIT);

  console.log(`${prefix} backfill: syncing up to ${BACKFILL_MESSAGE_LIMIT} messages for ${recent.length} chats...`);
  let synced = 0;
  for (const chat of recent) {
    try {
      const messages = await chat.fetchMessages({ limit: BACKFILL_MESSAGE_LIMIT });
      for (const m of messages) {
        await persistMessage(rt, m, m.fromMe, { emit: false });
      }
      synced++;
    } catch (e) {
      console.error(prefix, "backfill: failed for chat", chat.id?._serialized, e);
    }
  }
  console.log(`${prefix} backfill complete: ${synced}/${recent.length} chats synced.`);
  // Notify dashboards to refetch the chat list once, instead of per message.
  state.io?.to(inboxRoom(rt.key)).emit("chat_update", { accountKey: rt.key, backfill: true });
}

// client.initialize() can fail transiently — most notably when the page
// reloads mid-injection and puppeteer reports "Execution context was
// destroyed". Retry with a fresh client each time instead of leaving the
// service dead until manual Reconnect.
const MAX_INIT_ATTEMPTS = 5;
const INIT_RETRY_DELAY_MS = 10_000;

export function initializeWhatsApp(accountKey: string = MARHABA_ACCOUNT_KEY): Promise<Client> {
  const rt = getRuntime(accountKey);
  if (rt.client) return Promise.resolve(rt.client);
  // Server boot, the logout re-init timer, and the admin Reconnect action can
  // all trigger initialization concurrently — share one in-flight attempt
  // loop per account so they don't spawn competing browsers for the same
  // profile. Each account has its own loop: a failure in one account never
  // touches the other.
  rt.initPromise ??= (async () => {
    // Configuration gate, checked once up front: a missing or disabled
    // account is not a transient error, so it must reject immediately — no
    // client, no LocalAuth, no retry loop (a disabled account would still be
    // disabled on every retry). Only client startup failures are retried.
    await ensureDefaultAccounts();
    const account = await getAccount(rt.key);
    if (!account) {
      rt.state = "disconnected";
      rt.info = `Account "${rt.key}" is not configured.`;
      broadcastWhatsAppState(rt);
      throw new Error(
        `WhatsApp account "${rt.key}" is not configured. Create it under Admin → WhatsApp accounts first.`
      );
    }
    if (!account.enabled) {
      rt.state = "disconnected";
      rt.info = `Account "${account.displayName}" is disabled. Enable it under Admin → WhatsApp accounts.`;
      broadcastWhatsAppState(rt);
      throw new Error(
        `WhatsApp account "${rt.key}" is disabled. Enable it under Admin → WhatsApp accounts before connecting.`
      );
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_INIT_ATTEMPTS; attempt++) {
      try {
        return await initializeOnce(rt, account);
      } catch (e) {
        lastError = e;
        console.error(`${logPrefix(accountKey)} initialize attempt ${attempt}/${MAX_INIT_ATTEMPTS} failed:`, e);
        if (attempt < MAX_INIT_ATTEMPTS) {
          rt.info = `Initialization failed (attempt ${attempt}/${MAX_INIT_ATTEMPTS}). Retrying...`;
          broadcastWhatsAppState(rt);
          await new Promise((r) => setTimeout(r, INIT_RETRY_DELAY_MS));
        }
      }
    }

    rt.state = "disconnected";
    rt.info = "Initialization failed after repeated attempts. Use Reconnect to try again.";
    broadcastWhatsAppState(rt);
    throw lastError;
  })().finally(() => {
    rt.initPromise = null;
  });
  return rt.initPromise;
}

async function initializeOnce(rt: AccountRuntime, account: WhatsAppAccount) {
  if (rt.client) return rt.client;
  const prefix = logPrefix(rt.key);

  rt.info = "Initializing WhatsApp client...";

  const dataPath = path.join(process.cwd(), ".wwebjs_auth");
  // Marhaba keeps the legacy LocalAuth options exactly as before W3: no
  // clientId, so the existing .wwebjs_auth/session directory is used
  // untouched. Accounts with a sessionClientId (Nare: 'nare') get their own
  // session-<clientId> directory.
  const authStrategy = account.sessionClientId
    ? new LocalAuth({ dataPath, clientId: account.sessionClientId })
    : new LocalAuth({ dataPath });

  const client = new Client({
    authStrategy,
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
    console.log(prefix, "QR code received — scan it with WhatsApp on your phone.");
    writeAuditLog("WA_QR", null, `[${rt.key}] QR code issued — waiting for phone scan.`);
    rt.state = "qr";
    try {
      const svg = await QRCode.toString(qr, { type: "svg", margin: 2, width: 256 });
      rt.qrSvg = svg;
      rt.info = "Scan the QR code with WhatsApp on your phone.";
    } catch {
      rt.qrSvg = null;
      rt.info = "Failed to generate QR code.";
    }
    broadcastWhatsAppState(rt);
  });

  client.on("authenticated", () => {
    console.log(prefix, "authenticated. Waiting for client to become ready...");
    rt.state = "authenticated";
    rt.qrSvg = null;
    rt.info = "Authenticated. Loading chats...";
    broadcastWhatsAppState(rt);

    // If the client stays in "authenticated" without reaching "ready", the
    // WhatsApp Web app-state sync has stalled — common after a plain restart
    // (a fresh QR pairing always syncs; a resumed session often hangs).
    // Reloading the page usually kicks the sync back into gear, so try that
    // once before telling the user to re-pair.
    if (rt.readyWatchdog) clearTimeout(rt.readyWatchdog);
    rt.readyWatchdog = setTimeout(() => {
      if (rt.state !== "authenticated") return;
      console.warn(prefix, "not ready 90s after authentication — reloading the WhatsApp Web page to restart app-state sync...");
      (rt.client as any)?.pupPage
        ?.reload({ timeout: 60_000 })
        .catch((e: unknown) => console.error(prefix, "page reload failed:", e));
      rt.readyWatchdog = setTimeout(() => {
        if (rt.state === "authenticated") {
          console.warn(
            `${prefix} still not ready after page reload. ` +
              "The session may be stale — use Logout + Reconnect in the admin panel and scan the QR code again."
          );
        }
      }, 150_000);
    }, 90_000);
  });

  client.on("auth_failure", (msg: string) => {
    rt.state = "auth_failure";
    rt.info = `Authentication failure: ${msg}`;
    writeAuditLog("WA_AUTH_FAILURE", null, `[${rt.key}] ${String(msg).slice(0, 200)}`);
    broadcastWhatsAppState(rt);
  });

  client.on("ready", async () => {
    if (rt.readyWatchdog) {
      clearTimeout(rt.readyWatchdog);
      rt.readyWatchdog = null;
    }
    rt.state = "ready";
    rt.info = "WhatsApp client is ready.";
    rt.qrSvg = null;
    await prisma.whatsAppSession.upsert({
      where: { sessionId: rt.key },
      update: { connected: true, info: rt.info },
      create: { sessionId: rt.key, connected: true, info: rt.info },
    });
    broadcastWhatsAppState(rt);
    rt.ownPushname = (client.info as any)?.pushname || null;
    if (rt.ownPushname) console.log(prefix, "own pushname:", rt.ownPushname);
    // The linked number is read from the session itself (client.info), never
    // from configuration, and surfaced as the account's verified number.
    const wid = (client.info as any)?.wid;
    const verifiedNumber: string | null =
      (typeof wid?.user === "string" && wid.user) ||
      (typeof wid?._serialized === "string" && wid._serialized.includes("@")
        ? wid._serialized.split("@")[0]
        : null) ||
      null;
    if (verifiedNumber) {
      try {
        await prisma.whatsAppAccount.update({
          where: { key: rt.key },
          data: { verifiedNumber },
        });
        console.log(prefix, "verified linked number:", verifiedNumber);
      } catch (e) {
        console.error(prefix, "failed to store verified number:", e);
      }
    }
    let waVersion = "unknown";
    try {
      waVersion = await client.getWWebVersion();
      console.log(prefix, "running WhatsApp Web version:", waVersion);
    } catch {
      // ignore
    }
    writeAuditLog("WA_READY", null, `[${rt.key}] Client ready (WhatsApp Web ${waVersion}).`);
    console.log(prefix, "client ready. Listening for new messages.");
    backfillChats(rt, client).catch((e) => console.error(prefix, "backfill error:", e));
  });

  client.on("disconnected", async (reason: any) => {
    console.log(prefix, "disconnected:", reason);
    writeAuditLog("WA_DISCONNECTED", null, `[${rt.key}] ${String(reason).slice(0, 200)}`);
    if (rt.readyWatchdog) {
      clearTimeout(rt.readyWatchdog);
      rt.readyWatchdog = null;
    }
    rt.state = "disconnected";
    rt.info = `Disconnected: ${reason}`;
    rt.qrSvg = null;
    await prisma.whatsAppSession.upsert({
      where: { sessionId: rt.key },
      update: { connected: false, info: rt.info },
      create: { sessionId: rt.key, connected: false, info: rt.info },
    });
    broadcastWhatsAppState(rt);
  });

  client.on("message_create", async (msg: any) => {
    // Fires for both incoming and outgoing messages
    console.log(prefix, "message_create fired", getMessageId(msg), msg.fromMe);
    await persistMessage(rt, msg, msg.fromMe);
  });

  client.on("message", async (msg: any) => {
    // Incoming messages backup
    console.log(prefix, "message event fired", getMessageId(msg), msg.fromMe);
    await persistMessage(rt, msg, msg.fromMe);
  });

  client.on("change_state", (st: any) => {
    console.log(prefix, "state change:", st);
  });

  rt.client = client;
  try {
    await client.initialize();
  } catch (e) {
    // Tear down the half-initialized client so the next attempt starts clean.
    try {
      await client.destroy();
    } catch {
      // ignore
    }
    rt.client = null;
    throw e;
  }
  return client;
}

/** Initializes every enabled account; one account's failure never affects the others. */
export async function initializeWhatsAppAccounts(): Promise<void> {
  await ensureDefaultAccounts();
  const accounts = await prisma.whatsAppAccount.findMany({ where: { enabled: true } });
  await Promise.allSettled(
    accounts.map((account) =>
      initializeWhatsApp(account.key).catch((err) => {
        console.error(`${logPrefix(account.key)} initialization error:`, err);
      })
    )
  );
}

export async function logoutWhatsApp(accountKey: string = MARHABA_ACCOUNT_KEY) {
  const rt = getRuntime(accountKey);
  if (!rt.client) return;
  try {
    await rt.client.logout();
    await rt.client.destroy();
  } catch (e) {
    console.error(logPrefix(accountKey), "logout error:", e);
  }
  rt.client = null;
  rt.state = "disconnected";
  rt.qrSvg = null;
  rt.info = "Logged out. Re-initializing...";
  broadcastWhatsAppState(rt);
}

// Tears down the current client (without logging out of WhatsApp) and
// re-initializes. Used by the admin "Reconnect" action — calling
// initializeWhatsApp() alone is a no-op while a client instance exists.
export async function restartWhatsApp(accountKey: string = MARHABA_ACCOUNT_KEY) {
  const rt = getRuntime(accountKey);
  if (rt.readyWatchdog) {
    clearTimeout(rt.readyWatchdog);
    rt.readyWatchdog = null;
  }
  if (rt.client) {
    try {
      await rt.client.destroy();
    } catch (e) {
      console.error(logPrefix(accountKey), "destroy error:", e);
    }
    rt.client = null;
  }
  rt.state = "initializing";
  rt.qrSvg = null;
  rt.info = "Re-initializing WhatsApp client...";
  broadcastWhatsAppState(rt);
  return initializeWhatsApp(accountKey);
}

// Tears down the client WITHOUT logging out of WhatsApp and without
// re-initializing. Used when an account is disabled: a disabled account must
// not keep a client (or its browser) running. The session on disk is kept,
// so re-enabling + connect resumes without a new QR pairing.
export async function stopWhatsAppClient(accountKey: string = MARHABA_ACCOUNT_KEY) {
  const rt = getRuntime(accountKey);
  if (rt.readyWatchdog) {
    clearTimeout(rt.readyWatchdog);
    rt.readyWatchdog = null;
  }
  if (rt.client) {
    try {
      await rt.client.destroy();
    } catch (e) {
      console.error(logPrefix(accountKey), "destroy error:", e);
    }
    rt.client = null;
  }
  rt.state = "disconnected";
  rt.qrSvg = null;
  rt.info = "Account disabled. Enable it and use Connect to start it again.";
  broadcastWhatsAppState(rt);
}

export async function sendWhatsAppMessage({
  accountKey = MARHABA_ACCOUNT_KEY,
  remoteJid,
  body,
  type,
  mediaBase64,
  mediaMimeType,
  mediaFilename,
}: {
  accountKey?: string;
  remoteJid: string;
  body?: string;
  type: "text" | "image" | "voice" | "document";
  mediaBase64?: string;
  mediaMimeType?: string;
  mediaFilename?: string;
}) {
  const prefix = logPrefix(accountKey);
  console.log(prefix, "sendWhatsAppMessage called", { remoteJid, type });
  const rt = getRuntime(accountKey);
  if (!rt.client) {
    throw new Error(
      `WhatsApp account "${accountKey}" is not initialized. Connect it under Admin → WhatsApp accounts; the send can be retried on the same account.`
    );
  }
  if (rt.state !== "ready") {
    throw new Error(
      `WhatsApp account "${accountKey}" is not ready (state: ${rt.state}). Pair or reconnect it under Admin → WhatsApp accounts; the send can be retried on the same account.`
    );
  }

  const chatId = remoteJid.includes("@") ? remoteJid : `${remoteJid}@c.us`;

  // Normalize number if needed
  let finalChatId = chatId;
  if (!chatId.includes("@g.us")) {
    let numberId: { _serialized: string } | null | undefined;
    try {
      numberId = await rt.client.getNumberId(chatId.replace("@c.us", ""));
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
      console.log(prefix, "normalized number to", finalChatId);
    }
  }

  let message;
  if (type !== "text" && mediaBase64 && mediaMimeType) {
    const media = new MessageMedia(mediaMimeType, mediaBase64, mediaFilename || "file");
    message = await rt.client.sendMessage(finalChatId, media, {
      caption: body || undefined,
      sendAudioAsVoice: type === "voice",
    });
  } else {
    message = await rt.client.sendMessage(finalChatId, body || "");
  }

  // On newer WhatsApp Web versions sendMessage() can resolve to undefined even
  // though the message was delivered (the message_create event still fires and
  // persists it). Treat a missing return value as success.
  const sentId = getMessageId(message);
  console.log(prefix, "sendWhatsAppMessage sent message id:", sentId);

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
          where: { accountId_remoteJid: { accountId: accountKey, remoteJid: jid } },
          update: { phone: dialed },
          create: { accountId: accountKey, remoteJid: jid, phone: dialed, name: null },
        });
        console.log(prefix, "recorded dialed number", dialed, "for", jid);
      } catch (e) {
        console.error(prefix, "failed to record dialed number for", jid, e);
      }
    }
  }

  return message || { id: sentId };
}

export async function markChatAsRead(accountKey: string, remoteJid: string) {
  const rt = getRuntime(accountKey);
  if (!rt.client || rt.state !== "ready") return;
  try {
    const chat = await rt.client.getChatById(remoteJid);
    await chat.sendSeen();
  } catch (e) {
    console.error(logPrefix(accountKey), "markChatAsRead error:", e);
  }
}

export async function getChatById(client: Client, chatId: string) {
  return client.getChatById(chatId);
}
