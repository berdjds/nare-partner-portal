import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  join(process.cwd(), ".github/workflows/ci-cd.yml"),
  "utf8",
);

function extractJob(name: string): string {
  const match = workflow.match(
    new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [A-Za-z0-9_-]+:|(?![\\s\\S]))`, "m"),
  );
  expect(match, `missing workflow job ${name}`).not.toBeNull();
  return match?.[0] ?? "";
}

const devJob = extractJob("deploy-dev-manual");

describe("manual dev deployment workflow", () => {
  it("offers deploy-dev as a workflow_dispatch choice", () => {
    expect(workflow).toMatch(/^  workflow_dispatch:$/m);
    expect(workflow).toMatch(/^          - deploy-dev$/m);
  });

  it("runs deploy-dev-manual only for workflow_dispatch with the deploy-dev action", () => {
    expect(devJob).toMatch(
      /^    if: github\.event_name == 'workflow_dispatch' && inputs\.action == 'deploy-dev'$/m,
    );
    expect(devJob).not.toContain("github.event_name == 'push'");
    expect(devJob).not.toContain("github.event_name == 'pull_request'");
  });

  it("packages and uploads the dispatched ref, then deploys and smokes dev", () => {
    expect(devJob).toContain("- uses: actions/checkout@v4");
    expect(devJob).toContain('-czf "$RUNNER_TEMP/portal-source.tar.gz" .');
    expect(devJob).toContain(
      'ssh -i ~/.ssh/deploy_key "${DEPLOY_USER}@${DEPLOY_HOST}" "upload portal-source.tar.gz" < "$RUNNER_TEMP/portal-source.tar.gz"',
    );
    expect(devJob).toContain(
      'ssh -i ~/.ssh/deploy_key "${DEPLOY_USER}@${DEPLOY_HOST}" "deploy dev portal-source.tar.gz"',
    );
    expect(devJob).toContain(
      'ssh -i ~/.ssh/deploy_key "${DEPLOY_USER}@${DEPLOY_HOST}" "smoke dev"',
    );
    expect(devJob).toContain(
      'run: bash scripts/smoke-test.sh "https://dev.portal.nare.am"',
    );
  });

  it("does not deploy or smoke staging or production from the dev job", () => {
    expect(devJob).not.toContain('"deploy staging ');
    expect(devJob).not.toContain('"deploy production ');
    expect(devJob).not.toContain('"smoke staging"');
    expect(devJob).not.toContain('"smoke production"');
  });

  it("keeps the production jobs on the main-push release chain", () => {
    const deployProduction = extractJob("deploy-production");
    const smokeProduction = extractJob("smoke-production");
    expect(deployProduction).toMatch(/^    needs: smoke-staging$/m);
    expect(smokeProduction).toMatch(/^    needs: deploy-production$/m);
    for (const job of [deployProduction, smokeProduction]) {
      expect(job).toMatch(
        /^    if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'$/m,
      );
      expect(job).not.toContain("workflow_dispatch");
      expect(job).not.toContain("deploy dev");
    }
  });
});
