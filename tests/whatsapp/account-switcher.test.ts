/**
 * W3 (wa-multi) component tests for the dashboard AccountSwitcher: one
 * button per account with the selected account highlighted, and nothing at
 * all when fewer than two accounts are visible (there is nothing to
 * switch). Also covers pickDefaultAccountKey — the dashboard opens on
 * Marhaba whenever it is in the list, otherwise on the first account.
 * Rendered with react-dom/server in the node environment.
 */

import { describe, expect, it } from "vitest";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import AccountSwitcher, {
  pickDefaultAccountKey,
  type SwitcherAccount,
} from "@/components/dashboard/AccountSwitcher";

const marhaba: SwitcherAccount = { key: "marhaba", displayName: "Marhaba Armenia" };
const nare: SwitcherAccount = { key: "nare", displayName: "Nare Travel and Tours" };

function renderSwitcher(accounts: SwitcherAccount[], selected: string): string {
  return renderToString(h(AccountSwitcher, { accounts, selected, onSelect: () => {} }));
}

describe("AccountSwitcher", () => {
  it("renders one button per account with the selected account highlighted", () => {
    const html = renderSwitcher([marhaba, nare], "nare");

    expect(html).toContain("Marhaba Armenia");
    expect(html).toContain("Nare Travel and Tours");

    const buttons = html.match(/<button[^>]*>[^<]*<\/button>/g) ?? [];
    expect(buttons).toHaveLength(2);

    const marhabaButton = buttons.find((b) => b.includes("Marhaba Armenia"))!;
    const nareButton = buttons.find((b) => b.includes("Nare Travel and Tours"))!;
    // Selected → default variant (bg-primary), unselected → outline (border).
    expect(nareButton).toContain("bg-primary");
    expect(nareButton).not.toContain("border-input");
    expect(marhabaButton).toContain("border-input");
    expect(marhabaButton).not.toContain("bg-primary");
  });

  it("renders nothing when only one account is visible", () => {
    expect(renderSwitcher([marhaba], "marhaba")).toBe("");
  });

  it("renders nothing when no accounts are visible", () => {
    expect(renderSwitcher([], "marhaba")).toBe("");
  });
});

describe("pickDefaultAccountKey", () => {
  it("prefers marhaba whenever it is in the list", () => {
    expect(pickDefaultAccountKey([marhaba, nare])).toBe("marhaba");
    expect(pickDefaultAccountKey([nare, marhaba])).toBe("marhaba");
  });

  it("falls back to the first account when marhaba is absent", () => {
    expect(pickDefaultAccountKey([nare])).toBe("nare");
  });

  it("falls back to marhaba for an empty list", () => {
    expect(pickDefaultAccountKey([])).toBe("marhaba");
  });
});
