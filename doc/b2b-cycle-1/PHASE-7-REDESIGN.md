# Phase 7: Nare-aligned UX/UI redesign

Branch `feat/portal-b2b-cycle-1`. Code commits: `d11554a` (redesign), `a680ce2` (progress wraps on phones). Nothing merged, pushed or deployed to production; only the isolated loopback preview was rebuilt.

## Direction
Reference: the Nare logo (pomegranate red, aubergine) and staging.nare.am (warm ivory canvas, charcoal ink, serif display). Portal information architecture stays concise and B2B-focused.

| Token | Value | Use |
|---|---|---|
| `--background` | 38 40% 97% | ivory canvas |
| `--foreground` | 222 32% 11% | charcoal text |
| `--brand` | 358 68% 40% | pomegranate red (sampled from the logo): accents, active nav, step markers |
| `--plum` | 330 47% 20% | aubergine: headings, hero and contact panels |
| `--primary` | 214 90% 42% | bright blue, reserved for actions (buttons, links, focus) |
| `--warm` | 35 88% 52% | restrained amber details |
| `--radius-card` | 1.5rem | 24px cards (`rounded-card`) |

Fonts are local only: Geist (npm package) for body, a system serif stack for display (`--font-display-stack`), a system Armenian stack. The Google Fonts dependency in the root layout was removed, so builds and page views contact no font service. `prefers-reduced-motion` is honoured globally.

## What changed
1. **Landing**: asymmetric hero (serif headline, filled Sign in, outlined Become a partner, a graphic collage of the Nare mark and the real four-step process, "Founded in 2019" chip from the contact settings); benefits, three service cards (one featured), a connected four-step process, a slim trust strip, a plum contact panel with the verified email and phones, and a compact footer. No photograph: none is approved, so the visual is a CSS/graphic composition.
2. **Login and partner application**: the same shell, plum-to-pomegranate panel, serif headings, polished card; validation, show/hide password and the no-account-leak behaviour are unchanged.
3. **Authenticated shell and admin**: warm canvas, refined sidebar (pomegranate active marker, tinted active item), serif page titles, 10-unit controls, wider and denser content area.
4. **New request**: step navigation with completion marks, focused max-width form, sticky summary and primary action on large screens, bottom action bar only below `lg`, clearer helper text.
5. **Request details**: header with colour rule, serif title, a workflow progress indicator (`RequestProgress`), summary tiles (agency, dates, owner, validator), clearer tabs; the danger zone is a collapsed `<details>` element.
6. **Armenian and RTL**: Armenian pages checked at phone width with no overflow; layout uses logical properties and `rtl:` variants only where a direction matters (Arabic stays architecture-only).

Business logic, permissions, pricing and i18n behaviour are untouched; only presentation and structure changed.

## Evidence
Before/after screenshots at desktop 1440, tablet 820 and phone 390 for landing, login, new request, request details and admin (home and requests):
`doc/b2b-cycle-1/evidence/redesign/before/` and `.../after/` (plus Armenian phone shots `hy-*-mobile.png`). Scripts: `evidence/redesign-capture.mjs`, `evidence/redesign-audit.mjs`; audit results `evidence/redesign/audit-results.txt` (60/60: no horizontal scroll and no axe serious/critical issue on public, advisor, admin and partner pages at three widths; danger zone collapsed; Armenian fit).

## Limitations
* No photography (none approved); the hero is graphic.
* Armenian strings remain machine-assisted and unreviewed by a native speaker.
* Dev-mode React reports a pre-existing `<div>` inside `<p>` hydration warning in the admin accounts tab (not introduced here, not visible in the production build).
* Quotation PDFs keep their existing look; only the web UI was redesigned.
