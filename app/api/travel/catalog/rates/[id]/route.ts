import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { getTravelActor, travelError, unauthorized } from "../../../guard";
import {
  currencyField,
  dateField,
  moneyField,
  toAmount,
  toWeekdaysJson,
  validityOrdered,
  weekdaysField,
} from "../../schemas";

// Rates are archived, never deleted: they are the evidence trail for
// historical snapshots. Allowed transitions: NEEDS_REVIEW → VERIFIED →
// ARCHIVED (and VERIFIED → ARCHIVED). Amount/currency/validity edits are
// corrections and do not change the status; an amount edit on a VERIFIED
// rate is logged distinctly as RATE_AMOUNT_EDITED.
const patchRateSchema = z.object({
  status: z.enum(["NEEDS_REVIEW", "VERIFIED", "ARCHIVED"]).optional(),
  amount: moneyField,
  currency: currencyField.optional(),
  validFrom: dateField,
  validTo: dateField,
  priority: z.number().int().optional(),
  minStay: z.number().int().positive().nullish(),
  weekdays: weekdaysField,
  notes: z.string().trim().nullish(),
});

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  NEEDS_REVIEW: ["VERIFIED", "ARCHIVED"],
  VERIFIED: ["ARCHIVED"],
  ARCHIVED: [],
};

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getTravelActor();
  if (!actor) return unauthorized();
  if (actor.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const parsed = patchRateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors }, { status: 400 });
  }

  try {
    const rate = await prisma.rateVersion.findUnique({ where: { id: id } });
    if (!rate) return NextResponse.json({ error: "Not found" }, { status: 404 });

    if (parsed.data.status && parsed.data.status !== rate.status) {
      if (!ALLOWED_TRANSITIONS[rate.status]?.includes(parsed.data.status)) {
        return NextResponse.json(
          { error: `rate status cannot move ${rate.status} → ${parsed.data.status}` },
          { status: 400 },
        );
      }
    }

    const nextAmount = toAmount(parsed.data.amount);
    const nextValidFrom = parsed.data.validFrom !== undefined ? parsed.data.validFrom : rate.validFrom;
    const nextValidTo = parsed.data.validTo !== undefined ? parsed.data.validTo : rate.validTo;
    if (!validityOrdered(nextValidFrom, nextValidTo)) {
      return NextResponse.json({ error: "validFrom must be before validTo" }, { status: 400 });
    }

    const nextWeekdays = toWeekdaysJson(parsed.data.weekdays);
    const amountEdited = nextAmount !== undefined && nextAmount !== rate.amount;

    const updated = await prisma.rateVersion.update({
      where: { id: id },
      data: {
        ...(parsed.data.status ? { status: parsed.data.status } : {}),
        ...(nextAmount !== undefined ? { amount: nextAmount } : {}),
        ...(parsed.data.currency ? { currency: parsed.data.currency } : {}),
        ...(parsed.data.validFrom !== undefined ? { validFrom: parsed.data.validFrom } : {}),
        ...(parsed.data.validTo !== undefined ? { validTo: parsed.data.validTo } : {}),
        ...(parsed.data.priority !== undefined ? { priority: parsed.data.priority } : {}),
        ...(parsed.data.minStay !== undefined ? { minStay: parsed.data.minStay } : {}),
        ...(nextWeekdays !== undefined ? { weekdays: nextWeekdays } : {}),
        ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes || null } : {}),
      },
    });

    if (parsed.data.status && parsed.data.status !== rate.status) {
      await writeAuditLog("RATE_UPDATED", actor.id, `Rate ${id}: ${rate.status} → ${updated.status}`);
    }
    if (amountEdited && rate.status === "VERIFIED") {
      // Correcting a verified rate is allowed, but it must stand out in the
      // audit trail because verified rates feed historical snapshots.
      await writeAuditLog(
        "RATE_AMOUNT_EDITED",
        actor.id,
        `Rate ${id}: amount ${rate.amount ?? "TBC"} → ${updated.amount ?? "TBC"} ${updated.currency} (was VERIFIED)`,
      );
    } else if (amountEdited) {
      await writeAuditLog(
        "RATE_UPDATED",
        actor.id,
        `Rate ${id}: amount ${rate.amount ?? "TBC"} → ${updated.amount ?? "TBC"} ${updated.currency}`,
      );
    }
    return NextResponse.json(updated);
  } catch (err) {
    return travelError(err, "[API /travel/catalog/rates/[id]]");
  }
}
