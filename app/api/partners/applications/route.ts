/**
 * Public partner application endpoint (W5b, no session required).
 *
 * POST /api/partners/applications — multipart form with the company, licence
 * and contact fields plus up to three KYC files (trade licence required,
 * signatory ID and one other document optional).
 *
 * Pipeline, cheapest checks first: honeypot -> signed form token (min fill
 * time) -> zod field validation -> file count/size pre-checks -> per-IP and
 * per-day submission limits (429) -> one transaction that creates the
 * PartnerApplication row (transactional per-year reference, retried on the
 * P2002 race) and the PartnerDocument rows. Files are written inside the
 * transaction callback; if the transaction fails for any reason the written
 * files are discarded so no orphans (or lost quota slots) remain. On success
 * an audit Log entry is written and the applicant + staff emails are sent;
 * email failures never fail the submission.
 *
 * Error contract: every failure that is not a plain field-validation error
 * returns one of a few generic messages. Nothing in a response reveals
 * internals, stack details, or whether a company or email is already known.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import {
  KycStorageError,
  discardKycFiles,
  saveKycFile,
  KYC_MAX_FILE_BYTES,
  type StoredKycFile,
} from "@/lib/partners/kyc-storage";
import { nextPartnerReference } from "@/lib/partners/reference";
import { applicationFieldsSchema, collectApplicationFields } from "@/lib/partners/validation";
import {
  HONEYPOT_FIELD,
  checkSubmissionLimits,
  clientIpFromHeaders,
  hashClientIp,
  verifyFormToken,
} from "@/lib/partners/abuse";
import { sendApplicantConfirmationEmail, sendStaffAlertEmail } from "@/lib/partners/emails";

const LOG_PREFIX = "[API /partners/applications]";

const GENERIC_SUBMISSION_ERROR =
  "Your application could not be submitted. Please check the form and try again.";
const GENERIC_FILE_ERROR = "Files must be PDF, JPG or PNG and at most 10 MB each.";
const LICENCE_REQUIRED_ERROR = "A copy of your trade licence is required.";
const RATE_LIMIT_ERROR = "Too many applications were submitted. Please try again later.";
const INTERNAL_ERROR = "Something went wrong while submitting your application. Please try again later.";

const MAX_REFERENCE_RETRIES = 3;

type DocumentKind = "TRADE_LICENCE" | "SIGNATORY_ID" | "OTHER";

const FILE_FIELDS: { field: string; kind: DocumentKind; required: boolean }[] = [
  { field: "licenceFile", kind: "TRADE_LICENCE", required: true },
  { field: "signatoryIdFile", kind: "SIGNATORY_ID", required: false },
  { field: "otherFile", kind: "OTHER", required: false },
];

interface CollectedUpload {
  kind: DocumentKind;
  name: string;
  size: number;
  data: Buffer;
}

function isPresentFile(value: FormDataEntryValue | null): value is File {
  // Browsers submit an empty File (name "", size 0) for untouched file inputs.
  return typeof File !== "undefined" && value instanceof File && (value.size > 0 || value.name !== "");
}

function isReferenceConflict(error: unknown): boolean {
  const code = (error as { code?: string })?.code;
  if (code !== "P2002") return false;
  const target = (error as { meta?: { target?: unknown } })?.meta?.target;
  const fields = Array.isArray(target) ? target : [String(target ?? "")];
  return fields.some((field) => String(field).includes("reference"));
}

/**
 * Largest request body accepted (3 files of KYC_MAX_FILE_BYTES plus 1 MB of
 * form fields and multipart framing). A declared Content-Length above it is
 * refused BEFORE the body is parsed, so an oversized upload never gets
 * buffered in memory. Browsers always send Content-Length for form posts; a
 * proxy-level body cap is the defence in depth for chunked bodies.
 */
const MAX_REQUEST_BYTES = 3 * KYC_MAX_FILE_BYTES + 1024 * 1024;

