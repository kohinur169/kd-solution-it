// path: services/invoices/invoice-pdf-document.ts
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import { getAuthRuntime } from "../../lib/auth/runtime.ts";
import { requireAnyRole, requireCompanyId } from "../../lib/auth/session.ts";
import type { RequestActor } from "../../lib/auth/types.ts";
import { AppError } from "../../lib/errors/app-error.ts";
import { getMessage } from "../../lib/i18n/messages.ts";
import type { EnqueueResult, JobDefinition } from "../../lib/jobs/types.ts";
import type { JobQueue } from "../../lib/jobs/queue.ts";
import { enqueueJob, type JobRegistry } from "../../lib/jobs/registry.ts";
import { sanitizeFileName, sanitizeHeaderValue } from "../../lib/security/text.ts";
import { sha256Hex, sniffHead, uploadRejection, validateUpload } from "../../lib/security/upload.ts";
import { registerDefaultStorageAdapters } from "../../lib/storage/adapters.ts";
import { createDefaultFileEncryption, type StorageFileEncryption } from "../../lib/storage/encryption.ts";
import { StorageAdapterRegistry, activeAdapter } from "../../lib/storage/registry.ts";
import {
  archiveFile,
  getFileRecord,
  markFileVerified,
  recordUploadedFile,
  type FileRecord,
} from "../../lib/storage/records.ts";
import {
  downloadEncryptedObject,
  uploadEncryptedObject,
  type FileAccessContext,
} from "../../lib/storage/service.ts";
import {
  DEFAULT_STORAGE_BUCKET,
  isStorageError,
  type StorageAdapter,
} from "../../lib/storage/types.ts";
import { priceColumnSchema } from "../products/price.ts";
import { readInvoicePrintBranding } from "./invoice-branding.ts";
import { discountStateOf } from "./invoice-discount.ts";
import { INVOICE_MANAGE_ROLES } from "./invoices.ts";
import {
  INVOICE_PDF_CONTENT_TYPE,
  INVOICE_PDF_EXTENSION,
  INVOICE_PDF_MAXIMUM_BYTES,
  invoicePdfDocumentOf,
  renderInvoicePdf,
  type InvoicePdfSource,
} from "./invoice-pdf.ts";
import {
  INVOICE_DOCUMENT_STATUSES,
  INVOICE_PDF_NO_DOCUMENT,
  type InvoiceDocumentStatus,
  type InvoicePdfState,
  type InvoicePdfStateStatus,
} from "./invoice-pdf-state.ts";

// The words a screen uses are re-exported from here so a caller of this service has one module to import
// from; a client component imports `invoice-pdf-state.ts` itself, because this one is server only.
export {
  INVOICE_DOCUMENT_STATUSES,
  INVOICE_PDF_NO_DOCUMENT,
  type InvoiceDocumentStatus,
  type InvoicePdfState,
  type InvoicePdfStateStatus,
};

/**
 * The invoice PDF as a background job: section 16's "PDF invoice generation" on section 28's terms.
 *
 * ## The split this module keeps
 *
 * Section 28 is explicit about where the work happens - "PDF generation, email, webhook processing and
 * sub-merchant provisioning run as background jobs. Request handlers validate, write minimal rows and
 * enqueue" - so a request does three cheap things and stops: it proves the caller may act on this
 * invoice, it writes one row of `0115` saying a render is wanted, and it puts a job on the queue. The
 * job does everything heavy: it reads the document, renders the bytes with `invoice-pdf.ts`, seals them
 * with AES-256-GCM, stores them through the adapter of section 21, writes the `0057` file row, and
 * moves the `0115` row to `ready` with the hash and size of what it made.
 *
 * A merchant therefore never waits on a render, and a render that fails is a row that says so with a
 * code from the STEP 008 catalogue rather than a request that timed out and left nothing behind.
 *
 * ## Why the bytes go through the platform's own file rules
 *
 * The renderer produces `%PDF-1.4` bytes, and this module still hands them to `validateUpload` under
 * the `invoice_pdf` purpose before it stores them. That is not doubt about the renderer; it is the rule
 * of section 21 applied uniformly, and it is the check that would catch a renderer that one day grew an
 * image or an embedded font the purpose does not allow. A render whose own bytes fail the platform's
 * file check is a defect, and it fails the row instead of storing a document the storage layer would
 * have quarantined.
 *
 * ## One document, re-rendered
 *
 * `0115` keeps one live row per invoice. A new request walks that row back to `queued` and clears the
 * failure, and a completed render replaces the four facts of the document - file, size, hash, instant -
 * and archives the `0057` row it superseded. The old object stays in storage and its row stays
 * readable, because a PDF a client already received is evidence and section 13 keeps evidence.
 *
 * ## Who may ask, and what the job trusts
 *
 * The request path is the invoice's own: `owner` and the merchant's company, from the session, never
 * from the body. The job carries the company and the invoice in its payload, and every read and write it
 * makes is scoped to both, so a payload naming another merchant's invoice finds nothing: a render is
 * not a way around the scope that produced it.
 */

/** The `0115` table. */
export const INVOICE_DOCUMENTS_TABLE = "invoice_documents";

/** The only document type this STEP renders. */
export const INVOICE_DOCUMENT_TYPE = "invoice_pdf";

/** The background job of section 28 that renders one invoice's PDF. */
export const INVOICE_PDF_JOB = "invoice.pdf.render";

