/**
 * Staging drill tests (W3c) for scripts/portal-drill.sh and the staging-only
 * PORTAL_DRILL_FAIL_HEALTH hook in scripts/vps-deploy.sh, adapted to the W3b
 * portal layout (PORTAL_* variables, /opt/stack/staging root, installed
 * portal-deploy/portal-restore tools) in task layout-merge.
 *
 * portal-drill.sh proves on a staging host that (a) the deploy gate rolls
 * back without touching the data dirs when the post-cutover health check
 * fails (rollback drill) and (b) the restore tool really restores a verified
 * backup (restore drill). These tests run the real scripts via bash against a
 * throwaway staging root with the docker and curl CLIs replaced by the test
 * doubles on PATH (tests/deploy/docker-stub.sh, tests/deploy/curl-stub.sh),
 * exactly like the deploy-gate tests in vps-deploy.test.ts. The drill runs
 * the repo scripts as its child tools via the PORTAL_DEPLOY_TOOL /
 * PORTAL_RESTORE_TOOL overrides (on a real host they default to the installed
 * /usr/local/lib/portal-deploy/portal-deploy and portal-restore). The stub's
 * opt-in STUB_WRITE_ON feature simulates a container writing into a mounted
 * data dir so the drill's data-drift and restore-marker checks can be
 * exercised.
 *
 * The safety refusals (PORTAL_ENV_NAME must be "staging"; every data path
 * must resolve inside the staging root) are asserted to happen BEFORE any
 * docker call. The deploy gate hook is also exercised directly to prove it
 * is honoured in staging mode and ignored in production mode or when
 * PORTAL_ENV_NAME is unset.
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
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DRILL_SCRIPT = path.join(REPO_ROOT, "scripts", "portal-drill.sh");
const DEPLOY_SCRIPT = path.join(REPO_ROOT, "scripts", "vps-deploy.sh");
const RESTORE_SCRIPT = path.join(REPO_ROOT, "scripts", "restore-backup.sh");
const DOCKER_STUB = path.join(REPO_ROOT, "tests", "deploy", "docker-stub.sh");
const CURL_STUB = path.join(REPO_ROOT, "tests", "deploy", "curl-stub.sh");
const DATA_DIRS = ["data", "uploads", "auth"] as const;
/** Sentinel stubEnv value: remove the variable from the child environment. */
const UNSET = "<UNSET>";

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  dockerLog: string;
  stagingRoot: string;
}

