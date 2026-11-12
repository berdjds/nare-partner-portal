/**
 * Structured template content (v0.11.0).
 *
 * TemplateVersion.daysJson day services were plain label strings at import
 * time; they are upgraded to catalog-linked entries `{ serviceProductId,
 * label, quantity?, vehicleTypeId? }` — legacy strings remain valid and
 * normalize exactly like ItineraryDay.services (see normalizeDayServices).
 * `quantity` flows into the linked ServiceLine.quantity at instantiate (the
 * day-linked sync in saveVersionContent).
 *
 * TemplateVersion.scenariosJson holds default hotel scenarios with RELATIVE
 * dates: checkInOffset/nights against the request startDate, resolved to
 * absolute checkIn/checkOut at instantiate time.
 */

import { z } from "zod";
import { ruleSchema } from "@/lib/travel/template-rules";

export const templateDayServiceSchema = z.preprocess(
  (value) => (typeof value === "string" ? { label: value } : value),
  z.object({
    serviceProductId: z.string().min(1).nullish(),
    label: z.string().min(1).max(200),
    quantity: z.number().int().min(1).nullish(),
    vehicleTypeId: z.string().min(1).nullish(),
    /** Phase 2: optional, strict rule (traveller categories, group limits, departure weekdays). Absent = today's behaviour. */
    rule: ruleSchema.nullish(),
  }),
);
export type TemplateDayService = z.infer<typeof templateDayServiceSchema>;

export const templateDaySchema = z.object({
  dayOffset: z.number().int().min(0),
  narrative: z.string().max(4000).nullish(),
  overnightCity: z.string().max(200).nullish(),
  services: z.array(templateDayServiceSchema).nullish(),
});
export type TemplateDay = z.infer<typeof templateDaySchema>;

export const templateDaysSchema = z.array(templateDaySchema).max(60);

/** Slim room allocation for templates; capacity fields are filled from the linked hotel product at instantiate time. */
export const templateAllocationSchema = z.object({
  roomType: z.string().min(1).max(200),
  rooms: z.number().int().min(1),
  adults: z.number().int().min(0),
  children: z.number().int().min(0),
  infants: z.number().int().min(0),
  extraBeds: z.number().int().min(0),
});
export type TemplateAllocation = z.infer<typeof templateAllocationSchema>;

export const templateStaySchema = z.object({
  hotelProductId: z.string().min(1).nullish(),
  /** Display-name fallback for stays without a catalog hotel. */
  hotelName: z.string().max(200).nullish(),
  city: z.string().max(200).nullish(),
  board: z.string().max(200).nullish(),
  /** Days after the request startDate (0 = arrival day). */
  checkInOffset: z.number().int().min(0),
  nights: z.number().int().min(1),
  allocations: z.array(templateAllocationSchema).min(1),
});
export type TemplateStay = z.infer<typeof templateStaySchema>;

export const templateScenarioSchema = z.object({
  key: z.string().max(200).optional(),
  label: z.string().min(1).max(200),
  stays: z.array(templateStaySchema).min(1).max(20),
});
export type TemplateScenario = z.infer<typeof templateScenarioSchema>;

export const templateScenariosSchema = z.array(templateScenarioSchema).max(10);

/**
 * nights/days recomputed when template content is edited: scenarios are
 * authoritative for nights (hotel coverage); otherwise the day rows set the
 * trip length (the last row is the departure day, matching the workbook
 * import convention where 5 rows = 4 nights / 5 days).
 */
export function templateLength(days?: TemplateDay[], scenarios?: TemplateScenario[] | null): {
  nights: number;
  dayCount: number;
} {
  if (scenarios && scenarios.length > 0) {
    const nights = Math.max(...scenarios.flatMap((s) => s.stays.map((st) => st.checkInOffset + st.nights)));
    return { nights, dayCount: days?.length ?? nights + 1 };
  }
  const dayCount = days?.length ?? 0;
  return { nights: Math.max(0, dayCount - 1), dayCount };
}
