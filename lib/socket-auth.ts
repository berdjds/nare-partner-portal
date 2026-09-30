/**
 * Socket.io authentication, origin checking, room scoping and revalidation
 * (W1, sock-auth).
 *
 * The dashboard's real-time channel (/api/socket) used to accept any
 * connection (CORS `*`, no auth) and broadcast every event — including the
 * WhatsApp pairing QR and all message content — to every connected socket.
 * This module replaces that with the same trust boundary as the HTTP gates
 * (lib/access-policy.ts, lib/uploads.ts):
 *
 * 1. Origin gate (allowRequest): a connection is accepted only when the
 *    Origin header exactly equals the origin of NEXTAUTH_URL, or one of the
 *    comma-separated origins in optional SOCKET_ALLOWED_ORIGINS (local
 *    development). There is deliberately no `*` fallback and no
 *    Access-Control-Allow-Origin response header; cross-origin dashboards are
 *    rejected before the Socket.io handshake runs.
 * 2. Session gate (io.use handshake middleware): the NextAuth session cookie
 *    is decoded with NEXTAUTH_SECRET (next-auth/jwt, same as lib/uploads.ts).
 *    Missing, forged or expired tokens are rejected, then the user is loaded
 *    from the database and must be active and hold at least one socket-eligible
 *    permission (W2): whatsapp.inbox.view (message feed) or whatsapp.admin
 *    (full state/QR). Users with neither are refused.
 * 3. Server-managed rooms: the SERVER places each authenticated socket in the
 *    rooms its CURRENT effective permissions entitle it to: 'inbox' with
 *    whatsapp.inbox.view, 'admins' with whatsapp.admin. Clients are never
 *    asked to join anything and no client-to-server event handlers are
 *    registered — anything a client emits is ignored and logged
 *    (socket.onAny), so it cannot subscribe to rooms or trigger actions.
 * 4. Scoped emits (lib/whatsapp.ts): 'message' and 'chat_update' go to
 *    'inbox' only; availability { connected } goes to 'inbox' only; the full
 *    whatsapp_state (info + pairing qrSvg) goes to 'admins' only.
 * 5. Revalidation: a socket is disconnected when its token's exp passes, and
 *    every REVALIDATE_INTERVAL_MS each open socket's user is reloaded from
 *    the database — deactivation, a session-version (sv) mismatch against the
 *    user's current version, or losing every socket-eligible permission
 *    disconnects it, and room membership is re-synced with the CURRENT
 *    effective permissions (grants and denies take effect within one
 *    interval without a reconnect).
 *
 * Revocation (W1b, sv claim): sv is the user's session version — the
 * User.sessionVersion column. Bumping it atomically with { increment: 1 }
 * (revokeAllSessions in lib/access-policy.ts) invalidates every token issued
 * before the bump on the next HTTP request and disconnects open sockets on
 * the next revalidation pass. Tokens minted before W1b carry no sv claim;
 * they count as 0 and therefore match only a user that was never revoked —
 * the first revocation revokes legacy tokens too.
 */

import type { IncomingMessage } from "http";
import type { Server as SocketIOServer, Socket as ServerSocket, ExtendedError } from "socket.io";
import { decode } from "next-auth/jwt";
import { getActiveUserById } from "@/lib/access-policy";
import { hasPermission, type PermissionKey } from "@/lib/permissions";

/** Sockets with whatsapp.inbox.view land here; receives messages and availability. */
export const INBOX_ROOM = "inbox";
/** Sockets with whatsapp.admin; receives the full whatsapp_state including the pairing QR. */
export const ADMINS_ROOM = "admins";

/** Re-check interval for open sockets (active + socket-eligible permissions). */
export const REVALIDATE_INTERVAL_MS = 60_000;

/** connect_error message used for every refused handshake (client matches on it). */
export const UNAUTHORIZED = "unauthorized";

// NextAuth v4 uses the __Secure- prefix on HTTPS deployments (NEXTAUTH_URL
// starting with https://) and the plain name otherwise; accept both so the
// gate works in dev and behind the production reverse proxy alike.
const SESSION_COOKIE_NAMES = ["__Secure-next-auth.session-token", "next-auth.session-token"];

// setTimeout overflows (fires immediately) beyond ~24.85 days. W1b caps the
// session maxAge at 7 days (lib/auth.ts), so expiries stay in range — the
// re-arm below is kept as a defense in case the maxAge ever grows again.
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

export interface SocketAuthData {
  userId: string;
  role: string;
  /** Token's session version claim (W1b); compared against the user's current session version. */
  sv: number;
  /** Token expiry as unix seconds (from the decoded JWT). */
  exp: number;
  /** Effective permissions at the last database (re)check; rooms follow this set. */
  permissions: ReadonlySet<PermissionKey>;
}

/**
 * A socket is worth keeping only while the user holds at least one
 * socket-eligible permission: whatsapp.inbox.view (inbox feed) or
 * whatsapp.admin (full state / pairing QR).
 */
