/**
 * Merged provisioning tests (W3b provisioning + W3d live layout) for
 * deploy/provision-server.sh and deploy/portal-deploy-entry.sh.
 *
 * deploy/provision-server.sh is the owner's one-time, idempotent server
 * provisioning script, fitted to the live /opt/stack layout: the production
 * compose project runs the caddy container (PORTAL_CADDY_CONTAINER, default
 * "caddy") and the app container (PORTAL_APP_CONTAINER, default "portal-app")
 * on a compose-managed network whose real name is discovered from the running
 * app container, and the staging site is a marker-delimited block inside the
 * single live Caddyfile (PORTAL_CADDYFILE, default /opt/stack/Caddyfile) that
 * is validated and reloaded INSIDE the caddy container via docker exec.
 *
 * These tests run the real script with bash in "transplant mode"
 * (PORTAL_PROVISION_ROOT=<tmpdir>): every absolute target path lands under
 * the temp root while system mutations (apt-get, useradd, chown, systemctl)
 * are logged as [skip]. Docker is replaced by a PATH stub that records every
 * invocation, discovers a scripted network, names the caddy container as
 * running, captures the validate stdin, and scripts failures per scenario.
 * Covered:
 *
 *   - --dry-run prints every action and creates nothing under the root;
 *   - two real runs converge: the second reports only [unchanged]/[skip]
 *     action lines, the seeded production data under
 *     opt/stack/portal/{data,uploads,auth} stays byte-identical, and the
 *     before/after manifest lines are equal;
 *   - the installed layout (dispatcher, tool library incl. portal-drill,
 *     sudoers drop-in, systemd units, staging compose project, .env.staging
 *     + .env symlink) and the absence of the old host-level etc/caddy layout;
 *   - the exact authorized_keys line (forced command + all four no-* options)
 *     and a sudoers drop-in with exactly one non-comment line naming only the
 *     dispatcher;
 *   - .env.staging ships EMPTY credentials and an empty PORTAL_NETWORK line
 *     (never a fixed known secret) so the compose :? guards refuse to boot a
 *     forgotten staging;
 *   - the live-layout caddy flow: the managed staging block is appended with
 *     BEGIN/END markers, the candidate is validated inside the caddy
 *     container BEFORE the live path is touched, a timestamped backup is
 *     kept, a validation failure leaves the live file untouched, a reload
 *     failure restores the backup, a preset PORTAL_NETWORK skips discovery,
 *     and missing docker degrades to warnings (block installed without
 *     validation, empty PORTAL_NETWORK recorded);
 *   - the visudo gate: a failing visudo stub aborts before the sudoers
 *     drop-in is installed;
 *   - static checks: nothing under deploy/ or scripts/ references the old
 *     portal-caddy / portal-web names, and the compose/Caddyfile fixtures the
 *     script depends on match the live layout.
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
const DEV_DB_BYTES = Buffer.from("provision fixture db bytes ");
const UPLOAD_BYTES = Buffer.from("provision fixture upload bytes ");
const AUTH_BYTES = Buffer.from("provision fixture auth bytes ");

// Mirrors the live /opt/stack/Caddyfile (deploy/portal/Caddyfile.example).
const CADDYFILE_FIXTURE =
  "{\n\temail admin@nare.am\n}\n\nportal.nare.am {\n\tencode gzip\n\treverse_proxy portal:3000\n}\n";
const BEGIN_MARKER = "# BEGIN staging.portal.nare.am (managed by provision-server.sh)";
const END_MARKER = "# END staging.portal.nare.am";

/**
 * The stub scripts below deliberately use only "$var" expansions (the ${...}
 * forms are escaped) so they can live inside TypeScript template literals.
 * No `set -e` in the stubs on purpose: their scripted failures are driven by
 * explicit exit codes.
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

// Docker CLI double for the provisioning script: every invocation is appended
// to $STUB_LOG as one space-joined line; behavior is driven by STUB_* env:
//   STUB_NETWORK=<name>        network printed by `docker inspect portal-app`
//   STUB_PS_NAME=<name>        container list printed by `docker ps`
//   STUB_FAIL_INSPECT=1        `docker inspect` exits 1
//   STUB_FAIL_VALIDATE=1       the `caddy validate` exec exits 1
//   STUB_FAIL_RELOAD=1         the `caddy reload` exec exits 1
//   STUB_VALIDATE_CAPTURE=<p>  where the validate exec saves its stdin
const DOCKER_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_LOG"

cmd="\${1:-}"

case "$cmd" in
  inspect)
    if [ -n "\${STUB_FAIL_INSPECT:-}" ]; then
      exit 1
    fi
    printf '%s\\n' "\${STUB_NETWORK:-stack_portal_net}"
    exit 0
    ;;
  ps)
    printf '%s\\n' "\${STUB_PS_NAME:-caddy}"
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
  stackDir: string;
  caddyfilePath: string;
  stubBin: string;
  dockerLog: string;
}

/**
 * A throwaway transplant root with production data seeded under
 * opt/stack/portal/{data,uploads,auth} (three files total). When `caddyfile`
 * is given, opt/stack/Caddyfile — the live-layout location — is pre-created
 * with that content. `stubBin` is an empty dir the tests drop PATH stubs
 * (docker, visudo) into.
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

  const stackDir = path.join(root, "opt", "stack");
  const caddyfilePath = path.join(stackDir, "Caddyfile");
  if (opts.caddyfile !== undefined) {
    mkdirSync(stackDir, { recursive: true });
    writeFileSync(caddyfilePath, opts.caddyfile);
  }

  const pubkeyPath = path.join(work, "deploy.pub");
  writeFileSync(pubkeyPath, `${PUBKEY}\n`);
  const stubBin = path.join(work, "bin");
  mkdirSync(stubBin, { recursive: true });

  return { work, root, pubkeyPath, portalDir, stackDir, caddyfilePath, stubBin, dockerLog: path.join(work, "docker.log") };
}

/**
 * Run the real provisioning script against the fixture's transplant root with
 * a minimal, controlled environment (the stub dir first on PATH, nothing else
 * inherited) so runs stay deterministic. Scenario variables for the docker
 * stub (STUB_FAIL_*, PORTAL_NETWORK, ...) go through `extraEnv`.
 */
