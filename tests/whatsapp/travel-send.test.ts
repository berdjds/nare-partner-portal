/**
 * W3 (travel-nare): every travel-module WhatsApp send must go through the
 * account named by TravelSettings.whatsappAccountKey (default 'nare') — the
 * account is recorded on each WHATSAPP NotificationDelivery at queue time
 * (accountId + dedupKey prefix), failures and retries stay on that recorded
 * account, and sendQuoteDocument fails per recipient with a coded error when
 * the account is disabled or the key names no account. Marhaba (the inbox
 * account) must never be used as a fallback.
 *
 * All senders are mocked — nothing leaves the process. Tests share the DB and
 * run in order, so any test that flips TravelSettings.whatsappAccountKey or
 * nare.enabled restores the default (key "nare", enabled) in a finally; tests
 * that leave deliveries unprocessed delete them so later queue sweeps only
 * see their own rows.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";
import { ensureSchema, getPrisma } from "../travel-db/helpers";
import {
  actorOf,
  createRequestInput,
  saveContent,
  scenarioContent,
  seedFixtures,
  TEST_DOCS_DIR,
  type Fixtures,
} from "../workflow/fixtures";

const { sessionRef } = vi.hoisted(() => ({ sessionRef: { current: null as any } }));
vi.mock("next-auth/next", () => ({
  getServerSession: vi.fn(async () => sessionRef.current),
}));
vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn(async () => ({ providerId: "smtp-test" })),
}));
vi.mock("@/lib/whatsapp", () => ({
  sendWhatsAppMessage: vi.fn(async () => ({ id: { _serialized: "wa-test" } })),
}));
vi.mock("@/lib/travel/pdf/render", () => ({
  renderQuotationPdf: vi.fn(async () => Buffer.from("%PDF-1.4 fake")),
}));

let prisma: PrismaClient;
let workflow: typeof import("@/lib/travel/workflow");
let notifications: typeof import("@/lib/travel/notifications");
let settingsRoute: typeof import("@/app/api/travel/settings/route");
let sendQuoteDocument: typeof import("@/lib/travel/whatsapp-docs").sendQuoteDocument;
let sendWhatsAppMessage: ReturnType<typeof vi.fn>;
let fx: Fixtures;

function session(user: { id: string; role: string; email: string; name: string | null } | null) {
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

function tmpPdf(tag: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `travel-send-${tag}-`));
  const file = path.join(dir, "doc.pdf");
  writeFileSync(file, "%PDF-1.4 travel-send");
  return file;
}

let docSeq = 0;
function mkDoc(versionId: string, kind: string, file: string) {
  return prisma.quoteDocument.create({
    data: {
      versionId,
      snapshotHash: "0".repeat(64),
      kind,
      templateVersion: "1",
      filePath: file,
      sha256: "abc",
      idempotencyKey: `travel-send-doc-${++docSeq}`,
    },
  });
}

async function setTravelAccountKey(key: string) {
  await prisma.travelSettings.upsert({
    where: { id: "default" },
    update: { whatsappAccountKey: key },
    create: { id: "default", whatsappAccountKey: key, documentsDir: TEST_DOCS_DIR },
  });
}

async function setNareEnabled(enabled: boolean) {
  await prisma.whatsAppAccount.update({ where: { key: "nare" }, data: { enabled } });
}

/** Submits a fresh request and returns its SUBMITTED event with deliveries. */
async function submitFresh() {
  const { request, version } = await workflow.createRequest(actorOf(fx.advisor), createRequestInput(fx.agency.id));
  await saveContent(prisma, actorOf(fx.advisor), request.id, version.id, scenarioContent(fx.hotel.id, fx.hotel.name));
  await workflow.assignValidator(actorOf(fx.advisor), request.id, { validatorId: fx.validator.id });
  await workflow.submit(actorOf(fx.advisor), request.id);
  const event = await prisma.workflowEvent.findFirst({
    where: { requestId: request.id, type: "SUBMITTED" },
    include: { deliveries: true },
  });
  return { request, version, event: event!, deliveries: event!.deliveries };
}

const waCalls = () => sendWhatsAppMessage.mock.calls.map((c) => c[0] as any);

