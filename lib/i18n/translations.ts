/**
 * Managed-content translations (B2B cycle 1, Phase 4).
 *
 * Rules: English (the entity itself) is the source and the fallback. A translation is a
 * versioned row; only the latest APPROVED row is published. Humans and AI both write DRAFTs;
 * approval is a separate permission and a person's act. An approved translation is never
 * overwritten by anything: edits and AI drafts create new versions, approval supersedes the
 * old one and keeps it as history. Translations written against older English are flagged
 * stale (still shown, never silently dropped) and cannot be approved until revised.
 */

import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { hasPermission } from "@/lib/permissions";
import { DEFAULT_LOCALE, LOCALES, resolveLocale, type Locale } from "@/lib/i18n/locales";
import { sensitiveReason, type TranslationProvider } from "@/lib/i18n/provider";

export class I18nError extends Error {
  constructor(public code: string, message: string, public httpStatus = 400) { super(message); }
}

type Actor = { id: string; permissions?: ReadonlySet<string> | undefined };
export interface Key { entity: string; entityId: string; field: string; locale: string }

const MAX_TEXT = 4000;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const need = (actor: Actor, key: "content.translate" | "content.approve") => {
  if (!hasPermission(actor as never, key)) throw new I18nError("FORBIDDEN", "not allowed", 403);
};

// ---- allow-list: only admin-managed content can be translated, never request/client data
const DAY_FIELD = /^day:(\d{1,2}):narrative$/;
const ENTITY_FIELDS: Record<string, (field: string) => boolean> = {
  ServiceProduct: (f) => f === "name" || f === "details",
  PackageTemplate: (f) => f === "name",
  TemplateVersion: (f) => DAY_FIELD.test(f),
};

/** The current English text, or null when the entity/field does not exist. */
export async function sourceText(entity: string, entityId: string, field: string): Promise<string | null> {
  if (!ENTITY_FIELDS[entity]?.(field)) throw new I18nError("INVALID_ENTITY", "this content cannot be translated");
  if (entity === "ServiceProduct") {
    const r = await prisma.serviceProduct.findUnique({ where: { id: entityId }, select: { name: true, details: true } });
    return r ? ((field === "name" ? r.name : r.details) ?? null) : null;
  }
  if (entity === "PackageTemplate") return (await prisma.packageTemplate.findUnique({ where: { id: entityId }, select: { name: true } }))?.name ?? null;
  const tv = await prisma.templateVersion.findUnique({ where: { id: entityId }, select: { daysJson: true } });
  if (!tv) return null;
  try {
    const off = Number(DAY_FIELD.exec(field)![1]);
    const day = (JSON.parse(tv.daysJson) as Array<{ dayOffset: number; narrative?: string | null }>).find((d) => d.dayOffset === off);
    return day?.narrative ?? null;
  } catch { return null; }
}

function checkKey(k: Key): Locale {
  if (!ENTITY_FIELDS[k.entity]?.(k.field)) throw new I18nError("INVALID_ENTITY", "this content cannot be translated");
  const loc = k.locale as Locale;
  if (!(loc in LOCALES) || loc === DEFAULT_LOCALE || !LOCALES[loc].enabled) throw new I18nError("INVALID_LOCALE", "locale is not available for translation");
  return loc;
}

async function event(translationId: string, action: string, actorId: string | null, detail?: object) {
  await prisma.translationEvent.create({ data: { translationId, action, actorId, detail: detail ? JSON.stringify(detail) : null } });
}

// ---- reading
export interface Resolved { text: string; locale: Locale; fallback: boolean; stale: boolean }

/** Published text for a locale, else English. `english` is the caller's current source text. */
export async function resolveText(input: Key & { english: string }): Promise<Resolved> {
  const locale = resolveLocale(input.locale);
  if (locale === DEFAULT_LOCALE) return { text: input.english, locale, fallback: false, stale: false };
  const row = await prisma.translation.findFirst({
    where: { entity: input.entity, entityId: input.entityId, field: input.field, locale, status: "APPROVED" },
    orderBy: { version: "desc" },
  });
  if (!row) return { text: input.english, locale: DEFAULT_LOCALE, fallback: true, stale: false };
  return { text: row.text, locale, fallback: false, stale: row.sourceHash !== sha(input.english) };
}

export async function history(k: Key) {
  return prisma.translation.findMany({
    where: { entity: k.entity, entityId: k.entityId, field: k.field, locale: k.locale },
    orderBy: { version: "desc" },
    include: { events: { orderBy: { createdAt: "asc" } } },
  });
}