/** The audit actions of the three things that happen to a document. */
export const INVOICE_PDF_REQUESTED_AUDIT_ACTION = "invoice.pdf.requested";
export const INVOICE_PDF_RENDERED_AUDIT_ACTION = "invoice.pdf.rendered";
export const INVOICE_PDF_FAILED_AUDIT_ACTION = "invoice.pdf.failed";

/** The audit entity of all three. The file rows carry their own `file.*` entries. */
export const INVOICE_DOCUMENT_ENTITY = "invoice_document";

/** The middle segment of a rendered document's storage key, beside `kyc` and `logo`. */
export const INVOICE_PDF_KEY_SEGMENT = "invoice_pdf";

/** The `0057` purpose a rendered invoice is stored under. */
export const INVOICE_PDF_PURPOSE = "invoice_pdf";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const keyFilePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$/iu;

/** The row shape of `0115`, validated on every read so a schema drift fails here and not in a route. */
export const invoiceDocumentRowSchema = z.object({
  id: z.string().uuid(),
  company_id: z.string().uuid(),
  invoice_id: z.string().uuid(),
  document_type: z.string().min(1),
  status: z.enum(INVOICE_DOCUMENT_STATUSES),
  generation: z.number().int().min(0),
  attempts: z.number().int().min(0),
  file_id: z.string().uuid().nullable(),
  byte_size: z.number().int().nullable(),
  content_sha256: z.string().nullable(),
  rendered_at: z.string().nullable(),
  queued_at: z.string().min(1),
  last_error_code: z.string().nullable(),
  requested_by: z.string().uuid().nullable(),
  job_id: z.string().nullable(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
  deleted_at: z.string().nullable(),
  version: z.number().int().min(1),
});

export type InvoiceDocumentRow = z.infer<typeof invoiceDocumentRowSchema>;

/** The columns a state read needs, listed one by one: rule 17, and never a `*`. */
const DOCUMENT_ROW_COLUMNS =
  "select=id,company_id,invoice_id,document_type,status,generation,attempts,file_id,byte_size," +
  "content_sha256,rendered_at,queued_at,last_error_code,requested_by,job_id,created_at,updated_at," +
  "deleted_at,version";

/** The two columns that decide whether this merchant may ask for a render of this invoice. */
const INVOICE_KEY_COLUMNS = "select=id,company_id,version,number";

const invoiceKeyRowSchema = z.object({
  id: z.string().uuid(),
  company_id: z.string().uuid(),
  version: z.number().int().min(1),
  number: z.string().nullable(),
});

/** The invoice columns the document prints, and nothing else. */
const INVOICE_PRINT_COLUMNS =
  "select=id,company_id,number,status,currency,subtotal_minor,discount_minor,discount_basis," +
  "discount_percent_bp,tax_minor,total_minor,amount_paid_minor,client_name,client_email," +
  "client_address,memo,issued_at,due_at,version";

const invoicePrintRowSchema = z.object({
  id: z.string().uuid(),
  company_id: z.string().uuid(),
  number: z.string().nullable(),
  status: z.string().min(1),
  currency: z.string().length(3),
  subtotal_minor: priceColumnSchema,
  discount_minor: priceColumnSchema,
  discount_basis: z.string(),
  discount_percent_bp: z.number().int(),
  tax_minor: priceColumnSchema,
  total_minor: priceColumnSchema,
  amount_paid_minor: priceColumnSchema,
  client_name: z.string().min(1).max(160),
  client_email: z.string().max(254).nullable(),
  client_address: z.string().max(600).nullable(),
  memo: z.string().max(2_000).nullable(),
  issued_at: z.string().nullable(),
  due_at: z.string().min(1),
  version: z.number().int().min(1),
});

/** The line columns the document prints, in the order the document prints them. */
const LINE_PRINT_COLUMNS =
  "select=id,company_id,invoice_id,position,description,unit,quantity,unit_price_minor," +
  "discount_minor,line_total_minor";

const linePrintRowSchema = z.object({
  id: z.string().uuid(),
  company_id: z.string().uuid(),
  invoice_id: z.string().uuid(),
  position: z.number().int().min(1),
  description: z.string().min(1).max(300),
  unit: z.string().min(1),
  quantity: z.string().min(1),
  unit_price_minor: priceColumnSchema,
  discount_minor: priceColumnSchema,
  line_total_minor: priceColumnSchema,
});

/**
 * The job's payload.
 *
 * It carries the company beside the invoice, which is redundant with the invoice row and deliberate:
 * every statement the handler runs is scoped to the company in the payload, so a payload that named
 * another merchant's invoice reads nothing instead of reading it and finding out later.
 */
export const invoicePdfJobPayloadSchema = z
  .object({
    invoice_id: z.string().uuid(),
    company_id: z.string().uuid(),
    document_id: z.string().uuid(),
    requested_by: z.string().uuid().nullable(),
  })
  .strict();

export type InvoicePdfJobPayload = z.infer<typeof invoicePdfJobPayloadSchema>;

/**
 * The idempotency key of one render request.
 *
 * It is the document row and the version the request wrote, so a double click on one state of the row
 * is one job, while a merchant who asks again after a failure - which is a new write, and therefore a
 * new version - gets a render rather than the dead job's answer back.
 */
export function invoicePdfJobIdempotencyKey(documentId: string, documentVersion: number): string {
  return `${INVOICE_PDF_JOB}:${documentId}:${documentVersion}`;
}

/** The state of one invoice's PDF, as a screen reads it. */
export interface InvoicePdfStoreDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now?: () => number;
}

export interface InvoicePdfStorageDependencies extends InvoicePdfStoreDependencies {
  readonly adapter: StorageAdapter;
  readonly encryption: StorageFileEncryption;
}

