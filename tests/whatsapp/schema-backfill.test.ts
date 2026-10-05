/**
 * W3 backfill drill (acceptance criterion 2): proves that a POPULATED
 * pre-W3 database copy gains the new account columns via plain
 * `prisma db push` — no --accept-data-loss, no rows lost, and every existing
 * Chat / Message / NotificationDelivery row lands on the Marhaba account.
 *
 * Procedure:
 *  1. push the pre-W3 schema (below, as it was before this change) into a
 *     throwaway SQLite file
 *  2. populate it with chats, messages and a notification delivery
 *  3. run the repo's current `prisma db push` against that file
 *  4. verify the data with the current Prisma client
 *
 * The final describe block extends the drill for W6a: the deploy-time push on
 * a populated database must also create the additive PasswordResetToken and
 * SecurityRequest tables with their declared constraints (unique tokenHash,
 * @@index([userId]), @@index([kind, createdAt]), no foreign key on
 * SecurityRequest). These assertions use raw SQL on purpose: they verify the
 * database structure itself and stay valid even before `prisma generate` has
 * regenerated the typed client with the new models.
 */

import { execSync } from "child_process";
import { writeFileSync } from "fs";
import path from "path";
import { beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";

const rand = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
const DB_FILE = `/tmp/wacontrol-backfill-${rand}.db`;
const OLD_SCHEMA_FILE = `/tmp/wacontrol-old-schema-${rand}.prisma`;
const REPO_ROOT = path.resolve(__dirname, "..", "..");

process.env.DATABASE_URL = `file:${DB_FILE}`;

// The pre-W3 schema: Chat/Message/NotificationDelivery/TravelSettings as they
// were before the account columns, plus the unchanged User/WorkflowEvent
// models that NotificationDelivery references.
const OLD_SCHEMA = `
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}

model User {
  id        String   @id @default(cuid())
  email     String   @unique
  name      String?
  password  String
  role      String   @default("USER")
  active    Boolean  @default(true)
  sessionVersion Int @default(0)
  phone     String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  messages  Message[] @relation("SentBy")
  notificationDeliveries   NotificationDelivery[]
}

model Chat {
  id            String   @id @default(cuid())
  remoteJid     String   @unique
  name          String?
  phone         String?
  profilePicUrl String?
  lastMessageAt DateTime @default(now())
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  messages Message[]
}

model Message {
  id                String   @id @default(cuid())
  chatId            String
  remoteJid         String
  whatsappMessageId String?  @unique
  fromMe            Boolean  @default(false)
  body              String?
  type              String   @default("text")
  mediaUrl          String?
  mediaMimeType     String?
  mediaCaption      String?
  timestamp         DateTime @default(now())
  status            String   @default("received")
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  sentById String?
  sentBy   User?   @relation(fields: [sentById], references: [id], name: "SentBy")

  chat Chat @relation(fields: [chatId], references: [id], onDelete: Cascade)

  @@index([chatId, timestamp])
}

model WorkflowEvent {
  id          String   @id @default(cuid())
  requestId   String
  versionId   String?
  type        String
  actorId     String?
  payloadJson String
  createdAt   DateTime @default(now())

  deliveries NotificationDelivery[]
}

model NotificationDelivery {
  id          String    @id @default(cuid())
  eventId     String
  recipientId String
  channel     String
  destination String?
  dedupKey    String    @unique
  status      String    @default("QUEUED")
  providerId  String?
  attempts    Int       @default(0)
  lastError   String?
  body        String
  sentAt      DateTime?
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt

  event     WorkflowEvent @relation(fields: [eventId], references: [id], onDelete: Cascade)
  recipient User          @relation(fields: [recipientId], references: [id])

  @@index([status])
}

model TravelSettings {
  id                      String  @id @default("default")
  companyTz               String  @default("Asia/Yerevan")
  defaultPolicyId         String?
  requireSettingsForIssue Boolean @default(true)
  overdueReminderHours    Int?
  escalationUserId        String?
  documentsDir            String  @default("data/documents")
  companyName             String?
  companyPhone            String?
  companyEmail            String?
  companyAddress          String?
  companyWebsite          String?
  brandColor              String?
  validatorGroupJid       String?
  infantMaxAge            Int     @default(2)
  validatorUserIds        String  @default("[]")
  updatedAt               DateTime @updatedAt
}
`;

function dbPush(schemaPath?: string) {
  const schemaArg = schemaPath ? ` --schema=${schemaPath}` : "";
  execSync(`npx prisma db push --skip-generate${schemaArg}`, {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: `file:${DB_FILE}` },
    stdio: "pipe",
  });
}

