/** Phase 5: favicon and app icons come from the authoritative Nare icon, in the sizes browsers and devices ask for. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const file = (p: string) => path.join(root, p);
/** SHA-256 of staging.nare.am's public/logo/nare-icon.webp, verified identical to the portal copy (2026-11-10). */
const AUTHORITATIVE_ICON_SHA256 = "b240d0932429a2d7bdc93de1cc729067ff7aa888c90242dea40cadeda675a50b";
const png = (p: string) => { const b = readFileSync(file(p)); expect(b.subarray(1, 4).toString()).toBe("PNG"); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; };

describe("brand icons", () => {
  it("the source icon is byte-identical to the one staging.nare.am uses", () => {
    expect(createHash("sha256").update(readFileSync(file("public/brand/nare-icon.webp"))).digest("hex")).toBe(AUTHORITATIVE_ICON_SHA256);
  });
  it("derived PNGs exist at 32, 180, 192 and 512 px and are square", () => {
    for (const [p, n] of [["public/brand/icon-32.png", 32], ["public/brand/apple-touch-icon.png", 180], ["public/brand/icon-192.png", 192], ["public/brand/icon-512.png", 512]] as const) expect(png(p)).toEqual({ w: n, h: n });
  });
  it("app/favicon.ico is a valid ICO holding a 32 px image", () => {
    const b = readFileSync(file("app/favicon.ico"));
    expect(b.readUInt16LE(0)).toBe(0); expect(b.readUInt16LE(2)).toBe(1); expect(b.readUInt16LE(4)).toBe(1);
    expect(b[6]).toBe(32);
    const size = b.readUInt32LE(14), offset = b.readUInt32LE(18);
    expect(b.subarray(offset, offset + 4).toString("latin1")).toBe("\x89PNG");
    expect(offset + size).toBe(b.length);
  });
  it("the theme colour hex equals the --primary token (203 89% 35%)", async () => {
    const { BRAND_THEME_COLOR } = await import("@/lib/brand");
    const css = readFileSync(file("app/globals.css"), "utf8");
    expect(css).toContain("--primary: 203 89% 35%");
    const [h, s, l] = [203 / 360, 0.89, 0.35];
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    const f = (t: number) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
    const hex = [f(h + 1 / 3), f(h), f(h - 1 / 3)].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
    expect(BRAND_THEME_COLOR).toBe(`#${hex}`);
  });
  it("the root layout declares the icons, the theme colour and the manifest lists the install icons", () => {
    const layout = readFileSync(file("app/layout.tsx"), "utf8");
    for (const s of ["/brand/icon-32.png", "/brand/nare-icon.webp", "/brand/apple-touch-icon.png", "themeColor: BRAND_THEME_COLOR"]) expect(layout, s).toContain(s);
    const manifest = readFileSync(file("app/manifest.ts"), "utf8");
    for (const s of ["/brand/icon-192.png", "/brand/icon-512.png", "Nare Travel and Tours"]) expect(manifest, s).toContain(s);
    expect(existsSync(file("scripts/gen-brand-icons.mjs"))).toBe(true);
  });
});

describe("RTL readiness (Phase 5)", () => {
  it("no component or page uses a physical left/right utility; only logical ones (ps/pe/ms/me/start/end/text-start/text-end)", async () => {
    const { readdirSync, statSync } = await import("node:fs");
    const hits: string[] = [];
    const physical = /(?<![\w/])-?(?:pl|pr|ml|mr|left|right)-(?!1\/2\b|\[50%\])|(?<![\w-])(?:text-left|text-right|border-l|border-r|rounded-l|rounded-r)(?![\w-])/;
    (function walk(d: string) {
      for (const n of readdirSync(file(d))) {
        const rel = `${d}/${n}`;
        if (statSync(file(rel)).isDirectory()) walk(rel);
        else if (rel.endsWith(".tsx")) readFileSync(file(rel), "utf8").split("\n").forEach((line, i) => { if (/className|cn\(|["'`][^"'`]*-[a-z]/.test(line) && physical.test(line)) hits.push(`${rel}:${i + 1}`); });
      }
    })("app"); (function walk(d: string) {
      for (const n of readdirSync(file(d))) {
        const rel = `${d}/${n}`;
        if (statSync(file(rel)).isDirectory()) walk(rel);
        else if (rel.endsWith(".tsx")) readFileSync(file(rel), "utf8").split("\n").forEach((line, i) => { if (physical.test(line)) hits.push(`${rel}:${i + 1}`); });
      }
    })("components");
    expect(Array.from(new Set(hits))).toEqual([]);
  });
});
