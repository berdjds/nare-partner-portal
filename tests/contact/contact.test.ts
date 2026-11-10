/** Phase 4: company/contact configuration: validation, draft/publish, scopes, fallbacks, visibility, audit. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { ensureSchema, getPrisma } from "../travel-db/helpers";
import { contactDataSchema, DEFAULT_CONTACT, mapEmbedUrl, mapLinkUrl } from "@/lib/contact/schema";

let prisma: PrismaClient;
let svc: typeof import("@/lib/contact/service");
const admin = { id: "u-admin", permissions: new Set(["admin.settings"]) } as any;
const other = { id: "u-other", permissions: new Set() } as any;
const base = () => ({ ...DEFAULT_CONTACT });

beforeAll(async () => { ensureSchema(); prisma = await getPrisma(); svc = await import("@/lib/contact/service"); });

describe("schema", () => {
  it("the built-in defaults are exactly the approved business data and validate", () => {
    expect(DEFAULT_CONTACT).toMatchObject({ foundedYear: 2019, generalEmail: "info@nare.am", b2bEmail: "reservation@nare.am" });
    expect(DEFAULT_CONTACT.phones.map((p) => p.number)).toEqual(["+374 91 005046", "+374 10 545046"]);
    expect(contactDataSchema.safeParse(DEFAULT_CONTACT).success).toBe(true);
  });
  it("rejects bad emails, phones, years, hours length, unknown keys and unsafe map input", () => {
    const bad = (o: object) => contactDataSchema.safeParse({ ...base(), ...o }).success;
    expect(bad({ generalEmail: "nope" })).toBe(false);
    expect(bad({ b2bEmail: "a@b" })).toBe(false);
    expect(bad({ phones: [{ number: "12" }] })).toBe(false);
    expect(bad({ phones: [{ number: "+374 91 005046" }, { number: "abc" }] })).toBe(false);
    expect(bad({ whatsapp: "+37491005046" })).toBe(true);
    expect(bad({ whatsapp: "wa.me/x" })).toBe(false);
    expect(bad({ foundedYear: 1800 })).toBe(false);
    expect(bad({ foundedYear: 3000 })).toBe(false);
    expect(bad({ address: "x".repeat(301) })).toBe(false);
    expect(bad({ extra: 1 })).toBe(false);
    expect(bad({ map: { lat: 91, lng: 0 } })).toBe(false);
    expect(bad({ map: { lat: 40.18, lng: 44.51 } })).toBe(true);
    expect(bad({ map: { url: "https://evil.example/maps" } })).toBe(false);
    expect(bad({ map: { url: "javascript:alert(1)" } })).toBe(false);
    expect(bad({ map: { url: "https://www.google.com/url?q=https://evil.example" } })).toBe(false); // redirector, not /maps
    expect(bad({ map: { url: "https://goo.gl/maps/abc" } })).toBe(false);
    expect(bad({ map: { url: "https://evil@www.google.com/maps/x" } })).toBe(false); // userinfo
    expect(bad({ map: { url: "https://maps.app.goo.gl/abc123" } })).toBe(true);
    expect(bad({ map: { url: "https://www.google.com/maps/place/Nare" } })).toBe(true);
    expect(bad({ map: { placeId: "ChIJ-bad id!" } })).toBe(false);
    expect(bad({ map: { placeId: "ChIJN1t_tDeuEmsRUsoyG83frY4" } })).toBe(true);
  });
  it("map embed and link are built without any API key", () => {
    expect(mapEmbedUrl({ lat: 40.1792, lng: 44.4991 })).toBe("https://www.google.com/maps?q=40.1792,44.4991&z=16&output=embed");
    expect(mapEmbedUrl({})).toBeNull();
    expect(mapLinkUrl({ placeId: "ChIJabc_-123" })).toBe("https://www.google.com/maps/place/?q=place_id:ChIJabc_-123");
    expect(mapLinkUrl({ url: "https://maps.app.goo.gl/abc" })).toBe("https://maps.app.goo.gl/abc");
    expect(`${mapEmbedUrl({ lat: 1, lng: 2 })}${mapLinkUrl({ lat: 1, lng: 2 })}`).not.toMatch(/key=/i);
  });
});

describe("service", () => {
  it("with nothing published the public contact is the approved defaults (safe fallback)", async () => {
    const c = await svc.getPublicContact("portal");
    expect(c).toMatchObject({ foundedYear: 2019, generalEmail: "info@nare.am", b2bEmail: "reservation@nare.am" });
  });
  it("a draft is invisible; publishing makes it live and supersedes the previous version; history is kept", async () => {
    const d = await svc.saveDraft(admin, "global", { ...base(), address: "Draft address 1" }, "first");
    expect((await svc.getPublicContact("portal")).address).not.toBe("Draft address 1");
    await expect(svc.publish(other, d.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await svc.publish(admin, d.id);
    expect((await svc.getPublicContact("portal")).address).toBe("Draft address 1");
    const d2 = await svc.saveDraft(admin, "global", { ...base(), address: "Draft address 2" }, "second");
    await svc.publish(admin, d2.id);
    const h = await svc.history("global");
    expect(h.map((r) => [r.version, r.status])).toEqual([[2, "PUBLISHED"], [1, "SUPERSEDED"]]);
    expect(h[0]).toMatchObject({ publishedById: "u-admin", note: "second" });
    expect((await svc.getPublicContact("portal")).address).toBe("Draft address 2");
  });
  it("a portal override wins over global for the fields it sets; unset fields keep inheriting", async () => {
    const d = await svc.saveDraft(admin, "portal", { b2bEmail: "b2b-override@nare.am" }, "portal override");
    await svc.publish(admin, d.id);
    const c = await svc.getPublicContact("portal");
    expect(c.b2bEmail).toBe("b2b-override@nare.am");
    expect(c.address).toBe("Draft address 2");
    expect((await svc.getPublicContact("global")).b2bEmail).toBe("reservation@nare.am");
  });
  it("visibility flags remove fields from the public payload entirely", async () => {
    const d = await svc.saveDraft(admin, "portal", { b2bEmail: "b2b-override@nare.am", visibility: { phones: false, address: false } }, "hide");
    await svc.publish(admin, d.id);
    const c: any = await svc.getPublicContact("portal");
    expect(c.phones).toBeUndefined();
    expect(c.address).toBeUndefined();
    expect(c.generalEmail).toBeDefined();
    expect(JSON.stringify(c)).not.toContain("005046");
  });
  it("a portal override may be partial but is still validated; global must be complete", async () => {
    await expect(svc.saveDraft(admin, "portal", { b2bEmail: "nope" })).rejects.toMatchObject({ code: "INVALID_CONTACT" });
    await expect(svc.saveDraft(admin, "portal", { unknown: 1 })).rejects.toMatchObject({ code: "INVALID_CONTACT" });
    await expect(svc.saveDraft(admin, "global", { b2bEmail: "a@b.co" })).rejects.toMatchObject({ code: "INVALID_CONTACT" });
  });
  it("rejects invalid data and unknown scopes with a stable code; requires admin.settings", async () => {
    await expect(svc.saveDraft(admin, "global", { ...base(), generalEmail: "x" } as any)).rejects.toMatchObject({ code: "INVALID_CONTACT" });
    await expect(svc.saveDraft(admin, "tenant" as any, base())).rejects.toMatchObject({ code: "INVALID_SCOPE" });
    await expect(svc.saveDraft(other, "global", base())).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("audits drafts and publications", async () => {
    const logs = (await prisma.log.findMany({ where: { action: { in: ["contact.draft", "contact.publish"] } } })).map((l) => JSON.parse(l.details!.slice(0, l.details!.lastIndexOf("}") + 1)));
    expect(logs.some((l) => l.scope === "portal")).toBe(true);
    expect(JSON.stringify(logs)).not.toContain("@nare.am"); // ids and versions only, not the content
  });
  it("a published global profile replaces the built-in defaults: a cleared address stays cleared", async () => {
    const { address: _a, ...noAddress } = base() as any;
    const d = await svc.saveDraft(admin, "global", noAddress, "no address");
    await svc.publish(admin, d.id);
    svc.clearContactCache();
    expect((await svc.getPublicContact("global")).address).toBeUndefined();
    expect((await svc.getPublicContact("global")).generalEmail).toBe("info@nare.am");
  });
  it("reads are cached briefly and dropped on save/publish", async () => {
    svc.clearContactCache();
    const a = await svc.getPublicContact("portal"); const b = await svc.getPublicContact("portal");
    expect(b).toBe(a); // same cached object
    const d = await svc.saveDraft(admin, "global", { ...base(), hours: "Cache test" });
    await svc.publish(admin, d.id);
    expect(await svc.getPublicContact("global")).not.toBe(a);
  });
  it("falls back to the defaults, not an error, when the database read fails; and a corrupt stored row is skipped", async () => {
    const bad = await prisma.contactProfile.create({ data: { scope: "global", version: 99, status: "PUBLISHED", dataJson: "{not json" } });
    svc.clearContactCache();
    const ok = await svc.getPublicContact("portal");
    expect(ok.generalEmail).toBeDefined();
    await prisma.contactProfile.delete({ where: { id: bad.id } });
    svc.clearContactCache();
    const spy = vi.spyOn(prisma.contactProfile, "findMany").mockRejectedValueOnce(new Error("db down"));
    expect((await svc.getPublicContact("portal")).generalEmail).toBe("info@nare.am");
    spy.mockRestore();
  });
});
