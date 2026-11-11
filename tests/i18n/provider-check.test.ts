import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { deepSeekProvider, getTranslationProvider } from "@/lib/i18n/provider";

describe("translation provider configuration", () => {
  it("is disabled without both the provider name and the key", () => {
    expect(getTranslationProvider({})).toBeNull();
    expect(getTranslationProvider({ TRANSLATION_PROVIDER: "deepseek" })).toBeNull();
    expect(getTranslationProvider({ DEEPSEEK_API_KEY: "k" })).toBeNull();
    expect(getTranslationProvider({ TRANSLATION_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "k" })?.id).toBe("deepseek:deepseek-chat");
  });
  it("sends only the fixed instruction and the text, and a failure surfaces without the key", async () => {
    let body = "";
    const ok = deepSeekProvider("SECRET-KEY-123", (async (_u: any, init: any) => { body = init.body; return new Response(JSON.stringify({ choices: [{ message: { content: "Բարի գալուստ" } }] })); }) as any);
    expect(await ok.translate("Welcome", "hy")).toBe("Բարի գալուստ");
    expect(body).not.toContain("SECRET-KEY-123");
    const bad = deepSeekProvider("SECRET-KEY-123", (async () => new Response("no", { status: 401 })) as any);
    await expect(bad.translate("Welcome", "hy")).rejects.toThrow(/provider status 401/);
    await bad.translate("Welcome", "hy").catch((e) => expect(String(e)).not.toContain("SECRET-KEY-123"));
  });
  it("the check script never prints the key", () => {
    const src = readFileSync("scripts/check-translation-provider.ts", "utf8");
    expect(src).not.toMatch(/console\.log\([^)]*process\.env\.DEEPSEEK_API_KEY[^)]*\)/);
  });
});
