/**
 * /uploads/* media access tests (W1, msg-access): lib/uploads.ts is mounted in
 * server.ts before the Next.js handler; here it runs on a throwaway HTTP
 * server with REAL NextAuth JWT cookies (next-auth/jwt encode/decode against
 * NEXTAUTH_SECRET) and the seeded throwaway DB, so the whole gate is
 * exercised: cookie validity + expiry, the active/inbox-role DB check, path
 * traversal, leak-free 401/403/404 behavior, and the routing that decodes /
 * normalizes the pathname before deciding (encoded spellings must be
 * intercepted, undecodable URLs get 400, non-GET/HEAD methods get 405).
 */

import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encode } from "next-auth/jwt";
import type { PrismaClient } from "@prisma/client";
import { ensureSchema, getPrisma } from "../travel-db/helpers";
import { handleUploadsRequest, routeUploadsRequest } from "@/lib/uploads";

const SECRET = "uploads-test-secret-min-32-characters!!";
process.env.NEXTAUTH_SECRET = SECRET;

const UPLOAD_DIR = path.join(process.cwd(), "public", "uploads");
const FILE_NAME = `w1-access-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}.txt`;
const FILE_CONTENT = "secret media payload";

let prisma: PrismaClient;
let server: Server;
let baseUrl: string;

let user: { id: string; role: string };
let admin: { id: string; role: string };
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

async function get(pathname: string, cookie?: string, method = "GET") {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  return fetch(`${baseUrl}${pathname}`, { method, headers, redirect: "manual" });
}

beforeAll(async () => {
  ensureSchema();
  prisma = await getPrisma();

  admin = await prisma.user.create({ data: { email: "upl-admin@test.io", name: "Admin", password: "x", role: "ADMIN" } });
  user = await prisma.user.create({ data: { email: "upl-user@test.io", name: "User", password: "x", role: "USER" } });
  advisor = await prisma.user.create({ data: { email: "upl-advisor@test.io", name: "Advisor", password: "x", role: "ADVISOR" } });
  validator = await prisma.user.create({ data: { email: "upl-validator@test.io", name: "Validator", password: "x", role: "VALIDATOR" } });
  inactive = await prisma.user.create({
    data: { email: "upl-inactive@test.io", name: "Inactive", password: "x", role: "USER", active: false },
  });

  mkdirSync(UPLOAD_DIR, { recursive: true });
  writeFileSync(path.join(UPLOAD_DIR, FILE_NAME), FILE_CONTENT);

  // Mirror the server.ts wiring: routeUploadsRequest decides, the media gate
  // handles, and anything else falls through to a stand-in Next handler whose
  // body identifies it, so tests can tell "intercepted" apart from "leaked".
  server = createServer((req, res) => {
    let pathname: string | null = null;
    try {
      pathname = req.url ? new URL(req.url, "http://localhost").pathname : null;
    } catch {
      pathname = null;
    }
    if (pathname) {
      const route = routeUploadsRequest(req.method ?? "", pathname);
      if (route.kind === "handle") {
        handleUploadsRequest(req, res, pathname).catch((err) => {
          console.error("[test uploads] error:", err);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Internal error" }));
          } else {
            res.destroy();
          }
        });
        return;
      }
      if (route.kind === "bad-request") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Bad request" }));
        return;
      }
      if (route.kind === "method-not-allowed") {
        res.writeHead(405, { "Content-Type": "application/json", Allow: "GET, HEAD" });
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "next-handler" }));
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  // fetch() keeps sockets alive; close them so server.close() can resolve.
  (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  rmSync(path.join(UPLOAD_DIR, FILE_NAME), { force: true });
});