function makeSourceTarball(stagingRoot: string): string {
  const srcDir = mkdtempSync(path.join(tmpdir(), "portal-src-"));
  writeFileSync(path.join(srcDir, "docker-compose.yml"), "services: {}\n# test fixture\n");
  writeFileSync(path.join(srcDir, "candidate-marker.txt"), "candidate source");
  const tarball = path.join(stagingRoot, "portal-source.tar.gz");
  const res = spawnSync("tar", ["-czf", tarball, "-C", srcDir, "."], { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`fixture tar failed: ${res.stderr}`);
  return tarball;
}

/** The three data dirs under portal/ (each with a marker file) plus the compose file. */
function writeDataFixture(root: string) {
  for (const dir of DATA_DIRS) {
    mkdirSync(path.join(root, "portal", dir), { recursive: true });
    writeFileSync(path.join(root, "portal", dir, "MARKER.txt"), `${dir} marker`);
  }
  writeFileSync(path.join(root, "docker-compose.yml"), "services: {}\n# test fixture\n");
}

/**
 * A staging root as the drill expects it: the portal/{data,uploads,auth}
 * data dirs, the provisioning-owned compose file and the source tarball the
 * child deploy consumes. The child tools themselves are the repo scripts,
 * passed through PORTAL_DEPLOY_TOOL / PORTAL_RESTORE_TOOL.
 */
function setupStagingRoot(): string {
  const stagingRoot = mkdtempSync(path.join(tmpdir(), "portal-drill-staging-root-"));
  writeDataFixture(stagingRoot);
  makeSourceTarball(stagingRoot);
  return stagingRoot;
}

/** A staging-style app root for running scripts/vps-deploy.sh directly. */
function setupDeployRoot(): string {
  const appRoot = mkdtempSync(path.join(tmpdir(), "portal-drill-deploy-root-"));
  writeDataFixture(appRoot);
  return appRoot;
}

/**
 * The W3b host layout: the staging root lives INSIDE the production root
 * (/opt/stack/staging under /opt/stack). Returns both roots with the staging
 * fixtures (data dirs, compose file, source tarball) in place.
 */
function setupNestedLayout(): { productionRoot: string; stagingRoot: string } {
  const productionRoot = mkdtempSync(path.join(tmpdir(), "portal-drill-prod-root-"));
  const stagingRoot = path.join(productionRoot, "staging");
  mkdirSync(stagingRoot, { recursive: true });
  writeDataFixture(stagingRoot);
  makeSourceTarball(stagingRoot);
  return { productionRoot, stagingRoot };
}

/** Install the docker/curl stubs into a per-run bin/ dir; returns bin/log/state paths. */
function installStubs(work: string): { stubBin: string; logPath: string; curlLogPath: string; stateDir: string } {
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
  return { stubBin, logPath, curlLogPath, stateDir };
}

/** Expand the placeholder in every env value and drop UNSET-sentinel keys. */
function finalizeEnv(env: NodeJS.ProcessEnv, placeholder: string, root: string) {
  for (const [key, value] of Object.entries(env)) {
    if (value === UNSET) {
      delete env[key];
    } else {
      env[key] = (value ?? "").split(placeholder).join(root);
    }
  }
}

function runDrill(
  drill: "rollback" | "restore",
  stagingRoot: string,
  stubEnv: Record<string, string> = {}
): RunResult {
  const work = mkdtempSync(path.join(tmpdir(), "portal-drill-run-"));
  const { stubBin, logPath, curlLogPath, stateDir } = installStubs(work);

  const env: NodeJS.ProcessEnv = {
    ...(process.env as Record<string, string>),
    // Next.js global types make ProcessEnv.NODE_ENV required; carry the real
    // value (vitest runs as "test") so the spawnSync env overload is satisfied.
    NODE_ENV: (process.env.NODE_ENV ?? "test") as "test",
    PATH: `${stubBin}:${process.env.PATH ?? ""}`,
    PORTAL_ENV_NAME: "staging",
    PORTAL_STAGING_ROOT: stagingRoot,
    // The drill runs the repo scripts as its child tools; on a real host these
    // default to the installed /usr/local/lib/portal-deploy tools.
    PORTAL_DEPLOY_TOOL: DEPLOY_SCRIPT,
    PORTAL_RESTORE_TOOL: RESTORE_SCRIPT,
    STUB_LOG: logPath,
    STUB_CURL_LOG: curlLogPath,
    STUB_STATE_DIR: stateDir,
    // After a real rollback the container runs the previous image (started via
    // rollback-compose.yml); the drill requires exactly that ref.
    STUB_INSPECT_IMAGE: "portal-staging:previous",
    PORTAL_HEALTH_RETRIES: "2",
    PORTAL_HEALTH_INTERVAL_SECONDS: "0",
    ...stubEnv,
  };
  finalizeEnv(env, "{STAGING_ROOT}", stagingRoot);

  const res = spawnSync("bash", [DRILL_SCRIPT, drill], { env, encoding: "utf8" });
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    dockerLog: existsSync(logPath) ? readFileSync(logPath, "utf8") : "",
    stagingRoot,
  };
}

