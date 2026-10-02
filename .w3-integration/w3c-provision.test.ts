/**
 * Provisioning and dispatcher tests (W3c, task drill-wiring) for
 * deploy/provision-server.sh and deploy/portal-deploy-entry.sh.
 *
 * The provisioner runs against a throwaway root and must install
 * scripts/portal-drill.sh as <root>/usr/local/lib/portal-deploy/portal-drill
 * with mode 0755 (byte-identical to the source). The dispatcher's
 * staging-only gate is exercised directly: drill-rollback and drill-restore
 * must be rejected with a non-zero exit for PORTAL_ENV_NAME=production (and
 * when unset), before the drill binary is ever invoked; with
 * PORTAL_ENV_NAME=staging they must dispatch to the drill as
 * `PORTAL_ENV_NAME=staging portal-drill rollback|restore` (verified with a
 * recording stub standing in for the drill binary).
 */

import { spawnSync } from "child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const PROVISION_SCRIPT = path.join(REPO_ROOT, "deploy", "provision-server.sh");
const DISPATCHER_SCRIPT = path.join(REPO_ROOT, "deploy", "portal-deploy-entry.sh");
const DRILL_SOURCE = path.join(REPO_ROOT, "scripts", "portal-drill.sh");

function baseEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...(process.env as Record<string, string>),
    // Next.js global types make ProcessEnv.NODE_ENV required; carry the real
    // value (vitest runs as "test") so the spawnSync env overload is satisfied.
    NODE_ENV: (process.env.NODE_ENV ?? "test") as "test",
  };
  // Never inherit the variables under test from the outer environment.
  delete env.PORTAL_ENV_NAME;
  delete env.PORTAL_DRILL_BIN;
  delete env.STUB_RECORD;
  return { ...env, ...extra };
}

/** Provision into a temp root; returns the installed portal-drill path. */
function provisionTempRoot(): { root: string; drillBin: string } {
  const root = mkdtempSync(path.join(tmpdir(), "wacontrol-provision-root-"));
  const res = spawnSync("bash", [PROVISION_SCRIPT, root], { encoding: "utf8" });
  expect(res.status, res.stdout + res.stderr).toBe(0);
  return { root, drillBin: path.join(root, "usr/local/lib/portal-deploy/portal-drill") };
}

/**
 * A stub standing in for the installed drill binary: records how it was
 * invoked (args + PORTAL_ENV_NAME) to STUB_RECORD so dispatch can be asserted
 * without running a real drill.
 */
function makeRecordingDrillStub(work: string): { stubBin: string; recordPath: string } {
  const stubBin = path.join(work, "portal-drill");
  const recordPath = path.join(work, "drill-invocation.txt");
  writeFileSync(
    stubBin,
    "#!/usr/bin/env bash\n" +
      'printf \'args=%s env=%s\\n\' "$*" "${PORTAL_ENV_NAME:-<unset>}" >> "$STUB_RECORD"\n'
  );
  chmodSync(stubBin, 0o755);
  return { stubBin, recordPath };
}

