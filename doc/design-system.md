# Design System

How the Nare Travel and Tours portal looks and how its shared chrome is built.
This document describes what is implemented today (phases W4–W5f); the tests
listed at the end pin it, so update both together.

## Brand

The product is shown as **Nare Travel and Tours** with the subtitle **Portal**
(see `components/app/BrandMark.tsx`). The root metadata title is
`Nare Travel and Tours — Portal` (`app/layout.tsx`).

Brand palette (from the Nare Travel and Tours website repository):

| Role | Colour | Token |
| --- | --- | --- |
| Brand blue (marks, decoration) | `hsl(203 89% 53%)` | `--brand` |
| Primary / active (buttons, links) | Deepened brand blue `hsl(203 89% 40%)` — AA contrast with white text | `--primary`, `--ring`, `--sidebar-primary` |
| Warm highlight (rare) | Nare orange `hsl(27 96% 61%)` | `--warm` |
| Accent tint | Light blue `hsl(203 87% 95%)` / text `203 89% 28%` | `--accent`, `--accent-foreground` |
| Text | Near-black `hsl(0 0% 10%)` | `--foreground` |
| Neutrals | `hsl(0 0% 93%)` / `hsl(0 0% 78%)` | `--secondary`, `--muted` / `--input` |

## Tokens and where they live

The entire palette is CSS variables in **`app/globals.css`** (`:root` inside
`@layer base`) — HSL channel triples only, no hex literals. Tailwind maps them
once in **`tailwind.config.ts`** (`colors: { primary: "hsl(var(--primary))", …
sidebar: { … } }`), so components consume Tailwind colour utilities
(`bg-primary`, `text-muted-foreground`, `border-border`, `bg-sidebar-primary`,
…) and never a raw palette class or hex value.

Token groups:

- **Core**: `--background`, `--foreground`, `--card`, `--popover`,
  `--primary`, `--secondary`, `--muted`, `--accent`, `--destructive`,
  `--border`, `--input`, `--ring`, each with a `-foreground` pair where a
  foreground is meaningful, plus `--radius`.
- **Sidebar**: `--sidebar-background` (white rail), `--sidebar-foreground`,
  `--sidebar-primary` (brand red, used for the brand mark and active tint),
  `--sidebar-accent` / `--sidebar-accent-foreground` (red-tinted active
  background), `--sidebar-border`, `--sidebar-ring`.
- **Fonts**: Geist via `--font-geist-sans` / `--font-geist-mono`
  (`tailwind.config.ts` `fontFamily`).

### Colour rules

- **Primary** (deepened Nare blue) is reserved for primary actions and the active
  navigation state. Keep it rare; do not use it for decoration.
- **Destructive** keeps its own brighter red (`--destructive: 0 84% 60%`),
  visibly distinct from the brand blue, and is only used with an icon
  and a confirmation.
- **Status colours** (success / warning / info / danger / neutral) exist only
  for badges, pills and toasts. They live in the status maps exported from
  `components/ui/badge.tsx` (`badgeStatusStyles`, `badgeStatusTextStyles`;
  keys `neutral`, `warning`, `success`, `danger`, `info`), which is the one
  file exempt from the no-raw-palette rule. `components/ui/toast.tsx` maps its
  variants onto these (`success` → `success`, `error` → `danger`,
  `info` → `info`).
- **Raw palette classes are forbidden** everywhere else: no
  `bg-red-500`-style Tailwind palette utilities and no hex literals in
  `app/` or `components/` (allow-list: `app/globals.css`,
  `tailwind.config.ts`, `components/ui/badge.tsx`). The
  `tests/ui/design-guard.test.ts` guard fails the build otherwise.
- The PDF brand colour is single-sourced too:
  `lib/travel/branding.ts` exports `DEFAULT_BRAND_COLOR`; PDF templates and
  the settings panel import it instead of repeating the hex.
- The embedded calculator
  (`doc/temp/Hello_Armenia_Package_Calculator_2026_v3.html`) carries its own
  `--primary: #0B7BC1; --primary-dark: #085C91; --accent: #085C91;
  --text: #2D3032; --success: #16865c; --danger: #cc3d3d;` variables in its
  `<style>` block. Only colours may change there — never its single `<script>`
  block or the calculations (`tests/ui/calculator-shell.test.ts` pins the
  script verbatim).

