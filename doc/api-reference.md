# API Reference

## Authentication

All API routes except the NextAuth endpoints require an active session cookie. Permission checks follow the W2 permission model (`lib/permissions.ts`, gates in `lib/access-policy.ts`, see `doc/security.md`): the user is re-loaded from the database on every request and the current role preset plus per-user overrides decide, so deactivation, a role change or an override edit takes effect on the next request. Gates never consult the JWT role.

## HTTP Routes

### NextAuth

- **GET /api/auth/[...nextauth]**
- **POST /api/auth/[...nextauth]**

Standard NextAuth.js endpoints. The credentials provider accepts:

```json
{
  "email": "admin@example.com",
  "password": "admin123"
}
```

#### POST /api/auth/sign-out-everywhere

Revokes every session of the caller (W1b): bumps the caller's `User.sessionVersion`,
so every token minted before the call — including the one making the call — fails on
its next request, and open sockets disconnect on the next 60s revalidation pass.

**Access**: any active session (any role); only ever revokes the caller's own account
(the id comes from the session, never from the request).

**Response**: `{ "ok": true }`. Audit action `SIGN_OUT_EVERYWHERE`.

**Errors**: `401` (no active session).

### Chats

#### GET /api/chats

Returns all chats ordered by most recent message.

**Access**: Active session with the `whatsapp.inbox.view` permission (W2). Anonymous and deactivated users get 401; active users without the permission get 403.

**Response**:

```json
[
  {
    "id": "cuid",
    "remoteJid": "123456789@c.us",
    "name": "Contact Name",
    "profilePicUrl": null,
    "lastMessageAt": "2026-08-10T12:00:00.000Z",
    "createdAt": "2026-08-10T10:00:00.000Z",
    "updatedAt": "2026-08-10T12:00:00.000Z",
    "messages": [
      {
        "body": "Hello",
        "timestamp": "2026-08-10T12:00:00.000Z",
        "fromMe": false,
        "type": "text"
      }
    ]
  }
]
```

### Messages

#### GET /api/messages

Returns messages for a chat.

**Access**: Active session with the `whatsapp.inbox.view` permission (W2). Anonymous and deactivated users get 401; active users without the permission get 403.

**Query parameters**:
- `chatId` — Chat ID (preferred)
- `remoteJid` — WhatsApp JID (fallback)

At least one parameter is required.

**Response**:

```json
[
  {
    "id": "cuid",
    "chatId": "cuid",
    "remoteJid": "123456789@c.us",
    "whatsappMessageId": "...",
    "fromMe": false,
    "body": "Hello",
    "type": "text",
    "mediaUrl": null,
    "mediaMimeType": null,
    "mediaCaption": null,
    "timestamp": "2026-08-10T12:00:00.000Z",
    "status": "received",
    "createdAt": "...",
    "updatedAt": "...",
    "sentById": null
  }
]
```

### Send Message

#### POST /api/send

Sends a WhatsApp message. Can be used to start a new chat with an unsaved number.

**Access**: Active session with the `whatsapp.inbox.send` permission (W2) — view and send are separate keys. Anonymous and deactivated users get 401; active users without the permission get 403.

**Request body**:

```json
{
  "remoteJid": "123456789@c.us",
  "body": "Hello",
  "type": "text",
  "mediaBase64": "...",
  "mediaMimeType": "image/png",
  "mediaFilename": "image.png"
}
```

For text messages to a new number, only `remoteJid`, `body`, and `type` are required. Use the full JID format (`<number>@c.us`) or just the number with country code and the server will format it.

**Response**:

```json
{ "ok": true }
```

Error responses include status `401` (unauthorized), `403` (travel-only roles), `503` (WhatsApp not ready), and `500` (send failure).

### WhatsApp Status

#### GET /api/whatsapp/status

Returns the current WhatsApp connection state.

**Access**: ADMIN (full details) or USER (`connected` only), both from the current database role. Anonymous and deactivated users get 401; ADVISOR/VALIDATOR get 403.

**Response (ADMIN)**:

