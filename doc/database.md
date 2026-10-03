# Database

WAControl uses Prisma with SQLite as the database. The schema is defined in `prisma/schema.prisma`.

## Models

### User

Stores authenticated users.

| Field | Type | Description |
|-------|------|-------------|
| id | String (CUID) | Primary key |
| email | String (unique) | User email |
| name | String? | Display name |
| password | String | Hashed password (bcrypt) |
| role | String | `ADMIN` or `USER` |
| active | Boolean | Whether the account is enabled |
| createdAt | DateTime | Record creation time |
| updatedAt | DateTime | Last update time |

**Relations**
- `logs`: audit logs created by the user.
- `messages`: messages sent through the dashboard.

### Chat

Represents a WhatsApp conversation.

| Field | Type | Description |
|-------|------|-------------|
| id | String (CUID) | Primary key |
| accountId | String | WhatsAppAccount.id owning the chat (default `marhaba`; no FK — see WhatsAppAccount) |
| remoteJid | String | WhatsApp remote JID (e.g., `123456789@c.us`) |
| name | String? | Display name |
| profilePicUrl | String? | Profile picture URL |
| lastMessageAt | DateTime | Last activity timestamp |
| createdAt | DateTime | Record creation time |
| updatedAt | DateTime | Last update time |

**Relations**
- `messages`: messages belonging to the chat.

**Indexes**
- `@@unique([accountId, remoteJid])` — chat identity is account + remoteJid, so the same customer can chat with both business accounts without mixing.

### Message

Stores individual WhatsApp messages.

| Field | Type | Description |
|-------|------|-------------|
| id | String (CUID) | Primary key |
| accountId | String | WhatsAppAccount.id owning the message (default `marhaba`; no FK — see WhatsAppAccount) |
| chatId | String | Foreign key to Chat |
| remoteJid | String | Sender/recipient JID |
| whatsappMessageId | String? | Original WhatsApp message ID |
| fromMe | Boolean | Whether the message was sent from the dashboard |
| body | String? | Message text |
| type | String | `text`, `image`, `voice`, `document`, `video`, `sticker`, `media`, or `unknown` |
| mediaUrl | String? | Path to saved media file |
| mediaMimeType | String? | MIME type of media |
| mediaCaption | String? | Caption or filename |
| timestamp | DateTime | Message timestamp |
| status | String | `received`, `sent`, `delivered`, `read`, or `failed` |
| createdAt | DateTime | Record creation time |
| updatedAt | DateTime | Last update time |
| sentById | String? | Local user who sent the message |

**Relations**
- `chat`: parent chat.
- `sentBy`: local sender (optional).

**Indexes**
- `@@unique([accountId, whatsappMessageId])` — dedupe is per account; the same WhatsApp message id can exist once per business account (SQLite treats NULLs as distinct, so rows without an id are unaffected).
- `@@index([chatId, timestamp])`

### Log

Audit log for admin actions.

| Field | Type | Description |
|-------|------|-------------|
| id | String (CUID) | Primary key |
| action | String | Action name (e.g., `SEND_MESSAGE`, `USER_CREATED`) |
| userId | String? | Acting user |
| details | String? | Additional details |
| createdAt | DateTime | Action timestamp |

**Relations**
- `user`: acting user (optional).

**Indexes**
- `@@index([createdAt])`

### WhatsAppSession

Tracks the WhatsApp connection state.

| Field | Type | Description |
|-------|------|-------------|
| id | String (CUID) | Primary key |
| sessionId | String (unique) | Session identifier, defaults to `default` |
| connected | Boolean | Whether the session is connected |
| info | String? | Status information |
| createdAt | DateTime | Record creation time |
| updatedAt | DateTime | Last update time |

### WhatsAppAccount

One row per WhatsApp business account (W3): `marhaba` (the existing inbox
account) and `nare` (the travel account, shipped disabled). The bootstrap
(`ensureDefaultAccounts()` in `lib/whatsapp-accounts.ts`, called from
`prisma/seed.ts`) creates the enabled Marhaba row and the disabled Nare row;
it is idempotent and never modifies existing rows.

