# Design System

How the Nare Travel and Tours portal looks and how its shared chrome is built.
This document describes what is implemented today (phase W4); the tests listed
at the end pin it, so update both together.

## Brand

The product is shown as **Nare Travel and Tours** with the subtitle **Portal**
(see `components/app/BrandMark.tsx`). The root metadata title is
`Nare Travel and Tours — Portal` (`app/layout.tsx`).

Brand palette (from nare.am):

| Role | Colour | Token |
| --- | --- | --- |
| Primary / active | Nare red `#AE1F23` | `--primary: 358 70% 40%` |
| Accent hue | Plum `#592641` | `--accent-foreground: 328 40% 25%` |
| Text | Charcoal `#2D3032` | `--foreground: 204 5% 19%` |
| Light neutrals | `#EEEEEE` / `#C6C6C6` | `--secondary`, `--muted` / `--input` |

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

- **Primary** (Nare red) is reserved for primary actions and the active
  navigation state. Keep it rare; do not use it for decoration.
- **Destructive** keeps its own brighter red (`--destructive: 0 84% 60%`),
  visibly distinct from the deeper brand red, and is only used with an icon
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
  `--primary: #AE1F23; --primary-dark: #8B191C; --accent: #592641;
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
module wraps once in `app/travel/layout.tsx`. Only `app/login/page.tsx` and
`app/page.tsx` (a redirect) stay outside the shell.

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
  `app/**/page.tsx` inside the shared AppShell (allow-list: login and the
  root redirect); every top-level authenticated route covered by the nav
  model. Includes negative fixtures proving the detectors bite.
- `travel-shell.test.ts`, `admin-shell.test.ts`, `chat-shell.test.ts`,
  `calculator-shell.test.ts`, `login-brand.test.ts` — per-area checks that
  each surface renders inside the shared shell, has dropped its old header
  chrome, and kept its behaviour (guards, socket logic, calculator script,
  sign-in flow) unchanged.

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
