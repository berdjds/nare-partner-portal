/**
 * Workflow tests (W3b, task ci-pipeline) for .github/workflows/ci-cd.yml.
 *
 * The portal.nare.am release pipeline: pull requests and pushes run the test
 * job only; a push to main runs deploy staging -> smoke staging -> deploy
 * production -> smoke production through the server's forced-command
 * dispatcher (upload <name>, deploy <env> <tarball>, smoke <env>);
 * workflow_dispatch runs staging-only drills. These tests parse the workflow
 * YAML and pin the security-relevant structure:
 *
 *   - no ssh-keyscan anywhere; ~/.ssh/known_hosts is written from the pinned
 *     DEPLOY_KNOWN_HOSTS secret;
 *   - the production deploy needs the staging smoke job, so a failed staging
 *     smoke blocks anything from touching production;
 *   - deploy/smoke jobs run only for pushes to main, and pull requests still
 *     execute the test job only;
 *   - drills are offered only as drill-rollback | drill-restore and can
 *     never target production;
 *   - secrets are referenced only through env mappings — never interpolated
 *     into run scripts and never echoed to the log.
 */

import { createRequire } from "module";
import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

// js-yaml is pinned via package.json `overrides` and installed in
// node_modules, but ships no type declarations — require it through a
// narrow local signature instead of a typed import.
const require = createRequire(import.meta.url);
const yaml = require("js-yaml") as { load(text: string): unknown };

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const WORKFLOW_PATH = path.join(REPO_ROOT, ".github", "workflows", "ci-cd.yml");
const raw = readFileSync(WORKFLOW_PATH, "utf8");

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, unknown>;
}

interface Job {
  needs?: string | string[];
  if?: string;
  env?: Record<string, unknown>;
  steps?: Step[];
}

const doc = yaml.load(raw) as { jobs?: Record<string, Job> } & Record<string, any>;
// YAML 1.1 parsers read the `on:` key as boolean true; tolerate both.
const on = (doc.on ?? doc["true"]) as Record<string, any>;
const jobs = doc.jobs ?? {};

const DEPLOY_JOBS = ["deploy-staging", "smoke-staging", "deploy-production", "smoke-production"];

function needsOf(job: Job | undefined): string[] {
  if (!job || job.needs === undefined) return [];
  return Array.isArray(job.needs) ? job.needs : [job.needs];
}

function runScripts(job: Job | undefined): string[] {
  return (job?.steps ?? [])
    .map((step) => step.run)
    .filter((run): run is string => typeof run === "string");
}

function mentionsVar(line: string, name: string): boolean {
  return new RegExp(`\\$\\{?${name}\\}?`).test(line);
}

describe("workflow triggers", () => {
  it("is valid YAML with the expected jobs", () => {
    for (const name of ["test", ...DEPLOY_JOBS, "drill"]) {
      expect(jobs[name], name).toBeDefined();
    }
  });

  it("runs on pushes and pull requests to main", () => {
    expect(on.push?.branches).toContain("main");
    expect(on.pull_request?.branches).toContain("main");
  });

  it("pull requests execute the test job only", () => {
    const testIf = String(jobs.test?.if ?? "");
    // The test job's condition must not exclude pull requests.
    expect(testIf).not.toContain("pull_request");
    expect(testIf).not.toContain("refs/heads/main");
    // Every other job is gated on push-to-main or on workflow_dispatch.
    for (const [name, job] of Object.entries(jobs)) {
      if (name === "test") continue;
      const cond = String(job.if ?? "");
      const prSafe =
        cond.includes("github.event_name == 'push'") ||
        cond.includes("github.event_name == 'workflow_dispatch'");
      expect(prSafe, `${name} must not run on pull_request`).toBe(true);
    }
  });

  it("serializes deployments in a single concurrency group", () => {
    expect(String(doc.concurrency?.group)).toContain("deploy-main");
  });
});

