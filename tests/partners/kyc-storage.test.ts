/**
 * KYC document storage (lib/partners/kyc-storage.ts): magic-byte-validated
 * file persistence for partner KYC uploads.
 *
 * - Type detection is by MAGIC BYTES ONLY (PDF "%PDF-", JPG FF D8 FF, PNG
 *   89 50 4E 47 0D 0A 1A 0A). There is deliberately no client-supplied mime
 *   parameter anywhere in the API — a browser-declared Content-Type can lie,
 *   so the bytes decide. The file extension must agree with the detected
 *   kind (pdf→.pdf; jpg→.jpg/.jpeg; png→.png; case-insensitive).
 * - saveKycFile writes <baseDir>/<applicationId>/<32 hex chars>.<ext>; the
 *   sanitised original name is kept only as metadata, never in the stored
 *   file name. Stored files never land under public/.
 * - Size limit: > KYC_MAX_FILE_BYTES rejected (FILE_TOO_LARGE), exactly
 *   KYC_MAX_FILE_BYTES accepted. Count limit: KYC_MAX_FILES_PER_APPLICATION
 *   per application (existingCount override, else files already on disk).
 * - Disguised executables (ELF/MZ bytes named *.pdf) are rejected with
 *   UNSUPPORTED_TYPE and nothing is written. Extension lies are rejected
 *   with EXTENSION_MISMATCH.
 * - Path traversal is defused at two levels: originalName is reduced to a
 *   basename (POSIX and Windows separators), and applicationId must match
 *   /^[A-Za-z0-9_-]{1,64}$/ (INVALID_APPLICATION_ID otherwise).
 * - openKycReadStream refuses paths escaping baseDir (INVALID_STORAGE_PATH)
 *   and streams bytes identical to what was stored (sha256 round-trip).
 * - discardKycFiles is the transaction-failure cleanup path: it unlinks the
 *   listed paths, tolerates missing ones, and never throws.
 * - deleteKycDocuments removes the application directory recursively and
 *   deletes the DB rows via the injected KycDocumentRowDeleter (stubbed here
 *   with a recording fake — no real database), tolerating a missing
 *   directory on repeat calls.
 *
 * The suite is hermetic: every call gets an explicit baseDir inside a fresh
 * os.tmpdir() directory, applicationIds are unique per test, and nothing
 * touches the real data/ directory, prisma, or the network.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  KYC_BASE_DIR,
  KYC_MAX_FILE_BYTES,
  KYC_MAX_FILES_PER_APPLICATION,
  KycStorageError,
  deleteKycDocuments,
  detectKycFileType,
  discardKycFiles,
  openKycReadStream,
  sanitizeOriginalName,
  saveKycFile,
  type KycDocumentRowDeleter,
  type StoredKycFile,
} from "@/lib/partners/kyc-storage";

let baseDir: string;

beforeAll(async () => {
  baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), "kyc-storage-test-"));
});

afterAll(async () => {
  await fsp.rm(baseDir, { recursive: true, force: true });
});

function newApplicationId(): string {
  return `app-${crypto.randomUUID()}`;
}

function validPdf(): Buffer {
  return Buffer.concat([
    Buffer.from("%PDF-1.7\n"),
    Buffer.from("1 0 obj << /Type /Catalog >> endobj\n%%EOF\n"),
  ]);
}

function validPng(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]),
  ]);
}

function validJpg(): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
}

function fakeExecutableElf(): Buffer {
  return Buffer.concat([Buffer.from([0x7f]), Buffer.from("ELF"), Buffer.alloc(32, 0x01)]);
}

function fakeExecutableMz(): Buffer {
  return Buffer.concat([Buffer.from("MZ"), Buffer.alloc(32, 0x00)]);
}

function sha256Hex(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function expectKycRejection(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
  await promise.catch((e: unknown) => {
    expect(e).toBeInstanceOf(KycStorageError);
  });
}

describe("module constants", () => {
  it("pins the documented limits and default base dir", () => {
    expect(KYC_MAX_FILE_BYTES).toBe(10 * 1024 * 1024);
    expect(KYC_MAX_FILES_PER_APPLICATION).toBe(3);
    expect(typeof KYC_BASE_DIR).toBe("string");
    expect(KYC_BASE_DIR.length).toBeGreaterThan(0);
  });
});

describe("detectKycFileType", () => {
  it("detects PDF, JPG and PNG by magic bytes with matching extensions", () => {
    expect(detectKycFileType(validPdf(), "licence.pdf")).toEqual({
      kind: "pdf",
      mime: "application/pdf",
      extension: ".pdf",
    });
    expect(detectKycFileType(validJpg(), "photo.jpg")).toEqual({
      kind: "jpg",
      mime: "image/jpeg",
      extension: ".jpg",
    });
    expect(detectKycFileType(validPng(), "logo.png")).toEqual({
      kind: "png",
      mime: "image/png",
      extension: ".png",
    });
  });

  it("accepts .jpeg for JPG bytes and case-insensitive extensions", () => {
    expect(detectKycFileType(validJpg(), "photo.jpeg").extension).toBe(".jpg");
    expect(detectKycFileType(validPdf(), "SCAN.PDF").kind).toBe("pdf");
    expect(detectKycFileType(validPng(), "Logo.PNG").kind).toBe("png");
  });

  it("rejects unsupported content regardless of the file name", () => {
    expect(() => detectKycFileType(fakeExecutableElf(), "licence.pdf")).toThrow(KycStorageError);
    expect(() => detectKycFileType(fakeExecutableMz(), "licence.pdf")).toThrow(KycStorageError);
    try {
      detectKycFileType(fakeExecutableElf(), "licence.pdf");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(KycStorageError);
      expect((e as KycStorageError).code).toBe("UNSUPPORTED_TYPE");
    }
  });

  it("rejects an extension that contradicts the detected kind", () => {
    try {
      detectKycFileType(validPdf(), "scan.png");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(KycStorageError);
      expect((e as KycStorageError).code).toBe("EXTENSION_MISMATCH");
    }
  });
});

describe("sanitizeOriginalName", () => {
  it("reduces POSIX and Windows paths to a basename", () => {
    expect(sanitizeOriginalName("../../evil.pdf")).toBe("evil.pdf");
    expect(sanitizeOriginalName("..\\..\\evil.pdf")).toBe("evil.pdf");
    expect(sanitizeOriginalName("a/b/c.pdf")).toBe("c.pdf");
  });

  it("keeps plain names and falls back to \"file\" for empty input", () => {
    expect(sanitizeOriginalName("passport scan.pdf")).toBe("passport scan.pdf");
    expect(sanitizeOriginalName("")).toBe("file");
  });
});

describe("saveKycFile", () => {
  function assertStoredFile(
    stored: StoredKycFile,
    applicationId: string,
    data: Buffer,
    mime: string,
    extension: string,
  ) {
    expect(stored.mime).toBe(mime);
    expect(stored.size).toBe(data.length);
    expect(stored.sha256).toBe(sha256Hex(data));
    expect(stored.fileName).toMatch(/^[0-9a-f]{32}\.(pdf|jpg|png)$/);
    expect(stored.fileName.endsWith(extension)).toBe(true);
    expect(path.dirname(stored.storagePath)).toBe(path.join(baseDir, applicationId));
    expect(stored.storagePath.startsWith(baseDir + path.sep)).toBe(true);
    expect(stored.storagePath.startsWith(path.resolve("public") + path.sep)).toBe(false);
  }

  it("stores a real PDF with correct metadata and a random file name", async () => {
    const applicationId = newApplicationId();
    const data = validPdf();
    const stored = await saveKycFile({
      applicationId,
      originalName: "trade licence.pdf",
      data,
      baseDir,
    });

    assertStoredFile(stored, applicationId, data, "application/pdf", ".pdf");
    expect(stored.originalName).toBe("trade licence.pdf");
    expect(stored.fileName).not.toContain("trade licence");
    expect(await pathExists(stored.storagePath)).toBe(true);
    expect(await fsp.readFile(stored.storagePath)).toEqual(data);
  });

  it("stores a real JPG and a real PNG", async () => {
    const applicationId = newApplicationId();
    const jpg = validJpg();
    const png = validPng();

    const storedJpg = await saveKycFile({
      applicationId,
      originalName: "office.jpg",
      data: jpg,
      baseDir,
    });
    assertStoredFile(storedJpg, applicationId, jpg, "image/jpeg", ".jpg");

    const storedPng = await saveKycFile({
      applicationId,
      originalName: "logo.png",
      data: png,
      baseDir,
    });
    assertStoredFile(storedPng, applicationId, png, "image/png", ".png");
    expect(storedJpg.fileName).not.toBe(storedPng.fileName);
  });

  it("normalises a \".jpeg\" name to extension \".jpg\" / mime image/jpeg", async () => {
    const applicationId = newApplicationId();
    const stored = await saveKycFile({
      applicationId,
      originalName: "signboard.jpeg",
      data: validJpg(),
      baseDir,
    });
    expect(stored.mime).toBe("image/jpeg");
    expect(stored.fileName).toMatch(/^[0-9a-f]{32}\.jpg$/);
  });

  it("rejects a disguised ELF or MZ executable named *.pdf with UNSUPPORTED_TYPE and writes nothing", async () => {
    for (const data of [fakeExecutableElf(), fakeExecutableMz()]) {
      const applicationId = newApplicationId();
      await expectKycRejection(
        saveKycFile({ applicationId, originalName: "licence.pdf", data, baseDir }),
        "UNSUPPORTED_TYPE",
      );
      const appDir = path.join(baseDir, applicationId);
      if (await pathExists(appDir)) {
        expect(await fsp.readdir(appDir)).toEqual([]);
      }
    }
  });

  it("rejects PDF bytes named *.png and a valid PNG with no extension as EXTENSION_MISMATCH", async () => {
    const applicationId = newApplicationId();
    await expectKycRejection(
      saveKycFile({ applicationId, originalName: "scan.png", data: validPdf(), baseDir }),
      "EXTENSION_MISMATCH",
    );
    await expectKycRejection(
      saveKycFile({ applicationId, originalName: "scan", data: validPng(), baseDir }),
      "EXTENSION_MISMATCH",
    );
  });

  it("rejects a file one byte over the limit and accepts one exactly at the limit", async () => {
    const overLimit = Buffer.alloc(KYC_MAX_FILE_BYTES + 1);
    Buffer.from("%PDF-1.7\n").copy(overLimit);
    await expectKycRejection(
      saveKycFile({
        applicationId: newApplicationId(),
        originalName: "big.pdf",
        data: overLimit,
        baseDir,
      }),
      "FILE_TOO_LARGE",
    );

    const atLimit = Buffer.alloc(KYC_MAX_FILE_BYTES);
    Buffer.from("%PDF-1.7\n").copy(atLimit);
    const stored = await saveKycFile({
      applicationId: newApplicationId(),
      originalName: "exact.pdf",
      data: atLimit,
      baseDir,
    });
    expect(stored.size).toBe(KYC_MAX_FILE_BYTES);
    expect(await pathExists(stored.storagePath)).toBe(true);
  });

  it("rejects the 4th file for one application with TOO_MANY_FILES", async () => {
    const applicationId = newApplicationId();
    for (let i = 0; i < KYC_MAX_FILES_PER_APPLICATION; i++) {
      await saveKycFile({
        applicationId,
        originalName: `doc-${i}.pdf`,
        data: validPdf(),
        baseDir,
      });
    }
    await expectKycRejection(
      saveKycFile({ applicationId, originalName: "doc-3.pdf", data: validPdf(), baseDir }),
      "TOO_MANY_FILES",
    );
    expect(await fsp.readdir(path.join(baseDir, applicationId))).toHaveLength(
      KYC_MAX_FILES_PER_APPLICATION,
    );
  });

  it("honours the existingCount override: existingCount 3 rejects even the first save", async () => {
    const applicationId = newApplicationId();
    await expectKycRejection(
      saveKycFile({
        applicationId,
        originalName: "first.pdf",
        data: validPdf(),
        existingCount: 3,
        baseDir,
      }),
      "TOO_MANY_FILES",
    );
    expect(await pathExists(path.join(baseDir, applicationId))).toBe(false);
  });

  it("defuses path traversal in originalName: stores under a random name, metadata is the basename", async () => {
    // Dedicated baseDir so we can assert it contains ONLY the application dir.
    const isolatedBase = await fsp.mkdtemp(path.join(os.tmpdir(), "kyc-storage-traversal-"));
    try {
      const applicationId = newApplicationId();
      const stored = await saveKycFile({
        applicationId,
        originalName: "../../evil.pdf",
        data: validPdf(),
        baseDir: isolatedBase,
      });

      expect(stored.originalName).toBe("evil.pdf");
      expect(stored.fileName).toMatch(/^[0-9a-f]{32}\.pdf$/);
      expect(stored.fileName).not.toContain("evil");
      expect(path.dirname(stored.storagePath)).toBe(path.join(isolatedBase, applicationId));
      expect(await fsp.readdir(isolatedBase)).toEqual([applicationId]);
      expect(await pathExists(stored.storagePath)).toBe(true);
    } finally {
      await fsp.rm(isolatedBase, { recursive: true, force: true });
    }
  });

  it("rejects path traversal in applicationId with INVALID_APPLICATION_ID and writes nothing", async () => {
    for (const applicationId of ["../escape", "a/b"]) {
      await expectKycRejection(
        saveKycFile({ applicationId, originalName: "doc.pdf", data: validPdf(), baseDir }),
        "INVALID_APPLICATION_ID",
      );
    }
    expect(await pathExists(path.join(baseDir, "escape"))).toBe(false);
    expect(await pathExists(path.join(baseDir, "a"))).toBe(false);
  });
});

describe("openKycReadStream", () => {
  async function collectStream(stream: fs.ReadStream): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  it("streams back bytes whose sha256 matches the stored digest", async () => {
    const applicationId = newApplicationId();
    const data = validPdf();
    const stored = await saveKycFile({
      applicationId,
      originalName: "statement.pdf",
      data,
      baseDir,
    });

    const streamed = await collectStream(openKycReadStream(stored.storagePath, baseDir));
    expect(sha256Hex(streamed)).toBe(stored.sha256);
    expect(streamed).toEqual(data);
  });

  it("rejects relative and absolute paths escaping baseDir with INVALID_STORAGE_PATH", () => {
    expect(() => openKycReadStream("../outside.pdf", baseDir)).toThrow(KycStorageError);
    expect(() => openKycReadStream(path.join(os.tmpdir(), "outside.pdf"), baseDir)).toThrow(
      KycStorageError,
    );
    try {
      openKycReadStream("../outside.pdf", baseDir);
      expect.unreachable();
    } catch (e) {
      expect((e as KycStorageError).code).toBe("INVALID_STORAGE_PATH");
    }
    try {
      openKycReadStream(path.join(os.tmpdir(), "outside.pdf"), baseDir);
      expect.unreachable();
    } catch (e) {
      expect((e as KycStorageError).code).toBe("INVALID_STORAGE_PATH");
    }
  });
});

describe("discardKycFiles", () => {
  it("unlinks listed files, ignores missing ones and never throws (transaction-failure cleanup)", async () => {
    const applicationId = newApplicationId();
    const first = await saveKycFile({
      applicationId,
      originalName: "one.pdf",
      data: validPdf(),
      baseDir,
    });
    const second = await saveKycFile({
      applicationId,
      originalName: "two.png",
      data: validPng(),
      baseDir,
    });

    // Simulate the surrounding DB transaction failing on a third, invalid upload.
    await expectKycRejection(
      saveKycFile({
        applicationId,
        originalName: "three.pdf",
        data: fakeExecutableElf(),
        baseDir,
      }),
      "UNSUPPORTED_TYPE",
    );

    const nonexistent = path.join(baseDir, applicationId, "0".repeat(32) + ".pdf");
    await expect(
      discardKycFiles([first.storagePath, second.storagePath, nonexistent]),
    ).resolves.toBeUndefined();

    expect(await pathExists(first.storagePath)).toBe(false);
    expect(await pathExists(second.storagePath)).toBe(false);
  });
});

describe("deleteKycDocuments", () => {
  function recordingDeleter(count: number) {
    const calls: { where: { applicationId: string } }[] = [];
    const db: KycDocumentRowDeleter = {
      partnerDocument: {
        async deleteMany(args: { where: { applicationId: string } }) {
          calls.push(args);
          return { count };
        },
      },
    };
    return { db, calls };
  }

  it("removes the application directory and the DB rows, reporting both counts", async () => {
    const applicationId = newApplicationId();
    const first = await saveKycFile({
      applicationId,
      originalName: "licence.pdf",
      data: validPdf(),
      baseDir,
    });
    const second = await saveKycFile({
      applicationId,
      originalName: "photo.jpg",
      data: validJpg(),
      baseDir,
    });
    expect(await pathExists(first.storagePath)).toBe(true);
    expect(await pathExists(second.storagePath)).toBe(true);

    const { db, calls } = recordingDeleter(7);
    const result = await deleteKycDocuments(applicationId, db, baseDir);

    expect(result).toEqual({ deletedFiles: 2, deletedRows: 7 });
    expect(calls).toEqual([{ where: { applicationId } }]);
    expect(await pathExists(path.join(baseDir, applicationId))).toBe(false);
  });

  it("tolerates a missing directory on a repeat call", async () => {
    const applicationId = newApplicationId();
    const { db } = recordingDeleter(7);

    const first = await deleteKycDocuments(applicationId, db, baseDir);
    expect(first).toEqual({ deletedFiles: 0, deletedRows: 7 });

    await expect(deleteKycDocuments(applicationId, db, baseDir)).resolves.toEqual({
      deletedFiles: 0,
      deletedRows: 7,
    });
  });

  it("rejects an invalid applicationId with INVALID_APPLICATION_ID", async () => {
    const { db, calls } = recordingDeleter(0);
    await expectKycRejection(
      deleteKycDocuments("../escape", db, baseDir),
      "INVALID_APPLICATION_ID",
    );
    await expectKycRejection(deleteKycDocuments("a/b", db, baseDir), "INVALID_APPLICATION_ID");
    expect(calls).toEqual([]);
  });
});
