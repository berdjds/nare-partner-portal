/**
 * Manual recovery tests (W3b, task script-param) for scripts/export-since.sh
 * and scripts/restore-backup.sh.
 *
 * export-since: a real Prisma-pushed SQLite fixture is seeded with rows that
 * are old, new, or touched-after-create; the real script is run against it
 * and the JSON export must contain exactly the rows created or updated at/after
 * the archive's timestamp — no more, no less (tables without
 * createdAt/updatedAt are skipped and listed).
 *
 * restore-backup: the real script runs against a throwaway PORTAL_ROOT with
 * the same /opt/stack layout as the server (portal/{data,uploads,auth} under
 * the root, docker-compose.yml at the root) and the docker CLI replaced by
 * the same test double as the deploy-gate tests (tests/deploy/docker-stub.sh).
 * Covers argument/checksum validation, the --yes refusal, the export-since
 * acknowledgement (--no-export-ack escape hatch), the paused-notification
 * start (compose override carrying WACONTROL_NOTIFICATIONS_PAUSED=1), the
 * restore image check (the previous pre-deploy image is verified and retagged
 * as the compose service image portal:latest — portal-staging:latest in
 * staging — never the failed candidate a broken cutover left behind, and
 * never a production tag from a staging run), archive member validation, the
 * staging variant (portal-staging, with the WHATSAPP_DISABLED=1 override
 * merged into the compose up), and the acceptance rule that vps-deploy.sh
 * never calls restore-backup.sh.
 */

import { spawnSync } from "child_process";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const EXPORT_SCRIPT = path.join(REPO_ROOT, "scripts", "export-since.sh");
const RESTORE_SCRIPT = path.join(REPO_ROOT, "scripts", "restore-backup.sh");
const DEPLOY_SCRIPT = path.join(REPO_ROOT, "scripts", "vps-deploy.sh");
const DOCKER_STUB = path.join(REPO_ROOT, "tests", "deploy", "docker-stub.sh");
const APP_CONTAINER = "portal-app";
const THREE_DIRS = ["data", "uploads", "auth"] as const;

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  dockerLog: string;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** The portal-<env>-YYYYMMDDTHHMMSSZ stamp format used by scripts/vps-deploy.sh. */
function stampOf(d: Date): string {
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/** ISO string with milliseconds dropped — matches archive_since() output. */
function isoSecondPrecision(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function floorToSecond(d: Date): Date {
  return new Date(Math.floor(d.getTime() / 1000) * 1000);
}

function runScript(script: string, args: string[], env: NodeJS.ProcessEnv): RunResult {
  const res = spawnSync("bash", [script, ...args], { env, encoding: "utf8" });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "", dockerLog: "" };
}

// ---------------------------------------------------------------------------
// export-since fixtures
// ---------------------------------------------------------------------------

/** A throwaway PORTAL_ROOT mirroring /opt/stack: portal/{data,uploads,auth}. */
function makeAppRoot(): string {
  const appRoot = mkdtempSync(path.join(tmpdir(), "portal-recovery-"));
  for (const dir of THREE_DIRS) {
    mkdirSync(path.join(appRoot, "portal", dir), { recursive: true });
  }
  return appRoot;
}

/**
 * Build a backup archive holding the three data dir trees. sourceRoot must be
 * the directory that CONTAINS data/, uploads/ and auth/ (a standalone backup
 * tree, or <appRoot>/portal when archiving the app root itself).
 */
function makeArchive(sourceRoot: string, targetDir: string, name: string, mtime?: Date): string {
  mkdirSync(targetDir, { recursive: true });
  const archive = path.join(targetDir, name);
  const res = spawnSync("tar", ["-czf", archive, "-C", sourceRoot, ...THREE_DIRS], {
    encoding: "utf8",
  });
  if (res.status !== 0) throw new Error(`fixture tar failed: ${res.stderr}`);
  if (mtime) {
    utimesSync(archive, mtime, mtime);
  }
  return archive;
}

/** Push the Prisma schema into <appRoot>/portal/data/dev.db and connect. */
async function openFixtureDb(appRoot: string): Promise<PrismaClient> {
  const dbUrl = `file:${path.join(appRoot, "portal", "data", "dev.db")}`;
  const push = spawnSync("npx", ["prisma", "db", "push", "--skip-generate"], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: dbUrl },
    encoding: "utf8",
  });
  if (push.status !== 0) throw new Error(`fixture db push failed: ${push.stderr}`);
  process.env.DATABASE_URL = dbUrl;
  const { PrismaClient } = await import("@prisma/client");
  return new PrismaClient();
}

