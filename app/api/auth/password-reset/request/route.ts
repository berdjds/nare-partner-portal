/**
 * POST /api/auth/password-reset/request (W6a) — self-service password reset,
 * step 1: ask for a reset link by email.
 *
 * Anti-enumeration contract (do not weaken):
 *
 * - Every well-formed attempt gets the SAME 200 JSON body, whether the email
 *   is unknown, belongs to an inactive account, or just hit its per-account
 *   limit. Unknown and inactive accounts get no link and no token row, but
 *   the hash + limit bookkeeping still runs so timing does not reveal
 *   account existence.
 * - The honeypot field (PASSWORD_RESET_HONEYPOT_FIELD, rendered hidden on
 *   /forgot-password) short-circuits to the same 200 with no work at all.
 * - Only the per-IP overflow is distinguishable: a generic 429 that names
 *   nothing. Unparseable or invalid bodies also answer the generic 200 —
 *   an invalid email can never identify an account anyway.
 * - The audit row (PASSWORD_RESET_REQUESTED) and the SecurityRequest
 *   bookkeeping rows store hashes only: never the raw email, IP or token.
 *
 * Issuing: one transaction invalidates the user's earlier unused tokens and
 * stores only the hash of the fresh token (30-minute lifetime). The email
 * send is best-effort — a mail failure never changes the response.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { clientIpFromHeaders, hashClientIp } from "@/lib/partners/abuse";
import {
  PASSWORD_RESET_HONEYPOT_FIELD,
  SECURITY_REQUEST_KIND_REQUEST,
  checkRequestLimits,
  hashResetEmail,
} from "@/lib/security/limits";
import {
  generateResetToken,
  hashResetToken,
  resetTokenExpiry,
} from "@/lib/security/reset-token";
import { sendPasswordResetEmail } from "@/lib/security/emails";

const GENERIC_OK_BODY = {
  message:
    "If an account exists for that email address, we have sent a link to reset the password.",
} as const;

const requestSchema = z.object({
  email: z.string().trim().email().max(254),
  [PASSWORD_RESET_HONEYPOT_FIELD]: z.string().max(1024).optional(),
});

function genericOk(): NextResponse {
  return NextResponse.json(GENERIC_OK_BODY, { status: 200 });
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return genericOk();
  }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) return genericOk();
  const { email } = parsed.data;
  const honeypot = parsed.data[PASSWORD_RESET_HONEYPOT_FIELD];
  if (honeypot && honeypot.trim().length > 0) return genericOk();

  try {
    const ipHash = hashClientIp(clientIpFromHeaders(req.headers));
    const subjectHash = hashResetEmail(email);

    const limit = await checkRequestLimits(prisma, { ipHash, subjectHash });

    // The per-IP overflow is answered BEFORE any bookkeeping: the IP outcome
    // does not depend on the account, and counting already-rejected requests
    // would let one client burn the global daily quota (and grow the
    // SecurityRequest and Log tables without limit) with 429s alone.
    if (limit === "ip") {
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429 },
      );
    }

    // Bookkeeping + audit for every remaining real attempt (hashes only), so
    // unknown emails cost the same work as known ones.
    await prisma.securityRequest.create({
      data: { kind: SECURITY_REQUEST_KIND_REQUEST, subjectHash, ipHash },
    });
    await writeAuditLog(
      "PASSWORD_RESET_REQUESTED",
      null,
      `Password reset requested for subject hash ${subjectHash}`,
    );

    // Per-email and global limits stay invisible behind the generic 200.
    if (limit !== null) return genericOk();

    // Users are stored with their original case (the users API stores the
    // address as submitted and login matches exactly), so look up the
    // address as typed; fall back to the lowercased form for accounts that
    // were seeded lowercase. hashResetEmail lowercases internally, so the
    // per-account quota bucket is case-insensitive either way.
    const user =
      (await prisma.user.findUnique({ where: { email } })) ??
      (email === email.toLowerCase()
        ? null
        : await prisma.user.findUnique({ where: { email: email.toLowerCase() } }));
    if (user && user.active) {
      const token = generateResetToken();
      await prisma.$transaction([
        // A new token invalidates the user's earlier unused ones.
        prisma.passwordResetToken.updateMany({
          where: { userId: user.id, usedAt: null },
          data: { usedAt: new Date() },
        }),
        prisma.passwordResetToken.create({
          data: {
            userId: user.id,
            tokenHash: hashResetToken(token),
            expiresAt: resetTokenExpiry(),
          },
        }),
      ]);
      try {
        await sendPasswordResetEmail(user.email, token);
      } catch (mailErr) {
        console.error("[API /auth/password-reset/request] reset email failed:", mailErr);
      }
    }

    return genericOk();
  } catch (err) {
    console.error("[API /auth/password-reset/request] failed:", err);
    return NextResponse.json(
      { error: "Something went wrong. Please try again later." },
      { status: 500 },
    );
  }
}
