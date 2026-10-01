/**
 * Provisioning tests (W3b, task provision) for deploy/provision-server.sh and
 * deploy/portal-deploy-entry.sh.
 *
 * deploy/provision-server.sh is the owner's one-time, idempotent server
 * provisioning script. These tests run the real script with bash in
 * "transplant mode" (PORTAL_PROVISION_ROOT=<tmpdir>): every absolute target
 * path lands under the temp root while system mutations (apt-get, useradd,
 * chown, systemctl) are logged as [skip]. Covered:
 *
 *   - --dry-run prints every action and creates nothing under the root;
 *   - two real runs converge: the second reports only [unchanged]/[skip]
 *     action lines, the seeded production data under
 *     opt/stack/portal/{data,uploads,auth} stays byte-identical, and the
 *     before/after manifest lines are equal;
 *   - the exact authorized_keys line (forced command + all four no-* options)
 *     and a sudoers drop-in with exactly one non-comment line naming only the
 *     dispatcher;
 *   - .env.staging ships EMPTY credentials (never a fixed known secret) so
 *     the compose :? guards refuse to boot a forgotten staging;
 *   - the caddy validate gate: a PATH stub caddy validates the edited
 *     Caddyfile; a failing stub makes the script restore the backup and die;
 *     a failing visudo stub aborts before the sudoers drop-in is installed.
 *
 * deploy/portal-deploy-entry.sh is the forced-command dispatcher installed as
 * /usr/local/sbin/portal-deploy-entry. Its tests drive the repo copy directly
 * with SSH_ORIGINAL_COMMAND plus PORTAL_DEPLOY_SUDO / PORTAL_DEPLOY_LIB_DIR
 * stubs that record the exact argv and PORTAL_ENV_NAME reaching each tool:
 * an accept matrix for every command in the forced-command interface and a
 * reject matrix (shell metacharacters, newline/tab, unknown environments,
 * extra or missing args, `..`, leading `-`, tarballs outside the upload dir,
 * relative restore archives, client-sent --exec, empty SSH_ORIGINAL_COMMAND).
 * `upload <name.tar.gz>` — the pipeline's file-transfer path, since scp/sftp
 * cannot pass the forced command — is covered separately: stdin must land
 * byte-identical in the upload dir without sudo ever being called, unsafe or
 * non-bare names are rejected, and `--exec upload` (running it as root) is
 * refused.
 */

import { spawnSync } from "child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
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
const PROVISION = path.join(REPO_ROOT, "deploy", "provision-server.sh");
const DISPATCHER = path.join(REPO_ROOT, "deploy", "portal-deploy-entry.sh");

const PUBKEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIProvisionTestKeyNotARealKey provision@test";
const EXPECTED_AUTH_KEYS =
  'command="/usr/local/sbin/portal-deploy-entry",no-port-forwarding,no-agent-forwarding,no-pty,no-X11-forwarding' +
  ` ${PUBKEY}`;
const EXPECTED_SUDOERS_RULE = "deploy ALL=(root) NOPASSWD: /usr/local/sbin/portal-deploy-entry";

const PUBLIC_URL = "https://portal.example.test";
const STAGING_URL = "https://staging.example.test";

// Arbitrary bytes — provisioning must leave the seeded production data
// byte-identical across both runs.
const DEV_DB_BYTES = Buffer.from("provision fixture db bytes ");
const UPLOAD_BYTES = Buffer.from("provision fixture upload bytes ");
const AUTH_BYTES = Buffer.from("provision fixture auth bytes ");

const CADDYFILE_BASE = "portal.nare.am {\n    reverse_proxy portal-app:3000\n}\n";
const IMPORT_LINE = "import /etc/caddy/staging.portal.nare.am.caddy";

/**
 * The stub scripts below deliberately use only "$var" expansions (the one
 * ${...} form is escaped) so they can live inside TypeScript template
 * literals. No `set -e` in the stubs on purpose: their scripted failures are
 * driven by explicit exit codes.
 */
