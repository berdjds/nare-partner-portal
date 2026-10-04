/**
 * KYC document storage for partner enrollment (W5b).
 *
 * Companies applying for a B2B partnership upload identity documents (trade
 * licence, owner ID, ...). These files are sensitive personal data, so this
 * module is built around distrust of everything the client sends:
 *
 * - The real file type is decided by MAGIC BYTES of the content, never by
 *   the client-supplied Content-Type, and the original filename's extension
 *   must agree with the detected type. A renamed executable or a polyglot
 *   (e.g. a real PDF named "photo.png") is rejected before it ever touches
 *   disk.
 * - The original filename is kept only as sanitised metadata for display.
 *   The on-disk name is 16 random bytes hex -- the client has zero influence
 *   on the path, so filename traversal ("../../etc/passwd") is impossible.
 * - The application id is validated against a cuid-safe pattern, closing
 *   the remaining traversal vector (the id is the one caller-controlled
 *   path segment).
 * - Files live under `data/kyc/<applicationId>/` (KYC_STORAGE_DIR to
 *   relocate) -- a private directory covered by the backup job -- and NEVER
 *   under public/, where Next.js would serve them unauthenticated. They are
 *   streamed to authorised callers only via openKycReadStream(), which
 *   re-validates containment inside the base directory.
 *
 * Quotas (10 MB per file, 3 files per application) are enforced here as a
 * backstop; the route handler should also enforce them early for a better
 * error message.
 *
 * saveKycFile() writes the file but does NOT touch the database -- the
 * caller persists the PartnerDocument row in its own transaction and calls
 * discardKycFiles() to remove orphaned files if that transaction fails.
 * deleteKycDocuments() does the reverse (full teardown of one application).
 */

