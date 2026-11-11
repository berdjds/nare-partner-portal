import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync("components/travel/SettingsPanel.tsx", "utf8");

describe("SettingsPanel accessible names (Phase 5 audit)", () => {
  it("names the WhatsApp account select/input and the colour picker", () => {
    expect(src).toMatch(/<SelectTrigger aria-label="Travel WhatsApp account">/);
    expect(src).toMatch(/<Input aria-label="Travel WhatsApp account"/);
    expect(src).toMatch(/type="color"\s+aria-label="Brand color picker"/);
  });
});

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".tsx") ? [p] : [];
  });
}

describe("every Select trigger has an accessible name", () => {
  it("each <SelectTrigger> carries aria-label or id (label htmlFor)", () => {
    const bad: string[] = [];
    for (const f of [...walk("components"), ...walk("app")]) {
      if (f.endsWith("ui/select.tsx")) continue;
      const tags = readFileSync(f, "utf8").match(/<SelectTrigger\b[^>]*>/g) ?? [];
      for (const t of tags) if (!/aria-label|aria-labelledby|\bid=/.test(t)) bad.push(f);
    }
    expect(bad).toEqual([]);
  });
});

describe("Settings label associations", () => {
  it("each Settings text field is tied to its visible label with htmlFor/id", () => {
    const labels = Array.from(src.matchAll(/<Label htmlFor="(settings-[a-z0-9-]+)">/g), (m) => m[1]);
    expect(labels.length).toBeGreaterThanOrEqual(7);
    expect(new Set(labels).size).toBe(labels.length);
    for (const id of labels) expect(src).toContain(`id="${id}"`);
  });
});