const SUDO_STUB = `#!/usr/bin/env bash
# sudo test double: records the exact argv it was asked to run, then runs it —
# stage 1 of the dispatcher chains into stage 2 exactly as real sudo would.
# Falls back to bash when the target lacks the exec bit (the repo copy may not
# carry it; the installed copy is 0755).
printf '%s\\n' "$*" >> "$STUB_SUDO_LOG"
target="$1"
shift
if [ -x "$target" ]; then
  exec "$target" "$@"
fi
exec bash "$target" "$@"
`;

const TOOL_STUB = `#!/usr/bin/env bash
# Installed-tool test double (one copy per tool name): records its own name,
# the exact argv and the PORTAL_ENV_NAME it was handed.
printf 'tool=%s argv=%s PORTAL_ENV_NAME=%s\\n' "$(basename "$0")" "$*" "\${PORTAL_ENV_NAME:-}" >> "$STUB_TOOL_LOG"
`;

function caddyStub(exitCode: number): string {
  return `#!/usr/bin/env bash
# caddy test double: logs the invocation, then exits with a scripted status.
printf '%s\\n' "$*" >> "$STUB_CADDY_LOG"
exit ${exitCode}
`;
}

const VISUDO_FAIL_STUB = `#!/usr/bin/env bash
# visudo test double that always fails validation.
echo "visudo stub: forced validation failure" >&2
exit 1
`;

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function writeExecutable(file: string, content: string): void {
  writeFileSync(file, content);
  chmodSync(file, 0o755);
}

// ---------------------------------------------------------------------------
// deploy/provision-server.sh fixtures
// ---------------------------------------------------------------------------

interface ProvisionFixture {
  work: string;
  root: string;
  pubkeyPath: string;
  portalDir: string;
  caddyDir: string;
  caddyfilePath: string;
  stubBin: string;
  caddyLog: string;
}

/**
 * A throwaway transplant root with production data seeded under
 * opt/stack/portal/{data,uploads,auth} (three files total). When `caddyfile`
 * is given, etc/caddy/Caddyfile is pre-created with that content.
 */
function makeProvisionFixture(opts: { caddyfile?: string } = {}): ProvisionFixture {
  const work = mkdtempSync(path.join(tmpdir(), "portal-provision-"));
  const root = path.join(work, "root");
  const portalDir = path.join(root, "opt", "stack", "portal");
  mkdirSync(path.join(portalDir, "data"), { recursive: true });
  mkdirSync(path.join(portalDir, "uploads"), { recursive: true });
  mkdirSync(path.join(portalDir, "auth", "session"), { recursive: true });
  writeFileSync(path.join(portalDir, "data", "dev.db"), DEV_DB_BYTES);
  writeFileSync(path.join(portalDir, "uploads", "x.jpg"), UPLOAD_BYTES);
  writeFileSync(path.join(portalDir, "auth", "session", "Cookies"), AUTH_BYTES);

  const caddyDir = path.join(root, "etc", "caddy");
  const caddyfilePath = path.join(caddyDir, "Caddyfile");
  if (opts.caddyfile !== undefined) {
    mkdirSync(caddyDir, { recursive: true });
    writeFileSync(caddyfilePath, opts.caddyfile);
  }

  const pubkeyPath = path.join(work, "deploy.pub");
  writeFileSync(pubkeyPath, `${PUBKEY}\n`);
  const stubBin = path.join(work, "bin");
  mkdirSync(stubBin, { recursive: true });

  return { work, root, pubkeyPath, portalDir, caddyDir, caddyfilePath, stubBin, caddyLog: path.join(work, "caddy.log") };
}

/**
 * Run the real provisioning script against the fixture's transplant root with
 * a minimal, controlled environment (the stub dir first on PATH, nothing else
 * inherited) so runs stay deterministic.
 */