```json
{
  "state": "ready",
  "qrSvg": null,
  "info": "WhatsApp client is ready.",
  "version": "0.16.2",
  "startedAt": "2026-09-28T00:00:00.000Z"
}
```

`qrSvg` carries the pairing QR code while unpaired — ADMIN only.

**Response (USER)**:

```json
{ "connected": true }
```

Availability strictly as connected/not connected; no state text, info, QR, version or uptime.

#### POST /api/whatsapp/status

Performs an admin action on the WhatsApp session.

**Access**: Admin only (current database role; everyone else gets 401).

**Request body**:

```json
{ "action": "logout" }
```

or

```json
{ "action": "reconnect" }
```

### Media

#### GET /uploads/\<file\>

Streams an uploaded message media file (stored under `public/uploads/`).

**Access**: Served by the custom server (`server.ts` → `lib/uploads.ts`), which intercepts
`/uploads/*` before Next.js's static handler. The pathname is percent-decoded, slash-collapsed
and normalized before matching, so encoded spellings (`/%75ploads/…`, `/uploads%2F…`) are gated
too; GET/HEAD only, other methods get `405`. Requires a valid, unexpired NextAuth session
cookie plus an active database user holding the `whatsapp.inbox.view` permission (W2).
Responses carry the file's mime type and `Cache-Control: private, no-store`.

**Errors**: `400` (undecodable URL), `401` (no, invalid, expired or revoked session),
`403` (active user without the `whatsapp.inbox.view` permission), `404` (traversal or
missing file), `405` (non-GET/HEAD method).
Existing and missing files are indistinguishable to unauthorized callers.

### Users

#### GET /api/users

Returns all users.

**Access**: Admin only.

#### POST /api/users

Creates a new user.

**Access**: Admin only.

**Request body**:

```json
{
  "email": "user@example.com",
  "name": "User Name",
  "password": "password",
  "role": "USER",
  "phone": "37499123456"
}
```

`role` is one of `ADMIN` / `USER` / `ADVISOR` / `VALIDATOR` (defaults to `USER`). `phone` is
optional — 7–15 digits, optional leading `+` (stored without it); used for WhatsApp
notifications and document delivery.

#### PATCH /api/users

Updates a user.

**Access**: Admin only.

**Request body**:

```json
{
  "id": "cuid",
  "email": "new@example.com",
  "name": "New Name",
  "role": "ADMIN",
  "active": true,
  "password": "newpassword",
  "phone": null
}
```

All fields except `id` are optional; `role` accepts `ADMIN` / `USER` / `ADVISOR` / `VALIDATOR`
and `phone: null` clears the WhatsApp number.

Changing the `password`, changing the `role`, or setting `active: false` also bumps the
user's `sessionVersion` (W1b), revoking every session token minted before the change on
its next request (see `doc/security.md`, "Session revocation"). Name/email/phone-only
edits and no-op values do not bump.

#### DELETE /api/users

Deletes a user.

**Access**: Admin only.

**Query parameter**: `id`

Admins cannot delete their own account.

#### POST /api/users/[id]/revoke-sessions

Revokes every session of the target user (W1b): bumps the target's
`User.sessionVersion`, so every token minted before the call fails on its next
request, and open sockets disconnect on the next 60s revalidation pass.

**Access**: Admin only — active non-admin sessions get `403`, anonymous get `401`.

**Response**: `{ "ok": true }`. Audit action `SESSIONS_REVOKED`, attributed to the admin.

**Errors**: `401` (no active session), `403` (active non-admin), `404` (unknown user id).

### Logs

#### GET /api/logs

Returns audit logs.

**Access**: Admin only.

**Query parameter**: `take` (max 500, default 100)

## Socket.io

Socket.io is available at path `/api/socket`.

### Connection policy (W1)

Since W1 the socket channel is gated exactly like the HTTP APIs (see
`doc/security.md`, "Interim access policy"):

- **Origin**: the handshake is accepted only when its `Origin` header exactly
  equals the origin of `NEXTAUTH_URL` (plus comma-separated
  `SOCKET_ALLOWED_ORIGINS`). Anything else — including a missing `Origin` — is
  refused before the Socket.io handshake runs.
