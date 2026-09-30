# B2B Travel module — implementation and decision record

Implemented 2026-09-21 against `Kimi-Master-Prompt.md` and `WAControl-B2B-Module-Plan.md`.
Workbook evidence: `Workbook-Evidence.json` / `Formula-inventory.json` (static extraction; the
original `Tour Calculator v12.xlsm` was **not available** in this repository — agreement-image
rate reconciliation remains unverified, see RECONCILIATION.md).

## What was built

A versioned B2B travel package costing and quotation module inside WAControl:

- `lib/travel/contracts.ts` — frozen shared contract (money as decimal strings, ISO calendar
  dates, statuses, issue codes, engine DTOs, notification payload).
- `lib/travel/engine/` — pure deterministic calculation engine (decimal.js; no I/O, no clock,
  no DB): dates/nights, hotel nightly rate expansion with priority/ambiguity, occupancy and
  extra-bed rules, whole-unit cottages, 11 pricing bases, vehicle capacity, FX conversion
  (`fx[c] = AMD per 1 unit`), markup/margin/min-profit/fee policies, single round-up stage,
  per-scenario independence, structured issues + full trace.
- `lib/travel/snapshots.ts` — canonical JSON + sha256 snapshot hashing.
- `lib/travel/codes.ts` — transactional `CLIENTSHORT-YYYY-MM-DD-NNNN` package codes
  (PackageCodeCounter upsert, never count+1, min 4-digit padding, company-timezone date).
- `lib/travel/settings.ts` — TravelSettings singleton, active policy, effective-dated FX map.
- `lib/travel/import.ts` + `scripts/import-workbook.ts` — workbook evidence → staging
  (ImportBatch/ImportRow, idempotent, provenance per sheet!cell).
- `scripts/seed-travel-catalog.ts` — idempotent catalog seed (34 hotels, 95 services,
  13 templates, 237 rate versions, 4 vehicle types, Georgia USD PAX bands; TBC/conflicted
  rates staged as NEEDS_REVIEW).
- `lib/travel/resolve.ts` — DB → engine DTO resolution (VERIFIED rates only, overrides with
  reason/actor, stop-sale/quote-on-request enforcement, FX as of travel start, active policy).
- `lib/travel/workflow.ts` — DRAFT → PENDING_VALIDATION → APPROVED → ISSUED (+CHANGES_REQUESTED,
  REJECTED, ACCEPTED/DECLINED/EXPIRED, CANCELLED); assigned-validator-only decisions
  (self-validation allowed since v0.10.0), hash-bound approvals, transactional issue with
  idempotency, revisions; INTERNAL document generated and rendered at submit (v0.10.0) —
  its best-effort WhatsApp delivery was removed by the W2 int-lock: INTERNAL documents
  are never sent via WhatsApp, by anyone.
- `lib/travel/notifications.ts` + `lib/email.ts` — transactional outbox (WorkflowEvent +
  per-recipient/channel NotificationDelivery, dedup keys), async worker (wired in `server.ts`),
  email via SMTP (nodemailer) and WhatsApp via existing `sendWhatsAppMessage`; missing
  destinations flagged SKIPPED_NO_DESTINATION; overdue-validation sweep with escalation.
- `lib/travel/pdf/` — client quotation and internal costing HTML→PDF via a dedicated puppeteer
  browser (draft watermark, Unicode fonts, repeated table headers, page numbers; CLIENT docs
  contain no costs/margins/supplier refs).
- `app/api/travel/**` — requests, versions, submit/review/issue/outcome, agencies, catalog,
  rates verification, templates + instantiate, batch pricing, settings/policies/FX, imports,
  documents (authorized download), notifications (list/retry/process).
- `app/travel/**` + `components/travel/**` — requests workspace, review queue, templates,
  catalog/settings, notifications UI; nav buttons in both existing dashboards.
- `tests/` — vitest suites: engine, travel-db, workflow, pdf, qa, access, auth,
  messaging, email, socket, deploy (`npm test` = `vitest run`; the deploy suite
  covers the deploy gate and the recovery runbook).

## Reuse of existing WAControl features

- NextAuth credentials + JWT roles (`User.role` extended with ADVISOR/VALIDATOR; ADMIN is
  also the manager for floor exceptions and settings).
- `writeAuditLog()` for all mutations (UPPER_SNAKE actions), `lib/prisma.ts` singleton,
  zod body validation and `{ error }` response conventions in every new route.
- Existing WhatsApp client (`sendWhatsAppMessage`) reused for the WhatsApp notification
  channel; Socket.io (`__waControlState.io`) emits `travel_notification` for live UI updates.
