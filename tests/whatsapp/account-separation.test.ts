/**
 * W3 (wa-multi) end-to-end account-separation matrix for the two WhatsApp
 * business accounts ('marhaba' = inbox account, 'nare' = travel account),
 * driven by FAKE whatsapp-web.js clients (vi.mock — no browser, no network,
 * no live WhatsApp traffic) against a throwaway SQLite database.
 *
 * Unlike tests/whatsapp/travel-send.test.ts (which mocks @/lib/whatsapp
 * wholesale), this file keeps the REAL lib/whatsapp.ts on top of fake
 * whatsapp-web.js Client/LocalAuth classes, so the full path — account gate,
 * client lifecycle, message persistence, room-scoped emits, per-account
 * permissions and the travel notification outbox — is exercised end to end.
 *
 * Matrix:
 *  1. Same customer JID messaging both accounts -> separate Chat and Message
 *     rows per accountId; emits go to inbox:<key> with matching accountKey;
 *     the same whatsappMessageId on both accounts is NOT a dedup collision,
 *     while a true duplicate on the SAME account persists only once.
 *  2. A marhaba-only USER vs a nare-granted user across the chats API
 *     (real route + real permission gate), /uploads media (real NextAuth JWT
 *     cookies against a real HTTP server mounting lib/uploads.ts) and socket
 *     room placement (real socket-auth middleware + connection handler
 *     against fake sockets).
 *  3. One account down (nare logout) leaves marhaba's state, client instance
 *     and sends untouched, while nare sends throw naming the account.
 *  4-8. Travel sends ride the REAL outbox (queueWorkflowEvent +
 *     processNotificationQueue -> lib/whatsapp.sendWhatsAppMessage) against
 *     the fake nare client: nare ready sends; not-ready fails retryable with
 *     the account named and never falls back to marhaba; disabled fails with
 *     TRAVEL_WHATSAPP_ACCOUNT_DISABLED; the retry reuses the account recorded
 *     on the delivery; re-processing a SENT delivery never double-sends (the
 *     dedup key includes the account).
 */

import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import path from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { encode } from "next-auth/jwt";
import type { PrismaClient } from "@prisma/client";
import { ensureSchema, getPrisma } from "../travel-db/helpers";
import {
  actorOf,
  createRequestInput,
  seedFixtures,
  type Fixtures,
} from "../workflow/fixtures";
import { handleUploadsRequest, routeUploadsRequest } from "@/lib/uploads";

const SECRET = "account-separation-test-secret-32chars!!";
process.env.NEXTAUTH_SECRET = SECRET;

const { sessionRef } = vi.hoisted(() => ({ sessionRef: { current: null as any } }));
// The chats API route resolves its session via getServerSession; everything
// below that (requirePermission + the DB user read) stays real.
vi.mock("next-auth/next", () => ({
  getServerSession: vi.fn(async () => sessionRef.current),
}));
// The outbox also mails EMAIL deliveries; only the WHATSAPP channel is under
// test here, so SMTP is stubbed out.
vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn(async () => ({ providerId: "smtp-test" })),
}));