describe("authentication", () => {
  it("401 without a cookie, with a tampered cookie, and with an expired cookie", async () => {
    const anon = await get(`/uploads/${FILE_NAME}`);
    expect(anon.status).toBe(401);
    expect(await anon.text()).not.toBe(FILE_CONTENT);

    const tampered = await get(`/uploads/${FILE_NAME}`, "next-auth.session-token=not.a.jwe");
    expect(tampered.status).toBe(401);

    const expired = await get(`/uploads/${FILE_NAME}`, await cookieFor(user, -3600));
    expect(expired.status).toBe(401);
  });

  it("401 for a deactivated user, even with a valid unexpired cookie", async () => {
    const res = await get(`/uploads/${FILE_NAME}`, await cookieFor(inactive));
    expect(res.status).toBe(401);
  });

  it("401 for a cookie whose sv no longer matches the user's session version; 200 for the current sv (W1b)", async () => {
    // Dedicated user: the shared fixtures above are reused by other suites.
    const bumped = await prisma.user.create({
      data: { email: "upl-bumped@test.io", name: "Bumped", password: "x", role: "USER" },
    });

    // A fresh user sits at version 0; a token carrying sv 0 serves the file.
    expect((await get(`/uploads/${FILE_NAME}`, await cookieFor(bumped, 60 * 60, 0))).status).toBe(200);

    // Revoke all issued sessions: bump User.sessionVersion atomically (the
    // same { increment: 1 } update revokeAllSessions performs).
    await prisma.user.update({ where: { id: bumped.id }, data: { sessionVersion: { increment: 1 } } });

    const stale = await get(`/uploads/${FILE_NAME}`, await cookieFor(bumped, 60 * 60, 0));
    expect(stale.status).toBe(401);
    expect(await stale.text()).not.toBe(FILE_CONTENT);

    const current = await get(`/uploads/${FILE_NAME}`, await cookieFor(bumped, 60 * 60, 1));
    expect(current.status).toBe(200);
    expect(await current.text()).toBe(FILE_CONTENT);

    // A pre-W1b token with no sv claim at all counts as 0 — a real version,
    // not a bypass — so the revocation revokes it like any other stale token.
    expect((await get(`/uploads/${FILE_NAME}`, await cookieFor(bumped))).status).toBe(401);
  });

  it("accepts the __Secure- prefixed cookie name used on HTTPS deployments", async () => {
    const token = await encode({ token: { id: user.id, role: user.role }, secret: SECRET, maxAge: 3600 });
    const res = await get(`/uploads/${FILE_NAME}`, `__Secure-next-auth.session-token=${token}`);
    expect(res.status).toBe(200);
  });
});

describe("authorization", () => {
  it("403 for active travel-only roles (ADVISOR/VALIDATOR)", async () => {
    for (const who of [advisor, validator]) {
      const res = await get(`/uploads/${FILE_NAME}`, await cookieFor(who));
      expect(res.status).toBe(403);
      expect(await res.text()).not.toBe(FILE_CONTENT);
    }
  });

  it("200 with Cache-Control: private, no-store and the file's mime type for inbox roles", async () => {
    for (const who of [user, admin]) {
      const res = await get(`/uploads/${FILE_NAME}`, await cookieFor(who));
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("content-type")).toBe("text/plain");
      expect(await res.text()).toBe(FILE_CONTENT);
    }
  });

  it("HEAD returns headers without a body", async () => {
    const res = await get(`/uploads/${FILE_NAME}`, await cookieFor(user), "HEAD");
    expect(res.status).toBe(200);
    expect(Number(res.headers.get("content-length"))).toBe(FILE_CONTENT.length);
    expect(await res.text()).toBe("");
  });
});

describe("path handling and leak prevention", () => {
  it("never serves outside public/uploads/ via an encoded traversal attempt", async () => {
    // `/uploads/%2e%2e/%2e%2e/package.json` decodes + normalizes to
    // `/package.json`, i.e. OUTSIDE /uploads — the router deliberately sends
    // it to the Next handler (which 404s: nothing lives at public root), and
    // the file content is never served, with or without a session.
    const traversal = await get(`/uploads/%2e%2e/%2e%2e/package.json`, await cookieFor(user));
    expect(traversal.status).toBe(404);
    expect(await traversal.text()).not.toContain('"name"');

    // Same for an anonymous caller — the request stays anonymous all the way
    // through the (fake) Next handler, never touching the media gate.
    const anonTraversal = await get(`/uploads/%2e%2e/%2e%2e/package.json`);
    expect(anonTraversal.status).toBe(404);
    expect(await anonTraversal.text()).not.toContain('"name"');
  });

  it("404 for a missing file, and existence is never leaked to unauthorized callers", async () => {
    const missing = `w1-access-test-missing-${process.pid}.txt`;
    expect((await get(`/uploads/${missing}`, await cookieFor(user))).status).toBe(404);

    // Existing vs missing files are indistinguishable without a valid inbox session.
    for (const who of [advisor, validator, inactive]) {
      expect((await get(`/uploads/${FILE_NAME}`, await cookieFor(who))).status).toBe(
        (await get(`/uploads/${missing}`, await cookieFor(who))).status,
      );
    }
    expect((await get(`/uploads/${FILE_NAME}`)).status).toBe((await get(`/uploads/${missing}`)).status);
  });
});

