/**
 * W2 (perm-docs) persona matrix: one persona per role preset, exercised end to
 * end against EVERY protected surface — the role/permission-gated pages, the
 * inbox APIs, the admin permission API, the travel request API, CLIENT and
 * INTERNAL document downloads, the INTERNAL-document send lock, /uploads/*
 * media (real JWT cookies on a throwaway HTTP server) and the Socket.io
 * channel (real handshake via socket.io-client).
 *
 * Personas (dedicated user rows with unique emails; the per-file DB is never
 * cleaned, and nobody's sessionVersion is ever bumped — tokens minted without
 * an sv claim read as version 0, matching the fresh rows):
 *
 * - waOnly      USER      — preset: whatsapp.inbox.view + whatsapp.inbox.send
 * - travelOnly  ADVISOR   — preset: travel.access/.create/.issue +
 *                           travel.client_docs.download/.send (no whatsapp
 *                           keys, no internal keys)
 * - admin       ADMIN     — preset: every key
 * - noInternal  VALIDATOR — preset: travel.access/.review +
 *                           travel.client_docs.download/.send
 *                           (NO travel.internal.view / travel.internal.download)
 *
 * Per-user grant/deny OVERRIDES on top of these presets are covered in
 * tests/access/api-access.test.ts and tests/permissions/admin-matrix.test.ts;
 * this file pins the bare role presets across the whole surface area. The
 * permissions-migration confirmation Log row is never touched here, so the
 * migration stays unconfirmed for the whole file.
 */

import { createServer, type Server as HttpServer } from "http";
import type { AddressInfo } from "net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { encode } from "next-auth/jwt";
import { Server as SocketIOServer } from "socket.io";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import type { PrismaClient } from "@prisma/client";
import { ensureSchema, getPrisma } from "../travel-db/helpers";
import { actorOf, createRequestInput, seedFixtures, type Fixtures } from "../workflow/fixtures";
import { sendWhatsAppMessage } from "@/lib/whatsapp";
import { handleUploadsRequest, routeUploadsRequest } from "@/lib/uploads";
import { ADMINS_ROOM, INBOX_ROOM, adminsRoom, attachSocketAuth, inboxRoom, socketAllowRequest } from "@/lib/socket-auth";

const SECRET = "persona-matrix-test-secret-min-32-chars!";
process.env.NEXTAUTH_SECRET = SECRET;
process.env.NEXTAUTH_URL = "http://localhost:3000";

const { sessionRef, waState } = vi.hoisted(() => ({
  sessionRef: { current: null as any },
  waState: {
    current: {
      state: "ready",
      qrSvg: "<svg>pm-pairing-qr</svg>",
      info: "WhatsApp client is ready.",
      version: "0.0.0-test",
      startedAt: "2026-09-30T00:00:00.000Z",
    } as Record<string, unknown>,
  },
}));

vi.mock("next-auth/next", () => ({
  getServerSession: vi.fn(async () => sessionRef.current),
}));
vi.mock("@/lib/whatsapp", () => ({
  getWhatsAppState: vi.fn(() => waState.current),
  sendWhatsAppMessage: vi.fn(async () => ({ id: { _serialized: "wamid.pm.1" } })),
  logoutWhatsApp: vi.fn(async () => undefined),
  initializeWhatsApp: vi.fn(async () => ({})),
  restartWhatsApp: vi.fn(async () => ({})),
}));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ providerId: "smtp-test" })) }));
vi.mock("@/lib/travel/pdf/render", () => ({
  renderQuotationPdf: vi.fn(async () => Buffer.from("%PDF-1.4 fake")),
}));

const sendMock = vi.mocked(sendWhatsAppMessage);

type UserRow = { id: string; email: string; name: string | null; role: string };

let prisma: PrismaClient;
let fx: Fixtures;
let workflow: typeof import("@/lib/travel/workflow");

let waOnly: UserRow;
let travelOnly: UserRow;
let admin: UserRow;
let noInternal: UserRow;

