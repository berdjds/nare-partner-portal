# Design System

Visual language and page-composition rules for the WAControl portal surfaces.

## Public pages

The portal has two public (signed-out) pages: the landing page at `/`
(`app/page.tsx`) and the sign-in page at `/login` (`app/login/page.tsx`). Both
were added in phase W5a.

### Where copy and contact details live

All public-page copy lives in `lib/portal-content.ts` as typed, exported
constants — pages and components never hard-code strings:

- `PRODUCT_NAME`, `PAGE_TITLES` — product name and the `<title>` metadata for
  home and login.
- `HERO`, `HOW_IT_WORKS_STEPS`, `BENEFITS` — landing page headline, sub-line,
  CTA label, the three "how it works" steps, and the benefit list.
- `LOGIN_PANEL` — headline and bullets for the login brand panel.
- `CONTACT` — contact block (`reservation@nare.am`, `+374 10 545046`,
  `+374 91 005046`), taken from the public nare.am site and flagged in a code
  comment as "owner to confirm" before launch.
- `MAILTO_SUBJECTS`, `FORGOT_ACCESS` — mailto subjects and the
  "Forgot your password? Contact your Nare account manager" mailto.
- `INDEXABLE` and `robotsDirective()` — see below.

Wording is deliberately conservative: no pricing, no speed or automation
claims, no self-registration wording. Portal access is granted by Nare staff
to approved partners; the only approved claims are one place to send requests,
validation by the Nare team, and a clear status to follow.

Landing page sections are composed from `components/landing/` (`Hero`,
`HowItWorks`, `Benefits`, `ContactBlock`, `Footer`) by `app/page.tsx` for
signed-out visitors. The brand gradient uses design tokens only
(`bg-gradient-to-br from-primary to-brand`); raw palette classes and hex
literals stay out of page code.

### The INDEXABLE flag

`INDEXABLE` in `lib/portal-content.ts` (default `false`) is the single switch
for search-engine visibility of the landing page: `app/page.tsx` sets its
`robots` metadata from `robotsDirective()`, which returns
`"noindex, nofollow"` while the flag is `false` and `"index, follow"` once the
owner approves indexing. The login page is **always** `noindex, nofollow`,
independently of the flag — because `app/login/page.tsx` is a client
component, its metadata lives in the small server layout
`app/login/layout.tsx`.

### Landing and login sit outside the shell

The two public pages render standalone, full-page layouts and do not use the
portal shell components (e.g. `TravelShell`) or any authenticated chrome — no
sidebar, no account UI, no session-dependent navigation. They rely only on
brand tokens and the shared `components/ui/` primitives. `app/page.tsx` keeps
its signed-in redirect logic untouched (ADMIN → `/admin`, inbox roles →
`/dashboard`, others → `/travel` per the W1 access policy in
`lib/access-policy.ts`); only signed-out or deactivated visitors see the
landing page.

### Planned B2B hook points

The public pages are the front door for the B2B partner portal. The hooks that
connect them to B2B functionality arrive with the B2B BRD, not in W5a:

- **Sign-in** — the login form already routes through the existing
  credentials flow; future B2B client accounts will sign in through the same
  page and land on their B2B workspace.
- **Request submission** — the landing page's "Send a request" story and the
  contact mailto (`MAILTO_SUBJECTS.partnerAccess`) are placeholders for the
  B2B request-submission flow that the BRD will define.

Until then, no self-registration, password reset, or request submission exists
on the public pages, and nothing in W5a changes authentication, sessions,
permissions, or APIs.