beforeAll(async () => {
  ensureSchema();
  prisma = await getPrisma();
  workflow = await import("@/lib/travel/workflow");
  notifications = await import("@/lib/travel/notifications");
  settingsRoute = await import("@/app/api/travel/settings/route");
  sendQuoteDocument = (await import("@/lib/travel/whatsapp-docs")).sendQuoteDocument;
  sendWhatsAppMessage = (await import("@/lib/whatsapp")).sendWhatsAppMessage as any;
  fx = await seedFixtures(prisma);
  // The travel account ships disabled; enable it as the suite default.
  // Disabled-account behavior is exercised per test with a finally restore.
  const { ensureDefaultAccounts } = await import("@/lib/whatsapp-accounts");
  await ensureDefaultAccounts();
  await setNareEnabled(true);
});

beforeEach(() => session(null));

describe("travel sends use the configured account (Nare)", () => {
  it("records the travel account on WHATSAPP deliveries and prefixes the dedup key", async () => {
    const { event, deliveries } = await submitFresh();
    try {
      const wa = deliveries.filter((d) => d.channel === "WHATSAPP");
      expect(wa.length).toBeGreaterThan(0);
      for (const d of wa) {
        expect(d.accountId).toBe("nare");
        expect(d.dedupKey).toMatch(/^nare:/);
        expect(d.dedupKey.endsWith(`:${d.recipientId}:WHATSAPP`)).toBe(true);
        expect(d.dedupKey).toBe(`nare:${event.id}:${d.recipientId}:WHATSAPP`);
      }
      const emails = deliveries.filter((d) => d.channel === "EMAIL");
      expect(emails.length).toBeGreaterThan(0);
      for (const d of emails) {
        expect(d.dedupKey.startsWith("nare:")).toBe(false);
        expect(d.dedupKey).toBe(`${event.id}:${d.recipientId}:EMAIL`);
      }
    } finally {
      // Leave no QUEUED rows behind: later sweeps must only see their own.
      await prisma.notificationDelivery.deleteMany({ where: { eventId: event.id } });
    }
  });

  it("follows a changed TravelSettings.whatsappAccountKey at queue time", async () => {
    let eventId: string | null = null;
    try {
      await setTravelAccountKey("marhaba");
      const { event, deliveries } = await submitFresh();
      eventId = event.id;
      const wa = deliveries.filter((d) => d.channel === "WHATSAPP");
      expect(wa.length).toBeGreaterThan(0);
      for (const d of wa) {
        expect(d.accountId).toBe("marhaba");
        expect(d.dedupKey).toMatch(/^marhaba:/);
      }
    } finally {
      await setTravelAccountKey("nare");
      if (eventId) await prisma.notificationDelivery.deleteMany({ where: { eventId } });
    }
  });

  it("sends every queued WHATSAPP delivery through Nare and never Marhaba", async () => {
    const { event } = await submitFresh();
    await setNareEnabled(true);
    sendWhatsAppMessage.mockClear();

    await notifications.processNotificationQueue({ limit: 100 });
    const calls = waCalls();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((a) => a.accountKey === "nare")).toBe(true);
    expect(calls.some((a) => a.accountKey === "marhaba")).toBe(false);

    const waRows = await prisma.notificationDelivery.findMany({
      where: { eventId: event.id, channel: "WHATSAPP" },
    });
    expect(waRows.length).toBeGreaterThan(0);
    expect(waRows.every((d) => d.status === "SENT" && d.accountId === "nare")).toBe(true);

    // SENT rows are never retried: a second sweep sends nothing more.
    await notifications.processNotificationQueue({ limit: 100 });
    expect(sendWhatsAppMessage.mock.calls.length).toBe(calls.length);
  });
});