function exportEnv(appRoot: string): NodeJS.ProcessEnv {
  return {
    ...(process.env as Record<string, string>),
    NODE_ENV: (process.env.NODE_ENV ?? "test") as "test",
    PORTAL_ROOT: appRoot,
  };
}

// ---------------------------------------------------------------------------
// restore fixtures
// ---------------------------------------------------------------------------

function writeSha256Sidecar(archive: string): void {
  const sum = spawnSync("sha256sum", [archive], { encoding: "utf8" });
  if (sum.status !== 0) throw new Error(`fixture sha256sum failed: ${sum.stderr}`);
  writeFileSync(`${archive}.sha256`, sum.stdout);
}

/**
 * PORTAL_ROOT whose live data dirs say "live", plus a verified backup archive
 * (with sha256 sidecar) whose dirs say "backup".
 */
function setupRestoreFixture(): { appRoot: string; archive: string; exportFile: string } {
  const appRoot = makeAppRoot();
  for (const dir of THREE_DIRS) {
    writeFileSync(path.join(appRoot, "portal", dir, "MARKER.txt"), `${dir} live`);
  }
  writeFileSync(path.join(appRoot, "docker-compose.yml"), "services: {}\n# test fixture\n");

  const backupTree = mkdtempSync(path.join(tmpdir(), "portal-backup-tree-"));
  for (const dir of THREE_DIRS) {
    mkdirSync(path.join(backupTree, dir));
    writeFileSync(path.join(backupTree, dir, "MARKER.txt"), `${dir} backup`);
  }
  writeFileSync(path.join(backupTree, "data", "dev.db"), "backup db bytes");

  const backupsDir = path.join(appRoot, "backups");
  const archive = makeArchive(backupTree, backupsDir, "portal-production-20260928T120000Z.tar.gz");
  writeSha256Sidecar(archive);
  return { appRoot, archive, exportFile: archive.replace(/\.tar\.gz$/, ".export.json") };
}

function runRestore(args: string[], appRoot: string, stubEnv: Record<string, string> = {}): RunResult {
  const work = mkdtempSync(path.join(tmpdir(), "portal-restore-run-"));
  const stubBin = path.join(work, "bin");
  mkdirSync(stubBin);
  const dockerPath = path.join(stubBin, "docker");
  cpSync(DOCKER_STUB, dockerPath);
  chmodSync(dockerPath, 0o755);
  const logPath = path.join(work, "docker.log");
  mkdirSync(path.join(work, "state"));

  const env: NodeJS.ProcessEnv = {
    ...(process.env as Record<string, string>),
    NODE_ENV: (process.env.NODE_ENV ?? "test") as "test",
    PATH: `${stubBin}:${process.env.PATH ?? ""}`,
    PORTAL_ROOT: appRoot,
    STUB_LOG: logPath,
    STUB_STATE_DIR: path.join(work, "state"),
    PORTAL_HEALTH_RETRIES: "2",
    PORTAL_HEALTH_INTERVAL_SECONDS: "0",
    ...stubEnv,
  };
  const res = spawnSync("bash", [RESTORE_SCRIPT, ...args], { env, encoding: "utf8" });
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    dockerLog: existsSync(logPath) ? readFileSync(logPath, "utf8") : "",
  };
}

function lines(log: string): string[] {
  return log.split("\n").filter((line) => line.length > 0);
}

function assertInOrder(log: string, steps: string[]) {
  let cursor = 0;
  for (const step of steps) {
    const idx = log.indexOf(step, cursor);
    expect(idx, `docker step out of order or missing: "${step}"`).toBeGreaterThanOrEqual(0);
    cursor = idx + step.length;
  }
}

