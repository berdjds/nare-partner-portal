# Phase 6 (offline items): owner decisions that need no production-template access

Branch `feat/portal-b2b-cycle-1`. Nothing merged, pushed, migrated, restarted or deployed.

| Owner decision | Result | Proof |
|---|---|---|
| 2. Agencies may see draft client notes | Already true in `partnerRequestDetail` (no status filter); now locked by a test on a DRAFT request, including the internal note staying hidden and another agency getting nothing. | `tests/request-flow/client-notes.test.ts` |
| 3. Assigned advisors may see `rateOverrides`; nobody else without internal access | The owning advisor now keeps the stay `rateOverrides` on every status (previously drafts only). Supplier unit rates, override reasons and provenance stay hidden. An ungranted validator gets `null`; an advisor who does not own the request gets 404. | `tests/permissions/internal-view-redaction.test.ts` |
| 4. DeepSeek approved | Adapter, send guard, approval and audit already in place. **Not configured on this server**: `TRANSLATION_PROVIDER` and `DEEPSEEK_API_KEY` are absent, so no live translation was run. `scripts/check-translation-provider.ts` reports status without printing the key (`--live` sends one fixed harmless sentence; exit 2 = not configured, 3 = call failed). The key stays with the owner: set both variables in the production env file, then run the script on the server. | `tests/i18n/provider-check.test.ts` |
| 5. English and Armenian active, Arabic architecture only | Unchanged. **No native Armenian linguistic review has taken place.** The Armenian strings (including the new service-card sentences) are machine-assisted drafts accepted by the owner for launch; they remain unreviewed. | - |
| 6. Copy, trust strip, labels, table label, hero | Service cards reworded to plain descriptions (no "comprehensive", "complete", "specialized"); the trust strip no longer repeats the benefits (shows the founding year from the contact config, hidden when absent); Settings text fields use `htmlFor`/`id`; `Table` region label is localized (`table.region`) and overridable. | `tests/ui/phase6-offline.test.ts`, `tests/ui/settings-a11y.test.ts` |
| Hero photography | **No approved photography exists locally.** `Nare-Travel-and-Tours/public` holds only logos and `noise.png`; the images under `travel-platform` belong to a different product and were not used. The current typographic hero stays. Missing file: an approved Nare photograph, e.g. `public/brand/hero.webp` (about 1920x1080, with alt text and licence/ownership confirmation). | - |

Not done: the remaining ~45 aria-label-only label/control pairs in the admin screens are still not tied with `htmlFor`/`id` (they satisfy "label in name"; click-to-focus is missing). RTL Sheet slide direction stays documented while Arabic is disabled.

## Production-template export needed to prove pricing (blocks release)

Run on the VPS against the production SQLite file (opened read-only, no client/agency/user/contact/credential data), then place the file in `~/inbox/` on the dev server:

```
python3 scripts/export-templates-readonly.py /path/to/production.db > templates-export.json
```

Tables exported: PackageTemplate, TemplateVersion (daysJson, scenariosJson, provenance), ServiceProduct, RateVersion, HotelProduct, VehicleType, FXRateVersion, PricingPolicyVersion, and TravelSettings (id, companyTz, defaultPolicyId only). The file contains supplier rates: treat it as confidential, keep it out of git.
Alternative: an owner-made copy of the latest production backup restored to an isolated path, read with the same script.
