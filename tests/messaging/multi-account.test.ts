/**
 * W3 (wa-multi) acceptance tests 1-3: per-account WhatsApp clients run
 * independently, driven by a fake whatsapp-web.js (vi.mock) — no browser, no
 * network, no real WhatsApp session. The fake Client / LocalAuth classes
 * record their constructor options and registered event handlers so the real
 * handlers in lib/whatsapp.ts can be fired by the tests. Persistence runs
 * against a throwaway SQLite database (same pattern as tests/travel-db).
 *
 * Covers:
 *  (a) initializeWhatsApp('marhaba') builds LocalAuth with exactly
 *      { dataPath: <cwd>/.wwebjs_auth } — no clientId, so the legacy
 *      .wwebjs_auth/session directory stays untouched (acceptance 2)
 *  (b) initializeWhatsApp('nare') throws and builds no Client/LocalAuth while
 *      the nare account is disabled; once enabled, LocalAuth gets
 *      clientId 'nare' (session-nare, separate from Marhaba) (acceptance 1)
 *  (c) with both accounts running, logout / restart / a failed initialize on
 *      one account leaves the other account's getWhatsAppState() and client
 *      instance completely unchanged — in both directions (acceptance 1)
 *  (d) the same customer JID messaging both accounts creates two Chat rows
 *      (one per accountId) and live events go only to that account's
 *      inbox:<key> room, each payload carrying the matching accountKey
 *      (acceptance 3)
 */

import { beforeAll, describe, expect, it, vi } from "vitest";
import path from "path";
import type { PrismaClient } from "@prisma/client";
import { ensureSchema, getPrisma } from "../travel-db/helpers";

vi.mock("whatsapp-web.js", () => {
  class FakeClient {
    static instances: FakeClient[] = [];
    /** One-shot failure switch for the retry loop: the next initialize() rejects once. */
    static failNextInitialize = false;

    opts: any;
    authStrategy: any;
    info: any = { pushname: "Test Account", wid: { user: "37400000000", _serialized: "37400000000@c.us" } };
    handlers = new Map<string, Array<(...args: any[]) => unknown>>();
    sentMessages: Array<{ to: string; content: any; options: any }> = [];
    initializeCalls = 0;
    destroyCalls = 0;
    logoutCalls = 0;

    constructor(opts?: any) {
      this.opts = opts;
      this.authStrategy = opts?.authStrategy;
      FakeClient.instances.push(this);
    }

    on(event: string, fn: (...args: any[]) => unknown) {
      const list = this.handlers.get(event) ?? [];
      list.push(fn);
      this.handlers.set(event, list);
    }

    /** Test hook: the real handler lib/whatsapp.ts registered for an event. */
    handler(event: string) {
      const list = this.handlers.get(event);
      if (!list || list.length !== 1) throw new Error(`expected exactly one ${event} handler`);
      return list[0] as (...args: any[]) => Promise<void>;
    }

    async initialize() {
      this.initializeCalls++;
      if (FakeClient.failNextInitialize) {
        FakeClient.failNextInitialize = false;
        throw new Error("fake initialize failure (injected by test)");
      }
    }
    async destroy() {
      this.destroyCalls++;
    }
    async logout() {
      this.logoutCalls++;
    }
    async getProfilePicUrl() {
      return null;
    }
    async getChats() {
      return [];
    }
    async getWWebVersion() {
      return "2.3000.0-test";
    }
    async getNumberId(number: string) {
      return { _serialized: `${number}@c.us` };
    }
    async sendMessage(to: string, content: any, options?: any) {
      this.sentMessages.push({ to, content, options });
      return { id: { _serialized: `wamid.out.${this.sentMessages.length}` }, to };
    }
    async getChatById(_id: string) {
      return { sendSeen: async () => {} };
    }
  }

  class FakeLocalAuth {
    static instances: FakeLocalAuth[] = [];
    opts: any;
    constructor(opts?: any) {
      this.opts = opts ?? {};
      FakeLocalAuth.instances.push(this);
    }
  }

  class FakeMessageMedia {
    constructor(..._args: unknown[]) {}
  }

  return { Client: FakeClient, LocalAuth: FakeLocalAuth, MessageMedia: FakeMessageMedia };
});

/** Fake Socket.io server: records every room-scoped emit. */
class FakeIo {
  emits: Array<{ room: string; event: string; payload: any }> = [];
  sockets = { sockets: new Map() };
  use(_middleware: unknown) {}
  on(_event: string, _fn: unknown) {}
  to(room: string) {
    return {
      emit: (event: string, payload: any) => {
        this.emits.push({ room, event, payload });
      },
    };
  }
}

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

