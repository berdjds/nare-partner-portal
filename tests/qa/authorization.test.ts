/**
 * QA: route-level authorization (item 14). Sessions are mocked per test via a
 * hoisted mutable; routes run against the seeded throwaway DB, so these test
 * the server — not hidden buttons.
 *
 * - USER role: 401 on requests/settings/rates (and every other travel route)
 *   unless they hold an active validation assignment AND the matching
 *   permission grants (W2: the assignment path also requires travel.access /
 *   travel.review / travel.internal.download — see the last describe block).
 * - ADVISOR: 403 on PUT settings and PATCH rates (ADMIN-only); may POST requests.
 * - VALIDATOR: 403 creating requests; 403 issuing (not owner/admin).
 * - Non-current validator: 403 NOT_ASSIGNED_VALIDATOR on review.
 * - INTERNAL documents (D2): 403 for ADVISOR; 403 for VALIDATOR without an
 *   explicit travel.internal.download grant; 200 for a granted VALIDATOR and
 *   for ADMIN (the key is in the ADMIN preset only).
 * - ADVISOR list scope: sees only own requests.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";
import { ensureSchema, getPrisma } from "../travel-db/helpers";
import { actorOf, createRequestInput, saveContent, scenarioContent, seedFixtures, type Fixtures } from "../workflow/fixtures";

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
let advisor2: { id: string; role: string; name: string | null; email: string };

let requestsRoute: typeof import("@/app/api/travel/requests/route");
let requestByIdRoute: typeof import("@/app/api/travel/requests/[id]/route");
let assignableRoute: typeof import("@/app/api/travel/users/assignable/route");
let settingsRoute: typeof import("@/app/api/travel/settings/route");
let ratesRoute: typeof import("@/app/api/travel/catalog/rates/route");
let rateByIdRoute: typeof import("@/app/api/travel/catalog/rates/[id]/route");
let documentsRoute: typeof import("@/app/api/travel/documents/[id]/route");
let documentSendRoute: typeof import("@/app/api/travel/documents/[id]/send/route");
let issueRoute: typeof import("@/app/api/travel/versions/[id]/issue/route");
let reviewRoute: typeof import("@/app/api/travel/versions/[id]/review/route");

function session(user: { id: string; role: string; email: string; name: string | null } | null) {
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

beforeAll(async () => {
  ensureSchema();
  prisma = await getPrisma();
  workflow = await import("@/lib/travel/workflow");
  fx = await seedFixtures(prisma);
  advisor2 = await prisma.user.create({
    data: { email: "advisor2@test.io", name: "Advisor Two", password: "x", role: "ADVISOR" },
  });
  // W3 (travel-nare): the travel account ships disabled; enable it so CLIENT
  // document sends reach the mocked sender. Disabled-account behavior is
  // covered in tests/whatsapp/travel-send.test.ts.
  const { ensureDefaultAccounts } = await import("@/lib/whatsapp-accounts");
  await ensureDefaultAccounts();
  await prisma.whatsAppAccount.update({ where: { key: "nare" }, data: { enabled: true } });

  requestsRoute = await import("@/app/api/travel/requests/route");
  requestByIdRoute = await import("@/app/api/travel/requests/[id]/route");
  assignableRoute = await import("@/app/api/travel/users/assignable/route");
  settingsRoute = await import("@/app/api/travel/settings/route");
  ratesRoute = await import("@/app/api/travel/catalog/rates/route");
  rateByIdRoute = await import("@/app/api/travel/catalog/rates/[id]/route");
  documentsRoute = await import("@/app/api/travel/documents/[id]/route");
  documentSendRoute = await import("@/app/api/travel/documents/[id]/send/route");
  issueRoute = await import("@/app/api/travel/versions/[id]/issue/route");
  reviewRoute = await import("@/app/api/travel/versions/[id]/review/route");
});

beforeEach(() => session(null));

describe("USER role is rejected everywhere (401)", () => {
  it("GET requests / settings / rates all return 401 for USER and anonymous", async () => {
    for (const who of [fx.plainUser, null]) {
      session(who);
      expect((await requestsRoute.GET(req("http://t/api/travel/requests"))).status).toBe(401);
      expect((await settingsRoute.GET()).status).toBe(401);
      expect((await ratesRoute.GET(req("http://t/api/travel/catalog/rates"))).status).toBe(401);
    }
  });
});

describe("ADMIN-only mutations", () => {
  it("ADVISOR and VALIDATOR cannot PUT settings", async () => {
    for (const who of [fx.advisor, fx.validator]) {
      session(who);
      const res = await settingsRoute.PUT(req("http://t/api/travel/settings", { method: "PUT", body: { overdueReminderHours: 2 } }));
      expect(res.status).toBe(403);
    }
    session(fx.admin);
    const ok = await settingsRoute.PUT(req("http://t/api/travel/settings", { method: "PUT", body: { overdueReminderHours: 2 } }));
    expect(ok.status).toBe(200);
  });

  it("ADVISOR and VALIDATOR cannot PATCH rates", async () => {
    const rate = await prisma.rateVersion.findFirst({ where: { status: "VERIFIED" } });
    for (const who of [fx.advisor, fx.validator]) {
      session(who);
      const res = await rateByIdRoute.PATCH(req(`http://t/api/travel/catalog/rates/${rate!.id}`, { method: "PATCH", body: { notes: "x" } }), { params: Promise.resolve({ id: rate!.id }) });
      expect(res.status).toBe(403);
    }
    session(fx.admin);
    const ok = await rateByIdRoute.PATCH(req(`http://t/api/travel/catalog/rates/${rate!.id}`, { method: "PATCH", body: { notes: "reviewed" } }), { params: Promise.resolve({ id: rate!.id }) });
    expect(ok.status).toBe(200);
  });
});

describe("request creation and workflow actions", () => {
  it("VALIDATOR cannot create requests; ADVISOR can", async () => {
    session(fx.validator);
    const denied = await requestsRoute.POST(req("http://t/api/travel/requests", { method: "POST", body: createRequestInput(fx.agency.id) }));
    expect(denied.status).toBe(403);

    session(fx.advisor);
    const allowed = await requestsRoute.POST(req("http://t/api/travel/requests", { method: "POST", body: createRequestInput(fx.agency.id) }));
    expect(allowed.status).toBe(201);
  });

  it("VALIDATOR cannot issue (not owner, not admin): 403 FORBIDDEN", async () => {
    const { request, version } = await workflow.createRequest(actorOf(fx.advisor), createRequestInput(fx.agency.id));
    await saveContent(prisma, actorOf(fx.advisor), request.id, version.id, scenarioContent(fx.hotel.id, fx.hotel.name));
    await workflow.assignValidator(actorOf(fx.advisor), request.id, { validatorId: fx.validator.id });
    const { hash } = await workflow.submit(actorOf(fx.advisor), request.id);
    await workflow.review(actorOf(fx.validator), version.id, { action: "APPROVE", snapshotHash: hash });

    session(fx.validator);
    const res = await issueRoute.POST(req(`http://t/api/travel/versions/${version.id}/issue`, { method: "POST", body: {} }), { params: Promise.resolve({ id: version.id }) });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
  });

  it("a non-current validator cannot review: 403 NOT_ASSIGNED_VALIDATOR", async () => {
    const { request, version } = await workflow.createRequest(actorOf(fx.advisor), createRequestInput(fx.agency.id));
    await saveContent(prisma, actorOf(fx.advisor), request.id, version.id, scenarioContent(fx.hotel.id, fx.hotel.name));
    await workflow.assignValidator(actorOf(fx.advisor), request.id, { validatorId: fx.validator.id });
    const { hash } = await workflow.submit(actorOf(fx.advisor), request.id);

    session(fx.validator2); // a validator, but not the assigned one
    const res = await reviewRoute.POST(
      req(`http://t/api/travel/versions/${version.id}/review`, { method: "POST", body: { action: "APPROVE", snapshotHash: hash } }),
      { params: Promise.resolve({ id: version.id }) },
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("NOT_ASSIGNED_VALIDATOR");

    // The assigned validator succeeds through the same route.
    session(fx.validator);
    const ok = await reviewRoute.POST(
      req(`http://t/api/travel/versions/${version.id}/review`, { method: "POST", body: { action: "APPROVE", snapshotHash: hash } }),
      { params: Promise.resolve({ id: version.id }) },
    );
    expect(ok.status).toBe(200);
  });
});

describe("document kind authorization", () => {
  it("INTERNAL requires travel.internal.download (D2): 403 for ADVISOR and ungranted VALIDATOR, 200 for granted VALIDATOR/ADMIN; CLIENT allows any travel role", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "qa-docs-"));
    const file = path.join(dir, "doc.pdf");
    writeFileSync(file, "%PDF-1.4 qa");

    const { version } = await workflow.createRequest(actorOf(fx.advisor), createRequestInput(fx.agency.id));
    const mkDoc = (kind: string, key: string) =>
      prisma.quoteDocument.create({
        data: {
          versionId: version.id,
          snapshotHash: "0".repeat(64),
          kind,
          templateVersion: "1",
          filePath: file,
          sha256: "abc",
          idempotencyKey: key,
        },
      });
    const internal = await mkDoc("INTERNAL", "qa-internal");
    const client = await mkDoc("CLIENT", "qa-client");

    session(fx.advisor);
    expect((await documentsRoute.GET(req(`http://t/api/travel/documents/${internal.id}`), { params: Promise.resolve({ id: internal.id }) })).status).toBe(403);
    const clientRes = await documentsRoute.GET(req(`http://t/api/travel/documents/${client.id}`), { params: Promise.resolve({ id: client.id }) });
    expect(clientRes.status).toBe(200);
    expect(clientRes.headers.get("Content-Type")).toBe("application/pdf");

    // D2: travel.internal.download is in the ADMIN preset only, so a plain
    // VALIDATOR (no grant) is now refused INTERNAL downloads.
    session(fx.validator);
    expect((await documentsRoute.GET(req(`http://t/api/travel/documents/${internal.id}`), { params: Promise.resolve({ id: internal.id }) })).status).toBe(403);

    // ...but an explicit grant re-opens them for a VALIDATOR.
    const grantedValidator = await prisma.user.create({
      data: {
        email: "validator-granted@test.io",
        name: "Granted Validator",
        password: "x",
        role: "VALIDATOR",
        permissions: { create: [{ key: "travel.internal.download", allowed: true }] },
      },
    });
    session(grantedValidator);
    expect((await documentsRoute.GET(req(`http://t/api/travel/documents/${internal.id}`), { params: Promise.resolve({ id: internal.id }) })).status).toBe(200);

    session(fx.admin);
    expect((await documentsRoute.GET(req(`http://t/api/travel/documents/${internal.id}`), { params: Promise.resolve({ id: internal.id }) })).status).toBe(200);

    // USER role never reaches the kind check.
    session(fx.plainUser);
    expect((await documentsRoute.GET(req(`http://t/api/travel/documents/${client.id}`), { params: Promise.resolve({ id: client.id }) })).status).toBe(401);
  });
});

describe("advisor list scoping", () => {
  it("an advisor sees only their own requests; validators/admins see all", async () => {
    await workflow.createRequest(actorOf(fx.advisor), createRequestInput(fx.agency.id));
    await workflow.createRequest(actorOf(advisor2 as any), createRequestInput(fx.agency.id));

    session(fx.advisor);
    const mine = await (await requestsRoute.GET(req("http://t/api/travel/requests"))).json();
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((r: any) => r.owner.id === fx.advisor.id)).toBe(true);

    session(fx.validator);
    const all = await (await requestsRoute.GET(req("http://t/api/travel/requests"))).json();
    const ownerIds = new Set(all.map((r: any) => r.owner.id));
    expect(ownerIds.has(fx.advisor.id)).toBe(true);
    expect(ownerIds.has(advisor2.id)).toBe(true);
  });
});

// These tests run last: fx.plainUser gains an active assignment here, and the
// "USER role is rejected everywhere" block above depends on them having none.
describe("assigned USER-role validator (v0.10.0)", () => {
  it("any active user is assignable via /api/travel/users/assignable", async () => {
    session(fx.advisor);
    const res = await assignableRoute.GET();
    expect(res.status).toBe(200);
    const users = await res.json();
    expect(users.some((u: any) => u.id === fx.plainUser.id)).toBe(true);
    // Anonymous callers get 401.
    session(null);
    expect((await assignableRoute.GET()).status).toBe(401);
  });

  it("module access opens with an assignment plus grants; lists and details are scoped", async () => {
    const { request, version } = await workflow.createRequest(actorOf(fx.advisor), createRequestInput(fx.agency.id));
    await saveContent(prisma, actorOf(fx.advisor), request.id, version.id, scenarioContent(fx.hotel.id, fx.hotel.name));
    await workflow.assignValidator(actorOf(fx.advisor), request.id, { validatorId: fx.plainUser.id });
    const { hash } = await workflow.submit(actorOf(fx.advisor), request.id);

    // W2: an assignment alone no longer opens the module — travel.access is
    // required on top of the assignment.
    session(fx.plainUser);
    expect((await requestsRoute.GET(req("http://t/api/travel/requests"))).status).toBe(401);

    // W2: assignment + admin grants unlock; the assignment stays a runtime
    // record-level check on top of the permissions.
    for (const key of ["travel.access", "travel.internal.download", "travel.review"]) {
      await prisma.userPermission.create({ data: { userId: fx.plainUser.id, key, allowed: true } });
    }

    const list = await (await requestsRoute.GET(req("http://t/api/travel/requests"))).json();
    expect(list.map((r: any) => r.id)).toEqual([request.id]);

    // Detail opens for the assigned request...
    const own = await requestByIdRoute.GET(req(`http://t/api/travel/requests/${request.id}`), { params: Promise.resolve({ id: request.id }) });
    expect(own.status).toBe(200);

    // ...and the travel.internal.download grant unlocks the INTERNAL document
    // download (submit rendered one; a USER role without the grant would be
    // forbidden — D2).
    const internalDoc = await prisma.quoteDocument.findUnique({
      where: { idempotencyKey: `internal-${version.id}` },
    });
    expect(internalDoc).toBeTruthy();
    const dl = await documentsRoute.GET(req(`http://t/api/travel/documents/${internalDoc!.id}`), {
      params: Promise.resolve({ id: internalDoc!.id }),
    });
    expect(dl.status).toBe(200);

    // ...but existence of unrelated requests is not disclosed.
    const other = await workflow.createRequest(actorOf(advisor2 as any), createRequestInput(fx.agency.id));
    const denied = await requestByIdRoute.GET(req(`http://t/api/travel/requests/${other.request.id}`), {
      params: Promise.resolve({ id: other.request.id }),
    });
    expect(denied.status).toBe(404);

    // Review through the route works with role USER plus the travel.review grant.
    const ok = await reviewRoute.POST(
      req(`http://t/api/travel/versions/${version.id}/review`, {
        method: "POST",
        body: { action: "APPROVE", snapshotHash: hash },
      }),
      { params: Promise.resolve({ id: version.id }) },
    );
    expect(ok.status).toBe(200);
  });

  it("a USER with no assignment still gets 401", async () => {
    const stranger = await prisma.user.create({
      data: { email: "stranger@test.io", name: "Stranger", password: "x", role: "USER" },
    });
    session(stranger);
    expect((await requestsRoute.GET(req("http://t/api/travel/requests"))).status).toBe(401);
  });
});

describe("WhatsApp document delivery (v0.10.0)", () => {
  it("sends CLIENT per recipient; INTERNAL is rejected for every actor (int-lock)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "qa-send-"));
    const file = path.join(dir, "doc.pdf");
    writeFileSync(file, "%PDF-1.4 qa");

    const { request, version } = await workflow.createRequest(actorOf(fx.advisor), createRequestInput(fx.agency.id));
    await workflow.assignValidator(actorOf(fx.advisor), request.id, { validatorId: fx.validator.id });
    const mkDoc = (kind: string, key: string) =>
      prisma.quoteDocument.create({
        data: {
          versionId: version.id,
          snapshotHash: "0".repeat(64),
          kind,
          templateVersion: "1",
          filePath: file,
          sha256: "abc",
          idempotencyKey: key,
        },
      });
    const internal = await mkDoc("INTERNAL", "send-internal");
    const client = await mkDoc("CLIENT", "send-client");
    const recipient = await prisma.user.create({
      data: { email: "recip@test.io", name: "Recip", password: "x", role: "USER", phone: "37400000099" },
    });

    const { sendWhatsAppMessage } = await import("@/lib/whatsapp");
    const waMock = vi.mocked(sendWhatsAppMessage);

    session(fx.advisor); // the request owner may trigger delivery
    const noRecipients = await documentSendRoute.POST(
      req(`http://t/api/travel/documents/${client.id}/send`, { method: "POST", body: {} }),
      { params: Promise.resolve({ id: client.id }) },
    );
    expect(noRecipients.status).toBe(400);

    // int-lock: INTERNAL is rejected for every actor that passes the record
    // rule — owner, ADMIN and the assigned validator alike — and nothing
    // reaches WhatsApp.
    for (const who of [fx.advisor, fx.admin, fx.validator]) {
      waMock.mockClear();
      session(who);
      const res = await documentSendRoute.POST(
        req(`http://t/api/travel/documents/${internal.id}/send`, { method: "POST", body: { userIds: [recipient.id] } }),
        { params: Promise.resolve({ id: internal.id }) },
      );
      expect(res.status).toBe(403);
      expect((await res.json()).error).toContain("INTERNAL");
      expect(waMock).not.toHaveBeenCalled();
    }

    // CLIENT to a plain user still succeeds (mocked WhatsApp sender).
    session(fx.advisor);
    const clientRes = await documentSendRoute.POST(
      req(`http://t/api/travel/documents/${client.id}/send`, { method: "POST", body: { userIds: [recipient.id] } }),
      { params: Promise.resolve({ id: client.id }) },
    );
    const clientResults = (await clientRes.json()).results;
    expect(clientResults[0].ok).toBe(true);

    // A travel user with no relation to the request gets 404 (no disclosure).
    session(fx.validator2);
    const denied = await documentSendRoute.POST(
      req(`http://t/api/travel/documents/${client.id}/send`, { method: "POST", body: { userIds: [recipient.id] } }),
      { params: Promise.resolve({ id: client.id }) },
    );
    expect(denied.status).toBe(404);
    expect(request.id).toBeTruthy();
  });
});

// Last block: mutates TravelSettings (validatorUserIds / infantMaxAge); each
// test restores defaults so no other suite in this file is affected.
describe("validator group + infant settings (v0.11.0)", () => {
  it("validates infantMaxAge and validatorUserIds", async () => {
    session(fx.admin);
    const put = (body: unknown) =>
      settingsRoute.PUT(req("http://t/api/travel/settings", { method: "PUT", body }));

    expect((await put({ infantMaxAge: 13 })).status).toBe(400);
    expect((await put({ infantMaxAge: -1 })).status).toBe(400);
    expect((await put({ validatorUserIds: ["no-such-user"] })).status).toBe(400);
    // Inactive users are rejected as group members.
    await prisma.user.update({ where: { id: fx.validator2.id }, data: { active: false } });
    expect((await put({ validatorUserIds: [fx.validator2.id] })).status).toBe(400);
    await prisma.user.update({ where: { id: fx.validator2.id }, data: { active: true } });

    const ok = await put({ infantMaxAge: 3, validatorUserIds: [fx.validator.id, fx.plainUser.id] });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.infantMaxAge).toBe(3);
    expect(JSON.parse(body.validatorUserIds)).toEqual([fx.validator.id, fx.plainUser.id]);

    // Restore defaults.
    await put({ infantMaxAge: 2, validatorUserIds: [] });
  });

  it("validator-group membership no longer grants INTERNAL delivery (int-lock)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "qa-send-group-"));
    const file = path.join(dir, "doc.pdf");
    writeFileSync(file, "%PDF-1.4 qa");

    const { version } = await workflow.createRequest(actorOf(fx.advisor), createRequestInput(fx.agency.id));
    const internal = await prisma.quoteDocument.create({
      data: {
        versionId: version.id,
        snapshotHash: "0".repeat(64),
        kind: "INTERNAL",
        templateVersion: "1",
        filePath: file,
        sha256: "abc",
        idempotencyKey: "send-group-internal",
      },
    });
    // A USER-role group member: membership used to grant INTERNAL delivery;
    // int-lock removes that — nobody receives an INTERNAL sheet over WhatsApp.
    const member = await prisma.user.create({
      data: { email: "groupmember@test.io", name: "Group Member", password: "x", role: "USER", phone: "37400000098" },
    });
    await prisma.travelSettings.update({
      where: { id: "default" },
      data: { validatorUserIds: JSON.stringify([member.id]) },
    });
    try {
      session(fx.advisor); // request owner triggers the send attempt
      const res = await documentSendRoute.POST(
        req(`http://t/api/travel/documents/${internal.id}/send`, { method: "POST", body: { userIds: [member.id] } }),
        { params: Promise.resolve({ id: internal.id }) },
      );
      expect(res.status).toBe(403);

      // The shared sender refuses too when called directly, so group-targeted
      // code paths cannot bypass the route gate either.
      const { sendQuoteDocument } = await import("@/lib/travel/whatsapp-docs");
      const results = await sendQuoteDocument(internal.id, { userIds: [member.id] }, fx.advisor.id);
      expect(results).toHaveLength(1);
      expect(results[0].ok).toBe(false);
      expect(results[0].error).toContain("INTERNAL");
    } finally {
      await prisma.travelSettings.update({ where: { id: "default" }, data: { validatorUserIds: "[]" } });
    }
  });
});
