/**
 * Tests for the W5b partner review UI (staff side): app/admin/partners/page.tsx
 * and app/admin/partners/[id]/page.tsx render inside the shared AppShell with
 * the shared PageHeader, keep the partners.review permission guard that the
 * /api/admin/partners routes enforce, and hand off to the client components
 * components/partners/ReviewQueue.tsx and ReviewDetail.tsx, which talk to the
 * existing review API.
 *
 * These are source-text assertions via readFileSync — the same pattern as
 * tests/ui/admin-shell.test.ts (the suite runs in node, no DOM). The page
 * guards themselves (redirect("/login") without an active user,
 * redirect("/") without partners.review) are pinned here; the API-side 401/403
 * behaviour is covered end-to-end by tests/partners/review-api.test.ts.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

describe("W5b partner review pages", () => {
  it("app/admin/partners/page.tsx wraps the queue in AppShell and guards on partners.review", () => {
    const page = readRepoFile("app/admin/partners/page.tsx");
    expect(page).toContain('import AppShell from "@/components/app/AppShell"');
    expect(page).toContain('import { PageHeader } from "@/components/app/PageHeader"');
    expect(page).toContain("<AppShell>");
    expect(page).toContain("<PageHeader");
    // Guard: no active user -> /login; no partners.review -> / (same gate as
    // requirePartnerReviewer() on the /api/admin/partners routes).
    expect(page).toContain("getActiveUser");
    expect(page).toContain('redirect("/login")');
    expect(page).toContain('hasPermission(user, "partners.review")');
    expect(page).toContain('redirect("/")');
    expect(page).toContain("<ReviewQueue");
    expect(page).toMatch(/breadcrumb=(\{|\[)/);
  });

  it("app/admin/partners/[id]/page.tsx keeps the same guard and passes the id to ReviewDetail", () => {
    const page = readRepoFile("app/admin/partners/[id]/page.tsx");
    expect(page).toContain('import AppShell from "@/components/app/AppShell"');
    expect(page).toContain("<AppShell>");
    expect(page).toContain("<PageHeader");
    expect(page).toContain("getActiveUser");
    expect(page).toContain('redirect("/login")');
    expect(page).toContain('hasPermission(user, "partners.review")');
    expect(page).toContain('redirect("/")');
    // Next 15: params is a Promise; the id reaches the client component.
    expect(page).toContain("await params");
    expect(page).toContain("<ReviewDetail applicationId={id} />");
    // The breadcrumb links back to the queue.
    expect(page).toContain('href: "/admin/partners"');
  });
});

describe("W5b ReviewQueue component", () => {
  it("is a client component that lists applications from the review API with status filter and search", () => {
    const queue = readRepoFile("components/partners/ReviewQueue.tsx");
    expect(queue).toContain('"use client"');
    expect(queue).toContain('axios.get("/api/admin/partners"');
    // Status filter chips cover the four application statuses plus "All".
    for (const status of ["SUBMITTED", "INFO_REQUESTED", "APPROVED", "REJECTED"]) {
      expect(queue).toContain(status);
    }
    expect(queue).toContain("params.status");
    expect(queue).toContain("params.search");
    // Rows link to the detail page and render the status as a Badge.
    expect(queue).toContain("/admin/partners/${a.id}");
    expect(queue).toContain("<Badge");
    expect(queue).toContain("<Label htmlFor=");
  });
});

describe("W5b ReviewDetail component", () => {
  it("loads the detail, downloads documents through the API and records decisions", () => {
    const detail = readRepoFile("components/partners/ReviewDetail.tsx");
    expect(detail).toContain('"use client"');
    expect(detail).toContain("axios.get(`/api/admin/partners/${applicationId}`)");
    // Document downloads go through the authenticated streaming route.
    expect(detail).toContain("/api/admin/partners/${applicationId}/documents/${doc.id}");
    // Decision panel: approve posts the editable short code; reject and
    // request-info share the required note (buttons disabled while blank).
    expect(detail).toContain("axios.post(`/api/admin/partners/${applicationId}/decision`");
    expect(detail).toContain('submitDecision("approve")');
    expect(detail).toContain('submitDecision("reject")');
    expect(detail).toContain('submitDecision("request-info")');
    expect(detail).toContain("!decisionNote.trim()");
    expect(detail).toContain('htmlFor="short-code"');
    expect(detail).toContain('htmlFor="decision-note"');
    // Delete-documents action is confirmed and hits the DELETE route.
    expect(detail).toContain("window.confirm(");
    expect(detail).toContain("axios.delete(`/api/admin/partners/${applicationId}`)");
  });

  it("warns about licence expiry via the sanctioned badge text styles (no raw palette classes)", () => {
    const detail = readRepoFile("components/partners/ReviewDetail.tsx");
    expect(detail).toContain("badgeStatusTextStyles.warning");
    expect(detail).toContain("This licence has expired.");
    expect(detail).toContain("licenceExpiringSoon");
  });

  it("hides the decision form once the application is approved", () => {
    const detail = readRepoFile("components/partners/ReviewDetail.tsx");
    expect(detail).toContain('app.status === "APPROVED"');
    expect(detail).toContain("Approval is final.");
  });
});