### Icons

Icons come from **lucide-react only** (`Sidebar.tsx`, `PageHeader.tsx`, ui
primitives). Do not add another icon set or inline emoji/SVG icons.

## The shell

Shared chrome lives in `components/app/`:

- **`AppShell.tsx`** (server component) — reads the session with
  `getServerSession(authOptions)` and `getActiveUser()` from
  `lib/access-policy.ts`. With no active user it renders the children bare
  (pages still guard themselves; `getActiveUser()` re-reads the user row, so
  revocation takes effect on the next request). Otherwise it renders the
  sidebar, the mobile bar and a `<main>` container.
  - `variant="default"` (default): centered `max-w-6xl` container with page
    padding.
  - `variant="full"`: full-width container, no centering — used by the chat
    dashboard and the calculator, which manage their own viewport-height
    layout (`h-[calc(100dvh-3.5rem)]` / `lg:h-dvh`).
- **`Sidebar.tsx`** (client) — `Sidebar`: a fixed 240px (`w-60`) white rail on
  `lg+` with the brand mark, grouped navigation and a user card (avatar with
  initials, role label, sign out, "Sign out everywhere", app version).
  `MobileBar`: a sticky top bar below `lg` that opens the same navigation in a
  `Sheet`. The active item is derived from the pathname via each item's
  `match()` and tinted in brand red (`bg-primary/[0.08] text-primary`).
- **`BrandMark.tsx`** (client) — the `N` mark plus "Nare Travel and Tours" /
  "Portal" label (`compact` variant for the mobile bar); links to `/`. Also
  used by the login page.
- **`PageHeader.tsx`** (client) — page title block used *inside* pages, below
  the shell chrome: `title`, optional `subtitle`, optional `breadcrumb`
  (`BreadcrumbItem[]`, `ChevronRight`-separated, last item plain text) and
  optional `actions` rendered to the right.
  `components/travel/TravelShell.tsx` re-exports `PageHeader` and
  `BreadcrumbItem` so existing travel imports keep working.
- **`nav.ts`** — the navigation model (see below).

Pages wrap themselves explicitly (`<AppShell>…</AppShell>` or
`<AppShell variant="full">`) instead of a route-group layout; the travel
module wraps once in `app/travel/layout.tsx`. Only the public pages (landing,
login, apply, terms, privacy — see "Public pages") stay outside the shell.

## Navigation model

`components/app/nav.ts` exports `navGroupsForUser(user)`, a **pure** function
of `{ role, permissions }` — no React, no `next/*`, no Prisma — so server
components, client components and node Vitest tests all consume the same
model. It returns the visible groups in fixed order:

- **Inbox** — Chat dashboard (`/dashboard`).
- **Travel** — Requests (`/travel`), Review queue, Templates, Catalog,
  Agencies, Settings, Notifications.
- **Tools** — Calculator (`/calculator`).
- **Admin** — Accounts and users panel (`/admin`), Permissions report
  (`/admin/permissions`).

Every item's visibility mirrors exactly the guard of the page it links to,
expressed with the same helpers the pages use (`hasPermission()` over the
effective permission set from `lib/permissions.ts`, `isTravelRole()` from
`lib/travel/contracts.ts`, role checks). Each item carries an inline comment
citing the page guard it mirrors. The model is cosmetic only — the page
guards remain the enforcement. A group whose items are all invisible is
dropped; no active user yields no groups. Each item has a `match(pathname)`
predicate for the active state (exact for `/admin` so it does not highlight
on `/admin/permissions`; prefix-aware for the rest).

## How to add a page

1. Create the page under `app/` and guard it as usual
   (`getServerSession` + `getActiveUser` + role/permission check +
   `redirect`). The guard is the security boundary; the shell never grants
   access.
2. Wrap the page content in `<AppShell>` (or `<AppShell variant="full">` for
   full-viewport pages). Use `<PageHeader>` for the title block.
