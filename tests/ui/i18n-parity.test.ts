import { describe, expect, it } from "vitest";
import { en } from "@/lib/i18n/messages/en";
import { hy } from "@/lib/i18n/messages/hy";

function keysOnlyIn(
  source: Record<string, string>,
  target: Record<string, string>,
): string[] {
  return Object.keys(source)
    .filter((key) => !Object.prototype.hasOwnProperty.call(target, key))
    .sort();
}

describe("EN/HY message key parity", () => {
  it("includes every English key in Armenian", () => {
    expect(keysOnlyIn(en, hy), "keys missing from hy.ts").toEqual([]);
  });

  it("includes every Armenian key in English", () => {
    expect(keysOnlyIn(hy, en), "keys missing from en.ts").toEqual([]);
  });

  it("detects a key missing from Armenian", () => {
    expect(keysOnlyIn({ shared: "EN", englishOnly: "EN" }, { shared: "HY" })).toEqual([
      "englishOnly",
    ]);
  });

  it("detects a key missing from English", () => {
    expect(keysOnlyIn({ shared: "HY", armenianOnly: "HY" }, { shared: "EN" })).toEqual([
      "armenianOnly",
    ]);
  });
});
