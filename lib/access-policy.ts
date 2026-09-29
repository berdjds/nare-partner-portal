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
 * decides — the role baked into the JWT at login is never consulted. A
 * deactivation or role change therefore takes effect on the very next request,
 * even with the same unexpired session token (a revoked user gets 401, the
 * same as having no session).
 */

import type { Session } from "next-auth";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

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
}

/**
 * Resolves a user id to the current, active user row. Returns null when the
 * user no longer exists or was deactivated — the caller must treat the
 * request as unauthenticated, never fall back to the JWT role. Shared by
 * getActiveUser() and the Socket.io handshake (which decodes the JWT itself
 * and never has a Session object).
 */
export async function getActiveUserById(id: string): Promise<ActiveUser | null> {
  const user = await prisma.user.findUnique({
    where: { id },
    select: { id: true, email: true, name: true, role: true, active: true },
  });
  if (!user || !user.active) return null;
  return user;
}

/**
 * Resolves a session to the current, active user row. Returns null when there
 * is no session user id, the user no longer exists, or the user was
 * deactivated — in all three cases the caller must treat the request as
 * unauthenticated (401), never fall back to the JWT role.
 */
export async function getActiveUser(session: Session | null): Promise<ActiveUser | null> {
  const id = session?.user?.id;
  if (!id) return null;
  return getActiveUserById(id);
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
 * Gate for WhatsApp administration. Everything except an active ADMIN gets
 * 401 — matching the pre-W1 POST /api/whatsapp/status behavior, which never
 * distinguished "logged in but not admin" from "no session".
 */
export async function requireWhatsAppAdminAccess(session: Session | null): Promise<AccessDecision> {
  const user = await getActiveUser(session);
  if (!user) return denied(401, "Unauthorized");
  if (!canAdministerWhatsApp(user.role)) return denied(401, "Unauthorized");
  return { allowed: true, user };
}
