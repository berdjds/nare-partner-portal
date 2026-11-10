/**
 * English catalogue: the source of truth for UI labels and the fallback for every other
 * locale. Values that already live in lib/portal-content.ts are imported, not copied, so the
 * English text has exactly one home.
 */
import { FORGOT_ACCESS, LOGIN_PANEL, PARTNER_APPLY, PRODUCT_NAME } from "@/lib/portal-content";
import { FRIENDLY_CREDENTIALS_ERROR } from "@/lib/login-errors";

export const en = {
  "common.brand": PRODUCT_NAME,
  "common.signIn": "Sign in",
  "lang.label": "Language",
  "nav.home": "Home",
  "nav.apply": PARTNER_APPLY.linkLabel,
  "nav.primary": "Primary",
  "nav.openMenu": "Open menu",
  "nav.closeMenu": "Close menu",
  "login.headline": LOGIN_PANEL.headline,
  "login.bullet1": LOGIN_PANEL.bullets[0],
  "login.bullet2": LOGIN_PANEL.bullets[1],
  "login.bullet3": LOGIN_PANEL.bullets[2],
  "login.title": "Sign in to the partner portal",
  "login.subtitle": "Use the account provided by the Nare team.",
  "login.email": "Email",
  "login.emailPlaceholder": "you@example.com",
  "login.password": "Password",
  "login.showPassword": "Show password",
  "login.hidePassword": "Hide password",
  "login.capsLock": "Caps Lock is on.",
  "login.submit": "Sign in",
  "login.submitting": "Signing in...",
  "login.forgot": FORGOT_ACCESS.label,
  "login.error": FRIENDLY_CREDENTIALS_ERROR,
  "footer.terms": "Terms",
  "footer.privacy": "Privacy",
  "footer.legalNav": "Legal",
  "footer.since": "Founded in {year}",
  "footer.rights": "© {year} {name}. All rights reserved. Developed by Hayk FZC",
  "partner.title": "My quotations",
  "partner.subtitle": "Requests and issued quotations for {agency}.",
  "partner.empty": "No requests yet.",
  "partner.notIssued": "Quotation not issued yet.",
  "partner.messages": "Your messages and notes: ",
  "partner.quotation": "Quotation v{version} (PDF)",
} as const;

export type MessageKey = keyof typeof en;