/** Run scripts/vps-deploy.sh directly on a staging-style root (hook tests). */
function runDeployDirect(appRoot: string, stubEnv: Record<string, string> = {}): RunResult {
  const work = mkdtempSync(path.join(tmpdir(), "portal-drill-deploy-run-"));
  const { stubBin, logPath, curlLogPath, stateDir } = installStubs(work);
  const tarball = makeSourceTarball(appRoot);

  const env: NodeJS.ProcessEnv = {
    ...(process.env as Record<string, string>),
    NODE_ENV: (process.env.NODE_ENV ?? "test") as "test",
    PATH: `${stubBin}:${process.env.PATH ?? ""}`,
    PORTAL_ROOT: appRoot,
    PORTAL_SOURCE_TARBALL: tarball,
    PORTAL_PUBLIC_URL: "https://portal.test",
    STUB_LOG: logPath,
    STUB_CURL_LOG: curlLogPath,
    STUB_STATE_DIR: stateDir,
    STUB_INSPECT_IMAGE: "portal:latest",
    PORTAL_HEALTH_RETRIES: "2",
    PORTAL_HEALTH_INTERVAL_SECONDS: "0",
    ...stubEnv,
  };
  finalizeEnv(env, "{APP_ROOT}", appRoot);

  const res = spawnSync("bash", [DEPLOY_SCRIPT], { env, encoding: "utf8" });
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    dockerLog: existsSync(logPath) ? readFileSync(logPath, "utf8") : "",
    stagingRoot: appRoot,
  };
}

function lines(log: string): string[] {
  return log.split("\n").filter((line) => line.length > 0);
}

function expectMarkersIntact(stagingRoot: string) {
  for (const dir of DATA_DIRS) {
    expect(readFileSync(path.join(stagingRoot, "portal", dir, "MARKER.txt"), "utf8")).toBe(`${dir} marker`);
  }
}