// ---- writing
async function nextVersion(k: Key) {
  const last = await prisma.translation.findFirst({ where: { entity: k.entity, entityId: k.entityId, field: k.field, locale: k.locale }, orderBy: { version: "desc" }, select: { version: true } });
  return (last?.version ?? 0) + 1;
}

async function createDraft(actor: Actor, k: Key, text: string, source: "HUMAN" | "AI", model: string | null, english: string) {
  const version = await nextVersion(k);
  const created = await prisma.$transaction(async (tx) => {
    // Older unapproved drafts are superseded (kept as history); APPROVED rows are never touched here.
    await tx.translation.updateMany({ where: { entity: k.entity, entityId: k.entityId, field: k.field, locale: k.locale, status: "DRAFT" }, data: { status: "SUPERSEDED" } });
    const row = await tx.translation.create({ data: { ...k, version, text, status: "DRAFT", source, model, sourceHash: sha(english), createdById: actor.id } });
    await tx.translationEvent.create({ data: { translationId: row.id, action: source === "AI" ? "AI_GENERATED" : "CREATED", actorId: actor.id, detail: JSON.stringify({ model, sourceHash: row.sourceHash }) } });
    return row;
  });
  return created;
}

export async function saveDraft(actor: Actor, input: Key & { text: string }) {
  need(actor, "content.translate");
  checkKey(input);
  const text = input.text.trim();
  if (!text) throw new I18nError("INVALID_TEXT", "text is empty");
  if (input.text.length > MAX_TEXT) throw new I18nError("INVALID_TEXT", "text is too long");
  const english = await sourceText(input.entity, input.entityId, input.field);
  if (english === null) throw new I18nError("NOT_FOUND", "source content not found", 404);
  const row = await createDraft(actor, input, text, "HUMAN", null, english);
  await writeAuditLog("translation.draft", actor.id, JSON.stringify({ id: row.id, entity: input.entity, field: input.field, locale: input.locale, version: row.version, source: "HUMAN" }));
  return row;
}

export async function requestAiDraft(actor: Actor, k: Key, provider: TranslationProvider | null) {
  need(actor, "content.translate");
  checkKey(k);
  if (!provider) throw new I18nError("AI_DISABLED", "AI translation is not configured on this server");
  const english = await sourceText(k.entity, k.entityId, k.field);
  if (english === null || !english.trim()) throw new I18nError("NOT_FOUND", "source content not found", 404);
  if (english.length > MAX_TEXT) throw new I18nError("INVALID_TEXT", "source text is too long");
  const reason = sensitiveReason(english);
  if (reason) throw new I18nError("SENSITIVE_SOURCE", `the source text contains a ${reason}; edit it before using AI translation`);
  let out: string;
  try { out = await provider.translate(english, k.locale); }
  catch { throw new I18nError("AI_FAILED", "the AI provider could not translate this text", 502); }
  if (!out.trim() || out.length > MAX_TEXT) throw new I18nError("AI_FAILED", "the AI provider returned an unusable answer", 502);
  const row = await createDraft(actor, k, out.trim(), "AI", provider.id, english);
  await writeAuditLog("translation.ai_draft", actor.id, JSON.stringify({ id: row.id, entity: k.entity, field: k.field, locale: k.locale, version: row.version, model: provider.id }));
  return row;
}

export async function approve(actor: Actor, translationId: string) {
  need(actor, "content.approve");
  const row = await prisma.translation.findUnique({ where: { id: translationId } });
  if (!row) throw new I18nError("NOT_FOUND", "translation not found", 404);
  if (row.status !== "DRAFT") throw new I18nError("INVALID_STATE", "only a draft can be approved", 409);
  const english = await sourceText(row.entity, row.entityId, row.field);
  if (english === null || sha(english) !== row.sourceHash) throw new I18nError("STALE_SOURCE", "the English text changed after this draft was written; revise it first", 409);
  const approved = await prisma.$transaction(async (tx) => {
    const lock = await tx.translation.updateMany({ where: { id: row.id, status: "DRAFT" }, data: { status: "APPROVED", approvedById: actor.id, approvedAt: new Date() } });
    if (lock.count === 0) throw new I18nError("INVALID_STATE", "already decided", 409);
    const old = await tx.translation.findMany({ where: { entity: row.entity, entityId: row.entityId, field: row.field, locale: row.locale, status: "APPROVED", id: { not: row.id } } });
    for (const o of old) {
      await tx.translation.update({ where: { id: o.id }, data: { status: "SUPERSEDED" } });
      await tx.translationEvent.create({ data: { translationId: o.id, action: "SUPERSEDED", actorId: actor.id, detail: JSON.stringify({ by: row.id }) } });
    }
    await tx.translationEvent.create({ data: { translationId: row.id, action: "APPROVED", actorId: actor.id, detail: JSON.stringify({ source: row.source, model: row.model }) } });
    return tx.translation.findUniqueOrThrow({ where: { id: row.id } });
  });
  await writeAuditLog("translation.approve", actor.id, JSON.stringify({ id: row.id, entity: row.entity, field: row.field, locale: row.locale, version: row.version }));
  return approved;
}