describe("failure and retry stay on the travel account", () => {
  it("a not-ready Nare fails the delivery with the account named and retries on Nare, never Marhaba", async () => {
    const { event, deliveries } = await submitFresh();
    const waRows = deliveries.filter((d) => d.channel === "WHATSAPP" && d.status === "QUEUED");
    expect(waRows.length).toBeGreaterThan(0);

    sendWhatsAppMessage.mockClear();
    sendWhatsAppMessage.mockRejectedValue(
      new Error(
        'WhatsApp account "nare" is not ready (state: disconnected). ' +
          "Pair or reconnect it under Admin → WhatsApp accounts; the send can be retried on the same account.",
      ),
    );
    await notifications.processNotificationQueue({ limit: 100 });

    for (const d of waRows) {
      const row = await prisma.notificationDelivery.findUnique({ where: { id: d.id } });
      expect(row?.status).toBe("FAILED");
      expect(row?.lastError).toContain("nare");
      expect(row?.lastError).toContain("not ready");
    }

    // Requeue (what POST /api/travel/notifications/retry does) and reprocess
    // with a healthy sender: the retry must use the SAME recorded account.
    sendWhatsAppMessage.mockImplementation(async () => ({ id: { _serialized: "wa-test" } }));
    sendWhatsAppMessage.mockClear();
    await prisma.notificationDelivery.updateMany({
      where: { id: { in: waRows.map((d) => d.id) } },
      data: { status: "QUEUED", lastError: null },
    });
    await notifications.processNotificationQueue({ limit: 100 });

    const retried = waCalls();
    expect(retried.length).toBe(waRows.length);
    expect(retried.every((a) => a.accountKey === "nare")).toBe(true);
    expect(retried.some((a) => a.accountKey === "marhaba")).toBe(false);
    for (const d of waRows) {
      const row = await prisma.notificationDelivery.findUnique({ where: { id: d.id } });
      expect(row?.status).toBe("SENT");
      expect(row?.accountId).toBe("nare");
    }
    const eventRows = await prisma.notificationDelivery.findMany({ where: { eventId: event.id } });
    expect(eventRows.every((d) => d.status === "SENT")).toBe(true);
  });

  it("a disabled Nare fails with TRAVEL_WHATSAPP_ACCOUNT_DISABLED and sendWhatsAppMessage is never called", async () => {
    await setNareEnabled(false);
    let eventId: string | null = null;
    try {
      const { event } = await submitFresh();
      eventId = event.id;
      sendWhatsAppMessage.mockClear();

      await notifications.processNotificationQueue({ limit: 100 });

      const waRows = await prisma.notificationDelivery.findMany({
        where: { eventId: event.id, channel: "WHATSAPP" },
      });
      expect(waRows.length).toBeGreaterThan(0);
      for (const d of waRows) {
        expect(d.status).toBe("FAILED");
        expect(d.lastError).toContain("TRAVEL_WHATSAPP_ACCOUNT_DISABLED");
        expect(d.lastError).toContain("nare");
      }
      expect(sendWhatsAppMessage).not.toHaveBeenCalled();

      const emailRows = await prisma.notificationDelivery.findMany({
        where: { eventId: event.id, channel: "EMAIL" },
      });
      expect(emailRows.length).toBeGreaterThan(0);
      expect(emailRows.every((d) => d.status === "SENT")).toBe(true);
    } finally {
      await setNareEnabled(true);
      // The FAILED rows would become retryable after backoff — remove them so
      // later sweeps in this file only see their own deliveries.
      if (eventId) await prisma.notificationDelivery.deleteMany({ where: { eventId } });
    }
  });

  it("retries reuse the account recorded on the delivery, not the current setting", async () => {
    const { deliveries } = await submitFresh(); // recorded with accountId "nare"
    expect(deliveries.filter((d) => d.channel === "WHATSAPP").every((d) => d.accountId === "nare")).toBe(true);
    try {
      await setTravelAccountKey("marhaba");
      sendWhatsAppMessage.mockClear();

      await notifications.processNotificationQueue({ limit: 100 });

      const calls = waCalls();
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((a) => a.accountKey === "nare")).toBe(true);
      expect(calls.some((a) => a.accountKey === "marhaba")).toBe(false);
    } finally {
      await setTravelAccountKey("nare");
    }
  });
});