export interface InvoicePdfRequestDependencies extends InvoicePdfStoreDependencies {
  readonly registry: JobRegistry;
  readonly queue: JobQueue;
}

function nowOf(dependencies: { readonly now?: () => number }): number {
  return dependencies.now === undefined ? Date.now() : dependencies.now();
}

function isoOf(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

async function appendTolerated(
  audit: AuditTrail,
  entry: Parameters<AuditTrail["append"]>[0],
): Promise<void> {
  try {
    await audit.append(entry);
  } catch {
    // An audit sink that is down never fails the render it records.
  }
}

/** The role and the company, read from the session and never from a body. */
function requireInvoiceActor(actor: RequestActor): string {
  requireAnyRole(actor, INVOICE_MANAGE_ROLES);

  return requireCompanyId(actor);
}

function requireUuid(value: string, reason: string): string {
  if (!uuidPattern.test(value)) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "id", rule: "invalid_format" }],
      cause: { rule: "invoice_pdf", reason },
    });
  }

  return value;
}

/**
 * The invoice this caller may act on, or a 404.
 *
 * The scope is in the query, so another merchant's invoice id is not found rather than refused: the
 * answer does not say whether the document exists.
 */
async function readInvoiceKey(
  rest: RestClient,
  companyId: string,
  invoiceId: string,
): Promise<z.infer<typeof invoiceKeyRowSchema>> {
  const rows = await rest.select(
    "invoices",
    `${INVOICE_KEY_COLUMNS}&id=eq.${invoiceId}&company_id=eq.${companyId}&deleted_at=is.null`,
    invoiceKeyRowSchema,
  );
  const row = rows[0];

  if (row === undefined) {
    throw new AppError("RESOURCE_NOT_FOUND", { cause: { rule: "invoice_pdf", reason: "invoice_not_found" } });
  }

  return row;
}

async function readDocumentRow(
  rest: RestClient,
  companyId: string,
  invoiceId: string,
): Promise<InvoiceDocumentRow | null> {
  const rows = await rest.select(
    INVOICE_DOCUMENTS_TABLE,
    `${DOCUMENT_ROW_COLUMNS}&invoice_id=eq.${invoiceId}&company_id=eq.${companyId}&deleted_at=is.null`,
    invoiceDocumentRowSchema,
  );

  return rows[0] ?? null;
}

function stateOf(invoiceId: string, row: InvoiceDocumentRow | null): InvoicePdfState {
  if (row === null) {
    return {
      invoiceId,
      status: INVOICE_PDF_NO_DOCUMENT,
      documentId: null,
      generation: 0,
      attempts: 0,
      byteSize: null,
      renderedAt: null,
      queuedAt: null,
      lastErrorCode: null,
      ready: false,
      version: null,
    };
  }

  return {
    invoiceId,
    status: row.status,
    documentId: row.id,
    generation: row.generation,
    attempts: row.attempts,
    byteSize: row.byte_size,
    renderedAt: row.rendered_at,
    queuedAt: row.queued_at,
    lastErrorCode: row.last_error_code,
    ready: row.status === "ready" && row.file_id !== null,
    version: row.version,
  };
}

/**
 * The state of one invoice's PDF.
 *
 * Two reads and no writes: the invoice, which is what proves the caller may see any of this, and the
 * document row, which may legitimately be absent. An invoice that has never been asked for a PDF
 * answers `none` rather than a 404, because "nothing has been rendered" is a true statement about the
 * merchant's own document and the screen has to word it.
 */
export async function readInvoicePdfState(
  input: { readonly actor: RequestActor; readonly invoiceId: string },
  dependencies: InvoicePdfStoreDependencies,
): Promise<InvoicePdfState> {
  const companyId = requireInvoiceActor(input.actor);
  const invoiceId = requireUuid(input.invoiceId, "invoice_id");

  await readInvoiceKey(dependencies.rest, companyId, invoiceId);

  return stateOf(invoiceId, await readDocumentRow(dependencies.rest, companyId, invoiceId));
}

export interface InvoicePdfRequestResult {
  readonly state: InvoicePdfState;
  /** The queue record that will do the work, or null when a request was already in flight. */
  readonly jobId: string | null;
  /** True when this request added no work: a render was already queued, running or asked for. */
  readonly deduplicated: boolean;
}

/**
 * Ask for a render.
 *
 * The order is the security: the actor's role and company, the invoice under that scope, then the
 * document row. A row that is already `queued` or `rendering` is answered as it stands and adds no
 * work - a second click is not a second render, and `0115`'s status walk does not allow a request to
 * pull a running render back into the queue. A row that is `ready` or `failed` is written back to
 * `queued`, with the version-scoped update rule 13 asks for, and the version it lands at is the
 * idempotency key's, so two requests racing on one state produce one job between them.
 *
 * The enqueue is last and its failure is not swallowed: a row that says `queued` with no job behind it
 * would be a document that never arrives, so a queue that refuses leaves the caller with the error.
 */
