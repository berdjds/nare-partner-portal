/**
 * WhatsApp persistence regression tests (W1): pins lib/whatsapp.ts behaviour
 * so later W1 tasks and the Next 15 upgrade are proven not to change it.
 *
 * whatsapp-web.js is replaced by a fake in-memory client, so
 * initializeWhatsApp() registers its real event handlers without ever
 * launching a browser. The fake client's captured `message` /
 * `message_create` handlers then drive persistMessage() against a throwaway
 * SQLite database — no network, no real WhatsApp session.
 *
 * Covers:
 *  - getMessageId() reads both id._serialized (legacy) and id.$1 (2.3000.x+)
 *  - the same message delivered via both `message` and `message_create`
 *    persists exactly once (unique whatsappMessageId)
 *  - a P2002 unique-violation from the racing events is swallowed
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { ensureSchema, getPrisma } from "../travel-db/helpers";

interface FakeMsg {
  id: { _serialized?: string; $1?: string };
  type: string;
  from: string;
  to: string;
  fromMe: boolean;
  timestamp: number;
  body: string;
  hasMedia: boolean;
  getContact: () => Promise<{ pushname: string }>;
  getChat: () => Promise<{ name: string }>;
}

vi.mock("whatsapp-web.js", () => {
  class FakeClient {
    handlers = new Map<string, ((...args: any[]) => unknown)[]>();
    on(event: string, fn: (...args: any[]) => unknown) {
      const list = this.handlers.get(event) ?? [];
      list.push(fn);
      this.handlers.set(event, list);
    }
    /** Test hook: the real handler registered for a client event. */
    handler(event: string) {
      const list = this.handlers.get(event);
      if (!list || list.length !== 1) throw new Error(`expected exactly one ${event} handler`);
      return list[0];
    }
    async initialize() {}
    async destroy() {}
    async logout() {}
    async getProfilePicUrl() {
      return null;
    }
  }
  class LocalAuth {
    constructor(_opts?: unknown) {}
  }
  class MessageMedia {
    constructor(..._args: unknown[]) {}
  }
  return { Client: FakeClient, LocalAuth, MessageMedia };
});

let prisma: PrismaClient;
let wa: typeof import("@/lib/whatsapp");
let client: import("whatsapp-web.js").Client & {
  handler: (event: string) => (msg: FakeMsg) => Promise<void>;
};

const TIMESTAMP = 1_727_500_000; // seconds, as delivered by whatsapp-web.js

function fakeMsg(overrides: Partial<FakeMsg> = {}): FakeMsg {
  return {
    id: { _serialized: "wamid.H3LL0.1" },
    type: "chat",
    from: "37499000001@c.us",
    to: "37499000002@c.us",
    fromMe: false,
    timestamp: TIMESTAMP,
    body: "regression ping",
    hasMedia: false,
    getContact: async () => ({ pushname: "Alice Regression" }),
    getChat: async () => ({ name: "Alice Regression" }),
    ...overrides,
  };
}

beforeAll(async () => {
  ensureSchema();
  prisma = await getPrisma();
  wa = await import("@/lib/whatsapp");
  client = (await wa.initializeWhatsApp()) as any;
});

afterAll(async () => {
  await wa.logoutWhatsApp();
});

describe("getMessageId() via persistMessage", () => {
  it("persists whatsappMessageId from id._serialized (legacy field)", async () => {
    const msg = fakeMsg({ id: { _serialized: "wamid.legacy.serialized" } });
    await client.handler("message")(msg);

    const row = await prisma.message.findUnique({
      where: { accountId_whatsappMessageId: { accountId: "marhaba", whatsappMessageId: "wamid.legacy.serialized" } },
    });
    expect(row).toBeTruthy();
    expect(row!.fromMe).toBe(false);
    expect(row!.body).toBe("regression ping");
    expect(row!.type).toBe("text");
    expect(row!.timestamp).toEqual(new Date(TIMESTAMP * 1000));
    expect(row!.accountId).toBe("marhaba");
    // The chat was derived from msg.from (getChat() avoided) and named from the contact.
    const chatRow = await prisma.chat.findUnique({ where: { id: row!.chatId } });
    expect(chatRow!.remoteJid).toBe("37499000001@c.us");
    expect(chatRow!.accountId).toBe("marhaba");
    expect(chatRow!.name).toBe("Alice Regression");
    expect(chatRow!.phone).toBe("37499000001");
  });

  it("persists whatsappMessageId from id.$1 (WhatsApp Web 2.3000.1043x+)", async () => {
    const msg = fakeMsg({ id: { $1: "wamid.new.dollar1" } });
    await client.handler("message_create")(msg);

    const row = await prisma.message.findUnique({
      where: { accountId_whatsappMessageId: { accountId: "marhaba", whatsappMessageId: "wamid.new.dollar1" } },
    });
    expect(row).toBeTruthy();
    expect(row!.body).toBe("regression ping");
  });
});

describe("message + message_create idempotency", () => {
  it("persists the same WhatsApp message exactly once when both events fire", async () => {
    const msg = fakeMsg({ id: { _serialized: "wamid.double.delivery" } });

    // Sequentially: the second event hits the findUnique short-circuit.
    await client.handler("message")(msg);
    await client.handler("message_create")(msg);

    const rows = await prisma.message.findMany({ where: { whatsappMessageId: "wamid.double.delivery" } });
    expect(rows).toHaveLength(1);
  });

  it("stays idempotent when both events race (P2002 swallowed)", async () => {
    const msg = fakeMsg({ id: { _serialized: "wamid.racing.delivery" } });

    await Promise.all([client.handler("message")(msg), client.handler("message_create")(msg)]);

    const rows = await prisma.message.findMany({ where: { whatsappMessageId: "wamid.racing.delivery" } });
    expect(rows).toHaveLength(1);
  });

  it("swallows a P2002 unique violation on message.create without persisting a duplicate", async () => {
    const msg = fakeMsg({ id: { _serialized: "wamid.p2002.swallowed" } });
    const createSpy = vi
      .spyOn(prisma.message, "create")
      .mockRejectedValueOnce(Object.assign(new Error("Unique constraint failed on the fields: (`whatsappMessageId`)"), { code: "P2002" }));

    await expect(client.handler("message")(msg)).resolves.toBeUndefined();
    createSpy.mockRestore();

    // The P2002 meant nothing was stored, so a redelivery of the same message
    // persists normally afterwards — and still exactly once.
    await client.handler("message_create")(msg);
    expect(await prisma.message.count({ where: { whatsappMessageId: "wamid.p2002.swallowed" } })).toBe(1);
  });
});
