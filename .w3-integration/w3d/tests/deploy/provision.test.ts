/**
 * Tests for deploy/provision-server.sh (one-time staging provisioning).
 *
 * The script prepares the staging site (staging.portal.nare.am) on the
 * owner's server: staging data dirs, the discovered production Docker
 * network in the staging .env, and a managed staging block in the live
 * Caddyfile that is validated inside the caddy container before it ever
 * touches the live path. These tests run the real script against a
 * throwaway fixture Caddyfile with the docker CLI replaced by an inline
 * stub on PATH that records every invocation and scripts failures per
 * scenario (validate failure, reload failure, preset network). Static
 * checks pin the repo fixtures the script depends on.
 */

import { spawnSync } from "child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT = path.join(REPO_ROOT, "deploy", "provision-server.sh");

// Mirrors the live /opt/stack/Caddyfile (deploy/portal/Caddyfile.example).
const CADDYFILE_FIXTURE = [
  "{",
  "\temail admin@nare.am",
  "}",
  "",
  "portal.nare.am {",
  "\tencode gzip",
  "\treverse_proxy portal:3000",
  "}",
  "",
].join("\n");

// Inline docker CLI double, kept separate from tests/deploy/docker-stub.sh
// (which is tailored to scripts/vps-deploy.sh). Every invocation is appended
// to $STUB_LOG as one space-joined line; behavior is driven by STUB_* env:
//   STUB_NETWORK=<name>        network printed by `docker inspect portal-app`
//   STUB_FAIL_INSPECT=1        `docker inspect` exits 1
//   STUB_FAIL_VALIDATE=1       the `caddy validate` exec exits 1
//   STUB_FAIL_RELOAD=1         the `caddy reload` exec exits 1
//   STUB_VALIDATE_CAPTURE=<p>  where the validate exec saves its stdin
// No `set -e` here on purpose, same convention as docker-stub.sh.
const DOCKER_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "\${STUB_LOG:?STUB_LOG is required}"

cmd="\${1:-}"

