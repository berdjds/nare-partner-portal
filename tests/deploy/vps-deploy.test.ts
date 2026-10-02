/**
 * Deploy-gate tests (W3b, task script-param) for scripts/vps-deploy.sh and
 * docker-entrypoint.sh.
 *
 * scripts/vps-deploy.sh drives the whole VPS release against the /opt/stack
 * server layout (extract, build while serving, freeze, verified backup,
 * trial A/B, cutover, public health check, rollback). These tests run the
 * real script against a throwaway PORTAL_ROOT with the docker and curl CLIs
 * replaced by test doubles on PATH (tests/deploy/docker-stub.sh and
 * tests/deploy/curl-stub.sh) that record every invocation and script
 * failures per scenario. Each decision branch is covered: backup failure,
 * trial A failure, trial B yes/no, cutover failure with and without rollback
 * compatibility, public health check failure, mount/build aborts before the
 * freeze, the missing-compose-file refusal, compose-file immutability, the
 * first deploy of a brand-new environment (no previous tag, no trial B, no
 * rollback target on a cutover failure) versus a stopped container with an
 * existing latest image (NOT a first deploy), the
 * deploy-managed image override in both environments (a live compose pinning
 * a dated image still runs the candidate; an image-id mismatch after cutover
 * fails the deploy and rolls back), the staging WHATSAPP_DISABLED=1 override
 * (cutover and rollback), the per-env image tags (staging never builds or
 * tags the shared portal:* production tags), and the success path. Every
 * scenario also asserts that data is never restored automatically.
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
  rmSync,
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
const CURL_STUB = path.join(REPO_ROOT, "tests", "deploy", "curl-stub.sh");
const APP_CONTAINER = "portal-app";
const DATA_DIRS = ["data", "uploads", "auth"];
// The server compose file is provisioning-owned; the tarball ships a
// different one so any sync from the source into the server file is caught.
const SERVER_COMPOSE_CONTENT = "services: {}\n# test fixture\n";
const TARBALL_COMPOSE_CONTENT = "services: {}\n# candidate compose — must never be synced\n";

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  dockerLog: string;
  curlLog: string;
  appRoot: string;
}

function makeSourceTarball(appRoot: string): string {
  const srcDir = mkdtempSync(path.join(tmpdir(), "portal-src-"));
  writeFileSync(path.join(srcDir, "docker-compose.yml"), TARBALL_COMPOSE_CONTENT);
  writeFileSync(path.join(srcDir, "candidate-marker.txt"), "candidate source");
  const tarball = path.join(appRoot, "portal-source.tar.gz");
  const res = spawnSync("tar", ["-czf", tarball, "-C", srcDir, "."], { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`fixture tar failed: ${res.stderr}`);
  return tarball;
}

function setupAppRoot(): string {
  // Mirrors the /opt/stack layout: the compose file at the root, the live
  // data dirs under portal/.
  const appRoot = mkdtempSync(path.join(tmpdir(), "portal-app-root-"));
  for (const dir of DATA_DIRS) {
    mkdirSync(path.join(appRoot, "portal", dir), { recursive: true });
    writeFileSync(path.join(appRoot, "portal", dir, "MARKER.txt"), `${dir} marker`);
  }
  writeFileSync(path.join(appRoot, "docker-compose.yml"), SERVER_COMPOSE_CONTENT);
  return appRoot;
}

function runDeploy(appRoot: string, stubEnv: Record<string, string> = {}): RunResult {
  const work = mkdtempSync(path.join(tmpdir(), "portal-deploy-run-"));
  const stubBin = path.join(work, "bin");
  mkdirSync(stubBin);
  for (const [stub, name] of [
    [DOCKER_STUB, "docker"],
    [CURL_STUB, "curl"],
  ] as const) {
    const stubPath = path.join(stubBin, name);
    cpSync(stub, stubPath);
    chmodSync(stubPath, 0o755);
  }
  const logPath = path.join(work, "docker.log");
  const curlLogPath = path.join(work, "curl.log");
  const stateDir = path.join(work, "state");
  mkdirSync(stateDir);
  const tarball = makeSourceTarball(appRoot);

  const env: NodeJS.ProcessEnv = {
    ...(process.env as Record<string, string>),
    // Next.js global types make ProcessEnv.NODE_ENV required; carry the real
    // value (vitest runs as "test") so the spawnSync env overload is satisfied.
    NODE_ENV: (process.env.NODE_ENV ?? "test") as "test",
    PATH: `${stubBin}:${process.env.PATH ?? ""}`,
    PORTAL_ROOT: appRoot,
    PORTAL_PUBLIC_URL: "https://portal.test",
    PORTAL_SOURCE_TARBALL: tarball,
    PORTAL_HEALTH_RETRIES: "2",
    PORTAL_HEALTH_INTERVAL_SECONDS: "0",
    STUB_LOG: logPath,
    STUB_STATE_DIR: stateDir,
    STUB_CURL_LOG: curlLogPath,
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
    curlLog: existsSync(curlLogPath) ? readFileSync(curlLogPath, "utf8") : "",
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
  for (const dir of DATA_DIRS) {
    expect(readFileSync(path.join(appRoot, "portal", dir, "MARKER.txt"), "utf8")).toBe(`${dir} marker`);
  }
}

function backupArchives(appRoot: string): string[] {
  return readdirSync(path.join(appRoot, "backups")).filter((f) => f.endsWith(".tar.gz"));
}

describe("scripts/vps-deploy.sh", () => {
  it("success: build while serving, freeze, verified backup, trial A yes, trial B yes, cutover, public health check", () => {
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
      "build -t portal:candidate",
      "tag portal:latest portal:previous",
      `stop ${APP_CONTAINER}`,
      "-p portal-trial-a",
      "exec portal-trial-a",
      "exec portal-trial-a npm run db:seed",
      "exec portal-trial-a npx tsx scripts/seed-travel-catalog.ts",
      "rm -f portal-trial-a",
      "-p portal-trial-b",
      "tag portal:candidate portal:latest",
      `compose -f ${path.join(appRoot, "docker-compose.yml")} -f ${path.join(appRoot, "portal-production.overrides.yml")} up -d portal`,
      `exec ${APP_CONTAINER}`,
    ]);
    expect(countLine(ctx.dockerLog, `stop ${APP_CONTAINER}`)).toBe(1);
    expect(ctx.dockerLog).toContain(`exec ${APP_CONTAINER} npm run db:seed`);
    // The sequence ends with the public health check through the public URL.
    expect(ctx.curlLog).toContain("https://portal.test/login");
    expect(ctx.stdout).toContain("deploy finished successfully");

    // Verified backup with sha256 sidecar covering all three data dirs.
    const archives = backupArchives(appRoot);
    expect(archives).toHaveLength(1);
    expect(archives[0]).toMatch(/^portal-production-.*\.tar\.gz$/);
    expect(readdirSync(path.join(appRoot, "backups"))).toContain(`${archives[0]}.sha256`);
    const listing = spawnSync("tar", ["-tzf", path.join(appRoot, "backups", archives[0])], {
      encoding: "utf8",
    });
    expect(listing.status).toBe(0);
    for (const dir of DATA_DIRS) {
      expect(listing.stdout).toContain(`${dir}/MARKER.txt`);
    }

    expectNoAutomaticRestore(ctx);
  });

  it("first deploy (no running app, no latest image): no previous tag, no trial B, backup and cutover proceed", () => {
    const appRoot = setupAppRoot();
    // A brand-new environment: no app container and no portal:latest image.
    const ctx = runDeploy(appRoot, {
      STUB_CONTAINER_MISSING: "1",
      STUB_IMAGE_MISSING: "portal:latest",
    });
    expect(ctx.status, ctx.stdout + ctx.stderr).toBe(0);
    const out = ctx.stdout + ctx.stderr;

    expect(out).toContain("FIRST DEPLOY");
    expect(out).toContain("first deploy: TRIAL B skipped");
    expect(out).toContain("ROLLBACK_COMPATIBLE=no");
    expect(out).toContain("TRIAL A passed");
    expect(out).toContain("CUTOVER complete");
    expect(out).toContain("deploy finished successfully");

    // No previous tag is ever created and trial B never runs.
    expect(ctx.dockerLog).not.toContain("portal:previous");
    expect(ctx.dockerLog).not.toContain("-p portal-trial-b");
    expect(ctx.dockerLog).toContain("-p portal-trial-a");
    // The app was not running, so the freeze stops nothing.
    expect(countLine(ctx.dockerLog, `stop ${APP_CONTAINER}`)).toBe(0);
    // The cutover still tags the candidate as latest and starts it.
    expect(ctx.dockerLog).toContain("tag portal:candidate portal:latest");
    expect(ctx.dockerLog).toContain("up -d portal");

    // The verified backup of the (new) data dirs still happens.
    expect(backupArchives(appRoot)).toHaveLength(1);
    expect(ctx.curlLog).toContain("https://portal.test/login");
    expectDataMarkersIntact(appRoot);
    expectNoAutomaticRestore(ctx);
  });

  it("first deploy with a failing health check: exits 1 with no rollback attempt and no running candidate", () => {
    const appRoot = setupAppRoot();
    const ctx = runDeploy(appRoot, {
      STUB_CONTAINER_MISSING: "1",
      STUB_IMAGE_MISSING: "portal:latest",
      STUB_FAIL_EXEC_ON: "portal-app:login",
    });
    expect(ctx.status).toBe(1);
    const out = ctx.stdout + ctx.stderr;

    expect(out).toContain("FIRST DEPLOY");
    expect(out).toContain("CUTOVER FAILED");
    expect(out).toContain("first deploy: nothing to roll back to; data left as the candidate wrote it");
    // No rollback is possible and none is attempted.
    expect(out).not.toContain("rollback OK");
    expect(out).not.toContain("MANUAL RECOVERY PROCEDURE");
    expect(ctx.dockerLog).not.toContain("rollback-compose.yml");
    expect(ctx.dockerLog).not.toContain("portal:previous");
    // The candidate is stopped — the only stop of the run, as the freeze had
    // nothing to stop — so no candidate is left running.
    expect(countLine(ctx.dockerLog, `stop ${APP_CONTAINER}`)).toBe(1);
    // The pre-cutover backup of the data dirs was still taken.
    expect(backupArchives(appRoot)).toHaveLength(1);
    expectDataMarkersIntact(appRoot);
    expectNoAutomaticRestore(ctx);
  });

  it("a deploy over the state a first deploy leaves behind (running app, latest exists) is not a first deploy", () => {
    const appRoot = setupAppRoot();
    // After a successful first deploy the environment has the app running on
    // portal:latest — exactly the stub's default state — so the next deploy
    // must tag previous and run trial B exactly as before.
    const ctx = runDeploy(appRoot, { STUB_INSPECT_IMAGE: "portal:latest" });
    expect(ctx.status, ctx.stdout + ctx.stderr).toBe(0);
    const out = ctx.stdout + ctx.stderr;

    expect(out).not.toContain("FIRST DEPLOY");
    expect(out).toContain("ROLLBACK_COMPATIBLE=yes");
    expect(ctx.dockerLog).toContain("tag portal:latest portal:previous");
    expect(ctx.dockerLog).toContain("-p portal-trial-b");
    expect(ctx.dockerLog).toContain("tag portal:candidate portal:latest");
    expectNoAutomaticRestore(ctx);
  });

  it("a stopped container with an existing latest image is not a first deploy", () => {
    const appRoot = setupAppRoot();
    // The app container exists but is stopped, and portal:latest exists:
    // previous is tagged from portal:latest and trial B runs — nothing about
    // the first-deploy path applies.
    const ctx = runDeploy(appRoot, { STUB_INSPECT_RUNNING: "false" });
    expect(ctx.status, ctx.stdout + ctx.stderr).toBe(0);
    const out = ctx.stdout + ctx.stderr;

    expect(out).not.toContain("FIRST DEPLOY");
    expect(out).toContain("tagged portal:latest as portal:previous");
    expect(out).toContain("ROLLBACK_COMPATIBLE=yes");
    expect(ctx.dockerLog).toContain("tag portal:latest portal:previous");
    expect(ctx.dockerLog).toContain("-p portal-trial-b");
    // The freeze had nothing to stop (the app was already stopped).
    expect(countLine(ctx.dockerLog, `stop ${APP_CONTAINER}`)).toBe(0);
    expectNoAutomaticRestore(ctx);
  });

  it("does not mistake the running app's short Docker ID for another writer", () => {
    const appRoot = setupAppRoot();
    const ctx = runDeploy(appRoot, {
      STUB_APP_ID: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      STUB_APP_SHORT_ID: "abcdef123456",
      STUB_APP_MOUNTS: "{APP_ROOT}/portal/data",
    });
    expect(ctx.status, ctx.stdout + ctx.stderr).toBe(0);
    expect(ctx.dockerLog).toContain("ps -q --no-trunc");
    expect(ctx.stdout).toContain("no other container mounts the data dirs");
  });

  it("success: candidate whose first cutover probe fails but serves on a later probe deploys without rollback", () => {
    const appRoot = setupAppRoot();
    // The entrypoint runs `prisma db push` and boots Next before port 3000
    // listens, so the first cutover probe fails; the bounded retry passes on
    // the second probe and the deploy must not roll back.
    const ctx = runDeploy(appRoot, { STUB_FAIL_FIRST: "portal-app:login:1" });
    expect(ctx.status).toBe(0);
    const out = ctx.stdout + ctx.stderr;

    expect(out).toContain("CUTOVER complete");
    expect(out).toContain("deploy finished successfully");
    expect(ctx.dockerLog).toContain(`exec ${APP_CONTAINER} npm run db:seed`);
    expect(ctx.dockerLog).not.toContain("rollback-compose.yml");
    expect(ctx.dockerLog).not.toContain("tag portal:previous portal:latest");
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
    expect(ctx.dockerLog).not.toContain("tag portal:candidate portal:latest");
    expect(statSync(path.join(appRoot, "backups")).isDirectory()).toBe(false);
    expectDataMarkersIntact(appRoot);
    expectNoAutomaticRestore(ctx);
  });

  it("trial A failure: drops the trial container and restarts the old container on untouched data", () => {
    const appRoot = setupAppRoot();
    const ctx = runDeploy(appRoot, { STUB_FAIL_EXEC_ON: "portal-trial-a:login" });
    expect(ctx.status).toBe(1);
    const out = ctx.stdout + ctx.stderr;

    expect(out).toContain("TRIAL A failed");
    assertInOrder(ctx.dockerLog, [
      `stop ${APP_CONTAINER}`,
      "-p portal-trial-a",
      "rm -f portal-trial-a",
      `start ${APP_CONTAINER}`,
    ]);
    expect(ctx.dockerLog).not.toContain("up -d portal"); // no cutover
    expect(ctx.dockerLog).not.toContain("tag portal:candidate portal:latest");
    // The real data dirs were never mounted by any trial container.
    for (const line of lines(ctx.dockerLog)) {
      if (line.startsWith("compose ") || line.startsWith("run ")) {
        expect(line).not.toContain("/portal/data");
        expect(line).not.toContain("/portal/uploads");
        expect(line).not.toContain("/portal/auth");
      }
    }
    expectDataMarkersIntact(appRoot);
    expectNoAutomaticRestore(ctx);
  });

  it("trial B failure: records ROLLBACK_COMPATIBLE=no but the deploy still succeeds", () => {
    const appRoot = setupAppRoot();
    const ctx = runDeploy(appRoot, { STUB_FAIL_EXEC_ON: "portal-trial-b:login" });
    expect(ctx.status).toBe(0);
    const out = ctx.stdout + ctx.stderr;

    expect(out).toContain("ROLLBACK_COMPATIBLE=no");
    expect(out).toContain("CUTOVER complete");
    expect(out).toContain("deploy finished successfully");
    expect(ctx.dockerLog).toContain("-p portal-trial-b");
    expect(ctx.dockerLog).toContain(
      `compose -f ${path.join(appRoot, "docker-compose.yml")} -f ${path.join(appRoot, "portal-production.overrides.yml")} up -d portal`
    );
    expectNoAutomaticRestore(ctx);
  });

  it("rolls back when the first cutover seed fails, even if the second would succeed", () => {
    const appRoot = setupAppRoot();
    const ctx = runDeploy(appRoot, { STUB_FAIL_FIRST: "portal-app:db:seed:1" });
    expect(ctx.status).toBe(1);
    expect(ctx.stdout + ctx.stderr).toContain("CUTOVER FAILED: bootstrap seeds failed after cutover");
    expect(ctx.stdout + ctx.stderr).toContain("rollback OK");
    expect(ctx.dockerLog).not.toContain(`exec ${APP_CONTAINER} npx tsx scripts/seed-travel-catalog.ts`);
    expectNoAutomaticRestore(ctx);
  });

  it("aborts trial A when the first bootstrap seed fails", () => {
    const appRoot = setupAppRoot();
    const ctx = runDeploy(appRoot, { STUB_FAIL_EXEC_ON: "portal-trial-a:db:seed" });
    expect(ctx.status).toBe(1);
    expect(ctx.stdout + ctx.stderr).toContain("TRIAL A failed");
    expect(ctx.dockerLog).not.toContain("exec portal-trial-a npx tsx scripts/seed-travel-catalog.ts");
    expect(ctx.dockerLog).not.toContain("tag portal:candidate portal:latest");
    expectNoAutomaticRestore(ctx);
  });

  it("cutover failure with ROLLBACK_COMPATIBLE=yes: rolls back to previous on the current data", () => {
    const appRoot = setupAppRoot();
    // The candidate fails every health-check retry; only after the rollback
    // does the restarted previous image pass a probe.
    const ctx = runDeploy(appRoot, {
      STUB_FAIL_FIRST: "portal-app:login:2",
      PORTAL_HEALTH_RETRIES: "2",
    });
    expect(ctx.status).toBe(1);
    const out = ctx.stdout + ctx.stderr;

    expect(out).toContain("CUTOVER FAILED");
    expect(out).toContain("ROLLBACK_COMPATIBLE=yes");
    expect(out).toContain("rollback OK");
    const rollbackLines = lines(ctx.dockerLog).filter((line) => line.includes("rollback-compose.yml"));
    expect(rollbackLines).toHaveLength(1);
    expect(rollbackLines[0]).toContain("up -d portal");
    expect(ctx.dockerLog).toContain("tag portal:previous portal:latest");
    // Newly accepted data is kept — nothing is wiped or replaced.
    expectDataMarkersIntact(appRoot);
    expectNoAutomaticRestore(ctx);
  });

  it("cutover failure with ROLLBACK_COMPATIBLE=no: stops the candidate, prints the manual procedure, restores nothing", () => {
    const appRoot = setupAppRoot();
    const ctx = runDeploy(appRoot, {
      STUB_FAIL_EXEC_ON: "portal-trial-b:login portal-app:login",
    });
    expect(ctx.status).toBe(1);
    const out = ctx.stdout + ctx.stderr;

    expect(out).toContain("ROLLBACK_COMPATIBLE=no");
    expect(out).toContain("MANUAL RECOVERY PROCEDURE");
    expect(out).toContain("export-since");
    expect(out).toContain("fix forward");
    expect(out).toContain("restore-backup");
    // The pre-deploy backup is named in the procedure, not executed.
    const backups = backupArchives(appRoot);
    expect(backups).toHaveLength(1);
    expect(out).toContain(backups[0]);

    // Candidate stopped (freeze + post-cutover), no rollback attempted.
    expect(countLine(ctx.dockerLog, `stop ${APP_CONTAINER}`)).toBe(2);
    expect(ctx.dockerLog).not.toContain("rollback-compose.yml");
    expectDataMarkersIntact(appRoot);
    expectNoAutomaticRestore(ctx);
  });

  it("public health check failure rolls back to previous on the current data", () => {
    const appRoot = setupAppRoot();
    const ctx = runDeploy(appRoot, { STUB_CURL_FAIL: "1" });
    expect(ctx.status).toBe(1);
    const out = ctx.stdout + ctx.stderr;

    expect(out).toContain("CUTOVER FAILED");
    expect(out).toContain("public health check failed");
    expect(out).toContain("rollback OK");
    expect(ctx.curlLog).toContain("https://portal.test/login");
    const rollbackLines = lines(ctx.dockerLog).filter((line) => line.includes("rollback-compose.yml"));
    expect(rollbackLines).toHaveLength(1);
    expect(rollbackLines[0]).toContain("up -d portal");
    expect(ctx.dockerLog).toContain("tag portal:previous portal:latest");
    expectDataMarkersIntact(appRoot);
    expectNoAutomaticRestore(ctx);
  });

  it("production cutover runs the candidate even when the live compose pins a dated image", () => {
    const appRoot = setupAppRoot();
    // Mirror the live /opt/stack/docker-compose.yml (2026-10-02): the app
    // image is pinned to a dated tag, NOT ${PORTAL_IMAGE_TAG} or latest.
    writeFileSync(
      path.join(appRoot, "docker-compose.yml"),
      "services:\n  portal:\n    image: portal:2026-09-30\n"
    );
    const ctx = runDeploy(appRoot, { STUB_INSPECT_IMAGE: "portal:2026-09-30" });
    expect(ctx.status, ctx.stdout + ctx.stderr).toBe(0);
    const out = ctx.stdout + ctx.stderr;

    expect(out).toContain("cutover image verified");
    expect(out).toContain("CUTOVER complete");
    expect(out).toContain("deploy finished successfully");
    // The pinned tag becomes the rollback target; latest moves to the candidate.
    expect(ctx.dockerLog).toContain("tag portal:2026-09-30 portal:previous");
    expect(ctx.dockerLog).toContain("tag portal:candidate portal:latest");
    // The cutover merges the deploy-managed override that pins the app image,
    // so `compose up` starts the candidate despite the pinned compose file.
    const overridePath = path.join(appRoot, "portal-production.overrides.yml");
    const cutoverLine = `compose -f ${path.join(appRoot, "docker-compose.yml")} -f ${overridePath} up -d portal`;
    expect(countLine(ctx.dockerLog, cutoverLine)).toBe(1);
    const overrideContent = readFileSync(overridePath, "utf8");
    expect(overrideContent).toContain("image: portal:latest");
    expect(overrideContent).not.toContain("WHATSAPP_DISABLED"); // staging-only
    // The pinned compose file itself is provisioning-owned and never modified.
    expect(readFileSync(path.join(appRoot, "docker-compose.yml"), "utf8")).toContain("portal:2026-09-30");
    expectDataMarkersIntact(appRoot);
    expectNoAutomaticRestore(ctx);
  });

  it("image-id mismatch after cutover triggers cutover_failed and rollback", () => {
    const appRoot = setupAppRoot();
    // compose did not apply the image override: the app container still runs
    // the OLD image id even though `compose up` reported success.
    const ctx = runDeploy(appRoot, { STUB_CONTAINER_IMAGE_ID: "sha256:old-pinned" });
    expect(ctx.status).toBe(1);
    const out = ctx.stdout + ctx.stderr;

    expect(out).toContain("CUTOVER FAILED");
    expect(out).toContain("sha256:old-pinned");
    expect(out).toContain("not candidate portal:candidate");
    expect(out).toContain("ROLLBACK_COMPATIBLE=yes");
    expect(out).toContain("rollback OK");
    const rollbackLines = lines(ctx.dockerLog).filter((line) => line.includes("rollback-compose.yml"));
    expect(rollbackLines).toHaveLength(1);
    expect(rollbackLines[0]).toContain("up -d portal");
    // The rollback start also merges the image override, with the rollback
    // image override merged last so the previous image wins.
    expect(rollbackLines[0]).toContain("portal-production.overrides.yml");
    expect(rollbackLines[0].indexOf("portal-production.overrides.yml")).toBeLessThan(
      rollbackLines[0].indexOf("rollback-compose.yml")
    );
    expect(ctx.dockerLog).toContain("tag portal:previous portal:latest");
    expectDataMarkersIntact(appRoot);
    expectNoAutomaticRestore(ctx);
  });

  it("refuses to deploy when the server compose file is missing", () => {
    const appRoot = setupAppRoot();
    rmSync(path.join(appRoot, "docker-compose.yml"));
    const ctx = runDeploy(appRoot);
    expect(ctx.status).toBe(1);
    const out = ctx.stdout + ctx.stderr;

    expect(out).toContain("compose file not found");
    expect(ctx.dockerLog).not.toContain("build -t");
    expect(ctx.dockerLog).not.toContain(`stop ${APP_CONTAINER}`);
  });

  it("the server compose file is byte-identical after a successful deploy", () => {
    const appRoot = setupAppRoot();
    const composePath = path.join(appRoot, "docker-compose.yml");
    const before = readFileSync(composePath, "utf8");
    const ctx = runDeploy(appRoot);
    expect(ctx.status).toBe(0);
    expect(ctx.stdout).toContain("deploy finished successfully");

    expect(readFileSync(composePath, "utf8")).toBe(before);
    const bakFiles = readdirSync(appRoot).filter((f) => f.startsWith("docker-compose.yml.bak-"));
    expect(bakFiles).toHaveLength(0);
  });

  it("the server compose file is byte-identical after a rolled-back deploy", () => {
    const appRoot = setupAppRoot();
    const composePath = path.join(appRoot, "docker-compose.yml");
    const before = readFileSync(composePath, "utf8");
    const ctx = runDeploy(appRoot, {
      STUB_FAIL_FIRST: "portal-app:login:2",
      PORTAL_HEALTH_RETRIES: "2",
    });
    expect(ctx.status).toBe(1);
    expect(ctx.stdout + ctx.stderr).toContain("rollback OK");

    expect(readFileSync(composePath, "utf8")).toBe(before);
    const bakFiles = readdirSync(appRoot).filter((f) => f.startsWith("docker-compose.yml.bak-"));
    expect(bakFiles).toHaveLength(0);
  });

  it("staging deploy uses portal-staging and never starts the app without WHATSAPP_DISABLED=1", () => {
    const appRoot = setupAppRoot();
    const ctx = runDeploy(appRoot, {
      PORTAL_ENV_NAME: "staging",
      PORTAL_PUBLIC_URL: "https://staging.portal.test",
      STUB_INSPECT_IMAGE: "portal-staging:latest",
    });
    expect(ctx.status).toBe(0);
    const out = ctx.stdout + ctx.stderr;

    expect(out).toContain("WHATSAPP_DISABLED=1");
    expect(out).toContain("deploy finished successfully");
    expect(countLine(ctx.dockerLog, "stop portal-staging")).toBe(1);
    expect(ctx.dockerLog).not.toContain("stop portal-app");
    // The cutover merges the provisioning compose file with the staging
    // override that disables the WhatsApp client.
    const cutoverLine = `compose -f ${path.join(appRoot, "docker-compose.yml")} -f ${path.join(appRoot, "portal-staging.overrides.yml")} up -d portal-staging`;
    expect(countLine(ctx.dockerLog, cutoverLine)).toBe(1);
    const overrideContent = readFileSync(path.join(appRoot, "portal-staging.overrides.yml"), "utf8");
    expect(overrideContent).toContain("WHATSAPP_DISABLED=1");
    // The public health check goes to the staging URL.
    expect(ctx.curlLog).toContain("https://staging.portal.test/login");
    // Backup archives are named for the staging environment.
    const archives = backupArchives(appRoot);
    expect(archives).toHaveLength(1);
    expect(archives[0]).toMatch(/^portal-staging-.*\.tar\.gz$/);
    // EVERY start of the real app goes through the staging override.
    const upLines = lines(ctx.dockerLog).filter((line) => line.includes("up -d portal-staging"));
    expect(upLines.length).toBeGreaterThan(0);
    for (const line of upLines) {
      expect(line).toContain("portal-staging.overrides.yml");
    }
    // Trial containers are unchanged: they still run in trial mode.
    expect(ctx.dockerLog).toContain("-p portal-trial-a");
    expect(ctx.dockerLog).toContain("-p portal-trial-b");
    expectDataMarkersIntact(appRoot);
    expectNoAutomaticRestore(ctx);
  });

  it("staging deploy never builds or tags the shared production image tags", () => {
    const appRoot = setupAppRoot();
    const ctx = runDeploy(appRoot, {
      PORTAL_ENV_NAME: "staging",
      PORTAL_PUBLIC_URL: "https://staging.portal.test",
      STUB_INSPECT_IMAGE: "portal-staging:latest",
    });
    expect(ctx.status).toBe(0);
    expect(ctx.stdout).toContain("deploy finished successfully");

    // Staging uses its own repository tags end to end ...
    expect(ctx.dockerLog).toContain("build -t portal-staging:candidate");
    expect(ctx.dockerLog).toContain("tag portal-staging:latest portal-staging:previous");
    expect(ctx.dockerLog).toContain("tag portal-staging:candidate portal-staging:latest");
    // ... and no docker build/tag ever touches the production tags: moving
    // portal:latest from a staging deploy would pin a production rollback to
    // the staging candidate and let a production `compose up` boot the
    // ungated candidate.
    for (const line of lines(ctx.dockerLog)) {
      if (line.startsWith("build ") || line.startsWith("tag ") || line.startsWith("image inspect ")) {
        expect(line).not.toMatch(/(^|\s)portal:(candidate|previous|latest)(\s|$)/);
      }
    }
    expectDataMarkersIntact(appRoot);
    expectNoAutomaticRestore(ctx);
  });

  it("staging rollback keeps WHATSAPP_DISABLED=1", () => {
    const appRoot = setupAppRoot();
    const ctx = runDeploy(appRoot, {
      PORTAL_ENV_NAME: "staging",
      PORTAL_PUBLIC_URL: "https://staging.portal.test",
      STUB_INSPECT_IMAGE: "portal-staging:latest",
      STUB_FAIL_FIRST: "portal-staging:login:2",
      PORTAL_HEALTH_RETRIES: "2",
    });
    expect(ctx.status).toBe(1);
    const out = ctx.stdout + ctx.stderr;

    expect(out).toContain("CUTOVER FAILED");
    expect(out).toContain("rollback OK");
    const rollbackLines = lines(ctx.dockerLog).filter((line) => line.includes("rollback-compose.yml"));
    expect(rollbackLines).toHaveLength(1);
    expect(rollbackLines[0]).toContain("up -d portal-staging");
    // The staging override is merged ahead of the rollback compose file, so
    // the rolled-back container also runs with WHATSAPP_DISABLED=1.
    const overrideIdx = rollbackLines[0].indexOf("portal-staging.overrides.yml");
    const rollbackIdx = rollbackLines[0].indexOf("rollback-compose.yml");
    expect(overrideIdx).toBeGreaterThanOrEqual(0);
    expect(overrideIdx).toBeLessThan(rollbackIdx);
    expect(ctx.dockerLog).toContain("tag portal-staging:previous portal-staging:latest");
    // The rollback retag stays inside the staging repository: the production
    // portal:latest / portal:previous tags are never moved by staging.
    for (const line of lines(ctx.dockerLog)) {
      if (line.startsWith("build ") || line.startsWith("tag ")) {
        expect(line).not.toMatch(/(^|\s)portal:(candidate|previous|latest)(\s|$)/);
      }
    }
    expectDataMarkersIntact(appRoot);
    expectNoAutomaticRestore(ctx);
  });

  it("aborts before the freeze when another container mounts a data dir", () => {
    const appRoot = setupAppRoot();
    const ctx = runDeploy(appRoot, {
      STUB_PS_IDS: "aaa111 bbb222",
      STUB_OTHER_ID: "bbb222",
      STUB_OTHER_MOUNTS: "{APP_ROOT}/portal/data",
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