export async function requestInvoicePdf(
  input: { readonly actor: RequestActor; readonly invoiceId: string },
  dependencies: InvoicePdfRequestDependencies,
): Promise<InvoicePdfRequestResult> {
  const companyId = requireInvoiceActor(input.actor);
  const invoiceId = requireUuid(input.invoiceId, "invoice_id");
  const now = nowOf(dependencies);

  await readInvoiceKey(dependencies.rest, companyId, invoiceId);

  const existing = await readDocumentRow(dependencies.rest, companyId, invoiceId);

  if (existing !== null && (existing.status === "queued" || existing.status === "rendering")) {
    const enqueued = await enqueueInvoicePdfRender(dependencies, {
      companyId,
      invoiceId,
      documentId: existing.id,
      requestedBy: existing.requested_by,
      documentVersion: existing.version,
    });

    await appendTolerated(dependencies.audit, {
      action: INVOICE_PDF_REQUESTED_AUDIT_ACTION,
      actorUserId: input.actor.userId,
      entityType: INVOICE_DOCUMENT_ENTITY,
      entityId: existing.id,
      companyId,
      sessionId: input.actor.sessionId ?? null,
      payload: { invoice_id: invoiceId, status: existing.status, deduplicated: true },
    });

    return {
      state: stateOf(invoiceId, existing),
      jobId: enqueued.job.id,
      deduplicated: true,
    };
  }

  let row: InvoiceDocumentRow;

  if (existing === null) {
    const inserted = await dependencies.rest.insertReturning(
      INVOICE_DOCUMENTS_TABLE,
      [
        {
          company_id: companyId,
          invoice_id: invoiceId,
          document_type: INVOICE_DOCUMENT_TYPE,
          status: "queued",
          generation: 0,
          attempts: 0,
          queued_at: isoOf(now),
          requested_by: input.actor.userId,
        },
      ],
      invoiceDocumentRowSchema,
    );
    const created = inserted[0];

    if (created === undefined) {
      throw new AppError("INTERNAL_ERROR", {
        cause: { rule: "invoice_pdf", reason: "insert_returned_no_row" },
      });
    }

    row = created;
  } else {
    // Optimistic locking (rule 13): the write names the version it read, so the loser of a race matches
    // no row. What the loser does then is read the winner's state back and adopt it.
    const values: Readonly<Record<string, unknown>> = {
      status: "queued",
      attempts: 0,
      last_error_code: null,
      queued_at: isoOf(now),
      requested_by: input.actor.userId,
    };

    await dependencies.rest.update(
      INVOICE_DOCUMENTS_TABLE,
      `id=eq.${existing.id}&company_id=eq.${companyId}&deleted_at=is.null&version=eq.${existing.version}`,
      values,
    );

    const after = await readDocumentRow(dependencies.rest, companyId, invoiceId);

    if (after === null) {
      throw new AppError("RESOURCE_NOT_FOUND", {
        cause: { rule: "invoice_pdf", reason: "document_not_found" },
      });
    }

    if (!writeLanded(after, values)) {
      // Another request re-queued the row, or a worker claimed it while this one was writing. Its
      // render is the render, and the enqueue below carries the version now stored, so it collides with
      // the idempotency key that is already in the queue and answers as the duplicate it is.
      const enqueued = await enqueueInvoicePdfRender(dependencies, {
        companyId,
        invoiceId,
        documentId: after.id,
        requestedBy: after.requested_by,
        documentVersion: after.version,
      });

      return { state: stateOf(invoiceId, after), jobId: enqueued.job.id, deduplicated: true };
    }

    row = after;
  }

  const enqueued = await enqueueInvoicePdfRender(dependencies, {
    companyId,
    invoiceId,
    documentId: row.id,
    requestedBy: row.requested_by,
    documentVersion: row.version,
  });

  await appendTolerated(dependencies.audit, {
    action: INVOICE_PDF_REQUESTED_AUDIT_ACTION,
    actorUserId: input.actor.userId,
    entityType: INVOICE_DOCUMENT_ENTITY,
    entityId: row.id,
    companyId,
    sessionId: input.actor.sessionId ?? null,
    payload: {
      invoice_id: invoiceId,
      status: row.status,
      job_id: enqueued.job.id,
      deduplicated: enqueued.deduplicated,
    },
  });

  return { state: stateOf(invoiceId, row), jobId: enqueued.job.id, deduplicated: enqueued.deduplicated };
}

/**
 * Enqueue one render.
 *
 * Registration happens here rather than at boot, the way the sub-merchant jobs do it, so a queue that
 * is asked to carry this job can always run it: an unregistered name is a row that fails on every
 * attempt, and `lib/jobs/worker.ts` says so in as many words.
 */
export async function enqueueInvoicePdfRender(
  dependencies: {
    readonly registry: JobRegistry;
    readonly queue: JobQueue;
    readonly now?: () => number;
  },
  input: {
    readonly companyId: string;
    readonly invoiceId: string;
    readonly documentId: string;
    readonly requestedBy: string | null;
    readonly documentVersion: number;
  },
): Promise<EnqueueResult> {
  const parsed = invoicePdfJobPayloadSchema.safeParse({
    invoice_id: input.invoiceId,
    company_id: input.companyId,
    document_id: input.documentId,
    requested_by: input.requestedBy,
  });

  if (!parsed.success) {
    throw new AppError("VALIDATION_FAILED", {
      details: parsed.error.issues.map((issue) => ({
        field: issue.path.join("."),
        rule: "invalid_format",
      })),
      cause: { rule: "invoice_pdf", reason: "payload" },
    });
  }

  registerInvoicePdfJob(dependencies.registry);

  return enqueueJob(dependencies, INVOICE_PDF_JOB, parsed.data, {
    idempotencyKey: invoicePdfJobIdempotencyKey(input.documentId, input.documentVersion),
    // The caller's clock, when it has one: a job is due on the clock that asked for it, so a render
    // requested under an injected instant is claimable by a worker reading the same instant. In
    // production there is no injected clock and the queue stamps the job with the wall time.
    ...(dependencies.now === undefined ? {} : { now: dependencies.now() }),
  });
}

/* ---- the storage key ---- */