vi.mock("whatsapp-web.js", () => {
  class FakeClient {
    static instances: FakeClient[] = [];
    private static outSeq = 0;

    opts: any;
    authStrategy: any;
    info: any = { pushname: "Test Account", wid: { user: "37400000000", _serialized: "37400000000@c.us" } };
    handlers = new Map<string, Array<(...args: any[]) => unknown>>();
    sentMessages: Array<{ to: string; content: any; options: any }> = [];
    initializeCalls = 0;
    destroyCalls = 0;
    logoutCalls = 0;

    constructor(opts?: any) {
      this.opts = opts;
      this.authStrategy = opts?.authStrategy;
      FakeClient.instances.push(this);
    }

    on(event: string, fn: (...args: any[]) => unknown) {
      const list = this.handlers.get(event) ?? [];
      list.push(fn);
      this.handlers.set(event, list);
    }

    /** Test hook: the real handler lib/whatsapp.ts registered for an event. */
    handler(event: string) {
      const list = this.handlers.get(event);
      if (!list || list.length !== 1) throw new Error(`expected exactly one ${event} handler`);
      return list[0] as (...args: any[]) => Promise<void>;
    }

    async initialize() {
      this.initializeCalls++;
    }
    async destroy() {
      this.destroyCalls++;
    }
    async logout() {
      this.logoutCalls++;
    }
    async getProfilePicUrl() {
      return null;
    }
    async getChats() {
      return [];
    }
    async getWWebVersion() {
      return "2.3000.0-test";
    }
    async getNumberId(number: string) {
      return { _serialized: `${number}@c.us` };
    }
    async sendMessage(to: string, content: any, options?: any) {
      this.sentMessages.push({ to, content, options });
      return { id: { _serialized: `wamid.out.${FakeClient.outSeq++}` }, to };
    }
    async getChatById(_id: string) {
      return { sendSeen: async () => {} };
    }
  }

  class FakeLocalAuth {
    static instances: FakeLocalAuth[] = [];
    opts: any;
    constructor(opts?: any) {
      this.opts = opts ?? {};
      FakeLocalAuth.instances.push(this);
    }
  }

  class FakeMessageMedia {
    constructor(
      public mimetype: string,
      public data: string,
      public filename?: string,
    ) {}
  }

  return { Client: FakeClient, LocalAuth: FakeLocalAuth, MessageMedia: FakeMessageMedia };
});

/**
 * Fake Socket.io server: records every room-scoped emit and captures the
 * handshake middleware / connection handler that attachSocketAuth registers
 * (via wa.setSocketServer), so tests can run real socket authentication and
 * server-managed room placement against fake sockets.
 */
class FakeIo {
  emits: Array<{ room: string; event: string; payload: any }> = [];
  sockets = { sockets: new Map() };
  middleware: ((socket: any, next: (err?: any) => void) => void) | null = null;
  connectionHandler: ((socket: any) => void) | null = null;
  use(fn: any) {
    this.middleware = fn;
  }
  on(event: string, fn: any) {
    if (event === "connection") this.connectionHandler = fn;
  }
  to(room: string) {
    return {
      emit: (event: string, payload: any) => {
        this.emits.push({ room, event, payload });
      },
    };
  }
}

/** Minimal stand-in for a server-side Socket.io socket. */
class FakeSocket {
  data: any = {};
  rooms = new Set<string>();
  emitted: Array<{ event: string; payload: any }> = [];
  private onceHandlers = new Map<string, (...args: any[]) => void>();
  constructor(public request: any) {}
  async join(room: string) {
    this.rooms.add(room);
  }
  async leave(room: string) {
    this.rooms.delete(room);
  }
  emit(event: string, payload: any) {
    this.emitted.push({ event, payload });
  }
  onAny(_fn: any) {}
  once(event: string, fn: any) {
    this.onceHandlers.set(event, fn);
  }
  disconnect(_close?: boolean) {
    this.onceHandlers.get("disconnect")?.();
  }
}

interface FakeMsg {
  id: { _serialized?: string; $1?: string };
  type: string;
  from: string;
  to: string;
  fromMe: boolean;
  timestamp: number;
  body: string;
  hasMedia: boolean;
  getContact: () => Promise<{ pushname: string }>;
  getChat: () => Promise<{ name: string }>;
}

const TIMESTAMP = 1_727_500_000;
const CUSTOMER_JID = "37477000111@c.us";

function fakeIncoming(overrides: Partial<FakeMsg> = {}): FakeMsg {
  return {
    id: { _serialized: "wamid.sep.1" },
    type: "chat",
    from: CUSTOMER_JID,
    to: "37410000001@c.us",
    fromMe: false,
    timestamp: TIMESTAMP,
    body: "hello",
    hasMedia: false,
    getContact: async () => ({ pushname: "Caroline Customer" }),
    getChat: async () => ({ name: "Caroline Customer" }),
    ...overrides,
  };
}

