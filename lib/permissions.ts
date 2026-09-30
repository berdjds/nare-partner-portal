/**
 * W2 permission model: keys, role presets and effective-permission resolution.
 *
 * A permission key gates one capability of the product. The set of keys is
 * closed — PERMISSION_KEYS below is the complete list, and keys not in it can
 * never become effective (unknown keys stored in UserPermission rows are
 * dropped at resolution time).
 *
 * Every user gets the preset of their CURRENT database role plus their
 * per-user overrides (UserPermission rows: allowed=true grants a key,
 * allowed=false denies it). Effective permission = preset + grants − denies;
 * a deny always wins over both a grant of the same key and the role preset.
 *
 * Presets reproduce the interim W1 role behaviour exactly, with one decided
 * exception (D2): internal-cost viewing (travel.internal.view) and
 * internal-document download (travel.internal.download) default to ADMIN
 * only — today INTERNAL costing is also visible to validators, but until the
 * owner confirms the proposed-permissions migration (D3), non-admins get no
 * internal-cost access.
 *
 * Role-to-preset mapping (from the current enforcement sites):
 * - admin.users / admin.settings / whatsapp.admin: ADMIN-only today
 *   (/api/users, travel settings/catalog/policies/fx, WhatsApp status + QR).
 * - whatsapp.inbox.view / whatsapp.inbox.send: ADMIN + USER (canUseInbox).
 * - travel.access: the travel roles ADMIN / ADVISOR / VALIDATOR
 *   (TRAVEL_ROLES; a USER enters only via an active validation assignment,
 *   which stays a runtime check on top).
 * - travel.create: ADMIN + ADVISOR (POST /api/travel/requests).
 * - travel.review: ADMIN + VALIDATOR (review rights; the per-request assigned
 *   validator stays a runtime check on top).
 * - travel.issue: ADMIN + ADVISOR (issue() is owner-or-admin; only creators
 *   own requests).
 * - travel.client_docs.download / travel.client_docs.send: the travel roles
 *   (owner / assigned validator / ADMIN today; per-request checks stay on
 *   top).
 *
 * The enforcement sites still check roles (lib/access-policy.ts and the
 * travel guard/workflow) until the follow-up tasks wire them to these keys;
 * overrides already take effect wherever effective permissions are consulted.
 */

export const PERMISSION_KEYS = [
  /** Manage users (admin panel, /api/users). */
  "admin.users",
  /** Module settings and administration (travel settings, catalog, policies, fx, imports). */
  "admin.settings",
  /** Open the WhatsApp chat inbox: dashboard, /api/chats, /api/messages, /uploads/*. */
  "whatsapp.inbox.view",
  /** Send WhatsApp messages from the inbox (/api/send). */
  "whatsapp.inbox.send",
  /** Full WhatsApp status details, pairing QR, reconnect/logout, admins socket room. */
  "whatsapp.admin",
  /** Use the B2B travel module at all (pages under /travel and the travel APIs). */
  "travel.access",
  /** Create travel requests and quote versions. */
  "travel.create",
  /** Review submitted quote versions (approve / request changes / reject). */
  "travel.review",
  /** Issue approved quotations (generate the final documents). */
  "travel.issue",
  /** Download CLIENT quotation documents. */
  "travel.client_docs.download",
  /** Send CLIENT quotation documents (e.g. via WhatsApp). */
  "travel.client_docs.send",
  /** View internal costs and margins (calculation details, INTERNAL costing data). */
  "travel.internal.view",
  /** Download INTERNAL costing-sheet documents. */
  "travel.internal.download",
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

const KNOWN_KEYS: ReadonlySet<string> = new Set(PERMISSION_KEYS);

export function isPermissionKey(value: unknown): value is PermissionKey {
  return typeof value === "string" && KNOWN_KEYS.has(value);
}

/**
 * The internal keys decided admin-only (D2) until the owner confirms the
 * proposed-permissions migration (D3): internal-cost viewing and
 * internal-document download. No non-admin preset includes them.
 */
export const INTERNAL_PERMISSION_KEYS: ReadonlySet<PermissionKey> = new Set<PermissionKey>([
  "travel.internal.view",
  "travel.internal.download",
]);

/**
 * Default permission set per role. ADMIN holds every key (so a key added to
 * PERMISSION_KEYS is automatically admin-only until another preset opts in).
 * Unknown roles get the empty set — same as today, where an unrecognized role
 * passes no gate.
 */
export const ROLE_PRESETS: Readonly<Record<string, ReadonlySet<PermissionKey>>> = {
  ADMIN: new Set(PERMISSION_KEYS),
  USER: new Set<PermissionKey>(["whatsapp.inbox.view", "whatsapp.inbox.send"]),
  ADVISOR: new Set<PermissionKey>([
    "travel.access",
    "travel.create",
    "travel.issue",
    "travel.client_docs.download",
    "travel.client_docs.send",
  ]),
  VALIDATOR: new Set<PermissionKey>([
    "travel.access",
    "travel.review",
    "travel.client_docs.download",
    "travel.client_docs.send",
  ]),
};

const EMPTY_PRESET: ReadonlySet<PermissionKey> = new Set();

export function presetForRole(role: string | null | undefined): ReadonlySet<PermissionKey> {
  if (!role) return EMPTY_PRESET;
  return ROLE_PRESETS[role] ?? EMPTY_PRESET;
}

/** One per-user override row (the UserPermission table: allowed=true grants, allowed=false denies). */
export interface PermissionOverride {
  key: string;
  allowed: boolean;
}

/**
 * Resolves the effective permission set: (role preset ∪ grants) − denies.
 * Grants apply first, denies second, so a deny always wins over both a grant
 * of the same key and the role preset; a grant wins over the preset's absence
 * of a key. Overrides with unknown keys are ignored — a corrupted row can
 * never widen access. The role preset itself is never mutated — the result is
 * a fresh set.
 */
export function effectivePermissions(
  role: string | null | undefined,
  overrides: Iterable<PermissionOverride> = [],
): Set<PermissionKey> {
  const effective = new Set(presetForRole(role));
  const rows: PermissionOverride[] = [];
  for (const override of Array.from(overrides)) {
    if (isPermissionKey(override.key)) rows.push(override);
  }
  for (const row of rows) {
    if (row.allowed) effective.add(row.key as PermissionKey);
  }
  for (const row of rows) {
    if (!row.allowed) effective.delete(row.key as PermissionKey);
  }
  return effective;
}

/**
 * Convenience predicate over anything carrying an effective permission set
 * (e.g. ActiveUser). The set may be absent (e.g. an unresolved WorkflowActor)
 * — an absent set never satisfies a key.
 */
export function hasPermission(
  user: { permissions?: ReadonlySet<PermissionKey> | undefined } | null | undefined,
  key: PermissionKey,
): boolean {
  return user?.permissions?.has(key) ?? false;
}