const TIMESTAMP = 1_727_500_000;

function fakeIncoming(overrides: Partial<FakeMsg> = {}): FakeMsg {
  return {
    id: { _serialized: "wamid.multi.1" },
    type: "chat",
    from: "37477000111@c.us",
    to: "37410000001@c.us",
    fromMe: false,
    timestamp: TIMESTAMP,
    body: "hello",
    hasMedia: false,
    getContact: async () => ({ pushname: "Caroline Customer" }),
    getChat: async () => ({ name: "Caroline Customer" }),
    ...overrides,
  };
}

const MARHABA_NUMBER = "37410000001";
const MARHABA_PUSHNAME = "Marhaba Armenia";
const NARE_NUMBER = "37495000002";
const NARE_PUSHNAME = "Nare Travel and Tours";

let prisma: PrismaClient;
let wa: typeof import("@/lib/whatsapp");
let fakeIo: FakeIo;
let FakeClientClass: any;
let FakeLocalAuthClass: any;

/** The client instance each account is currently expected to run on. */
const liveClients: Record<string, any> = {};

function localAuthInstances(): Array<{ opts: any }> {
  return FakeLocalAuthClass.instances;
}

function clientInstances(): any[] {
  return FakeClientClass.instances;
}

/** Marks the account's current client and drives its 'ready' handler. */
async function markReady(key: string, client: any, number: string, pushname: string) {
  liveClients[key] = client;
  client.info = { pushname, wid: { user: number, _serialized: `${number}@c.us` } };
  await client.handler("ready")();
}

async function bringUp(key: "marhaba" | "nare") {
  const client: any = await wa.initializeWhatsApp(key);
  await markReady(key, client, key === "nare" ? NARE_NUMBER : MARHABA_NUMBER, key === "nare" ? NARE_PUSHNAME : MARHABA_PUSHNAME);
  return client;
}

/**
 * Functional proof that an account still runs on the SAME client instance:
 * sendWhatsAppMessage resolves the client from the account's runtime, so the
 * send must land on exactly this fake client and no other.
 */
async function assertSendRoutesThrough(key: string, client: any, marker: string) {
  const before = client.sentMessages.length;
  await wa.sendWhatsAppMessage({ accountKey: key, remoteJid: "37499000099@c.us", body: marker, type: "text" });
  expect(client.sentMessages.length).toBe(before + 1);
  expect(client.sentMessages[client.sentMessages.length - 1].content).toBe(marker);
}

/**
 * The init retry loop does real DB I/O (the account gate) before the retry
 * wait, then waits INIT_RETRY_DELAY_MS (10s) on a setTimeout that the tests
 * fake. Alternate real event-loop turns (so prisma queries settle) with
 * fake-clock advances until the init promise settles. Only setTimeout is
 * faked, so setImmediate and Date.now below stay real.
 *
 * The wait is bounded by WALL-CLOCK time, not by a fixed turn count:
 * setImmediate turns are nearly free (~750 turns in ~30ms), while the prisma
 * queries in the account gate take real milliseconds — under full-suite
 * parallel load they can outlast any fixed turn budget, and every fake-clock
 * advance fired before the retry setTimeout was even scheduled is wasted.
 * A wall-clock deadline makes the wait deterministic regardless of load.
 */
async function settleWithRetries(promise: Promise<unknown>) {
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true)
  );
  const deadline = Date.now() + 15_000;
  while (!settled && Date.now() < deadline) {
    for (let j = 0; j < 25 && !settled; j++) {
      await new Promise((r) => setImmediate(r));
    }
    await vi.advanceTimersByTimeAsync(10_500);
  }
  expect(settled).toBe(true);
}

beforeAll(async () => {
  ensureSchema();
  prisma = await getPrisma();
  const wwebjs: any = await import("whatsapp-web.js");
  FakeClientClass = wwebjs.Client;
  FakeLocalAuthClass = wwebjs.LocalAuth;
  wa = await import("@/lib/whatsapp");
  const { ensureDefaultAccounts } = await import("@/lib/whatsapp-accounts");
  await ensureDefaultAccounts();
  fakeIo = new FakeIo();
  wa.setSocketServer(fakeIo as any);
});