function runProvision(
  fx: Pick<ProvisionFixture, "root" | "pubkeyPath"> & Partial<ProvisionFixture>,
  opts: { dryRun?: boolean; extraEnv?: Record<string, string> } = {}
): RunResult {
  const args = [PROVISION, "--pubkey-file", fx.pubkeyPath];
  if (opts.dryRun) args.push("--dry-run");
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: process.env.NODE_ENV ?? "test",
    PATH: fx.stubBin ? `${fx.stubBin}${path.delimiter}${process.env.PATH ?? ""}` : (process.env.PATH ?? ""),
    PORTAL_PROVISION_ROOT: fx.root,
    STUB_LOG: fx.dockerLog ?? "",
    ...opts.extraEnv,
  };
  const res = spawnSync("bash", args, { env, encoding: "utf8" });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** Install the docker stub into the fixture's stub dir. */
function withDockerStub(fx: ProvisionFixture): void {
  writeExecutable(path.join(fx.stubBin, "docker"), DOCKER_STUB);
}

/** Everything the docker stub recorded (empty when docker was never called). */
function readDockerLog(fx: ProvisionFixture): string {
  return existsSync(fx.dockerLog) ? readFileSync(fx.dockerLog, "utf8") : "";
}

/** Timestamped Caddyfile backups next to the live file. */
function caddyBackups(fx: ProvisionFixture): string[] {
  return readdirSync(fx.stackDir).filter((entry) => entry.startsWith("Caddyfile.bak-"));
}

