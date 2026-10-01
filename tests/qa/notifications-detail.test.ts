/**
 * QA: workflow notification matrix (item 20).
 *
 * Every workflow event type is walked end-to-end; for each one we assert the
 * expected recipient×channel deliveries and that the body carries the package
 * code, version label, event and required action. Also covered:
 * - reassignment notifies old validator + new validator + owner;
 * - a failing channel keeps workflow state intact and never duplicates an
 *   issuance;
 * - stale reminders are suppressed once a version is decided.
 *
 * All senders are mocked — nothing leaves the process.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { ensureSchema, getPrisma } from "../travel-db/helpers";
import { actorOf, createRequestInput, saveContent, scenarioContent, seedFixtures, type Fixtures } from "../workflow/fixtures";

vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ providerId: "smtp-test" })) }));
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

async function eventDeliveries(requestId: string, type: string) {
  const event = await prisma.workflowEvent.findFirst({
    where: { requestId, type },
    include: { deliveries: true },
    orderBy: { createdAt: "desc" },
  });
  return event;
}

function expectDeliveryMatrix(event: any, recipientIds: string[], code: string, versionLabel: string) {
  expect(event).toBeTruthy();
  expect(event.deliveries).toHaveLength(recipientIds.length * 2);
  for (const rid of recipientIds) {
    for (const channel of ["EMAIL", "WHATSAPP"]) {
      const d = event.deliveries.find((x: any) => x.recipientId === rid && x.channel === channel);
      expect(d, `${channel} delivery for ${rid}`).toBeTruthy();
      expect(d.body).toContain(code);
      expect(d.body).toContain(versionLabel);
      expect(d.body).toContain(`[${event.type}]`);
      expect(d.body).toContain("Link:");
      // Operational only: no commercial data leaks into notifications.
      expect(d.body).not.toMatch(/cost|margin|profit|sell/i);
    }
  }
}

describe("per-event recipient × channel matrix", () => {
  it("SUBMITTED → RESUBMITTED → CHANGES_REQUESTED → APPROVED → ISSUED → OUTCOME_RECORDED", async () => {
    const { request, version } = await workflow.createRequest(actorOf(fx.advisor), createRequestInput(fx.agency.id));
    await saveContent(prisma, actorOf(fx.advisor), request.id, version.id, scenarioContent(fx.hotel.id, fx.hotel.name));
    await workflow.assignValidator(actorOf(fx.advisor), request.id, { validatorId: fx.validator.id });
    const code = request.packageCode;

    // SUBMITTED: validator gets the action, advisor the confirmation.
    const sub = await workflow.submit(actorOf(fx.advisor), request.id);
    const subEvent = (await eventDeliveries(request.id, "SUBMITTED"))!;
    expectDeliveryMatrix(subEvent, [fx.advisor.id, fx.validator.id], code, "v01");
    const validatorMail = subEvent.deliveries.find((d: any) => d.recipientId === fx.validator.id && d.channel === "EMAIL")!;
    expect(validatorMail.body).toContain("Action needed: Validate this quotation");
    expect(validatorMail.destination).toBe(fx.validator.email);
    const advisorWa = subEvent.deliveries.find((d: any) => d.recipientId === fx.advisor.id && d.channel === "WHATSAPP")!;
    expect(advisorWa.destination).toBe(fx.advisor.phone);

    // CHANGES_REQUESTED: advisor decision+reason+action, validator confirmation.
    await workflow.review(actorOf(fx.validator), version.id, {
      action: "REQUEST_CHANGES",
      reason: "Board basis wrong",
      snapshotHash: sub.hash,
    });
    const crEvent = (await eventDeliveries(request.id, "CHANGES_REQUESTED"))!;
    expectDeliveryMatrix(crEvent, [fx.advisor.id, fx.validator.id], code, "v01");
    const advisorMail = crEvent.deliveries.find((d: any) => d.recipientId === fx.advisor.id && d.channel === "EMAIL")!;
    expect(advisorMail.body).toContain("Reason: Board basis wrong");
    expect(advisorMail.body).toContain("Action needed: Revise and resubmit");

    // RESUBMITTED after revision.
    await saveContent(prisma, actorOf(fx.advisor), request.id, version.id, scenarioContent(fx.hotel.id, fx.hotel.name));
    const sub2 = await workflow.submit(actorOf(fx.advisor), request.id);
    expectDeliveryMatrix((await eventDeliveries(request.id, "RESUBMITTED"))!, [fx.advisor.id, fx.validator.id], code, "v01");

    // APPROVED: advisor ready-to-issue + validator confirmation.
    await workflow.review(actorOf(fx.validator), version.id, { action: "APPROVE", snapshotHash: sub2.hash });
    expectDeliveryMatrix((await eventDeliveries(request.id, "APPROVED"))!, [fx.advisor.id, fx.validator.id], code, "v01");

    // ISSUED: confirmation to both.
    await workflow.issue(actorOf(fx.advisor), version.id, {});
    expectDeliveryMatrix((await eventDeliveries(request.id, "ISSUED"))!, [fx.advisor.id, fx.validator.id], code, "v01");

    // OUTCOME_RECORDED: both, with the outcome in the reason line.
    const scenario = await prisma.scenario.findFirst({ where: { versionId: version.id } });
    await workflow.recordOutcome(actorOf(fx.advisor), version.id, { outcome: "ACCEPTED", scenarioId: scenario!.id });
    const outEvent = (await eventDeliveries(request.id, "OUTCOME_RECORDED"))!;
    expectDeliveryMatrix(outEvent, [fx.advisor.id, fx.validator.id], code, "v01");
    expect(outEvent.deliveries[0].body).toContain("outcome: ACCEPTED");
  });

  it("REASSIGNED notifies old validator + new validator + owner", async () => {
    const { request, version } = await workflow.createRequest(actorOf(fx.advisor), createRequestInput(fx.agency.id));
    await saveContent(prisma, actorOf(fx.advisor), request.id, version.id, scenarioContent(fx.hotel.id, fx.hotel.name));
    await workflow.assignValidator(actorOf(fx.advisor), request.id, { validatorId: fx.validator.id });
    await workflow.reassign(actorOf(fx.admin), request.id, { validatorId: fx.validator2.id });

    // validator2 has no phone → its WHATSAPP row is SKIPPED_NO_DESTINATION.
    const event = (await eventDeliveries(request.id, "REASSIGNED"))!;
    expect(event.deliveries).toHaveLength(6);
    for (const rid of [fx.validator.id, fx.validator2.id, fx.advisor.id]) {
      expect(event.deliveries.filter((d: any) => d.recipientId === rid)).toHaveLength(2);
    }
    const skipped = event.deliveries.find((d: any) => d.recipientId === fx.validator2.id && d.channel === "WHATSAPP");
    expect(skipped!.status).toBe("SKIPPED_NO_DESTINATION");
    const newValidatorMail = event.deliveries.find((d: any) => d.recipientId === fx.validator2.id && d.channel === "EMAIL");
    expect(newValidatorMail!.body).toContain("Action needed: Validate this quotation");
    expect(newValidatorMail!.body).toContain(request.packageCode);
  });
});

describe("failure isolation (item 20)", () => {
  it("a failing WhatsApp sender keeps ISSUED state intact and never duplicates issuance", async () => {
    const { request, version } = await workflow.createRequest(actorOf(fx.advisor), createRequestInput(fx.agency.id));
    await saveContent(prisma, actorOf(fx.advisor), request.id, version.id, scenarioContent(fx.hotel.id, fx.hotel.name));
    await workflow.assignValidator(actorOf(fx.advisor), request.id, { validatorId: fx.validator.id });
    const { hash } = await workflow.submit(actorOf(fx.advisor), request.id);
    await workflow.review(actorOf(fx.validator), version.id, { action: "APPROVE", snapshotHash: hash });
    const issued = await workflow.issue(actorOf(fx.advisor), version.id, {});

    sendWhatsAppMessage.mockRejectedValue(new Error("WhatsApp client not ready"));
    await notifications.processNotificationQueue({ limit: 200 });

    const failed = await prisma.notificationDelivery.findMany({ where: { status: "FAILED" } });
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.every((d) => d.channel === "WHATSAPP")).toBe(true);
    expect(failed[0].lastError).toContain("not ready");

    // Workflow state is untouched by the delivery failure.
    const v = await prisma.quoteVersion.findUnique({ where: { id: version.id } });
    expect(v?.status).toBe("ISSUED");
    expect(await prisma.quoteDocument.count({ where: { versionId: version.id, kind: "CLIENT" } })).toBe(1);

    // Re-issuing after the failure is idempotent — no duplicate document/event.
    const again = await workflow.issue(actorOf(fx.advisor), version.id, {});
    expect(again.idempotent).toBe(true);
    expect(again.document.id).toBe(issued.document.id);
    expect(await prisma.workflowEvent.count({ where: { requestId: request.id, type: "ISSUED" } })).toBe(1);

    // Retry of FAILED rows works once the sender recovers.
    sendWhatsAppMessage.mockReset();
    sendWhatsAppMessage.mockImplementation(async () => ({ id: { _serialized: "wa-ok" } }));
    await prisma.notificationDelivery.updateMany({ where: { status: "FAILED" }, data: { status: "QUEUED", lastError: null } });
    await notifications.processNotificationQueue({ limit: 200 });
    expect(await prisma.notificationDelivery.count({ where: { status: "FAILED" } })).toBe(0);
    const calls = sendWhatsAppMessage.mock.calls.length;
    await notifications.processNotificationQueue({ limit: 200 });
    expect(sendWhatsAppMessage.mock.calls.length).toBe(calls); // SENT rows never resent
  });

  it("EMAIL failure does not undo an approval", async () => {
    const { request, version } = await workflow.createRequest(actorOf(fx.advisor), createRequestInput(fx.agency.id));
    await saveContent(prisma, actorOf(fx.advisor), request.id, version.id, scenarioContent(fx.hotel.id, fx.hotel.name));
    await workflow.assignValidator(actorOf(fx.advisor), request.id, { validatorId: fx.validator.id });
    const { hash } = await workflow.submit(actorOf(fx.advisor), request.id);

    sendEmail.mockRejectedValueOnce(new Error("smtp down"));
    // The decision commits regardless of later delivery outcomes.
    await workflow.review(actorOf(fx.validator), version.id, { action: "APPROVE", snapshotHash: hash });
    await notifications.processNotificationQueue({ limit: 200 });
    const v = await prisma.quoteVersion.findUnique({ where: { id: version.id } });
    expect(v?.status).toBe("APPROVED");
  });
});

describe("stale reminder suppression (item 20)", () => {
  it("sweepOverdueValidations emits nothing for decided versions", async () => {
    const { request, version } = await workflow.createRequest(actorOf(fx.advisor), createRequestInput(fx.agency.id));
    await saveContent(prisma, actorOf(fx.advisor), request.id, version.id, scenarioContent(fx.hotel.id, fx.hotel.name));
    await workflow.assignValidator(actorOf(fx.advisor), request.id, {
      validatorId: fx.validator.id,
      dueAt: new Date(Date.now() - 60_000).toISOString(), // already overdue
    });
    const { hash } = await workflow.submit(actorOf(fx.advisor), request.id);

    // Overdue and pending: the sweep emits exactly one reminder for the validator.
    const queued = await notifications.sweepOverdueValidations();
    expect(queued).toBe(1);
    const reminder = await prisma.workflowEvent.findFirst({
      where: { requestId: request.id, type: "VALIDATION_OVERDUE" },
      include: { deliveries: true },
    });
    expect(reminder!.deliveries.every((d: any) => d.recipientId === fx.validator.id)).toBe(true);
    expect(reminder!.deliveries[0].body).toContain(request.packageCode);
    expect(reminder!.deliveries[0].body).toContain("VALIDATION_OVERDUE");

    // Once decided, the stale reminder is suppressed even though the
    // assignment is still past due.
    await workflow.review(actorOf(fx.validator), version.id, { action: "APPROVE", snapshotHash: hash });
    await prisma.workflowEvent.deleteMany({ where: { requestId: request.id, type: "VALIDATION_OVERDUE" } });
    expect(await notifications.sweepOverdueValidations()).toBe(0);
  });
});
