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

Server component that verifies authentication and renders `ChatDashboard` inside the shared `AppShell` (W4, variant `full` — no max-width container, so the two-pane chat layout fills the viewport below the mobile bar). It passes the W3 `accounts` list — every WhatsApp account whose per-account view permission the user holds (`whatsapp.inbox.view` for marhaba, `whatsapp.nare.view` for nare), each with its `canSend`/`canAdmin` flags. Users who may view no account are redirected to `/travel`. Navigation and sign-out live in the shell; the old `isAdminRole` prop is gone.

## Feature Components

### `components/admin/AdminDashboard.tsx`

Admin dashboard for:
- Managing the WhatsApp business accounts (W3): one card per account in the Accounts tab (`components/admin/AccountsPanel.tsx`) with business name, verified/public number, per-account state, QR pairing, connect/reconnect/disconnect and an enabled switch, backed by `/api/whatsapp/accounts`. The browser-to-server socket link is shown separately from each account's WhatsApp state, and the state returned by the HTTP status/accounts calls is shown until the socket delivers a fresher one.
- Managing users (create, update, delete, activate/deactivate).
- Viewing audit logs.

### `components/dashboard/ChatDashboard.tsx`

Main chat interface for:
- Switching between the WhatsApp accounts the user may view (W3 `components/dashboard/AccountSwitcher.tsx`, server-decided list, defaults to marhaba); chats, messages and sends are scoped to the selected account.
- Listing chats and latest messages.
- Viewing message history.
- Sending text and media messages.
- Marking chats as read.

W4: the dashboard renders inside the shared app shell (`components/app/AppShell.tsx`, variant `full`). Its old header (brand mark, Admin/Calculator/Travel navigation buttons, sign-out controls) is replaced by a slim toolbar holding only the account switcher, the New message action, and the socket/WhatsApp state badges; navigation and sign-out live in the shell sidebar.

## Hooks

### `hooks/useSocket.ts`

React hook for Socket.io connection.

```typescript
import { useSocket } from "@/hooks/useSocket";

const { socket, connected, unauthorized, whatsAppState, whatsAppStates, lastEvent, disconnectSocket } = useSocket();
```

**Returns**:
- `socket` — Socket.io client instance.
- `connected` — Boolean connection status.
- `unauthorized` — True after the server refused the handshake (`unauthorized`
  connect_error: missing/forged/expired session or disallowed origin). The
  hook stops reconnecting in that case; the dashboards show "Session expired".
- `whatsAppState` — The marhaba entry of `whatsAppStates` (pre-W3 compat view).
- `whatsAppStates` — Per-account WhatsApp states keyed by account key (W3):
  every `whatsapp_state` payload carries `accountKey`. Admins receive the full
  payload (`state`, `info`, `qrSvg`); non-admin inbox users only receive
  `{ connected: boolean }` (interim W1 policy). The exported
  `resolveWhatsAppDisplayState(socketState, httpState)` helper picks the socket
  state once delivered and the HTTP status state before that, so the UI never
  shows "initializing" when the server has reported a state.
- `lastEvent` — Last `message` or `chat_update` event payload (account-scoped
  via `payload.accountKey`).
- `disconnectSocket` — Disconnects the socket. Since W4 the sign-out controls
  live in the shared app shell sidebar, which ends the session by navigating
  away; the chat dashboard no longer calls it.

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
links to the authorized download route. Navigation between modules (dashboard, travel, calculator,
admin) lives in the shared W4 app shell sidebar, not in per-page header buttons.

Notable pieces: `CatalogAdmin.tsx` has create/edit dialogs for hotels and service products plus
per-product rate editors (new rates start NEEDS_REVIEW); `ItineraryTab.tsx` generates
duration-driven days from the travel dates, offers a per-day catalog service picker, and syncs
overnight cities from the scenario's hotel stays.
