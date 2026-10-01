/**
 * Scheduled-backup tests (W3b, task backup-sched) for scripts/portal-backup.sh
 * and its systemd units (deploy/systemd/portal-backup.{service,timer}).
 *
 * scripts/portal-backup.sh is the nightly off-band backup: it snapshots every
 * SQLite database in the data dir through `sqlite3 <db> ".backup '<target>'"`
 * (a consistent snapshot — never a raw copy of a live db), copies the rest of
 * the data/uploads/auth trees (excluding *.db-wal / *.db-journal / *.db-shm
 * and the Chromium cache dirs), archives them as
 * portal-backup-<UTC-stamp>.tar.gz into the backup dir, verifies the archive
 * (readable listing, a data-tree .db member, all three top-level trees),
 * writes and re-checks a sha256 sidecar, prunes portal-backup-* archives older
 * than PORTAL_BACKUP_KEEP_DAYS, and finally invokes the optional off-site
 * hook. Any failure before a verified archive cleans up the partial archive,
 * skips pruning and the hook, and exits 1 — the script must never delete the
 * only verified backup it has.
 *
 * These tests run the real script with bash against a throwaway /opt/stack
 * layout in tmpdir, with sqlite3 and tar replaced by PATH stubs (the tar stub
 * is a pass-through wrapper around the real tar that can truncate the freshly
 * written archive so the tar -tzf verification genuinely fails, or force an
 * exit status on the -czf call — GNU tar exit 1 "file changed as we read it"
 * on live trees, or a hard failure like exit 2). Settings come
 * from a per-test settings file via PORTAL_BACKUP_ENV; runs use a minimal,
 * controlled environment (no blanket process.env inheritance) to stay
 * deterministic.
 */

import { spawnSync } from "child_process";
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "portal-backup.sh");
const SERVICE_UNIT = path.join(REPO_ROOT, "deploy", "systemd", "portal-backup.service");
const TIMER_UNIT = path.join(REPO_ROOT, "deploy", "systemd", "portal-backup.timer");

// Arbitrary bytes — the archive must reproduce the snapshot byte-for-byte.
const DEV_DB_BYTES = Buffer.from("dev db bytes  fixture");
const EXTRA_DB_BYTES = Buffer.from("extra db bytes  fixture");

/**
 * The stub scripts below deliberately use only "$var" expansions (no ${...}
 * forms) so they can live inside a TypeScript template literal without
 * escaping every parameter expansion. No `set -e` in the stubs on purpose:
 * their scripted failures are driven by explicit exit codes.
 */
const SQLITE3_STUB = `#!/usr/bin/env bash
# sqlite3 test double: logs every invocation, then emulates exactly the one
# command the backup script is allowed to run — .backup '<target>' — as a
# plain copy of the source db. Any other sqlite3 invocation fails loudly so a
# script regression (e.g. opening the live db for a dump) cannot slip through.
printf '%s\\n' "$*" >> "$STUB_LOG"
if [ "$STUB_SQLITE_FAIL" = "1" ]; then
  echo "sqlite3 stub: forced failure" >&2
  exit 1
fi
db="$1"
cmd="$2"
case "$cmd" in
  ".backup '"*"'")
    # Strip the 9-char ".backup '" prefix and the trailing single quote.
    target="$(printf '%s' "$cmd" | cut -c10-)"
    target="$(printf '%s' "$target" | rev | cut -c2- | rev)"
    cp "$db" "$target"
    ;;
  *)
    echo "sqlite3 stub: unexpected command: $cmd" >&2
    exit 1
    ;;
esac
`;

const TAR_STUB = `#!/usr/bin/env bash
# Pass-through wrapper around the real tar (path baked in at fixture build
# time, resolved before the stub dir shadows it on PATH). With
# STUB_TAR_CORRUPT=1 the freshly created -czf archive is truncated to half
# its size, so the script's own tar -tzf verification genuinely fails. With
# STUB_TAR_EXIT=<n> the -czf call exits with <n> after the real tar ran
# (emulating GNU tar exit 1 "file changed as we read it" on live trees, or a
# hard failure like exit 2); the forced status applies only to archive
# creation, never to the script's own tar -tzf verification call.
printf '%s\\n' "$*" >> "$STUB_LOG"
"__REAL_TAR__" "$@"
status="$?"
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-czf" ]; then
    out="$a"
    break
  fi
  prev="$a"
done
if [ -n "$out" ]; then
  if [ "$status" -eq 0 ] && [ "$STUB_TAR_CORRUPT" = "1" ]; then
    sz="$(stat -c %s "$out")"
    head -c "$((sz / 2))" "$out" > "$out.tmp" && mv "$out.tmp" "$out"
  fi
  if [ -n "$STUB_TAR_EXIT" ]; then
    status="$STUB_TAR_EXIT"
  fi
fi
exit "$status"
`;

