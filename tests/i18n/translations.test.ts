/** Phase 4: managed-content translations. Drafts never replace approved text; AI is assistance only. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { ensureSchema, getPrisma } from "../travel-db/helpers";

let prisma: PrismaClient;
let svc: typeof import("@/lib/i18n/translations");
let prov: typeof import("@/lib/i18n/provider");
let product: any;
const editor = { id: "u-editor", permissions: new Set(["content.translate"]) } as any;
const approver = { id: "u-approver", permissions: new Set(["content.translate", "content.approve"]) } as any;
const nobody = { id: "u-none", permissions: new Set() } as any;
const key = () => ({ entity: "ServiceProduct", entityId: product.id, field: "name", locale: "hy" });

beforeAll(async () => {
  ensureSchema();
  prisma = await getPrisma();
  svc = await import("@/lib/i18n/translations");
  prov = await import("@/lib/i18n/provider");
  product = await prisma.serviceProduct.create({ data: { name: "Garni and Geghard tour", details: "Full day with lunch.", category: "TICKETS", basis: "PER_PERSON" } });
});

describe("resolution and fallback", () => {
  it("English is the source: with no translation the English text is returned and flagged as a fallback", async () => {
    const r = await svc.resolveText({ ...key(), english: "Garni and Geghard tour" });
    expect(r).toMatchObject({ text: "Garni and Geghard tour", fallback: true, stale: false });
    expect((await svc.resolveText({ ...key(), locale: "en", english: "X" })).fallback).toBe(false);
    expect((await svc.resolveText({ ...key(), locale: "ar", english: "X" })).text).toBe("X"); // disabled locale: English
  });
});

describe("human draft, approval, supersede, history", () => {
  it("a draft is invisible to readers until approved; approval needs content.approve", async () => {
    const d = await svc.saveDraft(editor, { ...key(), text: "Գառնիի և Գեղարդի էքսկուրսիա" });
    expect(d).toMatchObject({ status: "DRAFT", source: "HUMAN", version: 1 });
    expect((await svc.resolveText({ ...key(), english: "Garni and Geghard tour" })).fallback).toBe(true);
    await expect(svc.approve(editor, d.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(svc.approve(nobody, d.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const a = await svc.approve(approver, d.id);
    expect(a).toMatchObject({ status: "APPROVED", approvedById: "u-approver" });
    expect(await svc.resolveText({ ...key(), english: "Garni and Geghard tour" })).toMatchObject({ text: "Գառնիի և Գեղարդի էքսկուրսիա", fallback: false });
  });
  it("editing an approved translation creates a new draft; the published text stays until the new one is approved, then the old is superseded and kept", async () => {
    const d2 = await svc.saveDraft(editor, { ...key(), text: "Գառնի և Գեղարդ" });
    expect(d2.version).toBe(2);
    expect((await svc.resolveText({ ...key(), english: "Garni and Geghard tour" })).text).toBe("Գառնիի և Գեղարդի էքսկուրսիա");
    await svc.approve(approver, d2.id);
    expect((await svc.resolveText({ ...key(), english: "Garni and Geghard tour" })).text).toBe("Գառնի և Գեղարդ");
    const hist = await svc.history(key());
    expect(hist.map((h) => [h.version, h.status])).toEqual([[2, "APPROVED"], [1, "SUPERSEDED"]]);
    expect(hist[1].events.map((e) => e.action)).toEqual(expect.arrayContaining(["CREATED", "APPROVED", "SUPERSEDED"]));
  });
  it("validates entity, field, locale and text", async () => {
    for (const bad of [
      { ...key(), entity: "TravelRequest" }, { ...key(), field: "unitRate" }, { ...key(), locale: "en" },
      { ...key(), locale: "ar" }, { ...key(), text: "   " }, { ...key(), text: "x".repeat(4001) }, { ...key(), entityId: "missing" },
    ]) await expect(svc.saveDraft(editor, { text: "ok", ...bad } as any)).rejects.toMatchObject({ code: expect.stringMatching(/INVALID|NOT_FOUND/) });
    await expect(svc.saveDraft(nobody, { ...key(), text: "ok" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("a translation written against old English is flagged stale and cannot be approved until revised", async () => {
    const p2 = await prisma.serviceProduct.create({ data: { name: "Old name", category: "TICKETS", basis: "PER_PERSON" } });
    const k = { entity: "ServiceProduct", entityId: p2.id, field: "name", locale: "hy" };
    const d = await svc.saveDraft(editor, { ...k, text: "Հին անուն" });
    await svc.approve(approver, d.id);
    await prisma.serviceProduct.update({ where: { id: p2.id }, data: { name: "New name" } });
    const r = await svc.resolveText({ ...k, english: "New name" });
    expect(r).toMatchObject({ text: "Հին անուն", stale: true, fallback: false }); // human-approved text is never silently dropped
    const d2 = await svc.saveDraft(editor, { ...k, text: "Նոր անուն" });
    expect(d2.sourceHash).not.toBe(d.sourceHash);
    await prisma.serviceProduct.update({ where: { id: p2.id }, data: { name: "Newer name" } });
    await expect(svc.approve(approver, d2.id)).rejects.toMatchObject({ code: "STALE_SOURCE" });
  });
});

describe("AI assistance", () => {
  const fake = (out = "Ինքնաթիռի տոմս") => ({ id: "fake:model-1", translate: vi.fn(async () => out) });
  it("is disabled unless a provider is configured: no provider means a clear error and no row", async () => {
    await expect(svc.requestAiDraft(editor, key(), null)).rejects.toMatchObject({ code: "AI_DISABLED" });
    expect(prov.getTranslationProvider({} as any)).toBeNull();
    expect(prov.getTranslationProvider({ TRANSLATION_PROVIDER: "deepseek" } as any)).toBeNull(); // key missing
    expect(prov.getTranslationProvider({ TRANSLATION_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "k" } as any)?.id).toMatch(/deepseek/);
  });
  it("creates only a DRAFT with model, hash and an AI_GENERATED event; it never overwrites approved human text", async () => {
    const p = await prisma.serviceProduct.create({ data: { name: "Airport transfer", category: "TICKETS", basis: "GROUP" } });
    const k = { entity: "ServiceProduct", entityId: p.id, field: "name", locale: "hy" };
    const human = await svc.approve(approver, (await svc.saveDraft(editor, { ...k, text: "Օդանավակայանի տրանսֆեր" })).id);
    const f = fake();
    const ai = await svc.requestAiDraft(editor, k, f);
    expect(ai).toMatchObject({ status: "DRAFT", source: "AI", model: "fake:model-1" });
    expect(f.translate).toHaveBeenCalledWith("Airport transfer", "hy");
    expect((await svc.resolveText({ ...k, english: "Airport transfer" })).text).toBe("Օդանավակայանի տրանսֆեր");
    expect((await prisma.translation.findUniqueOrThrow({ where: { id: human.id } })).status).toBe("APPROVED");
    expect((await svc.history(k))[0].events.map((e) => e.action)).toContain("AI_GENERATED");
    // a human edits the AI draft, then approves: source becomes HUMAN-reviewed
    const edited = await svc.saveDraft(editor, { ...k, text: "Օդանավակայանի փոխադրում" });
    expect(edited.source).toBe("HUMAN");
    await svc.approve(approver, edited.id);
    expect((await svc.resolveText({ ...k, english: "Airport transfer" })).text).toBe("Օդանավակայանի փոխադրում");
  });
  it("sends only the English field text and refuses sources that look like personal or booking data", async () => {
    for (const secret of ["Contact john@client.com about it", "Call +374 91 005046 tomorrow", "Booking DEMO-2026-11-10-0001 for Hayk"]) {
      const p = await prisma.serviceProduct.create({ data: { name: secret, category: "TICKETS", basis: "GROUP" } });
      const f = fake();
      await expect(svc.requestAiDraft(editor, { entity: "ServiceProduct", entityId: p.id, field: "name", locale: "hy" }, f)).rejects.toMatchObject({ code: "SENSITIVE_SOURCE" });
      expect(f.translate).not.toHaveBeenCalled();
    }
  });
  it("an AI draft is refused while a human draft is waiting (human work is never pushed out of review)", async () => {
    const p = await prisma.serviceProduct.create({ data: { name: "Sevan boat trip", category: "TICKETS", basis: "PER_PERSON" } });
    const k = { entity: "ServiceProduct", entityId: p.id, field: "name", locale: "hy" };
    const human = await svc.saveDraft(editor, { ...k, text: "Սևանի նավակ" });
    await expect(svc.requestAiDraft(editor, k, fake())).rejects.toMatchObject({ code: "HUMAN_DRAFT_PENDING", httpStatus: 409 });
    expect((await prisma.translation.findUniqueOrThrow({ where: { id: human.id } })).status).toBe("DRAFT");
    await svc.approve(approver, human.id);
    // after approval an AI draft may be requested; it supersedes nothing that is approved
    const ai = await svc.requestAiDraft(editor, k, fake());
    expect(ai.status).toBe("DRAFT");
    expect((await prisma.translation.findUniqueOrThrow({ where: { id: human.id } })).status).toBe("APPROVED");
  });
  it("two simultaneous saves never produce a 500: one wins, the other is a clean conflict or a later version", async () => {
    const p = await prisma.serviceProduct.create({ data: { name: "Dilijan walk", category: "TICKETS", basis: "PER_PERSON" } });
    const k = { entity: "ServiceProduct", entityId: p.id, field: "name", locale: "hy" };
    const out = await Promise.allSettled([svc.saveDraft(editor, { ...k, text: "A" }), svc.saveDraft(editor, { ...k, text: "B" })]);
    for (const o of out) if (o.status === "rejected") expect((o.reason as any).code).toBe("CONFLICT");
    expect(out.some((o) => o.status === "fulfilled")).toBe(true);
    const versions = (await prisma.translation.findMany({ where: { entityId: p.id } })).map((r) => r.version);
    expect(new Set(versions).size).toBe(versions.length);
  });
  it("requires content.translate and an allow-listed entity; provider failure leaves no row and leaks no detail", async () => {
    const p = await prisma.serviceProduct.create({ data: { name: "Winery visit", category: "TICKETS", basis: "PER_PERSON" } });
    const k = { entity: "ServiceProduct", entityId: p.id, field: "name", locale: "hy" };
    await expect(svc.requestAiDraft(nobody, k, fake())).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(svc.requestAiDraft(editor, { ...k, entity: "TravelRequest" }, fake())).rejects.toMatchObject({ code: "INVALID_ENTITY" });
    const boom = { id: "fake:boom", translate: vi.fn(async () => { throw new Error("401 key=sk-secret"); }) };
    await expect(svc.requestAiDraft(editor, k, boom)).rejects.toMatchObject({ code: "AI_FAILED", message: expect.not.stringContaining("sk-secret") });
    expect(await prisma.translation.count({ where: { entityId: p.id } })).toBe(0);
  });
  it("the DeepSeek adapter posts only the system prompt and the text, with the key in the header, and returns the content", async () => {
    const fetchMock = vi.fn(async (_url: string, init: any) => ({ ok: true, json: async () => ({ choices: [{ message: { content: " Թարգմանություն " } }] }), _init: init }));
    const p = prov.deepSeekProvider("KEY123", fetchMock as any);
    expect(await p.translate("Hello", "hy")).toBe("Թարգմանություն");
    const [url, init] = fetchMock.mock.calls[0] as any;
    expect(url).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer KEY123");
    const body = JSON.parse(init.body);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[1]).toEqual({ role: "user", content: "Hello" });
    expect(JSON.stringify(body)).not.toContain("KEY123");
  });
});

describe("missing-translation check", () => {
  it("lists translatable fields without an approved translation", async () => {
    const missing = await svc.missingTranslations("hy");
    expect(missing.some((m) => m.entity === "ServiceProduct" && m.entityId === product.id && m.field === "details")).toBe(true);
    expect(missing.some((m) => m.entityId === product.id && m.field === "name")).toBe(false); // approved above
    await prisma.serviceProduct.update({ where: { id: product.id }, data: { name: "Garni and Geghard tour (updated)" } });
    expect((await svc.missingTranslations("hy")).find((m) => m.entityId === product.id && m.field === "name")).toMatchObject({ stale: true });
  });
});

describe("sensitiveReason", () => {
  it("lets ordinary tourism text through and stops contact data", async () => {
    const { sensitiveReason } = await import("@/lib/i18n/provider");
    expect(sensitiveReason("Open 2019-2026, group of 12, 3 nights, 15:00-18:30")).toBeNull();
    expect(sensitiveReason("Visit Garni temple (1st century AD).")).toBeNull();
    expect(sensitiveReason("+374 10 545046")).toBe("phone number");
    expect(sensitiveReason("write to info@nare.am")).toBe("email address");
    expect(sensitiveReason("see https://x.test")).toBe("link");
    // review hardening: money, obfuscation, other digit scripts, short local numbers, case
    expect(sensitiveReason("net 45 USD, margin 15%")).toBe("price, cost, rate or margin");
    expect(sensitiveReason("supplier rate for the group")).toBe("price, cost, rate or margin");
    expect(sensitiveReason("call ٠١٠ ٥٤٥٠٤٦")).toBe("phone number");           // Arabic-Indic digits
    expect(sensitiveReason("call １０ ５４５０４６")).toBe("phone number");       // fullwidth digits
    expect(sensitiveReason("10 545046")).toBe("phone number");
    expect(sensitiveReason("mail info＠nare.am")).toBe("email address");        // fullwidth @
    expect(sensitiveReason("name at nare dot am")).toBe("email address");
    expect(sensitiveReason("ref demo-2026-11-10-0001")).toBe("booking reference");
    expect(sensitiveReason("Lunch is included; group of 12, 3 nights, 2019-2026 season")).toBeNull();
  });
});