describe("account gating and LocalAuth options", () => {
  it("throws and builds no Client/LocalAuth while the nare account is disabled", async () => {
    // Nare ships disabled (lib/whatsapp-accounts.ts): no browser, no QR, no
    // session directory may be created for it until the owner enables it.
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const promise = wa.initializeWhatsApp("nare");
      const rejection = expect(promise).rejects.toThrow(/disabled/);
      await settleWithRetries(promise);
      await rejection;
    } finally {
      vi.useRealTimers();
    }

    expect(clientInstances()).toHaveLength(0);
    expect(localAuthInstances()).toHaveLength(0);
    // The rejection carries the actionable "disabled" message (asserted via
    // .rejects above); the account ends disconnected with no client.
    expect(wa.getWhatsAppState("nare").state).toBe("disconnected");
  });

  it("builds Marhaba's LocalAuth with exactly { dataPath } and no clientId", async () => {
    await bringUp("marhaba");

    expect(localAuthInstances()).toHaveLength(1);
    const opts = localAuthInstances()[0].opts;
    expect(opts).toEqual({ dataPath: path.join(process.cwd(), ".wwebjs_auth") });
    // "Exactly": no clientId key at all, so LocalAuth keeps using the legacy
    // .wwebjs_auth/session directory untouched.
    expect(Object.keys(opts)).toEqual(["dataPath"]);
    expect("clientId" in opts).toBe(false);
    // The client was built on top of that auth strategy.
    expect(clientInstances()).toHaveLength(1);
    expect(clientInstances()[0].authStrategy).toBe(localAuthInstances()[0]);
  });

  it("builds Nare's LocalAuth with clientId 'nare' once the account is enabled", async () => {
    await prisma.whatsAppAccount.update({ where: { key: "nare" }, data: { enabled: true } });
    await bringUp("nare");

    expect(localAuthInstances()).toHaveLength(2);
    expect(localAuthInstances()[1].opts).toEqual({
      dataPath: path.join(process.cwd(), ".wwebjs_auth"),
      clientId: "nare",
    });
    expect(clientInstances()).toHaveLength(2);
    expect(clientInstances()[1].authStrategy).toBe(localAuthInstances()[1]);
    expect(wa.getWhatsAppState("nare").state).toBe("ready");
  });
});

describe("account independence (one account never touches the other)", () => {
  it("logout of nare leaves marhaba's state and client unchanged", async () => {
    const before = wa.getWhatsAppState("marhaba");
    const marhabaClient = liveClients.marhaba;
    const nareClient = liveClients.nare;

    await wa.logoutWhatsApp("nare");

    expect(nareClient.logoutCalls).toBe(1);
    expect(wa.getWhatsAppState("nare").state).toBe("disconnected");
    expect(wa.getWhatsAppState("marhaba")).toEqual(before);
    expect(marhabaClient.logoutCalls).toBe(0);
    expect(marhabaClient.destroyCalls).toBe(0);
    await assertSendRoutesThrough("marhaba", marhabaClient, "marhaba alive after nare logout");

    // Bring nare back up (new client instance) for the next scenario.
    await bringUp("nare");
  });

  it("restart of nare leaves marhaba's state and client unchanged", async () => {
    const before = wa.getWhatsAppState("marhaba");
    const marhabaClient = liveClients.marhaba;
    const oldNare = liveClients.nare;

    const newNare: any = await wa.restartWhatsApp("nare");

    expect(newNare).not.toBe(oldNare);
    expect(oldNare.destroyCalls).toBe(1);
    expect(wa.getWhatsAppState("marhaba")).toEqual(before);
    expect(marhabaClient.destroyCalls).toBe(0);
    expect(marhabaClient.logoutCalls).toBe(0);
    await assertSendRoutesThrough("marhaba", marhabaClient, "marhaba alive after nare restart");

    await markReady("nare", newNare, NARE_NUMBER, NARE_PUSHNAME);
  });

  it("a failed initialize on nare (retried, then recovers) leaves marhaba unchanged", async () => {
    const before = wa.getWhatsAppState("marhaba");
    const marhabaClient = liveClients.marhaba;
    const oldNare = liveClients.nare;

    vi.useFakeTimers({ toFake: ["setTimeout"] });
    let newNare: any;
    try {
      FakeClientClass.failNextInitialize = true;
      const restartPromise = wa.restartWhatsApp("nare");
      await settleWithRetries(restartPromise);
      newNare = await restartPromise;
    } finally {
      vi.useRealTimers();
    }

    // The first attempt's client was torn down; the retry built a fresh one.
    expect(newNare).not.toBe(oldNare);
    expect(oldNare.destroyCalls).toBe(1);
    expect(wa.getWhatsAppState("marhaba")).toEqual(before);
    expect(marhabaClient.destroyCalls).toBe(0);
    expect(marhabaClient.logoutCalls).toBe(0);
    await assertSendRoutesThrough("marhaba", marhabaClient, "marhaba alive after nare init failure");

    await markReady("nare", newNare, NARE_NUMBER, NARE_PUSHNAME);
  });

  it("restart of marhaba leaves nare's state and client unchanged", async () => {
    const before = wa.getWhatsAppState("nare");
    const nareClient = liveClients.nare;
    const oldMarhaba = liveClients.marhaba;

    const newMarhaba: any = await wa.restartWhatsApp("marhaba");

    expect(newMarhaba).not.toBe(oldMarhaba);
    expect(oldMarhaba.destroyCalls).toBe(1);
    expect(wa.getWhatsAppState("nare")).toEqual(before);
    expect(nareClient.destroyCalls).toBe(0);
    expect(nareClient.logoutCalls).toBe(0);
    await assertSendRoutesThrough("nare", nareClient, "nare alive after marhaba restart");

    await markReady("marhaba", newMarhaba, MARHABA_NUMBER, MARHABA_PUSHNAME);
  });

  it("logout of marhaba leaves nare's state and client unchanged", async () => {
    const before = wa.getWhatsAppState("nare");
    const nareClient = liveClients.nare;
    const marhabaClient = liveClients.marhaba;

    await wa.logoutWhatsApp("marhaba");

    expect(marhabaClient.logoutCalls).toBe(1);
    expect(wa.getWhatsAppState("marhaba").state).toBe("disconnected");
    expect(wa.getWhatsAppState("nare")).toEqual(before);
    expect(nareClient.destroyCalls).toBe(0);
    expect(nareClient.logoutCalls).toBe(0);
    await assertSendRoutesThrough("nare", nareClient, "nare alive after marhaba logout");

    // Bring marhaba back up for the cross-account messaging test.
    await bringUp("marhaba");
  });
});

