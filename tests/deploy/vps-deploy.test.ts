/**
 * Deploy-gate tests (W1, task deploy-gate) for scripts/vps-deploy.sh and
 * docker-entrypoint.sh.
 *
 * scripts/vps-deploy.sh drives the whole VPS release (freeze, verified
 * backup, trial A/B, cutover, rollback). These tests run the real script
 * against a throwaway APP_ROOT with the docker CLI replaced by a test double
 * on PATH (tests/deploy/docker-stub.sh) that records every invocation and
 * scripts failures per scenario. Each decision branch is covered: backup
 * failure, trial A failure, trial B yes/no, cutover failure with and without
 * rollback compatibility, mount/build aborts before the freeze, and the
 * success path. Every scenario also asserts that data is never restored
 * automatically.
 */

import { spawnSync } from "child_process";
import {
  chmodSync,
  cpSync,
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
const DEPLOY_SCRIPT = path.join(REPO_ROOT, "scripts", "vps-deploy.sh");
const ENTRYPOINT_SCRIPT = path.join(REPO_ROOT, "docker-entrypoint.sh");
const DOCKER_STUB = path.join(REPO_ROOT, "tests", "deploy", "docker-stub.sh");
const APP_CONTAINER = "wacontrol-app";

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  dockerLog: string;
  appRoot: string;
}

function makeSourceTarball(appRoot: string): string {
  const srcDir = mkdtempSync(path.join(tmpdir(), "wacontrol-src-"));
  writeFileSync(path.join(srcDir, "docker-compose.yml"), "services: {}\n# test fixture\n");
  writeFileSync(path.join(srcDir, "candidate-marker.txt"), "candidate source");
  const tarball = path.join(appRoot, "wacontrol-source.tar.gz");
  const res = spawnSync("tar", ["-czf", tarball, "-C", srcDir, "."], { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`fixture tar failed: ${res.stderr}`);
  return tarball;
}

function setupAppRoot(): string {
  const appRoot = mkdtempSync(path.join(tmpdir(), "wacontrol-app-root-"));
  for (const dir of ["wacontrol-data", "wacontrol-uploads", "wacontrol-auth"]) {
    mkdirSync(path.join(appRoot, dir));
    writeFileSync(path.join(appRoot, dir, "MARKER.txt"), `${dir} marker`);
  }
  writeFileSync(path.join(appRoot, "docker-compose.yml"), "services: {}\n# test fixture\n");
  return appRoot;
}

function runDeploy(appRoot: string, stubEnv: Record<string, string> = {}): RunResult {
  const work = mkdtempSync(path.join(tmpdir(), "wacontrol-deploy-run-"));
  const stubBin = path.join(work, "bin");
  mkdirSync(stubBin);
  const dockerPath = path.join(stubBin, "docker");
  cpSync(DOCKER_STUB, dockerPath);
  chmodSync(dockerPath, 0o755);
  const logPath = path.join(work, "docker.log");
  const stateDir = path.join(work, "state");
  mkdirSync(stateDir);
  const tarball = makeSourceTarball(appRoot);

  const env: NodeJS.ProcessEnv = {
    ...(process.env as Record<string, string>),
    // Next.js global types make ProcessEnv.NODE_ENV required; carry the real
    // value (vitest runs as "test") so the spawnSync env overload is satisfied.
    NODE_ENV: (process.env.NODE_ENV ?? "test") as "test",
    PATH: `${stubBin}:${process.env.PATH ?? ""}`,
    WACONTROL_APP_ROOT: appRoot,
    WACONTROL_SOURCE_TARBALL: tarball,
    STUB_LOG: logPath,
    STUB_STATE_DIR: stateDir,
    WACONTROL_HEALTH_RETRIES: "2",
    WACONTROL_HEALTH_INTERVAL_SECONDS: "0",
    ...stubEnv,
  };
  // Allow stub env values to reference the app root.
  for (const [key, value] of Object.entries(env)) {
    env[key] = (value ?? "").split("{APP_ROOT}").join(appRoot);
  }

  const res = spawnSync("bash", [DEPLOY_SCRIPT], { env, encoding: "utf8" });
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    dockerLog: existsSync(logPath) ? readFileSync(logPath, "utf8") : "",
    appRoot,
  };
}

function lines(log: string): string[] {
  return log.split("\n").filter((line) => line.length > 0);
}