export async function reject(actor: Actor, translationId: string, reason?: string) {
  need(actor, "content.approve");
  const res = await prisma.translation.updateMany({ where: { id: translationId, status: "DRAFT" }, data: { status: "REJECTED" } });
  if (res.count === 0) throw new I18nError("INVALID_STATE", "only a draft can be rejected", 409);
  await event(translationId, "REJECTED", actor.id, reason ? { reason: reason.slice(0, 500) } : undefined);
  await writeAuditLog("translation.reject", actor.id, JSON.stringify({ id: translationId }));
}

// ---- the missing-translation check
export interface MissingItem { entity: string; entityId: string; field: string; label: string; english: string }

async function candidatesFor(limit: number): Promise<MissingItem[]> {
  const candidates: MissingItem[] = [];
  for (const p of await prisma.serviceProduct.findMany({ where: { active: true }, select: { id: true, name: true, details: true }, take: limit })) {
    candidates.push({ entity: "ServiceProduct", entityId: p.id, field: "name", label: p.name, english: p.name });
    if (p.details?.trim()) candidates.push({ entity: "ServiceProduct", entityId: p.id, field: "details", label: `${p.name} (details)`, english: p.details });
  }
  for (const t of await prisma.packageTemplate.findMany({ select: { id: true, name: true }, take: limit })) candidates.push({ entity: "PackageTemplate", entityId: t.id, field: "name", label: t.name, english: t.name });
  for (const v of await prisma.templateVersion.findMany({ where: { status: "ACTIVE" }, select: { id: true, daysJson: true, template: { select: { code: true } } }, take: limit })) {
    try {
      for (const d of JSON.parse(v.daysJson) as Array<{ dayOffset: number; narrative?: string | null }>) {
        if (d.narrative?.trim()) candidates.push({ entity: "TemplateVersion", entityId: v.id, field: `day:${d.dayOffset}:narrative`, label: `${v.template.code} day ${d.dayOffset + 1}`, english: d.narrative });
      }
    } catch { /* malformed template JSON is reported elsewhere */ }
  }
  return candidates;
}

export async function missingTranslations(locale: string, limit = 500): Promise<MissingItem[]> {
  const loc = checkKey({ entity: "ServiceProduct", entityId: "", field: "name", locale });
  const candidates = await candidatesFor(limit);
  const approved = await prisma.translation.findMany({ where: { locale: loc, status: "APPROVED" }, select: { entity: true, entityId: true, field: true } });
  const have = new Set(approved.map((a) => `${a.entity}|${a.entityId}|${a.field}`));
  return candidates.filter((c) => !have.has(`${c.entity}|${c.entityId}|${c.field}`)).slice(0, limit);
}

export type ItemState = "missing" | "draft" | "approved" | "stale";
export interface OverviewItem extends MissingItem { state: ItemState; hasAiDraft: boolean }

/** Every translatable item with its state for a locale (drives the admin screen). */
export async function overview(locale: string, limit = 500): Promise<OverviewItem[]> {
  const loc = checkKey({ entity: "ServiceProduct", entityId: "", field: "name", locale });
  const candidates = await candidatesFor(limit);
  const rows = await prisma.translation.findMany({ where: { locale: loc, status: { in: ["APPROVED", "DRAFT"] } }, select: { entity: true, entityId: true, field: true, status: true, sourceHash: true, source: true } });
  const by = new Map<string, typeof rows>();
  for (const r of rows) { const k = `${r.entity}|${r.entityId}|${r.field}`; by.set(k, [...(by.get(k) ?? []), r]); }
  return candidates.map((c) => {
    const rs = by.get(`${c.entity}|${c.entityId}|${c.field}`) ?? [];
    const ap = rs.find((r) => r.status === "APPROVED"), dr = rs.find((r) => r.status === "DRAFT");
    const state: ItemState = ap ? (ap.sourceHash !== sha(c.english) ? "stale" : "approved") : dr ? "draft" : "missing";
    return { ...c, state, hasAiDraft: dr?.source === "AI" };
  });
}