/**
 * The key a rendered document is stored under: tenant prefix, the purpose segment, the invoice, and a
 * fresh file name. The invoice is in the path so a re-render sits beside the render it replaces, and
 * the file name is new every time so no render can overwrite a document a client already holds.
 */
export function invoicePdfStorageKey(companyId: string, invoiceId: string): string {
  requireUuid(companyId, "company_id");
  requireUuid(invoiceId, "invoice_id");

  return `${companyId}/${INVOICE_PDF_KEY_SEGMENT}/${invoiceId}/${randomUUID()}${INVOICE_PDF_EXTENSION}`;
}

/** What a rendered document's key says about itself, or null when it is not one. */
export function parseInvoicePdfStorageKey(
  key: string,
): { readonly companyId: string; readonly invoiceId: string } | null {
  const segments = key.split("/");

  if (segments.length !== 4 || segments[1] !== INVOICE_PDF_KEY_SEGMENT) {
    return null;
  }

  const [companyId, , invoiceId, file] = segments;

  if (companyId === undefined || invoiceId === undefined || file === undefined) {
    return null;
  }

  if (!uuidPattern.test(companyId) || !uuidPattern.test(invoiceId) || !keyFilePattern.test(file)) {
    return null;
  }

  return { companyId, invoiceId };
}

/** Refuse a key that is not this invoice's, in this merchant's own prefix. */
export function assertInvoicePdfKeyForInvoice(
  key: string,
  companyId: string,
  invoiceId: string,
): void {
  const parsed = parseInvoicePdfStorageKey(key);

  if (parsed === null || parsed.companyId !== companyId || parsed.invoiceId !== invoiceId) {
    throw new AppError("PERMISSION_DENIED", {
      cause: { rule: "invoice_pdf", reason: "storage_key" },
    });
  }
}

/**
 * The name a download carries.
 *
 * The merchant's own number when the invoice has one, the catalog's draft word while it does not, run
 * through the file name sanitiser and then through a header-safe filter: a `Content-Disposition` is a
 * header, and a quote or a semicolon inside a name is how one is injected.
 */
export function invoicePdfFileName(number: string | null): string {
  const stem = getMessage("invoices.pdfFileStem");
  const tail = number === null ? getMessage("invoices.pdfFileDraftStem") : number;
  const sanitized = sanitizeFileName(`${stem}-${tail}${INVOICE_PDF_EXTENSION}`, 80);
  const headerSafe = sanitizeHeaderValue(sanitized, 80).replace(/[^A-Za-z0-9._-]/gu, "_");

  return headerSafe.endsWith(INVOICE_PDF_EXTENSION)
    ? headerSafe
    : `${headerSafe}${INVOICE_PDF_EXTENSION}`;
}

/* ---- the render ---- */

/**
 * A storage failure, classified.
 *
 * `unavailable` and `provider_error` are a provider having a moment, which is worth another attempt, so
 * they become the catalogue's retryable `DEPENDENCY_FAILED`; anything else - a malformed key, a
 * conflicting object - is not going to fix itself and stays non-retryable. Without this the worker
 * would see a `StorageError`, which is not an `AppError`, and settle the job as an internal error on
 * the first outage of the night.
 */
function classifyStorageFailure(error: unknown): never {
  if (isStorageError(error) && (error.code === "unavailable" || error.code === "provider_error")) {
    throw new AppError("DEPENDENCY_FAILED", {
      cause: { rule: "invoice_pdf", reason: `storage_${error.code}` },
    });
  }

  throw error;
}

async function readPrintableInvoice(
  dependencies: InvoicePdfStorageDependencies,
  companyId: string,
  invoiceId: string,
): Promise<InvoicePdfSource> {
  const rest = dependencies.rest;
  const invoices = await rest.select(
    "invoices",
    `${INVOICE_PRINT_COLUMNS}&id=eq.${invoiceId}&company_id=eq.${companyId}&deleted_at=is.null`,
    invoicePrintRowSchema,
  );
  const invoice = invoices[0];

  if (invoice === undefined) {
    throw new AppError("RESOURCE_NOT_FOUND", {
      cause: { rule: "invoice_pdf", reason: "invoice_not_found" },
    });
  }

  // One joined read of the lines in print order: rule 17's "no query in a loop", for the document that
  // is most tempting to build line by line.
  const lines = await rest.select(
    "invoice_items",
    `${LINE_PRINT_COLUMNS}&invoice_id=eq.${invoiceId}&company_id=eq.${companyId}&deleted_at=is.null` +
      "&order=position.asc",
    linePrintRowSchema,
  );

  const discount = discountStateOf(invoice);
  // The merchant's own half of the document: their choices from `0116`, their facts from the business
  // profile, and - when they chose one - the logo's bytes out of storage. Read here rather than passed in,
  // because the render is the moment the document is built, and branding saved a minute ago has to be the
  // branding this document carries.
  const branding = await readInvoicePrintBranding({ companyId }, dependencies);

  return {
    invoice: {
      id: invoice.id,
      number: invoice.number,
      status: invoice.status,
      currency: invoice.currency,
      subtotalMinor: invoice.subtotal_minor,
      discountMinor: invoice.discount_minor,
      // A percentage discount prints its percentage; a flat amount prints none, which is what
      // `discountStateOf` decides from the basis the row carries.
      discountPercentBasisPoints:
        discount.basis === "percent" ? Number(discount.basisPoints) : 0,
      taxMinor: invoice.tax_minor,
      totalMinor: invoice.total_minor,
      amountPaidMinor: invoice.amount_paid_minor,
      clientName: invoice.client_name,
      clientEmail: invoice.client_email,
      clientAddress: invoice.client_address,
      memo: invoice.memo,
      issuedAt: invoice.issued_at,
      dueAt: invoice.due_at,
    },
    lines: lines.map((line) => ({
      position: line.position,
      description: line.description,
      unit: line.unit,
      quantity: line.quantity,
      unitPriceMinor: line.unit_price_minor,
      discountMinor: line.discount_minor,
      lineTotalMinor: line.line_total_minor,
    })),
    branding: { ...branding.words, logo: branding.logo },
    generatedAtEpochMs: 0,
  };
}

