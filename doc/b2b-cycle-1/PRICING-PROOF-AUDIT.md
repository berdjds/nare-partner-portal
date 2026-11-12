# Production-template pricing audit (read-only export, 2026-11-12)

Source: read-only export of the production database's template, catalogue, rate, FX and policy tables (opened `mode=ro`, no client/agency/request/user data). The export file is kept out of git on the dev server (`~/inbox/templates-export.json`). Production was not modified.

## What production holds
13 templates (all ACTIVE), 98 service products, 332 rate versions (299 VERIFIED, 33 NEEDS_REVIEW), 34 hotel products, 4 vehicle types, 2 FX versions, 2 pricing policies (one active: General B2B, markup 16%, minimum profit 50 USD, rounding increment 1).

## Result: the proof cannot be completed, release stays blocked
The owner's condition was to stop if a rule is missing or ambiguous. Both are the case.

| Rule required | Finding in production data |
|---|---|
| Child / infant ages and prices | No field and no text anywhere. Template days carry only `dayOffset` and `narrative`; service products have no age band. |
| Complimentary / leader / staff | Only product names (4 TOUR_LEADER per-person items, 5 STAFF_MEALS) with no free-for-leader rule. |
| Free ratios (e.g. 1 free per N) | None. |
| Minimum / maximum travellers | None (`minStay` and `weekdays` empty on all 332 rates; capacity set on 4 of 98 services). |
| Optional items | One label only: "Wings of Tatev* (opt)" inside free text. |
| Tickets and degustations grouping | 19 TICKETS products (17 per person, 2 capacity blocks); no per-item child or free rule. |
| Room allocation | Engine checks capacity from hotel products; occupancy rates are SGL/DBL/TPL/EXTRA_BED/UNIT. 2 notes flag ambiguous per-occupancy vs whole-unit pricing. |
| Per-item rounding | Only the policy-level increment (1); no per-item rounding. |
| Template scenarios | `scenariosJson` empty on all 13 templates. |

Rate data quality: `validFrom` is empty on all 332 rates; 96 carry seasonality only as unparsed free text; 21 notes say "unverified", 20 say "TBD", 4 rates are quote-on-request and 4 are stop-sales.

## Decision needed from the owner
Name the business rules (child and infant age bands and percentages, free-for-leader and free-ratio items, min/max travellers, optional items, per-item rounding) for a reference template, or confirm that today's behaviour (children pay as guests, infants by `infantMaxAge`) is the intended production behaviour. Then each rule gets a focused test and the proof can close.
