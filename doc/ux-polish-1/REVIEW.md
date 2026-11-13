# UX SP-1 review: TR-UX-005 and TR-UX-006

This record is completed by the PO and the independent reviewer. Their
pre-release checks and sign-offs must be recorded before the owner's explicit
`release` approval. Post-deploy smoke results are added after deployment.

## PO checklist

### Before and after evidence

- [ ] **TR-UX-005 — Defect baseline approved:** before the branch build, I
  approved `doc/ux-polish-1/DEFECTS.md` §1.3, with one "before" screenshot per
  defect captured from a local production build of `ac4e78d`.
- [ ] **TR-UX-005 / TR-UX-006 — Before audit:** I checked the audit output from
  `evidence/ux-audit.mjs` and `evidence/headers-before.txt` from
  `evidence/headers-fetch.mjs`, produced from the local production build of
  `ac4e78d` with the seeded database only.
- [ ] **TR-UX-005 / TR-UX-006 — After audit:** I checked the corresponding
  after-audit output and `evidence/headers-after.txt`, produced from a local
  production build of the review branch with the seeded database only. No
  branch was deployed to staging.
- [ ] **TR-UX-005 / TR-UX-006 — Header diff:** I compared
  `evidence/headers-before.txt` against `evidence/headers-after.txt`; the
  response headers are identical apart from `Date`, `ETag` and nonce values.
- [ ] **TR-UX-005 / TR-UX-006 — No real data:** every captured form value comes
  from a named fixture in `evidence/fixtures.json`. Server-reject and
  upload-fail states were captured with a stubbed route; no application was
  submitted on staging or production. No admin or partner pages and no real
  licence files were captured. I confirm that no real email, phone, licence or
  application is visible in the evidence.
- [ ] **TR-UX-006 — Protected paths:** I reviewed `git diff ac4e78d` and
  confirmed that it contains no changes to `.github/`, `Dockerfile`,
  `docker-compose.yml`, `deploy.sh`, `deploy-vps.sh`, `package.json`,
  `package-lock.json`, `.env`, `prisma/schema.prisma`, `prisma/migrations/`,
  `AGENTS.md`, `.claude/` or `.mcp.json`.

### Release and rollback

- [ ] **TR-UX-005 — Release path:** the ledger phase for UX SP-1 is complete;
  there is one PR with CI green, as for PR #20; and the owner, as sole
  approver, gave the explicit `release` approval before merge. There was no
  direct push to `main`; merging runs the `main` deploy gate for staging and
  production. REQ-2026-0016 and REQ-2026-0017 are not live; if either goes
  live before release, the owner decides whether to switch paths.
- [ ] **TR-UX-005 — Release timing and rollback:** release is outside working
  hours and allows a short production write freeze. Rollback is a revert of
  the PR, running the gate again, with the gate's retained `previous` image as
  fallback. There is no schema or data change.

### Post-deploy smoke

- [ ] **TR-UX-005 — Staging:** `/`, `/partners/apply`, `/login`,
  `/forgot-password`, `/reset-password`, `/terms` and `/privacy` each returned
  200, and one login round trip with a test account succeeded.
- [ ] **TR-UX-005 — Production:** the same seven public routes each returned
  200, and one login round trip with a test account succeeded.

PO name: ____________________  
Pre-release review date: ____________________  
Post-deploy smoke date and result: ____________________

## Independent-reviewer checklist

### Evidence review

- [ ] **TR-UX-005 / TR-UX-006 — Before audit:** I independently checked that
  the before-audit output and `evidence/headers-before.txt` came from a local
  production build of `ac4e78d` with the seeded database only, and that
  `DEFECTS.md` §1.3 has one PO-approved "before" screenshot per defect.
- [ ] **TR-UX-005 / TR-UX-006 — After audit:** I independently checked that
  the after-audit output and `evidence/headers-after.txt` came from a local
  production build of the review branch with the seeded database only, with no
  branch deployment to staging.
- [ ] **TR-UX-005 / TR-UX-006 — Header diff:** I independently compared
  `evidence/headers-before.txt` with `evidence/headers-after.txt` and confirmed
  that the response headers are identical apart from `Date`, `ETag` and nonce
  values.
- [ ] **TR-UX-005 / TR-UX-006 — No real data:** I traced every captured form
  value to a named fixture in `evidence/fixtures.json`; confirmed stubbed
  routes for server-reject and upload-fail captures; and confirmed that no
  application was submitted on staging or production. No admin or partner
  pages or real licence files were captured, and no real email, phone, licence
  or application is visible.
- [ ] **TR-UX-006 — Protected paths:** I independently reviewed
  `git diff ac4e78d` and confirmed no changes to `.github/`, `Dockerfile`,
  `docker-compose.yml`, `deploy.sh`, `deploy-vps.sh`, `package.json`,
  `package-lock.json`, `.env`, `prisma/schema.prisma`, `prisma/migrations/`,
  `AGENTS.md`, `.claude/` or `.mcp.json`.
- [ ] **TR-UX-005 — Release controls:** I confirmed the completed UX SP-1
  ledger phase, one PR with CI green as for PR #20, no direct push to `main`,
  and the owner's explicit `release` approval as sole approver before merge.
  The merge runs the `main` deploy gate. REQ-2026-0016 and REQ-2026-0017 are
  not live; any change to that status before release is referred to the owner
  for the release-path decision. The release is outside working hours, and the
  PR-revert rollback and retained `previous` image fallback remain available.

### Post-deploy smoke

- [ ] **TR-UX-005 — Staging:** all seven public routes (`/`,
  `/partners/apply`, `/login`, `/forgot-password`, `/reset-password`, `/terms`
  and `/privacy`) returned 200, and one test-account login round trip
  succeeded.
- [ ] **TR-UX-005 — Production:** the same seven public routes returned 200,
  and one test-account login round trip succeeded.

Independent reviewer name: ____________________  
Pre-release review date: ____________________  
Post-deploy smoke date and result: ____________________

## Benefits eyebrow specification note

Keeping the Benefits eyebrow style on `h2#benefits-heading` would require a
spec change. The FR-UX-005 h2 scale rule is unconditional: it allows no
exception beyond the hero h1 and the legal-body h2s.

## Owner / PO decisions

- [ ] **Decision 1 — FR-UX-006 search scope:** code only, or code plus
  `doc/design-system.md` lines 271–273. If the documentation is included, the
  owner explicitly approves touching `doc/design-system.md`, limited to the
  sentences at lines 271–273 that describe `components/landing/Footer.tsx` and
  the compact footer. Decision and, if applicable, explicit owner approval:
  ____________________
- [ ] **Decision 2 — Should items:** keep or drop FR-UX-003, FR-UX-004 and
  FR-UX-010. Decision for each item: ____________________
- [ ] **Decision 3 — Version bump:** approve or reject the `package.json`
  version bump as a separate final task. Decision: ____________________