export async function POST(req: NextRequest) {
  // Cheap gates that run BEFORE the multipart body is parsed (parsing buffers
  // the whole upload in memory): declared size cap, then the per-IP and daily
  // submission limits. A client that already used its quota is answered 429
  // without any body parsing or file handling.
  const declaredLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    console.log(`${LOG_PREFIX} rejected: declared body of ${declaredLength} bytes exceeds the cap`);
    return NextResponse.json({ error: GENERIC_SUBMISSION_ERROR }, { status: 413 });
  }
  const clientIp = clientIpFromHeaders(req.headers);
  let ipHash: string;
  try {
    ipHash = hashClientIp(clientIp);
  } catch {
    // No signing secret configured: fail closed with the same generic answer
    // as every other pre-validation rejection (the form token check would
    // refuse the request anyway).
    console.log(`${LOG_PREFIX} rejected: client hashing unavailable`);
    return NextResponse.json({ error: GENERIC_SUBMISSION_ERROR }, { status: 400 });
  }
  const limit = await checkSubmissionLimits(prisma, ipHash);
  if (limit !== null) {
    console.log(`${LOG_PREFIX} rejected: ${limit} submission limit reached`);
    return NextResponse.json({ error: RATE_LIMIT_ERROR }, { status: 429 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: GENERIC_SUBMISSION_ERROR }, { status: 400 });
  }

  // Honeypot: a filled hidden field means a bot; answer exactly like any
  // other pre-validation rejection so the tripwire is not observable.
  const honeypot = form.get(HONEYPOT_FIELD);
  if (typeof honeypot === "string" && honeypot.trim() !== "") {
    console.log(`${LOG_PREFIX} rejected: honeypot filled`);
    return NextResponse.json({ error: GENERIC_SUBMISSION_ERROR }, { status: 400 });
  }

  const token = form.get("formToken");
  const tokenCheck = verifyFormToken(typeof token === "string" ? token : null);
  if (!tokenCheck.ok) {
    console.log(`${LOG_PREFIX} rejected: form token ${tokenCheck.reason}`);
    return NextResponse.json({ error: GENERIC_SUBMISSION_ERROR }, { status: 400 });
  }

  const parsed = applicationFieldsSchema.safeParse(collectApplicationFields(form));
  if (!parsed.success) {
    console.log(`${LOG_PREFIX} validation failed:`, parsed.error.issues);
    return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
  }
  const fields = parsed.data;

  // Collect and pre-check the uploads before any database work.
  const uploads: CollectedUpload[] = [];
  for (const { field, kind, required } of FILE_FIELDS) {
    const value = form.get(field);
    if (!isPresentFile(value)) {
      if (required) {
        return NextResponse.json({ error: LICENCE_REQUIRED_ERROR }, { status: 400 });
      }
      continue;
    }
    if (value.size > KYC_MAX_FILE_BYTES) {
      return NextResponse.json({ error: GENERIC_FILE_ERROR }, { status: 400 });
    }
    uploads.push({ kind, name: value.name, size: value.size, data: Buffer.from(await value.arrayBuffer()) });
  }

  // Create the application and its documents in one transaction. The files
  // land on disk inside the transaction callback; any failure discards them.
  let reference: string | null = null;
  for (let attempt = 0; attempt < MAX_REFERENCE_RETRIES && reference === null; attempt += 1) {
    const writtenPaths: string[] = [];
    try {
      reference = await prisma.$transaction(async (tx) => {
        const proposed = await nextPartnerReference(tx);
        const application = await tx.partnerApplication.create({
          data: { ...fields, reference: proposed, status: "SUBMITTED", ipHash },
        });

        for (let index = 0; index < uploads.length; index += 1) {
          const upload = uploads[index];
          const stored: StoredKycFile = await saveKycFile({
            applicationId: application.id,
            originalName: upload.name,
            data: upload.data,
            existingCount: index,
          });
          writtenPaths.push(stored.storagePath);
          await tx.partnerDocument.create({
            data: {
              applicationId: application.id,
              kind: upload.kind,
              originalName: stored.originalName,
              mime: stored.mime,
              size: stored.size,
              sha256: stored.sha256,
              storagePath: stored.storagePath,
            },
          });
        }
        return proposed;
      });
    } catch (error) {
      await discardKycFiles(writtenPaths);
      if (error instanceof KycStorageError) {
        console.log(`${LOG_PREFIX} rejected: file check ${error.code}`);
        return NextResponse.json({ error: GENERIC_FILE_ERROR }, { status: 400 });
      }
      if (isReferenceConflict(error) && attempt + 1 < MAX_REFERENCE_RETRIES) {
        console.log(`${LOG_PREFIX} reference conflict, retrying (attempt ${attempt + 1})`);
        continue;
      }
      console.error(`${LOG_PREFIX} submission failed:`, (error as Error)?.message ?? error);
      return NextResponse.json({ error: INTERNAL_ERROR }, { status: 500 });
    }
  }

  if (reference === null) {
    console.error(`${LOG_PREFIX} could not allocate a reference after ${MAX_REFERENCE_RETRIES} attempts`);
    return NextResponse.json({ error: INTERNAL_ERROR }, { status: 500 });
  }

  await writeAuditLog(
    "PARTNER_APPLICATION_SUBMITTED",
    null,
    `${reference} ${fields.companyLegalName} <${fields.contactEmail}> (${uploads.length} document(s))`,
  );

  await sendApplicantConfirmationEmail({
    to: fields.contactEmail,
    reference,
    companyLegalName: fields.companyLegalName,
  });
  await sendStaffAlertEmail({
    reference,
    companyLegalName: fields.companyLegalName,
    contactName: fields.contactName,
    contactEmail: fields.contactEmail,
    country: fields.country,
  });

  console.log(`${LOG_PREFIX} stored ${reference} for "${fields.companyLegalName}"`);
  return NextResponse.json({ reference }, { status: 200 });
}
