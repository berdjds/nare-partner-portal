/**
 * Travel workflow notifications: transactional outbox + background sender.
 *
 * queueWorkflowEvent() is called INSIDE the workflow transaction: the
 * WorkflowEvent row and one NotificationDelivery row per recipient+channel
 * commit or roll back together with the state change, so a notification can
 * never be lost after a committed transition nor sent for a rolled-back one.
 *
 * processNotificationQueue() is the sweeper: it sends QUEUED rows (and FAILED
 * rows under the retry cap) via email / WhatsApp and records the outcome.
 * Delivery rows carry a snapshot of the destination and rendered body so the
 * outbox stays accurate even if the user record changes later.
 *
 * Bodies are operational (package code, event, actor, link) and deliberately
 * carry NO costs, margins or traveler details — WhatsApp is not a confidential
 * channel. TEMPLATE_VERSION identifies the wording; bump it when it changes.
 */

import { prisma } from "@/lib/prisma";
import {
  NOTIFICATION_CHANNELS,
  type NotificationChannel,
  type NotificationPayload,
  type WorkflowEventType,
} from "@/lib/travel/contracts";
import { sendEmail } from "@/lib/email";
import { sendWhatsAppMessage } from "@/lib/whatsapp";
import { DEFAULT_TRAVEL_ACCOUNT_KEY, ensureDefaultAccounts, getAccount } from "@/lib/whatsapp-accounts";
import { INBOX_ROOM } from "@/lib/socket-auth";
import type { Prisma, User, WhatsAppAccount } from "@prisma/client";

export const TEMPLATE_VERSION = "1";

const MAX_ATTEMPTS = 3;

/** Prisma interactive-transaction client (what $transaction hands back). */
type Tx = Prisma.TransactionClient;

export interface QueueWorkflowEventInput {
  requestId: string;
  versionId?: string | null;
  type: WorkflowEventType;
  actorId?: string | null;
  payload: NotificationPayload;
  recipients: User[];
}

/**
 * Creates the WorkflowEvent and its NotificationDelivery rows inside `tx`.
 * Recipients are deduplicated by id; a missing destination yields a delivery
 * in SKIPPED_NO_DESTINATION immediately (flagged, never retried).
 */
export async function queueWorkflowEvent(
  tx: Tx,
  { requestId, versionId, type, actorId, payload, recipients }: QueueWorkflowEventInput,
) {
  const event = await tx.workflowEvent.create({
    data: {
      requestId,
      versionId: versionId ?? null,
      type,
      actorId: actorId ?? null,
      payloadJson: JSON.stringify(payload),
    },
  });

  const uniqueRecipients = new Map<string, User>();
  for (const r of recipients) {
    if (r && !uniqueRecipients.has(r.id)) uniqueRecipients.set(r.id, r);
  }

  // W3 (wa-multi): every WHATSAPP delivery of this event sends through the
  // account named by TravelSettings.whatsappAccountKey (default 'nare'). The
  // account is recorded on the delivery row at queue time and is part of the
  // dedup key, so retries always reuse the SAME account and never fall back
  // to Marhaba. Read through tx so the value commits with the event.
  let whatsappAccountId = DEFAULT_TRAVEL_ACCOUNT_KEY;
  const settings = await tx.travelSettings.findUnique({ where: { id: "default" } });
  if (settings?.whatsappAccountKey) whatsappAccountId = settings.whatsappAccountKey;

  for (const recipient of Array.from(uniqueRecipients.values())) {
    for (const channel of NOTIFICATION_CHANNELS) {
      const destination = channel === "EMAIL" ? recipient.email : recipient.phone;
      const body = renderNotificationBody(payload, channel);
      const isWhatsApp = channel === "WHATSAPP";
      await tx.notificationDelivery.create({
        data: {
          eventId: event.id,
          recipientId: recipient.id,
          channel,
          destination: destination ?? null,
          dedupKey: isWhatsApp
            ? `${whatsappAccountId}:${event.id}:${recipient.id}:${channel}`
            : `${event.id}:${recipient.id}:${channel}`,
          status: destination ? "QUEUED" : "SKIPPED_NO_DESTINATION",
          lastError: destination ? null : `user has no ${channel === "EMAIL" ? "email" : "phone"}`,
          body,
          ...(isWhatsApp ? { accountId: whatsappAccountId } : {}),
        },
      });
    }
  }

  return event;
}

/**
 * Renders the operational notification body for one channel. Keep it free of
 * commercial data (costs/margins) and traveler details — see module docstring.
 */