function countLine(log: string, exact: string): number {
  return lines(log).filter((line) => line === exact).length;
}

function assertInOrder(log: string, steps: string[]) {
  let cursor = 0;
  for (const step of steps) {
    const idx = log.indexOf(step, cursor);
    expect(idx, `docker step out of order or missing: "${step}"`).toBeGreaterThanOrEqual(0);
    cursor = idx + step.length;
  }
}

/** The deploy script must never pull data back out of a backup on its own. */
function expectNoAutomaticRestore(ctx: RunResult) {
  expect(ctx.dockerLog).not.toContain("backups/"); // docker never touches the backup dir
  expect(ctx.dockerLog).not.toMatch(/(^|\s)-x[zf]?\s/); // no extraction flags
  expect(ctx.stdout).not.toContain("restore complete");
  expect(ctx.stderr).not.toContain("restoring backup");
}

function expectDataMarkersIntact(appRoot: string) {
  for (const dir of ["wacontrol-data", "wacontrol-uploads", "wacontrol-auth"]) {
    expect(readFileSync(path.join(appRoot, dir, "MARKER.txt"), "utf8")).toBe(`${dir} marker`);
  }
}

describe("scripts/vps-deploy.sh", () => {
  it("success: build while serving, freeze, verified backup, trial A yes, trial B yes, cutover", () => {
    const appRoot = setupAppRoot();
    const ctx = runDeploy(appRoot);
    expect(ctx.status).toBe(0);
    const out = ctx.stdout + ctx.stderr;

    expect(out).toMatch(/WRITE FREEZE start \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);
    expect(out).toContain("WRITE FREEZE end");
    expect(out).toContain("no other container mounts the data dirs");
    expect(out).toContain("TRIAL A passed");
    expect(out).toContain("ROLLBACK_COMPATIBLE=yes");
    expect(out).toContain("CUTOVER complete");
    expect(out).toContain("deploy finished successfully");

    assertInOrder(ctx.dockerLog, [
      "build -t wacontrol:candidate",
      "tag wacontrol:latest wacontrol:previous",
      `stop ${APP_CONTAINER}`,
      "-p wacontrol-trial-a",
      "exec wacontrol-trial-a",
      "exec wacontrol-trial-a npm run db:seed",
      "exec wacontrol-trial-a npx tsx scripts/seed-travel-catalog.ts",
      "rm -f wacontrol-trial-a",
      "-p wacontrol-trial-b",
      "tag wacontrol:candidate wacontrol:latest",
      `compose -f ${path.join(appRoot, "docker-compose.yml")} up -d wacontrol_app`,
      `exec ${APP_CONTAINER}`,
    ]);
    expect(countLine(ctx.dockerLog, `stop ${APP_CONTAINER}`)).toBe(1);
    expect(ctx.dockerLog).toContain(`exec ${APP_CONTAINER} npm run db:seed`);

    // Verified backup with sha256 sidecar covering all three data dirs.
    const backups = readdirSync(path.join(appRoot, "backups"));
    const archives = backups.filter((f) => f.endsWith(".tar.gz"));
    expect(archives).toHaveLength(1);
    expect(backups).toContain(`${archives[0]}.sha256`);
    const listing = spawnSync("tar", ["-tzf", path.join(appRoot, "backups", archives[0])], {
      encoding: "utf8",
    });
    expect(listing.status).toBe(0);
    for (const dir of ["wacontrol-data", "wacontrol-uploads", "wacontrol-auth"]) {
      expect(listing.stdout).toContain(`${dir}/MARKER.txt`);
    }

    expectNoAutomaticRestore(ctx);
  });

  it("success: candidate whose first cutover probe fails but serves on a later probe deploys without rollback", () => {
    const appRoot = setupAppRoot();
    // The entrypoint runs `prisma db push` and boots Next before port 3000
    // listens, so the first cutover probe fails; the bounded retry passes on
    // the second probe and the deploy must not roll back.
    const ctx = runDeploy(appRoot, { STUB_FAIL_FIRST: "wacontrol-app:login:1" });
    expect(ctx.status).toBe(0);
    const out = ctx.stdout + ctx.stderr;

    expect(out).toContain("CUTOVER complete");
    expect(out).toContain("deploy finished successfully");
    expect(ctx.dockerLog).toContain(`exec ${APP_CONTAINER} npm run db:seed`);
    expect(ctx.dockerLog).not.toContain("rollback-compose.yml");
    expect(ctx.dockerLog).not.toContain("tag wacontrol:previous wacontrol:latest");
    expect(countLine(ctx.dockerLog, `stop ${APP_CONTAINER}`)).toBe(1); // freeze only
    expectNoAutomaticRestore(ctx);
  });

  it("backup failure: aborts, restarts the old container, never starts a trial", () => {
    const appRoot = setupAppRoot();
    // Block the backup target: mkdir -p fails on an existing regular file.
    writeFileSync(path.join(appRoot, "backups"), "not a directory");
    const ctx = runDeploy(appRoot);
    expect(ctx.status).toBe(1);
    const out = ctx.stdout + ctx.stderr;

    expect(out).toContain("WRITE FREEZE start");
    expect(out).toContain("WRITE FREEZE end");
    expect(out).toContain("backup failed");
    expect(ctx.dockerLog).toContain(`stop ${APP_CONTAINER}`);
    expect(ctx.dockerLog).toContain(`start ${APP_CONTAINER}`);
    expect(ctx.dockerLog).not.toContain("up -d app"); // no trial container started
    expect(ctx.dockerLog).not.toContain("tag wacontrol:candidate wacontrol:latest");
    expect(statSync(path.join(appRoot, "backups")).isDirectory()).toBe(false);
    expectDataMarkersIntact(appRoot);
    expectNoAutomaticRestore(ctx);
  });

  it("trial A failure: drops the trial container and restarts the old container on untouched data", () => {
    const appRoot = setupAppRoot();
    const ctx = runDeploy(appRoot, { STUB_FAIL_EXEC_ON: "wacontrol-trial-a:login" });
    expect(ctx.status).toBe(1);
    const out = ctx.stdout + ctx.stderr;

    expect(out).toContain("TRIAL A failed");
    assertInOrder(ctx.dockerLog, [
      `stop ${APP_CONTAINER}`,
      "-p wacontrol-trial-a",
      "rm -f wacontrol-trial-a",
      `start ${APP_CONTAINER}`,
    ]);
    expect(ctx.dockerLog).not.toContain("up -d wacontrol_app"); // no cutover
    expect(ctx.dockerLog).not.toContain("tag wacontrol:candidate wacontrol:latest");
    // The real data dirs were never mounted by any trial container.
    for (const line of lines(ctx.dockerLog)) {
      if (line.startsWith("compose ") || line.startsWith("run ")) {
        expect(line).not.toContain("wacontrol-data");
        expect(line).not.toContain("wacontrol-uploads");
        expect(line).not.toContain("wacontrol-auth");
      }
    }
    expectDataMarkersIntact(appRoot);
    expectNoAutomaticRestore(ctx);
  });

  it("trial B failure: records ROLLBACK_COMPATIBLE=no but the deploy still succeeds", () => {
    const appRoot = setupAppRoot();
    const ctx = runDeploy(appRoot, { STUB_FAIL_EXEC_ON: "wacontrol-trial-b:login" });
    expect(ctx.status).toBe(0);
    const out = ctx.stdout + ctx.stderr;

    expect(out).toContain("ROLLBACK_COMPATIBLE=no");
    expect(out).toContain("CUTOVER complete");
    expect(out).toContain("deploy finished successfully");
    expect(ctx.dockerLog).toContain("-p wacontrol-trial-b");
    expect(ctx.dockerLog).toContain(`compose -f ${path.join(appRoot, "docker-compose.yml")} up -d wacontrol_app`);
    expectNoAutomaticRestore(ctx);
  });

  it("cutover failure with ROLLBACK_COMPATIBLE=yes: rolls back to previous on the current data", () => {
    const appRoot = setupAppRoot();
    // The candidate fails every health-check retry; only after the rollback
    // does the restarted previous image pass a probe.
    const ctx = runDeploy(appRoot, {
      STUB_FAIL_FIRST: "wacontrol-app:login:2",
      WACONTROL_HEALTH_RETRIES: "2",
    });
    expect(ctx.status).toBe(1);
    const out = ctx.stdout + ctx.stderr;

    expect(out).toContain("CUTOVER FAILED");
    expect(out).toContain("ROLLBACK_COMPATIBLE=yes");
    expect(out).toContain("rollback OK");
    const rollbackLines = lines(ctx.dockerLog).filter((line) => line.includes("rollback-compose.yml"));
    expect(rollbackLines).toHaveLength(1);
    expect(rollbackLines[0]).toContain("up -d wacontrol_app");
    expect(ctx.dockerLog).toContain("tag wacontrol:previous wacontrol:latest");
    // Newly accepted data is kept — nothing is wiped or replaced.
    expectDataMarkersIntact(appRoot);
    expectNoAutomaticRestore(ctx);
  });

  it("cutover failure with ROLLBACK_COMPATIBLE=no: stops the candidate, prints the manual procedure, restores nothing", () => {
    const appRoot = setupAppRoot();
    const ctx = runDeploy(appRoot, {
      STUB_FAIL_EXEC_ON: "wacontrol-trial-b:login wacontrol-app:login",
    });
    expect(ctx.status).toBe(1);
    const out = ctx.stdout + ctx.stderr;

    expect(out).toContain("ROLLBACK_COMPATIBLE=no");
    expect(out).toContain("MANUAL RECOVERY PROCEDURE");
    expect(out).toContain("export-since");
    expect(out).toContain("fix forward");
    expect(out).toContain("restore-backup");
    // The pre-deploy backup is named in the procedure, not executed.
    const backups = readdirSync(path.join(appRoot, "backups")).filter((f) => f.endsWith(".tar.gz"));
    expect(backups).toHaveLength(1);
    expect(out).toContain(backups[0]);

    // Candidate stopped (freeze + post-cutover), no rollback attempted.
    expect(countLine(ctx.dockerLog, `stop ${APP_CONTAINER}`)).toBe(2);
    expect(ctx.dockerLog).not.toContain("rollback-compose.yml");
    expectDataMarkersIntact(appRoot);
    expectNoAutomaticRestore(ctx);
  });

  it("aborts before the freeze when another container mounts a data dir", () => {
    const appRoot = setupAppRoot();
    const ctx = runDeploy(appRoot, {
      STUB_PS_IDS: "aaa111 bbb222",
      STUB_OTHER_ID: "bbb222",
      STUB_OTHER_MOUNTS: "{APP_ROOT}/wacontrol-data",
    });
    expect(ctx.status).toBe(1);
    expect(ctx.stdout + ctx.stderr).toContain("refusing to deploy");
    expect(ctx.dockerLog).not.toContain(`stop ${APP_CONTAINER}`);
    expect(ctx.dockerLog).not.toContain("up -d app");
    expectNoAutomaticRestore(ctx);
  });

  it("candidate build failure leaves the running app untouched", () => {
    const appRoot = setupAppRoot();
    const ctx = runDeploy(appRoot, { STUB_FAIL_BUILD: "1" });
    expect(ctx.status).toBe(1);
    expect(ctx.stdout + ctx.stderr).toContain("candidate build failed");
    expect(ctx.dockerLog).not.toContain(`stop ${APP_CONTAINER}`);
    expectNoAutomaticRestore(ctx);
  });
});

