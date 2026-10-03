/**
 * W2 (perm-travel): permission enforcement pins for the travel module.
 *
 * Every gated travel surface checks the EFFECTIVE permission set (role preset
 * + UserPermission grants − denies, deny wins) on top of the pre-W2 role and
 * record rules — a permission can only narrow, never widen:
 *
 * - Guard (getTravelActor): no effective travel.access → 401, even with an
 *   active validation assignment.
 * - Workflow: createRequest/createRevision need travel.create, review needs
 *   travel.review (before the assigned-validator rule), issue needs
 *   travel.issue (after owner-or-admin); all throw WorkflowError 403 FORBIDDEN.
 * - Documents: CLIENT download/send need travel.client_docs.download /
 *   travel.client_docs.send; INTERNAL download needs travel.internal.download
 *   (D2: admin-only preset, non-admins need an explicit grant).
 *
 * Users that need an override get a DEDICATED user row with UserPermission
 * rows created inline, so denies never leak into other cases sharing the DB.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";
import { ensureSchema, getPrisma } from "../travel-db/helpers";
import { actorOf, createRequestInput, saveContent, scenarioContent, seedFixtures, type Fixtures } from "../workflow/fixtures";
import { effectivePermissions, presetForRole } from "@/lib/permissions";
import { sendWhatsAppMessage } from "@/lib/whatsapp";

const { sessionRef } = vi.hoisted(() => ({ sessionRef: { current: null as any } }));
vi.mock("next-auth/next", () => ({
  getServerSession: vi.fn(async () => sessionRef.current),
}));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ providerId: "smtp-test" })) }));
vi.mock("@/lib/whatsapp", () => ({
  sendWhatsAppMessage: vi.fn(async () => ({ id: { _serialized: "wa-test" } })),
}));
vi.mock("@/lib/travel/pdf/render", () => ({
  renderQuotationPdf: vi.fn(async () => Buffer.from("%PDF-1.4 fake")),
}));

let prisma: PrismaClient;
let workflow: typeof import("@/lib/travel/workflow");
let fx: Fixtures;

let requestsRoute: typeof import("@/app/api/travel/requests/route");
let documentsRoute: typeof import("@/app/api/travel/documents/[id]/route");
let documentSendRoute: typeof import("@/app/api/travel/documents/[id]/send/route");
let issueRoute: typeof import("@/app/api/travel/versions/[id]/issue/route");
let reviewRoute: typeof import("@/app/api/travel/versions/[id]/review/route");

const sendMock = vi.mocked(sendWhatsAppMessage);

type Userish = { id: string; role: string; name: string | null; email: string };

function session(user: Userish | null) {
  sessionRef.current = user
    ? { user: { id: user.id, role: user.role, email: user.email, name: user.name }, expires: "2099-01-01" }
    : null;
}

function req(url: string, init?: { method?: string; body?: unknown }) {
  return new NextRequest(url, {
    method: init?.method ?? "GET",
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

const getRequests = () => requestsRoute.GET(req("http://t/api/travel/requests"));
const getDoc = (id: string) =>
  documentsRoute.GET(req(`http://t/api/travel/documents/${id}`), { params: Promise.resolve({ id }) });
const postReview = (versionId: string, hash: string) =>
  reviewRoute.POST(
    req(`http://t/api/travel/versions/${versionId}/review`, { method: "POST", body: { action: "APPROVE", snapshotHash: hash } }),
    { params: Promise.resolve({ id: versionId }) },
  );
const postIssue = (versionId: string) =>
  issueRoute.POST(req(`http://t/api/travel/versions/${versionId}/issue`, { method: "POST", body: {} }), {
    params: Promise.resolve({ id: versionId }),
  });
const postSend = (docId: string, userIds: string[]) =>
  documentSendRoute.POST(req(`http://t/api/travel/documents/${docId}/send`, { method: "POST", body: { userIds } }), {
    params: Promise.resolve({ id: docId }),
  });

/** A user with per-user overrides (UserPermission rows), unique email per call site. */
function createUser(role: string, email: string, overrides: { key: string; allowed: boolean }[] = []) {
  return prisma.user.create({
    data: { email, name: email, password: "x", role, permissions: { create: overrides } },
  });
}