export function renderNotificationBody(
  payload: NotificationPayload,
  channel: NotificationChannel,
): string {
  const lines = [
    `[${payload.event}] ${payload.packageCode} (${payload.clientShort}) ${payload.versionLabel}`,
    `By: ${payload.actorName}`,
  ];
  if (payload.action) lines.push(`Action needed: ${payload.action}`);
  if (payload.reason) lines.push(`Reason: ${payload.reason}`);
  if (payload.dueAt) lines.push(`Due: ${payload.dueAt}`);
  lines.push(`Link: ${payload.link}`);
  lines.push(`At: ${payload.timestamp}`);
  if (channel === "EMAIL") {
    lines.unshift(`WAControl travel workflow notification (template ${TEMPLATE_VERSION})`);
  }
  return lines.join("\n");
}

function emitDeliveryStatus(deliveryId: string, status: string) {
  // Socket.io lives on the WhatsApp singleton (dual module instances, see
  // AGENTS.md pitfall #1); optional-chained so tests and CLI runs are a no-op.
  // Room-scoped like every other emit: under the W1 interim policy every
  // connectable socket (active ADMIN/USER) sits in the inbox room, so this
  // reaches the same set a broadcast would without broadcasting to all.
  try {
    (globalThis as any)
      .__waControlState?.io?.to(INBOX_ROOM)
      .emit("travel_notification", { deliveryId, status });
  } catch {
    // never let a socket hiccup affect delivery state
  }
}

export interface ProcessQueueResult {
  processed: number;
  sent: number;
  failed: number;
}

/**
 * Sends pending deliveries. QUEUED rows plus FAILED rows below the retry cap
 * are attempted; SENT rows are never touched again (idempotent re-runs).
 *
 * Claiming is atomic: each candidate is flipped QUEUED/FAILED → SENDING with
 * updateMany on the current status, and only the worker whose update matched
 * sends it — two concurrent sweeps can never double-send one row. A row stuck
 * in SENDING for >10 min (crashed worker) is reclaimed as QUEUED. FAILED rows
 * back off linearly: after n attempts a row waits n minutes (from updatedAt)
 * before it is eligible again.
 */
const STALE_SENDING_MS = 10 * 60 * 1000;
const RETRY_BACKOFF_MS = 60 * 1000;