let chat: { id: string; remoteJid: string };
let travelRequestId: string;
let clientDoc: { id: string };
let internalDoc: { id: string };

let chatsGET: typeof import("@/app/api/chats/route").GET;
let messagesGET: typeof import("@/app/api/messages/route").GET;
let sendPOST: typeof import("@/app/api/send/route").POST;
let statusGET: typeof import("@/app/api/whatsapp/status/route").GET;
let permissionsGET: typeof import("@/app/api/permissions/route").GET;
let travelRequestsGET: typeof import("@/app/api/travel/requests/route").GET;
let documentGET: typeof import("@/app/api/travel/documents/[id]/route").GET;
let documentSendPOST: typeof import("@/app/api/travel/documents/[id]/send/route").POST;

let HomePage: typeof import("@/app/page").default;
let DashboardPage: typeof import("@/app/dashboard/page").default;
let TravelPage: typeof import("@/app/travel/page").default;
let AdminPage: typeof import("@/app/admin/page").default;
let PermissionsPage: typeof import("@/app/admin/permissions/page").default;

/** Session the way NextAuth returns it (no sv claim: reads as session version 0). */
function login(u: UserRow | null) {
  sessionRef.current = u
    ? { user: { id: u.id, role: u.role, email: u.email, name: u.name }, expires: "2099-01-01" }
    : null;
}

