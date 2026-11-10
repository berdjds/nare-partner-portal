# Phase 2: template-driven recalculation (R-CALC) and owner decisions applied first

Branch `feat/portal-b2b-cycle-1`. Not merged, pushed, deployed or migrated.

## Owner decisions applied before Phase 2
1. **/calculator** is an internal costing workbook. The page now requires the central `travel.internal.view` permission (ADMIN and VALIDATOR presets, or an explicit grant); plain USER, ungranted ADVISOR and PARTNER are redirected server-side, the nav link follows the same key, and a test proves nothing else serves the workbook file (no API, no static copy). Note: granting the key to a non-admin is still subject to the existing permissions-report confirmation lock.
2. **Advisors never see supplier rates, costs, margins, markups or internal calculations.** Catalog amounts, policies, imports and template markups were already withheld (Phase 1). Price guidance is a server-computed sell-side figure (`lib/travel/guidance.ts`): allow-list redaction, issues reduced to `{code, severity}`, no message text. Tests walk the whole payload for forbidden keys and policy values.

## Evidence used (what "inspected ARM-S26-0506A" means here)
The reference template's production record (its day-by-day services) lives in the production database, which this work does not read. What is in the repository is the workbook it was imported from (`doc/travel/Workbook-Evidence.json`, 449 KB) and the import mapper. From the "Mass Calculation" and "Tour Calculator" sheets (ARM-S26-0506A "Armenia Grand Tour - Jermuk Edition", 5 nights / 6 days, pax bands 2/4/6; ARMGG/ARMG/ARM variants):
* items are tied to days and are charged per person x pax band (x2, x4, x6) or per group;
* "Tickets & Degustations" is a block of unit price x quantity lines;
* shared "Group Tour" items run on fixed weekdays ("Wed-Fri-Sun", "Tue-Thu-Sat", "Mon-Fri-Sun");
* Tour Leader lines (tickets, meals, accommodation SGL/DBL) and Guide lines (overnight, lunch, dinner) are charged for leaders/guides, not guests;
* per-person price is rounded up to a whole unit (`ROUNDUP`), already covered by the pricing policy rounding increment;
* the workbook has no child, infant, complimentary or free-ratio rule (zero hits), and a "(opt)" appears only inside a label.

## Rule vocabulary (strict schema, optional per template service, absent = old behaviour)
| Rule | Evidence | Behaviour |
|---|---|---|
| `appliesTo` (adult, child, infant, complimentary, leader, staff) | Leader and Guide lines | participants = sum of those counts; 0 => line inactive (not charged), no conflict |
| `minParticipants` / `maxParticipants` | group tours | inclusive; a breach flags `BELOW_MIN`/`ABOVE_MAX` for review, never removes or reprices |
| `weekdays` (ISO 1-7) | "Wed-Fri-Sun" | date outside => `WEEKDAY_UNAVAILABLE` flag |
Basis (per person / group / capacity block), quantity, category, currency and day association keep coming from the catalog product and the template day, as before. Unknown keys are rejected, so no unreviewed rule can enter a template.

## How recalculation works
* `lib/travel/template-rules.ts` and `lib/travel/recalc-plan.ts` are pure and deterministic. `recalculateFromTemplate` (workflow) applies them: re-dates days from the start date, adds/removes template items (manual items untouched), stamps lines (`origin=TEMPLATE`, `templateKey`, `derivedJson`), sets participants / inactive / review flags.
* A line whose participants no longer match what was last derived was edited by hand: it is kept and reported (`MANUAL_OVERRIDE_KEPT`); a hand-edited quantity is kept (`QUANTITY_MANUAL_KEPT`); a template item that was edited and then removed from the template stays (`REMOVED_FROM_TEMPLATE_KEPT`).
* Stays and room allocations are **not** edited; mismatches are flagged (`STAYS_NEED_REVIEW`, `ROOMS_NEED_REVIEW`).
* Optimistic lock on `TravelRequest.revision` (409 on stale), idempotent (second run writes nothing, no revision bump, no audit row), snapshot invalidated on change, one `travel.recalc` audit row per change. `PATCH /requests/[id]` re-derives automatically when travellers or dates change; `POST /requests/[id]/recalculate` does it on demand and for a template switch. The editor round trip keeps the stamp. The template editor keeps rules through a save.
* Authorization: owner or ADMIN, editable versions only; partners and non-owner advisors are refused.

## Migration and rollback (additive)
`ServiceLine` gains `origin`, `templateKey`, `derivedJson`, `reviewFlag` (nullable) and `ruleInactive` (default false). No data backfill, no template data changed (`rule` lives inside existing `daysJson`). Rollback: deploy the previous code; the columns are ignored, and old code reads `daysJson` without the unknown `rule` key. Dropping columns is optional and not required for rollback.

## Owner decisions still open (only the affected rule waits; everything else is delivered)
1. **Child and infant rules per item** (free under N, percentage of adult, which tours/tickets/degustations): no workbook evidence. Today infants are counted by the existing age limit (`infantMaxAge`), and children pay as guests. Needed: item list and age cut points.
2. **Complimentary and free-leader ratios** (for example one free per N paying): no evidence. Complimentary travellers are excluded from `paying` as before; `appliesTo: ["complimentary"]` exists but no ratio logic.
3. **Below-minimum / above-maximum behaviour**: flagged only. Decide whether to reprice, remove or block.
4. **Optional items** ("(opt)" in a label): not inferred from labels. Needs an explicit flag and pricing treatment.
5. **Room allocation from traveller counts** (workbook uses pax/2 rooms): flagged, not automated.
6. **Per-item rounding**: the workbook rounds the per-person total up; confirm that the policy rounding increment is enough.
7. **Validate against production templates**: please provide a read-only export of the `daysJson` of ARM-S26-0506A and a few active templates (no client data) so the vocabulary can be checked against the real rows before any rule is authored.