describe("deploy scripts conventions", () => {
  it("both scripts run bash with set -euo pipefail", () => {
    for (const script of [DEPLOY_SCRIPT, ENTRYPOINT_SCRIPT]) {
      const src = readFileSync(script, "utf8");
      expect(src).toContain("#!/usr/bin/env bash");
      expect(src).toContain("set -euo pipefail");
    }
  });

  it("docker-entrypoint.sh still pushes the schema but never passes --accept-data-loss", () => {
    const src = readFileSync(ENTRYPOINT_SCRIPT, "utf8");
    expect(src).toContain("npm run db:push");
    expect(src).not.toContain("--accept-data-loss");
  });

  it("both scripts pass bash -n", () => {
    for (const script of [DEPLOY_SCRIPT, ENTRYPOINT_SCRIPT]) {
      const res = spawnSync("bash", ["-n", script], { encoding: "utf8" });
      expect(res.status, `${script}: ${res.stderr}`).toBe(0);
    }
  });

  it("both scripts are shellcheck-clean when shellcheck is available", () => {
    const check = spawnSync("bash", ["-c", "command -v shellcheck"], { encoding: "utf8" });
    if (check.status !== 0) {
      return; // shellcheck not installed here — nothing to assert
    }
    const res = spawnSync("shellcheck", [DEPLOY_SCRIPT, ENTRYPOINT_SCRIPT], { encoding: "utf8" });
    expect(res.status, res.stdout + res.stderr).toBe(0);
  });
});