function req(url: string, init?: { method?: string; body?: unknown }) {
  return new NextRequest(url, {
    method: init?.method ?? "GET",
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

/** Runs a page and returns the redirect target, or null when it rendered. */
async function redirectTarget(render: () => Promise<unknown>): Promise<string | null> {
  try {
    await render();
    return null;
  } catch (err: any) {
    if (typeof err?.digest === "string" && err.digest.startsWith("NEXT_REDIRECT")) {
      return err.digest.split(";")[2];
    }
    throw err;
  }
}

const getDoc = (id: string) =>
  documentGET(req(`http://localhost:3000/api/travel/documents/${id}`), { params: Promise.resolve({ id }) });
const postDocSend = (docId: string) =>
  documentSendPOST(
    req(`http://localhost:3000/api/travel/documents/${docId}/send`, {
      method: "POST",
      body: { userIds: [noInternal.id] },
    }),
    { params: Promise.resolve({ id: docId }) },
  );

function mkDoc(versionId: string, kind: string, key: string, file: string) {
  return prisma.quoteDocument.create({
    data: {
      versionId,
      snapshotHash: "0".repeat(64),
      kind,
      templateVersion: "1",
      filePath: file,
      sha256: "abc",
      idempotencyKey: key,
    },
  });
}

function tmpPdf(tag: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `pm-${tag}-`));
  const file = path.join(dir, "doc.pdf");
  writeFileSync(file, "%PDF-1.4 persona-matrix");
  return file;
}

// ---------------------------------------------------------------------------
// Media surface: a throwaway HTTP server mounting the uploads gate exactly the
// way server.ts does, driven by real NextAuth JWT cookies.
// ---------------------------------------------------------------------------

const UPLOAD_DIR = path.join(process.cwd(), "public", "uploads");
const FILE_NAME = `pm-matrix-${process.pid}-${Math.random().toString(36).slice(2, 8)}.txt`;
const FILE_CONTENT = "persona matrix media payload";

let uploadsServer: HttpServer;
let uploadsBaseUrl: string;

async function cookieFor(u: UserRow, maxAge = 60 * 60): Promise<string> {
  const token = await encode({ token: { id: u.id, role: u.role }, secret: SECRET, maxAge });
  return `next-auth.session-token=${token}`;
}

async function uploadGet(pathname: string, cookie?: string) {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  return fetch(`${uploadsBaseUrl}${pathname}`, { method: "GET", headers, redirect: "manual" });
}

// ---------------------------------------------------------------------------
// Socket surface: a real http server + socket.io Server with the production
// allowRequest/auth wiring, driven by socket.io-client with JWT cookies.
// ---------------------------------------------------------------------------

const socketHooks = {
  getWhatsAppState: () => ({
    state: "qr",
    qrSvg: "<svg>pm-socket-qr</svg>",
    info: "pm socket state",
    version: "0.0.0-test",
    startedAt: "2026-09-30T00:00:00.000Z",
  }),
  isConnected: () => false,
};

interface StartedSocketServer {
  sio: SocketIOServer;
  httpServer: HttpServer;
  url: string;
}

let socketServer: StartedSocketServer;
const clients: ClientSocket[] = [];

async function startSocketServer(): Promise<StartedSocketServer> {
  const httpServer = createServer();
  const sio = new SocketIOServer(httpServer, {
    path: "/api/socket",
    allowRequest: socketAllowRequest,
    pingInterval: 3_600_000,
    pingTimeout: 3_600_000,
  });
  attachSocketAuth(sio, socketHooks);
  await new Promise<void>((resolvePromise) => httpServer.listen(0, "127.0.0.1", resolvePromise));
  return { sio, httpServer, url: `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}` };
}

function makeClient(url: string, opts: { cookie?: string; origin?: string }): ClientSocket {
  const extraHeaders: Record<string, string> = {};
  if (opts.origin !== undefined) extraHeaders.Origin = opts.origin;
  if (opts.cookie) extraHeaders.Cookie = opts.cookie;
  const socket = ioClient(url, {
    path: "/api/socket",
    transports: ["websocket"],
    extraHeaders,
    reconnection: false,
    autoConnect: false,
  });
  clients.push(socket);
  return socket;
}

/** Attaches listeners and connects; resolves with "connected" or the connect_error message. */
function connectOutcome(socket: ClientSocket): Promise<string> {
  return new Promise((resolvePromise) => {
    const onConnect = () => {
      socket.off("connect_error", onError);
      resolvePromise("connected");
    };
    const onError = (err: Error) => {
      socket.off("connect", onConnect);
      resolvePromise(err.message);
    };
    socket.once("connect", onConnect);
    socket.once("connect_error", onError);
    socket.connect();
  });
}

function serverSocketFor(sio: SocketIOServer, userId: string) {
  return Array.from(sio.sockets.sockets.values()).find((s) => s.data.user?.userId === userId);
}

async function waitForSocketCount(sio: SocketIOServer, n: number): Promise<void> {
  await vi.waitFor(() => expect(sio.sockets.sockets.size).toBe(n));
}

beforeAll(async () => {
  ensureSchema();
  prisma = await getPrisma();

  // Dynamic imports AFTER every vi.mock above.
  workflow = await import("@/lib/travel/workflow");
  chatsGET = (await import("@/app/api/chats/route")).GET;
  messagesGET = (await import("@/app/api/messages/route")).GET;
  sendPOST = (await import("@/app/api/send/route")).POST;
  statusGET = (await import("@/app/api/whatsapp/status/route")).GET;
  permissionsGET = (await import("@/app/api/permissions/route")).GET;
  travelRequestsGET = (await import("@/app/api/travel/requests/route")).GET;
  documentGET = (await import("@/app/api/travel/documents/[id]/route")).GET;
  documentSendPOST = (await import("@/app/api/travel/documents/[id]/send/route")).POST;
  HomePage = (await import("@/app/page")).default;
  DashboardPage = (await import("@/app/dashboard/page")).default;
  TravelPage = (await import("@/app/travel/page")).default;
  AdminPage = (await import("@/app/admin/page")).default;
  PermissionsPage = (await import("@/app/admin/permissions/page")).default;

  waOnly = await prisma.user.create({ data: { email: "pm-waonly@test.io", name: "WA Only", password: "x", role: "USER" } });
  travelOnly = await prisma.user.create({
    data: { email: "pm-travelonly@test.io", name: "Travel Only", password: "x", role: "ADVISOR" },
  });
  admin = await prisma.user.create({ data: { email: "pm-admin@test.io", name: "Admin", password: "x", role: "ADMIN" } });
  noInternal = await prisma.user.create({
    data: { email: "pm-nointernal@test.io", name: "No Internal", password: "x", role: "VALIDATOR" },
  });

  // Inbox fixtures so the 200 responses carry content.
  chat = await prisma.chat.create({ data: { remoteJid: "37420000099@c.us", name: "PM Chat" } });
  await prisma.message.create({
    data: { chatId: chat.id, remoteJid: chat.remoteJid, whatsappMessageId: "pm-msg-1", fromMe: false, body: "hi", type: "text" },
  });

  // Travel fixtures: a request OWNED by travelOnly (CLIENT record rule passes
  // for them) with noInternal as the assigned validator (record rule passes
  // for the validator without any internal-cost permission).
  fx = await seedFixtures(prisma);
  const created = await workflow.createRequest(actorOf(travelOnly), createRequestInput(fx.agency.id));
  travelRequestId = created.request.id;
  await workflow.assignValidator(actorOf(travelOnly), created.request.id, { validatorId: noInternal.id });
  clientDoc = await mkDoc(created.version.id, "CLIENT", "pm-doc-client", tmpPdf("pm-client"));
  internalDoc = await mkDoc(created.version.id, "INTERNAL", "pm-doc-internal", tmpPdf("pm-internal"));

  // Media server: routeUploadsRequest decides, handleUploadsRequest serves,
  // anything else falls through to a stand-in Next handler.
  mkdirSync(UPLOAD_DIR, { recursive: true });
  writeFileSync(path.join(UPLOAD_DIR, FILE_NAME), FILE_CONTENT);
  uploadsServer = createServer((req, res) => {
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
          console.error("[persona-matrix uploads] error:", err);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Internal error" }));
          } else {
            res.destroy();
          }
        });
        return;
      }
      if (route.kind === "bad-request") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Bad request" }));
        return;
      }
      if (route.kind === "method-not-allowed") {
        res.writeHead(405, { "Content-Type": "application/json", Allow: "GET, HEAD" });
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "next-handler" }));
  });
  await new Promise<void>((resolvePromise) => uploadsServer.listen(0, "127.0.0.1", resolvePromise));
  uploadsBaseUrl = `http://127.0.0.1:${(uploadsServer.address() as AddressInfo).port}`;

  socketServer = await startSocketServer();
});

