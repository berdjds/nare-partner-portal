import { canViewInternal } from "@/lib/travel/redact";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { getTravelActor, travelError, unauthorized } from "../guard";

// Package templates with their versions (newest first per template).
export async function GET() {
  const actor = await getTravelActor();
  if (!actor) return unauthorized();

  try {
    const templates = await prisma.packageTemplate.findMany({
      orderBy: { code: "asc" },
      include: { versions: { orderBy: { versionNo: "desc" } } },
    });
    // legacyMarkup is an imported margin figure: internal permission only (D3).
    const view = canViewInternal(actor)
      ? templates
      : templates.map((t) => ({ ...t, versions: t.versions.map((v) => ({ ...v, legacyMarkup: null })) }));
    return NextResponse.json(view);
  } catch (err) {
    return travelError(err, "[API /travel/templates]");
  }
}

const createTemplateSchema = z.object({
  code: z
    .string()
    .min(1)
    .max(50)
    .transform((s) => s.trim().toUpperCase()),
  name: z.string().min(1).max(200),
  nights: z.number().int().min(1).max(59),
  /** Day rows; defaults to nights + 1 (arrival … departure). More is allowed — extra free days. */
  days: z.number().int().min(1).max(60).optional(),
});

// Template creation from the UI (v0.12.0 — before, only the workbook import
// created templates). ADMIN only: templates silently affect every future
// instantiate. Version 1 starts as empty day slots; content is edited in the
// template editor.
export async function POST(req: NextRequest) {
  const actor = await getTravelActor();
  if (!actor) return unauthorized();
  if (actor.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const parsed = createTemplateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors }, { status: 400 });
  }

  const { code, name, nights } = parsed.data;
  const dayCount = parsed.data.days ?? nights + 1;
  try {
    const template = await prisma.packageTemplate.create({
      data: {
        code,
        name: name.trim(),
        versions: {
          create: {
            versionNo: 1,
            nights,
            days: dayCount,
            daysJson: JSON.stringify(Array.from({ length: dayCount }, (_, i) => ({ dayOffset: i }))),
            provenance: "Created in template manager",
          },
        },
      },
      include: { versions: { orderBy: { versionNo: "desc" } } },
    });
    await writeAuditLog("TRAVEL_TEMPLATE_CREATED", actor.id, `Created template ${code} "${name.trim()}" (${nights}n/${dayCount}d)`);
    return NextResponse.json(template, { status: 201 });
  } catch (err: any) {
    if (err?.code === "P2002") {
      return NextResponse.json({ error: `Template code ${code} already exists`, code: "DUPLICATE_CODE" }, { status: 409 });
    }
    return travelError(err, "[API /travel/templates POST]");
  }
}