- Puppeteer/Chromium already shipped for WhatsApp is reused for PDF rendering (separate
  browser instance, honors `PUPPETEER_EXECUTABLE_PATH` — no new system dependency in Docker).
- UI conventions: Card/Tabs/Dialog/Toast, axios client fetching, light shadcn theme.

## Decisions and assumptions (reversible, recorded per the master prompt)

1. **Single organization.** WAControl has no tenancy; org scope = the deployment. All travel
   records are scoped by role, not tenant.
2. **Agency model added.** No client/agency records existed; `Agency` (with admin-maintained
   uppercase `shortCode`) is module-owned and does not affect WhatsApp `Chat` records.
3. **Money = decimal strings.** SQLite has no decimal type; decimal.js is the arithmetic
   authority. Client code never recomputes totals.
4. **Package code date/sequence defaults** (user specified components, not reset rules):
   date = request creation day in company timezone (`TravelSettings.companyTz`, default
   `Asia/Yerevan`); sequence resets per agency per creation day; minimum 4-digit padding,
   grows naturally; generated once, immutable.
5. **Roles.** `ADMIN` doubles as validator-eligible manager; only ADMIN may grant below-floor
   exceptions, manage settings/rates/agencies, and reassign validators. `USER` has no travel
   access by default (401 at API, redirect at pages) — unless they hold an active validation
   assignment (see decision 24, v0.10.0).
6. **Approval blocks on engine blockers.** A version with BLOCKER issues (missing rates, FX,
   occupancy, capacity, stop-sale, below floor without exception) cannot be approved;
   warnings (e.g. unused beds) do not block.
7. **Issue-time settings gate.** With `TravelSettings.requireSettingsForIssue` (default true),
   issuance requires an active pricing policy and a quote-currency FX rate. The seeded policy
   ("Legacy workbook markup 14%") is intentionally **inactive** and has **no minProfit** —
   production settings are an explicit admin task.
8. **Notification merging.** The planned NotificationOutbox + NotificationDelivery pair is
   implemented as WorkflowEvent + NotificationDelivery (one row per event+recipient+channel,
   `dedupKey` unique) — same semantics, fewer tables.
9. **Documents on local disk** under `TravelSettings.documentsDir` (`data/documents/`, Docker
   volume candidate), never under `public/uploads/` (which is publicly reachable). Downloads
   stream through an authorized API route; INTERNAL documents require the
   `travel.internal.view` (list/preview/costs) and `travel.internal.download` (file)
   permissions — admin-granted, off by default for non-admins (W2 int-lock, D2).
10. **Vehicle checks at engine level only** — service resolution does not yet attach a vehicle
    assignment to versions (documented gap; engine validates `vehicleChecks` when provided).
11. **Rate seasons stay textual** for imported catalog rates: free-text seasonal notes are
    stored on the rate/hotel but not parsed into validity windows; ambiguous cottage pricing
    (Elegant, Mariot differing SGL/DBL/TPL columns) is staged NEEDS_REVIEW, not activated.
