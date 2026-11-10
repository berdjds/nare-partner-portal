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
* Chromium (isolated trial-mode server, throwaway database, no WhatsApp, no production data): `evidence/phase3/browser-results.json`, 37/37 checks at 1366, 820 and 390 px, screenshots in `evidence/phase3/`. `browser-phase3.mjs` and `seed-phase3.ts` reproduce it. After the independent review the run was repeated: 43/43 checks (adds Enter-key submit on an invalid form, every invalid field linked and aria-invalid, touch target size, real cancel/draft-clear assertions).

## Migration and rollback
Additive nullable column `TravelRequest.clientNotes`. Rolling the code back ignores it.

## Not done / open
* Submit is not blocked by template review flags (warn only); blocking needs an acknowledgement design.
* The pre-creation page shows no price (the sell-side figure appears after creation, on the detail page).
* Translations and company/contact settings are Phase 4; visual redesign and favicon Phase 5. The new page uses the existing shell and tokens.
* The worktree's installed packages were stale (Next 14.0.4); `npm install --ignore-scripts` aligned only this worktree's `node_modules` with `package.json` (no tracked file changed). The shared checkout still has the stale install.

## Independent review (read-only) and what changed
No high finding. Fixed: **M1** a failed rule application after instantiate is logged on the server, the client opens the request with a `templateRules=failed` banner and an "Apply template rules" retry (tested through the route with the recalculation forced to fail; only an error code reaches the client); **M3** the draft is stored per user and cleared on sign-out; **L1** no double leave prompt; **L2** a half-entered date range no longer clears the template and a template list that fails to load clears the choice visibly; **L3** date fields and the traveller group are linked to their errors, one summary alert only; **L4** touch targets are 44 px on phones; **L5** the client-only "at least one traveller" rule was removed; the partner page now shows the agency's own messages; the hint reads "Shared with the agency on this request."

Open owner decision (from the review, M2): `clientNotes` are visible to the agency through the API as soon as the request exists, including while it is still a DRAFT. Decide whether draft-stage client messages should be hidden until the quotation is issued. Not changed, because it alters what the agency sees.
Remaining low items: source-string UI tests cannot prove behaviour (the browser run covers it); no component-level unit tests exist for draft restore.