describe("scripts/portal-drill.sh rollback drill", () => {
  it("passes when the deploy rolls back with the data unchanged", () => {
    const stagingRoot = setupStagingRoot();
    const ctx = runDrill("rollback", stagingRoot);
    expect(ctx.status, ctx.stdout + ctx.stderr).toBe(0);
    const out = ctx.stdout + ctx.stderr;

    expect(ctx.stdout).toContain("DRILL PASS rollback");
    // The drill hook failed the cutover and the deploy gate rolled back.
    expect(out).toContain("CUTOVER FAILED");
    expect(out).toContain("rollback OK");
    const rollbackLines = lines(ctx.dockerLog).filter(
      (line) => line.includes("rollback-compose.yml") && line.includes("up -d portal-staging")
    );
    expect(rollbackLines).toHaveLength(1);
    expect(ctx.dockerLog).toContain("tag portal-staging:previous portal-staging:latest");
    expectMarkersIntact(stagingRoot);
  });

  it("fails when the deploy dies before the cutover (no rollback was exercised)", () => {
    const stagingRoot = setupStagingRoot();
    // STUB_FAIL_BUILD makes `docker build` exit 1: the deploy fails long
    // before the cutover and the container is untouched — still running
    // portal-staging:previous, exactly the state every successful rollback
    // drill leaves behind. A drill that reads any non-zero deploy exit plus a
    // previous-image container as "rolled back" would false-pass here.
    const ctx = runDrill("rollback", stagingRoot, { STUB_FAIL_BUILD: "1" });
    expect(ctx.status).toBe(1);
    const out = ctx.stdout + ctx.stderr;

    expect(out).toContain("DRILL FAIL rollback:");
    expect(out).toContain("failed before the cutover or rollback");
    // The deploy really died at the build step and no rollback was exercised.
    expect(ctx.dockerLog).toContain("build");
    expect(ctx.dockerLog).not.toContain("rollback-compose.yml");
    expectMarkersIntact(stagingRoot);
  });

  it("fails when the rollback leaves the data changed", () => {
    const stagingRoot = setupStagingRoot();
    const driftFile = path.join(stagingRoot, "portal", "data", "DRIFT.txt");
    // The stub simulates the app container writing into the data dir when it
    // is (re)started by the cutover/rollback `compose ... up -d portal-staging`
    // (every real-app staging compose up merges portal-staging.overrides.yml).
    const ctx = runDrill("rollback", stagingRoot, {
      STUB_WRITE_ON: "portal-staging.overrides.yml:{STAGING_ROOT}/portal/data/DRIFT.txt",
    });
    expect(ctx.status).toBe(1);
    const out = ctx.stdout + ctx.stderr;

    expect(out).toContain("DRILL FAIL rollback:");
    expect(out).toContain("staging data changed");
    expect(existsSync(driftFile)).toBe(true); // the simulated write happened
  });

  it("fails when the previous image is not running after the rollback", () => {
    const stagingRoot = setupStagingRoot();
    const ctx = runDrill("rollback", stagingRoot, { STUB_INSPECT_RUNNING: "false" });
    expect(ctx.status).toBe(1);
    const out = ctx.stdout + ctx.stderr;

    expect(out).toContain("DRILL FAIL rollback:");
    expect(out).toContain("is not running");
  });

  it("fails when the container still runs the candidate (latest) image after the rollback", () => {
    const stagingRoot = setupStagingRoot();
    // The rollback `compose up` failed, so the candidate — started under the
    // latest tag by the cutover — is still running. Accepting latest as a
    // valid rollback result would false-pass here.
    const ctx = runDrill("rollback", stagingRoot, {
      STUB_INSPECT_IMAGE: "portal-staging:latest",
    });
    expect(ctx.status).toBe(1);
    const out = ctx.stdout + ctx.stderr;

    expect(out).toContain("DRILL FAIL rollback:");
    expect(out).toContain("runs image");
    expect(out).toContain("portal-staging:latest");
  });

  it("refuses when PORTAL_ENV_NAME=production, before any docker call", () => {
    const stagingRoot = setupStagingRoot();
    const ctx = runDrill("rollback", stagingRoot, { PORTAL_ENV_NAME: "production" });
    expect(ctx.status).toBe(1);
    const out = ctx.stdout + ctx.stderr;

    expect(out).toContain("DRILL FAIL rollback: refusing to run");
    expect(out).toContain("PORTAL_ENV_NAME");
    expect(ctx.dockerLog).toBe(""); // the refusal happens before any docker call
  });

  it("refuses when a data path resolves outside the staging root, before any docker call", () => {
    const stagingRoot = setupStagingRoot();
    const outside = mkdtempSync(path.join(tmpdir(), "portal-outside-data-"));
    writeFileSync(path.join(outside, "MARKER.txt"), "data marker");
    rmSync(path.join(stagingRoot, "portal", "data"), { recursive: true });
    symlinkSync(outside, path.join(stagingRoot, "portal", "data"));

    const ctx = runDrill("rollback", stagingRoot);
    expect(ctx.status).toBe(1);
    expect(ctx.stdout + ctx.stderr).toContain("outside the staging root");
    expect(ctx.dockerLog).toBe("");
  });

  it("refuses when PORTAL_SOURCE_TARBALL resolves outside the staging root, before any docker call", () => {
    const stagingRoot = setupStagingRoot();
    // The child deploy deletes the tarball, so an override pointing outside
    // the staging root must be refused by the safety gate.
    const outsideTarball = path.join(
      mkdtempSync(path.join(tmpdir(), "portal-outside-tarball-")),
      "portal-source.tar.gz"
    );
    writeFileSync(outsideTarball, "foreign tarball");

    const ctx = runDrill("rollback", stagingRoot, { PORTAL_SOURCE_TARBALL: outsideTarball });
    expect(ctx.status).toBe(1);
    expect(ctx.stdout + ctx.stderr).toContain("outside the staging root");
    expect(ctx.dockerLog).toBe("");
  });

  it("refuses when PORTAL_PAUSE_COMPOSE_FILE resolves outside the staging root, before any docker call", () => {
    const stagingRoot = setupStagingRoot();
    // The restore tool writes the pause override, so an override pointing
    // outside the staging root must be refused by the safety gate.
    const outsideCompose = path.join(
      mkdtempSync(path.join(tmpdir(), "portal-outside-compose-")),
      "portal-restore-paused.compose.yml"
    );

    const ctx = runDrill("restore", stagingRoot, { PORTAL_PAUSE_COMPOSE_FILE: outsideCompose });
    expect(ctx.status).toBe(1);
    expect(ctx.stdout + ctx.stderr).toContain("outside the staging root");
    expect(ctx.dockerLog).toBe("");
  });
});