export async function processNotificationQueue({ limit = 50 }: { limit?: number } = {}): Promise<ProcessQueueResult> {
  const now = new Date();

  await prisma.notificationDelivery.updateMany({
    where: { status: "SENDING", updatedAt: { lt: new Date(now.getTime() - STALE_SENDING_MS) } },
    data: { status: "QUEUED" },
  });

  const candidates = await prisma.notificationDelivery.findMany({
    where: {
      OR: [{ status: "QUEUED" }, { status: "FAILED", attempts: { lt: MAX_ATTEMPTS } }],
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  // W3 (travel-nare): account rows are read once per sweep (cached) so a
  // disabled or unconfigured travel account fails its deliveries with a
  // coded, actionable WorkflowError naming the account — the row stays
  // retryable on the SAME account and no other account is ever tried.
  // Dynamic import: workflow.ts imports this module, so a static import of
  // WorkflowError would close a cycle.
  await ensureDefaultAccounts();
  const { WorkflowError } = await import("@/lib/travel/workflow");
  const accountCache = new Map<string, WhatsAppAccount | null>();
  const accountFor = async (key: string): Promise<WhatsAppAccount | null> => {
    if (!accountCache.has(key)) accountCache.set(key, await getAccount(key));
    return accountCache.get(key) ?? null;
  };

  let processed = 0;
  let sent = 0;
  let failed = 0;

  for (const delivery of candidates) {
    if (
      delivery.status === "FAILED" &&
      now.getTime() - delivery.updatedAt.getTime() < delivery.attempts * RETRY_BACKOFF_MS
    ) {
      continue; // backoff not elapsed
    }
    const claim = await prisma.notificationDelivery.updateMany({
      where: { id: delivery.id, status: delivery.status },
      data: { status: "SENDING" },
    });
    if (claim.count !== 1) continue; // a concurrent sweep claimed it first
    processed++;

    try {
      let providerId: string;
      if (delivery.channel === "EMAIL") {
        const res = await sendEmail({
          to: delivery.destination!,
          subject: `WAControl: ${delivery.body.split("\n")[1] ?? "travel notification"}`,
          text: delivery.body,
        });
        providerId = res.providerId;
      } else {
        // W3 (wa-multi): sends through the account recorded on the delivery
        // (TravelSettings.whatsappAccountKey at queue time) — never a
        // fallback account. A disabled/unconfigured account fails here with a
        // coded WorkflowError; a not-ready client throws from
        // sendWhatsAppMessage naming the account. Either way the delivery
        // becomes FAILED below and stays retryable on the SAME account.
        const account = await accountFor(delivery.accountId);
        if (!account) {
          throw new WorkflowError(
            "TRAVEL_WHATSAPP_ACCOUNT_NOT_CONFIGURED",
            `WhatsApp account "${delivery.accountId}" is not configured. Create it under Admin → WhatsApp accounts; ` +
              `the delivery stays queued for retry on the same account.`,
            503,
          );
        }
        if (!account.enabled) {
          throw new WorkflowError(
            "TRAVEL_WHATSAPP_ACCOUNT_DISABLED",
            `WhatsApp account "${account.key}" (${account.displayName}) is disabled. Enable it under Admin → WhatsApp accounts; ` +
              `the delivery stays queued for retry on the same account.`,
            503,
          );
        }
        const msg: any = await sendWhatsAppMessage({
          accountKey: delivery.accountId,
          remoteJid: delivery.destination!,
          body: delivery.body,
          type: "text",
        });
        // sendMessage may resolve undefined even on success (see whatsapp.ts).
        providerId = msg?.id?._serialized ?? msg?.id?.$1 ?? "whatsapp";
      }
      await prisma.notificationDelivery.update({
        where: { id: delivery.id },
        data: {
          status: "SENT",
          providerId,
          sentAt: new Date(),
          attempts: { increment: 1 },
          lastError: null,
        },
      });
      sent++;
      emitDeliveryStatus(delivery.id, "SENT");
    } catch (err: any) {
      const message = err?.code ? `${err.code}: ${err.message}` : err?.message ?? String(err);
      await prisma.notificationDelivery.update({
        where: { id: delivery.id },
        data: { status: "FAILED", lastError: message, attempts: { increment: 1 } },
      });
      failed++;
      console.log(`[Travel] notification ${delivery.id} failed: ${message}`);
      emitDeliveryStatus(delivery.id, "FAILED");
    }
  }

  return { processed, sent, failed };
}

/**
 * Periodic sweeper for the notification outbox. Returns a stop function.
 * Exported for the server lead — NOT wired into server.ts here.
 */
export function startNotificationWorker(intervalMs = 15000): () => void {
  const timer = setInterval(async () => {
    try {
      await processNotificationQueue({});
    } catch (err: any) {
      console.error("[Travel] notification worker error:", err?.message ?? err);
    }
  }, intervalMs);
  return () => clearInterval(timer);
}

/**
 * Queues VALIDATION_OVERDUE reminders for PENDING_VALIDATION versions whose
 * active assignment is past due. Suppression: at most one reminder event per
 * version per 24h (checked against WorkflowEvent), and only versions still
 * pending with a CURRENT active assignment are considered — decisions or
 * reassignments automatically suppress stale reminders.
 *
 * Escalation: when overdue exceeds 2× overdueReminderHours, the configured
 * escalation user is added as a recipient.
 */
export async function sweepOverdueValidations(now: Date = new Date()): Promise<number> {
  const { getTravelSettings } = await import("@/lib/travel/settings");
  const settings = await getTravelSettings();

  const pending = await prisma.quoteVersion.findMany({
    where: { status: "PENDING_VALIDATION" },
    include: {
      request: {
        include: {
          agency: true,
          owner: true,
          assignments: { where: { active: true }, include: { validator: true } },
        },
      },
    },
  });

  const reminderHorizon = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  let queued = 0;

  for (const version of pending) {
    const assignment = version.request.assignments[0];
    if (!assignment?.dueAt || assignment.dueAt >= now) continue;

    const recent = await prisma.workflowEvent.findFirst({
      where: {
        requestId: version.requestId,
        versionId: version.id,
        type: "VALIDATION_OVERDUE",
        createdAt: { gte: reminderHorizon },
      },
    });
    if (recent) continue;

    const overdueHours = (now.getTime() - assignment.dueAt.getTime()) / 3_600_000;
    const recipients = new Map<string, User>();
    recipients.set(assignment.validator.id, assignment.validator);

    let escalated = false;
    if (
      settings.overdueReminderHours &&
      overdueHours > 2 * settings.overdueReminderHours &&
      settings.escalationUserId
    ) {
      const escalation = await prisma.user.findUnique({ where: { id: settings.escalationUserId } });
      if (escalation) {
        recipients.set(escalation.id, escalation);
        escalated = true;
      }
    }

    const { versionLabel } = await import("@/lib/travel/contracts");
    const payload: NotificationPayload = {
      packageCode: version.request.packageCode,
      clientShort: version.request.agency.shortCode,
      versionLabel: versionLabel(version.versionNo),
      event: "VALIDATION_OVERDUE",
      actorName: "System",
      action: "Review this quotation",
      dueAt: assignment.dueAt.toISOString(),
      reason: escalated ? "overdue; escalated" : "overdue",
      link: `${process.env.NEXTAUTH_URL ?? ""}/travel/requests/${version.requestId}`,
      timestamp: now.toISOString(),
    };

    await prisma.$transaction(async (tx) => {
      await queueWorkflowEvent(tx, {
        requestId: version.requestId,
        versionId: version.id,
        type: "VALIDATION_OVERDUE",
        actorId: null,
        payload,
        recipients: Array.from(recipients.values()),
      });
    });
    queued++;
  }

  return queued;
}