function expectLiveMarkers(appRoot: string) {
  for (const dir of THREE_DIRS) {
    expect(readFileSync(path.join(appRoot, "portal", dir, "MARKER.txt"), "utf8")).toBe(`${dir} live`);
  }
}

function expectBackupMarkers(appRoot: string) {
  for (const dir of THREE_DIRS) {
    expect(readFileSync(path.join(appRoot, "portal", dir, "MARKER.txt"), "utf8")).toBe(`${dir} backup`);
  }
}

// ---------------------------------------------------------------------------
// scripts/export-since.sh
// ---------------------------------------------------------------------------

describe("scripts/export-since.sh", () => {
  it("exports exactly the rows created or updated after the archive timestamp", async () => {
    const appRoot = makeAppRoot();
    const prisma = await openFixtureDb(appRoot);
    try {
      const cutoff = new Date(Date.now() - 5 * 60 * 1000);
      const before = new Date(cutoff.getTime() - 60 * 1000);

      // Old rows: created before the backup, never touched since.
      const oldChat = await prisma.chat.create({ data: { remoteJid: "old@lid" } });
      await prisma.message.create({ data: { chatId: oldChat.id, remoteJid: "old@lid", body: "old" } });
      await prisma.log.create({ data: { action: "OLD_EVENT" } });
      await prisma.$executeRawUnsafe(
        `UPDATE "Chat" SET "createdAt" = ?, "updatedAt" = ? WHERE "id" = ?`,
        before,
        before,
        oldChat.id
      );
      await prisma.$executeRawUnsafe(
        `UPDATE "Message" SET "createdAt" = ?, "updatedAt" = ? WHERE "chatId" = ?`,
        before,
        before,
        oldChat.id
      );
      await prisma.$executeRawUnsafe(`UPDATE "Log" SET "createdAt" = ? WHERE "action" = ?`, before, "OLD_EVENT");

      // Touched row: created before the backup but updated after it — the
      // updatedAt branch must catch it even though createdAt is old.
      const touchedChat = await prisma.chat.create({ data: { remoteJid: "touched@lid" } });
      await prisma.$executeRawUnsafe(
        `UPDATE "Chat" SET "createdAt" = ?, "updatedAt" = ? WHERE "id" = ?`,
        before,
        before,
        touchedChat.id
      );
      await prisma.$executeRawUnsafe(
        `UPDATE "Chat" SET "updatedAt" = ? WHERE "id" = ?`,
        new Date(),
        touchedChat.id
      );

      // New rows: created after the backup.
      const newChat = await prisma.chat.create({ data: { remoteJid: "new@lid" } });
      const newMessage = await prisma.message.create({
        data: { chatId: newChat.id, remoteJid: "new@lid", body: "new" },
      });
      const newLog = await prisma.log.create({ data: { action: "NEW_EVENT" } });

      const archive = makeArchive(
        path.join(appRoot, "portal"),
        path.join(appRoot, "backups"),
        `portal-production-${stampOf(cutoff)}.tar.gz`
      );
      const exportFile = archive.replace(/\.tar\.gz$/, ".export.json");

      const ctx = runScript(EXPORT_SCRIPT, [archive], exportEnv(appRoot));
      expect(ctx.status, ctx.stderr).toBe(0);
      expect(ctx.stderr).toContain("export-since: Chat:");
      expect(existsSync(exportFile)).toBe(true);

      const out = JSON.parse(readFileSync(exportFile, "utf8"));
      expect(out.archive).toBe(path.basename(archive));
      expect(out.since).toBe(isoSecondPrecision(floorToSecond(cutoff)));

      // Exactly the post-backup rows — the old rows are absent everywhere.
      expect(out.tables.Chat.map((r: { id: string }) => r.id).sort()).toEqual(
        [newChat.id, touchedChat.id].sort()
      );
      expect(out.tables.Message.map((r: { id: string }) => r.id)).toEqual([newMessage.id]);
      expect(out.tables.Log.map((r: { id: string }) => r.id)).toEqual([newLog.id]);
      // Timestamped tables with no matching rows are exported empty.
      expect(out.tables.TravelRequest).toEqual([]);
      expect(out.totalRows).toBe(4);
      expect(out.counts.Chat).toBe(2);
      const allRows = JSON.stringify(out.tables);
      expect(allRows).not.toContain(oldChat.id);
      // Tables without createdAt/updatedAt are skipped, and listed.
      expect(out.tables.Scenario).toBeUndefined();
      expect(out.skippedTables).toContain("Scenario");
      expect(out.skippedTables).not.toContain("Message");
    } finally {
      await prisma.$disconnect();
    }
  });

  it("falls back to the archive mtime when the name has no timestamp", async () => {
    const appRoot = makeAppRoot();
    const prisma = await openFixtureDb(appRoot);
    try {
      const oldAt = new Date(Date.now() - 60 * 1000);
      const oldChat = await prisma.chat.create({ data: { remoteJid: "old@lid" } });
      await prisma.$executeRawUnsafe(
        `UPDATE "Chat" SET "createdAt" = ?, "updatedAt" = ? WHERE "id" = ?`,
        oldAt,
        oldAt,
        oldChat.id
      );

      const mtime = new Date();
      const archive = makeArchive(path.join(appRoot, "portal"), path.join(appRoot, "backups"), "manual.tar.gz", mtime);

      const newChat = await prisma.chat.create({ data: { remoteJid: "new@lid" } });

      const ctx = runScript(EXPORT_SCRIPT, [archive], exportEnv(appRoot));
      expect(ctx.status, ctx.stderr).toBe(0);
      const out = JSON.parse(readFileSync(archive.replace(/\.tar\.gz$/, ".export.json"), "utf8"));
      expect(out.since).toBe(isoSecondPrecision(floorToSecond(mtime)));
      expect(out.tables.Chat.map((r: { id: string }) => r.id)).toEqual([newChat.id]);
    } finally {
      await prisma.$disconnect();
    }
  });

  it("refuses to run when the live database is missing", () => {
    const appRoot = makeAppRoot(); // no dev.db inside portal/data
    const archive = makeArchive(
      path.join(appRoot, "portal"),
      path.join(appRoot, "backups"),
      "portal-production-20260928T120000Z.tar.gz"
    );
    const ctx = runScript(EXPORT_SCRIPT, [archive], exportEnv(appRoot));
    expect(ctx.status).toBe(1);
    expect(ctx.stderr).toContain("live database not found");
  });
});

