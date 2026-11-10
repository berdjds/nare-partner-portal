/**
 * Client-safe projection for PARTNER accounts (allow-list, never strip-list).
 *
 * Built from a purpose-made narrow query that never loads costing, supplier
 * rates, margins, internal notes, workflow, assignments or staff identities,
 * so there is nothing to leak by omission. Prices are shown only for versions
 * that have an ISSUED CLIENT quotation document.
 */

import { prisma } from "@/lib/prisma";
import { redactScenarioResultJson } from "@/lib/travel/redact";

export async function partnerRequestList(agencyId: string, filter: { q?: string; status?: string }) {
  const rows = await prisma.travelRequest.findMany({
    where: {
      agencyId,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.q ? { OR: [{ packageCode: { contains: filter.q } }, { title: { contains: filter.q } }] } : {}),
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true, packageCode: true, title: true, startDate: true, endDate: true, status: true, createdAt: true,
      agency: { select: { id: true, shortCode: true, name: true } },
    },
  });
  return rows;
}

/** Returns null when the request does not exist or belongs to another agency (callers answer 404). */
export async function partnerRequestDetail(agencyId: string, requestId: string) {
  const request = await prisma.travelRequest.findFirst({
    where: { id: requestId, agencyId },
    select: {
      id: true, packageCode: true, agencyRef: true, title: true, destinations: true, startDate: true, endDate: true,
      travelers: true, status: true, createdAt: true,
      agency: { select: { id: true, shortCode: true, name: true } },
      versions: {
        orderBy: { versionNo: "asc" },
        select: {
          id: true, versionNo: true, status: true, validUntil: true,
          documents: { where: { kind: "CLIENT", issuedAt: { not: null } }, select: { id: true, issuedAt: true } },
          itineraryDays: { orderBy: { dayOffset: "asc" }, select: { dayOffset: true, date: true, narrative: true, overnightCity: true } },
          scenarios: { select: { label: true, resultJson: true } },
        },
      },
    },
  });
  if (!request) return null;
  return {
    ...request,
    versions: request.versions.map((v) => {
      const issued = v.documents.length > 0;
      return {
        id: v.id,
        versionNo: v.versionNo,
        status: v.status,
        validUntil: v.validUntil,
        documents: v.documents,
        itineraryDays: issued ? v.itineraryDays : [],
        // sell-side fields only (ref, label, sell, perPayingPerson, validity, nights/days); issues are dropped.
        scenarios: issued
          ? v.scenarios.map((s) => {
              const r = JSON.parse(redactScenarioResultJson(s.resultJson) ?? "{}");
              return { label: s.label, nights: r.nights, days: r.days, sell: r.sell, perPayingPerson: r.perPayingPerson };
            })
          : [],
      };
    }),
  };
}