describe("routing (server level)", () => {
  it("intercepts encoded spellings of /uploads and answers 401 without a cookie", async () => {
    // Regression: the raw url pathname keeps percent-encoding, and Next's
    // public/ lookup resolves the decoded path — these variants used to miss
    // the interception check and were served with no session (200).
    for (const variant of [`/%75ploads/${FILE_NAME}`, `/uploads%2F${FILE_NAME}`, `/%2Fuploads/${FILE_NAME}`]) {
      const res = await get(variant);
      expect(res.status).toBe(401);
      expect(await res.text()).not.toBe(FILE_CONTENT);
    }
  });

  it("routes an authorized request with an encoded prefix through the media gate (no content leak)", async () => {
    // Intercepted (not passed to Next) yet nothing is served: the raw pathname
    // keeps its encoding, so the gate's literal /uploads/ prefix match leaves
    // a remainder that resolves to no file — 404, never the payload.
    const res = await get(`/%75ploads/${FILE_NAME}`, await cookieFor(user));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(JSON.stringify({ error: "Not found" }));
    expect((await get(`/%75ploads/${FILE_NAME}`, await cookieFor(admin))).status).toBe(404);
  });

  it("serves a traversal that stays inside public/uploads/ after normalization", async () => {
    // fetch() normalizes a literal "..", so the segment arrives percent-encoded
    // like a real attack. Decoded+normalized this IS /uploads/<file>, so it is
    // intercepted and the gate resolves the raw remainder back to the file.
    const res = await get(`/uploads/w1-sub-dir/%2e%2e/${FILE_NAME}`, await cookieFor(user));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(FILE_CONTENT);
    expect((await get(`/uploads/w1-sub-dir/%2e%2e/${FILE_NAME}`)).status).toBe(401);
  });

  it("405 JSON (not the Next handler) for non-GET/HEAD methods on uploads paths", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      const res = await get(`/uploads/${FILE_NAME}`, undefined, method);
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, HEAD");
      expect(await res.text()).toBe(JSON.stringify({ error: "Method not allowed" }));
    }
    // Encoded spellings hit the 405 too — they are intercepted first.
    expect((await get(`/%75ploads/${FILE_NAME}`, undefined, "POST")).status).toBe(405);
  });

  it("400 for an undecodable pathname", async () => {
    const res = await get("/uploads/%zz");
    expect(res.status).toBe(400);
  });

  it("non-uploads paths still fall through to the Next handler", async () => {
    const res = await get("/dashboard");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(JSON.stringify({ error: "next-handler" }));
  });
});

describe("routeUploadsRequest (unit)", () => {
  it("matches /uploads only after decoding, slash-collapsing and normalization", () => {
    expect(routeUploadsRequest("GET", `/uploads/${FILE_NAME}`)).toEqual({ kind: "handle" });
    expect(routeUploadsRequest("HEAD", `/uploads/${FILE_NAME}`)).toEqual({ kind: "handle" });
    expect(routeUploadsRequest("GET", `/%75ploads/${FILE_NAME}`)).toEqual({ kind: "handle" });
    expect(routeUploadsRequest("GET", `/uploads%2F${FILE_NAME}`)).toEqual({ kind: "handle" });
    expect(routeUploadsRequest("GET", `/%2Fuploads/${FILE_NAME}`)).toEqual({ kind: "handle" });
    expect(routeUploadsRequest("GET", `//uploads/${FILE_NAME}`)).toEqual({ kind: "handle" });
    expect(routeUploadsRequest("GET", `/x/../uploads/${FILE_NAME}`)).toEqual({ kind: "handle" });
    expect(routeUploadsRequest("GET", "/uploads")).toEqual({ kind: "handle" });
    expect(routeUploadsRequest("GET", "/uploads/")).toEqual({ kind: "handle" });
  });

  it("passes non-uploads paths — including ones normalized away from /uploads — to Next", () => {
    expect(routeUploadsRequest("GET", "/dashboard")).toEqual({ kind: "next" });
    expect(routeUploadsRequest("GET", "/api/chats")).toEqual({ kind: "next" });
    expect(routeUploadsRequest("GET", "/uploads-other/x")).toEqual({ kind: "next" });
    expect(routeUploadsRequest("GET", `/uploads/../${FILE_NAME}`)).toEqual({ kind: "next" });
  });

  it("rejects non-GET/HEAD methods on uploads paths with method-not-allowed", () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      expect(routeUploadsRequest(method, `/uploads/${FILE_NAME}`)).toEqual({ kind: "method-not-allowed" });
    }
    expect(routeUploadsRequest("POST", `/%75ploads/${FILE_NAME}`)).toEqual({ kind: "method-not-allowed" });
    expect(routeUploadsRequest("POST", "/dashboard")).toEqual({ kind: "next" });
  });

  it("flags undecodable pathnames as bad-request", () => {
    expect(routeUploadsRequest("GET", "/uploads/%zz")).toEqual({ kind: "bad-request" });
    expect(routeUploadsRequest("GET", "/%")).toEqual({ kind: "bad-request" });
  });
});
