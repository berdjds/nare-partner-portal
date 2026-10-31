import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PARTNER_APPLY } from "@/lib/portal-content";
import { ApplyStepper } from "@/components/partners/ApplyWizard";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function extract(markup: string, pattern: RegExp, description: string): string {
  const match = markup.match(pattern);
  expect(match, `expected ${description}`).not.toBeNull();
  return match![0];
}

function classNames(markup: string): string[] {
  const openingTag = extract(markup, /^<[^>]+>/, "an opening tag");
  return openingTag.match(/\bclass="([^"]*)"/)?.[1].split(/\s+/).filter(Boolean) ?? [];
}

function renderStepper() {
  const html = renderToStaticMarkup(createElement(ApplyStepper, { stageIndex: 1 }));
  const nav = extract(html, /<nav\b[^>]*>[\s\S]*?<\/nav>/, "the stepper nav");
  const list = extract(nav, /<ol\b[^>]*>[\s\S]*?<\/ol>/, "the stepper list");
  const items = list.match(/<li\b[^>]*>[\s\S]*?<\/li>/g) ?? [];
  return { nav, list, items };
}

describe("ApplyStepper", () => {
  it("renders the four stages in order in a nonwrapping horizontal list", () => {
    const { nav, list, items } = renderStepper();

    expect(nav).toContain(`aria-label="${escapeHtml(PARTNER_APPLY.progressLabel)}"`);
    expect(items).toHaveLength(4);
    (["company", "licence", "contacts", "review"] as const).forEach((key, index) => {
      expect(items[index]).toContain(escapeHtml(PARTNER_APPLY.sections[key]));
    });
    expect(classNames(list)).toEqual(
      expect.arrayContaining(["flex", "flex-nowrap", "overflow-x-auto"]),
    );
    expect(classNames(list)).not.toContain("flex-wrap");
  });

  it("marks Company completed and Trade licence current", () => {
    const { items } = renderStepper();
    const completed = items[0]!;
    const current = items[1]!;

    expect(classNames(completed)).toEqual(expect.arrayContaining(["border", "border-border"]));
    expect(completed).not.toContain("aria-current");
    expect(completed).toContain("lucide-check");
    expect(completed).toMatch(/<svg\b[^>]*\baria-hidden="true"[^>]*>/);
    expect(completed).toContain('<span class="sr-only">completed</span>');

    expect(current).toContain('aria-current="step"');
    expect(classNames(current)).toEqual(
      expect.arrayContaining(["bg-primary", "text-primary-foreground"]),
    );
    expect(current).not.toContain("<svg");
    expect(current).not.toContain("completed");
    expect(items.filter((item) => item.includes('aria-current="step"'))).toHaveLength(1);
  });

  it("styles Contacts and Review as upcoming without completion affordances", () => {
    const { items } = renderStepper();

    for (const upcoming of items.slice(2)) {
      expect(classNames(upcoming)).toContain("text-muted-foreground");
      expect(classNames(upcoming).some((name) => name === "border" || name.startsWith("border-"))).toBe(false);
      expect(upcoming).not.toContain("aria-current");
      expect(upcoming).not.toContain("<svg");
      expect(upcoming).not.toContain("completed");
    }
  });
});
