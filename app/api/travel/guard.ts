/**
 * Shared guard + error mapping for /api/travel routes.
 *
 * Every travel route requires a session whose current database role is in
 * TRAVEL_ROLES (ADMIN / ADVISOR / VALIDATOR) — or any user holding an active
 * validation assignment (v0.10.0) — AND the effective travel.access
 * permission (W2 perm-travel): the role/assignment rule stays as the minimum,
 * the permission can only narrow it (a deny override locks the user out of
 * the whole module). Role, session version and permissions are re-read from
 * the database via getActiveUser(), never trusted from the JWT, so a revoked
 * or stale token — or a permission edit — is rejected here on the next
 * request. The actor carries the effective permissions into the workflow
 * layer, which gates create/review/issue per key; finer record-level RBAC
 * lives in lib/travel/workflow.ts, which throws WorkflowError with an HTTP
 * status that travelError() maps verbatim.
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { ZodError } from "zod";
import { authOptions } from "@/lib/auth";
import { getActiveUser } from "@/lib/access-policy";
import { hasPermission } from "@/lib/permissions";
import { canAccessTravel } from "@/lib/travel/access";
import { WorkflowError, type WorkflowActor } from "@/lib/travel/workflow";
import { ResolutionError } from "@/lib/travel/resolve";
import { ROLE_PARTNER } from "@/lib/travel/contracts";
import { prisma } from "@/lib/prisma";

async function resolveActor(allowPartner: boolean): Promise<WorkflowActor | null> {
  const session = await getServerSession(authOptions);
  const user = await getActiveUser(session);
  if (!user) return null;
  if (!hasPermission(user, "travel.access")) return null;
  if (user.role === ROLE_PARTNER) {
    // Default-deny: a PARTNER only passes on routes that explicitly opt in, and
    // only while bound to an ACTIVE agency.
    if (!allowPartner || !user.agencyId) return null;
    const agency = await prisma.agency.findUnique({ where: { id: user.agencyId }, select: { active: true } });
    if (!agency?.active) return null;
  } else if (!(await canAccessTravel(user.id, user.role))) {
    return null;
  }
  return {
    id: user.id,
    role: user.role,
    agencyId: user.role === ROLE_PARTNER ? user.agencyId : null,
    name: user.name,
    email: user.email,
    permissions: user.permissions,
  };
}

/** Staff actor. PARTNER accounts are always rejected here (default-deny). */
export function getTravelActor(): Promise<WorkflowActor | null> {
  return resolveActor(false);
}

/**
 * Staff OR PARTNER actor. Only the three read routes that serve partners use
 * this (own-agency request list/detail and issued client documents); each must
 * scope by actor.agencyId itself.
 */
export function getTravelOrPartnerActor(): Promise<WorkflowActor | null> {
  return resolveActor(true);
}

export function unauthorized(): NextResponse {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export function travelError(err: unknown, logPrefix: string): NextResponse {
  if (err instanceof WorkflowError) {
    return NextResponse.json(
      {
        error: err.message,
        code: err.code,
        ...(err.details !== undefined ? { details: err.details } : {}),
      },
      { status: err.httpStatus },
    );
  }
  if (err instanceof ResolutionError) {
    return NextResponse.json(
      { error: err.message, code: err.code, details: err.details ?? [] },
      { status: 400 },
    );
  }
  if (err instanceof ZodError) {
    return NextResponse.json({ error: err.errors }, { status: 400 });
  }
  console.error(logPrefix, err);
  // Unknown errors (Prisma internals, IO, bugs) must not leak their message —
  // it can contain SQL, paths or data. The detail stays in the server log.
  return NextResponse.json({ error: "Internal error" }, { status: 500 });
}
