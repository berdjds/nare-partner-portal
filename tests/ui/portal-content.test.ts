/**
 * Content contract for the W5a portal landing/sign-in copy.
 *
 * The wording guards at the bottom are the point of the module: the portal
 * copy must never promise pricing, speed/automation, or self-registration,
 * because none of those are part of the approved offer.
 */

import { describe, expect, it } from "vitest";
import {
  BENEFITS,
  CONTACT,
  FORGOT_ACCESS,
  HERO,
  HOW_IT_WORKS_STEPS,
  INDEXABLE,
  LOGIN_PANEL,
  MAILTO_SUBJECTS,
  PAGE_TITLES,
  PRODUCT_NAME,
  robotsDirective,
} from "@/lib/portal-content";

describe("portal content: product and page titles", () => {
  it("exposes the exact product name", () => {
    expect(PRODUCT_NAME).toBe("Nare Travel and Tours");
  });

  it("exposes the exact home and login page titles (em dash U+2014)", () => {
    expect(PAGE_TITLES.home).toBe("Nare Travel and Tours — Partner Portal");
    expect(PAGE_TITLES.login).toBe("Sign in — Nare Travel and Tours Portal");
    expect(PAGE_TITLES.home).toContain("—");
    expect(PAGE_TITLES.login).toContain("—");
  });
});

describe("portal content: hero", () => {
  it("has a non-empty headline, subline and CTA label", () => {
    expect(HERO.headline.trim()).not.toBe("");
    expect(HERO.subline.trim()).not.toBe("");
    expect(HERO.ctaLabel.trim()).not.toBe("");
  });
});

describe("portal content: how-it-works steps", () => {
  it("has exactly three steps, each with a non-empty title and body", () => {
    expect(HOW_IT_WORKS_STEPS).toHaveLength(3);
    for (const step of HOW_IT_WORKS_STEPS) {
      expect(step.title.trim()).not.toBe("");
      expect(step.body.trim()).not.toBe("");
    }
  });
});

describe("portal content: benefits and login panel", () => {
  it("lists at least one non-empty benefit", () => {
    expect(BENEFITS.length).toBeGreaterThan(0);
    for (const benefit of BENEFITS) {
      expect(benefit.trim()).not.toBe("");
    }
  });

  it("has a login-panel headline and exactly three bullets", () => {
    expect(LOGIN_PANEL.headline.trim()).not.toBe("");
    expect(LOGIN_PANEL.bullets).toHaveLength(3);
    for (const bullet of LOGIN_PANEL.bullets) {
      expect(bullet.trim()).not.toBe("");
    }
  });
});

describe("portal content: contact details", () => {
  it("uses the exact contact email and both phone numbers", () => {
    expect(CONTACT.email).toBe("reservation@nare.am");
    expect(CONTACT.phones).toContain("+374 10 545046");
    expect(CONTACT.phones).toContain("+374 91 005046");
  });

  it("provides non-empty mailto subjects", () => {
    expect(MAILTO_SUBJECTS.contact.trim()).not.toBe("");
    expect(MAILTO_SUBJECTS.partnerAccess.trim()).not.toBe("");
  });

  it("provides forgot-password text pointing at the contact email", () => {
    expect(FORGOT_ACCESS.text).toBe(
      "Forgot your password? Contact your Nare account manager",
    );
    expect(FORGOT_ACCESS.mailto).toBe("reservation@nare.am");
    expect(FORGOT_ACCESS.mailto).toBe(CONTACT.email);
  });
});

describe("portal content: robots directive", () => {
  it("is not indexable by default", () => {
    expect(INDEXABLE).toBe(false);
  });

  it("returns a noindex directive while INDEXABLE is false", () => {
    const directive = robotsDirective();
    expect(directive).toMatch(/\bnoindex\b/);
    // "noindex" contains the substring "index", so the positive-directive
    // check must anchor on the token, not the substring.
    expect(directive).not.toMatch(/(^|,\s*)index\b/);
  });

  it("derives the directive from the INDEXABLE flag", () => {
    expect(robotsDirective()).toBe(
      INDEXABLE ? "index, follow" : "noindex, nofollow",
    );
  });
});

describe("portal content: wording guards", () => {
  const userFacing = [
    HERO.headline,
    HERO.subline,
    HERO.ctaLabel,
    ...HOW_IT_WORKS_STEPS.flatMap((step) => [step.title, step.body]),
    ...BENEFITS,
    LOGIN_PANEL.headline,
    ...LOGIN_PANEL.bullets,
    FORGOT_ACCESS.text,
  ].join("\n");

  it("contains no pricing words", () => {
    expect(userFacing).not.toMatch(/\b(pricing?|costs?|fees?|cheap|discount)\b/i);
  });

  it("contains no speed or automation claims", () => {
    expect(userFacing).not.toMatch(
      /\b(instant(ly)?|automate[d]?|automation|real[- ]time|fast(est)?)\b/i,
    );
  });

  it("contains no self-registration wording", () => {
    expect(userFacing).not.toMatch(
      /\b(sign[- ]?up|register|create (an? )?account)\b/i,
    );
  });

  it("states that access is granted by Nare staff", () => {
    expect(userFacing).toMatch(/access is granted by the Nare team/i);
  });
});