function accessOf(companyId: string, actorUserId: string | null, fileId: string | null): FileAccessContext {
  return {
    actorUserId,
    companyId,
    fileId,
    purpose: INVOICE_PDF_PURPOSE,
  };
}

/** A column comparison on the wire, where a null and an absent value are the same fact. */
function sameWire(left: unknown, right: unknown): boolean {
  return String(left ?? "") === String(right ?? "");
}

/**
 * Whether the write this caller sent is the one the row now holds.
 *
 * A version comparison cannot answer that: the version moves when the write lands and it moves when a
 * competing write lands instead, so "the version changed" says only that somebody wrote. The row is
 * asked the question that does have an answer - does it hold these values? - and when it does not, the
 * state of the document is somebody else's write and this caller adopts it rather than believing its own.
 */
function writeLanded(row: InvoiceDocumentRow, values: Readonly<Record<string, unknown>>): boolean {
  const stored: Readonly<Record<string, unknown>> = { ...row };

  return Object.entries(values).every(([column, value]) => sameWire(stored[column], value));
}

/** The error code a failure is recorded with: the catalogue's own, or the generic internal one. */
function failureCodeOf(error: unknown): string {
  return error instanceof AppError ? error.code : "INTERNAL_ERROR";
}

export interface InvoicePdfRenderResult {
  readonly documentId: string;
  readonly invoiceId: string;
  readonly companyId: string;
  readonly fileId: string;
  readonly byteSize: number;
  readonly contentSha256: string;
  readonly generation: number;
  /** True when the document was already rendered by an earlier attempt and nothing was written. */
  readonly alreadyRendered: boolean;
}

/** What the queue knows about the attempt, which the row records so a support trace can follow it. */
export interface InvoicePdfRenderContext {
  readonly jobId?: string;
}

/**
 * Render, store and record one invoice's PDF.
 *
 * The steps, in the order the failure modes demand:
 *
 *   1. the document row, under the payload's own company scope - a payload naming another merchant's
 *      document finds nothing, and a row that is already `ready` answers as rendered rather than
 *      making a second document;
 *   2. the claim: `rendering`, with the attempt counted and the queue record named, version scoped so
 *      two workers cannot both believe they own it;
 *   3. the invoice and its lines, in two joined reads;
 *   4. the bytes, from `invoice-pdf.ts`, dated with this instant so a re-render of an unchanged
 *      document is byte identical;
 *   5. the platform's own file verdict on those bytes;
 *   6. the seal and the upload, the `0057` record and its verification, and the archive of the record
 *      this render replaces;
 *   7. the row to `ready` with the four facts of the render, and the audit entry.
 *
 * A failure at any step after the claim writes `failed` with the catalogue's code and rethrows, so the
 * queue decides whether another attempt is worth making.
 */
