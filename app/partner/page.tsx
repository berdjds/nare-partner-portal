import Link from "next/link";
import { getServerSession } from "next-auth/next";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { getActiveUser } from "@/lib/access-policy";
import { hasPermission } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import AppShell from "@/components/app/AppShell";
import { PageHeader } from "@/components/app/PageHeader";
import { partnerRequestList, partnerRequestDetail } from "@/lib/travel/partner-view";

// Agency (PARTNER) landing: the agency's own requests and their issued client
// quotations. Read-only. The data comes from the same allow-list projection as
// the API (lib/travel/partner-view.ts); no costing is ever loaded here.
export default async function PartnerPage() {
  const session = await getServerSession(authOptions);
  const user = await getActiveUser(session);
  if (!user) redirect("/login");
  if (user.role !== "PARTNER") redirect("/");
  // Same rules as the API guard: an admin deny of travel.access locks the page too.
  if (!hasPermission(user, "travel.access")) redirect("/login");
  const canDownload = hasPermission(user, "travel.client_docs.download");
  const agency = user.agencyId
    ? await prisma.agency.findFirst({ where: { id: user.agencyId, active: true }, select: { id: true, name: true } })
    : null;
  if (!agency) redirect("/login");

  const requests = await partnerRequestList(agency.id, {});
  const details = await Promise.all(requests.map((r) => partnerRequestDetail(agency.id, r.id)));

  return (
    <AppShell>
      <PageHeader title="My quotations" subtitle={`Requests and issued quotations for ${agency.name}.`} />
      {requests.length === 0 ? (
        <p className="rounded-xl border bg-card p-6 text-sm text-muted-foreground">No requests yet.</p>
      ) : (
        <ul className="space-y-3">
          {requests.map((r, i) => {
            const docs = (details[i]?.versions ?? []).flatMap((v) => v.documents.map((d) => ({ ...d, versionNo: v.versionNo })));
            return (
              <li key={r.id} className="rounded-xl border bg-card p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="text-base font-semibold">{r.title}</h2>
                  <span className="text-xs text-muted-foreground">{r.packageCode}</span>
                </div>
                <p className="text-sm text-muted-foreground">{r.startDate} to {r.endDate} · {r.status.replaceAll("_", " ").toLowerCase()}</p>
                {canDownload && docs.length > 0 ? (
                  <ul className="mt-2 flex flex-wrap gap-2">
                    {docs.map((d) => (
                      <li key={d.id}>
                        <Link className="inline-flex min-h-11 items-center rounded-lg border px-3 text-sm underline" href={`/api/travel/documents/${d.id}`} prefetch={false}>
                          Quotation v{d.versionNo} (PDF)
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-sm text-muted-foreground">Quotation not issued yet.</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </AppShell>
  );
}
