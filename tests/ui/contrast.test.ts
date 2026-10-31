import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";

type Hsl = [number, number, number];
type Srgb = [number, number, number];

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const globalsCss = readFileSync(path.join(REPO_ROOT, "app/globals.css"), "utf8");

function tokenValue(token: string): string {
  const match = globalsCss.match(new RegExp(`${token}:\\s*([^;]+);`));
  if (!match) throw new Error(`Token ${token} not declared in app/globals.css`);
  return match[1].trim();
}

function parseHsl(value: string): Hsl {
  const match = value.match(/^(-?\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%$/);
  if (!match) throw new Error(`Invalid HSL value: ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function hslToken(token: string): Hsl {
  return parseHsl(tokenValue(token));
}

function hslToSrgb([hue, saturation, lightness]: Hsl): Srgb {
  const s = saturation / 100;
  const l = lightness / 100;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const h = (((hue % 360) + 360) % 360) / 60;
  const x = chroma * (1 - Math.abs((h % 2) - 1));

  let rgb: Srgb;
  if (h < 1) rgb = [chroma, x, 0];
  else if (h < 2) rgb = [x, chroma, 0];
  else if (h < 3) rgb = [0, chroma, x];
  else if (h < 4) rgb = [0, x, chroma];
  else if (h < 5) rgb = [x, 0, chroma];
  else rgb = [chroma, 0, x];

  const m = l - chroma / 2;
  return [rgb[0] + m, rgb[1] + m, rgb[2] + m];
}

function relativeLuminance([red, green, blue]: Srgb): number {
  const linearize = (channel: number): number =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;

  return 0.2126 * linearize(red) + 0.7152 * linearize(green) + 0.0722 * linearize(blue);
}

function contrastRatio(foreground: Hsl, background: Hsl): number {
  const foregroundLuminance = relativeLuminance(hslToSrgb(foreground));
  const backgroundLuminance = relativeLuminance(hslToSrgb(background));
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

const contrastCases: ReadonlyArray<readonly [string, string, string]> = [
  ["--primary on --background", "--primary", "--background"],
  ["--primary on --muted", "--primary", "--muted"],
  ["--primary on --card", "--primary", "--card"],
  ["--primary on --sidebar-background", "--primary", "--sidebar-background"],
  ["--primary-foreground on --primary", "--primary-foreground", "--primary"],
  ["--primary-foreground on --gradient-end", "--primary-foreground", "--gradient-end"],
  ["--muted-foreground on --background", "--muted-foreground", "--background"],
  ["--muted-foreground on --muted", "--muted-foreground", "--muted"],
  ["--muted-foreground on --card", "--muted-foreground", "--card"],
  ["--foreground on --background", "--foreground", "--background"],
];

describe("WCAG color contrast", () => {
  for (const [label, foregroundToken, backgroundToken] of contrastCases) {
    it(`${label} has contrast of at least 4.5:1`, () => {
      expect(contrastRatio(hslToken(foregroundToken), hslToken(backgroundToken))).toBeGreaterThanOrEqual(4.5);
    });
  }

  it("preserves the 203 89% 40% on 0 0% 93% contrast regression", () => {
    expect(contrastRatio(parseHsl("203 89% 40%"), parseHsl("0 0% 93%"))).toBeCloseTo(3.88, 1);
  });
});
