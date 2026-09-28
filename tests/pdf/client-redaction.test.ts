/**
 * CLIENT quotation redaction regression test (W1): pins that the client-facing
 * template output for the sample quote contains no cost price, no margin and
 * no internal note fields — so later W1 tasks and the Next 15 upgrade are
 * proven not to change it. (The INTERNAL document legitimately contains all of
 * these; see templates.test.ts.)
 */

import { describe, expect, it } from "vitest";
import { buildClientQuotationHtml } from "@/lib/travel/pdf/templates";
import {
  FIXTURE_ITINERARY_DAYS,
  FIXTURE_NIGHTLY_RATE,
  FIXTURE_SOURCEREF,
  makeFixture,
} from "./fixture";

describe("CLIENT template output leaks no internals (W1 regression)", () => {
  const html = buildClientQuotationHtml(makeFixture({ itineraryDays: FIXTURE_ITINERARY_DAYS }));

  it("contains no cost price fields", () => {
    expect(html).not.toContain("costQuote");
    expect(html).not.toContain("1471700.00"); // raw costQuote amount
    expect(html).not.toContain("1,471,700"); // ceiled costQuote amount
    expect(html).not.toContain(FIXTURE_NIGHTLY_RATE); // raw nightly rate (cost)
    expect(html).not.toContain("28,501"); // ceiled nightly rate (cost)
    expect(html).not.toContain("unitRate");
    expect(html).not.toContain("Nightly rate trace");
  });

  it("contains no margin fields", () => {
    expect(html).not.toContain("margin");
    expect(html).not.toContain("Margin");
    expect(html).not.toContain("profit");
    expect(html).not.toContain("Profit");
    expect(html).not.toContain("0.1235"); // raw margin ratio
    expect(html).not.toContain("12.4%"); // rendered margin
    expect(html).not.toContain("MARKUP_ON_COST");
  });

  it("contains no internal note fields", () => {
    expect(html).not.toContain("Override notes");
    expect(html).not.toContain("Group discount negotiated"); // internal override reason
    expect(html).not.toContain("actor:");
    expect(html).not.toContain("UNUSED_BEDS"); // internal issue code
    expect(html).not.toContain("2 bed(s) allocated but unused"); // internal issue message
    expect(html).not.toContain(FIXTURE_SOURCEREF); // rate provenance
    expect(html).not.toContain("Calculation trace");
    expect(html).not.toContain("INTERNAL");
  });

  it("still renders the client-facing quote content", () => {
    expect(html).toContain("ACME-2026-09-21-0001");
    expect(html).toContain("Option A");
    expect(html).toContain("1,679,000.00 AMD");
  });
});
