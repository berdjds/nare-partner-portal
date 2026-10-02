/**
 * Staging drill tests (W3c) for scripts/portal-drill.sh and the staging-only
 * PORTAL_DRILL_FAIL_HEALTH hook in scripts/vps-deploy.sh.
 *
 * portal-drill.sh proves on a staging host that (a) the deploy gate rolls
 * back without touching the data dirs when the post-cutover health check
 * fails (rollback drill) and (b) restore-backup.sh really restores a
 * verified backup (restore drill). These tests run the real scripts via bash
 * against a throwaway staging root with the docker CLI replaced by the test
 * double on PATH (tests/deploy/docker-stub.sh), exactly like the deploy-gate
 * tests in vps-deploy.test.ts. The stub's opt-in STUB_WRITE_ON feature
 * simulates a container writing into a mounted data dir so the drill's
 * data-drift and restore-marker checks can be exercised.
 *
 * The safety refusals (PORTAL_ENV_NAME must be "staging"; every data path
 * must resolve inside the staging root) are asserted to happen BEFORE any
 * docker call. The vps-deploy.sh hook is also exercised directly to prove it
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
const STAGING_APP_CONTAINER = "wacontrol-staging-app";
const THREE_DIRS = ["wacontrol-data", "wacontrol-uploads", "wacontrol-auth"] as const;
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
  const srcDir = mkdtempSync(path.join(tmpdir(), "wacontrol-src-"));
  writeFileSync(path.join(srcDir, "docker-compose.yml"), "services: {}\n# test fixture\n");
  writeFileSync(path.join(srcDir, "candidate-marker.txt"), "candidate source");
  const tarball = path.join(stagingRoot, "wacontrol-source.tar.gz");
  const res = spawnSync("tar", ["-czf", tarball, "-C", srcDir, "."], { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`fixture tar failed: ${res.stderr}`);
  return tarball;
}

/** The three data dirs (each with a marker file) plus the compose file. */
function writeDataFixture(root: string) {
  for (const dir of THREE_DIRS) {
    mkdirSync(path.join(root, dir));
    writeFileSync(path.join(root, dir, "MARKER.txt"), `${dir} marker`);
  }
  writeFileSync(path.join(root, "docker-compose.yml"), "services: {}\n# test fixture\n");
}

/**
 * A staging root as the drill expects it: the data dirs, the compose file,
 * the child deploy/restore tools under wacontrol-src/scripts/ and the source
 * tarball the child deploy consumes.
 */
function setupStagingRoot(): string {
  const stagingRoot = mkdtempSync(path.join(tmpdir(), "wacontrol-staging-root-"));
  writeDataFixture(stagingRoot);
  const srcScripts = path.join(stagingRoot, "wacontrol-src", "scripts");
  mkdirSync(srcScripts, { recursive: true });
  cpSync(DEPLOY_SCRIPT, path.join(srcScripts, "vps-deploy.sh"));
  cpSync(RESTORE_SCRIPT, path.join(srcScripts, "restore-backup.sh"));
  makeSourceTarball(stagingRoot);
  return stagingRoot;
}

/** A staging-style app root for running scripts/vps-deploy.sh directly. */
function setupDeployRoot(): string {
  const appRoot = mkdtempSync(path.join(tmpdir(), "wacontrol-drill-deploy-root-"));
  writeDataFixture(appRoot);
  return appRoot;
}

