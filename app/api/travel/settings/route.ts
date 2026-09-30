import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { getTravelSettings } from "@/lib/travel/settings";
import { getTravelActor, travelError, unauthorized } from "../guard";

const updateSettingsSchema = z.object({
  companyTz: z.string().min(1).optional(),
  overdueReminderHours: z.number().int().min(1).nullish(),
  escalationUserId: z.string().nullish(),
  requireSettingsForIssue: z.boolean().optional(),
  documentsDir: z.string().min(1).optional(),
  /** Activates this PricingPolicyVersion (deactivating all others). */
  activatePolicyId: z.string().nullish(),
  // Company branding shown on the client quotation PDF (frozen per issue).
  companyName: z.string().max(200).nullish(),
  companyPhone: z.string().max(200).nullish(),
  companyEmail: z.string().max(200).nullish(),
  companyAddress: z.string().max(400).nullish(),
  companyWebsite: z.string().max(200).nullish(),
  brandColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "expected a #rrggbb hex color")
    .nullish(),
  // WhatsApp group receiving quotation documents (....@g.us).
  // Deprecated since v0.11.0 (validatorUserIds replaced it); still accepted so
  // older clients don't break, but nothing reads it anymore.
  validatorGroupJid: z
    .string()
    .regex(/^\d+(-\d+)?@g\.us$/, "expected a WhatsApp group id like 120363...@g.us")
    .nullish(),
  // Children at or below this age (at return) are infants.
  infantMaxAge: z.number().int().min(0).max(12).optional(),
  // Virtual validator group: user ids; membership validated against active
  // users in the handler (zod can't query the DB).
  validatorUserIds: z.array(z.string().min(1)).max(50).optional(),
  // W3 (travel-nare): WhatsAppAccount.key every travel-module WhatsApp send
  // goes through (default 'nare'); validated against existing accounts in the
  // handler.
  whatsappAccountKey: z.string().min(1).optional(),
});

export async function GET() {
  const actor = await getTravelActor();
  if (!actor) return unauthorized();

  try {
    const settings = await getTravelSettings();
    const activePolicy = await prisma.pricingPolicyVersion.findFirst({
      where: { active: true },
    });
    // Non-admin roles (advisors) must not read markup/margin policy — only
    // the currency a quote will be priced in.
    if (actor.role !== "ADMIN") {
      return NextResponse.json({
        settings,
        activePolicy: activePolicy ? { quoteCurrency: activePolicy.quoteCurrency } : null,
      });
    }
    return NextResponse.json({ settings, activePolicy });
  } catch (err) {
    return travelError(err, "[API /travel/settings]");
  }
}

export async function PUT(req: NextRequest) {
  const actor = await getTravelActor();
  if (!actor) return unauthorized();
  if (actor.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const parsed = updateSettingsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors }, { status: 400 });
  }

  try {
    const { activatePolicyId, validatorUserIds, ...restPatch } = parsed.data;

    // The validator group is stored as a JSON array string; every member must
    // be an active user.
    const settingsPatch: typeof restPatch & { validatorUserIds?: string } = { ...restPatch };
    if (validatorUserIds !== undefined) {
      const active = await prisma.user.findMany({
        where: { id: { in: validatorUserIds }, active: true },
        select: { id: true },
      });
      if (active.length !== new Set(validatorUserIds).size) {
        return NextResponse.json(
          { error: "validatorUserIds must reference active users only" },
          { status: 400 },
        );
      }
      settingsPatch.validatorUserIds = JSON.stringify(Array.from(new Set(validatorUserIds)));
    }

    // The travel WhatsApp account must reference an existing account row;
    // account rows are managed via /api/whatsapp/accounts, not created here.
    if (restPatch.whatsappAccountKey !== undefined) {
      const account = await prisma.whatsAppAccount.findUnique({
        where: { key: restPatch.whatsappAccountKey },
      });
      if (!account) {
        return NextResponse.json(
          { error: `unknown WhatsApp account key: ${restPatch.whatsappAccountKey}` },
          { status: 400 },
        );
      }
    }

    if (activatePolicyId) {
      const policy = await prisma.pricingPolicyVersion.findUnique({
        where: { id: activatePolicyId },
      });
      if (!policy) {
        return NextResponse.json({ error: "Policy version not found" }, { status: 404 });
      }
      // Exactly one active policy: deactivate all, then activate the target.
      await prisma.$transaction([
        prisma.pricingPolicyVersion.updateMany({ where: { active: true }, data: { active: false } }),
        prisma.pricingPolicyVersion.update({ where: { id: activatePolicyId }, data: { active: true } }),
        prisma.travelSettings.update({
          where: { id: "default" },
          data: { defaultPolicyId: activatePolicyId },
        }),
      ]);
      await writeAuditLog("TRAVEL_POLICY_ACTIVATED", actor.id, `Activated policy ${policy.name} (${policy.id})`);
    }

    let settings = await getTravelSettings();
    if (Object.keys(settingsPatch).length > 0) {
      settings = await prisma.travelSettings.update({
        where: { id: "default" },
        data: settingsPatch,
      });
      await writeAuditLog("TRAVEL_SETTINGS_UPDATED", actor.id, JSON.stringify(settingsPatch));
    }

    return NextResponse.json(settings);
  } catch (err) {
    return travelError(err, "[API /travel/settings]");
  }
}
