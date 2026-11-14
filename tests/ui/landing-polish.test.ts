import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Hero } from "@/components/landing/Hero";
import { ServicesSection } from "@/components/landing/ServicesSection";
import { AboutNare } from "@/components/landing/AboutNare";

const HERO_IMAGE_SRC = "/brand/photos/hero-expo-1920.webp";
const HERO_SRCSET = "/brand/photos/hero-expo-960.webp 960w, /brand/photos/hero-expo-1920.webp 1920w";
const FLOOR_CLASSES = "absolute inset-x-0 bottom-0 -z-10 h-1/3 bg-gradient-to-t from-black/80 to-transparent lg:hidden";

function readSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

const heroSource = readSource("components/landing/Hero.tsx");
const servicesSource = readSource("components/landing/ServicesSection.tsx");
const aboutSource = readSource("components/landing/AboutNare.tsx");
const heroHtml = renderToStaticMarkup(createElement(Hero));
const servicesHtml = renderToStaticMarkup(createElement(ServicesSection));
const aboutHtml = renderToStaticMarkup(createElement(AboutNare));

function classTokens(attributes: string): string[] {
  return (/\bclass(?:Name)?\s*=\s*"([^"]*)"/.exec(attributes)?.[1] ?? "")
    .split(/\s+/)
    .filter(Boolean);
}

function tagWithTestId(markup: string, testId: string): string {
  const tags = (markup.match(/<[a-z][a-z0-9]*\b[^>]*>/g) ?? []).filter((tag) =>
    tag.includes(`data-testid="${testId}"`),
  );
  expect(tags, testId).toHaveLength(1);
  return tags[0];
}

function imageWithSrc(markup: string): string {
  const images = (markup.match(/<img\b[^>]*>/g) ?? []).filter((image) =>
    image.includes(`src="${HERO_IMAGE_SRC}"`),
  );
  expect(images).toHaveLength(1);
  return images[0];
}

function expectReadableServiceBody(attributes: string): void {
  const classes = classTokens(attributes);
  expect(classes).toContain("text-base");
  expect(classes.some((token) => /^leading-(?:normal|relaxed|loose)$/.test(token))).toBe(true);
  expect(classes.some((token) => /(?:^|:)(?:truncate|line-clamp(?:-|$))/.test(token))).toBe(false);
}

describe("SP-1 landing polish", () => {
  it("renders the hero panel and About decoration exactly once", () => {
    for (const [source, html, testId] of [
      [heroSource, heroHtml, "hero-text-panel"],
      [aboutSource, aboutHtml, "about-decoration"],
    ]) {
      tagWithTestId(source, testId);
      tagWithTestId(html, testId);
    }
  });

  it("keeps the eager baseline hero image in source and SSR", () => {
    const sourceImage = imageWithSrc(heroSource);
    const renderedImage = imageWithSrc(heroHtml);

    expect(sourceImage).toContain(`srcSet="${HERO_SRCSET}"`);
    expect(sourceImage).toContain('sizes="100vw"');
    expect(sourceImage).toContain("width={1920}");
    expect(sourceImage).toContain("height={1440}");
    expect(sourceImage).toContain('fetchPriority="high"');

    expect(renderedImage).toMatch(new RegExp(`srcSet="${HERO_SRCSET.replace(/[/.]/g, "\\$&")}"`, "i"));
    expect(renderedImage).toMatch(/sizes="100vw"/i);
    expect(renderedImage).toMatch(/width="1920"/i);
    expect(renderedImage).toMatch(/height="1440"/i);
    expect(renderedImage).toMatch(/fetchPriority="high"/i);
    for (const image of [sourceImage, renderedImage]) {
      expect(image).not.toMatch(/\s(?:loading|decoding)\s*=/i);
    }
  });

  it("retains the exact mobile floor gradient", () => {
    expect(heroSource).toContain(`<div aria-hidden="true" className="${FLOOR_CLASSES}" />`);
    expect(heroHtml).toContain(`<div aria-hidden="true" class="${FLOOR_CLASSES}"></div>`);
  });

  it("keeps the hero panel narrow through 1024 px", () => {
    for (const markup of [heroSource, heroHtml]) {
      expect(classTokens(tagWithTestId(markup, "hero-text-panel"))).toEqual(
        expect.arrayContaining(["max-w-md", "md:max-w-sm", "xl:max-w-2xl"]),
      );
    }
  });

  it("keeps all three service bodies readable and every tile interior padded", () => {
    const sourceBodies = Array.from(
      servicesSource.matchAll(/<p\b([^>]*)>\s*\{t\(body\)\}\s*<\/p>/g),
      (match) => match[1],
    );
    expect(sourceBodies).toHaveLength(2);
    sourceBodies.forEach(expectReadableServiceBody);

    const renderedBodies = Array.from(servicesHtml.matchAll(/<p\b([^>]*)>/g), (match) => match[1])
      .filter((attributes) => classTokens(attributes).includes("text-base"));
    expect(renderedBodies).toHaveLength(3);
    renderedBodies.forEach(expectReadableServiceBody);
    expect(servicesSource).not.toMatch(/truncate|line-clamp/);

    const tiles = Array.from(servicesHtml.matchAll(/<li\b([^>]*)>/g), (match) => match[1]);
    expect(tiles).toHaveLength(3);
    for (const attributes of tiles) {
      const basePadding = classTokens(attributes).find((token) => /^p-\d+$/.test(token));
      expect(basePadding).toBeDefined();
      expect(Number(basePadding!.slice(2))).toBeGreaterThanOrEqual(4);
    }
  });

  it("keeps the About image bounded and its decoration anchored inside a padded relative wrapper", () => {
    expect(aboutSource).toContain("max-h-[26rem]");
    expect(aboutHtml).toContain("max-h-[26rem]");

    for (const markup of [aboutSource, aboutHtml]) {
      const decorationClasses = classTokens(tagWithTestId(markup, "about-decoration"));
      expect(decorationClasses).toEqual(expect.arrayContaining(["start-0", "bottom-0"]));
      expect(
        decorationClasses.some((token) => /(?:^|:)(?:-(?:start|bottom)-|(?:start|bottom)-\[-)/.test(token)),
      ).toBe(false);

      const wrapper = /<div\b([^>]*)>\s*<div\b(?=[^>]*data-testid="about-decoration")[^>]*>/.exec(markup);
      expect(wrapper).not.toBeNull();
      expect(classTokens(wrapper![1])).toEqual(expect.arrayContaining(["relative", "p-4"]));
    }
  });

  it("uses no inline styles or raw colours in the three component sources", () => {
    const hexColour = /#[0-9a-fA-F]{3,8}\b/;
    const paletteUtility =
      /\b(?:bg|text|border|ring|from|via|to)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d/;

    for (const [file, source] of [
      ["components/landing/Hero.tsx", heroSource],
      ["components/landing/ServicesSection.tsx", servicesSource],
      ["components/landing/AboutNare.tsx", aboutSource],
    ]) {
      expect(source, file).not.toMatch(/\bstyle\s*=/);
      expect(source, file).not.toMatch(hexColour);
      expect(source, file).not.toMatch(paletteUtility);
    }
  });
});