function runDispatcher(
  command: string,
  extraEnv: Record<string, string>
): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync("bash", [DISPATCHER_SCRIPT, command], {
    env: baseEnv(extraEnv),
    encoding: "utf8",
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

describe("deploy/provision-server.sh", () => {
  it("installs scripts/portal-drill.sh as <root>/usr/local/lib/portal-deploy/portal-drill", () => {
    const { drillBin } = provisionTempRoot();
    expect(existsSync(drillBin)).toBe(true);
    // The installed file is built from the drill script byte for byte.
    expect(readFileSync(drillBin, "utf8")).toBe(readFileSync(DRILL_SOURCE, "utf8"));
  });

  it("installs the drill with mode 0755 and the file executes directly", () => {
    const { drillBin } = provisionTempRoot();
    // eslint-disable-next-line no-bitwise
    expect(statSync(drillBin).mode & 0o777).toBe(0o755);
    // Direct exec (no `bash` wrapper) proves the exec bit: with no arguments
    // the drill prints its usage and exits 2.
    const res = spawnSync(drillBin, [], { encoding: "utf8" });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("usage: portal-drill");
  });

  it("installs the dispatcher next to the drill", () => {
    const { root } = provisionTempRoot();
    const dispatcherBin = path.join(root, "usr/local/lib/portal-deploy/portal-deploy-entry");
    expect(existsSync(dispatcherBin)).toBe(true);
    // eslint-disable-next-line no-bitwise
    expect(statSync(dispatcherBin).mode & 0o777).toBe(0o755);
  });
});

describe("deploy/portal-deploy-entry.sh drill commands", () => {
  it("rejects drill-rollback for PORTAL_ENV_NAME=production without invoking the drill", () => {
    const work = mkdtempSync(path.join(tmpdir(), "wacontrol-dispatch-run-"));
    const { stubBin, recordPath } = makeRecordingDrillStub(work);
    const res = runDispatcher("drill-rollback", {
      PORTAL_ENV_NAME: "production",
      PORTAL_DRILL_BIN: stubBin,
      STUB_RECORD: recordPath,
    });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("refusing drill-rollback");
    expect(res.stderr).toContain("staging");
    expect(existsSync(recordPath)).toBe(false); // the drill was never invoked
  });

  it("rejects drill-restore for PORTAL_ENV_NAME=production without invoking the drill", () => {
    const work = mkdtempSync(path.join(tmpdir(), "wacontrol-dispatch-run-"));
    const { stubBin, recordPath } = makeRecordingDrillStub(work);
    const res = runDispatcher("drill-restore", {
      PORTAL_ENV_NAME: "production",
      PORTAL_DRILL_BIN: stubBin,
      STUB_RECORD: recordPath,
    });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("refusing drill-restore");
    expect(res.stderr).toContain("staging");
    expect(existsSync(recordPath)).toBe(false);
  });

  it("rejects both drill commands when PORTAL_ENV_NAME is unset", () => {
    const work = mkdtempSync(path.join(tmpdir(), "wacontrol-dispatch-run-"));
    const { stubBin, recordPath } = makeRecordingDrillStub(work);
    for (const command of ["drill-rollback", "drill-restore"]) {
      const res = runDispatcher(command, { PORTAL_DRILL_BIN: stubBin, STUB_RECORD: recordPath });
      expect(res.status, res.stdout + res.stderr).not.toBe(0);
      expect(res.stderr).toContain(`refusing ${command}`);
    }
    expect(existsSync(recordPath)).toBe(false);
  });

  it("dispatches drill-rollback as PORTAL_ENV_NAME=staging portal-drill rollback", () => {
    const work = mkdtempSync(path.join(tmpdir(), "wacontrol-dispatch-run-"));
    const { stubBin, recordPath } = makeRecordingDrillStub(work);
    const res = runDispatcher("drill-rollback", {
      PORTAL_ENV_NAME: "staging",
      PORTAL_DRILL_BIN: stubBin,
      STUB_RECORD: recordPath,
    });
    expect(res.status, res.stdout + res.stderr).toBe(0);
    expect(readFileSync(recordPath, "utf8")).toBe("args=rollback env=staging\n");
  });

  it("dispatches drill-restore as PORTAL_ENV_NAME=staging portal-drill restore", () => {
    const work = mkdtempSync(path.join(tmpdir(), "wacontrol-dispatch-run-"));
    const { stubBin, recordPath } = makeRecordingDrillStub(work);
    const res = runDispatcher("drill-restore", {
      PORTAL_ENV_NAME: "staging",
      PORTAL_DRILL_BIN: stubBin,
      STUB_RECORD: recordPath,
    });
    expect(res.status, res.stdout + res.stderr).toBe(0);
    expect(readFileSync(recordPath, "utf8")).toBe("args=restore env=staging\n");
  });

  it("exits non-zero with usage for an unknown command", () => {
    const res = runDispatcher("not-a-command", { PORTAL_ENV_NAME: "staging" });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("usage: portal-deploy-entry");
  });
});

describe("provisioning script conventions", () => {
  it("both deploy scripts pass bash -n", () => {
    for (const script of [PROVISION_SCRIPT, DISPATCHER_SCRIPT]) {
      const res = spawnSync("bash", ["-n", script], { encoding: "utf8" });
      expect(res.status, `${script}: ${res.stderr}`).toBe(0);
    }
  });
});
