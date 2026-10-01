/**
 * Deploy-gate run modes for the custom server (W1, task deploy-gate).
 *
 * A candidate build must be exercisable against a COPY of production data
 * without starting any background writers, so the VPS deploy script runs
 * trial containers with WACONTROL_MODE=trial. Notification delivery can also
 * be paused independently on a live container with
 * WACONTROL_NOTIFICATIONS_PAUSED=1.
 *
 * Trial mode is HTTP-only: no WhatsApp client, no notification worker and no
 * overdue-validation sweep are started. HTTP, Socket.io and the authenticated
 * media gate are unaffected — a trial container answers /login exactly like a
 * normal one, which is what the deploy script's internal health check probes.
 *
 * Staging (W3b) runs in normal mode — the notification worker stays up so
 * staging e-mail can flow to the staging sink — but must NEVER start the
 * WhatsApp Web client: the deploy gate starts staging with
 * WHATSAPP_DISABLED=1, which gates only the WhatsApp client.
 */

export type ServerRunMode = "normal" | "trial";

export interface ServerRuntime {
  mode: ServerRunMode;
  /** true when WACONTROL_NOTIFICATIONS_PAUSED=1 */
  notificationsPaused: boolean;
  /** start the WhatsApp Web client */
  whatsapp: boolean;
  /** start the travel notification outbox worker */
  notificationWorker: boolean;
  /** schedule the hourly overdue-validation sweep */
  overdueSweep: boolean;
}

export function resolveServerRuntime(env: NodeJS.ProcessEnv = process.env): ServerRuntime {
  const trial = env.WACONTROL_MODE === "trial";
  const whatsappDisabled = env.WHATSAPP_DISABLED === "1";
  const notificationsPaused = env.WACONTROL_NOTIFICATIONS_PAUSED === "1";
  return {
    mode: trial ? "trial" : "normal",
    notificationsPaused,
    whatsapp: !trial && !whatsappDisabled,
    notificationWorker: !trial && !notificationsPaused,
    overdueSweep: !trial,
  };
}
