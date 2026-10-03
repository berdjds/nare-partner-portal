/**
 * Notification outbox tests: dedup on reprocessing, missing-destination
 * skipping, failure + retry, and overdue-validation sweeps.
 * All senders are mocked — nothing leaves the process.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { ensureSchema, getPrisma } from "../travel-db/helpers";
import { actorOf, createRequestInput, saveContent, scenarioContent, seedFixtures, type Fixtures } from "./fixtures";

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
let sendEmail: ReturnType<typeof vi.fn>;
let sendWhatsAppMessage: ReturnType<typeof vi.fn>;
let fx: Fixtures;

beforeAll(async () => {
  ensureSchema();
  prisma = await getPrisma();
  workflow = await import("@/lib/travel/workflow");
  notifications = await import("@/lib/travel/notifications");
  sendEmail = (await import("@/lib/email")).sendEmail as any;
  sendWhatsAppMessage = (await import("@/lib/whatsapp")).sendWhatsAppMessage as any;
  fx = await seedFixtures(prisma);
  // W3 (travel-nare): the travel account ships disabled; enable it so queued
  // WHATSAPP deliveries reach the mocked sender. Disabled-account behavior is
  // covered in tests/whatsapp/travel-send.test.ts.
  const { ensureDefaultAccounts } = await import("@/lib/whatsapp-accounts");
  await ensureDefaultAccounts();
  await prisma.whatsAppAccount.update({ where: { key: "nare" }, data: { enabled: true } });
});

/** Submits a fresh request and returns its SUBMITTED deliveries. */
async function submitFresh(validatorId: string) {
  const { request, version } = await workflow.createRequest(actorOf(fx.advisor), createRequestInput(fx.agency.id));
  await saveContent(prisma, actorOf(fx.advisor), request.id, version.id, scenarioContent(fx.hotel.id, fx.hotel.name));
  await workflow.assignValidator(actorOf(fx.advisor), request.id, { validatorId });
  await workflow.submit(actorOf(fx.advisor), request.id);
  const event = await prisma.workflowEvent.findFirst({
    where: { requestId: request.id, type: "SUBMITTED" },
    include: { deliveries: true },
  });
  return { request, version, deliveries: event!.deliveries };
}

