import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { getTravelActor, travelError, unauthorized } from "../../../guard";

// Copies a template with its latest version's content (v0.12.0). The copy is a
// fresh template (versionNo restarts at 1) with a -COPY code, incremented when
// taken. The duplicated content is fully editable afterwards — the source is
// never touched.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getTravelActor();
  if (!actor) return unauthorized();
  if (actor.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const source = await prisma.packageTemplate.findUnique({
      where: { id },
      include: { versions: { orderBy: { versionNo: "desc" } } },
    });
    if (!source) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const latest = source.versions[0];

    // First free copy code: CODE-COPY, then CODE-COPY-2, ... The create itself
    // is retried on the unique-code race (P2002) instead of a check-then-act.
    const baseCode = `${source.code}-COPY`;
    let created = null;
    for (let attempt = 0; attempt < 20 && !created; attempt++) {
      const code = attempt === 0 ? baseCode : `${baseCode}-${attempt + 1}`;
      try {
        created = await prisma.packageTemplate.create({
          data: {
            code,
            name: `${source.name} (copy)`,
            versions: latest
              ? {
                  create: {
                    versionNo: 1,
                    nights: latest.nights,
                    days: latest.days,
                    daysJson: latest.daysJson,
                    scenariosJson: latest.scenariosJson,
                    legacyMarkup: latest.legacyMarkup,
                    provenance: `Duplicated from ${source.code} v${latest.versionNo}`,
                  },
                }
              : undefined,
          },
          include: { versions: { orderBy: { versionNo: "desc" } } },
        });
      } catch (err: any) {
        if (err?.code !== "P2002") throw err;
      }
    }
    if (!created) {
      return NextResponse.json({ error: "Could not allocate a copy code" }, { status: 409 });
    }

    await writeAuditLog(
      "TRAVEL_TEMPLATE_DUPLICATED",
      actor.id,
      `Duplicated template ${source.code} → ${created.code} "${created.name}"`,
    );
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    return travelError(err, "[API /travel/templates/[id]/duplicate]");
  }
}