describe("scripts/portal-drill.sh restore drill", () => {
  it("passes when the marker disappears and the data matches the backup", () => {
    const stagingRoot = setupStagingRoot();
    const ctx = runDrill("restore", stagingRoot);
    expect(ctx.status, ctx.stdout + ctx.stderr).toBe(0);

    expect(ctx.stdout).toContain("DRILL PASS restore");
    expect(existsSync(path.join(stagingRoot, "portal", "data", "DRILL-MARKER.txt"))).toBe(false);
    // Exactly the drill's verified backup plus its sha256 sidecar.
    const backups = readdirSync(path.join(stagingRoot, "backups"));
    const archives = backups.filter((f) => f.endsWith(".tar.gz"));
    expect(archives).toHaveLength(1);
    expect(archives[0]).toMatch(/^portal-staging-\d{8}T\d{6}Z\.tar\.gz$/);
    expect(backups.sort()).toEqual([archives[0], `${archives[0]}.sha256`].sort());
    expect(ctx.dockerLog).toContain("up -d portal-staging");
    // The restore runs the image that matches the just-taken backup: the
    // running latest, retagged onto itself. Booting the older previous image
    // on current-schema data would be a silent downgrade.
    expect(ctx.dockerLog).not.toContain("tag portal-staging:previous portal-staging:latest");
    // The restore put the original files back.
    expectMarkersIntact(stagingRoot);
  });

  it("fails when the marker survives the restore", () => {
    const stagingRoot = setupStagingRoot();
    // The restore's `compose ... up -d portal-staging` re-creates the drill
    // marker after the backup extraction removed it.
    const ctx = runDrill("restore", stagingRoot, {
      STUB_WRITE_ON: "portal-staging.overrides.yml:{STAGING_ROOT}/portal/data/DRILL-MARKER.txt",
    });
    expect(ctx.status).toBe(1);
    const out = ctx.stdout + ctx.stderr;

    expect(out).toContain("DRILL FAIL restore:");
    expect(out).toContain("marker");
  });

  it("fails with 'the restore tool failed' and leaves no marker behind when the restore tool refuses before extraction", () => {
    const stagingRoot = setupStagingRoot();
    // STUB_CONTAINER_MISSING makes `docker image inspect` fail, so the
    // restore tool refuses (restore image not found) BEFORE its rm -rf /
    // extraction. The drill had already planted DRILL-MARKER.txt; leaving it
    // behind would poison every later run (it would end up in the next
    // manifest/backup, be restored, and fail that run as "the drill marker
    // survived the restore").
    const ctx = runDrill("restore", stagingRoot, { STUB_CONTAINER_MISSING: "1" });
    expect(ctx.status).toBe(1);
    const out = ctx.stdout + ctx.stderr;

    expect(out).toContain("DRILL FAIL restore:");
    expect(out).toContain("the restore tool failed");
    expect(existsSync(path.join(stagingRoot, "portal", "data", "DRILL-MARKER.txt"))).toBe(false);
    // The refusal happened before the data dirs were touched.
    expectMarkersIntact(stagingRoot);
  });

  it("passes and cleans up a stale marker left by a previous failed run", () => {
    const stagingRoot = setupStagingRoot();
    const staleMarker = path.join(stagingRoot, "portal", "data", "DRILL-MARKER.txt");
    writeFileSync(staleMarker, "stale marker from a previous failed run");

    const ctx = runDrill("restore", stagingRoot);
    expect(ctx.status, ctx.stdout + ctx.stderr).toBe(0);
    const out = ctx.stdout + ctx.stderr;

    expect(ctx.stdout).toContain("DRILL PASS restore");
    expect(out).toContain("leftover drill marker");
    expect(existsSync(staleMarker)).toBe(false);
    expectMarkersIntact(stagingRoot);
  });

  it("refuses when PORTAL_ENV_NAME is unset, before any docker call", () => {
    const stagingRoot = setupStagingRoot();
    const ctx = runDrill("restore", stagingRoot, { PORTAL_ENV_NAME: UNSET });
    expect(ctx.status).toBe(1);

    expect(ctx.stdout + ctx.stderr).toContain("DRILL FAIL restore: refusing to run");
    expect(ctx.dockerLog).toBe("");
  });

  it("refuses when a data path resolves outside the staging root, before any docker call", () => {
    const stagingRoot = setupStagingRoot();
    const outside = mkdtempSync(path.join(tmpdir(), "portal-outside-auth-"));
    writeFileSync(path.join(outside, "MARKER.txt"), "auth marker");
    rmSync(path.join(stagingRoot, "portal", "auth"), { recursive: true });
    symlinkSync(outside, path.join(stagingRoot, "portal", "auth"));

    const ctx = runDrill("restore", stagingRoot);
    expect(ctx.status).toBe(1);
    expect(ctx.stdout + ctx.stderr).toContain("outside the staging root");
    expect(ctx.dockerLog).toBe("");
  });
});

