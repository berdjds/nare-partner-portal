# B2B Portal cycle 1: audit, BRD and specification

Status: **DRAFT for owner review** (branch `feat/portal-b2b-cycle-1`, from main 5625cd2). Nothing is merged, pushed, deployed or migrated.
BRD approval is the owner's. No implementation has started; the first code phase (P1) waits for the decisions in section 5 that change business behaviour.

## 1. Audit: what exists today (verified in code)

| Area | Finding | Evidence |
|---|---|---|
| Stack | Next.js 15 / React 19 custom server, Prisma 5 + SQLite, NextAuth credentials, Vitest, Tailwind + Radix | `AGENTS.md`, `package.json` |
| Roles | `User.role` string: ADMIN, USER, ADVISOR, VALIDATOR. Travel area is for ADMIN/ADVISOR/VALIDATOR (plus anyone with an active validation assignment). **There is no partner/agency login role.** `Agency` has no users; `TravelRequest.ownerId` is always a staff user. | `schema.prisma` User, Agency; `lib/travel/access.ts`, `contracts.ts` |
| Permissions | Per-user grant/deny overrides over role presets. Keys include `travel.access`, `travel.create`, `travel.review`, `travel.issue`, `travel.client_docs.download`, `travel.internal.*`. | `lib/permissions.ts`, `UserPermission` |
| Document download | `GET /api/travel/documents/[id]` already checks kind: INTERNAL needs `travel.internal.download` AND ADMIN/VALIDATOR or the assigned validator; CLIENT needs `travel.client_docs.download` AND owner/assigned validator/ADMIN, else 404. Two kinds exist: `CLIENT` and `INTERNAL`. | `app/api/travel/documents/[id]/route.ts`, `QuoteDocument` |
| Redaction | Client view/PDF redaction exists and is tested. | `lib/travel/redact.ts`, `tests/pdf/client-redaction.test.ts`, `tests/permissions/internal-view-redaction.test.ts` |
| "Detailed calculation" | No control with that name exists. The nearest are the Review/Scenarios tabs and the INTERNAL costing sheet. Its gating must be located per tab before any claim. | grep over `components/` and `app/` |
| Calculation | Server-side engine, decimal strings, snapshots with hash and engine version, optimistic `revision`. Pricing bases: PER_PERSON, GROUP, CAPACITY_BLOCK, VEHICLE_TRIP/DAY, PER_KM, GUIDE_*, ROOM_NIGHT, PERSON_MEAL, FIXED_PACKAGE. Staff lines are never multiplied by guest pax. | `lib/travel/engine/*`, `contracts.ts` |
| Traveller model | `adults, children, infants, childAges[], paying, complimentary, leaders, staff`. Infant age limit is a setting (`infantMaxAge`, default 2). | `contracts.ts`, `TravelSettings` |
| Templates | `TemplateVersion.daysJson` (day, narrative, city, services `{serviceProductId?, label, quantity?, vehicleTypeId?}`) and optional `scenariosJson`. **Instantiation is a one-shot copy** into a new request. Nothing re-runs when travellers change. No per-item rules (age band, min/max pax, role applicability, included vs optional, rounding). "Tickets & degustations" is not a first-class concept. | `lib/travel/templates.ts`, `app/api/travel/templates/[id]/instantiate/route.ts` |
| Auto vs manual lines | `ServiceLine` has `sourceRef` and day-linked sync, but no explicit "template-added" versus "manual" marker or rule version. | `schema.prisma` ServiceLine |
| New request | A modal dialog inside the requests list. Field `notes` is a single string. | `components/travel/RequestsList.tsx` |
| Notes | One `TravelRequest.notes` field; the client-visible/internal split is not modelled. | `schema.prisma` |
| Translations | **None in the portal** (no locale routing, no dictionary, no `lang` switching). | grep over `app lib components` |
| Landing/login | Exist with brand tokens and guard tests (`tests/ui/*`), shipped W5a/W5e/W10/W10b. | `tests/ui`, `lib/portal-content.ts` |
| Company/contact data | `TravelSettings` holds company name/phone/email/address/website/brand colour for the quotation PDF only. No public contact config, no draft/publish, no map settings. | `schema.prisma` TravelSettings |
| Favicon/logo | Authoritative source on staging.nare.am is `public/logo/nare-icon.webp` (declared as icon and shortcut in its `app/layout.tsx`). The portal's `public/brand/nare-icon.webp` is **byte-identical** (same SHA-256). The portal layout does not declare an `icons` entry. | `Nare-Travel-and-Tours/app/layout.tsx`; sha256 compare |
| Staging translations | File-based `data/translations.json` entries `{key,en,hy,ru,ar,section}`. Not DB-backed, no approval workflow, no versions. Only the key/section vocabulary is reusable; the storage is not compatible with the portal's availability and audit needs. | `lib/translations-storage.ts` |
| Deploy | CI (`tsc`, Vitest, `next build`) then staging, smoke, production through `deploy/`. Schema changes go through `prisma db push` in the deploy path. | `AGENTS.md`, `deploy/` |

