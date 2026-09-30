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
  const notificationsPaused = env.WACONTROL_NOTIFICATIONS_PAUSED === "1";
  return {
    mode: trial ? "trial" : "normal",
    notificationsPaused,
    whatsapp: !trial,
    notificationWorker: !trial && !notificationsPaused,
    overdueSweep: !trial,
  };
}
