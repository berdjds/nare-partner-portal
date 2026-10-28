import { describe, expect, it } from "vitest";
import { PRIVACY_NOTICE } from "@/lib/legal-content";
import { RETENTION_DAYS } from "@/lib/partners/retention";
import { resolveServerRuntime } from "@/lib/server-mode";

describe("partner retention promise", () => {
  it("states the same retention period as the scheduled sweep", () => {
    const notice = PRIVACY_NOTICE.sections.flatMap((section) => [
      ...(section.paragraphs ?? []),
      ...(section.items ?? []),
    ]);

    expect(notice).toContain(
      `For an application that is not approved, the documents are deleted within ${RETENTION_DAYS} days of the decision, or earlier if you ask us to delete them.`,
    );
  });

  it.each<[string, NodeJS.ProcessEnv]>([
    ["normal", { NODE_ENV: "test" }],
    ["trial", { NODE_ENV: "test", WACONTROL_MODE: "trial" }],
    ["notifications paused", { NODE_ENV: "test", WACONTROL_NOTIFICATIONS_PAUSED: "1" }],
    ["WhatsApp disabled", { NODE_ENV: "test", WHATSAPP_DISABLED: "1" }],
  ])("matches overdue sweep gating by default in %s mode", (_name, env) => {
    const runtime = resolveServerRuntime(env);
    expect(runtime.retentionSweep).toBe(runtime.overdueSweep);
  });
});