describe("same customer JID on both accounts", () => {
  it("creates two chats (one per account) and emits only to the matching account rooms", async () => {
    const jid = "37477000111@c.us";
    fakeIo.emits.length = 0;

    // Same customer, same WhatsApp message id on both accounts: chat and
    // message identity are (accountId, remoteJid) / (accountId,
    // whatsappMessageId), so neither account dedupes or overwrites the other.
    await liveClients.marhaba.handler("message")(
      fakeIncoming({ id: { _serialized: "wamid.cross.1" }, body: "hello marhaba" })
    );
    await liveClients.nare.handler("message")(
      fakeIncoming({ id: { _serialized: "wamid.cross.1" }, body: "hello nare" })
    );

    const chats = await prisma.chat.findMany({ where: { remoteJid: jid } });
    expect(chats).toHaveLength(2);
    const chatByAccount = new Map(chats.map((c) => [c.accountId, c]));
    expect(chatByAccount.get("marhaba")).toBeTruthy();
    expect(chatByAccount.get("nare")).toBeTruthy();
    expect(chatByAccount.get("marhaba")!.id).not.toBe(chatByAccount.get("nare")!.id);

    const messages = await prisma.message.findMany({ where: { whatsappMessageId: "wamid.cross.1" } });
    expect(messages).toHaveLength(2);
    expect(new Set(messages.map((m) => m.accountId))).toEqual(new Set(["marhaba", "nare"]));
    expect(messages.find((m) => m.accountId === "marhaba")!.body).toBe("hello marhaba");
    expect(messages.find((m) => m.accountId === "nare")!.body).toBe("hello nare");

    // Live events: one 'message' emit per account, to that account's inbox
    // room only, each payload carrying the matching accountKey.
    const messageEmits = fakeIo.emits.filter(
      (e) => e.event === "message" && e.payload?.whatsappMessageId === "wamid.cross.1"
    );
    expect(messageEmits).toHaveLength(2);
    const marhabaEmit = messageEmits.find((e) => e.room === "inbox:marhaba");
    const nareEmit = messageEmits.find((e) => e.room === "inbox:nare");
    expect(marhabaEmit).toBeTruthy();
    expect(marhabaEmit!.payload.accountKey).toBe("marhaba");
    expect(marhabaEmit!.payload.body).toBe("hello marhaba");
    expect(nareEmit).toBeTruthy();
    expect(nareEmit!.payload.accountKey).toBe("nare");
    expect(nareEmit!.payload.body).toBe("hello nare");
    // No cross-account leakage: every emit in this window went to a
    // per-account room, and message content only ever to its own room.
    expect(messageEmits.every((e) => e.room === `inbox:${e.payload.accountKey}`)).toBe(true);
    expect(fakeIo.emits.every((e) => /^(inbox|admins):(marhaba|nare)$/.test(e.room))).toBe(true);
  });
});
