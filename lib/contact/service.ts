import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { hasPermission } from "@/lib/permissions";
import { contactDataSchema, contactOverrideSchema, DEFAULT_CONTACT, mapEmbedUrl, mapLinkUrl, type ContactData, type ContactOverride } from "@/lib/contact/schema";

export class ContactError extends Error {
  constructor(public code: string, message: string, public httpStatus = 400) { super(message); }
}
export const SCOPES = ["global", "portal"] as const;
export type Scope = (typeof SCOPES)[number];
type Actor = { id: string; permissions?: ReadonlySet<string> | undefined };

const need = (a: Actor) => { if (!hasPermission(a as never, "admin.settings")) throw new ContactError("FORBIDDEN", "not allowed", 403); };
const checkScope = (s: string): Scope => { if (!(SCOPES as readonly string[]).includes(s)) throw new ContactError("INVALID_SCOPE", "unknown scope"); return s as Scope; };

export async function saveDraft(actor: Actor, scope: string, data: unknown, note?: string) {
  need(actor);
  const sc = checkScope(scope);
  const parsed = (sc === "global" ? contactDataSchema : contactOverrideSchema).safeParse(data);
  if (!parsed.success) throw new ContactError("INVALID_CONTACT", parsed.error.issues.map((i) => `${i.path.join(".") || "data"}: ${i.message}`).join("; "));
  const row = await prisma.$transaction(async (tx) => {
    const last = await tx.contactProfile.findFirst({ where: { scope: sc }, orderBy: { version: "desc" }, select: { version: true } });
    await tx.contactProfile.updateMany({ where: { scope: sc, status: "DRAFT" }, data: { status: "SUPERSEDED" } });
    return tx.contactProfile.create({ data: { scope: sc, version: (last?.version ?? 0) + 1, status: "DRAFT", dataJson: JSON.stringify(parsed.data), note: note?.slice(0, 300) ?? null, createdById: actor.id } });
  }).catch((e) => { if ((e as { code?: string }).code === "P2002") throw new ContactError("CONFLICT", "someone saved at the same time; reload and try again", 409); throw e; });
  clearContactCache();
  await writeAuditLog("contact.draft", actor.id, JSON.stringify({ id: row.id, scope: sc, version: row.version }));
  return row;
}

export async function publish(actor: Actor, id: string) {
  need(actor);
  const row = await prisma.contactProfile.findUnique({ where: { id } });
  if (!row) throw new ContactError("NOT_FOUND", "not found", 404);
  if (row.status !== "DRAFT") throw new ContactError("INVALID_STATE", "only a draft can be published", 409);
  if (!schemaFor(row.scope).safeParse(safeParse(row.dataJson)).success) throw new ContactError("INVALID_CONTACT", "the stored draft is no longer valid");
  const out = await prisma.$transaction(async (tx) => {
    const lock = await tx.contactProfile.updateMany({ where: { id, status: "DRAFT" }, data: { status: "PUBLISHED", publishedById: actor.id, publishedAt: new Date() } });
    if (lock.count === 0) throw new ContactError("INVALID_STATE", "already decided", 409);
    await tx.contactProfile.updateMany({ where: { scope: row.scope, status: "PUBLISHED", id: { not: id } }, data: { status: "SUPERSEDED" } });
    return tx.contactProfile.findUniqueOrThrow({ where: { id } });
  });
  clearContactCache();
  await writeAuditLog("contact.publish", actor.id, JSON.stringify({ id, scope: row.scope, version: row.version }));
  return out;
}

export async function history(scope: string) {
  return prisma.contactProfile.findMany({ where: { scope: checkScope(scope) }, orderBy: { version: "desc" }, take: 50 });
}

const schemaFor = (scope: string) => (scope === "global" ? contactDataSchema : contactOverrideSchema);
function safeParse(json: string): unknown { try { return JSON.parse(json); } catch { return null; } }

async function publishedData(scope: Scope): Promise<(ContactData | ContactOverride) | null> {
  const rows = await prisma.contactProfile.findMany({ where: { scope, status: "PUBLISHED" }, orderBy: { version: "desc" }, take: 5 });
  for (const r of rows) {
    const p = schemaFor(scope).safeParse(safeParse(r.dataJson));
    if (p.success) return p.data; // a corrupt row is skipped, never shown
  }
  return null;
}

export interface PublicContact {
  foundedYear?: number; generalEmail?: string; b2bEmail?: string; phones?: Array<{ label?: string; number: string }>;
  whatsapp?: string; address?: string; hours?: string; mapEmbedUrl?: string; mapLinkUrl?: string;
}

/**
 * What the public pages may show: built-in approved defaults, then the published global profile,
 * then the published portal override (field by field), reduced by the visibility flags. Any
 * failure returns the defaults: the public site never breaks because configuration did.
 */
async function computePublicContact(scope: Scope): Promise<PublicContact> {
  let merged: ContactData = DEFAULT_CONTACT;
  try {
    const g = (await publishedData("global")) as ContactData | null;
    const p = scope === "portal" ? ((await publishedData("portal")) as ContactOverride | null) : null;
    // A published global profile REPLACES the built-in defaults (so an admin can remove the address,
    // hours or founded year); the defaults are only the base when nothing valid is published.
    merged = g ? { ...g, visibility: { ...g.visibility } } : { ...DEFAULT_CONTACT, visibility: { ...DEFAULT_CONTACT.visibility } };
    if (p) {
      const { visibility, ...rest } = p as Partial<ContactData> & { visibility?: Partial<ContactData["visibility"]> };
      merged = { ...merged, ...rest, visibility: { ...merged.visibility, ...(visibility ?? {}) } } as ContactData;
    }
  } catch { merged = DEFAULT_CONTACT; }
  const v = merged.visibility;
  const out: PublicContact = {};
  if (v.foundedYear && merged.foundedYear) out.foundedYear = merged.foundedYear;
  if (v.generalEmail) out.generalEmail = merged.generalEmail;
  if (v.b2bEmail) out.b2bEmail = merged.b2bEmail;
  if (v.phones && merged.phones.length) out.phones = merged.phones;
  if (v.whatsapp && merged.whatsapp) out.whatsapp = merged.whatsapp;
  if (v.address && merged.address) out.address = merged.address;
  if (v.hours && merged.hours) out.hours = merged.hours;
  if (v.map) { const e = mapEmbedUrl(merged.map), l = mapLinkUrl(merged.map); if (e) out.mapEmbedUrl = e; if (l) out.mapLinkUrl = l; }
  return out;
}

// Pages ask for the contact on every render (the root layout), so reads are cached in-process for a
// short time and dropped the moment something is saved or published here.
const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; value: PublicContact }>();
export function clearContactCache() { cache.clear(); }

export async function getPublicContact(scope: Scope = "portal"): Promise<PublicContact> {
  const hit = cache.get(scope);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await computePublicContact(scope);
  cache.set(scope, { at: Date.now(), value });
  return value;
}
