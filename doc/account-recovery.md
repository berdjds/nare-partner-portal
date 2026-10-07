# Account Recovery (Self-Service Password Reset)

Phase W6a added a self-service password reset: any user who forgot their
password can request a single-use emailed link and choose a new password,
without involving an administrator. This document covers the flow, the abuse
limits, the audit events, exactly what is stored (hashes only), the operator
checklist for email delivery, and how to revoke sessions after a suspected
compromise.

Implementation entry points:

- `app/api/auth/password-reset/request/route.ts` — step 1 API
- `app/api/auth/password-reset/confirm/route.ts` — step 2 API
- `app/forgot-password/page.tsx`, `app/reset-password/page.tsx` — public pages
  (same public header/footer as the landing page; copy lives in
  `lib/portal-content.ts`)
- `lib/security/reset-token.ts` — token minting, hashing, expiry
- `lib/security/limits.ts` — DB-backed request limits
- `lib/security/password-policy.ts` — shared password policy
- `lib/security/emails.ts` — reset and confirmation email texts

## Flow

1. The user opens `/forgot-password` (linked from the sign-in page via
   "Forgot your password?") and submits their email address.
2. `POST /api/auth/password-reset/request` **always answers the same generic
   200 body** — "If an account exists for that email address, we have sent a
   link to reset the password." — whether the account exists, is inactive, or
   has hit its per-account limit. Unknown and inactive accounts receive no
   email and no token row, but the same hashing and limit bookkeeping runs for
   them so response timing does not reveal account existence. A hidden
   honeypot field on the form short-circuits bot submissions to the same 200
   with no work at all.
3. For a known, active account the route invalidates the user's earlier
   unused tokens, stores the sha256 hash of a fresh token (30-minute
   lifetime) and sends a plain-text email with the link
   `NEXTAUTH_URL/reset-password?token=...`. The mail send is best-effort: a
   delivery failure is logged and never changes the response.
4. The user opens the link, lands on `/reset-password` and submits a new
   password to `POST /api/auth/password-reset/confirm`.
5. In **one transaction** the confirm route claims the token atomically
   (a concurrent replay finds it already used), stores the new bcrypt hash
   (cost 10, same as the users API), increments `User.sessionVersion` —
   which ends every session minted before the reset via the `sv` check in
   `lib/access-policy.ts` — and invalidates the user's other unused tokens.
6. A best-effort confirmation email tells the user the password was changed
   and all other sessions were signed out, with instructions to contact their
   Nare account manager if it was not them.