describe("scripts/portal-drill.sh nested staging layout (W3b)", () => {
  it("passes both drills with the staging root nested under the production root", () => {
    // The real-host layout: STAGING_ROOT=/opt/stack/staging sits inside
    // PRODUCTION_ROOT=/opt/stack. Both drills must run to DRILL PASS; the
    // overlap gate must only refuse genuinely dangerous arrangements.
    const { productionRoot, stagingRoot } = setupNestedLayout();
    for (const drill of ["rollback", "restore"] as const) {
      const ctx = runDrill(drill, stagingRoot, { PORTAL_PRODUCTION_ROOT: productionRoot });
      expect(ctx.status, ctx.stdout + ctx.stderr).toBe(0);
      expect(ctx.stdout).toContain(`DRILL PASS ${drill}`);
    }
    expectMarkersIntact(stagingRoot);
  });

  it("refuses when the staging root equals the production root, before any docker call", () => {
    const stagingRoot = setupStagingRoot();
    const ctx = runDrill("rollback", stagingRoot, { PORTAL_PRODUCTION_ROOT: stagingRoot });
    expect(ctx.status).toBe(1);
    expect(ctx.stdout + ctx.stderr).toContain("DRILL FAIL rollback: refusing to run");
    expect(ctx.dockerLog).toBe("");
  });

  it("refuses when a staging data dir is symlinked into the production portal dir, before any docker call", () => {
    const { productionRoot, stagingRoot } = setupNestedLayout();
    const productionData = path.join(productionRoot, "portal", "data");
    mkdirSync(productionData, { recursive: true });
    writeFileSync(path.join(productionData, "MARKER.txt"), "production data marker");
    rmSync(path.join(stagingRoot, "portal", "data"), { recursive: true });
    symlinkSync(productionData, path.join(stagingRoot, "portal", "data"));

    const ctx = runDrill("rollback", stagingRoot, { PORTAL_PRODUCTION_ROOT: productionRoot });
    expect(ctx.status).toBe(1);
    expect(ctx.stdout + ctx.stderr).toContain("DRILL FAIL rollback: refusing to run");
    expect(ctx.dockerLog).toBe(""); // the refusal happens before any docker call
  });

  it("refuses when the staging root is nested inside the production data areas, before any docker call", () => {
    // Staging paths resolve inside the staging root here, so only the
    // production-data-areas check can catch this arrangement.
    const productionRoot = mkdtempSync(path.join(tmpdir(), "portal-drill-prod-root-"));
    const stagingRoot = path.join(productionRoot, "portal", "staging");
    mkdirSync(stagingRoot, { recursive: true });
    writeDataFixture(stagingRoot);
    makeSourceTarball(stagingRoot);

    const ctx = runDrill("rollback", stagingRoot, { PORTAL_PRODUCTION_ROOT: productionRoot });
    expect(ctx.status).toBe(1);
    expect(ctx.stdout + ctx.stderr).toContain("production data areas");
    expect(ctx.dockerLog).toBe("");
  });
});