export async function renderInvoicePdfDocument(
  payload: InvoicePdfJobPayload,
  dependencies: InvoicePdfStorageDependencies,
  context: InvoicePdfRenderContext = {},
): Promise<InvoicePdfRenderResult> {
  const companyId = payload.company_id;
  const now = nowOf(dependencies);

  const row = await readDocumentRowById(dependencies.rest, companyId, payload.document_id);

  if (row === null || row.invoice_id !== payload.invoice_id) {
    throw new AppError("RESOURCE_NOT_FOUND", {
      cause: { rule: "invoice_pdf", reason: "document_not_found" },
    });
  }

  if (row.status === "ready") {
    // An attempt whose lease expired after the render landed: the document exists, so this one is
    // finished rather than a second render of the same invoice.
    return {
      documentId: row.id,
      invoiceId: row.invoice_id,
      companyId,
      fileId: row.file_id ?? "",
      byteSize: row.byte_size ?? 0,
      contentSha256: row.content_sha256 ?? "",
      generation: row.generation,
      alreadyRendered: true,
    };
  }

  const claimed = await writeDocumentState(dependencies, row, {
    status: "rendering",
    attempts: row.attempts + 1,
    ...(context.jobId === undefined ? {} : { job_id: context.jobId }),
  });

  try {
    const source = await readPrintableInvoice(dependencies, companyId, payload.invoice_id);
    const printable = invoicePdfDocumentOf({ ...source, generatedAtEpochMs: now });
    const bytes = renderInvoicePdf(printable);

    if (bytes.length > INVOICE_PDF_MAXIMUM_BYTES) {
      throw new AppError("PAYLOAD_TOO_LARGE", {
        cause: { rule: "invoice_pdf", reason: "too_large" },
      });
    }

    // Section 21's rules applied to our own bytes: the purpose's type list, its ceiling, and the magic
    // bytes at offset zero. A render that fails this is a defect and is not stored.
    const decision = validateUpload(
      {
        fileName: invoicePdfFileName(printable.number),
        declaredType: INVOICE_PDF_CONTENT_TYPE,
        byteSize: bytes.length,
        head: sniffHead(bytes),
      },
      INVOICE_PDF_PURPOSE,
    );

    if (!decision.ok) {
      throw uploadRejection(decision.reason);
    }

    if (decision.verdict.decision !== "verified") {
      throw new AppError("INTERNAL_ERROR", {
        cause: {
          rule: "invoice_pdf",
          reason: decision.verdict.quarantineReason ?? "the rendered bytes did not verify",
        },
      });
    }

    const key = invoicePdfStorageKey(companyId, payload.invoice_id);
    let stored;
    let sealed;

    try {
      const uploaded = await uploadEncryptedObject(
        dependencies.adapter,
        { bucket: DEFAULT_STORAGE_BUCKET, key, bytes, contentType: INVOICE_PDF_CONTENT_TYPE },
        accessOf(companyId, payload.requested_by, null),
        dependencies,
      );

      stored = uploaded.stored;
      sealed = uploaded.sealed;
    } catch (error) {
      classifyStorageFailure(error);
    }

    const recordDeps = {
      rest: dependencies.rest,
      audit: dependencies.audit,
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    };
    const record: FileRecord = await recordUploadedFile(recordDeps, {
      companyId,
      uploadedBy: payload.requested_by,
      purpose: INVOICE_PDF_PURPOSE,
      contentType: INVOICE_PDF_CONTENT_TYPE,
      stored,
      sealed,
    });
    const verified = await markFileVerified(recordDeps, { companyId, fileId: record.id });

    // The render this one replaces stays in storage and stays readable, archived rather than deleted:
    // a PDF a client already received is evidence, and section 13 keeps evidence for seven years.
    if (row.file_id !== null && row.file_id !== verified.id) {
      try {
        await archiveFile(recordDeps, { companyId, fileId: row.file_id });
      } catch {
        // An earlier record that cannot archive does not undo the render that replaced it.
      }
    }

    const completed = await writeDocumentState(dependencies, claimed, {
      status: "ready",
      generation: claimed.generation + 1,
      file_id: verified.id,
      byte_size: verified.byte_size,
      content_sha256: verified.content_sha256,
      rendered_at: isoOf(now),
    });

    await appendTolerated(dependencies.audit, {
      action: INVOICE_PDF_RENDERED_AUDIT_ACTION,
      actorUserId: payload.requested_by,
      entityType: INVOICE_DOCUMENT_ENTITY,
      entityId: completed.id,
      companyId,
      sessionId: null,
      payload: {
        invoice_id: payload.invoice_id,
        file_id: verified.id,
        byte_size: verified.byte_size,
        content_sha256: verified.content_sha256,
        generation: completed.generation,
        attempts: completed.attempts,
      },
    });

    return {
      documentId: completed.id,
      invoiceId: payload.invoice_id,
      companyId,
      fileId: verified.id,
      byteSize: verified.byte_size,
      contentSha256: verified.content_sha256,
      generation: completed.generation,
      alreadyRendered: false,
    };
  } catch (error) {
    const code = failureCodeOf(error);

    await writeDocumentState(
      dependencies,
      claimed,
      { status: "failed", last_error_code: code },
      true,
    );

    await appendTolerated(dependencies.audit, {
      action: INVOICE_PDF_FAILED_AUDIT_ACTION,
      actorUserId: payload.requested_by,
      entityType: INVOICE_DOCUMENT_ENTITY,
      entityId: claimed.id,
      companyId,
      sessionId: null,
      // The code and the invoice, never the message: a storage message can carry a key id or a
      // provider's own words, and the trail is read by people who do not need either.
      payload: { invoice_id: payload.invoice_id, code, attempts: claimed.attempts },
    });

    throw error;
  }
}

async function readDocumentRowById(
  rest: RestClient,
  companyId: string,
  documentId: string,
): Promise<InvoiceDocumentRow | null> {
  const rows = await rest.select(
    INVOICE_DOCUMENTS_TABLE,
    `${DOCUMENT_ROW_COLUMNS}&id=eq.${documentId}&company_id=eq.${companyId}&deleted_at=is.null`,
    invoiceDocumentRowSchema,
  );

  return rows[0] ?? null;
}

/**
 * One version-scoped write to the document row, read back.
 *
 * Every transition in this module goes through here, so the optimistic lock of rule 13 is one sentence
 * rather than a habit, and `0115`'s guard sees a row that always moves from the state it was read in.
 * A write that matched nothing - another worker claimed the render, or a merchant asked again while it
 * ran - is a conflict unless the caller asked for it to be tolerated, which only the failure path does,
 * because a failure must not replace the error it is reporting.
 */
async function writeDocumentState(
  dependencies: InvoicePdfStoreDependencies,
  row: InvoiceDocumentRow,
  values: Readonly<Record<string, unknown>>,
  tolerateFailure: boolean = false,
): Promise<InvoiceDocumentRow> {
  const tolerate = tolerateFailure;
  try {
    await dependencies.rest.update(
      INVOICE_DOCUMENTS_TABLE,
      `id=eq.${row.id}&company_id=eq.${row.company_id}&deleted_at=is.null&version=eq.${row.version}`,
      values,
    );
  } catch (error) {
    if (tolerate) {
      return row;
    }

    throw error;
  }

  const after = await readDocumentRowById(dependencies.rest, row.company_id, row.id);

  if (after === null) {
    if (tolerate) {
      return row;
    }

    throw new AppError("RESOURCE_NOT_FOUND", {
      cause: { rule: "invoice_pdf", reason: "document_not_found" },
    });
  }

  if (!writeLanded(after, values)) {
    // The row does not hold what this write sent, so a competing worker owns the render now: two
    // workers finishing one document would store two objects and point the row at whichever wrote last.
    if (tolerate) {
      return after;
    }

    throw new AppError("CONFLICT", { cause: { rule: "invoice_pdf", reason: "stale_document" } });
  }

  return after;
}