case "$cmd" in
  inspect)
    if [ -n "\${STUB_FAIL_INSPECT:-}" ]; then
      exit 1
    fi
    printf '%s\\n' "\${STUB_NETWORK:-stack_portal_net}"
    exit 0
    ;;
  exec)
    joined="$*"
    case "$joined" in
      *"caddy validate"*)
        cat > "\${STUB_VALIDATE_CAPTURE:-$STUB_LOG.validate}"
        if [ -n "\${STUB_FAIL_VALIDATE:-}" ]; then
          exit 1
        fi
        exit 0
        ;;
      *"caddy reload"*)
        if [ -n "\${STUB_FAIL_RELOAD:-}" ]; then
          exit 1
        fi
        exit 0
        ;;
    esac
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`;

interface RunContext {
  root: string;
  caddyfile: string;
  stagingDir: string;
  logPath: string;
  env: NodeJS.ProcessEnv;
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  dockerLog: string;
}

function setup(): RunContext {
  const root = mkdtempSync(path.join(tmpdir(), "wacontrol-provision-"));
  const stubBin = path.join(root, "bin");
  mkdirSync(stubBin);
  const dockerPath = path.join(stubBin, "docker");
  writeFileSync(dockerPath, DOCKER_STUB);
  chmodSync(dockerPath, 0o755);
  const caddyfile = path.join(root, "Caddyfile");
  writeFileSync(caddyfile, CADDYFILE_FIXTURE);
  const logPath = path.join(root, "docker.log");
  const env: NodeJS.ProcessEnv = {
    ...(process.env as Record<string, string>),
    // Next.js global types make ProcessEnv.NODE_ENV required; carry the real
    // value (vitest runs as "test") so the spawnSync env overload is satisfied.
    NODE_ENV: (process.env.NODE_ENV ?? "test") as "test",
    PATH: `${stubBin}:${process.env.PATH ?? ""}`,
    PORTAL_CADDYFILE: caddyfile,
    PORTAL_STAGING_DIR: path.join(root, "staging"),
    STUB_LOG: logPath,
  };
  return { root, caddyfile, stagingDir: path.join(root, "staging"), logPath, env };
}

function run(ctx: RunContext, extraEnv: Record<string, string> = {}): RunResult {
  const res = spawnSync("bash", [SCRIPT], {
    env: { ...ctx.env, ...extraEnv },
    encoding: "utf8",
  });
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    dockerLog: existsSync(ctx.logPath) ? readFileSync(ctx.logPath, "utf8") : "",
  };
}

function backupsOf(ctx: RunContext): string[] {
  return readdirSync(ctx.root).filter((f) => f.startsWith("Caddyfile.bak."));
}

function assertInOrder(log: string, steps: string[]) {
  let cursor = 0;
  for (const step of steps) {
    const idx = log.indexOf(step, cursor);
    expect(idx, `docker step out of order or missing: "${step}"`).toBeGreaterThanOrEqual(0);
    cursor = idx + step.length;
  }
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

describe("deploy/provision-server.sh", () => {
  it("success: staging dirs, .env, managed block, backup, validate before reload", () => {
    const ctx = setup();
    const res = run(ctx);
    expect(res.status, res.stdout + res.stderr).toBe(0);

    for (const dir of ["data", "uploads", "auth"]) {
      expect(statSync(path.join(ctx.stagingDir, dir)).isDirectory()).toBe(true);
    }

    // The network came from the stubbed `docker inspect portal-app`.
    expect(readFileSync(path.join(ctx.stagingDir, ".env"), "utf8")).toContain(
      "PORTAL_NETWORK=stack_portal_net",
    );
    expect(res.dockerLog).toContain("inspect");
    expect(res.dockerLog).toContain("portal-app");

    const content = readFileSync(ctx.caddyfile, "utf8");
    expect(content.match(/^# BEGIN staging\.portal\.nare\.am/gm)).toHaveLength(1);
    expect(content.match(/^# END staging\.portal\.nare\.am$/gm)).toHaveLength(1);
    expect(content).toContain("staging.portal.nare.am {");
    expect(content).toContain("reverse_proxy portal-staging:3000");

    const backups = backupsOf(ctx);
    expect(backups).toHaveLength(1);
    expect(readFileSync(path.join(ctx.root, backups[0]), "utf8")).toBe(CADDYFILE_FIXTURE);

    // The candidate was validated inside the caddy container BEFORE reload.
    assertInOrder(res.dockerLog, [
      "caddy validate",
      "caddy reload --config /etc/caddy/Caddyfile",
    ]);
    const captured = readFileSync(`${ctx.logPath}.validate`, "utf8");
    expect(captured).toContain("# BEGIN staging.portal.nare.am");
    expect(captured).toContain("reverse_proxy portal-staging:3000");
  });

  it("idempotent: a second run regenerates a byte-identical Caddyfile", () => {
    const ctx = setup();
    const first = run(ctx);
    expect(first.status, first.stdout + first.stderr).toBe(0);
    const afterFirst = readFileSync(ctx.caddyfile, "utf8");

    const second = run(ctx);
    expect(second.status, second.stdout + second.stderr).toBe(0);
    const afterSecond = readFileSync(ctx.caddyfile, "utf8");

    expect(afterSecond).toBe(afterFirst);
    expect(afterSecond.match(/^# BEGIN staging\.portal\.nare\.am/gm)).toHaveLength(1);
    expect(afterSecond.match(/^# END staging\.portal\.nare\.am$/gm)).toHaveLength(1);
  });

  it("invalid candidate: exits 1, live Caddyfile untouched, no reload attempted", () => {
    const ctx = setup();
    const res = run(ctx, { STUB_FAIL_VALIDATE: "1" });
    expect(res.status).toBe(1);
    expect(readFileSync(ctx.caddyfile, "utf8")).toBe(CADDYFILE_FIXTURE);
    expect(backupsOf(ctx)).toHaveLength(1);
    expect(res.dockerLog).toContain("caddy validate");
    expect(res.dockerLog).not.toContain("caddy reload");
  });

  it("reload failure: exits 1 and restores the live Caddyfile from the backup", () => {
    const ctx = setup();
    const res = run(ctx, { STUB_FAIL_RELOAD: "1" });
    expect(res.status).toBe(1);
    expect(readFileSync(ctx.caddyfile, "utf8")).toBe(CADDYFILE_FIXTURE);
    expect(backupsOf(ctx)).toHaveLength(1);
  });

  it("preset PORTAL_NETWORK: skips discovery and records the given network", () => {
    const ctx = setup();
    const res = run(ctx, { PORTAL_NETWORK: "custom_net" });
    expect(res.status, res.stdout + res.stderr).toBe(0);
    expect(res.dockerLog).not.toContain("inspect");
    expect(readFileSync(path.join(ctx.stagingDir, ".env"), "utf8")).toContain(
      "PORTAL_NETWORK=custom_net",
    );
  });
});

describe("provisioning static checks", () => {
  it("provision-server.sh keeps /etc/caddy strictly container-internal", () => {
    const src = readFileSync(SCRIPT, "utf8");
    expect(src).not.toContain("portal-caddy");
    expect(src).not.toContain("portal-web");
    for (const line of src.split("\n")) {
      if (line.includes("/etc/caddy")) {
        expect(line, `host-level caddy path outside docker exec: ${line}`).toContain("docker exec");
      }
    }
  });

  it("no file under deploy/ or scripts/ references portal-caddy or portal-web", () => {
    for (const dir of ["deploy", "scripts"]) {
      for (const file of walk(path.join(REPO_ROOT, dir))) {
        const src = readFileSync(file, "utf8");
        expect(src, file).not.toContain("portal-caddy");
        expect(src, file).not.toContain("portal-web");
      }
    }
  });

  it("deploy/staging/docker-compose.yml matches the provisioned staging layout", () => {
    const src = readFileSync(path.join(REPO_ROOT, "deploy", "staging", "docker-compose.yml"), "utf8");
    expect(src).toContain("container_name: portal-staging");
    expect(src).toContain("WHATSAPP_DISABLED");
    expect(src).toContain("external: true");
    expect(src).toContain("${PORTAL_NETWORK");
    expect(src).toContain("/opt/stack/staging/data");
  });

  it("deploy/portal/docker-compose.yml matches the live production layout", () => {
    const src = readFileSync(path.join(REPO_ROOT, "deploy", "portal", "docker-compose.yml"), "utf8");
    expect(src).toContain("container_name: caddy");
    expect(src).toContain("image: caddy:2");
    expect(src).toContain("container_name: portal-app");
    expect(src).toContain("portal_net");
    expect(src).toContain("./Caddyfile:/etc/caddy/Caddyfile:ro");
    expect(src).toContain("${PORTAL_IMAGE_TAG}");
  });

  it("deploy/portal/Caddyfile.example mirrors the live site block", () => {
    const src = readFileSync(path.join(REPO_ROOT, "deploy", "portal", "Caddyfile.example"), "utf8");
    expect(src).toContain("portal.nare.am");
    expect(src).toContain("reverse_proxy portal:3000");
  });
});

describe("provision-server.sh conventions", () => {
  it("runs bash with set -euo pipefail", () => {
    const src = readFileSync(SCRIPT, "utf8");
    expect(src).toContain("#!/usr/bin/env bash");
    expect(src).toContain("set -euo pipefail");
  });

  it("passes bash -n", () => {
    const res = spawnSync("bash", ["-n", SCRIPT], { encoding: "utf8" });
    expect(res.status, res.stderr).toBe(0);
  });

  it("is shellcheck-clean when shellcheck is available", () => {
    const check = spawnSync("bash", ["-c", "command -v shellcheck"], { encoding: "utf8" });
    if (check.status !== 0) {
      return; // shellcheck not installed here — nothing to assert
    }
    const res = spawnSync("shellcheck", [SCRIPT], { encoding: "utf8" });
    expect(res.status, res.stdout + res.stderr).toBe(0);
  });
});