Overlap: the growth BRD (`partner-portal-growth-self-servi`, SP-18..SP-34, awaiting owner answers Q20/Q21) also plans partner self-service and translations (its Q9). This cycle must not contradict it; see decision D1.

## 2. Requirements (traceable)

IDs are provisional until the owner approves the BRD.

* **R-SEC**: partner users cannot see or fetch detailed/internal calculations, cost, supplier rates, margin or markup. Enforced in API and export endpoints; audit logged; negative tests.
* **R-CALC**: template-driven itinerary and pricing that recalculates deterministically when travellers change. Server authoritative.
* **R-REQ**: new request as a routed full page; notes split client-visible vs internal.
* **R-I18N**: English and Armenian now, Arabic/RTL-ready, AI-assisted draft with human approval.
* **R-CFG**: admin-managed company/contact configuration with draft/publish and audit.
* **R-UI**: brand foundation, landing, login, authenticated formatting.

## 3. Design

### 3.1 Permissions (R-SEC)
* Add role `PARTNER` (agency user) and a nullable `User.agencyId` (additive column). Partner access is limited to requests of their own agency; every other agency's request returns 404.
* A single server function `canViewInternalCalculation(actor, request)` is the only check used by: the calculate/preview API, the version content/trace payloads, the INTERNAL document route and any new export. It returns false for PARTNER and for any actor without `travel.internal.view`/`travel.internal.download`.
* Partner responses use a client-safe projection (sell price, approved itinerary and content). Internal fields are never loaded into the response object (allow-list, not strip-list).
* Every export writes an audit row (`kind`, actor, request, version, outcome including denials).
* No "Detailed calculation" control is rendered for PARTNER, but the server never relies on that.