| Field | Type | Description |
|-------|------|-------------|
| id | String | Primary key, fixed: `marhaba` or `nare` |
| key | String (unique) | Account key, same values as `id` |
| displayName | String | Display name |
| enabled | Boolean | Whether the account is active (default `false`) |
| sessionClientId | String? | LocalAuth clientId; null = legacy default `.wwebjs_auth/session` directory |
| publicNumber | String? | Owner-published number shown on client documents |
| verifiedNumber | String? | Number read from the linked session once ready |
| purpose | String | `INBOX` or `TRAVEL` (default `INBOX`) |
| createdAt | DateTime | Record creation time |
| updatedAt | DateTime | Last update time |

The `accountId` columns on Chat, Message and NotificationDelivery are plain
strings **without** a Prisma relation/foreign key to WhatsAppAccount, on
purpose: this keeps `prisma db push` on a populated database a pure additive
ADD COLUMN with a default (no table rebuild, no FK check against account rows
that only exist after the bootstrap seed runs). All pre-existing rows are
backfilled to `accountId = 'marhaba'` by the column default, so the push needs
no `--accept-data-loss`.

## Prisma Client

The Prisma client is exported as a singleton from `lib/prisma.ts` to prevent multiple instances during hot reload in development.

```typescript
import { prisma } from "@/lib/prisma";
```

## Travel module tables (additive)

Agency, PackageCodeCounter (transactional package-code sequences), TravelRequest (immutable
`packageCode`), QuoteVersion, Scenario, StaySegment, ItineraryDay, ServiceLine, Supplier,
HotelProduct, VehicleType, ServiceProduct, RateVersion (verification lifecycle
NEEDS_REVIEW → VERIFIED → ARCHIVED), FXRateVersion, PricingPolicyVersion, CalculationSnapshot
(immutable inputs/results + sha256 hash), ValidationAssignment, ReviewDecision, WorkflowEvent,
NotificationDelivery (outbox, unique dedupKey; gained `accountId` — the WhatsApp
account that owns/sent the delivery, default `marhaba`, no FK — see WhatsAppAccount), QuoteDocument (hash-recorded PDFs on disk),
ImportBatch/ImportRow (workbook staging), BatchRun, PackageTemplate/TemplateVersion
(TemplateVersion gained `scenariosJson` — default scenario definitions instantiated into new
requests — in v0.11.0),
TravelSettings (singleton; gained `validatorGroupJid`, the WhatsApp group for quotation
document delivery, in v0.10.0 — deprecated/ignored since v0.11.0 in favor of
`validatorUserIds`, the virtual validator user group; also gained `infantMaxAge`, the
traveler-classification ceiling, in v0.11.0; gained `whatsappAccountKey` in W3, the
WhatsApp account key all travel-module sends must use, default `nare` — there is no
silent fallback to another account). `User` gained a nullable `phone` (WhatsApp
notification destination) and role values ADVISOR/VALIDATOR. Money and FX values are decimal strings; JSON
payloads are String columns. See `prisma/schema.prisma` comments and `lib/travel/contracts.ts`.

`TravelRequest.travelers` is a JSON `TravelerSetup` string: counts (adults, children, infants,
paying, complimentary, leaders, staff) plus an optional `childAges` number array (age of each
child at return, 0–12; one entry per child, validated by `travelerSchema` in
`lib/travel/workflow.ts`).

Phase 3/4 additions: `ServiceLine` gained nullable `serviceProductId` (catalog link) and `date`
(YYYY-MM-DD) columns — a linked line is shared (`scenarioId = null`), keeps `unitRate = null`,
and is priced from SERVICE RateVersions covering its date. `ItineraryDay.services` items are
now `{ serviceProductId: string | null; label: string; details?: string | null;
vehicleTypeId?: string | null; quantity?: number }` objects (quantity drives the synced
ServiceLine quantity since v0.11.0; `details` is the client-facing long description since
v0.14.0); legacy plain-string arrays are normalized on read by `normalizeDayServices()`.
Since v0.14.0 `ServiceProduct` also gained a nullable `details` column — the catalog's long
client-facing description, with `name` kept as the short title; day-service picks copy it
onto the itinerary item.

Per-vehicle pricing addition: `ServiceLine` gained a nullable `vehicleTypeId` (indexed;
selected fleet vehicle for the line). SERVICE RateVersions may carry a `vehicleTypeId` —
transportation products hold one VERIFIED priority-1 row per vehicle type (seeded equal to
the priority-0 vehicle-agnostic base rate until fleet-specific prices are entered).
Resolution prefers the line's vehicle rows, falling back to the base row. VehicleType names
follow the fleet vocabulary: Sedan / Minivan / Sprinter / Big bus.
