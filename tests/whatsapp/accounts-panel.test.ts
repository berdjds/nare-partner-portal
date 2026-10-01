/**
 * W3 (wa-multi) component tests for the admin AccountsPanel: per-account
 * cards render independently (own state badge, enabled checkbox, action
 * buttons, QR block), the browser↔server link badge is kept separate from
 * the per-account WhatsApp states, and busyAccount disables only that
 * account's controls. Rendered with react-dom/server in the node
 * environment — no DOM, no testing-library. Also covers
 * resolveWhatsAppDisplayState (socket state wins, HTTP status is the
 * pre-socket fallback) at the unit level.
 */

import { describe, expect, it } from "vitest";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import AccountsPanel, {
  type AccountCardData,
  type AccountsPanelProps,
} from "@/components/admin/AccountsPanel";
import { resolveWhatsAppDisplayState, type WhatsAppState } from "@/hooks/useSocket";

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

function makeAccount(overrides: Partial<AccountCardData> & { key: string }): AccountCardData {
  return {
    displayName: overrides.key,
    enabled: true,
    purpose: "INBOX",
    publicNumber: null,
    verifiedNumber: null,
    state: null,
    ...overrides,
  };
}

function renderPanel(props: Partial<AccountsPanelProps> & { accounts: AccountCardData[] }): string {
  return renderToString(
    h(AccountsPanel, {
      browserLink: { connected: true, unauthorized: false },
      onAction: () => {},
      onToggleEnabled: () => {},
      ...props,
    })
  );
}

const marhabaReady = makeAccount({
  key: "marhaba",
  displayName: "Marhaba Armenia",
  enabled: true,
  purpose: "INBOX",
  publicNumber: "37420000099",
  verifiedNumber: "37420000001",
  state: { state: "ready", accountKey: "marhaba" },
});

const nareQr = makeAccount({
  key: "nare",
  displayName: "Nare Travel and Tours",
  enabled: false,
  purpose: "TRAVEL",
  state: { state: "qr", accountKey: "nare", qrSvg: "<svg>nare-qr</svg>" },
});

describe("AccountsPanel", () => {
  it("renders both accounts with independent per-account controls", () => {
    const html = renderPanel({ accounts: [marhabaReady, nareQr] });

    expect(html).toContain("Marhaba Armenia");
    expect(html).toContain("Nare Travel and Tours");
    expect(html).toContain('id="enabled-marhaba"');
    expect(html).toContain('id="enabled-nare"');

    // One Connect / Reconnect / Disconnect button per card (the brackets
    // keep "Reconnect"/"Disconnect" from matching the "Connect" count).
    expect(count(html, ">Connect<")).toBe(2);
    expect(count(html, ">Reconnect<")).toBe(2);
    expect(count(html, ">Disconnect<")).toBe(2);

    // Numbers: verified falls back to "Not paired", public renders only when set.
    expect(html).toContain("+37420000001");
    // SSR splits "Public number: +" and the interpolated value with a comment
    // marker, so assert label and value separately.
    expect(count(html, "Public number:")).toBe(1);
    expect(html).toContain("37420000099");
    expect(html).toContain("Not paired");

    // Only nare carries a QR: its markup renders exactly once, while
    // marhaba's card keeps its own state text and the no-QR fallback.
    expect(count(html, "<svg>nare-qr</svg>")).toBe(1);
    expect(count(html, "Scan this QR code with WhatsApp")).toBe(1);
    expect(count(html, "Waiting for WhatsApp state...")).toBe(1);
    expect(html).toContain(">ready<");
    expect(html).toContain(">qr<");
  });

  it("shows the browser link state separately from the per-account WhatsApp state", () => {
    const html = renderPanel({
      accounts: [marhabaReady],
      browserLink: { connected: false, unauthorized: false },
    });

    expect(html).toContain("Server link:");
    expect(html).toMatch(/Server link:[\s\S]{0,300}>offline</);
    expect(html).toContain("WhatsApp state:");
    expect(html).toMatch(/WhatsApp state:[\s\S]{0,300}>ready</);
    // The link being offline must not bleed into the account badge.
    expect(count(html, "offline")).toBe(1);
    expect(count(html, "ready")).toBe(1);

    const expired = renderPanel({
      accounts: [marhabaReady],
      browserLink: { connected: false, unauthorized: true },
    });
    expect(expired).toMatch(/Server link:[\s\S]{0,300}>session expired</);
    expect(expired).not.toContain(">offline<");
    expect(expired).toMatch(/WhatsApp state:[\s\S]{0,300}>ready</);
  });

  it("disables only the busy account's controls", () => {
    const html = renderPanel({
      accounts: [marhabaReady, nareQr],
      busyAccount: "nare",
    });

    const idxNare = html.indexOf('id="enabled-nare"');
    expect(html.indexOf('id="enabled-marhaba"')).toBeGreaterThan(-1);
    expect(idxNare).toBeGreaterThan(-1);

    // Accounts render in prop order, so everything before the nare checkbox
    // (the server-link line plus the whole marhaba card) must be enabled.
    // Count the rendered attribute (`disabled=""`): the bare word "disabled"
    // also appears in Tailwind variant classes (disabled:opacity-50,
    // peer-disabled:...) on buttons and labels regardless of state.
    const marhabaSection = html.slice(0, idxNare);
    const nareSection = html.slice(idxNare);
    expect(count(marhabaSection, 'disabled=""')).toBe(0);
    // Checkbox + Connect + Reconnect + Disconnect.
    expect(count(nareSection, 'disabled=""')).toBe(4);
  });
});

describe("resolveWhatsAppDisplayState", () => {
  const httpState: WhatsAppState = { state: "ready", accountKey: "marhaba" };
  const socketState: WhatsAppState = { state: "qr", accountKey: "marhaba", qrSvg: "<svg/>" };

  it("falls back to the HTTP status state before the first socket event", () => {
    expect(resolveWhatsAppDisplayState(undefined, httpState)).toBe(httpState);
    expect(resolveWhatsAppDisplayState(null, httpState)).toBe(httpState);
  });

  it("prefers the socket state once one has been delivered", () => {
    expect(resolveWhatsAppDisplayState(socketState, httpState)).toBe(socketState);
    expect(resolveWhatsAppDisplayState(socketState, undefined)).toBe(socketState);
  });

  it("returns null when neither source has a state", () => {
    expect(resolveWhatsAppDisplayState(null, null)).toBeNull();
    expect(resolveWhatsAppDisplayState(undefined, undefined)).toBeNull();
  });
});