const HOOK_STUB = `#!/usr/bin/env bash
# Off-site hook double: records the archive path it was handed.
printf '%s\\n' "$1" >> "$HOOK_LOG"
`;

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  stubLog: string;
}

interface StackFixture {
  work: string;
  root: string;
  dataDir: string;
  uploadsDir: string;
  authDir: string;
  backupDir: string;
  settingsPath: string;
  stubBin: string;
  stubLog: string;
  hookLog: string;
}

/** The real tar, found on the ORIGINAL PATH before the stub dir shadows it. */
function resolveRealTar(): string {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "tar");
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // not here — keep scanning
    }
  }
  throw new Error("real tar not found on the original PATH");
}

function writeExecutable(file: string, content: string): void {
  writeFileSync(file, content);
  chmodSync(file, 0o755);
}

function writeStubs(stubBin: string): void {
  mkdirSync(stubBin, { recursive: true });
  writeExecutable(path.join(stubBin, "sqlite3"), SQLITE3_STUB);
  writeExecutable(path.join(stubBin, "tar"), TAR_STUB.split("__REAL_TAR__").join(resolveRealTar()));
}

/**
 * A throwaway /opt/stack mirror: portal/{data,uploads,auth} plus backups/,
 * with the same layout (and Chromium cache tree under auth) as the server.
 * withDbs=false leaves the data dir without any *.db file (refusal case).
 */
function makeStack(withDbs = true): StackFixture {
  const work = mkdtempSync(path.join(tmpdir(), "portal-backup-"));
  const root = path.join(work, "stack");
  const dataDir = path.join(root, "portal", "data");
  const uploadsDir = path.join(root, "portal", "uploads");
  const authDir = path.join(root, "portal", "auth");
  const backupDir = path.join(root, "backups");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(uploadsDir, { recursive: true });
  mkdirSync(path.join(authDir, "session", "Default", "Cache"), { recursive: true });
  mkdirSync(backupDir, { recursive: true });

  if (withDbs) {
    writeFileSync(path.join(dataDir, "dev.db"), DEV_DB_BYTES);
    writeFileSync(path.join(dataDir, "extra.db"), EXTRA_DB_BYTES);
  }
  writeFileSync(path.join(dataDir, "settings.json"), '{"theme":"dark"}\n');
  writeFileSync(path.join(dataDir, "dev.db-wal"), "wal bytes that must never be archived raw");
  writeFileSync(path.join(uploadsDir, "x.jpg"), "jpeg bytes");
  writeFileSync(path.join(authDir, "session", "Default", "Cookies"), "cookie bytes");
  writeFileSync(path.join(authDir, "session", "Default", "Cache", "junk.bin"), "chromium cache junk");

  const stubBin = path.join(work, "bin");
  writeStubs(stubBin);

  return {
    work,
    root,
    dataDir,
    uploadsDir,
    authDir,
    backupDir,
    settingsPath: path.join(work, "portal-backup.env"),
    stubBin,
    stubLog: path.join(work, "stub.log"),
    hookLog: path.join(work, "hook.log"),
  };
}

/** Per-test settings file, referenced via PORTAL_BACKUP_ENV. */
function writeSettings(fx: StackFixture, extra: Record<string, string> = {}): void {
  const vars: Record<string, string> = {
    PORTAL_DATA_DIR: fx.dataDir,
    PORTAL_UPLOADS_DIR: fx.uploadsDir,
    PORTAL_AUTH_DIR: fx.authDir,
    PORTAL_BACKUP_DIR: fx.backupDir,
    ...extra,
  };
  writeFileSync(
    fx.settingsPath,
    Object.entries(vars)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n"
  );
}

