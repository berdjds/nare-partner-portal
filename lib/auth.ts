import { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import {
  SECURITY_REQUEST_KIND_LOGIN_FAIL,
  checkLoginLimits,
  clientIpFromSignInHeaders,
  hashLoginEmail,
  hashLoginIp,
} from "@/lib/security/login-limits";
import { hashPassword, needsRehash } from "@/lib/security/hash";
import { z } from "zod";

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

/** Hashed identifiers for the W7b sign-in throttle counters. */
type LoginSubject = { subjectHash: string; ipHash: string };

/**
 * Records one failed sign-in attempt on SecurityRequest (hashes only; unknown
 * emails are recorded too, so they are throttled exactly like known ones).
 * Best-effort: a recording fault never changes the authorize() outcome.
 */
async function recordLoginFailure(subject: LoginSubject | null): Promise<void> {
  if (!subject) return;
  try {
    await prisma.securityRequest.create({
      data: { kind: SECURITY_REQUEST_KIND_LOGIN_FAIL, ...subject },
    });
  } catch (err) {
    console.error("[auth] failed to record login failure:", err);
  }
}

export const authOptions: NextAuthOptions = {
  adapter: undefined, // credentials provider requires no adapter for JWT
  session: {
    strategy: "jwt",
    // 7 days instead of the 30-day default — W1b revocation (the sv claim)
    // only takes effect on re-reads, so token lifetime should not be generous.
    maxAge: 7 * 24 * 60 * 60,
  },
  providers: [
    CredentialsProvider({
      name: "Credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials, req) {
        const parsed = credentialsSchema.safeParse(credentials);
        if (!parsed.success) return null;

        // W7b sign-in throttling. Hashing, the limit check, failure recording
        // and the counter clear all run inside try/catch blocks that fail
        // OPEN: a throttle fault must never block a legitimate sign-in or
        // change what an attempt reveals about the account.
        let subject: LoginSubject | null = null;
        try {
          subject = {
            subjectHash: hashLoginEmail(parsed.data.email),
            ipHash: hashLoginIp(clientIpFromSignInHeaders(req?.headers)),
          };
          const verdict = await checkLoginLimits(prisma, subject);
          if (verdict) {
            // Throttled: the same null as a wrong password, without ever
            // checking it. The attempt is still recorded so the counters keep
            // pace with a sustained attack; the audit row (hashed identifiers
            // only) is written only when the quota is first reached.
            await prisma.securityRequest.create({
              data: { kind: SECURITY_REQUEST_KIND_LOGIN_FAIL, ...subject },
            });
            if (verdict.firstHit) {
              await writeAuditLog(
                "LOGIN_THROTTLED",
                null,
                `Sign-in throttled (${verdict.limit} limit): subject hash ${subject.subjectHash}, IP hash ${subject.ipHash}`,
              );
            }
            return null;
          }
        } catch (err) {
          subject = null;
          console.error("[auth] login throttle check failed, allowing attempt:", err);
        }

        const user = await prisma.user.findUnique({
          where: { email: parsed.data.email },
          select: {
            id: true,
            email: true,
            name: true,
            password: true,
            role: true,
            active: true,
            // W1b session version: minted into the JWT as the sv claim.
            sessionVersion: true,
          },
        });

        if (!user || !user.active) {
          await recordLoginFailure(subject);
          return null;
        }

        const valid = await bcrypt.compare(parsed.data.password, user.password);
        if (!valid) {
          await recordLoginFailure(subject);
          return null;
        }

        // A successful sign-in clears the account's counter (the per-IP
        // counter is shared across accounts and stays untouched).
        if (subject) {
          try {
            await prisma.securityRequest.deleteMany({
              where: {
                kind: SECURITY_REQUEST_KIND_LOGIN_FAIL,
                subjectHash: subject.subjectHash,
              },
            });
          } catch (err) {
            console.error("[auth] failed to clear login failure counter:", err);
          }
        }

        // W7b rehash-on-login: pre-W7b hashes were minted at cost 10. Awaited
        // so the upgrade is durable before the session exists, but best-effort
        // — a failed update never blocks the sign-in, and only the password
        // column is written (sessionVersion must not move here: bumping it
        // would revoke the session this very sign-in is about to mint).
        if (needsRehash(user.password)) {
          try {
            await prisma.user.update({
              where: { id: user.id },
              data: { password: await hashPassword(parsed.data.password) },
            });
          } catch (err) {
            console.error("[auth] failed to upgrade password hash cost:", err);
          }
        }

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          sv: user.sessionVersion,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = user.role;
        token.sv = user.sv ?? 0;
      }
      return token;
    },
    async session({ session, token }) {
      if (token) {
        session.user.id = token.id as string;
        session.user.role = token.role as string;
        session.user.sv = typeof token.sv === "number" ? token.sv : 0;
      }
      return session;
    },
  },
  pages: {
    signIn: "/login",
    error: "/login",
  },
};
