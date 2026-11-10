/**
 * D3 (owner, B2B cycle 1): internal calculations (cost, supplier rates,
 * margins, markups, trace rows, INTERNAL documents) are server-enforced by the
 * dedicated keys `travel.internal.view` / `travel.internal.download`.
 *
 *  - ADMIN holds both by preset.
 *  - A VALIDATOR holds them by preset too, but only for a request they are
 *    ACTIVELY assigned to; being a validator alone opens nothing.
 *  - Any other role needs an explicit admin grant (UserPermission override),
 *    on top of the route's own owner/assignee scoping.
 *  - PARTNER can never hold them (PARTNER_CEILING in lib/permissions.ts).
 *
 * This is the only record-level check used by the request detail, calculate,
 * submit and document routes.
 */

import { prisma } from "@/lib/prisma";
import { hasPermission, type PermissionKey } from "@/lib/permissions";
import { ROLE_PARTNER, ROLE_VALIDATOR } from "@/lib/travel/contracts";

type Actor = { id: string; role: string; permissions?: ReadonlySet<PermissionKey> | undefined } | null | undefined;

async function scoped(actor: Actor, requestId: string, key: PermissionKey): Promise<boolean> {
  if (!actor || actor.role === ROLE_PARTNER) return false;
  if (!hasPermission(actor, key)) return false;
  if (actor.role !== ROLE_VALIDATOR) return true;
  const assignment = await prisma.validationAssignment.findFirst({
    where: { requestId, validatorId: actor.id, active: true },
    select: { id: true },
  });
  return assignment !== null;
}

/** May this actor see internal costing for this request? */
export const canViewInternalFor = (actor: Actor, requestId: string) => scoped(actor, requestId, "travel.internal.view");

/** May this actor download INTERNAL documents of this request? */
export const canDownloadInternalFor = (actor: Actor, requestId: string) => scoped(actor, requestId, "travel.internal.download");