afterAll(async () => {
  // fetch() keeps sockets alive; close them so server.close() can resolve.
  (uploadsServer as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
  await new Promise<void>((resolvePromise) => uploadsServer.close(() => resolvePromise()));
  rmSync(path.join(UPLOAD_DIR, FILE_NAME), { force: true });

  for (const socket of clients) socket.disconnect();
  socketServer.sio.disconnectSockets(true);
  await socketServer.sio.close();
});

beforeEach(() => {
  login(null);
});

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

describe("page / (role-based redirect)", () => {
  it("admin → /admin; waOnly → /dashboard; travelOnly & noInternal → /travel", async () => {
    login(admin);
    expect(await redirectTarget(() => HomePage())).toBe("/admin");
    login(waOnly);
    expect(await redirectTarget(() => HomePage())).toBe("/dashboard");
    login(travelOnly);
    expect(await redirectTarget(() => HomePage())).toBe("/travel");
    login(noInternal);
    expect(await redirectTarget(() => HomePage())).toBe("/travel");
  });
});

describe("page /dashboard (whatsapp.inbox.view)", () => {
  it("renders for waOnly & admin; travelOnly & noInternal → /travel", async () => {
    login(waOnly);
    expect(await redirectTarget(() => DashboardPage())).toBeNull();
    login(admin);
    expect(await redirectTarget(() => DashboardPage())).toBeNull();
    login(travelOnly);
    expect(await redirectTarget(() => DashboardPage())).toBe("/travel");
    login(noInternal);
    expect(await redirectTarget(() => DashboardPage())).toBe("/travel");
  });
});

describe("page /travel (travel.access + canAccessTravel)", () => {
  it("renders for travelOnly, noInternal & admin; waOnly (no travel.access) → /dashboard", async () => {
    login(travelOnly);
    expect(await redirectTarget(() => TravelPage())).toBeNull();
    login(noInternal);
    expect(await redirectTarget(() => TravelPage())).toBeNull();
    login(admin);
    expect(await redirectTarget(() => TravelPage())).toBeNull();
    login(waOnly);
    expect(await redirectTarget(() => TravelPage())).toBe("/dashboard");
  });
});

describe("page /admin (raw ADMIN role)", () => {
  it("renders for admin only; waOnly, travelOnly & noInternal → /login", async () => {
    login(admin);
    expect(await redirectTarget(() => AdminPage())).toBeNull();
    for (const who of [waOnly, travelOnly, noInternal]) {
      login(who);
      expect(await redirectTarget(() => AdminPage())).toBe("/login");
    }
  });
});

describe("page /admin/permissions (admin.users)", () => {
  it("renders for admin only; waOnly, travelOnly & noInternal → /", async () => {
    login(admin);
    expect(await redirectTarget(() => PermissionsPage())).toBeNull();
    for (const who of [waOnly, travelOnly, noInternal]) {
      login(who);
      expect(await redirectTarget(() => PermissionsPage())).toBe("/");
    }
  });
});

// ---------------------------------------------------------------------------
// Inbox APIs
// ---------------------------------------------------------------------------

describe("GET /api/chats (whatsapp.inbox.view)", () => {
  it("200 with content for waOnly & admin; 403 for travelOnly & noInternal", async () => {
    for (const who of [waOnly, admin]) {
      login(who);
      const res = await chatsGET(req("http://localhost:3000/api/chats"));
      expect(res.status).toBe(200);
      expect((await res.json()).some((c: any) => c.id === chat.id)).toBe(true);
    }
    for (const who of [travelOnly, noInternal]) {
      login(who);
      const res = await chatsGET(req("http://localhost:3000/api/chats"));
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("Forbidden");
    }
  });
});

describe("GET /api/messages (whatsapp.inbox.view)", () => {
  const url = `http://localhost:3000/api/messages?chatId=`;

  it("200 with content for waOnly & admin; 403 for travelOnly & noInternal", async () => {
    for (const who of [waOnly, admin]) {
      login(who);
      const res = await messagesGET(req(`${url}${chat.id}`));
      expect(res.status).toBe(200);
      expect((await res.json()).some((m: any) => m.whatsappMessageId === "pm-msg-1")).toBe(true);
    }
    for (const who of [travelOnly, noInternal]) {
      login(who);
      expect((await messagesGET(req(`${url}${chat.id}`))).status).toBe(403);
    }
  });
});

describe("POST /api/send (whatsapp.inbox.send)", () => {
  const sendReq = () =>
    req("http://localhost:3000/api/send", {
      method: "POST",
      body: { remoteJid: "37420000098@c.us", body: "hello", type: "text" },
    });

  it("200 and a WhatsApp send for waOnly & admin; 403 and nothing sent for travelOnly & noInternal", async () => {
    sendMock.mockClear();
    for (const who of [travelOnly, noInternal]) {
      login(who);
      expect((await sendPOST(sendReq())).status).toBe(403);
    }
    expect(sendMock).not.toHaveBeenCalled();

    for (const who of [waOnly, admin]) {
      login(who);
      expect((await sendPOST(sendReq())).status).toBe(200);
    }
    expect(sendMock).toHaveBeenCalledTimes(2);
  });
});

describe("GET /api/whatsapp/status (whatsapp.admin vs whatsapp.inbox.view)", () => {
  it("admin gets the full state incl. QR; waOnly gets exactly { connected }; travelOnly & noInternal 403", async () => {
    login(admin);
    const full = await statusGET(req("http://localhost:3000/api/whatsapp/status"));
    expect(full.status).toBe(200);
    expect(await full.json()).toEqual({
      state: "ready",
      qrSvg: "<svg>pm-pairing-qr</svg>",
      info: "WhatsApp client is ready.",
      version: "0.0.0-test",
      startedAt: "2026-09-30T00:00:00.000Z",
    });

    login(waOnly);
    const availability = await statusGET(req("http://localhost:3000/api/whatsapp/status"));
    expect(availability.status).toBe(200);
    expect(await availability.json()).toEqual({ connected: true });

    for (const who of [travelOnly, noInternal]) {
      login(who);
      expect((await statusGET(req("http://localhost:3000/api/whatsapp/status"))).status).toBe(403);
    }
  });
});

// ---------------------------------------------------------------------------
// Admin API
// ---------------------------------------------------------------------------

describe("GET /api/permissions (admin.users)", () => {
  it("200 with the full matrix for admin; 403 for waOnly, travelOnly & noInternal", async () => {
    login(admin);
    const res = await permissionsGET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.keys).toHaveLength(17);
    // The migration confirmation Log row is never touched in this file.
    expect(body.internalLocked).toBe(true);
    expect(body.users.some((u: any) => u.id === waOnly.id)).toBe(true);

    for (const who of [waOnly, travelOnly, noInternal]) {
      login(who);
      expect((await permissionsGET()).status).toBe(403);
    }
  });
});

