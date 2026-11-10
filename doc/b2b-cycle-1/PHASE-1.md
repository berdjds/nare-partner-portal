# Phase 1: partner security (R-SEC), evidence

Branch `feat/portal-b2b-cycle-1`. Decisions applied: D1 (PARTNER, one agency), D3 (dedicated internal permission, ADMIN and the request's assigned validator).
Not merged, pushed, deployed or migrated.

## What was built
* `PARTNER` role + nullable `User.agencyId` (additive). Hard permission ceiling: `travel.access`, `travel.client_docs.download` (`PARTNER_CEILING`); overrides cannot lift it, `/api/permissions` refuses out-of-ceiling grants.
* Travel guard is default-deny for PARTNER; three read routes opt in (own-agency list, detail, issued CLIENT document). Allow-list projection in `lib/travel/partner-view.ts`: no costing, notes, workflow, identities; only versions with an issued quotation; prices only for those.
* D3 gate `lib/travel/internal-access.ts` (key + validator needs an active assignment to that request) used by request detail, submit, calculate and INTERNAL download (view and download now agree).
* Catalog rates, hotel/service rates, pricing policies, workbook imports and template `legacyMarkup` need `travel.internal.view` (advisors see structure, `hasRate`, no amounts).
* Partners can never be validators or notification/WhatsApp recipients; becoming a PARTNER deactivates validator assignments.
* `travel.export` audit rows: allowed, denied, unauthenticated and WhatsApp sends; never the file path.
* `/partner` landing and nav; redirect loop closed; `/calculator` blocked for PARTNER; users API binds an active agency and revokes sessions on agency/role change; `GET /api/users` returns `agencyId`.

## Independent review
Read-only reviewer on c86558a: no high finding. Medium M1 (partner as validator/recipient) and M2 (rates/policies open to all staff) fixed. Lows fixed: L1 view/download consistency, L2 `/partner` honours denies, L3 grant cap, L4 audit gaps, L5 internal workflow state hidden, L6 stale text, L7 `agencyId` in users list. Tests strengthened (no conditional asserts; real path value checked; issued-document projection tested).

## Evidence
* Tests: 118 files, 1546 tests pass (baseline 114 / 1475); `tsc --noEmit` clean. New: `tests/partner/*` (default-deny over every `/api/travel` route file, isolation, projection, downloads, audit, users, redirects, review fixes).
* Seven older tests asserted the superseded D2 "admin-only" preset and were rewritten to D3.

## Migration and rollback
`ALTER TABLE User ADD COLUMN agencyId TEXT` plus an index; no data backfill, nothing destructive. Old code ignores the column and gives an unknown role no access, so rolling the code back is safe with the column present. Production would apply it through the existing `prisma db push` deploy path only after approval.

## Behaviour changes to confirm
1. Advisors no longer see supplier amounts in the catalog or the itinerary service picker (amounts show as unavailable). If advisors need price guidance, a sell-side figure must be provided in Phase 2.
2. `/calculator` (internal costing workbook) is still open to every signed-in non-partner, including role USER. Owner decision pending.

## Not covered
No Chromium/screenshot run (only the minimal `/partner` page exists); done with the request flow in Phase 3.
