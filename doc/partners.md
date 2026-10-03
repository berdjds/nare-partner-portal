# Partner Enrollment (B2B)

This document describes the W5b partner enrollment flow (REQ-2026-0004 phase 1):
how new B2B companies apply online with their trade licence, how their KYC
documents are stored, and how Nare staff review, approve or reject
applications. Approval creates an `Agency` record for the travel module.

Out of scope for this phase: partner portal accounts or logins, request
submission by companies, WhatsApp groups, company notifications, automatic KYC
checks, malware scanning and e-signatures (see "What W5c and W5d add" below).

## Data flow

1. **Apply (public, no login).** The applicant fills in the form at
   `/partners/apply` (linked as "Become a partner" from the landing page hero
   and the sign-in page). The page is deliberately outside the authenticated
   app shell, branded like the landing page, and marked `noindex, nofollow`.
   All copy comes from `lib/portal-content.ts` (`PARTNER_APPLY`).
2. **Submit.** The form posts `multipart/form-data` to
   `POST /api/partners/applications` (`app/api/partners/applications/route.ts`).
   The server validates every field, checks the abuse gates (see below),
   verifies the uploaded files by content, and creates the
   `PartnerApplication` plus its `PartnerDocument` rows in a single
   transaction. The reference (`PA-YYYY-NNNN`, e.g. `PA-2026-0001`) is
   generated per year inside the transaction; the unique index on `reference`
   is the real guard and a conflict retries the whole transaction (up to 3
   times). Files are written to disk inside the transaction callback; if the
   transaction fails, the already-written files are removed so no orphaned
   files remain. On success the applicant gets back `{ reference }` and the
   page shows a success view with that reference.
3. **Notify.** Two emails are sent (failures are logged and never affect the
   response): a confirmation to the applicant (reference, "what happens next",
   deliberately no promised dates) and an alert to the Nare address
   (`reservation@nare.am`) pointing staff at the admin queue. An audit log
   entry `PARTNER_APPLICATION_SUBMITTED` is written with `userId: null`.
4. **Review (staff).** Users with the `partners.review` permission open
   `/admin/partners` (nav item "Partner applications" in the Admin group), see
   the queue newest first with status chips and search, and open an
   application at `/admin/partners/[id]` to check the company details, the
   trade licence (with an expiry warning when the licence has expired or
   expires within 30 days) and the uploaded documents.
5. **Decide.** The reviewer records one of three decisions via
   `POST /api/admin/partners/[id]/decision`:
   - **approve** — creates an `Agency` in the same transaction that marks the
     application `APPROVED` (short code, name and contact fields copied from
     the application; half-approved states are impossible);
   - **reject** — requires a decision note;
   - **request-info** — requires a decision note; sets `INFO_REQUESTED`.

   Every decision stamps `reviewedById`/`reviewedAt`, writes an audit log
   entry and emails the applicant (approval, rejection with the note as
   "Explanation:", or info request with the note as "What we need:"). Email
   failures never fail the decision. Approval is terminal: an already-approved
   application answers `409` to any further decision; rejected and
   info-requested applications can be re-decided.

Approving never creates user accounts, WhatsApp groups or notifications —
those arrive in later phases.

## Data model

Additive only; no existing table changed (`prisma/schema.prisma`).

**PartnerApplication** — one row per submission:

- `id` (cuid), `reference` (unique, `PA-YYYY-NNNN`, generated transactionally
  per year), `status` (`SUBMITTED` | `INFO_REQUESTED` | `APPROVED` |
  `REJECTED`, default `SUBMITTED`).
- Company: `companyLegalName`, `tradingName?`, `country`, `city`, `address`,
  `website?`.
- Trade licence: `licenceNumber`, `licenceAuthority`, `licenceExpiry`
  (`YYYY-MM-DD` string).
- Contacts: `contactName`, `contactRole?`, `contactEmail`, `contactPhone`
  (international digits, must be WhatsApp capable), optional second contact
  (`secondContactName?/Email?/Phone?`).
- `notes?`, consents: `consentKyc`, `consentChannels`, `consentVersion`
  (currently `2026-10-v1`).
- `ipHash` — hashed applicant IP for the abuse limits; the raw IP is never
  stored.
- Review: `reviewedById?`, `reviewedAt?`, `decisionNote?` (required for
  reject / request-info), `agencyId?`.
- `createdAt`, `updatedAt`; indexes on `status`, `createdAt` and `ipHash`.

`reviewedById` and `agencyId` are plain strings without Prisma foreign keys on
purpose (same precedent as the WhatsApp `accountId`), so no back-relations are
needed on `User`/`Agency`.

**PartnerDocument** — metadata only; the bytes live on disk:

- `applicationId` (cascade delete), `kind` (`TRADE_LICENCE` |
  `SIGNATORY_ID` | `OTHER`), `originalName` (sanitised display name),
  `mime` (decided server-side from magic bytes, never the client-supplied
  type), `size`, `sha256`, `storagePath`, `createdAt`.

## KYC document storage

`lib/partners/kyc-storage.ts` stores files under
`data/kyc/<applicationId>/<random>.<ext>` (relocatable via the
`KYC_STORAGE_DIR` env var) — the same persistent volume the backups cover,
never under `public/`. Rules:

- Only **PDF, JPG and PNG**, decided by **magic bytes**; the file extension
  must agree with the detected type. The client mime type is never trusted.
- At most **10 MB per file** and **3 files per application** (licence file
  required; signatory ID and one other file optional).
- The on-disk name is 16 random bytes; the original name is sanitised
  (basename, control characters stripped, capped at 128 characters) and kept
  only as metadata.
- A **SHA-256** hash of every file is computed at upload and stored on the
  document row.