// ---------------------------------------------------------------------------
// Travel API
// ---------------------------------------------------------------------------

describe("GET /api/travel/requests (travel.access)", () => {
  it("200 for travelOnly (own request listed), noInternal & admin; waOnly gets 401 from the guard (not 403)", async () => {
    login(travelOnly);
    const own = await travelRequestsGET(req("http://localhost:3000/api/travel/requests"));
    expect(own.status).toBe(200);
    expect((await own.json()).some((r: any) => r.id === travelRequestId)).toBe(true);

    for (const who of [noInternal, admin]) {
      login(who);
      const res = await travelRequestsGET(req("http://localhost:3000/api/travel/requests"));
      expect(res.status).toBe(200);
      expect(Array.isArray(await res.json())).toBe(true);
    }

    // getTravelActor() collapses every failure (no session, no travel.access,
    // no module access) to the same 401 — a USER without travel.access is
    // "Unauthorized", not "Forbidden".
    login(waOnly);
    const denied = await travelRequestsGET(req("http://localhost:3000/api/travel/requests"));
    expect(denied.status).toBe(401);
    expect((await denied.json()).error).toBe("Unauthorized");
  });
});

// ---------------------------------------------------------------------------
// Document downloads
// ---------------------------------------------------------------------------

describe("GET /api/travel/documents/[id] — CLIENT document (travel.client_docs.download + record rule)", () => {
  it("200 for admin, travelOnly (owner) & noInternal (assigned validator); waOnly 401", async () => {
    for (const who of [admin, travelOnly, noInternal]) {
      login(who);
      const res = await getDoc(clientDoc.id);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/pdf");
    }

    login(waOnly);
    expect((await getDoc(clientDoc.id)).status).toBe(401);
  });
});

