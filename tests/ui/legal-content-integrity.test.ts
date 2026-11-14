import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function readSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

describe("legal content integrity", () => {
  it("matches the ac4e78d legal text byte for byte after removing the added ids", () => {
    const current = readSource("lib/legal-content.ts");
    const baseline = readSource("tests/ui/fixtures/legal-content.ac4e78d.txt");
    const withoutIds = current
      .replace(/^[ \t]*id: "[^"]+",\r?\n/gm, "")
      .replace(/^[ \t]*readonly id: string;\r?\n/gm, "");

    expect(withoutIds).not.toBe(current);
    expect(withoutIds).toBe(baseline);
  });
});