### 3.2 Template rules and recalculation (R-CALC)
* Extend `daysJson` service entries with optional `rule` objects (backward compatible; absent means today's behaviour): `applies_to` (adult/child/infant/complimentary/leader/staff with age bands), `min_pax`, `max_pax`, `basis`, `per` (person|group|capacity_block), `rounding`, `optional`, `group` (for example `tickets_degustations`).
* A pure function `deriveLines(template, travellers, rules) -> lines[]` in `lib/travel/engine/`: no I/O, deterministic, idempotent (stable line keys `tpl:<templateVersionId>:<day>:<itemKey>`).
* Persist `ServiceLine.origin` (`TEMPLATE` | `MANUAL`), `templateKey`, `ruleVersion` (additive, nullable). Recalculation replaces only `TEMPLATE` lines with the same key; `MANUAL` lines are never touched; a manual override of a template line is stored as an override with a conflict flag when the rule output changes.
* A recalculate endpoint takes the request `revision` (409 on stale) and returns a diff (added/changed/removed/conflicts) plus an audit entry. Inputs and outputs are stored in the existing `CalculationSnapshot` hash.
* The UI only displays what the endpoint returns.

### 3.3 Notes (R-REQ)
* Add `clientNotes` (client-visible) and keep `notes` as internal. Existing `notes` are treated as internal by default (safe), shown as "Internal notes"; the new label "Client messages and notes" applies to `clientNotes`. Backfill is not needed.

### 3.4 Translations (R-I18N)
* Dictionary layer `lib/i18n/` with `en` (fallback), `hy`, an `ar` stub, and a direction map (`ltr`/`rtl`). Pages set `lang` and `dir`; layout uses logical CSS properties.
* Managed content: `Translation { entity, entityId, field, locale, text, status DRAFT|APPROVED, source (HUMAN|AI), model, sourceVersion, approvedBy, approvedAt }` with unique (entity, entityId, field, locale). Approved human rows are never overwritten by the AI workflow; AI output is always a DRAFT.
* AI draft endpoint (admin/editor only): server-side call with a provider key kept in server env. **Sending portal content to an external AI provider is an owner decision (D4).** Until decided, the endpoint is built behind a provider interface with a disabled default.
* Missing translation falls back to English, with a test that lists missing keys.

### 3.5 Company/contact configuration (R-CFG)
* `ContactProfile` rows: scope (`GLOBAL` or portal id), `status` (DRAFT|PUBLISHED), version, fields (founded year, general/B2B email, phones, WhatsApp, address, hours, visibility flags, map URL/place id/lat-lng) and `ContactProfileAudit`. Resolver: portal override over global over a built-in default of the approved data (info@nare.am, reservation@nare.am, +374 91 005046, +374 10 545046, founded 2019).
* Map preview uses a keyless embed link or static coordinates. No map API secret reaches the browser or the repository.

### 3.6 Visual (R-UI)
* Reuse the staging tokens (colours, typography, rounded cards) already mirrored in `tests/ui/brand-tokens.test.ts`; add the icon entry in `app/layout.tsx` pointing at the verified asset (also generate 32/180/192/512 PNG sizes as the staging site only ships a single WebP).

## 4. Delivery phases (in order)

| Phase | Content | Needs migration |
|---|---|---|
| P1 | R-SEC: role and agency scoping, single internal-calculation gate, client-safe projection, export audit, negative and direct-URL tests | additive columns, audit table |
| P2 | R-CALC: rule schema, pure derivation, origin markers, recalculate endpoint, boundary and concurrency tests | additive columns |
| P3 | R-REQ: routed full-page request flow, notes split | additive column |
| P4 | R-I18N and R-CFG | new tables |
| P5 | R-UI: tokens, favicon, landing, login, authenticated polish | none |

Each phase: own commits, TDD, independent review, QA, Chromium checks at desktop/tablet/mobile. Migrations are additive and nullable, reversible by dropping the added columns/tables; none runs against production without evidence and approval.

## 5. Decisions for the owner (these change business behaviour)

* **D1 Partner login (blocks P1/P3).** Today agencies have no login. Default proposed: add a `PARTNER` role linked to one agency, created by an admin on partner approval; partners see only their agency's requests and client-safe quotations. This overlaps growth BRD SP-18+. Merge into that BRD, or build the minimal role here first?
* **D2 Rule vocabulary (blocks P2).** Proposed in 3.2. The business rules themselves (which tours are free for leaders, child age bands per item) must come from the real templates and the owner, not from labels. Please nominate one template as the reference.
* **D3 Who may see internal calculation.** Default: ADMIN and VALIDATOR (and the assigned validator) only; ADVISOR sees sell prices unless granted `travel.internal.view`.
* **D4 AI translation provider.** Which provider, and is it acceptable to send template and quotation text to it?
* **D5 Arabic.** Armenian and English now; Arabic is architecture only. Confirm.

## 6. Risks and constraints discovered
* Partner role touches auth: needs `sessionVersion` handling and negative tests; do not weaken login or leak account existence.
* SQLite `prisma db push` in the deploy path means every added column must be nullable or defaulted.
* The calculation is already hash-snapshotted; the rule engine must keep `engineVersion` bumped so old snapshots stay reproducible.
* The staging site is not used at runtime (assets and vocabulary are copied/mirrored only).
* Baseline test run in this worktree: see section 7.

## 7. Baseline evidence
* Worktree with its own `node_modules` and a freshly generated Prisma client: **114 test files, 1475 tests, all passing** (main 5625cd2, no code changes).
* The shared checkout's installed Prisma client is stale (generated 2026-09-24, 32 models; the schema has 38). On it, the same suite shows 295 failures and 48 failing files, all `PrismaClientValidationError`. This is an environment problem, not a code defect; fix with `npx prisma generate` in `~/projects/wa.hayk` (not done: it modifies that checkout's installed packages).
* Protected files: `CLAUDE.local.md` is git-ignored and untouched; main checkout `git status` clean before and after.