/** DRAFT → content → assign → submit; returns the snapshot hash for review. */
async function submittedRequest(owner: Userish, validatorId: string) {
  const { request, version } = await workflow.createRequest(actorOf(owner), createRequestInput(fx.agency.id));
  await saveContent(prisma, actorOf(owner), request.id, version.id, scenarioContent(fx.hotel.id, fx.hotel.name));
  await workflow.assignValidator(actorOf(owner), request.id, { validatorId });
  const { hash } = await workflow.submit(actorOf(owner), request.id);
  return { request, version, hash };
}

/** A request driven to APPROVED: submitted and approved by fx.validator. */
async function approvedRequest(owner: Userish) {
  const r = await submittedRequest(owner, fx.validator.id);
  await workflow.review(actorOf(fx.validator), r.version.id, { action: "APPROVE", snapshotHash: r.hash });
  return r;
}

function mkDoc(versionId: string, kind: string, key: string, file: string) {
  return prisma.quoteDocument.create({
    data: {
      versionId,
      snapshotHash: "0".repeat(64),
      kind,
      templateVersion: "1",
      filePath: file,
      sha256: "abc",
      idempotencyKey: key,
    },
  });
}

function tmpPdf(tag: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `perm-${tag}-`));
  const file = path.join(dir, "doc.pdf");
  writeFileSync(file, "%PDF-1.4 perm");
  return file;
}

beforeAll(async () => {
  ensureSchema();
  prisma = await getPrisma();
  workflow = await import("@/lib/travel/workflow");
  fx = await seedFixtures(prisma);
  // W3 (travel-nare): the travel account ships disabled; enable it so CLIENT
  // document sends reach the mocked sender. Disabled-account behavior is
  // covered in tests/whatsapp/travel-send.test.ts.
  const { ensureDefaultAccounts } = await import("@/lib/whatsapp-accounts");
  await ensureDefaultAccounts();
  await prisma.whatsAppAccount.update({ where: { key: "nare" }, data: { enabled: true } });

  requestsRoute = await import("@/app/api/travel/requests/route");
  documentsRoute = await import("@/app/api/travel/documents/[id]/route");
  documentSendRoute = await import("@/app/api/travel/documents/[id]/send/route");
  issueRoute = await import("@/app/api/travel/versions/[id]/issue/route");
  reviewRoute = await import("@/app/api/travel/versions/[id]/review/route");
});

beforeEach(() => session(null));

describe("module access (guard): effective travel.access gates the whole module", () => {
  it("a travel-only ADVISOR (preset has travel.access but no inbox keys) gets 200", async () => {
    expect(presetForRole("ADVISOR").has("travel.access")).toBe(true);
    expect(presetForRole("ADVISOR").has("whatsapp.inbox.view")).toBe(false);

    session(fx.advisor);
    const res = await getRequests();
    expect(res.status).toBe(200);
  });

  it("an ADVISOR with a deny override on travel.access gets 401", async () => {
    const denied = await createUser("ADVISOR", "noaccess@perm.io", [{ key: "travel.access", allowed: false }]);
    session(denied);
    const res = await getRequests();
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Unauthorized");
  });

  it("a USER with an active assignment but no grant gets 401; a travel.access grant opens the module", async () => {
    const { request } = await workflow.createRequest(actorOf(fx.advisor), createRequestInput(fx.agency.id));
    await workflow.assignValidator(actorOf(fx.advisor), request.id, { validatorId: fx.plainUser.id });

    session(fx.plainUser);
    expect((await getRequests()).status).toBe(401);

    await prisma.userPermission.create({ data: { userId: fx.plainUser.id, key: "travel.access", allowed: true } });
    expect((await getRequests()).status).toBe(200);
  });
});

