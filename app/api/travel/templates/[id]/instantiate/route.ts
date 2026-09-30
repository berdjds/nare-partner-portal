import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { addDays } from "@/lib/travel/engine";
import {
  createRequest,
  createRequestSchema,
  saveVersionContent,
  WorkflowError,
} from "@/lib/travel/workflow";
import { templateDaysSchema, templateScenariosSchema } from "@/lib/travel/templates";
import { getTravelActor, travelError, unauthorized } from "../../../guard";

const instantiateSchema = createRequestSchema.extend({
  // The picker pre-fills the title with the template name; when left blank the
  // server falls back to it, so the field is optional here (v0.11.0).
  title: z.string().max(200).optional(),
  templateVersionId: z.string().optional(),
});

// Template content columns are server-written JSON; a corrupted row should
// surface as a client-visible 400, not an opaque 500 from JSON.parse.
// (Generics rather than ZodType<T> because z.preprocess schemas have an
// unknown input type that would poison inference.)
function parseTemplateJson<S extends z.ZodTypeAny>(raw: string, schema: S, label: string): z.output<S> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new WorkflowError("TEMPLATE_CONTENT_INVALID", `${label} is not valid JSON`, 400);
  }
  return schema.parse(value);
}

// Creates a NEW request whose v1 content is copied from a template version.
// Day services may carry catalog links ({serviceProductId, quantity?,
// vehicleTypeId}) — saveVersionContent validates them and turns linked entries
// into priced shared ServiceLines via the day-linked sync. scenariosJson holds
// stays with RELATIVE dates (checkInOffset/nights) resolved against the new
// request startDate here, replacing the skeleton "Option A"/TBD stay.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getTravelActor();
  if (!actor) return unauthorized();
  if (actor.role !== "ADMIN" && actor.role !== "ADVISOR") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const parsed = instantiateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors }, { status: 400 });
  }

  try {
    const template = await prisma.packageTemplate.findUnique({
      where: { id },
      include: { versions: { orderBy: { versionNo: "desc" } } },
    });
    if (!template) return NextResponse.json({ error: "Template not found" }, { status: 404 });

    const templateVersion = parsed.data.templateVersionId
      ? template.versions.find((v) => v.id === parsed.data.templateVersionId)
      : template.versions.find((v) => v.status === "ACTIVE") ?? template.versions[0];
    if (!templateVersion) {
      return NextResponse.json({ error: "Template has no versions" }, { status: 400 });
    }

    const { templateVersionId: _ignored, ...requestData } = parsed.data;
    const title = requestData.title?.trim() || template.name;
    const { request, version } = await createRequest(actor, { ...requestData, title });

    const days = parseTemplateJson(templateVersion.daysJson, templateDaysSchema, "template daysJson");
    const itineraryDays = days.map((d) => ({
      dayOffset: d.dayOffset,
      date: addDays(request.startDate, d.dayOffset),
      narrative: d.narrative ?? null,
      overnightCity: d.overnightCity ?? null,
      services:
        d.services?.map((s) => ({
          serviceProductId: s.serviceProductId ?? null,
          label: s.label,
          quantity: s.quantity ?? null,
          vehicleTypeId: s.vehicleTypeId ?? null,
        })) ?? null,
    }));
    // Freshly created request: revision is 0 (createRequest never bumps it).
    await saveVersionContent(actor, version.id, { expectedRevision: 0, itineraryDays });

    if (templateVersion.scenariosJson) {
      const templateScenarios = parseTemplateJson(
        templateVersion.scenariosJson,
        templateScenariosSchema,
        "template scenariosJson",
      );
      if (templateScenarios.length > 0) {
        const hotelIds = Array.from(
          new Set(
            templateScenarios.flatMap((s) =>
              s.stays.map((st) => st.hotelProductId).filter((id): id is string => !!id),
            ),
          ),
        );
        const hotels = await prisma.hotelProduct.findMany({ where: { id: { in: hotelIds } } });
        const hotelById = new Map(hotels.map((h) => [h.id, h]));
        for (const id of hotelIds) {
          if (!hotelById.has(id)) {
            throw new WorkflowError("TEMPLATE_HOTEL_UNKNOWN", `template references unknown hotel product ${id}`, 400);
          }
        }

        const scenarios = templateScenarios.map((s, si) => ({
          key: s.key ?? `template-${si + 1}`,
          label: s.label,
          stays: s.stays.map((st) => {
            const hotel = st.hotelProductId ? hotelById.get(st.hotelProductId) : null;
            const checkIn = addDays(request.startDate, st.checkInOffset);
            return {
              hotelProductId: hotel?.id ?? null,
              hotelName: hotel?.name ?? st.hotelName ?? "TBD",
              city: st.city ?? hotel?.city ?? null,
              board: st.board ?? null,
              checkIn,
              checkOut: addDays(checkIn, st.nights),
              // Capacity defaults mirror createRequest's skeleton allocation,
              // filled from the linked hotel product when one exists.
              allocations: st.allocations.map((a) => ({
                ...a,
                capacityAdults: hotel?.capacityAdults ?? 2,
                capacityChildren: hotel?.capacityChildren ?? 0,
                capacityTotal: hotel?.capacityTotal ?? 2,
                extraBedAllowed: hotel?.extraBedAllowed ?? false,
                extraBedIncludedInRate: false,
                wholeUnit: hotel?.kind === "COTTAGE_UNIT",
              })),
              rateOverrides: null,
            };
          }),
        }));
        // The itinerary-days save above bumped the revision to 1.
        await saveVersionContent(actor, version.id, { expectedRevision: 1, scenarios });
      }
    }

    await prisma.quoteVersion.update({
      where: { id: version.id },
      data: { templateVersionId: templateVersion.id },
    });

    return NextResponse.json(
      { request, versionId: version.id, templateVersionId: templateVersion.id },
      { status: 201 },
    );
  } catch (err) {
    // travelError maps ZodError (invalid stored template content) to 400.
    return travelError(err, "[API /travel/templates/[id]/instantiate]");
  }
}