/** Assert that the given steps appear in the log in order. */
function assertInOrder(log: string, steps: string[]): void {
  let cursor = 0;
  for (const step of steps) {
    const idx = log.indexOf(step, cursor);
    expect(idx, `docker step out of order or missing: "${step}"`).toBeGreaterThanOrEqual(0);
    cursor = idx + step.length;
  }
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

/** Recursive file listing for the static checks. */
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
    const fx = makeProvisionFixture({ caddyfile: CADDYFILE_FIXTURE });
    withDockerStub(fx);
    const seeded = seededBytes(fx);

    const run1 = runProvision(fx);
    expect(run1.status, run1.stdout + run1.stderr).toBe(0);
    expect(run1.stdout).toContain("[install]");
    const manifest1 = manifestLines(run1.stdout);
    expect(manifest1.before).toBe(manifest1.after);
    expect(manifest1.before).toContain("files=3");
    // The managed staging block was appended to the live Caddyfile and the
    // discovered production network recorded for staging.
    expect(readFileSync(fx.caddyfilePath, "utf8")).toContain(BEGIN_MARKER);
    expect(readFileSync(fx.caddyfilePath, "utf8")).toContain("reverse_proxy portal-staging:3000");
    expect(readFileSync(path.join(fx.root, "opt", "stack", "staging", ".env.staging"), "utf8")).toContain(
      "PORTAL_NETWORK=stack_portal_net"
    );
    // Seeded production data is byte-identical after run 1.
    expect(seededBytes(fx).db.equals(seeded.db)).toBe(true);
    expect(seededBytes(fx).upload.equals(seeded.upload)).toBe(true);
    expect(seededBytes(fx).auth.equals(seeded.auth)).toBe(true);
    const caddyfileAfterRun1 = readFileSync(fx.caddyfilePath, "utf8");

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
    // The live Caddyfile regenerated byte-identically.
    expect(readFileSync(fx.caddyfilePath, "utf8")).toBe(caddyfileAfterRun1);
    // Seeded production data is still byte-identical after run 2.
    expect(seededBytes(fx).db.equals(seeded.db)).toBe(true);
    expect(seededBytes(fx).upload.equals(seeded.upload)).toBe(true);
    expect(seededBytes(fx).auth.equals(seeded.auth)).toBe(true);
  });

  it("installs the layout: dispatcher, tool library, systemd units and the staging project", () => {
    // No Caddyfile and no docker stub: the live-stack steps degrade to
    // warnings while the rest of the layout is installed.
    const fx = makeProvisionFixture();
    const res = runProvision(fx);
    expect(res.status, res.stdout + res.stderr).toBe(0);
    expect(res.stderr).toContain("[warn]");

    const expectedFiles = [
      "usr/local/sbin/portal-deploy-entry",
      "usr/local/lib/portal-deploy/portal-deploy",
      "usr/local/lib/portal-deploy/portal-restore",
      "usr/local/lib/portal-deploy/portal-export",
      "usr/local/lib/portal-deploy/portal-backup",
      "usr/local/lib/portal-deploy/portal-smoke",
      "usr/local/lib/portal-deploy/portal-drill",
      "etc/sudoers.d/portal-deploy",
      "etc/systemd/system/portal-backup.service",
      "etc/systemd/system/portal-backup.timer",
      "etc/portal-backup.env",
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
    // The old host-level caddy layout is gone: provisioning never creates
    // etc/caddy — the live Caddyfile is a single file under /opt/stack.
    expect(existsSync(path.join(fx.root, "etc", "caddy"))).toBe(false);
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
    // The production network line ships empty too: it is recorded by
    // discovery (or set by hand), never hard-coded.
    expect(content).toMatch(/^PORTAL_NETWORK=$/m);
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
  it("aborts without installing the sudoers drop-in when visudo validation fails", () => {
    const fx = makeProvisionFixture();
    writeExecutable(path.join(fx.stubBin, "visudo"), VISUDO_FAIL_STUB);

    const res = runProvision(fx);
    expect(res.status, res.stdout + res.stderr).toBe(1);
    expect(res.stderr).toMatch(/visudo/);
    expect(existsSync(path.join(fx.root, "etc", "sudoers.d", "portal-deploy"))).toBe(false);
  });
});

describe("deploy/provision-server.sh live layout", () => {
  it("success: network recorded, managed block installed, backup kept, validate before reload", () => {
    const fx = makeProvisionFixture({ caddyfile: CADDYFILE_FIXTURE });
    withDockerStub(fx);

    const res = runProvision(fx);
    expect(res.status, res.stdout + res.stderr).toBe(0);

    // The network came from the stubbed `docker inspect portal-app`.
    expect(readFileSync(path.join(fx.root, "opt", "stack", "staging", ".env.staging"), "utf8")).toContain(
      "PORTAL_NETWORK=stack_portal_net"
    );
    const dockerLog = readDockerLog(fx);
    expect(dockerLog).toContain("inspect");
    expect(dockerLog).toContain("portal-app");

    // Exactly one managed staging block in the live Caddyfile.
    const content = readFileSync(fx.caddyfilePath, "utf8");
    expect(content.match(/^# BEGIN staging\.portal\.nare\.am/gm)).toHaveLength(1);
    expect(content.match(/^# END staging\.portal\.nare\.am$/gm)).toHaveLength(1);
    expect(content).toContain("staging.portal.nare.am {");
    expect(content).toContain("reverse_proxy portal-staging:3000");

    // Exactly one timestamped backup, holding the pre-provisioning content.
    const backups = caddyBackups(fx);
    expect(backups).toHaveLength(1);
    expect(readFileSync(path.join(fx.stackDir, backups[0]), "utf8")).toBe(CADDYFILE_FIXTURE);

    // The candidate was validated inside the caddy container BEFORE reload.
    assertInOrder(dockerLog, ["caddy validate", "caddy reload --config /etc/caddy/Caddyfile"]);
    const captured = readFileSync(`${fx.dockerLog}.validate`, "utf8");
    expect(captured).toContain("# BEGIN staging.portal.nare.am");
    expect(captured).toContain("reverse_proxy portal-staging:3000");
  });

  it("idempotent: a second run regenerates a byte-identical Caddyfile and makes no new backup", () => {
    const fx = makeProvisionFixture({ caddyfile: CADDYFILE_FIXTURE });
    withDockerStub(fx);

    const run1 = runProvision(fx);
    expect(run1.status, run1.stdout + run1.stderr).toBe(0);
    const afterFirst = readFileSync(fx.caddyfilePath, "utf8");

    const run2 = runProvision(fx);
    expect(run2.status, run2.stdout + run2.stderr).toBe(0);
    const afterSecond = readFileSync(fx.caddyfilePath, "utf8");

    expect(afterSecond).toBe(afterFirst);
    expect(afterSecond.match(/^# BEGIN staging\.portal\.nare\.am/gm)).toHaveLength(1);
    expect(afterSecond.match(/^# END staging\.portal\.nare\.am$/gm)).toHaveLength(1);
    expect(caddyBackups(fx)).toHaveLength(1);
  });

  it("keeps the live Caddyfile inode when the block is installed (single-file bind mount)", () => {
    const fx = makeProvisionFixture({ caddyfile: CADDYFILE_FIXTURE });
    withDockerStub(fx);
    const inoBefore = statSync(fx.caddyfilePath).ino;

    const res = runProvision(fx);
    expect(res.status, res.stdout + res.stderr).toBe(0);

    // The live layout bind-mounts the single Caddyfile into the caddy
    // container (./Caddyfile:/etc/caddy/Caddyfile:ro), and a single-file bind
    // mount stays pinned to the inode it was created with. Unlinking and
    // recreating the file would leave the container serving the OLD content
    // while `caddy reload` reports success — the staging site would never
    // activate without a container restart.
    expect(statSync(fx.caddyfilePath).ino).toBe(inoBefore);
    expect(readFileSync(fx.caddyfilePath, "utf8")).toContain("reverse_proxy portal-staging:3000");
  });

  it("invalid candidate: exits 1, live Caddyfile untouched, backup kept, no reload attempted", () => {
    const fx = makeProvisionFixture({ caddyfile: CADDYFILE_FIXTURE });
    withDockerStub(fx);

    const res = runProvision(fx, { extraEnv: { STUB_FAIL_VALIDATE: "1" } });
    expect(res.status, res.stdout + res.stderr).toBe(1);
    expect(res.stderr).toContain("candidate Caddyfile failed validation");
    expect(readFileSync(fx.caddyfilePath, "utf8")).toBe(CADDYFILE_FIXTURE);
    expect(caddyBackups(fx)).toHaveLength(1);
    const dockerLog = readDockerLog(fx);
    expect(dockerLog).toContain("caddy validate");
    expect(dockerLog).not.toContain("caddy reload");
  });

  it("reload failure: exits 1 and restores the live Caddyfile from the backup", () => {
    const fx = makeProvisionFixture({ caddyfile: CADDYFILE_FIXTURE });
    withDockerStub(fx);
    const inoBefore = statSync(fx.caddyfilePath).ino;

    const res = runProvision(fx, { extraEnv: { STUB_FAIL_RELOAD: "1" } });
    expect(res.status, res.stdout + res.stderr).toBe(1);
    expect(res.stderr).toContain("caddy reload failed");
    expect(readFileSync(fx.caddyfilePath, "utf8")).toBe(CADDYFILE_FIXTURE);
    // The restore is in-place too: the container's single-file bind mount
    // must keep seeing the restored content without a restart.
    expect(statSync(fx.caddyfilePath).ino).toBe(inoBefore);
    expect(caddyBackups(fx)).toHaveLength(1);
  });

  it("preset PORTAL_NETWORK: skips discovery and records the given network", () => {
    const fx = makeProvisionFixture({ caddyfile: CADDYFILE_FIXTURE });
    withDockerStub(fx);

    const res = runProvision(fx, { extraEnv: { PORTAL_NETWORK: "custom_net" } });
    expect(res.status, res.stdout + res.stderr).toBe(0);
    expect(readDockerLog(fx)).not.toContain("inspect");
    expect(readFileSync(path.join(fx.root, "opt", "stack", "staging", ".env.staging"), "utf8")).toContain(
      "PORTAL_NETWORK=custom_net"
    );
  });

  it("docker unavailable: warns, records an empty network and installs the block without validation", () => {
    const fx = makeProvisionFixture({ caddyfile: CADDYFILE_FIXTURE });
    // Deliberately no docker stub on PATH.

    const res = runProvision(fx);
    expect(res.status, res.stdout + res.stderr).toBe(0);
    expect(res.stderr).toContain("[warn]");
    expect(readFileSync(path.join(fx.root, "opt", "stack", "staging", ".env.staging"), "utf8")).toMatch(
      /^PORTAL_NETWORK=$/m
    );
    expect(readFileSync(fx.caddyfilePath, "utf8")).toContain(BEGIN_MARKER);
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
// static checks
// ---------------------------------------------------------------------------

describe("provisioning static checks", () => {
  it("provision-server.sh keeps /etc/caddy strictly container-internal", () => {
    const src = readFileSync(PROVISION, "utf8");
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
    expect(src).toContain("image: portal-staging:latest");
    expect(src).toContain("WHATSAPP_DISABLED");
    expect(src).toContain("external: true");
    expect(src).toContain("${PORTAL_NETWORK");
    expect(src).toContain("./portal/data");
    expect(src).not.toContain("portal-web");
  });

  it("deploy/portal/docker-compose.yml matches the live production layout", () => {
    const src = readFileSync(path.join(REPO_ROOT, "deploy", "portal", "docker-compose.yml"), "utf8");
    expect(src).toContain("container_name: caddy");
    expect(src).toContain("image: caddy:2");
    expect(src).toContain("container_name: portal-app");
    expect(src).toContain("portal_net");
    expect(src).toContain("./Caddyfile:/etc/caddy/Caddyfile:ro");
    expect(src).toContain("${PORTAL_IMAGE_TAG:-latest}");
  });

  it("deploy/portal/Caddyfile.example mirrors the live site block", () => {
    const src = readFileSync(path.join(REPO_ROOT, "deploy", "portal", "Caddyfile.example"), "utf8");
    expect(src).toContain("portal.nare.am");
    expect(src).toContain("reverse_proxy portal:3000");
  });

  it("the staging service name cannot collide with the production Caddy upstream host", () => {
    const stagingCompose = readFileSync(path.join(REPO_ROOT, "deploy", "staging", "docker-compose.yml"), "utf8");
    const caddyfile = readFileSync(path.join(REPO_ROOT, "deploy", "portal", "Caddyfile.example"), "utf8");
    // Compose registers each service name as a DNS alias on every network the
    // service joins; staging joins the PRODUCTION network, so a staging
    // service named like the production Caddy upstream would let the live
    // caddy route portal.nare.am traffic to the staging app and database.
    const servicesBlock = stagingCompose.split(/^networks:/m)[0];
    const serviceNames: string[] = [];
    const serviceRe = /^  ([a-z0-9-]+):\s*$/gm;
    for (let m = serviceRe.exec(servicesBlock); m !== null; m = serviceRe.exec(servicesBlock)) {
      serviceNames.push(m[1]);
    }
    expect(serviceNames).toContain("portal-staging");
    const upstreams: string[] = [];
    const upstreamRe = /reverse_proxy\s+([a-z0-9.-]+):\d+/g;
    for (let m = upstreamRe.exec(caddyfile); m !== null; m = upstreamRe.exec(caddyfile)) {
      upstreams.push(m[1]);
    }
    expect(upstreams.length).toBeGreaterThan(0);
    for (const host of upstreams) {
      expect(serviceNames, `staging service name collides with production upstream ${host}`).not.toContain(host);
    }
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