function isSocketEligible(user: { permissions: ReadonlySet<PermissionKey> }): boolean {
  return hasPermission(user, "whatsapp.inbox.view") || hasPermission(user, "whatsapp.admin");
}

export interface SocketStateHooks {
  /** Full whatsapp_state payload for the admin dashboard (info, qrSvg, ...). */
  getWhatsAppState: () => Record<string, unknown>;
  /** Whether the WhatsApp client is currently 'ready' (availability only). */
  isConnected: () => boolean;
}

/**
 * Exact origins a socket may connect from: the origin of NEXTAUTH_URL plus
 * any comma-separated entries in SOCKET_ALLOWED_ORIGINS. An absent or
 * unparseable NEXTAUTH_URL simply contributes nothing (fails closed), it
 * never widens the allow-list.
 */
export function allowedSocketOrigins(): string[] {
  const origins: string[] = [];
  const nextAuthUrl = process.env.NEXTAUTH_URL;
  if (nextAuthUrl) {
    try {
      origins.push(new URL(nextAuthUrl).origin);
    } catch {
      // unparseable NEXTAUTH_URL — no origin from it
    }
  }
  const extra = process.env.SOCKET_ALLOWED_ORIGINS;
  if (extra) {
    for (const entry of extra.split(",")) {
      const trimmed = entry.trim();
      if (trimmed) origins.push(trimmed);
    }
  }
  return origins;
}

/**
 * Exact-match check against the allow-list. A missing Origin header does not
 * match anything and is refused — browsers always send Origin on WebSocket
 * handshakes, so a socket without it is not a browser dashboard.
 */
export function isSocketOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return false;
  return allowedSocketOrigins().includes(origin);
}

/** allowRequest hook for the Socket.io Server: engine-level origin gate. */
export function socketAllowRequest(
  req: IncomingMessage,
  callback: (err: string | null | undefined, success: boolean) => void
): void {
  callback(null, isSocketOriginAllowed(req.headers.origin));
}

function readSessionCookie(req: IncomingMessage): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    if (SESSION_COOKIE_NAMES.includes(name)) {
      const value = pair.slice(eq + 1).trim();
      try {
        return decodeURIComponent(value);
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Decodes the handshake's session cookie and resolves it to the current,
 * active, socket-eligible user. Throws "unauthorized" for every failure mode —
 * missing/forged/expired token, unknown user, deactivated user, or effective
 * permissions without either whatsapp.inbox.view or whatsapp.admin — so the
 * middleware can refuse identically.
 */
async function authenticateHandshake(req: IncomingMessage): Promise<SocketAuthData> {
  const deny = () => Promise.reject(new Error(UNAUTHORIZED));
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) return deny(); // fail closed rather than accept unsigned tokens
  const token = readSessionCookie(req);
  if (!token) return deny();
  let payload: { exp?: number; id?: unknown; sub?: unknown; sv?: unknown } | null = null;
  try {
    payload = await decode({ token, secret });
  } catch {
    // Expired (JWTExpired), tampered with, or not a JWE — same answer: deny.
    return deny();
  }
  if (!payload) return deny();
  // decode() already enforces exp via jose (15s clock tolerance); re-check so
  // an absent exp can never slip through as "never expires".
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now()) return deny();
  const id = payload.id ?? payload.sub;
  if (typeof id !== "string" || !id) return deny();
  // Tokens minted before W1b carry no sv claim; they count as 0, which matches
  // only a user that was never revoked (getActiveUserById always compares —
  // 0 is a real version, not a bypass).
  const sv = typeof payload.sv === "number" ? payload.sv : 0;
  const user = await getActiveUserById(id, sv);
  if (!user || !isSocketEligible(user)) return deny();
  return { userId: user.id, role: user.role, sv, exp: payload.exp, permissions: user.permissions };
}

/** io.use handshake middleware: authenticates and tags socket.data.user. */
export function socketAuthMiddleware(socket: ServerSocket, next: (err?: ExtendedError) => void): void {
  authenticateHandshake(socket.request)
    .then((auth) => {
      socket.data.user = auth;
      next();
    })
    .catch(() => next(new Error(UNAUTHORIZED)));
}

function getAuthData(socket: ServerSocket): SocketAuthData | undefined {
  return socket.data.user as SocketAuthData | undefined;
}

/**
 * Disconnects the socket when its token expires. Long expiries (NextAuth
 * defaults to 30 days, beyond setTimeout's range) are re-armed on each
 * firing until the expiry actually passes.
 */
function scheduleTokenExpiryDisconnect(socket: ServerSocket, expSeconds: number): void {
  const arm = () => {
    const remaining = expSeconds * 1000 - Date.now();
    if (remaining <= 0) {
      console.log("[Socket] session token expired — disconnecting", getAuthData(socket)?.userId);
      socket.disconnect(true);
      return;
    }
    socket.data.expiryTimer = setTimeout(arm, Math.min(remaining, MAX_TIMER_DELAY_MS));
  };
  socket.data.expiryTimer = setTimeout(arm, Math.min(expSeconds * 1000 - Date.now(), MAX_TIMER_DELAY_MS));
}

