# Current Known Issues

> Last updated: 2026-09-23 (media-send patch, v0.15.3)

This document tracks WhatsApp integration issues that affected message sync and sending in WAControl.

## Media (PDF/image) sends fail with "Data passed to getter must include an id property" — RESOLVED (v0.15.3)

A WhatsApp Web rollout (~2026-09-17) broke media sending: in the injected
`sendMessage`, spreading the `mediaOptions` MediaData MobX model into the
outgoing message overwrites the freshly-built `id: newMsgKey` (its enumerable
internals include `__x_id`, plus `id` from `mediaOptions.toJSON()`), so WA
Web's Msg memoize getter throws (upstream
[wwebjs#201921](https://github.com/wwebjs/whatsapp-web.js/issues/201921) /
[#201922](https://github.com/wwebjs/whatsapp-web.js/issues/201922); fix PRs
#201923 / #201925). Text sends were unaffected (no `mediaOptions`). Fix:
`scripts/patch-wwebjs.js` gained a second patch that restores
`message.id = newMsgKey` (and deletes `__x_id`) right after the spread. Also
shipped: `sendWhatsAppMessage` now fails fast with "Not a WhatsApp number:
<number>" when `getNumberId()` resolves to `null`, instead of a cryptic
downstream error.

## Resolution summary (2026-08-11, second round — production)

After the first round of fixes, a new WhatsApp Web rollout (2.3000.1043x+) broke the
integration again in different ways. Fixes shipped in v0.2.0–v0.2.6:

1. **`message.id._serialized` renamed to `$1`** on newer WhatsApp Web versions — message
   persistence deduped on a null id and `msg.getChat()` crashed with the minified `r: r`
   error. Fix: `persistMessage` reads both id forms and derives the chat id from
   `msg.from`/`msg.to` instead of `getChat()` (`lib/whatsapp.ts`).
2. **`getChats()`/`getChatById()` crash with `r: r`** — one unserializable chat model
   rejects the whole injected `Promise.all` evaluation (upstream
   [#201845](https://github.com/wwebjs/whatsapp-web.js/issues/201845) /
   [#201838](https://github.com/wwebjs/whatsapp-web.js/issues/201838)). Fix: container-start
   patch `scripts/patch-wwebjs.js` switches the injected `getChats()` to
   `Promise.allSettled` + filter. Pinning an older WhatsApp Web build via
   `webVersion`/`wa-version` snapshots was tried and abandoned — every alpha snapshot
   stalls at app-state sync (`authenticated` never reaches `ready`).
3. **Session corrupted by pairing under a pinned alpha build** — after unpinned restarts
   the client stalled at `authenticated`. Fix: session reset + re-pair on the live version.
4. **Restart stall (`authenticated` never `ready`)** — resumed sessions often hang in
   app-state sync. Mitigations: removed the service-worker cache clearing (it was only
   needed for the abandoned version pin), and a two-stage watchdog reloads the WhatsApp Web
   page 90s after `authenticated` without `ready`, only asking for re-pair after a further
   150s (`lib/whatsapp.ts` `authenticated` handler).
5. **Audit log FK violation (P2003)** — `prisma.log.create` with a stale session user id
   threw and broke message sending. Fix: `lib/audit.ts` `writeAuditLog()` retries with
   `userId: null` and never throws.
6. **Init robustness** — `initializeWhatsApp()` retries client startup failures up to 5
   times with full teardown between attempts, and concurrent callers share one in-flight
   attempt loop. Configuration errors (account missing or disabled) are not transient and
   reject immediately, before any client is built.

Also shipped: build version + uptime on the admin page, mobile-friendly dashboard layout,
contact phone numbers stored on chats (`Chat.phone`), and "Developed by Hayk FZC" branding.

## Issue 1: WhatsApp state stuck at `authenticated` — RESOLVED

**Symptom**
- The admin dashboard showed **State: authenticated** with "Authenticated. Loading chats...".
- The dashboard never reached the `ready` state.
- Sending messages from the dashboard showed the toast: **"WhatsApp client not ready"**.

**Root cause**
- Originally: the stored session was unpaired / corrupted. Later recurrences: resumed
  sessions hang in app-state sync after plain restarts (upstream whatsapp-web.js behavior;
  fresh QR pairings always sync).

**Resolution**
- Re-pair the session (scan the QR code in the admin panel) if the session is stale.
- For restart stalls: the watchdog now reloads the WhatsApp Web page automatically 90s
  after `authenticated`; re-pairing is only needed if that also fails.

## Issue 2: New messages are not received — RESOLVED

**Symptom**
- The dashboard showed **"No chats yet"** even when messages were sent to the linked number.
- The server logs showed no `message_create` or `message` events after startup.

**Cause**
- WhatsApp Web events (`message_create`, `message`) only fire when the client is `ready`,
  which was blocked by Issue 1.

**Resolution**
- After re-pairing and reaching `ready`, incoming and outgoing messages are persisted and
  appear in the dashboard in real time.

## Issue 3: Sending messages to new numbers fails — RESOLVED

**Symptom**
- The **New message** dialog accepted a phone number and text, but clicking **Send** failed.
- The UI showed: **"WhatsApp client not ready"**.

**Root cause**
- The `/api/send` endpoint ran in the Next.js route-bundle copy of `lib/whatsapp.ts`, whose
  `state` never left `initializing` because the real client lived in the custom-server copy.
- Additionally, the audit-log insert threw a Prisma P2003 FK violation when the session
  carried a stale user id, which surfaced as a send failure.

**Resolution**
- Shared state via `globalThis` (see resolution summary). `/api/send` now sees the real
  client state and sends once the client is `ready`.
- `writeAuditLog()` is non-fatal and retries with a null user id.

## Issue 4: Historical messages do not sync — RESOLVED (v0.2.6)

**Status**
- Resolved. On `ready`, `backfillChats()` syncs the 20 most recent chats × 50 messages via
  `client.getChats()` + `chat.fetchMessages()`, made reliable by the `Promise.allSettled`
  patch (`scripts/patch-wwebjs.js`). Additional history also arrives passively through
  app-sync `message_create` events after pairing.
- Verified on production 2026-08-11: `backfill complete: 20/20 chats synced`, 59+ chats /
  367+ messages in the database.

## Operational notes

- The installed `whatsapp-web.js` is v1.34.7 (latest). The note in older revisions of this
  document referencing v1.23.0 was outdated.
- Do NOT pin `webVersion` to wa-version alpha snapshots — they stall at app-state sync.
- Protocol noise (`e2e_notification`, `notification_template`, `gp2`, `call_log`,
  `revoked`) is intentionally not persisted (v0.2.7 extended the filter with
  `call_log`/`revoked` and cleaned the legacy noise rows from the production DB —
  44 noise messages removed, 6 chats that held only noise deleted). For `@lid`
  contacts, `contact.number` returns the LID itself (not the real phone number —
  WhatsApp's privacy system does not expose it), so `Chat.phone` is only populated
  for `@c.us` chats; the UI never shows the raw `@lid` code and falls back to
  "Unknown contact" / "Number hidden by WhatsApp".
- The admin Logs tab records full activity (v0.2.7): `WA_QR`, `WA_READY` (with the
  live WhatsApp Web version), `WA_DISCONNECTED`, `WA_AUTH_FAILURE`,
  `MESSAGE_RECEIVED` (real-time incoming, with sender + snippet), and
  `SEND_MESSAGE` (dashboard sends, logged by `/api/send`).
- When the dashboard sends to a phone number, WhatsApp may map it to an opaque
  `@lid` jid. Since the dialed number is known at send time, `sendWhatsAppMessage`
  records it on the `Chat.phone` of every jid the send touched (v0.2.8), so the
  conversation shows `+<number>` instead of "Number hidden by WhatsApp".
- Display names are phone-first (v0.2.9): the sidebar and conversation header lead
  with `+<phone>` whenever the number is known, with the contact name as the
  secondary line. For outgoing messages `msg.getContact()` can resolve to our own
  contact, which stamped the account's pushname onto outgoing-only chats — that
  name is now discarded at persistence time (matched against `client.info.pushname`
  captured on `ready`) and the 33 affected legacy rows were cleaned.
- If the client gets stuck again, check the server logs first — the event logging and the
  authenticated watchdog (with automatic page reload) make the stall visible and usually
  self-healing.
- Re-pairing requires scanning a QR code with the phone that owns the WhatsApp account.

## Related files

- `lib/whatsapp.ts` — WhatsApp client initialization, shared state, and event handlers.
- `lib/audit.ts` — non-fatal audit logging helper.
- `scripts/patch-wwebjs.js` — container-start patch for the injected `getChats()`.
- `docker-entrypoint.sh` — applies the patch and clears Chromium singleton locks.
- `app/api/send/route.ts` — API endpoint for sending messages.
- `app/api/whatsapp/status/route.ts` — status/reconnect/logout endpoint.
- `components/dashboard/ChatDashboard.tsx` — Dashboard UI with the New message dialog.
- `doc/troubleshooting.md` — General troubleshooting steps.