const MARHABA_NUMBER = "37410000001";
const MARHABA_PUSHNAME = "Marhaba Armenia";
const NARE_NUMBER = "37411000000";
const NARE_PUSHNAME = "Nare Travel and Tours";

const UPLOAD_DIR = path.join(process.cwd(), "public", "uploads");
const FLAT_FILE = `w3-sep-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}.txt`;
const FLAT_CONTENT = "marhaba secret media payload";
const NARE_DIR = path.join(UPLOAD_DIR, "nare");
const NARE_FILE = `w3-sep-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}.txt`;
const NARE_CONTENT = "nare secret media payload";

let prisma: PrismaClient;
let wa: typeof import("@/lib/whatsapp");
let workflow: typeof import("@/lib/travel/workflow");
let notifications: typeof import("@/lib/travel/notifications");
let chatsRoute: typeof import("@/app/api/chats/route");
let fakeIo: FakeIo;
let fx: Fixtures;
let server: Server;
let baseUrl: string;

/** Every client instance ever built per account (sends are asserted across instances). */
const clientsByKey: Record<string, any[]> = { marhaba: [], nare: [] };
/** The client instance each account currently runs on. */
const liveClients: Record<string, any> = {};

let marhabaOnly: { id: string; role: string; email: string; name: string | null };
let nareOnly: { id: string; role: string; email: string; name: string | null };

function sendsFor(key: "marhaba" | "nare"): number {
  return clientsByKey[key].reduce((n, c) => n + c.sentMessages.length, 0);
}

async function markReady(key: string, client: any, number: string, pushname: string) {
  liveClients[key] = client;
  client.info = { pushname, wid: { user: number, _serialized: `${number}@c.us` } };
  await client.handler("ready")();
}

/** Brings the account up on a (new) fake client unless it is already ready. */
async function ensureReady(key: "marhaba" | "nare") {
  if (wa.getWhatsAppState(key).state === "ready" && liveClients[key]) return liveClients[key];
  const client: any = await wa.initializeWhatsApp(key);
  clientsByKey[key].push(client);
  await markReady(key, client, key === "nare" ? NARE_NUMBER : MARHABA_NUMBER, key === "nare" ? NARE_PUSHNAME : MARHABA_PUSHNAME);
  return client;
}

function sessionFor(user: { id: string; role: string; email: string; name: string | null } | null) {
  sessionRef.current = user
    ? { user: { id: user.id, role: user.role, email: user.email, name: user.name }, expires: "2099-01-01" }
    : null;
}

async function cookieFor(u: { id: string; role: string }, maxAge = 60 * 60): Promise<string> {
  const token = await encode({ token: { id: u.id, role: u.role }, secret: SECRET, maxAge });
  return `next-auth.session-token=${token}`;
}

async function httpGet(pathname: string, cookie?: string) {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  return fetch(`${baseUrl}${pathname}`, { headers, redirect: "manual" });
}

/** Runs the real socket-auth middleware + connection handler for one cookie. */
async function connectSocket(cookie: string): Promise<FakeSocket> {
  const socket = new FakeSocket({ headers: { cookie } }) as any;
  await new Promise<void>((resolve, reject) => {
    fakeIo.middleware!(socket, (err?: any) => (err ? reject(err) : resolve()));
  });
  fakeIo.connectionHandler!(socket);
  return socket;
}

function releaseSocket(socket: FakeSocket) {
  clearTimeout(socket.data.expiryTimer);
  socket.disconnect(true);
}

/**
 * Queues one SUBMITTED workflow event for the fixture validator (who has a
 * phone on file) through the REAL outbox — the same rows workflow.submit()
 * creates, without needing the full submit machinery.
 */
async function queueTravelEvent() {
  const { request } = await workflow.createRequest(actorOf(fx.advisor), createRequestInput(fx.agency.id));
  const event = await notifications.queueWorkflowEvent(prisma as any, {
    requestId: request.id,
    type: "SUBMITTED",
    actorId: fx.advisor.id,
    payload: {
      packageCode: request.packageCode,
      clientShort: "ACME",
      versionLabel: "v01",
      event: "SUBMITTED",
      actorName: fx.advisor.name ?? "Advisor",
      action: "Validate this quotation",
      link: `http://test.local/travel/requests/${request.id}`,
      timestamp: new Date().toISOString(),
    },
    recipients: [fx.validator],
  });
  const deliveries = await prisma.notificationDelivery.findMany({ where: { eventId: event.id } });
  return { request, event, deliveries };
}