- **Session**: the NextAuth session cookie is decoded (`NEXTAUTH_SECRET`) and
  the user is loaded from the database; the socket connects only for an
  ACTIVE `ADMIN` or `USER`. Anything else gets a `connect_error` with the
  message `unauthorized` and never connects.
- **Rooms**: the SERVER places each socket in `inbox` (ADMIN/USER) and ADMIN
  sockets additionally in `admins`. No client-to-server handlers exist:
  client-emitted events are ignored and logged.
- **Revalidation**: the socket is disconnected when its session token expires
  or when the periodic (60s) database re-check finds the user deactivated or
  the role changed.

### Client Connection

```typescript
import { io } from "socket.io-client";

const socket = io({
  path: "/api/socket",
  transports: ["websocket", "polling"],
});
```

WebSocket is listed first on purpose: the server only accepts allowed
origins, and browsers always send the `Origin` header on WebSocket
connections (same-origin GET polling requests may omit it).

### Server-to-Client Events

#### `whatsapp_state`

Sent on connection and whenever the WhatsApp state changes. The payload
depends on the socket's role (server-managed rooms):

- ADMIN sockets (`admins` room) receive the full state:

```json
{
  "state": "qr",
  "qrSvg": "<svg>...</svg>",
  "info": "Scan the QR code with WhatsApp on your phone.",
  "version": "0.16.2",
  "startedAt": "2026-09-29T00:00:00.000Z"
}
```

- Inbox-only (USER) sockets receive availability and nothing else:

```json
{ "connected": false }
```

Possible `state` values: `initializing`, `qr`, `authenticated`, `ready`, `disconnected`, `auth_failure`.

#### `message`

Sent when a new message is persisted. Delivered to the `inbox` room only
(active ADMIN/USER sockets).

```json
{
  "id": "cuid",
  "chatId": "cuid",
  "remoteJid": "123456789@c.us",
  "fromMe": false,
  "body": "Hello",
  "type": "text",
  "timestamp": "2026-08-10T12:00:00.000Z",
  "chat": { ... }
}
```

#### `chat_update`

Sent when a chat record is created or updated. Delivered to the `inbox` room
only.

```json
{
  "id": "cuid",
  "remoteJid": "123456789@c.us",
  "name": "Contact Name",
  "lastMessageAt": "2026-08-10T12:00:00.000Z"
}
```

### Client-to-Server Events

None. The server registers no client-to-server handlers and ignores (logs)
anything a client emits — clients cannot join rooms, subscribe or act over the
socket. Client actions must use the HTTP API.

---

## Travel Module API (`/api/travel/*`)

B2B travel package costing and quotation module. All routes require an authenticated session
with role `ADMIN`, `ADVISOR` or `VALIDATOR` — or, since v0.10.0, any user holding an active
validation assignment (401 otherwise; scoped to own + assigned requests). Request bodies are zod-validated
(400 `{ error: [...] }`); business-rule failures return `{ error, code }` with an appropriate
status (409 for stale snapshot/revision conflicts). Money values are decimal strings; dates are
`YYYY-MM-DD` local calendar dates. See `doc/travel/IMPLEMENTATION.md`.