describe("release chain", () => {
  it("deploys staging, smokes staging, then deploys and smokes production", () => {
    expect(needsOf(jobs["deploy-staging"])).toContain("test");
    expect(needsOf(jobs["smoke-staging"])).toContain("deploy-staging");
    // The production deploy is gated on staging smoke success.
    expect(needsOf(jobs["deploy-production"])).toContain("smoke-staging");
    expect(needsOf(jobs["smoke-production"])).toContain("deploy-production");
  });

  it("runs deploy and smoke jobs only for pushes to main", () => {
    for (const name of DEPLOY_JOBS) {
      const cond = String(jobs[name]?.if ?? "");
      expect(cond, name).toContain("github.event_name == 'push'");
      expect(cond, name).toContain("refs/heads/main");
    }
  });

  it("streams the source tarball to the dispatcher's upload command", () => {
    // scp/sftp cannot pass the forced command (the dispatcher rejects their
    // SSH_ORIGINAL_COMMAND), so the tarball must go over ssh stdin to the
    // dispatcher's `upload` command — this is what makes the deploy able to
    // resolve the bare tarball name from the upload dir afterwards.
    for (const name of ["deploy-staging", "deploy-production"]) {
      const scripts = runScripts(jobs[name]).join("\n");
      expect(scripts, name).toContain(
        'ssh -i ~/.ssh/deploy_key "${DEPLOY_USER}@${DEPLOY_HOST}" "upload portal-source.tar.gz" < "$RUNNER_TEMP/portal-source.tar.gz"'
      );
      expect(scripts, name).not.toMatch(/^\s*scp\s/m);
      expect(scripts, name).not.toMatch(/^\s*sftp\s/m);
    }
  });

  it("calls the forced-command interface for deploys and server-side smokes", () => {
    expect(runScripts(jobs["deploy-staging"]).join("\n")).toContain('"deploy staging portal-source.tar.gz"');
    expect(runScripts(jobs["smoke-staging"]).join("\n")).toContain('"smoke staging"');
    expect(runScripts(jobs["deploy-production"]).join("\n")).toContain('"deploy production portal-source.tar.gz"');
    expect(runScripts(jobs["smoke-production"]).join("\n")).toContain('"smoke production"');
  });

  it("runs the repository smoke script from the checkout against the URL variables", () => {
    expect(runScripts(jobs["smoke-staging"]).join("\n")).toContain('bash scripts/smoke-test.sh "$STAGING_URL"');
    expect(runScripts(jobs["smoke-production"]).join("\n")).toContain('bash scripts/smoke-test.sh "$PORTAL_URL"');
    expect(String(jobs["smoke-staging"]?.env?.STAGING_URL)).toContain("vars.STAGING_URL");
    expect(String(jobs["smoke-production"]?.env?.PORTAL_URL)).toContain("vars.PORTAL_URL");
  });
});

describe("SSH authentication", () => {
  it("never uses ssh-keyscan", () => {
    expect(raw).not.toContain("ssh-keyscan");
  });

  it("writes the deploy key and known_hosts from pinned secrets", () => {
    let installers = 0;
    for (const [name, job] of Object.entries(jobs)) {
      const scripts = runScripts(job).join("\n");
      if (!scripts.includes("~/.ssh/known_hosts")) continue;
      installers += 1;
      expect(String(job.env?.DEPLOY_SSH_KEY), name).toBe("${{ secrets.DEPLOY_SSH_KEY }}");
      expect(String(job.env?.DEPLOY_KNOWN_HOSTS), name).toBe("${{ secrets.DEPLOY_KNOWN_HOSTS }}");
      expect(scripts, name).toContain("printf '%s\\n' \"$DEPLOY_SSH_KEY\" > ~/.ssh/deploy_key");
      expect(scripts, name).toContain("printf '%s\\n' \"$DEPLOY_KNOWN_HOSTS\" > ~/.ssh/known_hosts");
    }
    // The four deploy/smoke jobs plus the drill job all install the key.
    expect(installers).toBe(DEPLOY_JOBS.length + 1);
  });
});

describe("staging drills", () => {
  it("offers only drill-rollback and drill-restore as the workflow_dispatch action", () => {
    const action = on.workflow_dispatch?.inputs?.action;
    expect(action?.required).toBe(true);
    expect(action?.type).toBe("choice");
    expect(action?.options).toEqual(["drill-rollback", "drill-restore"]);
  });

  it("runs drills only on workflow_dispatch and can never target production", () => {
    const drill = jobs.drill;
    expect(drill).toBeDefined();
    expect(String(drill?.if)).toContain("github.event_name == 'workflow_dispatch'");
    const scripts = runScripts(drill).join("\n");
    // The action reaches the ssh command through an env var, and no drill
    // step can name production — the only production restore path
    // (`restore --production`) appears nowhere in the workflow.
    expect(String(drill?.env?.DRILL_ACTION)).toContain("inputs.action");
    expect(scripts).toContain('"$DRILL_ACTION"');
    expect(scripts).not.toContain("production");
    expect(raw).not.toContain("restore --production");
  });
});

describe("secret handling", () => {
  it("references secrets only through env mappings, never inside run scripts", () => {
    for (const [name, job] of Object.entries(jobs)) {
      for (const script of runScripts(job)) {
        expect(script, name).not.toContain("${{ secrets.");
      }
    }
  });

  it("never echoes secret values to the log", () => {
    // Secret material (key, host key) may only be written to files via
    // printf redirection; no echo of any secret-bearing variable anywhere.
    const secretMaterial = ["DEPLOY_SSH_KEY", "DEPLOY_KNOWN_HOSTS"];
    const secretVars = [...secretMaterial, "DEPLOY_HOST", "DEPLOY_USER"];
    for (const [name, job] of Object.entries(jobs)) {
      for (const script of runScripts(job)) {
        for (const line of script.split("\n")) {
          for (const v of secretMaterial) {
            if (!mentionsVar(line, v)) continue;
            expect(line.trim().startsWith("printf"), `${name}: ${line}`).toBe(true);
            expect(line, `${name}: ${line}`).toContain(">");
          }
          if (/(^|\s)echo\s/.test(line)) {
            for (const v of secretVars) {
              expect(mentionsVar(line, v), `${name}: ${line}`).toBe(false);
            }
          }
        }
      }
    }
  });
});