const waRowsOf = (deliveries: any[]) => deliveries.filter((d) => d.channel === "WHATSAPP");

beforeAll(async () => {
  ensureSchema();
  prisma = await getPrisma();
  wa = await import("@/lib/whatsapp");
  workflow = await import("@/lib/travel/workflow");
  notifications = await import("@/lib/travel/notifications");
  chatsRoute = await import("@/app/api/chats/route");

  const { ensureDefaultAccounts } = await import("@/lib/whatsapp-accounts");
  await ensureDefaultAccounts();
  // Nare ships disabled; the matrix needs it enabled except in the dedicated
  // disabled-account case (which restores the flag in a finally).
  await prisma.whatsAppAccount.update({ where: { key: "nare" }, data: { enabled: true } });

  fakeIo = new FakeIo();
  wa.setSocketServer(fakeIo as any);

  fx = await seedFixtures(prisma);

  // Marhaba-only: the USER preset holds whatsapp.inbox.* and nothing nare.
  marhabaOnly = await prisma.user.create({
    data: { email: "sep-marhaba-only@test.io", name: "Marhaba Only", password: "x", role: "USER" },
  });
  // Nare-only: the ADVISOR preset holds no inbox keys; the single nare view
  // grant opens the nare inbox/media/socket room and nothing of marhaba's.
  nareOnly = await prisma.user.create({
    data: { email: "sep-nare-only@test.io", name: "Nare Only", password: "x", role: "ADVISOR" },
  });
  await prisma.userPermission.create({ data: { userId: nareOnly.id, key: "whatsapp.nare.view", allowed: true } });

  mkdirSync(NARE_DIR, { recursive: true });
  writeFileSync(path.join(UPLOAD_DIR, FLAT_FILE), FLAT_CONTENT);
  writeFileSync(path.join(NARE_DIR, NARE_FILE), NARE_CONTENT);

  // Mirror the server.ts wiring: routeUploadsRequest decides, the media gate
  // handles, anything else falls through to a stand-in Next handler.
  server = createServer((req, res) => {
    let pathname: string | null = null;
    try {
      pathname = req.url ? new URL(req.url, "http://localhost").pathname : null;
    } catch {
      pathname = null;
    }
    if (pathname) {
      const route = routeUploadsRequest(req.method ?? "", pathname);
      if (route.kind === "handle") {
        handleUploadsRequest(req, res, pathname).catch((err) => {
          console.error("[test uploads] error:", err);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Internal error" }));
          } else {
            res.destroy();
          }
        });
        return;
      }
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "next-handler" }));
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  sessionFor(null);
  await wa.stopWhatsAppClient("marhaba").catch(() => {});
  await wa.stopWhatsAppClient("nare").catch(() => {});
  (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  rmSync(path.join(UPLOAD_DIR, FLAT_FILE), { force: true });
  rmSync(path.join(NARE_DIR, NARE_FILE), { force: true });
  try {
    // Plain rmdir: removes the nare subdir only when we were its only writer.
    rmSync(NARE_DIR);
  } catch {
    // Another suite's files live here — leave them untouched.
  }
});

