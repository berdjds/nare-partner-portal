# Phase 5: brand, landing, login, authenticated UI audit

Branch `feat/portal-b2b-cycle-1` (from main 5625cd2). Nothing merged, pushed, deployed or migrated.

## Delivered

| Item | Result |
|---|---|
| Brand / favicon | Staging icon reused. `scripts/gen-brand-icons.mjs` produces `app/favicon.ico` and `public/brand/{icon-32,apple-touch-icon,icon-192,icon-512}.png`; `app/manifest.ts`; theme colour in one place (`lib/brand.ts`). Test: `tests/ui/brand-icons.test.ts`. |
| Landing | Hero (Sign in primary, Become a partner secondary), partner benefits, 3 service groups, 4-step process, trust strip limited to verified facts (founded 2019), compact contact block and footer fed from the contact profile (Phase 4). |
| Removed claims | Every unverified statistic/superlative removed ("leading", counts, response-time promises). "Corporate Travel" service group removed (not verifiable). A test scans the rendered landing for such patterns. |
| Login | Inline validation (`lib/login-validation.ts`), `noValidate` + `aria-invalid` + `aria-describedby`, show/hide password, forgot-password and partner-application links, one generic failure message (no account-existence leak). |
| RTL readiness | Physical `ml/mr/pl/pr/left/right` utilities replaced by logical ones across app and components; no Arabic content. |
| Audit | Playwright + axe-core on desktop 1280, tablet 768 and phone 390 for admin, advisor and partner roles: no horizontal page scroll, axe serious/critical, one h1, tab bars, landing order. |

## Audit findings and fixes

First run: 15 failures. Fixes: aria-labels on 57 label/control pairs (templates, agencies, settings, catalog, template editor, overview, review, dashboards); keyboard-focusable, labelled scroll region in `components/ui/table.tsx`; notifications status filter label; `--destructive` darkened to 0 72% 45% (white-on-destructive now >= 4.5:1, tested). Second run: 144/146; the last two were unlabeled controls in Settings (WhatsApp account select/input, brand colour picker), fixed with a test (`tests/ui/settings-a11y.test.ts`).

## Notes for the owner

* No photography: staging has no photo assets, the hero is typographic. Photography is an owner decision.
* Armenian landing strings are machine-assisted drafts and need native review.
* Quotation PDFs and remaining screens are not yet translated (English fallback).
* `next build` needs network access for Google Fonts.

## Evidence

`doc/b2b-cycle-1/evidence/phase5/` (screenshots, `browser-phase5-results.json`), script `evidence/browser-phase5.mjs`, seed `evidence/phase5-seed.ts`. Isolated trial-mode server on a throwaway SQLite DB; production data untouched.
