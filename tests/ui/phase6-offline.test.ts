import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Table } from "@/components/ui/table";
import { LocaleProvider } from "@/lib/i18n/react";
import { TrustStrip } from "@/components/landing/TrustStrip";
import { B2B_SERVICES } from "@/lib/portal-content";
import { MESSAGES } from "@/lib/i18n/messages";

describe("localized table region label", () => {
  it("is English by default, Armenian under hy, and overridable", () => {
    expect(renderToStaticMarkup(createElement(Table))).toContain('aria-label="Data table"');
    expect(renderToStaticMarkup(createElement(LocaleProvider, { locale: "hy", children: createElement(Table) }))).toContain('aria-label="Տվյալների աղյուսակ"');
    expect(renderToStaticMarkup(createElement(Table, { regionLabel: "Rates" }))).toContain('aria-label="Rates"');
  });
});

describe("trust strip", () => {
  it("does not repeat the benefit sentences shown in the section above", () => {
    const html = renderToStaticMarkup(createElement(TrustStrip));
    expect(html).not.toContain("Each request is reviewed");
    expect(html).not.toContain("Access is granted");
    expect(html).toContain("2019");
  });
});

describe("service-card copy", () => {
  it("is plain and descriptive: no superlatives or capability boasts", () => {
    const text = B2B_SERVICES.map((s) => `${s.title} ${s.body}`).join(" ");
    expect(text).not.toMatch(/\b(comprehensive|complete|leading|best|specialized|specialised|premier|unique|expert|world-class|full-service)\b/i);
  });
  it("has an Armenian string for every English service card", () => {
    for (let i = 1; i <= 3; i++) expect((MESSAGES.hy as any)[`landing.service${i}.body`]).toBeTruthy();
  });
});
