/**
 * int-lock: INTERNAL costing-sheet documents (QuoteDocument.kind ===
 * "INTERNAL") must never be sent via WhatsApp — by anyone, through any path.
 *
 * - POST /api/travel/documents/[id]/send with an INTERNAL id is rejected with
 *   403 for ADMIN, the request owner and the assigned validator alike; an
 *   unrelated travel user still gets 404 (existence is not disclosed).
 * - sendQuoteDocument() itself refuses INTERNAL ids for userIds and groupJids
 *   alike, so no code path (route, auto-send, future callers) can attach an
 *   INTERNAL document to a WhatsApp message — the refusal is audited as
 *   QUOTE_DOCUMENT_SEND_REFUSED, never QUOTE_DOCUMENT_SENT.
 * - Regression: CLIENT documents still send for an authorized actor.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";
import { ensureSchema, getPrisma } from "../travel-db/helpers";
import { actorOf, createRequestInput, seedFixtures, type Fixtures } from "../workflow/fixtures";
import { sendWhatsAppMessage } from "@/lib/whatsapp";
import { sendQuoteDocument } from "@/lib/travel/whatsapp-docs";

const { sessionRef } = vi.hoisted(() => ({ sessionRef: { current: null as any } }));
vi.mock("next-auth/next", () => ({
  getServerSession: vi.fn(async () => sessionRef.current),
}));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ providerId: "smtp-test" })) }));
vi.mock("@/lib/whatsapp", () => ({
  sendWhatsAppMessage: vi.fn(async () => ({ id: { _serialized: "wa-test" } })),
}));
vi.mock("@/lib/travel/pdf/render", () => ({
  renderQuotationPdf: vi.fn(async () => Buffer.from("%PDF-1.4 fake")),
}));

let prisma: PrismaClient;
let workflow: typeof import("@/lib/travel/workflow");
let fx: Fixtures;

let documentSendRoute: typeof import("@/app/api/travel/documents/[id]/send/route");

const sendMock = vi.mocked(sendWhatsAppMessage);

type Userish = { id: string; role: string; name: string | null; email: string };

function session(user: Userish | null) {
  sessionRef.current = user
    ? { user: { id: user.id, role: user.role, email: user.email, name: user.name }, expires: "2099-01-01" }
    : null;
}

function req(url: string, init?: { method?: string; body?: unknown }) {
  return new NextRequest(url, {
    method: init?.method ?? "GET",
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

const postSend = (docId: string, body: unknown) =>
  documentSendRoute.POST(req(`http://t/api/travel/documents/${docId}/send`, { method: "POST", body }), {
    params: Promise.resolve({ id: docId }),
  });

function tmpPdf(tag: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `intlock-${tag}-`));
  const file = path.join(dir, "doc.pdf");
  writeFileSync(file, "%PDF-1.4 intlock");
  return file;
}

function mkDoc(versionId: string, kind: string, key: string, file: string) {
  return prisma.quoteDocument.create({
    data: {
      versionId,
      snapshotHash: "0".repeat(64),
      kind,
      templateVersion: "1",
      filePath: file,
      sha256: "abc",
      idempotencyKey: key,
    },
  });
}

beforeAll(async () => {
  ensureSchema();
  prisma = await getPrisma();
  workflow = await import("@/lib/travel/workflow");
  fx = await seedFixtures(prisma);
  documentSendRoute = await import("@/app/api/travel/documents/[id]/send/route");
  // W3 (travel-nare): the travel account ships disabled; enable it so the
  // CLIENT regression reaches the mocked sender. Disabled-account behavior is
  // covered in tests/whatsapp/travel-send.test.ts.
  const { ensureDefaultAccounts } = await import("@/lib/whatsapp-accounts");
  await ensureDefaultAccounts();
  await prisma.whatsAppAccount.update({ where: { key: "nare" }, data: { enabled: true } });
});

beforeEach(() => {
  session(null);
  sendMock.mockClear();
});

describe("route: POST /api/travel/documents/[id]/send with an INTERNAL id", () => {
  it("is rejected for ADMIN, the request owner and the assigned validator; strangers get 404", async () => {
    const { request, version } = await workflow.createRequest(actorOf(fx.advisor), createRequestInput(fx.agency.id));
    await workflow.assignValidator(actorOf(fx.advisor), request.id, { validatorId: fx.validator.id });
    const internal = await mkDoc(version.id, "INTERNAL", "intlock-route-internal", tmpPdf("route"));

    for (const who of [fx.admin, fx.advisor, fx.validator]) {
      session(who);
      const res = await postSend(internal.id, { userIds: [fx.plainUser.id] });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("INTERNAL documents cannot be sent via WhatsApp");
    }
    expect(sendMock).not.toHaveBeenCalled();

    // No disclosure: an unrelated travel user cannot learn the doc exists.
    const stranger = await prisma.user.create({
      data: { email: "intlock-stranger@test.io", name: "Stranger", password: "x", role: "ADVISOR" },
    });
    session(stranger);
    expect((await postSend(internal.id, { userIds: [fx.plainUser.id] })).status).toBe(404);
  });
});

describe("sendQuoteDocument(): the refusal holds for every caller", () => {
  it("an INTERNAL id with both userIds and groupJids fails per target and never touches WhatsApp", async () => {
    const { version } = await workflow.createRequest(actorOf(fx.advisor), createRequestInput(fx.agency.id));
    const internal = await mkDoc(version.id, "INTERNAL", "intlock-direct-internal", tmpPdf("direct"));
    const recipient = await prisma.user.create({
      data: { email: "intlock-recip@test.io", name: "Recip", password: "x", role: "USER", phone: "37400000097" },
    });

    const results = await sendQuoteDocument(
      internal.id,
      { userIds: [recipient.id, fx.admin.id], groupJids: ["120363000000000000@g.us"] },
      fx.admin.id,
    );
    expect(results).toHaveLength(3);
    expect(results.every((r) => !r.ok)).toBe(true);
    expect(results.every((r) => r.error === "INTERNAL documents cannot be sent via WhatsApp")).toBe(true);
    expect(sendMock).not.toHaveBeenCalled();

    // The refusal is audited without QUOTE_DOCUMENT_SENT success semantics.
    const refusedAudit = await prisma.log.findFirst({
      where: { action: "QUOTE_DOCUMENT_SEND_REFUSED", details: { contains: internal.id } },
    });
    expect(refusedAudit).toBeTruthy();
    const sentAudit = await prisma.log.findFirst({
      where: { action: "QUOTE_DOCUMENT_SENT", details: { contains: "INTERNAL" } },
    });
    expect(sentAudit).toBeNull();
  });

  it("regression: a CLIENT document still sends for an authorized actor", async () => {
    const { version } = await workflow.createRequest(actorOf(fx.advisor), createRequestInput(fx.agency.id));
    const client = await mkDoc(version.id, "CLIENT", "intlock-direct-client", tmpPdf("client"));

    session(fx.advisor); // request owner with the default travel.client_docs.send grant
    const res = await postSend(client.id, { userIds: [fx.validator.id], groupJids: ["120363111111111111@g.us"] });
    expect(res.status).toBe(200);
    const { results } = await res.json();
    expect(results).toHaveLength(2);
    expect(results.every((r: any) => r.ok)).toBe(true);
    expect(sendMock).toHaveBeenCalledTimes(2);
  });
});
