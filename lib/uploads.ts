/**
 * Authenticated media serving for /uploads/*.
 *
 * Uploaded message media lives in public/uploads/, which Next.js would serve
 * to anyone (public/ is statically reachable). server.ts therefore intercepts
 * /uploads/* BEFORE the Next.js handler and runs this gate instead. The
 * routing decision (routeUploadsRequest) percent-decodes, slash-collapses and
 * normalizes the pathname before matching, so encoded spellings of /uploads
 * cannot slip past the gate into Next's decoded public/ lookup:
 *
 * 1. A valid, unexpired NextAuth session cookie (next-auth/jwt decode with
 *    NEXTAUTH_SECRET). Missing, malformed or expired → 401. NEXTAUTH_SECRET
 *    unset → fail closed (401), never serve unsigned.
 * 2. An ACTIVE user loaded from the database whose current role satisfies
 *    canUseInbox() (interim W1 policy — media belongs to the chat inbox).
 *    Unknown/deactivated → 401, valid but non-inbox role → 403.
 * 3. A normalized path strictly inside public/uploads/ (no traversal). The
 *    traversal/out-of-bounds and not-found cases all answer 404, so the
 *    response never leaks file existence to unauthorized callers: 401/403 are
 *    identical for existing and missing files.
 *
 * Authorized responses stream the file with its mime type and
 * Cache-Control: private, no-store (browser caches must not outlive a logout
 * or deactivation). Cookies are never logged.
 */

import type { IncomingMessage, ServerResponse } from "http";
import { createReadStream } from "fs";
import fs from "fs/promises";
import path from "path";
import { decode } from "next-auth/jwt";
import mime from "mime-types";
import { prisma } from "@/lib/prisma";
import { canUseInbox } from "@/lib/access-policy";

const UPLOAD_DIR = path.join(process.cwd(), "public", "uploads");

// NextAuth v4 uses the __Secure- prefix on HTTPS deployments (NEXTAUTH_URL
// starting with https://) and the plain name otherwise; accept both so the
// gate works in dev and behind the production reverse proxy alike.
const SESSION_COOKIE_NAMES = ["__Secure-next-auth.session-token", "next-auth.session-token"];

export function isUploadsRequest(pathname: string): boolean {
  return pathname === "/uploads" || pathname.startsWith("/uploads/");
}

export type UploadsRouteDecision =
  | { kind: "next" } // not an /uploads path — pass to the Next.js handler
  | { kind: "handle" } // GET/HEAD /uploads/* — run the media gate
  | { kind: "bad-request" } // undecodable pathname — 400
  | { kind: "method-not-allowed" }; // non-GET/HEAD on /uploads/* — 405

/**
 * Decides how server.ts must route a request before it reaches the Next.js
 * handler. `pathname` here is the RAW url pathname (new URL().pathname keeps
 * percent-encoding in place), and Next's own public-file lookup resolves the
 * DECODED path — so a plain prefix check on the raw spelling would let
 * /%75ploads/… or /uploads%2F… fall through to Next and be served unsigned.
 * Decode first (undecodable → 400), collapse duplicate slashes, then let
 * path.posix.normalize resolve dot segments before matching. GET/HEAD uploads
 * requests are handed to handleUploadsRequest with the RAW pathname so its
 * traversal checks still apply to the original encoding.
 */
export function routeUploadsRequest(method: string, pathname: string): UploadsRouteDecision {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { kind: "bad-request" };
  }
  const normalized = path.posix.normalize(decoded.replace(/\/{2,}/g, "/"));
  if (!isUploadsRequest(normalized)) return { kind: "next" };
  if (method !== "GET" && method !== "HEAD") return { kind: "method-not-allowed" };
  return { kind: "handle" };
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

/** Decodes and validates the session cookie; returns the user id or null. */
async function readTokenUserId(req: IncomingMessage): Promise<string | null> {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) return null; // fail closed rather than serve media unsigned
  const token = readSessionCookie(req);
  if (!token) return null;
  let payload: { exp?: number; id?: unknown; sub?: unknown } | null = null;
  try {
    payload = await decode({ token, secret });
  } catch {
    // Expired (JWTExpired), tampered with, or not a JWE — same answer: no session.
    return null;
  }
  if (!payload) return null;
  // decode() already enforces exp via jose (15s clock tolerance); re-check so an
  // absent exp can never slip through as "never expires".
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now()) return null;
  const id = payload.id ?? payload.sub;
  return typeof id === "string" && id ? id : null;
}

/**
 * Maps "/uploads/<name>" to an absolute path inside public/uploads/, or null
 * when the URL is malformed or escapes the uploads directory.
 */
export function resolveUploadPath(pathname: string): string | null {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname.slice("/uploads/".length));
  } catch {
    return null;
  }
  if (!rel || rel.includes("\0")) return null;
  // posix.normalize collapses ".." segments; anything still absolute or
  // parent-escaping is rejected before touching the filesystem.
  const normalized = path.posix.normalize(rel);
  if (path.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) {
    return null;
  }
  const root = path.resolve(UPLOAD_DIR);
  const abs = path.resolve(root, normalized);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

function sendJson(res: ServerResponse, status: number, body: { error: string }): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
    "Cache-Control": "private, no-store",
  });
  res.end(json);
}

/**
 * Handles a GET/HEAD /uploads/* request. Assumes isUploadsRequest() matched;
 * always terminates the response (never falls through to the Next handler).
 */
export async function handleUploadsRequest(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  const userId = await readTokenUserId(req);
  if (!userId) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, active: true, role: true },
  });
  if (!user || !user.active) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }
  if (!canUseInbox(user.role)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  const abs = resolveUploadPath(pathname);
  if (!abs) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  let stat: Awaited<ReturnType<typeof fs.stat>> | null = null;
  try {
    stat = await fs.stat(abs);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isFile()) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  const type = mime.lookup(abs) || "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": stat.size,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }

  await new Promise<void>((resolvePromise) => {
    const stream = createReadStream(abs);
    stream.on("error", () => {
      // Headers are out; all we can do is cut the response short.
      res.destroy();
      resolvePromise();
    });
    stream.on("end", () => resolvePromise());
    stream.pipe(res);
  });
}
