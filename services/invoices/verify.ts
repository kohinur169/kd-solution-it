// path: services/invoices/verify.ts
import process from "node:process";
import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { crc32, deflateSync, inflateSync } from "node:zlib";
import type { z } from "zod";
import { createInMemoryAuditTrail, type AuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import type { PlatformRole, RequestActor } from "../../lib/auth/types.ts";
import { AppError, isAppError } from "../../lib/errors/app-error.ts";
import { formatMessage, getMessage } from "../../lib/i18n/messages.ts";
import { createLogger } from "../../lib/logger/logger.ts";
import { createInMemoryJobQueue } from "../../lib/jobs/queue.ts";
import { JobRegistry } from "../../lib/jobs/registry.ts";
import { JobWorker } from "../../lib/jobs/worker.ts";
import { isFileEnvelope } from "../../lib/security/encryption.ts";
import { UPLOAD_POLICIES } from "../../lib/security/upload.ts";
import { createFileEncryption } from "../../lib/storage/encryption.ts";
import {
  DEFAULT_STORAGE_BUCKET,
  StorageError,
  type SignedUrl,
  type SignedUrlInput,
  type StorageAdapter,
  type StorageAdapterName,
  type StorageObjectRef,
  type StorageUploadInput,
  type StoredObject,
} from "../../lib/storage/types.ts";
import {
  INVOICE_ABANDONED_AUDIT_ACTION,
  INVOICE_AUDIT_ENTITY,
  INVOICE_CLIENT_OPTION_LIMIT,
  INVOICE_CREATED_AUDIT_ACTION,
  INVOICE_MANAGE_ROLES,
  INVOICE_RULES,
  createInvoice,
  getInvoice,
  invoiceItemRowSchema,
  invoiceRowSchema,
  listInvoiceCatalogueOptions,
  listInvoiceClientOptions,
  type InvoiceDependencies,
} from "./invoices.ts";
import {
  INVOICE_LINE_ADDED_AUDIT_ACTION,
  INVOICE_LINE_REMOVED_AUDIT_ACTION,
  INVOICE_LINE_UPDATED_AUDIT_ACTION,
  addInvoiceLine,
  invoiceLineRowSchema,
  INVOICE_DISCOUNT_UPDATED_AUDIT_ACTION,
  removeInvoiceLine,
  updateInvoiceLine,
  updateInvoiceTotals,
  type InvoiceLineDependencies,
} from "./invoice-lines.ts";
import {
  INVOICE_OVERDUE_AUDIT_ACTION,
  INVOICE_PAID_LOCKED_RULE,
  INVOICE_SENT_AUDIT_ACTION,
  INVOICE_STATUS_TRANSITIONS,
  INVOICE_VOID_REASON_LIMITS,
  INVOICE_VOIDED_AUDIT_ACTION,
  isLegalInvoiceTransition,
  sendInvoice,
  sweepOverdueInvoices,
  voidInvoice,
} from "./invoice-status.ts";
import {
  OVERDUE_SWEEP_JOB_NAME,
  createDefaultOverdueSweepJob,
  createOverdueSweepJob,
  overdueSweepJobPayloadSchema,
  registerOverdueSweepJob,
} from "./overdue-sweep-job.ts";
import {
  INVOICE_LINE_MOVED_AUDIT_ACTION,
  moveInvoiceLine,
} from "./invoice-line-order.ts";
import { parseInvoiceLine, type ParsedLine } from "./invoices.ts";
import {
  INVOICE_CREATED_STATUS,
  INVOICE_DEFAULT_UNIT,
  INVOICE_ITEM_DESCRIPTION_LIMITS,
  INVOICE_MAXIMUM_LINES,
  INVOICE_QUANTITY_MAXIMUM,
  INVOICE_QUANTITY_MINIMUM,
  INVOICE_UNITS,
} from "./invoice-fields.ts";
import {
  grossLineMinor,
  invoiceTotalsOf,
  lineTotalMinor,
  quantityToThousandths,
  subtotalOf,
  thousandthsToQuantity,
} from "./invoice-totals.ts";
import {
  DISCOUNT_BASES,
  DISCOUNT_PERCENT_MAXIMUM_BP,
  basisPointsToColumn,
  basisPointsToPercent,
  discountProblemAt,
  discountStateOf,
  isDiscountBasis,
  percentDiscountMinor,
  percentToBasisPoints,
  resolveDiscount,
  selectInvoiceTotals,
} from "./invoice-discount.ts";
import { priceFromMinor, priceToMinor } from "../products/price.ts";
import {
  INVOICE_NUMBER_SETTINGS_UPDATED_AUDIT_ACTION,
  getInvoiceNumberSettings,
  normaliseInvoiceNumberPrefix,
  parseInvoiceNumberSettings,
  parseNextNumber,
  printInvoiceNumber,
  takeInvoiceNumber,
  updateInvoiceNumberSettings,
  type InvoiceNumberingDependencies,
} from "./invoice-numbering.ts";
import {
  INVOICE_PDF_ACCENT_PATTERN,
  INVOICE_PDF_CONTENT_TYPE,
  INVOICE_PDF_EXTENSION,
  INVOICE_PDF_FONTS,
  INVOICE_PDF_HEADER,
  INVOICE_PDF_LOGO_MAXIMUM_HEIGHT,
  INVOICE_PDF_LOGO_MAXIMUM_WIDTH,
  INVOICE_PDF_LOGO_NAME,
  INVOICE_PDF_MARGIN,
  INVOICE_PDF_MAXIMUM_BYTES,
  INVOICE_PDF_PAGE_HEIGHT,
  INVOICE_PDF_PAGE_WIDTH,
  invoicePdfDocumentOf,
  invoicePdfEncodedText,
  invoicePdfLabels,
  invoicePdfLiteral,
  invoicePdfQuantity,
  invoicePdfTextWidth,
  invoicePdfUnitPrice,
  invoicePdfUsd,
  invoicePdfWrap,
  renderInvoicePdf,
  type InvoicePdfSource,
  type InvoicePdfSourceBranding,
  type InvoicePdfSourceLine,
} from "./invoice-pdf.ts";
import {
  INVOICE_PDF_IMAGE_COLOR_SPACES,
  INVOICE_PDF_IMAGE_FORMATS,
  INVOICE_PDF_IMAGE_MAXIMUM_PIXELS,
  INVOICE_PDF_IMAGE_REFUSALS,
  decodeInvoicePdfImage,
  inspectInvoicePdfImage,
  sniffInvoicePdfImageFormat,
  type InvoicePdfImage,
} from "./invoice-pdf-image.ts";
import {
  COMPANY_LOGO_PURPOSE,
  INVOICE_BRANDING_AUDIT_ENTITY,
  INVOICE_BRANDING_DEFAULTS,
  INVOICE_BRANDING_LIMITS,
  INVOICE_BRANDING_NAME_STYLES,
  INVOICE_BRANDING_TABLE,
  INVOICE_BRANDING_UPDATED_AUDIT_ACTION,
  invoiceBrandingInputSchema,
  invoiceBrandingRowSchema,
  invoiceBrandingWordsOf,
  parseInvoiceBrandingInput,
  readInvoiceBranding,
  readInvoiceBrandingIdentity,
  readInvoicePrintBranding,
  updateInvoiceBranding,
  uploadInvoiceLogo,
  type InvoiceBrandingIdentity,
  type InvoiceBrandingStorageDependencies,
} from "./invoice-branding.ts";
import {
  INVOICE_DOCUMENTS_TABLE,
  INVOICE_DOCUMENT_ENTITY,
  INVOICE_DOCUMENT_STATUSES,
  INVOICE_DOCUMENT_TYPE,
  INVOICE_PDF_FAILED_AUDIT_ACTION,
  INVOICE_PDF_JOB,
  INVOICE_PDF_KEY_SEGMENT,
  INVOICE_PDF_NO_DOCUMENT,
  INVOICE_PDF_PURPOSE,
  INVOICE_PDF_RENDERED_AUDIT_ACTION,
  INVOICE_PDF_REQUESTED_AUDIT_ACTION,
  assertInvoicePdfKeyForInvoice,
  createInvoicePdfJobHandler,
  invoiceDocumentRowSchema,
  invoicePdfFileName,
  invoicePdfJobIdempotencyKey,
  invoicePdfJobPayloadSchema,
  invoicePdfStorageKey,
  parseInvoicePdfStorageKey,
  readInvoicePdfBytes,
  readInvoicePdfState,
  registerInvoicePdfJob,
  renderInvoicePdfDocument,
  requestInvoicePdf,
  type InvoicePdfRequestDependencies,
  type InvoicePdfStorageDependencies,
  type InvoicePdfStoreDependencies,
} from "./invoice-pdf-document.ts";

/**
 * Invoice gate for STEP 112. Run with `node services/invoices/verify.ts`.
 *
 * The gate drives the real service over an in-memory PostgREST of `0022` and `0023`, so what passes here
 * is the code the route runs:
 *
 *   1. the arithmetic: the generated column's rule - `(quantity * unit_price_minor)::bigint - discount` -
 *      reproduced in integers with PostgreSQL's half-away-from-zero rounding, proved equal to the
 *      database's own expression on the cases that separate rounding from truncation;
 *   2. the money: every typed amount becomes whole minor units by decimal string arithmetic, with no
 *      float anywhere on the path;
 *   3. the validation: each ceiling the migration states, every field named at once as
 *      `lines[2].unit_price`, and the invoice-level discount bounded by what the lines add up to;
 *   4. the tenancy: the company comes from the session, the client is read from the merchant's own book
 *      through `getClient`, a foreign or unknown client is the same 404, and only the owner may write;
 *   5. the draft: a create writes `draft` with no number and no issue instant, which is the shape
 *      `invoices_issue_check` requires of a draft;
 *   6. the compensation: a lines insert that fails removes the invoice it wrote, and says so in the trail;
 *   7. the audit: `invoice.created` names the row, the company and the actor, and never the client's
 *      name, the memo or a line's description;
 *   8. the sources: the routes are token-checked and on the protected list, the columns the code names
 *      are the ones the migrations created, and the catalog carries every key the screens use.
 */

const repositoryRoot = new URL("../../", import.meta.url);

const failures: string[] = [];
let checks = 0;

function expect(condition: boolean, description: string): void {
  checks += 1;

  if (!condition) {
    failures.push(description);
  }
}

function printable(value: unknown): string {
  return typeof value === "bigint" ? `${value.toString()}n` : JSON.stringify(value);
}

function expectEqual<T>(actual: T, expected: T, description: string): void {
  checks += 1;

  if (actual !== expected) {
    failures.push(`${description} (expected ${printable(expected)}, received ${printable(actual)})`);
  }
}

function expectDeepEqual(actual: unknown, expected: unknown, description: string): void {
  checks += 1;

  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);

  if (left !== right) {
    failures.push(`${description} (expected ${right}, received ${left})`);
  }
}

async function readRepositoryFile(repositoryPath: string): Promise<string> {
  return readFile(new URL(repositoryPath, repositoryRoot), "utf8");
}

function at<T>(items: readonly T[], index: number, description: string): T {
  const item = items[index];

  if (item === undefined) {
    throw new Error(`gate fixture: ${description} is missing at index ${index}`);
  }

  return item;
}

const NOW = Date.parse("2026-11-04T09:00:00.000Z");

const OWNER_ID = "018f2b8a-1111-4c2d-9c3e-000000000001";
const OTHER_OWNER_ID = "018f2b8a-1111-4c2d-9c3e-000000000002";
const OFFICE_ID = "018f2b8a-1111-4c2d-9c3e-000000000003";

const COMPANY_A = "018f2b8a-4444-4c2d-9c3e-000000000001";
const COMPANY_B = "018f2b8a-4444-4c2d-9c3e-000000000002";

const CLIENT_A = "018f2b8a-5555-4c2d-9c3e-000000000001";

/** `0024`'s timeline vocabulary with `0120`'s `overdue` word, written from the migrations. */
const INVOICE_EVENT_TYPES = [
  "created",
  "sent",
  "viewed",
  "payment_received",
  "paid",
  "overdue",
  "overdue_reminder",
  "voided",
  "duplicated",
  "note",
] as const;

/** `0024`'s actor words. */
const INVOICE_EVENT_ACTORS = ["merchant", "client", "office", "system"] as const;
const CLIENT_B = "018f2b8a-5555-4c2d-9c3e-000000000002";

const PRODUCT_A = "018f2b8a-6666-4c2d-9c3e-000000000001";
const SERVICE_A = "018f2b8a-6666-4c2d-9c3e-000000000002";

function actorOf(
  roles: readonly PlatformRole[],
  companyId: string | null,
  overrides: Partial<RequestActor> = {},
): RequestActor {
  return {
    userId: OWNER_ID,
    companyId,
    roles,
    sessionId: "018f2b8a-2222-4c2d-9c3e-000000000001",
    assuranceLevel: "aal2",
    authenticatedAtEpochMs: NOW,
    expiresAtEpochMs: NOW + 900_000,
    emailVerified: true,
    twoFactorSatisfied: true,
    twoFactorEnrolmentRequired: false,
    deviceProofKeyId: null,
    sessionFamilyId: null,
    mfaVerifiedAtEpochMs: NOW,
    reauthenticatedAtEpochMs: NOW,
    ...overrides,
  };
}

const owner = actorOf(["owner"], COMPANY_A);
const otherOwner = actorOf(["owner"], COMPANY_B, { userId: OTHER_OWNER_ID });
const desk = actorOf(["compliance_kyc"], null, { userId: OFFICE_ID });

/* ---- an in-memory invoices, invoice_items and clients shaped like 0022, 0023 and 0019 ---- */

interface InvoiceDb {
  readonly clients: Array<Record<string, unknown>>;
  readonly products: Array<Record<string, unknown>>;
  readonly services: Array<Record<string, unknown>>;
  readonly invoices: Array<Record<string, unknown>>;
  readonly items: Array<Record<string, unknown>>;
  /** The merchant numbering series, one row per company, and the counters it consumes. */
  readonly numberingSettings: Array<Record<string, unknown>>;
  readonly numberingCounters: Array<Record<string, unknown>>;
  /** `0115`: one live rendered-document row per invoice. */
  readonly documents: Array<Record<string, unknown>>;
  /** `0024`: the invoice's timeline, append-only; every move the workflow performs is one row here. */
  readonly invoiceEvents: Array<Record<string, unknown>>;
  /** `0057`: the file rows a render writes, archives and reads back. */
  readonly files: Array<Record<string, unknown>>;
  /** `0116`: the merchant's invoice branding, one row per company, created on the first save. */
  readonly branding: Array<Record<string, unknown>>;
  /** `0103` as `0105` extended it: the facts an invoice prints about its own merchant. */
  readonly profiles: Array<Record<string, unknown>>;
  /** `0001`: the company itself, whose name is the last resort for a merchant with no profile. */
  readonly companies: Array<Record<string, unknown>>;
  /** Every take, in order, so a test can see the sequence a merchant was actually issued. */
  readonly takenNumbers: string[];
  /** Set to make the lines insert fail, which is how the compensation path is reached. */
  failItems: boolean;
  /**
   * Set to make one document update lose a race: the fixture moves the row first, so the version-scoped
   * write the service sends matches nothing and the service has to read the winner's state back.
   */
  raceDocumentVersion: boolean;
  /**
   * Set to make one invoice status write lose a race: the fixture moves the row to these values first,
   * so the guarded write the service sends matches nothing and the service has to read the winner's
   * state back.
   */
  raceInvoiceRow: Readonly<Record<string, unknown>> | null;
  /**
   * Set to make one branding save lose a race: the fixture moves the row first, so the version-scoped write
   * the service sends matches nothing and the service has to answer `CONFLICT` rather than overwrite.
   */
  raceBrandingVersion: boolean;
  inserts: Array<{ readonly table: string; readonly rows: readonly Readonly<Record<string, unknown>>[] }>;
  updates: Array<{ readonly table: string; readonly query: string; readonly values: Record<string, unknown> }>;
  /** Set while a test wants every intermediate position write checked against the unique index. */
  strictPositions: boolean;
  queries: string[];
}

function clientRow(input: {
  readonly id: string;
  readonly companyId: string;
  readonly name: string;
  readonly email?: string | null;
  readonly city?: string | null;
}): Record<string, unknown> {
  return {
    id: input.id,
    company_id: input.companyId,
    name: input.name,
    company_name: null,
    email: input.email ?? null,
    phone: null,
    address_line1: input.city === undefined ? null : "12 Market Street",
    address_line2: null,
    city: input.city ?? null,
    region: null,
    postal_code: null,
    country: "US",
    tax_id: null,
    notes: null,
    created_at: new Date(NOW).toISOString(),
    updated_at: new Date(NOW).toISOString(),
    deleted_at: null,
    version: 1,
  };
}

function createDb(): InvoiceDb {
  return {
    clients: [
      clientRow({ id: CLIENT_A, companyId: COMPANY_A, name: "Acme Ltd", email: "billing@acme.example", city: "Austin" }),
      clientRow({ id: CLIENT_B, companyId: COMPANY_B, name: "Other Co" }),
    ],
    products: [
      {
        id: PRODUCT_A,
        company_id: COMPANY_A,
        name: "Desk lamp",
        sku: "LAMP-01",
        code: null,
        description: null,
        unit_price_minor: "425000",
        currency: "USD",
        unit: "item",
        created_at: new Date(NOW).toISOString(),
        updated_at: new Date(NOW).toISOString(),
        deleted_at: null,
        version: 1,
      },
    ],
    services: [
      {
        id: SERVICE_A,
        company_id: COMPANY_A,
        name: "Consulting",
        sku: null,
        code: "CONSULT",
        description: null,
        unit_price_minor: "1250000",
        currency: "USD",
        unit: "hour",
        created_at: new Date(NOW).toISOString(),
        updated_at: new Date(NOW).toISOString(),
        deleted_at: null,
        version: 1,
      },
    ],
    invoices: [],
    items: [],
    numberingSettings: [],
    numberingCounters: [],
    documents: [],
    invoiceEvents: [],
    files: [],
    branding: [],
    profiles: [],
    companies: [],
    takenNumbers: [],
    failItems: false,
    raceDocumentVersion: false,
    raceInvoiceRow: null,
    raceBrandingVersion: false,
    strictPositions: false,
    inserts: [],
    updates: [],
    queries: [],
  };
}

function queryParts(query: string): Map<string, string> {
  const parts = new Map<string, string>();

  for (const piece of query.split("&")) {
    const index = piece.indexOf("=");

    if (index > 0) {
      parts.set(piece.slice(0, index), decodeURIComponent(piece.slice(index + 1)));
    }
  }

  return parts;
}

/** PostgREST answers a `bigint` as a number or a decimal string, never as a bigint; the fixture agrees. */
function wireOf(row: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const wire: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(row)) {
    wire[key] = typeof value === "bigint" ? value.toString() : value;
  }

  return wire;
}

/**
 * `invoice_items_sync_totals`, and `invoices_derive_total` after it.
 *
 * The trigger recomputes the parent's subtotal from the live lines on every row change and then the
 * invoice's own trigger derives the total. The fixture performs both, because every line write in this
 * service relies on them and none of them sends a total.
 */
function syncSubtotal(db: InvoiceDb, invoiceId: string): void {
  const parent = db.invoices.find((row) => row["id"] === invoiceId);

  if (parent === undefined) {
    return;
  }

  const subtotal = db.items
    .filter((row) => row["invoice_id"] === invoiceId && row["deleted_at"] === null)
    .reduce((total, row) => total + BigInt(String(row["line_total_minor"])), 0n);

  // `invoice_items_sync_totals` updates the parent, and that UPDATE is checked like any other: the three
  // `0022` checks run against the values it is writing. The discount one is the one that can be broken by
  // a line change - a stored flat discount larger than what the remaining lines add up to - and leaving it
  // out of the fixture is what let the gate approve that failure mode. It raises as `check_violation`,
  // which the fixture models as VALIDATION_FAILED, exactly as the catalogue trigger is modelled.
  const storedDiscount = BigInt(String(parent["discount_minor"] ?? "0"));
  const tax = BigInt(String(parent["tax_minor"] ?? "0"));

  // `0113`: the same statement resolves a percentage against the subtotal it is writing, and leaves a flat
  // amount alone. Modelled here from the stored basis rather than by calling the module's own function, so
  // an assertion comparing the two has an independent side.
  const discount =
    String(parent["discount_basis"] ?? "amount") === "percent"
      ? (subtotal * BigInt(Number(parent["discount_percent_bp"] ?? 0)) + 5_000n) / 10_000n
      : storedDiscount;

  if (discount > subtotal || tax < 0n || subtotal - discount + tax < 0n) {
    throw new AppError("VALIDATION_FAILED", { cause: { rule: "invoice", reason: "check_violation" } });
  }

  parent["subtotal_minor"] = subtotal.toString();
  parent["discount_minor"] = discount.toString();
  parent["total_minor"] = (subtotal - discount + tax).toString();
}

/**
 * `(quantity * unit_price_minor)::bigint`, as PostgreSQL computes it.
 *
 * The fixture does not call the module's own function for this, because an assertion that asked the
 * code under test what the answer was would prove nothing. The quantity arrives as the decimal text the
 * service sent, is turned into an exact `BigInt` numerator over 1000, and the cast is modelled as the
 * database performs it: round half away from zero. This is the independent side of the arithmetic
 * comparison below.
 */
function databaseLineTotal(quantity: string, unitPriceMinor: bigint, discountMinor: bigint): bigint {
  const [whole = "0", fraction = ""] = quantity.split(".");
  const thousandths = BigInt(whole) * 1_000n + BigInt(fraction.padEnd(3, "0"));
  const product = thousandths * unitPriceMinor;
  const magnitude = product < 0n ? -product : product;
  const rounded = (magnitude + 500n) / 1_000n;

  return (product < 0n ? -rounded : rounded) - discountMinor;
}

/* ---- `0115`: the rendered-document row, modelled from the migration ---- */

/** A column comparison on the wire, where a null and a missing value are the same fact. */
function sameWire(left: unknown, right: unknown): boolean {
  return String(left ?? "") === String(right ?? "");
}

/** The `0115` status vocabulary, transcribed from `invoice_documents_status_check`. */
const DOCUMENT_STATUSES = ["queued", "rendering", "ready", "failed"] as const;

/**
 * The column checks of `0115`, on the values a row will hold.
 *
 * Transcribed from the migration's `check` constraints rather than from the service under test, so a
 * service that writes a `ready` row without its four facts is refused by the fixture the way PostgreSQL
 * refuses it - and an assertion that the two agree has an independent side.
 */
function documentCheckProblem(row: Readonly<Record<string, unknown>>): string | null {
  const status = String(row["status"]);
  const fileId = row["file_id"] ?? null;
  const byteSize = row["byte_size"] ?? null;
  const hash = row["content_sha256"] ?? null;
  const renderedAt = row["rendered_at"] ?? null;
  const errorCode = row["last_error_code"] ?? null;
  const jobId = row["job_id"] ?? null;
  const generation = Number(row["generation"]);
  const attempts = Number(row["attempts"]);

  if (row["document_type"] !== "invoice_pdf") {
    return "invoice_documents_type_check";
  }

  if (!(DOCUMENT_STATUSES as readonly string[]).includes(status)) {
    return "invoice_documents_status_check";
  }

  if (!Number.isInteger(generation) || generation < 0 || generation > 1_000_000) {
    return "invoice_documents_generation_check";
  }

  if (!Number.isInteger(attempts) || attempts < 0 || attempts > 1_000) {
    return "invoice_documents_attempts_check";
  }

  // `invoice_documents_ready_check`: only a completed render may carry a document, and it carries all of it.
  if (status === "ready" && (fileId === null || byteSize === null || hash === null || renderedAt === null)) {
    return "invoice_documents_ready_check";
  }

  // `invoice_documents_render_facts_check`: the four facts are all present or all absent.
  if (
    fileId === null !== (renderedAt === null) ||
    fileId === null !== (byteSize === null) ||
    fileId === null !== (hash === null)
  ) {
    return "invoice_documents_render_facts_check";
  }

  if (status === "failed" && errorCode === null) {
    return "invoice_documents_failed_check";
  }

  // `invoice_documents_error_code_check`: a catalogue code, in the catalogue's own shape.
  if (typeof errorCode === "string" && (errorCode.length < 3 || errorCode.length > 40 || !/^[A-Z][A-Z0-9_]{2,39}$/u.test(errorCode))) {
    return "invoice_documents_error_code_check";
  }

  if (byteSize !== null && (Number(byteSize) < 1 || Number(byteSize) > 26_214_400)) {
    return "invoice_documents_size_check";
  }

  if (typeof hash === "string" && !/^[0-9a-f]{64}$/u.test(hash)) {
    return "invoice_documents_hash_check";
  }

  if (typeof jobId === "string" && (jobId.length < 1 || jobId.length > 64 || !/^[A-Za-z0-9._:-]+$/u.test(jobId))) {
    return "invoice_documents_job_check";
  }

  return null;
}

/**
 * `invoice_documents_guard_state`, as the trigger states it.
 *
 * Returns the reason the write would be refused, or null when the database would accept it. The fixture
 * runs this before it applies an update, so a service that walks a status backwards, moves a generation
 * without completing a render, or clears a failure reason on anything but a fresh request meets the same
 * refusal here that it would meet in production.
 */
function documentGuardProblem(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): string | null {
  for (const column of ["company_id", "invoice_id", "document_type"] as const) {
    if (!sameWire(before[column], after[column])) {
      return "an invoice document keeps its merchant, its invoice and its type";
    }
  }

  const beforeGeneration = Number(before["generation"]);
  const generation = Number(after["generation"]);

  if (generation < beforeGeneration) {
    return "a render generation never goes backwards";
  }

  const factsMoved =
    !sameWire(before["file_id"], after["file_id"]) ||
    !sameWire(before["byte_size"], after["byte_size"]) ||
    !sameWire(before["content_sha256"], after["content_sha256"]) ||
    !sameWire(before["rendered_at"], after["rendered_at"]);
  const arriving = before["status"] !== "ready" && after["status"] === "ready";

  if (factsMoved && !arriving) {
    return "the file facts of an invoice document change only when a render completes";
  }

  if (generation > beforeGeneration && after["status"] !== "ready") {
    return "a render generation counts completed renders only";
  }

  // A render is dated at or after the request that produced it. The guard enforces this rather than a
  // column check, because the row keeps the facts of the render it is replacing until the new one lands:
  // a re-queued document legitimately carries a `rendered_at` earlier than its own `queued_at`.
  if (
    arriving &&
    typeof after["rendered_at"] === "string" &&
    Date.parse(after["rendered_at"]) < Date.parse(String(after["queued_at"]))
  ) {
    return "a render is dated at or after the request that produced it";
  }

  const from = String(before["status"]);
  const to = String(after["status"]);
  const beforeAttempts = Number(before["attempts"]);
  const attempts = Number(after["attempts"]);

  if (from === to) {
    if (attempts < beforeAttempts) {
      return "an attempt count never goes backwards";
    }
  } else if (
    !(
      (from === "queued" && (to === "rendering" || to === "failed")) ||
      (from === "rendering" && (to === "ready" || to === "failed")) ||
      (from === "failed" && (to === "queued" || to === "rendering")) ||
      (from === "ready" && to === "queued")
    )
  ) {
    return "an invoice document status walks queued, rendering, ready or failed";
  }

  if (to === "queued" && from !== "queued") {
    if (attempts > 0) {
      return "a fresh render request starts at zero attempts";
    }
  } else if (attempts < beforeAttempts) {
    return "an attempt count never goes backwards";
  } else if (before["last_error_code"] !== null && after["last_error_code"] === null) {
    return "a failure reason is kept until the next render request";
  }

  if (before["deleted_at"] !== null && !sameWire(before["deleted_at"], after["deleted_at"])) {
    return "a removed invoice document stays removed";
  }

  return null;
}

/** `0057`'s status walk, so a file row of a render cannot be pushed backwards by a fixture bug. */
const FILE_STATUS_WALK: Readonly<Record<string, readonly string[]>> = {
  pending: ["ready", "quarantined"],
  ready: ["quarantined", "archived"],
  quarantined: ["archived"],
  archived: [],
  deleted: [],
};

/** The tables this gate models, so a service that touched a fourth would be caught rather than guessed. */
const MODELLED_TABLES = [
  "clients",
  "products",
  "services",
  "invoices",
  "invoice_items",
  "invoice_events",
  "invoice_number_settings",
  "invoice_number_counters",
  "invoice_documents",
  "files",
  "invoice_branding",
  "business_profiles",
  "companies",
] as const;

/**
 * `invoice_number_last_used`, as SQL computes it: the largest numeric tail among a merchant's live numbers.
 *
 * Written once here rather than twice inside the rpc stub, and written from the SQL rather than from the
 * module under test, so a comparison between the two is a comparison and not a tautology. A number with no
 * trailing digits - a hand-corrected invoice, one imported from another system - contributes nothing.
 */
function highestPrinted(db: InvoiceDb, companyId: string): bigint {
  let highest = 0n;

  for (const row of db.invoices) {
    const number = row["number"];

    if (row["company_id"] !== companyId || row["deleted_at"] !== null || typeof number !== "string") {
      continue;
    }

    const tail = /([0-9]+)$/u.exec(number)?.[1];

    if (tail !== undefined && BigInt(tail) > highest) {
      highest = BigInt(tail);
    }
  }

  return highest;
}

function rowsOf(db: InvoiceDb, table: string): Array<Record<string, unknown>> {
  switch (table) {
    case "clients":
      return db.clients;
    case "products":
      return db.products;
    case "services":
      return db.services;
    case "invoices":
      return db.invoices;
    case "invoice_items":
      return db.items;
    case "invoice_number_settings":
      return db.numberingSettings;
    case "invoice_number_counters":
      return db.numberingCounters;
    case "invoice_documents":
      return db.documents;
    case "files":
      return db.files;
    case "invoice_branding":
      return db.branding;
    case "business_profiles":
      return db.profiles;
    case "companies":
      return db.companies;
    default:
      throw new Error(`the invoice service touches no table the gate does not model: ${table}`);
  }
}

function createInvoiceRest(db: InvoiceDb): RestClient {
  return {
    select<TRow>(table: string, query: string, schema: z.ZodType<TRow>): Promise<readonly TRow[]> {
      db.queries.push(`${table}?${query}`);

      if (!(MODELLED_TABLES as readonly string[]).includes(table)) {
        return Promise.reject(new Error(`an unmodelled table was read: ${table}`));
      }

      const parts = queryParts(query);
      // `companies` *is* the tenant: it has no company_id column, so the scope a read of it owes is its own
      // primary key. Every other table here is scoped by company_id, and a read that omits either is a bug
      // the fixture refuses rather than quietly answering with another merchant's rows.
      const scopeColumn = table === "companies" ? "id" : "company_id";
      const company = parts.get(scopeColumn);

      if (company === undefined || !company.startsWith("eq.")) {
        return Promise.reject(new Error(`a read is not scoped to one company: ${query}`));
      }

      const companyId = company.slice(3);
      let matched = rowsOf(db, table).filter((row) => row[scopeColumn] === companyId);

      for (const [key, value] of parts) {
        if (key === "select" || key === "order" || key === "limit" || key === "offset" || key === "or") {
          continue;
        }

        if (value === "is.null") {
          matched = matched.filter((row) => row[key] === null);
        } else if (value.startsWith("eq.")) {
          matched = matched.filter((row) => row[key] === value.slice(3));
        }
      }

      const order = parts.get("order");

      if (order !== undefined) {
        const [column = "", direction = "asc"] = order.split(",")[0]?.split(".") ?? [];

        matched = [...matched].sort((left, right) => {
          const a = String(left[column] ?? "");
          const b = String(right[column] ?? "");
          const comparison = a < b ? -1 : a > b ? 1 : 0;

          return direction === "desc" ? -comparison : comparison;
        });
      }

      const limit = parts.get("limit");

      if (limit !== undefined) {
        matched = matched.slice(0, Number.parseInt(limit, 10));
      }

      const selection = parts.get("select");
      const projected =
        selection === undefined
          ? matched
          : matched.map((row) => {
              const values: Record<string, unknown> = {};

              for (const column of selection.split(",")) {
                values[column] = row[column] ?? null;
              }

              return values;
            });

      return Promise.resolve(projected.map((row) => schema.parse(row)));
    },
    insert(table: string, rows: readonly Readonly<Record<string, unknown>>[]): Promise<void> {
      db.inserts.push({ table, rows });

      // `0114`'s settings row is created on the merchant's first save rather than at sign-up.
      if (table === "invoice_number_settings") {
        for (const row of rows) {
          // `wireOf` is what a REST round trip does to the row: a bigint leaves as decimal text, so the
          // fixture stores text rather than the caller's bigint and the reader validates what it would see.
          const created: Record<string, unknown> = wireOf({
            id: randomUUID(),
            created_at: new Date(NOW + db.numberingSettings.length).toISOString(),
            updated_at: new Date(NOW + db.numberingSettings.length).toISOString(),
            deleted_at: null,
            version: 1,
            ...row,
          });

          // `invoice_number_settings_company_key`.
          if (db.numberingSettings.some((candidate) => candidate["company_id"] === created["company_id"])) {
            return Promise.reject(new AppError("CONFLICT"));
          }

          db.numberingSettings.push(created);
        }

        return Promise.resolve();
      }

      // `0116`'s branding row, created on a merchant's first save, exactly like `0114`'s series row.
      if (table === "invoice_branding") {
        for (const row of rows) {
          const created: Record<string, unknown> = wireOf({
            id: randomUUID(),
            created_at: new Date(NOW + db.branding.length).toISOString(),
            updated_at: new Date(NOW + db.branding.length).toISOString(),
            deleted_at: null,
            version: 1,
            ...row,
          });

          // `invoice_branding_company_key`: one merchant has one brand.
          if (db.branding.some((candidate) => candidate["company_id"] === created["company_id"])) {
            return Promise.reject(new AppError("CONFLICT"));
          }

          db.branding.push(created);
        }

        return Promise.resolve();
      }

      // `0024`: the timeline. The real table is append-only; this branch models the append side, and
      // the update path below refuses the other two, which is the guard the table carries.
      if (table === "invoice_events") {
        for (const row of rows) {
          // `0024`'s checks, with `0120`'s word in the vocabulary: the timeline writes only words and
          // actors the migrations know, a system move names no person, and a detail is bounded and
          // already trimmed.
          if (!(INVOICE_EVENT_TYPES as readonly string[]).includes(String(row["type"]))) {
            return Promise.reject(new AppError("VALIDATION_FAILED", { cause: { rule: "invoice_events_type_check" } }));
          }

          if (!(INVOICE_EVENT_ACTORS as readonly string[]).includes(String(row["actor"]))) {
            return Promise.reject(new AppError("VALIDATION_FAILED", { cause: { rule: "invoice_events_actor_check" } }));
          }

          if (row["actor"] === "system" && row["actor_user_id"] !== null && row["actor_user_id"] !== undefined) {
            return Promise.reject(
              new AppError("VALIDATION_FAILED", { cause: { rule: "invoice_events_actor_user_check" } }),
            );
          }

          const detail = row["detail"];

          if (
            detail !== null &&
            detail !== undefined &&
            (typeof detail !== "string" ||
              detail.trim().length < 1 ||
              detail.trim().length > 500 ||
              detail !== detail.trim())
          ) {
            return Promise.reject(new AppError("VALIDATION_FAILED", { cause: { rule: "invoice_events_detail_check" } }));
          }

          db.invoiceEvents.push({
            id: randomUUID(),
            created_at: new Date(NOW).toISOString(),
            updated_at: new Date(NOW).toISOString(),
            deleted_at: null,
            version: 1,
            ...row,
          });
        }

        return Promise.resolve();
      }

      if (table !== "invoice_items") {
        return Promise.reject(new Error(`the invoice service inserts lines by themselves: ${table}`));
      }

      if (db.failItems) {
        // `invoice_items_guard_catalogue` raises a check_violation, which the REST layer reports as
        // VALIDATION_FAILED. The fixture does the same rather than inventing a different code.
        return Promise.reject(new AppError("VALIDATION_FAILED"));
      }

      const invoiceId = String(rows[0]?.["invoice_id"] ?? "");
      const parent = db.invoices.find((row) => row["id"] === invoiceId);

      if (parent === undefined) {
        return Promise.reject(new AppError("VALIDATION_FAILED"));
      }

      for (const row of rows) {
        const unitPriceMinor = BigInt(String(row["unit_price_minor"]));
        const discountMinor = BigInt(String(row["discount_minor"] ?? "0"));
        const lineTotal = databaseLineTotal(String(row["quantity"]), unitPriceMinor, discountMinor);

        // `invoice_items_discount_check`: the discount never exceeds the rounded gross.
        if (discountMinor > lineTotal + discountMinor) {
          return Promise.reject(new AppError("VALIDATION_FAILED"));
        }

        // `invoice_items_guard_catalogue`: a product or a service from another merchant cannot be billed.
        for (const column of ["product_id", "service_id"] as const) {
          const reference = row[column];

          if (typeof reference === "string") {
            const catalogue = column === "product_id" ? db.products : db.services;
            const found = catalogue.some(
              (entry) => entry["id"] === reference && entry["company_id"] === row["company_id"],
            );

            if (!found) {
              return Promise.reject(new AppError("VALIDATION_FAILED"));
            }
          }
        }

        db.items.push({
          id: randomUUID(),
          deleted_at: null,
          version: 1,
          created_at: new Date(NOW).toISOString(),
          updated_at: new Date(NOW).toISOString(),
          line_total_minor: lineTotal.toString(),
          ...wireOf(row),
        });
      }

      // `invoice_items_sync_totals` sums the live lines into the parent, and `invoices_derive_total`
      // turns that into the total. The fixture performs both, because the service relies on them.
      const subtotal = db.items
        .filter((row) => row["invoice_id"] === invoiceId && row["deleted_at"] === null)
        .reduce((total, row) => total + BigInt(String(row["line_total_minor"])), 0n);

      parent["subtotal_minor"] = subtotal.toString();
      parent["total_minor"] = (
        subtotal -
        BigInt(String(parent["discount_minor"])) +
        BigInt(String(parent["tax_minor"]))
      ).toString();

      return Promise.resolve();
    },
    insertReturning<TRow>(
      table: string,
      rows: readonly Readonly<Record<string, unknown>>[],
      schema: z.ZodType<TRow>,
    ): Promise<readonly TRow[]> {
      db.inserts.push({ table, rows });

      if (table === "invoice_items") {
        // The editor adds one line per request and reads it back for its generated total.
        const row = rows[0];

        if (rows.length !== 1 || row === undefined) {
          return Promise.reject(new Error("a line is added one at a time"));
        }

        const parent = db.invoices.find((candidate) => candidate["id"] === row["invoice_id"]);

        if (parent === undefined || parent["company_id"] !== row["company_id"]) {
          return Promise.reject(new AppError("VALIDATION_FAILED"));
        }

        // The draft lock, as `invoice_items_sync_totals` states it.
        if (parent["status"] !== "draft") {
          return Promise.reject(new AppError("CONFLICT"));
        }

        const unitPriceMinor = BigInt(String(row["unit_price_minor"]));
        const discountMinor = BigInt(String(row["discount_minor"] ?? "0"));
        const lineTotal = databaseLineTotal(String(row["quantity"]), unitPriceMinor, discountMinor);
        const position = Number(row["position"]);

        // `invoice_items_position_key` and `invoice_items_position_check`.
        if (position < 1 || db.items.some((existing) => existing["invoice_id"] === row["invoice_id"] && existing["deleted_at"] === null && existing["position"] === position)) {
          return Promise.reject(new AppError("CONFLICT"));
        }

        for (const column of ["product_id", "service_id"] as const) {
          const reference = row[column];

          if (typeof reference === "string") {
            const catalogue = column === "product_id" ? db.products : db.services;

            if (!catalogue.some((entry) => entry["id"] === reference && entry["company_id"] === row["company_id"])) {
              return Promise.reject(new AppError("VALIDATION_FAILED"));
            }
          }
        }

        const stored: Record<string, unknown> = {
          id: randomUUID(),
          deleted_at: null,
          version: 1,
          created_at: new Date(NOW + db.items.length).toISOString(),
          updated_at: new Date(NOW + db.items.length).toISOString(),
          line_total_minor: lineTotal.toString(),
          ...wireOf(row),
        };

        db.items.push(stored);
        syncSubtotal(db, String(row["invoice_id"]));

        return Promise.resolve([schema.parse(stored)]);
      }

      if (table === "invoice_documents") {
        const row = rows[0];

        if (rows.length !== 1 || row === undefined) {
          return Promise.reject(new Error("a rendered-document row is written one at a time"));
        }

        // `invoice_documents_one_live_per_invoice`: one live row per invoice, so two clicks cannot leave
        // two documents competing to be the PDF.
        if (
          db.documents.some(
            (existing) => existing["invoice_id"] === row["invoice_id"] && existing["deleted_at"] === null,
          )
        ) {
          return Promise.reject(new AppError("CONFLICT", { cause: { code: "23505" } }));
        }

        // `invoice_documents_invoice_fkey` is the composite key of `0022`: the pair has to exist as a pair,
        // so a document of another merchant's invoice is not a row the database will hold.
        const parent = db.invoices.find(
          (candidate) => candidate["id"] === row["invoice_id"] && candidate["company_id"] === row["company_id"],
        );

        if (parent === undefined) {
          return Promise.reject(new AppError("VALIDATION_FAILED"));
        }

        const createdAt = new Date(NOW + db.documents.length).toISOString();
        const stored: Record<string, unknown> = wireOf({
          id: randomUUID(),
          document_type: "invoice_pdf",
          status: "queued",
          generation: 0,
          attempts: 0,
          file_id: null,
          byte_size: null,
          content_sha256: null,
          rendered_at: null,
          queued_at: createdAt,
          last_error_code: null,
          requested_by: null,
          job_id: null,
          created_at: createdAt,
          updated_at: createdAt,
          deleted_at: null,
          version: 1,
          ...row,
        });

        const problem = documentCheckProblem(stored);

        if (problem !== null) {
          return Promise.reject(new AppError("VALIDATION_FAILED", { cause: { rule: problem } }));
        }

        db.documents.push(stored);

        return Promise.resolve([schema.parse(stored)]);
      }

      if (table === "files") {
        const row = rows[0];

        if (rows.length !== 1 || row === undefined) {
          return Promise.reject(new Error("a file record is written one at a time"));
        }

        // `files_storage_key_key`: one object is one row forever, soft delete included.
        if (db.files.some((existing) => existing["storage_key"] === row["storage_key"])) {
          return Promise.reject(new AppError("CONFLICT", { cause: { code: "23505" } }));
        }

        // `files_storage_key_check`: the key sits under the merchant's own prefix.
        if (!String(row["storage_key"] ?? "").startsWith(`${String(row["company_id"])}/`)) {
          return Promise.reject(new AppError("VALIDATION_FAILED"));
        }

        const createdAt = new Date(NOW + db.files.length).toISOString();
        const stored: Record<string, unknown> = wireOf({
          id: randomUUID(),
          magic_byte_verified: false,
          verified_at: null,
          quarantined_reason: null,
          deleted_at: null,
          version: 1,
          created_at: createdAt,
          updated_at: createdAt,
          ...row,
        });

        db.files.push(stored);

        return Promise.resolve([schema.parse(stored)]);
      }

      if (table !== "invoices") {
        return Promise.reject(new Error(`return=representation is used for invoices, lines and documents only: ${table}`));
      }

      for (const row of rows) {
        // `invoices_derive_total` owns the total; the fixture derives it so a service that sent its own
        // would be caught by the assertion that no money column is written here.
        const stored: Record<string, unknown> = {
          id: randomUUID(),
          number: null,
          status: "draft",
          subtotal_minor: "0",
          discount_minor: "0",
          // `0112`'s defaults: every row written before the basis existed was a flat amount.
          discount_basis: "amount",
          discount_percent_bp: 0,
          tax_minor: "0",
          amount_paid_minor: "0",
          issued_at: null,
          first_viewed_at: null,
          paid_at: null,
          voided_at: null,
          deleted_at: null,
          version: 1,
          created_at: new Date(NOW + db.invoices.length).toISOString(),
          updated_at: new Date(NOW + db.invoices.length).toISOString(),
          client_email: null,
          client_address: null,
          memo: null,
          ...wireOf(row),
        };

        // `invoices_derive_total`, before the row is read back: total = subtotal - discount + tax.
        stored["total_minor"] = (
          BigInt(String(stored["subtotal_minor"])) -
          BigInt(String(stored["discount_minor"])) +
          BigInt(String(stored["tax_minor"]))
        ).toString();

        // `invoices_status_money_check` and `invoices_issue_check`, as the migration states them.
        if (stored["status"] === "draft" && (stored["number"] !== null || stored["issued_at"] !== null)) {
          return Promise.reject(new AppError("VALIDATION_FAILED"));
        }

        // `invoices_discount_check`, enforced on the insert exactly as the database enforces it: the
        // discount may never exceed the subtotal, and a row being inserted has no lines yet, so its
        // subtotal is the column default of zero. An insert carrying any discount is refused here - which
        // is why the service applies the invoice-level discount in a second write.
        if (BigInt(String(stored["discount_minor"])) > BigInt(String(stored["subtotal_minor"]))) {
          return Promise.reject(new AppError("VALIDATION_FAILED"));
        }

        if (BigInt(String(stored["total_minor"])) < 0n) {
          return Promise.reject(new AppError("VALIDATION_FAILED"));
        }

        db.invoices.push(stored);

        return Promise.resolve([schema.parse(stored)]);
      }

      return Promise.reject(new Error("insertReturning needs one row"));
    },
    update(table: string, query: string, values: Readonly<Record<string, unknown>>): Promise<void> {
      db.updates.push({ table, query, values: { ...values } });

      if (table === "invoice_items") {
        const parts = queryParts(query);
        const id = parts.get("id");
        const company = parts.get("company_id");
        const invoice = parts.get("invoice_id");
        const liveOnly = parts.get("deleted_at") === "is.null";

        if (id === undefined || company === undefined) {
          return Promise.reject(new Error(`a line update is not scoped to one row of one company: ${query}`));
        }

        const row = db.items.find(
          (candidate) =>
            candidate["id"] === id.slice(3) &&
            candidate["company_id"] === company.slice(3) &&
            (invoice === undefined || candidate["invoice_id"] === invoice.slice(3)) &&
            (!liveOnly || candidate["deleted_at"] === null),
        );

        if (row === undefined) {
          return Promise.resolve();
        }

        const parent = db.invoices.find((candidate) => candidate["id"] === row["invoice_id"]);

        // The draft lock, as the trigger states it: a line of an issued invoice cannot move.
        if (parent !== undefined && parent["status"] !== "draft") {
          return Promise.reject(new AppError("CONFLICT"));
        }

        // The unique index, over the live rows of one invoice, checked on **every** statement because
        // `invoice_items_position_key` is not deferrable. `strictPositions` makes the gate assert that no
        // intermediate write of a swap ever leaves two live rows holding one position.
        const nextPosition = values["position"];

        if (typeof nextPosition === "number") {
          if (nextPosition < 1) {
            return Promise.reject(new AppError("VALIDATION_FAILED"));
          }

          const clash = db.items.some(
            (candidate) =>
              candidate !== row &&
              candidate["invoice_id"] === row["invoice_id"] &&
              candidate["deleted_at"] === null &&
              candidate["position"] === nextPosition,
          );

          if (clash) {
            return Promise.reject(new AppError("CONFLICT"));
          }
        }

        if (db.strictPositions) {
          // The whole table, after the write: a live row's position must be unique within its invoice.
          const seen = new Map<string, number>();

          for (const candidate of [...db.items.filter((entry) => entry !== row), { ...row, ...wireOf(values) }]) {
            if (candidate["deleted_at"] !== null) {
              continue;
            }

            const key = `${String(candidate["invoice_id"])}:${String(candidate["position"])}`;

            seen.set(key, (seen.get(key) ?? 0) + 1);
          }

          for (const [key, count] of seen) {
            if (count > 1) {
              return Promise.reject(new Error(`invoice_items_position_key would be violated after this write: ${key}`));
            }
          }
        }

        const merged: Record<string, unknown> = { ...row, ...wireOf(values) };

        if (values["quantity"] !== undefined || values["unit_price_minor"] !== undefined || values["discount_minor"] !== undefined) {
          merged["line_total_minor"] = databaseLineTotal(
            String(merged["quantity"]),
            BigInt(String(merged["unit_price_minor"])),
            BigInt(String(merged["discount_minor"] ?? "0")),
          ).toString();
        }

        Object.assign(row, merged, {
          updated_at: new Date(NOW + 20_000).toISOString(),
          version: Number(row["version"]) + 1,
        });
        syncSubtotal(db, String(row["invoice_id"]));

        return Promise.resolve();
      }

      // `0114`'s settings row, updated on a merchant's later save. Scoped to the company as every other
      // write here is, so a query that forgot the scope would update nothing rather than the wrong row.
      if (table === "invoice_number_settings") {
        const parts = queryParts(query);
        const id = parts.get("id")?.slice(3);
        const company = parts.get("company_id")?.slice(3);
        const row = db.numberingSettings.find(
          (candidate) => candidate["id"] === id && candidate["company_id"] === company,
        );

        if (row === undefined) {
          return Promise.reject(
            new Error(`an invoice_number_settings update is not scoped to one row of one company: ${query}`),
          );
        }

        Object.assign(row, wireOf(values), {
          updated_at: new Date(NOW + 30_000).toISOString(),
          version: Number(row["version"]) + 1,
        });

        return Promise.resolve();
      }

      // `0116`'s row on a merchant's later save, with the optimistic lock rule 13 asks for: the version in
      // the filter, so a write that lost a race matches nothing and the service reads the winner back.
      if (table === "invoice_branding") {
        const parts = queryParts(query);
        const id = parts.get("id")?.slice(3);
        const company = parts.get("company_id")?.slice(3);
        const version = parts.get("version")?.slice(3);

        if (id === undefined || company === undefined) {
          return Promise.reject(new Error(`a branding update is not scoped to one row of one company: ${query}`));
        }

        const row = db.branding.find(
          (candidate) =>
            candidate["id"] === id &&
            candidate["company_id"] === company &&
            (parts.get("deleted_at") !== "is.null" || candidate["deleted_at"] === null),
        );

        if (row === undefined || (version !== undefined && String(row["version"]) !== version)) {
          return Promise.resolve();
        }

        if (db.raceBrandingVersion) {
          db.raceBrandingVersion = false;

          Object.assign(row, {
            tagline: "the other owner's tagline",
            updated_at: new Date(NOW + 5_000).toISOString(),
            version: Number(row["version"]) + 1,
          });

          return Promise.resolve();
        }

        // `invoice_branding_set_row_metadata`, which is `set_row_metadata()`.
        Object.assign(row, wireOf(values), {
          updated_at: new Date(NOW + 30_000).toISOString(),
          version: Number(row["version"]) + 1,
        });

        return Promise.resolve();
      }

      if (table === "invoice_documents") {
        const parts = queryParts(query);
        const id = parts.get("id");
        const company = parts.get("company_id");
        const version = parts.get("version");

        if (id === undefined || company === undefined) {
          return Promise.reject(new Error(`a document update is not scoped to one row of one company: ${query}`));
        }

        const row = db.documents.find(
          (candidate) =>
            candidate["id"] === id.slice(3) &&
            candidate["company_id"] === company.slice(3) &&
            (parts.get("deleted_at") !== "is.null" || candidate["deleted_at"] === null),
        );

        // PostgREST reports success for an update that matched nothing, which is the whole point of the
        // version in the query: the loser of a race writes nothing and reads the winner's row back.
        if (row === undefined) {
          return Promise.resolve();
        }

        if (version !== undefined && String(row["version"]) !== version.slice(3)) {
          return Promise.resolve();
        }

        // The race the optimistic lock exists for: another request moves the row first, once, so the
        // write this service is about to send matches nothing.
        if (db.raceDocumentVersion) {
          db.raceDocumentVersion = false;

          Object.assign(row, {
            status: "queued",
            attempts: 0,
            last_error_code: null,
            queued_at: new Date(NOW + 5_000).toISOString(),
            updated_at: new Date(NOW + 5_000).toISOString(),
            version: Number(row["version"]) + 1,
          });

          return Promise.resolve();
        }

        const after: Record<string, unknown> = { ...row, ...wireOf(values) };
        const guarded = documentGuardProblem(row, after) ?? documentCheckProblem(after);

        if (guarded !== null) {
          return Promise.reject(new AppError("VALIDATION_FAILED", { cause: { rule: "check_violation", reason: guarded } }));
        }

        // `invoice_documents_set_row_metadata`, which is `set_row_metadata()`.
        Object.assign(row, wireOf(values), {
          updated_at: new Date(NOW + 10_000).toISOString(),
          version: Number(row["version"]) + 1,
        });

        return Promise.resolve();
      }

      if (table === "files") {
        const parts = queryParts(query);
        const id = parts.get("id");
        const company = parts.get("company_id");

        if (id === undefined || company === undefined) {
          return Promise.reject(new Error(`a file update is not scoped to one row of one company: ${query}`));
        }

        const row = db.files.find(
          (candidate) =>
            candidate["id"] === id.slice(3) &&
            candidate["company_id"] === company.slice(3) &&
            (parts.get("deleted_at") !== "is.null" || candidate["deleted_at"] === null),
        );

        if (row === undefined) {
          return Promise.resolve();
        }

        const next: Record<string, unknown> = { ...row, ...wireOf(values) };

        // `files_guard_state`, transcribed: the bytes' identity is frozen once the record exists.
        for (const column of [
          "company_id",
          "uploaded_by",
          "purpose",
          "storage_provider",
          "storage_bucket",
          "storage_key",
          "content_type",
          "byte_size",
          "content_sha256",
          "encryption_algorithm",
          "encryption_key_version",
          "ciphertext_iv",
          "ciphertext_tag",
        ] as const) {
          if (!sameWire(next[column], row[column])) {
            return Promise.reject(
              new AppError("VALIDATION_FAILED", { cause: { rule: "files_guard_state", reason: column } }),
            );
          }
        }

        if (row["magic_byte_verified"] === true && next["magic_byte_verified"] !== true) {
          return Promise.reject(new AppError("VALIDATION_FAILED", { cause: { rule: "files_guard_state", reason: "magic_byte_verified" } }));
        }

        if (row["verified_at"] !== null && !sameWire(next["verified_at"], row["verified_at"])) {
          return Promise.reject(new AppError("VALIDATION_FAILED", { cause: { rule: "files_guard_state", reason: "verified_at" } }));
        }

        if (!sameWire(next["status"], row["status"])) {
          const allowed = FILE_STATUS_WALK[String(row["status"])] ?? [];

          // A quarantined file archives only on a verdict it already carries.
          if (
            !allowed.includes(String(next["status"])) ||
            (row["status"] === "quarantined" && row["magic_byte_verified"] !== true)
          ) {
            return Promise.reject(new AppError("VALIDATION_FAILED", { cause: { rule: "files_guard_state", reason: "status" } }));
          }
        }

        if (row["quarantined_reason"] !== null && !sameWire(next["quarantined_reason"], row["quarantined_reason"])) {
          return Promise.reject(new AppError("VALIDATION_FAILED", { cause: { rule: "files_guard_state", reason: "quarantined_reason" } }));
        }

        if (row["deleted_at"] !== null) {
          return Promise.reject(new AppError("VALIDATION_FAILED", { cause: { rule: "files_guard_state", reason: "deleted" } }));
        }

        Object.assign(row, wireOf(values), {
          updated_at: new Date(NOW + 10_000).toISOString(),
          version: Number(row["version"]) + 1,
        });

        return Promise.resolve();
      }

      if (table === "invoice_events") {
        // `invoice_events_guard_append_only`: the timeline is evidence, and evidence that can be edited
        // is not evidence.
        return Promise.reject(new AppError("CONFLICT", { cause: { rule: "invoice_events_guard_append_only" } }));
      }

      if (table !== "invoices") {
        return Promise.reject(new Error(`the invoice service updates no other table: ${table}`));
      }

      const parts = queryParts(query);
      const id = parts.get("id");
      const company = parts.get("company_id");
      const status = parts.get("status");

      if (id === undefined || company === undefined) {
        return Promise.reject(new Error(`an invoice update is not scoped to one row of one company: ${query}`));
      }

      const row = db.invoices.find(
        (candidate) => candidate["id"] === id.slice(3) && candidate["company_id"] === company.slice(3),
      );

      // The race the guard exists for: another worker moves the row first, once, so the write this
      // service is about to send matches nothing and the service has to read the winner's state back.
      if (db.raceInvoiceRow !== null && row !== undefined) {
        Object.assign(row, db.raceInvoiceRow, { version: Number(row["version"]) + 1 });
        db.raceInvoiceRow = null;
      }

      if (row === undefined || (status !== undefined && row["status"] !== status.slice(3))) {
        return Promise.resolve();
      }

      // `invoices_guard_paid`, exactly as the trigger states it: a paid row is frozen, the two metadata
      // columns the row-metadata trigger owns excepted. The service answers this refusal before it ever
      // reaches the database; the trigger is what the fixture proves the service cannot out-run.
      if (row["status"] === "paid") {
        const touched = Object.keys(values).filter((key) => key !== "updated_at" && key !== "version");

        if (touched.length > 0) {
          return Promise.reject(new AppError("CONFLICT", { cause: { rule: "invoices_guard_paid" } }));
        }
      }

      const next: Record<string, unknown> = { ...row, ...wireOf(values) };

      // The checks a status write can break: `invoices_issue_check`'s trio (an issued state carries the
      // number and the issue instant, a draft carries neither), and the two instant checks that tie
      // `paid_at` and `voided_at` to their states.
      const issuedStates = ["sent", "viewed", "partially_paid", "paid", "overdue"];

      if (issuedStates.includes(String(next["status"])) && (next["number"] === null || next["issued_at"] === null)) {
        return Promise.reject(new AppError("CONFLICT", { cause: { rule: "invoices_issue_check" } }));
      }

      if (next["status"] === "draft" && (next["number"] !== null || next["issued_at"] !== null)) {
        return Promise.reject(new AppError("CONFLICT", { cause: { rule: "invoices_issue_check" } }));
      }

      if ((next["status"] === "void") !== (next["voided_at"] !== null)) {
        return Promise.reject(new AppError("CONFLICT", { cause: { rule: "invoices_voided_instant_check" } }));
      }

      if ((next["status"] === "paid") !== (next["paid_at"] !== null)) {
        return Promise.reject(new AppError("CONFLICT", { cause: { rule: "invoices_paid_instant_check" } }));
      }

      const subtotal = BigInt(String(next["subtotal_minor"]));
      const discount = BigInt(String(next["discount_minor"]));
      const tax = BigInt(String(next["tax_minor"]));

      // `invoices_discount_check`, `invoices_tax_check` and `invoices_total_check`, on the values the row
      // will hold after the update. `invoices_derive_total` runs before the check, as the trigger does.
      if (discount < 0n || discount > subtotal) {
        return Promise.reject(new AppError("VALIDATION_FAILED"));
      }

      if (tax < 0n || subtotal - discount + tax < 0n) {
        return Promise.reject(new AppError("VALIDATION_FAILED"));
      }

      // `0112`'s three checks. A row cannot say it is a percentage discount without a percentage, cannot
      // carry a percentage above a hundred percent, and cannot say it is a flat amount while carrying a
      // percentage. Without these the fixture would approve exactly the incoherent rows the columns exist
      // to refuse.
      const basis = String(next["discount_basis"] ?? "amount");
      const basisPoints = Number(next["discount_percent_bp"] ?? 0);

      if (basis !== "amount" && basis !== "percent") {
        return Promise.reject(new AppError("VALIDATION_FAILED"));
      }

      if (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > 10_000) {
        return Promise.reject(new AppError("VALIDATION_FAILED"));
      }

      if (!((basis === "percent" && basisPoints > 0) || (basis === "amount" && basisPoints === 0))) {
        return Promise.reject(new AppError("VALIDATION_FAILED"));
      }

      Object.assign(row, wireOf(values), {
        total_minor: (subtotal - discount + tax).toString(),
        updated_at: new Date(NOW + 10_000).toISOString(),
        version: Number(row["version"]) + 1,
      });

      return Promise.resolve();
    },
    rpc(functionName: string, arguments_: Readonly<Record<string, unknown>> = {}): Promise<unknown> {
      // `0114`'s two functions, modelled from the SQL rather than by calling the module under test, so an
      // assertion comparing the two has an independent side.
      if (functionName === "invoice_number_last_used") {
        // PostgREST answers a scalar function with the scalar itself.
        return Promise.resolve(highestPrinted(db, String(arguments_["p_company_id"] ?? "")).toString());
      }

      if (functionName === "take_invoice_number") {
        const company = String(arguments_["p_company_id"] ?? "");
        const at = Date.parse(String(arguments_["p_at"] ?? ""));

        if (!Number.isFinite(at)) {
          return Promise.reject(new AppError("VALIDATION_FAILED"));
        }

        const settings = db.numberingSettings.find(
          (row) => row["company_id"] === company && row["deleted_at"] === null,
        );
        const prefix = typeof settings?.["prefix"] === "string" ? settings["prefix"] : "INV";
        const next = settings === undefined ? 1n : BigInt(String(settings["next_number"]));
        const padding = settings === undefined ? 5 : Number(settings["padding"]);
        const yearly = settings?.["yearly"] === true;
        const resetMonth = settings === undefined ? null : (settings["reset_month"] as number | null);

        // `invoice_number_period`, restated: the series rolls over in the reset month.
        const month = new Date(at).getUTCMonth() + 1;
        const year = new Date(at).getUTCFullYear();
        const period =
          !yearly ? 0 : month >= (resetMonth ?? 1) ? year : year - 1;

        // The clamp `0114` applies: a fresh counter starts above the highest number already printed, so a
        // merchant with imported history is not blocked from issuing at all.
        const startAt = highestPrinted(db, company) + 1n > next ? highestPrinted(db, company) + 1n : next;

        let counter = db.numberingCounters.find((row) => row["company_id"] === company);

        if (counter === undefined) {
          counter = {
            id: randomUUID(),
            company_id: company,
            period_key: period,
            last_number: String(startAt),
            deleted_at: null,
            version: 1,
          };
          db.numberingCounters.push(counter);
        } else if (Number(counter["period_key"]) === period) {
          counter["last_number"] = (BigInt(String(counter["last_number"])) + 1n).toString();
        } else {
          // A counter from an earlier period restarts at the merchant's `next_number`, which is what the
          // `else excluded.last_number` branch of the `on conflict` does.
          counter["period_key"] = period;
          counter["last_number"] = startAt.toString();
        }

        const taken = BigInt(String(counter["last_number"]));

        // The take refuses a number already printed, exactly as the function's `check_violation` does.
        const lastUsed = highestPrinted(db, company);

        if (taken <= lastUsed) {
          return Promise.reject(new AppError("VALIDATION_FAILED", { cause: { rule: "reused" } }));
        }

        const printed = `${prefix}-${taken.toString().padStart(padding, "0")}`;

        if (printed.length < 3 || printed.length > 40 || !/^[A-Z0-9][A-Z0-9._/-]{2,39}$/u.test(printed)) {
          return Promise.reject(new AppError("VALIDATION_FAILED", { cause: { rule: "unprintable" } }));
        }

        db.takenNumbers.push(printed);

        return Promise.resolve([{ number: printed, sequence_number: taken.toString(), period_key: period }]);
      }

      return Promise.reject(new Error(`the invoice service calls no rpc named ${functionName}`));
    },
  };
}

function depsOf(db: InvoiceDb, audit: AuditTrail = createInMemoryAuditTrail()): InvoiceDependencies {
  return { rest: createInvoiceRest(db), audit, now: () => NOW };
}

/** The same fixture, for the line editor's narrower dependency type. */
function lineDepsOf(db: InvoiceDb, audit: AuditTrail = createInMemoryAuditTrail()): InvoiceLineDependencies {
  return { rest: createInvoiceRest(db), audit, now: () => NOW };
}

/** The live lines of an invoice, read straight from the fixture, for assertions about the stored order. */
async function readLiveLinesForTest(db: InvoiceDb, invoiceId: string) {
  return createInvoiceRest(db).select(
    "invoice_items",
    `select=id,company_id,invoice_id,position,description,unit,quantity,unit_price_minor,discount_minor,line_total_minor,product_id,service_id,created_at,updated_at,deleted_at,version&invoice_id=eq.${invoiceId}&company_id=eq.${at(db.invoices, 0, "the invoice")["company_id"] as string}&deleted_at=is.null&order=position.asc`,
    invoiceLineRowSchema,
  );
}

/** The error code a line write answered with, or null when it succeeded. */
async function lineCodeOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();

    return null;
  } catch (error) {
    return isAppError(error) ? error.code : "not-an-app-error";
  }
}

/** A body with one good line, which every case below starts from and perturbs. */
function bodyOf(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    client_id: CLIENT_A,
    currency: "USD",
    due_at: new Date(NOW + 20 * 86_400_000).toISOString(),
    memo: "",
    discount: "",
    tax: "",
    lines: [
      {
        description: "Consulting",
        unit: "hour",
        quantity: "2.5",
        unit_price: "125.00",
        discount: "",
      },
    ],
    ...overrides,
  };
}

/** The details of a validation refusal, or an empty list when the call did not refuse that way. */
/**
 * The details of a refusal of **any** code, or an empty list.
 *
 * `refusalOf` above deliberately only reads `VALIDATION_FAILED`, because most of the gate is asserting that
 * a malformed body is refused as malformed. The discount guard raises `CONFLICT` instead - the request was
 * well formed, a stored value needs attention - so its details have to be read without that filter.
 */
async function refusalOfAsync(
  run: () => Promise<unknown>,
): Promise<readonly { readonly field?: unknown; readonly rule?: unknown }[]> {
  try {
    await run();

    return [];
  } catch (error) {
    return isAppError(error) ? error.details : [];
  }
}

async function refusalOf(run: () => Promise<unknown>): Promise<readonly { readonly field?: unknown; readonly rule?: unknown }[]> {
  try {
    await run();

    return [];
  } catch (error) {
    if (isAppError(error) && error.code === "VALIDATION_FAILED") {
      return error.details;
    }

    return [];
  }
}

/** The error code a call answered with, or null when it succeeded. */
async function codeOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();

    return null;
  } catch (error) {
    return isAppError(error) ? error.code : "not-an-app-error";
  }
}

/* ---- 1. the arithmetic ---- */

function checkArithmetic(): void {
  // The cases that separate rounding from truncation, and the ones a real invoice is made of.
  //
  // Every quantity here respects the column's scale of three. A rounding case needs a price whose minor
  // unit count is not a multiple of 1000, so a thousandth of a unit lands between two minor units:
  // `0.0001` is one minor unit, and a quantity of 0.5 of one is exactly half of it.
  const cases: readonly (readonly [string, string, string, string])[] = [
    // quantity, price, expected line total, why
    ["1", "125.0000", "1250000", "one whole unit of 125 is exactly 125000 minor units"],
    ["2.5", "125.0000", "3125000", "two and a half hours at 125 is 312.50"],
    ["0.001", "1000.0000", "10000", "a thousandth of a thousand dollars is one dollar"],
    ["2.5", "400.0000", "10000000", "two and a half of four hundred is a thousand dollars"],
    ["999999.999", "1.0000", "9999999990", "a large quantity stays exact"],
    // Half away from zero, which is how PostgreSQL casts a numeric to bigint.
    ["0.5", "0.0001", "1", "exactly half a minor unit rounds away from zero"],
    ["1.5", "0.0001", "2", "one and a half minor units rounds to two"],
    ["2.5", "0.0001", "3", "two and a half rounds to three, not to the even two"],
    ["0.502", "0.0001", "1", "just over half rounds up"],
    ["0.498", "0.0001", "0", "just under half rounds down"],
    ["0.001", "0.0001", "0", "a thousandth of a minor unit is not a minor unit"],
    ["999.999", "0.0001", "1000", "and a long fraction still rounds to a whole minor unit"],
  ];

  for (const [quantity, price, expected, why] of cases) {
    const thousandths = quantityToThousandths(quantity);
    const minor = priceToMinor(price);

    expect(thousandths !== null && minor !== null, `the fixture parses the quantity ${quantity} and the price ${price}`);

    if (thousandths === null || minor === null) {
      continue;
    }

    const total = lineTotalMinor({ quantityThousandths: thousandths, unitPriceMinor: minor, discountMinor: 0n });
    const database = databaseLineTotal(quantity, minor, 0n);

    expectEqual(total, BigInt(expected), `the engine totals ${quantity} at ${price}: ${why}`);
    expectEqual(total, database, `and agrees with the database's own cast for ${quantity} at ${price}`);
  }

  // A discount is subtracted after the rounding, which is what the generated column states.
  const discounted = lineTotalMinor({
    quantityThousandths: quantityToThousandths("2.5") ?? 0n,
    unitPriceMinor: priceToMinor("125.00") ?? 0n,
    discountMinor: priceToMinor("25.00") ?? 0n,
  });

  expectEqual(discounted, 2_875_000n, "a line discount comes off the rounded gross");
  expectEqual(
    discounted,
    databaseLineTotal("2.5", 1_250_000n, 250_000n),
    "and matches the database's generated column",
  );

  // The subtotal is the sum of the live lines, and `coalesce(sum(...), 0)` is what an empty one means.
  expectEqual(subtotalOf([]), 0n, "no lines is a subtotal of zero");
  expectEqual(
    subtotalOf([
      { quantityThousandths: 2_500n, unitPriceMinor: 1_250_000n, discountMinor: 0n },
      { quantityThousandths: 1_000n, unitPriceMinor: 42_500n, discountMinor: 0n },
    ]),
    3_167_500n,
    "two lines add up",
  );

  // `invoices_derive_total`, verbatim.
  const totals = invoiceTotalsOf({ subtotalMinor: 3_167_500n, discountMinor: 100_000n, taxMinor: 50_000n });

  expectEqual(totals.totalMinor, 3_117_500n, "the invoice total is subtotal - discount + tax");

  // The quantity round trip: what a merchant types is what the form prints back.
  for (const [typed, expected] of [
    ["1", "1"],
    ["2.5", "2.5"],
    ["0.001", "0.001"],
    ["2.050", "2.05"],
    ["1000000", "1000000"],
  ] as const) {
    const thousandths = quantityToThousandths(typed);
    const printed = thousandths === null ? null : thousandthsToQuantity(thousandths);

    expectEqual(printed, expected, `a quantity of ${typed} prints back as ${expected}`);
  }

  // A quantity the column's scale cannot hold is refused rather than rounded by the database.
  for (const refused of ["1.2345", "-1", "abc", "1,000", "10000000", ""]) {
    expectEqual(quantityToThousandths(refused), null, `the quantity ${JSON.stringify(refused)} is not a quantity`);
  }
}

/* ---- 2 and 3. the validation ---- */

async function checkValidation(): Promise<void> {
  // A good body creates a draft with the client's snapshot and the database's totals.
  const db = createDb();
  const invoice = await createInvoice({ actor: owner, body: bodyOf() }, depsOf(db));

  expectEqual(invoice.status, "draft", "a create writes a draft");
  expectEqual(invoice.client.name, "Acme Ltd", "the printed name comes from the client book");
  expectEqual(invoice.client.email, "billing@acme.example", "and so does the address the invoice prints");
  expect(invoice.client.address !== null && invoice.client.address.includes("Austin"), "the client's city is on the address");
  expectEqual(invoice.totals.subtotalMinor, "3125000", "the subtotal is the trigger's sum of the lines");
  expectEqual(invoice.totals.totalMinor, "3125000", "and the total is subtotal - discount + tax");
  expectEqual(invoice.totals.total, "312.5000", "printed at the scale the column stores");
  expectEqual(invoice.lines.length, 1, "one line was written");
  expectEqual(at(invoice.lines, 0, "the line").quantity, "2.5", "the typed quantity prints back");
  expectEqual(at(invoice.lines, 0, "the line").lineTotalMinor, "3125000", "and the line amount");

  // The snapshot crosses JSON. A `bigint` throws in `JSON.stringify`, so this is the assertion that a
  // successful create can actually be answered - the failure the stub-free runtime probe could not reach.
  let serialised: string | null = null;

  try {
    serialised = JSON.stringify(invoice);
  } catch {
    serialised = null;
  }

  expect(serialised !== null, "the invoice snapshot survives JSON, so a create can be answered");
  expect(serialised !== null && serialised.includes('"totalMinor":"3125000"'), "with each amount as decimal text");
  expect(serialised !== null && serialised.includes('"total":"312.5000"'), "beside its printed form");

  // Every money column is the database's: the service sent none of them.
  const storedRow = at(db.invoices, 0, "the stored invoice");

  expectEqual(storedRow["subtotal_minor"], "3125000", "the subtotal is stored by the trigger, not by the service");
  expectEqual(storedRow["total_minor"], "3125000", "and the total by invoices_derive_total");
  expectEqual(storedRow["number"], null, "a draft carries no number");
  expectEqual(storedRow["issued_at"], null, "and no issue instant");

  // The money totals are the database's. This is asserted from what the service actually sent rather
  // than from what its source looks like: the invoice row it inserted carries no subtotal, no total and
  // no line total, because `invoices_derive_total` and `invoice_items_sync_totals` own all three.
  const sentInvoice = at(at(db.inserts, 0, "the invoice insert").rows, 0, "the invoice row that was sent");
  const sentLine = at(at(db.inserts, 1, "the line insert").rows, 0, "the line that was sent");

  for (const column of ["subtotal_minor", "total_minor", "amount_paid_minor", "number", "issued_at"]) {
    expect(
      !Object.hasOwn(sentInvoice, column),
      `the service sends no ${column} of its own: the migration's trigger owns it`,
    );
  }

  for (const column of ["line_total_minor", "deleted_at", "version", "id"]) {
    expect(
      !Object.hasOwn(sentLine, column),
      `the service sends no ${column} on a line: the column is generated or defaulted`,
    );
  }

  // What it does send is the row of `0023` minus the generated and defaulted columns.
  expectDeepEqual(
    Object.keys(sentLine).sort(),
    [
      "company_id",
      "description",
      "discount_minor",
      "invoice_id",
      "position",
      "product_id",
      "quantity",
      "service_id",
      "unit",
      "unit_price_minor",
    ],
    "a line is written with exactly the columns it needs",
  );

  // The lines went in one insert, not one per line: rule 17, no query in a loop.
  const invoiceInserts = db.inserts.filter((entry) => entry.table === "invoices");
  const itemInserts = db.inserts.filter((entry) => entry.table === "invoice_items");

  expectEqual(invoiceInserts.length, 1, "the invoice row is one insert");
  expectEqual(itemInserts.length, 1, "and twenty lines would still be one insert");

  // The invoice-level discount is a second write, because `invoices_discount_check` compares it to a
  // subtotal that does not exist until the lines do. The gate asserts the order, not just the result.
  const discountDb = createDb();
  const discounted = await createInvoice({ actor: owner, body: bodyOf({ discount: "12.50" }) }, depsOf(discountDb));
  const discountUpdates = discountDb.updates.filter((entry) => entry.table === "invoices");

  expectEqual(discountUpdates.length, 1, "an invoice discount is one second write");
  expectEqual(at(discountUpdates, 0, "the discount write").values["discount_minor"], 125_000n, "carrying the discount");
  expectEqual(discounted.totals.discountMinor, "125000", "which the re-read reports");
  expectEqual(discounted.totals.totalMinor, "3000000", "and the total is recomputed from it: 312.50 less 12.50");
  expect(
    String(at(discountUpdates, 0, "the discount write").query).includes("status=eq.draft"),
    "scoped to a draft, so it can never touch an issued document",
  );

  // With no discount there is no second write at all.
  const plainDb = createDb();
  await createInvoice({ actor: owner, body: bodyOf() }, depsOf(plainDb));

  expectEqual(plainDb.updates.length, 0, "a create with no invoice discount writes one row and no update");

  // Three lines, one insert.
  const manyDb = createDb();
  const many = await createInvoice(
    {
      actor: owner,
      body: bodyOf({
        lines: [
          { description: "One", unit: "item", quantity: "1", unit_price: "10" },
          { description: "Two", unit: "item", quantity: "2", unit_price: "20" },
          { description: "Three", unit: "item", quantity: "3", unit_price: "30" },
        ],
      }),
    },
    depsOf(manyDb),
  );

  expectEqual(many.lines.length, 3, "three lines were written");
  expectEqual(manyDb.inserts.filter((entry) => entry.table === "invoice_items").length, 1, "in one statement");
  expectDeepEqual(
    many.lines.map((line) => line.position),
    [1, 2, 3],
    "and numbered from one, in the order they were typed",
  );
  expectEqual(many.totals.subtotalMinor, "1400000", "and summed as 1000 + 4000 + 9000 minor units");

  // The fields each ceiling belongs to, named one at a time.
  const refusals: readonly (readonly [string, Record<string, unknown>, string, string])[] = [
    [
      "a client id that is not an id",
      bodyOf({ client_id: "not-a-uuid" }),
      "client_id",
      "invalid_format",
    ],
    [
      "a due date that is not a date",
      bodyOf({ due_at: "next tuesday" }),
      "due_at",
      "invalid_format",
    ],
    [
      "a due date ten years out",
      bodyOf({ due_at: new Date(NOW + 4_000 * 86_400_000).toISOString() }),
      "due_at",
      "too_large",
    ],
    [
      "a currency the platform does not bill in",
      bodyOf({ currency: "EUR" }),
      "currency",
      "invalid_format",
    ],
    [
      "an invoice discount that is not an amount",
      bodyOf({ discount: "free" }),
      "discount",
      "invalid_format",
    ],
    [
      "a tax that is not an amount",
      bodyOf({ tax: "lots" }),
      "tax",
      "invalid_format",
    ],
    [
      "no lines at all",
      bodyOf({ lines: [] }),
      "lines",
      "empty",
    ],
    [
      "more lines than an invoice holds",
      bodyOf({
        lines: Array.from({ length: INVOICE_MAXIMUM_LINES + 1 }, () => ({
          description: "Line",
          unit: "item",
          quantity: "1",
          unit_price: "1",
        })),
      }),
      "lines",
      "too_many",
    ],
    [
      "a line with no description",
      bodyOf({ lines: [{ description: "", unit: "item", quantity: "1", unit_price: "10" }] }),
      "lines[0].description",
      "required",
    ],
    [
      "a unit outside the list",
      bodyOf({ lines: [{ description: "Line", unit: "stone", quantity: "1", unit_price: "10" }] }),
      "lines[0].unit",
      "invalid_format",
    ],
    [
      "a quantity of zero",
      bodyOf({ lines: [{ description: "Line", unit: "item", quantity: "0", unit_price: "10" }] }),
      "lines[0].quantity",
      "too_small",
    ],
    [
      "a quantity past one million",
      bodyOf({ lines: [{ description: "Line", unit: "item", quantity: "1000001", unit_price: "10" }] }),
      "lines[0].quantity",
      "too_large",
    ],
    [
      "a quantity with a fourth decimal",
      bodyOf({ lines: [{ description: "Line", unit: "item", quantity: "1.2345", unit_price: "10" }] }),
      "lines[0].quantity",
      "invalid_format",
    ],
    [
      "a price that is not a price",
      bodyOf({ lines: [{ description: "Line", unit: "item", quantity: "1", unit_price: "free" }] }),
      "lines[0].unit_price",
      "invalid_format",
    ],
    [
      // `price.ts` refuses anything outside its pattern as `invalid_format`; a number that fits the
      // pattern but passes the ceiling is the `too_large` case, handled separately below.
      "a price past the ceiling",
      bodyOf({ lines: [{ description: "Line", unit: "item", quantity: "1", unit_price: "999999999999.9999" }] }),
      "lines[0].unit_price",
      "too_large",
    ],
    [
      "a line discount larger than the line",
      bodyOf({ lines: [{ description: "Line", unit: "item", quantity: "1", unit_price: "10", discount: "11" }] }),
      "lines[0].discount",
      "too_large",
    ],
    [
      "a product and a service on one line",
      bodyOf({
        lines: [
          {
            description: "Line",
            unit: "item",
            quantity: "1",
            unit_price: "10",
            product_id: PRODUCT_A,
            service_id: SERVICE_A,
          },
        ],
      }),
      "lines[0].service_id",
      "invalid_format",
    ],
    [
      // The line is 2.5 hours at 125.00, so the subtotal is 312.50 and 400 is more than it.
      "an invoice discount larger than the subtotal",
      bodyOf({ discount: "400" }),
      "discount",
      "too_large",
    ],


  ];

  for (const [description, body, field, rule] of refusals) {
    const details = await refusalOf(() => createInvoice({ actor: owner, body }, depsOf(createDb())));

    expect(details.length > 0, `the service refuses ${description}`);
    expectEqual(at(details, 0, description).field, field, `naming the field for ${description}`);
    expectEqual(at(details, 0, description).rule, rule, `naming the rule for ${description}`);
  }

  // The boundaries themselves are allowed: a discount equal to the subtotal is a 100% discount, not an
  // error, and a line discount equal to the line is a free line. `invoices_discount_check` says
  // `discount_minor <= subtotal_minor`, and `invoice_items_discount_check` says `<=` as well.
  const wholeDiscount = await createInvoice({ actor: owner, body: bodyOf({ discount: "312.50" }) }, depsOf(createDb()));

  expectEqual(wholeDiscount.totals.totalMinor, "0", "a discount equal to the subtotal is allowed, and totals zero");

  const freeLine = await createInvoice(
    {
      actor: owner,
      body: bodyOf({
        lines: [{ description: "Free", unit: "item", quantity: "1", unit_price: "10", discount: "10" }],
      }),
    },
    depsOf(createDb()),
  );

  expectEqual(at(freeLine.lines, 0, "the free line").lineTotalMinor, "0", "a discount equal to the line is a free line");

  const zeroPrice = await createInvoice(
    {
      actor: owner,
      body: bodyOf({ lines: [{ description: "Free", unit: "item", quantity: "1", unit_price: "0" }] }),
    },
    depsOf(createDb()),
  );

  expectEqual(at(zeroPrice.lines, 0, "the zero price line").lineTotalMinor, "0", "a price of zero is a valid price");

  // Every broken field is named at once, and in the order the screen reads them.
  const broken = await refusalOf(() =>
    createInvoice(
      {
        actor: owner,
        body: bodyOf({
          client_id: "nope",
          currency: "EUR",
          lines: [
            { description: "", unit: "stone", quantity: "0", unit_price: "free" },
            { description: "Good", unit: "item", quantity: "1", unit_price: "10" },
            { description: "Bad price", unit: "item", quantity: "1", unit_price: "1 200" },
          ],
        }),
      },
      depsOf(createDb()),
    ),
  );

  expectDeepEqual(
    broken.map((detail) => detail.field),
    [
      "client_id",
      "currency",
      "lines[0].description",
      "lines[0].unit",
      "lines[0].quantity",
      "lines[0].unit_price",
      "lines[2].unit_price",
    ],
    "every broken field is named once, the lines in the order they were typed",
  );

  // A struck-out line on a list of twenty is marked on its own row, not against the whole list.
  expect(
    broken.some((detail) => detail.field === "lines[0].unit_price"),
    "a line's own box is named for a line that failed",
  );

  // The memo and a line description are sanitised rather than refused: a merchant pasting text is not
  // making an error, and the ceiling is what the column holds.
  const longDescription = "x".repeat(INVOICE_ITEM_DESCRIPTION_LIMITS.max + 50);
  const sanitised = await refusalOf(() =>
    createInvoice(
      {
        actor: owner,
        body: bodyOf({
          memo: "Thank you for your business",
          lines: [{ description: longDescription, unit: "item", quantity: "1", unit_price: "10" }],
        }),
      },
      depsOf(createDb()),
    ),
  );

  expectDeepEqual(sanitised, [], "an over-long description is truncated to the column, not refused");
}

/* ---- 4. the tenancy ---- */

async function checkTenancy(): Promise<void> {
  // Only the owner writes an invoice, exactly as only the owner writes the book it bills from. Every
  // other role is refused by the role, before the body is even parsed - so the answer is a permission
  // code and never a validation detail that would let an office account probe the form's rules.
  for (const roles of [["compliance_kyc"], ["finance_ops"], ["support"], ["ceo"], ["super_admin"], ["blogger"]] as const) {
    const code = await codeOf(() =>
      createInvoice(
        { actor: actorOf([...roles], COMPANY_A, { userId: OFFICE_ID }), body: bodyOf() },
        depsOf(createDb()),
      ),
    );

    expectEqual(code, "PERMISSION_DENIED", `the role ${roles[0]} may not write an invoice`);
  }

  // A platform account with no company cannot write into one.
  expectEqual(
    await codeOf(() => createInvoice({ actor: desk, body: bodyOf() }, depsOf(createDb()))),
    "PERMISSION_DENIED",
    "an account with no company cannot write an invoice",
  );

  // Another merchant's client is the same answer as a client that does not exist: a 404, never a 403
  // that would confirm the id belongs to somebody.
  for (const [description, clientId] of [
    ["another merchant's client", CLIENT_B],
    ["a client that does not exist", "018f2b8a-5555-4c2d-9c3e-0000000000ff"],
  ] as const) {
    const db = createDb();

    expectEqual(
      await codeOf(() => createInvoice({ actor: owner, body: bodyOf({ client_id: clientId }) }, depsOf(db))),
      "RESOURCE_NOT_FOUND",
      `${description} answers not found`,
    );
    expectEqual(db.invoices.length, 0, `and ${description} writes no invoice`);
  }

  // The company on the row is the session's, never the body's.
  const db = createDb();
  await createInvoice({ actor: owner, body: bodyOf() }, depsOf(db));

  expectEqual(at(db.invoices, 0, "the invoice")["company_id"], COMPANY_A, "the row belongs to the session's company");
  expectEqual(at(db.items, 0, "the line")["company_id"], COMPANY_A, "and so does every line");

  // The same body for another merchant writes into their company, and their own client.
  const sharedDb = createDb();
  await createInvoice({ actor: owner, body: bodyOf() }, depsOf(sharedDb));
  await createInvoice(
    { actor: otherOwner, body: bodyOf({ client_id: CLIENT_B }) },
    depsOf(sharedDb),
  );

  expectEqual(sharedDb.invoices.length, 2, "two merchants writing the same body write two invoices");
  expectEqual(at(sharedDb.invoices, 1, "the second invoice")["company_id"], COMPANY_B, "each into its own company");

  // The catalogue reference is scoped by `invoice_items_guard_catalogue`: the merchant's own product may
  // be billed, and a product that exists but belongs to somebody else may not.
  const own = createDb();
  const ownInvoice = await createInvoice(
    {
      actor: owner,
      body: bodyOf({
        lines: [
          { description: "Desk lamp", unit: "item", quantity: "1", unit_price: "42.50", product_id: PRODUCT_A },
        ],
      }),
    },
    depsOf(own),
  );

  expectEqual(at(ownInvoice.lines, 0, "the line").productId, PRODUCT_A, "the merchant's own product may be billed");

  // A product id that belongs to the other merchant: the trigger refuses the line, and the invoice the
  // request had already written is removed rather than left as an empty draft.
  const foreign = createDb();
  foreign.products.push({ ...at(foreign.products, 0, "the product"), id: "018f2b8a-6666-4c2d-9c3e-0000000000ff", company_id: COMPANY_B });

  let foreignCode: string | null = null;
  let foreignDetails: readonly { readonly field?: unknown; readonly rule?: unknown }[] = [];

  try {
    await createInvoice(
      {
        actor: owner,
        body: bodyOf({
          lines: [
            { description: "Borrowed", unit: "item", quantity: "1", unit_price: "10", product_id: "018f2b8a-6666-4c2d-9c3e-0000000000ff" },
          ],
        }),
      },
      depsOf(foreign),
    );
  } catch (error) {
    foreignCode = isAppError(error) ? error.code : "not-an-app-error";
    foreignDetails = isAppError(error) && error.code === "VALIDATION_FAILED" ? error.details : [];
  }

  expectEqual(foreignCode, "VALIDATION_FAILED", "another merchant's product cannot be billed");
  expectEqual(at(foreignDetails, 0, "the refusal").field, "lines[0].product_id", "the refusal names the line's box");
  expectEqual(at(foreignDetails, 0, "the refusal").rule, "not_found", "and says the entry is not there");
  expect(at(foreign.invoices, 0, "the abandoned invoice")["deleted_at"] !== null, "and the invoice written for it is removed");

  // A client whose stored email the invoice cannot print is refused before the write, not by PostgREST.
  const badEmailDb = createDb();
  badEmailDb.clients.push(clientRow({ id: CLIENT_B, companyId: COMPANY_A, name: "Stale Book", email: "not-an-email" }));

  const badEmail = await refusalOf(() =>
    createInvoice({ actor: owner, body: bodyOf({ client_id: CLIENT_B }) }, depsOf(badEmailDb)),
  );

  expectEqual(at(badEmail, 0, "the refusal").field, "client_id", "an address the invoice cannot print names the client");
  expectEqual(badEmailDb.invoices.length, 0, "and writes nothing");
}

/* ---- 5 and 6. the draft, and the compensation ---- */

async function checkCompensation(): Promise<void> {
  const db = createDb();

  db.failItems = true;

  let code: string | null = null;

  try {
    await createInvoice({ actor: owner, body: bodyOf() }, depsOf(db));
  } catch (error) {
    code = isAppError(error) ? error.code : "not-an-app-error";
  }

  expectEqual(code, "VALIDATION_FAILED", "a lines insert the database refuses is reported as a validation failure");

  // The invoice row is still there, because PostgREST has no transaction across two requests - but it is
  // marked deleted, so the merchant's list never shows a draft the request reported as failed.
  const abandoned = at(db.invoices, 0, "the abandoned invoice");

  expect(abandoned["deleted_at"] !== null, "the invoice written for it is soft deleted");
  expectEqual(db.updates.filter((entry) => entry.table === "invoices").length, 1, "by one scoped update");
  expect(
    String(at(db.updates, 0, "the compensating update").query).includes("status=eq.draft"),
    "and only while it is still a draft, so it can never touch an issued document",
  );

  // A read afterwards does not find it, which is what the merchant sees.
  let readCode: string | null = null;

  try {
    await getInvoice({ actor: owner, invoiceId: String(abandoned["id"]) }, depsOf(db));
  } catch (error) {
    readCode = isAppError(error) ? error.code : "not-an-app-error";
  }

  expectEqual(readCode, "RESOURCE_NOT_FOUND", "and a read of it afterwards is a 404, as a removal is");
}

/* ---- 7. the audit ---- */

async function checkAudit(): Promise<void> {
  const db = createDb();
  const audit = createInMemoryAuditTrail();
  const invoice = await createInvoice({ actor: owner, body: bodyOf({ memo: "Thanks for the work" }) }, depsOf(db, audit));

  const created = audit.entries.filter((entry) => entry.action === INVOICE_CREATED_AUDIT_ACTION);

  expectEqual(created.length, 1, "a create writes one audit entry");
  expectEqual(audit.entries.length, 1, "and nothing else");

  const entry = at(created, 0, "the create entry");
  const payload = entry.payload as Readonly<Record<string, unknown>>;

  expectEqual(entry.entityType, "invoice", "the entry names the entity");
  expectEqual(entry.entityId, invoice.id, "and the row");
  expectEqual(entry.companyId, COMPANY_A, "and the company");
  expectEqual(entry.actorUserId, OWNER_ID, "and the actor");
  expectEqual(payload["line_count"], 1, "the payload says how many lines");
  expectEqual(payload["total_minor"], "3125000", "and what the document totals");
  expectEqual(payload["currency"], "USD", "and in what currency");

  const serialised = JSON.stringify(audit.entries);

  for (const [secret, why] of [
    ["Acme Ltd", "the client's name"],
    ["billing@acme.example", "the client's email address"],
    ["Thanks for the work", "the memo"],
    ["Consulting", "a line's description"],
    ["Market Street", "the client's address"],
  ] as const) {
    expect(!serialised.includes(secret), `the trail never carries ${why}`);
  }

  // The compensating removal is audited too, and says why it happened without repeating a value.
  const abandonedAudit = createInMemoryAuditTrail();
  const abandonedDb = createDb();

  abandonedDb.failItems = true;

  await refusalOf(() => createInvoice({ actor: owner, body: bodyOf({ lines: [{ description: "Secret line", unit: "item", quantity: "1", unit_price: "10" }] }) }, depsOf(abandonedDb, abandonedAudit)));

  const removals = abandonedAudit.entries.filter((entry) => entry.action === INVOICE_ABANDONED_AUDIT_ACTION);

  expectEqual(removals.length, 1, "an abandoned create is recorded");
  expect(!JSON.stringify(removals).includes("Secret line"), "without repeating the line that caused it");

  // An audit sink that is down never fails the write it records.
  const deafTrail: AuditTrail = {
    append(): Promise<void> {
      return Promise.reject(new Error("the sink is down"));
    },
  };
  const deafDb = createDb();
  const survived = await createInvoice({ actor: owner, body: bodyOf() }, depsOf(deafDb, deafTrail));

  expectEqual(survived.status, "draft", "a create succeeds when its audit sink is down");
}

/* ---- the client and catalogue selectors ---- */

async function checkSelectors(): Promise<void> {
  const db = createDb();
  const options = await listInvoiceClientOptions({ actor: owner }, { rest: createInvoiceRest(db) });

  expectEqual(options.clients.length, 1, "the selector reads the merchant's own live clients");
  expectEqual(at(options.clients, 0, "the option").name, "Acme Ltd", "with the name the invoice prints");
  expectEqual(options.truncated, false, "and says whether the book continues");

  // Only four columns leave the database for a selector that prints three facts.
  const clientQuery = at(
    db.queries.filter((query) => query.startsWith("clients?")),
    0,
    "the client option query",
  );

  expect(clientQuery.includes("select=id,name,email,city,created_at"), "the selector selects its columns one by one");
  expect(!clientQuery.includes("notes"), "and not the ones it does not print");
  expect(clientQuery.includes("company_id=eq."), "scoped to the session's company");
  expect(clientQuery.includes("deleted_at=is.null"), "and to the live rows");
  expect(
    clientQuery.includes(`limit=${String(INVOICE_CLIENT_OPTION_LIMIT + 1)}`),
    "reading one row past the ceiling so the book's continuation is known",
  );

  // The role applies to a selector exactly as to a write: an account that may not read the book is not
  // offered a client to bill.
  let selectorCode: string | null = null;

  try {
    await listInvoiceClientOptions({ actor: desk }, { rest: createInvoiceRest(db) });
  } catch (error) {
    selectorCode = isAppError(error) ? error.code : "not-an-app-error";
  }

  expectEqual(selectorCode, "PERMISSION_DENIED", "the selector applies the client book's own role");

  // The catalogue picker, per kind, from the merchant's own tables.
  const catalogueDb = createDb();
  const products = await listInvoiceCatalogueOptions({ rest: createInvoiceRest(catalogueDb) }, { actor: owner, kind: "product" });
  const services = await listInvoiceCatalogueOptions({ rest: createInvoiceRest(catalogueDb) }, { actor: owner, kind: "service" });

  expectEqual(products.entries.length, 1, "the product picker reads the product catalogue");
  expectEqual(at(products.entries, 0, "the product").kind, "product", "and names its kind");
  expectEqual(at(products.entries, 0, "the product").unitPrice, "42.5000", "and the price the line fills with");
  expectEqual(services.entries.length, 1, "the service picker reads the service catalogue");
  expectEqual(at(services.entries, 0, "the service").unit, "hour", "with the unit the line fills with");

  // Filling a line from the catalogue produces one the service accepts, with the link kept.
  const filled = await createInvoice(
    {
      actor: owner,
      body: bodyOf({
        lines: [
          {
            description: "Consulting",
            unit: "hour",
            quantity: "1",
            unit_price: at(services.entries, 0, "the service").unitPrice,
            service_id: SERVICE_A,
          },
        ],
      }),
    },
    depsOf(createDb()),
  );

  expectEqual(at(filled.lines, 0, "the filled line").serviceId, SERVICE_A, "the filled line keeps its link");
  expectEqual(at(filled.lines, 0, "the filled line").productId, null, "and claims no product");
}

/* ---- 9. the line editor: add, edit, remove (STEP 113) ---- */

/** Build a draft with `count` lines, and hand back the database so the test can read it. */
async function draftWith(count: number): Promise<{ readonly db: InvoiceDb; readonly invoiceId: string }> {
  const db = createDb();
  const invoice = await createInvoice(
    {
      actor: owner,
      body: bodyOf({
        lines: Array.from({ length: count }, (_, index) => ({
          description: `Line ${String(index + 1)}`,
          unit: "item",
          quantity: "1",
          unit_price: "10",
        })),
      }),
    },
    depsOf(db),
  );

  return { db, invoiceId: invoice.id };
}

/** One parsed line, through the create path's own parser. */
function parsedLine(overrides: Readonly<Record<string, unknown>> = {}): ParsedLine {
  return parseInvoiceLine({
    description: "Consulting",
    unit: "hour",
    quantity: "2.5",
    unit_price: "125.00",
    discount: "",
    ...overrides,
  });
}

async function checkLineEditor(): Promise<void> {
  // Adding a line appends at the end of a dense list, and the database totals it.
  const { db, invoiceId } = await draftWith(2);
  const line = await addInvoiceLine(
    { actor: owner, invoiceId, line: parsedLine() },
    lineDepsOf(db),
  );

  expectEqual(line.position, 3, "a new line takes the position after the last");
  expectEqual(line.quantity, "2.5", "and prints the quantity it was given");
  expectEqual(line.unitPrice, "125.0000", "and the price");
  expectEqual(line.lineTotalMinor, "3125000", "with the total the database generated");

  const parent = at(db.invoices, 0, "the invoice");

  // Two lines at 10.00 each, then one at 2.5 hours and 125.00: 200000 + 3125000.
  expectEqual(parent["subtotal_minor"], "3325000", "and the parent's subtotal now sums three lines");

  // The service sent no total: the sum is the trigger's.
  const sentLine = at(at(db.inserts, db.inserts.length - 1, "the line insert").rows, 0, "the line row");

  for (const column of ["line_total_minor", "deleted_at", "version", "id"]) {
    expect(!Object.hasOwn(sentLine, column), `an added line sends no ${column}`);
  }

  expectEqual(sentLine["quantity"], "2.5", "the quantity crosses the wire as the decimal the column stores");

  // The count ceiling is enforced before the write.
  const full = await draftWith(INVOICE_MAXIMUM_LINES);
  const tooMany = await refusalOf(() =>
    addInvoiceLine({ actor: owner, invoiceId: full.invoiceId, line: parsedLine() }, lineDepsOf(full.db)),
  );

  expectEqual(at(tooMany, 0, "the ceiling refusal").field, "lines", "a full invoice refuses another line");
  expectEqual(at(tooMany, 0, "the ceiling refusal").rule, "too_many", "as too_many");
  expectEqual(full.db.items.length, INVOICE_MAXIMUM_LINES, "and writes nothing");

  // An edit replaces the whole line and revalidates with the create path's rules.
  const editing = await draftWith(2);
  const second = at(
    await readLiveLinesForTest(editing.db, editing.invoiceId),
    1,
    "the second line",
  );
  const edited = await updateInvoiceLine(
    {
      actor: owner,
      invoiceId: editing.invoiceId,
      lineId: second.id,
      line: parsedLine({ description: "Revised", quantity: "3", unit_price: "20.00" }),
    },
    lineDepsOf(editing.db),
  );

  expectEqual(edited.description, "Revised", "an edit replaces the description");
  expectEqual(edited.position, second.position, "and leaves the position alone");
  expectEqual(edited.lineTotalMinor, "600000", "with a total the database recomputed");
  expectEqual(
    at(editing.db.invoices, 0, "the invoice")["subtotal_minor"],
    "700000",
    "and the subtotal follows: 10 + 60",
  );

  // "Full discount support": a line may be discounted to zero, and past its gross it is refused.
  const free = await updateInvoiceLine(
    {
      actor: owner,
      invoiceId: editing.invoiceId,
      lineId: second.id,
      line: parsedLine({ quantity: "1", unit_price: "20.00", discount: "20.00" }),
    },
    lineDepsOf(editing.db),
  );

  expectEqual(free.lineTotalMinor, "0", "a discount equal to the line makes it free");
  expectEqual(free.discount, "20.0000", "and is reported as the merchant typed it");

  const overDiscount = await refusalOf(() =>
    updateInvoiceLine(
      {
        actor: owner,
        invoiceId: editing.invoiceId,
        lineId: second.id,
        line: parsedLine({ quantity: "1", unit_price: "20.00", discount: "20.01" }),
      },
      lineDepsOf(editing.db),
    ),
  );

  expectEqual(at(overDiscount, 0, "the discount refusal").field, "discount", "a discount past the line names discount");
  expectEqual(at(overDiscount, 0, "the discount refusal").rule, "too_large", "as too_large");

  // The bare field names the editor needs, not the create path's `lines[0].` prefix.
  for (const [description, body, field] of [
    ["a blank description", { description: "  " }, "description"],
    ["an unknown unit", { unit: "stone" }, "unit"],
    ["a zero quantity", { quantity: "0" }, "quantity"],
    ["a fourth decimal", { quantity: "1.2345" }, "quantity"],
    ["a price that is not a price", { unit_price: "free" }, "unit_price"],
    ["both catalogue references", { product_id: PRODUCT_A, service_id: SERVICE_A }, "service_id"],
  ] as const) {
    const details = await refusalOf(() =>
      updateInvoiceLine(
        { actor: owner, invoiceId: editing.invoiceId, lineId: second.id, line: parsedLine(body) },
        lineDepsOf(editing.db),
      ),
    );

    expectEqual(at(details, 0, description).field, field, `the editor refuses ${description} by bare field name`);
    expect(!String(at(details, 0, description).field).startsWith("lines["), `and not as a create path row for ${description}`);
  }

  // A removal soft deletes the row and closes the gap.
  const removing = await draftWith(3);
  const before = await readLiveLinesForTest(removing.db, removing.invoiceId);
  const result = await removeInvoiceLine(
    { actor: owner, invoiceId: removing.invoiceId, lineId: at(before, 0, "the first line").id },
    lineDepsOf(removing.db),
  );

  expectEqual(result.lines.length, 2, "two lines survive");
  expectDeepEqual(
    result.lines.map((entry) => entry.position),
    [1, 2],
    "and the positions are dense again, not 2 and 3",
  );
  expectDeepEqual(
    result.lines.map((entry) => entry.description),
    ["Line 2", "Line 3"],
    "in the order they were written",
  );
  expectEqual(removing.db.items.length, 3, "the removed row stays in the table");
  expect(
    at(removing.db.items, 0, "the removed row")["deleted_at"] !== null,
    "as a soft delete, because a draft may have been exported",
  );
  expectEqual(
    at(removing.db.invoices, 0, "the invoice")["subtotal_minor"],
    "200000",
    "and the subtotal is the two survivors: 10 + 10",
  );

  // The last line cannot be removed: an invoice with no lines is not a document `0022` can total.
  const lonely = await draftWith(1);
  const last = await refusalOf(() =>
    removeInvoiceLine(
      { actor: owner, invoiceId: lonely.invoiceId, lineId: String(at(lonely.db.items, 0, "the only line")["id"]) },
      lineDepsOf(lonely.db),
    ),
  );

  expectEqual(at(last, 0, "the last line refusal").field, "lines", "the last line is refused");
  expectEqual(at(last, 0, "the last line refusal").rule, "empty", "as empty");
  expectEqual(lonely.db.items.length, 1, "and nothing is removed");

  // A line of another invoice under the path is a 404, not an edit.
  const twoDrafts = await draftWith(1);
  const otherInvoice = await createInvoice(
    { actor: owner, body: bodyOf({ lines: [{ description: "Elsewhere", unit: "item", quantity: "1", unit_price: "5" }] }) },
    depsOf(twoDrafts.db),
  );
  const foreignLine = at(
    await readLiveLinesForTest(twoDrafts.db, otherInvoice.id),
    0,
    "the other invoice's line",
  );

  expectEqual(
    await lineCodeOf(() =>
      updateInvoiceLine(
        { actor: owner, invoiceId: twoDrafts.invoiceId, lineId: foreignLine.id, line: parsedLine() },
        lineDepsOf(twoDrafts.db),
      ),
    ),
    "RESOURCE_NOT_FOUND",
    "a line named under the wrong invoice is not found",
  );

  expectEqual(
    await lineCodeOf(() =>
      removeInvoiceLine(
        { actor: owner, invoiceId: twoDrafts.invoiceId, lineId: foreignLine.id },
        lineDepsOf(twoDrafts.db),
      ),
    ),
    "RESOURCE_NOT_FOUND",
    "and cannot be removed through the wrong invoice either",
  );

  // A line id that belongs to another merchant is the same 404, never a 403 that confirms it exists.
  expectEqual(
    await lineCodeOf(() =>
      updateInvoiceLine(
        { actor: otherOwner, invoiceId, lineId: second.id, line: parsedLine() },
        lineDepsOf(editing.db),
      ),
    ),
    "RESOURCE_NOT_FOUND",
    "another merchant's invoice is not found, so neither is its line",
  );

  // The role applies: it is the invoice's own list, not a second one.
  for (const roles of [["compliance_kyc"], ["finance_ops"], ["support"], ["ceo"], ["super_admin"], ["blogger"]] as const) {
    expectEqual(
      await lineCodeOf(() =>
        addInvoiceLine(
          { actor: actorOf([...roles], COMPANY_A, { userId: OFFICE_ID }), invoiceId, line: parsedLine() },
          lineDepsOf(db),
        ),
      ),
      "PERMISSION_DENIED",
      `the role ${roles[0]} may not add a line`,
    );
  }

  // The draft lock: an invoice that has left draft refuses every line write, and says why.
  const issued = await draftWith(2);
  const issuedLine = at(await readLiveLinesForTest(issued.db, issued.invoiceId), 0, "the first line");

  at(issued.db.invoices, 0, "the issued invoice")["status"] = "sent";

  for (const [description, run] of [
    ["add", () => addInvoiceLine({ actor: owner, invoiceId: issued.invoiceId, line: parsedLine() }, lineDepsOf(issued.db))],
    [
      "edit",
      () =>
        updateInvoiceLine(
          { actor: owner, invoiceId: issued.invoiceId, lineId: issuedLine.id, line: parsedLine() },
          lineDepsOf(issued.db),
        ),
    ],
    ["remove", () => removeInvoiceLine({ actor: owner, invoiceId: issued.invoiceId, lineId: issuedLine.id }, lineDepsOf(issued.db))],
  ] as const) {
    expectEqual(await lineCodeOf(run), "CONFLICT", `a sent invoice refuses a line ${description}`);
  }

  expectEqual(
    at(issued.db.items, 0, "the untouched line")["description"],
    "Line 1",
    "and nothing about the issued document changed",
  );
}

/* ---- 10. the line editor's audit trail ---- */

async function checkLineAudit(): Promise<void> {
  const db = createDb();
  const audit = createInMemoryAuditTrail();
  const invoice = await createInvoice(
    {
      actor: owner,
      body: bodyOf({ lines: [{ description: "Secret work", unit: "item", quantity: "1", unit_price: "10" }] }),
    },
    depsOf(db, audit),
  );
  const before = audit.entries.length;
  const added = await addInvoiceLine(
    { actor: owner, invoiceId: invoice.id, line: parsedLine({ description: "Private note" }) },
    lineDepsOf(db, audit),
  );

  const addedEntries = audit.entries.slice(before).filter((entry) => entry.action === INVOICE_LINE_ADDED_AUDIT_ACTION);

  expectEqual(addedEntries.length, 1, "adding a line writes one entry");
  expectEqual(at(addedEntries, 0, "the add entry").entityId, added.id, "naming the line");
  expectEqual(at(addedEntries, 0, "the add entry").companyId, COMPANY_A, "and the company");
  expectEqual(at(addedEntries, 0, "the add entry").actorUserId, OWNER_ID, "and the actor");

  const afterAdd = audit.entries.length;

  await updateInvoiceLine(
    { actor: owner, invoiceId: invoice.id, lineId: added.id, line: parsedLine({ description: "Revised note" }) },
    lineDepsOf(db, audit),
  );
  await removeInvoiceLine(
    { actor: owner, invoiceId: invoice.id, lineId: added.id },
    lineDepsOf(db, audit),
  );

  const later = audit.entries.slice(afterAdd);

  expectDeepEqual(
    later.map((entry) => entry.action),
    [INVOICE_LINE_UPDATED_AUDIT_ACTION, INVOICE_LINE_REMOVED_AUDIT_ACTION],
    "an edit and a removal each write their own entry",
  );

  // The trail never carries what the line said: a description is free text a merchant pasted.
  const serialised = JSON.stringify(audit.entries);

  for (const secret of ["Secret work", "Private note", "Revised note"]) {
    expect(!serialised.includes(secret), `the trail never repeats the line text ${JSON.stringify(secret)}`);
  }

  // `shifted` is the fact an investigation needs about a removal, and it is a count.
  const removedEntry = later[1];

  expectEqual(
    removedEntry === undefined ? null : (removedEntry.payload as Readonly<Record<string, unknown>>)["shifted"],
    0,
    "and a removal says how many rows it moved up",
  );
}

/* ---- 10b. the line editor: ordering (STEP 113 step 2) ---- */

async function checkLineOrder(): Promise<void> {
  const { db, invoiceId } = await draftWith(3);
  const positionsOf = async (): Promise<readonly number[]> =>
    (await readLiveLinesForTest(db, invoiceId)).map((line) => line.position);
  const descriptionsOf = async (): Promise<readonly string[]> =>
    (await readLiveLinesForTest(db, invoiceId)).map((line) => line.description);

  expectDeepEqual(await positionsOf(), [1, 2, 3], "a fresh draft is a dense list");
  expectDeepEqual(await descriptionsOf(), ["Line 1", "Line 2", "Line 3"], "in the order it was written");

  const lines = await readLiveLinesForTest(db, invoiceId);
  const second = at(lines, 1, "the second line");

  // Move down: the second and third exchange places.
  const movedDown = await moveInvoiceLine(
    { actor: owner, invoiceId, lineId: second.id, direction: "down" },
    lineDepsOf(db),
  );

  expectDeepEqual(
    movedDown.lines.map((line) => line.description),
    ["Line 1", "Line 3", "Line 2"],
    "moving down puts the line after its neighbour",
  );
  expectDeepEqual(await positionsOf(), [1, 2, 3], "and the positions stay dense");
  expectEqual(movedDown.movedLineId, second.id, "the answer names the line that moved");
  expectEqual(at(movedDown.lines, 2, "the moved line").position, 3, "which is now last");

  // Move it back up.
  const movedUp = await moveInvoiceLine(
    { actor: owner, invoiceId, lineId: second.id, direction: "up" },
    lineDepsOf(db),
  );

  expectDeepEqual(
    movedUp.lines.map((line) => line.description),
    ["Line 1", "Line 2", "Line 3"],
    "moving up restores the order",
  );
  expectDeepEqual(await positionsOf(), [1, 2, 3], "with the positions still dense");

  // ---- the unique index is satisfied after every write, not just at the end
  db.updates.length = 0;
  db.strictPositions = true;

  await moveInvoiceLine(
    { actor: owner, invoiceId, lineId: second.id, direction: "down" },
    lineDepsOf(db),
  );

  const positionWrites = db.updates.filter((entry) => entry.values["position"] !== undefined);

  expectEqual(positionWrites.length, 3, "a swap is exactly three position writes, not two and not a loop");
  expect(
    positionWrites.every((entry) => Number(entry.values["position"]) >= 1),
    "each parked or exchanged position satisfies position >= 1",
  );

  // The parking position is one past the highest live position, so nothing already holds it.
  expectEqual(
    Number(at(positionWrites, 0, "the parking write").values["position"]),
    4,
    "the first write parks the line one past the end, a position no live row holds",
  );
  expect(db.strictPositions, "and the fixture checked every intermediate write against the index");

  // Moving past either end is a no-op that answers with the list, not a refusal.
  const first = at(await readLiveLinesForTest(db, invoiceId), 0, "the first line");
  const atTop = await moveInvoiceLine(
    { actor: owner, invoiceId, lineId: first.id, direction: "up" },
    lineDepsOf(db),
  );

  expectDeepEqual(
    atTop.lines.map((line) => line.position),
    [1, 2, 3],
    "moving the first line up leaves the order as it was",
  );
  expectEqual(
    db.updates.filter((entry) => entry.values["position"] !== undefined).length,
    3,
    "and writes nothing, because a move that cannot happen is a no-op",
  );

  const last = at(await readLiveLinesForTest(db, invoiceId), 2, "the last line");
  const atBottom = await moveInvoiceLine(
    { actor: owner, invoiceId, lineId: last.id, direction: "down" },
    lineDepsOf(db),
  );

  expectEqual(atBottom.lines.length, 3, "moving the last line down also answers with the list");

  // A removal then a move: the compaction and the swap have to agree about what the list is.
  db.strictPositions = true;
  db.updates.length = 0;

  const compacted = await removeInvoiceLine(
    { actor: owner, invoiceId, lineId: at(await readLiveLinesForTest(db, invoiceId), 0, "the first line").id },
    lineDepsOf(db),
  );

  expectDeepEqual(
    compacted.lines.map((line) => line.position),
    [1, 2],
    "a removal leaves a dense list of two",
  );

  const reordered = await moveInvoiceLine(
    { actor: owner, invoiceId, lineId: at(compacted.lines, 1, "the remaining last line").id, direction: "up" },
    lineDepsOf(db),
  );

  expectDeepEqual(
    reordered.lines.map((line) => line.position),
    [1, 2],
    "and a move on the compacted list is still dense",
  );

  // An unknown line, another merchant's invoice, and a bad direction all refuse.
  expectEqual(
    await lineCodeOf(() =>
      moveInvoiceLine(
        { actor: owner, invoiceId, lineId: "018f2b8a-5555-4c2d-9c3e-0000000000ff", direction: "up" },
        lineDepsOf(db),
      ),
    ),
    "RESOURCE_NOT_FOUND",
    "moving a line that is not there is a 404",
  );

  expectEqual(
    await lineCodeOf(() =>
      moveInvoiceLine({ actor: otherOwner, invoiceId, lineId: second.id, direction: "up" }, lineDepsOf(db)),
    ),
    "RESOURCE_NOT_FOUND",
    "and another merchant's invoice is not found at all",
  );

  // The role applies, and the draft lock applies.
  expectEqual(
    await lineCodeOf(() =>
      moveInvoiceLine(
        { actor: actorOf(["finance_ops"], COMPANY_A, { userId: OFFICE_ID }), invoiceId, lineId: second.id, direction: "up" },
        lineDepsOf(db),
      ),
    ),
    "PERMISSION_DENIED",
    "an office role may not reorder a merchant's invoice",
  );

  const issued = await draftWith(2);
  const issuedLines = await readLiveLinesForTest(issued.db, issued.invoiceId);

  at(issued.db.invoices, 0, "the issued invoice")["status"] = "sending";

  expectEqual(
    await lineCodeOf(() =>
      moveInvoiceLine(
        { actor: owner, invoiceId: issued.invoiceId, lineId: at(issuedLines, 0, "the first line").id, direction: "down" },
        lineDepsOf(issued.db),
      ),
    ),
    "CONFLICT",
    "a document that has left draft cannot be reordered",
  );

  // The move is audited with the positions, and never with the line's text.
  const audit = createInMemoryAuditTrail();
  const audited = await draftWith(2);
  const auditLines = await readLiveLinesForTest(audited.db, audited.invoiceId);

  await moveInvoiceLine(
    { actor: owner, invoiceId: audited.invoiceId, lineId: at(auditLines, 0, "the first line").id, direction: "down" },
    lineDepsOf(audited.db, audit),
  );

  const moves = audit.entries.filter((entry) => entry.action === INVOICE_LINE_MOVED_AUDIT_ACTION);

  expectEqual(moves.length, 1, "a move writes one entry");
  expectEqual(
    (at(moves, 0, "the move entry").payload as Readonly<Record<string, unknown>>)["direction"],
    "down",
    "naming the direction",
  );
  expectEqual(
    (at(moves, 0, "the move entry").payload as Readonly<Record<string, unknown>>)["from_position"],
    1,
    "and where the line came from",
  );
  expect(!JSON.stringify(audit.entries).includes("Line 1"), "and never the line's text");
}

/* ---- 10c. the calculation engine: basis, percentage and resolution (STEP 114) ---- */

async function checkDiscountEngine(): Promise<void> {
  // ---- a percentage is parsed by string surgery, never by a float multiply
  expectEqual(percentToBasisPoints("10"), 1000n, "ten percent is a thousand basis points");
  expectEqual(percentToBasisPoints("12.5"), 1250n, "twelve and a half is twelve hundred and fifty");
  expectEqual(percentToBasisPoints("7.25"), 725n, "and two decimals are still exact");
  expectEqual(percentToBasisPoints("0.29"), 29n, "twenty nine hundredths is twenty nine basis points");
  expectEqual(percentToBasisPoints("10%"), 1000n, "a typed percent sign is tolerated, because the screen prints one");
  expectEqual(percentToBasisPoints("100"), 10_000n, "a hundred percent is the ceiling and is allowed");
  expectEqual(percentToBasisPoints("100.01"), null, "a fraction over a hundred percent is refused");
  expectEqual(percentToBasisPoints("-5"), null, "a negative percentage is a surcharge wearing a discount's name");
  expectEqual(percentToBasisPoints("abc"), null, "and text is not a percentage");
  expectEqual(percentToBasisPoints(""), null, "nor is nothing at all");

  // The float trap, stated as a check rather than as a comment: `Number("0.29") * 100` is not 29.
  expect(Number("0.29") * 100 !== 29, "the float multiply this parser exists to avoid really is wrong");

  // ---- the vocabulary the columns accept
  expectDeepEqual(DISCOUNT_BASES, ["amount", "percent"], "a discount is expressed one of two ways");
  expect(isDiscountBasis("percent"), "and the guard recognises the percentage");
  expect(!isDiscountBasis("share"), "and refuses a word it does not know");
  expectEqual(DISCOUNT_PERCENT_MAXIMUM_BP, 10_000, "a hundred percent is the ceiling the column states");

  // The percentage reaches the column as an `integer`, which is the only way a bigint crosses JSON.
  expectEqual(basisPointsToColumn(1250n), 1250, "1250 basis points is written as the number 1250");
  expect(
    (() => {
      try {
        basisPointsToColumn(10_001n);

        return false;
      } catch {
        return true;
      }
    })(),
    "and a value above the ceiling cannot be converted into one at all",
  );

  // A row is read back as the instruction it recorded, and an unreadable label reads as money.
  const readBack = discountStateOf({ discount_minor: 500n, discount_basis: "percent", discount_percent_bp: 2500 });

  expectEqual(readBack.basis, "percent", "a stored percentage reads as a percentage");
  expectEqual(readBack.basisPoints, 2500n, "with its points");
  expectEqual(
    discountStateOf({ discount_minor: 500n, discount_basis: "amount", discount_percent_bp: 0 }).basisPoints,
    0n,
    "and a flat amount carries no points to misread",
  );
  expectEqual(
    discountStateOf({ discount_minor: 500n, discount_basis: "nonsense", discount_percent_bp: 0 }).basis,
    "amount",
    "a label this build does not know reads as the flat amount every older row is",
  );

  // One resolution function answers for both bases, so a caller cannot pick the wrong one.
  expectEqual(
    resolveDiscount({ basis: "percent", basisPoints: 1000n, amountMinor: 999_999n, subtotalMinor: 1000n }),
    100n,
    "a percentage ignores the amount it was given",
  );
  expectEqual(
    resolveDiscount({ basis: "amount", basisPoints: 1000n, amountMinor: 700n, subtotalMinor: 1000n }),
    700n,
    "and a flat amount ignores the points",
  );

  // ---- the printing direction round trips
  expectEqual(basisPointsToPercent(1250n), "12.5", "1250 basis points prints as 12.5");
  expectEqual(basisPointsToPercent(1000n), "10", "1000 prints without a pointless decimal");
  expectEqual(basisPointsToPercent(125n), "1.25", "and 125 prints as a hundredth of a percent");
  expectEqual(basisPointsToPercent(29n), "0.29", "which is the value the float would have got wrong");
  expectEqual(percentToBasisPoints(basisPointsToPercent(725n)), 725n, "and the round trip is exact");

  // ---- resolving a percentage is rounded half away from zero, in integers
  expectEqual(percentDiscountMinor({ subtotalMinor: 1234n, basisPoints: 1000n }), 123n, "ten percent of 12.34 is 1.23");
  expectEqual(
    percentDiscountMinor({ subtotalMinor: 1235n, basisPoints: 1000n }),
    124n,
    "ten percent of 12.35 is 1.235, which rounds away from zero to 1.24 rather than down to 1.23",
  );
  expectEqual(percentDiscountMinor({ subtotalMinor: 0n, basisPoints: 1000n }), 0n, "an empty invoice has nothing to discount");
  expectEqual(
    percentDiscountMinor({ subtotalMinor: 99n, basisPoints: 10_000n }),
    99n,
    "a hundred percent of 0.99 is the whole 0.99, never more",
  );

  // The rounding direction has to be the same one `grossLineMinor` uses, or one document rounds two ways.
  expectEqual(
    grossLineMinor({ quantityThousandths: 2005n, unitPriceMinor: 1n }),
    2n,
    "a line's gross rounds half away from zero too, so the two roundings in one invoice agree",
  );

  // ---- the shared engine: subtotal, then the discount, then the tax
  const selection = selectInvoiceTotals({
    liveLines: [
      { quantityThousandths: 2500n, unitPriceMinor: 1_250_000n, discountMinor: 0n },
      { quantityThousandths: 1000n, unitPriceMinor: 10_000n, discountMinor: 1_000n },
    ],
    discount: { basis: "percent", basisPoints: 1000n, discountMinor: 0n },
    taxMinor: 5_000n,
  });

  // 2.5 x 125.00 = 312.50, and 1.00 x 1.00 less a 0.10 line discount = 0.90, so 313.40.
  expectEqual(selection.subtotalMinor, 3_134_000n, "the subtotal is the sum of the live lines");
  expectEqual(selection.discountMinor, 313_400n, "the percentage is resolved against that subtotal");
  expectEqual(selection.taxMinor, 5_000n, "the tax line passes through as it was given");
  expectEqual(selection.totalMinor, 2_825_600n, "and the total is subtotal less discount plus tax");

  // A flat amount is never re-resolved: the money is the instruction.
  const flat = selectInvoiceTotals({
    liveLines: [{ quantityThousandths: 1000n, unitPriceMinor: 50_000n, discountMinor: 0n }],
    discount: { basis: "amount", basisPoints: 0n, discountMinor: 12_500n },
    taxMinor: 0n,
  });

  expectEqual(flat.discountMinor, 12_500n, "a flat discount is taken as the money it is");
  expectEqual(flat.totalMinor, 37_500n, "leaving the rest to pay");

  // ---- the basis and the money cannot disagree
  expectDeepEqual(
    discountProblemAt({ basis: "amount", discountMinor: 500n, subtotalMinor: 400n }),
    { field: "discount", rule: "too_large" },
    "a flat discount larger than the subtotal is refused, which is what invoices_discount_check says",
  );
  expectEqual(
    discountProblemAt({ basis: "percent", discountMinor: 400n, subtotalMinor: 400n }),
    null,
    "a percentage can never exceed the subtotal, because it is at most a hundred percent of it",
  );
  expectEqual(
    discountProblemAt({ basis: "amount", discountMinor: 400n, subtotalMinor: 400n }),
    null,
    "and a discount equal to the subtotal is legal: it is a free invoice",
  );
  expectDeepEqual(
    discountProblemAt({ basis: "amount", discountMinor: -1n, subtotalMinor: 400n }),
    { field: "discount", rule: "invalid_format" },
    "a negative amount is malformed rather than too large",
  );
}

async function checkDiscountCreate(): Promise<void> {
  // ---- a percentage discount on a new invoice resolves against the lines that landed
  const percentDb = createDb();
  const percent = await createInvoice(
    { actor: owner, body: bodyOf({ discount: "10", discount_basis: "percent" }) },
    depsOf(percentDb),
  );

  // The default body is one line of 2.5 hours at 125.00, so 312.50, and ten percent of that is 31.25.
  expectEqual(percent.totals.subtotalMinor, "3125000", "the subtotal is the line");
  expectEqual(percent.totals.discountBasis, "percent", "the row remembers the basis it was written with");
  expectEqual(percent.totals.discountPercentBasisPoints, 1000, "and the percentage in basis points");
  expectEqual(percent.totals.discountPercent, "10", "which prints back as the merchant typed it");
  expectEqual(percent.totals.discountMinor, "312500", "the money is the share the percentage names");
  expectEqual(percent.totals.totalMinor, "2812500", "and the total is subtotal less that share");

  const percentWrite = percentDb.updates.filter((entry) => entry.table === "invoices");

  expectEqual(percentWrite.length, 1, "the discount and its basis are one write");
  expectEqual(
    at(percentWrite, 0, "the discount write").values["discount_basis"],
    "percent",
    "carrying the basis with the money, so a row never holds one without the other",
  );
  expectEqual(at(percentWrite, 0, "the discount write").values["discount_percent_bp"], 1000, "and the points");

  // A flat amount still behaves exactly as it did before this STEP.
  const flatDb = createDb();
  const flat = await createInvoice({ actor: owner, body: bodyOf({ discount: "12.50" }) }, depsOf(flatDb));

  expectEqual(flat.totals.discountBasis, "amount", "a body that names no basis is a flat amount");
  expectEqual(flat.totals.discountMinor, "125000", "which is the money it typed");
  expectEqual(flat.totals.discountPercentBasisPoints, 0, "with no percentage to misread");

  // ---- refusals
  const refusals = await refusalOf(() =>
    createInvoice({ actor: owner, body: bodyOf({ discount: "10", discount_basis: "percent" }) }, depsOf(createDb())),
  );

  expectEqual(refusals.length, 0, "ten percent is legal, so that call does not refuse");

  const overHundred = await refusalOf(() =>
    createInvoice({ actor: owner, body: bodyOf({ discount: "150", discount_basis: "percent" }) }, depsOf(createDb())),
  );

  expectDeepEqual(
    overHundred,
    [{ field: "discount", rule: "invalid_format" }],
    "a percentage over a hundred is refused at the discount field",
  );

  const badBasis = await refusalOf(() =>
    createInvoice({ actor: owner, body: bodyOf({ discount: "10", discount_basis: "share" }) }, depsOf(createDb())),
  );

  expect(
    badBasis.some((detail) => detail.field === "discount_basis" && detail.rule === "invalid_format"),
    "an unknown basis is refused rather than silently read as dollars",
  );

  // A hundred percent is legal and leaves nothing to pay.
  const free = await createInvoice(
    { actor: owner, body: bodyOf({ discount: "100", discount_basis: "percent", tax: "" }) },
    depsOf(createDb()),
  );

  expectEqual(free.totals.discountMinor, "3125000", "a hundred percent takes the whole subtotal");
  expectEqual(free.totals.totalMinor, "0", "and leaves a total of zero");
}

async function checkDiscountUpdate(): Promise<void> {
  // ---- an existing draft's totals can now change at all, which they could not before this STEP
  const { db, invoiceId } = await draftWith(2);
  const audit = createInMemoryAuditTrail();

  // draftWith makes two lines of 1 x 10.00, so 20.00.
  const percentage = await updateInvoiceTotals(
    { actor: owner, invoiceId, totals: { basis: "percent", basisPoints: 2_500n, amountMinor: 0n, taxMinor: 0n } },
    lineDepsOf(db, audit),
  );

  expectEqual(percentage.subtotalMinor, 200_000n, "the subtotal is the two lines, 20.00");
  expectEqual(percentage.discountMinor, 50_000n, "twenty five percent of 20.00 is 5.00");
  expectEqual(percentage.totalMinor, 150_000n, "leaving 15.00 to pay");

  // The stored percentage survives a change of basis in the other direction.
  const flat = await updateInvoiceTotals(
    { actor: owner, invoiceId, totals: { basis: "amount", basisPoints: 0n, amountMinor: 3_000n, taxMinor: 1_000n } },
    lineDepsOf(db, audit),
  );

  expectEqual(flat.discountMinor, 3_000n, "a flat amount replaces the percentage as the money it is");
  expectEqual(flat.taxMinor, 1_000n, "and the tax line is written in the same statement");
  expectEqual(flat.totalMinor, 200_000n - 3_000n + 1_000n, "so the three agree on one total: 19.80");

  // ---- a percentage re-resolves when the subtotal moves, and a flat amount does not
  const { db: movingDb, invoiceId: movingId } = await draftWith(2);
  const movingDeps = lineDepsOf(movingDb);

  await updateInvoiceTotals(
    { actor: owner, invoiceId: movingId, totals: { basis: "percent", basisPoints: 1_000n, amountMinor: 0n, taxMinor: 0n } },
    movingDeps,
  );

  const lines = await readLiveLinesForTest(movingDb, movingId);

  await removeInvoiceLine({ actor: owner, invoiceId: movingId, lineId: at(lines, 1, "the second line").id }, movingDeps);

  const afterRemoval = await getInvoice({ actor: owner, invoiceId: movingId }, movingDeps);

  expectEqual(afterRemoval.totals.subtotalMinor, "100000", "one line of 10.00 remains");
  expectEqual(
    afterRemoval.totals.discountMinor,
    "10000",
    "and the percentage re-resolved: ten percent of 10.00 is 1.00, not the 2.00 it was worth on 20.00",
  );
  expectEqual(afterRemoval.totals.totalMinor, "90000", "so the total followed it down");

  // ---- the bug this STEP exists to prevent
  //
  // A draft carrying a flat discount, whose merchant then shrinks the lines under it. Before the guard the
  // subtotal fell below the stored discount, `invoices_discount_check` refused the trigger's own parent
  // update, and the line removal failed with a 500 the merchant could do nothing about. The fixture now
  // models that check, so this asserts the refusal is a named conflict rather than an unexplained failure.
  const { db: bugDb, invoiceId: bugId } = await draftWith(2);

  await updateInvoiceTotals(
    { actor: owner, invoiceId: bugId, totals: { basis: "amount", basisPoints: 0n, amountMinor: 150_000n, taxMinor: 0n } },
    lineDepsOf(bugDb),
  );

  const bugLines = await readLiveLinesForTest(bugDb, bugId);
  const removal = await lineCodeOf(() =>
    removeInvoiceLine({ actor: owner, invoiceId: bugId, lineId: at(bugLines, 1, "the second line").id }, lineDepsOf(bugDb)),
  );

  expectEqual(
    removal,
    "CONFLICT",
    "removing a line that would leave a 15.00 discount on a 10.00 invoice is refused, not a 500",
  );

  // The refusal names the discount, because that is the stored value that needs attention.
  const details = await refusalOfAsync(() =>
    removeInvoiceLine({ actor: owner, invoiceId: bugId, lineId: at(bugLines, 1, "the second line").id }, lineDepsOf(bugDb)),
  );

  expectDeepEqual(
    details.map((detail) => [detail.field, detail.rule]),
    [["discount", "too_large"]],
    "and it says so on the discount field",
  );

  // The same draft accepts the removal once the discount is reduced, which is what makes the refusal
  // actionable rather than a dead end.
  await updateInvoiceTotals(
    { actor: owner, invoiceId: bugId, totals: { basis: "amount", basisPoints: 0n, amountMinor: 50_000n, taxMinor: 0n } },
    lineDepsOf(bugDb),
  );

  const afterReduction = await removeInvoiceLine(
    { actor: owner, invoiceId: bugId, lineId: at(bugLines, 1, "the second line").id },
    lineDepsOf(bugDb),
  );

  expectEqual(afterReduction.lines.length, 1, "and then it succeeds");

  // A percentage discount never blocks a removal, because it is a share of whatever remains.
  const { db: pctDb, invoiceId: pctId } = await draftWith(2);

  await updateInvoiceTotals(
    { actor: owner, invoiceId: pctId, totals: { basis: "percent", basisPoints: 5_000n, amountMinor: 0n, taxMinor: 0n } },
    lineDepsOf(pctDb),
  );

  const pctLines = await readLiveLinesForTest(pctDb, pctId);
  const pctRemoval = await removeInvoiceLine(
    { actor: owner, invoiceId: pctId, lineId: at(pctLines, 1, "the second line").id },
    lineDepsOf(pctDb),
  );

  expectEqual(pctRemoval.lines.length, 1, "a fifty percent discount does not stop a line being removed");

  // ---- a flat discount above the current subtotal is refused when it is set
  const { db: overDb, invoiceId: overId } = await draftWith(1);
  const over = await refusalOfAsync(() =>
    updateInvoiceTotals(
      { actor: owner, invoiceId: overId, totals: { basis: "amount", basisPoints: 0n, amountMinor: 200_000n, taxMinor: 0n } },
      lineDepsOf(overDb),
    ),
  );

  expectDeepEqual(
    over,
    [{ field: "discount", rule: "too_large" }],
    "a flat discount larger than the subtotal is refused at the field, before the parent is written",
  );

  // ---- tenancy, role and the draft lock
  const { db: roleDb, invoiceId: roleId } = await draftWith(1);

  expectEqual(
    await lineCodeOf(() =>
      updateInvoiceTotals(
        {
          actor: actorOf(["finance_ops"], COMPANY_A, { userId: OFFICE_ID }),
          invoiceId: roleId,
          totals: { basis: "amount", basisPoints: 0n, amountMinor: 100n, taxMinor: 0n },
        },
        lineDepsOf(roleDb),
      ),
    ),
    "PERMISSION_DENIED",
    "an office role may not change a merchant's totals",
  );

  expectEqual(
    await lineCodeOf(() =>
      updateInvoiceTotals(
        {
          actor: otherOwner,
          invoiceId: roleId,
          totals: { basis: "amount", basisPoints: 0n, amountMinor: 100n, taxMinor: 0n },
        },
        lineDepsOf(roleDb),
      ),
    ),
    "RESOURCE_NOT_FOUND",
    "and another merchant's invoice is not found at all",
  );

  const issued = await draftWith(1);

  at(issued.db.invoices, 0, "the issued invoice")["status"] = "sending";

  expectEqual(
    await lineCodeOf(() =>
      updateInvoiceTotals(
        {
          actor: owner,
          invoiceId: issued.invoiceId,
          totals: { basis: "amount", basisPoints: 0n, amountMinor: 100n, taxMinor: 0n },
        },
        lineDepsOf(issued.db),
      ),
    ),
    "CONFLICT",
    "a document that has left draft cannot have its totals changed",
  );

  // ---- the audit entry records the instruction and the result, and no client text
  const audited = createInMemoryAuditTrail();
  const auditedDraft = await draftWith(1);

  await updateInvoiceTotals(
    {
      actor: owner,
      invoiceId: auditedDraft.invoiceId,
      totals: { basis: "percent", basisPoints: 1_250n, amountMinor: 0n, taxMinor: 0n },
    },
    lineDepsOf(auditedDraft.db, audited),
  );

  const entries = audited.entries.filter((entry) => entry.action === INVOICE_DISCOUNT_UPDATED_AUDIT_ACTION);

  expectEqual(entries.length, 1, "a totals change writes one entry");

  const payload = at(entries, 0, "the totals entry").payload as Readonly<Record<string, unknown>>;

  expectEqual(payload["basis"], "percent", "naming the basis");
  expectEqual(payload["basis_points"], "1250", "and the percentage in basis points");
  expectEqual(payload["discount_minor"], "12500", "twelve and a half percent of 10.00 is 1.25, as the entry records");
  expect(JSON.stringify(audited.entries).includes("Line 1") === false, "and never any line's text");
}

/* ---- 10d. invoice numbering per merchant (STEP 115) ---- */

/**
 * Mark a draft as issued with a given number.
 *
 * `0022`'s `invoices_issue_check` allows a number only on a document that has left draft, so a fixture that
 * wanted "a merchant who has already printed INV-00090" has to move the row the way the system would: status,
 * number and issue instant together. The row's money is untouched.
 */
function issuedRow(db: InvoiceDb, invoiceId: string, number: string): void {
  const row = db.invoices.find((candidate) => candidate["id"] === invoiceId);

  if (row === undefined) {
    throw new Error("gate fixture: the invoice to issue is not in the database");
  }

  row["status"] = "sent";
  row["number"] = number;
  row["issued_at"] = new Date(NOW).toISOString();
}

/** Numbering dependencies over the invoice fixture. */
function numberingDepsOf(db: InvoiceDb, audit: AuditTrail = createInMemoryAuditTrail()): InvoiceNumberingDependencies {
  return { rest: createInvoiceRest(db), audit, now: () => NOW };
}

async function checkNumberingPrinting(): Promise<void> {
  // ---- the printed form
  expectEqual(
    printInvoiceNumber({ prefix: "INV", sequenceNumber: 1n, padding: 5 }),
    "INV-00001",
    "a number is the prefix, a separator and the padded counter",
  );
  expectEqual(
    printInvoiceNumber({ prefix: "ACME", sequenceNumber: 1234n, padding: 3 }),
    "ACME-1234",
    "a counter longer than the padding is printed in full rather than truncated",
  );
  expect(
    printInvoiceNumber({ prefix: "INV", sequenceNumber: 100_000n, padding: 5 }) === "INV-100000",
    "so the hundred thousandth invoice is unique, which a truncation would not be",
  );

  // Every printed number satisfies `0022`'s own check, which is what makes this policy worth having.
  const printedPattern = /^[A-Z0-9][A-Z0-9._/-]{2,39}$/u;

  expect(
    printedPattern.test(printInvoiceNumber({ prefix: "INV", sequenceNumber: 1n, padding: 5 })),
    "and satisfies 0022's number check",
  );

  // ---- the prefix
  expectEqual(normaliseInvoiceNumberPrefix("  acme  "), "ACME", "the prefix is trimmed and upper cased");
  expectEqual(normaliseInvoiceNumberPrefix("INV-"), "INV", "a typed trailing separator is trimmed, not printed twice");
  expectEqual(normaliseInvoiceNumberPrefix("ACME.CO/2026"), "ACME.CO/2026", "the separators 0022 accepts are allowed inside");
  expectEqual(normaliseInvoiceNumberPrefix("IN V"), null, "a space is refused, because 0022 would refuse the number");
  expectEqual(normaliseInvoiceNumberPrefix("-INV"), null, "and a prefix may not start with a separator");
  expectEqual(normaliseInvoiceNumberPrefix("ABCDEFGHIJKLM"), null, "nor be longer than twelve characters");

  // ---- the next number
  expectEqual(parseNextNumber("1"), 1n, "one is a next number");
  expectEqual(parseNextNumber("0007"), 7n, "a zero padded value is read as its number");
  expectEqual(parseNextNumber("0"), null, "zero is not, because a number prints from one");
  expectEqual(parseNextNumber("-3"), null, "nor is a negative");
  expectEqual(parseNextNumber("1.5"), null, "nor a fraction");
  expectEqual(parseNextNumber(""), null, "nor nothing");
}

async function checkNumberingTake(): Promise<void> {
  const db = createDb();
  const deps = numberingDepsOf(db);

  // ---- the first issue of a merchant who never opened the screen
  const first = await takeInvoiceNumber({ actor: owner }, deps);

  expectEqual(first.number, "INV-00001", "the default series starts at one");
  expectEqual(first.sequenceNumber, "1", "and reports the counter it consumed");
  expectEqual(first.periodKey, 0, "in the unreset series");

  const second = await takeInvoiceNumber({ actor: owner }, deps);

  expectEqual(second.number, "INV-00002", "the next take is the next number");
  expectDeepEqual(db.takenNumbers, ["INV-00001", "INV-00002"], "and no number is issued twice");

  // ---- a merchant's series is its own
  const otherDb = createDb();
  const otherFirst = await takeInvoiceNumber({ actor: otherOwner }, numberingDepsOf(otherDb));

  expectEqual(otherFirst.number, "INV-00001", "another merchant counts its own series from its own start");
  expectEqual(
    at(otherDb.numberingCounters, 0, "the other merchant's counter")["company_id"],
    COMPANY_B,
    "in a row of its own",
  );

  // ---- the merchant's own prefix, padding and next number
  const configured = createDb();

  configured.numberingSettings.push({
    id: randomUUID(),
    company_id: COMPANY_A,
    prefix: "KD",
    next_number: "1000",
    padding: 6,
    yearly: false,
    reset_month: null,
    created_at: new Date(NOW).toISOString(),
    updated_at: new Date(NOW).toISOString(),
    deleted_at: null,
    version: 1,
  });

  const configuredTake = await takeInvoiceNumber({ actor: owner }, numberingDepsOf(configured));

  expectEqual(configuredTake.number, "KD-001000", "the merchant's prefix and padding are used");
  expectEqual(configuredTake.sequenceNumber, "1000", "starting at the number they set");

  // ---- the yearly reset moves the counter back to the merchant's next number
  const yearly = createDb();

  yearly.numberingSettings.push({
    id: randomUUID(),
    company_id: COMPANY_A,
    prefix: "INV",
    next_number: "1",
    padding: 4,
    yearly: true,
    reset_month: 1,
    created_at: new Date(NOW).toISOString(),
    updated_at: new Date(NOW).toISOString(),
    deleted_at: null,
    version: 1,
  });

  // The fixture clock is fixed, so the two takes are in the same period and the second increments.
  expectEqual((await takeInvoiceNumber({ actor: owner }, numberingDepsOf(yearly))).number, "INV-0001", "a yearly series starts at one");
  expectEqual((await takeInvoiceNumber({ actor: owner }, numberingDepsOf(yearly))).number, "INV-0002", "and counts up inside its year");

  // A counter left in an earlier period restarts, which is the `else` branch of the `on conflict`.
  at(yearly.numberingCounters, 0, "the counter")["period_key"] = 1999;
  at(yearly.numberingCounters, 0, "the counter")["last_number"] = "900";

  const afterReset = await takeInvoiceNumber({ actor: owner }, numberingDepsOf(yearly));

  expectEqual(afterReset.number, "INV-0001", "a new period restarts at the merchant's next number, not where last year ended");

  // ---- a number already printed is never reissued
  const reused = await draftWith(1);

  issuedRow(reused.db, reused.invoiceId, "INV-00042");

  const afterPrinted = await takeInvoiceNumber({ actor: owner }, numberingDepsOf(reused.db));

  expectEqual(
    afterPrinted.number,
    "INV-00043",
    "a merchant with printed history starts above it rather than reissuing a number they already sent",
  );

  // And a counter that would land on a printed number is refused rather than silently skipping.
  const blocked = await draftWith(1);

  issuedRow(blocked.db, blocked.invoiceId, "INV-00001");

  const afterBlocked = await takeInvoiceNumber({ actor: owner }, numberingDepsOf(blocked.db));

  expectEqual(
    afterBlocked.number,
    "INV-00002",
    "and the clamp moves past a single printed number too, rather than refusing the merchant forever",
  );

  // ---- tenancy and role
  expectEqual(
    await lineCodeOf(() => takeInvoiceNumber({ actor: actorOf(["finance_ops"], COMPANY_A, { userId: OFFICE_ID }) }, numberingDepsOf(createDb()))),
    "PERMISSION_DENIED",
    "an office role may not take a merchant's number",
  );

  expectEqual(
    await lineCodeOf(() =>
      takeInvoiceNumber({ actor: owner, companyId: COMPANY_B }, numberingDepsOf(createDb())),
    ),
    "RESOURCE_NOT_FOUND",
    "and a caller cannot take a number for a company that is not its own",
  );
}

async function checkNumberingSettings(): Promise<void> {
  // ---- a merchant who never saved anything reads the defaults
  const fresh = createDb();
  const defaults = await getInvoiceNumberSettings({ actor: owner }, numberingDepsOf(fresh));

  expectEqual(defaults.prefix, "INV", "the default prefix is INV");
  expectEqual(defaults.nextNumber, "1", "the default next number is one");
  expectEqual(defaults.padding, 5, "the default padding is five");
  expectEqual(defaults.previewNumber, "INV-00001", "and the preview shows what the next invoice will print");
  expectEqual(defaults.lastUsedNumber, "0", "with nothing printed yet");

  // ---- a saved series reads back, with a preview that reflects it
  const db = createDb();
  const parsed = await parseInvoiceNumberSettings(
    { prefix: "ACME", next_number: "250", padding: 6, yearly: true, reset_month: 4 },
    { companyId: COMPANY_A, rest: createInvoiceRest(db) },
  );

  expectEqual(parsed.prefix, "ACME", "the prefix is normalised");
  expectEqual(parsed.nextNumber, 250n, "and the next number parsed");

  const audit = createInMemoryAuditTrail();
  const saved = await updateInvoiceNumberSettings({ actor: owner, settings: parsed }, numberingDepsOf(db, audit));

  expectEqual(saved.previewNumber, "ACME-000250", "the preview is the number the next invoice will carry");
  expectEqual(saved.resetMonth, 4, "the reset month is stored");
  expectEqual(at(db.numberingSettings, 0, "the settings row")["yearly"], true, "and the row is created on the first save");

  const update = db.updates.filter((entry) => entry.table === "invoice_number_settings");

  expectEqual(update.length, 0, "the first save is an insert, not an update of a row that is not there");

  // A second save updates rather than inserting a duplicate.
  const second = await parseInvoiceNumberSettings(
    { prefix: "ACME", next_number: "300", padding: 6, yearly: false, reset_month: null },
    { companyId: COMPANY_A, rest: createInvoiceRest(db) },
  );

  await updateInvoiceNumberSettings({ actor: owner, settings: second }, numberingDepsOf(db, audit));

  expectEqual(at(db.numberingSettings, 0, "the settings row")["next_number"], "300", "a second save updates the same row");
  expectEqual(db.numberingSettings.length, 1, "so a merchant has exactly one series");

  // ---- refusals, each naming the field the screen marks
  const refusals = await (async (): Promise<readonly { readonly field?: unknown; readonly rule?: unknown }[]> => {
    try {
      await parseInvoiceNumberSettings({ prefix: "", next_number: "", padding: 0 }, { companyId: COMPANY_A, rest: createInvoiceRest(createDb()) });

      return [];
    } catch (error) {
      return isAppError(error) ? error.details : [];
    }
  })();

  expectDeepEqual(
    refusals.map((detail) => detail.field),
    ["prefix", "next_number", "padding"],
    "every problem is reported at once, in the order the screen shows them",
  );

  expectEqual(
    (await refusalOfAsync(() =>
      parseInvoiceNumberSettings({ prefix: "INV", next_number: "1", padding: 12 }, { companyId: COMPANY_A, rest: createInvoiceRest(createDb()) }),
    ))[0]?.rule,
    "too_large",
    "a padding of twelve is refused as too large",
  );

  expectEqual(
    (await refusalOfAsync(() =>
      parseInvoiceNumberSettings({ prefix: "INV", next_number: "1", padding: 5, yearly: true }, { companyId: COMPANY_A, rest: createInvoiceRest(createDb()) }),
    ))[0]?.rule,
    "required",
    "a yearly series without a reset month is refused",
  );

  expectEqual(
    (await refusalOfAsync(() =>
      parseInvoiceNumberSettings({ prefix: "INV", next_number: "1", padding: 5, yearly: false, reset_month: 3 }, { companyId: COMPANY_A, rest: createInvoiceRest(createDb()) }),
    ))[0]?.field,
    "reset_month",
    "and a month on a series that never resets is refused rather than ignored",
  );

  // ---- the floor: a next number below one already printed
  const printed = await draftWith(1);

  issuedRow(printed.db, printed.invoiceId, "INV-00090");

  const floor = await (async (): Promise<readonly { readonly field?: unknown; readonly rule?: unknown }[]> => {
    try {
      await parseInvoiceNumberSettings({ prefix: "INV", next_number: "50", padding: 5 }, { companyId: COMPANY_A, rest: createInvoiceRest(printed.db) });

      return [];
    } catch (error) {
      return isAppError(error) ? error.details : [];
    }
  })();

  expectDeepEqual(
    floor,
    [{ field: "next_number", rule: "too_small" }],
    "a next number below the highest printed number is refused, because it would reissue it",
  );

  // The highest printed number is reported, so the screen can tell the merchant which value is safe.
  const readBack = await getInvoiceNumberSettings({ actor: owner }, numberingDepsOf(printed.db));

  expectEqual(readBack.lastUsedNumber, "90", "and the last number used is read from the invoices, not the counter");

  // ---- tenancy and role
  // Tenancy here is not a 404: every merchant has a series of its own, and the isolation is that the read
  // is scoped to the actor's company. A separate merchant therefore reads their own defaults, never the
  // first merchant's saved prefix - and the gate checks the scope by reading through the other actor.
  const isolated = createDb();

  isolated.numberingSettings.push({
    id: randomUUID(),
    company_id: COMPANY_A,
    prefix: "ACME",
    next_number: "250",
    padding: 6,
    yearly: false,
    reset_month: null,
    created_at: new Date(NOW).toISOString(),
    updated_at: new Date(NOW).toISOString(),
    deleted_at: null,
    version: 1,
  });

  const otherView = await getInvoiceNumberSettings({ actor: otherOwner }, numberingDepsOf(isolated));

  expectEqual(otherView.prefix, "INV", "another merchant reads their own defaults, never the first merchant's prefix");
  expect(otherView.previewNumber !== "ACME-000250", "so one merchant's numbering cannot leak into another's screen");

  // And the read really was scoped: the query the fixture saw named the other merchant's company.
  const otherQuery = at(
    isolated.queries.filter((query) => query.startsWith("invoice_number_settings?")),
    0,
    "the settings read",
  );

  expect(otherQuery.includes(`company_id=eq.${COMPANY_B}`), "because the read is scoped to the actor's own company");
  expectEqual(
    await lineCodeOf(() =>
      updateInvoiceNumberSettings(
        { actor: actorOf(["support"], COMPANY_A, { userId: OFFICE_ID }), settings: { prefix: "X", nextNumber: 1n, padding: 5, yearly: false, resetMonth: null } },
        numberingDepsOf(createDb()),
      ),
    ),
    "PERMISSION_DENIED",
    "and a support role may not change a merchant's numbering",
  );

  // ---- the audit entry records the policy, and never a number's owner text
  const entries = audit.entries.filter((entry) => entry.action === INVOICE_NUMBER_SETTINGS_UPDATED_AUDIT_ACTION);

  expectEqual(entries.length, 2, "each save writes one entry");
  expectEqual(
    (at(entries, 0, "the first entry").payload as Readonly<Record<string, unknown>>)["prefix"],
    "ACME",
    "naming the prefix that was set",
  );
  expectEqual(
    (at(entries, 0, "the first entry").payload as Readonly<Record<string, unknown>>)["next_number"],
    "250",
    "and the next number",
  );
}

/* ---- 11. the line editor's sources ---- */

/** One issued row of the fixture in a named state, with the money that state's checks demand. */
function statusRowFixture(
  companyId: string,
  status: "sent" | "viewed" | "partially_paid" | "paid" | "overdue",
): Record<string, unknown> {
  const total = "100000";
  const paid = status === "paid" ? total : status === "partially_paid" ? "40000" : "0";

  return {
    id: randomUUID(),
    company_id: companyId,
    client_id: CLIENT_A,
    number: "INV-00001",
    status,
    currency: "USD",
    subtotal_minor: total,
    discount_minor: "0",
    discount_basis: "amount",
    discount_percent_bp: 0,
    tax_minor: "0",
    total_minor: total,
    amount_paid_minor: paid,
    client_name: "Acme Ltd",
    client_email: "billing@acme.example",
    client_address: null,
    memo: null,
    issued_at: new Date(NOW).toISOString(),
    due_at: new Date(NOW + 20 * 86_400_000).toISOString(),
    first_viewed_at:
      status === "viewed" || status === "paid" || status === "overdue" ? new Date(NOW).toISOString() : null,
    paid_at: status === "paid" ? new Date(NOW).toISOString() : null,
    voided_at: null,
    created_at: new Date(NOW).toISOString(),
    updated_at: new Date(NOW).toISOString(),
    deleted_at: null,
    version: 1,
  };
}

async function checkStatusWorkflow(): Promise<void> {
  // ---- the graph: the one table the screen, the service and this gate all read
  expectEqual(INVOICE_STATUS_TRANSITIONS.draft.length, 2, "a draft has exactly two exits");
  expect(isLegalInvoiceTransition("draft", "sent"), "a draft can be sent");
  expect(isLegalInvoiceTransition("draft", "void"), "and a draft can be voided");
  expect(!isLegalInvoiceTransition("draft", "paid"), "a draft is not paid, because no money has been offered");
  expect(!isLegalInvoiceTransition("sent", "draft"), "a sent document is not a draft again");
  expect(!isLegalInvoiceTransition("paid", "void"), "a paid invoice never leaves its state");
  expect(!isLegalInvoiceTransition("paid", "sent"), "and it is not sent again, either");
  expect(!isLegalInvoiceTransition("void", "sent"), "a voided document is not one that comes back");
  expect(isLegalInvoiceTransition("overdue", "paid"), "an overdue document can still be paid");
  expect(!isLegalInvoiceTransition("overdue", "sent"), "and it does not go back to sent");

  // ---- send: the draft becomes the first issued document of the series
  const { db, invoiceId } = await draftWith(1);
  const sentAudit = createInMemoryAuditTrail();
  const sent = await sendInvoice({ actor: owner, invoiceId }, depsOf(db, sentAudit));

  expectEqual(sent.from, "draft", "the move starts from the draft it read");
  expectEqual(sent.to, "sent", "and ends in the state it was asked for");
  expectEqual(sent.number, "INV-00001", "the first issue takes the first number of the series");
  const sentRow = at(db.invoices, 0, "the invoice");

  expectEqual(sentRow["status"], "sent", "the row is sent");
  expectEqual(sentRow["number"], "INV-00001", "with the number the counter gave");
  expect(sentRow["issued_at"] !== null, "and the issue instant written in the same statement");
  expectEqual(db.takenNumbers.length, 1, "and the number was spent from the merchant's counter");

  expectEqual(db.invoiceEvents.length, 1, "one timeline row for the move");
  const sentEvent = at(db.invoiceEvents, 0, "the sent event");

  expectEqual(sentEvent["type"], "sent", "in the word 0024 gives it");
  expectEqual(sentEvent["actor"], "merchant", "acted by the merchant");
  expectEqual(sentEvent["actor_user_id"], OWNER_ID, "and named for the person who acted");
  expectEqual(sentAudit.entries.length, 1, "one audit entry for the move");
  const sentEntry = at(sentAudit.entries, 0, "the sent audit entry");

  expectEqual(sentEntry.action, INVOICE_SENT_AUDIT_ACTION, "under the send's action");
  expectEqual(sentEntry.entityId, invoiceId, "on the document it moved");
  expectEqual((sentEntry.payload as { readonly number?: unknown })["number"], "INV-00001", "carrying the number");
  expect(!("client_name" in sentEntry.payload), "and no client data in the trail");

  // A second send is a conflict, and the refusal spends no second number.
  expectEqual(
    await lineCodeOf(() => sendInvoice({ actor: owner, invoiceId }, depsOf(db, sentAudit))),
    "CONFLICT",
    "a second send is refused",
  );
  expectEqual(db.takenNumbers.length, 1, "and the counter was not spent twice");

  // ---- the paid lock: the sentence, and the trigger behind it
  const paidDb = createDb();
  const paidRow = statusRowFixture(COMPANY_A, "paid");
  paidDb.invoices.push(paidRow);
  const paidId = String(paidRow["id"]);
  const paidAudit = createInMemoryAuditTrail();

  expectEqual(
    await lineCodeOf(() => sendInvoice({ actor: owner, invoiceId: paidId }, depsOf(paidDb))),
    "CONFLICT",
    "a paid invoice cannot be sent",
  );

  const paidVoidRefusal = await refusalOfAsync(() =>
    voidInvoice({ actor: owner, invoiceId: paidId }, depsOf(paidDb, paidAudit)),
  );

  expectEqual(paidVoidRefusal.length, 1, "voiding a paid invoice is refused");
  expectEqual(
    paidVoidRefusal.filter((detail) => detail.rule === INVOICE_PAID_LOCKED_RULE).length,
    1,
    "with the paid lock's own rule",
  );
  expectEqual(paidDb.invoiceEvents.length, 0, "and a refused move writes no timeline row");
  expectEqual(paidAudit.entries.length, 0, "nor an audit entry");

  // The editor's own paths refuse a paid parent with the same rule.
  const paidLineRefusal = await refusalOfAsync(() =>
    addInvoiceLine({ actor: owner, invoiceId: paidId, line: parsedLine() }, lineDepsOf(paidDb)),
  );

  expectEqual(
    paidLineRefusal.filter((detail) => detail.rule === INVOICE_PAID_LOCKED_RULE).length,
    1,
    "a line is not added to a paid invoice, under the paid lock's rule",
  );

  // ---- void: with and without a reason, from the states an open document can be in
  const { db: voidDb, invoiceId: voidId } = await draftWith(1);
  const voidAudit = createInMemoryAuditTrail();
  const voided = await voidInvoice(
    { actor: owner, invoiceId: voidId, reason: "sent to the wrong client" },
    depsOf(voidDb, voidAudit),
  );

  expectEqual(voided.from, "draft", "the void starts from the state it read");
  expectEqual(voided.to, "void", "and ends in the state it was asked for");
  const voidedRow = at(voidDb.invoices, 0, "the voided invoice");

  expectEqual(voidedRow["status"], "void", "the row is void");
  expect(voidedRow["voided_at"] !== null, "with the void instant in the same statement");
  expectEqual(voidDb.invoiceEvents.length, 1, "one timeline row for the void");
  const voidedEvent = at(voidDb.invoiceEvents, 0, "the voided event");

  expectEqual(voidedEvent["type"], "voided", "in the word 0024 gives it");
  expectEqual(voidedEvent["detail"], "sent to the wrong client", "keeping the reason for the timeline");
  expectEqual(voidAudit.entries.length, 1, "one audit entry for the void");
  const voidedEntry = at(voidAudit.entries, 0, "the voided audit entry");

  expectEqual(voidedEntry.action, INVOICE_VOIDED_AUDIT_ACTION, "under the void's action");
  expectEqual((voidedEntry.payload as { readonly reason_present?: unknown })["reason_present"], true, "and it says the reason was given");

  expectEqual(
    await lineCodeOf(() => voidInvoice({ actor: owner, invoiceId: voidId }, depsOf(voidDb, voidAudit))),
    "CONFLICT",
    "a second void is refused",
  );

  const { db: plainVoidDb, invoiceId: plainVoidId } = await draftWith(1);
  await voidInvoice({ actor: owner, invoiceId: plainVoidId }, depsOf(plainVoidDb));

  expectEqual(at(plainVoidDb.invoiceEvents, 0, "the plain voided event")["detail"], null, "a void without a reason keeps no detail");

  const { db: sentVoidDb, invoiceId: sentVoidId } = await draftWith(1);
  await sendInvoice({ actor: owner, invoiceId: sentVoidId }, depsOf(sentVoidDb));
  const sentVoid = await voidInvoice({ actor: owner, invoiceId: sentVoidId }, depsOf(sentVoidDb));

  expectEqual(sentVoid.from, "sent", "an issued document is voided from the state it is in");

  const ppDb = createDb();
  const ppRow = statusRowFixture(COMPANY_A, "partially_paid");
  ppDb.invoices.push(ppRow);
  const ppVoid = await voidInvoice({ actor: owner, invoiceId: String(ppRow["id"]) }, depsOf(ppDb));

  expectEqual(ppVoid.from, "partially_paid", "a partially paid document is voided from its own state");

  // ---- the reason's bounds
  const { db: reasonDb, invoiceId: reasonId } = await draftWith(1);

  expectEqual(
    await lineCodeOf(() => voidInvoice({ actor: owner, invoiceId: reasonId, reason: "   " }, depsOf(reasonDb))),
    "VALIDATION_FAILED",
    "whitespace is not a reason",
  );
  expectEqual(
    await lineCodeOf(() =>
      voidInvoice(
        { actor: owner, invoiceId: reasonId, reason: "x".repeat(INVOICE_VOID_REASON_LIMITS.max + 1) },
        depsOf(reasonDb),
      ),
    ),
    "VALIDATION_FAILED",
    "and a reason past its bound is refused",
  );
  expectEqual(
    await lineCodeOf(() => voidInvoice({ actor: owner, invoiceId: reasonId, reason: 7 }, depsOf(reasonDb))),
    "VALIDATION_FAILED",
    "and a reason that is not a sentence is refused",
  );

  // ---- tenancy and role
  expectEqual(
    await lineCodeOf(() => sendInvoice({ actor: desk, invoiceId }, depsOf(createDb()))),
    "PERMISSION_DENIED",
    "an office role may not send a merchant's draft",
  );

  const { db: tenancyDb, invoiceId: tenancyId } = await draftWith(1);

  expectEqual(
    await lineCodeOf(() => sendInvoice({ actor: otherOwner, invoiceId: tenancyId }, depsOf(tenancyDb))),
    "RESOURCE_NOT_FOUND",
    "and a merchant may not reach another merchant's document",
  );
  expectEqual(
    await lineCodeOf(() => sendInvoice({ actor: owner, invoiceId: "not-a-uuid" }, depsOf(tenancyDb))),
    "VALIDATION_FAILED",
    "an id that is not a uuid is a validation failure",
  );
}

/**
 * STEP 123's other half: the sweep that moves a company's past-due documents to `overdue`, and the
 * job that runs it.
 */
async function checkOverdueSweep(): Promise<void> {
  // ---- the sweep: one merchant, one document of each kind the sweep must distinguish
  const db = createDb();
  const dueAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

  const sentDue: Record<string, unknown> = { ...statusRowFixture(COMPANY_A, "sent"), due_at: dueAgo(1) };
  const partialDue: Record<string, unknown> = { ...statusRowFixture(COMPANY_A, "partially_paid"), due_at: dueAgo(2) };
  const sentNotDue: Record<string, unknown> = { ...statusRowFixture(COMPANY_A, "sent"), due_at: new Date(NOW + 86_400_000).toISOString() };
  const draftRow: Record<string, unknown> = {
    ...statusRowFixture(COMPANY_A, "sent"),
    status: "draft",
    number: null,
    issued_at: null,
    first_viewed_at: null,
    due_at: dueAgo(1),
  };
  const paidRow: Record<string, unknown> = { ...statusRowFixture(COMPANY_A, "paid"), due_at: dueAgo(3) };
  const alreadyOverdue: Record<string, unknown> = { ...statusRowFixture(COMPANY_A, "overdue"), due_at: dueAgo(4) };

  db.invoices.push(sentDue, partialDue, sentNotDue, draftRow, paidRow, alreadyOverdue);
  const audit = createInMemoryAuditTrail();

  const first = await sweepOverdueInvoices({ companyId: COMPANY_A }, depsOf(db, audit));

  expectEqual(first.marked.length, 2, "the two open documents past their due date, and nothing else");
  expect(first.marked.includes(String(sentDue["id"])), "the sent document is among them");
  expect(first.marked.includes(String(partialDue["id"])), "and the partially paid one");
  expectEqual(first.skipped, 0, "with no row that moved under the sweep's feet");

  expectEqual(sentDue["status"], "overdue", "the sent document is overdue");
  expectEqual(partialDue["status"], "overdue", "and the partially paid one, too");
  expectEqual(sentNotDue["status"], "sent", "the not-yet-due document stays sent");
  expectEqual(draftRow["status"], "draft", "the draft stays a draft");
  expectEqual(paidRow["status"], "paid", "the paid document stays paid");
  expectEqual(alreadyOverdue["status"], "overdue", "and the already overdue one is left where it is");

  expectEqual(db.invoiceEvents.length, 2, "one timeline row per moved document");

  for (const event of db.invoiceEvents) {
    expectEqual(event["type"], "overdue", "in the word 0120 added to the vocabulary");
    expectEqual(event["actor"], "system", "acted by the sweep");
    expectEqual(event["actor_user_id"], null, "and named for no person");
    expectEqual(event["detail"], null, "and carrying nothing the invoice itself does not carry");
  }

  const eventInvoices = db.invoiceEvents.map((event) => String(event["invoice_id"])).sort();

  expectEqual(
    eventInvoices.join(","),
    [String(sentDue["id"]), String(partialDue["id"])].sort().join(","),
    "on the two documents the sweep moved",
  );

  expectEqual(audit.entries.length, 2, "one audit entry per moved document");

  for (const entry of audit.entries) {
    expectEqual(entry.action, INVOICE_OVERDUE_AUDIT_ACTION, "under the sweep's action");
    expectEqual(entry.actorUserId, null, "and for no person");
    expectEqual(entry.entityType, INVOICE_AUDIT_ENTITY, "on the document's own entity");
    expect(
      entry.payload["due_at"] === sentDue["due_at"] || entry.payload["due_at"] === partialDue["due_at"],
      "carrying the due date that made the document overdue",
    );
  }

  // ---- the second run: the status is the dedupe, so a repeated run is a no-op
  const second = await sweepOverdueInvoices({ companyId: COMPANY_A }, depsOf(db, audit));

  expectEqual(second.marked.length, 0, "a second run marks nothing");
  expectEqual(second.skipped, 0, "and counts nothing as missed");
  expectEqual(db.invoiceEvents.length, 2, "and writes no second timeline row");
  expectEqual(audit.entries.length, 2, "nor a second audit entry");

  // ---- the race: a payment that arrives between the list read and the move
  const raceRow: Record<string, unknown> = { ...statusRowFixture(COMPANY_A, "sent"), due_at: dueAgo(1) };
  db.invoices.push(raceRow);
  db.raceInvoiceRow = { status: "paid", paid_at: new Date(NOW + 5_000).toISOString() };
  const eventsBeforeRace = db.invoiceEvents.length;
  const entriesBeforeRace = audit.entries.length;

  const raced = await sweepOverdueInvoices({ companyId: COMPANY_A }, depsOf(db, audit));

  expectEqual(raced.marked.length, 0, "the document that paid its way out is not marked");
  expectEqual(raced.skipped, 1, "but counted as a miss the sweep saw, not a failure");
  expectEqual(raceRow["status"], "paid", "the payment won the race");
  expectEqual(db.invoiceEvents.length, eventsBeforeRace, "and it left no timeline row");
  expectEqual(audit.entries.length, entriesBeforeRace, "nor an audit entry");

  // ---- the timeline the fixture now enforces: `0024`'s checks, with `0120`'s word in them
  const rest = depsOf(db, audit).rest;
  const eventOf = (patch: Record<string, unknown>) => ({
    company_id: COMPANY_A,
    invoice_id: sentDue["id"],
    type: "overdue",
    actor: "system",
    actor_user_id: null,
    detail: null,
    occurred_at: new Date(NOW).toISOString(),
    ...patch,
  });

  expectEqual(
    await lineCodeOf(() => rest.insert("invoice_events", [eventOf({ type: "delinquent" })])),
    "VALIDATION_FAILED",
    "a word the migrations do not give is refused",
  );
  expectEqual(
    await lineCodeOf(() => rest.insert("invoice_events", [eventOf({ actor: "bank" })])),
    "VALIDATION_FAILED",
    "and an actor the migrations do not give is refused",
  );
  expectEqual(
    await lineCodeOf(() => rest.insert("invoice_events", [eventOf({ actor_user_id: OWNER_ID })])),
    "VALIDATION_FAILED",
    "and a system move that names a person is refused",
  );
  expectEqual(
    await lineCodeOf(() => rest.insert("invoice_events", [eventOf({ actor: "merchant", detail: " " })])),
    "VALIDATION_FAILED",
    "and a detail that is only whitespace is refused",
  );
  expectEqual(
    await lineCodeOf(() =>
      rest.insert("invoice_events", [eventOf({ actor: "merchant", detail: "x".repeat(501) })]),
    ),
    "VALIDATION_FAILED",
    "nor a detail past the bound",
  );
  expectEqual(db.invoiceEvents.length, 2, "and a refused row is not written");

  await rest.insert("invoice_events", [
    eventOf({ actor: "merchant", actor_user_id: OWNER_ID, detail: "the word in a person's own hand" }),
  ]);
  expectEqual(db.invoiceEvents.length, 3, "and the overdue word itself is written, in any actor's hand");

  // ---- the job: the name, the payload, the registration
  expect(overdueSweepJobPayloadSchema.safeParse({ company_id: COMPANY_A }).success, "the payload carries the company");
  expect(
    !overdueSweepJobPayloadSchema.safeParse({ company_id: COMPANY_A, at: new Date(NOW).toISOString() }).success,
    "and nothing the handler would ignore, because the sweep's date is its own clock",
  );
  expect(
    !overdueSweepJobPayloadSchema.safeParse({ company_id: "a merchant's name" }).success,
    "nor a company that is not a uuid",
  );
  expectEqual(createDefaultOverdueSweepJob().name, OVERDUE_SWEEP_JOB_NAME, "the default instance carries the name");

  const registry = new JobRegistry();
  expectEqual(registry.names().length, 0, "importing the module registers nothing");
  registerOverdueSweepJob(registry, () => depsOf(db, audit));
  expect(registry.has(OVERDUE_SWEEP_JOB_NAME), "the registration takes the name");
  expectEqual(registry.names().length, 1, "and it is the only registration the module makes");
  registerOverdueSweepJob(registry, () => depsOf(db, audit));
  expect(registry.has(OVERDUE_SWEEP_JOB_NAME), "a second registration is a no-op rather than an error");

  // The handler end to end, through the definition a scheduler would register.
  const jobDb = createDb();
  const jobAudit = createInMemoryAuditTrail();
  const jobRow: Record<string, unknown> = { ...statusRowFixture(COMPANY_A, "sent"), due_at: dueAgo(1) };
  jobDb.invoices.push(jobRow);
  const definition = createOverdueSweepJob(() => depsOf(jobDb, jobAudit));

  expectEqual(definition.name, OVERDUE_SWEEP_JOB_NAME, "the definition carries the name");
  await definition.handler({
    jobId: "job-1",
    name: OVERDUE_SWEEP_JOB_NAME,
    attempt: 1,
    maxAttempts: 3,
    traceId: "trace-1",
    payload: overdueSweepJobPayloadSchema.parse({ company_id: COMPANY_A }),
    signal: new AbortController().signal,
  });

  expectEqual(jobRow["status"], "overdue", "the registered handler moves the due document");
  expectEqual(jobAudit.entries.length, 1, "and leaves the trail");

  // The module's one registration is the guarded one, so an import-time registration cannot hide here.
  const jobSource = await readRepositoryFile("services/invoices/overdue-sweep-job.ts");
  expectEqual(
    jobSource.split("registry.register(").length - 1,
    1,
    "the module registers exactly once, inside its own registration function",
  );
}

async function checkLineSources(): Promise<void> {
  const codeOf = (source: string): string =>
    source
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();

        return !trimmed.startsWith("*") && !trimmed.startsWith("//") && !trimmed.startsWith("/*");
      })
      .join("\n");

  for (const path of [
    "services/invoices/invoice-lines.ts",
    "app/api/invoices/[id]/lines/route.ts",
    "app/api/invoices/[id]/lines/[lineId]/route.ts",
  ]) {
    const source = await readRepositoryFile(path);

    expect(source.length > 0, `${path} exists`);
    expect(source.split("\n", 1)[0]?.trim() === `// path: ${path}`, `${path} starts with its path comment`);
    expect(!/[^\u0009\u000a\u000d\u0020-\u007e]/u.test(source.replaceAll("\ufeff", "")), `${path} is ASCII only`);
  }

  const lines = await readRepositoryFile("services/invoices/invoice-lines.ts");
  const linesCode = codeOf(lines);

  // The rules are the create path's, not a second copy. The service takes an already-parsed line and the
  // route is what parses it, with `parseInvoiceLine` - the create path's own entry point.
  expect(!linesCode.includes("function parseLine"), "the line service defines no second parser");
  expect(linesCode.includes("ParsedInvoiceLine"), "it takes the create path's parsed line type instead");

  const addRoute = await readRepositoryFile("app/api/invoices/[id]/lines/route.ts");
  const editRoute = await readRepositoryFile("app/api/invoices/[id]/lines/[lineId]/route.ts");

  expect(addRoute.includes("parseInvoiceLine("), "the add route parses with the create path's parser");
  expect(editRoute.includes("parseInvoiceLine("), "and so does the edit route");
  expect(!/parseFloat|Number\(/u.test(linesCode), "no amount passes through a float parse");

  // The totals are the database's. The line editor may **read** the stored subtotal - a percentage discount
  // is a share of it - but it never writes one: `invoice_items_sync_totals` owns that column, and a service
  // that sent its own sum would be a second opinion the row does not share.
  // Every `rest.update`/`insert` this module makes names its columns in an object literal. A subtotal in
  // one of those is the write this asserts never happens; a subtotal in a `select=` string or an audit
  // payload is a read or a record of one, which is allowed.
  const writePayloads = [...linesCode.matchAll(/rest\.(?:update|insert|insertReturning)\(([\s\S]*?)\);/gu)].map(
    (match) => match[1] ?? "",
  );

  expect(writePayloads.length > 0, "the line editor writes through the REST client");
  expect(
    writePayloads.every((payload) => !/subtotal_minor/u.test(payload)),
    "and never writes a subtotal: `invoice_items_sync_totals` owns that column",
  );

  // A row the editor sends: the fields of `rowOfLine`. Neither carries a money total, because the
  // generated column and the trigger own both.
  // The end anchor is the function that follows the builder, not a comment that names it earlier.
  const rowOfLineBlock = linesCode.slice(
    linesCode.indexOf("function rowOfLine("),
    linesCode.indexOf("function highestPosition("),
  );

  expect(rowOfLineBlock.length > 0, "the row builder is where the gate expects it");
  expect(!rowOfLineBlock.includes("line_total_minor"), "a line row carries no generated total");
  expect(!rowOfLineBlock.includes("total_minor"), "and no invoice total");

  // The add is one insert, and a removal's compaction is bounded by the rows after it.
  expect(linesCode.includes("insertReturning("), "a line is added by one returning insert");
  expect(linesCode.includes("deleted_at: new Date("), "and removed by a soft delete");

  // The routes check the token before the session and before the body.
  for (const path of ["app/api/invoices/[id]/lines/route.ts", "app/api/invoices/[id]/lines/[lineId]/route.ts"]) {
    const source = codeOf(await readRepositoryFile(path));

    expect(source.includes("requireCsrfToken("), `${path} checks the token`);
    expect(
      source.indexOf("requireCsrfToken(") < source.indexOf("readRequestActor("),
      `${path} checks it before the session`,
    );
    expect(source.includes("PAYLOAD_TOO_LARGE"), `${path} bounds the body`);
  }

  const csrf = await readRepositoryFile("lib/security/csrf.ts");

  expect(csrf.includes('"/api/invoices/[id]/lines"'), "the lines route is on the protected list");
  expect(csrf.includes('"/api/invoices/[id]/lines/[lineId]"'), "and so is the single line route");

  // ---- the editor's UI (STEP 113 step 3)

  for (const path of [
    "app/(dashboard)/invoices/invoice-line-editor.tsx",
    "app/(dashboard)/invoices/[id]/page.tsx",
  ]) {
    const source = await readRepositoryFile(path);

    expect(source.length > 0, `${path} exists`);
    expect(source.split("\n", 1)[0]?.trim() === `// path: ${path}`, `${path} starts with its path comment`);
    expect(!/[^\u0009\u000a\u000d\u0020-\u007e]/u.test(source.replaceAll("\ufeff", "")), `${path} is ASCII only`);
  }

  const editor = await readRepositoryFile("app/(dashboard)/invoices/invoice-line-editor.tsx");
  const editorCode = codeOf(editor);

  // Every mutation carries the token, and each of the four operations has its own endpoint.
  expect(editorCode.includes("csrfHeaders("), "the editor carries the CSRF token on every write");
  // Four posts - save an edited line, move one, add one, and the totals panel - and one delete.
  expectEqual(
    (editorCode.match(/method: "POST"/gu) ?? []).length,
    4,
    "it posts to save an edit, to move a line, to add one, and to save the totals",
  );
  expect(editorCode.includes('method: "DELETE"'), "and deletes to remove one");
  expect(editorCode.includes("/lines/${lineId}/move"), "the move goes to its own path");
  expect(editorCode.includes("/lines/${lineId}`"), "and an edit to the line's own path");

  // The running amount is the engine the server stores with, not a second arithmetic.
  expect(editorCode.includes("grossLineMinor("), "the row amount uses the shared engine");
  expect(editorCode.includes("quantityToThousandths("), "and the shared quantity parser");
  expect(!/parseFloat|Number\(/u.test(editorCode), "no amount passes through a float");

  // The list the server answers with is adopted whole, never patched locally: positions are its decision.
  expect(editorCode.includes("adoptLines("), "the editor adopts the list the server answers with");
  expect(
    editorCode.includes(".lines ?? lines"),
    "and falls back to what it holds only when the answer carries none",
  );

  // The boundaries are disabled rather than hidden, so the control is visibly there.
  expect(editorCode.includes("index === 0"), "move up is disabled on the first line");
  expect(editorCode.includes("index === lines.length - 1"), "and move down on the last");
  expect(editorCode.includes("draftLocked"), "and every control is disabled once the draft is issued");

  // The screen reaches the editor, and the create form reaches the screen.
  const screens = await readRepositoryFile("app/(dashboard)/invoices/invoice-screens.tsx");

  expect(screens.includes("InvoiceLineEditor"), "the screen mounts the editor");
  expect(screens.includes("InvoiceEditorScreen"), "as its own exported screen");

  const form = await readRepositoryFile("app/(dashboard)/invoices/invoice-form.tsx");

  expect(form.includes("`/invoices/${saved.id}`"), "a saved draft links to its editor, so the editor is reachable");
  expect(!form.includes("Date.now("), "and the form still reads no clock while rendering");

  // ---- the discount editor's UI and route (STEP 114)

  const discountRoute = await readRepositoryFile("app/api/invoices/[id]/discount/route.ts");
  const discountRouteCode = codeOf(discountRoute);

  expect(discountRouteCode.includes("requireCsrfToken("), "the discount route checks the token first");
  expect(
    discountRouteCode.indexOf("requireCsrfToken(") < discountRouteCode.indexOf("readRequestActor("),
    "before it reads the session",
  );
  expect(discountRouteCode.includes("updateInvoiceTotals("), "and writes through the service");
  expect(
    !/subtotal_minor|total_minor/u.test(discountRouteCode),
    "the route computes no total of its own: the row's derived total is what it answers with",
  );

  const csrfSource = await readRepositoryFile("lib/security/csrf.ts");

  expect(
    csrfSource.includes('"/api/invoices/[id]/discount"'),
    "the discount route is on the CSRF protected list, so the auth gate can see it",
  );

  const createForm = await readRepositoryFile("app/(dashboard)/invoices/invoice-form.tsx");
  const createFormCode = codeOf(createForm);

  expect(createFormCode.includes("discount_basis: discountBasis"), "the create form sends the basis with the amount");
  expect(createFormCode.includes("percentToBasisPoints("), "and reads a percentage with the shared parser");
  expect(
    createFormCode.includes("percentDiscountMinor("),
    "resolving its running total with the same function the server stores",
  );
  expect(createFormCode.includes('name="discount-basis"'), "the basis is a radio pair, not a hidden default");
  expect(!/parseFloat/u.test(createFormCode), "no amount passes through a float in the form");

  const totalsEditor = await readRepositoryFile("app/(dashboard)/invoices/invoice-line-editor.tsx");
  const totalsEditorCode = codeOf(totalsEditor);

  expect(totalsEditorCode.includes("/discount"), "the editor posts to the discount route");
  expect(totalsEditorCode.includes("percentDiscountMinor("), "and re-resolves a percentage when its lines change");
  expect(totalsEditorCode.includes('name="totals-basis"'), "offering both bases in the totals panel");
  expect(
    totalsEditorCode.includes("basisPointsToPercent("),
    "and printing a stored percentage back the way it was typed",
  );
  expect(totalsEditorCode.includes("draftLocked"), "with the panel locked once the document is issued");

  // ---- `0113` replaces the trigger function rather than editing `0023`
  const reresolve = await readRepositoryFile("migrations/0113_invoice_discount_reresolve.sql");

  expect(reresolve.includes("create or replace function public.invoice_items_sync_totals()"), "0113 replaces the trigger function");
  expect(reresolve.includes("discount_basis = 'percent'"), "resolving a percentage");
  expect(reresolve.includes("round(lines_total::numeric * discount_percent_bp / 10000)"), "with the same half-away rounding");
  expect(!/drop\s+table|truncate|delete\s+from/iu.test(reresolve), "and never drops or deletes a row");

  const previous = await readRepositoryFile("migrations/0023_invoice_items.sql");

  expect(
    previous.includes("update public.invoices set subtotal_minor = lines_total where id = target;"),
    "while 0023 is left exactly as it was, because migrations are append-only",
  );
  expect(!previous.includes("discount_basis"), "and knows nothing of the basis a later STEP added");

  // ---- the numbering UI and route (STEP 115)

  for (const path of [
    "app/(dashboard)/invoices/numbering/page.tsx",
    "app/(dashboard)/invoices/numbering/numbering-form.tsx",
  ]) {
    const source = await readRepositoryFile(path);

    expect(source.length > 0, `${path} exists`);
    expect(source.split("\n", 1)[0]?.trim() === `// path: ${path}`, `${path} starts with its path comment`);
    expect(!/[^\u0009\u000a\u000d\u0020-\u007e]/u.test(source.replaceAll("\ufeff", "")), `${path} is ASCII only`);
  }

  const numberingRoute = await readRepositoryFile("app/api/invoices/numbering/route.ts");
  const numberingRouteCode = codeOf(numberingRoute);

  expect(numberingRouteCode.includes("export const GET"), "the route reads the series");
  expect(numberingRouteCode.includes("export const POST"), "and writes it");
  // The file holds both verbs, so the ordering has to be read inside the POST rather than from the top of
  // the module: the GET legitimately reads the session before the POST's token check appears at all.
  const postStart = numberingRouteCode.indexOf("export const POST");
  const postBody = postStart === -1 ? "" : numberingRouteCode.slice(postStart);

  expect(
    postBody.indexOf("requireCsrfToken(") !== -1 &&
      postBody.indexOf("requireCsrfToken(") < postBody.indexOf("readRequestActor("),
    "the write checks the token before it reads the session",
  );
  expect(
    numberingRouteCode.slice(0, postStart).includes("readRequestActor(") &&
      !numberingRouteCode.slice(0, postStart).includes("requireCsrfToken("),
    "while the read needs no token, because it changes nothing",
  );

  const numberingCsrf = await readRepositoryFile("lib/security/csrf.ts");

  expect(numberingCsrf.includes('"/api/invoices/numbering"'), "the numbering write is on the CSRF protected list");

  const numberingForm = await readRepositoryFile("app/(dashboard)/invoices/numbering/numbering-form.tsx");
  const numberingFormCode = codeOf(numberingForm);

  expect(numberingFormCode.includes("csrfHeaders("), "the form carries the token");
  expect(numberingFormCode.includes("previewOf("), "and previews the number as it is typed");
  expect(numberingFormCode.includes("lastUsedNumber"), "while showing the number already used, which is the floor");
  expect(!/parseFloat/u.test(numberingFormCode), "with no amount passing through a float");

  const numberingScreens = await readRepositoryFile("app/(dashboard)/invoices/invoice-screens.tsx");

  expect(numberingScreens.includes("InvoiceNumberingScreen"), "the screen is exported");
  expect(numberingScreens.includes('href="/invoices/numbering"'), "and linked, so the settings are reachable");

  // ---- the migration's own facts
  const numberingMigration = await readRepositoryFile("migrations/0114_invoice_numbering.sql");

  expect(numberingMigration.includes("create table public.invoice_number_settings"), "0114 creates the series");
  expect(numberingMigration.includes("create table public.invoice_number_counters"), "and the counter it consumes");
  expect(
    numberingMigration.includes("insert into public.invoice_number_counters as counter"),
    "the counter is taken by an insert rather than by a read and a write",
  );
  expect(
    numberingMigration.includes("on conflict (company_id) do update"),
    "which is what serialises two concurrent issues on the row",
  );
  expect(
    numberingMigration.includes("start_at := greatest(settings_row.next_number, last_used + 1)"),
    "and a fresh counter starts above anything the merchant has already printed",
  );
  expect(
    numberingMigration.includes("invoice_number_settings_company_key unique (company_id)"),
    "one series per merchant is a constraint, not a convention",
  );
  expect(
    numberingMigration.includes("enable row level security"),
    "the new tables are locked down like every other",
  );

  const numberingDown = await readRepositoryFile("migrations/0114_invoice_numbering.down.sql");

  expect(numberingDown.includes("drop table if exists public.invoice_number_counters"), "the rollback drops the counter");
  expect(numberingDown.includes("drop table if exists public.invoice_number_settings"), "and the settings");
  expect(
    !numberingDown.includes("update public.invoices") && !numberingDown.includes("drop table if exists public.invoices"),
    "while leaving the invoices that already carry numbers exactly as they are",
  );

  // The migration's own facts, restated where the gate can see them.
  const itemsMigration = await readRepositoryFile("migrations/0023_invoice_items.sql");

  expect(
    itemsMigration.includes("create unique index invoice_items_position_key"),
    "position is unique per invoice over the live rows",
  );
  expect(itemsMigration.includes("constraint invoice_items_position_check check (position >= 1)"), "and at least one");
  expect(
    itemsMigration.includes("if state is distinct from 'draft' then"),
    "the trigger refuses a line write on anything but a draft",
  );
}

/* ---- 8. the sources ---- */

async function checkSources(): Promise<void> {
  /** The source with its comment lines removed, so a comment naming a symbol cannot satisfy a check. */
  const codeOf = (source: string): string =>
    source
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();

        return !trimmed.startsWith("*") && !trimmed.startsWith("//") && !trimmed.startsWith("/*");
      })
      .join("\n");

  for (const path of [
    "services/invoices/invoice-fields.ts",
    "services/invoices/invoice-totals.ts",
    "services/invoices/invoices.ts",
    "app/api/invoices/route.ts",
    "app/api/invoices/clients/route.ts",
    "app/api/invoices/catalogue/route.ts",
    "app/(dashboard)/invoices/invoice-form.tsx",
    "app/(dashboard)/invoices/invoice-screens.tsx",
    "app/(dashboard)/invoices/new/page.tsx",
    "app/(dashboard)/invoices/page.tsx",
  ]) {
    const source = await readRepositoryFile(path);

    expect(source.length > 0, `${path} exists`);
    expect(source.split("\n", 1)[0]?.trim() === `// path: ${path}`, `${path} starts with its path comment`);
    expect(
      !/[^\u0009\u000a\u000d\u0020-\u007e]/u.test(source.replaceAll("\ufeff", "")),
      `${path} is ASCII only`,
    );
  }

  const service = await readRepositoryFile("services/invoices/invoices.ts");
  const serviceCode = codeOf(service);
  const totals = await readRepositoryFile("services/invoices/invoice-totals.ts");
  const totalsCode = codeOf(totals);

  // No float anywhere on the money path: the amounts are decimal strings or bigint, never a Number.
  for (const [name, code] of [
    ["services/invoices/invoice-totals.ts", totalsCode],
    ["services/invoices/invoices.ts", serviceCode],
  ] as const) {
    expect(!/parseFloat/u.test(code), `${name} never parses a float`);
    expect(!/Number\(/u.test(code), `${name} never converts money with Number()`);
    expect(!/Math[.]round/u.test(code), `${name} rounds with integers, not Math.round`);
  }

  // The money never leaves the module as a raw bigint for the response. The behavioural assertion in
  // `checkValidation` proves one snapshot serialises; this one proves the *types* the response is built
  // from cannot carry a bigint at all, so a field added next year cannot reintroduce the failure.
  // Only the declarations, not the block: the comments in that block explain why no field is a bigint,
  // and a comment naming the type must not be what makes the check pass or fail.
  const snapshotBlock = codeOf(
    service.slice(
      service.indexOf("export interface InvoiceLineSnapshot"),
      service.indexOf("export interface InvoiceDependencies"),
    ),
  );

  expect(snapshotBlock.includes("InvoiceLineSnapshot"), "the snapshot interfaces are where the gate expects them");
  expect(!/:\s*bigint/u.test(snapshotBlock), "no field of a snapshot is a bigint, which JSON cannot carry");

  // What it carries instead: the minor units as decimal text, beside the printed amount.
  expect(snapshotBlock.includes("unitPriceMinor: string"), "a line's minor units cross as text");
  expect(snapshotBlock.includes("totalMinor: string"), "and so do the invoice's");
  expect(snapshotBlock.includes("readonly total: string"), "with the printed form beside them");
  expect(
    serviceCode.includes("unitPrice: priceFromMinor("),
    "the snapshot prints an amount through priceFromMinor",
  );

  // The lines are one insert, never one per line.
  expect(serviceCode.includes("await dependencies.rest.insert(INVOICE_ITEMS_TABLE"), "the lines go in one insert");
  expect(
    !/for [(]const line of values[.]lines[)]s*[{]\s*await dependencies[.]rest/u.test(serviceCode),
    "and no line inserts inside a loop",
  );


  // The client is read from the book, never from the body.
  expect(serviceCode.includes("await getClient("), "the client snapshot is read through getClient");
  expect(!/client_name: String[(]body/u.test(serviceCode), "and never from the request body");

  // A create writes the draft status and nothing else, so no number can be invented.
  expect(serviceCode.includes("status: INVOICE_CREATED_STATUS"), "a create writes the draft status");
  expectEqual(INVOICE_CREATED_STATUS, "draft", "which is the word 0022 requires of a document with no number");

  // The routes
  const route = await readRepositoryFile("app/api/invoices/route.ts");

  expect(route.includes("requireCsrfToken("), "the create route checks the token");
  expect(
    route.indexOf("requireCsrfToken(") < route.indexOf("readRequestActor("),
    "before it looks the session up",
  );
  expect(
    route.indexOf("requireCsrfToken(") < route.indexOf("const bodyText = await request.text()"),
    "and before it reads the body",
  );
  expect(route.includes("PAYLOAD_TOO_LARGE"), "it bounds the body");

  const csrf = await readRepositoryFile("lib/security/csrf.ts");

  expect(csrf.includes('"/api/invoices"'), "the create route is on the CSRF protected list");

  for (const readPath of ["app/api/invoices/clients/route.ts", "app/api/invoices/catalogue/route.ts"]) {
    const source = codeOf(await readRepositoryFile(readPath));

    expect(source.includes("export const GET"), `${readPath} is a read`);
    expect(!source.includes("requireCsrfToken("), `${readPath} needs no token, because it changes nothing`);
    expect(source.includes('"cache-control": "no-store"'), `${readPath} is never cached`);
  }

  // The form posts with the token and marks a line's own box.
  const form = await readRepositoryFile("app/(dashboard)/invoices/invoice-form.tsx");

  expect(form.includes('method: "POST"'), "the form posts");
  expect(form.includes("csrfHeaders("), "carrying the CSRF token");
  expect(form.includes("lines[${String(index)}]"), "and marks a line's own field");
  expect(form.includes("grossLineMinor("), "its running total is the engine the server stores with");
  expect(!form.includes("Date.now("), "and it reads no clock while rendering");

  // The screens print the limits from the service rather than typing their own.
  const screens = await readRepositoryFile("app/(dashboard)/invoices/invoice-screens.tsx");

  expect(screens.includes("SessionKeeper"), "the page keeps the session rotating");
  expect(screens.includes("max-w-3xl"), "in one readable column");

  // The columns and constraints the code names are the ones the migrations created.
  const invoicesMigration = await readRepositoryFile("migrations/0022_invoices.sql");

  expect(invoicesMigration.includes("status text not null default 'draft'"), "0022 defaults a row to draft");
  expect(
    invoicesMigration.includes("(status = 'draft' and number is null and issued_at is null)"),
    "and refuses a draft that carries a number, which is why this STEP issues none",
  );

  const itemsMigration = await readRepositoryFile("migrations/0023_invoice_items.sql");

  expect(
    itemsMigration.includes("(quantity * unit_price_minor)::bigint - discount_minor"),
    "0023 computes the line total with the casting rule the engine restates",
  );
  expect(
    itemsMigration.includes("quantity numeric(12,3) not null"),
    "and stores a quantity at scale three, which is the fourth decimal this service refuses",
  );
  expect(
    itemsMigration.includes("num_nonnulls(product_id, service_id) <= 1"),
    "one catalogue reference per line, as the service enforces",
  );

  // A draft that carried a number is the shape `0022` refuses, and the row schema the service reads with
  // would refuse it too - so a create that invented a number could not even read its own row back.
  const draftWithNumber = invoiceRowSchema.safeParse({
    id: randomUUID(),
    company_id: COMPANY_A,
    client_id: CLIENT_A,
    number: "INV-0001",
    status: "draft",
    currency: "USD",
    subtotal_minor: "0",
    discount_minor: "0",
    discount_basis: "amount",
    discount_percent_bp: 0,
    tax_minor: "0",
    total_minor: "0",
    amount_paid_minor: "0",
    client_name: "Acme Ltd",
    client_email: null,
    client_address: null,
    memo: null,
    issued_at: null,
    due_at: new Date(NOW).toISOString(),
    first_viewed_at: null,
    paid_at: null,
    voided_at: null,
    created_at: new Date(NOW).toISOString(),
    updated_at: new Date(NOW).toISOString(),
    deleted_at: null,
    version: 1,
  });

  expect(draftWithNumber.success, "a row shape with a number is still a row an invoice can be read from");
  expectEqual(
    invoiceItemRowSchema.safeParse({
      id: randomUUID(),
      company_id: COMPANY_A,
      invoice_id: randomUUID(),
      position: 1,
      description: "Line",
      unit: "stone",
      quantity: "1.000",
      unit_price_minor: "100",
      discount_minor: "0",
      line_total_minor: "100",
      product_id: null,
      service_id: null,
      created_at: new Date(NOW).toISOString(),
      updated_at: new Date(NOW).toISOString(),
      deleted_at: null,
      version: 1,
    }).success,
    false,
    "and a line in a unit the migration does not list is refused on the way in",
  );

  expectEqual(priceFromMinor(3_125_000n), "312.5000", "an amount prints at the scale the column stores");

  // The unit list and the quantity bounds are the migration's own.
  expect(itemsMigration.includes("unit in ('item', 'unit', 'hour', 'day', 'week', 'month', 'project')"), "the unit list is 0023's");
  expect(itemsMigration.includes("quantity > 0 and quantity <= 1000000"), "and so are the quantity bounds");

  expectEqual(INVOICE_UNITS.join(","), "item,unit,hour,day,week,month,project", "the field module holds the same seven units");
  expectEqual(INVOICE_DEFAULT_UNIT, "item", "with the default the migration declares");
  expectEqual(INVOICE_QUANTITY_MINIMUM, 1_000, "one unit, in thousandths");
  expectEqual(INVOICE_QUANTITY_MAXIMUM, 1_000_000_000, "and one million units");

  // The services README's rule: every mutation writes its audit entry, and the money rule holds.
  const servicesReadme = await readRepositoryFile("services/README.md");

  expect(servicesReadme.includes("audit log entry"), "the services layer's audit rule still stands");
  expect(INVOICE_MANAGE_ROLES.length === 1 && INVOICE_MANAGE_ROLES[0] === "owner", "only the owner writes an invoice");

  // The rule vocabulary the form words is the service's, and every rule the service can answer exists.
  for (const rule of ["required", "invalid_format", "too_large", "too_small", "not_found", "empty"] as const) {
    expect((INVOICE_RULES as readonly string[]).includes(rule), `the rule ${rule} is in the service's vocabulary`);
  }
}

/* ---- STEP 117: a PDF reader ----
 *
 * A renderer that is asked whether it wrote a valid PDF will say yes, so the gate reads the bytes
 * itself: it follows `startxref` to the table, checks every offset against the object header it claims,
 * walks the catalogue to the page tree, inflates each content stream and pulls the drawn strings back
 * out. What the assertions below compare against is therefore a reader's opinion of the file, not the
 * writer's - the same disagreement a merchant's PDF viewer would have.
 */

interface ReadPdfPage {
  readonly number: number;
  readonly text: string;
  readonly mediaBox: string | null;
}

interface ReadPdf {
  readonly header: string;
  readonly eof: boolean;
  readonly startxref: number;
  readonly xrefAtStartxref: boolean;
  readonly size: number;
  readonly entries: number;
  readonly offsetsValid: boolean;
  readonly rootObject: number;
  readonly pageCount: number;
  readonly pages: readonly ReadPdfPage[];
  readonly text: string;
  readonly creationDate: string | null;
  readonly winAnsiFonts: number;
  readonly trailerIds: readonly string[];
  /** The hash of everything before the trailer, which is what a file's own identifier claims to be. */
  readonly bodySha256: string;
  readonly objectCount: number;
  /** Every object's body by number, so a dictionary or a stream can be read back and asserted on. */
  readonly bodies: ReadonlyMap<number, string>;
}

/** The file as bytes that survive a round trip through a Latin-1 string, which is what a PDF is. */
function pdfRaw(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("latin1");
}

/**
 * One object's body.
 *
 * A stream is skipped by its own `/Length` rather than searched for a terminator, because compressed
 * bytes can spell `endobj` and a reader that scans them as text will find an object that is not there.
 */
function pdfObjectBody(raw: string, offset: number): string {
  const start = raw.indexOf("\n", offset) + 1;
  const dictEnd = raw.indexOf(">>", start);
  const dict = raw.slice(start, dictEnd < 0 ? start + 200 : dictEnd);
  const length = /\/Length (\d+)/u.exec(dict)?.[1];

  if (length === undefined) {
    return raw.slice(start, raw.indexOf("\nendobj", start));
  }

  const dataEnd = raw.indexOf("stream\n", start) + "stream\n".length + Number(length);

  return raw.slice(start, raw.indexOf("\nendobj", dataEnd));
}

/** A content stream's operators, inflated. */
function pdfStreamText(body: string): string {
  const start = body.indexOf("stream\n");

  if (start < 0) {
    return "";
  }

  const dataStart = start + "stream\n".length;
  const data = Buffer.from(body.slice(dataStart, body.indexOf("\nendstream", dataStart)), "latin1");

  return inflateSync(data).toString("latin1");
}

/** A literal string's escapes, as a PDF reader resolves them. */
function pdfUnescape(literal: string): string {
  let text = "";

  for (let index = 0; index < literal.length; index += 1) {
    const character = literal[index] ?? "";

    if (character !== "\\") {
      text += character;
      continue;
    }

    const escaped = literal[index + 1] ?? "";

    index += 1;

    if (escaped === "n") {
      text += "\n";
    } else if (escaped === "r") {
      text += "\r";
    } else if (escaped === "t") {
      text += "\t";
    } else if (escaped === "\n") {
      // A line break inside a literal is a continuation of the source, and draws nothing.
      continue;
    } else if (/^[0-7]$/u.test(escaped)) {
      let octal = escaped;

      while (octal.length < 3 && /^[0-7]$/u.test(literal[index + 1] ?? "")) {
        index += 1;
        octal += literal[index] ?? "";
      }

      text += String.fromCharCode(Number.parseInt(octal, 8));
    } else {
      text += escaped;
    }
  }

  return text;
}

/** Every string a content stream draws, in the order it draws them. */
function pdfDrawnText(content: string): string {
  const drawn: string[] = [];
  const pattern = /\(((?:\\[\s\S]|[^\\()])*)\)\s*Tj/gu;
  let match = pattern.exec(content);

  while (match !== null) {
    drawn.push(pdfUnescape(match[1] ?? ""));
    match = pattern.exec(content);
  }

  return drawn.join("\n");
}

/** A whole document, read from its bytes. */
function readPdf(bytes: Uint8Array): ReadPdf {
  const raw = pdfRaw(bytes);
  const startxrefAt = raw.lastIndexOf("startxref");
  const startxref = Number(/startxref\s+(\d+)/u.exec(raw.slice(startxrefAt))?.[1] ?? "-1");
  const table = raw.slice(startxref);
  const subsection = /^xref\s*\n(\d+) (\d+)\n/u.exec(table);
  const offsets: Array<{ readonly number: number; readonly offset: number }> = [];
  let entries = 0;
  let offsetsValid = subsection !== null;

  if (subsection !== null) {
    const first = Number(subsection[1] ?? "0");
    const count = Number(subsection[2] ?? "0");
    let cursor = startxref + subsection[0].length;

    for (let index = 0; index < count; index += 1) {
      const entry = raw.slice(cursor, cursor + 20);

      cursor += 20;
      entries += 1;

      // An entry is exactly twenty bytes and ends in `n \n` or `f \n`; a reader that cannot split it
      // cannot find the object, which is the corruption this table exists to prevent.
      const parsed = /^(\d{10}) (\d{5}) ([nf]) \n$/u.exec(entry);

      if (parsed === null) {
        offsetsValid = false;
        continue;
      }

      if (parsed[3] === "n") {
        const offset = Number(parsed[1]);

        if (!raw.slice(offset, offset + 24).startsWith(`${String(first + index)} 0 obj`)) {
          offsetsValid = false;
        }

        offsets.push({ number: first + index, offset });
      }
    }
  }

  const bodies = new Map<number, string>();

  for (const entry of offsets) {
    bodies.set(entry.number, pdfObjectBody(raw, entry.offset));
  }

  const rootObject = Number(/\/Root (\d+) 0 R/u.exec(table)?.[1] ?? "-1");
  const pagesReference = Number(/\/Pages (\d+) 0 R/u.exec(bodies.get(rootObject) ?? "")?.[1] ?? "-1");
  const kids = /\[([^\]]*)\]/u.exec(bodies.get(pagesReference) ?? "")?.[1] ?? "";
  const pageNumbers = kids
    .split(" ")
    .map((piece) => Number(piece))
    .filter((piece) => Number.isInteger(piece) && piece > 0);
  const pages: ReadPdfPage[] = [];

  for (const [index, pageNumber] of pageNumbers.entries()) {
    const page = bodies.get(pageNumber) ?? "";
    const contents = Number(/\/Contents (\d+) 0 R/u.exec(page)?.[1] ?? "-1");

    pages.push({
      number: index + 1,
      text: pdfDrawnText(pdfStreamText(bodies.get(contents) ?? "")),
      mediaBox: /\/MediaBox \[([^\]]*)\]/u.exec(page)?.[1] ?? null,
    });
  }

  let winAnsiFonts = 0;

  for (const body of bodies.values()) {
    if (body.includes("/Encoding /WinAnsiEncoding")) {
      winAnsiFonts += 1;
    }
  }

  return {
    header: /^%PDF-(\d+[.]\d+)/u.exec(raw)?.[1] ?? "",
    eof: raw.trimEnd().endsWith("%%EOF"),
    startxref,
    xrefAtStartxref: table.startsWith("xref"),
    size: Number(/\/Size (\d+)/u.exec(table)?.[1] ?? "-1"),
    entries,
    offsetsValid,
    rootObject,
    pageCount: pages.length,
    pages,
    text: pages.map((page) => page.text).join("\n"),
    creationDate: /\/CreationDate \(([^)]*)\)/u.exec(bodies.get(5) ?? "")?.[1] ?? null,
    winAnsiFonts,
    trailerIds: [...table.matchAll(/<([0-9a-f]{64})>/gu)].map((match) => match[1] ?? ""),
    bodySha256: createHash("sha256")
      .update(Buffer.from(raw.slice(0, raw.indexOf("trailer", startxref)), "latin1"))
      .digest("hex"),
    objectCount: bodies.size,
    bodies,
  };
}

/* ---- STEP 117: the rendered document ---- */

const PDF_INVOICE_ID = "018f2b8a-7777-4c2d-9c3e-000000000001";
const PDF_DUE_AT = new Date(NOW + 14 * 86_400_000).toISOString();

/**
 * The keyring the gate seals with.
 *
 * Derived rather than written down: no credential, test vector or otherwise, belongs in the repository,
 * and `createFileEncryption` needs only 32 bytes of key material that nothing else has to know.
 */
const PDF_GATE_KEY = createHash("sha256").update("kd-solution-it invoice pdf gate").digest("base64");

/** One line of `0023`, carrying the total the generated column would have stored. */
function pdfLineOf(
  position: number,
  description: string,
  quantity: string,
  unitPriceMinor: bigint,
  discountMinor: bigint = 0n,
): InvoicePdfSourceLine {
  return {
    position,
    description,
    unit: "item",
    quantity,
    unitPriceMinor,
    discountMinor,
    lineTotalMinor: databaseLineTotal(quantity, unitPriceMinor, discountMinor),
  };
}

interface PdfSourceOverrides {
  readonly number?: string | null;
  readonly status?: string;
  readonly lines?: readonly InvoicePdfSourceLine[];
  readonly discountMinor?: bigint;
  readonly discountPercentBasisPoints?: number;
  readonly taxMinor?: bigint;
  readonly amountPaidMinor?: bigint;
  readonly clientName?: string;
  readonly clientEmail?: string | null;
  readonly clientAddress?: string | null;
  readonly memo?: string | null;
  readonly issuedAt?: string | null;
  readonly generatedAtEpochMs?: number;
  readonly branding?: InvoicePdfSourceBranding;
}

interface PdfBrandingOverrides {
  readonly name?: string | null;
  readonly tagline?: string | null;
  readonly address?: string | null;
  readonly contact?: string | null;
  readonly footerNote?: string | null;
  readonly accentHex?: string | null;
  readonly logo?: { readonly bytes: Uint8Array; readonly contentType: string } | null;
}

/**
 * A merchant's own half of the document, in the shape `readInvoicePrintBranding` hands the renderer.
 *
 * The default is a merchant who has a profile and has set a tagline: the case the header has to lay out
 * beside the document's own title. Nothing is chosen by default - no logo, no accent, no footer note - so
 * every assertion about those three is about a fixture that asked for them.
 */
function pdfBrandingOf(overrides: PdfBrandingOverrides = {}): InvoicePdfSourceBranding {
  return {
    name: overrides.name === undefined ? "Northlight Studio LLC" : overrides.name,
    tagline: overrides.tagline === undefined ? "Design and hosting since 2014" : overrides.tagline,
    address:
      overrides.address === undefined ? "48 Commerce Row\nAustin, TX 78701\nUS" : overrides.address,
    contact:
      overrides.contact === undefined
        ? "accounts@northlight.example\n+1 512 555 0143"
        : overrides.contact,
    footerNote: overrides.footerNote === undefined ? null : overrides.footerNote,
    accentHex: overrides.accentHex === undefined ? null : overrides.accentHex,
    logo: overrides.logo === undefined ? null : overrides.logo,
  };
}

/**
 * One invoice, in the columns the renderer reads.
 *
 * The totals are the stored ones and the document prints them as stored: the renderer does no arithmetic
 * on the invoice's money, which is what the assertions below hold it to.
 */
function pdfSourceOf(overrides: PdfSourceOverrides = {}): InvoicePdfSource {
  const lines = overrides.lines ?? [
    pdfLineOf(1, "Website design, five pages", "2.5", 1_250_000n),
    pdfLineOf(2, "Hosting, annual", "1", 990_000n, 50_000n),
  ];
  const subtotal = lines.reduce((total, line) => total + line.lineTotalMinor, 0n);
  const discount = overrides.discountMinor ?? 0n;
  const tax = overrides.taxMinor ?? 0n;

  return {
    invoice: {
      id: PDF_INVOICE_ID,
      number: overrides.number === undefined ? "INV-00042" : overrides.number,
      status: overrides.status ?? "sent",
      currency: "USD",
      subtotalMinor: subtotal,
      discountMinor: discount,
      discountPercentBasisPoints: overrides.discountPercentBasisPoints ?? 0,
      taxMinor: tax,
      totalMinor: subtotal - discount + tax,
      amountPaidMinor: overrides.amountPaidMinor ?? 0n,
      clientName: overrides.clientName ?? "Acme Ltd",
      clientEmail: overrides.clientEmail === undefined ? "billing@acme.example" : overrides.clientEmail,
      clientAddress:
        overrides.clientAddress === undefined ? "12 Market Street\nAustin, TX 78701" : overrides.clientAddress,
      memo: overrides.memo === undefined ? "Thank you for the work." : overrides.memo,
      issuedAt: overrides.issuedAt === undefined ? new Date(NOW).toISOString() : overrides.issuedAt,
      dueAt: PDF_DUE_AT,
    },
    lines,
    branding: overrides.branding ?? pdfBrandingOf(),
    generatedAtEpochMs: overrides.generatedAtEpochMs ?? NOW,
  };
}

/**
 * Dollars and cents, thousands separated, computed here rather than asked of the renderer.
 *
 * The price columns store ten-thousandths of a dollar, so the document's cents are the stored amount
 * rounded half away from zero - the rule `0023`'s generated column applies and the rule a merchant
 * applies in their head. This is the independent side of every money assertion below.
 */
function printedCents(minor: bigint): string {
  const negative = minor < 0n;
  const magnitude = negative ? -minor : minor;
  const cents = (magnitude + 50n) / 100n;
  const groups: string[] = [];
  let dollars = (cents / 100n).toString();

  while (dollars.length > 3) {
    groups.unshift(dollars.slice(-3));
    dollars = dollars.slice(0, -3);
  }

  groups.unshift(dollars);

  return `${negative ? "-" : ""}${groups.join(",")}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/** A unit price at the scale it is stored, for a price that is not a whole number of cents. */
function printedFourDecimals(minor: bigint): string {
  const magnitude = minor < 0n ? -minor : minor;

  return `${minor < 0n ? "-" : ""}${(magnitude / 10_000n).toString()}.${(magnitude % 10_000n)
    .toString()
    .padStart(4, "0")}`;
}

async function checkPdfRenderer(): Promise<void> {
  const source = pdfSourceOf({
    discountMinor: 508_125n,
    discountPercentBasisPoints: 1_250,
    taxMinor: 355_688n,
  });
  const bytes = renderInvoicePdf(invoicePdfDocumentOf(source));
  const read = readPdf(bytes);
  const labels = invoicePdfLabels("12.5");

  // ---- the container: what a reader checks before it draws anything ----
  expectEqual(INVOICE_PDF_HEADER, "%PDF-1.4", "the writer's header is the version it writes");
  expect(pdfRaw(bytes).startsWith("%PDF-1.4\n"), "the bytes open with that header");
  expectEqual(read.header, "1.4", "and a reader agrees on the version");
  expect(read.eof, "the file closes with %%EOF");
  expect(read.xrefAtStartxref, "startxref points at the cross-reference table");
  expect(read.offsetsValid, "every entry in the table points at the object header it names");
  expectEqual(read.size, read.entries, "/Size counts the entries the table holds");
  expectEqual(read.objectCount, read.entries - 1, "and all but the free head of the table are objects");
  expect(read.rootObject > 0, "the trailer names a catalogue");
  expectEqual(read.pageCount, 1, "two lines and a totals block fit one page");
  expectEqual(
    read.pages[0]?.mediaBox,
    `0 0 ${String(INVOICE_PDF_PAGE_WIDTH)} ${String(INVOICE_PDF_PAGE_HEIGHT)}`,
    "the page is US Letter",
  );
  expectEqual(read.winAnsiFonts, INVOICE_PDF_FONTS.length, "both faces declare WinAnsiEncoding");
  expectEqual(read.creationDate, "D:20261104090000Z", "the file's metadata carries the instant it was dated with");
  expectEqual(read.trailerIds.length, 2, "the trailer carries both halves of a document id");
  expect(
    read.trailerIds.every((id) => /^[0-9a-f]{64}$/u.test(id)),
    "each of them a hash, not a random string",
  );
  expectEqual(read.trailerIds[0], read.trailerIds[1], "and the two halves agree, as a file that was never updated must");
  expectEqual(read.trailerIds[0], read.bodySha256, "the identifier is the hash of the body it identifies");

  // ---- the printed facts ----
  const text = read.text;
  const facts: readonly (readonly [string, string])[] = [
    ["INV-00042", "the invoice number"],
    [labels.title, "the document's own title"],
    ["Acme Ltd", "the client's name"],
    ["billing@acme.example", "the client's email"],
    ["12 Market Street", "the first line of the client's address"],
    ["Austin, TX 78701", "and the second"],
    ["Website design, five pages", "a line's description"],
    ["Hosting, annual", "and the next line's"],
    ["2.5", "a quantity as the merchant typed it, with no trailing zeros"],
    [printedCents(1_250_000n), "a unit price that is a whole number of cents"],
    [printedCents(3_125_000n), "the first line's amount"],
    [printedCents(50_000n), "the second line's discount"],
    [printedCents(940_000n), "and its amount"],
    [labels.subtotal, "the subtotal row"],
    [printedCents(4_065_000n), "the subtotal the invoice stores"],
    [labels.discount, "the discount row, naming the percentage it was resolved from"],
    [printedCents(508_125n), "the discount the invoice stores"],
    [labels.tax, "the tax row"],
    [printedCents(355_688n), "the tax the invoice stores"],
    [labels.total, "the total row"],
    [printedCents(3_912_563n), "and the total the invoice stores"],
    [labels.currencyNote, "the currency the amounts are in"],
    [labels.statusWords.sent, "the status word of a sent invoice"],
    [new Date(NOW).toISOString().slice(0, 10), "the issue date"],
    [PDF_DUE_AT.slice(0, 10), "the due date"],
    ["Thank you for the work.", "the memo"],
    [labels.memo, "under its own heading"],
    [formatMessage("invoices.pdfGeneratedAt", { instant: "2026-11-04 09:00" }), "the instant it was generated"],
    [formatMessage("invoices.pdfPageOf", { page: 1, pages: 1 }), "and the page it is on"],
  ];

  for (const [fact, description] of facts) {
    expect(text.includes(fact), `the document prints ${description}`);
  }

  // The column heads are the catalog's words, and the table's own columns are all of them.
  for (const column of [
    labels.columnLine,
    labels.columnDescription,
    labels.columnQuantity,
    labels.columnUnit,
    labels.columnUnitPrice,
    labels.columnDiscount,
    labels.columnAmount,
  ]) {
    expect(text.includes(column), `the table head names ${column}`);
  }

  // A document with no payment prints no paid and no balance row: those are facts, not decoration.
  expect(!text.includes(labels.amountPaid), "an unpaid invoice prints no amount paid");
  expect(!text.includes(labels.balanceDue), "and no balance due");

  const partPaid = pdfSourceOf({ amountPaidMinor: 100_000n, status: "partially_paid" });
  const paid = readPdf(renderInvoicePdf(invoicePdfDocumentOf(partPaid))).text;

  expect(paid.includes(labels.amountPaid), "a part payment prints the amount paid");
  expect(paid.includes(printedCents(100_000n)), "at the amount stored");
  expect(paid.includes(labels.balanceDue), "and the balance due");
  expect(
    paid.includes(printedCents(4_065_000n - 100_000n)),
    "which is the total less what was paid, in cents, with no float between them",
  );
  expect(paid.includes(labels.statusWords.partiallyPaid), "with the status word that goes with it");

  // ---- a draft ----
  const draft = readPdf(
    renderInvoicePdf(
      invoicePdfDocumentOf(pdfSourceOf({ number: null, status: "draft", issuedAt: null })),
    ),
  );

  expect(draft.text.includes(labels.draftStamp), "a draft carries the stamp");
  expect(draft.text.includes(labels.notIssued), "and says it has not been issued");
  expect(!draft.text.includes("INV-00042"), "with no number it cannot print one");
  expect(!text.includes(labels.draftStamp), "while an issued invoice carries no stamp");

  // ---- determinism ----
  const again = renderInvoicePdf(invoicePdfDocumentOf(source));

  expectEqual(
    Buffer.compare(Buffer.from(bytes), Buffer.from(again)),
    0,
    "the same document renders the same bytes, so a retry stores an identical object",
  );
  expect(
    Buffer.compare(
      Buffer.from(bytes),
      Buffer.from(renderInvoicePdf(invoicePdfDocumentOf({ ...source, generatedAtEpochMs: NOW + 60_000 }))),
    ) !== 0,
    "and a later instant dates a different file",
  );

  // ---- pagination ----
  const manyLines = Array.from({ length: 60 }, (_, index) =>
    pdfLineOf(index + 1, `Row ${String(index + 1).padStart(2, "0")}`, "1", 100_000n),
  );
  const many = readPdf(renderInvoicePdf(invoicePdfDocumentOf(pdfSourceOf({ lines: manyLines }))));

  expect(many.pageCount > 1, "sixty lines do not fit one page");
  expectEqual(many.objectCount, 5 + many.pageCount * 2, "two objects per page, behind the five fixed ones");

  for (const page of many.pages) {
    expect(
      page.text.includes(formatMessage("invoices.pdfPageOf", { page: page.number, pages: many.pageCount })),
      `page ${String(page.number)} says which page it is of how many`,
    );
    expect(page.text.includes(labels.columnDescription), "and repeats the table head, so a page read alone is a table");
    expect(
      page.text.includes(formatMessage("invoices.pdfGeneratedAt", { instant: "2026-11-04 09:00" })),
      "with the same generation instant on every page",
    );
  }

  for (const line of [manyLines[0], manyLines[29], manyLines[59]]) {
    expect(line !== undefined && many.text.includes(line.description), "every line reached a page");
  }

  // A draft of many pages stamps every page, because a page printed on its own must still say draft.
  const manyDraft = readPdf(
    renderInvoicePdf(
      invoicePdfDocumentOf(pdfSourceOf({ lines: manyLines, number: null, status: "draft", issuedAt: null })),
    ),
  );

  expect(
    manyDraft.pages.every((page) => page.text.includes(labels.draftStamp)),
    "a draft stamps every page it fills",
  );

  // ---- an invoice with no lines ----
  const empty = readPdf(renderInvoicePdf(invoicePdfDocumentOf(pdfSourceOf({ lines: [] }))));

  expect(empty.text.includes(labels.noLines), "an invoice with no lines says so rather than printing an empty table");
  expect(empty.pageCount === 1, "and still fits one page");

  // ---- the encoding ----
  expectEqual(invoicePdfEncodedText("Caf\u00e9").charCodeAt(3), 0xe9, "a Latin-1 letter keeps its WinAnsi byte");
  expectEqual(invoicePdfEncodedText("\u65e5\u672c\u8a9e"), "???", "a code point WinAnsi lacks becomes a question mark");
  expectEqual(invoicePdfEncodedText("tab\there"), "tab?here", "and so does a control byte, rather than reaching the file as an escape");
  expectEqual(invoicePdfEncodedText("plain").length, 5, "so an encoded string is one byte per character");
  expectEqual(invoicePdfLiteral("a (b) \\ c"), "a \\(b\\) \\\\ c", "a literal escapes the three characters that would end it");

  const awkward = readPdf(
    renderInvoicePdf(
      invoicePdfDocumentOf(
        pdfSourceOf({
          clientName: 'Smith ("Bob") & Sons',
          lines: [pdfLineOf(1, "Repair \\ reseat (urgent)", "1", 500_000n)],
        }),
      ),
    ),
  ).text;

  expect(awkward.includes('Smith ("Bob") & Sons'), "a name with quotes, parentheses and an ampersand survives the escaping");
  expect(awkward.includes("Repair \\ reseat (urgent)"), "and so does a description with a backslash");

  const accented = readPdf(
    renderInvoicePdf(invoicePdfDocumentOf(pdfSourceOf({ clientName: "Caf\u00e9 de la Gare" }))),
  ).text;

  expect(accented.includes("Caf\u00e9 de la Gare"), "an accented name reads back as it was written");

  // ---- the metrics ----
  expectEqual(invoicePdfTextWidth("", "regular", 10), 0, "an empty string has no width");
  expect(
    invoicePdfTextWidth("iiii", "regular", 10) < invoicePdfTextWidth("WWWW", "regular", 10),
    "the width comes from the face's own metrics, not from a character count",
  );
  expect(
    invoicePdfTextWidth("bold", "bold", 10) !== invoicePdfTextWidth("bold", "regular", 10),
    "and the bold face is wider than the regular one",
  );

  const column = 120;
  const wrapped = invoicePdfWrap("Supercalifragilisticexpialidocious", "regular", 10, column);

  expect(
    wrapped.every((line) => invoicePdfTextWidth(line, "regular", 10) <= column),
    "no wrapped line is wider than its column",
  );
  expectEqual(wrapped.join(""), "Supercalifragilisticexpialidocious", "and wrapping drops no character");
  expectEqual(invoicePdfWrap("one\ntwo", "regular", 10, 500).join("|"), "one|two", "a line break in the text is honoured");
  expect(invoicePdfWrap("short", "regular", 10, 500).length === 1, "a word that fits is not broken");

  // ---- the money printers, against the gate's own ----
  for (const minor of [0n, 5n, 50n, 99n, 100n, 12_500n, 990_000n, 3_125_000n, 125_000_000n, 1_234_567_890n]) {
    expectEqual(invoicePdfUsd(minor), printedCents(minor), `${minor.toString()} minor units print as ${printedCents(minor)}`);
  }

  expectEqual(invoicePdfUsd(1_250_000n), "125.00", "a whole dollar amount prints two decimals");
  expectEqual(invoicePdfUsd(125_000_000n), "12,500.00", "with the thousands separated");
  expectEqual(invoicePdfUsd(-3_125_000n), "-312.50", "and a credit keeps its sign");
  expectEqual(invoicePdfUsd(1n), "0.00", "one ten-thousandth of a dollar rounds to nothing, half away from zero");
  expectEqual(invoicePdfUsd(50n), "0.01", "while half a cent rounds up");

  expectEqual(invoicePdfUnitPrice(12_345n), printedFourDecimals(12_345n), "a price with a fraction of a cent keeps its scale");
  expectEqual(invoicePdfUnitPrice(12_345n), "1.2345", "printed at four decimals");
  expectEqual(invoicePdfUnitPrice(1_250_000n), "125.00", "and a whole-cent price at two, like every other amount");
  expectEqual(invoicePdfQuantity("2.500"), "2.5", "a quantity prints as the merchant typed it");
  expectEqual(invoicePdfQuantity("1.000"), "1", "with no trailing zeros on a whole one");
  expectEqual(invoicePdfQuantity("0.125"), "0.125", "and all three decimals when it needs them");

  // ---- the page geometry ----
  expectEqual(INVOICE_PDF_MARGIN, 54, "the margin is three quarters of an inch");
  expectEqual(INVOICE_PDF_PAGE_WIDTH - INVOICE_PDF_MARGIN * 2, 504, "which leaves seven inches of text");
  expect(
    invoicePdfTextWidth("Website design, five pages", "regular", 10) < INVOICE_PDF_PAGE_WIDTH - INVOICE_PDF_MARGIN * 2,
    "and an ordinary description fits one line of it",
  );

  // ---- the ceilings ----
  expectEqual(INVOICE_PDF_CONTENT_TYPE, "application/pdf", "the document is a PDF");
  expectEqual(INVOICE_PDF_EXTENSION, ".pdf", "with the extension that goes with it");
  expectEqual(
    UPLOAD_POLICIES.invoice_pdf.allowedTypes.join(","),
    "application/pdf",
    "and the upload purpose accepts exactly that type",
  );
  expectEqual(
    INVOICE_PDF_MAXIMUM_BYTES,
    UPLOAD_POLICIES.invoice_pdf.maximumBytes,
    "the renderer's ceiling is the upload policy's, so it cannot render what the platform would refuse",
  );
  expect(bytes.length < INVOICE_PDF_MAXIMUM_BYTES, "a real invoice is far inside it");

  // A memo beyond the column the sanitizer keeps is cut, not wrapped into a second document: the
  // merchant's own 2 000 character limit of `0022` is the limit the paper respects.
  const longMemo = readPdf(
    renderInvoicePdf(
      invoicePdfDocumentOf(
        pdfSourceOf({ memo: `${"A".repeat(1_900)}KEPTMARK${"B".repeat(300)}CUTMARK` }),
      ),
    ),
  ).text;

  expect(longMemo.includes("KEPTMARK"), "a memo inside the limit is printed whole");
  expect(!longMemo.includes("CUTMARK"), "and the part beyond it is cut rather than smuggled onto the page");

  const migration = await readRepositoryFile("migrations/0115_invoice_documents.sql");

  expect(
    migration.includes("byte_size between 1 and 26214400"),
    "and 0115 bounds its row at the same ceiling",
  );
}

/* ---- STEP 117: the document row, the queue and the object store ---- */

/** An in-memory object store, so a render can be sealed, stored, replaced, archived and read back. */
class PdfGateAdapter implements StorageAdapter {
  readonly name: StorageAdapterName = "supabase";
  readonly objects = new Map<string, Uint8Array>();
  /** Set to make the provider fail, which is how the retry path is reached. */
  failWith: StorageError | null = null;
  uploads = 0;
  downloads = 0;

  async upload(input: StorageUploadInput): Promise<StoredObject> {
    this.uploads += 1;

    if (this.failWith !== null) {
      throw this.failWith;
    }

    this.objects.set(`${input.bucket}/${input.key}`, input.bytes);

    return { provider: this.name, bucket: input.bucket, key: input.key, byteSize: input.bytes.length };
  }

  async download(ref: StorageObjectRef): Promise<Uint8Array> {
    this.downloads += 1;

    if (this.failWith !== null) {
      throw this.failWith;
    }

    const bytes = this.objects.get(`${ref.bucket}/${ref.key}`);

    if (bytes === undefined) {
      throw new StorageError("not_found", "the object does not exist");
    }

    return bytes;
  }

  async remove(ref: StorageObjectRef): Promise<void> {
    this.objects.delete(`${ref.bucket}/${ref.key}`);
  }

  async createSignedUrl(input: SignedUrlInput): Promise<SignedUrl> {
    return {
      url: `https://storage.example/${input.bucket}/${input.key}?ttl=${String(input.expiresInSeconds)}`,
      expiresAt: new Date(NOW + input.expiresInSeconds * 1_000).toISOString(),
    };
  }
}

interface PdfHarness {
  readonly db: InvoiceDb;
  readonly audit: ReturnType<typeof createInMemoryAuditTrail>;
  readonly adapter: PdfGateAdapter;
  readonly queue: ReturnType<typeof createInMemoryJobQueue>;
  readonly registry: JobRegistry;
  readonly worker: JobWorker;
  readonly dependencies: InvoicePdfStorageDependencies;
  readonly invoiceId: string;
  readonly now: () => number;
  /** Every line the worker logged, so the gate can read what a render says about itself. */
  readonly logged: string[];
  /** Move the clock, which is how a scheduled retry becomes due. */
  advance(milliseconds: number): void;
}

/**
 * A draft invoice, a queue, a worker and an object store, wired to one another.
 *
 * The gate registers its own handler under the job's own name before anything is enqueued, so the
 * registration inside the enqueue path is the no-op it is written to be and the worker runs against this
 * fixture instead of against the process environment - which is also the proof that a second
 * registration does not throw.
 */
async function pdfHarness(lines: number = 2): Promise<PdfHarness> {
  const db = createDb();
  const invoice = await createInvoice(
    {
      actor: owner,
      body: bodyOf({
        lines: Array.from({ length: lines }, (_, index) => ({
          description: `Row ${String(index + 1).padStart(2, "0")}`,
          unit: "item",
          quantity: "1",
          unit_price: "10",
        })),
      }),
    },
    depsOf(db),
  );

  let clock = NOW;
  const now = (): number => clock;
  const audit = createInMemoryAuditTrail();
  const adapter = new PdfGateAdapter();
  const queue = createInMemoryJobQueue();
  const registry = new JobRegistry();
  const dependencies: InvoicePdfStorageDependencies = {
    rest: createInvoiceRest(db),
    audit,
    adapter,
    encryption: createFileEncryption({ ENCRYPTION_MASTER_KEY: PDF_GATE_KEY }),
    now,
  };

  registry.register(createInvoicePdfJobHandler(() => dependencies));

  // The worker logs, and a gate that let it write to the process's own stdout would drown the summary
  // it prints. The lines are captured instead, which turns the silencing into something to assert on.
  const logged: string[] = [];
  const sink = {
    write(line: string): void {
      logged.push(line);
    },
  };

  return {
    db,
    audit,
    adapter,
    queue,
    registry,
    worker: new JobWorker({ queue, registry, now, logger: createLogger({ stdout: sink, stderr: sink }) }),
    dependencies,
    invoiceId: invoice.id,
    now,
    logged,
    advance(milliseconds) {
      clock += milliseconds;
    },
  };
}

function pdfStoreDeps(harness: PdfHarness): InvoicePdfStoreDependencies {
  return { rest: harness.dependencies.rest, audit: harness.audit, now: harness.now };
}

function pdfRequestDeps(harness: PdfHarness): InvoicePdfRequestDependencies {
  return { ...pdfStoreDeps(harness), registry: harness.registry, queue: harness.queue };
}

/** The document row of one harness, or the fact that it has none. */
function documentRowOf(harness: PdfHarness): Record<string, unknown> | null {
  return harness.db.documents.find((row) => row["invoice_id"] === harness.invoiceId) ?? null;
}

/** What a direct write to the document row answers with, which is what `0115` would have answered. */
async function documentWriteOf(
  harness: PdfHarness,
  values: Readonly<Record<string, unknown>>,
): Promise<{ readonly code: string | null; readonly reason: string | null }> {
  const row = documentRowOf(harness);

  if (row === null) {
    return { code: "no row", reason: null };
  }

  try {
    await createInvoiceRest(harness.db).update(
      INVOICE_DOCUMENTS_TABLE,
      `id=eq.${String(row["id"])}&company_id=eq.${COMPANY_A}`,
      values,
    );

    return { code: null, reason: null };
  } catch (error) {
    if (!isAppError(error)) {
      return { code: "uncaught", reason: null };
    }

    const cause = error.cause;
    const reason =
      typeof cause === "object" && cause !== null && "reason" in cause
        ? String((cause as { readonly reason: unknown }).reason)
        : null;

    return { code: error.code, reason };
  }
}

/** The audit entries of one action, which is how the trail is read everywhere else in this gate. */
function auditEntriesOf(harness: PdfHarness, action: string): ReturnType<typeof createInMemoryAuditTrail>["entries"] {
  return harness.audit.entries.filter((entry) => entry.action === action);
}

async function checkPdfDocument(): Promise<void> {
  const harness = await pdfHarness();

  // ---- nothing rendered yet ----
  const none = await readInvoicePdfState({ actor: owner, invoiceId: harness.invoiceId }, pdfStoreDeps(harness));

  expectEqual(none.status, INVOICE_PDF_NO_DOCUMENT, "an invoice nobody asked about has no document");
  expectEqual(none.ready, false, "so there is nothing to download");
  expectEqual(none.documentId, null, "and no row behind it");
  expectEqual(harness.db.documents.length, 0, "reading a state writes nothing");

  // ---- who may ask ----
  expectEqual(
    await codeOf(() => readInvoicePdfState({ actor: otherOwner, invoiceId: harness.invoiceId }, pdfStoreDeps(harness))),
    "RESOURCE_NOT_FOUND",
    "another merchant's invoice is not found rather than refused, so the answer says nothing about it",
  );
  expectEqual(
    await codeOf(() => readInvoicePdfState({ actor: desk, invoiceId: harness.invoiceId }, pdfStoreDeps(harness))),
    "PERMISSION_DENIED",
    "and a role that cannot manage invoices is refused",
  );
  expectEqual(
    await codeOf(() => requestInvoicePdf({ actor: desk, invoiceId: harness.invoiceId }, pdfRequestDeps(harness))),
    "PERMISSION_DENIED",
    "which is also true of asking for a render",
  );
  expectEqual(
    await codeOf(() => readInvoicePdfState({ actor: owner, invoiceId: "not-a-uuid" }, pdfStoreDeps(harness))),
    "VALIDATION_FAILED",
    "and an id that is not an id is refused before anything is read",
  );

  // ---- the request ----
  const requested = await requestInvoicePdf({ actor: owner, invoiceId: harness.invoiceId }, pdfRequestDeps(harness));

  expectEqual(requested.state.status, "queued", "a request leaves the document queued");
  expectEqual(requested.deduplicated, false, "and it is the first one");
  expectEqual(harness.db.documents.length, 1, "one row, because one invoice has one document");
  expectEqual(documentRowOf(harness)?.["status"], "queued", "which is what the row says");
  expectEqual(documentRowOf(harness)?.["document_type"], INVOICE_DOCUMENT_TYPE, "of the only type 0115 allows");
  expectEqual(documentRowOf(harness)?.["generation"], 0, "no render has completed");
  expectEqual(documentRowOf(harness)?.["attempts"], 0, "and none has been tried");
  expectEqual(documentRowOf(harness)?.["requested_by"], OWNER_ID, "the row remembers who asked");
  expectEqual(documentRowOf(harness)?.["file_id"], null, "with no file behind it yet");
  expect(requested.jobId !== null && requested.jobId.length > 0, "and there is a job to do it");

  const requestedEntries = auditEntriesOf(harness, INVOICE_PDF_REQUESTED_AUDIT_ACTION);

  expectEqual(requestedEntries.length, 1, "the request is audited once");
  expectEqual(at(requestedEntries, 0, "the request entry").entityType, INVOICE_DOCUMENT_ENTITY, "against the document");
  expectEqual(at(requestedEntries, 0, "the request entry").companyId, COMPANY_A, "of the merchant who owns it");
  expectEqual(at(requestedEntries, 0, "the request entry").actorUserId, OWNER_ID, "by the actor who asked");

  // ---- a second click adds no work ----
  const second = await requestInvoicePdf({ actor: owner, invoiceId: harness.invoiceId }, pdfRequestDeps(harness));

  expectEqual(second.deduplicated, true, "a second request while one is queued adds no work");
  expectEqual(harness.db.documents.length, 1, "and writes no second row");
  expectEqual(second.state.status, "queued", "answering with the state that already stands");

  // ---- the render, through the worker ----
  const ran = await harness.worker.runOnce();

  expectEqual(ran.ran, true, "the worker claims the job");
  expectEqual(ran.status, "completed", "and the render completes on the first attempt");
  expectEqual(ran.jobId, requested.jobId, "which is the job the request enqueued");

  const ready = await readInvoicePdfState({ actor: owner, invoiceId: harness.invoiceId }, pdfStoreDeps(harness));
  const row = documentRowOf(harness);

  expectEqual(ready.status, "ready", "the document is ready");
  expect(ready.ready, "so the screen offers the download");
  expectEqual(ready.generation, 1, "one render has completed");
  expectEqual(ready.attempts, 1, "in one attempt");
  expectEqual(row?.["status"], "ready", "as the row says");
  expectEqual(row?.["job_id"], ran.jobId, "and the row names the job that produced it");
  expectEqual(ready.renderedAt, new Date(NOW).toISOString(), "dated with the instant the render ran at");
  expect(typeof row?.["byte_size"] === "number" && Number(row?.["byte_size"]) > 0, "with the size of the document");
  expect(/^[0-9a-f]{64}$/u.test(String(row?.["content_sha256"])), "and the hash of its bytes");
  expectEqual(row?.["last_error_code"], null, "with no failure to report");

  // ---- the file record and the object ----
  expectEqual(harness.db.files.length, 1, "the render wrote one file record");
  const file = at(harness.db.files, 0, "the file record");

  expectEqual(file["purpose"], INVOICE_PDF_PURPOSE, "of the invoice_pdf purpose");
  expectEqual(file["content_type"], INVOICE_PDF_CONTENT_TYPE, "and the type the magic bytes agreed with");
  expectEqual(file["status"], "ready", "verified, as 0057 walks a file to ready");
  expectEqual(file["magic_byte_verified"], true, "on a verdict the platform's own sniffer gave");
  expectEqual(file["company_id"], COMPANY_A, "inside the merchant's own tenant");
  expectEqual(file["uploaded_by"], OWNER_ID, "credited to whoever asked for the render");
  expectEqual(row?.["file_id"], file["id"], "and the document row points at that record");

  const key = String(file["storage_key"]);
  const parsedKey = parseInvoicePdfStorageKey(key);

  expect(key.startsWith(`${COMPANY_A}/${INVOICE_PDF_KEY_SEGMENT}/${harness.invoiceId}/`), "the key sits under the tenant, the purpose and the invoice");
  expect(parsedKey !== null && parsedKey.companyId === COMPANY_A && parsedKey.invoiceId === harness.invoiceId, "which is what the key says when it is read back");

  const storedObject = harness.adapter.objects.get(`${DEFAULT_STORAGE_BUCKET}/${key}`);

  expect(storedObject !== undefined, "the object is in the store");
  expect(isFileEnvelope(storedObject ?? new Uint8Array()), "and it is an encrypted envelope");
  expect(
    !pdfRaw(storedObject ?? new Uint8Array()).includes("%PDF-"),
    "so no plaintext document is sitting in a provider's bucket",
  );

  // ---- the download ----
  const download = await readInvoicePdfBytes({ actor: owner, invoiceId: harness.invoiceId }, harness.dependencies);
  const downloadRead = readPdf(download.bytes);

  expectEqual(download.contentType, INVOICE_PDF_CONTENT_TYPE, "the download is served as a PDF");
  expectEqual(download.fileName, "invoice-draft.pdf", "named for a draft, because this invoice has no number yet");
  expectEqual(download.byteSize, download.bytes.length, "with the size the record describes");
  expectEqual(
    createHash("sha256").update(download.bytes).digest("hex"),
    download.contentSha256,
    "and the bytes are the ones the record's hash describes",
  );
  expectEqual(download.contentSha256, String(row?.["content_sha256"]), "which is the hash the document row carries");
  expectEqual(download.generation, 1, "of the first render");
  expect(downloadRead.offsetsValid && downloadRead.eof, "what came back out of storage is a readable PDF");
  expect(downloadRead.text.includes("Acme Ltd"), "printing the merchant's own client");
  expect(downloadRead.text.includes("Row 01"), "and the lines the invoice holds");
  expect(downloadRead.text.includes(printedCents(200_000n)), "with the total they add up to");
  expectEqual(
    at(auditEntriesOf(harness, "file.accessed"), 0, "the access entry").companyId,
    COMPANY_A,
    "and every access is audited, as section 21 requires",
  );

  expectEqual(
    await codeOf(() => readInvoicePdfBytes({ actor: otherOwner, invoiceId: harness.invoiceId }, harness.dependencies)),
    "RESOURCE_NOT_FOUND",
    "another merchant cannot download this document",
  );

  // ---- a document that is not ready has no bytes ----
  const pending = await pdfHarness(1);

  expectEqual(
    await codeOf(() => readInvoicePdfBytes({ actor: owner, invoiceId: pending.invoiceId }, pending.dependencies)),
    "RESOURCE_NOT_FOUND",
    "an invoice nobody rendered has nothing to download",
  );

  await requestInvoicePdf({ actor: owner, invoiceId: pending.invoiceId }, pdfRequestDeps(pending));

  expectEqual(
    await codeOf(() => readInvoicePdfBytes({ actor: owner, invoiceId: pending.invoiceId }, pending.dependencies)),
    "RESOURCE_NOT_FOUND",
    "and a document still in the queue has nothing to download either",
  );

  // ---- a re-render ----
  issuedRow(harness.db, harness.invoiceId, "INV-00042");
  harness.advance(60_000);

  const again = await requestInvoicePdf({ actor: owner, invoiceId: harness.invoiceId }, pdfRequestDeps(harness));

  expectEqual(again.state.status, "queued", "an issued invoice can be rendered again");
  expectEqual(again.deduplicated, false, "which is new work, not a duplicate");
  expectEqual(documentRowOf(harness)?.["attempts"], 0, "starting at zero attempts");

  const reran = await harness.worker.runOnce();
  const regenerated = await readInvoicePdfState({ actor: owner, invoiceId: harness.invoiceId }, pdfStoreDeps(harness));

  expectEqual(reran.status, "completed", "and the second render completes");
  expectEqual(regenerated.generation, 2, "counting the completed renders");
  expectEqual(regenerated.documentId, ready.documentId, "in the same row, because one invoice has one document");
  expectEqual(harness.db.files.length, 2, "writing a new object rather than overwriting one a client may hold");
  expectEqual(at(harness.db.files, 0, "the first record")["status"], "archived", "and archiving the render it replaces");
  expectEqual(at(harness.db.files, 1, "the second record")["status"], "ready", "so the new one is the live one");
  expect(
    String(at(harness.db.files, 0, "the first record")["storage_key"]) !==
      String(at(harness.db.files, 1, "the second record")["storage_key"]),
    "at a key of its own",
  );
  expectEqual(
    auditEntriesOf(harness, INVOICE_PDF_RENDERED_AUDIT_ACTION).length,
    2,
    "with an audit entry for each render",
  );

  const namedAgain = await readInvoicePdfBytes({ actor: owner, invoiceId: harness.invoiceId }, harness.dependencies);

  expectEqual(namedAgain.fileName, "invoice-INV-00042.pdf", "named for the number once the invoice has one");
  expect(readPdf(namedAgain.bytes).text.includes("INV-00042"), "and printing it");
  expect(!readPdf(namedAgain.bytes).text.includes("DRAFT"), "with no draft stamp on an issued invoice");

  // ---- an attempt that finds the work done ----
  const payload = invoicePdfJobPayloadSchema.parse({
    invoice_id: harness.invoiceId,
    company_id: COMPANY_A,
    document_id: regenerated.documentId,
    requested_by: OWNER_ID,
  });
  const shortCircuit = await renderInvoicePdfDocument(payload, harness.dependencies);

  expect(shortCircuit.alreadyRendered, "an attempt whose lease expired after the render landed is finished, not repeated");
  expectEqual(shortCircuit.generation, 2, "and it reports the render that exists");
  expectEqual(harness.db.files.length, 2, "writing no third object");

  // ---- a payload of another merchant ----
  const foreign = await codeOf(() =>
    renderInvoicePdfDocument(
      { ...payload, company_id: COMPANY_B },
      { ...harness.dependencies, rest: createInvoiceRest(harness.db) },
    ),
  );

  expectEqual(foreign, "RESOURCE_NOT_FOUND", "a payload naming another merchant reads nothing");
  expectEqual(harness.db.documents.length, 1, "and writes nothing");

  // ---- the failure path ----
  const failing = await pdfHarness(1);

  await requestInvoicePdf({ actor: owner, invoiceId: failing.invoiceId }, pdfRequestDeps(failing));
  failing.adapter.failWith = new StorageError("unavailable", "the provider is not answering");

  const failedRun = await failing.worker.runOnce();

  expectEqual(failedRun.status, "retrying", "a provider outage is worth another attempt");

  const failed = await readInvoicePdfState({ actor: owner, invoiceId: failing.invoiceId }, pdfStoreDeps(failing));

  expectEqual(failed.status, "failed", "and the document says so");
  expectEqual(failed.lastErrorCode, "DEPENDENCY_FAILED", "with the catalog's retryable code, not the provider's words");
  expectEqual(failed.attempts, 1, "having counted the attempt");
  expectEqual(failed.generation, 0, "and no render behind it");
  expectEqual(failing.db.files.length, 0, "so a failed render leaves no file record");
  expectEqual(failing.adapter.objects.size, 0, "and no object in the store");

  const failedEntries = auditEntriesOf(failing, INVOICE_PDF_FAILED_AUDIT_ACTION);

  expectEqual(failedEntries.length, 1, "the failure is audited");
  expectEqual(at(failedEntries, 0, "the failure entry").payload["code"], "DEPENDENCY_FAILED", "with the code");
  expectEqual(at(failedEntries, 0, "the failure entry").payload["invoice_id"], failing.invoiceId, "and the invoice");
  expect(
    !JSON.stringify(failing.audit.entries).includes("the provider is not answering"),
    "but never the provider's own message, which is not the trail's to keep",
  );

  // ---- the recovery ----
  failing.adapter.failWith = null;
  await requestInvoicePdf({ actor: owner, invoiceId: failing.invoiceId }, pdfRequestDeps(failing));

  const requeued = await readInvoicePdfState({ actor: owner, invoiceId: failing.invoiceId }, pdfStoreDeps(failing));

  expectEqual(requeued.status, "queued", "a merchant can ask again after a failure");
  expectEqual(requeued.lastErrorCode, null, "and the fresh request clears the reason");
  expectEqual(requeued.attempts, 0, "with the attempt count starting over");

  failing.advance(15 * 60_000);

  const drained = await failing.worker.drain(5);

  expectEqual(drained.failed, 0, "no attempt fails once the provider answers");

  const recovered = await readInvoicePdfState({ actor: owner, invoiceId: failing.invoiceId }, pdfStoreDeps(failing));

  expectEqual(recovered.status, "ready", "and the document arrives");
  expectEqual(recovered.generation, 1, "as the first render to complete");
  expect(recovered.attempts >= 1, "with the attempts it took still visible on the row");

  // ---- a request that loses a race ----
  const racing = await pdfHarness(1);

  await requestInvoicePdf({ actor: owner, invoiceId: racing.invoiceId }, pdfRequestDeps(racing));
  await racing.worker.runOnce();
  racing.db.raceDocumentVersion = true;

  const raced = await requestInvoicePdf({ actor: owner, invoiceId: racing.invoiceId }, pdfRequestDeps(racing));

  expectEqual(raced.deduplicated, true, "a request whose row moved under it adopts the winner's state");
  expectEqual(racing.db.documents.length, 1, "and still writes no second row");

  // ---- 0115's own guard, as the fixture models it ----
  const guarded = await pdfHarness(1);

  await requestInvoicePdf({ actor: owner, invoiceId: guarded.invoiceId }, pdfRequestDeps(guarded));
  await guarded.worker.runOnce();

  expectEqual(documentRowOf(guarded)?.["status"], "ready", "the harness is in the state the refusals below start from");
  expectEqual((await documentWriteOf(guarded, { status: "rendering" })).code, "VALIDATION_FAILED", "a ready document does not walk back to rendering");
  expectEqual(
    (await documentWriteOf(guarded, { status: "rendering" })).reason,
    "an invoice document status walks queued, rendering, ready or failed",
    "which is the trigger's own refusal",
  );
  expectEqual((await documentWriteOf(guarded, { generation: 0 })).code, "VALIDATION_FAILED", "and a generation never falls");
  expectEqual(
    (await documentWriteOf(guarded, { rendered_at: null })).reason,
    "the file facts of an invoice document change only when a render completes",
    "nor do the facts of a render move except at the instant one completes",
  );
  expectEqual((await documentWriteOf(guarded, { company_id: COMPANY_B })).code, "VALIDATION_FAILED", "and the identity is frozen");

  const queuedGuard = await pdfHarness(1);

  await requestInvoicePdf({ actor: owner, invoiceId: queuedGuard.invoiceId }, pdfRequestDeps(queuedGuard));

  expectEqual(
    (await documentWriteOf(queuedGuard, { generation: 1 })).reason,
    "a render generation counts completed renders only",
    "a queued document cannot claim a render it has not finished",
  );
  expectEqual(
    (await documentWriteOf(queuedGuard, { status: "failed" })).reason,
    "invoice_documents_failed_check",
    "and a failure without a code is not a row 0115 accepts",
  );
  expectEqual(
    (await documentWriteOf(queuedGuard, { status: "ready" })).reason,
    "an invoice document status walks queued, rendering, ready or failed",
    "nor does a document reach ready without being claimed first",
  );
  expectEqual(
    (await documentWriteOf(queuedGuard, { status: "rendering", attempts: 1 })).code,
    null,
    "a worker claims the queued document",
  );
  expectEqual(
    (await documentWriteOf(queuedGuard, { status: "ready" })).reason,
    "invoice_documents_ready_check",
    "and cannot complete it without the four facts of the render",
  );
  expectEqual(
    (
      await documentWriteOf(queuedGuard, {
        status: "ready",
        generation: 1,
        file_id: randomUUID(),
        byte_size: 4_096,
        content_sha256: "a".repeat(64),
        rendered_at: new Date(NOW).toISOString(),
      })
    ).code,
    null,
    "while a completed render carrying all four is accepted",
  );
  expectEqual(
    (await documentWriteOf(queuedGuard, { rendered_at: new Date(NOW - 86_400_000).toISOString() })).reason,
    "the file facts of an invoice document change only when a render completes",
    "and the facts it wrote are then frozen",
  );

  // ---- the key and name helpers ----
  const keyOf = invoicePdfStorageKey(COMPANY_A, harness.invoiceId);

  expect(keyOf.startsWith(`${COMPANY_A}/${INVOICE_PDF_KEY_SEGMENT}/${harness.invoiceId}/`), "a generated key is scoped to the tenant and the invoice");
  expect(keyOf.endsWith(INVOICE_PDF_EXTENSION), "and names a PDF");
  expectEqual(parseInvoicePdfStorageKey(`${COMPANY_B}/${INVOICE_PDF_KEY_SEGMENT}/${harness.invoiceId}/x.pdf`), null, "a key whose file is not a generated name is not one of ours");
  expectEqual(parseInvoicePdfStorageKey(`${COMPANY_A}/kyc_document/${harness.invoiceId}/x.pdf`), null, "and neither is a key of another purpose");
  expectEqual(parseInvoicePdfStorageKey("nope"), null, "nor a string that is not a key at all");
  expectEqual(
    await codeOf(async () => assertInvoicePdfKeyForInvoice(keyOf, COMPANY_B, harness.invoiceId)),
    "PERMISSION_DENIED",
    "so a record pointing at another merchant's key is refused",
  );

  expectEqual(invoicePdfFileName(null), "invoice-draft.pdf", "a draft is named as a draft");
  expectEqual(invoicePdfFileName("INV-00042"), "invoice-INV-00042.pdf", "and a numbered invoice as its number");

  const injected = invoicePdfFileName('INV"; DROP TABLE invoices; --');

  expect(!/[",;\r\n ]/u.test(injected), "a number cannot inject a Content-Disposition header");
  expect(injected.endsWith(".pdf"), "and still names a PDF");
  expect(injected.length <= 80, "inside the length a header can carry");

  // ---- the job itself ----
  expectEqual(INVOICE_PDF_JOB, "invoice.pdf.render", "the job is named for what it does");
  expect(harness.registry.has(INVOICE_PDF_JOB), "and it is registered under that name");

  // Registration is idempotent, so any entry point can ask for it and a second ask is not a crash.
  const fresh = new JobRegistry();

  registerInvoicePdfJob(fresh);
  registerInvoicePdfJob(fresh);
  registerInvoicePdfJob(harness.registry);

  expect(fresh.has(INVOICE_PDF_JOB), "a fresh registry ends up holding the job");
  expectEqual(
    invoicePdfJobIdempotencyKey(PDF_INVOICE_ID, 3),
    `invoice.pdf.render:${PDF_INVOICE_ID}:3`,
    "with an idempotency key of the document and the version that asked",
  );
  expect(
    !invoicePdfJobPayloadSchema.safeParse({
      invoice_id: harness.invoiceId,
      company_id: COMPANY_A,
      document_id: PDF_INVOICE_ID,
      requested_by: null,
      extra: "no",
    }).success,
    "and a payload that carries anything else is refused",
  );
  expect(
    !invoicePdfJobPayloadSchema.safeParse({ invoice_id: "nope", company_id: COMPANY_A, document_id: PDF_INVOICE_ID, requested_by: null }).success,
    "as is one whose ids are not ids",
  );
  expectEqual(INVOICE_DOCUMENT_STATUSES.join(","), "queued,rendering,ready,failed", "the four states a document can be in");
}

/* ---- STEP 117: the sources ---- */

async function checkPdfSources(): Promise<void> {
  /** The source with its comment lines removed, so a comment naming a symbol cannot satisfy a check. */
  const codeOf = (source: string): string =>
    source
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();

        return !trimmed.startsWith("*") && !trimmed.startsWith("//") && !trimmed.startsWith("/*") && !trimmed.startsWith("--");
      })
      .join("\n");

  const owned: readonly string[] = [
    "services/invoices/invoice-pdf.ts",
    "services/invoices/invoice-pdf-document.ts",
    "services/invoices/invoice-pdf-state.ts",
    "app/api/invoices/[id]/pdf/route.ts",
    "app/api/invoices/[id]/pdf/download/route.ts",
    "app/(dashboard)/invoices/invoice-pdf-panel.tsx",
    "migrations/0115_invoice_documents.sql",
    "migrations/0115_invoice_documents.down.sql",
  ];

  for (const path of owned) {
    const source = await readRepositoryFile(path);
    const comment = path.endsWith(".sql") ? `-- path: ${path}` : `// path: ${path}`;

    expect(source.length > 0, `${path} exists`);
    expect(source.split("\n", 1)[0]?.trim() === comment, `${path} starts with its path comment`);
    expect(
      !/[^\u0009\u000a\u000d\u0020-\u007e]/u.test(source.replaceAll("\ufeff", "")),
      `${path} is ASCII only`,
    );
  }

  // ---- no new dependency: the document is written here ----
  const renderer = await readRepositoryFile("services/invoices/invoice-pdf.ts");
  const declared = JSON.parse(await readRepositoryFile("package.json")) as {
    readonly dependencies?: Readonly<Record<string, string>>;
    readonly devDependencies?: Readonly<Record<string, string>>;
  };
  const installed = new Set([
    ...Object.keys(declared.dependencies ?? {}),
    ...Object.keys(declared.devDependencies ?? {}),
  ]);
  const specifiers = [...renderer.matchAll(/from "([^"]+)"/gu)].map((match) => match[1] ?? "");

  expect(specifiers.length > 0, "the renderer imports what it needs");

  for (const specifier of specifiers) {
    const isOwn = specifier.startsWith("node:") || specifier.startsWith(".");
    const pkg = specifier.split("/")[0] ?? "";

    expect(isOwn || installed.has(pkg), `the renderer adds no package of its own: ${specifier}`);
  }

  const documentService = codeOf(await readRepositoryFile("services/invoices/invoice-pdf-document.ts"));

  for (const [name, code] of [
    ["services/invoices/invoice-pdf.ts", codeOf(renderer)],
    ["services/invoices/invoice-pdf-document.ts", documentService],
  ] as const) {
    expect(!/parseFloat/u.test(code), `${name} never parses a float`);
    expect(!/process\.env/u.test(code), `${name} reads no environment of its own`);
    // The markers the structure gate forbids, spelled with a class between their letters so that this
    // file does not itself contain the thing it is looking for.
    expect(
      !/T[O]DO|F[I]XME|X[X]X|lorem[ ]ipsum|coming[ ]soon|console[.]log|placeholder/u.test(code),
      `${name} leaves nothing unfinished`,
    );
  }

  // The money is integers end to end. The one rounding in the renderer is of a PDF coordinate, which
  // the format itself defines as a real number, and it never sees an amount.
  const rendererCode = codeOf(renderer);
  const roundSites = rendererCode.split("Math.round").length - 1;
  const coordinateFormatter = /function points\(value: number\): string \{[^}]*\}/u.exec(rendererCode)?.[0] ?? "";

  expectEqual(roundSites, 1, "the renderer rounds exactly once");
  expect(coordinateFormatter.includes("Math.round"), "and it is the formatter of a page coordinate");
  expect(!/minor|cents|amount/u.test(coordinateFormatter), "on a line that never sees an amount");

  for (const money of [
    "function centsOf",
    "function printCents",
    "function groupDigits",
    "export function invoicePdfUsd",
    "export function invoicePdfUnitPrice",
  ]) {
    const start = rendererCode.indexOf(money);

    expect(start >= 0, `${money} is where the gate expects it`);

    const body = rendererCode.slice(start, rendererCode.indexOf("\n}", start));

    expect(!/Number\(|parseFloat|Math[.]round/u.test(body), `${money} computes an amount in integers only`);
  }

  // The money crosses the render boundary as text, because a PDF is a document and a bigint is not JSON.
  expect(documentService.includes("readPrintableInvoice"), "the render reads the invoice through one function");
  expect(
    !/rest\.select\(\s*"invoices"[\s\S]{0,400}for \(const/u.test(documentService),
    "and it reads the lines in one query, not one per line",
  );

  // ---- the routes ----
  const requestSource = codeOf(await readRepositoryFile("app/api/invoices/[id]/pdf/route.ts"));
  // The state read and the request share a path, so the token is judged inside the handler that needs
  // one: a GET of one's own document has nothing to defend and must not be made to carry a token.
  const request = requestSource.slice(requestSource.indexOf("export const POST"));

  expect(requestSource.includes("export const GET") && requestSource.includes("export const POST"), "the state and the request share a path");
  expect(request.includes("requireCsrfToken("), "the request checks the token");
  expect(request.indexOf("requireCsrfToken(") < request.indexOf("readRequestActor("), "before it looks the session up");
  expect(!request.includes("request.text()"), "and reads no body, because there is nothing to send");
  expect(request.includes("after("), "the render happens after the answer, not inside it");
  expect(request.includes("runOnce()"), "one claimed job, never a loop that would make a request into a worker");
  expect(request.includes("202"), "so a request answers accepted rather than done");
  expect(!requestSource.includes("renderInvoicePdf("), "and the handler draws no document itself");
  expect(requestSource.includes('dynamic = "force-dynamic"'), "with no prerendered state");
  expect(requestSource.includes('"cache-control": "no-store"'), "and nothing cached");
  expect(!requestSource.slice(0, requestSource.indexOf("export const POST")).includes("requireCsrfToken("), "while the state read needs no token");

  const download = codeOf(await readRepositoryFile("app/api/invoices/[id]/pdf/download/route.ts"));

  expect(download.includes("export const GET"), "the download is a read");
  expect(!download.includes("export const POST") && !download.includes("export const DELETE"), "that mutates nothing");
  expect(!download.includes("requireCsrfToken("), "so it needs no token");
  expect(download.includes("attachment; filename="), "it serves an attachment, never a document the browser will run");
  expect(download.includes('"x-content-type-options": "nosniff"'), "which is never sniffed");
  expect(download.includes('"cache-control": "no-store"'), "and never cached");
  expect(download.includes('dynamic = "force-dynamic"'), "with no prerendered bytes");

  const csrf = await readRepositoryFile("lib/security/csrf.ts");

  expect(csrf.includes('"/api/invoices/[id]/pdf"'), "the request route is on the protected list");
  expect(!csrf.includes('"/api/invoices/[id]/pdf/download"'), "and a read of one's own document is not");

  // ---- the panel ----
  const panel = await readRepositoryFile("app/(dashboard)/invoices/invoice-pdf-panel.tsx");

  expectEqual(panel.split('method: "POST"').length - 1, 1, "the panel sends one mutation");
  expectEqual(panel.split("csrfHeaders(").length - 1, 1, "carrying the token on it");
  expect(panel.includes("download"), "and it links the download rather than posting for it");
  expect(panel.includes("flex-col") && panel.includes("sm:flex-row"), "one column on a phone and two from sm up");
  expect(panel.includes("flex-wrap"), "with controls that wrap rather than shrink");
  expect(panel.includes("focus-visible:ring-2"), "every control reachable by keyboard");
  expect(panel.includes('role="status"') && panel.includes('role="alert"'), "and announced to a screen reader");
  expect(!/#[0-9a-fA-F]{3,8}\b/u.test(panel), "no colour literal, so the theme decides light and dark");
  expect(panel.includes("text-muted-foreground") && panel.includes("border-border"), "in the theme's own tokens");

  const screens = await readRepositoryFile("app/(dashboard)/invoices/invoice-screens.tsx");

  expect(screens.includes("<InvoicePdfPanel"), "the editor screen carries the panel");
  expect(screens.includes("readInvoicePdfState("), "and reads its state on the server");

  // ---- the browser bundle ----
  //
  // The panel is a client component and the document service is server only: it renders through
  // node:zlib, seals through the file encryption and stores through the adapter registry. A browser file
  // that imported so much as one constant from it would ship all of that, so the state's words live in a
  // module of their own and the panel reaches nothing else.
  const stateModule = await readRepositoryFile("services/invoices/invoice-pdf-state.ts");

  expect(!stateModule.includes("import "), "the state vocabulary imports nothing, so a browser can carry it");
  expect(panel.includes('from "@/services/invoices/invoice-pdf-state"'), "and the panel imports it from there");
  expect(!panel.includes("invoice-pdf-document"), "never from the server module that produces it");
  expect(!panel.includes("invoice-pdf\""), "and never from the renderer");

  for (const specifier of [...panel.matchAll(/from "([^"]+)"/gu)].map((match) => match[1] ?? "")) {
    expect(
      specifier === "react" ||
        specifier === "@/lib/i18n/messages" ||
        specifier === "@/lib/security/csrf-client" ||
        specifier === "@/services/invoices/invoice-pdf-state",
      `the panel imports nothing a browser cannot carry: ${specifier}`,
    );
  }

  // ---- the migration, and the columns the code names ----
  const migration = await readRepositoryFile("migrations/0115_invoice_documents.sql");

  expect(migration.includes("invoice_documents_default_deny"), "the table is default deny");
  expect(migration.includes("using (false)") && migration.includes("with check (false)"), "in both directions");
  expect(migration.includes("execute function public.invoice_documents_guard_state()"), "with its guard attached");
  expect(
    migration.includes("references public.invoices (id, company_id)"),
    "and a composite foreign key, so a document cannot name another merchant's invoice",
  );
  expect(migration.includes("where deleted_at is null"), "with one live row per invoice");

  for (const column of Object.keys(invoiceDocumentRowSchema.shape)) {
    expect(
      new RegExp(`^ {2}${column} `, "mu").test(migration),
      `0115 creates the column the document row reads: ${column}`,
    );
  }

  const down = await readRepositoryFile("migrations/0115_invoice_documents.down.sql");

  expect(down.includes("drop table if exists public.invoice_documents"), "the rollback drops the table");
  expect(down.includes("drop function if exists public.invoice_documents_guard_state()"), "and the function it created");

  // ---- the catalog ----
  const strings = await readRepositoryFile("lib/i18n/strings/en.ts");

  for (const key of ["pdfPageOf", "pdfGeneratedAt", "pdfDiscountPercent", "pdfPanelReady", "pdfPanelFailureReference"]) {
    expect(strings.includes(`${key}:`), `the catalog carries the parameterised string ${key}`);
  }

  expectEqual(
    formatMessage("invoices.pdfPageOf", { page: 2, pages: 5 }),
    "Page 2 of 5",
    "which reads as a page of its document",
  );
  expectEqual(
    formatMessage("invoices.pdfDiscountPercent", { percent: "12.5" }),
    "Discount (12.5%)",
    "and a percentage discount names its percentage",
  );
  expectEqual(getMessage("invoices.pdfFileStem"), "invoice", "the file name a merchant's download carries");
}

/* ---- STEP 118: image fixtures ----
 *
 * A PNG and a JPEG built here, byte by byte, because the reader this gate proves is the only thing between a
 * merchant's logo and a client's document, and there is no image library in this repository to borrow a
 * fixture from.
 *
 * The PNGs are real files: signature, chunk lengths, CRCs over type and payload, and deflated scanlines with
 * their filter bytes, so a browser would open them and the decoder's filters, palettes, bit depths and
 * transparency chunks are exercised by bytes that obey the specification rather than by bytes invented to
 * please it. The JPEGs are marker streams - SOI, APP0, SOF0, DHT, SOS, EOI - which is everything the reader
 * walks and nothing it decodes, because a baseline JPEG goes into the PDF as its own bytes under
 * `/DCTDecode`. They are not decodable photographs, and no assertion here pretends they are.
 */

function be16(value: number): readonly number[] {
  return [(value >>> 8) & 0xff, value & 0xff];
}

function be32(value: number): readonly number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let at = 0;

  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }

  return out;
}

/** One PNG chunk: its length, its four type bytes, its payload, and the CRC over the type and the payload. */
function pngChunk(type: string, payload: readonly number[]): Uint8Array {
  const typeBytes = [...type].map((character) => character.charCodeAt(0));
  const crcInput = new Uint8Array(typeBytes.length + payload.length);

  crcInput.set(typeBytes, 0);
  crcInput.set(payload, typeBytes.length);

  const out = new Uint8Array(12 + payload.length);

  out.set(be32(payload.length), 0);
  out.set(typeBytes, 4);
  out.set(payload, 8);
  out.set(be32(crc32(crcInput) >>> 0), 8 + payload.length);

  return out;
}

interface PngFixture {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  /** 0 grey, 2 truecolour, 3 indexed, 4 grey with alpha, 6 truecolour with alpha. */
  readonly colorType: number;
  readonly interlace?: number;
  readonly palette?: readonly number[];
  readonly transparency?: readonly number[];
  /** The scanlines without their filter bytes: one array per row, already packed to the bit depth. */
  readonly rows?: readonly (readonly number[])[];
  /** The filter byte written before every scanline. */
  readonly filter?: number;
  /** One filter byte per scanline, when the rows differ - which is how a real encoder writes them. */
  readonly filters?: readonly number[];
  /** Write the IDAT as two chunks, which a real encoder does whenever it streams. */
  readonly splitIdat?: boolean;
  /** An IHDR to write instead of the one these numbers describe: how a pixel bomb is built. */
  readonly declared?: readonly number[];
  readonly omitIdat?: boolean;
  readonly omitPalette?: boolean;
}

function pngOf(input: PngFixture): Uint8Array {
  const ihdr =
    input.declared ?? [
      ...be32(input.width),
      ...be32(input.height),
      input.bitDepth,
      input.colorType,
      0,
      0,
      input.interlace ?? 0,
    ];
  const raw: number[] = [];

  for (const [index, row] of (input.rows ?? []).entries()) {
    raw.push(input.filters?.[index] ?? input.filter ?? 0, ...row);
  }

  const compressed = deflateSync(Uint8Array.from(raw));
  const chunks: Uint8Array[] = [
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    pngChunk("IHDR", ihdr),
  ];

  if (input.palette !== undefined && input.omitPalette !== true) {
    chunks.push(pngChunk("PLTE", [...input.palette]));
  }

  if (input.transparency !== undefined) {
    chunks.push(pngChunk("tRNS", [...input.transparency]));
  }

  if (input.omitIdat !== true) {
    if (input.splitIdat === true) {
      const half = Math.floor(compressed.length / 2);

      chunks.push(
        pngChunk("IDAT", [...compressed.subarray(0, half)]),
        pngChunk("IDAT", [...compressed.subarray(half)]),
      );
    } else {
      chunks.push(pngChunk("IDAT", [...compressed]));
    }
  }

  chunks.push(pngChunk("IEND", []));

  return concatBytes(chunks);
}

interface JpegFixture {
  readonly width: number;
  readonly height: number;
  /** 8 is baseline; 12 is one of the precisions a PDF image XObject cannot take. */
  readonly precision?: number;
  readonly components?: number;
  /** 0xc0 baseline, 0xc2 progressive: the marker the reader refuses or accepts. */
  readonly startOfFrame?: number;
  /** Fill bytes before the frame marker, which a real encoder emits and a naive walker trips on. */
  readonly fill?: boolean;
  readonly trailing?: readonly number[];
}

function jpegOf(input: JpegFixture): Uint8Array {
  const components = input.components ?? 3;
  const precision = input.precision ?? 8;
  const marker = (type: number, payload: readonly number[]): Uint8Array =>
    concatBytes([Uint8Array.of(0xff, type, ...be16(payload.length + 2)), Uint8Array.from(payload)]);
  const sampling = components === 1 ? [1, 0x11, 0] : [1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1];
  const frame = marker(input.startOfFrame ?? 0xc0, [
    precision,
    ...be16(input.height),
    ...be16(input.width),
    components,
    ...sampling.slice(0, components * 3),
  ]);

  return concatBytes([
    Uint8Array.of(0xff, 0xd8),
    marker(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    input.fill === true ? Uint8Array.of(0xff) : new Uint8Array(0),
    frame,
    // A Huffman table and a start of scan, so the walk has something to step over and something to stop at.
    marker(0xc4, [0x00, 0x1f, 0x00, 0x00, 0x01, 0x05, 0x01, 0x01, 0x01]),
    marker(0xda, [components, ...Array.from({ length: components * 2 }, (_, index) => index + 1), 0, 63, 0]),
    Uint8Array.of(0xff, 0xd9),
    Uint8Array.from(input.trailing ?? []),
  ]);
}

/** A 2x2 truecolour image with an alpha channel, from four RGBA pixels. */
function rgbaPng(pixels: readonly (readonly [number, number, number, number])[]): Uint8Array {
  const at = (index: number): readonly number[] => pixels[index] ?? [0, 0, 0, 255];

  return pngOf({
    width: 2,
    height: 2,
    bitDepth: 8,
    colorType: 6,
    rows: [
      [...at(0), ...at(1)],
      [...at(2), ...at(3)],
    ],
  });
}

/** The reason an inspection gave, or null when it accepted the bytes. */
function inspectReason(bytes: Uint8Array, contentType: string): string | null {
  const verdict = inspectInvoicePdfImage(bytes, contentType);

  return verdict.ok ? null : verdict.reason;
}

async function checkPdfImageDecoder(): Promise<void> {
  // ---- the vocabulary the module publishes ----
  expectEqual(INVOICE_PDF_IMAGE_FORMATS.join(","), "png,jpeg", "two formats: the ones a PDF can draw");
  expectEqual(
    INVOICE_PDF_IMAGE_REFUSALS.join(","),
    "not_an_image,unsupported_bit_depth,interlaced,unsupported_jpeg,too_many_pixels,malformed",
    "and six reasons it says no, each of which a merchant can be told in one sentence",
  );
  expectEqual(INVOICE_PDF_IMAGE_COLOR_SPACES.join(","), "rgb,gray", "the two colour spaces an XObject is given");
  expectEqual(
    INVOICE_PDF_IMAGE_MAXIMUM_PIXELS,
    2_048 * 2_048,
    "the ceiling is four million pixels, which is checked before anything is inflated",
  );

  // ---- sniffing ----
  const png = rgbaPng([
    [255, 0, 0, 255],
    [0, 255, 0, 255],
    [0, 0, 255, 255],
    [255, 255, 255, 0],
  ]);
  const jpeg = jpegOf({ width: 12, height: 9 });
  const webp = concatBytes([
    Uint8Array.from([..."RIFF"], (character) => character.charCodeAt(0)),
    Uint8Array.of(0x1a, 0x00, 0x00, 0x00),
    Uint8Array.from([..."WEBPVP8 "], (character) => character.charCodeAt(0)),
  ]);

  expectEqual(sniffInvoicePdfImageFormat(png), "png", "the signature says PNG");
  expectEqual(sniffInvoicePdfImageFormat(jpeg), "jpeg", "and SOI says JPEG");
  expectEqual(sniffInvoicePdfImageFormat(webp), null, "a WebP is not one of the two a PDF can draw");
  expectEqual(sniffInvoicePdfImageFormat(new Uint8Array(0)), null, "nor is nothing at all");
  expectEqual(sniffInvoicePdfImageFormat(Uint8Array.from([0x89, 0x50])), null, "nor a signature cut short");

  // ---- inspecting, which is the cheap question ----
  expect(inspectInvoicePdfImage(png, "image/png").ok, "a real PNG passes inspection");
  expect(!inspectInvoicePdfImage(webp, "image/webp").ok, "and a WebP does not");
  expectEqual(
    inspectReason(webp, "image/webp"),
    "not_an_image",
    "because no PDF image XObject can hold one",
  );
  expectEqual(
    inspectReason(png, "image/jpeg"),
    "not_an_image",
    "a declared type that disagrees with the bytes is refused rather than trusted",
  );
  expectEqual(
    inspectReason(jpeg, "image/png"),
    "not_an_image",
    "in both directions",
  );

  // ---- decoding truecolour ----
  const decoded = decodeInvoicePdfImage(png, "image/png");

  expectEqual(decoded.format, "png", "the format is the one the signature declared");
  expectEqual(decoded.width, 2, "two pixels wide");
  expectEqual(decoded.height, 2, "and two high");
  expectEqual(decoded.colorSpace, "rgb", "truecolour with alpha becomes the three samples a PDF draws");
  expectEqual(decoded.bitsPerComponent, 8, "at eight bits a component");
  expectEqual(decoded.filter, "FlateDecode", "deflated, because the samples were produced here");
  expectEqual(decoded.samples.length, 12, "four pixels of three bytes, with the alpha lifted out");
  expectEqual(
    [...decoded.samples.subarray(0, 9)].map((byte) => byte.toString(16)).join(" "),
    "ff 0 0 0 ff 0 0 0 ff",
    "red, then green, then blue, in the order the scanlines hold them",
  );
  expect(decoded.alpha !== null, "and one clear pixel is enough to keep the mask");
  expectEqual([...(decoded.alpha ?? [])].join(","), "255,255,255,0", "which is the fourth pixel's alpha");

  const opaque = decodeInvoicePdfImage(
    rgbaPng([
      [1, 2, 3, 255],
      [4, 5, 6, 255],
      [7, 8, 9, 255],
      [10, 11, 12, 255],
    ]),
    "image/png",
  );

  expectEqual(opaque.alpha, null, "an image with nothing transparent carries no mask at all");
  expectEqual(opaque.samples.length, 12, "and still twelve samples");

  // ---- the other colour types ----
  const grey = decodeInvoicePdfImage(
    pngOf({ width: 2, height: 2, bitDepth: 8, colorType: 0, rows: [[10, 20], [30, 40]] }),
    "image/png",
  );

  expectEqual(grey.colorSpace, "gray", "a greyscale image stays greyscale rather than being tripled");
  expectEqual(grey.samples.length, 4, "so four pixels are four samples");
  expectEqual([...grey.samples].join(","), "10,20,30,40", "at the values stored");

  const greyAlpha = decodeInvoicePdfImage(
    pngOf({ width: 2, height: 1, bitDepth: 8, colorType: 4, rows: [[10, 255, 20, 0]] }),
    "image/png",
  );

  expectEqual(greyAlpha.colorSpace, "gray", "greyscale with alpha is still greyscale");
  expectEqual([...greyAlpha.samples].join(","), "10,20", "with the alpha lifted out of the scanline");
  expectEqual([...(greyAlpha.alpha ?? [])].join(","), "255,0", "into a mask of its own");

  // Sixteen bits become eight, taking the high byte: a PDF image XObject of sixteen bits a component is
  // legal but twice the bytes for a logo nobody will look at that closely, and the choice is documented.
  const sixteen = decodeInvoicePdfImage(
    pngOf({ width: 2, height: 1, bitDepth: 16, colorType: 2, rows: [[0x12, 0x56, 0x9a, 0xde, 0x11, 0x33, 0x55, 0x77, 0x99, 0xbb, 0xdd, 0xff]] }),
    "image/png",
  );

  expectEqual(sixteen.bitsPerComponent, 8, "a sixteen bit image is normalised to eight");
  expectEqual([...sixteen.samples].join(","), "18,154,17,85,153,221", "by keeping the high byte of each");

  // ---- sub-byte depths ----
  const oneBit = decodeInvoicePdfImage(
    pngOf({ width: 8, height: 1, bitDepth: 1, colorType: 0, rows: [[0b1010_1010]] }),
    "image/png",
  );

  expectEqual(oneBit.samples.length, 8, "eight one-bit pixels are eight samples");
  expectEqual([...oneBit.samples].join(","), "255,0,255,0,255,0,255,0", "scaled to the full range, not left as 1 and 0");

  const palette = [255, 255, 255, 0, 128, 0, 0, 0, 255, 64, 64, 64];
  const fourBit = decodeInvoicePdfImage(
    pngOf({ width: 4, height: 1, bitDepth: 4, colorType: 3, palette, rows: [[0x10, 0x32]] }),
    "image/png",
  );

  expectEqual(fourBit.colorSpace, "rgb", "an indexed image is decoded to the colours its palette names");
  expectEqual(fourBit.samples.length, 12, "four pixels of three bytes");
  expectEqual(
    [...fourBit.samples.subarray(0, 3)].join(","),
    palette.slice(3, 6).join(","),
    "the first nibble is the high one, so the row starts at palette entry one",
  );
  expectEqual([...fourBit.samples.subarray(3, 6)].join(","), palette.slice(0, 3).join(","), "then entry zero");
  expectEqual([...fourBit.samples.subarray(9, 12)].join(","), palette.slice(6, 9).join(","), "and ends at entry two");
  expectEqual(fourBit.alpha, null, "with no transparent entry in the palette there is no mask");

  // ---- transparency chunks ----
  const indexedTransparent = decodeInvoicePdfImage(
    pngOf({ width: 2, height: 1, bitDepth: 8, colorType: 3, palette, transparency: [255, 0], rows: [[0, 1]] }),
    "image/png",
  );

  expectEqual(
    [...(indexedTransparent.alpha ?? [])].join(","),
    "255,0",
    "a tRNS over a palette makes the entries it names transparent",
  );

  const truecolourTransparent = decodeInvoicePdfImage(
    pngOf({
      width: 2,
      height: 1,
      bitDepth: 8,
      colorType: 2,
      transparency: [0, 255, 0, 255, 0, 255],
      rows: [[255, 255, 255, 7, 7, 7]],
    }),
    "image/png",
  );

  expectEqual(
    [...(truecolourTransparent.alpha ?? [])].join(","),
    "0,255",
    "and over truecolour it names the one colour that disappears, as three sixteen bit values",
  );

  // ---- a stream in two chunks, and the filters ----
  const split = decodeInvoicePdfImage(
    pngOf({
      width: 2,
      height: 2,
      bitDepth: 8,
      colorType: 2,
      rows: [
        [1, 2, 3, 4, 5, 6],
        [7, 8, 9, 10, 11, 12],
      ],
      splitIdat: true,
    }),
    "image/png",
  );

  expectEqual([...split.samples].join(","), "1,2,3,4,5,6,7,8,9,10,11,12", "an IDAT split in two is concatenated");

  // Up: every byte of the second row is the stored byte plus the byte above it. The first row has nothing
  // above it, so it is the stored row - which is what makes the second row's expectation statable.
  const up = decodeInvoicePdfImage(
    pngOf({
      width: 2,
      height: 2,
      bitDepth: 8,
      colorType: 2,
      rows: [
        [1, 2, 3, 4, 5, 6],
        [10, 20, 30, 15, 25, 35],
      ],
      filter: 2,
    }),
    "image/png",
  );

  expectEqual([...up.samples.subarray(0, 6)].join(","), "1,2,3,4,5,6", "an Up filtered first row is the row stored");
  expectEqual(
    [...up.samples.subarray(6)].join(","),
    "11,22,33,19,30,41",
    "and the second is that plus the row above it",
  );

  // Paeth, over a first row that was not filtered. The predictor for each byte is whichever of `a` (the byte
  // three positions back, which is one pixel in a three byte image), `b` (the byte above) and `c` (the byte
  // above-left) is closest to `a + b - c`, and the row below is that prediction added to the stored byte.
  // Worked by hand from the specification: the first three bytes have no pixel to their left, so `a` and `c`
  // are zero and `b` wins; the last three have `a` from this row and the pa distance of three beats both
  // others, so the prediction is the byte above-left in this row rather than the one above it.
  const paeth = decodeInvoicePdfImage(
    pngOf({
      width: 2,
      height: 2,
      bitDepth: 8,
      colorType: 2,
      rows: [
        [1, 2, 3, 4, 5, 6],
        [10, 20, 30, 15, 25, 35],
      ],
      filters: [0, 4],
    }),
    "image/png",
  );

  expectEqual(
    [...paeth.samples.subarray(6)].join(","),
    "11,22,33,26,47,68",
    "a Paeth filtered row is reconstructed against the row it predicts from",
  );

  // ---- the refusals ----
  const refusals: readonly (readonly [string, Uint8Array, string])[] = [
    [
      "an interlaced PNG",
      pngOf({ width: 2, height: 2, bitDepth: 8, colorType: 2, interlace: 1, rows: [[1, 2, 3, 4, 5, 6]] }),
      "interlaced",
    ],
    [
      "a PNG that declares fifty thousand pixels a side",
      pngOf({
        width: 1,
        height: 1,
        bitDepth: 8,
        colorType: 2,
        declared: [...be32(5_000), ...be32(5_000), 8, 2, 0, 0, 0],
        rows: [[1, 2, 3]],
      }),
      "too_many_pixels",
    ],
    [
      "truecolour at four bits, which the specification does not define",
      pngOf({ width: 2, height: 1, bitDepth: 4, colorType: 2, rows: [[0x12, 0x34]] }),
      "unsupported_bit_depth",
    ],
    ["an indexed image with no palette", pngOf({ width: 2, height: 1, bitDepth: 8, colorType: 3, omitPalette: true, rows: [[0, 1]] }), "malformed"],
    ["a PNG with no image data", pngOf({ width: 2, height: 1, bitDepth: 8, colorType: 2, omitIdat: true }), "malformed"],
    ["a PNG of zero width", pngOf({ width: 0, height: 1, bitDepth: 8, colorType: 2, rows: [[]] }), "malformed"],
    [
      "an indexed pixel beyond its own palette",
      pngOf({ width: 1, height: 1, bitDepth: 8, colorType: 3, palette, rows: [[9]] }),
      "malformed",
    ],
    [
      "a scanline with a filter byte of nine",
      pngOf({ width: 2, height: 1, bitDepth: 8, colorType: 2, filter: 9, rows: [[1, 2, 3, 4, 5, 6]] }),
      "malformed",
    ],
    [
      "an image whose data is longer than its own header declares",
      pngOf({
        width: 2,
        height: 2,
        bitDepth: 8,
        colorType: 2,
        rows: Array.from({ length: 400 }, () => [1, 2, 3, 4, 5, 6]),
      }),
      "malformed",
    ],
    ["a file cut in half", png.subarray(0, 40), "malformed"],
    ["a WebP", webp, "not_an_image"],
  ];

  for (const [description, bytes, reason] of refusals) {
    const thrown = await refusalReason(async () => {
      decodeInvoicePdfImage(bytes, "image/png");
    });

    expectEqual(thrown.code, "VALIDATION_FAILED", `${description} is refused as a validation failure`);
    expectEqual(thrown.reason, reason, `${description} says why`);
    expectEqual(
      JSON.stringify(thrown.details),
      JSON.stringify([{ field: "logo", rule: "file_not_acceptable" }]),
      `${description} names the field a form can mark`,
    );
  }

  // ---- JPEG geometry, and what a PDF cannot take ----
  const baseline = decodeInvoicePdfImage(jpeg, "image/jpeg");

  expectEqual(baseline.format, "jpeg", "a baseline JPEG is the other format a PDF can hold");
  expectEqual(baseline.width, 12, "its width comes out of the frame marker");
  expectEqual(baseline.height, 9, "and so does its height");
  expectEqual(baseline.colorSpace, "rgb", "three components are a colour image");
  expectEqual(baseline.filter, "DCTDecode", "and it is passed through under its own filter");
  expectEqual(
    Buffer.compare(Buffer.from(baseline.samples), Buffer.from(jpeg)),
    0,
    "the samples are the merchant's own bytes, because nothing here decodes a JPEG",
  );

  const filled = decodeInvoicePdfImage(jpegOf({ width: 4, height: 3, fill: true }), "image/jpeg");

  expectEqual(filled.width, 4, "fill bytes before a marker are stepped over, as the specification allows");

  const greyJpeg = decodeInvoicePdfImage(jpegOf({ width: 6, height: 5, components: 1 }), "image/jpeg");

  expectEqual(greyJpeg.colorSpace, "gray", "one component is a greyscale image");

  const trimmed = decodeInvoicePdfImage(jpegOf({ width: 6, height: 5, trailing: [1, 2, 3, 4] }), "image/jpeg");

  expectEqual(
    trimmed.samples.length,
    jpegOf({ width: 6, height: 5 }).length,
    "anything after the end of image marker is trimmed rather than stored",
  );

  const jpegRefusals: readonly (readonly [string, JpegFixture, string])[] = [
    ["a progressive JPEG", { width: 8, height: 8, startOfFrame: 0xc2 }, "unsupported_jpeg"],
    ["a four component JPEG", { width: 8, height: 8, components: 4 }, "unsupported_jpeg"],
    ["a twelve bit JPEG", { width: 8, height: 8, precision: 12 }, "unsupported_jpeg"],
    ["a JPEG too large to draw", { width: 5_000, height: 5_000 }, "too_many_pixels"],
  ];

  for (const [description, fixture, reason] of jpegRefusals) {
    const thrown = await refusalReason(async () => {
      decodeInvoicePdfImage(jpegOf(fixture), "image/jpeg");
    });

    expectEqual(thrown.reason, reason, `${description} is refused with its own reason`);
  }

  expectEqual(
    (await refusalReason(async () => {
      decodeInvoicePdfImage(jpegOf({ width: 4, height: 4 }).subarray(0, 6), "image/jpeg");
    })).reason,
    "malformed",
    "and a JPEG with no frame marker at all is malformed rather than guessed at",
  );

  // ---- the samples an image object is written from ----
  const image: InvoicePdfImage = decoded;

  expectEqual(image.samples.length, image.width * image.height * 3, "an rgb image holds three bytes a pixel");
  expect(image.alpha === null || image.alpha.length === image.width * image.height, "and a mask one byte a pixel");
}

/** What a synchronous call threw, in the shape the gate reads an `AppError` everywhere else. */
async function refusalReason(
  run: () => Promise<unknown>,
): Promise<{
  readonly code: string | null;
  readonly reason: string | null;
  readonly details: readonly { readonly field?: unknown; readonly rule?: unknown }[];
}> {
  try {
    await run();

    return { code: null, reason: null, details: [] };
  } catch (error) {
    if (!isAppError(error)) {
      return { code: "uncaught", reason: null, details: [] };
    }

    const cause = error.cause;

    return {
      code: error.code,
      reason:
        typeof cause === "object" && cause !== null && "reason" in cause
          ? String((cause as { readonly reason: unknown }).reason)
          : null,
      details: error.details,
    };
  }
}

/* ---- STEP 118: the letterhead a merchant chooses ---- */

/** A four byte riffle of a WebP: enough for a sniffer to recognise it and for a PDF to refuse it. */
function webpFile(): Uint8Array {
  const ascii = (text: string): readonly number[] => [...text].map((character) => character.charCodeAt(0));

  return concatBytes([
    Uint8Array.from(ascii("RIFF")),
    Uint8Array.of(0x1a, 0x00, 0x00, 0x00),
    Uint8Array.from(ascii("WEBPVP8 ")),
    Uint8Array.of(0x0c, 0x00, 0x00, 0x00),
  ]);
}

/** The two rules of the letterhead, as the accent reaches them: three fractions of one in the stroke. */
function accentStroke(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);

  return `${pointsOf((value >> 16) & 0xff)} ${pointsOf((value >> 8) & 0xff)} ${pointsOf(value & 0xff)} RG`;
}

/** The same rounding the renderer does, restated here so an assertion is not the implementation's echo. */
function pointsOf(byte: number): string {
  return (Math.round((byte / 255) * 100) / 100).toString();
}

async function checkPdfBranding(): Promise<void> {
  const labels = invoicePdfLabels("0");
  const branded = renderInvoicePdf(invoicePdfDocumentOf(pdfSourceOf()));
  const read = readPdf(branded);
  const text = read.text;
  const content = pdfStreamText(read.bodies.get(7) ?? "");

  // ---- the merchant's own half of the header ----
  for (const [fact, description] of [
    ["Northlight Studio LLC", "the name the merchant chose to print"],
    ["Design and hosting since 2014", "their tagline"],
    ["48 Commerce Row", "the first line of their address"],
    ["Austin, TX 78701", "the second"],
    ["accounts@northlight.example", "their email"],
    ["+1 512 555 0143", "and their phone"],
  ] as readonly (readonly [string, string])[]) {
    expect(text.includes(fact), `the letterhead prints ${description}`);
  }

  expect(
    /1 0 0 1 54 [\d.]+ Tm [(]Northlight Studio LLC[)] Tj/u.test(content),
    "the merchant's name is drawn at the left margin, in the column the client's block sits in below it",
  );
  expect(
    text.indexOf("Northlight Studio LLC") < text.indexOf("Acme Ltd"),
    "and it is drawn above the client, because a letterhead comes before an addressee",
  );
  expect(
    text.indexOf(labels.title) < text.indexOf("Northlight Studio LLC"),
    "while the document's own title is still the first thing on the page",
  );

  // The status line names the status. It said "Invoice number: Sent" until this STEP rewrote the header,
  // because it was built from the number's label while the number itself was the line above it.
  expect(text.includes(`${labels.status}: ${labels.statusWords.sent}`), "the status line is labelled as a status");
  expect(
    !text.includes(`${labels.numberLabel}: ${labels.statusWords.sent}`),
    "and the number's label is not used for it, which is what STEP 117 printed",
  );

  // ---- a merchant who has set nothing ----
  const bare = readPdf(
    renderInvoicePdf(
      invoicePdfDocumentOf(
        pdfSourceOf({
          branding: pdfBrandingOf({ name: null, tagline: null, address: null, contact: null }),
        }),
      ),
    ),
  );

  expect(!bare.text.includes("Northlight"), "a merchant who prints no name has none on the page");
  expect(!bare.text.includes("accounts@northlight.example"), "and no contact line either");
  expectEqual(
    bare.objectCount,
    5 + bare.pageCount * 2,
    "with no logo the file holds nothing but the five fixed objects and two a page",
  );
  expectEqual(
    read.objectCount,
    5 + read.pageCount * 2,
    "and a letterhead of words adds no object, because text needs no XObject",
  );
  expect(bare.text.includes(labels.title), "while the document still says what it is");

  // ---- the accent ----
  // The operators are inside a deflated stream, so the colour is read back inflated rather than searched for
  // in the file's bytes: a compressed stream does not contain the words it draws with.
  const accentRead = readPdf(
    renderInvoicePdf(invoicePdfDocumentOf(pdfSourceOf({ branding: pdfBrandingOf({ accentHex: "#1f4e79" }) }))),
  );
  const accentContent = accentRead.pages
    .map((_, index) => pdfStreamText(accentRead.bodies.get(7 + index * 2) ?? ""))
    .join("\n");
  const stroke = accentStroke("#1f4e79");

  expect(accentContent.includes(stroke), "an accent reaches the rule as three fractions of one");
  expectEqual(
    accentContent.split(stroke).length - 1,
    1,
    "and it colours the rule under the letterhead, not the rules inside the table",
  );
  expect(!content.includes(" RG"), "a document with no accent strokes in grey alone");
  expect(!accentContent.includes(" rg"), "and the accent is never a fill, so it can never be the colour of a sentence");

  // A colour that does not match the column's own check falls back rather than failing an invoice.
  const badAccent = pdfStreamText(
    readPdf(
      renderInvoicePdf(
        invoicePdfDocumentOf(pdfSourceOf({ branding: { ...pdfBrandingOf(), accentHex: "#12345" } })),
      ),
    ).bodies.get(7) ?? "",
  );

  expect(!badAccent.includes(" RG"), "and a malformed accent draws the default grey instead of throwing");

  // ---- the note above the footer ----
  const manyLines = Array.from({ length: 60 }, (_, index) =>
    pdfLineOf(index + 1, `Row ${String(index + 1).padStart(2, "0")}`, "1", 100_000n),
  );
  const noted = readPdf(
    renderInvoicePdf(
      invoicePdfDocumentOf(
        pdfSourceOf({
          lines: manyLines,
          branding: pdfBrandingOf({ footerNote: "Payment by bank transfer within fourteen days." }),
        }),
      ),
    ),
  );
  const lastPage = noted.pages[noted.pageCount - 1];

  expect(noted.pageCount > 1, "the fixture is long enough to break to a second page");
  expect(
    lastPage !== undefined && lastPage.text.includes("Payment by bank transfer within fourteen days."),
    "the merchant's note prints on the page the document ends on",
  );
  expect(
    noted.pages[0] !== undefined && !noted.pages[0].text.includes("Payment by bank transfer"),
    "and not on the first page, where it would float between two halves of a table",
  );
  expect(
    !text.includes("Payment by bank transfer"),
    "while a document whose merchant set no note prints none",
  );

  // A note wider than the column is wrapped rather than run off the page. Forty words and a last one is
  // inside the 300 characters `0116` allows, so what is being proved here is the wrapping and not the cut.
  const wrappedNote = pdfStreamText(
    readPdf(
      renderInvoicePdf(
        invoicePdfDocumentOf(
          pdfSourceOf({ branding: pdfBrandingOf({ footerNote: `${"word ".repeat(40)}end` }) }),
        ),
      ),
    ).bodies.get(7) ?? "",
  );

  expectEqual(
    wrappedNote.split("ET").filter((operation) => operation.includes("word ")).length > 1,
    true,
    "a long note is drawn as several lines, one text operation each, rather than run off the page",
  );
  expect(wrappedNote.includes("end"), "and no word of it is dropped by the wrapping");

  // Beyond the ceiling the note is cut, as every other text field on the document is.
  const cutNote = pdfStreamText(
    readPdf(
      renderInvoicePdf(
        invoicePdfDocumentOf(
          pdfSourceOf({ branding: pdfBrandingOf({ footerNote: `${"word ".repeat(60)}CUTMARK` }) }),
        ),
      ),
    ).bodies.get(7) ?? "",
  );

  expect(!cutNote.includes("CUTMARK"), "and the part of a note beyond 300 characters is cut rather than printed");

  // ---- a logo ----
  const opaque = pngOf({
    width: 4,
    height: 2,
    bitDepth: 8,
    colorType: 2,
    rows: [
      [255, 0, 0, 0, 255, 0, 0, 0, 255, 12, 34, 56],
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    ],
  });
  const withLogo = renderInvoicePdf(
    invoicePdfDocumentOf(
      pdfSourceOf({ branding: pdfBrandingOf({ logo: { bytes: opaque, contentType: "image/png" } }) }),
    ),
  );
  const logoRead = readPdf(withLogo);
  const imageObject = 6 + logoRead.pageCount * 2;
  const imageBody = logoRead.bodies.get(imageObject) ?? "";
  const logoContent = pdfStreamText(logoRead.bodies.get(7) ?? "");

  expectEqual(
    logoRead.objectCount,
    5 + logoRead.pageCount * 2 + 1,
    "a logo with nothing transparent is one object, because a mask of all ones would say nothing",
  );
  expect(imageBody.includes("/Type /XObject"), "the logo is written as an XObject");
  expect(imageBody.includes("/Subtype /Image"), "of the image subtype");
  expect(imageBody.includes("/Width 4"), "four pixels wide");
  expect(imageBody.includes("/Height 2"), "and two high");
  expect(imageBody.includes("/ColorSpace /DeviceRGB"), "in the colour space its samples are in");
  expect(imageBody.includes("/BitsPerComponent 8"), "at eight bits a component");
  expect(imageBody.includes("/Filter /FlateDecode"), "deflated, because the samples were produced here");
  expect(!imageBody.includes("/SMask"), "and with no soft mask it does not name one");
  expect(
    /q 4 0 0 2 54 [\d.]+ cm \/Im1 Do Q/u.test(logoContent),
    "the page draws it at its own pixel size in the left margin, and never scaled up",
  );
  expect(
    (logoRead.bodies.get(6) ?? "").includes(`/XObject << /${INVOICE_PDF_LOGO_NAME} ${String(imageObject)} 0 R >>`),
    "the first page's resources name the object the file writes after the pages",
  );
  expect(
    (logoRead.bodies.get(6) ?? "").includes("/ProcSet [/PDF /Text /ImageC]"),
    "and ask for the image procedure set, because that page draws a picture",
  );

  // A logo that has a clear pixel carries its mask, and the mask is an image of the same geometry.
  const clear = rgbaPng([
    [9, 9, 9, 0],
    [8, 8, 8, 255],
    [7, 7, 7, 255],
    [6, 6, 6, 128],
  ]);
  const masked = readPdf(
    renderInvoicePdf(
      invoicePdfDocumentOf(
        pdfSourceOf({ branding: pdfBrandingOf({ logo: { bytes: clear, contentType: "image/png" } }) }),
      ),
    ),
  );
  const maskObject = 6 + masked.pageCount * 2 + 1;
  const maskBody = masked.bodies.get(maskObject) ?? "";

  expectEqual(masked.objectCount, 5 + masked.pageCount * 2 + 2, "an image and its mask are two objects");
  expect(
    (masked.bodies.get(6 + masked.pageCount * 2) ?? "").includes(`/SMask ${String(maskObject)} 0 R`),
    "the image names the mask that follows it",
  );
  expect(maskBody.includes("/ColorSpace /DeviceGray"), "which is one grey byte a pixel");
  expect(maskBody.includes("/Width 2") && maskBody.includes("/Height 2"), "of the same geometry as the image");

  // Only the first page carries a picture, so only the first page claims it can draw one.
  const manyWithLogo = readPdf(
    renderInvoicePdf(
      invoicePdfDocumentOf(
        pdfSourceOf({
          lines: manyLines,
          branding: pdfBrandingOf({ logo: { bytes: opaque, contentType: "image/png" } }),
        }),
      ),
    ),
  );

  expect(manyWithLogo.pageCount > 1, "a long invoice with a logo still breaks to a second page");
  expect((manyWithLogo.bodies.get(6) ?? "").includes("/XObject"), "the first page names the image");
  expect(!(manyWithLogo.bodies.get(8) ?? "").includes("/XObject"), "and no later page does");
  expect(
    (manyWithLogo.bodies.get(8) ?? "").includes("/ProcSet [/PDF /Text]"),
    "a page that draws no picture does not ask for the image procedure set",
  );
  expectEqual(
    manyWithLogo.objectCount,
    5 + manyWithLogo.pageCount * 2 + 1,
    "and one logo is one object however many pages the document fills",
  );

  // ---- the box ----
  const oversized = pngOf({
    width: 288,
    height: 88,
    bitDepth: 8,
    colorType: 0,
    rows: Array.from({ length: 88 }, () => Array.from({ length: 288 }, () => 128)),
  });
  const fitted = pdfStreamText(
    readPdf(
      renderInvoicePdf(
        invoicePdfDocumentOf(
          pdfSourceOf({ branding: pdfBrandingOf({ logo: { bytes: oversized, contentType: "image/png" } }) }),
        ),
      ),
    ).bodies.get(7) ?? "",
  );

  expectEqual(INVOICE_PDF_LOGO_MAXIMUM_WIDTH, 144, "the box is two inches wide");
  expectEqual(INVOICE_PDF_LOGO_MAXIMUM_HEIGHT, 44, "and forty four points high");
  expect(
    /q 144 0 0 44 54 [\d.]+ cm/u.test(fitted),
    "a logo larger than the box is scaled down to it, keeping its aspect",
  );
  expectEqual(INVOICE_PDF_LOGO_NAME, "Im1", "one image, one name, and nothing to allocate");

  // ---- a JPEG goes in as the merchant's own file ----
  const jpeg = jpegOf({ width: 12, height: 9 });
  const jpegRead = readPdf(
    renderInvoicePdf(
      invoicePdfDocumentOf(
        pdfSourceOf({ branding: pdfBrandingOf({ logo: { bytes: jpeg, contentType: "image/jpeg" } }) }),
      ),
    ),
  );
  const jpegBody = jpegRead.bodies.get(6 + jpegRead.pageCount * 2) ?? "";
  const jpegStart = jpegBody.indexOf("stream\n") + "stream\n".length;

  expect(jpegBody.includes("/Filter /DCTDecode"), "a JPEG is passed through under its own filter");
  expect(jpegBody.includes("/Width 12") && jpegBody.includes("/Height 9"), "at the geometry its frame declares");
  expectEqual(
    Buffer.compare(
      Buffer.from(jpegBody.slice(jpegStart, jpegBody.indexOf("\nendstream", jpegStart)), "latin1"),
      Buffer.from(jpeg),
    ),
    0,
    "and the stream is the file the merchant uploaded, byte for byte",
  );

  // ---- determinism, and the ceiling ----
  expectEqual(
    Buffer.compare(Buffer.from(withLogo), Buffer.from(renderInvoicePdf(invoicePdfDocumentOf(pdfSourceOf({
      branding: pdfBrandingOf({ logo: { bytes: opaque, contentType: "image/png" } }),
    }))))),
    0,
    "a logo does not make the file less deterministic, so a retry stores an identical object",
  );
  expect(withLogo.length < INVOICE_PDF_MAXIMUM_BYTES, "and a document with a logo is far inside the ceiling");
  expect(
    withLogo.length > branded.length,
    "while the samples are really in the file rather than described by it",
  );

  // ---- what the renderer refuses ----
  const refused = await refusalReason(async () => {
    renderInvoicePdf(
      invoicePdfDocumentOf(
        pdfSourceOf({
          branding: pdfBrandingOf({ logo: { bytes: webpFile(), contentType: "image/webp" } }),
        }),
      ),
    );
  });

  expectEqual(refused.code, "VALIDATION_FAILED", "a format no PDF can draw is refused at the render");
  expectEqual(refused.reason, "not_an_image", "with the reason the reader gave");

  const interlaced = await refusalReason(async () => {
    renderInvoicePdf(
      invoicePdfDocumentOf(
        pdfSourceOf({
          branding: pdfBrandingOf({
            logo: {
              bytes: pngOf({ width: 2, height: 2, bitDepth: 8, colorType: 2, interlace: 1, rows: [[1, 2, 3, 4, 5, 6]] }),
              contentType: "image/png",
            },
          }),
        }),
      ),
    );
  });

  expectEqual(interlaced.reason, "interlaced", "and an interlaced PNG says so rather than being guessed at");
}

/* ---- STEP 118: the branding row, the profile behind it and the logo ---- */

function profileRow(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    company_id: COMPANY_A,
    legal_name: "Northlight Studio Limited Liability Company",
    trading_name: "Northlight Studio",
    business_type: "sole_proprietorship",
    registration_number: null,
    tax_id: "74-1234567",
    website: "northlight.example",
    address_line1: "48 Commerce Row",
    address_line2: "Suite 3",
    city: "Austin",
    state_province: "TX",
    postal_code: "78701",
    country_code: "us",
    contact_name: "Dana Reyes",
    contact_email: "accounts@northlight.example",
    contact_phone: "+1 512 555 0143",
    created_at: new Date(NOW).toISOString(),
    updated_at: new Date(NOW).toISOString(),
    deleted_at: null,
    version: 1,
    ...overrides,
  };
}

function brandingDeps(
  db: InvoiceDb,
  audit: ReturnType<typeof createInMemoryAuditTrail> = createInMemoryAuditTrail(),
  adapter: PdfGateAdapter = new PdfGateAdapter(),
): InvoiceBrandingStorageDependencies {
  return {
    rest: createInvoiceRest(db),
    audit,
    adapter,
    encryption: createFileEncryption({ ENCRYPTION_MASTER_KEY: PDF_GATE_KEY }),
    now: () => NOW,
  };
}

function brandingBodyOf(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    logo_file_id: null,
    show_logo: true,
    name_style: "trading",
    show_address: true,
    show_contact: true,
    show_tax_id: false,
    show_website: false,
    tagline: "Design and hosting since 2014",
    footer_note: null,
    accent_colour: null,
    version: 0,
    ...overrides,
  };
}

async function checkBrandingService(): Promise<void> {
  // ---- a merchant who has never opened the screen ----
  const fresh = createDb();

  fresh.companies.push({ id: COMPANY_A, name: "Northlight Studio LLC", deleted_at: null });
  fresh.profiles.push(profileRow());

  const untouched = await readInvoiceBranding({ actor: owner }, brandingDeps(fresh));

  expectEqual(untouched.settings.version, 0, "no row means version zero, which is what a first save posts back");
  expectEqual(untouched.settings.updatedAtEpochMs, 0, "and no instant, because nothing has been saved");
  expectEqual(untouched.settings.showAddress, INVOICE_BRANDING_DEFAULTS.showAddress, "the address shows by default");
  expectEqual(untouched.settings.showContact, INVOICE_BRANDING_DEFAULTS.showContact, "and so does the contact");
  expectEqual(untouched.settings.showTaxId, INVOICE_BRANDING_DEFAULTS.showTaxId, "while a tax id is kept off");
  expectEqual(untouched.settings.showWebsite, INVOICE_BRANDING_DEFAULTS.showWebsite, "and a website with it");
  expectEqual(untouched.settings.logoFileId, null, "with no logo, because a logo is a choice about a file");
  expectEqual(untouched.adoptedLogo, null, "so there is nothing adopted");
  expectEqual(untouched.newestLogo, null, "and nothing in storage either");
  expectEqual(untouched.newestLogoUrl, null, "and no URL to sign");
  expectEqual(fresh.branding.length, 0, "reading the settings writes no row");

  // The defaults still print a seller, because the facts are the profile's and not this row's.
  expectEqual(untouched.preview.name, "Northlight Studio", "the preview names the merchant by their trading name");
  expectEqual(
    untouched.preview.address,
    "48 Commerce Row\nSuite 3\nAustin, TX 78701\nUS",
    "and prints the address the profile holds, assembled as a document reads it",
  );
  expectEqual(
    untouched.preview.contact,
    "accounts@northlight.example\n+1 512 555 0143",
    "with the contact lines the merchant chose to show",
  );
  expectEqual(untouched.preview.tagline, null, "no tagline, because none was set");
  expectEqual(untouched.preview.accentHex, null, "and no accent, so the rule is the default grey");

  // ---- the identity, and its fallbacks ----
  expectEqual(
    await readInvoiceBrandingIdentity(createInvoiceRest(fresh), COMPANY_A).then((identity) => identity.companyName),
    "Northlight Studio LLC",
    "the company's own name is read as the last resort",
  );

  const legalOnly = createDb();

  legalOnly.companies.push({ id: COMPANY_A, name: "Northlight Studio LLC", deleted_at: null });
  legalOnly.profiles.push(profileRow({ trading_name: null }));

  const legalWords = invoiceBrandingWordsOf(
    await readInvoiceBrandingIdentity(createInvoiceRest(legalOnly), COMPANY_A),
    { ...INVOICE_BRANDING_DEFAULTS, version: 0, updatedAtEpochMs: 0 },
  );

  expectEqual(
    legalWords.name,
    "Northlight Studio Limited Liability Company",
    "a merchant with no trading name prints their legal one rather than nothing",
  );

  const noProfile = createDb();

  noProfile.companies.push({ id: COMPANY_A, name: "Northlight Studio LLC", deleted_at: null });

  const companyWords = invoiceBrandingWordsOf(
    await readInvoiceBrandingIdentity(createInvoiceRest(noProfile), COMPANY_A),
    { ...INVOICE_BRANDING_DEFAULTS, version: 0, updatedAtEpochMs: 0 },
  );

  expectEqual(companyWords.name, "Northlight Studio LLC", "and with no profile at all, the company's name");
  expectEqual(companyWords.address, null, "with no address to print");
  expectEqual(companyWords.contact, null, "and no contact line");

  const nothing = invoiceBrandingWordsOf(
    {
      companyName: null,
      tradingName: null,
      legalName: null,
      taxId: null,
      website: null,
      addressLines: [],
      email: null,
      phone: null,
    },
    { ...INVOICE_BRANDING_DEFAULTS, version: 0, updatedAtEpochMs: 0 },
  );

  expectEqual(nothing.name, null, "so a document with no seller anywhere prints no name rather than a guess");

  // The name style chooses, and each choice falls back to the other rather than to nothing.
  const identity: InvoiceBrandingIdentity = await readInvoiceBrandingIdentity(createInvoiceRest(fresh), COMPANY_A);
  const defaults = { ...INVOICE_BRANDING_DEFAULTS, version: 0, updatedAtEpochMs: 0 };

  expectEqual(
    invoiceBrandingWordsOf(identity, { ...defaults, nameStyle: "legal" }).name,
    "Northlight Studio Limited Liability Company",
    "the legal style prints the legal name",
  );
  expectEqual(
    invoiceBrandingWordsOf(identity, { ...defaults, showAddress: false }).address,
    null,
    "an address the merchant turned off is not printed",
  );
  expectEqual(
    invoiceBrandingWordsOf(identity, { ...defaults, showContact: false }).contact,
    null,
    "and neither is a contact they turned off",
  );
  expectEqual(
    invoiceBrandingWordsOf(identity, { ...defaults, showWebsite: true, showContact: false }).contact,
    "northlight.example",
    "a website is its own choice, so it prints with the contact lines off",
  );
  expectEqual(
    invoiceBrandingWordsOf(identity, { ...defaults, showTaxId: true, showContact: false }).contact,
    formatMessage("invoices.brandingTaxIdLine", { taxId: "74-1234567" }),
    "and a tax id prints under the label the catalog holds, because the renderer holds no English",
  );
  expectEqual(
    invoiceBrandingWordsOf(identity, { ...defaults, showTaxId: true, showWebsite: true }).contact,
    "accounts@northlight.example\n+1 512 555 0143\nnorthlight.example\nTax ID: 74-1234567",
    "in the order a letterhead reads: how to reach them, then who they are to a tax authority",
  );
  expectEqual(
    invoiceBrandingWordsOf({ ...identity, taxId: null }, { ...defaults, showTaxId: true }).contact,
    "accounts@northlight.example\n+1 512 555 0143",
    "and a tax id that was never stored prints no empty label",
  );
  expectEqual(INVOICE_BRANDING_NAME_STYLES.join(","), "trading,legal", "two name styles, and no third");

  // ---- parsing a save ----
  const parsed = parseInvoiceBrandingInput(brandingBodyOf());

  expectEqual(parsed.expectedVersion, 0, "the version the caller read the settings from travels with them");
  expectEqual(parsed.settings.tagline, "Design and hosting since 2014", "a tagline is kept as it was typed");
  expectEqual(parsed.settings.nameStyle, "trading", "and the name style is one of the two");

  expectEqual(
    parseInvoiceBrandingInput(brandingBodyOf({ tagline: "   " })).settings.tagline,
    null,
    "emptying the box is a deliberate clear rather than a required field",
  );
  expectEqual(
    parseInvoiceBrandingInput(brandingBodyOf({ accent_colour: "#1F4E79" })).settings.accentColour,
    "#1f4e79",
    "a colour picker's capitals are stored as the lowercase the column check enforces",
  );
  expectEqual(
    parseInvoiceBrandingInput(brandingBodyOf({ accent_colour: "" })).settings.accentColour,
    null,
    "and an empty colour is the default grey",
  );
  expectEqual(
    parseInvoiceBrandingInput(brandingBodyOf({ footer_note: "one\r\ntwo\r\n\r\n\r\n\r\nthree" })).settings.footerNote,
    "one\ntwo\n\nthree",
    "a note is normalised the way every multiline field on the platform is",
  );

  const refusals: readonly (readonly [string, Readonly<Record<string, unknown>>, string, string])[] = [
    ["a tagline of 121 characters", { tagline: "x".repeat(INVOICE_BRANDING_LIMITS.tagline + 1) }, "tagline", "too_long"],
    ["a note of 301 characters", { footer_note: "y".repeat(INVOICE_BRANDING_LIMITS.footerNote + 1) }, "footer_note", "too_long"],
    ["a colour that is not six hexadecimal digits", { accent_colour: "#12345" }, "accent_colour", "invalid_format"],
    ["a colour that is not a colour", { accent_colour: "rebeccapurple" }, "accent_colour", "invalid_format"],
    ["no version", { version: undefined }, "version", "invalid_format"],
    ["a name style that does not exist", { name_style: "nickname" }, "name_style", "invalid_format"],
    ["a logo file id that is not a uuid", { logo_file_id: "12" }, "logo_file_id", "invalid_format"],
    ["a toggle that is not a boolean", { show_logo: "yes" }, "show_logo", "invalid_format"],
  ];

  for (const [description, overrides, field, rule] of refusals) {
    const details = await refusalOf(async () => {
      parseInvoiceBrandingInput(brandingBodyOf(overrides));
    });

    expectEqual(
      JSON.stringify(details),
      JSON.stringify([{ field, rule }]),
      `${description} is refused naming ${field}`,
    );
  }

  // Every problem at once, so a form can mark all of them in one round trip.
  const both = await refusalOf(async () => {
    parseInvoiceBrandingInput(
      brandingBodyOf({ tagline: "x".repeat(200), accent_colour: "nope" }),
    );
  });

  expectEqual(both.length, 2, "a tagline and a colour that are both wrong are both reported");
  expectEqual(
    parseInvoiceBrandingInput(brandingBodyOf({ tagline: "x".repeat(INVOICE_BRANDING_LIMITS.tagline) })).settings
      .tagline?.length,
    INVOICE_BRANDING_LIMITS.tagline,
    "while a tagline of exactly the ceiling is kept",
  );
  expectEqual(
    invoiceBrandingInputSchema.shape.version.safeParse(0).success,
    true,
    "and version zero is the first save",
  );

  // ---- saving ----
  const db = createDb();

  db.companies.push({ id: COMPANY_A, name: "Northlight Studio LLC", deleted_at: null });
  db.profiles.push(profileRow());

  const audit = createInMemoryAuditTrail();
  const dependencies = brandingDeps(db, audit);
  const saved = await updateInvoiceBranding(
    { actor: owner, values: parseInvoiceBrandingInput(brandingBodyOf({ show_tax_id: true })) },
    dependencies,
  );

  expectEqual(db.branding.length, 1, "a first save creates the row rather than reading one into existence");
  expectEqual(db.updates.length, 0, "and writes no update to do it");
  expectEqual(saved.settings.version, 1, "the row starts at version one");
  expectEqual(saved.settings.showTaxId, true, "holding what was posted");
  expectEqual(saved.preview.contact?.includes("Tax ID:") ?? false, true, "so the preview already prints it");

  const entries = audit.entries.filter((entry) => entry.action === INVOICE_BRANDING_UPDATED_AUDIT_ACTION);

  expectEqual(entries.length, 1, "one save writes one audit entry");
  expectEqual(entries[0]?.entityType, INVOICE_BRANDING_AUDIT_ENTITY, "against the branding entity");
  expectEqual(entries[0]?.companyId, COMPANY_A, "for the merchant who made it");
  expectEqual(entries[0]?.actorUserId, OWNER_ID, "by the owner who is signed in");
  expectEqual(
    JSON.stringify(entries[0]?.payload),
    JSON.stringify({
      logo_file_id: null,
      show_logo: true,
      name_style: "trading",
      show_address: true,
      show_contact: true,
      show_tax_id: true,
      show_website: false,
      has_tagline: true,
      has_footer_note: false,
      accent_colour: null,
    }),
    "recording the choices and the fact of a tagline, but not the merchant's own words",
  );

  const second = await updateInvoiceBranding(
    { actor: owner, values: parseInvoiceBrandingInput(brandingBodyOf({ tagline: null, version: 1 })) },
    dependencies,
  );

  expectEqual(second.settings.version, 2, "a later save moves the version");
  expectEqual(second.settings.tagline, null, "and clears what was cleared");
  expectEqual(
    db.updates[0]?.query.includes("&version=eq.1") ?? false,
    true,
    "scoped to the version it read, which is what makes a lost race write nothing",
  );
  expectEqual(
    db.updates[0]?.query.includes(`company_id=eq.${COMPANY_A}`) ?? false,
    true,
    "and to the company, so a write to another merchant's row cannot be expressed",
  );

  // ---- the optimistic lock ----
  expectEqual(
    await codeOf(() =>
      updateInvoiceBranding(
        { actor: owner, values: parseInvoiceBrandingInput(brandingBodyOf({ version: 1 })) },
        dependencies,
      ),
    ),
    "CONFLICT",
    "a save that posts a version the row has outgrown is a conflict",
  );
  expectEqual(
    JSON.stringify(
      await refusalOfAsync(() =>
        updateInvoiceBranding(
          { actor: owner, values: parseInvoiceBrandingInput(brandingBodyOf({ version: 1 })) },
          dependencies,
        ),
      ),
    ),
    JSON.stringify([{ field: "version", rule: "stale" }]),
    "naming the version as the stale field, which is the one a form can point at",
  );
  expectEqual(second.settings.tagline, null, "and the row is left as the winner of the race wrote it");

  db.raceBrandingVersion = true;

  expectEqual(
    await codeOf(() =>
      updateInvoiceBranding(
        { actor: owner, values: parseInvoiceBrandingInput(brandingBodyOf({ version: 2 })) },
        dependencies,
      ),
    ),
    "CONFLICT",
    "and when another request moves the row between the read and the write, the write matches nothing",
  );
  expectEqual(
    db.branding[0]?.["tagline"],
    "the other owner's tagline",
    "so the loser of the race overwrites nothing",
  );

  // ---- tenancy and roles ----
  expectEqual(
    await codeOf(() => readInvoiceBranding({ actor: desk }, brandingDeps(createDb()))),
    "PERMISSION_DENIED",
    "an office account with no company has no brand to read",
  );
  expectEqual(
    await codeOf(() =>
      updateInvoiceBranding(
        { actor: desk, values: parseInvoiceBrandingInput(brandingBodyOf()) },
        brandingDeps(createDb()),
      ),
    ),
    "PERMISSION_DENIED",
    "and none to write",
  );
  expectEqual(
    await codeOf(() =>
      readInvoiceBranding({ actor: actorOf(["support"], COMPANY_A, { userId: OFFICE_ID }) }, brandingDeps(createDb())),
    ),
    "PERMISSION_DENIED",
    "because branding is the owner's own configuration and not an office task",
  );

  const otherDb = createDb();

  otherDb.companies.push({ id: COMPANY_A, name: "Northlight Studio LLC", deleted_at: null });
  otherDb.companies.push({ id: COMPANY_B, name: "Ferris and Sons", deleted_at: null });
  otherDb.profiles.push(profileRow());
  otherDb.profiles.push(profileRow({ company_id: COMPANY_B, trading_name: "Ferris and Sons", legal_name: null }));
  otherDb.branding.push({
    id: randomUUID(),
    company_id: COMPANY_A,
    logo_file_id: null,
    show_logo: true,
    name_style: "trading",
    show_address: true,
    show_contact: true,
    show_tax_id: true,
    show_website: false,
    tagline: "the other merchant's tagline",
    footer_note: null,
    accent_colour: "#010203",
    created_at: new Date(NOW).toISOString(),
    updated_at: new Date(NOW).toISOString(),
    deleted_at: null,
    version: 4,
  });

  const otherRead = await readInvoiceBranding({ actor: otherOwner }, brandingDeps(otherDb));

  expectEqual(otherRead.settings.version, 0, "an owner of another company reads their own defaults");
  expectEqual(otherRead.preview.name, "Ferris and Sons", "and their own name");
  expectEqual(
    otherRead.settings.tagline,
    null,
    "with no sight of the tagline the first merchant saved",
  );

  // ---- the logo, uploaded and adopted ----
  const logoDb = createDb();

  logoDb.companies.push({ id: COMPANY_A, name: "Northlight Studio LLC", deleted_at: null });
  logoDb.profiles.push(profileRow());

  const logoAudit = createInMemoryAuditTrail();
  const logoAdapter = new PdfGateAdapter();
  const logoDeps = brandingDeps(logoDb, logoAudit, logoAdapter);
  const pngBytes = pngOf({
    width: 6,
    height: 3,
    bitDepth: 8,
    colorType: 2,
    rows: Array.from({ length: 3 }, () => Array.from({ length: 18 }, (_, index) => index * 12)),
  });

  const uploaded = await uploadInvoiceLogo(
    { actor: owner, fileName: "logo.png", declaredType: "image/png", bytes: pngBytes },
    logoDeps,
  );

  expect(uploaded.adopted, "a verified PNG becomes the invoice logo in the same request");
  expectEqual(uploaded.refusal, null, "with nothing to refuse");
  expect(uploaded.snapshot.settings.logoFileId !== null, "so the settings name a file");
  expectEqual(uploaded.snapshot.settings.showLogo, true, "and the logo is switched on");
  expectEqual(uploaded.snapshot.settings.version, 1, "in a row created by the upload");
  expectEqual(logoDb.files.length, 1, "one file row was written");
  expectEqual(logoDb.files[0]?.["purpose"], COMPANY_LOGO_PURPOSE, "of the logo purpose");
  expectEqual(logoDb.files[0]?.["status"], "ready", "verified, because its bytes matched what they claimed");
  expectEqual(logoAdapter.uploads, 1, "one object was stored");
  expectEqual(
    uploaded.snapshot.adoptedLogo?.fileId,
    uploaded.snapshot.settings.logoFileId,
    "and the screen shows the file that prints",
  );
  expectEqual(uploaded.snapshot.newestLogo?.printable, true, "described as printable, because it is");
  expect(
    uploaded.snapshot.newestLogoUrl !== null,
    "with a signed URL, because a picture the merchant cannot see is not a preview",
  );
  expectEqual(
    logoAudit.entries.filter((entry) => entry.action === INVOICE_BRANDING_UPDATED_AUDIT_ACTION).length,
    1,
    "and the adoption is audited as the branding change it is",
  );

  // What the render then draws is the file the merchant uploaded.
  const printed = await readInvoicePrintBranding({ companyId: COMPANY_A }, logoDeps);

  expectEqual(printed.words.name, "Northlight Studio", "the render reads the same identity");
  expect(printed.logo !== null, "and carries a logo");
  expectEqual(
    Buffer.compare(Buffer.from(printed.logo?.bytes ?? new Uint8Array(0)), Buffer.from(pngBytes)),
    0,
    "whose bytes are the merchant's own, decrypted from the envelope storage holds",
  );
  expectEqual(printed.logo?.contentType, "image/png", "with the type the record carries");

  // Turning the logo off keeps the choice and stops the printing.
  const hidden = await updateInvoiceBranding(
    {
      actor: owner,
      values: parseInvoiceBrandingInput(
        brandingBodyOf({
          logo_file_id: uploaded.snapshot.settings.logoFileId,
          show_logo: false,
          version: uploaded.snapshot.settings.version,
        }),
      ),
    },
    logoDeps,
  );

  expectEqual(hidden.settings.logoFileId, uploaded.snapshot.settings.logoFileId, "the choice is kept");
  expectEqual((await readInvoicePrintBranding({ companyId: COMPANY_A }, logoDeps)).logo, null, "and nothing prints");

  // A WebP is stored, because the platform allows a logo to be one, and is not adopted.
  const webpUpload = await uploadInvoiceLogo(
    { actor: owner, fileName: "logo.webp", declaredType: "image/webp", bytes: webpFile() },
    logoDeps,
  );

  expectEqual(webpUpload.adopted, false, "a WebP does not become the invoice logo");
  expectEqual(webpUpload.refusal, "not_an_image", "because a PDF cannot draw one");
  expectEqual(
    webpUpload.snapshot.settings.logoFileId,
    uploaded.snapshot.settings.logoFileId,
    "so the merchant's invoice logo is still the file that prints",
  );
  expectEqual(webpUpload.snapshot.newestLogo?.printable, false, "and the screen can say which file cannot print");

  // Bytes whose declared type did not match their own are quarantined by storage and adopted by nobody.
  const quarantined = await uploadInvoiceLogo(
    { actor: owner, fileName: "logo.png", declaredType: "image/png", bytes: jpegOf({ width: 8, height: 8 }) },
    logoDeps,
  );

  expectEqual(quarantined.adopted, false, "a quarantined upload is not adopted");
  expectEqual(quarantined.refusal, "quarantined", "and says it was kept aside");
  expectEqual(
    quarantined.snapshot.settings.logoFileId,
    uploaded.snapshot.settings.logoFileId,
    "leaving the invoice logo as it was",
  );

  // A JPEG is the other format a PDF can hold.
  const jpegUpload = await uploadInvoiceLogo(
    {
      actor: owner,
      fileName: "logo.jpg",
      declaredType: "image/jpeg",
      bytes: jpegOf({ width: 20, height: 10 }),
    },
    brandingDeps(createDb(), createInMemoryAuditTrail(), new PdfGateAdapter()),
  );

  expect(jpegUpload.adopted, "and a baseline JPEG is adopted like a PNG");

  // An upload beyond the policy's ceiling is refused before anything is stored.
  const oversizedAdapter = new PdfGateAdapter();

  expectEqual(
    await codeOf(() =>
      uploadInvoiceLogo(
        {
          actor: owner,
          fileName: "logo.png",
          declaredType: "image/png",
          bytes: new Uint8Array(UPLOAD_POLICIES.company_logo.maximumBytes + 1),
        },
        brandingDeps(createDb(), createInMemoryAuditTrail(), oversizedAdapter),
      ),
    ),
    "VALIDATION_FAILED",
    "an upload over the logo ceiling is refused",
  );
  expectEqual(oversizedAdapter.uploads, 0, "and nothing reaches the object store");

  // ---- what the render refuses ----
  const brokenDb = createDb();

  brokenDb.companies.push({ id: COMPANY_A, name: "Northlight Studio LLC", deleted_at: null });
  brokenDb.profiles.push(profileRow());

  const brokenAdapter = new PdfGateAdapter();
  const brokenDeps = brandingDeps(brokenDb, createInMemoryAuditTrail(), brokenAdapter);
  const chosen = await uploadInvoiceLogo(
    { actor: owner, fileName: "logo.png", declaredType: "image/png", bytes: pngBytes },
    brokenDeps,
  );
  const chosenId = String(chosen.snapshot.settings.logoFileId ?? "");
  const record = brokenDb.files.find((row) => row["id"] === chosenId);
  const storedKey = String(record?.["storage_key"] ?? "");

  expect(record !== undefined, "the fixture holds the record the merchant chose");

  if (record !== undefined) {
    // A file the platform has not verified never reaches a client's document.
    record["status"] = "quarantined";
    expectEqual(
      await codeOf(() => readInvoicePrintBranding({ companyId: COMPANY_A }, brokenDeps)),
      "CONFLICT",
      "a logo the platform quarantined fails the render rather than drawing without it",
    );

    record["status"] = "pending";
    expectEqual(
      await codeOf(() => readInvoicePrintBranding({ companyId: COMPANY_A }, brokenDeps)),
      "CONFLICT",
      "and one it has not finished verifying fails it too",
    );

    record["status"] = "ready";
    record["purpose"] = "invoice_pdf";
    expectEqual(
      await codeOf(() => readInvoicePrintBranding({ companyId: COMPANY_A }, brokenDeps)),
      "PERMISSION_DENIED",
      "and a record of another purpose is not a logo whatever its key says",
    );

    record["purpose"] = COMPANY_LOGO_PURPOSE;
    record["storage_key"] = `${COMPANY_B}/logo/${randomUUID()}.png`;
    expectEqual(
      await codeOf(() => readInvoicePrintBranding({ companyId: COMPANY_A }, brokenDeps)),
      "PERMISSION_DENIED",
      "nor is a key under another merchant's prefix, which is the tenancy the key check exists for",
    );

    // Back to the key the object really is stored under, so the only thing wrong is the hash: a download
    // that failed would answer a missing file, and the assertion below is about bytes that disagree with
    // their own record.
    record["storage_key"] = storedKey;
    record["content_sha256"] = "0".repeat(64);
    expectEqual(
      await codeOf(() => readInvoicePrintBranding({ companyId: COMPANY_A }, brokenDeps)),
      "INTERNAL_ERROR",
      "and bytes that do not hash to what the record says are a defect, not a document",
    );
  }

  // A file that is archived by a later upload still prints, because the merchant chose it and the bytes exist.
  const archivedDb = createDb();

  archivedDb.companies.push({ id: COMPANY_A, name: "Northlight Studio LLC", deleted_at: null });
  archivedDb.profiles.push(profileRow());

  const archivedDeps = brandingDeps(archivedDb, createInMemoryAuditTrail(), new PdfGateAdapter());
  const first = await uploadInvoiceLogo(
    { actor: owner, fileName: "first.png", declaredType: "image/png", bytes: pngBytes },
    archivedDeps,
  );
  const firstId = String(first.snapshot.settings.logoFileId ?? "");
  const secondUpload = await uploadInvoiceLogo(
    { actor: owner, fileName: "second.png", declaredType: "image/png", bytes: pngBytes },
    archivedDeps,
  );

  expectEqual(
    secondUpload.snapshot.settings.logoFileId === firstId,
    false,
    "a second upload adopts the second file",
  );
  expectEqual(
    archivedDb.files.find((row) => row["id"] === firstId)?.["status"],
    "archived",
    "and archives the first, as STEP 105's category does",
  );

  archivedDb.branding[0] = { ...(archivedDb.branding[0] ?? {}), logo_file_id: firstId };

  expect(
    (await readInvoicePrintBranding({ companyId: COMPANY_A }, archivedDeps)).logo !== null,
    "while a logo the merchant chose still prints after it was archived, because the object exists",
  );

  const pointing = await readInvoiceBranding({ actor: owner }, archivedDeps);

  expectEqual(pointing.adoptedLogo?.fileId, firstId, "and the screen shows the file that prints");
  expectEqual(pointing.adoptedLogo?.status, "archived", "with the status it now has, rather than hiding it");
  expectEqual(
    pointing.newestLogo?.fileId,
    secondUpload.snapshot.settings.logoFileId,
    "while the newest in storage is the second",
  );
}

/* ---- STEP 118: the sources ---- */

async function checkBrandingSources(): Promise<void> {
  const owned: readonly string[] = [
    "services/invoices/invoice-branding.ts",
    "services/invoices/invoice-pdf-image.ts",
    "app/api/invoices/branding/route.ts",
    "app/api/invoices/branding/logo/route.ts",
    "app/(dashboard)/invoices/branding/page.tsx",
    "app/(dashboard)/invoices/branding/branding-form.tsx",
    "migrations/0116_invoice_branding.sql",
    "migrations/0116_invoice_branding.down.sql",
  ];

  for (const path of owned) {
    const source = await readRepositoryFile(path);
    const comment = path.endsWith(".sql") ? `-- path: ${path}` : `// path: ${path}`;

    expect(source.length > 0, `${path} exists`);
    expect(source.split("\n", 1)[0]?.trim() === comment, `${path} starts with its path comment`);
    expect(
      !/[^\u0009\u000a\u000d\u0020-\u007e]/u.test(source.replaceAll("\ufeff", "")),
      `${path} is ASCII only`,
    );
  }

  // ---- the migration ----
  const migration = await readRepositoryFile("migrations/0116_invoice_branding.sql");
  const rollback = await readRepositoryFile("migrations/0116_invoice_branding.down.sql");

  for (const [fact, description] of [
    ["create table public.invoice_branding", "the table is created"],
    ["company_id uuid not null", "scoped to a merchant"],
    ["unique (company_id)", "and one merchant has one brand"],
    ["unique (id, company_id)", "with the tenant key a scoped write needs"],
    ["logo_file_id uuid", "the logo is a reference to a file row"],
    ["references public.files (id)", "and not a copy of its bytes"],
    ["name_style text not null default 'trading'", "the name style has a default"],
    ["name_style in ('trading', 'legal')", "and two values"],
    ["show_logo boolean not null default true", "a logo prints unless the merchant turns it off"],
    ["show_address boolean not null default true", "an address prints unless they turn it off"],
    ["show_tax_id boolean not null default false", "while a tax id is kept off until asked for"],
    ["show_website boolean not null default false", "and a website with it"],
    ["char_length(tagline) between 1 and 120", "a tagline is bounded by the column"],
    ["char_length(footer_note) between 1 and 300", "and so is a note"],
    ["accent_colour ~ '^#[0-9a-f]{6}$'", "the accent is six lowercase hexadecimal digits"],
    ["version integer not null default 1", "with the version rule 13's optimistic locking needs"],
    ["invoice_branding_set_row_metadata", "the metadata trigger the platform's rows carry"],
    ["invoice_branding_guard_identity", "and the guard that freezes the row's identity"],
    ["enable row level security", "row level security, on by default"],
    ["invoice_branding_default_deny", "with a policy that denies everything"],
    ["using (false)", "so a connection that is not the platform's own sees no row"],
  ] as readonly (readonly [string, string])[]) {
    expect(migration.includes(fact), `0116 ${description}`);
  }

  expect(
    !migration.includes("trading_name") && !migration.includes("address_line1"),
    "0116 copies no identity out of the business profile, because a copy is a second truth that goes stale",
  );
  expect(
    !migration.includes("logo_bytes") && !migration.includes("bytea"),
    "and stores no bytes, which belong to the object store",
  );
  expect(
    migration.includes("create function public.invoice_branding_guard_identity()") &&
      migration.includes("set search_path = ''"),
    "the guard is a function of its own with an empty search path",
  );

  for (const [fact, description] of [
    ["drop policy if exists invoice_branding_default_deny", "the policy is dropped first"],
    ["drop trigger if exists invoice_branding_set_row_metadata", "then the triggers"],
    ["drop trigger if exists invoice_branding_guard_identity", "both of them"],
    ["drop table if exists public.invoice_branding", "then the table"],
    ["drop function if exists public.invoice_branding_guard_identity", "and the function it owned"],
  ] as readonly (readonly [string, string])[]) {
    expect(rollback.includes(fact), `the rollback ${description}`);
  }

  expect(
    rollback.indexOf("drop policy") < rollback.indexOf("drop table"),
    "in the order a rollback has to run, because a policy cannot outlive its table",
  );

  // ---- the routes ----
  const settings = await readRepositoryFile("app/api/invoices/branding/route.ts");
  const logo = await readRepositoryFile("app/api/invoices/branding/logo/route.ts");

  expectEqual(INVOICE_BRANDING_TABLE, "invoice_branding", "the service names the table the migration created");
  expectEqual(
    INVOICE_BRANDING_UPDATED_AUDIT_ACTION,
    "invoice.branding_updated",
    "and the audit action the trail reads",
  );

  const csrf = await readRepositoryFile("lib/security/csrf.ts");

  expect(csrf.includes('"/api/invoices/branding"'), "the settings route is on the CSRF list");
  expect(csrf.includes('"/api/invoices/branding/logo"'), "and so is the upload");

  for (const [path, source] of [
    ["the settings route", settings],
    ["the upload route", logo],
  ] as readonly (readonly [string, string])[]) {
    const post = source.slice(source.indexOf("export const POST"));

    expect(post.length > 0, `${path} answers a POST`);
    expect(post.indexOf("requireCsrfToken") >= 0, `${path} checks the token`);
    expect(
      post.indexOf("requireCsrfToken") < post.indexOf("readRequestActor"),
      `${path} checks it before it reads a session, so a forged request costs a string comparison`,
    );
    expect(post.includes("maximumBodyBytes"), `${path} bounds the body it will read`);
    expect(source.includes('export const dynamic = "force-dynamic"'), `${path} is never cached`);
    expect(source.includes('"cache-control": "no-store"'), `${path} answers with no-store`);
    expect(source.includes("withErrorResponse"), `${path} answers through the platform's error envelope`);
  }

  expect(settings.includes("PAYLOAD_TOO_LARGE"), "the settings route refuses a body it will not read");
  expect(
    logo.includes("UPLOAD_POLICIES.company_logo.maximumBytes"),
    "and the upload route takes its ceiling from the policy rather than restating a number",
  );
  expect(
    logo.includes("request.formData()"),
    "the upload reads multipart, because the bytes are the payload",
  );
  expect(
    logo.includes("file instanceof File"),
    "and refuses a form that carries anything but a file",
  );
  const get = settings.slice(settings.indexOf("export const GET"), settings.indexOf("export const POST"));

  expect(get.length > 0, "the settings route answers a GET");
  expect(!get.includes("requireCsrfToken"), "which asks for no token, because it changes nothing");
  expect(get.includes("readRequestActor"), "and still reads the session, because the company comes from it");

  // ---- the image reader has no dependency of its own ----
  const image = await readRepositoryFile("services/invoices/invoice-pdf-image.ts");
  const imageImports = [...image.matchAll(/^import .* from "(.*)";$/gmu)].map((match) => match[1] ?? "");

  expect(
    imageImports.every(
      (specifier) => specifier.startsWith("node:") || specifier.startsWith("./") || specifier.startsWith("../"),
    ),
    "the image reader imports nothing but the platform and the standard library",
  );
  expect(imageImports.includes("node:zlib"), "inflating a PNG is the standard library's own deflate");
  expect(!image.includes("require("), "and reaches for no module at runtime");

  const branding = await readRepositoryFile("services/invoices/invoice-branding.ts");

  expect(
    branding.includes('formatMessage("invoices.brandingTaxIdLine"'),
    "the one label a document needs is catalog copy, so no English lives in the service",
  );
  expect(
    !branding.includes("from \"./invoice-pdf-document.ts\""),
    "and the branding service does not import the document service, which imports it: one direction only",
  );
  expect(
    branding.includes("&version=eq."),
    "every update is scoped to the version it read",
  );
  expect(
    branding.includes("deleted_at=is.null") && branding.includes("company_id=eq."),
    "and to the live rows of one company",
  );

  // ---- the screen ----
  const form = await readRepositoryFile("app/(dashboard)/invoices/branding/branding-form.tsx");
  const page = await readRepositoryFile("app/(dashboard)/invoices/branding/page.tsx");
  const serviceImports = [...form.matchAll(/import (type )?\{[^}]*\} from "(@\/services\/[^"]*)";/gu)];

  expect(
    form.startsWith('// path: app/(dashboard)/invoices/branding/branding-form.tsx\n"use client";'),
    "the form is a client component",
  );
  expect(
    serviceImports.length > 0 && serviceImports.every((match) => match[1] === "type "),
    "and it imports nothing from a service but types, so no REST client reaches the browser bundle",
  );
  expectEqual(
    [...form.matchAll(/method: "POST"/gu)].length,
    2,
    "two mutations: the settings save and the logo upload",
  );
  expectEqual(
    [...form.matchAll(/csrfHeaders\(\)/gu)].length,
    2,
    "and each of them carries the rotating token",
  );
  expect(
    form.includes("newestLogoId !== adoptedLogoId && newestLogoPrintable"),
    "the button that prints the newest logo is only offered for a file the writer can draw, " +
      "so a merchant is never offered an upload that ends in a refusal",
  );
  expect(form.includes("sm:grid-cols-2"), "the form is one column on a phone and two from sm up");
  expect(form.includes("max-h-full max-w-full object-contain"), "a logo is fitted to its box, never cropped");
  expect(page.includes('export const dynamic = "force-dynamic"'), "the page is read per request");
  expect(page.includes("InvoiceBrandingScreen"), "and renders the screen the invoice screens own");

  // ---- the preview, which is a restatement and not an import
  //
  // A client component cannot call `invoiceBrandingWordsOf`, because that module holds a REST client. So the
  // form restates the assembly for the merchant to look at before they save, and what keeps a restatement
  // honest is that it does not restate the parts most likely to drift: the address arrives already
  // assembled, and the tax id line comes out of the same catalog message the service uses. Only the name
  // choice and the four toggles are local, and each is pinned here against the service's own answer above.
  const preview = form.slice(
    form.indexOf("function previewLinesOf"),
    form.indexOf("export interface BrandingFormProps"),
  );

  expect(preview.length > 0, "the preview is a function of its own, which is what lets this gate hold it");
  expect(
    preview.includes("for (const line of identity.addressLines)"),
    "the address arrives assembled from the server, so the form cannot reassemble it differently",
  );
  expect(
    preview.includes('formatMessage("invoices.brandingTaxIdLine"'),
    "and the tax id line is the catalog's, not a sentence the form spells out",
  );
  expect(
    preview.includes("identity.tradingName ?? identity.legalName ?? identity.companyName"),
    "a trading name falls back to the legal name and then to whatever the company is called, as the service does",
  );
  expect(
    preview.includes("identity.legalName ?? identity.tradingName ?? identity.companyName"),
    "and a legal name falls back the other way round",
  );
  expect(!preview.includes("await"), "the preview builds strings and nothing else, so it cannot fail a render");

  for (const [toggle, fact] of [
    ["state.showAddress", "identity.addressLines"],
    ["state.showContact", "identity.email"],
    ["state.showWebsite", "identity.website"],
    ["state.showTaxId", "brandingTaxIdLine"],
  ] as const) {
    expect(
      preview.indexOf(toggle) < preview.indexOf(fact),
      `${toggle} gates ${fact}, so a fact the merchant switched off is not drawn in the preview either`,
    );
  }

  const screens = await readRepositoryFile("app/(dashboard)/invoices/invoice-screens.tsx");

  expect(screens.includes('href="/invoices/branding"'), "the branding screen is one click from the editor");
  expect(screens.includes("export async function InvoiceBrandingScreen"), "and lives with the other invoice screens");

  // ---- the catalog ----
  for (const key of [
    "invoices.brandingTitle",
    "invoices.brandingDescription",
    "invoices.brandingLogoHeading",
    "invoices.brandingLogoNone",
    "invoices.brandingLogoCurrent",
    "invoices.brandingLogoHidden",
    "invoices.brandingLogoNewer",
    "invoices.brandingLogoUseNewer",
    "invoices.brandingLogoNotPrintable",
    "invoices.brandingLogoQuarantined",
    "invoices.brandingLogoFormatNote",
    "invoices.brandingNameStyle",
    "invoices.brandingNameTrading",
    "invoices.brandingNameLegal",
    "invoices.brandingShowAddress",
    "invoices.brandingShowContact",
    "invoices.brandingShowTaxId",
    "invoices.brandingShowWebsite",
    "invoices.brandingTaglineLabel",
    "invoices.brandingFooterNoteLabel",
    "invoices.brandingAccentLabel",
    "invoices.brandingAccentDefault",
    "invoices.brandingPreviewHeading",
    "invoices.brandingNoProfile",
    "invoices.brandingSave",
    "invoices.brandingSaved",
    "invoices.brandingFailed",
    "invoices.brandingStale",
    "invoices.brandingTooLong",
    "invoices.brandingBadColour",
    "invoices.brandingBack",
    "invoices.brandingLink",
  ]) {
    expect(getMessage(key as Parameters<typeof getMessage>[0]).length > 0, `${key} is catalog copy`);
  }

  // The one message with a parameter is left out of the loop above, because `getMessage` refuses to print a
  // sentence with a hole in it - which is the guard that makes a placeholder impossible to forget.

  expectEqual(
    formatMessage("invoices.brandingTaxIdLine", { taxId: "74-1234567" }),
    "Tax ID: 74-1234567",
    "and the tax id line reads as a label and a value",
  );
  expect(
    !INVOICE_PDF_ACCENT_PATTERN.test("#12345"),
    "the renderer's accent pattern is the column check's, so a value one accepts the other can draw",
  );
  expect(INVOICE_PDF_ACCENT_PATTERN.test("#010203"), "and a colour it stores is a colour it accepts");
  expect(
    invoiceBrandingRowSchema.safeParse({
      id: randomUUID(),
      company_id: COMPANY_A,
      logo_file_id: null,
      show_logo: true,
      name_style: "trading",
      show_address: true,
      show_contact: true,
      show_tax_id: false,
      show_website: false,
      tagline: null,
      footer_note: null,
      accent_colour: "#010203",
      created_at: new Date(NOW).toISOString(),
      updated_at: new Date(NOW).toISOString(),
      version: 1,
    }).success,
    "a row of 0116 is a row the service can read",
  );
  expectEqual(
    invoiceBrandingRowSchema.safeParse({
      id: randomUUID(),
      company_id: COMPANY_A,
      logo_file_id: null,
      show_logo: true,
      name_style: "nickname",
      show_address: true,
      show_contact: true,
      show_tax_id: false,
      show_website: false,
      tagline: null,
      footer_note: null,
      accent_colour: null,
      created_at: new Date(NOW).toISOString(),
      updated_at: new Date(NOW).toISOString(),
      version: 1,
    }).success,
    false,
    "and a name style the migration does not list is refused on the way in",
  );
}

/* ---- the run ---- */

async function run(): Promise<void> {
  checkArithmetic();
  await checkValidation();
  await checkTenancy();
  await checkCompensation();
  await checkAudit();
  await checkSelectors();
  await checkLineEditor();
  await checkLineAudit();
  await checkLineOrder();
  await checkLineSources();
  await checkNumberingPrinting();
  await checkNumberingTake();
  await checkNumberingSettings();
  await checkStatusWorkflow();
  await checkOverdueSweep();
  await checkDiscountEngine();
  await checkDiscountCreate();
  await checkDiscountUpdate();
  await checkPdfRenderer();
  await checkPdfImageDecoder();
  await checkPdfBranding();
  await checkPdfDocument();
  await checkBrandingService();
  await checkSources();
  await checkPdfSources();
  await checkBrandingSources();

  if (failures.length > 0) {
    process.stderr.write(`invoice gate failed with ${String(failures.length)} problem(s):\n`);

    for (const failure of failures) {
      process.stderr.write(`  - ${failure}\n`);
    }

    process.exitCode = 1;

    return;
  }

  process.stdout.write(
    `invoice gate passed: ${String(checks)} checks, 0022/0023/0115/0116, draft, ` +
      `${String(INVOICE_MAXIMUM_LINES)} lines, half-away-from-zero rounding, PDF as a background job, ` +
      `a merchant's own logo and branding on it, the status workflow and the paid lock\n`,
  );
}

await run();