let prisma: PrismaClient;

beforeAll(async () => {
  // 1. Old schema, populated like a production copy.
  writeFileSync(OLD_SCHEMA_FILE, OLD_SCHEMA);
  dbPush(OLD_SCHEMA_FILE);

  const { PrismaClient } = await import("@prisma/client");
  prisma = new PrismaClient({ datasources: { db: { url: `file:${DB_FILE}` } } });

  await prisma.$executeRawUnsafe(
    `INSERT INTO "User" ("id","email","name","password","role","active","sessionVersion","createdAt","updatedAt")
     VALUES ('u1','owner@test.io','Owner','x','ADMIN',1,0,datetime('now'),datetime('now'))`
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Chat" ("id","remoteJid","name","phone","lastMessageAt","createdAt","updatedAt")
     VALUES ('c1','37411000001@c.us','Alice','37411000001',datetime('now'),datetime('now'),datetime('now')),
            ('c2','37411000002@c.us','Bob','37411000002',datetime('now'),datetime('now'),datetime('now'))`
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Message" ("id","chatId","remoteJid","whatsappMessageId","fromMe","body","type","timestamp","status","createdAt","updatedAt")
     VALUES ('m1','c1','37411000001@c.us','wamid.old.1',0,'hello','text',datetime('now'),'received',datetime('now'),datetime('now')),
            ('m2','c1','37411000001@c.us','wamid.old.2',1,'hi back','text',datetime('now'),'sent',datetime('now'),datetime('now')),
            ('m3','c2','37411000002@c.us',NULL,0,'no wa id','text',datetime('now'),'received',datetime('now'),datetime('now'))`
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "WorkflowEvent" ("id","requestId","type","payloadJson","createdAt")
     VALUES ('e1','r1','SUBMITTED','{}',datetime('now'))`
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "NotificationDelivery" ("id","eventId","recipientId","channel","destination","dedupKey","status","attempts","body","createdAt","updatedAt")
     VALUES ('d1','e1','u1','WHATSAPP','37411000001','e1:u1:WHATSAPP','SENT',1,'doc',datetime('now'),datetime('now'))`
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "TravelSettings" ("id","companyTz","documentsDir","validatorUserIds","updatedAt")
     VALUES ('default','Asia/Yerevan','data/documents','[]',datetime('now'))`
  );

  // 2. The deploy-time push with the CURRENT schema. Must succeed without
  //    --accept-data-loss; execSync throws on a non-zero exit.
  dbPush();
}, 120_000);

describe("db push backfill on a populated pre-W3 database", () => {
  it("keeps every chat and assigns it to the Marhaba account", async () => {
    const chats = await prisma.chat.findMany({ orderBy: { id: "asc" } });
    expect(chats).toHaveLength(2);
    for (const chat of chats) {
      expect(chat.accountId).toBe("marhaba");
    }
    expect(chats.map((c) => c.remoteJid)).toEqual(["37411000001@c.us", "37411000002@c.us"]);
    expect(chats[0].name).toBe("Alice");
    expect(chats[0].phone).toBe("37411000001");
  });

  it("keeps every message (including the one without a WhatsApp id) and assigns it to Marhaba", async () => {
    const messages = await prisma.message.findMany({ orderBy: { id: "asc" } });
    expect(messages).toHaveLength(3);
    for (const message of messages) {
      expect(message.accountId).toBe("marhaba");
    }
    expect(messages[0].whatsappMessageId).toBe("wamid.old.1");
    expect(messages[2].whatsappMessageId).toBeNull();
    expect(messages[2].body).toBe("no wa id");
  });

  it("assigns the existing notification delivery to Marhaba", async () => {
    const delivery = await prisma.notificationDelivery.findUnique({ where: { id: "d1" } });
    expect(delivery).toBeTruthy();
    expect(delivery!.accountId).toBe("marhaba");
    expect(delivery!.dedupKey).toBe("e1:u1:WHATSAPP");
  });

  it("defaults TravelSettings.whatsappAccountKey to 'nare' on the existing row", async () => {
    const settings = await prisma.travelSettings.findUnique({ where: { id: "default" } });
    expect(settings).toBeTruthy();
    expect(settings!.whatsappAccountKey).toBe("nare");
    expect(settings!.companyTz).toBe("Asia/Yerevan");
  });

  it("applies the composite chat unique: same remoteJid is allowed on a second account but not twice on Marhaba", async () => {
    const { ensureDefaultAccounts } = await import("@/lib/whatsapp-accounts");
    await ensureDefaultAccounts();

    const nareChat = await prisma.chat.create({
      data: { accountId: "nare", remoteJid: "37411000001@c.us", name: "Alice on Nare" },
    });
    expect(nareChat.accountId).toBe("nare");

    await expect(
      prisma.chat.create({ data: { accountId: "marhaba", remoteJid: "37411000001@c.us" } })
    ).rejects.toMatchObject({ code: "P2002" });

    // Same WhatsApp message id may exist once per account.
    await prisma.message.create({
      data: { accountId: "nare", chatId: nareChat.id, remoteJid: nareChat.remoteJid, whatsappMessageId: "wamid.old.1" },
    });
    await expect(
      prisma.message.create({
        data: { accountId: "marhaba", chatId: "c1", remoteJid: "37411000001@c.us", whatsappMessageId: "wamid.old.1" },
      })
    ).rejects.toMatchObject({ code: "P2002" });
  });
});

describe("W6a additive tables on the pushed populated database", () => {
  // Test-only hashes, built at run time (never real tokens).
  const hashA = String("a".repeat(64));
  const hashB = String("b".repeat(64));
  const subjectHash = String("c".repeat(64));
  const ipHash = String("d".repeat(64));

  it("creates PasswordResetToken with a unique tokenHash and an index on userId", async () => {
    // userId is a plain string without a foreign key: a row referencing a
    // user id that does not exist in this fixture must still insert.
    await prisma.$executeRawUnsafe(
      `INSERT INTO "PasswordResetToken" ("id","userId","tokenHash","expiresAt","usedAt","createdAt")
       VALUES ('prt1','u-missing','${hashA}',datetime('now','+30 minutes'),NULL,datetime('now'))`
    );
    // tokenHash is unique: a second row with the same hash is rejected.
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "PasswordResetToken" ("id","userId","tokenHash","expiresAt","usedAt","createdAt")
         VALUES ('prt2','u1','${hashA}',datetime('now','+30 minutes'),NULL,datetime('now'))`
      )
    ).rejects.toThrow();
    // userId is indexed, not unique: one user may hold several tokens.
    await prisma.$executeRawUnsafe(
      `INSERT INTO "PasswordResetToken" ("id","userId","tokenHash","expiresAt","usedAt","createdAt")
       VALUES ('prt3','u1','${hashB}',datetime('now','+30 minutes'),NULL,datetime('now'))`
    );

    const indexes = await prisma.$queryRawUnsafe<{ name: string }[]>(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'PasswordResetToken' AND name NOT LIKE 'sqlite_autoindex_%'`
    );
    expect(indexes.map((i) => i.name).sort()).toEqual([
      "PasswordResetToken_tokenHash_key",
      "PasswordResetToken_userId_idx",
    ]);
  });

  it("creates SecurityRequest with a (kind, createdAt) index and no foreign keys", async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "SecurityRequest" ("id","kind","subjectHash","ipHash","createdAt")
       VALUES ('sr1','PASSWORD_RESET_REQUEST','${subjectHash}','${ipHash}',datetime('now'))`
    );

    const foreignKeys = await prisma.$queryRawUnsafe<unknown[]>(
      `PRAGMA foreign_key_list('SecurityRequest')`
    );
    expect(foreignKeys).toHaveLength(0);

    const indexes = await prisma.$queryRawUnsafe<{ name: string }[]>(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'SecurityRequest' AND name NOT LIKE 'sqlite_autoindex_%'`
    );
    expect(indexes.map((i) => i.name)).toEqual(["SecurityRequest_kind_createdAt_idx"]);
  });
});
