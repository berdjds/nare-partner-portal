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

- [ ] **TR-UX-002 — Unchanged B2B redesign audit:** I ran the original
  `doc/b2b-cycle-1/evidence/redesign-audit.mjs`, without editing it, against
  the branch local production build on `http://localhost:3000`. The run is
  acceptable only when its terminal summary is exactly `60/60 passed`. Actual
  result, recorded verbatim (not a generic audit check): ____________________

### Owner / PO local evidence runbook

These browser scripts are **owner/PO manual pre-release gates, not CI**. Use
only throwaway local worktrees and SQLite files, with no staging or production
deployment. “Seeded database only” means a newly created database followed only
by the seed commands below: do not import an existing database and do not submit
a fixture application. Run the steps in order and keep only one server running
at a time. Stop a server with `Ctrl+C` in its terminal before starting the next
one.

1. From the repository root, create two new worktrees. Replace
   `<review-branch>` with the review branch name; use previously unused `/tmp`
   paths rather than reusing worktrees or databases.

   ```bash
   git worktree add --detach /tmp/wacontrol-ux-before ac4e78d
   git worktree add /tmp/wacontrol-ux-after <review-branch>
   ```

2. Build and seed the detached baseline. In the baseline server terminal, run:

   ```bash
   cd /tmp/wacontrol-ux-before
   export DATABASE_URL='file:/tmp/wacontrol-ux-before.db'
   export NEXTAUTH_URL='http://localhost:3000'
   export NEXTAUTH_SECRET='local-ux-evidence-only-0123456789abcdef'
   export ADMIN_EMAIL='admin@example.com'
   export ADMIN_PASSWORD='admin123'
   npm ci
   npx prisma generate
   npm run db:push
   npm run db:seed
   npm run build
   npm start
   ```

   Leave this local production server running on port 3000. In a second
   terminal, invoke the branch-only evidence scripts from the branch worktree
   against the baseline server:

   ```bash
   cd /tmp/wacontrol-ux-after
   node doc/ux-polish-1/evidence/ux-audit.mjs --base http://localhost:3000 --label before
   node doc/ux-polish-1/evidence/headers-fetch.mjs --base http://localhost:3000 --label before
   ```

   Stop the baseline server with `Ctrl+C` and confirm that its terminal has
   returned before continuing.

3. Build and seed the review branch separately. In the branch server terminal,
   run:

   ```bash
   cd /tmp/wacontrol-ux-after
   export DATABASE_URL='file:/tmp/wacontrol-ux-after.db'
   export NEXTAUTH_URL='http://localhost:3000'
   export NEXTAUTH_SECRET='local-ux-evidence-only-0123456789abcdef'
   export ADMIN_EMAIL='admin@example.com'
   export ADMIN_PASSWORD='admin123'
   npm ci
   npx prisma generate
   npm run db:push
   npm run db:seed
   npm run build
   npm start
   ```

4. With only the branch production server running on port 3000, capture the
   after evidence in a second terminal, then run the unchanged original B2B
   redesign audit. Its existing local browser, seeded-preview-account and
   password-file prerequisites remain mandatory; do not edit the script or add
   fixture submissions to make it pass.

   ```bash
   cd /tmp/wacontrol-ux-after
   node doc/ux-polish-1/evidence/ux-audit.mjs --base http://localhost:3000 --label after
   node doc/ux-polish-1/evidence/headers-fetch.mjs --base http://localhost:3000 --label after
   node doc/ux-polish-1/evidence/headers-fetch.mjs --diff
   mkdir -p /tmp/wacontrol-ux-after/doc/ux-polish-1/evidence/redesign-after
   set -o pipefail
   node doc/b2b-cycle-1/evidence/redesign-audit.mjs http://localhost:3000 /tmp/wacontrol-ux-after/doc/ux-polish-1/evidence/redesign-after 2>&1 | tee /tmp/wacontrol-ux-after/doc/ux-polish-1/evidence/redesign-audit-after.txt
   ```

   The original audit must finish with the actual summary **`60/60 passed`**;
   any other count or a failed run blocks this gate. Record that actual summary
   verbatim in the PO and independent-reviewer TR-UX-002 checklist lines and retain
   `redesign-audit-after.txt`. A generic statement that the audit ran is not
   sufficient. Stop the branch server with `Ctrl+C` when all captures finish.

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
- [ ] **TR-UX-002 — Unchanged B2B redesign audit:** I independently verified
  that the unedited original `doc/b2b-cycle-1/evidence/redesign-audit.mjs` ran
  against the branch local production build on `http://localhost:3000`, and
  checked its retained output. The required result is exactly `60/60 passed`.
  Actual result, recorded verbatim (not a generic audit check):
  ____________________
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
