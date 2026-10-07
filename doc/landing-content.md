# Landing page content

How the copy on the public pages of the Nare Travel and Tours partner portal
is stored, reviewed and extended. This document covers the landing page
(`/`), the sign-in page (`/login`) and the partner application page
(`/partners/apply`).

## Where the copy lives

All public-page wording is typed data in
[`lib/portal-content.ts`](../lib/portal-content.ts). The module is
dependency-free and pure, so App Router pages, components and tests can all
import it without pulling in React or Next.

Nothing is hardcoded in the components: the landing sections
(`components/landing/`), the public header and footer
(`components/public/`), the sign-in page and the partner application page all
read their strings from this file.

The main exports, in the order they appear on the page:

| Export | Used for |
|--------|----------|
| `PRODUCT_NAME`, `PAGE_TITLES` | Brand name and per-page `<title>` values |
| `HERO` | Hero headline, subline and primary call to action |
| `B2B_SERVICES` | The four B2B service lines (W5e) |
| `WHY_NARE` | "Why choose us" items (W5e) |
| `DMC_STRENGTHS` | Destination Management Company strengths (W5e) |
| `ABOUT_NARE` | The company story, with its own heading (W5e) |
| `ARMENIA_GLANCE` | "Armenia at a glance" intro and tour types (W5e) |
| `LANDING_SECTION_TITLES` | Accessible headings for the W5e sections |
| `HOW_IT_WORKS_STEPS` | The three portal steps |
| `BENEFITS` | Approved claims about the portal |
| `LOGIN_PANEL` | Headline and bullets on the sign-in page |
| `PARTNER_APPLY` | All wording for the partner application wizard |
| `CONTACT`, `OFFICE_ADDRESS` | Email, phone numbers and office address |
| `MAILTO_SUBJECTS`, `FORGOT_ACCESS` | Contact links; `FORGOT_ACCESS` is the sign-in page's "Forgot your password?" link to /forgot-password (W6a), and `FORGOT_PAGE` / `RESET_PAGE` hold the two reset pages' copy |
| `INDEXABLE`, `robotsDirective()` | The single place that decides whether public pages may be indexed (currently `noindex`) |

## Review rule

The landing copy is **owner-approved wording from the public nare.am site**.
The rule for any change:

1. Wording changes are made only in `lib/portal-content.ts`, never inline in
   a component.
2. The owner reviews the wording **before launch**. Copy is not merged with a
   "we will fix the text later" note; what is in the content file is what the
   public sees.
3. Contact details (`CONTACT`, `OFFICE_ADDRESS`) follow the same rule — the
   office address was confirmed by the owner, and any change to it or to the
   phone numbers and email needs owner confirmation too.

## Left-out claims

The public pages deliberately do **not** mention any of the following. Do not
add them without explicit owner approval:

- Prices, discounts or savings
- Speed, turnaround times or automation claims
- Awards or rankings
- Partner counts, traveller counts or any other statistic (the "500+
  partners" claim in particular is not approved)
- Any number at all beyond "2014" (the founding year) and "24/7" (support
  availability), which are the only figures from the approved nare.am copy
- Self-service onboarding wording — portal access is granted by Nare staff
  to approved partners, and the copy says so

`tests/ui/landing.test.ts` asserts that the public pages render only the
approved content and none of the left-out claims.

## How to add a section

1. **Add the copy first.** Define a typed constant in
   `lib/portal-content.ts` (use `TitledContentItem` for title/body pairs, or
   add a small interface if the shape is new). Add the section's accessible
   heading to `LANDING_SECTION_TITLES`. Get the wording approved (see the
   review rule above) before continuing.
2. **Create the section component** in `components/landing/`. Follow the
   existing sections (e.g. `ServicesSection.tsx`): a `<section>` with an
   `id` and `aria-labelledby` pointing at its heading, content read from the
   content file, and styling only through the design tokens
   (`bg-background`, `text-foreground`, `text-muted-foreground`,
   `bg-primary`, `bg-warm` for the small accent bar, ...). Never use raw
   colours or green-family palette classes on public pages — see the colour
   guard below.
3. **Compose it in `app/page.tsx`** in the right reading order. The W5e
   story sections (services, why Nare, the story, Armenia at a glance) sit
   between the hero and the portal-mechanics sections (`HowItWorks`,
   `Benefits`), before the contact block.
4. **Extend the tests.** Add the section to `tests/ui/landing.test.ts` (copy
   and headings) and make sure it stays inside the scanned surface of the
   colour guard.

## Colour guard

`tests/ui/public-no-green.test.ts` scans every public-page source
(`components/landing`, `components/public`, `app/page.tsx`, `app/login`,
`app/partners/apply`, `app/terms`, `app/privacy`) and fails if it finds:

- a green-family Tailwind class (`green`, `emerald`, `lime`, `teal`), or
- a raw colour literal (hex or `hsl(...)`).

Public pages are white and light-neutral surfaces with Nare blue for primary
actions and the warm orange only as a small accent, expressed through the
tokens in `app/globals.css`. If the guard fails, replace the raw colour with
the matching token rather than widening the allow-list.
