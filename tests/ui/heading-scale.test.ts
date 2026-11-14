import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LegalPage } from "@/components/public/LegalPage";
import { TERMS_OF_USE } from "@/lib/legal-content";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

function sourceFiles(relativeDir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(path.join(REPO_ROOT, relativeDir), { withFileTypes: true })) {
    const relativePath = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) files.push(...sourceFiles(relativePath));
    else if (/\.(?:css|jsx?|tsx?)$/.test(entry.name)) files.push(relativePath);
  }
  return files.sort();
}

function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function compact(source: string): string {
  return source.replace(/\s+/g, "");
}

function occurrenceCount(source: string, value: string): number {
  return source.split(value).length - 1;
}

interface CssRule {
  selector: string;
  declarations: Map<string, string[]>;
  atRules: string[];
}

function declarationsOf(body: string): Map<string, string[]> {
  const declarations = new Map<string, string[]>();
  for (const item of body.split(";")) {
    const colon = item.indexOf(":");
    if (colon === -1) continue;
    const property = item.slice(0, colon).trim();
    if (!property || property.startsWith("@")) continue;
    const value = item.slice(colon + 1).trim().replace(/\s+/g, " ");
    declarations.set(property, [...(declarations.get(property) ?? []), value]);
  }
  return declarations;
}

/** Extracts leaf rules, including rules nested in layers/media/supports blocks. */
function parseCssRules(css: string): CssRule[] {
  const rules: CssRule[] = [];

  function visit(block: string, atRules: string[]): void {
    let cursor = 0;
    while (cursor < block.length) {
      const open = block.indexOf("{", cursor);
      if (open === -1) return;

      const preludeStart = Math.max(
        block.lastIndexOf("}", open - 1),
        block.lastIndexOf(";", open - 1),
      ) + 1;
      const prelude = block.slice(preludeStart, open).trim().replace(/\s+/g, " ");

      let depth = 1;
      let end = open + 1;
      while (end < block.length && depth > 0) {
        if (block[end] === "{") depth += 1;
        else if (block[end] === "}") depth -= 1;
        end += 1;
      }
      expect(depth, `unbalanced CSS block beginning with ${prelude}`).toBe(0);

      const body = block.slice(open + 1, end - 1);
      if (/^@(layer|media|supports)\b/.test(prelude)) {
        visit(body, [...atRules, prelude]);
      } else if (prelude && !prelude.startsWith("@")) {
        rules.push({ selector: prelude, declarations: declarationsOf(body), atRules });
      }
      cursor = end;
    }
  }

  visit(withoutComments(css), []);
  return rules;
}

function onlyRule(rules: CssRule[], selector: string): CssRule {
  const matches = rules.filter((rule) => rule.selector === selector);
  expect(matches, `expected exactly one ${selector} rule`).toHaveLength(1);
  return matches[0];
}

function expectDeclaration(rule: CssRule, property: string, value: string): void {
  expect(rule.declarations.get(property), `${rule.selector} { ${property} }`).toEqual([value]);
}

function classTokens(value: string): string[] {
  return value.split(/\s+/).filter(Boolean);
}

function jsxClasses(attributes: string): string[] | null {
  const className = /\bclassName\s*=\s*"([^"]*)"/.exec(attributes)?.[1];
  return className === undefined ? null : classTokens(className);
}

function htmlClasses(attributes: string): string[] {
  return classTokens(/\bclass="([^"]*)"/.exec(attributes)?.[1] ?? "");
}

function baseUtility(token: string): string {
  return token.slice(token.lastIndexOf(":") + 1);
}

function sizeUtilities(classes: string[]): string[] {
  return classes.filter((token) =>
    /^text-(?:xs|sm|base|lg|xl|[2-9]xl|\[[^\]]+\])$/.test(baseUtility(token)),
  );
}

function weightUtilities(classes: string[]): string[] {
  return classes.filter((token) =>
    /^font-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black|\[[^\]]+\])$/.test(
      baseUtility(token),
    ),
  );
}

function literalHeadings(source: string): { tag: string; attributes: string }[] {
  return Array.from(source.matchAll(/<(h[123])\b([^>]*)>/g), (match) => ({
    tag: match[1],
    attributes: match[2],
  }));
}

