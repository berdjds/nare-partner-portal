import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { templateDaysSchema, templateLength, templateScenariosSchema } from "@/lib/travel/templates";
import { writeAuditLog } from "@/lib/audit";
import { getTravelActor, travelError, unauthorized } from "../../../../guard";

const updateTemplateVersionSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  days: templateDaysSchema.optional(),
  /** null clears the default scenarios; omitted leaves them untouched. */
  scenarios: templateScenariosSchema.nullish(),
});

// Template content editing (v0.11.0): ADMIN only, because template changes
// silently affect every future instantiate. nights/days are derived from the
// content (templateLength) so the request-dialog picker stays accurate.
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; versionId: string }> },
) {
  const { id, versionId } = await params;
  const actor = await getTravelActor();
  if (!actor) return unauthorized();
  if (actor.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const parsed = updateTemplateVersionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors }, { status: 400 });
  }

  try {
    const version = await prisma.templateVersion.findUnique({
      where: { id: versionId },
      include: { template: true },
    });
    if (!version || version.templateId !== id) {
      return NextResponse.json({ error: "Template version not found" }, { status: 404 });
    }

    const { name, days, scenarios } = parsed.data;
    if (name !== undefined && name !== version.template.name) {
      await prisma.packageTemplate.update({ where: { id: version.templateId }, data: { name } });
    }

    if (days !== undefined || scenarios !== undefined) {
      // Derive length from the freshest content: the new value when supplied,
      // otherwise the stored one (legacy rows always have daysJson).
      const nextDays =
        days ?? templateDaysSchema.parse(JSON.parse(version.daysJson));
      const nextScenarios =
        scenarios !== undefined
          ? scenarios
          : version.scenariosJson
            ? templateScenariosSchema.parse(JSON.parse(version.scenariosJson))
            : null;
      const { nights, dayCount } = templateLength(nextDays, nextScenarios);
      await prisma.templateVersion.update({
        where: { id: version.id },
        data: {
          ...(days !== undefined ? { daysJson: JSON.stringify(days) } : {}),
          ...(scenarios !== undefined
            ? { scenariosJson: scenarios === null ? null : JSON.stringify(scenarios) }
            : {}),
          nights,
          days: dayCount,
        },
      });
    }

    await writeAuditLog(
      "TEMPLATE_VERSION_UPDATED",
      actor.id,
      `Updated template ${version.template.code} v${version.versionNo}`,
    );

    const updated = await prisma.templateVersion.findUnique({ where: { id: version.id } });
    return NextResponse.json(updated);
  } catch (err) {
    return travelError(err, "[API /travel/templates/[id]/versions/[versionId]]");
  }
}