describe("create: travel.create narrows, never widens", () => {
  it("route: ADVISOR denied travel.create → 403; default ADVISOR → 201; VALIDATOR granted travel.create → still 403", async () => {
    const deniedAdvisor = await createUser("ADVISOR", "nocreate@perm.io", [{ key: "travel.create", allowed: false }]);
    session(deniedAdvisor);
    const denied = await requestsRoute.POST(
      req("http://t/api/travel/requests", { method: "POST", body: createRequestInput(fx.agency.id) }),
    );
    expect(denied.status).toBe(403);
    expect((await denied.json()).code).toBe("FORBIDDEN");

    session(fx.advisor);
    const allowed = await requestsRoute.POST(
      req("http://t/api/travel/requests", { method: "POST", body: createRequestInput(fx.agency.id) }),
    );
    expect(allowed.status).toBe(201);

    const grantedValidator = await createUser("VALIDATOR", "grantedcreate@perm.io", [{ key: "travel.create", allowed: true }]);
    session(grantedValidator);
    const stillDenied = await requestsRoute.POST(
      req("http://t/api/travel/requests", { method: "POST", body: createRequestInput(fx.agency.id) }),
    );
    expect(stillDenied.status).toBe(403);
  });

  it("workflow: createRequest with travel.create denied rejects with WorkflowError 403", async () => {
    const actor = {
      ...actorOf(fx.advisor),
      permissions: effectivePermissions("ADVISOR", [{ key: "travel.create", allowed: false }]),
    };
    await expect(workflow.createRequest(actor, createRequestInput(fx.agency.id))).rejects.toMatchObject({
      code: "FORBIDDEN",
      httpStatus: 403,
    });
  });
});

describe("review: travel.review is checked before the assigned-validator rule", () => {
  it("the assigned validator with the default preset approves: 200", async () => {
    const { version, hash } = await submittedRequest(fx.advisor, fx.validator.id);
    session(fx.validator);
    const res = await postReview(version.id, hash);
    expect(res.status).toBe(200);
  });

  it("an assigned validator denied travel.review → 403 FORBIDDEN; a non-assigned validator → 403 NOT_ASSIGNED_VALIDATOR", async () => {
    const deniedValidator = await createUser("VALIDATOR", "noreview@perm.io", [{ key: "travel.review", allowed: false }]);
    const { version, hash } = await submittedRequest(fx.advisor, deniedValidator.id);

    session(deniedValidator);
    const denied = await postReview(version.id, hash);
    expect(denied.status).toBe(403);
    expect((await denied.json()).code).toBe("FORBIDDEN");

    // The version is still PENDING_VALIDATION; the record rule still holds.
    session(fx.validator2);
    const notAssigned = await postReview(version.id, hash);
    expect(notAssigned.status).toBe(403);
    expect((await notAssigned.json()).code).toBe("NOT_ASSIGNED_VALIDATOR");
  });
});

describe("issue: travel.issue on top of owner-or-admin", () => {
  it("the owner advisor denied travel.issue gets 403 FORBIDDEN on an APPROVED version", async () => {
    const deniedOwner = await createUser("ADVISOR", "noissue@perm.io", [{ key: "travel.issue", allowed: false }]);
    const { version } = await approvedRequest(deniedOwner);

    session(deniedOwner);
    const res = await postIssue(version.id);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("FORBIDDEN");
  });

  it("the owner advisor with the default preset issues: 200", async () => {
    const { version } = await approvedRequest(fx.advisor);
    session(fx.advisor);
    expect((await postIssue(version.id)).status).toBe(200);
  });

  it("an ADMIN issues someone else's approved version: 200", async () => {
    const { version } = await approvedRequest(fx.advisor);
    session(fx.admin);
    expect((await postIssue(version.id)).status).toBe(200);
  });
});