function runProvision(
  fx: Pick<ProvisionFixture, "root" | "pubkeyPath"> & Partial<ProvisionFixture>,
  opts: { dryRun?: boolean } = {}
): RunResult {
  const args = [PROVISION, "--pubkey-file", fx.pubkeyPath];
  if (opts.dryRun) args.push("--dry-run");
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: process.env.NODE_ENV ?? "test",
    PATH: fx.stubBin ? `${fx.stubBin}${path.delimiter}${process.env.PATH ?? ""}` : (process.env.PATH ?? ""),
    PORTAL_PROVISION_ROOT: fx.root,
    STUB_CADDY_LOG: fx.caddyLog ?? "",
  };
  const res = spawnSync("bash", args, { env, encoding: "utf8" });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** The current bytes of the three seeded production files. */
function seededBytes(fx: ProvisionFixture): { db: Buffer; upload: Buffer; auth: Buffer } {
  return {
    db: readFileSync(path.join(fx.portalDir, "data", "dev.db")),
    upload: readFileSync(path.join(fx.portalDir, "uploads", "x.jpg")),
    auth: readFileSync(path.join(fx.portalDir, "auth", "session", "Cookies")),
  };
}

/** The before/after manifest summary lines the script prints. */
function manifestLines(stdout: string): { before: string; after: string } {
  const before = /^production data manifest \(before\): (.+)$/m.exec(stdout);
  const after = /^production data manifest \(after\): (.+)$/m.exec(stdout);
  expect(before, stdout).not.toBeNull();
  expect(after, stdout).not.toBeNull();
  return { before: before?.[1] ?? "", after: after?.[1] ?? "" };
}

// ---------------------------------------------------------------------------
// deploy/portal-deploy-entry.sh fixtures
// ---------------------------------------------------------------------------

interface DispatcherFixture {
  work: string;
  libDir: string;
  uploadDir: string;
  sudoPath: string;
  sudoLog: string;
  toolLog: string;
}

function makeDispatcherFixture(): DispatcherFixture {
  const work = mkdtempSync(path.join(tmpdir(), "portal-dispatch-"));
  const libDir = path.join(work, "lib");
  mkdirSync(libDir, { recursive: true });
  for (const tool of ["portal-deploy", "portal-smoke", "portal-backup", "portal-restore", "portal-drill"]) {
    writeExecutable(path.join(libDir, tool), TOOL_STUB);
  }
  const uploadDir = path.join(work, "upload");
  mkdirSync(uploadDir);
  const sudoPath = path.join(work, "sudo");
  writeExecutable(sudoPath, SUDO_STUB);
  return { work, libDir, uploadDir, sudoPath, sudoLog: path.join(work, "sudo.log"), toolLog: path.join(work, "tool.log") };
}

/**
 * Drive the repo copy of the dispatcher as sshd would: no arguments, the
 * client command in SSH_ORIGINAL_COMMAND, sudo and the tool library replaced
 * by recording stubs.
 */
function runDispatcher(fx: DispatcherFixture, sshCommand?: string, stdin?: Buffer): RunResult {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: process.env.NODE_ENV ?? "test",
    PATH: process.env.PATH ?? "",
    PORTAL_DEPLOY_SUDO: fx.sudoPath,
    PORTAL_DEPLOY_LIB_DIR: fx.libDir,
    PORTAL_DEPLOY_ENTRY_PATH: DISPATCHER,
    PORTAL_DEPLOY_UPLOAD_DIR: fx.uploadDir,
    PORTAL_PUBLIC_URL: PUBLIC_URL,
    PORTAL_STAGING_URL: STAGING_URL,
    STUB_SUDO_LOG: fx.sudoLog,
    STUB_TOOL_LOG: fx.toolLog,
  };
  if (sshCommand !== undefined) env.SSH_ORIGINAL_COMMAND = sshCommand;
  const res = spawnSync("bash", [DISPATCHER], { env, encoding: "utf8", input: stdin });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

// ---------------------------------------------------------------------------
// deploy/provision-server.sh
// ---------------------------------------------------------------------------