describe("processNotificationQueue", () => {
  it("sends queued deliveries once — reprocessing never resends SENT rows", async () => {
    await submitFresh(fx.validator.id);
    sendEmail.mockClear();
    sendWhatsAppMessage.mockClear();

    const first = await notifications.processNotificationQueue({ limit: 100 });
    expect(first.failed).toBe(0);
    expect(first.sent).toBeGreaterThan(0);
    const emailCalls = sendEmail.mock.calls.length;
    const waCalls = sendWhatsAppMessage.mock.calls.length;
    expect(emailCalls).toBeGreaterThan(0);
    expect(waCalls).toBeGreaterThan(0);

    const second = await notifications.processNotificationQueue({ limit: 100 });
    expect(second.processed).toBe(0);
    expect(sendEmail.mock.calls.length).toBe(emailCalls);
    expect(sendWhatsAppMessage.mock.calls.length).toBe(waCalls);

    const sent = await prisma.notificationDelivery.findMany({ where: { status: "SENT" } });
    expect(sent.every((d) => d.providerId && d.sentAt)).toBe(true);
  });

  it("skips WHATSAPP without destination while EMAIL still sends", async () => {
    // validator2 has no phone — its WHATSAPP row is flagged at queue time.
    const { deliveries } = await submitFresh(fx.validator2.id);
    const waSkipped = deliveries.filter(
      (d) => d.recipientId === fx.validator2.id && d.channel === "WHATSAPP",
    );
    expect(waSkipped).toHaveLength(1);
    expect(waSkipped[0].status).toBe("SKIPPED_NO_DESTINATION");

    await notifications.processNotificationQueue({ limit: 100 });
    const email = await prisma.notificationDelivery.findFirst({
      where: { recipientId: fx.validator2.id, channel: "EMAIL" },
      orderBy: { createdAt: "desc" },
    });
    expect(email?.status).toBe("SENT");
  });

  it("marks a throwing WhatsApp sender FAILED and retry succeeds", async () => {
    const { deliveries } = await submitFresh(fx.validator.id);
    const waDelivery = deliveries.find((d) => d.channel === "WHATSAPP" && d.status === "QUEUED")!;

    sendWhatsAppMessage.mockRejectedValueOnce(new Error("WhatsApp client not ready"));
    await notifications.processNotificationQueue({ limit: 100 });

    let row = await prisma.notificationDelivery.findUnique({ where: { id: waDelivery.id } });
    expect(row?.status).toBe("FAILED");
    expect(row?.lastError).toContain("not ready");
    expect(row?.attempts).toBe(1);

    // Requeue (what POST /api/travel/notifications/retry does) and reprocess.
    await prisma.notificationDelivery.update({
      where: { id: waDelivery.id },
      data: { status: "QUEUED", lastError: null },
    });
    await notifications.processNotificationQueue({ limit: 100 });
    row = await prisma.notificationDelivery.findUnique({ where: { id: waDelivery.id } });
    expect(row?.status).toBe("SENT");
    expect(row?.providerId).toBe("wa-test");
  });

  it("two concurrent sweeps claim atomically — every row is sent exactly once", async () => {
    await submitFresh(fx.validator.id);
    sendEmail.mockClear();
    sendWhatsAppMessage.mockClear();
    // Slow senders so both sweeps overlap mid-send: without the atomic
    // QUEUED→SENDING claim, both would send the same row.
    sendEmail.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return { providerId: "smtp-slow" };
    });
    sendWhatsAppMessage.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return { id: { _serialized: "wa-slow" } };
    });

    const queuedBefore = await prisma.notificationDelivery.count({ where: { status: "QUEUED" } });
    expect(queuedBefore).toBeGreaterThan(0);

    const [a, b] = await Promise.all([
      notifications.processNotificationQueue({ limit: 100 }),
      notifications.processNotificationQueue({ limit: 100 }),
    ]);
    expect(a.sent + b.sent).toBe(queuedBefore);
    // Every QUEUED row was sent by exactly one sweep — no double sends.
    expect(sendEmail.mock.calls.length + sendWhatsAppMessage.mock.calls.length).toBe(queuedBefore);
    expect(await prisma.notificationDelivery.count({ where: { status: "QUEUED" } })).toBe(0);
    expect(await prisma.notificationDelivery.count({ where: { status: "SENDING" } })).toBe(0);

    sendEmail.mockImplementation(async () => ({ providerId: "smtp-test" }));
    sendWhatsAppMessage.mockImplementation(async () => ({ id: { _serialized: "wa-test" } }));
  });

  it("FAILED rows back off per attempt and stale SENDING rows are reclaimed", async () => {
    const { deliveries } = await submitFresh(fx.validator.id);
    const wa = deliveries.find((d) => d.channel === "WHATSAPP" && d.status === "QUEUED")!;

    sendWhatsAppMessage.mockRejectedValueOnce(new Error("boom"));
    await notifications.processNotificationQueue({ limit: 100 });
    let row = await prisma.notificationDelivery.findUnique({ where: { id: wa.id } });
    expect(row?.status).toBe("FAILED");
    expect(row?.attempts).toBe(1);

    // Backoff: attempt 1 → not eligible again until 60s after the failure.
    sendWhatsAppMessage.mockClear();
    const skipped = await notifications.processNotificationQueue({ limit: 100 });
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    row = await prisma.notificationDelivery.findUnique({ where: { id: wa.id } });
    expect(row?.status).toBe("FAILED");

    // Once the backoff window has passed, the row is retried and succeeds.
    await prisma.notificationDelivery.update({
      where: { id: wa.id },
      data: { updatedAt: new Date(Date.now() - 61_000) },
    });
    await notifications.processNotificationQueue({ limit: 100 });
    row = await prisma.notificationDelivery.findUnique({ where: { id: wa.id } });
    expect(row?.status).toBe("SENT");

    // Crash recovery: a row stuck in SENDING for >10 min is reclaimed.
    const { deliveries: fresh } = await submitFresh(fx.validator.id);
    const stuck = fresh.find((d) => d.channel === "EMAIL")!;
    await prisma.notificationDelivery.update({
      where: { id: stuck.id },
      data: { status: "SENDING", updatedAt: new Date(Date.now() - 11 * 60_000) },
    });
    await notifications.processNotificationQueue({ limit: 100 });
    row = await prisma.notificationDelivery.findUnique({ where: { id: stuck.id } });
    expect(row?.status).toBe("SENT");

    // A fresh SENDING row (another worker actively sending) is NOT reclaimed.
    const { deliveries: fresh2 } = await submitFresh(fx.validator.id);
    const active = fresh2.find((d) => d.channel === "EMAIL")!;
    await prisma.notificationDelivery.update({
      where: { id: active.id },
      data: { status: "SENDING" },
    });
    sendEmail.mockClear();
    await notifications.processNotificationQueue({ limit: 100 });
    row = await prisma.notificationDelivery.findUnique({ where: { id: active.id } });
    expect(row?.status).toBe("SENDING");
    expect(sendEmail.mock.calls.some((c) => c[0]?.to === active.destination)).toBe(false);
  });
});

describe("sweepOverdueValidations", () => {
  it("reminds the current validator once per 24h and escalates after 2x reminder hours", async () => {
    const { request } = await submitFresh(fx.validator.id);

    const dueAt = new Date(Date.now() - 3 * 3_600_000); // 3h overdue
    await prisma.validationAssignment.updateMany({
      where: { requestId: request.id, active: true },
      data: { dueAt },
    });
    await prisma.travelSettings.update({
      where: { id: "default" },
      data: { overdueReminderHours: 1, escalationUserId: fx.admin.id },
    });

    const queued = await notifications.sweepOverdueValidations();
    expect(queued).toBe(1);

    const event = await prisma.workflowEvent.findFirst({
      where: { requestId: request.id, type: "VALIDATION_OVERDUE" },
      include: { deliveries: true },
    });
    expect(event).toBeTruthy();
    // 3h overdue > 2 × 1h reminder → escalation user (admin) included.
    const recipientIds = new Set(event!.deliveries.map((d) => d.recipientId));
    expect(recipientIds.has(fx.validator.id)).toBe(true);
    expect(recipientIds.has(fx.admin.id)).toBe(true);

    // Second sweep within 24h is suppressed.
    expect(await notifications.sweepOverdueValidations()).toBe(0);

    // Deciding the version suppresses future reminders automatically.
    const version = await prisma.quoteVersion.findFirst({
      where: { requestId: request.id },
      orderBy: { versionNo: "desc" },
    });
    await prisma.workflowEvent.deleteMany({ where: { requestId: request.id, type: "VALIDATION_OVERDUE" } });
    await workflow.review(actorOf(fx.validator), version!.id, {
      action: "APPROVE",
      snapshotHash: (await prisma.calculationSnapshot.findUnique({ where: { versionId: version!.id } }))!.hash,
    });
    expect(await notifications.sweepOverdueValidations()).toBe(0);
  });
});