3. Add a nav item in `components/app/nav.ts` in the right group, with a
   visibility predicate that mirrors the page guard (cite the guard in a
   comment), an icon from the `NavIcon` union (add the lucide mapping in
   `Sidebar.tsx`'s `NAV_ICONS` if new), and a `match()` predicate.
4. Use token colours only (`bg-primary`, `text-muted-foreground`, …); status
   colours only through the badge/toast status maps.
5. Update the guard tests: `tests/ui/nav.test.ts` (visibility per role),
   `tests/ui/design-guard.test.ts` if the route set changes (nav-coverage
   guard pins the top-level authenticated routes).

## Guard tests

The design system is pinned by `tests/ui/` (all pure node tests; only
`nav.test.ts` executes runtime code, the rest assert on source text):

- `nav.test.ts` — `navGroupsForUser()` output per role (ADMIN, USER,
  ADVISOR, VALIDATOR, unknown role, no session) with real
  `effectivePermissions()`, including permission-denial and grant cases and
  the `match()` predicates.
- `brand-tokens.test.ts` — the exact token values in `app/globals.css`, the
  Tailwind sidebar mappings, no hex literals in globals.css,
  destructive ≠ primary, ring == primary, the metadata title, the badge
  status maps, and token-cleanliness of button/toast/BrandMark.
- `design-guard.test.ts` — repo-wide regression guards: no raw palette
  classes or hex in `app/`/`components/` outside the allow-list; every
  `app/**/page.tsx` inside the shared AppShell (allow-list: the five public
  pages — landing, login, apply, terms, privacy — each with a reason); every
  top-level authenticated route covered by the nav model. Includes negative
  fixtures proving the detectors bite.
- `travel-shell.test.ts`, `admin-shell.test.ts`, `chat-shell.test.ts`,
  `calculator-shell.test.ts`, `login-brand.test.ts` — per-area checks that
  each surface renders inside the shared shell, has dropped its old header
  chrome, and kept its behaviour (guards, socket logic, calculator script,
  sign-in flow) unchanged.
- `pub-chrome.test.ts` — the shared public header/footer: links and labels,
  `aria-current` per `active` prop, mobile-menu wiring (`aria-expanded`,
  `aria-controls`, Escape-to-close), footer contact/office/legal links and
  copyright, token-only colours, and that the landing, apply and login pages
  render the chrome.
- `legal-pages.test.ts` — the `/terms` and `/privacy` pages: the drafted
  documents rendered section by section, "Last updated", the "Contact us"
  block, metadata titles and `robots` pinned to `robotsDirective()`, and
  token-only colours.
- `landing-v2.test.ts` (W5e) — the landing renders the four approved B2B
  sections in order between the hero and the contact block, each with its id
  and an accessible labelled heading, every W5e content string from
  `lib/portal-content.ts`, the h1→h2/h3 heading outline in order, and the
  `/partners/apply` + `/login` links on both the landing and the sign-in
  page.
- `public-no-green.test.ts` (W5e) — no green-family colour classes
  (green/emerald/lime/teal) and no raw hex or hsl colours anywhere on the
  public surface (`components/landing`, `components/public`, `app/page.tsx`,
  `app/login`, `app/partners/apply`, `app/terms`, `app/privacy`), with
  negative fixtures proving the detectors bite.

Run them with `npm test`.

## Retuning the palette

A palette change touches **`app/globals.css` only** (plus the calculator's
`<style>` variables and `lib/travel/branding.ts` if their hues move too):

1. Edit the HSL triples in `:root`. Keep the pairing rules: every `-foreground`
   stays legible on its base, `--ring` tracks `--primary`, `--destructive`
   stays visibly distinct from `--primary`, and the sidebar tokens stay a
   white rail with a red-tinted active state.
2. Update `tests/ui/brand-tokens.test.ts` with the new values — the test
   asserts the exact triples, so it doubles as the palette's source of truth
   in CI.
3. If status hues change, adjust the maps in `components/ui/badge.tsx` (the
   design-guard exemption requires it to keep containing raw palette classes).
4. Do not introduce hex literals or raw palette classes elsewhere — the
   design guard will fail.

## Public pages

The portal has five public (signed-out) pages: the landing page at `/`
(`app/page.tsx`), the sign-in page at `/login` (`app/login/page.tsx`), the
partner application at `/partners/apply` (see `doc/partners.md`), and the
legal pages at `/terms` and `/privacy`. The first two were added in phase
W5a; the application page in W5b; the staged application, the shared public
chrome and the legal pages in W5f.

### Public chrome (header and footer)

All five pages share the same header and footer, built with token colours
only:

- **`components/public/PublicHeader.tsx`** (client) — a bordered top bar
  (`border-b border-border bg-background`, `max-w-5xl` inner) with the Nare
  wordmark (text, not an image — tests forbid `/brand/` asset references)
  linking home, and the primary nav (`aria-label="Primary"`): **Home** (`/`),
  **Become a partner** (`/partners/apply`) and **Sign in** (`/login`). The
  active page is passed in as an `active` prop (`"home" | "apply" | "login"`)
  and its link gets `aria-current="page"` and `text-primary underline`;
  inactive links are `text-muted-foreground hover:text-foreground`. On small
  screens a menu button (`sm:hidden`) toggles the nav with `aria-expanded`
  and `aria-controls="public-header-nav"`, swapping Menu/X icons; Escape
  closes the menu from anywhere inside the header, and on `sm+` the nav is
  always visible (`sm:flex`), so links stay keyboard reachable.
- **`components/public/PublicFooter.tsx`** (server — no interactivity, so it
  renders from server and client pages alike) — `border-t border-border`
  with three columns (brand + `OFFICE_ADDRESS`, contact email/phones from
  `CONTACT` as `mailto:`/`tel:` links, and a Legal nav linking `/terms` and
  `/privacy`) and a bottom bar with the copyright line
  `© {current year} {PRODUCT_NAME}. All rights reserved.`

The landing page composes `PublicHeader active="home"`, the landing sections
from `components/landing/` — `Hero`, then the W5e B2B sections
(`ServicesSection` with the `DMC strengths` sub-block, `WhyNareSection`,
`AboutNareSection`, `ArmeniaGlanceSection`, each a `<section>` with an id and
an `aria-labelledby` heading), then `HowItWorks`, `Benefits`, `ContactBlock`
— and `PublicFooter`; the earlier `components/landing/Footer.tsx` is retained
but no longer used. The sign-in page renders `PublicHeader active="login"`
above its two-column panel and `PublicFooter` below; the apply page renders
`PublicHeader active="apply"`. The legal pages pass no `active` (none of the
three header links is the current page).

### Legal pages

`app/terms/page.tsx` and `app/privacy/page.tsx` render `TERMS_OF_USE` and
`PRIVACY_NOTICE` from **`lib/legal-content.ts`** (pure typed data —
`LegalDocument` with `title`, `subtitle`, `intro` and `sections` of
paragraphs and/or item lists, plus `LEGAL_LAST_UPDATED`) through
**`components/public/LegalPage.tsx`** (server): an `<article max-w-3xl>`
with the title header, the "Last updated: …" line, the intro, one numbered
`<section>` per section (numbering is positional, not stored in the data)
and a "Contact us" card (`bg-card border-border`) built from `CONTACT` and
`OFFICE_ADDRESS`. Both pages use the shared public header/footer, title
their metadata `{document.title} — Nare Travel and Tours Portal`, and set
`robots` from `robotsDirective()` — the same `INDEXABLE` owner decision as
the landing page.

**The legal text is a working draft awaiting review by Nare's legal
advisor** before the portal is promoted to the public (comment at the top of
`lib/legal-content.ts`); the wording deliberately promises nothing the
portal does not do today. Only the retention promise it makes (90-day
deletion of documents for applications that are not approved) is already
operational — honoured manually, see `doc/partners.md`.

### Where copy and contact details live

All public-page copy lives in `lib/portal-content.ts` as typed, exported
constants — pages and components never hard-code strings:

- `PRODUCT_NAME`, `PAGE_TITLES` — product name and the `<title>` metadata for
  home, login and the apply page.
- `HERO`, `HOW_IT_WORKS_STEPS`, `BENEFITS` — landing page headline, sub-line,
  CTA label, the three "how it works" steps, and the benefit list.
- `B2B_SERVICES`, `WHY_NARE`, `DMC_STRENGTHS`, `ABOUT_NARE`,
  `ARMENIA_GLANCE`, `LANDING_SECTION_TITLES` (W5e) — the approved nare.am B2B
  copy for the four landing sections and their accessible headings.
- `LOGIN_PANEL` — headline and bullets for the login brand panel.
- `PARTNER_APPLY` — everything the application wizard renders: section and
  field labels, the stepper chrome (`stepLabel` "Step {step} of {total}",
  `progressLabel`, Back/Next/Edit/Replace), the review-stage strings
  (`reviewHelper`, `notProvided`, `fixErrorsNotice`), consent text, file
  rules and the success/unavailable copy.
- `CONTACT` — contact block (`reservation@nare.am`, `+374 10 545046`,
  `+374 91 005046`), taken from the public nare.am site and flagged in a code
  comment as "owner to confirm" before launch.
- `OFFICE_ADDRESS` — `91 Teryan St, Tparan Business Center, Yerevan,
  Armenia` (owner-confirmed 2026-10-03), rendered in the footer and the legal
  pages' "Contact us" card.
- `MAILTO_SUBJECTS`, `FORGOT_ACCESS` — mailto subjects and the
  "Forgot your password? Contact your Nare account manager" mailto.
- `INDEXABLE` and `robotsDirective()` — see below.

The legal documents are not part of `portal-content.ts`: they live in
`lib/legal-content.ts` as pure data (see "Legal pages" above), so pages and
tests import them without React or Next.

Wording is deliberately conservative: no pricing, no speed or automation
claims, no self-registration wording. Portal access is granted by Nare staff
to approved partners; the only approved claims are one place to send requests,
validation by the Nare team, and a clear status to follow.

Landing page sections are composed from `components/landing/` (`Hero`,
`ServicesSection`, `WhyNareSection`, `AboutNareSection`,
`ArmeniaGlanceSection`, `HowItWorks`, `Benefits`, `ContactBlock`) by
`app/page.tsx` for signed-out
visitors, between the shared `PublicHeader` and `PublicFooter`. The brand
gradient uses design tokens only
(`bg-gradient-to-br from-primary to-brand`); raw palette classes and hex
literals stay out of page code, and no green-family colour appears on any
public page (guarded by `tests/ui/public-no-green.test.ts`).

### The INDEXABLE flag

`INDEXABLE` in `lib/portal-content.ts` (default `false`) is the single switch
for search-engine visibility of the public pages: `app/page.tsx`, the apply
page and both legal pages set their `robots` metadata from
`robotsDirective()`, which returns `"noindex, nofollow"` while the flag is
`false` and `"index, follow"` once the owner approves indexing. The login
page is **always** `noindex, nofollow`, independently of the flag — because
`app/login/page.tsx` is a client component, its metadata lives in the small
server layout `app/login/layout.tsx`.

### Public pages sit outside the shell

The five public pages render standalone, full-page layouts and do not use
the portal shell components (e.g. `TravelShell`) or any authenticated chrome
— no sidebar, no account UI, no session-dependent navigation. They rely only
on brand tokens, the shared `components/ui/` primitives and the public
chrome above. All five are allow-listed in the AppShell guard in
`tests/ui/design-guard.test.ts` (`app/page.tsx`, `app/login/page.tsx`,
`app/partners/apply/page.tsx`, `app/terms/page.tsx`, `app/privacy/page.tsx`).
`app/page.tsx` keeps its signed-in redirect logic untouched (ADMIN →
`/admin`, inbox roles → `/dashboard`, others → `/travel` per the W1 access
policy in `lib/access-policy.ts`); only signed-out or deactivated visitors
see the landing page.

### Planned B2B hook points

The public pages are the front door for the B2B partner portal. The hooks that
connect them to B2B functionality arrive with the B2B BRD, not in W5a:

- **Sign-in** — the login form already routes through the existing
  credentials flow; future B2B client accounts will sign in through the same
  page and land on their B2B workspace.
- **Request submission** — the landing page's "Send a request" story and the
  contact mailto (`MAILTO_SUBJECTS.partnerAccess`) are placeholders for the
  B2B request-submission flow that the BRD will define.

Until then, no portal self-registration, password reset, or request
submission exists on the public pages. The partner **application**
(`/partners/apply`, W5b/W5f) is live but is not an account: it only starts
the staff-reviewed enrollment flow (see `doc/partners.md`). Nothing in the
public pages changes authentication, sessions, permissions, or APIs.
