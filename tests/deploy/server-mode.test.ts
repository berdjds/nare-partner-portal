/**
 * Deploy-gate run-mode tests (W1, task deploy-gate) for lib/server-mode.ts and
 * its wiring in server.ts.
 *
 * Trial mode (WACONTROL_MODE=trial) must start no WhatsApp client and no
 * background job; WACONTROL_NOTIFICATIONS_PAUSED=1 must start no notification
 * worker. resolveServerRuntime() is the single source of truth for those
 * decisions; the server.ts wiring checks below pin each gated call site to
 * its runtime flag so the gate cannot be bypassed accidentally.
 */

import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { resolveServerRuntime } from "@/lib/server-mode";

describe("resolveServerRuntime", () => {
  it("normal mode starts the WhatsApp client and all background jobs", () => {
    const rt = resolveServerRuntime({ NODE_ENV: "test" });
    expect(rt.mode).toBe("normal");
    expect(rt.notificationsPaused).toBe(false);
    expect(rt.whatsapp).toBe(true);
    expect(rt.notificationWorker).toBe(true);
    expect(rt.overdueSweep).toBe(true);
  });

  it("trial mode starts no WhatsApp client and no background jobs", () => {
    const rt = resolveServerRuntime({ NODE_ENV: "test", WACONTROL_MODE: "trial" });
    expect(rt.mode).toBe("trial");
    expect(rt.whatsapp).toBe(false);
    expect(rt.notificationWorker).toBe(false);
    expect(rt.overdueSweep).toBe(false);
  });

  it("paused mode starts no notification worker (WhatsApp and sweep still run)", () => {
    const rt = resolveServerRuntime({ NODE_ENV: "test", WACONTROL_NOTIFICATIONS_PAUSED: "1" });
    expect(rt.mode).toBe("normal");
    expect(rt.notificationsPaused).toBe(true);
    expect(rt.notificationWorker).toBe(false);
    expect(rt.whatsapp).toBe(true);
    expect(rt.overdueSweep).toBe(true);
  });

  it("trial wins over paused: every background writer stays off", () => {
    const rt = resolveServerRuntime({ NODE_ENV: "test", WACONTROL_MODE: "trial", WACONTROL_NOTIFICATIONS_PAUSED: "1" });
    expect(rt.mode).toBe("trial");
    expect(rt.notificationWorker).toBe(false);
    expect(rt.whatsapp).toBe(false);
    expect(rt.overdueSweep).toBe(false);
  });

  it("only the exact values 'trial' and '1' trigger the gates", () => {
    expect(resolveServerRuntime({ NODE_ENV: "test", WACONTROL_MODE: "TRIAL" }).whatsapp).toBe(true);
    expect(resolveServerRuntime({ NODE_ENV: "test", WACONTROL_MODE: "trial " }).whatsapp).toBe(true);
    expect(resolveServerRuntime({ NODE_ENV: "test", WACONTROL_NOTIFICATIONS_PAUSED: "true" }).notificationWorker).toBe(true);
    expect(resolveServerRuntime({ NODE_ENV: "test", WACONTROL_NOTIFICATIONS_PAUSED: "0" }).notificationWorker).toBe(true);
  });
});

describe("server.ts deploy-gate wiring", () => {
  const source = readFileSync(path.resolve(__dirname, "..", "..", "server.ts"), "utf8");

  it("derives the runtime from resolveServerRuntime()", () => {
    expect(source).toContain("resolveServerRuntime()");
  });

  it("initializes WhatsApp only behind runtime.whatsapp", () => {
    // No dotAll flag: the project tsconfig sets no `target` (default ES5),
    // and tsc rejects the `s` regex flag below ES2018 (TS1501). The `\s*`
    // spans match the newlines here without it.
    expect(source).toMatch(/if \(runtime\.whatsapp\) \{\s*setTimeout\(\(\) => \{\s*initializeWhatsApp/);
  });

  it("starts the notification worker only behind runtime.notificationWorker", () => {
    expect(source).toMatch(/if \(runtime\.notificationWorker\) \{\s*startNotificationWorker\(\);/);
  });

  it("schedules the overdue sweep only behind runtime.overdueSweep", () => {
    expect(source).toMatch(/if \(runtime\.overdueSweep\) \{\s*setInterval\(\(\) => \{\s*sweepOverdueValidations/);
  });
});