describe("1. same customer JID on both accounts", () => {
  it("persists per-account chats/messages, scopes emits per account room, and dedups per account only", async () => {
    await ensureReady("marhaba");
    await ensureReady("nare");
    fakeIo.emits.length = 0;

    // A true duplicate on the SAME account (the message_create + message
    // events both firing) is persisted and emitted only once.
    const dup = fakeIncoming({ id: { _serialized: "wamid.shared.1" }, body: "hello marhaba" });
    await liveClients.marhaba.handler("message")(dup);
    await liveClients.marhaba.handler("message")(dup);

    // The SAME customer JID with the SAME whatsappMessageId on the other
    // account is not a collision: identity is (accountId, whatsappMessageId).
    await liveClients.nare.handler("message")(
      fakeIncoming({ id: { _serialized: "wamid.shared.1" }, body: "hello nare", to: `${NARE_NUMBER}@c.us` }),
    );

    const chats = await prisma.chat.findMany({ where: { remoteJid: CUSTOMER_JID } });
    expect(chats).toHaveLength(2);
    const chatByAccount = new Map(chats.map((c) => [c.accountId, c]));
    expect(chatByAccount.get("marhaba")).toBeTruthy();
    expect(chatByAccount.get("nare")).toBeTruthy();
    expect(chatByAccount.get("marhaba")!.id).not.toBe(chatByAccount.get("nare")!.id);

    const messages = await prisma.message.findMany({ where: { whatsappMessageId: "wamid.shared.1" } });
    expect(messages).toHaveLength(2);
    expect(new Set(messages.map((m) => m.accountId))).toEqual(new Set(["marhaba", "nare"]));
    expect(messages.find((m) => m.accountId === "marhaba")!.body).toBe("hello marhaba");
    expect(messages.find((m) => m.accountId === "nare")!.body).toBe("hello nare");
    expect(messages.find((m) => m.accountId === "marhaba")!.chatId).toBe(chatByAccount.get("marhaba")!.id);
    expect(messages.find((m) => m.accountId === "nare")!.chatId).toBe(chatByAccount.get("nare")!.id);

    // Live events: exactly one 'message' emit per account (the same-account
    // duplicate emitted nothing), to that account's inbox room only, each
    // payload carrying the matching accountKey — no cross-account leakage.
    const messageEmits = fakeIo.emits.filter(
      (e) => e.event === "message" && e.payload?.whatsappMessageId === "wamid.shared.1",
    );
    expect(messageEmits).toHaveLength(2);
    const marhabaEmit = messageEmits.find((e) => e.room === "inbox:marhaba");
    const nareEmit = messageEmits.find((e) => e.room === "inbox:nare");
    expect(marhabaEmit).toBeTruthy();
    expect(marhabaEmit!.payload.accountKey).toBe("marhaba");
    expect(marhabaEmit!.payload.body).toBe("hello marhaba");
    expect(nareEmit).toBeTruthy();
    expect(nareEmit!.payload.accountKey).toBe("nare");
    expect(nareEmit!.payload.body).toBe("hello nare");
    expect(messageEmits.every((e) => e.room === `inbox:${e.payload.accountKey}`)).toBe(true);

    const chatUpdates = fakeIo.emits.filter(
      (e) => e.event === "chat_update" && e.payload?.remoteJid === CUSTOMER_JID,
    );
    expect(chatUpdates).toHaveLength(2);
    expect(chatUpdates.every((e) => e.room === `inbox:${e.payload.accountKey}`)).toBe(true);
  });
});

