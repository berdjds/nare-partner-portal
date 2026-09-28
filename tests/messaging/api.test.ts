/**
 * Messaging route regression tests (W1): GET /api/chats, GET /api/messages and
 * POST /api/send. getServerSession and the WhatsApp service are mocked — no
 * network, no real WhatsApp client. Prisma runs against a throwaway SQLite
 * database and the real audit writer is used, so the SEND_MESSAGE audit entry
 * is verified end to end.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";
import { ensureSchema, getPrisma } from "../travel-db/helpers";

const { sessionRef, waRef, sendWhatsAppMessageMock } = vi.hoisted(() => ({
  sessionRef: { current: null as any },
  waRef: { state: "ready" as string },
  sendWhatsAppMessageMock: { fn: vi.fn() },
}));

vi.mock("next-auth/next", () => ({
  getServerSession: vi.fn(async () => sessionRef.current),
}));
vi.mock("@/lib/whatsapp", () => ({
  sendWhatsAppMessage: sendWhatsAppMessageMock.fn,
  getWhatsAppState: vi.fn(() => ({ state: waRef.state })),
}));

let prisma: PrismaClient;
let chatsGET: typeof import("@/app/api/chats/route").GET;
let messagesGET: typeof import("@/app/api/messages/route").GET;
let sendPOST: typeof import("@/app/api/send/route").POST;

let sender: { id: string; email: string };
let chat: { id: string; remoteJid: string };
let storedMessage: { id: string; body: string | null; type: string; whatsappMessageId: string | null };

function login() {
  sessionRef.current = {
    user: { id: sender.id, role: "USER", email: sender.email, name: "Sender" },
    expires: "2099-01-01",
  };
}

function postSend(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/send", {
    method: "POST",
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

beforeAll(async () => {
  ensureSchema();
  prisma = await getPrisma();
  chatsGET = (await import("@/app/api/chats/route")).GET;
  messagesGET = (await import("@/app/api/messages/route")).GET;
  sendPOST = (await import("@/app/api/send/route")).POST;

  sender = await prisma.user.create({
    data: { email: "msg-sender@test.io", name: "Sender", password: "x", role: "USER" },
  });
  chat = await prisma.chat.create({
    data: { remoteJid: "37410000001@c.us", name: "Alice" },
  });
  storedMessage = await prisma.message.create({
    data: {
      chatId: chat.id,
      remoteJid: chat.remoteJid,
      whatsappMessageId: "wamid.regression.1",
      fromMe: false,
      body: "stored hello",
      type: "text",
      timestamp: new Date("2026-09-01T10:00:00.000Z"),
    },
  });
});

beforeEach(() => {
  sessionRef.current = null;
  waRef.state = "ready";
  sendWhatsAppMessageMock.fn.mockReset();
  sendWhatsAppMessageMock.fn.mockResolvedValue({ id: { _serialized: "wamid.sent.1" } });
});

describe("GET /api/chats", () => {
  it("returns 401 without a session", async () => {
    const res = await chatsGET();
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Unauthorized");
  });

  it("returns the stored chats with their last message to a logged-in user", async () => {
    login();
    const res = await chatsGET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    const found = body.find((c: any) => c.remoteJid === chat.remoteJid);
    expect(found).toBeTruthy();
    expect(found.name).toBe("Alice");
    expect(found.messages).toHaveLength(1);
    expect(found.messages[0]).toMatchObject({
      body: storedMessage.body,
      fromMe: false,
      type: "text",
    });
  });
});

describe("GET /api/messages", () => {
  it("returns 401 without a session", async () => {
    const res = await messagesGET(new NextRequest(`http://localhost:3000/api/messages?chatId=${chat.id}`));
    expect(res.status).toBe(401);
  });

  it("returns the stored messages for a chatId", async () => {
    login();
    const res = await messagesGET(new NextRequest(`http://localhost:3000/api/messages?chatId=${chat.id}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    const found = body.find((m: any) => m.id === storedMessage.id);
    expect(found).toMatchObject({
      remoteJid: chat.remoteJid,
      whatsappMessageId: "wamid.regression.1",
      body: "stored hello",
      type: "text",
    });
  });

  it("returns the stored messages for a remoteJid and 400 with no selector", async () => {
    login();
    const byJid = await messagesGET(new NextRequest(`http://localhost:3000/api/messages?remoteJid=${chat.remoteJid}`));
    expect(byJid.status).toBe(200);
    expect((await byJid.json()).map((m: any) => m.id)).toContain(storedMessage.id);

    const none = await messagesGET(new NextRequest("http://localhost:3000/api/messages"));
    expect(none.status).toBe(400);
  });
});

describe("POST /api/send", () => {
  const validBody = { remoteJid: "37410000002@c.us", body: "hi there", type: "text" };

  it("returns 401 without a session and never touches WhatsApp", async () => {
    const res = await sendPOST(postSend(validBody));
    expect(res.status).toBe(401);
    expect(sendWhatsAppMessageMock.fn).not.toHaveBeenCalled();
    expect(await prisma.log.count({ where: { action: "SEND_MESSAGE" } })).toBe(0);
  });

  it("returns 503 when the WhatsApp client is not ready", async () => {
    login();
    waRef.state = "disconnected";
    const res = await sendPOST(postSend(validBody));
    expect(res.status).toBe(503);
    expect(sendWhatsAppMessageMock.fn).not.toHaveBeenCalled();
    waRef.state = "ready";
  });

  it("rejects an invalid body with 400 (zod) and does not send", async () => {
    login();
    const res = await sendPOST(postSend({ body: "missing remoteJid" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(Array.isArray(body.error)).toBe(true);
    expect(sendWhatsAppMessageMock.fn).not.toHaveBeenCalled();
  });

  it("treats an undefined send result as success, sends exactly once, and writes a SEND_MESSAGE audit entry", async () => {
    login();
    // whatsapp-web.js can resolve sendMessage() to undefined even on success.
    sendWhatsAppMessageMock.fn.mockResolvedValue(undefined);

    const res = await sendPOST(postSend(validBody));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(sendWhatsAppMessageMock.fn).toHaveBeenCalledTimes(1);
    expect(sendWhatsAppMessageMock.fn).toHaveBeenCalledWith(
      expect.objectContaining({ remoteJid: validBody.remoteJid, body: validBody.body, type: "text" }),
    );

    const audit = await prisma.log.findFirst({ where: { action: "SEND_MESSAGE" } });
    expect(audit).toBeTruthy();
    expect(audit!.userId).toBe(sender.id);
    expect(audit!.details).toContain(validBody.remoteJid);
  });

  it("applies the zod defaults (type=text) and forwards media fields verbatim", async () => {
    login();
    const res = await sendPOST(
      postSend({ remoteJid: "37410000003@c.us", mediaBase64: "QUJD", mediaMimeType: "application/pdf", mediaFilename: "quote.pdf" }),
    );
    expect(res.status).toBe(200);
    expect(sendWhatsAppMessageMock.fn).toHaveBeenCalledTimes(1);
    expect(sendWhatsAppMessageMock.fn).toHaveBeenCalledWith(
      expect.objectContaining({
        remoteJid: "37410000003@c.us",
        type: "text", // schema default — text-without-body carries the media fields
        mediaBase64: "QUJD",
        mediaMimeType: "application/pdf",
        mediaFilename: "quote.pdf",
      }),
    );
  });

  it("returns 500 when the send throws", async () => {
    login();
    sendWhatsAppMessageMock.fn.mockRejectedValue(new Error("Not a WhatsApp number: 37410000002"));
    const res = await sendPOST(postSend(validBody));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("Not a WhatsApp number");
    // The failed send still produced an audit attempt that must not crash the route.
    expect(await prisma.log.count({ where: { action: "SEND_MESSAGE" } })).toBeGreaterThanOrEqual(1);
  });
});