/** Install the docker stub into a per-run bin/ dir; returns bin/log/state paths. */
function installDockerStub(work: string): { stubBin: string; logPath: string; stateDir: string } {
  const stubBin = path.join(work, "bin");
  mkdirSync(stubBin);
  const dockerPath = path.join(stubBin, "docker");
  cpSync(DOCKER_STUB, dockerPath);
  chmodSync(dockerPath, 0o755);
  const logPath = path.join(work, "docker.log");
  const stateDir = path.join(work, "state");
  mkdirSync(stateDir);
  return { stubBin, logPath, stateDir };
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
  const work = mkdtempSync(path.join(tmpdir(), "wacontrol-drill-run-"));
  const { stubBin, logPath, stateDir } = installDockerStub(work);

  const env: NodeJS.ProcessEnv = {
    ...(process.env as Record<string, string>),
    // Next.js global types make ProcessEnv.NODE_ENV required; carry the real
    // value (vitest runs as "test") so the spawnSync env overload is satisfied.
    NODE_ENV: (process.env.NODE_ENV ?? "test") as "test",
    PATH: `${stubBin}:${process.env.PATH ?? ""}`,
    PORTAL_ENV_NAME: "staging",
    PORTAL_STAGING_ROOT: stagingRoot,
    STUB_LOG: logPath,
    STUB_STATE_DIR: stateDir,
    // After a real rollback the container runs the previous image (started via
    // rollback-compose.yml); the drill requires exactly that ref.
    STUB_INSPECT_IMAGE: "wacontrol-staging:previous",
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
  const work = mkdtempSync(path.join(tmpdir(), "wacontrol-drill-deploy-run-"));
  const { stubBin, logPath, stateDir } = installDockerStub(work);
  const tarball = makeSourceTarball(appRoot);

  const env: NodeJS.ProcessEnv = {
    ...(process.env as Record<string, string>),
    NODE_ENV: (process.env.NODE_ENV ?? "test") as "test",
    PATH: `${stubBin}:${process.env.PATH ?? ""}`,
    WACONTROL_APP_ROOT: appRoot,
    WACONTROL_SOURCE_TARBALL: tarball,
    WACONTROL_APP_CONTAINER: STAGING_APP_CONTAINER,
    WACONTROL_CANDIDATE_IMAGE: "wacontrol-staging:candidate",
    WACONTROL_PREVIOUS_IMAGE: "wacontrol-staging:previous",
    WACONTROL_LATEST_IMAGE: "wacontrol-staging:latest",
    STUB_INSPECT_IMAGE: "wacontrol-staging:latest",
    STUB_LOG: logPath,
    STUB_STATE_DIR: stateDir,
    WACONTROL_HEALTH_RETRIES: "2",
    WACONTROL_HEALTH_INTERVAL_SECONDS: "0",
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
  for (const dir of THREE_DIRS) {
    expect(readFileSync(path.join(stagingRoot, dir, "MARKER.txt"), "utf8")).toBe(`${dir} marker`);
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
      (line) => line.includes("rollback-compose.yml") && line.includes("up -d wacontrol_app")
    );
    expect(rollbackLines).toHaveLength(1);
    expect(ctx.dockerLog).toContain("tag wacontrol-staging:previous wacontrol-staging:latest");
    expectMarkersIntact(stagingRoot);
  });

  it("fails when the deploy dies before the cutover (no rollback was exercised)", () => {
    const stagingRoot = setupStagingRoot();
    // STUB_FAIL_BUILD makes `docker build` exit 1: the deploy fails long
    // before the cutover and the container is untouched — still running
    // wacontrol-staging:previous, exactly the state every successful rollback
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
    const driftFile = path.join(stagingRoot, "wacontrol-data", "DRIFT.txt");
    // The stub simulates the app container writing into the data dir when it
    // is (re)started by the cutover/rollback `compose ... up -d wacontrol_app`.
    const ctx = runDrill("rollback", stagingRoot, {
      STUB_WRITE_ON: "wacontrol_app:{STAGING_ROOT}/wacontrol-data/DRIFT.txt",
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
      STUB_INSPECT_IMAGE: "wacontrol-staging:latest",
    });
    expect(ctx.status).toBe(1);
    const out = ctx.stdout + ctx.stderr;

    expect(out).toContain("DRILL FAIL rollback:");
    expect(out).toContain("runs image");
    expect(out).toContain("wacontrol-staging:latest");
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
    const outside = mkdtempSync(path.join(tmpdir(), "wacontrol-outside-data-"));
    writeFileSync(path.join(outside, "MARKER.txt"), "wacontrol-data marker");
    rmSync(path.join(stagingRoot, "wacontrol-data"), { recursive: true });
    symlinkSync(outside, path.join(stagingRoot, "wacontrol-data"));

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
      mkdtempSync(path.join(tmpdir(), "wacontrol-outside-tarball-")),
      "wacontrol-source.tar.gz"
    );
    writeFileSync(outsideTarball, "foreign tarball");

    const ctx = runDrill("rollback", stagingRoot, { PORTAL_SOURCE_TARBALL: outsideTarball });
    expect(ctx.status).toBe(1);
    expect(ctx.stdout + ctx.stderr).toContain("outside the staging root");
    expect(ctx.dockerLog).toBe("");
  });

  it("refuses when PORTAL_RESTORE_SCRIPT resolves outside the staging root, before any docker call", () => {
    const stagingRoot = setupStagingRoot();
    const outsideScript = path.join(
      mkdtempSync(path.join(tmpdir(), "wacontrol-outside-script-")),
      "restore-backup.sh"
    );
    writeFileSync(outsideScript, "#!/usr/bin/env bash\n");

    const ctx = runDrill("restore", stagingRoot, { PORTAL_RESTORE_SCRIPT: outsideScript });
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
    expect(existsSync(path.join(stagingRoot, "wacontrol-data", "DRILL-MARKER.txt"))).toBe(false);
    // Exactly the drill's verified backup plus its sha256 sidecar.
    const backups = readdirSync(path.join(stagingRoot, "backups"));
    const archives = backups.filter((f) => f.endsWith(".tar.gz"));
    expect(archives).toHaveLength(1);
    expect(backups.sort()).toEqual([archives[0], `${archives[0]}.sha256`].sort());
    expect(ctx.dockerLog).toContain("up -d wacontrol_app");
    // The restore runs the image that matches the just-taken backup: the
    // running latest, retagged onto itself. Booting the older previous image
    // on current-schema data would be a silent downgrade.
    expect(ctx.dockerLog).not.toContain("tag wacontrol-staging:previous wacontrol-staging:latest");
    // The restore put the original files back.
    expectMarkersIntact(stagingRoot);
  });

  it("fails when the marker survives the restore", () => {
    const stagingRoot = setupStagingRoot();
    // The restore's `compose ... up -d wacontrol_app` re-creates the drill
    // marker after the backup extraction removed it.
    const ctx = runDrill("restore", stagingRoot, {
      STUB_WRITE_ON: "wacontrol_app:{STAGING_ROOT}/wacontrol-data/DRILL-MARKER.txt",
    });
    expect(ctx.status).toBe(1);
    const out = ctx.stdout + ctx.stderr;

    expect(out).toContain("DRILL FAIL restore:");
    expect(out).toContain("marker");
  });

  it("fails with 'the restore tool failed' and leaves no marker behind when the restore tool refuses before extraction", () => {
    const stagingRoot = setupStagingRoot();
    // STUB_CONTAINER_MISSING makes `docker image inspect` fail, so
    // restore-backup.sh refuses (restore image not found) BEFORE its
    // rm -rf / extraction. The drill had already planted DRILL-MARKER.txt;
    // leaving it behind would poison every later run (it would end up in the
    // next manifest/backup, be restored, and fail that run as "the drill
    // marker survived the restore").
    const ctx = runDrill("restore", stagingRoot, { STUB_CONTAINER_MISSING: "1" });
    expect(ctx.status).toBe(1);
    const out = ctx.stdout + ctx.stderr;

    expect(out).toContain("DRILL FAIL restore:");
    expect(out).toContain("the restore tool failed");
    expect(existsSync(path.join(stagingRoot, "wacontrol-data", "DRILL-MARKER.txt"))).toBe(false);
    // The refusal happened before the data dirs were touched.
    expectMarkersIntact(stagingRoot);
  });

  it("passes and cleans up a stale marker left by a previous failed run", () => {
    const stagingRoot = setupStagingRoot();
    const staleMarker = path.join(stagingRoot, "wacontrol-data", "DRILL-MARKER.txt");
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
    const outside = mkdtempSync(path.join(tmpdir(), "wacontrol-outside-auth-"));
    writeFileSync(path.join(outside, "MARKER.txt"), "wacontrol-auth marker");
    rmSync(path.join(stagingRoot, "wacontrol-auth"), { recursive: true });
    symlinkSync(outside, path.join(stagingRoot, "wacontrol-auth"));

    const ctx = runDrill("restore", stagingRoot);
    expect(ctx.status).toBe(1);
    expect(ctx.stdout + ctx.stderr).toContain("outside the staging root");
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