function sectionId(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

const globals = readRepoFile("app/globals.css");
const cssRules = parseCssRules(globals);
const headingScales = {
  "--h1-size": "clamp(2rem, 4vw, 3rem)",
  "--h2-size": "clamp(2.1rem, 4.6vw, 4rem)",
  "--h3-size": "clamp(1.25rem, 2vw, 1.5rem)",
} as const;

const OWNED_HEADING_FILES = [
  "components/public/LegalPage.tsx",
  "app/login/page.tsx",
  "app/forgot-password/page.tsx",
  "app/reset-password/page.tsx",
  "app/partners/apply/page.tsx",
  "components/partners/ApplyWizard.tsx",
  "components/partners/ApplyForm.tsx",
  "components/landing/Hero.tsx",
  "components/landing/ServicesSection.tsx",
  "components/landing/AboutNare.tsx",
] as const;

const LEGACY_CLAMP_FILES = new Set([
  "components/landing/HowItWorks.tsx",
  "components/landing/Benefits.tsx",
  "components/landing/ContactBlock.tsx",
]);

describe("FR-UX-005 shared heading scale", () => {
  it("declares each normalized scale once on an unlayered root and nowhere new in app/components", () => {
    const unlayeredRoots = cssRules.filter(
      (rule) => rule.selector === ":root" && rule.atRules.length === 0,
    );
    expect(unlayeredRoots).toHaveLength(1);

    const globalsWithoutComments = compact(withoutComments(globals));
    const applicationFiles = [...sourceFiles("app"), ...sourceFiles("components")].filter(
      (file) => file !== "app/globals.css" && !LEGACY_CLAMP_FILES.has(file),
    );

    for (const [token, value] of Object.entries(headingScales)) {
      expectDeclaration(unlayeredRoots[0], token, value);
      expect(occurrenceCount(globalsWithoutComments, compact(value)), token).toBe(1);

      const unexpected = applicationFiles.filter((file) =>
        compact(readRepoFile(file)).includes(compact(value)),
      );
      expect(unexpected, `${value} must come from ${token}`).toEqual([]);
    }
  });

  it("uses exactly the six local font files and no HTTP font origin", () => {
    const fontFaces = Array.from(withoutComments(globals).matchAll(/@font-face\s*\{([^{}]*)\}/g));
    const sources = fontFaces.flatMap((face) =>
      Array.from(face[1].matchAll(/\bsrc\s*:\s*([^;]+)/g), (match) => match[1]),
    );
    const urls = sources.flatMap((source) =>
      Array.from(source.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/g), (match) => match[1]),
    );

    expect(fontFaces).toHaveLength(6);
    expect(urls.sort()).toEqual([
      "/fonts/fraunces-latin-ext.woff2",
      "/fonts/fraunces-latin.woff2",
      "/fonts/inter-latin-ext.woff2",
      "/fonts/inter-latin.woff2",
      "/fonts/noto-sans-armenian.woff2",
      "/fonts/noto-serif-armenian.woff2",
    ]);
    expect(globals).not.toMatch(/url\(\s*["']?https?:\/\//i);
    expect(globals).not.toMatch(/@import\s+(?:url\()?\s*["']?https?:\/\//i);
  });

  it("parses the exact heading selectors, exclusions, legal exception, Benefits scale and HY rules", () => {
    const expectedRules = [
      ["h1.font-display:not(.hero-h1)", "--h1-size"],
      ["h2.font-display:not(.legal-h2)", "--h2-size"],
      ["h3.font-display", "--h3-size"],
    ] as const;

    for (const [selector, token] of expectedRules) {
      const rule = onlyRule(cssRules, selector);
      expectDeclaration(rule, "font-size", `var(${token})`);
      expectDeclaration(rule, "font-weight", "600");
    }

    const legal = onlyRule(cssRules, "h2.font-display.legal-h2");
    expectDeclaration(legal, "font-size", "var(--h3-size)");

    const benefits = onlyRule(cssRules, "h2#benefits-heading");
    expectDeclaration(benefits, "font-family", "var(--font-display-stack)");
    expectDeclaration(benefits, "font-size", "var(--h2-size)");
    expectDeclaration(benefits, "font-weight", "600");

    const armenianDisplay = onlyRule(cssRules, "html:lang(hy) .font-display");
    expectDeclaration(armenianDisplay, "font-family", "var(--font-display-hy-stack)");
    const armenianBenefits = onlyRule(cssRules, "html:lang(hy) h2#benefits-heading");
    expectDeclaration(armenianBenefits, "font-family", "var(--font-display-hy-stack)");
  });

  it("removes literal heading size and weight utilities while requiring font-display", () => {
    const headings = OWNED_HEADING_FILES.flatMap((file) =>
      literalHeadings(readRepoFile(file)).map((heading) => ({ file, ...heading })),
    );
    expect(headings.length).toBeGreaterThan(0);

    for (const heading of headings) {
      const context = `${heading.file} <${heading.tag}>`;
      const classes = jsxClasses(heading.attributes);
      expect(classes, `${context} needs a literal className`).not.toBeNull();
      if (classes === null) continue;

      expect(classes, context).toContain("font-display");
      expect(weightUtilities(classes), context).toEqual([]);
      if (!classes.includes("hero-h1")) {
        expect(sizeUtilities(classes), context).toEqual([]);
      }
    }
  });

  it("does not pass a size or weight override to login's shared CardTitle h3", () => {
    const titles = Array.from(readRepoFile("app/login/page.tsx").matchAll(/<CardTitle\b([^>]*)>/g));
    expect(titles).toHaveLength(1);
    const classes = jsxClasses(titles[0][1]) ?? [];
    expect(sizeUtilities(classes)).toEqual([]);
    expect(weightUtilities(classes)).toEqual([]);
  });

  it("renders legal navigation with a non-heading label and legal-h2 on every document h2", () => {
    const html = renderToStaticMarkup(createElement(LegalPage, { document: TERMS_OF_USE }));
    expect(html).not.toMatch(/<h2\b[^>]*>\s*On this page\s*<\/h2>/);

    const nav = /<nav\b[^>]*\baria-labelledby="legal-toc-heading"[^>]*>[\s\S]*?<\/nav>/.exec(html);
    expect(nav).not.toBeNull();
    expect(nav![0]).toContain('id="legal-toc-heading"');

    const label = /<([a-z][a-z0-9]*)\b[^>]*\bid="legal-toc-heading"[^>]*>([\s\S]*?)<\/\1>/.exec(html);
    expect(label?.[1]).toBe("p");
    expect(label?.[2]).toContain("On this page");

    const h2Attributes = Array.from(html.matchAll(/<h2\b([^>]*)>/g), (match) => match[1]);
    expect(h2Attributes).toHaveLength(TERMS_OF_USE.sections.length + 1);
    for (const attributes of h2Attributes) {
      expect(htmlClasses(attributes), attributes).toContain("legal-h2");
    }

    for (const section of TERMS_OF_USE.sections) {
      const attributes = h2Attributes.find((value) => value.includes(`id="${sectionId(section.title)}"`));
      expect(attributes, section.title).toBeDefined();
    }
    const contact = h2Attributes.find((value) => value.includes('id="legal-contact-heading"'));
    expect(contact).toBeDefined();
    expect(html).toMatch(/<h2\b[^>]*\bid="legal-contact-heading"[^>]*>\s*Contact us\s*<\/h2>/);
  });

  it("leaves only font-display and tracking-tight on the ApplySuccess h2", () => {
    const heading = /<h2\b([^>]*)>\s*\{PARTNER_APPLY\.successTitle\}\s*<\/h2>/.exec(
      readRepoFile("components/partners/ApplyForm.tsx"),
    );
    expect(heading).not.toBeNull();
    expect(jsxClasses(heading![1])).toEqual(["font-display", "tracking-tight"]);
  });

  it("keeps exactly the three established responsive sizes on the hero h1", () => {
    const hero = literalHeadings(readRepoFile("components/landing/Hero.tsx")).find(
      (heading) => heading.tag === "h1" && jsxClasses(heading.attributes)?.includes("hero-h1"),
    );
    expect(hero).toBeDefined();
    expect(sizeUtilities(jsxClasses(hero!.attributes) ?? [])).toEqual([
      "text-3xl",
      "sm:text-4xl",
      "lg:text-5xl",
    ]);
  });
});
