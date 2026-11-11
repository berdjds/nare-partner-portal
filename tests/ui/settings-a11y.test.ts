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
