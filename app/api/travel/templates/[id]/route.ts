import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { getTravelActor, travelError, unauthorized } from "../../guard";

// Hard delete of a template and all its versions (v0.12.0). Safe for requests:
// instantiation snapshots content into the request (QuoteVersion keeps only an
// informational templateVersionId string, no FK). BatchRun rows also reference
// the version by plain string — they stay as history. Versions are deleted
// explicitly rather than relying on the schema's onDelete: Cascade so the
// endpoint behaves the same on databases whose FKs predate the cascade
// annotation.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getTravelActor();
  if (!actor) return unauthorized();
  if (actor.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const template = await prisma.packageTemplate.findUnique({
      where: { id: id },
      include: { versions: { select: { id: true } } },
    });
    if (!template) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    await writeAuditLog(
      "TRAVEL_TEMPLATE_DELETED",
      actor.id,
      `Deleted template ${template.code} "${template.name}" (${template.versions.length} version(s))`,
    );

    await prisma.$transaction([
      prisma.templateVersion.deleteMany({ where: { templateId: template.id } }),
      prisma.packageTemplate.delete({ where: { id: template.id } }),
    ]);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return travelError(err, "[API /travel/templates/[id] DELETE]");
  }
}
