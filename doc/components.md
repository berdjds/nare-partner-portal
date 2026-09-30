# Components and Hooks

## UI Components

Base components are located in `components/ui/`. They follow the shadcn/ui pattern using Radix UI primitives and TailwindCSS.

| Component | Purpose |
|-----------|---------|
| `button.tsx` | Button variants |
| `input.tsx` | Text input |
| `textarea.tsx` | Multiline text input |
| `label.tsx` | Form labels |
| `card.tsx` | Card container |
| `dialog.tsx` | Modal dialogs |
| `select.tsx` | Dropdown select |
| `tabs.tsx` | Tab navigation |
| `avatar.tsx` | User/chat avatars |
| `badge.tsx` | Status badges |
| `toast.tsx` | Toast notifications |

All UI components use `cn()` from `lib/utils.ts` to merge Tailwind classes.

## Page Components

### `app/login/page.tsx`

Client-side login form. Handles credential submission and redirects on success.

### `app/admin/page.tsx`

Server component that verifies the `ADMIN` role and renders `AdminDashboard`.

### `app/dashboard/page.tsx`

Server component that verifies authentication and renders `ChatDashboard`, passing `isAdmin` flag.

## Feature Components

### `components/admin/AdminDashboard.tsx`

Admin dashboard for:
- Viewing WhatsApp connection status and QR code.
- Controlling logout/reconnect actions.
- Managing users (create, update, delete, activate/deactivate).
- Viewing audit logs.

### `components/dashboard/ChatDashboard.tsx`

Main chat interface for:
- Listing chats and latest messages.
- Viewing message history.
- Sending text and media messages.
- Marking chats as read.

## Hooks

### `hooks/useSocket.ts`

React hook for Socket.io connection.

```typescript
import { useSocket } from "@/hooks/useSocket";

const { socket, connected, unauthorized, whatsAppState, lastEvent, disconnectSocket } = useSocket();
```

**Returns**:
- `socket` — Socket.io client instance.
- `connected` — Boolean connection status.
- `unauthorized` — True after the server refused the handshake (`unauthorized`
  connect_error: missing/forged/expired session or disallowed origin). The
  hook stops reconnecting in that case; the dashboards show "Session expired".
- `whatsAppState` — Current WhatsApp state. Admins receive the full payload
  (`state`, `info`, `qrSvg`); non-admin inbox users only receive
  `{ connected: boolean }` (interim W1 policy).
- `lastEvent` — Last `message` or `chat_update` event payload.
- `disconnectSocket` — Disconnects the socket; the dashboards call it on
  sign-out so the session cookie is not used after logout.

The hook connects to `/api/socket` and listens for:
- `connect` / `disconnect` / `connect_error`
- `whatsapp_state`
- `message`
- `chat_update`

## Utility Functions

### `lib/utils.ts`

```typescript
export function cn(...inputs: ClassValue[]): string;
```

Merges Tailwind classes using `clsx` and `tailwind-merge`.

## Travel module components

`components/travel/` holds the client components for `app/travel/` pages: requests list and
detail workspace (itinerary, scenarios with split-stay preview, review actions, documents,
history), review queue, templates, catalog/settings administration and notification delivery
status. They follow the existing conventions (axios + useToast + Card/Tabs/Dialog, light
theme). The client quotation PDF is generated server-side (`lib/travel/pdf/`); the UI only
links to the authorized download route. Nav buttons to `/travel` were added to both existing
dashboards.

Notable pieces: `CatalogAdmin.tsx` has create/edit dialogs for hotels and service products plus
per-product rate editors (new rates start NEEDS_REVIEW); `ItineraryTab.tsx` generates
duration-driven days from the travel dates, offers a per-day catalog service picker, and syncs
overnight cities from the scenario's hotel stays.
