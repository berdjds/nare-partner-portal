import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  join(process.cwd(), ".github/workflows/ci-cd.yml"),
  "utf8",
);

function extractBlock(source: string, key: string, indent = ""): string {
  const match = source.match(
    new RegExp(
      `^${indent}${key}:\\n([\\s\\S]*?)(?=^${indent}\\S|(?![\\s\\S]))`,
      "m",
    ),
  );

  if (!match) {
    throw new Error(`Missing workflow section: ${key}`);
  }

  return match[1];
}

const onBlock = extractBlock(workflow, "on");
const pushBlock = extractBlock(onBlock, "push", "  ");
const pullRequestBlock = extractBlock(onBlock, "pull_request", "  ");
const jobsBlock = extractBlock(workflow, "jobs");

describe("CI documentation paths", () => {
  it("ignores only documentation changes on pushes to main", () => {
    expect(pushBlock.trimEnd()).toBe(
      "    branches: [main]\n    paths-ignore:\n      - doc/**",
    );
  });

  it("does not filter pull request paths", () => {
    expect(pullRequestBlock).not.toMatch(/^    paths(?:-ignore)?:/m);
  });

  it("keeps manual workflow dispatch", () => {
    expect(onBlock).toMatch(/^  workflow_dispatch:$/m);
  });

  it.each([
    "deploy-staging",
    "smoke-staging",
    "deploy-production",
    "smoke-production",
  ])("keeps the %s job", (job) => {
    expect(jobsBlock).toMatch(new RegExp(`^  ${job}:$`, "m"));
  });
});