describe("2. marhaba-only user vs nare-permitted user", () => {
  it("the chats API requires each account's own view permission", async () => {
    sessionFor(marhabaOnly);
    const marhabaList = await chatsRoute.GET(new NextRequest("http://t/api/chats"));
    expect(marhabaList.status).toBe(200);
    const marhabaOnNare = await chatsRoute.GET(new NextRequest("http://t/api/chats?account=nare"));
    expect(marhabaOnNare.status).toBe(403);

    sessionFor(nareOnly);
    const nareList = await chatsRoute.GET(new NextRequest("http://t/api/chats?account=nare"));
    expect(nareList.status).toBe(200);
    const nareOnMarhaba = await chatsRoute.GET(new NextRequest("http://t/api/chats"));
    expect(nareOnMarhaba.status).toBe(403);

    sessionFor(null);
  });

  it("media under /uploads/<account>/ requires that account's view permission", async () => {
    // Marhaba-only USER: 200 on the flat (marhaba) file, 403 on nare media.
    const flatAsMarhaba = await httpGet(`/uploads/${FLAT_FILE}`, await cookieFor(marhabaOnly));
    expect(flatAsMarhaba.status).toBe(200);
    expect(await flatAsMarhaba.text()).toBe(FLAT_CONTENT);
    const nareAsMarhaba = await httpGet(`/uploads/nare/${NARE_FILE}`, await cookieFor(marhabaOnly));
    expect(nareAsMarhaba.status).toBe(403);
    expect(await nareAsMarhaba.text()).not.toBe(NARE_CONTENT);

    // Nare-granted user: 200 on nare media, 403 on the flat marhaba file.
    const nareAsNare = await httpGet(`/uploads/nare/${NARE_FILE}`, await cookieFor(nareOnly));
    expect(nareAsNare.status).toBe(200);
    expect(await nareAsNare.text()).toBe(NARE_CONTENT);
    expect(nareAsNare.headers.get("cache-control")).toBe("private, no-store");
    const flatAsNare = await httpGet(`/uploads/${FLAT_FILE}`, await cookieFor(nareOnly));
    expect(flatAsNare.status).toBe(403);
    expect(await flatAsNare.text()).not.toBe(FLAT_CONTENT);
  });

  it("the socket handshake places each user in exactly their account's rooms", async () => {
    const marhabaSocket = await connectSocket(await cookieFor(marhabaOnly));
    try {
      expect(marhabaSocket.rooms.has("inbox:marhaba")).toBe(true);
      expect(marhabaSocket.rooms.has("inbox:nare")).toBe(false);
      expect(marhabaSocket.rooms.has("admins:marhaba")).toBe(false);
      expect(marhabaSocket.rooms.has("admins:nare")).toBe(false);
      // Availability only, and only for marhaba — no nare payload, no QR state.
      expect(marhabaSocket.emitted.length).toBeGreaterThan(0);
      expect(marhabaSocket.emitted.every((e) => e.event === "whatsapp_state")).toBe(true);
      expect(marhabaSocket.emitted.every((e) => e.payload?.accountKey === "marhaba")).toBe(true);
      expect(marhabaSocket.emitted.every((e) => !("qrSvg" in (e.payload ?? {})))).toBe(true);
    } finally {
      releaseSocket(marhabaSocket);
    }

    const nareSocket = await connectSocket(await cookieFor(nareOnly));
    try {
      expect(nareSocket.rooms.has("inbox:nare")).toBe(true);
      expect(nareSocket.rooms.has("inbox:marhaba")).toBe(false);
      expect(nareSocket.rooms.has("admins:nare")).toBe(false);
      expect(nareSocket.rooms.has("admins:marhaba")).toBe(false);
      expect(nareSocket.emitted.length).toBeGreaterThan(0);
      expect(nareSocket.emitted.every((e) => e.payload?.accountKey === "nare")).toBe(true);
    } finally {
      releaseSocket(nareSocket);
    }
  });
});

describe("3. one account down while the other works", () => {
  it("logout of nare leaves marhaba's state and client untouched; marhaba still sends, nare sends throw", async () => {
    await ensureReady("marhaba");
    await ensureReady("nare");
    const before = wa.getWhatsAppState("marhaba");
    const marhabaClient = liveClients.marhaba;
    const nareClient = liveClients.nare;
    const marhabaSendsBefore = sendsFor("marhaba");

    await wa.logoutWhatsApp("nare");

    expect(nareClient.logoutCalls).toBe(1);
    expect(wa.getWhatsAppState("nare").state).toBe("disconnected");
    expect(wa.getWhatsAppState("marhaba")).toEqual(before);
    expect(marhabaClient.logoutCalls).toBe(0);
    expect(marhabaClient.destroyCalls).toBe(0);

    await wa.sendWhatsAppMessage({
      accountKey: "marhaba",
      remoteJid: "37499000099@c.us",
      body: "marhaba alive after nare logout",
      type: "text",
    });
    expect(sendsFor("marhaba")).toBe(marhabaSendsBefore + 1);
    expect(marhabaClient.sentMessages[marhabaClient.sentMessages.length - 1].content).toBe(
      "marhaba alive after nare logout",
    );

    await expect(
      wa.sendWhatsAppMessage({ accountKey: "nare", remoteJid: "37499000099@c.us", body: "x", type: "text" }),
    ).rejects.toThrow(/WhatsApp account "nare" is not initialized/);
  });
});