// ---------------------------------------------------------------------------
// scripts/restore-backup.sh
// ---------------------------------------------------------------------------

describe("scripts/restore-backup.sh", () => {
  it("refuses to run without --yes", () => {
    const { appRoot, archive } = setupRestoreFixture();
    const ctx = runRestore([archive], appRoot);
    expect(ctx.status).toBe(1);
    expect(ctx.stderr).toContain("--yes");
    expect(ctx.dockerLog).toBe(""); // the refusal happens before any docker call
    expectLiveMarkers(appRoot);
  });

  it("validates the archive argument", () => {
    const { appRoot } = setupRestoreFixture();
    const missing = runRestore(["--yes"], appRoot);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("usage");

    const notFound = runRestore(["/nonexistent/portal-production-20260928T120000Z.tar.gz", "--yes"], appRoot);
    expect(notFound.status).toBe(1);
    expect(notFound.stderr).toContain("archive not found");
    expect(notFound.dockerLog).toBe("");
  });

  it("refuses on a checksum mismatch", () => {
    const { appRoot, archive } = setupRestoreFixture();
    appendFileSync(archive, "corruption");
    const ctx = runRestore([archive, "--yes"], appRoot);
    expect(ctx.status).toBe(1);
    expect(ctx.stderr).toMatch(/checksum mismatch/);
    expect(ctx.dockerLog).toBe("");
    expectLiveMarkers(appRoot);
  });

  it("refuses without the export-since acknowledgement for this archive", () => {
    const { appRoot, archive, exportFile } = setupRestoreFixture();
    expect(existsSync(exportFile)).toBe(false);
    const ctx = runRestore([archive, "--yes"], appRoot);
    expect(ctx.status).toBe(1);
    expect(ctx.stderr).toContain("export-since");
    expect(ctx.stderr).toContain(exportFile);
    expect(ctx.dockerLog).toBe("");
    expectLiveMarkers(appRoot);
  });

  it("restores the three data dirs and starts the app with notifications paused", () => {
    const { appRoot, archive, exportFile } = setupRestoreFixture();
    writeFileSync(exportFile, JSON.stringify({ tables: {}, counts: {}, totalRows: 0 }));

    const ctx = runRestore([archive, "--yes"], appRoot);
    expect(ctx.status, ctx.stdout + ctx.stderr).toBe(0);

    // The restore image is verified and retagged as the compose service
    // image BEFORE the app is stopped; the paused compose up and the health
    // probe come last. Starting portal:latest untagged would boot the
    // failed candidate on the restored backup.
    assertInOrder(ctx.dockerLog, [
      `image inspect portal:previous`,
      `tag portal:previous portal:latest`,
      `stop ${APP_CONTAINER}`,
      `compose -f ${path.join(appRoot, "docker-compose.yml")} -f ${path.join(appRoot, "portal-restore-paused.compose.yml")} up -d portal`,
      `exec ${APP_CONTAINER}`,
    ]);

    // The pause override carries WACONTROL_NOTIFICATIONS_PAUSED=1 and is
    // what compose merges into the restarted app.
    const pauseFile = path.join(appRoot, "portal-restore-paused.compose.yml");
    expect(readFileSync(pauseFile, "utf8")).toContain("WACONTROL_NOTIFICATIONS_PAUSED=1");
    expect(ctx.dockerLog).toContain(`-f ${pauseFile}`);

    // All three dirs now hold the backup content.
    expectBackupMarkers(appRoot);
    expect(readFileSync(path.join(appRoot, "portal", "data", "dev.db"), "utf8")).toBe("backup db bytes");

    // The operator is told how to review the export and resume notifications,
    // and which image the restored app runs.
    expect(ctx.stdout).toContain("RESTORE COMPLETE");
    expect(ctx.stdout).toContain(exportFile);
    expect(ctx.stdout).toContain("PAUSED");
    expect(ctx.stdout).toContain("resume");
    expect(ctx.stdout).toContain("portal-restore-paused.compose.yml");
    expect(ctx.stdout).toContain("portal:previous");
    expect(ctx.stdout).toContain("not the failed candidate");
  });

  it("does not mistake the running app's short Docker ID for another restore writer", () => {
    const { appRoot, archive, exportFile } = setupRestoreFixture();
    writeFileSync(exportFile, JSON.stringify({ tables: {}, counts: {}, totalRows: 0 }));
    const ctx = runRestore([archive, "--yes"], appRoot, {
      STUB_APP_ID: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      STUB_APP_SHORT_ID: "abcdef123456",
      STUB_APP_MOUNTS: path.join(appRoot, "portal", "data"),
    });
    expect(ctx.status, ctx.stdout + ctx.stderr).toBe(0);
    expect(ctx.dockerLog).toContain("ps -q --no-trunc");
    expectBackupMarkers(appRoot);
  });

  it("refuses when the restore image is missing", () => {
    const { appRoot, archive, exportFile } = setupRestoreFixture();
    writeFileSync(exportFile, JSON.stringify({ tables: {}, counts: {}, totalRows: 0 }));
    const ctx = runRestore([archive, "--yes"], appRoot, { STUB_CONTAINER_MISSING: "1" });
    expect(ctx.status).toBe(1);
    expect(ctx.stderr).toContain("restore image");
    expect(ctx.stderr).toContain("portal:previous");
    expect(ctx.dockerLog).toContain("image inspect portal:previous");
    // The refusal happens before the app is stopped or any data is touched.
    expect(ctx.dockerLog).not.toContain(`stop ${APP_CONTAINER}`);
    expect(ctx.dockerLog).not.toContain("tag portal:previous");
    expectLiveMarkers(appRoot);
  });

  it("honors PORTAL_RESTORE_IMAGE for the verified, retagged start", () => {
    const { appRoot, archive, exportFile } = setupRestoreFixture();
    writeFileSync(exportFile, JSON.stringify({ tables: {}, counts: {}, totalRows: 0 }));
    const ctx = runRestore([archive, "--yes"], appRoot, { PORTAL_RESTORE_IMAGE: "portal:known-good" });
    expect(ctx.status, ctx.stdout + ctx.stderr).toBe(0);
    assertInOrder(ctx.dockerLog, [
      `image inspect portal:known-good`,
      `tag portal:known-good portal:latest`,
      `stop ${APP_CONTAINER}`,
      `compose -f ${path.join(appRoot, "docker-compose.yml")} -f ${path.join(appRoot, "portal-restore-paused.compose.yml")} up -d portal`,
    ]);
    expect(ctx.stdout).toContain("portal:known-good");
    expectBackupMarkers(appRoot);
  });

  it("restores with --no-export-ack when the export was preserved another way", () => {
    const { appRoot, archive, exportFile } = setupRestoreFixture();
    expect(existsSync(exportFile)).toBe(false);
    const ctx = runRestore([archive, "--yes", "--no-export-ack"], appRoot);
    expect(ctx.status, ctx.stdout + ctx.stderr).toBe(0);
    expect(ctx.stderr).not.toContain("export-since");
    expectBackupMarkers(appRoot);
    const pauseFile = path.join(appRoot, "portal-restore-paused.compose.yml");
    expect(readFileSync(pauseFile, "utf8")).toContain("WACONTROL_NOTIFICATIONS_PAUSED=1");
    expect(ctx.stdout).toContain("PAUSED");
  });

  it("refuses archives with unexpected members", () => {
    const { appRoot, archive } = setupRestoreFixture();
    // Rebuild the archive with a stray top-level entry next to the data dirs.
    const tree = mkdtempSync(path.join(tmpdir(), "portal-stray-tree-"));
    for (const dir of THREE_DIRS) {
      mkdirSync(path.join(tree, dir));
      writeFileSync(path.join(tree, dir, "MARKER.txt"), `${dir} backup`);
    }
    mkdirSync(path.join(tree, "stray"));
    writeFileSync(path.join(tree, "stray", "evil.txt"), "evil");
    const rebuilt = spawnSync("tar", ["-czf", archive, "-C", tree, ...THREE_DIRS, "stray"], {
      encoding: "utf8",
    });
    if (rebuilt.status !== 0) throw new Error(`fixture tar failed: ${rebuilt.stderr}`);
    writeSha256Sidecar(archive);

    const ctx = runRestore([archive, "--yes", "--no-export-ack"], appRoot);
    expect(ctx.status).toBe(1);
    expect(ctx.stderr).toContain("unexpected archive member");
    expect(ctx.dockerLog).not.toContain(`stop ${APP_CONTAINER}`);
    // The refusal happens after the image-existence check but BEFORE
    // portal:latest is retagged — a refused restore must not move the tag.
    expect(ctx.dockerLog).not.toContain("tag portal:previous");
    expectLiveMarkers(appRoot);
  });

  it("staging restore stops portal-staging and merges the WHATSAPP_DISABLED override", () => {
    const { appRoot, archive, exportFile } = setupRestoreFixture();
    expect(existsSync(exportFile)).toBe(false);
    const ctx = runRestore([archive, "--yes", "--no-export-ack"], appRoot, {
      PORTAL_ENV_NAME: "staging",
    });
    expect(ctx.status, ctx.stdout + ctx.stderr).toBe(0);

    // Staging's container is portal-staging; portal-app is never touched.
    expect(ctx.dockerLog).toContain("stop portal-staging");
    expect(ctx.dockerLog).not.toContain("stop portal-app");

    // The compose up merges the provisioning compose file, the staging
    // override and the pause override, in that order.
    assertInOrder(ctx.dockerLog, [
      `tag portal-staging:previous portal-staging:latest`,
      `stop portal-staging`,
      `compose -f ${path.join(appRoot, "docker-compose.yml")} -f ${path.join(appRoot, "portal-staging.overrides.yml")} -f ${path.join(appRoot, "portal-restore-paused.compose.yml")} up -d portal-staging`,
    ]);

    // The staging override was written (it was missing) and carries the
    // WhatsApp gate so a restored staging never starts the WhatsApp client.
    const stagingOverride = path.join(appRoot, "portal-staging.overrides.yml");
    expect(existsSync(stagingOverride)).toBe(true);
    expect(readFileSync(stagingOverride, "utf8")).toContain("WHATSAPP_DISABLED=1");

    // The data dirs still get the backup content.
    expectBackupMarkers(appRoot);
  });

  it("staging restore never inspects or tags the shared production image tags", () => {
    const { appRoot, archive, exportFile } = setupRestoreFixture();
    expect(existsSync(exportFile)).toBe(false);
    const ctx = runRestore([archive, "--yes", "--no-export-ack"], appRoot, {
      PORTAL_ENV_NAME: "staging",
    });
    expect(ctx.status, ctx.stdout + ctx.stderr).toBe(0);

    // Staging's restore image is portal-staging:previous, retagged as
    // portal-staging:latest; a staging restore must never move the production
    // portal:latest / portal:previous tags.
    expect(ctx.dockerLog).toContain("image inspect portal-staging:previous");
    expect(ctx.dockerLog).toContain("tag portal-staging:previous portal-staging:latest");
    for (const line of lines(ctx.dockerLog)) {
      if (line.startsWith("build ") || line.startsWith("tag ") || line.startsWith("image inspect ")) {
        expect(line).not.toMatch(/(^|\s)portal:(candidate|previous|latest)(\s|$)/);
      }
    }
    expectBackupMarkers(appRoot);
  });
});

