# Authentication

WAControl uses NextAuth.js v4 with a credentials provider and JWT sessions.

## Provider

The application uses a custom credentials provider defined in `lib/auth.ts`:

- Email and password are validated against the `User` table.
- Passwords are hashed with bcrypt.
- Only active users can sign in.
- Session strategy is JWT.

## Roles and Permissions

Access is decided by a closed set of 13 permission keys defined in `lib/permissions.ts`:
`admin.users`, `admin.settings`, `whatsapp.inbox.view`, `whatsapp.inbox.send`,
`whatsapp.admin`, `travel.access`, `travel.create`, `travel.review`, `travel.issue`,
`travel.client_docs.download`, `travel.client_docs.send`, `travel.internal.view`,
`travel.internal.download`. Each role maps to a default preset of keys:

| Role | Default permissions |
|------|---------------------|
| `ADMIN` | All keys |
| `USER` | `whatsapp.inbox.view`, `whatsapp.inbox.send` |
| `ADVISOR` | `travel.access`, `travel.create`, `travel.issue`, `travel.client_docs.download`, `travel.client_docs.send` |
| `VALIDATOR` | `travel.access`, `travel.review`, `travel.client_docs.download`, `travel.client_docs.send` |

Per-user overrides (`UserPermission` rows: `allowed=true` grants a key,
`allowed=false` denies it) adjust the preset; the effective set is
(preset ∪ grants) − denies, and a deny always wins. The internal-cost keys
(`travel.internal.view`, `travel.internal.download`) are preset for ADMIN only, so
non-admins have no internal-cost access until the owner confirms the permissions
migration.

Every gate re-reads the user row and its override rows from the database on each
request; the role stored in the JWT at login is never consulted. A role change,
override edit, or deactivation therefore takes effect on the next request. See
`doc/security.md` for the full permission model, the migration report, and the
internal-document rules.

## Session Flow

1. User submits credentials on `/login`.
2. `authorize` callback validates the email and password.
3. On success, a JWT is created containing `id`, `role`, and `sv` (the user's
   session version, minted from `User.sessionVersion`). Session maxAge is 7 days.
4. The `session` callback exposes `id`, `role`, and `sv` to the client session.
5. Server components and API routes use `getServerSession(authOptions)` plus
   `getActiveUser()` (`lib/access-policy.ts`), which re-reads the user row from
   the database on every request: the user must exist and be active, and the
   token's `sv` must match the current `User.sessionVersion` (a token without
   `sv` counts as version 0).
6. Permission changes, role changes, password changes, deactivation, and explicit
   revocation all bump `sessionVersion`, immediately invalidating previously
   issued tokens on their next request and disconnecting open sockets on the next
   revalidation pass.

Two revocation endpoints exist: `POST /api/users/[id]/revoke-sessions` (admin)
and `POST /api/auth/sign-out-everywhere` (self-service).

## Type Augmentation

NextAuth types are extended in `types/next-auth.d.ts`:

```typescript
declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: string;
      sv: number;
    } & DefaultSession["user"];
  }

  interface User {
    id: string;
    role: string;
    sv?: number;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
    role?: string;
    sv?: number;
  }
}
```

## Protected Routes

- `/dashboard` — requires the `whatsapp.inbox.view` permission; without it users
  are redirected to `/travel`. Sending additionally requires `whatsapp.inbox.send`.
- `/admin` — requires the `ADMIN` role; `/admin/permissions` — requires the
  `admin.users` permission.
- `/travel` — requires the `travel.access` permission.
- `/uploads/*` media — requires an authenticated, active user holding
  `whatsapp.inbox.view`.
- Socket.io (`/api/socket`) — requires `whatsapp.inbox.view` or `whatsapp.admin`.
- API routes enforce these gates individually. `/api/users` and `/api/permissions`
  are gated on the effective `admin.users` permission; `/api/logs` is gated on the
  raw `ADMIN` role.

## Login Page

The login page is a client component at `app/login/page.tsx`. It calls `signIn` from `next-auth/react` with `redirect: false`, then navigates on success.

## Note on SessionProvider

The root layout currently does not wrap the application in `<SessionProvider>`. Because the app relies on server-side session checks and JWT strategy, this is acceptable for the existing flow. If you add client components that call `useSession`, wrap the layout with `SessionProvider` from `next-auth/react`.