/* ---- the download ---- */

export interface InvoicePdfDownload {
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly contentSha256: string;
  readonly generation: number;
  readonly renderedAt: string;
  readonly fileId: string;
}

/**
 * Read one invoice's rendered PDF back, decrypted.
 *
 * The record is the merchant's own, its purpose is `invoice_pdf`, its key is this invoice's key in this
 * merchant's prefix, and the bytes that come back are the bytes the record's hash describes - so a
 * ciphertext swapped between rows fails the seal, and a seal that opens to something else fails the
 * hash. A document that is not `ready` is not found: there are no bytes to serve, and the state
 * endpoint is where a screen learns why.
 */
export async function readInvoicePdfBytes(
  input: { readonly actor: RequestActor; readonly invoiceId: string },
  dependencies: InvoicePdfStorageDependencies,
): Promise<InvoicePdfDownload> {
  const companyId = requireInvoiceActor(input.actor);
  const invoiceId = requireUuid(input.invoiceId, "invoice_id");

  const invoice = await readInvoiceKey(dependencies.rest, companyId, invoiceId);
  const row = await readDocumentRow(dependencies.rest, companyId, invoiceId);

  if (row === null || row.status !== "ready" || row.file_id === null || row.rendered_at === null) {
    throw new AppError("RESOURCE_NOT_FOUND", {
      cause: { rule: "invoice_pdf", reason: "pdf_not_ready" },
    });
  }

  const recordDeps = {
    rest: dependencies.rest,
    audit: dependencies.audit,
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  };
  const record = await getFileRecord(recordDeps, { companyId, fileId: row.file_id });

  if (record.purpose !== INVOICE_PDF_PURPOSE) {
    throw new AppError("PERMISSION_DENIED", {
      cause: { rule: "invoice_pdf", reason: "not_an_invoice_pdf" },
    });
  }

  assertInvoicePdfKeyForInvoice(record.storage_key, companyId, invoiceId);

  let bytes: Uint8Array;

  try {
    bytes = await downloadEncryptedObject(
      dependencies.adapter,
      { bucket: record.storage_bucket, key: record.storage_key },
      accessOf(companyId, input.actor.userId, record.id),
      dependencies,
    );
  } catch (error) {
    classifyStorageFailure(error);
  }

  if (bytes.length !== record.byte_size || sha256Hex(bytes) !== record.content_sha256) {
    // The seal opened, so the bytes are this tenant's and this purpose's, but they are not the bytes
    // the record describes. Nothing serves a document it cannot vouch for.
    throw new AppError("INTERNAL_ERROR", {
      cause: { rule: "invoice_pdf", reason: "content_mismatch" },
    });
  }

  return {
    bytes,
    fileName: invoicePdfFileName(invoice.number),
    contentType: INVOICE_PDF_CONTENT_TYPE,
    byteSize: record.byte_size,
    contentSha256: record.content_sha256,
    generation: row.generation,
    renderedAt: row.rendered_at,
    fileId: record.id,
  };
}

/* ---- the job and the wiring ---- */

/**
 * The job definition, with the dependencies injectable so the gate can drive the handler against an
 * in-memory store, an in-memory adapter and a real key. The default wiring closes over the auth
 * runtime and the storage runtime, exactly as a route does.
 */
export function createInvoicePdfJobHandler(
  dependenciesOf: () => InvoicePdfStorageDependencies,
): JobDefinition<InvoicePdfJobPayload> {
  return {
    name: INVOICE_PDF_JOB,
    payloadSchema: invoicePdfJobPayloadSchema,
    handler: async (context) => {
      await renderInvoicePdfDocument(context.payload, dependenciesOf(), { jobId: context.jobId });
    },
  };
}

const defaultInvoicePdfJob = createInvoicePdfJobHandler(() => invoicePdfDependencies());

/** Register the render job once; a second call is a no-op, so any entry point can ask for it. */
export function registerInvoicePdfJob(registry: JobRegistry): void {
  if (!registry.has(INVOICE_PDF_JOB)) {
    registry.register(defaultInvoicePdfJob);
  }
}

/**
 * The real dependencies of a render, built on first use.
 *
 * Nothing here is built at import time: the adapters and the file encryption both read the validated
 * environment, so a module that captured them while a page's data was being collected would make a
 * build machine need runtime secrets. The registry is filled once per process, and the active adapter
 * is resolved on every call, so a deployment that sets `STORAGE_PROVIDER=s3` is served by S3 without
 * this module ever naming a provider.
 */
interface InvoicePdfStorageRuntime {
  readonly registry: StorageAdapterRegistry;
  readonly encryption: StorageFileEncryption;
}

let storageRuntime: InvoicePdfStorageRuntime | undefined;

function invoicePdfStorage(): InvoicePdfStorageRuntime {
  if (storageRuntime === undefined) {
    const registry = new StorageAdapterRegistry();

    registerDefaultStorageAdapters(registry);
    storageRuntime = { registry, encryption: createDefaultFileEncryption() };
  }

  return storageRuntime;
}

export function invoicePdfDependencies(): InvoicePdfStorageDependencies {
  const runtime = getAuthRuntime();
  const storage = invoicePdfStorage();

  return {
    rest: runtime.rest,
    audit: runtime.audit,
    adapter: activeAdapter(storage.registry),
    encryption: storage.encryption,
  };
}
