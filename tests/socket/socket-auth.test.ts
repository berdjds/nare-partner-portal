/**
 * Socket.io channel tests (W1, sock-auth): lib/socket-auth.ts wired onto an
 * in-process http server + socket.io, driven by real socket.io-client
 * connections with REAL NextAuth JWT cookies (next-auth/jwt encode/decode
 * against NEXTAUTH_SECRET) and the seeded throwaway DB — so the whole gate is
 * exercised end to end:
 *
 *  - origin gate (allowRequest): only the exact origin of NEXTAUTH_URL plus
 *    SOCKET_ALLOWED_ORIGINS entries connect; anything else — including a
 *    missing Origin header — is refused before the Socket.io handshake runs.
 *  - session gate (io.use): anonymous, forged, expired, deactivated and
 *    travel-only (ADVISOR/VALIDATOR) sessions are refused with the
 *    "unauthorized" connect_error the client hook matches on.
 *  - room scoping: the server joins 'inbox' (ADMIN/USER) and 'admins' (ADMIN
 *    only); inbox users receive message/chat_update and availability
 *    { connected } but never the full whatsapp_state (info/qrSvg); admins do.
 *  - no client-to-server surface: emitting join/subscribe/send-style events
 *    gains no room and triggers no action (ignored + logged via onAny).
 *  - revalidation: a token's exp disconnects the socket, and the 60s loop
 *    disconnects on deactivation or loss of inbox access; a promotion
 *    (USER -> ADMIN) re-syncs room membership instead (fake timers).
 *  - W2 permission model (perm-inbox): the handshake, room assignment and the
 *    60s revalidation all follow the CURRENT effective permissions
 *    (role preset + UserPermission grants − denies, deny always wins) instead
 *    of the bare role — per-user grants of whatsapp.inbox.view /
 *    whatsapp.admin open the socket and rooms, denies close them.
 */

import { createServer, type Server as HttpServer } from "http";
import type { AddressInfo } from "net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Server as SocketIOServer } from "socket.io";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { encode } from "next-auth/jwt";
import type { PrismaClient } from "@prisma/client";
import { ensureSchema, getPrisma } from "../travel-db/helpers";
import { revokeAllSessions } from "@/lib/access-policy";
import {
  ADMINS_ROOM,
  INBOX_ROOM,
  allowedSocketOrigins,
  attachSocketAuth,
  isSocketOriginAllowed,
  socketAllowRequest,
} from "@/lib/socket-auth";

const SECRET = "socket-auth-test-secret-min-32-characters!";
process.env.NEXTAUTH_SECRET = SECRET;
process.env.NEXTAUTH_URL = "http://localhost:3000";

// Stand-in for lib/whatsapp.ts state: the real payloads are injected as hooks
// by setSocketServer(); here the test drives them directly.
let fakeWaState = "qr";
const hooks = {
  getWhatsAppState: () => ({
    state: fakeWaState,
    qrSvg: "<svg>fake-pairing-qr</svg>",
    info: `fake state: ${fakeWaState}`,
    version: "0.0.0-test",
    startedAt: "2026-09-29T00:00:00.000Z",
  }),
  isConnected: () => fakeWaState === "ready",
};

interface StartedServer {
  sio: SocketIOServer;
  httpServer: HttpServer;
  url: string;
}

async function startServer(): Promise<StartedServer> {
  const httpServer = createServer();
  const sio = new SocketIOServer(httpServer, {
    path: "/api/socket",
    allowRequest: socketAllowRequest,
    // Heartbeats must not interfere with fake-timer advances: tests advance
    // the clock by minutes, and the engine.io client adopts these handshake
    // values for its own ping-timeout timer.
    pingInterval: 3_600_000,
    pingTimeout: 3_600_000,
  });
  attachSocketAuth(sio, hooks);
  await new Promise<void>((resolvePromise) => httpServer.listen(0, "127.0.0.1", resolvePromise));
  return { sio, httpServer, url: `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}` };
}

async function stopServer({ sio }: StartedServer): Promise<void> {
  // io.close() is async in socket.io v4: it disconnects every socket, closes
  // the engine AND the attached http server.
  sio.disconnectSockets(true);
  await sio.close();
}

let prisma: PrismaClient;
let shared: StartedServer;
const clients: ClientSocket[] = [];

let admin: { id: string; role: string };
let user: { id: string; role: string };
let advisor: { id: string; role: string };
let validator: { id: string; role: string };
let inactive: { id: string; role: string };