describe("GET /api/travel/documents/[id] — INTERNAL document (travel.internal.download, admin-only preset D2)", () => {
  it("200 for admin only; travelOnly & noInternal 403 (no internal keys); waOnly 401", async () => {
    login(admin);
    const res = await getDoc(internalDoc.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");

    // The permission check runs before the record rule, so even the assigned
    // validator (whose role would otherwise pass the INTERNAL record rule) is
    // denied without the travel.internal.download key.
    for (const who of [travelOnly, noInternal]) {
      login(who);
      expect((await getDoc(internalDoc.id)).status).toBe(403);
    }

    login(waOnly);
    expect((await getDoc(internalDoc.id)).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// INTERNAL document send lock
// ---------------------------------------------------------------------------

describe("POST /api/travel/documents/[id]/send — INTERNAL int-lock", () => {
  it("403 for admin, travelOnly (owner) & noInternal (assigned validator); 401 for waOnly; WhatsApp is never touched", async () => {
    sendMock.mockClear();

    login(waOnly);
    expect((await postDocSend(internalDoc.id)).status).toBe(401);

    // The int-lock sits after the record rule: the owner, the assigned
    // validator and ADMIN all reach it and get the same 403.
    for (const who of [admin, travelOnly, noInternal]) {
      login(who);
      const res = await postDocSend(internalDoc.id);
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("INTERNAL documents cannot be sent via WhatsApp");
    }

    expect(sendMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Media (/uploads/*)
// ---------------------------------------------------------------------------

describe("media /uploads/* (whatsapp.inbox.view, real JWT cookies)", () => {
  it("200 with the file content for waOnly & admin; 403 without the content for travelOnly & noInternal", async () => {
    for (const who of [waOnly, admin]) {
      const res = await uploadGet(`/uploads/${FILE_NAME}`, await cookieFor(who));
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("content-type")).toBe("text/plain");
      expect(await res.text()).toBe(FILE_CONTENT);
    }
    for (const who of [travelOnly, noInternal]) {
      const res = await uploadGet(`/uploads/${FILE_NAME}`, await cookieFor(who));
      expect(res.status).toBe(403);
      expect(await res.text()).not.toBe(FILE_CONTENT);
    }
  });
});

// ---------------------------------------------------------------------------
// Sockets (/api/socket)
// ---------------------------------------------------------------------------

describe("socket /api/socket (origin + session + effective-permission rooms)", () => {
  it("waOnly connects into the inbox room only and gets availability { connected } — never the QR", async () => {
    const socket = makeClient(socketServer.url, { cookie: await cookieFor(waOnly), origin: "http://localhost:3000" });
    // Attach BEFORE connecting: the initial whatsapp_state is emitted by the
    // server in the same tick as the CONNECT packet and may arrive batched.
    const statePayloads: any[] = [];
    socket.on("whatsapp_state", (p) => statePayloads.push(p));

    expect(await connectOutcome(socket)).toBe("connected");
    await vi.waitFor(() => expect(statePayloads.length).toBe(1));
    expect(statePayloads[0]).toEqual({ accountKey: "marhaba", connected: false });

    const srv = serverSocketFor(socketServer.sio, waOnly.id);
    expect(srv).toBeDefined();
    expect(Array.from(srv!.rooms).sort()).toEqual([INBOX_ROOM, srv!.id].sort());

    socket.disconnect();
    await waitForSocketCount(socketServer.sio, 0);
  });

  it("admin connects into inbox + admins and receives the full state including qrSvg", async () => {
    const socket = makeClient(socketServer.url, { cookie: await cookieFor(admin), origin: "http://localhost:3000" });
    const statePayloads: any[] = [];
    socket.on("whatsapp_state", (p) => statePayloads.push(p));

    expect(await connectOutcome(socket)).toBe("connected");
    // W3: the ADMIN preset holds both accounts' keys, so the initial state is
    // emitted per account — availability first, then the full state, for
    // marhaba and nare alike.
    await vi.waitFor(() => expect(statePayloads.length).toBe(4));
    expect(statePayloads[1]).toEqual({ accountKey: "marhaba", ...socketHooks.getWhatsAppState() });
    expect(statePayloads[1].qrSvg).toBe("<svg>pm-socket-qr</svg>");

    const srv = serverSocketFor(socketServer.sio, admin.id);
    expect(srv).toBeDefined();
    expect(Array.from(srv!.rooms).sort()).toEqual(
      [ADMINS_ROOM, INBOX_ROOM, adminsRoom("nare"), inboxRoom("nare"), srv!.id].sort(),
    );

    socket.disconnect();
    await waitForSocketCount(socketServer.sio, 0);
  });

  it("travelOnly & noInternal are refused with connect_error \"unauthorized\" (no socket-eligible key)", async () => {
    for (const who of [travelOnly, noInternal]) {
      const outcome = await connectOutcome(
        makeClient(socketServer.url, { cookie: await cookieFor(who), origin: "http://localhost:3000" }),
      );
      expect(outcome).toBe("unauthorized");
    }
    expect(socketServer.sio.sockets.sockets.size).toBe(0);
  });
});