describe("PORTAL_DRILL_FAIL_HEALTH hook in scripts/vps-deploy.sh", () => {
  it("is honoured in staging mode: the cutover fails and the deploy rolls back", () => {
    const appRoot = setupDeployRoot();
    const ctx = runDeployDirect(appRoot, {
      PORTAL_ENV_NAME: "staging",
      PORTAL_DRILL_FAIL_HEALTH: "1",
    });
    expect(ctx.status).toBe(1);
    const out = ctx.stdout + ctx.stderr;

    expect(out).toContain("CUTOVER FAILED");
    expect(out).toContain("drill hook");
    expect(out).toContain("rollback OK");
    expect(ctx.dockerLog).toContain("rollback-compose.yml");
  });

  it("is ignored in production mode even when set", () => {
    const appRoot = setupDeployRoot();
    const ctx = runDeployDirect(appRoot, {
      PORTAL_ENV_NAME: "production",
      PORTAL_DRILL_FAIL_HEALTH: "1",
    });
    expect(ctx.status, ctx.stdout + ctx.stderr).toBe(0);
    const out = ctx.stdout + ctx.stderr;

    expect(out).toContain("deploy finished successfully");
    expect(out).not.toContain("DRILL HOOK active");
    expect(ctx.dockerLog).not.toContain("rollback-compose.yml");
  });

  it("is ignored when PORTAL_ENV_NAME is unset", () => {
    const appRoot = setupDeployRoot();
    const ctx = runDeployDirect(appRoot, { PORTAL_DRILL_FAIL_HEALTH: "1" });
    expect(ctx.status, ctx.stdout + ctx.stderr).toBe(0);
    expect(ctx.stdout + ctx.stderr).toContain("deploy finished successfully");
  });
});

describe("drill script conventions", () => {
  it("portal-drill.sh runs bash with set -euo pipefail", () => {
    const src = readFileSync(DRILL_SCRIPT, "utf8");
    expect(src).toContain("#!/usr/bin/env bash");
    expect(src).toContain("set -euo pipefail");
  });

  it("the drill and its child tools pass bash -n", () => {
    for (const script of [DRILL_SCRIPT, DEPLOY_SCRIPT, RESTORE_SCRIPT]) {
      const res = spawnSync("bash", ["-n", script], { encoding: "utf8" });
      expect(res.status, `${script}: ${res.stderr}`).toBe(0);
    }
  });

  it("the drill and its child tools are shellcheck-clean when shellcheck is available", () => {
    const check = spawnSync("bash", ["-c", "command -v shellcheck"], { encoding: "utf8" });
    if (check.status !== 0) {
      return; // shellcheck not installed here — nothing to assert
    }
    const res = spawnSync("shellcheck", [DRILL_SCRIPT, DEPLOY_SCRIPT, RESTORE_SCRIPT], {
      encoding: "utf8",
    });
    expect(res.status, res.stdout + res.stderr).toBe(0);
  });
});