- The read helper re-validates that the path stays inside the KYC base
  directory before streaming; the delete helper removes the application's
  whole directory and its `PartnerDocument` rows.

## Privacy and access rules

- **Permission.** `partners.review` is the last key in `PERMISSION_KEYS`
  (`lib/permissions.ts`). Only the ADMIN preset holds it automatically; no
  other role preset includes it. Like any key it can be granted per user (a
  per-user deny always wins). Every staff gate re-reads the user row and
  effective permissions, so deactivation or a revoked grant takes effect on
  the next request: no active session → `401`, session without the permission
  → `403`.
- **Staff APIs** (`app/api/admin/partners/`): list (`GET`, `status` filter +
  `search` over reference/company/contact, newest first), detail (`GET`,
  includes documents but never their `storagePath`), document download
  (`GET .../documents/[docId]`), decision (`POST .../decision`), and
  delete-documents (`DELETE /api/admin/partners/[id]` — removes only the KYC
  documents, not the application).
- **Document download** streams the file as an attachment with
  `Content-Disposition` (RFC 5987 filename), `X-Content-Type-Options:
  nosniff`, `Cache-Control: private, no-store` and an `X-Content-SHA256`
  header so the reviewer can verify integrity. Every successful download is
  audit logged with who, when and which file.
- **Audit log actions:** `PARTNER_APPLICATION_SUBMITTED` (userId null),
  `PARTNER_APPLICATION_APPROVED`, `PARTNER_APPLICATION_REJECTED`,
  `PARTNER_APPLICATION_INFO_REQUESTED`, `PARTNER_KYC_DOCUMENT_DOWNLOADED`,
  `PARTNER_KYC_DOCUMENTS_DELETED`.
- **What applicants see.** Only their reference and generic wording. Error
  messages never reveal internals or whether a company or email address is
  already known to us.

## Abuse protection

There is no rate limiting anywhere else in the app; the public submission
endpoint carries its own defences (`lib/partners/abuse.ts`), all answered with
the same generic messages so bots learn nothing:

- **Honeypot.** A hidden `companyFax` field must be empty; a filled value gets
  the identical generic 400 as any other rejection.
- **Minimum fill time.** The page mints a signed timestamp token during
  server-side render (HMAC-SHA256 keyed by `NEXTAUTH_SECRET`, verified
  timing-safe). Submissions younger than **3 seconds** or older than **2
  hours** are rejected. If `NEXTAUTH_SECRET` is missing, the form fails
  closed: the page shows an "unavailable" notice instead of the form.
- **Rate limits.** At most **3 applications per hashed IP per rolling hour**
  and **50 per UTC day overall**; beyond that the endpoint answers `429`. The
  IP is taken from `x-forwarded-for` (the app sits behind Traefik) and stored
  only as a salted SHA-256 hash (`NEXTAUTH_SECRET` is the salt). The limit
  check runs before the insert, so a concurrent race can overshoot slightly —
  accepted as harmless.

## Review procedure

1. Open **Partner applications** in the admin sidebar. New submissions also
   arrive as an alert email to `reservation@nare.am`.
2. Filter by status (All / Submitted / Info requested / Approved / Rejected)
   or search by reference, company or contact; the queue is newest first.
3. Open an application and check: company details, trade licence number and
   issuing authority, and the expiry date — the detail page warns when the
   licence has expired or expires within 30 days, in which case you may want
   to request a renewal instead of approving.
4. Download the documents and verify them against the entered licence data.
   The `X-Content-SHA256` response header lets you confirm the file matches
   what was uploaded.
5. Record the decision:
   - **Approve** — the agency short code is proposed from the company legal
     name (letters only, uppercased, first 10; 3–10 uppercase letters
     required) and can be edited before submitting; it must be unique across
     agencies (`409` if taken). Approval creates the `Agency` and marks the
     application `APPROVED` in one transaction. Approval is final.
   - **Reject** — a note to the applicant is required; it is included in the
     rejection email.
   - **Request more info** — a note describing what is missing is required;
     it is included in the email. The application moves to `INFO_REQUESTED`
     and the applicant replies by email.
6. Every decision emails the applicant automatically and is audit logged with
   the reviewer's identity.
7. **Delete documents** (button on the detail page, behind a confirmation
   dialog) removes all KYC files and document rows for the application — the
   manual tool for honouring erasure requests or cleaning up rejected
   applications until a retention policy is decided. The deletion is audit
   logged.

## Retention decisions still open (owner: Nare)

These are deliberately undecided in W5b and need a product-owner decision:

- How long KYC documents of **rejected** applications are kept before
  deletion.
- Whether documents of **approved** applications are retained for the life of
  the agency or deleted once onboarding completes.
- The standard handling and target turnaround of applicant **erasure
  requests** (today: manual, via the delete-documents action).

Until decided, documents are kept and removals are done manually with the
audit-logged delete-documents action.

## What W5c and W5d add

- **W5c** — WhatsApp groups: on approval, a WhatsApp group is created for the
  partner with configured default members, linked to the agency.
- **W5d** — company notifications over those channels (request updates to the
  partner), building on the groups from W5c.

Partner portal accounts/logins and request submission by companies follow in
later phases; the consent to being contacted by email and added to a WhatsApp
group (`consentChannels`) is already collected at application time.

## Tests

The behaviour above is pinned by `tests/partners/`: `apply-api.test.ts`
(submission contract and abuse gates), `kyc-storage.test.ts` (storage rules),
`reference.test.ts` (reference generation), `review-api.test.ts` (staff API
gates, decisions, downloads, deletion), `review-ui.test.ts` and
`apply-page.test.ts` (pages, nav, allow-list and entry links). The public
apply page is in the AppShell allow-list in `tests/ui/design-guard.test.ts`
with the reason "public unauthenticated partner application page (W5b)".
