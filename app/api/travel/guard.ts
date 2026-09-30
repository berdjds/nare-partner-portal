/**
 * Shared guard + error mapping for /api/travel routes.
 *
 * Every travel route requires a session whose current database role is in
 * TRAVEL_ROLES (ADMIN / ADVISOR / VALIDATOR) — or any user holding an active
 * validation assignment (v0.10.0). Role and session version are re-read from
 * the database via getActiveUser(), never trusted from the JWT, so a revoked
 * or stale token is rejected here. Finer-grained RBAC lives in the workflow
 * layer (lib/travel/workflow.ts), which throws WorkflowError with an HTTP
 * status that travelError() maps verbatim.
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { ZodError } from "zod";
import { authOptions } from "@/lib/auth";
import { getActiveUser } from "@/lib/access-policy";
import { canAccessTravel } from "@/lib/travel/access";
import { WorkflowError, type WorkflowActor } from "@/lib/travel/workflow";
import { ResolutionError } from "@/lib/travel/resolve";

export async function getTravelActor(): Promise<WorkflowActor | null> {
  const session = await getServerSession(authOptions);
  const user = await getActiveUser(session);
  if (!user) return null;
  if (!(await canAccessTravel(user.id, user.role))) return null;
  return {
    id: user.id,
    role: user.role,
    name: user.name,
    email: user.email,
  };
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