import { createHash, randomBytes } from "node:crypto";
import { createReadStream, type ReadStream } from "node:fs";
import { mkdir, readdir, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export const KYC_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const KYC_MAX_FILES_PER_APPLICATION = 3;
export const KYC_BASE_DIR: string = process.env.KYC_STORAGE_DIR ?? "data/kyc";

export type KycFileKind = "pdf" | "jpg" | "png";

export interface KycFileType {
  kind: KycFileKind;
  mime: string;
  extension: string;
}

export type KycErrorCode =
  | "INVALID_APPLICATION_ID"
  | "UNSUPPORTED_TYPE"
  | "EXTENSION_MISMATCH"
  | "FILE_TOO_LARGE"
  | "TOO_MANY_FILES"
  | "INVALID_STORAGE_PATH";

export class KycStorageError extends Error {
  readonly code: KycErrorCode;

  constructor(code: KycErrorCode, message: string) {
    super(message);
    this.name = "KycStorageError";
    this.code = code;
  }
}

/** cuid-safe application ids; also the traversal guard for the id path segment. */
const APPLICATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const MAX_ORIGINAL_NAME_LENGTH = 128;
const RANDOM_NAME_BYTES = 16;

// Magic bytes, checked on content only -- the client-supplied mime type is
// never consulted. PDF: "%PDF-", JPG: SOI + marker, PNG: full 8-byte signature.
const MAGIC_SIGNATURES: { kind: KycFileKind; mime: string; extension: string; bytes: number[] }[] = [
  { kind: "pdf", mime: "application/pdf", extension: ".pdf", bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  { kind: "jpg", mime: "image/jpeg", extension: ".jpg", bytes: [0xff, 0xd8, 0xff] },
  { kind: "png", mime: "image/png", extension: ".png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
];

const EXTENSIONS_BY_KIND: Record<KycFileKind, string[]> = {
  pdf: [".pdf"],
  jpg: [".jpg", ".jpeg"],
  png: [".png"],
};

// Drops C0 controls, DEL and the C1 range from display metadata. Written as a
// code-point loop rather than a regex so the source stays pure ASCII.
function stripNonPrintable(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 32 && (code < 127 || code > 159)) out += ch;
  }
  return out;
}

/**
 * Detects the real file type from the content's magic bytes and requires the
 * original filename's extension to agree with it. Throws UNSUPPORTED_TYPE
 * when the content is not a PDF/JPG/PNG, EXTENSION_MISMATCH when the
 * extension is missing, unknown, or contradicts the detected kind. The
 * returned extension is normalised (".jpeg" becomes ".jpg").
 */
export function detectKycFileType(data: Buffer, originalName: string): KycFileType {
  const signature = MAGIC_SIGNATURES.find((sig) =>
    sig.bytes.every((byte, index) => data.length > index && data[index] === byte),
  );
  if (!signature) {
    throw new KycStorageError(
      "UNSUPPORTED_TYPE",
      "File content is not a PDF, JPG or PNG (magic-byte check failed)",
    );
  }

  const extension = path.extname(originalName).toLowerCase();
  if (!EXTENSIONS_BY_KIND[signature.kind].includes(extension)) {
    throw new KycStorageError(
      "EXTENSION_MISMATCH",
      `File extension "${extension || "(none)"}" does not match the detected ${signature.kind} content`,
    );
  }

  return { kind: signature.kind, mime: signature.mime, extension: signature.extension };
}

/**
 * Reduces a client-supplied filename to safe display metadata: basename only
 * (both POSIX and Windows separators), control/non-printable characters
 * stripped, whitespace collapsed, capped at 128 chars. Never used to build
 * an on-disk path -- the on-disk name is random -- so this only needs to be
 * safe to store and render, not safe to resolve.
 */
export function sanitizeOriginalName(name: string): string {
  const basename = name.split(/[/\\]/).pop() ?? "";
  const cleaned = stripNonPrintable(basename).replace(/\s+/g, " ").trim().slice(0, MAX_ORIGINAL_NAME_LENGTH);
  return cleaned.length > 0 ? cleaned : "file";
}

export interface SaveKycFileInput {
  applicationId: string;
  originalName: string;
  data: Buffer;
  /** Committed-document count from the caller's transaction; when omitted,
   *  the files already present in the application directory are counted. */
  existingCount?: number;
  baseDir?: string;
}

export interface StoredKycFile {
  storagePath: string;
  fileName: string;
  originalName: string;
  mime: string;
  size: number;
  sha256: string;
}

function assertValidApplicationId(applicationId: string): void {
  if (!APPLICATION_ID_PATTERN.test(applicationId)) {
    throw new KycStorageError(
      "INVALID_APPLICATION_ID",
      "applicationId must match /^[A-Za-z0-9_-]{1,64}$/",
    );
  }
}

async function countStoredFiles(applicationDir: string): Promise<number> {
  try {
    return (await readdir(applicationDir)).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

/**
 * Validates and stores one KYC file. Checks run in order: applicationId
 * format, size, content/extension type, per-application count. The file is
 * then written under `<baseDir>/<applicationId>/<random>.<ext>`. Nothing is
 * written to the database; on failure of the surrounding transaction the
 * caller must discardKycFiles() the returned storagePath.
 */
export async function saveKycFile(input: SaveKycFileInput): Promise<StoredKycFile> {
  const baseDir = input.baseDir ?? KYC_BASE_DIR;

  assertValidApplicationId(input.applicationId);

  if (input.data.length > KYC_MAX_FILE_BYTES) {
    throw new KycStorageError(
      "FILE_TOO_LARGE",
      `File is ${input.data.length} bytes; the limit is ${KYC_MAX_FILE_BYTES}`,
    );
  }

  const type = detectKycFileType(input.data, input.originalName);

  const applicationDir = path.join(baseDir, input.applicationId);
  const existingCount = input.existingCount ?? (await countStoredFiles(applicationDir));
  if (existingCount >= KYC_MAX_FILES_PER_APPLICATION) {
    throw new KycStorageError(
      "TOO_MANY_FILES",
      `Application already has ${existingCount} documents; the limit is ${KYC_MAX_FILES_PER_APPLICATION}`,
    );
  }

  const fileName = `${randomBytes(RANDOM_NAME_BYTES).toString("hex")}${type.extension}`;
  const storagePath = path.join(applicationDir, fileName);

  await mkdir(applicationDir, { recursive: true });
  await writeFile(storagePath, input.data);

  return {
    storagePath,
    fileName,
    originalName: sanitizeOriginalName(input.originalName),
    mime: type.mime,
    size: input.data.length,
    sha256: createHash("sha256").update(input.data).digest("hex"),
  };
}

/**
 * Opens a read stream for a stored KYC file. The storage path (relative as
 * produced by saveKycFile, or absolute) is resolved and must stay inside
 * baseDir; anything escaping it (".." traversal, absolute paths elsewhere)
 * is rejected with INVALID_STORAGE_PATH.
 */
export function openKycReadStream(storagePath: string, baseDir: string = KYC_BASE_DIR): ReadStream {
  const resolvedBase = path.resolve(baseDir);
  const resolvedPath = path.resolve(storagePath);
  if (resolvedPath !== resolvedBase && !resolvedPath.startsWith(resolvedBase + path.sep)) {
    throw new KycStorageError(
      "INVALID_STORAGE_PATH",
      "storagePath resolves outside the KYC storage directory",
    );
  }
  return createReadStream(resolvedPath);
}

/**
 * Best-effort removal of stored files; individual failures are swallowed and
 * the function never throws. Used to clean up files that were written before
 * the surrounding database transaction failed, so a quota slot is not lost
 * to an orphaned file.
 */
export async function discardKycFiles(storagePaths: string[]): Promise<void> {
  for (const storagePath of storagePaths) {
    try {
      await unlink(storagePath);
    } catch {
      // Best-effort cleanup: a missing or unremovable file must not mask the
      // original transaction error.
    }
  }
}

/** The slice of PrismaClient (or its transaction client) this module needs. */
export interface KycDocumentRowDeleter {
  partnerDocument: {
    deleteMany(args: { where: { applicationId: string } }): Promise<{ count: number }>;
  };
}

/**
 * Removes all KYC material of one application: the whole storage directory
 * (recursive, absent directory is fine) and the PartnerDocument rows.
 * deletedFiles counts the directory entries present before removal. The
 * Prisma singleton is imported lazily so the module loads without
 * instantiating it.
 */
export async function deleteKycDocuments(
  applicationId: string,
  db?: KycDocumentRowDeleter,
  baseDir: string = KYC_BASE_DIR,
): Promise<{ deletedFiles: number; deletedRows: number }> {
  assertValidApplicationId(applicationId);

  const applicationDir = path.join(baseDir, applicationId);
  const deletedFiles = await countStoredFiles(applicationDir);
  await rm(applicationDir, { recursive: true, force: true });

  const deleter =
    db ??
    ((await import("@/lib/prisma")) as unknown as { prisma: KycDocumentRowDeleter }).prisma;
  const { count } = await deleter.partnerDocument.deleteMany({ where: { applicationId } });

  return { deletedFiles, deletedRows: count };
}
