/**
 * Partner application reference generation: PA-YYYY-NNNN (e.g. PA-2026-0001).
 *
 * The sequence is per calendar year and derived from the existing
 * PartnerApplication rows — there is deliberately no counter table: the W5b
 * data model is fixed at the two additive models (PartnerApplication,
 * PartnerDocument), and the unique index on `reference` is the real guard.
 * Callers create the application row with the value returned here and retry
 * on a P2002 unique-violation (the same race pattern as
 * lib/travel/codes.ts), so concurrent submissions can never collide.
 * The NNNN padding is a minimum; sequences beyond 9999 simply grow
 * (String(seq) is not truncated).
 *
 * Pass a transaction client when the create runs inside a transaction so the
 * read sees the transaction's own writes.
 */

export const PARTNER_REFERENCE_PATTERN = /^PA-\d{4}-\d{4,}$/;

const MIN_REFERENCE_SEQ_PADDING = 4;

/** The slice of PrismaClient (or its transaction client) this module needs. */
export interface PartnerReferenceReader {
  partnerApplication: {
    findMany(args: {
      where: { reference: { startsWith: string } };
      select: { reference: true };
    }): Promise<{ reference: string }[]>;
  };
}

/**
 * Returns the next free reference for the given year (default: the current
 * UTC year). The value is only a proposal until the row insert succeeds —
 * concurrent callers can compute the same proposal, and exactly one of their
 * inserts wins the unique index.
 */
export async function nextPartnerReference(
  db: PartnerReferenceReader,
  year: number = new Date().getUTCFullYear(),
): Promise<string> {
  const prefix = `PA-${year}-`;
  const rows = await db.partnerApplication.findMany({
    where: { reference: { startsWith: prefix } },
    select: { reference: true },
  });
  let maxSeq = 0;
  for (const row of rows) {
    const seq = parseInt(row.reference.slice(prefix.length), 10);
    if (!Number.isNaN(seq) && seq > maxSeq) maxSeq = seq;
  }
  return `${prefix}${String(maxSeq + 1).padStart(MIN_REFERENCE_SEQ_PADDING, "0")}`;
}

export interface ParsedPartnerReference {
  year: number;
  seq: number;
}

/** Parses a partner reference; returns null when the format does not match. */
export function parsePartnerReference(reference: string): ParsedPartnerReference | null {
  if (!PARTNER_REFERENCE_PATTERN.test(reference)) return null;
  const [, year, seq] = reference.split("-");
  return { year: parseInt(year, 10), seq: parseInt(seq, 10) };
}