/**
 * Re-checks one open socket against the database: the user must still exist,
 * be active, and hold at least one socket-eligible permission, otherwise the
 * socket is disconnected. Room membership is re-synced with the CURRENT
 * effective permissions so a grant or deny takes effect within one interval
 * without waiting for the next login.
 */
export async function revalidateSocket(socket: ServerSocket): Promise<void> {
  const auth = getAuthData(socket);
  if (!auth) {
    socket.disconnect(true);
    return;
  }
  const user = await getActiveUserById(auth.userId, auth.sv);
  if (!user || !isSocketEligible(user)) {
    console.log("[Socket] user deactivated, permissions revoked or session revoked — disconnecting", auth.userId);
    socket.disconnect(true);
    return;
  }
  auth.role = user.role;
  auth.permissions = user.permissions;
  await syncRooms(socket, user.permissions);
}

/** Places the socket in exactly the rooms its effective permissions entitle it to. */
async function syncRooms(socket: ServerSocket, permissions: ReadonlySet<PermissionKey>): Promise<void> {
  const entitled: Array<[string, boolean]> = [
    [INBOX_ROOM, permissions.has("whatsapp.inbox.view")],
    [ADMINS_ROOM, permissions.has("whatsapp.admin")],
  ];
  for (const [room, allow] of entitled) {
    if (allow) {
      if (!socket.rooms.has(room)) await socket.join(room);
    } else if (socket.rooms.has(room)) {
      await socket.leave(room);
    }
  }
}

/** Re-checks every open socket; errors are logged, never thrown into the loop. */
export function revalidateAllSockets(io: SocketIOServer): void {
  // Map.forEach rather than for..of over .values(): the base tsconfig has no
  // downlevelIteration, so iterating a MapIterator does not compile.
  io.sockets.sockets.forEach((socket) => {
    revalidateSocket(socket).catch((err) => console.error("[Socket] revalidation error:", err));
  });
}

/**
 * Starts the periodic revalidation loop. The interval is unref'd so it never
 * keeps an otherwise-idle process (e.g. a test runner) alive.
 */
export function startRoleRevalidation(
  io: SocketIOServer,
  intervalMs: number = REVALIDATE_INTERVAL_MS
): NodeJS.Timeout {
  const timer = setInterval(() => revalidateAllSockets(io), intervalMs);
  timer.unref?.();
  return timer;
}

/**
 * Wires the whole gate onto a Socket.io server:
 * - io.use session middleware (origin is gated earlier by allowRequest),
 * - 'connection' handler that joins server-managed rooms by effective
 *   permission, ignores any client-emitted event, sends the initial state
 *   (full for 'admins' sockets, availability only otherwise) and arms the
 *   expiry timer,
 * - the periodic revalidation loop.
 *
 * State payloads are injected via hooks so this module does not depend on
 * lib/whatsapp.ts (which would create a bundler cycle across the custom
 * server and the Next.js API routes).
 */
export function attachSocketAuth(io: SocketIOServer, hooks: SocketStateHooks): void {
  io.use(socketAuthMiddleware);

  io.on("connection", (socket: ServerSocket) => {
    const auth = getAuthData(socket);
    if (!auth) {
      // Cannot happen — the middleware tags every socket — but never leave a
      // room decision to chance on an untagged socket.
      socket.disconnect(true);
      return;
    }

    // The server, never the client, decides room membership — from the
    // effective permissions resolved at the handshake.
    if (auth.permissions.has("whatsapp.inbox.view")) socket.join(INBOX_ROOM);
    if (auth.permissions.has("whatsapp.admin")) socket.join(ADMINS_ROOM);

    // No client-to-server handlers exist anywhere: whatever a client emits
    // (join/subscribe/send/...) is ignored and logged, so it can never
    // subscribe to a room or trigger an action.
    socket.onAny((event) => {
      console.warn(`[Socket] ignoring client-emitted event "${event}" from user ${auth.userId}`);
    });

    // Initial state: sockets in 'admins' get the full picture (including the
    // pairing QR); everyone else gets availability as { connected } and
    // nothing else.
    if (socket.rooms.has(ADMINS_ROOM)) {
      socket.emit("whatsapp_state", hooks.getWhatsAppState());
    } else {
      socket.emit("whatsapp_state", { connected: hooks.isConnected() });
    }

    scheduleTokenExpiryDisconnect(socket, auth.exp);
    socket.once("disconnect", () => {
      const timer = socket.data.expiryTimer as NodeJS.Timeout | undefined;
      if (timer) clearTimeout(timer);
    });
  });

  startRoleRevalidation(io);
}