async function cookieFor(u: { id: string; role: string }, maxAge = 60 * 60, sv?: number): Promise<string> {
  const token = await encode({
    token: { id: u.id, role: u.role, ...(sv !== undefined ? { sv } : {}) },
    secret: SECRET,
    maxAge,
  });
  return `next-auth.session-token=${token}`;
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

// Captured at module load, BEFORE any test installs fake timers: the guard
// timeout inside waitDisconnect must stay a REAL timer. The fake clock is
// frozen while real time passes, so a fake 5s guard would fire at fake T+5s —
// in the middle of vi.advanceTimersByTimeAsync(60_000), long before the 60s
// revalidation interval it guards — and reject "timed out" even though the
// disconnect arrives a moment later.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

function waitDisconnect(socket: ClientSocket, timeoutMs = 5000): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = realSetTimeout(() => rejectPromise(new Error("timed out waiting for disconnect")), timeoutMs);
    socket.once("disconnect", (reason) => {
      realClearTimeout(timer);
      resolvePromise(reason);
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function serverSocketFor(sio: SocketIOServer, userId: string) {
  return Array.from(sio.sockets.sockets.values()).find((s) => s.data.user?.userId === userId);
}

async function waitForSocketCount(sio: SocketIOServer, n: number): Promise<void> {
  await vi.waitFor(() => expect(sio.sockets.sockets.size).toBe(n));
}

beforeAll(async () => {
  ensureSchema();
  prisma = await getPrisma();

  admin = await prisma.user.create({ data: { email: "sock-admin@test.io", name: "Admin", password: "x", role: "ADMIN" } });
  user = await prisma.user.create({ data: { email: "sock-user@test.io", name: "User", password: "x", role: "USER" } });
  advisor = await prisma.user.create({ data: { email: "sock-advisor@test.io", name: "Advisor", password: "x", role: "ADVISOR" } });
  validator = await prisma.user.create({ data: { email: "sock-validator@test.io", name: "Validator", password: "x", role: "VALIDATOR" } });
  inactive = await prisma.user.create({
    data: { email: "sock-inactive@test.io", name: "Inactive", password: "x", role: "USER", active: false },
  });

  shared = await startServer();
});

afterAll(async () => {
  for (const socket of clients) socket.disconnect();
  await stopServer(shared);
});

describe("origin gate (allowRequest)", () => {
  it("refuses a disallowed Origin even with a valid session", async () => {
    const outcome = await connectOutcome(makeClient(shared.url, { cookie: await cookieFor(user), origin: "https://evil.example" }));
    expect(outcome).not.toBe("connected");
    expect(shared.sio.sockets.sockets.size).toBe(0);
  });

  it("refuses a missing Origin header", async () => {
    const outcome = await connectOutcome(makeClient(shared.url, { cookie: await cookieFor(user) }));
    expect(outcome).not.toBe("connected");
    expect(shared.sio.sockets.sockets.size).toBe(0);
  });

  it("accepts the exact origin of NEXTAUTH_URL", async () => {
    const socket = makeClient(shared.url, { cookie: await cookieFor(user), origin: "http://localhost:3000" });
    expect(await connectOutcome(socket)).toBe("connected");
    socket.disconnect();
    await waitForSocketCount(shared.sio, 0);
  });

  it("accepts origins listed in SOCKET_ALLOWED_ORIGINS (dev) and nothing else", async () => {
    const previous = process.env.SOCKET_ALLOWED_ORIGINS;
    process.env.SOCKET_ALLOWED_ORIGINS = "http://localhost:5173, http://127.0.0.1:5500";
    try {
      const allowedSocket = makeClient(shared.url, { cookie: await cookieFor(user), origin: "http://localhost:5173" });
      expect(await connectOutcome(allowedSocket)).toBe("connected");
      allowedSocket.disconnect();
      await waitForSocketCount(shared.sio, 0);

      const nearMiss = await connectOutcome(makeClient(shared.url, { cookie: await cookieFor(user), origin: "http://localhost:5174" }));
      expect(nearMiss).not.toBe("connected");
    } finally {
      if (previous === undefined) delete process.env.SOCKET_ALLOWED_ORIGINS;
      else process.env.SOCKET_ALLOWED_ORIGINS = previous;
    }
  });
});

describe("session gate (io.use handshake)", () => {
  it("refuses anonymous connections", async () => {
    expect(await connectOutcome(makeClient(shared.url, { origin: "http://localhost:3000" }))).toBe("unauthorized");
    expect(shared.sio.sockets.sockets.size).toBe(0);
  });

  it("refuses a forged session token", async () => {
    const outcome = await connectOutcome(
      makeClient(shared.url, { cookie: "next-auth.session-token=not.a.jwe", origin: "http://localhost:3000" })
    );
    expect(outcome).toBe("unauthorized");
  });

  it("refuses an expired session token", async () => {
    const outcome = await connectOutcome(
      makeClient(shared.url, { cookie: await cookieFor(user, -3600), origin: "http://localhost:3000" })
    );
    expect(outcome).toBe("unauthorized");
  });

  it("refuses a deactivated user with a valid unexpired token", async () => {
    const outcome = await connectOutcome(
      makeClient(shared.url, { cookie: await cookieFor(inactive), origin: "http://localhost:3000" })
    );
    expect(outcome).toBe("unauthorized");
  });

  it("refuses ADVISOR and VALIDATOR (their presets hold no socket-eligible permission)", async () => {
    for (const who of [advisor, validator]) {
      const outcome = await connectOutcome(
        makeClient(shared.url, { cookie: await cookieFor(who), origin: "http://localhost:3000" })
      );
      expect(outcome).toBe("unauthorized");
    }
    expect(shared.sio.sockets.sockets.size).toBe(0);
  });

  it("refuses a token whose sv no longer matches the user's session version; the current sv connects (W1b)", async () => {
    // Dedicated user: the shared fixtures above are reused by other suites.
    const bumped = await prisma.user.create({
      data: { email: "sock-bumped@test.io", name: "Bumped", password: "x", role: "USER" },
    });
    // Revoke all issued sessions: bump User.sessionVersion atomically (the
    // same { increment: 1 } update revokeAllSessions performs).
    await prisma.user.update({ where: { id: bumped.id }, data: { sessionVersion: { increment: 1 } } });

    // A stale sv claim (minted before the revocation) is refused.
    const stale = await connectOutcome(
      makeClient(shared.url, { cookie: await cookieFor(bumped, 60 * 60, 0), origin: "http://localhost:3000" })
    );
    expect(stale).toBe("unauthorized");
    expect(shared.sio.sockets.sockets.size).toBe(0);

    // A pre-W1b token with no sv claim at all counts as 0 — a real version,
    // not a bypass — so the revocation revokes it like any other stale token.
    const legacy = await connectOutcome(
      makeClient(shared.url, { cookie: await cookieFor(bumped), origin: "http://localhost:3000" })
    );
    expect(legacy).toBe("unauthorized");
    expect(shared.sio.sockets.sockets.size).toBe(0);

    const socket = makeClient(shared.url, { cookie: await cookieFor(bumped, 60 * 60, 1), origin: "http://localhost:3000" });
    expect(await connectOutcome(socket)).toBe("connected");
    socket.disconnect();
    await waitForSocketCount(shared.sio, 0);
  });
});

describe("room scoping and payloads", () => {
  it("USER joins 'inbox' only, receives message/chat_update and { connected }, never info or qrSvg", async () => {
    const socket = makeClient(shared.url, { cookie: await cookieFor(user), origin: "http://localhost:3000" });
    // Attach BEFORE connecting: the initial whatsapp_state is emitted by the
    // server in the same tick as the CONNECT packet and may be delivered
    // batched with it.
    const statePayloads: any[] = [];
    const messages: any[] = [];
    const chatUpdates: any[] = [];
    const adminOnly: any[] = [];
    socket.on("whatsapp_state", (p) => statePayloads.push(p));
    socket.on("message", (p) => messages.push(p));
    socket.on("chat_update", (p) => chatUpdates.push(p));
    socket.on("admin_only_probe", (p) => adminOnly.push(p));

    expect(await connectOutcome(socket)).toBe("connected");

    // Initial state: availability only, as the exact payload.
    await vi.waitFor(() => expect(statePayloads.length).toBe(1));
    expect(statePayloads[0]).toEqual({ connected: false });

    const srv = serverSocketFor(shared.sio, user.id);
    expect(srv).toBeDefined();
    expect(Array.from(srv!.rooms).sort()).toEqual([INBOX_ROOM, srv!.id].sort());

    // What lib/whatsapp.ts emits: inbox rooms get content, admins get the rest.
    shared.sio.to(INBOX_ROOM).emit("message", { id: "m1", body: "hello" });
    shared.sio.to(INBOX_ROOM).emit("chat_update", { id: "c1", backfill: false });
    shared.sio.to(ADMINS_ROOM).emit("whatsapp_state", hooks.getWhatsAppState());
    shared.sio.to(ADMINS_ROOM).emit("admin_only_probe", { secret: true });
    await sleep(300);

    expect(messages).toEqual([{ id: "m1", body: "hello" }]);
    expect(chatUpdates).toEqual([{ id: "c1", backfill: false }]);
    expect(adminOnly).toEqual([]);
    // Across the whole session the USER socket never saw info/qrSvg/raw state.
    expect(statePayloads).toHaveLength(1);
    expect(JSON.stringify(statePayloads)).not.toContain("qrSvg");
    expect(JSON.stringify(statePayloads)).not.toContain("fake-pairing-qr");
    expect(statePayloads[0]).not.toHaveProperty("info");
    expect(statePayloads[0]).not.toHaveProperty("state");

    socket.disconnect();
    await waitForSocketCount(shared.sio, 0);
  });

  it("USER availability flips to { connected: true } when the client becomes ready", async () => {
    fakeWaState = "ready";
    try {
      const socket = makeClient(shared.url, { cookie: await cookieFor(user), origin: "http://localhost:3000" });
      const statePayloads: any[] = [];
      socket.on("whatsapp_state", (p) => statePayloads.push(p));
      expect(await connectOutcome(socket)).toBe("connected");
      await vi.waitFor(() => expect(statePayloads.length).toBe(1));
      expect(statePayloads[0]).toEqual({ connected: true });
      socket.disconnect();
      await waitForSocketCount(shared.sio, 0);
    } finally {
      fakeWaState = "qr";
    }
  });

  it("ADMIN joins 'inbox' AND 'admins' and receives the full state including qrSvg", async () => {
    const socket = makeClient(shared.url, { cookie: await cookieFor(admin), origin: "http://localhost:3000" });
    const statePayloads: any[] = [];
    socket.on("whatsapp_state", (p) => statePayloads.push(p));
    expect(await connectOutcome(socket)).toBe("connected");
    await vi.waitFor(() => expect(statePayloads.length).toBe(1));
    expect(statePayloads[0]).toEqual(hooks.getWhatsAppState());
    expect(statePayloads[0].qrSvg).toBe("<svg>fake-pairing-qr</svg>");
    expect(statePayloads[0].info).toContain("fake state");
    expect(statePayloads[0].state).toBe("qr");

    const srv = serverSocketFor(shared.sio, admin.id);
    expect(Array.from(srv!.rooms).sort()).toEqual([ADMINS_ROOM, INBOX_ROOM, srv!.id].sort());

    // Subsequent full-state broadcasts reach the admin socket.
    shared.sio.to(ADMINS_ROOM).emit("whatsapp_state", hooks.getWhatsAppState());
    await vi.waitFor(() => expect(statePayloads.length).toBe(2));
    socket.disconnect();
    await waitForSocketCount(shared.sio, 0);
  });
});

describe("no client-to-server surface", () => {
  it("client-emitted join/subscribe/send-style events gain no room and cause no action", async () => {
    const socket = makeClient(shared.url, { cookie: await cookieFor(user), origin: "http://localhost:3000" });
    expect(await connectOutcome(socket)).toBe("connected");
    const srv = serverSocketFor(shared.sio, user.id)!;
    const roomsBefore = Array.from(srv.rooms).sort();

    const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      socket.emit("join", ADMINS_ROOM);
      socket.emit("subscribe", "whatsapp_state");
      socket.emit("send", { remoteJid: "37499000000@c.us", body: "should never send" });
      socket.emit("join", "admins");
      await sleep(300);

      // No room gained, none lost; every emission was logged-and-ignored.
      expect(Array.from(srv.rooms).sort()).toEqual(roomsBefore);
      expect(spy).toHaveBeenCalled();
      const logged = spy.mock.calls.map((c) => String(c[0]));
      expect(logged.some((m) => m.includes('"join"'))).toBe(true);

      // Proof the socket still receives inbox events and is still not in 'admins':
      // an admins-room emit never arrives, an inbox emit does.
      const inbox: any[] = [];
      const adminOnly: any[] = [];
      socket.on("message", (p) => inbox.push(p));
      socket.on("admin_only_probe", (p) => adminOnly.push(p));
      shared.sio.to(ADMINS_ROOM).emit("admin_only_probe", { secret: true });
      shared.sio.to(INBOX_ROOM).emit("message", { id: "m2" });
      await sleep(300);
      expect(inbox).toEqual([{ id: "m2" }]);
      expect(adminOnly).toEqual([]);
      socket.disconnect();
      await waitForSocketCount(shared.sio, 0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("revalidation", () => {
  it("disconnects the socket when the token expires (fake timers)", async () => {
    vi.useFakeTimers();
    const server = await startServer();
    try {
      const token = await encode({ token: { id: user.id, role: user.role }, secret: SECRET, maxAge: 2 });
      const socket = makeClient(server.url, { cookie: `next-auth.session-token=${token}`, origin: "http://localhost:3000" });
      expect(await connectOutcome(socket)).toBe("connected");
      expect(server.sio.sockets.sockets.size).toBe(1);

      // Attach before advancing so a fast disconnect can never be missed.
      const disconnected = waitDisconnect(socket);
      await vi.advanceTimersByTimeAsync(2_100); // past the 2s expiry
      vi.useRealTimers();
      await disconnected;
      await vi.waitFor(() => expect(server.sio.sockets.sockets.size).toBe(0));
    } finally {
      vi.useRealTimers();
      await stopServer(server);
    }
  });

  it("a healthy socket survives the 60s revalidation loop (fake timers)", async () => {
    vi.useFakeTimers();
    const server = await startServer();
    try {
      const socket = makeClient(server.url, { cookie: await cookieFor(user), origin: "http://localhost:3000" });
      expect(await connectOutcome(socket)).toBe("connected");

      let disconnected = false;
      socket.on("disconnect", () => {
        disconnected = true;
      });
      await vi.advanceTimersByTimeAsync(3 * 60_000); // three whole intervals
      vi.useRealTimers();
      await sleep(200);
      expect(disconnected).toBe(false);
      expect(server.sio.sockets.sockets.size).toBe(1);
      socket.disconnect();
    } finally {
      vi.useRealTimers();
      await stopServer(server);
    }
  });

  it("disconnects on deactivation within one 60s interval (fake timers)", async () => {
    const deact = await prisma.user.create({ data: { email: "sock-deact@test.io", name: "Deact", password: "x", role: "USER" } });
    vi.useFakeTimers();
    const server = await startServer();
    try {
      const socket = makeClient(server.url, { cookie: await cookieFor(deact), origin: "http://localhost:3000" });
      expect(await connectOutcome(socket)).toBe("connected");

      await prisma.user.update({ where: { id: deact.id }, data: { active: false } });
      // Attach before advancing so a fast disconnect can never be missed.
      const disconnected = waitDisconnect(socket);
      await vi.advanceTimersByTimeAsync(60_000); // first interval re-reads the DB
      vi.useRealTimers();
      await disconnected;
      await vi.waitFor(() => expect(server.sio.sockets.sockets.size).toBe(0));
    } finally {
      vi.useRealTimers();
      await stopServer(server);
    }
  });

  it("disconnects when a revocation moves the user's session version past the token's sv (W1b, fake timers)", async () => {
    const revoked = await prisma.user.create({ data: { email: "sock-revoked@test.io", name: "Revoked", password: "x", role: "USER" } });
    vi.useFakeTimers();
    const server = await startServer();
    try {
      // Token carries the sv minted at login, matching the DB at connect time.
      const socket = makeClient(server.url, { cookie: await cookieFor(revoked, 60 * 60, 0), origin: "http://localhost:3000" });
      expect(await connectOutcome(socket)).toBe("connected");

      await prisma.user.update({ where: { id: revoked.id }, data: { sessionVersion: { increment: 1 } } });
      // Attach before advancing so a fast disconnect can never be missed.
      const disconnected = waitDisconnect(socket);
      await vi.advanceTimersByTimeAsync(60_000); // first interval re-reads the DB
      vi.useRealTimers();
      await disconnected;
      await vi.waitFor(() => expect(server.sio.sockets.sockets.size).toBe(0));
    } finally {
      vi.useRealTimers();
      await stopServer(server);
    }
  });

  it("disconnects within 60s when revokeAllSessions bumps the user's session version (W1b sv-revoke, fake timers)", async () => {
    const u = await prisma.user.create({ data: { email: "sock-sv-revoke@test.io", name: "SvRevoke", password: "x", role: "USER" } });
    vi.useFakeTimers();
    const server = await startServer();
    try {
      // Token carries the sv minted at login, matching the DB at connect time.
      const socket = makeClient(server.url, { cookie: await cookieFor(u, 60 * 60, 0), origin: "http://localhost:3000" });
      expect(await connectOutcome(socket)).toBe("connected");

      // The real helper the revocation endpoints call (W1b sv-revoke) — not a
      // hand-rolled { increment: 1 } like the neighboring test.
      await revokeAllSessions(u.id);
      // Attach before advancing so a fast disconnect can never be missed.
      const disconnected = waitDisconnect(socket);
      await vi.advanceTimersByTimeAsync(60_000); // first interval re-reads the DB
      vi.useRealTimers();
      await disconnected;
      await vi.waitFor(() => expect(server.sio.sockets.sockets.size).toBe(0));
    } finally {
      vi.useRealTimers();
      await stopServer(server);
    }
  });

  it("disconnects when the role loses inbox access (USER -> ADVISOR) within one interval (fake timers)", async () => {
    const roleChange = await prisma.user.create({ data: { email: "sock-role@test.io", name: "Role", password: "x", role: "USER" } });
    vi.useFakeTimers();
    const server = await startServer();
    try {
      const socket = makeClient(server.url, { cookie: await cookieFor(roleChange), origin: "http://localhost:3000" });
      expect(await connectOutcome(socket)).toBe("connected");

      await prisma.user.update({ where: { id: roleChange.id }, data: { role: "ADVISOR" } });
      // Attach before advancing so a fast disconnect can never be missed.
      const disconnected = waitDisconnect(socket);
      await vi.advanceTimersByTimeAsync(60_000);
      vi.useRealTimers();
      await disconnected;
      await vi.waitFor(() => expect(server.sio.sockets.sockets.size).toBe(0));
    } finally {
      vi.useRealTimers();
      await stopServer(server);
    }
  });

  it("re-syncs room membership on promotion (USER -> ADMIN) within one interval (fake timers)", async () => {
    const promo = await prisma.user.create({ data: { email: "sock-promo@test.io", name: "Promo", password: "x", role: "USER" } });
    vi.useFakeTimers();
    const server = await startServer();
    try {
      const socket = makeClient(server.url, { cookie: await cookieFor(promo), origin: "http://localhost:3000" });
      expect(await connectOutcome(socket)).toBe("connected");

      let disconnected = false;
      socket.on("disconnect", () => {
        disconnected = true;
      });

      await prisma.user.update({ where: { id: promo.id }, data: { role: "ADMIN" } });
      await vi.advanceTimersByTimeAsync(60_000); // first interval re-reads the DB
      vi.useRealTimers();
      await sleep(200);

      // Promotion keeps the socket alive and lands it in 'admins' without a
      // reconnect — the counterpart of the ADVISOR demotion disconnect above.
      expect(disconnected).toBe(false);
      expect(server.sio.sockets.sockets.size).toBe(1);
      const srv = serverSocketFor(server.sio, promo.id)!;
      expect(Array.from(srv.rooms).sort()).toEqual([ADMINS_ROOM, INBOX_ROOM, srv.id].sort());
      socket.disconnect();
    } finally {
      vi.useRealTimers();
      await stopServer(server);
    }
  });
});

describe("allowedSocketOrigins / isSocketOriginAllowed (unit)", () => {
  const saved = { NEXTAUTH_URL: process.env.NEXTAUTH_URL, SOCKET_ALLOWED_ORIGINS: process.env.SOCKET_ALLOWED_ORIGINS };

  afterEach(() => {
    process.env.NEXTAUTH_URL = saved.NEXTAUTH_URL;
    if (saved.SOCKET_ALLOWED_ORIGINS === undefined) delete process.env.SOCKET_ALLOWED_ORIGINS;
    else process.env.SOCKET_ALLOWED_ORIGINS = saved.SOCKET_ALLOWED_ORIGINS;
  });

  it("allows exactly the origin of NEXTAUTH_URL plus each SOCKET_ALLOWED_ORIGINS entry", () => {
    process.env.NEXTAUTH_URL = "https://portal.nare.am/some/path";
    process.env.SOCKET_ALLOWED_ORIGINS = "http://localhost:5173, http://127.0.0.1:5500";
    expect(allowedSocketOrigins()).toEqual(["https://portal.nare.am", "http://localhost:5173", "http://127.0.0.1:5500"]);
    expect(isSocketOriginAllowed("https://portal.nare.am")).toBe(true);
    expect(isSocketOriginAllowed("http://localhost:5173")).toBe(true);
    // Exact match only: trailing slash, other scheme/port/host never match.
    expect(isSocketOriginAllowed("https://portal.nare.am/")).toBe(false);
    expect(isSocketOriginAllowed("http://portal.nare.am")).toBe(false);
    expect(isSocketOriginAllowed("https://portal.nare.am:443")).toBe(false);
    expect(isSocketOriginAllowed("http://localhost:5174")).toBe(false);
    expect(isSocketOriginAllowed("null")).toBe(false);
    expect(isSocketOriginAllowed(undefined)).toBe(false);
    expect(isSocketOriginAllowed("")).toBe(false);
  });

  it("fails closed when NEXTAUTH_URL is missing or unparseable", () => {
    delete process.env.NEXTAUTH_URL;
    delete process.env.SOCKET_ALLOWED_ORIGINS;
    expect(allowedSocketOrigins()).toEqual([]);
    expect(isSocketOriginAllowed("http://localhost:3000")).toBe(false);

    process.env.NEXTAUTH_URL = "not a url";
    expect(allowedSocketOrigins()).toEqual([]);
    expect(isSocketOriginAllowed("http://localhost:3000")).toBe(false);
  });
});

describe("W2 permission handshake (perm-inbox)", () => {
  it("refuses a USER denied whatsapp.inbox.view (deny beats the preset)", async () => {
    // Deny always wins, even over the role preset: USER's preset holds
    // whatsapp.inbox.view, so without the deny row this user would connect.
    const deniedUser = await prisma.user.create({
      data: { email: "sock-w2-deny-view@test.io", name: "DenyView", password: "x", role: "USER" },
    });
    await prisma.userPermission.create({ data: { userId: deniedUser.id, key: "whatsapp.inbox.view", allowed: false } });

    const outcome = await connectOutcome(
      makeClient(shared.url, { cookie: await cookieFor(deniedUser), origin: "http://localhost:3000" })
    );
    expect(outcome).toBe("unauthorized");
    expect(shared.sio.sockets.sockets.size).toBe(0);
  });

  it("connects a travel-only user granted whatsapp.inbox.view, inbox room only", async () => {
    // ADVISOR's preset has no socket-eligible keys; the grant alone opens the
    // socket — proof the gate follows effective permissions, not the role.
    const grantedAdvisor = await prisma.user.create({
      data: { email: "sock-w2-grant-view@test.io", name: "GrantView", password: "x", role: "ADVISOR" },
    });
    await prisma.userPermission.create({ data: { userId: grantedAdvisor.id, key: "whatsapp.inbox.view", allowed: true } });

    const socket = makeClient(shared.url, { cookie: await cookieFor(grantedAdvisor), origin: "http://localhost:3000" });
    // Attach BEFORE connecting: the initial whatsapp_state is emitted in the
    // same tick as the CONNECT packet and may be delivered batched with it.
    const statePayloads: any[] = [];
    const messages: any[] = [];
    const adminOnly: any[] = [];
    socket.on("whatsapp_state", (p) => statePayloads.push(p));
    socket.on("message", (p) => messages.push(p));
    socket.on("admin_only_probe", (p) => adminOnly.push(p));

    expect(await connectOutcome(socket)).toBe("connected");

    // Inbox-only: availability as the exact payload (fakeWaState is "qr", so
    // connected is false) — never the full state with qrSvg.
    await vi.waitFor(() => expect(statePayloads.length).toBe(1));
    expect(statePayloads[0]).toEqual({ connected: false });

    const srv = serverSocketFor(shared.sio, grantedAdvisor.id);
    expect(srv).toBeDefined();
    expect(Array.from(srv!.rooms).sort()).toEqual([INBOX_ROOM, srv!.id].sort());

    // Room scoping still applies to granted sockets: admins-room traffic never
    // arrives, inbox traffic does.
    shared.sio.to(ADMINS_ROOM).emit("admin_only_probe", { secret: true });
    shared.sio.to(ADMINS_ROOM).emit("whatsapp_state", hooks.getWhatsAppState());
    shared.sio.to(INBOX_ROOM).emit("message", { id: "m-w2", body: "inbox for granted advisor" });
    await sleep(300);

    expect(messages).toEqual([{ id: "m-w2", body: "inbox for granted advisor" }]);
    expect(adminOnly).toEqual([]);
    expect(statePayloads).toHaveLength(1);
    expect(JSON.stringify(statePayloads)).not.toContain("qrSvg");

    socket.disconnect();
    await waitForSocketCount(shared.sio, 0);
  });

  it("connects an ADVISOR granted only whatsapp.admin: admins room only, receives full state incl qrSvg, no inbox messages", async () => {
    // whatsapp.admin alone is socket-eligible: the socket lands in 'admins'
    // without 'inbox' — the QR/status channel decoupled from the message feed.
    const adminAdvisor = await prisma.user.create({
      data: { email: "sock-w2-grant-admin@test.io", name: "GrantAdmin", password: "x", role: "ADVISOR" },
    });
    await prisma.userPermission.create({ data: { userId: adminAdvisor.id, key: "whatsapp.admin", allowed: true } });

    const socket = makeClient(shared.url, { cookie: await cookieFor(adminAdvisor), origin: "http://localhost:3000" });
    // Attach BEFORE connecting: the initial whatsapp_state is emitted in the
    // same tick as the CONNECT packet and may be delivered batched with it.
    const statePayloads: any[] = [];
    const messages: any[] = [];
    socket.on("whatsapp_state", (p) => statePayloads.push(p));
    socket.on("message", (p) => messages.push(p));

    expect(await connectOutcome(socket)).toBe("connected");

    // Full initial state — the admins-room payload, qrSvg included.
    await vi.waitFor(() => expect(statePayloads.length).toBe(1));
    expect(statePayloads[0]).toEqual(hooks.getWhatsAppState());
    expect(statePayloads[0].qrSvg).toBe("<svg>fake-pairing-qr</svg>");

    const srv = serverSocketFor(shared.sio, adminAdvisor.id);
    expect(srv).toBeDefined();
    expect(Array.from(srv!.rooms).sort()).toEqual([ADMINS_ROOM, srv!.id].sort());

    // Not in 'inbox': message traffic never arrives, admins traffic does.
    shared.sio.to(INBOX_ROOM).emit("message", { id: "m-w2-admin", body: "must not arrive" });
    shared.sio.to(ADMINS_ROOM).emit("whatsapp_state", hooks.getWhatsAppState());
    await sleep(300);

    expect(messages).toEqual([]);
    expect(statePayloads).toHaveLength(2);

    socket.disconnect();
    await waitForSocketCount(shared.sio, 0);
  });
});

describe("W2 permission revalidation (perm-inbox, fake timers)", () => {
  it("disconnects within 60s when whatsapp.inbox.view is removed", async () => {
    const u = await prisma.user.create({ data: { email: "sock-w2-rev-view@test.io", name: "RevView", password: "x", role: "USER" } });
    vi.useFakeTimers();
    const server = await startServer();
    try {
      const socket = makeClient(server.url, { cookie: await cookieFor(u), origin: "http://localhost:3000" });
      expect(await connectOutcome(socket)).toBe("connected");
      expect(server.sio.sockets.sockets.size).toBe(1);

      // Deny beats the USER preset: after this row the user holds no
      // socket-eligible permission, so the next pass must disconnect.
      await prisma.userPermission.create({ data: { userId: u.id, key: "whatsapp.inbox.view", allowed: false } });
      // Attach before advancing so a fast disconnect can never be missed.
      const disconnected = waitDisconnect(socket);
      await vi.advanceTimersByTimeAsync(60_000); // first interval re-reads the DB
      vi.useRealTimers();
      await disconnected;
      await vi.waitFor(() => expect(server.sio.sockets.sockets.size).toBe(0));
    } finally {
      vi.useRealTimers();
      await stopServer(server);
    }
  });

  it("re-rooms within 60s when whatsapp.admin is removed from an ADMIN (stays connected, leaves 'admins')", async () => {
    const u = await prisma.user.create({ data: { email: "sock-w2-rev-admin@test.io", name: "RevAdmin", password: "x", role: "ADMIN" } });
    vi.useFakeTimers();
    const server = await startServer();
    try {
      const socket = makeClient(server.url, { cookie: await cookieFor(u), origin: "http://localhost:3000" });
      expect(await connectOutcome(socket)).toBe("connected");
      const before = serverSocketFor(server.sio, u.id)!;
      expect(before.rooms.has(ADMINS_ROOM)).toBe(true);

      let disconnected = false;
      socket.on("disconnect", () => {
        disconnected = true;
      });

      // Deny beats even the ADMIN preset; whatsapp.inbox.view remains, so the
      // socket must survive but drop out of 'admins'.
      await prisma.userPermission.create({ data: { userId: u.id, key: "whatsapp.admin", allowed: false } });
      await vi.advanceTimersByTimeAsync(60_000); // first interval re-reads the DB
      // Revalidation resolves asynchronously (DB read + room sync) after the
      // interval fires — back on real timers, give it a real moment to settle.
      vi.useRealTimers();
      await sleep(200);

      expect(disconnected).toBe(false);
      expect(server.sio.sockets.sockets.size).toBe(1);
      const srv = serverSocketFor(server.sio, u.id)!;
      expect(Array.from(srv.rooms).sort()).toEqual([INBOX_ROOM, srv.id].sort());

      // Proof the room sync is real, not just the data structure: admins-room
      // emits no longer arrive, inbox emits still do.
      const inbox: any[] = [];
      const adminOnly: any[] = [];
      socket.on("message", (p) => inbox.push(p));
      socket.on("admin_only_probe", (p) => adminOnly.push(p));
      server.sio.to(ADMINS_ROOM).emit("admin_only_probe", { secret: true });
      server.sio.to(INBOX_ROOM).emit("message", { id: "m-w2-rev" });
      await sleep(300);
      expect(adminOnly).toEqual([]);
      expect(inbox).toEqual([{ id: "m-w2-rev" }]);

      socket.disconnect();
    } finally {
      vi.useRealTimers();
      await stopServer(server);
    }
  });

  it("joins 'admins' within 60s when whatsapp.admin is granted", async () => {
    const u = await prisma.user.create({ data: { email: "sock-w2-grant-admin-live@test.io", name: "GrantAdminLive", password: "x", role: "USER" } });
    vi.useFakeTimers();
    const server = await startServer();
    try {
      const socket = makeClient(server.url, { cookie: await cookieFor(u), origin: "http://localhost:3000" });
      expect(await connectOutcome(socket)).toBe("connected");
      expect(serverSocketFor(server.sio, u.id)!.rooms.has(ADMINS_ROOM)).toBe(false);

      // The grant takes effect on the next pass without a reconnect.
      await prisma.userPermission.create({ data: { userId: u.id, key: "whatsapp.admin", allowed: true } });
      await vi.advanceTimersByTimeAsync(60_000); // first interval re-reads the DB
      // Revalidation resolves asynchronously (DB read + room sync) after the
      // interval fires — back on real timers, give it a real moment to settle.
      vi.useRealTimers();
      await sleep(200);

      expect(server.sio.sockets.sockets.size).toBe(1);
      const srv = serverSocketFor(server.sio, u.id)!;
      expect(Array.from(srv.rooms).sort()).toEqual([ADMINS_ROOM, INBOX_ROOM, srv.id].sort());

      // Admins-room traffic now reaches the socket.
      const adminOnly: any[] = [];
      socket.on("admin_only_probe", (p) => adminOnly.push(p));
      server.sio.to(ADMINS_ROOM).emit("admin_only_probe", { secret: true });
      await sleep(300);
      expect(adminOnly).toEqual([{ secret: true }]);

      socket.disconnect();
    } finally {
      vi.useRealTimers();
      await stopServer(server);
    }
  });

  it("disconnects within 60s when an admin-only user loses whatsapp.admin", async () => {
    const u = await prisma.user.create({
      data: { email: "sock-w2-lose-admin@test.io", name: "LoseAdmin", password: "x", role: "ADVISOR" },
    });
    // Grant BEFORE connecting: the ADVISOR preset has no socket-eligible keys,
    // so this row is the only thing letting the handshake through.
    await prisma.userPermission.create({ data: { userId: u.id, key: "whatsapp.admin", allowed: true } });
    vi.useFakeTimers();
    const server = await startServer();
    try {
      const socket = makeClient(server.url, { cookie: await cookieFor(u), origin: "http://localhost:3000" });
      expect(await connectOutcome(socket)).toBe("connected");
      expect(server.sio.sockets.sockets.size).toBe(1);

      // Removing the override leaves the ADVISOR preset — nothing
      // socket-eligible — so the next pass must disconnect.
      await prisma.userPermission.deleteMany({ where: { userId: u.id } });
      // Attach before advancing so a fast disconnect can never be missed.
      const disconnected = waitDisconnect(socket);
      await vi.advanceTimersByTimeAsync(60_000); // first interval re-reads the DB
      vi.useRealTimers();
      await disconnected;
      await vi.waitFor(() => expect(server.sio.sockets.sockets.size).toBe(0));
    } finally {
      vi.useRealTimers();
      await stopServer(server);
    }
  });
});
