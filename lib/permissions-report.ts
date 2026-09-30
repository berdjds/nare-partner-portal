/**
 * W2 (D3) persistence for the proposed-permissions migration confirmation.
 *
 * The permission matrix ships with a "proposed-permissions" report (the preset
 * every existing user would receive). Until the owner confirms that report,
 * the internal-cost keys (INTERNAL_PERMISSION_KEYS) stay locked to ADMIN — the
 * D2 interim decision. Because the schema cannot gain a settings table for
 * this one-off flag, the confirmation is recorded as an audit Log row with a
 * dedicated action; its presence is the confirmation. The earliest row wins
 * (a later duplicate, which the API rejects anyway, must not move the
 * confirmed-at timestamp).
 */

import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";

export const PERMISSIONS_MIGRATION_CONFIRMED_ACTION = "PERMISSIONS_MIGRATION_CONFIRMED";

export interface PermissionsMigrationConfirmation {
  userId: string | null;
  email: string | null;
  confirmedAt: Date;
}

/**
 * Returns the earliest confirmation row, or null while the report is still
 * unconfirmed. The email resolves through the user relation, so a deleted
 * admin's confirmation keeps its timestamp but reports email = null (the
 * Log.user relation is onDelete: SetNull, which also nulls userId).
 */
export async function getPermissionsMigrationConfirmation(): Promise<PermissionsMigrationConfirmation | null> {
  const row = await prisma.log.findFirst({
    where: { action: PERMISSIONS_MIGRATION_CONFIRMED_ACTION },
    orderBy: { createdAt: "asc" },
    include: { user: { select: { email: true } } },
  });
  if (!row) return null;
  return { userId: row.userId, email: row.user?.email ?? null, confirmedAt: row.createdAt };
}

/**
 * Records the owner's confirmation of the proposed-permissions report for the
 * given number of users. Goes through writeAuditLog so a stale admin id can
 * never fail the confirm action, and the details carry no credentials.
 */
export async function recordPermissionsMigrationConfirmation(
  adminId: string,
  userCount: number,
): Promise<void> {
  await writeAuditLog(
    PERMISSIONS_MIGRATION_CONFIRMED_ACTION,
    adminId,
    `Confirmed proposed-permissions report for ${userCount} users`,
  );
}