describe("client document download: travel.client_docs.download", () => {
  it("owner default → 200; owner denied → 403; unrelated advisor → 404; ADMIN → 200", async () => {
    const { version } = await workflow.createRequest(actorOf(fx.advisor), createRequestInput(fx.agency.id));
    const client = await mkDoc(version.id, "CLIENT", "perm-dl-client", tmpPdf("dl"));

    session(fx.advisor);
    const ok = await getDoc(client.id);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Content-Type")).toBe("application/pdf");

    const deniedOwner = await createUser("ADVISOR", "nodownload@perm.io", [
      { key: "travel.client_docs.download", allowed: false },
    ]);
    const ownVersion = await workflow.createRequest(actorOf(deniedOwner), createRequestInput(fx.agency.id));
    const ownDoc = await mkDoc(ownVersion.version.id, "CLIENT", "perm-dl-client-denied", tmpPdf("dl-denied"));
    session(deniedOwner);
    expect((await getDoc(ownDoc.id)).status).toBe(403);

    const stranger = await createUser("ADVISOR", "unrelated@perm.io");
    session(stranger);
    expect((await getDoc(client.id)).status).toBe(404);

    session(fx.admin);
    expect((await getDoc(client.id)).status).toBe(200);
  });
});

describe("client document send: travel.client_docs.send is separate from inbox access", () => {
  it("the owner advisor (no whatsapp.inbox.send) sends a CLIENT document: 200 and WhatsApp delivery attempted", async () => {
    expect(presetForRole("ADVISOR").has("whatsapp.inbox.send")).toBe(false);
    expect(presetForRole("ADVISOR").has("travel.client_docs.send")).toBe(true);

    const { version } = await workflow.createRequest(actorOf(fx.advisor), createRequestInput(fx.agency.id));
    const client = await mkDoc(version.id, "CLIENT", "perm-send-client", tmpPdf("send"));

    sendMock.mockClear();
    session(fx.advisor);
    const res = await postSend(client.id, [fx.validator.id]);
    expect(res.status).toBe(200);
    const { results } = await res.json();
    expect(results[0].ok).toBe(true);
    expect(sendMock).toHaveBeenCalled();
  });

  it("the owner advisor denied travel.client_docs.send gets 403 and nothing is sent", async () => {
    const deniedOwner = await createUser("ADVISOR", "nosend@perm.io", [{ key: "travel.client_docs.send", allowed: false }]);
    const { version } = await workflow.createRequest(actorOf(deniedOwner), createRequestInput(fx.agency.id));
    const client = await mkDoc(version.id, "CLIENT", "perm-send-client-denied", tmpPdf("send-denied"));

    sendMock.mockClear();
    session(deniedOwner);
    const res = await postSend(client.id, [fx.validator.id]);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Forbidden");
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe("internal document download: travel.internal.download is admin-only by default (D2)", () => {
  it("VALIDATOR default → 403; granted → 200; ADVISOR → 403; ADMIN → 200", async () => {
    expect(presetForRole("VALIDATOR").has("travel.internal.download")).toBe(false);

    const { version } = await workflow.createRequest(actorOf(fx.advisor), createRequestInput(fx.agency.id));
    const internal = await mkDoc(version.id, "INTERNAL", "perm-internal", tmpPdf("internal"));

    session(fx.validator);
    expect((await getDoc(internal.id)).status).toBe(403);

    await prisma.userPermission.create({
      data: { userId: fx.validator.id, key: "travel.internal.download", allowed: true },
    });
    session(fx.validator);
    expect((await getDoc(internal.id)).status).toBe(200);

    session(fx.advisor);
    expect((await getDoc(internal.id)).status).toBe(403);

    session(fx.admin);
    expect((await getDoc(internal.id)).status).toBe(200);
  });
});