describe("deploy/provision-server.sh --dry-run", () => {
  it("prints every action and creates nothing under PORTAL_PROVISION_ROOT", () => {
    const work = mkdtempSync(path.join(tmpdir(), "portal-provision-dry-"));
    // The root deliberately does NOT exist yet: a dry run must not create it.
    const root = path.join(work, "root");
    const pubkeyPath = path.join(work, "deploy.pub");
    writeFileSync(pubkeyPath, `${PUBKEY}\n`);

    const res = runProvision({ root, pubkeyPath }, { dryRun: true });
    expect(res.status, res.stdout + res.stderr).toBe(0);
    expect(res.stdout).toContain("[dry-run] would mkdir -p");
    expect(res.stdout).toContain("[dry-run] would install");
    // System mutations are never executed under a transplant root.
    expect(res.stdout).toContain("[skip] system step in test root:");
    expect(res.stdout).toContain("[dry-run] would symlink");
    expect(res.stdout).toContain("NEXT STEPS:");
    // Not a single file or directory was created under the root.
    expect(existsSync(root)).toBe(false);
  });
});

describe("deploy/provision-server.sh idempotency and manifests", () => {
  it("two runs converge; the second reports only [unchanged]/[skip] and leaves production data byte-identical", () => {
    const fx = makeProvisionFixture({ caddyfile: CADDYFILE_BASE });
    // A passing caddy on PATH keeps the validate gate deterministic.
    writeExecutable(path.join(fx.stubBin, "caddy"), caddyStub(0));
    const seeded = seededBytes(fx);

    const run1 = runProvision(fx);
    expect(run1.status, run1.stdout + run1.stderr).toBe(0);
    expect(run1.stdout).toContain("[install]");
    const manifest1 = manifestLines(run1.stdout);
    expect(manifest1.before).toBe(manifest1.after);
    expect(manifest1.before).toContain("files=3");
    // The staging import was appended to the Caddyfile and validated.
    expect(readFileSync(fx.caddyfilePath, "utf8")).toContain(IMPORT_LINE);
    expect(readFileSync(fx.caddyLog, "utf8")).toContain(`validate --config ${fx.caddyfilePath}`);
    // Seeded production data is byte-identical after run 1.
    expect(seededBytes(fx).db.equals(seeded.db)).toBe(true);
    expect(seededBytes(fx).upload.equals(seeded.upload)).toBe(true);
    expect(seededBytes(fx).auth.equals(seeded.auth)).toBe(true);

    const run2 = runProvision(fx);
    expect(run2.status, run2.stdout + run2.stderr).toBe(0);
    // Every action line of the second run is [unchanged] or [skip] — no
    // [install]/[update]/[mkdir]/[symlink]/[backup]/[run]/[caddy].
    const actionLines = run2.stdout.split("\n").filter((line) => line.startsWith("["));
    expect(actionLines.length).toBeGreaterThan(0);
    for (const line of actionLines) {
      expect(line).toMatch(/^\[(unchanged|skip)\]/);
    }
    expect(actionLines.some((line) => line.startsWith("[unchanged]"))).toBe(true);
    const manifest2 = manifestLines(run2.stdout);
    expect(manifest2.before).toBe(manifest2.after);
    expect(manifest2.before).toBe(manifest1.before);
    // Seeded production data is still byte-identical after run 2.
    expect(seededBytes(fx).db.equals(seeded.db)).toBe(true);
    expect(seededBytes(fx).upload.equals(seeded.upload)).toBe(true);
    expect(seededBytes(fx).auth.equals(seeded.auth)).toBe(true);
  });

  it("installs the layout: dispatcher, tool library, systemd units, staging project and caddy site", () => {
    const fx = makeProvisionFixture();
    const res = runProvision(fx);
    expect(res.status, res.stdout + res.stderr).toBe(0);

    const expectedFiles = [
      "usr/local/sbin/portal-deploy-entry",
      "usr/local/lib/portal-deploy/portal-deploy",
      "usr/local/lib/portal-deploy/portal-restore",
      "usr/local/lib/portal-deploy/portal-export",
      "usr/local/lib/portal-deploy/portal-backup",
      "usr/local/lib/portal-deploy/portal-smoke",
      "etc/sudoers.d/portal-deploy",
      "etc/systemd/system/portal-backup.service",
      "etc/systemd/system/portal-backup.timer",
      "etc/portal-backup.env",
      "etc/caddy/staging.portal.nare.am.caddy",
      "opt/stack/staging/docker-compose.yml",
      "opt/stack/staging/.env.staging",
    ];
    for (const rel of expectedFiles) {
      expect(existsSync(path.join(fx.root, ...rel.split("/"))), rel).toBe(true);
    }
    // The dispatcher and the tools are executable; the sudoers drop-in is 0440.
    expect(statSync(path.join(fx.root, "usr/local/sbin/portal-deploy-entry")).mode & 0o111).not.toBe(0);
    expect(statSync(path.join(fx.root, "etc/sudoers.d/portal-deploy")).mode & 0o777).toBe(0o440);
    // The staging data dirs exist, separate from the production ones.
    expect(existsSync(path.join(fx.root, "opt/stack/staging/portal/data"))).toBe(true);
    expect(existsSync(path.join(fx.root, "opt/stack/staging/portal/uploads"))).toBe(true);
    expect(existsSync(path.join(fx.root, "opt/stack/staging/portal/auth"))).toBe(true);
    // .env is a relative symlink to .env.staging.
    const envLink = path.join(fx.root, "opt/stack/staging/.env");
    expect(lstatSync(envLink).isSymbolicLink()).toBe(true);
  });

  it("writes the exact authorized_keys line with the forced command and all four no-* options", () => {
    const fx = makeProvisionFixture();
    const res = runProvision(fx);
    expect(res.status, res.stdout + res.stderr).toBe(0);

    const sshDir = path.join(fx.root, "home", "deploy", ".ssh");
    const authKeys = path.join(sshDir, "authorized_keys");
    const content = readFileSync(authKeys, "utf8");
    // Exactly one line, byte-exact: forced command + the four no-* options.
    expect(content).toBe(`${EXPECTED_AUTH_KEYS}\n`);
    expect(statSync(authKeys).mode & 0o777).toBe(0o600);
    expect(statSync(sshDir).mode & 0o777).toBe(0o700);
  });

  it("writes a sudoers drop-in whose single rule allows only the dispatcher", () => {
    const fx = makeProvisionFixture();
    const res = runProvision(fx);
    expect(res.status, res.stdout + res.stderr).toBe(0);

    const content = readFileSync(path.join(fx.root, "etc", "sudoers.d", "portal-deploy"), "utf8");
    const rules = content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    expect(rules).toEqual([EXPECTED_SUDOERS_RULE]);
  });

  it("writes .env.staging with empty credentials — never a fixed known secret", () => {
    const fx = makeProvisionFixture();
    const res = runProvision(fx);
    expect(res.status, res.stdout + res.stderr).toBe(0);

    const content = readFileSync(path.join(fx.root, "opt", "stack", "staging", ".env.staging"), "utf8");
    // No usable placeholder may ever ship: the compose :? guards must fail
    // loudly until the owner fills in real values.
    expect(content).not.toContain("CHANGE-ME");
    expect(content).toMatch(/^PORTAL_NEXTAUTH_SECRET=$/m);
    expect(content).toMatch(/^PORTAL_ADMIN_EMAIL=$/m);
    expect(content).toMatch(/^PORTAL_ADMIN_PASSWORD=$/m);
    // Staging never starts the WhatsApp client and mails to a sink.
    expect(content).toContain("WHATSAPP_DISABLED=1");
    expect(content).toContain("PORTAL_SMTP_HOST=mail-sink.invalid");
    // The script tells the owner to set the staging credentials.
    expect(res.stdout).toContain("PORTAL_NEXTAUTH_SECRET");
    expect(res.stdout).toMatch(/staging credentials|\.env\.staging/);
  });

  it("creates the deploy user with a real login shell — nologin would break the forced command", () => {
    // sshd runs the forced command as `<login shell> -c <command>`; with a
    // nologin shell every CI connection would die before the dispatcher runs.
    const src = readFileSync(PROVISION, "utf8");
    expect(src).toContain("useradd --create-home --shell /bin/sh deploy");
    expect(src).not.toContain("--shell /usr/sbin/nologin");
  });
});

