/**
 * POST /api/auth/password-reset/confirm (W6a) — self-service password reset,
 * step 2: exchange an emailed token for a new password.
 *
 * Contract (do not weaken):
 *
 * - Wrong, expired, already-used and malformed tokens all get the SAME
 *   generic 400, and so does a token whose account is gone or inactive — the
 *   response never reveals which case it was. Only a password that violates
 *   the shared policy (lib/security/password-policy.ts) gets a different 400,
 *   carrying the policy message so the user can fix it; the token stays
 *   usable in that case.
 * - Confirm attempts are limited per hashed client IP (10/hour, counted on
 *   SecurityRequest rows) because the limit exists to slow online guessing
 *   against leaked tokens — so FAILED attempts count too. The 429 answer is
 *   generic and, like the request route, is answered BEFORE the bookkeeping
 *   insert so rejected attempts cannot grow the table without limit.
 * - The bookkeeping row stores hashes only: the ipHash and the sha256 of the
 *   presented token (which for a valid token equals the stored tokenHash).
 *   The raw token and raw IP are never persisted.
 * - The reset itself is ONE transaction: the token is claimed atomically
 *   (a concurrent replay finds it already used), the bcrypt hash (cost 10,
 *   like the users API) is stored, sessionVersion is incremented — ending
 *   every session minted before the reset via the sv check in
 *   lib/access-policy.ts — and the user's other unused tokens are
 *   invalidated.
 * - The audit row (PASSWORD_RESET_COMPLETED) is attributed to the user and
 *   holds neither the token nor the email; the confirmation email is
 *   best-effort — a mail failure never changes the response.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { clientIpFromHeaders, hashClientIp } from "@/lib/partners/abuse";
import { SECURITY_REQUEST_KIND_CONFIRM, checkConfirmLimits } from "@/lib/security/limits";
import { passwordSchemaFor } from "@/lib/security/password-policy";
import {
  hashResetToken,
  isResetTokenExpired,
  verifyResetToken,
} from "@/lib/security/reset-token";
import { sendPasswordResetConfirmationEmail } from "@/lib/security/emails";

const GENERIC_INVALID_BODY = {
  error: "This reset link is invalid or has expired. Please request a new one.",
} as const;

const GENERIC_LIMIT_BODY = {
  error: "Too many requests. Please try again later.",
} as const;

const SUCCESS_BODY = {
  message: "Your password has been changed. You can now sign in with your new password.",
} as const;

// Loose on purpose: token shape problems are indistinguishable from unknown
// tokens (both get the generic 400), and password LENGTH rules belong to the
// shared policy so their violations answer with the policy message, not this
// generic one.
const confirmSchema = z.object({
  token: z.string().min(1).max(256),
  password: z.string().min(1),
});

function genericInvalid(): NextResponse {
  return NextResponse.json(GENERIC_INVALID_BODY, { status: 400 });
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return genericInvalid();
  }
  const parsed = confirmSchema.safeParse(body);
  if (!parsed.success) return genericInvalid();
  const { token, password } = parsed.data;

  try {
    const ipHash = hashClientIp(clientIpFromHeaders(req.headers));

    const limit = await checkConfirmLimits(prisma, ipHash);
    if (limit === "ip") {
      return NextResponse.json(GENERIC_LIMIT_BODY, { status: 429 });
    }

    // Every real attempt is counted, including failures — the limit exists to
    // slow guessing, so only well-formed bodies that got past the 429
    // short-circuit land here. Hashes only: the subject is the sha256 of the
    // presented token, never the token itself.
    const tokenHash = hashResetToken(token);
    await prisma.securityRequest.create({
      data: { kind: SECURITY_REQUEST_KIND_CONFIRM, subjectHash: tokenHash, ipHash },
    });

    const tokenRow = await prisma.passwordResetToken.findUnique({ where: { tokenHash } });
    // Defense in depth: the unique-hash lookup already implies equality, but
    // the comparison itself stays constant-time (lib/security/reset-token.ts).
    if (!tokenRow || !verifyResetToken(token, tokenRow.tokenHash)) return genericInvalid();
    if (tokenRow.usedAt !== null || isResetTokenExpired(tokenRow.expiresAt)) {
      return genericInvalid();
    }

    const user = await prisma.user.findUnique({
      where: { id: tokenRow.userId },
      select: { id: true, email: true, active: true },
    });
    // An inactive (or deleted) account cannot be reset; the answer is the
    // same generic 400 so the response reveals nothing about the account.
    if (!user || !user.active) return genericInvalid();

    // Policy violations are the ONLY distinguishable 400: the message tells
    // the user what to fix, and the token is left untouched so they can retry
    // with a compliant password.
    const passwordCheck = passwordSchemaFor(user.email).safeParse(password);
    if (!passwordCheck.success) {
      return NextResponse.json(
        { error: passwordCheck.error.issues[0]?.message ?? "Password does not meet the policy" },
        { status: 400 },
      );
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const completed = await prisma.$transaction(async (tx) => {
      // Atomic claim: a concurrent confirm of the same token finds usedAt
      // already set and aborts here, so one link can never reset twice.
      const claimed = await tx.passwordResetToken.updateMany({
        where: { id: tokenRow.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (claimed.count === 0) return false;
      await tx.user.update({
        where: { id: user.id },
        data: { password: passwordHash, sessionVersion: { increment: 1 } },
      });
      // The user's other unused tokens die with the reset.
      await tx.passwordResetToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      return true;
    });
    if (!completed) return genericInvalid();

    await writeAuditLog(
      "PASSWORD_RESET_COMPLETED",
      user.id,
      "Password reset via emailed token; all sessions revoked",
    );

    try {
      await sendPasswordResetConfirmationEmail(user.email);
    } catch (mailErr) {
      console.error("[API /auth/password-reset/confirm] confirmation email failed:", mailErr);
    }

    return NextResponse.json(SUCCESS_BODY, { status: 200 });
  } catch (err) {
    console.error("[API /auth/password-reset/confirm] failed:", err);
    return NextResponse.json(
      { error: "Something went wrong. Please try again later." },
      { status: 500 },
    );
  }
}