| Route | Methods | Role | Purpose |
|---|---|---|---|
| `/api/travel/requests` | GET, POST | travel roles | Search (q/status/owner/dates) and create requests; POST generates the immutable package code `CLIENTSHORT-YYYY-MM-DD-NNNN` |
| `/api/travel/requests/[id]` | GET, PATCH, DELETE | GET/PATCH: travel roles; DELETE: ADMIN | Detail (versions, scenarios, snapshot summary, assignments, decisions, documents); PATCH edits drafts with `expectedRevision` optimistic lock. Since v0.11.0 the request owner sees full scenario results (per-line net costs included); redaction to sell-side fields would only apply to a non-owner advisor, who is 404'd. v0.15.0: submitted versions carry `scenarios[].traceRows` — the frozen calculation breakdown rebuilt at read time from the snapshot's `inputsJson` + `resultJson` (withheld under the same redaction rule as `resultJson`; `inputsJson` itself is never returned). DELETE (v0.12.0) hard-deletes the request with all children in one transaction (404 unknown, 403 non-admin) |
| `/api/travel/requests/[id]/submit` | POST | owner/ADMIN | DRAFT/CHANGES_REQUESTED → PENDING_VALIDATION; freezes calculation snapshot. Response carries the full engine result (the submitter is the owner or ADMIN — v0.11.0) |
| `/api/travel/requests/[id]/assignments` | GET, POST | travel roles | Validator assignment history / assign validator (any active user is assignable, self-assignment allowed — v0.10.0) |
| `/api/travel/requests/[id]/reassign` | POST | ADMIN | Reassign validator; former validator loses decision rights |
| `/api/travel/users/assignable` | GET | travel roles | Active users (`id`, `name`, `email`, `role`, `phone`) for the validator picker |
| `/api/travel/requests/[id]/versions` | POST | owner/ADMIN | Create a new draft revision (v02, ...) cloning latest content |
| `/api/travel/versions/[id]/calculate` | POST | travel roles | Engine preview (no snapshot persisted); optional policy override. Since v0.11.0 full results include `scenarios[].lines` (per-line net costs: rate, quantity, amountSource, AMD + quote-currency amounts; v0.14.0 adds `amount` in the line's source currency) and per-night conversions in `nightly[]`; v0.14.0 also adds `totals.bySourceCurrency` and computes the min-profit floor per paying person (`cost + minProfit × paying`); v0.15.1 changes the floor multiplier to travelers excluding infants (`cost + minProfit × max(0, adults + children − infants)`); v0.15.0 adds a response-only `scenarios[].traceRows` calculation breakdown (same rows as the internal costing PDF; never persisted, not part of the frozen ScenarioResult contract, withheld from advisor-redacted responses); the request owner (and ADMIN/VALIDATOR) sees the full result |
| `/api/travel/versions/[id]/content` | PUT | owner/ADMIN | Replace scenarios/stays/service lines/itinerary (draft statuses only). `itineraryDays[].services` items are `{serviceProductId?, label, vehicleTypeId?, quantity?}` objects (legacy plain strings accepted and normalized; quantity drives the linked service line's quantity since v0.11.0); `serviceLines[]` accept and pass through `serviceProductId`/`date`/`vehicleTypeId` for catalog-linked lines |
| `/api/travel/versions/[id]/review` | POST | assigned validator | APPROVE / REQUEST_CHANGES / REJECT bound to `snapshotHash` |
| `/api/travel/versions/[id]/issue` | POST | owner/ADMIN | Issue approved snapshot → client PDF; idempotent via `idempotencyKey` |
| `/api/travel/versions/[id]/outcome` | POST | owner/ADMIN | ACCEPTED (with scenario) / DECLINED / EXPIRED |
| `/api/travel/agencies`, `/api/travel/agencies/[id]` | GET, POST, PATCH | GET: travel roles; mutations: ADMIN | Client agencies and uppercase short codes; GET `?includeInactive=true` (ADMIN only) also lists deactivated ones |
| `/api/travel/catalog/hotels`, `/catalog/services`, `/catalog/rates` | GET | travel roles | Catalog with rates and verification status |
| `/api/travel/catalog/hotels(/[id])`, `/catalog/services(/[id])` | POST, PATCH, DELETE | ADMIN | Create/edit hotel and service products (name, category, basis, capacity, language, duration, active flag; services also take `details`, the client-facing long description since v0.14.0). DELETE (v0.16.0) hard-deletes the product with its rate versions — 409 while stays/service lines still link it |
| `/api/travel/catalog/hotels/reorder`, `/catalog/services/reorder` | POST | ADMIN | Drag-and-drop ordering: `{ids: string[]}` splices the submitted ids into their existing positions in the canonical `[sortOrder, name]` sequence, then rewrites the whole column to 0..n-1 in one transaction (v0.16.0 `lib/travel/reorder.ts`; unknown ids ignored); GET endpoints order by `sortOrder, name` |
| `/api/travel/catalog/rates` | POST | ADMIN | Add a rate version to a product; new rates start NEEDS_REVIEW. SERVICE rates accept an optional `vehicleTypeId` (per-vehicle transportation pricing; must reference an existing vehicle type) |
| `/api/travel/catalog/rates/[id]` | PATCH | ADMIN | Edit amount/validity/priority/minStay/weekdays/notes; status transitions NEEDS_REVIEW → VERIFIED → ARCHIVED (never delete). `vehicleTypeId` identifies the rate bracket and is not editable (archive + recreate) |
| `/api/travel/catalog/vehicles` | GET | travel roles | Active fleet vehicle types `[{id, name, seats}]` (Sedan / Minivan / Sprinter / Big bus) for vehicle pickers |
| `/api/travel/catalog/suppliers` | GET | travel roles | Supplier directory for catalog products |
| `/api/travel/templates`, `/templates/[id]/instantiate` | GET, POST | GET/instantiate: travel roles; POST create: ADMIN | Package templates (ARM/GEO/COM codes); instantiate into a new request. Since v0.11.0 instantiation populates structured itinerary days (catalog-linked services with quantities) and the template's default scenarios (title defaults to the template name). `POST /api/travel/templates` (v0.12.0) creates a template `{code, name, nights, days?}` with v1 as nights+1 empty day slots; duplicate code → 409 |
| `/api/travel/templates/[id]` | DELETE | ADMIN | Hard delete template + versions (v0.12.0); requests created from it are unaffected (content was snapshotted at instantiate) |
| `/api/travel/templates/[id]/duplicate` | POST | ADMIN | Copy template + latest version content into `<CODE>-COPY` (incremented when taken — v0.12.0) |
| `/api/travel/templates/[id]/versions/[versionId]` | PUT | ADMIN | Edit a template version: `{name?, days?, scenarios?}`; `scenarios: null` clears the defaults; `nights`/`days` are recomputed from the day count |
| `/api/travel/settings` | GET, PUT | GET: travel roles; PUT: ADMIN | Company timezone, reminders, escalation, policy activation, `validatorUserIds` (virtual validator user group: submit notifications, INTERNAL costing sheet, auto-assignment of the first member — v0.11.0; `validatorGroupJid` is deprecated/ignored), `infantMaxAge` (0–12, traveler classification ceiling), and company branding (`companyName`, `companyPhone`, `companyEmail`, `companyAddress`, `companyWebsite`, `brandColor` as `#rrggbb` or null) for the quotation PDF |
| `/api/travel/policies`, `/api/travel/fx` | GET, POST | ADMIN | Pricing policy versions and effective-dated FX rates |
| `/api/travel/policies/[id]`, `/api/travel/fx/[id]` | DELETE | ADMIN | v0.16.0: hard delete a policy version (409 on the active or last policy; clears a stale `defaultPolicyId`) or an FX rate (409 on the last rate of a currency) |
| `/api/travel/imports`, `/imports/[id]`, `/imports/[id]/verify` | GET, POST | ADMIN | Workbook import staging batches and row verification |
| `/api/travel/documents/[id]` | GET | travel roles (INTERNAL: ADMIN/VALIDATOR) | Authorized PDF download |
| `/api/travel/documents/[id]/send` | POST | owner / assigned validator / ADMIN | WhatsApp delivery of the rendered PDF: `{ userIds?, groupJids? }`, per-recipient results; INTERNAL recipients restricted to ADMIN/VALIDATOR or the assigned validator |
| `/api/travel/notifications`, `/notifications/retry`, `/notifications/process` | GET, POST | own / ADMIN | Delivery status, retry failed, manual queue processing |
| `/api/travel/batch` | POST | travel roles | Batch template pricing over PAX bands (default 2/4/6) |

### Socket.io: `travel_notification`

Server emits `travel_notification` when a workflow notification delivery changes status
(queued/sent/failed), so the UI can update badges live.
