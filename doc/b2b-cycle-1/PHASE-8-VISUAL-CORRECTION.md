# Phase 8: corrective visual pass (photo-led public shell)

Code commit `c0eab8f` on `feat/portal-b2b-cycle-1`; the loopback preview (port 3120) serves exactly this commit. Nothing merged, pushed or deployed to production.

## Staging sources located and reused
Repository: `~/projects/Nare-Travel-and-Tours` (staging.nare.am, HEAD 41265db). Its upload folder holds only `.gitkeep`; the photographs live on the staging server, so they were copied once from the staging content API (`/api/content/heroSlides`, `/api/content/pageBanners`, `/api/serve-image/uploads/...`), optimised with sharp and stored locally. Nothing is hotlinked.

| Reused | Staging path | Local file / use |
|---|---|---|
| Script logo | `public/logo/Nare_logo_menu_web.webp` (SHA-256 identical) | `public/brand/nare-logo.webp`: the single header lockup |
| Icon | `public/logo/nare-icon.webp` | favicon/app icons only (and the signed-in sidebar mark) |
| Hero photo | `uploads/armenia-georgia-tour-destination-management-1764605124075.webp` (staging hero slide 1) | `public/brand/photos/hero-expo.webp` (144 KB), landing hero |
| About photo | `uploads/nare-travel-tours-about-us-1764605555849.webp` (staging About banner) | `public/brand/photos/about-monastery.webp` (81 KB), About Nare, login panel, partner application band, CTA texture |
| Footer system | `components/footer.tsx` (charcoal `hsl(222 32% 9%)`, 4-column grid, outlined 44px round social buttons, round contact icon chips, legal bar, TikTok and TripAdvisor glyph paths) | adapted in `components/public/PublicFooter.tsx` with portal links; token `--footer` |
| Typography/palette | `app/globals.css`, `app/layout.tsx` (Fraunces/Inter via Google Fonts) | replaced by local system serif + Geist, no font service |
| Social links | `data_backup/socialLinks.json` | defaults of the admin-managed contact settings (editable) |

Reviewed and **not used**: the paramotor photo (carries a third-party "Armenian Explorer" watermark; not Nare's imagery and not to be cropped around), wedding-couple photos (identifiable private individuals), the seasonal market photos, stock passport/wine/Egypt images. Staging's "5000 travelers / 10 years" statistics were NOT carried over (unverified). Provenance and the licence caveat are in `public/brand/photos/SOURCES.md`.

## What changed
* **One brand lockup**: header only. Removed from the hero (no duplicate logo/name/founded badge/fake dashboard), the footer shows the name as text.
* **Hero**: photo-led, asymmetric (large photo, offset aubergine block, amber ring), concise copy, only Sign in and Become a partner.
* **Rhythm**: hero, one continuous benefits band, editorial services list, aubergine four-step timeline, About Nare, CTA + contact panel, dark footer.
* **About Nare**: staging About photograph, large 2019 numeral (from the contact settings), three plain verified sentences, no statistics or superlatives.
* **Footer**: all emails, phones, address/map and social links come from the admin-managed contact data. New additive `social` block (https links on each platform's own domain, validated; optional visibility flag; admin UI "Social links"; no schema migration, stored in the existing JSON profile).
* **Login and partner application**: the same photo-led panel and header logo.
* Authenticated shell, permissions, forms, i18n and pricing/traveller logic untouched.

## Verification
* `tsc` clean; full suite 135 files / 1701 tests; production build OK.
* Preview audit (`evidence/redesign-audit.mjs`): 60/60 (axe wcag2a/aa/2.1aa serious+critical, no horizontal scroll, three widths, public/advisor/admin/partner, Armenian at phone width with reduced motion).
* Permission smoke on the preview: 40/40.
* Performance/keyboard script: no external requests; 296 KB of images; load 536 ms on loopback; hero `fetchpriority=high`, others lazy; every image has alt text; visible focus on every focusable element; reduced motion neutralises transitions.
* Admin API: an invalid social host is rejected (400); a valid one saves as a draft only.

## Visual QA
Evidence: `evidence/redesign2/before/` (previous preview), `evidence/redesign2/staging/` (staging reference), `evidence/redesign2/after/` (final, incl. Armenian phone shots). Two passes were made: pass 1 replaced the generic card grids; pass 2 dropped the watermarked photo, enlarged the header logo, balanced the headline, aligned the header grid and tuned tablet image ratios.

## Open items
Licence/ownership confirmation of the two photographs for the production portal; native review of the Armenian strings; the production-template pricing proof remains an open release blocker.
