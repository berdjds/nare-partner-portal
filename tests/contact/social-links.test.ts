import { describe, expect, it } from "vitest";
import { contactDataSchema, DEFAULT_CONTACT, socialSchema } from "@/lib/contact/schema";

describe("social links in the admin-managed contact data", () => {
  it("accepts https links on each platform's own domain", () => {
    expect(socialSchema.safeParse({ facebook: "https://www.facebook.com/Nare.Travel.and.Tours/", instagram: "https://www.instagram.com/nare_travel/", linkedin: "https://www.linkedin.com/company/105172290/", tiktok: "https://www.tiktok.com/@nare_travel", youtube: "https://youtu.be/abc", twitter: "https://x.com/nare" }).success).toBe(true);
  });
  it("rejects http, other hosts, lookalikes, credentials and unknown platforms", () => {
    for (const bad of [{ facebook: "http://www.facebook.com/x" }, { facebook: "https://evil.example/facebook.com" }, { facebook: "https://facebook.com.evil.example/x" }, { instagram: "https://user:pw@instagram.com/x" }, { linkedin: "javascript:alert(1)" }, { snapchat: "https://snapchat.com/x" }]) {
      expect(socialSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
  it("the built-in defaults are valid and a profile saved before social links existed still parses", () => {
    expect(contactDataSchema.safeParse(DEFAULT_CONTACT).success).toBe(true);
    const { social, ...legacy } = DEFAULT_CONTACT;
    const { social: _s, ...vis } = legacy.visibility as Record<string, unknown>;
    void social; void _s;
    expect(contactDataSchema.safeParse({ ...legacy, visibility: vis }).success).toBe(true);
  });
});
