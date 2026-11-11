# Phase 9: landing rebuilt in staging.nare.am's actual system

Branch `feat/portal-b2b-cycle-1`. Nothing merged, pushed or deployed to production. The loopback preview (port 3120) serves the commit named in the final report.

## Source inspected directly
`~/projects/Nare-Travel-and-Tours` (HEAD 41265db) and the live staging site (HTML, CSS, content API). Components read: `components/hero-slider/index.tsx` (full-bleed photo, dark gradient overlay, glass text panel, pill buttons), `components/page-banner.tsx`, `components/services-premium.tsx` (image-backed tiles, featured tile spanning two rows), `components/dmc-section.tsx` (charcoal section with glow, hairline-divided grid, blue CTA band), `components/footer.tsx`, `app/about/page.tsx`, and `app/globals.css` (`.eyebrow`, `.section-y`, `.pill-btn*`, `.reveal-up`).

## Typography (what the user flagged)
Staging uses **Inter** for body text and **Fraunces** (optical-size axis) for display type, with **Noto Sans Armenian / Noto Serif Armenian** for Armenian, section titles at `clamp(2.1rem, 4.6vw, 4rem)` semibold and 17-18px body copy. The portal had used a system serif fallback (Times on macOS) and smaller sizes. It now uses the same font files that staging itself serves, copied once into `public/fonts` (provenance in `public/fonts/SOURCES.md`, SIL OFL families) and declared with local `@font-face` rules, so nothing is fetched from a font service. The body, `.font-display` and Armenian-heading stacks mirror staging's.

## Imagery (provenance recorded in `public/brand/photos/SOURCES.md`)
Only two Nare photographs from staging are used: the exhibition stand hero (staging home slide 1) and the monastery visitors (staging's banner image on every page); plus the Yerevan market scene (staging slide 2) for the DMC tile and the login/application panels. The paramotor image (third-party "Armenian Explorer" watermark), wedding images (private individuals) and unrelated stock images were rejected. Photos were recompressed (186 / 78 / 111 / 68 KB).

## Layout
* **One brand lockup**: the script logo in the header only; no logo, mark or founded badge in the hero, no mock dashboard.
* **Hero**: image-led, staging's overlay and text panel, two pill buttons (Sign in, Become a partner).
* **Rhythm**: quiet benefits row (no boxes) -> image-backed services (large feature tile plus two compact tiles) -> charcoal "How it works" with hairline cells -> About Nare (asymmetric photo and about 120 words of story from approved wording and facts, 2019 and the count of service groups) -> blue CTA band (no contact details) -> rich dark footer (portal links, legal, contact and social from the admin settings).
* **No repeated contact content**: email, phones, address and social links appear only in the footer.
* **Login and partner application**: the same photo-led panel (market photo, dark overlay) and a slim footer.
* No content is hidden behind scroll animations.

## Verification
See the final report in the conversation for exact counts: typecheck, full suite, production build, 60-check browser audit (axe, no horizontal scroll, three widths, public/advisor/admin/partner, Armenian at phone width with reduced motion), 40-check permission smoke, and the performance/keyboard script. Evidence: `evidence/redesign3/before` (previous preview), `evidence/redesign3/after`, `evidence/redesign2/staging` (reference).

## Open items
Licence/ownership of the three photographs for the production portal; native review of Armenian; pricing proof (release blocker).