/**
 * Run the real script with a minimal controlled environment — the stub dir
 * first on PATH, the settings file, the stub log, and nothing inherited
 * beyond PATH (HOME etc. are intentionally absent).
 */
function runBackup(fx: StackFixture, extraEnv: Record<string, string> = {}): RunResult {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: process.env.NODE_ENV ?? "test",
    PATH: `${fx.stubBin}:${process.env.PATH ?? ""}`,
    PORTAL_BACKUP_ENV: fx.settingsPath,
    STUB_LOG: fx.stubLog,
    HOOK_LOG: fx.hookLog,
    ...extraEnv,
  };
  const res = spawnSync("bash", [SCRIPT], { env, encoding: "utf8" });
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    stubLog: existsSync(fx.stubLog) ? readFileSync(fx.stubLog, "utf8") : "",
  };
}

/** Basenames of the portal-backup-*.tar.gz archives currently in the dir. */
function backupArchives(backupDir: string): string[] {
  return readdirSync(backupDir)
    .filter((entry) => /^portal-backup-.+\.tar\.gz$/.test(entry))
    .sort();
}

/** Basenames of the sha256 sidecars currently in the dir. */
function backupSidecars(backupDir: string): string[] {
  return readdirSync(backupDir)
    .filter((entry) => /^portal-backup-.+\.tar\.gz\.sha256$/.test(entry))
    .sort();
}

/** An old archive + sidecar pair, both backdated (the retention fixtures). */
function seedOldPair(backupDir: string, name: string, ageDays: number): void {
  const mtime = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
  for (const suffix of ["", ".sha256"]) {
    const file = path.join(backupDir, `${name}${suffix}`);
    writeFileSync(file, `old ${name}${suffix} fixture\n`);
    utimesSync(file, mtime, mtime);
  }
}

function writeHookStub(fx: StackFixture): string {
  const hook = path.join(fx.work, "off-site-hook.sh");
  writeExecutable(hook, HOOK_STUB);
  return hook;
}

// ---------------------------------------------------------------------------
// scripts/portal-backup.sh
// ---------------------------------------------------------------------------

