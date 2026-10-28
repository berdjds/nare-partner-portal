import { writeAuditLog } from "@/lib/audit";
import { deleteKycDocuments, type KycDocumentRowDeleter } from "./kyc-storage";

export const RETENTION_DAYS = 90;

export interface ExpiredPartnerApplication {
  id: string;
  reference: string;
}

/** The slice of PrismaClient (or its transaction client) this module needs. */
export interface RetentionDb extends KycDocumentRowDeleter {
  partnerApplication: {
    findMany(args: {
      where: {
        status: string;
        reviewedAt: { lte: Date };
        documents: { some: Record<string, never> };
      };
      select: { id: true; reference: true };
    }): Promise<ExpiredPartnerApplication[]>;
  };
}

export interface RetentionSweepDeps {
  deleteDocuments?: typeof deleteKycDocuments;
}

export async function selectExpiredApplications(
  db: RetentionDb,
  now: Date = new Date(),
): Promise<ExpiredPartnerApplication[]> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  return db.partnerApplication.findMany({
    where: {
      status: "REJECTED",
      reviewedAt: { lte: cutoff },
      documents: { some: {} },
    },
    select: { id: true, reference: true },
  });
}

export async function runRetentionSweep(
  db: RetentionDb,
  now: Date = new Date(),
  deps: RetentionSweepDeps = {},
): Promise<number> {
  const applications = await selectExpiredApplications(db, now);
  const deleteDocuments = deps.deleteDocuments ?? deleteKycDocuments;
  let cleaned = 0;

  for (const application of applications) {
    try {
      const { deletedFiles, deletedRows } = await deleteDocuments(application.id, db);
      await writeAuditLog(
        "PARTNER_DOCUMENTS_EXPIRED",
        null,
        `${application.reference} (${deletedFiles} file(s), ${deletedRows} row(s))`,
      );
      cleaned += 1;
    } catch (error) {
      console.error("[partners/retention] cleanup failed:", (error as Error)?.message ?? error);
    }
  }

  return cleaned;
}