12. **New dependencies** (sanctioned by the master prompt's test/email requirements):
    decimal.js, nodemailer@^7 (pinned for next-auth optional peer), vitest. No other upgrades.
13. **Email is greenfield**: SMTP_* env vars; when unconfigured, email deliveries are flagged
    FAILED (visible, retryable) — never silently "sent".
14. **Tests do not contact real recipients**: email/WhatsApp/PDF senders are mocked in
    workflow tests; the PDF smoke test uses local Chromium/Chrome only.
15. **Snapshot hash input** = sha256 of canonical `{ engineVersion, inputs }`; review decisions
    and issuance bind to it; issuance re-verifies inside the transaction with an atomic
    status guard (`updateMany` on status) so a concurrent edit cannot slip under an approval.
    Client-facing display data (agency name/contacts, title, dates, travelers) is frozen at
    submit into `CalculationSnapshot.displayJson` (not hashed — it is not pricing-relevant);
    document regeneration uses the frozen copy so issued artifacts are reproducible.
16. **Concurrency hardening**: submit/review/issue use in-transaction atomic status guards
    (double-submit/double-review losers get 409); `createRequest` retries SQLite lock-race
    failures (P1008/P2028) — code generation stays atomic per attempt, so retries leave only
    harmless sequence gaps.
17. **Structured day services with legacy normalization.** `ItineraryDay.services` holds
    `DayServiceItem[]` (`{ serviceProductId: string | null; label: string }`);
    `normalizeDayServices()` maps legacy plain-string items to `{ serviceProductId: null, label }`
    and drops malformed entries (display data, never a pricing input). Day services carrying a
    `serviceProductId` are mirrored as **day-linked ServiceLines** inside `saveVersionContent`:
    the sync diff keys on `(serviceProductId, date)`, lines are shared (`scenarioId = null`),
    and `unitRate` stays null so resolve.ts prices them from SERVICE RateVersions — the band
    must cover `line.date ?? startDate`, VERIFIED rates only, with TBC / quoteOnRequest /
    ambiguity rules mirroring hotel resolution. Scenario-tab saves echo the lines back, so the
    round-trip preserves links. `overnightCity` is derived from the first scenario's stays and
    manual edits are preserved ("Sync cities from stays" reapplies derivation on demand).
    The frozen day list (normalized) also goes into `displayJson` at submit, so issued client
    PDFs render the day-by-day itinerary exactly as approved.
18. **Company branding is frozen into `displayJson` at submit** (`branding` object:
    companyName/phone/email/address/website/brandColor from the TravelSettings singleton).
    Document regeneration prefers the frozen copy and falls back to live settings only for
    pre-freeze snapshots — same pattern as `itineraryDays`. The client quotation PDF is a
    branded package offer: cover block (company name, contact block, `#packageCode`, display
    title, destination subtitle, stat pills), brand-color section bars, day-by-day banner bars
    with overnight city, a Package Options comparison table (one row per scenario: hotels,
    max-concurrent room summary, group total, per-paying price), side-by-side
    Inclusions/Exclusions, numbered Terms, a fixed Important Notes box ("offer only", rates
    subject to change, valid-until) and a thank-you closing banner. The shared print CSS still
    avoids the `margin` property entirely (padding only) so the client document never contains
    the substring "margin"; brand colors are interpolated into CSS only after a strict
    `#rrggbb` validation, defaulting to navy `#16305b`.
19. **Per-vehicle transportation pricing.** Transportation tours (TRANSPORTATION services,
    basis VEHICLE_TRIP) are priced per fleet vehicle type. The catalog seed converges the
    fleet vocabulary to Sedan (3) / Minivan (5) / Sprinter (12) / Big bus (48) — legacy names
    (Van / Minibus / Large bus) are renamed in place so rate references survive — and stamps
    each priced TRANSPORTATION product with one VERIFIED SERVICE RateVersion per vehicle at
    **priority 1**, initially copying the vehicle-agnostic base rate (priority 0, kept as the
    fallback) pending operator-entered fleet-specific prices. `ServiceLine.vehicleTypeId`
    records the selected vehicle: `resolveServiceRate` considers only that vehicle's rows when
    set (falling back to the vehicle-agnostic rows when none cover the line's date), and
    `buildEngineInputForVersion` passes the selection through `ServiceLineInput`. Lines
    without a vehicle selection keep the previous behavior (all rows; vehicle rows outrank the
    base row by priority). The itinerary-day ↔ linked-line sync keys on
    `(serviceProductId, date, vehicleTypeId)` — the same tour in two vehicles on one day is
    two lines — and unknown vehicle ids are rejected with `VEHICLE_TYPE_UNKNOWN` (400), same
    style as `SERVICE_PRODUCT_UNKNOWN`. `vehicleTypeId` identifies the rate bracket and is
    not editable on existing rates (archive + recreate), same rule as occupancy.
20. **Group-priced tickets via catalog data, not engine math.** The operator prices two
    TICKETS items per group: Chir's House 10,000 AMD per group of up to 5 (6 pax → 2×) and
    Lavash Baking 10,000 AMD per group of up to 10 (12 pax → 2×; supersedes the earlier flat
    GROUP basis inferred from mass template E5:G5). The engine's CAPACITY_BLOCK basis already
    computes `ceil(pax/capacity) × rate × qty` with `pax = participants ?? travelers.paying`,
    so the fix is seed data only: `serviceSpec()` maps `/chir/i` → CAPACITY_BLOCK capacity 5
    and `/lavash/i` → CAPACITY_BLOCK capacity 10, and `upsertServiceProduct` updates the
    existing rows in place on re-seed. All other TICKETS stay PER_PERSON.
21. **`childAges` on TravelerSetup.** Traveler input follows the booking.com occupancy
    pattern: adults/children steppers plus an "age at return" (0–17) dropdown per child.
    `TravelerSetup.childAges?: number[]` lives inside the travelers JSON string (no schema
    change); `travelerSchema` rejects payloads where `childAges.length !== children`
    ("childAges must list one age per child") on both the create and update paths. The ages
    are informational input for the advisor — occupancy validation
    (`lib/travel/engine/occupancy.ts`) and ticket participant defaults already key off the
    counts, so no engine math changes were needed. The shared `TravelerSetupEditor` component
    keeps `childAges` in sync with `children` (pad with 7 / truncate) and auto-derives
    `paying = adults + children` only while paying still equals the previous sum, so a manual
    override is never clobbered.
22. **Live quote preview via revision-triggered calculate.** The request detail page renders a
    "Quote summary" bar between the header and the tabs so the advisor always sees calculated
    amounts before submitting. For editable versions (DRAFT/CHANGES_REQUESTED) a shared
    `useQuotePreview` hook POSTs the existing (unpersisted, advisor-redacted) calculate
    endpoint and re-runs whenever `detail.revision` changes — the server bumps the revision on
    every content save, making it a perfect "content changed" signal; a run counter discards
    stale responses, and errors keep the last known prices. Non-editable versions read the
    persisted per-scenario snapshot (`Scenario.resultJson`) — no API call, so an approved price
    never moves. Submit now opens a confirmation dialog listing sell / per-paying-person /
    blockers per scenario; blockers are a warning, not a hard stop, because `submit()`
    deliberately allows submitting with issues (approval is what they block). The Scenarios
    tab's own preview machinery, per-scenario service-line tables and the duplicate "All
    service lines" card are gone: one always-rendered "Service lines" card, with day-linked
    (itinerary-managed) lines as compact read-only rows. The Documents tab merged into Review
    (5 tabs); advisor redaction is unchanged — the preview hook consumes the same redacted
    payload the old Calculate preview button did.
23. **Operator-feedback UX round.** (a) All `Select` poppers are clamped to the Radix
    available-height/width viewport vars with a scrolling viewport — long lists (child ages,
    hotel catalogs) can no longer grow past the frame. (b) Child ages are 0–12 (was 0–17),
    enforced in `travelerSchema` and the occupancy editor. (c) New-request `paying` defaults
    to 1, deliberately not `adults + children`, so the auto-follow logic leaves it alone.
    (d) An empty editable itinerary auto-generates from the travel dates and saves immediately
    (once per version id, guarded against StrictMode; the PUT takes the day list explicitly so
    it never depends on state timing). (e) The itinerary day picker separates private-vehicle
    tours from per-seat group tours — `needsVehicle()` no longer keys on the TRANSPORTATION
    category, which had been attaching "· Sedan" to per-seat group tours — and groups the rest
    into friendly sections with a name search. (f) Hotel display names never double the "N★"
    prefix (`hotelDisplayName`). (g) The departure day (`date >= endDate`) shows a muted "no
    overnight needed" hint instead of the amber no-stay warning, because nights span
    [startDate, endDate). (h) `money()` displays long engine decimals rounded to 2dp —
    display-only formatting, stored values are never recomputed client-side.
24. **Flexible validator model (v0.10.0), superseding the no-self-approval rule.** Any active
    user is assignable as validator — `assertAssignableValidator` no longer checks the role,
    and the owner may assign themselves (`SELF_ASSIGNMENT` and `SELF_APPROVAL` errors are
    gone). Assignment, not the VALIDATOR role, is what grants review rights: `review()` still
    requires the current active assignment, reassign still revokes the former validator, and
    APPROVE is still blocked on engine BLOCKER issues. Users without a travel role enter the
    module when they hold an active assignment (`canAccessTravel` in `lib/travel/access.ts`,
    used by both the API guard and the page gates); since W2 (perm-travel) they additionally
    need the effective `travel.access` permission (and `travel.review` to decide,
    `travel.internal.download` for INTERNAL sheets — D2), granted per user by an admin; the
    assignment stays a runtime record-level check on top. Their request list and request details are
    scoped to own + assigned requests (existence of anything else is not disclosed), while
    per-action RBAC still applies. The validator picker reads the new
    `GET /api/travel/users/assignable` (any travel actor) instead of ADMIN-only `/api/users`.
    Admin → Users manages all four roles and the WhatsApp `phone` field.
25. **WhatsApp document delivery (v0.10.0).** `submit()` now creates the INTERNAL quotation
    document in the same transaction (idempotency key `internal-<versionId>`; resubmission
    rebinds the row to the new snapshot and re-renders), renders it post-transaction, and
    best-effort WhatsApps it to the assigned validator's phone plus the configured
    `TravelSettings.validatorGroupJid` (a `…@g.us` group, editable in Travel → Settings —
    superseded by the validator user group in v0.11.0, see decision 26).
    `issue()` does the same for the CLIENT document to owner + validator + group. Manual
    delivery: `POST /api/travel/documents/[id]/send` (owner / assigned validator / ADMIN)
    takes `{ userIds, groupJids }` and reports per-recipient success; INTERNAL recipients are
    restricted to ADMIN/VALIDATOR roles or the assigned validator (margins inside). All
    delivery goes through `lib/travel/whatsapp-docs.ts`, never throws into the workflow, and
    writes `QUOTE_DOCUMENT_SENT` audit entries. Advisors never see INTERNAL documents, not
    even as list metadata. **Superseded by the W2 int-lock:** INTERNAL documents are no
    longer delivered at all — `submit()` only renders the sheet, the send route rejects
    INTERNAL ids with 403 for every actor (including ADMIN), and `sendQuoteDocument()`
    refuses INTERNAL for every target (users and groups) at send time, auditing the attempt
    as `QUOTE_DOCUMENT_SEND_REFUSED`.
26. **Virtual validator user group (v0.11.0).** The validator "group" is a list of users, not a
    WhatsApp group: `TravelSettings.validatorUserIds` (JSON array, validated as active users in
    the settings route) replaces the `validatorGroupJid` column (kept for data, unused). Submit
    fans out text notifications to owner + assigned validator + group members (deduped) and
    used to WhatsApp the INTERNAL costing sheet to the assigned validator and each group
    member individually (removed by the W2 int-lock — INTERNAL sheets are never sent);
    issue does the same with the CLIENT PDF. The former INTERNAL visibility rules in
    `whatsapp-docs.ts` are gone with the int-lock. `createRequest`
    auto-assigns the first active group member as the validator (via `setValidator` semantics,
    quietly — no notification when nothing is replaced) so submit never blocks on a missing
    assignment. Decision rights stay with the single assigned validator; group membership only
    adds visibility.
27. **Template-driven request creation (v0.11.0).** `TemplateVersion.scenariosJson` (new nullable
    column) holds default hotel scenarios with RELATIVE dates (`checkInOffset`/`nights` against
    the request startDate, slim allocations — capacity fields are filled from the linked hotel
    product at instantiate), and `daysJson` day services upgrade from plain labels to structured
    `{ serviceProductId, label, quantity?, vehicleTypeId? }` (legacy strings still accepted,
    normalized like `normalizeDayServices`; schemas in `lib/travel/templates.ts`). Instantiate
    saves the days (revision 0 → 1), then applies scenariosJson with a second
    `saveVersionContent({ expectedRevision: 1, scenarios })` that replaces the skeleton
    "Option A"/TBD stay; the title defaults to the template name when blank. Editing is
    ADMIN-only via `PUT /api/travel/templates/[id]/versions/[versionId]` (+ the
    `/travel/templates/[id]` editor page), because template changes silently shape every future
    instantiate; nights/days recompute from content (`templateLength()`, scenarios
    authoritative) so the new-request dialog picker — which offers active template versions
    matching the trip's night count — stays accurate. Imported workbook templates keep
    label-only days until edited.
28. **Line-level cost visibility for the request owner (v0.11.0).** `ScenarioResult` gained
    `lines`: per-service-line net costs `{ ref, label, category, basis, currency, unitRate,
    quantity, participants, amountSource (CATALOG/MANUAL/OVERRIDE/INCLUDED/MISSING), amountAmd,
    amountQuote }` plus `serviceProductId`/`date`/`vehicleTypeId` passthrough so editors key
    lines by (product, date, vehicle); `NightlyCharge` rows carry `amountAmd`/`amountQuote`.
    Conversions happen once FX is known; FX failure leaves nulls rather than partial truths.
    Day-service `quantity` is written onto the linked ServiceLine by the day-linked sync
    (created AND updated/retargeted lines follow the day quantity — manual quantity edits on
    day-linked lines no longer survive, by design; the itinerary stepper is the single editor).
    Redaction rule change: the request OWNER sees the full engine result (the initiator prices
    the request — deliberate operator decision); non-owner advisors remain redacted (and are
    404'd by the routes anyway, so `redactScenarioResult` is now defense in depth). The
    Itinerary tab shows Tours and Tickets & degustations columns with quantity steppers and
    `AMD · quote` line costs from the shared quote preview (first scenario's lines — day-linked
    lines are shared), and the Scenarios tab shows per-stay nightly rates and stay totals.
    INTERNAL documents remain advisor-invisible; only the engine JSON visibility changed.
29. **Tabbed service picker + day-card restyle (v0.11.2).** The itinerary/template service picker
    is a shared `ServicePickerDialog` (search, vehicle second step, custom labels, indicative
    rates) organized into three switchable tabs — Tours (both TRANSPORTATION sections), Tickets &
    degustations, Services (meals, guides, staff costs, …) — with search filtering the active
    tab. Each itinerary panel/chips row has its own add button opening the picker on the matching
    tab. Edit-mode day cards: tidy header row (day/date/city/remove), full-width narrative, two
    bordered panels with real empty states; the read-only view uses the same grouping (which is
    why the service catalog now loads for read-only viewers too — `categoryOf` drives grouping).
    No save/sync/pricing logic changed.
30. **Template management endpoints (v0.12.0).** `POST /api/travel/templates` (ADMIN; code
    uppercased, P2002 → 409) creates a template with v1 as `nights + 1` empty day slots —
    before this, only the workbook import could create templates.
    `POST /templates/[id]/duplicate` copies the latest version's content into `<CODE>-COPY`
    (incremented, P2002-retried against the allocation race); the copy restarts at versionNo 1.
    `DELETE /templates/[id]` hard-deletes template + versions — safe because requests snapshot
    content at instantiate (`QuoteVersion.templateVersionId` is an informational string, no FK)
    and BatchRun references are plain-string history. Versions are deleted explicitly in a
    transaction rather than relying on the schema cascade so behavior does not depend on FK
    enforcement. Audits: TRAVEL_TEMPLATE_CREATED / _DUPLICATED / _DELETED (the TRAVEL_ prefix is
    new; older travel audits are unprefixed).
31. **Request hard delete (v0.12.0).** `DELETE /api/travel/requests/[id]` (ADMIN only) removes
    the request and every child row explicitly in dependency order inside one `$transaction`
    (deliveries → events → assignments → stays → scenarios → days → lines → snapshots →
    decisions → documents → versions → request) instead of trusting the onDelete: Cascade FKs.
    Rendered PDF files are unlinked best-effort after the transaction — a missing file must not
    fail the delete. Audit TRAVEL_REQUEST_DELETED carries package code + title. UI: per-row ✕
    in the requests list and a "Danger zone" card on the Overview tab, both behind confirm
    dialogs. Built to purge test requests from production.
32. **Travel chrome via route layout (v0.12.0).** `app/travel/layout.tsx` renders the module
    chrome once: a new `TravelHeader` client component (sticky backdrop-blur, pathname-derived
    active nav pills, hamburger + user dropdown below md, role badge, sign out) and a slim
    footer with the package version. `TravelShell` survives as a thin compatibility wrapper
    (title/subtitle → exported `PageHeader`) so unmigrated pages (CatalogAdmin, TemplateEditor)
    keep working; restyled pages render PageHeader themselves. New ui primitives: table,
    skeleton, separator, dropdown-menu. Native confirm() calls in RequestDetail (new revision),
    ScenariosTab (remove scenario) and TemplateEditor (discard on version switch) became Dialog
    confirms. CatalogAdmin deliberately got no table rework — it inherits the chrome and a deep
    restyle was out of scope.
33. **Design overhaul (v0.13.0).** Full visual redesign of the travel module (and a light
    restyle of /login): Geist replaces Inter (`geist` package, wired via next/font in
    `app/layout.tsx` + tailwind `fontFamily.sans/mono`); a zinc-ramp token system in
    `globals.css` (zinc-100 page background under white cards, deep-green primary reserved
    for primary buttons and active nav/tab states only, `--radius: 0.75rem`, 8pt spacing,
    13px tables). The v0.12.0 `TravelHeader` top-nav is **deleted** and replaced by
    `TravelSidebar` — a fixed 240px sidebar on lg+ (grouped nav: Work / Library / Admin,
    brand block, user card with sign-out) plus a mobile top bar with a left Sheet drawer
    (new `components/ui/sheet.tsx`). ui primitives restyled (button/input/select/textarea
    h-9 rounded-lg, card/dialog/dropdown/tabs/table/badge/toast) and badge gains
    neutral/warning/success/danger/info variants mapped from status strings in
    `components/travel/utils.tsx`. The itinerary tab drops its outer card for a timeline
    (numbered day rail + connecting line, day cards as the only containment layer), all
    nine CatalogAdmin tables converted from raw `<table>` to the ui Table primitive,
    money columns right-aligned with tabular-nums, and a shared `EmptyState` component
    replaces ad-hoc empty lists. Chat dashboard and admin panel were intentionally left
    untouched except for the global token changes.
34. **Admin-defined catalog ordering (v0.13.1).** `HotelProduct.sortOrder` and
    `ServiceProduct.sortOrder` (both `Int @default(0)`) drive every catalog list and picker:
    the hotels/services GET endpoints order by `[{ sortOrder: "asc" }, { name: "asc" }]`, so
    legacy all-zero rows keep their old alphabetical display until reordered. New ADMIN-only
    endpoints `POST /api/travel/catalog/hotels/reorder` and `.../services/reorder` take
    `{ ids: string[] }` (zod; 400 on empty/duplicates), ignore unknown ids, and rewrite
    sortOrder in one transaction — a full-table list becomes a clean 0..n-1 sequence, while a
    partial list (the Services tab with a category filter) keeps the existing sortOrder slots
    of just those rows so the rest of the catalog does not move (**partial-list slot reuse
    superseded in v0.16.0, decision 39** — it collided across categories on legacy all-zero
    rows). Audit
    `TRAVEL_CATALOG_REORDERED`. UI: CatalogAdmin Hotels/Services tables use
    @dnd-kit (core/sortable/utilities) with a GripVertical handle column, pointer + keyboard
    sensors, optimistic update with revert + error toast on failure; drag is disabled while a
    search query is active (hint shown) because reordering a filtered subset is meaningless.
    No picker re-sorts client-side, so the admin order propagates everywhere automatically.
35. **Readable internal trace (v0.13.2).** The engine's free-text `res.trace` strings and the
    PDF money cells were reformatted for the internal costing sheet: money in trace lines is
    ceiling-rounded and comma-grouped (`displayMoneyCeil`/`groupMoney` in
    `lib/travel/engine/money.ts`), per-night stay lines consolidated into one line per
    (roomType, rate, currency, sourceRef) group, and `RateVersion <cuid>` prefixes stripped
    down to the evidence parenthetical. Display-only — engine math keeps full Decimal
    precision, and issue messages are untouched.
36. **Per-person profit floor, trace table and service details (v0.14.0).** Three changes:
    (a) The policy min-profit floor is now **per paying person**
    (**superseded by v0.15.1, decision 38 — the multiplier is travelers excluding
    infants**):
    `floor = cost + minProfit × travelers.paying` (`computePolicyStage` takes the paying
    count); pre-v0.14.0 snapshots were computed with the flat per-package floor and keep
    their frozen numbers. The Catalog → FX & Policy UI labels the field "Min profit per
    paying person". (b) The internal costing PDF renders ALL money via `displayMoneyCeil`
    (margin as a 1-decimal percentage instead) and replaces the bullet-list calculation
    trace with a structured **Description | Basis | Calculation | Amount** table built purely
    from snapshot data (`res.nightly`, `res.lines`, `res.totals`, policy fields) — the
    free-text `res.trace` strings stay in the snapshot for API/debug but are no longer
    rendered. Contract additions backing it: `CategoryCurrencyTotals.bySourceCurrency`,
    `ScenarioResultLine.amount` (source-currency line total) and
    `ServiceLineInput.vehicleTypeName` (frozen at resolution for "35,000 per Sedan" basis
    text). The client quotation keeps `groupMoney` (decimals preserved). (c) `ServiceProduct`
    gained a nullable `details` column — the long client-facing description; `name` is now
    the short title. Day service items carry `details` end-to-end (picker →
    `ItineraryDay.services` JSON → frozen `displayJson` → client quotation
    "label — details"), and `scripts/split-service-details.ts` splits existing catalog names
    on the first ": " into name/details (run once on the server after deploy).
37. **Shared trace rows in the web Review tab (v0.15.0).** The v0.14.0 calculation-trace
    table is no longer PDF-only: row building moved from `pdf/templates.ts` into pure
    `lib/travel/trace-table.ts` (`buildTraceRows` + `TraceRow`, which adds an optional
    `muted` flag on Total Net/FX subtotal rows — the PDF renderer ignores it, keeping PDF
    output content-identical). `POST /api/travel/versions/[id]/calculate` attaches a
    response-only `traceRows` array per scenario (NOT part of the frozen `ScenarioResult`
    contract, never persisted, and withheld from the advisor-redacted branch like all
    costing internals). `GET /api/travel/requests/[id]` rebuilds the same rows at read time
    from the frozen `CalculationSnapshot.inputsJson` + each scenario's `resultJson` and
    exposes them as `scenarios[].traceRows`, following the exact resultJson redaction rule
    (`inputsJson` itself is consumed server-side only). The Review tab summary table gained
    Cost / Profit / Margin % columns plus a per-scenario collapsible "Calculation
    breakdown" (`components/travel/TraceTable.tsx`, shadcn Table with right-aligned
    tabular-nums amounts, bold Sell/Profit, muted subtotals); the submit dialog offers the
    same breakdown above the Sell line. `useQuotePreview` carries a `traces` map keyed by
    scenario ref alongside `results`, wired through `DetailContext.quoteTraces` (live
    preview for editable versions, frozen snapshot rows otherwise).
38. **Min-profit floor per traveler excluding infants (v0.15.1).** Supersedes the v0.14.0
    per-paying-person multiplier: `floor = cost + minProfit × max(0, adults + children −
    infants)` — `children` is the 0–12 count and already includes infants (the childAges ≤
    `TravelSettings.infantMaxAge` subset derived in `workflow.ts`), so subtract; the clamp
    guards manual overrides that leave infants > children. `computePolicyStage`'s parameter
    is renamed `payingPax` → `floorTravelers` (the count is derived at the `engine.ts` call
    site); the engine trace reads `(3 travelers × 50 USD) + 651 = 801`, and the trace-table
    Policy floor row uses the same derivation with basis text "per traveler (excl. infants)".
    Labels updated in Catalog → FX & Policy ("Min profit per traveler (excl. infants)" /
    "Min profit / traveler") and the internal PDF policy table. Snapshots frozen before
    v0.15.1 keep their per-paying floor numbers (historical record); `paying` remains the
    denominator for per-paying-person price displays and PER_PERSON service pricing.
    Adjacent fix: QuoteSummaryBar and the ReviewTab summary/submit dialog no longer show
    Sell / per-paying figures for an INVALID scenario result — the engine's bare-cost
    fallback sell was misleading next to FAILED, so they render "—".
39. **Catalog deletes, reorder fix, dd-mmm-yyyy dates, dialog layout, narrative auto-fill
    (v0.16.0).** A UI-batch release: (a) Hard deletes with guards — DELETE on catalog
    hotels/services (409 while stays/service lines still link the product; rate versions go
    along, audited `HOTEL_DELETED`/`SERVICE_DELETED`), FX rates (409 on the last rate of a
    currency, `TRAVEL_FX_DELETED`) and policy versions (409 on the active or last policy;
    a stale `TravelSettings.defaultPolicyId` is cleared in the same transaction,
    `TRAVEL_POLICY_DELETED`). (b) Catalog reorder moved to shared `lib/travel/reorder.ts`
    (`applyCatalogReorder`): the submitted ids are spliced into the positions they already
    occupy in the canonical `[sortOrder, name]` sequence, then the WHOLE column is rewritten
    to 0..n-1 in one transaction — the v0.13.1 partial-list slot reuse collided with other
    categories' values on legacy all-zero rows. (c) All user-facing dates render as
    dd-mmm-yyyy via `formatDisplayDate`/`formatDisplayDateRange` (`lib/travel/engine/dates.ts`;
    passthrough, never throws) and every `<Input type="date">` is replaced by
    `components/travel/DateField.tsx` — a dependency-free calendar popover (no popover
    primitive exists in components/ui) with min/max day disabling; engine issue messages and
    package codes keep quoting raw ISO input verbatim. (d) The new-request dialog
    (RequestsList) groups agency + dates + template, filters the template picker to versions
    matching the trip length once dates are set, and guards empty dates in submit (DateField
    has no native `required`). (e) ItineraryTab narrative auto-fill: adding a TRANSPORTATION
    service with catalog `details` fills a blank (or verbatim-auto-filled) day narrative from
    it, and removing that service clears the narrative only while untouched — tracked by
    string equality, so user-typed text never moves.

## Known limitations

- **Split groups (parallel hotels on the same night) are blocked** in v1: any two stays covering
  one night raise `NIGHT_OVERLAP`. The spec allows parallel hotels with disjoint traveler
  allocations, but the current contract has no per-stay traveler subsets to prove disjointness,
  so the conservative block is deliberate until per-stay allocation is modeled.
- The original xlsm is absent: agreement-image rates (67 images) were not re-verified;
  conflicting/ambiguous rates are staged as NEEDS_REVIEW with evidence anchors.
- `RateVersion.weekdays`/`minStay` are stored but not yet enforced during resolution
  (weekday departures validated for shared tours only via product metadata display).
- Template instantiation copies itinerary days AND, since v0.11.0, catalog-linked day services
  (priced automatically) plus default hotel scenarios; templates without structured content keep
  label-only days until edited in the template editor (see decision 27).
- Batch pricing prices stays + template structure per PAX band; it does not reproduce the
  workbook's broken Mass Calculation totals (intentionally).
- WhatsApp notifications require the linked session to be `ready`; failures are visible and
  retryable, and never block or reverse workflow transitions.
- Day-linked service lines are **shared across scenarios** (`scenarioId = null`), not priced
  per scenario — a scenario-specific catalog service still needs a manual scenario-bound line.
- Itinerary `overnightCity` derivation reads the **first scenario's** stays only; multi-scenario
  packages with different routings need manual city edits on the remaining days.