// ---------------------------------------------------------------------------
// acceptance + conventions
// ---------------------------------------------------------------------------

describe("manual recovery acceptance", () => {
  it("vps-deploy.sh never calls restore-backup.sh (or export-since.sh)", () => {
    const src = readFileSync(DEPLOY_SCRIPT, "utf8");
    // The deploy gate may only MENTION the manual procedure; it must never
    // invoke the restore (no call form can appear if the file name never does).
    expect(src).not.toContain("restore-backup.sh");
    expect(src).not.toContain("export-since.sh");
  });

  it("recovery scripts follow the deploy-script conventions", () => {
    for (const script of [EXPORT_SCRIPT, RESTORE_SCRIPT]) {
      const src = readFileSync(script, "utf8");
      expect(src).toContain("#!/usr/bin/env bash");
      expect(src).toContain("set -euo pipefail");
    }
  });

  it("recovery scripts pass bash -n", () => {
    for (const script of [EXPORT_SCRIPT, RESTORE_SCRIPT]) {
      const res = spawnSync("bash", ["-n", script], { encoding: "utf8" });
      expect(res.status, `${script}: ${res.stderr}`).toBe(0);
    }
  });

  it("recovery scripts are shellcheck-clean when shellcheck is available", () => {
    const check = spawnSync("bash", ["-c", "command -v shellcheck"], { encoding: "utf8" });
    if (check.status !== 0) {
      return; // shellcheck not installed here — nothing to assert
    }
    const res = spawnSync("shellcheck", [EXPORT_SCRIPT, RESTORE_SCRIPT], { encoding: "utf8" });
    expect(res.status, res.stdout + res.stderr).toBe(0);
  });

  it("the deployment docs document the runbook and the paused start", () => {
    const doc = readFileSync(path.join(REPO_ROOT, "doc", "deployment.md"), "utf8");
    expect(doc).toContain("export-since");
    expect(doc).toContain("restore-backup");
    expect(doc).toContain("WACONTROL_NOTIFICATIONS_PAUSED=1");
    expect(doc).toContain("WRITE FREEZE");
    expect(doc).toContain("20");
  });
});
