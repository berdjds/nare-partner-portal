/**
 * Phase 1 (R-SEC): PARTNER role ceiling and the D3 internal-calculation keys.
 * Pure tests, no database.
 */
import { describe, expect, it } from "vitest";
import { PERMISSION_KEYS, effectivePermissions, presetForRole } from "@/lib/permissions";
import { ROLE_PARTNER } from "@/lib/travel/contracts";

const PARTNER_ALLOWED = ["travel.access", "travel.client_docs.download"];

describe("PARTNER permissions", () => {
  it("the preset is exactly the read-only client-facing set", () => {
    expect(Array.from(presetForRole(ROLE_PARTNER)).sort()).toEqual([...PARTNER_ALLOWED].sort());
  });

  it("no override can lift a PARTNER above the ceiling (internal, admin, whatsapp, review, issue, create)", () => {
    const grants = PERMISSION_KEYS.map((key) => ({ key, allowed: true }));
    const eff = effectivePermissions(ROLE_PARTNER, grants);
    expect(Array.from(eff).sort()).toEqual([...PARTNER_ALLOWED].sort());
  });

  it("a deny override still removes a partner key", () => {
    const eff = effectivePermissions(ROLE_PARTNER, [{ key: "travel.client_docs.download", allowed: false }]);
    expect(eff.has("travel.client_docs.download")).toBe(false);
  });

  it("other roles keep granting behaviour (ceiling applies to PARTNER only)", () => {
    expect(effectivePermissions("ADVISOR", [{ key: "travel.internal.view", allowed: true }]).has("travel.internal.view")).toBe(true);
  });
});

describe("D3: internal calculation keys", () => {
  it("ADMIN and VALIDATOR presets carry them; ADVISOR and USER do not", () => {
    for (const k of ["travel.internal.view", "travel.internal.download"] as const) {
      expect(presetForRole("ADMIN").has(k)).toBe(true);
      expect(presetForRole("VALIDATOR").has(k)).toBe(true);
      expect(presetForRole("ADVISOR").has(k)).toBe(false);
      expect(presetForRole("USER").has(k)).toBe(false);
    }
  });
});