describe("scripts/portal-backup.sh", () => {
  it("creates a verified archive with consistent db snapshots and no cache or wal members", () => {
    const fx = makeStack();
    writeSettings(fx);

    const ctx = runBackup(fx);
    expect(ctx.status, ctx.stdout + ctx.stderr).toBe(0);
    expect(ctx.stdout).toContain("backup: verified");

    // Exactly one new archive + its sidecar.
    const archives = backupArchives(fx.backupDir);
    expect(archives).toHaveLength(1);
    expect(backupSidecars(fx.backupDir)).toEqual([`${archives[0]}.sha256`]);
    const archivePath = path.join(fx.backupDir, archives[0]);

    // The sidecar verifies when checked from the backup dir (it must
    // reference the archive by basename, not by absolute path).
    const check = spawnSync("sha256sum", ["-c", `${archives[0]}.sha256`], {
      cwd: fx.backupDir,
      encoding: "utf8",
    });
    expect(check.status, (check.stdout ?? "") + (check.stderr ?? "")).toBe(0);

    // The archive layout mirrors the deploy gate: data/, uploads/, auth/
    // trees by basename — without the wal file or any Chromium cache member.
    const listing = spawnSync("tar", ["-tzf", archivePath], { encoding: "utf8" });
    expect(listing.status, listing.stderr ?? "").toBe(0);
    const members = (listing.stdout ?? "").split("\n");
    for (const expected of [
      "data/dev.db",
      "data/extra.db",
      "data/settings.json",
      "uploads/x.jpg",
      "auth/session/Default/Cookies",
    ]) {
      expect(members).toContain(expected);
    }
    const joined = members.join("\n");
    expect(joined).not.toContain("dev.db-wal");
    expect(joined).not.toContain("Cache");
    expect(joined).not.toContain("junk.bin");

    // The archived db is byte-identical to the source fixture...
    const extractDir = path.join(fx.work, "extract");
    mkdirSync(extractDir);
    const untar = spawnSync("tar", ["-xzf", archivePath, "-C", extractDir], { encoding: "utf8" });
    expect(untar.status, untar.stderr ?? "").toBe(0);
    const restored = readFileSync(path.join(extractDir, "data", "dev.db"));
    expect(restored.equals(readFileSync(path.join(fx.dataDir, "dev.db")))).toBe(true);

    // ...and it got there through `sqlite3 .backup` (a consistent snapshot),
    // once per db file — never through a raw copy of a live database.
    expect(ctx.stubLog).toContain(`${path.join(fx.dataDir, "dev.db")} .backup '`);
    expect(ctx.stubLog).toContain(`${path.join(fx.dataDir, "extra.db")} .backup '`);
  });

  it("detects a corrupt archive, cleans up, and exits 1", () => {
    const fx = makeStack();
    writeSettings(fx);

    const ctx = runBackup(fx, { STUB_TAR_CORRUPT: "1" });
    expect(ctx.status).toBe(1);
    expect(ctx.stderr).toMatch(/verif|corrupt|readable/i);
    // The partial archive and its sidecar are deleted.
    expect(backupArchives(fx.backupDir)).toEqual([]);
    expect(backupSidecars(fx.backupDir)).toEqual([]);
  });

  it("tolerates tar exit 1 (files changed on the live trees) and still verifies the archive", () => {
    const fx = makeStack();
    const hook = writeHookStub(fx);
    writeSettings(fx, { PORTAL_OFFSITE_HOOK: hook });

    // GNU tar exit 1 means "file changed as we read it" — normal on the live
    // auth/uploads trees. The stub wrote a perfectly good archive before
    // exiting 1, so the run must succeed end to end.
    const ctx = runBackup(fx, { STUB_TAR_EXIT: "1" });
    expect(ctx.status, ctx.stdout + ctx.stderr).toBe(0);
    expect(ctx.stderr).toMatch(/files changed while being archived/i);
    expect(ctx.stdout).toContain("backup: verified");
    expect(backupArchives(fx.backupDir)).toHaveLength(1);
    // A tolerated warning still runs the hook — the backup itself succeeded.
    expect(existsSync(fx.hookLog)).toBe(true);
  });

  it("removes the partial archive and prunes nothing when tar fails hard (exit 2)", () => {
    const fx = makeStack();
    const hook = writeHookStub(fx);
    writeSettings(fx, { PORTAL_BACKUP_KEEP_DAYS: "14", PORTAL_OFFSITE_HOOK: hook });
    // A verified backup that must survive this failed run untouched.
    seedOldPair(fx.backupDir, "portal-backup-20000101T000000Z.tar.gz", 30);

    // The stub writes a PARTIAL (truncated) archive, then exits 2 — a hard
    // failure like a full disk. Without cleanup, every failed night would
    // leave one more orphan portal-backup-* archive that retention never
    // reaches (retention only runs after a verified backup).
    const ctx = runBackup(fx, { STUB_TAR_CORRUPT: "1", STUB_TAR_EXIT: "2" });
    expect(ctx.status).toBe(1);
    expect(ctx.stderr).toMatch(/tar failed \(exit 2\)/);

    // No new archive or sidecar is left behind — only the seeded old pair.
    expect(backupArchives(fx.backupDir)).toEqual(["portal-backup-20000101T000000Z.tar.gz"]);
    expect(backupSidecars(fx.backupDir)).toEqual(["portal-backup-20000101T000000Z.tar.gz.sha256"]);
    // Retention never ran, and the hook was not called.
    expect(existsSync(fx.hookLog)).toBe(false);
  });

  it("prunes only its own portal-backup-* archives older than KEEP days", () => {
    const fx = makeStack();
    writeSettings(fx, { PORTAL_BACKUP_KEEP_DAYS: "14" });
    seedOldPair(fx.backupDir, "portal-backup-20000101T000000Z.tar.gz", 30);
    // The deploy gate's archives share the backup dir and must never be
    // pruned by this script.
    seedOldPair(fx.backupDir, "portal-production-20000101T000000Z.tar.gz", 30);

    const ctx = runBackup(fx);
    expect(ctx.status, ctx.stdout + ctx.stderr).toBe(0);

    // The old portal-backup pair is gone; the fresh archive took its place.
    const archives = backupArchives(fx.backupDir);
    expect(archives).toHaveLength(1);
    expect(archives[0]).not.toBe("portal-backup-20000101T000000Z.tar.gz");
    expect(backupSidecars(fx.backupDir)).toEqual([`${archives[0]}.sha256`]);

    // The deploy gate's pair is untouched, sha256 sidecar included.
    expect(existsSync(path.join(fx.backupDir, "portal-production-20000101T000000Z.tar.gz"))).toBe(true);
    expect(existsSync(path.join(fx.backupDir, "portal-production-20000101T000000Z.tar.gz.sha256"))).toBe(
      true
    );
  });

  it("runs the off-site hook with the verified archive path", () => {
    const fx = makeStack();
    const hook = writeHookStub(fx);
    writeSettings(fx, { PORTAL_OFFSITE_HOOK: hook });

    const ctx = runBackup(fx);
    expect(ctx.status, ctx.stdout + ctx.stderr).toBe(0);

    const archives = backupArchives(fx.backupDir);
    expect(archives).toHaveLength(1);
    // Exactly one hook call, carrying the new archive's absolute path.
    expect(readFileSync(fx.hookLog, "utf8")).toBe(`${path.join(fx.backupDir, archives[0])}\n`);
  });

  it("never prunes or calls the hook when the new archive fails verification", () => {
    const fx = makeStack();
    const hook = writeHookStub(fx);
    writeSettings(fx, { PORTAL_BACKUP_KEEP_DAYS: "14", PORTAL_OFFSITE_HOOK: hook });
    // The only verified backup there is: deleting it on a failed run would
    // leave the server with no backup at all.
    seedOldPair(fx.backupDir, "portal-backup-20000101T000000Z.tar.gz", 30);

    const ctx = runBackup(fx, { STUB_TAR_CORRUPT: "1" });
    expect(ctx.status).toBe(1);

    expect(existsSync(path.join(fx.backupDir, "portal-backup-20000101T000000Z.tar.gz"))).toBe(true);
    expect(existsSync(path.join(fx.backupDir, "portal-backup-20000101T000000Z.tar.gz.sha256"))).toBe(true);
    expect(existsSync(fx.hookLog)).toBe(false);
  });

  it("refuses to run when the data dir holds no database", () => {
    const fx = makeStack(false);
    writeSettings(fx);

    const ctx = runBackup(fx);
    expect(ctx.status).toBe(1);
    expect(ctx.stderr).toMatch(/database|\.db/i);
    expect(backupArchives(fx.backupDir)).toEqual([]);
    expect(backupSidecars(fx.backupDir)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// conventions + systemd units
// ---------------------------------------------------------------------------

describe("portal-backup script conventions", () => {
  it("follows the deploy-script conventions", () => {
    const src = readFileSync(SCRIPT, "utf8");
    expect(src.startsWith("#!/usr/bin/env bash")).toBe(true);
    expect(src).toContain("set -euo pipefail");
  });

  it("passes bash -n", () => {
    const res = spawnSync("bash", ["-n", SCRIPT], { encoding: "utf8" });
    expect(res.status, res.stderr ?? "").toBe(0);
  });

  it("is shellcheck-clean when shellcheck is available", () => {
    const check = spawnSync("bash", ["-c", "command -v shellcheck"], { encoding: "utf8" });
    if (check.status !== 0) {
      return; // shellcheck not installed here — nothing to assert
    }
    const res = spawnSync("shellcheck", [SCRIPT], { encoding: "utf8" });
    expect(res.status, (res.stdout ?? "") + (res.stderr ?? "")).toBe(0);
  });
});

describe("portal-backup systemd units", () => {
  it("the service is a oneshot running the installed backup script", () => {
    const src = readFileSync(SERVICE_UNIT, "utf8");
    expect(src).toContain("Type=oneshot");
    expect(src).toContain("ExecStart=/usr/local/lib/portal-deploy/portal-backup");
  });

  it("the timer runs nightly at 03:30, catches up after downtime, and is wanted by timers.target", () => {
    const src = readFileSync(TIMER_UNIT, "utf8");
    expect(src).toContain("OnCalendar=");
    expect(src).toContain("03:30");
    expect(src).toContain("Persistent=true");
    expect(src).toContain("WantedBy=timers.target");
  });
});