describe("deploy/provision-server.sh validation gates", () => {
  it("restores the Caddyfile backup and dies when caddy validate fails", () => {
    const fx = makeProvisionFixture({ caddyfile: CADDYFILE_BASE });
    writeExecutable(path.join(fx.stubBin, "caddy"), caddyStub(1));

    const res = runProvision(fx);
    expect(res.status, res.stdout + res.stderr).toBe(1);
    expect(res.stderr).toContain("caddy validate failed");
    // The Caddyfile was restored byte-for-byte and the backup kept.
    expect(readFileSync(fx.caddyfilePath, "utf8")).toBe(CADDYFILE_BASE);
    const backups = readdirSync(fx.caddyDir).filter((entry) => entry.startsWith("Caddyfile.bak-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(path.join(fx.caddyDir, backups[0]), "utf8")).toBe(CADDYFILE_BASE);
  });

  it("aborts without installing the sudoers drop-in when visudo validation fails", () => {
    const fx = makeProvisionFixture();
    writeExecutable(path.join(fx.stubBin, "visudo"), VISUDO_FAIL_STUB);

    const res = runProvision(fx);
    expect(res.status, res.stdout + res.stderr).toBe(1);
    expect(res.stderr).toMatch(/visudo/);
    expect(existsSync(path.join(fx.root, "etc", "sudoers.d", "portal-deploy"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// deploy/portal-deploy-entry.sh
// ---------------------------------------------------------------------------

describe("deploy/portal-deploy-entry.sh accept matrix", () => {
  it("accepts exactly the listed commands and hands each tool the exact argv and PORTAL_ENV_NAME", () => {
    const fx = makeDispatcherFixture();
    const archive = path.join(fx.work, "backups", "a.tar.gz");
    const cases: Array<{ cmd: string; tool: string; sudo: string }> = [
      {
        cmd: "deploy staging app.tar.gz",
        tool: `tool=portal-deploy argv=staging ${fx.uploadDir}/app.tar.gz PORTAL_ENV_NAME=`,
        sudo: `${DISPATCHER} --exec deploy staging ${fx.uploadDir}/app.tar.gz`,
      },
      {
        cmd: "deploy production rel.tar.gz",
        tool: `tool=portal-deploy argv=production ${fx.uploadDir}/rel.tar.gz PORTAL_ENV_NAME=`,
        sudo: `${DISPATCHER} --exec deploy production ${fx.uploadDir}/rel.tar.gz`,
      },
      {
        // An absolute tarball path is accepted only under the upload dir.
        cmd: `deploy staging ${fx.uploadDir}/app.tar.gz`,
        tool: `tool=portal-deploy argv=staging ${fx.uploadDir}/app.tar.gz PORTAL_ENV_NAME=`,
        sudo: `${DISPATCHER} --exec deploy staging ${fx.uploadDir}/app.tar.gz`,
      },
      {
        cmd: "smoke staging",
        tool: `tool=portal-smoke argv=${STAGING_URL} PORTAL_ENV_NAME=`,
        sudo: `${DISPATCHER} --exec smoke staging`,
      },
      {
        cmd: "smoke production",
        tool: `tool=portal-smoke argv=${PUBLIC_URL} PORTAL_ENV_NAME=`,
        sudo: `${DISPATCHER} --exec smoke production`,
      },
      {
        cmd: "backup",
        tool: "tool=portal-backup argv= PORTAL_ENV_NAME=",
        sudo: `${DISPATCHER} --exec backup`,
      },
      {
        // Bare restore is staging-only; the dispatcher's invocation IS the
        // operator's --yes acknowledgement.
        cmd: `restore ${archive}`,
        tool: `tool=portal-restore argv=${archive} --yes PORTAL_ENV_NAME=staging`,
        sudo: `${DISPATCHER} --exec restore ${archive}`,
      },
      {
        cmd: `restore --production ${archive}`,
        tool: `tool=portal-restore argv=${archive} --yes PORTAL_ENV_NAME=production`,
        sudo: `${DISPATCHER} --exec restore --production ${archive}`,
      },
      {
        cmd: "drill-rollback",
        tool: "tool=portal-drill argv=rollback PORTAL_ENV_NAME=staging",
        sudo: `${DISPATCHER} --exec drill-rollback`,
      },
      {
        cmd: "drill-restore",
        tool: "tool=portal-drill argv=restore PORTAL_ENV_NAME=staging",
        sudo: `${DISPATCHER} --exec drill-restore`,
      },
    ];

    for (const c of cases) {
      const res = runDispatcher(fx, c.cmd);
      expect(res.status, `${c.cmd}\n${res.stdout}${res.stderr}`).toBe(0);
    }
    // Every accepted command reached its tool exactly once, in order, and
    // went through sudo as `<dispatcher> --exec <words...>`.
    expect(readFileSync(fx.toolLog, "utf8").trimEnd().split("\n")).toEqual(cases.map((c) => c.tool));
    expect(readFileSync(fx.sudoLog, "utf8").trimEnd().split("\n")).toEqual(cases.map((c) => c.sudo));
  });
});

describe("deploy/portal-deploy-entry.sh reject matrix", () => {
  it("rejects shell metacharacters and control whitespace", () => {
    const fx = makeDispatcherFixture();
    const metachars = [";", "|", "&", "$", "`", "(", ")", "<", ">", "*", "?", "\\", "'", '"'];
    const commands = [
      ...metachars.map((ch) => `deploy staging app.tar.gz${ch}id`),
      "backup\nid",
      "deploy\tstaging app.tar.gz",
    ];
    for (const cmd of commands) {
      const res = runDispatcher(fx, cmd);
      expect(res.status, JSON.stringify(cmd)).toBe(1);
      expect(res.stderr).toContain("portal-deploy-entry: rejected:");
    }
    // Nothing was ever handed to sudo or to a tool.
    expect(existsSync(fx.sudoLog)).toBe(false);
    expect(existsSync(fx.toolLog)).toBe(false);
  });

  it("rejects unknown environments, wrong arity and unsafe paths", () => {
    const fx = makeDispatcherFixture();
    const commands = [
      // Unknown environments.
      "deploy qa app.tar.gz",
      "smoke qa",
      // Extra or missing arguments.
      "backup extra",
      "smoke staging extra",
      "drill-rollback extra",
      "drill-restore now",
      "deploy staging",
      "deploy",
      "smoke",
      "restore",
      // Path traversal.
      "deploy staging ../app.tar.gz",
      `restore ${fx.work}/backups/../a.tar.gz`,
      // Arguments that would be parsed as flags by the downstream tool.
      "deploy staging -app.tar.gz",
      "restore -a.tar.gz",
      // A tarball outside the deploy user's upload dir.
      "deploy staging /etc/app.tar.gz",
      // A relative restore archive.
      "restore backups/a.tar.gz",
      // A client-sent --exec: stage 2 is reachable only via stage 1's sudo.
      "--exec backup",
      // Unknown command.
      "shell",
      // A path argument that is not a .tar.gz archive.
      "deploy staging app.zip",
    ];
    for (const cmd of commands) {
      const res = runDispatcher(fx, cmd);
      expect(res.status, JSON.stringify(cmd)).toBe(1);
      expect(res.stderr).toContain("portal-deploy-entry: rejected:");
    }
    expect(existsSync(fx.sudoLog)).toBe(false);
    expect(existsSync(fx.toolLog)).toBe(false);
  });

  it("rejects an empty or missing SSH_ORIGINAL_COMMAND (interactive access is not allowed)", () => {
    const fx = makeDispatcherFixture();
    const empty = runDispatcher(fx, "");
    expect(empty.status).toBe(1);
    expect(empty.stderr).toContain("portal-deploy-entry: rejected:");
    const missing = runDispatcher(fx, undefined);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("portal-deploy-entry: rejected:");
    expect(existsSync(fx.sudoLog)).toBe(false);
    expect(existsSync(fx.toolLog)).toBe(false);
  });
});

describe("deploy/portal-deploy-entry.sh upload", () => {
  it("writes stdin byte-identically to the upload dir without ever calling sudo", () => {
    const fx = makeDispatcherFixture();
    const payload = Buffer.concat([
      // Binary edge bytes (including the gzip magic) to prove no text mangling.
      Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x1f, 0x8b]),
      Buffer.from("portal-source fixture bytes\n"),
    ]);
    const res = runDispatcher(fx, "upload app.tar.gz", payload);
    expect(res.status, res.stdout + res.stderr).toBe(0);
    expect(readFileSync(path.join(fx.uploadDir, "app.tar.gz")).equals(payload)).toBe(true);
    // Upload is a stage-1 operation: sudo and the tool library were never touched.
    expect(existsSync(fx.sudoLog)).toBe(false);
    expect(existsSync(fx.toolLog)).toBe(false);
    // The atomic temp file was renamed away — only the payload remains.
    expect(readdirSync(fx.uploadDir)).toEqual(["app.tar.gz"]);
  });

  it("rejects unsafe upload names and wrong arity", () => {
    const fx = makeDispatcherFixture();
    const commands = [
      "upload", // missing name
      "upload a.tar.gz extra", // extra argument
      "upload sub/dir/a.tar.gz", // not a bare name
      `upload ${fx.uploadDir}/a.tar.gz`, // absolute path: still not bare
      "upload ../a.tar.gz", // traversal
      "upload -a.tar.gz", // leading dash (would parse as a flag downstream)
      "upload a.zip", // not a .tar.gz archive
    ];
    for (const cmd of commands) {
      const res = runDispatcher(fx, cmd);
      expect(res.status, JSON.stringify(cmd)).toBe(1);
      expect(res.stderr).toContain("portal-deploy-entry: rejected:");
    }
    // Nothing was written, and sudo / the tools were never touched.
    expect(existsSync(fx.sudoLog)).toBe(false);
    expect(existsSync(fx.toolLog)).toBe(false);
    expect(readdirSync(fx.uploadDir)).toEqual([]);
  });

  it("refuses to run upload as root (--exec upload is rejected)", () => {
    const fx = makeDispatcherFixture();
    // Stage 2 is only reachable via stage 1's sudo call, but it must be safe
    // even when invoked directly: upload must never execute with root rights.
    const res = spawnSync("bash", [DISPATCHER, "--exec", "upload", "a.tar.gz"], {
      env: {
        NODE_ENV: process.env.NODE_ENV ?? "test",
        PATH: process.env.PATH ?? "",
        PORTAL_DEPLOY_LIB_DIR: fx.libDir,
        PORTAL_DEPLOY_UPLOAD_DIR: fx.uploadDir,
      },
      encoding: "utf8",
    });
    expect(res.status).toBe(1);
    expect(res.stderr ?? "").toContain("portal-deploy-entry: rejected:");
    expect(existsSync(fx.toolLog)).toBe(false);
    expect(readdirSync(fx.uploadDir)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// conventions
// ---------------------------------------------------------------------------

describe("provisioning script conventions", () => {
  const scripts = [
    ["deploy/provision-server.sh", PROVISION],
    ["deploy/portal-deploy-entry.sh", DISPATCHER],
  ] as const;

  for (const [name, script] of scripts) {
    it(`${name} follows the deploy-script conventions`, () => {
      const src = readFileSync(script, "utf8");
      expect(src.startsWith("#!/usr/bin/env bash")).toBe(true);
      expect(src).toContain("set -euo pipefail");
    });

    it(`${name} passes bash -n`, () => {
      const res = spawnSync("bash", ["-n", script], { encoding: "utf8" });
      expect(res.status, res.stderr ?? "").toBe(0);
    });

    it(`${name} is shellcheck-clean when shellcheck is available`, () => {
      const check = spawnSync("bash", ["-c", "command -v shellcheck"], { encoding: "utf8" });
      if (check.status !== 0) {
        return; // shellcheck not installed here — nothing to assert
      }
      const res = spawnSync("shellcheck", [script], { encoding: "utf8" });
      expect(res.status, (res.stdout ?? "") + (res.stderr ?? "")).toBe(0);
    });
  }
});
