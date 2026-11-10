# Phase 3: routed new-request flow, client vs internal notes, template review notice

Branch `feat/portal-b2b-cycle-1`. Not merged, pushed, deployed or migrated.

## What changed
* **`/travel/requests/new`** replaces the modal. Same gates as `POST /api/travel/requests` (travel.access + travel.create, ADMIN/ADVISOR); partners go to `/partner`, others back to the list. Sections: 1 Agency (agency, optional agency reference), 2 Dates & template, 3 Travellers (adults/children with each child's age, infants, paying, complimentary, leaders, staff), 4 Client requirements, 5 Review summary. A section nav, a sticky action bar, one error summary plus per-field messages (`role="alert"`, `aria-invalid`, focus moves to the first invalid field).
* **Safe behaviour:** entered values are kept in the tab (sessionStorage) across reload/back and cleared on success or "Start over"; a leave warning and a confirm on Cancel/Back when there is unsaved input; a synchronous in-flight guard plus a disabled button prevent duplicate submissions; a template that no longer fits changed dates is cleared with a visible message.
* **Notes:** new additive `TravelRequest.clientNotes` = "Client messages and notes" (visible to the agency). Existing `notes` is unchanged in meaning and now labelled "Internal notes (staff only)"; existing data stays internal by default. Partners receive `clientNotes` only; a test proves internal notes never reach them.
* **Template flow:** instantiating from a template now stamps the Phase 2 rules immediately; the request detail page lists every flagged or not-applicable template item (`TemplateReviewNotice`), so conflicts are no longer silent.
* **Accessibility fixes found by axe in the browser run and fixed:** unlabeled traveller number inputs, unnamed stepper buttons, unnamed status filter, low-contrast sidebar captions, error text colour.
* Client validation (`lib/travel/new-request-form.ts`) mirrors the server limits and invents no business rule (for example `paying` is not forced to equal adults + children).

## Evidence
* Tests: see the final report; new files `tests/request-flow/*`.
* Chromium (isolated trial-mode server, throwaway database, no WhatsApp, no production data): `evidence/phase3/browser-results.json`, 37/37 checks at 1366, 820 and 390 px, screenshots in `evidence/phase3/`. `browser-phase3.mjs` and `seed-phase3.ts` reproduce it. The last one-line colour change to the error-summary box (token classes instead of raw palette classes, required by the design guard test) was not re-run in the browser.

## Migration and rollback
Additive nullable column `TravelRequest.clientNotes`. Rolling the code back ignores it.

## Not done / open
* Submit is not blocked by template review flags (warn only); blocking needs an acknowledgement design.
* The pre-creation page shows no price (the sell-side figure appears after creation, on the detail page).
* Translations and company/contact settings are Phase 4; visual redesign and favicon Phase 5. The new page uses the existing shell and tokens.
* The worktree's installed packages were stale (Next 14.0.4); `npm install --ignore-scripts` aligned only this worktree's `node_modules` with `package.json` (no tracked file changed). The shared checkout still has the stale install.