Wrong, expired, already-used and malformed tokens — and tokens belonging to
deleted or inactive accounts — all get the **same generic 400** ("This reset
link is invalid or has expired."). The only distinguishable 400 is a password
policy violation, which carries the policy message and leaves the token
usable so the user can retry.

## Token design

- The emailed token is 32 random bytes, base64url-encoded (256 bits of
  entropy). Only its **sha256 hash** — bound to the purpose string
  `password-reset` so hashes from other features cannot be replayed here — is
  stored in `PasswordResetToken.tokenHash`. A database leak does not hand out
  usable links.
- Verification compares hashes with `crypto.timingSafeEqual` (defense in
  depth on top of the unique-hash lookup), so a forged token cannot be probed
  character by character.
- Tokens expire 30 minutes after minting and are single-use. Requesting a new
  link invalidates all earlier unused tokens for that account; a completed
  reset does the same.

## Password policy

The shared zod schema in `lib/security/password-policy.ts` requires: at least
12 characters, at most 128, not equal to the account email
(case-insensitive), and not one of a small list of very common passwords.
The same schema backs every password-setting surface so the rules cannot
drift apart.

## Request limits

Limits are enforced by counting rows on the `SecurityRequest` table
(`lib/security/limits.ts`); the counter interface is injected exactly like
`PartnerApplicationCounter` in `lib/partners/abuse.ts`. All quotas are
rolling-window counts:

| Quota | Limit | Window | Visible behaviour when hit |
|-------|-------|--------|-----------------------------|
| Reset requests per client IP | 5 | 1 hour | Generic `429` ("Too many requests.") — the only distinguishable rejection |
| Reset requests per email | 3 | 1 hour | Hidden behind the generic 200 — no token is issued, nothing is revealed |
| Reset requests globally | 200 | 1 UTC day | Hidden behind the generic 200 |
| Confirm attempts per client IP | 10 | 1 hour | Generic `429` |

Notes:

- The per-IP 429 is answered **before** any bookkeeping row is written, so a
  rejected client cannot burn the global daily quota or grow the
  `SecurityRequest` and `Log` tables with 429s alone.
- Failed confirm attempts count towards the confirm limit too — the limit
  exists to slow online guessing against leaked tokens, and the token itself
  is unguessable.
- Checks run before the insert, so a concurrent race can overshoot a quota
  slightly; that is acceptable for abuse protection.

## Audit events

| Action | When | Attribution | Detail stored |
|--------|------|-------------|---------------|
| `PASSWORD_RESET_REQUESTED` | Every well-formed request attempt (known or unknown email) | `userId: null` | The **hashed** email only — never the raw address |
| `PASSWORD_RESET_COMPLETED` | A token is successfully exchanged for a new password | The reset user | A plain message; holds neither the token nor the email |
| `SIGN_OUT_EVERYWHERE` | Self-service session revocation (W1b) | The caller | Plain message |
| `SESSIONS_REVOKED` | Admin revokes another user's sessions (W1b) | The admin | Target's email |

Entries are written via `writeAuditLog()` (`lib/audit.ts`), which never
throws, and are visible to admins on the Logs tab.

## Data stored

Two models were added (see `prisma/schema.prisma`); **no existing column
changed**. Raw emails, IP addresses and tokens are never persisted by this
flow:

- `PasswordResetToken` — `id`, `userId`, `tokenHash` (unique; sha256 of the
  emailed token, purpose-bound), `expiresAt`, `usedAt` (null = still usable),
  `createdAt`.
- `SecurityRequest` — `id`, `kind` (`PASSWORD_RESET_REQUEST` |
  `PASSWORD_RESET_CONFIRM`), `subjectHash`, `ipHash`, `createdAt`. The
  subject is the sha256 of the normalised email (request) or of the presented
  token (confirm); the IP hash comes from `hashClientIp` in
  `lib/partners/abuse.ts`. Both hashes are salted with `NEXTAUTH_SECRET`, so
  with a known salt an attacker could reverse them over a dictionary —
  missing `NEXTAUTH_SECRET` fails closed.

## Operator checklist

Email delivery and link building depend on deployment configuration. Before
go-live (and when rotating infrastructure), verify:

1. **`NEXTAUTH_URL` is the canonical public origin** (e.g.
   `https://portal.nare.am`). Reset links are built from it; if it is wrong
   or missing, `lib/security/emails.ts` fails closed and no link is sent.
2. **SMTP variables are set** — `SMTP_HOST`, `SMTP_PORT` (default 587; 465
   switches to implicit TLS), `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` (default:
   the SMTP user). Without `SMTP_HOST`, `lib/email.ts` throws
   `EMAIL_NOT_CONFIGURED`; the reset routes treat the send as best-effort, so
   the user still gets the generic 200 but **no email arrives** — the failure
   appears only in the server log. Always send a real reset request to a test
   mailbox after changing SMTP settings.
3. **`NEXTAUTH_SECRET` is a random 32+ character value** and stable. It salts
   the stored email/IP hashes; rotating it orphans the `SecurityRequest`
   quota buckets (limits reset — harmless) and, like any rotation, is a
   security event to schedule deliberately.
4. **Deliverability**: the reset email is plain text from `SMTP_FROM` with
   the subject "Reset your partner portal password" — check spam folders and
   SPF/DKIM alignment for the sending domain.
5. **Audit check**: after a test reset, confirm `PASSWORD_RESET_REQUESTED`
   and `PASSWORD_RESET_COMPLETED` rows appear in the admin Logs tab and that
   the requested row shows a hash, not a raw email.

## Revoking sessions after a suspected compromise

All revocation works by incrementing `User.sessionVersion`. Every request
re-reads the user row (`getActiveUser()` in `lib/access-policy.ts`) and
rejects tokens whose `sv` claim no longer matches — so a bump ends every
session minted before it on the very next request, and open Socket.io
connections on the next revalidation pass.

Options, fastest first:

1. **The user themselves** — `POST /api/auth/sign-out-everywhere` ("sign out
   everywhere"), then a password reset or admin password change.
2. **An admin** — the Revoke sessions action in the admin panel
   (`POST /api/users/[id]/revoke-sessions`, requires the `admin.users`
   permission), audited as `SESSIONS_REVOKED`.
3. **A completed password reset** — bumps `sessionVersion` as part of its
   single transaction, so finishing a reset also ends the attacker's
   sessions.
4. **Deactivation** — setting the user inactive in the admin panel blocks
   them on the next request regardless of session version, and also prevents
   any reset link from being issued or confirmed for that account.

After any suspected compromise: revoke sessions, force a new password (via
the self-service reset or the admin users API — both bump `sessionVersion`),
then review the audit log for `PASSWORD_RESET_REQUESTED` /
`PASSWORD_RESET_COMPLETED` entries you cannot explain.

## Out of scope (for now)

Multi-factor authentication (phase W6b), account lockout on the sign-in
endpoint, SMS/WhatsApp recovery, and admin-initiated password resets as a
distinct flow (the existing users API covers admin password changes).
