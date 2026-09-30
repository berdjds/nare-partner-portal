/**
 * Email regression tests (W1): pins lib/email.ts behaviour so later W1 tasks
 * and the Next 15 upgrade are proven not to change it.
 *
 * nodemailer's createTransport is mocked, but the returned transporter is a
 * REAL nodemailer jsonTransport/streamTransport — nothing opens a socket and
 * no SMTP server is contacted. The captured sendMail argument is asserted for
 * the expected from/to/subject/text shape, and the message must never use
 * nodemailer's `raw` option (raw MIME bypasses header handling).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createTransportMock = vi.hoisted(() => ({ fn: vi.fn() }));

vi.mock("nodemailer", () => ({
  default: { createTransport: createTransportMock.fn },
  createTransport: createTransportMock.fn,
}));

// The real nodemailer is only reachable through vi.importActual (bypasses the
// mock); loading it lazily keeps it out of the mocked module graph.
let real: any;

let sentMessages: any[] = [];
let sendInfos: any[] = [];

/** Install a REAL no-network transporter and capture every built message. */
function useRealTransport(kind: "stream" | "json") {
  sentMessages = [];
  sendInfos = [];
  createTransportMock.fn.mockImplementation((_opts: unknown) => {
    const transporter =
      kind === "stream"
        ? real.createTransport({ streamTransport: true, buffer: true, newline: "unix" })
        : real.createTransport({ jsonTransport: true });
    const original = transporter.sendMail.bind(transporter);
    transporter.sendMail = async (mail: unknown) => {
      sentMessages.push(mail);
      const info = await original(mail);
      sendInfos.push(info);
      return info;
    };
    return transporter;
  });
}

const SMTP_VARS = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM"] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
  if (!real) {
    const actual: any = await vi.importActual<typeof import("nodemailer")>("nodemailer");
    real = actual.default ?? actual;
  }
  savedEnv = Object.fromEntries(SMTP_VARS.map((k) => [k, process.env[k]]));
  createTransportMock.fn.mockReset();
  useRealTransport("stream");
});

afterEach(() => {
  for (const k of SMTP_VARS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("sendEmail configuration", () => {
  it("throws EMAIL_NOT_CONFIGURED when SMTP_HOST is unset and never builds a transport", async () => {
    delete process.env.SMTP_HOST;
    const { sendEmail } = await import("@/lib/email");
    await expect(sendEmail({ to: "a@b.c", subject: "s", text: "t" })).rejects.toThrow("EMAIL_NOT_CONFIGURED");
    expect(createTransportMock.fn).not.toHaveBeenCalled();
  });

  it("builds an SMTP transport from the environment (secure only on port 465)", async () => {
    process.env.SMTP_HOST = "smtp.example.test";
    process.env.SMTP_PORT = "465";
    process.env.SMTP_USER = "smtp-user";
    process.env.SMTP_PASS = "smtp-pass";
    process.env.SMTP_FROM = "wacontrol@example.test";

    const { sendEmail } = await import("@/lib/email");
    await sendEmail({ to: "ops@example.test", subject: "hi", text: "body" });
    expect(createTransportMock.fn).toHaveBeenCalledWith({
      host: "smtp.example.test",
      port: 465,
      secure: true,
      auth: { user: "smtp-user", pass: "smtp-pass" },
    });

    createTransportMock.fn.mockClear();
    process.env.SMTP_PORT = "587";
    await sendEmail({ to: "ops@example.test", subject: "hi", text: "body" });
    expect(createTransportMock.fn).toHaveBeenCalledWith({
      host: "smtp.example.test",
      port: 587,
      secure: false,
      auth: { user: "smtp-user", pass: "smtp-pass" },
    });
  });

  it("omits auth when SMTP_USER is unset and defaults the port to 587", async () => {
    process.env.SMTP_HOST = "smtp.example.test";
    delete process.env.SMTP_PORT;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    delete process.env.SMTP_FROM;

    const { sendEmail } = await import("@/lib/email");
    await sendEmail({ to: "ops@example.test", subject: "hi", text: "body" });
    expect(createTransportMock.fn).toHaveBeenCalledWith({
      host: "smtp.example.test",
      port: 587,
      secure: false,
      auth: undefined,
    });
  });
});

describe("built message (streamTransport)", () => {
  it("carries the expected from/to/subject/text and never uses the raw option", async () => {
    process.env.SMTP_HOST = "smtp.example.test";
    process.env.SMTP_FROM = "Wacontrol <wacontrol@example.test>";

    const { sendEmail } = await import("@/lib/email");
    const result = await sendEmail({ to: "ops@example.test", subject: "Quotation ready", text: "Hello\nWorld" });

    expect(sentMessages).toHaveLength(1);
    const mail = sentMessages[0];
    // Header-injection bypass must stay unused, and today's shape carries no
    // prebuilt attachments either — only the composed from/to/subject/text.
    expect(mail.raw).toBeUndefined();
    expect(mail.attachments).toBeUndefined();
    expect(mail.from).toBe("Wacontrol <wacontrol@example.test>");
    expect(mail.to).toBe("ops@example.test");
    expect(mail.subject).toBe("Quotation ready");
    expect(mail.text).toBe("Hello\nWorld");
    // providerId is the SMTP message id from the transport.
    expect(result.providerId).toBe(sendInfos[0].messageId);
    expect(result.providerId).toBeTruthy();
  });
});

describe("built message (jsonTransport)", () => {
  it("serializes the same message shape — from/to/subject/text, no raw", async () => {
    useRealTransport("json");
    process.env.SMTP_HOST = "smtp.example.test";
    process.env.SMTP_USER = "smtp-user";
    delete process.env.SMTP_FROM;

    const { sendEmail } = await import("@/lib/email");
    await sendEmail({ to: "validator@example.test", subject: "WAControl: notification", text: "line1\nline2" });

    expect(sentMessages).toHaveLength(1);
    const mail = sentMessages[0];
    expect(mail.raw).toBeUndefined();

    const built = JSON.parse(sendInfos[0].message);
    const serialized = JSON.stringify(built);
    expect(serialized).toContain("smtp-user"); // falls back to SMTP_USER when SMTP_FROM is unset
    expect(serialized).toContain("validator@example.test");
    expect(serialized).toContain("WAControl: notification");
    expect(serialized).toContain("line1");
    expect(built.raw).toBeUndefined();
  });
});
