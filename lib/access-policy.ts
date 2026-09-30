/**
 * Interim role access policy (W1, until W2 grants per-user inbox access).
 *
 * - canUseInbox(role): ADMIN or USER — the only roles that may open the
 *   WhatsApp chat inbox (dashboard page, /api/chats, /api/messages, /api/send
 *   and media under /uploads/).
 * - canAdministerWhatsApp(role): ADMIN — full WhatsApp status details
 *   (state, info, pairing QR, version, startedAt) and the reconnect/logout
 *   actions.
 * - ADVISOR and VALIDATOR are travel-only: pages redirect them to /travel,
 *   inbox APIs answer 403, media answers 403.
 *
 * Trust boundary: every gate below reloads the user from the database on each
 * request. The user must exist and be active, and the CURRENT database role
 * decides — the role baked into the JWT at login is never consulted. The gate
 * also compares the token's session version (`sv`) against the user's current
 * session version (W1b, the User.sessionVersion column). Revoking every
 * session of a user means bumping that column atomically with
 * { increment: 1 } (see revokeAllSessions below), which revokes every token
 * issued before the bump on the very next request. A missing sv claim reads
 * as 0, so a legacy token keeps working only while the user was never
 * revoked; the first revocation revokes legacy tokens too. Role and active
 * changes need no version bump: the row re-read already applies them. A
 * deactivation, role change or sv mismatch therefore takes effect with the
 * same unexpired session token (a revoked user gets 401, the same as having
 * no session).
 *
 * W2 permission model: ActiveUser also carries the user's EFFECTIVE
 * permissions (lib/permissions.ts — role preset + grants − denies from the
 * UserPermission table), resolved from the same database read (the override
 * rows load through the indexed (userId, key) relation in the one user
 * query), so an override edit takes effect on the next request exactly like a
 * role change. The inbox surfaces (W2 perm-inbox: chat APIs, media, sockets,
 * WhatsApp administration) enforce through requirePermission() and the
 * permission-based requireWhatsAppAdminAccess(); the role predicates remain
 * for the role-based redirects (app/page.tsx) and the travel gates.
 */

import type { Session } from "next-auth";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  effectivePermissions,
  type PermissionKey,
} from "@/lib/permissions";

export function canUseInbox(role: string | null | undefined): boolean {
  return role === "ADMIN" || role === "USER";
}

export function canAdministerWhatsApp(role: string | null | undefined): boolean {
  return role === "ADMIN";
}

export interface ActiveUser {
  id: string;
  email: string;
  name: string | null;
  role: string;
  /** Current session version: the User.sessionVersion column. */
  sessionVersion: number;
  /** Effective W2 permissions: role preset + grants − denies, from the current DB row. */
  permissions: ReadonlySet<PermissionKey>;
}

/**
 * Revokes every session of a user: bumps User.sessionVersion atomically, so
 * every token minted before this call (including pre-W1b legacy tokens, whose
 * missing sv claim reads as 0) fails the version comparison on the very next
 * HTTP request, upload request or socket revalidation pass.
 */
export async function revokeAllSessions(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { sessionVersion: { increment: 1 } },
  });
}

/**
 * Resolves a user id to the current, active user row. Returns null when the
 * user no longer exists, was deactivated, or — when expectedSessionVersion is
 * given — the user's current session version (the User.sessionVersion column)
 * no longer equals the token's sv claim (a token issued before a revocation
 * must resolve as unauthenticated). A missing sv claim reads as 0, which is a
 * real version, not a bypass: it matches only users that were never revoked,
 * so the first revocation revokes legacy tokens too. The caller must treat
 * null as unauthenticated, never fall back to the JWT role. Shared by
 * getActiveUser() and the Socket.io handshake (which decodes the JWT itself
 * and never has a Session object).
 */
export async function getActiveUserById(
  id: string,
  expectedSessionVersion?: number
): Promise<ActiveUser | null> {
  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      active: true,
      sessionVersion: true,
      // Per-user grant/deny overrides (UserPermission), fetched in the same
      // user read via the indexed (userId, key) relation.
      permissions: { select: { key: true, allowed: true } },
    },
  });
  if (!user || !user.active) return null;
  const sessionVersion = user.sessionVersion;
  if (expectedSessionVersion !== undefined && sessionVersion !== expectedSessionVersion) {
    return null;
  }
  const permissions = effectivePermissions(user.role, user.permissions);
  return { id: user.id, email: user.email, name: user.name, role: user.role, sessionVersion, permissions };
}

/**
 * Resolves a session to the current, active user row. Returns null when there
 * is no session user id, the user no longer exists, the user was deactivated,
 * or the token's sv claim no longer matches the user's current session
 * version — in all cases the caller must treat the request as unauthenticated
 * (401), never fall back to the JWT role. A token minted before W1b has no sv
 * claim; it counts as version 0 and therefore matches only a user that was
 * never revoked.
 */
export async function getActiveUser(session: Session | null): Promise<ActiveUser | null> {
  const id = session?.user?.id;
  if (!id) return null;
  return getActiveUserById(id, session?.user?.sv ?? 0);
}

export type AccessDecision =
  | { allowed: true; user: ActiveUser }
  | { allowed: false; response: NextResponse };

function denied(status: 401 | 403, message: "Unauthorized" | "Forbidden"): AccessDecision {
  return { allowed: false, response: NextResponse.json({ error: message }, { status }) };
}

/** Gate for the chat inbox APIs: 401 without an active session, 403 for active non-inbox roles. */
export async function requireInboxAccess(session: Session | null): Promise<AccessDecision> {
  const user = await getActiveUser(session);
  if (!user) return denied(401, "Unauthorized");
  if (!canUseInbox(user.role)) return denied(403, "Forbidden");
  return { allowed: true, user };
}

/**
 * Gate for WhatsApp administration (W2 perm-inbox): requires the effective
 * whatsapp.admin permission (an ADMIN denied the key, or a non-admin granted
 * it, is decided by the permission, not the role). Everything without the
 * permission gets 401 — matching the pre-W1 POST /api/whatsapp/status
 * behavior, which never distinguished "logged in but not admin" from "no
 * session".
 */
export async function requireWhatsAppAdminAccess(session: Session | null): Promise<AccessDecision> {
  const user = await getActiveUser(session);
  if (!user) return denied(401, "Unauthorized");
  if (!user.permissions.has("whatsapp.admin")) return denied(401, "Unauthorized");
  return { allowed: true, user };
}

/**
 * Permission-aware gate (W2): 401 without an active session (including stale
 * session versions), 403 when the user's effective permissions lack the key.
 * Mirrors requireInboxAccess's status-code contract.
 */
export async function requirePermission(session: Session | null, key: PermissionKey): Promise<AccessDecision> {
  const user = await getActiveUser(session);
  if (!user) return denied(401, "Unauthorized");
  if (!user.permissions.has(key)) return denied(403, "Forbidden");
  return { allowed: true, user };
}