describe("sendQuoteDocument account gating", () => {
  it("sends CLIENT documents through the travel account", async () => {
    const { version } = await workflow.createRequest(actorOf(fx.advisor), createRequestInput(fx.agency.id));
    const doc = await mkDoc(version.id, "CLIENT", tmpPdf("client"));
    await setNareEnabled(true);
    sendWhatsAppMessage.mockClear();

    // fx.validator has a phone on file (fixtures), so the send is attempted.
    const results = await sendQuoteDocument(doc.id, { userIds: [fx.validator.id] }, fx.admin.id);
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    const arg = waCalls()[0];
    expect(arg.accountKey).toBe("nare");
    expect(arg.type).toBe("document");
    expect(arg.mediaMimeType).toBe("application/pdf");
  });

  it("fails every recipient with a coded error naming the account when Nare is disabled", async () => {
    const { version } = await workflow.createRequest(actorOf(fx.advisor), createRequestInput(fx.agency.id));
    const doc = await mkDoc(version.id, "CLIENT", tmpPdf("disabled"));
    await setNareEnabled(false);
    try {
      sendWhatsAppMessage.mockClear();
      const results = await sendQuoteDocument(doc.id, { userIds: [fx.validator.id] }, fx.admin.id);
      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(r.ok).toBe(false);
        expect(r.error ?? "").toContain("TRAVEL_WHATSAPP_ACCOUNT_DISABLED");
        expect(r.error ?? "").toContain("nare");
      }
      expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    } finally {
      await setNareEnabled(true);
    }
  });

  it("fails with TRAVEL_WHATSAPP_ACCOUNT_NOT_CONFIGURED when the setting names an unknown account", async () => {
    const { version } = await workflow.createRequest(actorOf(fx.advisor), createRequestInput(fx.agency.id));
    const doc = await mkDoc(version.id, "CLIENT", tmpPdf("unconfigured"));
    try {
      await setTravelAccountKey("nonexistent");
      sendWhatsAppMessage.mockClear();
      const results = await sendQuoteDocument(doc.id, { userIds: [fx.validator.id] }, fx.admin.id);
      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(r.ok).toBe(false);
        expect(r.error ?? "").toContain("TRAVEL_WHATSAPP_ACCOUNT_NOT_CONFIGURED");
        expect(r.error ?? "").toContain("nonexistent");
      }
      expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    } finally {
      await setTravelAccountKey("nare");
    }
  });
});

describe("PUT /api/travel/settings whatsappAccountKey", () => {
  it("ADMIN can update whatsappAccountKey to an existing account; unknown keys are rejected; non-admin is forbidden", async () => {
    session(fx.admin);
    try {
      const ok = await settingsRoute.PUT(
        req("http://t/api/travel/settings", { method: "PUT", body: { whatsappAccountKey: "marhaba" } }),
      );
      expect(ok.status).toBe(200);
      expect((await ok.json()).whatsappAccountKey).toBe("marhaba");
      expect(
        (await prisma.travelSettings.findUnique({ where: { id: "default" } }))?.whatsappAccountKey,
      ).toBe("marhaba");

      const bad = await settingsRoute.PUT(
        req("http://t/api/travel/settings", { method: "PUT", body: { whatsappAccountKey: "ghost" } }),
      );
      expect(bad.status).toBe(400);
      expect((await bad.json()).error).toBe("unknown WhatsApp account key: ghost");
      // The rejected update must not have touched the stored key.
      expect(
        (await prisma.travelSettings.findUnique({ where: { id: "default" } }))?.whatsappAccountKey,
      ).toBe("marhaba");
    } finally {
      session(fx.admin);
      const restore = await settingsRoute.PUT(
        req("http://t/api/travel/settings", { method: "PUT", body: { whatsappAccountKey: "nare" } }),
      );
      expect(restore.status).toBe(200);
    }

    session(fx.advisor);
    const forbidden = await settingsRoute.PUT(
      req("http://t/api/travel/settings", { method: "PUT", body: { whatsappAccountKey: "marhaba" } }),
    );
    expect(forbidden.status).toBe(403);
    expect(
      (await prisma.travelSettings.findUnique({ where: { id: "default" } }))?.whatsappAccountKey,
    ).toBe("nare");
  });

  it("GET exposes whatsappAccountKey", async () => {
    session(fx.admin);
    const res = await settingsRoute.GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    const db = await prisma.travelSettings.findUnique({ where: { id: "default" } });
    expect(typeof body.settings.whatsappAccountKey).toBe("string");
    expect(body.settings.whatsappAccountKey).toBe(db?.whatsappAccountKey);
  });
});