describe("4-8. travel sends through the nare account (real outbox, fake clients)", () => {
  // Cases 5 and 7 share the not-ready delivery rows (7 retries 5's rows).
  let notReadyEventId: string;

  it("4. travel send with nare ready: the fake nare client receives it and the delivery records accountId 'nare'", async () => {
    await ensureReady("marhaba");
    await ensureReady("nare");
    const { event, deliveries } = await queueTravelEvent();
    const waRows = waRowsOf(deliveries);
    expect(waRows.length).toBeGreaterThan(0);
    for (const d of waRows) {
      expect(d.accountId).toBe("nare");
      expect(d.dedupKey).toBe(`nare:${event.id}:${d.recipientId}:WHATSAPP`);
    }

    const nareBefore = sendsFor("nare");
    const marhabaBefore = sendsFor("marhaba");
    await notifications.processNotificationQueue({ limit: 100 });

    expect(sendsFor("nare")).toBe(nareBefore + waRows.length);
    expect(sendsFor("marhaba")).toBe(marhabaBefore); // never a marhaba fallback
    const nareSent = liveClients.nare.sentMessages;
    expect(nareSent.some((m: any) => m.to === `${fx.validator.phone}@c.us`)).toBe(true);

    const rows = await prisma.notificationDelivery.findMany({
      where: { eventId: event.id, channel: "WHATSAPP" },
    });
    expect(rows.every((d) => d.status === "SENT" && d.accountId === "nare")).toBe(true);
  });

  it("5. travel send with nare not ready: fails naming the account, stays retryable, marhaba receives nothing", async () => {
    await ensureReady("marhaba");
    // Nare enabled but its client torn down: sendWhatsAppMessage must throw
    // 'not initialized' naming the account.
    await wa.stopWhatsAppClient("nare");
    const stoppedNare = liveClients.nare;
    const stoppedNareSends = stoppedNare.sentMessages.length;

    const { event, deliveries } = await queueTravelEvent();
    notReadyEventId = event.id;
    const waRows = waRowsOf(deliveries);
    expect(waRows.length).toBeGreaterThan(0);

    const nareBefore = sendsFor("nare");
    const marhabaBefore = sendsFor("marhaba");
    await notifications.processNotificationQueue({ limit: 100 });

    const rows = await prisma.notificationDelivery.findMany({
      where: { eventId: event.id, channel: "WHATSAPP" },
    });
    for (const d of rows) {
      expect(d.status).toBe("FAILED");
      expect(d.lastError).toContain("not initialized");
      expect(d.lastError).toContain('"nare"');
      expect(d.accountId).toBe("nare");
      expect(d.attempts).toBeLessThan(3); // below the retry cap: still retryable
    }
    expect(sendsFor("nare")).toBe(nareBefore);
    expect(stoppedNare.sentMessages).toHaveLength(stoppedNareSends); // the torn-down client sent nothing
    expect(sendsFor("marhaba")).toBe(marhabaBefore); // no fallback to marhaba
  });

  it("6. travel send with nare disabled: TRAVEL_WHATSAPP_ACCOUNT_DISABLED and no send on either client", async () => {
    await prisma.whatsAppAccount.update({ where: { key: "nare" }, data: { enabled: false } });
    let eventId: string | null = null;
    try {
      const { event, deliveries } = await queueTravelEvent();
      eventId = event.id;
      expect(waRowsOf(deliveries).length).toBeGreaterThan(0);

      const nareBefore = sendsFor("nare");
      const marhabaBefore = sendsFor("marhaba");
      await notifications.processNotificationQueue({ limit: 100 });

      const rows = await prisma.notificationDelivery.findMany({
        where: { eventId: event.id, channel: "WHATSAPP" },
      });
      expect(rows.length).toBeGreaterThan(0);
      for (const d of rows) {
        expect(d.status).toBe("FAILED");
        expect(d.lastError).toContain("TRAVEL_WHATSAPP_ACCOUNT_DISABLED");
        expect(d.lastError).toContain("nare");
      }
      expect(sendsFor("nare")).toBe(nareBefore);
      expect(sendsFor("marhaba")).toBe(marhabaBefore);
    } finally {
      await prisma.whatsAppAccount.update({ where: { key: "nare" }, data: { enabled: true } });
      // Leave no retryable rows behind: later sweeps must only see their own.
      if (eventId) await prisma.notificationDelivery.deleteMany({ where: { eventId } });
    }
  });

  it("7. retry after the not-ready failure reuses the SAME account (nare), still nothing on marhaba", async () => {
    const nare = await ensureReady("nare"); // back up on a fresh fake client
    const marhabaBefore = sendsFor("marhaba");
    const nareBefore = sendsFor("nare");

    // What POST /api/travel/notifications/retry does: FAILED -> QUEUED.
    const failedRows = await prisma.notificationDelivery.findMany({
      where: { eventId: notReadyEventId, channel: "WHATSAPP" },
    });
    expect(failedRows.length).toBeGreaterThan(0);
    expect(failedRows.every((d) => d.status === "FAILED" && d.accountId === "nare")).toBe(true);
    await prisma.notificationDelivery.updateMany({
      where: { id: { in: failedRows.map((d) => d.id) } },
      data: { status: "QUEUED", lastError: null },
    });

    await notifications.processNotificationQueue({ limit: 100 });

    expect(sendsFor("nare")).toBe(nareBefore + failedRows.length);
    expect(sendsFor("marhaba")).toBe(marhabaBefore);
    expect(nare.sentMessages.some((m: any) => m.to === `${fx.validator.phone}@c.us`)).toBe(true);

    for (const d of failedRows) {
      const row = await prisma.notificationDelivery.findUnique({ where: { id: d.id } });
      // The SAME delivery row succeeded through the SAME recorded account.
      expect(row?.status).toBe("SENT");
      expect(row?.accountId).toBe("nare");
      expect(row?.lastError).toBeNull();
    }
  });

  it("8. no duplicate: re-processing a SENT delivery sends nothing again and the dedup key rejects a second row", async () => {
    await ensureReady("nare");
    const { event, deliveries } = await queueTravelEvent();
    const waRows = waRowsOf(deliveries);
    expect(waRows.length).toBeGreaterThan(0);

    await notifications.processNotificationQueue({ limit: 100 });
    const nareAfterFirst = sendsFor("nare");
    // This event's body is unique (it carries the fresh request's package
    // code), so counting sends with this exact content isolates this event
    // from earlier cases that sent to the same validator phone.
    const body = waRows[0].body;
    const sendsOfThisEvent = () =>
      clientsByKey.nare.reduce((n, c) => n + c.sentMessages.filter((m: any) => m.content === body).length, 0);
    expect(sendsOfThisEvent()).toBe(1);

    // SENT rows are never candidates again: a second sweep sends nothing.
    await notifications.processNotificationQueue({ limit: 100 });
    expect(sendsFor("nare")).toBe(nareAfterFirst);
    expect(sendsOfThisEvent()).toBe(1);

    // Exactly one delivery row exists per event+recipient+channel, and the
    // dedup key (prefixed with the account) makes a second row impossible.
    const rows = await prisma.notificationDelivery.findMany({
      where: { eventId: event.id, channel: "WHATSAPP", recipientId: fx.validator.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("SENT");
    expect(rows[0].dedupKey).toBe(`nare:${event.id}:${fx.validator.id}:WHATSAPP`);
    await expect(
      prisma.notificationDelivery.create({
        data: {
          eventId: event.id,
          recipientId: fx.validator.id,
          channel: "WHATSAPP",
          destination: rows[0].destination,
          dedupKey: rows[0].dedupKey,
          accountId: "nare",
          body: rows[0].body,
        },
      }),
    ).rejects.toThrow();
    expect(sendsOfThisEvent()).toBe(1);
  });
});
