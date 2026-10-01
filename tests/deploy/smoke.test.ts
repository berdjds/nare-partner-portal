/**
 * Smoke-test script tests (W3b, task smoke-test) for scripts/smoke-test.sh.
 *
 * scripts/smoke-test.sh is the curl-only post-deploy smoke test: it checks
 * that the portal serves /login, that the anonymous-access gates return 401
 * for the API and uploads, that the engine.io origin gate answers a foreign
 * Origin with 403, and that a cookie-less Socket.io namespace connect is
 * refused with the "unauthorized" connect error. These tests run the real
 * script with bash against a small in-process node:http stub that emulates
 * the portal on 127.0.0.1 with an ephemeral port — no external network.
 * The stub has three breakage flags (openApi, allowForeignOrigin,
 * acceptUnauthenticated) so each failure branch of the script is covered in
 * addition to the all-green path.
 */

import { spawn, spawnSync } from "child_process";
import type { IncomingMessage, Server, ServerResponse } from "http";
import { createServer } from "http";
import type { AddressInfo } from "net";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "smoke-test.sh");

const GATED_PATHS = [
  "/api/whatsapp/status",
  "/api/chats",
  "/api/permissions",
  "/api/users",
  "/uploads/x.jpg",
];

const HANDSHAKE_BODY =
  '0{"sid":"smoke-sid","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}';

interface StubFlags {
  /** The five auth-gated endpoints answer 200 instead of 401. */
  openApi?: boolean;
  /** The socket endpoint skips the 403 origin gate for any Origin. */
  allowForeignOrigin?: boolean;
  /** The namespace connect succeeds instead of returning "unauthorized". */
  acceptUnauthenticated?: boolean;
}

interface Stub {
  url: string;
  close: () => Promise<void>;
}

function handleRequest(flags: StubFlags, ownOrigin: string, req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", ownOrigin);
  const pathname = url.pathname;

  const send = (status: number, body: string, contentType = "text/plain"): void => {
    res.writeHead(status, { "Content-Type": contentType });
    res.end(body);
  };

  if (req.method === "GET" && pathname === "/login") {
    send(200, "<html><body>login</body></html>", "text/html");
    return;
  }

  if (req.method === "GET" && GATED_PATHS.includes(pathname)) {
    if (flags.openApi) {
      send(200, "{}", "application/json");
    } else {
      send(401, '{"error":"Unauthorized"}', "application/json");
    }
    return;
  }

  if (pathname === "/api/socket/") {
    const origin = req.headers.origin;
    if (!flags.allowForeignOrigin && origin !== ownOrigin) {
      send(403, "Forbidden");
      return;
    }
    const sid = url.searchParams.get("sid");
    if (req.method === "GET" && !sid) {
      send(200, HANDSHAKE_BODY);
      return;
    }
    if (req.method === "POST" && sid) {
      req.resume(); // drain the "40" namespace-connect packet
      send(200, "ok");
      return;
    }
    if (req.method === "GET" && sid) {
      if (flags.acceptUnauthenticated) {
        send(200, '40{"sid":"smoke-socket"}');
      } else {
        send(200, '44{"message":"unauthorized"}');
      }
      return;
    }
  }

  send(404, "Not Found");
}

async function startStub(flags: StubFlags = {}): Promise<Stub> {
  let server: Server;
  server = createServer((req, res) => {
    const address = server.address() as AddressInfo;
    handleRequest(flags, `http://127.0.0.1:${address.port}`, req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

// The stub server shares this process's event loop, so the script must run
// asynchronously: spawnSync would block the loop, the stub could never answer
// and every curl call would burn its full --max-time (HTTP 000 everywhere).
function runSmoke(url: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [SCRIPT_PATH, url]);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function passLines(stdout: string): string[] {
  return stdout.split("\n").filter((line) => line.startsWith("PASS "));
}

let currentStub: Stub | null = null;

async function useStub(flags: StubFlags = {}): Promise<Stub> {
  currentStub = await startStub(flags);
  return currentStub;
}

afterEach(async () => {
  if (currentStub) {
    await currentStub.close();
    currentStub = null;
  }
});

describe("scripts/smoke-test.sh", () => {
  it("passes all eight checks against a correctly gated portal", async () => {
    const stub = await useStub();
    const result = await runSmoke(stub.url);

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("8 passed, 0 failed");
    expect(result.stdout).toContain(`Smoke test for ${stub.url}`);
    expect(passLines(result.stdout), result.stdout + result.stderr).toHaveLength(8);
    expect(result.stdout).not.toContain("FAIL ");
    expect(result.stdout).not.toContain("Failed checks:");
  });

  it("fails every auth-gate check when the API answers anonymously (openApi)", async () => {
    const stub = await useStub({ openApi: true });
    const result = await runSmoke(stub.url);

    expect(result.status, result.stdout + result.stderr).toBe(1);
    for (const name of [
      "GET /api/whatsapp/status requires auth",
      "GET /api/chats requires auth",
      "GET /api/permissions requires auth",
      "GET /api/users requires auth",
      "GET /uploads/x.jpg requires auth",
    ]) {
      expect(result.stdout).toContain(`FAIL ${name}`);
    }
    // /login and both socket checks still pass.
    expect(passLines(result.stdout)).toHaveLength(3);
    expect(result.stdout).toContain("3 passed, 5 failed");
    expect(result.stdout).toContain("Failed checks:");
  });

  it("fails the foreign-origin check when the socket origin gate is open (allowForeignOrigin)", async () => {
    const stub = await useStub({ allowForeignOrigin: true });
    const result = await runSmoke(stub.url);

    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain("FAIL socket handshake with foreign Origin returns 403");
    // The other seven checks are unaffected.
    expect(passLines(result.stdout)).toHaveLength(7);
    expect(result.stdout).toContain("7 passed, 1 failed");
    expect(result.stdout).toContain("Failed checks:");
  });

  it("fails the cookie-less connect check when the namespace accepts anonymous sockets (acceptUnauthenticated)", async () => {
    const stub = await useStub({ acceptUnauthenticated: true });
    const result = await runSmoke(stub.url);

    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain("FAIL socket connect without cookie is refused (unauthorized)");
    expect(passLines(result.stdout)).toHaveLength(7);
    expect(result.stdout).toContain("7 passed, 1 failed");
    expect(result.stdout).toContain("Failed checks:");
  });

  it("the script passes bash -n", () => {
    const res = spawnSync("bash", ["-n", SCRIPT_PATH], { encoding: "utf8" });
    expect(res.status, res.stderr ?? "").toBe(0);
  });

  it("the script is shellcheck-clean when shellcheck is available", () => {
    const check = spawnSync("bash", ["-c", "command -v shellcheck"], { encoding: "utf8" });
    if (check.status !== 0) {
      return; // shellcheck not installed here — nothing to assert
    }
    const res = spawnSync("shellcheck", [SCRIPT_PATH], { encoding: "utf8" });
    expect(res.status, (res.stdout ?? "") + (res.stderr ?? "")).toBe(0);
  });
});
