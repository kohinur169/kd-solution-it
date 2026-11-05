// path: services/estimates/verify.ts
import process from "node:process";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { createInMemoryAuditTrail, type AuditTrail, type InMemoryAuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import type { PlatformRole, RequestActor } from "../../lib/auth/types.ts";
import { AppError, isAppError } from "../../lib/errors/app-error.ts";
import {
  AUDIT_MAXIMUM_PAYLOAD_BYTES,
  AUDIT_MAXIMUM_USER_AGENT_LENGTH,
  auditEntryProblem,
  auditPayloadBytes,
  buildAuditEntry,
} from "../../lib/security/audit.ts";
import { isIpLiteral } from "../../lib/security/host.ts";
import { INVOICE_MAXIMUM_LINES, INVOICE_UNITS } from "../invoices/invoice-fields.ts";
import {
  createEstimate,
  ESTIMATE_ABANDONED_AUDIT_ACTION,
  ESTIMATE_AUDIT_ENTITY,
  ESTIMATE_CREATED_AUDIT_ACTION,
  ESTIMATE_MANAGE_ROLES,
  ESTIMATE_RULES,
  estimateCreateSchema,
  estimateItemRowSchema,
  estimateRowSchema,
  getEstimate,
  type EstimateDependencies,
  type EstimateSnapshot,
} from "./estimates.ts";
import { percentToBasisPoints } from "../invoices/invoice-discount.ts";
import {
  canonicalEstimateDocumentEncoding,
  captureEstimateSignature,
  ESTIMATE_DOCUMENT_HASH_ENCODING,
  ESTIMATE_SIGNATURE_COLUMNS,
  estimateSignatureCaptureSchema,
  estimateSignatureRowSchema,
  estimateSignatureSnapshotOf,
  hashEstimateDocument,
  parseEstimateSignatureCapture,
  readEstimateSignature,
  type EstimateSignatureSnapshot,
} from "./estimate-signature.ts";
import {
  ESTIMATE_DOCUMENT_HASH_LENGTH,
  ESTIMATE_DOCUMENT_HASH_PATTERN,
  ESTIMATE_SIGNATURES_TABLE,
  ESTIMATE_SIGNATURE_AUDIT_ENTITY,
  ESTIMATE_SIGNATURE_DECISIONS,
  ESTIMATE_SIGNATURE_EMAIL_PATTERN,
  ESTIMATE_SIGNATURE_FINGERPRINT_PATTERN,
  ESTIMATE_SIGNATURE_LIMITS,
  ESTIMATE_SIGNATURE_OPEN_STATUSES,
  ESTIMATE_SIGNATURE_RECORDED_AUDIT_ACTION,
  ESTIMATE_SIGNATURE_RULES,
} from "./estimate-signature-fields.ts";
import { priceToMinor } from "../products/price.ts";
import {
  addEstimateLine,
  ESTIMATE_DISCOUNT_UPDATED_AUDIT_ACTION,
  ESTIMATE_LINE_ADDED_AUDIT_ACTION,
  ESTIMATE_LINE_AUDIT_ENTITY,
  ESTIMATE_LINE_MOVED_AUDIT_ACTION,
  ESTIMATE_LINE_REMOVED_AUDIT_ACTION,
  ESTIMATE_LINE_UPDATED_AUDIT_ACTION,
  moveEstimateLine,
  parseEstimateLine,
  removeEstimateLine,
  updateEstimateLine,
  updateEstimateTotals,
  type EstimateLineDependencies,
} from "./estimate-lines.ts";
import {
  ESTIMATE_COLUMNS,
  ESTIMATE_CREATED_STATUS,
  ESTIMATE_CURRENCIES,
  ESTIMATE_EXPIRY_MAXIMUM_DAYS,
  ESTIMATE_ITEMS_TABLE,
  ESTIMATE_ITEM_COLUMNS,
  ESTIMATE_STATUSES,
  ESTIMATE_TABLE,
  ESTIMATE_VOID_REASONS,
  isEstimateStatus,
  isEstimateVoidReason,
} from "./estimate-fields.ts";

/**
 * The gate for section 16's quote: the create form and the line items of STEP 119.
 *
 * ## How this proves anything without a database
 *
 * There is no PostgreSQL in this sandbox, so the fixture below is the database: an in-memory `estimates`
 * and `estimate_items` whose every refusal is transcribed from `0025`, `0026` and `0117` rather than from
 * the module under test. That distinction is the whole method. A fixture written from the service agrees
 * with the service by construction and proves nothing; a fixture written from the migrations disagrees
 * with the service exactly where the service is wrong. So the column checks, the generated line total, the
 * subtotal trigger, the percentage resolution, the draft lock, the catalogue guard, the terminal guard and
 * the metadata trigger are all restated here from the SQL, with the constraint's own name beside each one.
 *
 * Two consequences are worth stating because they look like fixture bugs and are not. A quote's `version`
 * after a create is not one: `estimate_items_sync_totals` is an AFTER ROW trigger whose body performs an
 * UPDATE on the parent, and that UPDATE fires `estimates_set_row_metadata`, so the parent's version moves
 * once per line written and once more for a discount write. And a percentage discount is resolved here with
 * the SQL's own arithmetic - `round(lines_total::numeric * discount_percent_bp / 10000)`, which rounds half
 * away from zero - and not by calling `percentDiscountMinor`, so an assertion that compares the two has an
 * independent side to compare against.
 *
 * ## What this part covers
 *
 * The document and its lines: the vocabulary, a create, a read, the discount bases, every refusal, tenancy,
 * the compensating removal of a quote whose lines could not be written, and the source and migration
 * guarantees that hold the two ends together. Sending a quote, numbering it, the signature that accepts it,
 * declining, expiring and the conversion into an invoice are STEP 120 and STEP 121, and this gate asserts
 * that nothing here can write them: a create produces a draft, and a draft is the only shape `0025` allows
 * to have no number and no issue instant.
 */

/* ---- the harness ---- */

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

/* ---- the actors ---- */

const NOW = Date.parse("2026-11-04T09:00:00.000Z");

const OWNER_ID = "018f2b8a-1111-4c2d-9c3e-000000000001";
const OTHER_OWNER_ID = "018f2b8a-1111-4c2d-9c3e-000000000002";
const OFFICE_ID = "018f2b8a-1111-4c2d-9c3e-000000000003";

const COMPANY_A = "018f2b8a-4444-4c2d-9c3e-000000000001";
const COMPANY_B = "018f2b8a-4444-4c2d-9c3e-000000000002";

const CLIENT_A = "018f2b8a-5555-4c2d-9c3e-000000000001";
const CLIENT_B = "018f2b8a-5555-4c2d-9c3e-000000000002";
/** A client of the same company with nothing but a name, which is most of a new merchant's book. */
const CLIENT_SPARSE = "018f2b8a-5555-4c2d-9c3e-000000000003";

const PRODUCT_A = "018f2b8a-6666-4c2d-9c3e-000000000001";
const SERVICE_A = "018f2b8a-6666-4c2d-9c3e-000000000002";
const PRODUCT_B = "018f2b8a-6666-4c2d-9c3e-000000000003";

/** Fourteen days after the fixture's now, which is a lifetime an offer can actually have. */
const EXPIRES_AT = new Date(NOW + 14 * 86_400_000).toISOString();

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
const desk = actorOf(["support"], null, { userId: OFFICE_ID });

/* ---- an in-memory estimates, estimate_items, estimate_signatures and clients shaped like 0025, 0026, 0027, 0117 and 0019 ---- */

/** A `0019` client row, because the printed snapshot of a quote is read from the book and never from a body. */
function clientRow(input: {
  readonly id: string;
  readonly companyId: string;
  readonly name: string;
  readonly email?: string | null;
  readonly city?: string | null;
  /** A client whose six postal columns are all null, so `addressOf` has nothing to join. */
  readonly noAddress?: boolean;
}): Record<string, unknown> {
  const postal = input.noAddress === true;

  return {
    id: input.id,
    company_id: input.companyId,
    name: input.name,
    company_name: null,
    email: input.email ?? null,
    phone: null,
    address_line1: postal || input.city === undefined ? null : "12 Market Street",
    address_line2: null,
    city: postal ? null : (input.city ?? null),
    region: postal ? null : "TX",
    postal_code: postal ? null : "78701",
    country: postal ? null : "US",
    tax_id: null,
    notes: null,
    created_at: new Date(NOW).toISOString(),
    updated_at: new Date(NOW).toISOString(),
    deleted_at: null,
    version: 1,
  };
}

interface EstimateDb {
  readonly clients: Array<Record<string, unknown>>;
  readonly products: Array<Record<string, unknown>>;
  readonly services: Array<Record<string, unknown>>;
  readonly estimates: Array<Record<string, unknown>>;
  readonly items: Array<Record<string, unknown>>;
  /** The evidence rows `0027` holds: one per decided quote, and never more. */
  readonly signatures: Array<Record<string, unknown>>;
  /** Every read, in order, so a loop of queries is visible as a count and not as a guess. */
  readonly queries: string[];
  /** Every insert, in order, so one insert of N lines is distinguishable from N inserts of one. */
  readonly inserts: Array<{ readonly table: string; readonly rows: readonly Readonly<Record<string, unknown>>[] }>;
  /** Every update, in order, with the query it was scoped by. */
  readonly updates: Array<{ readonly table: string; readonly query: string; readonly values: Record<string, unknown> }>;
  /** Set to make the lines insert fail, which is how the compensating removal is reached. */
  failItems: boolean;
  /** Set to make every update fail, so a compensating action that fails cannot replace the original error. */
  failUpdates: boolean;
  /** Set to make the quote insert hit a uniqueness or foreign key violation, as a racing delete would. */
  conflictInsert: boolean;
  /** Set to make the evidence insert hit its unique index, as two signers deciding one quote at once would. */
  signatureConflict: boolean;
}

function catalogueRow(input: {
  readonly id: string;
  readonly companyId: string;
  readonly name: string;
  readonly unit: string;
  readonly price: string;
  readonly sku: string | null;
  readonly code: string | null;
}): Record<string, unknown> {
  return {
    id: input.id,
    company_id: input.companyId,
    name: input.name,
    sku: input.sku,
    code: input.code,
    description: null,
    unit_price_minor: input.price,
    currency: "USD",
    unit: input.unit,
    created_at: new Date(NOW).toISOString(),
    updated_at: new Date(NOW).toISOString(),
    deleted_at: null,
    version: 1,
  };
}

function createDb(): EstimateDb {
  return {
    clients: [
      clientRow({ id: CLIENT_A, companyId: COMPANY_A, name: "Acme Ltd", email: "billing@acme.example", city: "Austin" }),
      clientRow({ id: CLIENT_B, companyId: COMPANY_B, name: "Other Co" }),
      clientRow({ id: CLIENT_SPARSE, companyId: COMPANY_A, name: "  Solo Trader  ", email: null, noAddress: true }),
    ],
    products: [
      catalogueRow({
        id: PRODUCT_A,
        companyId: COMPANY_A,
        name: "Desk lamp",
        unit: "item",
        price: "425000",
        sku: "LAMP-01",
        code: null,
      }),
      catalogueRow({
        id: PRODUCT_B,
        companyId: COMPANY_B,
        name: "Another merchant's lamp",
        unit: "item",
        price: "425000",
        sku: "LAMP-02",
        code: null,
      }),
    ],
    services: [
      catalogueRow({
        id: SERVICE_A,
        companyId: COMPANY_A,
        name: "Consulting",
        unit: "hour",
        price: "1250000",
        sku: null,
        code: "CONSULT",
      }),
    ],
    estimates: [],
    items: [],
    signatures: [],
    queries: [],
    inserts: [],
    updates: [],
    failItems: false,
    failUpdates: false,
    conflictInsert: false,
    signatureConflict: false,
  };
}

/** The tables this gate models, so a service that touched another would be caught rather than guessed. */
const MODELLED_TABLES = [
  "clients",
  "products",
  "services",
  "estimates",
  "estimate_items",
  "estimate_signatures",
] as const;

function rowsOf(db: EstimateDb, table: string): Array<Record<string, unknown>> {
  switch (table) {
    case "clients":
      return db.clients;
    case "products":
      return db.products;
    case "services":
      return db.services;
    case "estimates":
      return db.estimates;
    case "estimate_items":
      return db.items;
    case "estimate_signatures":
      return db.signatures;
    default:
      throw new Error(`an unmodelled table was touched: ${table}`);
  }
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

/** A column comparison on the wire, where a null and a missing value are the same fact. */
function sameWire(left: unknown, right: unknown): boolean {
  return String(left ?? "") === String(right ?? "");
}

/**
 * `estimate_items.line_total_minor`, as `0026` generates it.
 *
 * `(quantity * unit_price_minor)::bigint - discount_minor`, where the cast rounds half away from zero and
 * the quantity arrives as the decimal text of `numeric(12,3)`. Written from the column definition and not
 * from the service's own arithmetic, so a comparison between the two is a comparison.
 */
function databaseLineTotal(quantity: string, unitPriceMinor: bigint, discountMinor: bigint): bigint {
  const [whole = "0", fraction = ""] = quantity.split(".");
  const thousandths = BigInt(whole) * 1_000n + BigInt(fraction.padEnd(3, "0"));
  const product = thousandths * unitPriceMinor;
  const magnitude = product < 0n ? -product : product;
  const rounded = (magnitude + 500n) / 1_000n;

  return (product < 0n ? -rounded : rounded) - discountMinor;
}

/**
 * `0025`'s column checks and `0117`'s two, on the values a row will hold.
 *
 * Transcribed from the migration's `check` constraints rather than from the service under test, so a
 * service that writes a draft with a number, or a void quote with no reason, or a discount larger than its
 * own subtotal, is refused by the fixture the way PostgreSQL refuses it. Returns the constraint's own name
 * as the message, because a fixture that says "invalid" tells nobody which rule it is standing in for.
 */
function estimateColumnProblem(row: Readonly<Record<string, unknown>>): string | null {
  const status = String(row["status"] ?? "");
  const voidReason = row["void_reason"] ?? null;
  const number = row["number"] ?? null;
  const issuedAt = row["issued_at"] ?? null;
  const acceptedAt = row["accepted_at"] ?? null;
  const voidedAt = row["voided_at"] ?? null;
  const converted = row["converted_invoice_id"] ?? null;
  const subtotal = BigInt(String(row["subtotal_minor"] ?? "0"));
  const discount = BigInt(String(row["discount_minor"] ?? "0"));
  const tax = BigInt(String(row["tax_minor"] ?? "0"));
  const total = BigInt(String(row["total_minor"] ?? "0"));
  const basis = String(row["discount_basis"] ?? "amount");
  const basisPoints = Number(row["discount_percent_bp"] ?? 0);
  const clientName = String(row["client_name"] ?? "");
  const clientEmail = row["client_email"] ?? null;
  const clientAddress = row["client_address"] ?? null;
  const memo = row["memo"] ?? null;
  const expiresAt = Date.parse(String(row["expires_at"] ?? ""));
  const createdAt = Date.parse(String(row["created_at"] ?? ""));
  const deletedAt = row["deleted_at"] ?? null;

  if (!(ESTIMATE_STATUSES as readonly string[]).includes(status)) {
    return "estimates_status_check";
  }

  if (voidReason !== null && !(ESTIMATE_VOID_REASONS as readonly string[]).includes(String(voidReason))) {
    return "estimates_void_reason_check";
  }

  if ((status === "void") !== (voidReason !== null)) {
    return "estimates_void_pair_check";
  }

  if (
    number !== null &&
    (String(number).length < 3 ||
      String(number).length > 40 ||
      !/^[A-Z0-9][A-Z0-9._/-]{2,39}$/u.test(String(number)))
  ) {
    return "estimates_number_check";
  }

  if (!/^[A-Z]{3}$/u.test(String(row["currency"] ?? ""))) {
    return "estimates_currency_check";
  }

  if (subtotal < 0n) {
    return "estimates_subtotal_check";
  }

  if (discount < 0n || discount > subtotal) {
    return "estimates_discount_check";
  }

  if (tax < 0n) {
    return "estimates_tax_check";
  }

  if (total !== subtotal - discount + tax || total < 0n) {
    return "estimates_total_check";
  }

  // `estimates_issue_check`: a draft has no number and no issue instant, an issued quote has both, and a
  // void quote is either - because a quote can be withdrawn before it was ever sent.
  if (status === "draft" && (number !== null || issuedAt !== null)) {
    return "estimates_issue_check";
  }

  if ((status === "sent" || status === "viewed" || status === "accepted") && (number === null || issuedAt === null)) {
    return "estimates_issue_check";
  }

  if ((status === "accepted") !== (acceptedAt !== null)) {
    return "estimates_accepted_instant_check";
  }

  if ((status === "void") !== (voidedAt !== null)) {
    return "estimates_voided_instant_check";
  }

  if (issuedAt !== null && !(expiresAt > Date.parse(String(issuedAt)))) {
    return "estimates_expiry_check";
  }

  if (converted !== null && status !== "accepted") {
    return "estimates_conversion_check";
  }

  if (clientName.length < 1 || clientName.length > 160 || clientName !== clientName.trim()) {
    return "estimates_client_name_check";
  }

  if (
    clientEmail !== null &&
    (String(clientEmail).length < 3 ||
      String(clientEmail).length > 254 ||
      String(clientEmail) !== String(clientEmail).trim() ||
      !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+[.][A-Za-z]{2,}$/u.test(String(clientEmail)))
  ) {
    return "estimates_client_email_check";
  }

  if (
    clientAddress !== null &&
    (String(clientAddress).length < 1 ||
      String(clientAddress).length > 600 ||
      String(clientAddress) !== String(clientAddress).trim())
  ) {
    return "estimates_client_address_check";
  }

  if (memo !== null && (String(memo).length < 1 || String(memo).length > 2_000 || String(memo) !== String(memo).trim())) {
    return "estimates_memo_check";
  }

  if (Number(row["version"] ?? 0) < 1) {
    return "estimates_version_positive_check";
  }

  if (deletedAt !== null && Date.parse(String(deletedAt)) < createdAt) {
    return "estimates_deleted_after_creation_check";
  }

  // `0117`: the basis is one of two words, the percentage is at most the whole quote, and the two columns
  // have to agree or a reader cannot tell which of them to trust.
  if (basis !== "amount" && basis !== "percent") {
    return "estimates_discount_basis_check";
  }

  if (basisPoints < 0 || basisPoints > 10_000) {
    return "estimates_discount_percent_check";
  }

  if (!((basis === "percent" && basisPoints > 0) || (basis === "amount" && basisPoints === 0))) {
    return "estimates_discount_basis_coherent_check";
  }

  return null;
}

/**
 * `estimate_items_sync_totals` of `0026` as `0117` replaced it, and `estimates_derive_total` after it.
 *
 * The function does three things in the database and all three are modelled here, because the service
 * relies on each and sends none of them: it refuses a line change on a quote that has left `draft`, it sums
 * the live lines into the parent's subtotal, and it resolves a percentage discount against the subtotal it
 * is writing. Then the parent's own trigger derives the total from the two values this statement has just
 * made agree.
 *
 * The percentage is computed as the SQL computes it - `round(lines_total::numeric * bp / 10000)`, which
 * rounds half away from zero - and not by calling the module under test, so the assertion that compares
 * this number with the service's has an independent side.
 */
function syncEstimateTotals(db: EstimateDb, estimateId: string): void {
  const parent = db.estimates.find((row) => row["id"] === estimateId);

  if (parent === undefined) {
    return;
  }

  // The draft lock, as the trigger states it: a quote a client is deciding on must not move under them.
  if (parent["status"] !== ESTIMATE_CREATED_STATUS) {
    throw new AppError("CONFLICT", { cause: { rule: "estimate", reason: "lines_locked" } });
  }

  const subtotal = db.items
    .filter((row) => row["estimate_id"] === estimateId && row["deleted_at"] === null)
    .reduce((total, row) => total + BigInt(String(row["line_total_minor"])), 0n);

  const storedDiscount = BigInt(String(parent["discount_minor"] ?? "0"));
  const tax = BigInt(String(parent["tax_minor"] ?? "0"));
  const discount =
    String(parent["discount_basis"] ?? "amount") === "percent"
      ? (subtotal * BigInt(Number(parent["discount_percent_bp"] ?? 0)) + 5_000n) / 10_000n
      : storedDiscount;

  // `estimates_discount_check` and `estimates_total_check` run against the values this statement writes,
  // and the discount one is the one a line change can break: a stored flat discount larger than what the
  // remaining lines add up to. It raises as `check_violation`, which the REST layer reports as
  // VALIDATION_FAILED.
  if (discount > subtotal || tax < 0n || subtotal - discount + tax < 0n) {
    throw new AppError("VALIDATION_FAILED", { cause: { rule: "estimate", reason: "check_violation" } });
  }

  parent["subtotal_minor"] = subtotal.toString();
  parent["discount_minor"] = discount.toString();
  // `estimates_derive_total`, which `0025` borrows from `0022` so the identity is defined once.
  parent["total_minor"] = (subtotal - discount + tax).toString();

  // The trigger's UPDATE on the parent is an update like any other, so `estimates_set_row_metadata` moves
  // `updated_at` and `version` with it. This is why a created quote's version is one per line written and
  // not one: a fact STEP 120 needs, because a version-scoped write on a quote has to expect it.
  parent["updated_at"] = new Date(NOW).toISOString();
  parent["version"] = Number(parent["version"]) + 1;
}

/** `0026`'s checks on one line, plus the generated column it declares. */
function estimateItemProblem(
  db: EstimateDb,
  row: Readonly<Record<string, unknown>>,
  liveRows: readonly Readonly<Record<string, unknown>>[],
): string | null {
  const position = Number(row["position"] ?? 0);
  const description = String(row["description"] ?? "");
  const unit = String(row["unit"] ?? "");
  const quantityText = String(row["quantity"] ?? "");
  const unitPrice = BigInt(String(row["unit_price_minor"] ?? "0"));
  const discount = BigInt(String(row["discount_minor"] ?? "0"));

  if (position < 1) {
    return "estimate_items_position_check";
  }

  if (
    liveRows.some(
      (candidate) => candidate["estimate_id"] === row["estimate_id"] && Number(candidate["position"]) === position,
    )
  ) {
    return "estimate_items_position_key";
  }

  if (description.length < 1 || description.length > 300 || description !== description.trim()) {
    return "estimate_items_description_check";
  }

  if (!(INVOICE_UNITS as readonly string[]).includes(unit)) {
    return "estimate_items_unit_check";
  }

  const [whole = "", fraction = ""] = quantityText.split(".");

  if (!/^\d{1,7}([.]\d{1,3})?$/u.test(quantityText)) {
    return "estimate_items_quantity_check";
  }

  const thousandths = BigInt(whole) * 1_000n + BigInt(fraction.padEnd(3, "0"));

  if (thousandths <= 0n || thousandths > 1_000_000_000n) {
    return "estimate_items_quantity_check";
  }

  if (unitPrice < 0n) {
    return "estimate_items_unit_price_check";
  }

  const gross = databaseLineTotal(quantityText, unitPrice, 0n);

  if (discount < 0n || discount > gross) {
    return "estimate_items_discount_check";
  }

  const references = [row["product_id"], row["service_id"]].filter((value) => value !== null && value !== undefined);

  if (references.length > 1) {
    return "estimate_items_source_check";
  }

  // `estimate_items_guard_catalogue`: a product or a service of another merchant cannot be quoted.
  for (const column of ["product_id", "service_id"] as const) {
    const reference = row[column];

    if (typeof reference === "string") {
      const catalogue = column === "product_id" ? db.products : db.services;
      const found = catalogue.some(
        (entry) => entry["id"] === reference && entry["company_id"] === row["company_id"],
      );

      if (!found) {
        return "estimate_items_guard_catalogue";
      }
    }
  }

  return null;
}

/**
 * `0027`'s column checks on the values an evidence row will hold.
 *
 * Transcribed from the migration's `check` constraints rather than from the service under test, and through
 * the limits the vocabulary module states, because `checkSignature` proves those limits against the
 * migration's own text: one number, one spelling, proved once. Returns the constraint's own name as the
 * message, because a fixture that says "invalid" tells nobody which rule it is standing in for.
 */
function estimateSignatureProblem(
  row: Readonly<Record<string, unknown>>,
  db: EstimateDb,
): string | null {
  const text = (column: string): string | null => {
    const value = row[column];

    return typeof value === "string" ? value : null;
  };

  // `estimate_signatures_estimate_fkey` is composite, so a row naming a quote and a merchant that do not
  // belong together has no parent to point at - which is what tenant isolation looks like from here.
  const parent = rowsOf(db, ESTIMATE_TABLE).find(
    (quote) =>
      quote["id"] === row["estimate_id"] &&
      quote["company_id"] === row["company_id"] &&
      quote["deleted_at"] === null,
  );

  if (parent === undefined) {
    return "estimate_signatures_estimate_fkey";
  }

  const decision = text("decision");

  if (decision === null || !(ESTIMATE_SIGNATURE_DECISIONS as readonly string[]).includes(decision)) {
    return "estimate_signatures_decision_check";
  }

  const signerName = text("signer_name");

  if (
    signerName === null ||
    signerName.length < ESTIMATE_SIGNATURE_LIMITS.signerName.min ||
    signerName.length > ESTIMATE_SIGNATURE_LIMITS.signerName.max ||
    signerName !== signerName.trim()
  ) {
    return "estimate_signatures_signer_name_check";
  }

  const signerEmail = text("signer_email");

  if (
    signerEmail === null ||
    signerEmail.length < ESTIMATE_SIGNATURE_LIMITS.signerEmail.min ||
    signerEmail.length > ESTIMATE_SIGNATURE_LIMITS.signerEmail.max ||
    !ESTIMATE_SIGNATURE_EMAIL_PATTERN.test(signerEmail)
  ) {
    return "estimate_signatures_signer_email_check";
  }

  const consentText = text("consent_text");

  if (
    consentText === null ||
    consentText.length < ESTIMATE_SIGNATURE_LIMITS.consentText.min ||
    consentText.length > ESTIMATE_SIGNATURE_LIMITS.consentText.max ||
    consentText !== consentText.trim()
  ) {
    return "estimate_signatures_consent_text_check";
  }

  if (row["consent_accepted"] !== true) {
    return "estimate_signatures_consent_check";
  }

  const signedAt = text("signed_at");

  if (signedAt === null || Number.isNaN(Date.parse(signedAt))) {
    // `signed_at timestamptz not null` carries no constraint name of its own, so the refusal is named
    // after the column: the element of section 16 it stands in for is the time of the decision.
    return "estimate_signatures_signed_at_not_null";
  }

  const ip = text("ip");

  if (ip === null || !isIpLiteral(ip)) {
    // `ip inet not null`, again a column rather than a named constraint, tested with the platform's own
    // predicate rather than with a pattern of this gate's.
    return "estimate_signatures_ip_not_null";
  }

  const geoLocation = text("geo_location");

  if (
    geoLocation !== null &&
    (geoLocation.length < ESTIMATE_SIGNATURE_LIMITS.geoLocation.min ||
      geoLocation.length > ESTIMATE_SIGNATURE_LIMITS.geoLocation.max ||
      geoLocation !== geoLocation.trim())
  ) {
    return "estimate_signatures_geo_check";
  }

  const fingerprint = text("device_fingerprint");

  if (
    fingerprint !== null &&
    (fingerprint.length < ESTIMATE_SIGNATURE_LIMITS.deviceFingerprint.min ||
      fingerprint.length > ESTIMATE_SIGNATURE_LIMITS.deviceFingerprint.max ||
      !ESTIMATE_SIGNATURE_FINGERPRINT_PATTERN.test(fingerprint))
  ) {
    return "estimate_signatures_fingerprint_check";
  }

  const documentHash = text("document_hash");

  if (documentHash === null || !ESTIMATE_DOCUMENT_HASH_PATTERN.test(documentHash)) {
    return "estimate_signatures_hash_check";
  }

  const signaturePath = text("signature_path");

  if (
    signaturePath !== null &&
    (signaturePath.length < ESTIMATE_SIGNATURE_LIMITS.signaturePath.min ||
      signaturePath.length > ESTIMATE_SIGNATURE_LIMITS.signaturePath.max ||
      signaturePath !== signaturePath.trim())
  ) {
    return "estimate_signatures_path_check";
  }

  if (Number(row["version"] ?? 0) <= 0) {
    return "estimate_signatures_version_positive_check";
  }

  return null;
}

/**
 * The body of one decision, as a signing page would send it.
 *
 * Every value inside its column's limits and every one of them a value a signer could have given: an
 * address out of the documentation range, a fingerprint of the printable shape the column admits, and a
 * consent sentence that says what it is consenting to.
 */
function signatureBodyOf(
  estimateId: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    estimate_id: estimateId,
    company_id: COMPANY_A,
    decision: "accepted",
    signer_name: "Rina Akter",
    signer_email: "rina@buyer.example",
    consent_text: "I have read this quote and I accept its terms.",
    consent_accepted: true,
    ip_address: "203.0.113.44",
    geo_location: "Dhaka, BD",
    device_fingerprint: "fp-9f2c41ab7d05",
    signature_path: null,
    user_agent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
    ...overrides,
  };
}

/** An issued quote with three lines, which is the only state that accepts a signature. */
async function openQuoteWith(
  overrides: Readonly<Record<string, unknown>> = {},
): Promise<{ readonly db: EstimateDb; readonly snapshot: EstimateSnapshot }> {
  const quote = await draftWith({ lines: threeLines(), ...overrides });

  issue(quote.db, quote.snapshot.id);

  return quote;
}

/**
 * Write line rows the way `0026` does, for both insert shapes.
 *
 * The order is the database's: the guards on the row first, then the generated column, then the row becomes
 * visible, then the AFTER ROW trigger updates the parent. A failure at any step throws, and the caller turns
 * it into a rejected promise - which is what makes a half-written statement impossible to model as a success.
 */
function writeLineRows(
  db: EstimateDb,
  rows: readonly Readonly<Record<string, unknown>>[],
): Array<Record<string, unknown>> {
  const first = at(rows, 0, "a line row");
  const estimateId = String(first["estimate_id"] ?? "");
  const parent = db.estimates.find((row) => row["id"] === estimateId);

  // `estimate_items_estimate_fkey` references `(id, company_id)`, so a line of another merchant's quote has
  // no parent to point at.
  if (parent === undefined || parent["company_id"] !== first["company_id"]) {
    throw new AppError("VALIDATION_FAILED");
  }

  const created: Array<Record<string, unknown>> = [];

  for (const row of rows) {
    const candidate: Record<string, unknown> = {
      id: randomUUID(),
      created_at: new Date(NOW).toISOString(),
      updated_at: new Date(NOW).toISOString(),
      deleted_at: null,
      version: 1,
      ...wireOf(row),
    };

    const live = db.items.filter(
      (existing) => existing["estimate_id"] === estimateId && existing["deleted_at"] === null,
    );
    const problem = estimateItemProblem(db, candidate, live);

    if (problem !== null) {
      throw new AppError("VALIDATION_FAILED", { cause: { rule: "estimate", reason: problem } });
    }

    candidate["line_total_minor"] = databaseLineTotal(
      String(candidate["quantity"]),
      BigInt(String(candidate["unit_price_minor"])),
      BigInt(String(candidate["discount_minor"] ?? "0")),
    ).toString();

    db.items.push(candidate);
    created.push(candidate);

    // The AFTER ROW trigger fires once per row, so the parent moves once per line and not once per
    // statement - which is where the parent's version count comes from.
    syncEstimateTotals(db, estimateId);
  }

  return created;
}

function createEstimateRest(db: EstimateDb): RestClient {
  return {
    select<TRow>(table: string, query: string, schema: z.ZodType<TRow>): Promise<readonly TRow[]> {
      db.queries.push(`${table}?${query}`);

      if (!(MODELLED_TABLES as readonly string[]).includes(table)) {
        return Promise.reject(new Error(`an unmodelled table was read: ${table}`));
      }

      const parts = queryParts(query);
      const company = parts.get("company_id");

      // Every table here is scoped by company_id, and a read that omits it is a bug the fixture refuses
      // rather than quietly answering with another merchant's rows.
      if (company === undefined || !company.startsWith("eq.")) {
        return Promise.reject(new Error(`a read is not scoped to one company: ${query}`));
      }

      const companyId = company.slice(3);
      let matched = rowsOf(db, table).filter((row) => row["company_id"] === companyId);

      for (const [key, value] of parts) {
        if (key === "select" || key === "order" || key === "limit" || key === "offset") {
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
          const a = Number(left[column] ?? 0);
          const b = Number(right[column] ?? 0);
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

      return Promise.resolve(projected.map((row) => schema.parse(wireOf(row))));
    },

    insert(table: string, rows: readonly Readonly<Record<string, unknown>>[]): Promise<void> {
      db.inserts.push({ table, rows });

      if (table !== ESTIMATE_ITEMS_TABLE) {
        return Promise.reject(new Error(`this service inserts lines by themselves: ${table}`));
      }

      if (db.failItems) {
        // `estimate_items_guard_catalogue` raises a check_violation, which the REST layer reports as
        // VALIDATION_FAILED. The fixture does the same rather than inventing a different code.
        return Promise.reject(new AppError("VALIDATION_FAILED"));
      }

      try {
        writeLineRows(db, rows);
      } catch (error) {
        return Promise.reject(error);
      }

      return Promise.resolve();
    },

    insertReturning<TRow>(
      table: string,
      rows: readonly Readonly<Record<string, unknown>>[],
      schema: z.ZodType<TRow>,
    ): Promise<readonly TRow[]> {
      db.inserts.push({ table, rows });

      if (table === ESTIMATE_ITEMS_TABLE) {
        if (db.failItems) {
          return Promise.reject(new AppError("VALIDATION_FAILED"));
        }

        try {
          return Promise.resolve(writeLineRows(db, rows).map((row) => schema.parse(wireOf(row))));
        } catch (error) {
          return Promise.reject(error);
        }
      }

      if (table === ESTIMATE_SIGNATURES_TABLE) {
        if (db.signatureConflict) {
          // `23505` on `estimate_signatures_estimate_id_key`. PostgREST answers a unique violation with a
          // conflict, which is the one failure of this insert the REST layer reports as one.
          return Promise.reject(
            new AppError("CONFLICT", { cause: { rule: "estimate_signature", reason: "unique_violation" } }),
          );
        }

        const evidence: TRow[] = [];

        for (const row of rows) {
          const candidate: Record<string, unknown> = {
            id: randomUUID(),
            signed_at: new Date(NOW).toISOString(),
            geo_location: null,
            device_fingerprint: null,
            signature_path: null,
            created_at: new Date(NOW).toISOString(),
            updated_at: new Date(NOW).toISOString(),
            deleted_at: null,
            version: 1,
            ...wireOf(row),
          };

          // `estimate_signatures_guard_decision` is a BEFORE INSERT trigger, and it reads the quote rather
          // than the row, so the fixture has to read it too. A trigger's `raise exception` reaches the REST
          // layer as `check_violation`, which is class 23 and therefore a validation failure, not a conflict.
          const quote = rowsOf(db, ESTIMATE_TABLE).find(
            (row_) => row_["id"] === candidate["estimate_id"] && row_["company_id"] === candidate["company_id"],
          );
          const state = quote === undefined ? "" : String(quote["status"] ?? "");

          if (!(ESTIMATE_SIGNATURE_OPEN_STATUSES as readonly string[]).includes(state)) {
            return Promise.reject(
              new AppError("VALIDATION_FAILED", {
                cause: { rule: "estimate_signature", reason: "estimate_signatures_guard_decision" },
              }),
            );
          }

          const problem = estimateSignatureProblem(candidate, db);

          if (problem !== null) {
            return Promise.reject(
              new AppError("VALIDATION_FAILED", { cause: { rule: "estimate_signature", reason: problem } }),
            );
          }

          rowsOf(db, ESTIMATE_SIGNATURES_TABLE).push(candidate);
          evidence.push(schema.parse(wireOf(candidate)));
        }

        return Promise.resolve(evidence);
      }

      if (table !== ESTIMATE_TABLE) {
        return Promise.reject(new Error(`this service returns rows of three tables and nothing else: ${table}`));
      }

      if (db.conflictInsert) {
        // `23505` on `estimates_number_key`, or `23503` on the client foreign key when a client is deleted
        // between the read of the book and the write of the quote. Both arrive as a conflict.
        return Promise.reject(new AppError("CONFLICT", { cause: { rule: "estimate", reason: "unique_violation" } }));
      }

      const created: TRow[] = [];

      for (const row of rows) {
        const candidate: Record<string, unknown> = {
          id: randomUUID(),
          number: null,
          void_reason: null,
          subtotal_minor: "0",
          discount_minor: "0",
          discount_basis: "amount",
          discount_percent_bp: 0,
          total_minor: "0",
          issued_at: null,
          accepted_at: null,
          voided_at: null,
          converted_invoice_id: null,
          created_at: new Date(NOW).toISOString(),
          updated_at: new Date(NOW).toISOString(),
          deleted_at: null,
          version: 1,
          ...wireOf(row),
        };

        // `estimates_derive_total` is a BEFORE INSERT trigger, so the total a caller sends is overwritten
        // by the identity rather than trusted: a service that computed its own total cannot store it.
        candidate["total_minor"] = (
          BigInt(String(candidate["subtotal_minor"])) -
          BigInt(String(candidate["discount_minor"])) +
          BigInt(String(candidate["tax_minor"]))
        ).toString();

        const problem = estimateColumnProblem(candidate);

        if (problem !== null) {
          return Promise.reject(new AppError("VALIDATION_FAILED", { cause: { rule: "estimate", reason: problem } }));
        }

        db.estimates.push(candidate);
        created.push(schema.parse(wireOf(candidate)));
      }

      return Promise.resolve(created);
    },

    update(table: string, query: string, values: Readonly<Record<string, unknown>>): Promise<void> {
      db.updates.push({ table, query, values: { ...values } });

      if (db.failUpdates) {
        return Promise.reject(new Error("the fixture was told to refuse every update"));
      }

      if (table === ESTIMATE_ITEMS_TABLE) {
        const parts = queryParts(query);
        const id = parts.get("id");
        const company = parts.get("company_id");
        const estimate = parts.get("estimate_id");

        if (id === undefined || company === undefined) {
          return Promise.reject(new Error(`a line update is not scoped to one row of one company: ${query}`));
        }

        const row = db.items.find(
          (candidate) =>
            candidate["id"] === id.slice(3) &&
            candidate["company_id"] === company.slice(3) &&
            candidate["deleted_at"] === null &&
            (estimate === undefined || candidate["estimate_id"] === estimate.slice(3)),
        );

        // A PostgREST update that matched nothing still reports success, which is why the service re-reads.
        if (row === undefined) {
          return Promise.resolve();
        }

        // `estimate_items_guard_catalogue` refuses a line that is moved to another quote, because the line's
        // parent is part of what a signature would cover.
        if (values["estimate_id"] !== undefined && !sameWire(row["estimate_id"], values["estimate_id"])) {
          return Promise.reject(
            new AppError("VALIDATION_FAILED", {
              cause: { rule: "estimate", reason: "estimate_items_guard_catalogue" },
            }),
          );
        }

        const merged: Record<string, unknown> = { ...row, ...wireOf(values) };
        const others = db.items.filter(
          (candidate) =>
            candidate["estimate_id"] === row["estimate_id"] &&
            candidate["deleted_at"] === null &&
            candidate["id"] !== row["id"],
        );
        const problem = estimateItemProblem(db, merged, others);

        if (problem !== null) {
          return Promise.reject(
            new AppError("VALIDATION_FAILED", { cause: { rule: "estimate", reason: problem } }),
          );
        }

        // The generated column follows its three inputs, and `estimate_items_set_row_metadata` moves the
        // clock and the version. Both happen before the AFTER ROW trigger reads the row.
        merged["line_total_minor"] = databaseLineTotal(
          String(merged["quantity"]),
          BigInt(String(merged["unit_price_minor"])),
          BigInt(String(merged["discount_minor"] ?? "0")),
        ).toString();
        merged["updated_at"] = new Date(NOW).toISOString();
        merged["version"] = Number(row["version"]) + 1;

        for (const [column, value] of Object.entries(merged)) {
          row[column] = value;
        }

        try {
          syncEstimateTotals(db, String(row["estimate_id"]));
        } catch (error) {
          return Promise.reject(error);
        }

        return Promise.resolve();
      }

      if (table !== ESTIMATE_TABLE) {
        return Promise.reject(new Error(`an unmodelled table was written: ${table}`));
      }

      const parts = queryParts(query);
      const id = parts.get("id");
      const company = parts.get("company_id");
      const status = parts.get("status");

      if (id === undefined || company === undefined) {
        return Promise.reject(new Error(`an update is not scoped to one row of one company: ${query}`));
      }

      const row = db.estimates.find(
        (candidate) =>
          candidate["id"] === id.slice(3) &&
          candidate["company_id"] === company.slice(3) &&
          (status === undefined || candidate["status"] === status.slice(3)),
      );

      // A PostgREST update that matched nothing still reports success, which is why the service re-reads.
      if (row === undefined) {
        return Promise.resolve();
      }

      // `estimates_guard_terminal`: a decided quote is frozen apart from the metadata columns.
      const decided = row["status"] === "accepted" || row["status"] === "void";
      const merged: Record<string, unknown> = { ...row, ...wireOf(values) };
      const moved = Object.keys(values).some((column) => !sameWire(row[column], values[column]));

      if (decided && moved) {
        return Promise.reject(
          new AppError("VALIDATION_FAILED", { cause: { rule: "estimate", reason: "estimates_guard_terminal" } }),
        );
      }

      // Both remaining triggers are BEFORE UPDATE, so they run before PostgreSQL evaluates the column
      // checks against the row: `estimates_derive_total` overwrites a total a caller computed, and
      // `estimates_set_row_metadata` moves the clock and the version. Checking first and deriving second
      // would test a row the database never stores.
      merged["total_minor"] = (
        BigInt(String(merged["subtotal_minor"])) -
        BigInt(String(merged["discount_minor"])) +
        BigInt(String(merged["tax_minor"]))
      ).toString();
      merged["updated_at"] = new Date(NOW).toISOString();
      merged["version"] = Number(row["version"]) + 1;

      const problem = estimateColumnProblem(merged);

      if (problem !== null) {
        return Promise.reject(new AppError("VALIDATION_FAILED", { cause: { rule: "estimate", reason: problem } }));
      }

      for (const [column, value] of Object.entries(merged)) {
        row[column] = value;
      }

      return Promise.resolve();
    },

    rpc(functionName: string): Promise<unknown> {
      return Promise.reject(new Error(`this service calls no stored function: ${functionName}`));
    },
  };
}

/* ---- the helpers a check runs through ---- */

function depsOf(db: EstimateDb = createDb(), audit: AuditTrail = createInMemoryAuditTrail()): EstimateDependencies {
  return { rest: createEstimateRest(db), audit, now: () => NOW };
}

/** One line of a create body, as a form sends it: every field text, nothing judged by its shape. */
function lineOf(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    description: "Site redesign",
    unit: "project",
    quantity: "2.5",
    unit_price: "125.00",
    discount: "",
    product_id: "",
    service_id: "",
    ...overrides,
  };
}

/**
 * A create body, as a form sends it.
 *
 * The two default lines are 2.5 hours of a 125.00 project and one 99.00 month less a 5.00 line discount,
 * so the subtotal is 312.50 + 94.00 = 406.50 and every amount below is one a reader can check by hand.
 */
function bodyOf(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    client_id: CLIENT_A,
    expires_at: EXPIRES_AT,
    memo: "Valid for fourteen days.",
    tax: "35.57",
    lines: [
      lineOf(),
      lineOf({ description: "Hosting", unit: "month", quantity: "1", unit_price: "99.00", discount: "5.00" }),
    ],
    ...overrides,
  };
}

/** A major-unit amount as exact minor units, for the fixed amounts this gate writes. */
function minorOf(amount: string): bigint {
  const value = priceToMinor(amount);

  if (value === null) {
    throw new Error(`gate fixture: ${amount} is not a money amount`);
  }

  return value;
}

function lineDepsOf(db: EstimateDb, audit: InMemoryAuditTrail = createInMemoryAuditTrail()): EstimateLineDependencies {
  return { rest: createEstimateRest(db), audit, now: () => NOW };
}

/** One stored quote row, by id. */
function rowOf(db: EstimateDb, estimateId: string): Record<string, unknown> {
  const row = db.estimates.find((candidate) => candidate["id"] === estimateId);

  if (row === undefined) {
    throw new Error(`gate fixture: no quote ${estimateId}`);
  }

  return row;
}

/**
 * Three lines whose arithmetic a reader can check by hand.
 *
 * 2.5 of 125.00 is 312.50, one month of 99.00 less a 5.00 line discount is 94.00, and 4 of 75.00 is 300.00,
 * so the subtotal is 706.50 and the tax of 35.57 makes the total 742.07.
 */
function threeLines(): readonly Record<string, unknown>[] {
  return [
    lineOf(),
    lineOf({ description: "Hosting", unit: "month", quantity: "1", unit_price: "99.00", discount: "5.00" }),
    lineOf({ description: "Training", unit: "hour", quantity: "4", unit_price: "75.00" }),
  ];
}

/** A draft quote with three lines, and the two in-memory doubles it was written through. */
async function draftWith(
  overrides: Readonly<Record<string, unknown>> = {},
): Promise<{ readonly db: EstimateDb; readonly snapshot: EstimateSnapshot }> {
  const db = createDb();
  const snapshot = await createEstimate(
    { actor: owner, body: bodyOf({ lines: threeLines(), ...overrides }) },
    depsOf(db),
  );

  return { db, snapshot };
}

/** A quote that has been issued, which is the state every line operation has to refuse. */
function issue(db: EstimateDb, estimateId: string): void {
  const row = rowOf(db, estimateId);

  row["status"] = "sent";
  row["number"] = "Q-2026-0001";
  row["issued_at"] = new Date(NOW).toISOString();
}

/** The code a refusal carries, or null when the call succeeded. */
async function codeOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();

    return null;
  } catch (error) {
    return isAppError(error) ? error.code : "not_an_app_error";
  }
}

/** The details a refusal carries, whatever its code, because a quote's refusals are not all validation. */
async function refusalOf(run: () => Promise<unknown>): Promise<readonly { field?: string; rule?: string }[]> {
  try {
    await run();

    return [];
  } catch (error) {
    return isAppError(error) ? error.details : [];
  }
}

/** The reason inside a refusal's cause, which is where a constraint name travels. */
async function refusalReason(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();

    return null;
  } catch (error) {
    if (!isAppError(error)) {
      return "not_an_app_error";
    }

    const cause = error.cause as { readonly reason?: unknown } | undefined;

    return typeof cause?.reason === "string" ? cause.reason : null;
  }
}

async function created(
  overrides: Readonly<Record<string, unknown>> = {},
  db: EstimateDb = createDb(),
  audit: InMemoryAuditTrail = createInMemoryAuditTrail(),
): Promise<{
  readonly db: EstimateDb;
  readonly audit: InMemoryAuditTrail;
  readonly snapshot: EstimateSnapshot;
}> {
  const trail = audit;
  const snapshot = await createEstimate({ actor: owner, body: bodyOf(overrides) }, depsOf(db, trail));

  return { db, audit: trail, snapshot };
}

/* ---- the vocabulary ---- */

async function checkVocabulary(): Promise<void> {
  const migration = await readRepositoryFile("migrations/0025_estimates.sql");
  const items = await readRepositoryFile("migrations/0026_estimate_items.sql");
  const basis = await readRepositoryFile("migrations/0117_estimate_discount_basis.sql");

  expectDeepEqual(
    [...ESTIMATE_STATUSES],
    ["draft", "sent", "viewed", "accepted", "void"],
    "a quote has five statuses, because nothing is paid on a quote",
  );
  expect(
    migration.includes("status in ('draft', 'sent', 'viewed', 'accepted', 'void')"),
    "and they are the five `estimates_status_check` allows, word for word",
  );
  expectDeepEqual(
    [...ESTIMATE_VOID_REASONS],
    ["declined", "expired", "withdrawn"],
    "the three ways a quote ends, which section 16 reports as one status",
  );
  expect(
    migration.includes("void_reason in ('declined', 'expired', 'withdrawn')"),
    "and they are the three `estimates_void_reason_check` allows",
  );
  expectEqual(ESTIMATE_CREATED_STATUS, "draft", "a create writes a draft and no other shape");
  expect(
    (ESTIMATE_STATUSES as readonly string[]).includes(ESTIMATE_CREATED_STATUS),
    "which is one of the five, so a create cannot invent a status",
  );
  expectDeepEqual([...ESTIMATE_CURRENCIES], ["USD"], "rule 2 and section 16: a quote is in dollars");
  expectEqual(
    ESTIMATE_EXPIRY_MAXIMUM_DAYS,
    365,
    "an expiry at most a year out, which is a business limit and not a column's",
  );
  expect(ESTIMATE_EXPIRY_MAXIMUM_DAYS > 0, "and a positive one, so the bound it makes is a bound");
  expectEqual(ESTIMATE_TABLE, "estimates", "the table is `0025`'s");
  expectEqual(ESTIMATE_ITEMS_TABLE, "estimate_items", "and the lines are `0026`'s");

  expectEqual(isEstimateStatus("accepted"), true, "the guard accepts a status of the vocabulary");
  expectEqual(isEstimateStatus("paid"), false, "refuses one an invoice has and a quote does not");
  expectEqual(isEstimateStatus(null), false, "refuses something that is not a word at all");
  expectEqual(isEstimateVoidReason("expired"), true, "and the reason guard accepts a reason");
  expectEqual(isEstimateVoidReason("refunded"), false, "refuses a reason a quote cannot have");

  // The two column lists are what the service reads with, and a list that disagrees with the schema it
  // validates against is a row PostgREST would answer without a column the schema then refuses.
  for (const [name, list, schema] of [
    ["a quote", ESTIMATE_COLUMNS, estimateRowSchema],
    ["a line", ESTIMATE_ITEM_COLUMNS, estimateItemRowSchema],
    ["the evidence", ESTIMATE_SIGNATURE_COLUMNS, estimateSignatureRowSchema],
  ] as const) {
    expect(list.startsWith("select="), `${name} is read through a named column list, never through every column`);

    const selected = list.slice("select=".length).split(",");
    const validated = Object.keys(schema.shape);

    for (const column of validated) {
      expect(selected.includes(column), `${name} selects ${column}, which its own schema validates`);
    }

    for (const column of selected) {
      expect(validated.includes(column), `${name} selects nothing its schema does not validate: ${column}`);
    }
  }

  // `0013`'s `audit_logs_action_check` is the shape of an action name, and a name that does not match it is
  // refused by the log the service is required to write.
  for (const action of [ESTIMATE_CREATED_AUDIT_ACTION, ESTIMATE_ABANDONED_AUDIT_ACTION]) {
    expect(
      /^[a-z][a-z0-9]*(\.[a-z0-9_]+)+$/u.test(action) && action.length <= 64,
      `${action} is a shape ` + "`0013` accepts",
    );
  }

  expectEqual(ESTIMATE_AUDIT_ENTITY, "estimate", "both entries name the quote they are about");
  expectDeepEqual([...ESTIMATE_MANAGE_ROLES], ["owner"], "section 25: a merchant's documents belong to its owner");

  const rules = [...ESTIMATE_RULES];

  expectEqual(new Set(rules).size, rules.length, "no rule is listed twice");
  expect(
    rules.every((rule) => /^[a-z][a-z0-9_]*$/u.test(rule)),
    "every rule is a lower snake word a catalog key can be built from",
  );
  expect(items.includes("mirrors `invoice_items` exactly"), "and `0026` still says the lines are the invoice's");
  expect(
    basis.includes("create or replace function public.estimate_items_sync_totals()"),
    "`0117` replaces the sync function rather than adding a second one",
  );
}

/* ---- a create ---- */

async function checkCreate(): Promise<void> {
  const { db, audit, snapshot } = await created();

  expectEqual(snapshot.companyId, COMPANY_A, "the quote belongs to the actor's own company");
  expectEqual(snapshot.clientId, CLIENT_A, "and to the client the body named");
  expectEqual(snapshot.status, "draft", "a create writes a draft");
  expectEqual(snapshot.number, null, "with no number, because a number is issued and this is not an issue");
  expectEqual(snapshot.voidReason, null, "no reason, because nothing has ended");
  expectEqual(snapshot.currency, "USD", "in the only currency the platform quotes in");
  expectEqual(snapshot.issuedAt, null, "no issue instant");
  expectEqual(snapshot.acceptedAt, null, "no acceptance, which is STEP 120's to write");
  expectEqual(snapshot.voidedAt, null, "no void instant");
  expectEqual(snapshot.convertedInvoiceId, null, "and no invoice, which is STEP 121's to write");
  expectEqual(snapshot.expiresAt, EXPIRES_AT, "with the expiry the merchant chose, to the instant");
  expectEqual(snapshot.memo, "Valid for fourteen days.", "and the memo they wrote");

  // The printed client is the book's, which is the point of a snapshot column.
  expectEqual(snapshot.client.name, "Acme Ltd", "the client's name comes from the book");
  expectEqual(snapshot.client.email, "billing@acme.example", "so does the delivery address");
  expectEqual(
    snapshot.client.address,
    "12 Market Street, Austin, TX, 78701, US",
    "and so does the postal address, assembled the way an invoice assembles it",
  );

  expectEqual(snapshot.lines.length, 2, "both lines were written");
  const first = at(snapshot.lines, 0, "the first line");
  const second = at(snapshot.lines, 1, "the second line");

  expectEqual(first.position, 1, "positions are one based");
  expectEqual(second.position, 2, "and follow the order the merchant typed");
  expectEqual(first.description, "Site redesign", "a line keeps what it says");
  expectEqual(first.unit, "project", "and the unit it counts in");
  expectEqual(first.quantity, "2.5", "a decimal quantity is printed back as it was typed, not as 2.500");
  expectEqual(first.unitPrice, "125.0000", "a price is printed at the scale the column stores");
  expectEqual(first.unitPriceMinor, "1250000", "and carried as exact minor units beside it");
  expectEqual(first.discountMinor, "0", "a line with no discount carries zero, not null");
  expectEqual(first.lineTotalMinor, "3125000", "2.5 of 125.00 is 312.50, which the database generated");
  expectEqual(second.quantity, "1", "one unit prints as one");
  expectEqual(second.discountMinor, "50000", "a 5.00 line discount is 50000 minor units");
  expectEqual(second.lineTotalMinor, "940000", "99.00 less 5.00 is 94.00");
  expectEqual(first.productId, null, "a line with no catalogue reference carries none");

  expectEqual(snapshot.totals.subtotal, "406.5000", "the lines add up to 406.50");
  expectEqual(snapshot.totals.subtotalMinor, "4065000", "which the trigger summed and this module read back");
  expectEqual(snapshot.totals.discountMinor, "0", "no quote-level discount was asked for");
  expectEqual(snapshot.totals.discountBasis, "amount", "so the basis is the default one");
  expectEqual(snapshot.totals.discountPercentBasisPoints, 0, "and no percentage is recorded");
  expectEqual(snapshot.totals.taxMinor, "355700", "the tax is what the body carried");
  expectEqual(snapshot.totals.totalMinor, "4420700", "406.50 less nothing plus 35.57 is 442.07");
  expectEqual(snapshot.totals.total, "442.0700", "printed at the same scale");

  // `estimate_items_sync_totals` updates the parent once per line row, and each of those updates fires
  // `estimates_set_row_metadata`: a created quote's version is one per line, not one.
  expectEqual(snapshot.version, 3, "the version counts the row plus one move per line written");
  expectEqual(snapshot.createdAtEpochMs, NOW, "the quote is dated at the fixture's now");

  // A bigint cannot cross JSON, and a snapshot that carried one would answer every create with a 500.
  const serialised = JSON.stringify(snapshot);

  expect(typeof serialised === "string" && serialised.length > 0, "the snapshot serialises, so a route can answer with it");
  expect(!serialised.includes('"bigint"'), "and nothing in it is tagged as a type JSON does not have");

  // Rule 17: the lines are one insert, and a create reads exactly three times.
  expectEqual(db.inserts.length, 2, "two writes: the quote and its lines");
  expectEqual(at(db.inserts, 0, "the first write").table, "estimates", "the parent first, because a line needs one");
  expectEqual(at(db.inserts, 1, "the second write").table, "estimate_items", "then the lines");
  expectEqual(at(db.inserts, 1, "the second write").rows.length, 2, "both lines in one insert, never one per line");
  expectDeepEqual(
    db.queries.map((query) => query.slice(0, query.indexOf("?"))),
    ["clients", "estimates", "estimate_items"],
    "three reads: the client from the book, then the quote and its lines read back",
  );
  expectEqual(db.updates.length, 0, "and no update at all, because no discount was asked for");

  expectEqual(audit.entries.length, 1, "one audit entry for one create");
  const entry = at(audit.entries, 0, "the entry");

  expectEqual(entry.action, "estimate.created", "named for what happened");
  expectEqual(entry.entityType, "estimate", "about a quote");
  expectEqual(entry.entityId, snapshot.id, "naming the row it wrote");
  expectEqual(entry.companyId, COMPANY_A, "inside the merchant's own trail");
  expectEqual(entry.actorUserId, OWNER_ID, "by the actor who wrote it");
  expectEqual(entry.sessionId, owner.sessionId, "from the session they used");

  const payload = JSON.stringify(entry.payload ?? {});

  expect(payload.includes('"line_count":2'), "counting the lines");
  expect(payload.includes('"total_minor":"4420700"'), "and the total, which is the fact an investigator needs");
  expect(payload.includes("expires_at"), "with the field names that were written");
  expect(!payload.includes("Acme"), "but never the client's name");
  expect(!payload.includes("Site redesign"), "never a line's description");
  expect(!payload.includes("fourteen days"), "and never the merchant's own words: a trail is not a copy of a document");
}

/* ---- the two discount bases ---- */

async function checkDiscount(): Promise<void> {
  const flat = await created({ discount: "50.81" });

  expectEqual(flat.snapshot.totals.discountMinor, "508100", "a flat discount is the money the merchant typed");
  expectEqual(flat.snapshot.totals.discountBasis, "amount", "recorded as an amount");
  expectEqual(flat.snapshot.totals.discountPercentBasisPoints, 0, "with no percentage beside it");
  expectEqual(flat.snapshot.totals.totalMinor, "3912600", "406.50 less 50.81 plus 35.57 is 391.26");
  expectEqual(flat.db.updates.length, 1, "written in one second update, after the lines existed");

  const values = at(flat.db.updates, 0, "the discount write").values;

  expectDeepEqual(
    Object.keys(values).sort(),
    ["discount_basis", "discount_minor", "discount_percent_bp"],
    "the basis, its points and the money travel in one statement, so a row never holds one without another",
  );
  expect(
    at(flat.db.updates, 0, "the discount write").query.includes(`status=eq.${ESTIMATE_CREATED_STATUS}`),
    "scoped to a draft, so a discount can never be written onto a quote that has been issued since",
  );

  const percent = await created({ discount: "12.5", discount_basis: "percent" });

  expectEqual(percent.snapshot.totals.discountBasis, "percent", "a percentage is recorded as one");
  expectEqual(percent.snapshot.totals.discountPercentBasisPoints, 1250, "twelve and a half percent is 1250 basis points");
  expectEqual(percent.snapshot.totals.discountPercent, "12.5", "and printed back as the merchant typed it");
  expectEqual(
    percent.snapshot.totals.discountMinor,
    "508125",
    "resolved against the subtotal the trigger had just written: 12.5 percent of 406.50 is 50.8125",
  );
  expectEqual(percent.snapshot.totals.totalMinor, "3912575", "which leaves 391.2575 with the tax");

  // The rounding case: 33.33 percent of 406.50 is 135.4864_5, and `round()` on a numeric goes half away
  // from zero, so the stored money is 1354865 minor units and not the truncation 1354864.
  const rounded = await created({ discount: "33.33", discount_basis: "percent" });

  expectEqual(rounded.snapshot.totals.discountMinor, "1354865", "a half rounds away from zero, as the SQL does");
  expectEqual(rounded.snapshot.totals.totalMinor, "3065835", "and the total follows the resolved money");

  const whole = await created({ discount: "100", discount_basis: "percent" });

  expectEqual(whole.snapshot.totals.discountMinor, "4065000", "a hundred percent takes the whole subtotal");
  expectEqual(whole.snapshot.totals.totalMinor, "355700", "and leaves the tax, which is all that is owed");

  const none = await created();

  expectEqual(none.db.updates.length, 0, "a quote with no discount is written with no second statement at all");

  // Every stored row satisfies `0117`'s coherence, which is the check that makes a basis readable.
  for (const [name, state] of [
    ["the flat", flat],
    ["the percentage", percent],
    ["the rounded", rounded],
    ["the whole", whole],
  ] as const) {
    const row = at(state.db.estimates, 0, `${name} row`);
    const basis = String(row["discount_basis"]);
    const points = Number(row["discount_percent_bp"]);

    expect(
      (basis === "percent" && points > 0) || (basis === "amount" && points === 0),
      `${name} quote stores a basis and a percentage that agree`,
    );
  }

  expectEqual(
    await codeOf(() => createEstimate({ actor: owner, body: bodyOf({ discount: "500.00" }) }, depsOf())),
    "VALIDATION_FAILED",
    "a flat discount larger than the lines is refused",
  );
  expectDeepEqual(
    await refusalOf(() => createEstimate({ actor: owner, body: bodyOf({ discount: "500.00" }) }, depsOf())),
    [{ field: "discount", rule: "too_large" }],
    "as `estimates_discount_check` would have, and against the box the merchant filled",
  );
  expectEqual(
    await codeOf(() =>
      createEstimate({ actor: owner, body: bodyOf({ discount: "200", discount_basis: "percent" }) }, depsOf()),
    ),
    "VALIDATION_FAILED",
    "and so is a percentage above a hundred, which `0117` refuses at the column as well",
  );
}

/* ---- every refusal ---- */

async function checkValidation(): Promise<void> {
  const refuse = async (
    body: unknown,
  ): Promise<readonly { field?: string; rule?: string }[]> => {
    const db = createDb();

    return refusalOf(() => createEstimate({ actor: owner, body }, depsOf(db)));
  };
  const code = async (body: unknown): Promise<string | null> =>
    codeOf(() => createEstimate({ actor: owner, body }, depsOf()));

  expectEqual(await code(null), "VALIDATION_FAILED", "a body that is not an object is refused");
  expectEqual(await code("quote"), "VALIDATION_FAILED", "and so is one that is a string");
  expectEqual(await code([]), "VALIDATION_FAILED", "and one that is an array");

  // `.strict()` is what makes a self-issued quote impossible: the body has no status to send. The refusal
  // names the document and not the key, because a key a quote does not have is not a box on any form, and
  // that is the invoice's answer to the same body - one pattern per concern.
  for (const key of ["status", "number", "issued_at", "accepted_at", "voided_at", "converted_invoice_id", "void_reason"]) {
    const details = await refuse({ ...bodyOf(), [key]: "accepted" });

    expectEqual(details.length, 1, `a body that sends ${key} is refused rather than stripped`);
    expectDeepEqual(
      [...details],
      [{ field: "estimate", rule: "invalid_format" }],
      `and ${key} never reaches a row, so no caller can self-issue or self-accept a quote`,
    );
  }

  expectEqual(await code({ ...bodyOf(), client_id: undefined }), "VALIDATION_FAILED", "a body with no client is refused");
  expectDeepEqual(await refuse({ ...bodyOf(), client_id: "" }), [{ field: "client_id", rule: "required" }], "named as missing");
  expectDeepEqual(
    await refuse({ ...bodyOf(), client_id: "not-a-uuid" }),
    [{ field: "client_id", rule: "invalid_format" }],
    "and a client id that is not an id is named as malformed",
  );
  expectDeepEqual(
    await refuse({ ...bodyOf(), currency: "EUR" }),
    [{ field: "currency", rule: "invalid_format" }],
    "a currency the platform does not quote in is refused, not converted",
  );

  // The expiry: `0025` requires the column and this module requires it to be in the future.
  expectDeepEqual(await refuse({ ...bodyOf(), expires_at: "" }), [{ field: "expires_at", rule: "required" }], "an expiry is required");
  expectDeepEqual(
    await refuse({ ...bodyOf(), expires_at: "the fourteenth" }),
    [{ field: "expires_at", rule: "invalid_format" }],
    "and has to be an instant",
  );
  expectDeepEqual(
    await refuse({ ...bodyOf(), expires_at: new Date(NOW - 1_000).toISOString() }),
    [{ field: "expires_at", rule: "expired_before_issue" }],
    "a quote that expired yesterday is refused, because it could never be issued",
  );
  expectDeepEqual(
    await refuse({ ...bodyOf(), expires_at: new Date(NOW).toISOString() }),
    [{ field: "expires_at", rule: "expired_before_issue" }],
    "and one expiring at this exact instant is refused too: `expires_at > issued_at` needs room",
  );
  expectDeepEqual(
    await refuse({ ...bodyOf(), expires_at: new Date(NOW + (ESTIMATE_EXPIRY_MAXIMUM_DAYS + 1) * 86_400_000).toISOString() }),
    [{ field: "expires_at", rule: "too_large" }],
    "and one further out than a year is refused as a mistyped year",
  );
  expectEqual(
    await code({ ...bodyOf(), expires_at: new Date(NOW + ESTIMATE_EXPIRY_MAXIMUM_DAYS * 86_400_000 - 1_000).toISOString() }),
    null,
    "while one just inside a year is accepted",
  );

  expectDeepEqual(
    await refuse({ ...bodyOf(), discount_basis: "voucher" }),
    [{ field: "discount_basis", rule: "invalid_format" }],
    "a basis this build does not know is malformed rather than defaulted",
  );
  expectDeepEqual(
    await refuse({ ...bodyOf(), discount: "twelve" }),
    [{ field: "discount", rule: "invalid_format" }],
    "a discount that is not a number is refused",
  );
  expectDeepEqual(
    await refuse({ ...bodyOf(), discount: "10", discount_basis: "percent", tax: "35.57" }),
    [],
    "a percentage of the lines is accepted",
  );
  expectDeepEqual(await refuse({ ...bodyOf(), tax: "free" }), [{ field: "tax", rule: "invalid_format" }], "and so is a tax that is not money");
  expectDeepEqual(
    await refuse({ ...bodyOf(), tax: "-1.00" }),
    [{ field: "tax", rule: "invalid_format" }],
    "a negative tax is refused before `estimates_tax_check` has to",
  );

  expectDeepEqual(await refuse({ ...bodyOf(), lines: [] }), [{ field: "lines", rule: "empty" }], "a quote with no lines is not a document");
  expectDeepEqual(
    await refuse({
      ...bodyOf(),
      lines: Array.from({ length: INVOICE_MAXIMUM_LINES + 1 }, () => lineOf()),
    }),
    [{ field: "lines", rule: "too_many" }],
    `and more than ${String(INVOICE_MAXIMUM_LINES)} of them is an import, not a quote`,
  );

  // One line's seven judgements, each named with the row and the box.
  expectDeepEqual(
    await refuse({ ...bodyOf(), lines: [lineOf({ description: "   " })] }),
    [{ field: "lines[0].description", rule: "required" }],
    "a blank description is named on the row it is on",
  );
  expectDeepEqual(
    await refuse({ ...bodyOf(), lines: [lineOf({ unit: "fortnight" })] }),
    [{ field: "lines[0].unit", rule: "invalid_format" }],
    "a unit outside the seven is refused",
  );
  expectDeepEqual(
    await refuse({ ...bodyOf(), lines: [lineOf({ quantity: "0" })] }),
    [{ field: "lines[0].quantity", rule: "too_small" }],
    "a zero quantity is a number the merchant typed that a quote cannot print",
  );
  expectDeepEqual(
    await refuse({ ...bodyOf(), lines: [lineOf({ quantity: "1000001" })] }),
    [{ field: "lines[0].quantity", rule: "too_large" }],
    "and a million and one units is beyond `estimate_items_quantity_check`",
  );
  expectDeepEqual(
    await refuse({ ...bodyOf(), lines: [lineOf({ quantity: "1.2345" })] }),
    [{ field: "lines[0].quantity", rule: "invalid_format" }],
    "a fourth decimal is refused rather than silently rounded by `numeric(12,3)`",
  );
  expectDeepEqual(
    await refuse({ ...bodyOf(), lines: [lineOf({ unit_price: "-125.00" })] }),
    [{ field: "lines[0].unit_price", rule: "invalid_format" }],
    "a negative price is refused",
  );
  expectDeepEqual(
    await refuse({ ...bodyOf(), lines: [lineOf({ discount: "400.00" })] }),
    [{ field: "lines[0].discount", rule: "too_large" }],
    "a line discount above its own gross is refused against the rounded gross, not a second opinion of it",
  );
  expectDeepEqual(
    await refuse({ ...bodyOf(), lines: [lineOf({ product_id: PRODUCT_A, service_id: SERVICE_A })] }),
    [{ field: "lines[0].service_id", rule: "invalid_format" }],
    "`estimate_items_source_check` allows at most one catalogue reference",
  );
  expectDeepEqual(
    await refuse({ ...bodyOf(), lines: [lineOf({ product_id: "lamp" })] }),
    [{ field: "lines[0].product_id", rule: "invalid_format" }],
    "and a reference that is not an id is malformed",
  );

  // Every problem of one body is reported at once, in the order the screen reads.
  const many = await refuse({
    client_id: "nope",
    currency: "EUR",
    expires_at: "",
    tax: "free",
    lines: [lineOf({ unit: "fortnight" }), lineOf({ quantity: "0" })],
  });

  expectDeepEqual(
    many.map((detail) => `${String(detail.field)}:${String(detail.rule)}`),
    [
      "client_id:invalid_format",
      "currency:invalid_format",
      "expires_at:required",
      "tax:invalid_format",
      "lines[0].unit:invalid_format",
      "lines[1].quantity:too_small",
    ],
    "one refusal names every broken box, document fields first and then the lines in the order they were typed",
  );

  // A plain string sort would put lines[10] before lines[2], so the ordering is numeric on the index.
  const eleven = Array.from({ length: 11 }, (_, index) =>
    index === 2 || index === 10 ? lineOf({ unit: "fortnight" }) : lineOf(),
  );
  const ordered = await refuse({ ...bodyOf(), lines: eleven });

  expectDeepEqual(
    ordered.map((detail) => detail.field),
    ["lines[2].unit", "lines[10].unit"],
    "and the tenth row is reported after the second, because the index is compared as a number",
  );

  // The memo is the merchant's own text, so it is sanitised and bounded rather than trusted.
  const long = await created({ memo: `terms ${"and conditions ".repeat(200)}` });

  expect(
    (long.snapshot.memo ?? "").length <= 2_000,
    "a memo longer than `estimates_memo_check` allows is cut rather than refused, because the quote is not wrong",
  );
  const blank = await created({ memo: "   " });

  expectEqual(blank.snapshot.memo, null, "and a memo of nothing is stored as nothing, not as three spaces");

  // Every rule this service can emit is one the vocabulary names, so a form can build a sentence for it.
  const emitted = new Set<string>();
  const racing = createDb();

  racing.conflictInsert = true;

  for (const detail of await refusalOf(() =>
    createEstimate({ actor: owner, body: bodyOf() }, depsOf(racing)),
  )) {
    if (typeof detail.rule === "string") {
      emitted.add(detail.rule);
    }
  }

  for (const body of [
    { ...bodyOf(), client_id: "" },
    { ...bodyOf(), client_id: "nope" },
    { ...bodyOf(), currency: "EUR" },
    { ...bodyOf(), expires_at: "" },
    { ...bodyOf(), expires_at: "soon" },
    { ...bodyOf(), expires_at: new Date(NOW - 1_000).toISOString() },
    { ...bodyOf(), expires_at: new Date(NOW + 400 * 86_400_000).toISOString() },
    { ...bodyOf(), discount_basis: "voucher" },
    { ...bodyOf(), discount: "twelve" },
    { ...bodyOf(), discount: "500.00" },
    { ...bodyOf(), tax: "free" },
    { ...bodyOf(), lines: [] },
    { ...bodyOf(), lines: [lineOf({ description: " " })] },
    { ...bodyOf(), lines: [lineOf({ quantity: "0" })] },
    { ...bodyOf(), lines: [lineOf({ quantity: "1000001" })] },
    { ...bodyOf(), lines: [lineOf({ discount: "400.00" })] },
    { ...bodyOf(), lines: Array.from({ length: INVOICE_MAXIMUM_LINES + 1 }, () => lineOf()) },
    { ...bodyOf(), lines: [lineOf({ product_id: PRODUCT_B })] },
    { ...bodyOf(), status: "accepted" },
  ]) {
    for (const detail of await refuse(body)) {
      if (typeof detail.rule === "string") {
        emitted.add(detail.rule);
      }
    }
  }

  for (const rule of emitted) {
    expect(
      (ESTIMATE_RULES as readonly string[]).includes(rule),
      `every rule the service emits is one the vocabulary names, and ${rule} is`,
    );
  }

  // The vocabulary is the form's key space rather than a list of what this part happens to emit: part 3
  // words one sentence per rule, exactly as `invoice-form.tsx` words `INVOICE_RULES`. So the claim worth
  // making is that every rule a refusal of this part produces has wording, and that the entries a later
  // part needs are already there. `already_used` is proved below, by the race that produces it.
  for (const rule of [
    "required",
    "invalid_format",
    "too_small",
    "too_large",
    "empty",
    "too_many",
    "expired_before_issue",
    "already_used",
    // `not_found` arrives as a detail rule from the catalogue guard. A client of another merchant answers
    // as a bare 404 with no field, because `getClient` refuses to say which of the two it was.
    "not_found",
  ] as const) {
    expect(emitted.has(rule), `a refusal of this part produces ${rule}, so a form has a sentence to word`);
  }

  expectEqual(emitted.size, 9, "and this part produces nine of them, no more");
}

/* ---- a conflict on the write ---- */

/**
 * The one failure this part cannot prevent: a client deleted between the read of the book and the write of
 * the quote, or a number taken by a concurrent write against the same unique index. Both reach the service as a conflict from
 * the database, and both have to answer as a conflict rather than as a broken platform.
 */
async function checkConflict(): Promise<void> {
  const db = createDb();
  const audit = createInMemoryAuditTrail();

  db.conflictInsert = true;

  expectEqual(
    await codeOf(() => createEstimate({ actor: owner, body: bodyOf() }, depsOf(db, audit))),
    "CONFLICT",
    "a violation on the insert is reported as the conflict it is",
  );
  expectDeepEqual(
    await refusalOf(() => createEstimate({ actor: owner, body: bodyOf() }, depsOf(db, audit))),
    [{ field: "client_id", rule: "already_used" }],
    "against the reference that raced, which is the only box on the form the merchant can act on",
  );
  expectEqual(db.estimates.length, 0, "and there is no half written quote to take back out");
  expectEqual(db.items.length, 0, "no line was written either, because the parent never existed");
  expectEqual(db.updates.length, 0, "so no compensating update runs: there is nothing to compensate");
  expectEqual(audit.entries.length, 0, "and no audit entry, because nothing was created");
}

/* ---- tenancy ---- */

async function checkTenancy(): Promise<void> {
  const { snapshot } = await created();
  const db = createDb();

  // A client of another merchant is read through the actor's own scope, so it is the same not-found as a
  // client that does not exist: an id is not a credential.
  expectEqual(
    await codeOf(() => createEstimate({ actor: otherOwner, body: bodyOf({ client_id: CLIENT_A }) }, depsOf(db))),
    "RESOURCE_NOT_FOUND",
    "an owner cannot quote another merchant's client, and is not told the client exists",
  );
  expectEqual(
    await codeOf(() => createEstimate({ actor: otherOwner, body: bodyOf({ client_id: CLIENT_B }) }, depsOf(db))),
    null,
    "while their own client is quoted normally",
  );

  // A read, on a quote that exists in the company being read from.
  const otherDb = createDb();
  const mine = await createEstimate({ actor: owner, body: bodyOf() }, depsOf(otherDb));

  expectEqual(
    await codeOf(() => getEstimate({ actor: otherOwner, estimateId: mine.id }, depsOf(otherDb))),
    "RESOURCE_NOT_FOUND",
    "and an owner of another company cannot read a quote that is not theirs",
  );
  expectEqual(
    await codeOf(() => getEstimate({ actor: owner, estimateId: randomUUID() }, depsOf(otherDb))),
    "RESOURCE_NOT_FOUND",
    "which is the same answer an id that does not exist gets, so an id is not a credential",
  );
  expectEqual(
    (await getEstimate({ actor: owner, estimateId: mine.id }, depsOf(otherDb))).id,
    mine.id,
    "while the merchant that wrote it reads it back",
  );

  expectEqual(
    await codeOf(() => createEstimate({ actor: desk, body: bodyOf() }, depsOf())),
    "PERMISSION_DENIED",
    "a platform account writes no quote, because section 25 gives a merchant's documents to its owner",
  );
  expectEqual(
    await codeOf(() => getEstimate({ actor: desk, estimateId: snapshot.id }, depsOf())),
    "PERMISSION_DENIED",
    "and reads none either",
  );
  expectEqual(
    await codeOf(() => createEstimate({ actor: actorOf(["owner"], null), body: bodyOf() }, depsOf())),
    "PERMISSION_DENIED",
    "an owner with no company has nothing to quote for",
  );

  // `estimate_items_guard_catalogue`: a line may quote this merchant's catalogue and nobody else's.
  const foreignDb = createDb();

  expectEqual(
    await codeOf(() =>
      createEstimate({ actor: owner, body: bodyOf({ lines: [lineOf({ product_id: PRODUCT_B })] }) }, depsOf(foreignDb)),
    ),
    "VALIDATION_FAILED",
    "a product of another merchant cannot be quoted",
  );
  expectDeepEqual(
    await refusalOf(() =>
      createEstimate({ actor: owner, body: bodyOf({ lines: [lineOf({ product_id: PRODUCT_B })] }) }, depsOf(foreignDb)),
    ),
    [{ field: "lines[0].product_id", rule: "not_found" }],
    "and the refusal names the line and the reference that was refused, not the whole document",
  );
  expectEqual(
    at(foreignDb.estimates, 0, "the abandoned quote")["deleted_at"] !== null,
    true,
    "so the quote that was written first is taken back out",
  );
  expectEqual(
    await codeOf(() =>
      createEstimate({ actor: owner, body: bodyOf({ lines: [lineOf({ product_id: PRODUCT_A })] }) }, depsOf()),
    ),
    null,
    "while this merchant's own product is quoted normally",
  );
  expectEqual(
    await codeOf(() =>
      createEstimate({ actor: owner, body: bodyOf({ lines: [lineOf({ service_id: SERVICE_A })] }) }, depsOf()),
    ),
    null,
    "and so is this merchant's own service",
  );
}

/* ---- the compensating removal ---- */

async function checkCompensation(): Promise<void> {
  const db = createDb();
  const audit = createInMemoryAuditTrail();

  db.failItems = true;

  expectEqual(
    await codeOf(() => createEstimate({ actor: owner, body: bodyOf() }, depsOf(db, audit))),
    "VALIDATION_FAILED",
    "a line insert that fails fails the create",
  );
  expectEqual(db.estimates.length, 1, "the quote row the create wrote is still there to look at");
  expectEqual(
    at(db.estimates, 0, "the abandoned quote")["deleted_at"] !== null,
    true,
    "but it is soft deleted, so it never sits in the merchant's list behind an error message",
  );
  expect(
    at(db.updates, 0, "the compensating update").query.includes(`status=eq.${ESTIMATE_CREATED_STATUS}`),
    "and the compensating write is scoped to a draft, so it cannot touch a quote issued since",
  );

  expectEqual(audit.entries.length, 1, "one entry for the removal, and none for a create that did not happen");
  expectEqual(at(audit.entries, 0, "the entry").action, ESTIMATE_ABANDONED_AUDIT_ACTION, "named for what happened");
  expectEqual(at(audit.entries, 0, "the entry").entityType, ESTIMATE_AUDIT_ENTITY, "about the quote");
  expectEqual(
    JSON.stringify(at(audit.entries, 0, "the entry").payload ?? {}),
    JSON.stringify({ reason: "validation_failed" }),
    "carrying the error code as the reason, which is a fact about the platform and no merchant data",
  );

  // The compensating action failing must not replace the failure the caller needs to see.
  const failing = createDb();

  failing.failItems = true;
  failing.failUpdates = true;

  expectEqual(
    await codeOf(() => createEstimate({ actor: owner, body: bodyOf() }, depsOf(failing))),
    "VALIDATION_FAILED",
    "and when the compensating write fails too, the original refusal is still the one reported",
  );

  // An audit sink that is down never fails the write it records.
  const deafDb = createDb();
  const deafTrail: AuditTrail = {
    append(): Promise<void> {
      return Promise.reject(new Error("the sink is down"));
    },
  };
  const deaf = await createEstimate({ actor: owner, body: bodyOf() }, depsOf(deafDb, deafTrail));

  expectEqual(deaf.status, "draft", "a quote is still created when the trail cannot be written");
  expectEqual(deafDb.estimates.length, 1, "and the row is there");

  // A decided quote is frozen, which is what makes the compensating scope more than a habit.
  const frozenDb = createDb();
  const frozen = await created({}, frozenDb);
  const row = at(frozenDb.estimates, 0, "the quote");

  row["status"] = "accepted";
  row["accepted_at"] = new Date(NOW).toISOString();

  expectEqual(
    await refusalReason(() =>
      frozenDb.failUpdates
        ? Promise.resolve()
        : createEstimateRest(frozenDb).update(
            ESTIMATE_TABLE,
            `id=eq.${frozen.snapshot.id}&company_id=eq.${COMPANY_A}`,
            { memo: "changed after acceptance" },
          ),
    ),
    "estimates_guard_terminal",
    "`0025`'s terminal guard refuses an edit to an accepted quote, which is why a signature cannot be outrun",
  );
  expectEqual(row["memo"], "Valid for fourteen days.", "and the row kept what a client signed against");
}

/* ---- the boundaries ---- */

/**
 * The edges of every limit this part enforces, because a limit is only a limit at its edge.
 *
 * Each case here is the one an off-by-one would survive: the maximum number of lines rather than one fewer,
 * the smallest and largest quantity the column allows, the quantity whose product lands exactly on a half
 * so the rounding direction is visible, and the expiry shapes a browser actually sends. The rounding case is
 * the important one. A line's total is a generated column, so the gate computes it from `0026`'s own
 * definition and compares that with what the service printed: `1.001` of `0.0500` is `0.05005`, which is
 * exactly half a minor unit, and `(::bigint)` rounds away from zero to `501`. A service that truncated would
 * print `500` and every other check in this file would still pass.
 */
async function checkBoundaries(): Promise<void> {
  // The line count: the maximum is a document, one more is an import, and the version counts the moves.
  const maximum = await created({
    lines: Array.from({ length: INVOICE_MAXIMUM_LINES }, (_, index) =>
      lineOf({ description: `Task ${String(index + 1)}`, quantity: "1", unit_price: "1.00" }),
    ),
  });

  expectEqual(
    maximum.snapshot.lines.length,
    INVOICE_MAXIMUM_LINES,
    `a quote of exactly ${String(INVOICE_MAXIMUM_LINES)} lines is written, so the limit is not off by one`,
  );
  expectEqual(
    at(maximum.snapshot.lines, 0, "the first line").position,
    1,
    "and the positions run from one",
  );
  expectEqual(
    at(maximum.snapshot.lines, INVOICE_MAXIMUM_LINES - 1, "the last line").position,
    INVOICE_MAXIMUM_LINES,
    `to ${String(INVOICE_MAXIMUM_LINES)}, one per line, with no gap and no repeat`,
  );
  expectEqual(
    maximum.snapshot.version,
    INVOICE_MAXIMUM_LINES + 1,
    "the version moved once per line the sync trigger wrote, plus the row itself",
  );
  expectEqual(maximum.snapshot.totals.subtotalMinor, "2000000", "200 lines of 1.00 are 200.00");

  // The quantity floor is one whole unit, and it is the invoice's rather than this part's: `parseDocumentLine`
  // is shared and `INVOICE_QUANTITY_MINIMUM` is one thousand thousandths, which is stricter than the
  // `quantity > 0` that `0026` declares. So a quote for half an hour is refused by a rule this STEP does not
  // own, and part 3's form has to offer a minimum of one unit instead of letting a merchant type a quantity
  // the service will then refuse. Pinned here because a reader of `0026` alone would expect 0.5 to work.
  const smallest = await created({ lines: [lineOf({ quantity: "1", unit_price: "1000.0000" })] });

  expectEqual(at(smallest.snapshot.lines, 0, "the line").quantity, "1", "one unit is the smallest quantity a line takes");
  expectEqual(
    at(smallest.snapshot.lines, 0, "the line").unitPriceMinor,
    "10000000",
    "a price carries all four decimal places the column stores",
  );
  expectEqual(
    at(smallest.snapshot.lines, 0, "the line").unitPrice,
    "1000.0000",
    "and prints back at that scale, so a screen shows what was stored",
  );
  expectEqual(
    at(smallest.snapshot.lines, 0, "the line").lineTotalMinor,
    "10000000",
    "one unit of a price is that price",
  );
  expectEqual(
    await codeOf(() =>
      createEstimate({ actor: owner, body: bodyOf({ lines: [lineOf({ quantity: "0.999" })] }) }, depsOf()),
    ),
    "VALIDATION_FAILED",
    "while nine hundred ninety nine thousandths of a unit is below the shared floor",
  );

  const largest = await created({ lines: [lineOf({ quantity: "1000000", unit_price: "0.0001" })] });

  expectEqual(at(largest.snapshot.lines, 0, "the line").quantity, "1000000", "a million units is the largest quantity");
  expectEqual(at(largest.snapshot.lines, 0, "the line").lineTotalMinor, "1000000", "and a million of 0.0001 is 10.00");
  expectEqual(
    await codeOf(() =>
      createEstimate({ actor: owner, body: bodyOf({ lines: [lineOf({ quantity: "1000000.001" })] }) }, depsOf()),
    ),
    "VALIDATION_FAILED",
    "while a million and a thousandth is beyond `estimate_items_quantity_check`",
  );
  expectEqual(
    await codeOf(() =>
      createEstimate({ actor: owner, body: bodyOf({ lines: [lineOf({ quantity: "0.0001" })] }) }, depsOf()),
    ),
    "VALIDATION_FAILED",
    "and a fourth decimal place is refused rather than rounded into the column by PostgreSQL",
  );

  // The rounding half, compared against the generated column's own definition.
  const half = await created({ lines: [lineOf({ quantity: "1.001", unit_price: "0.0500" })] });
  const halfLine = at(half.snapshot.lines, 0, "the line");

  expectEqual(halfLine.lineTotalMinor, "501", "1.001 of 0.0500 is exactly half a minor unit over, and rounds away from zero");
  expectEqual(
    halfLine.lineTotalMinor,
    databaseLineTotal("1.001", 500n, 0n).toString(),
    "which is what `0026` generates for the same three numbers, so the service and the column agree",
  );
  expectEqual(
    databaseLineTotal("1.001", 500n, 0n),
    501n,
    "and the fixture's own transcription of the cast is the rounding, not a truncation to 500",
  );

  const discountedHalf = await created({
    lines: [lineOf({ quantity: "1.001", unit_price: "0.0500", discount: "0.0001" })],
  });

  expectEqual(
    at(discountedHalf.snapshot.lines, 0, "the line").lineTotalMinor,
    "500",
    "a line discount comes off after the rounding, as the generated column defines it",
  );

  // The expiry shapes a browser sends. A date-only value is UTC by specification, and an offset-qualified
  // one is unambiguous; both are asserted exactly. A `datetime-local` value carries no zone at all, and
  // `Date.parse` reads it in the server's zone - so it is asserted to be a real instant in the future and
  // not to be a particular one, because which instant it is depends on where this runs. Part 3's form has
  // to send an offset-qualified value for that reason, and this is the check that says so.
  const dateOnly = await created({ expires_at: "2026-12-01" });

  expectEqual(
    dateOnly.snapshot.expiresAt,
    "2026-12-01T00:00:00.000Z",
    "a date a merchant picks is stored as that date at midnight UTC, whatever zone the server is in",
  );

  const offset = await created({ expires_at: "2026-12-01T09:30:00+06:00" });

  expectEqual(
    offset.snapshot.expiresAt,
    "2026-12-01T03:30:00.000Z",
    "an instant with its offset is stored as the same instant, converted once and never again",
  );

  const zulu = await created({ expires_at: "2026-12-01T09:30:00Z" });

  expectEqual(zulu.snapshot.expiresAt, "2026-12-01T09:30:00.000Z", "and a UTC instant is stored unchanged");

  const zoneless = await created({ expires_at: "2026-12-01T09:30" });

  expect(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[.]\d{3}Z$/u.test(zoneless.snapshot.expiresAt),
    "a value with no zone is still normalised to one instant in UTC before it is stored",
  );
  expect(
    Date.parse(zoneless.snapshot.expiresAt) > NOW,
    "and it is still in the future, which is the only fact this part can promise about it",
  );

  // The memo is the merchant's own prose, so it is cleaned and bounded rather than refused: control
  // characters cannot travel into a PDF or an email header, and a line break the browser sent as CRLF is
  // stored as the LF the column holds. Markup is left alone on purpose - it is data, and the escaping that
  // makes it safe is the renderer's, which part 3's gate asserts no screen bypasses.
  const memo = await created({ memo: "Terms\r\nPayable\twithin 14 days" });

  expectEqual(memo.snapshot.memo, "Terms\nPayable within 14 days", "a memo keeps its line breaks and loses its control characters");

  const control = await created({ memo: "Net 14\u0000 days\u0007" });

  expectEqual(control.snapshot.memo, "Net 14 days", "and a null byte or a bell cannot ride into a document");

  const markup = await created({ memo: "<b>Net 14</b>" });

  expectEqual(
    markup.snapshot.memo,
    "<b>Net 14</b>",
    "markup is stored as the characters the merchant typed, not as an interpretation of them",
  );

  const truncated = await created({ memo: "ab".repeat(1_500) });

  expectEqual(
    (truncated.snapshot.memo ?? "").length,
    2_000,
    "a memo longer than `estimates_memo_check` allows is cut to the column rather than refused",
  );

  // A client with nothing but a name, which is most of a new merchant's book.
  const sparse = await created({ client_id: CLIENT_SPARSE });

  expectEqual(sparse.snapshot.client.name, "Solo Trader", "a client's name is stored trimmed, as the column requires");
  expectEqual(sparse.snapshot.client.email, null, "a client with no email is quoted without one");
  expectEqual(
    sparse.snapshot.client.address,
    null,
    "and a client with no postal address has none, rather than a line of commas where it should be",
  );

  // Rule 17: selected columns, a company scope, live rows only, and the lines in print order.
  const readDb = createDb();
  const mine = await createEstimate({ actor: owner, body: bodyOf() }, depsOf(readDb));

  readDb.queries.length = 0;
  await getEstimate({ actor: owner, estimateId: mine.id }, depsOf(readDb));

  // The fixture records a read as `table?query`, so the query is the half after the question mark.
  const [quoteQuery = "", linesQuery = ""] = readDb.queries.map((recorded) => recorded.slice(recorded.indexOf("?") + 1));

  expect(quoteQuery.startsWith(`${ESTIMATE_COLUMNS}&`), "a quote is read through its named column list");
  expect(quoteQuery.includes(`id=eq.${mine.id}`), "by its id");
  expect(quoteQuery.includes(`company_id=eq.${COMPANY_A}`), "inside the actor's own company, never a body's");
  expect(quoteQuery.includes("deleted_at=is.null"), "and among the live rows only");
  expect(linesQuery.startsWith(`${ESTIMATE_ITEM_COLUMNS}&`), "the lines through their own named column list");
  expect(linesQuery.includes("order=position.asc"), "in print order, so a screen cannot reorder a document");
  expectEqual(readDb.queries.length, 2, "in two reads, with no query per line");

  // A quote whose lines could not be written is soft deleted, so it must be invisible afterwards: a ghost
  // in the list behind an error message is a document the merchant cannot open and cannot remove.
  const abandonedDb = createDb();

  abandonedDb.failItems = true;
  await codeOf(() => createEstimate({ actor: owner, body: bodyOf() }, depsOf(abandonedDb)));

  const abandonedId = String(at(abandonedDb.estimates, 0, "the abandoned quote")["id"]);

  expectEqual(
    await codeOf(() => getEstimate({ actor: owner, estimateId: abandonedId }, depsOf(abandonedDb))),
    "RESOURCE_NOT_FOUND",
    "and a quote that was taken back out cannot be read afterwards",
  );

  // Every column a read selects is one the migrations declare. A name misspelled here is not a type error
  // and not a fixture error: PostgREST answers it with a 400 in production, on every read.
  const quotes = await readRepositoryFile("migrations/0025_estimates.sql");
  const basis = await readRepositoryFile("migrations/0117_estimate_discount_basis.sql");
  const items = await readRepositoryFile("migrations/0026_estimate_items.sql");

  for (const column of ESTIMATE_COLUMNS.slice("select=".length).split(",")) {
    const declared =
      new RegExp(`^\\s{2,}${column}\\s`, "mu").test(quotes) || basis.includes(`add column ${column} `);

    expect(declared, `a quote selects ${column}, which ` + "`0025` or `0117` declares");
  }

  for (const column of ESTIMATE_ITEM_COLUMNS.slice("select=".length).split(",")) {
    expect(
      new RegExp(`^\\s{2,}${column}\\s`, "mu").test(items),
      `a line selects ${column}, which ` + "`0026` declares",
    );
  }
}

/* ---- the line editor ---- */

/**
 * The lines of a quote after it exists: added, edited, ordered, removed, and the totals above the total.
 *
 * ## What makes this section an estimate section
 *
 * Every operation here is available on a draft and on nothing else, because `0026` raises
 * `lines of an issued estimate are locked` the moment a quote has been sent. That is checked twice: once as
 * the service's own refusal, which is what a merchant sees, and once against the fixture's transcription of
 * the trigger, which is what would happen if the service did not answer first. A gate that only checked the
 * service would not know whether the database was still holding the line.
 *
 * ## What the arithmetic asserts
 *
 * Three lines of 312.50, 94.00 and 300.00 make a subtotal of 706.50, and every total below is that number
 * plus or minus something a reader can do in their head. The percentage case is the one worth reading: a
 * stored percentage is re-resolved by `0117`'s trigger against the subtotal it is writing, so removing a
 * line from a quote discounted by 12.5 percent moves the discount without any code in this module asking it
 * to. That is asserted on the stored row, not on a returned value.
 */
async function checkLines(): Promise<void> {
  /* -- a line added -- */

  const added = await draftWith();
  const addTrail = createInMemoryAuditTrail();

  added.db.queries.length = 0;
  added.db.inserts.length = 0;
  added.db.updates.length = 0;

  const addedLine = await addEstimateLine(
    {
      actor: owner,
      estimateId: added.snapshot.id,
      line: parseEstimateLine(
        lineOf({ description: "Support retainer", unit: "month", quantity: "3", unit_price: "250.00" }),
      ),
    },
    lineDepsOf(added.db, addTrail),
  );

  expectEqual(addedLine.position, 4, "a new line goes to the end, at the one position no live row holds");
  expectEqual(addedLine.description, "Support retainer", "and keeps what it says");
  expectEqual(addedLine.quantity, "3", "with the quantity as it was typed");
  expectEqual(addedLine.unitPriceMinor, "2500000", "the price in exact minor units");
  expectEqual(addedLine.lineTotalMinor, "7500000", "3 of 250.00 is 750.00, which the column generated");
  expectEqual(addedLine.version, 1, "a new line is at version one");

  const addedParent = rowOf(added.db, added.snapshot.id);

  expectEqual(String(addedParent["subtotal_minor"]), "14565000", "the trigger summed the new line into the subtotal");
  expectEqual(String(addedParent["total_minor"]), "14920700", "and the total followed: 1456.50 plus the 35.57 of tax");
  expectEqual(Number(addedParent["version"]), 5, "the quote's version moved once for the line the trigger wrote");
  expectEqual(added.db.inserts.length, 1, "one insert for one line");
  expectEqual(at(added.db.inserts, 0, "the insert").table, ESTIMATE_ITEMS_TABLE, "into the lines table");
  expectEqual(added.db.updates.length, 0, "and no update: the subtotal is the trigger's, never this module's");
  expectDeepEqual(
    added.db.queries.map((query) => query.slice(0, query.indexOf("?"))),
    [ESTIMATE_TABLE, ESTIMATE_ITEMS_TABLE],
    "two reads: is this a live draft, and what is the highest position",
  );

  expectEqual(addTrail.entries.length, 1, "one audit entry for one line added");
  const addEntry = at(addTrail.entries, 0, "the entry");

  expectEqual(addEntry.action, ESTIMATE_LINE_ADDED_AUDIT_ACTION, "named for what happened");
  expectEqual(addEntry.entityType, ESTIMATE_LINE_AUDIT_ENTITY, "about the line, so one line can be followed");
  expectEqual(addEntry.entityId, addedLine.id, "naming the row written");
  expectDeepEqual(
    addEntry.payload,
    { estimate_id: added.snapshot.id, position: 4, line_total_minor: "7500000" },
    "carrying the quote, the position and the money - and never the description, which is free text",
  );

  /* -- the ceiling, the state and the tenant -- */

  const full = await draftWith({
    lines: Array.from({ length: INVOICE_MAXIMUM_LINES }, (_, index) =>
      lineOf({ description: `Task ${String(index + 1)}`, quantity: "1", unit_price: "1.00" }),
    ),
  });
  const oneMore = parseEstimateLine(lineOf({ description: "One more" }));

  expectEqual(
    await codeOf(() =>
      addEstimateLine({ actor: owner, estimateId: full.snapshot.id, line: oneMore }, lineDepsOf(full.db)),
    ),
    "VALIDATION_FAILED",
    `a quote of ${String(INVOICE_MAXIMUM_LINES)} lines cannot take another`,
  );
  expectDeepEqual(
    await refusalOf(() =>
      addEstimateLine({ actor: owner, estimateId: full.snapshot.id, line: oneMore }, lineDepsOf(full.db)),
    ),
    [{ field: "lines", rule: "too_many" }],
    "so an editor cannot grow a document past what the create path could have produced",
  );

  const sent = await draftWith();

  issue(sent.db, sent.snapshot.id);
  sent.db.inserts.length = 0;

  expectEqual(
    await codeOf(() =>
      addEstimateLine({ actor: owner, estimateId: sent.snapshot.id, line: oneMore }, lineDepsOf(sent.db)),
    ),
    "CONFLICT",
    "a quote that has been sent takes no new line",
  );
  expectDeepEqual(
    await refusalOf(() =>
      addEstimateLine({ actor: owner, estimateId: sent.snapshot.id, line: oneMore }, lineDepsOf(sent.db)),
    ),
    [{ field: "status", rule: "already_changed" }],
    "and says the quote moved on rather than that it vanished, because a 404 would be a lie",
  );
  expectEqual(sent.db.inserts.length, 0, "with nothing written behind the refusal");
  expectEqual(
    await codeOf(() =>
      createEstimateRest(sent.db).insert(ESTIMATE_ITEMS_TABLE, [
        {
          company_id: COMPANY_A,
          estimate_id: sent.snapshot.id,
          position: 4,
          description: "Smuggled in",
          unit: "item",
          quantity: "1",
          unit_price_minor: "10000",
          discount_minor: "0",
          product_id: null,
          service_id: null,
        },
      ]),
    ),
    "CONFLICT",
    "and `0026`'s own trigger refuses the same write, so the service is answering first, not instead",
  );

  expectEqual(
    await codeOf(() =>
      addEstimateLine({ actor: desk, estimateId: added.snapshot.id, line: oneMore }, lineDepsOf(added.db)),
    ),
    "PERMISSION_DENIED",
    "a platform account edits no merchant's quote",
  );
  expectEqual(
    await codeOf(() =>
      addEstimateLine({ actor: otherOwner, estimateId: added.snapshot.id, line: oneMore }, lineDepsOf(added.db)),
    ),
    "RESOURCE_NOT_FOUND",
    "and an owner of another company is not told the quote exists",
  );
  expectDeepEqual(
    await refusalOf(() =>
      addEstimateLine({ actor: owner, estimateId: "not-a-uuid", line: oneMore }, lineDepsOf(added.db)),
    ),
    [{ field: "estimateId", rule: "invalid_format" }],
    "an id that is not an id is refused before anything is read with it",
  );

  /* -- a line edited -- */

  const edited = await draftWith();
  const editTrail = createInMemoryAuditTrail();
  const hostingId = at(edited.snapshot.lines, 1, "the second line").id;

  edited.db.queries.length = 0;
  edited.db.updates.length = 0;

  const editedLine = await updateEstimateLine(
    {
      actor: owner,
      estimateId: edited.snapshot.id,
      lineId: hostingId,
      line: parseEstimateLine(
        lineOf({ description: "Hosting", unit: "month", quantity: "2", unit_price: "99.00", discount: "5.00" }),
      ),
    },
    lineDepsOf(edited.db, editTrail),
  );

  expectEqual(editedLine.position, 2, "an edit replaces seven values and moves nothing");
  expectEqual(editedLine.lineTotalMinor, "1930000", "2 of 99.00 less the 5.00 line discount is 193.00");
  expectEqual(editedLine.version, 2, "and the line's own version moved, which is what an optimistic lock reads");
  expectEqual(
    String(rowOf(edited.db, edited.snapshot.id)["subtotal_minor"]),
    "8055000",
    "312.50 plus 193.00 plus 300.00 is the new subtotal",
  );
  expectEqual(edited.db.updates.length, 1, "one write for one line");
  expect(
    at(edited.db.updates, 0, "the write").query.includes(`estimate_id=eq.${edited.snapshot.id}`),
    "scoped to the row, the company and the quote, so a path cannot name two documents",
  );
  expectEqual(
    edited.db.queries.length,
    5,
    "five reads: the parent, the line, the live lines, the stored discount, and the line read back",
  );
  expectDeepEqual(
    at(editTrail.entries, 0, "the entry").payload,
    {
      estimate_id: edited.snapshot.id,
      position: 2,
      fields: ["description", "unit", "quantity", "unit_price", "discount", "product_id", "service_id"],
      line_total_minor: "1930000",
    },
    "the trail records which fields changed and what the line became, never what it says",
  );
  expectEqual(at(editTrail.entries, 0, "the entry").action, ESTIMATE_LINE_UPDATED_AUDIT_ACTION, "named for an edit");

  // Two quotes of one merchant: the path names one, the line belongs to the other.
  const twoDb = createDb();
  const firstQuote = await createEstimate({ actor: owner, body: bodyOf({ lines: threeLines() }) }, depsOf(twoDb));
  const secondQuote = await createEstimate({ actor: owner, body: bodyOf({ lines: threeLines() }) }, depsOf(twoDb));
  const foreignLineId = at(secondQuote.lines, 0, "the other quote's line").id;

  expectEqual(
    await codeOf(() =>
      updateEstimateLine(
        { actor: owner, estimateId: firstQuote.id, lineId: foreignLineId, line: parseEstimateLine(lineOf()) },
        lineDepsOf(twoDb),
      ),
    ),
    "RESOURCE_NOT_FOUND",
    "a line of a different quote is not edited through this path, even inside one merchant's book",
  );
  expectEqual(
    await codeOf(() =>
      removeEstimateLine({ actor: owner, estimateId: firstQuote.id, lineId: foreignLineId }, lineDepsOf(twoDb)),
    ),
    "RESOURCE_NOT_FOUND",
    "and not removed through it either",
  );

  // The guard an edit needs and looks like it does not: lowering a line can outgrow a stored flat discount.
  const guarded = await draftWith({ discount: "500.00" });
  const trainingId = at(guarded.snapshot.lines, 2, "the third line").id;
  const lowerTraining = () =>
    updateEstimateLine(
      {
        actor: owner,
        estimateId: guarded.snapshot.id,
        lineId: trainingId,
        line: parseEstimateLine(lineOf({ description: "Training", unit: "hour", quantity: "1", unit_price: "75.00" })),
      },
      lineDepsOf(guarded.db),
    );

  expectEqual(await codeOf(lowerTraining), "CONFLICT", "an edit that would leave a 500.00 discount above the lines is refused");
  expectDeepEqual(
    await refusalOf(lowerTraining),
    [{ field: "discount", rule: "too_large" }],
    "naming the stored value that needs attention, not the line the merchant happened to edit",
  );
  expectEqual(
    String(rowOf(guarded.db, guarded.snapshot.id)["subtotal_minor"]),
    "7065000",
    "and the line was not written, so the quote is exactly as it was",
  );

  /* -- a line removed -- */

  const removed = await draftWith();
  const removeTrail = createInMemoryAuditTrail();
  const removedId = at(removed.snapshot.lines, 1, "the second line").id;

  removed.db.updates.length = 0;

  const afterRemoval = await removeEstimateLine(
    { actor: owner, estimateId: removed.snapshot.id, lineId: removedId },
    lineDepsOf(removed.db, removeTrail),
  );

  expectEqual(afterRemoval.removedLineId, removedId, "the answer names the line that went");
  expectEqual(afterRemoval.lines.length, 2, "and returns what is left, because the screen prints a list");
  expectDeepEqual(
    afterRemoval.lines.map((line) => line.position),
    [1, 2],
    "with the positions dense again, so the printed order and the stored one cannot disagree",
  );
  expectEqual(
    at(afterRemoval.lines, 1, "the shifted line").description,
    "Training",
    "the line after the removal moved up into its place",
  );
  expectEqual(
    String(rowOf(removed.db, removed.snapshot.id)["subtotal_minor"]),
    "6125000",
    "312.50 plus 300.00 is what the trigger now sums",
  );
  expectEqual(removed.db.updates.length, 2, "two writes: the removal, and the one row that closed the gap");
  expect(
    removed.db.updates.every((write) => write.table === ESTIMATE_ITEMS_TABLE),
    "both of them against the lines table",
  );

  const gone = removed.db.items.find((item) => item["id"] === removedId);

  expect(gone !== undefined && gone["deleted_at"] !== null, "the line is soft deleted, not erased");
  expectEqual(
    at(removeTrail.entries, 0, "the entry").action,
    ESTIMATE_LINE_REMOVED_AUDIT_ACTION,
    "named for a removal",
  );
  expectDeepEqual(
    at(removeTrail.entries, 0, "the entry").payload,
    { estimate_id: removed.snapshot.id, position: 2, shifted: 1 },
    "recording how many rows moved to close the gap, which is the fact an investigation needs",
  );

  const single = await draftWith({ lines: [lineOf()] });

  expectDeepEqual(
    await refusalOf(() =>
      removeEstimateLine(
        { actor: owner, estimateId: single.snapshot.id, lineId: at(single.snapshot.lines, 0, "the only line").id },
        lineDepsOf(single.db),
      ),
    ),
    [{ field: "lines", rule: "empty" }],
    "and the last line cannot be removed, because a quote with no lines is not a document a create could make",
  );

  /* -- a line moved -- */

  const moved = await draftWith();
  const moveTrail = createInMemoryAuditTrail();
  const movingId = at(moved.snapshot.lines, 1, "the second line").id;

  moved.db.updates.length = 0;

  const afterMove = await moveEstimateLine(
    { actor: owner, estimateId: moved.snapshot.id, lineId: movingId, direction: "up" },
    lineDepsOf(moved.db, moveTrail),
  );

  expectEqual(afterMove.movedLineId, movingId, "the answer names the line that moved");
  expectDeepEqual(
    afterMove.lines.map((line) => line.description),
    ["Hosting", "Site redesign", "Training"],
    "and the two neighbours exchanged, which is the whole of what move up means",
  );
  expectDeepEqual(
    afterMove.lines.map((line) => line.position),
    [1, 2, 3],
    "with the list still dense",
  );
  expectEqual(
    moved.db.updates.length,
    3,
    "in three writes, because `0026`'s unique key is not deferrable and a two-write swap fails on the first",
  );
  expect(
    moved.db.updates.every((write) => write.table === ESTIMATE_ITEMS_TABLE && Object.keys(write.values).join() === "position"),
    "each of them writing a position and nothing else",
  );
  expectDeepEqual(
    moved.db.updates.map((write) => Number(write.values["position"])),
    [4, 2, 1],
    "park past the highest position, let the displaced line take the place just freed, then take the other",
  );
  expectDeepEqual(
    at(moveTrail.entries, 0, "the entry").payload,
    { estimate_id: moved.snapshot.id, direction: "up", from_position: 2, to_position: 1 },
    "and the trail records both positions, which is the change in full",
  );
  expectEqual(at(moveTrail.entries, 0, "the entry").action, ESTIMATE_LINE_MOVED_AUDIT_ACTION, "named for a move");

  const edge = await draftWith();

  edge.db.updates.length = 0;

  const unchanged = await moveEstimateLine(
    {
      actor: owner,
      estimateId: edge.snapshot.id,
      lineId: at(edge.snapshot.lines, 0, "the first line").id,
      direction: "up",
    },
    lineDepsOf(edge.db),
  );

  expectEqual(unchanged.lines.length, 3, "a move past the end of the list is answered rather than refused");
  expectDeepEqual(
    unchanged.lines.map((line) => line.position),
    [1, 2, 3],
    "with the list exactly as it stands, because the button that sent it should have been disabled",
  );
  expectEqual(edge.db.updates.length, 0, "and no write at all");

  const sentMove = await draftWith();

  issue(sentMove.db, sentMove.snapshot.id);

  expectDeepEqual(
    await refusalOf(() =>
      moveEstimateLine(
        {
          actor: owner,
          estimateId: sentMove.snapshot.id,
          lineId: at(sentMove.snapshot.lines, 0, "the first line").id,
          direction: "down",
        },
        lineDepsOf(sentMove.db),
      ),
    ),
    [{ field: "status", rule: "already_changed" }],
    "and a sent quote's lines cannot be reordered, which is what makes a signature cover an order",
  );
  expectEqual(
    await codeOf(() =>
      moveEstimateLine(
        { actor: owner, estimateId: added.snapshot.id, lineId: randomUUID(), direction: "up" },
        lineDepsOf(added.db),
      ),
    ),
    "RESOURCE_NOT_FOUND",
    "while a line id that does not exist is a 404: a move that cannot happen is a no-op, a bad id is a mistake",
  );

  /* -- the totals above the total -- */

  const totalsQuote = await draftWith();
  const totalsTrail = createInMemoryAuditTrail();

  totalsQuote.db.updates.length = 0;

  const flat = await updateEstimateTotals(
    {
      actor: owner,
      estimateId: totalsQuote.snapshot.id,
      totals: { basis: "amount", basisPoints: 0n, amountMinor: minorOf("100.00"), taxMinor: minorOf("35.57") },
    },
    lineDepsOf(totalsQuote.db, totalsTrail),
  );

  expectEqual(flat.subtotalMinor, "7065000", "the subtotal is read back from the row, never recomputed here");
  expectEqual(flat.discountMinor, "1000000", "a flat discount is the money the merchant typed");
  expectEqual(flat.totalMinor, "6420700", "706.50 less 100.00 plus 35.57 is 642.07");
  expectEqual(flat.discountBasis, "amount", "recorded as an amount");
  expectEqual(flat.discountPercentBasisPoints, 0, "with no percentage beside it");
  expectEqual(totalsQuote.db.updates.length, 1, "in one write");
  expectDeepEqual(
    Object.keys(at(totalsQuote.db.updates, 0, "the write").values).sort(),
    ["discount_basis", "discount_minor", "discount_percent_bp", "tax_minor"],
    "carrying the basis, its points and both amounts together, so `0117`'s coherence check cannot fail",
  );
  expect(
    at(totalsQuote.db.updates, 0, "the write").query.includes(`status=eq.${ESTIMATE_CREATED_STATUS}`),
    "scoped to a draft, so a totals write cannot land on a quote issued since it was read",
  );
  expectEqual(at(totalsTrail.entries, 0, "the entry").action, ESTIMATE_DISCOUNT_UPDATED_AUDIT_ACTION, "named for the change");
  expectEqual(at(totalsTrail.entries, 0, "the entry").entityType, "estimate", "about the quote, not a line");
  expectDeepEqual(
    at(totalsTrail.entries, 0, "the entry").payload,
    {
      basis: "amount",
      basis_points: "0",
      discount_minor: "1000000",
      tax_minor: "355700",
      subtotal_minor: "7065000",
      total_minor: "6420700",
    },
    "with the instruction and the four amounts it produced, and no free text anywhere in it",
  );

  const percentQuote = await draftWith();
  const percentTotals = await updateEstimateTotals(
    {
      actor: owner,
      estimateId: percentQuote.snapshot.id,
      totals: {
        basis: "percent",
        basisPoints: percentToBasisPoints("12.5") ?? 0n,
        amountMinor: 0n,
        taxMinor: minorOf("35.57"),
      },
    },
    lineDepsOf(percentQuote.db),
  );

  expectEqual(percentTotals.discountMinor, "883125", "12.5 percent of 706.50 is 88.3125, resolved against the stored subtotal");
  expectEqual(percentTotals.discountPercent, "12.5", "and printed back as the merchant typed it");
  expectEqual(percentTotals.discountPercentBasisPoints, 1250, "stored as basis points, which are exact");
  expectEqual(percentTotals.totalMinor, "6537575", "706.50 less 88.3125 plus 35.57 is 653.7575");

  // The claim `0117` exists for: a stored percentage follows the lines without being asked to.
  const followsQuote = await draftWith();

  await updateEstimateTotals(
    {
      actor: owner,
      estimateId: followsQuote.snapshot.id,
      totals: {
        basis: "percent",
        basisPoints: percentToBasisPoints("12.5") ?? 0n,
        amountMinor: 0n,
        taxMinor: minorOf("35.57"),
      },
    },
    lineDepsOf(followsQuote.db),
  );
  await removeEstimateLine(
    {
      actor: owner,
      estimateId: followsQuote.snapshot.id,
      lineId: at(followsQuote.snapshot.lines, 2, "the third line").id,
    },
    lineDepsOf(followsQuote.db),
  );

  const followed = rowOf(followsQuote.db, followsQuote.snapshot.id);

  expectEqual(String(followed["subtotal_minor"]), "4065000", "removing the 300.00 line leaves 312.50 plus 94.00");
  expectEqual(
    String(followed["discount_minor"]),
    "508125",
    "and the same 12.5 percent is now 50.8125, re-resolved by the trigger and by no code in this module",
  );
  expectEqual(String(followed["total_minor"]), "3912575", "which makes the total 391.2575");
  expectEqual(Number(followed["discount_percent_bp"]), 1250, "while the instruction itself is unchanged");

  const sentTotals = await draftWith();

  issue(sentTotals.db, sentTotals.snapshot.id);

  expectDeepEqual(
    await refusalOf(() =>
      updateEstimateTotals(
        {
          actor: owner,
          estimateId: sentTotals.snapshot.id,
          totals: { basis: "amount", basisPoints: 0n, amountMinor: minorOf("10.00"), taxMinor: 0n },
        },
        lineDepsOf(sentTotals.db),
      ),
    ),
    [{ field: "status", rule: "already_changed" }],
    "a sent quote keeps the totals a client was asked to accept",
  );
  expectDeepEqual(
    await refusalOf(() =>
      updateEstimateTotals(
        {
          actor: owner,
          estimateId: percentQuote.snapshot.id,
          totals: { basis: "amount", basisPoints: 0n, amountMinor: minorOf("900.00"), taxMinor: 0n },
        },
        lineDepsOf(percentQuote.db),
      ),
    ),
    [{ field: "discount", rule: "too_large" }],
    "and a flat discount above the lines is refused before the write rather than by the column check after it",
  );
  expectEqual(
    await codeOf(() =>
      updateEstimateTotals(
        {
          actor: desk,
          estimateId: percentQuote.snapshot.id,
          totals: { basis: "amount", basisPoints: 0n, amountMinor: minorOf("1.00"), taxMinor: 0n },
        },
        lineDepsOf(percentQuote.db),
      ),
    ),
    "PERMISSION_DENIED",
    "with the owner role required by every one of the five operations",
  );

  /* -- one parser for one line, whichever document it belongs to -- */

  expectDeepEqual(
    await refusalOf(() => Promise.resolve(parseEstimateLine(lineOf({ description: "  ", unit: "fortnight" })))),
    [
      { field: "description", rule: "required" },
      { field: "unit", rule: "invalid_format" },
    ],
    "an editor's refusal names the bare field, because the screen has one set of boxes and no rows to index",
  );

  const parsed = parseEstimateLine(lineOf({ quantity: "2.5", unit_price: "125.00" }));

  expectEqual(parsed.quantityThousandths, 2_500n, "the parsed quantity is integer thousandths, never a float");
  expectEqual(parsed.unitPriceMinor, 1_250_000n, "and the price is minor units");
  expectEqual(parsed.discountMinor, 0n, "with no line discount when the box is empty");
  expectEqual(parsed.productId, null, "and no catalogue reference when neither box is filled");

  // Every rule the five operations can emit is one the vocabulary names, so part 3 has wording for each.
  const lineRules = new Set<string>();

  for (const details of [
    await refusalOf(() =>
      addEstimateLine({ actor: owner, estimateId: sent.snapshot.id, line: oneMore }, lineDepsOf(sent.db)),
    ),
    await refusalOf(lowerTraining),
    await refusalOf(() =>
      removeEstimateLine(
        { actor: owner, estimateId: single.snapshot.id, lineId: at(single.snapshot.lines, 0, "the only line").id },
        lineDepsOf(single.db),
      ),
    ),
    await refusalOf(() =>
      addEstimateLine({ actor: owner, estimateId: full.snapshot.id, line: oneMore }, lineDepsOf(full.db)),
    ),
    await refusalOf(() => Promise.resolve(parseEstimateLine({ quantity: "0" }))),
  ]) {
    for (const detail of details) {
      if (typeof detail.rule === "string") {
        lineRules.add(detail.rule);
      }
    }
  }

  for (const rule of lineRules) {
    expect(
      (ESTIMATE_RULES as readonly string[]).includes(rule),
      `every rule the line editor emits is one the vocabulary names, and ${rule} is`,
    );
  }

  expect(lineRules.has("already_changed"), "which includes the refusal that only an editor can produce");

  for (const action of [
    ESTIMATE_LINE_ADDED_AUDIT_ACTION,
    ESTIMATE_LINE_UPDATED_AUDIT_ACTION,
    ESTIMATE_LINE_REMOVED_AUDIT_ACTION,
    ESTIMATE_LINE_MOVED_AUDIT_ACTION,
    ESTIMATE_DISCOUNT_UPDATED_AUDIT_ACTION,
  ]) {
    expect(
      /^[a-z][a-z0-9]*(\.[a-z0-9_]+)+$/u.test(action) && action.length <= 64,
      `${action} is a shape ` + "`0013` accepts",
    );
  }
}

/* ---- the HTTP surface ---- */

/** The five routes that change something, and the two that only read. */
const MUTATING_ROUTES = [
  "app/api/estimates/route.ts",
  "app/api/estimates/[id]/lines/route.ts",
  "app/api/estimates/[id]/lines/[lineId]/route.ts",
  "app/api/estimates/[id]/lines/[lineId]/move/route.ts",
  "app/api/estimates/[id]/discount/route.ts",
] as const;

/**
 * The routes that only read, each beside the one definition of the fact it reads.
 *
 * A read goes through the service that owns the fact rather than querying a table itself: a route that
 * queried would be a second cap, a second column list and a second company scope, and the three drift
 * apart from the picker or the evidence they duplicate. Naming the reader per route is what lets the third
 * one read something other than a picker without the claim going vague.
 */
const READING_ROUTES = [
  ["app/api/estimates/clients/route.ts", "listInvoiceClientOptions("],
  ["app/api/estimates/catalogue/route.ts", "listInvoiceCatalogueOptions("],
  ["app/api/estimates/[id]/signature/route.ts", "readEstimateSignature("],
] as const;

/**
 * The routes this part adds, read as text.
 *
 * A route's behaviour cannot be exercised here without a server, so what is asserted is the shape every
 * mutating route in this codebase has, and the one thing a route must never do: decide a money rule of its
 * own. The order of the checks inside each handler - token, length, session, parse, service - is the order
 * the auth gate and this one both assert, because a route that read the body before the token would let a
 * cross-origin post make the server do work it was not asked to do.
 */
async function checkRoutes(): Promise<void> {
  const codeOf = (source: string): string =>
    source
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();

        return !trimmed.startsWith("*") && !trimmed.startsWith("//") && !trimmed.startsWith("/*");
      })
      .join("\n");

  for (const path of [
    ...MUTATING_ROUTES,
    ...READING_ROUTES.map(([route]) => route),
    "services/estimates/estimate-lines.ts",
  ]) {
    const source = await readRepositoryFile(path);

    expect(source.length > 0, `${path} exists`);
    expect(
      source.split("\n", 1)[0]?.trim() === `// path: ${path}`,
      `${path} starts with its own path, so a reader knows which file a fragment came from`,
    );
    expect(
      !/[^\u0009\u000a\u000d\u0020-\u007e]/u.test(source.replaceAll("\ufeff", "")),
      `${path} is ASCII only`,
    );
  }

  for (const path of MUTATING_ROUTES) {
    const source = codeOf(await readRepositoryFile(path));

    expect(source.includes("withErrorResponse("), `${path} answers through the error envelope`);
    expect(source.includes('dynamic = "force-dynamic"'), `${path} is never statically rendered`);
    expect(source.includes("requireCsrfToken("), `${path} checks the CSRF token`);
    expect(
      source.indexOf("requireCsrfToken(") < source.indexOf("readRequestActor("),
      `${path} checks it before it reads the session`,
    );
    expect(source.includes("PAYLOAD_TOO_LARGE"), `${path} bounds the body it will read`);
    expect(
      source.indexOf("maximumBodyBytes") < source.indexOf("request.text()"),
      `${path} bounds the declared length before it reads the bytes`,
    );
    expect(source.includes('"cache-control": "no-store"'), `${path} lets no cache keep a merchant's document`);
    // A company may be *logged* - from the row the service wrote - but never read out of a request. These
    // are the four places a route could take one from a caller: the body, the query string, the path and a
    // header. The session is the fifth and the only one that is trusted.
    expect(
      !/searchParams[.]get\(["']company|body[.]company|params[.]company|headers[.]get\(["']x-company/u.test(source),
      `${path} never takes a company from the request: the session is the only source of one`,
    );
    expect(
      !/parseFloat|Number\(/u.test(source),
      `${path} does no arithmetic of its own, so no amount passes through a float here`,
    );
  }

  // The create route answers 201 with the snapshot, and cannot be handed a status to write.
  const createRoute = codeOf(await readRepositoryFile("app/api/estimates/route.ts"));

  expect(createRoute.includes("createEstimate("), "the create route calls the service and nothing else that writes");
  expect(createRoute.includes("status: 201"), "and answers 201, because a row was created");
  expect(
    createRoute.includes("companyId: estimate.companyId"),
    "the company it logs is the one the service wrote, not one a request named",
  );
  expect(
    !/status:\s*"sent"|status:\s*"accepted"/u.test(createRoute),
    "with no way to name a status, so a quote arrives as a draft every time",
  );

  // One parser per line, and it is the create path's.
  const lineRoutes = [
    "app/api/estimates/[id]/lines/route.ts",
    "app/api/estimates/[id]/lines/[lineId]/route.ts",
  ] as const;

  for (const path of lineRoutes) {
    const source = codeOf(await readRepositoryFile(path));

    expect(source.includes("parseEstimateLine("), `${path} parses a line with the create path's parser`);
  }

  const lines = await readRepositoryFile("services/estimates/estimate-lines.ts");
  const linesCode = codeOf(lines);

  expect(!linesCode.includes("function parseLine"), "the line service defines no second line parser");
  expect(linesCode.includes("parseDocumentLineBody("), "it parses through the document parser it imports");
  expect(!/parseFloat|Math[.]round/u.test(linesCode), "and no amount in it passes through a float");

  // The subtotal is the trigger's. The editor may read it - a percentage is a share of it - but never write it.
  const writePayloads = [...linesCode.matchAll(/rest\.(?:update|insert|insertReturning)\(([\s\S]*?)\);/gu)].map(
    (match) => match[1] ?? "",
  );

  expect(writePayloads.length > 0, "the line editor writes through the REST client");
  expect(
    writePayloads.every((payload) => !/subtotal_minor/u.test(payload)),
    "and never writes a subtotal: `estimate_items_sync_totals` owns that column",
  );

  const rowOfLineBlock = linesCode.slice(
    linesCode.indexOf("function rowOfLine("),
    linesCode.indexOf("function highestPosition("),
  );

  expect(rowOfLineBlock.length > 0, "the row builder is where the gate expects it");
  expect(!rowOfLineBlock.includes("line_total_minor"), "a line row carries no generated total");
  expect(!rowOfLineBlock.includes("total_minor"), "and no quote total");

  expect(linesCode.includes("insertReturning("), "a line is added by one returning insert");
  expect(linesCode.includes("deleted_at: new Date("), "and removed by a soft delete, so the row stays answerable");
  expect(
    linesCode.includes("moveDocumentLine("),
    "a move is the shared three-write swap, not a second copy of a concurrency argument",
  );

  // The totals body is judged in the service, so a second caller cannot invent a second parsing.
  const discountRoute = codeOf(await readRepositoryFile("app/api/estimates/[id]/discount/route.ts"));

  expect(discountRoute.includes("parseEstimateTotalsBody("), "the discount route parses its body in the service");
  expect(
    !/percentToBasisPoints|priceToMinor/u.test(discountRoute),
    "and converts no money itself, which is what keeps one definition of a totals body",
  );
  expect(linesCode.includes("export function parseEstimateTotalsBody"), "which the service is where that parser lives");

  // A move route offers exactly the two directions the schema can do honestly.
  const moveRoute = codeOf(await readRepositoryFile("app/api/estimates/[id]/lines/[lineId]/move/route.ts"));

  expect(moveRoute.includes("DOCUMENT_LINE_MOVE_DIRECTIONS"), "the move route takes its directions from the shared list");
  expect(
    !/"left"|"right"|position:/u.test(moveRoute),
    "and offers no general reorder, which `0026`'s non-deferrable key cannot do in one pass",
  );

  // The two reads change nothing, so they carry no token - and they are the only two estimate routes that do not.
  for (const [path, reader] of READING_ROUTES) {
    const source = codeOf(await readRepositoryFile(path));

    expect(source.includes("export const GET"), `${path} answers a GET`);
    expect(!source.includes("requireCsrfToken("), `${path} checks no token, because it changes nothing`);
    expect(!source.includes("export const POST"), `${path} exports no mutation`);
    expect(source.includes('"cache-control": "no-store"'), `${path} still lets no cache keep the answer`);
    expect(source.includes(reader), `${path} reads through ${reader.slice(0, -1)}, the one definition of the fact it answers`);
  }

  // The protected list is what makes the five mutations safe, and the auth gate counts it against the
  // routes that answer a POST - so a path missing here is a route with no token check at all.
  const csrf = await readRepositoryFile("lib/security/csrf.ts");

  for (const path of MUTATING_ROUTES) {
    const apiPath = `/${path.slice("app/".length).replace(/\/route[.]ts$/u, "")}`;

    expect(csrf.includes(`"${apiPath}"`), `${apiPath} is on the CSRF protected list`);
  }

  for (const [path] of READING_ROUTES) {
    const apiPath = `/${path.slice("app/".length).replace(/\/route[.]ts$/u, "")}`;

    expect(!csrf.includes(`"${apiPath}"`), `${apiPath} is not on it, because a read has nothing to forge`);
  }
}

/* ---- the source ---- */

async function checkSources(): Promise<void> {
  const service = await readRepositoryFile("services/estimates/estimates.ts");
  const fields = await readRepositoryFile("services/estimates/estimate-fields.ts");
  const code = service.replaceAll(/\/\*[\s\S]*?\*\//gu, "").replaceAll(/\/\/.*/gu, "");

  expect(service.startsWith("// path: services/estimates/estimates.ts\n"), "the service starts with its path");
  expect(fields.startsWith("// path: services/estimates/estimate-fields.ts\n"), "and so does the vocabulary");

  // Rule 2: no float anywhere on the money path.
  for (const [name, source] of [
    ["estimates.ts", code],
    ["estimate-fields.ts", fields],
  ] as const) {
    expect(!/parseFloat/u.test(source), `${name} never parses a float`);
    expect(!/Math[.]round/u.test(source), `${name} rounds with integers, not Math.round`);
  }

  expect(!/: bigint/u.test(code.slice(code.indexOf("export interface EstimateLineSnapshot"), code.indexOf("export interface EstimateDependencies"))), "no snapshot field is a bigint, which JSON cannot carry");
  expect(code.includes("unitPriceMinor: string"), "a line's minor units cross as text");
  expect(code.includes("totalMinor: string"), "and so do the quote's");
  expect(code.includes("priceFromMinor("), "with the printed form beside them");

  // One insert for the lines, and no query in a loop.
  expect(code.includes("await dependencies.rest.insert(ESTIMATE_ITEMS_TABLE"), "the lines go in one insert");
  expect(
    !/for \(const line of values[.]lines\) \{\s*await dependencies[.]rest/u.test(code),
    "and no line is written by its own statement",
  );

  // One parser for one set of rules: the quote judges a line with the invoice's parser.
  expect(!code.includes("function parseLine"), "this service defines no second line parser");
  expect(code.includes("parseDocumentLine("), "it parses a line with the document parser it imports");
  expect(code.includes("orderDocumentDetails("), "and orders its refusals with the shared ordering");
  expect(code.includes("addressOf("), "prints a client's address the way an invoice prints one");
  expect(
    code.includes("from \"../invoices/invoice-totals.ts\"") && code.includes("from \"../invoices/invoice-discount.ts\""),
    "the money arithmetic is the invoice's, imported rather than copied, because a total is one identity here",
  );

  // The printed client is read, never taken from the body.
  expect(code.includes("getClient("), "the client is read from the book through the client service");
  for (const column of ["client_name", "client_email", "client_address"]) {
    expect(
      !new RegExp(`${column}:\\s*value[.]`, "u").test(code),
      `and ${column} is never taken from the body a caller sent`,
    );
  }
  expect(
    !estimateCreateSchema.shape.hasOwnProperty("client_name"),
    "the create schema has no client_name key at all, so a crafted body has nowhere to put one",
  );
  expect(
    !estimateCreateSchema.shape.hasOwnProperty("status"),
    "and no status key, so no caller can self-issue or self-accept a quote",
  );

  // Rule 9: the audit entry is written by the same flow as the change, and says nothing about the document.
  expect(code.includes("appendTolerated(dependencies.audit"), "the create writes its audit entry itself");
  expect(code.includes("ESTIMATE_CREATED_AUDIT_ACTION"), "named by the constant the gate compares against");
  expect(
    !code.includes("payload: {\n      client_name"),
    "and the payload is field names and counts, never the client's name",
  );

  // Rule 13 is the version column, and rule 17 is the column list: both are visible in the queries.
  expect(code.includes("deleted_at=is.null"), "every read is of live rows");
  expect(code.includes("company_id=eq."), "and every statement is scoped to one company");
  expect(
    code.includes("${ESTIMATE_COLUMNS}&") && code.includes("${ESTIMATE_ITEM_COLUMNS}&"),
    "through a named column list rather than every column of the row",
  );

  // `0117`'s two columns are written together or not at all, which is the coherence check by construction.
  const discountWrite = code.slice(code.indexOf("discount_minor: resolvedDiscount"));

  expect(discountWrite.includes("discount_basis: values.discountBasis"), "the basis travels with the money");
  expect(
    discountWrite.includes("discount_percent_bp: basisPointsToColumn(values.discountBasisPoints)"),
    "and so do the points, so a row never holds one without the other",
  );
}

/* ---- the migrations ---- */

async function checkMigration(): Promise<void> {
  const quotes = await readRepositoryFile("migrations/0025_estimates.sql");
  const items = await readRepositoryFile("migrations/0026_estimate_items.sql");
  const basis = await readRepositoryFile("migrations/0117_estimate_discount_basis.sql");
  const rollback = await readRepositoryFile("migrations/0117_estimate_discount_basis.down.sql");
  const policies = await readRepositoryFile("migrations/0070_tenant_policies_batch_one.sql");

  expect(quotes.includes("create table public.estimates ("), "`0025` creates the quote");
  expect(quotes.includes("expires_at timestamptz not null"), "with an expiry every row has to carry");
  expect(quotes.includes("constraint estimates_tenant_key unique (id, company_id)"), "a tenant key a line can point at");
  expect(quotes.includes("estimates_expiry_check"), "and the expiry bound the service supplies the other half of");
  expect(quotes.includes("public.invoices_derive_total()"), "the total derived by the invoice's own function");
  expect(quotes.includes("estimates_guard_terminal"), "with a decided quote frozen by a trigger");
  expect(quotes.includes("alter table public.estimates enable row level security"), "row level security on");
  expect(quotes.includes("using (false)"), "and default deny, so a connection that is not the platform's sees no row");
  expect(policies.includes("create policy estimates_tenant_isolation"), "`0070` adds the tenant policy on top");

  expect(items.includes("create table public.estimate_items ("), "`0026` creates the lines");
  expect(
    items.includes("references public.estimates (id, company_id)"),
    "each one pointing at its quote through the tenant key",
  );
  expect(items.includes("estimate_items_position_key"), "one line per position among the live ones");
  expect(items.includes("lines of an issued estimate are locked"), "and no line change once the quote is issued");
  expect(items.includes("estimate_items_guard_catalogue"), "with the catalogue guard this service relies on");
  expect(
    items.includes("generated always as"),
    "and the line total generated, so a stored line cannot disagree with its own arithmetic",
  );

  // `0117`: the two columns, the three checks and the replaced trigger.
  expect(basis.includes("add column discount_basis text not null default 'amount'"), "`0117` adds the basis");
  expect(basis.includes("add column discount_percent_bp integer not null default 0"), "and the percentage in basis points");
  expect(basis.includes("estimates_discount_basis_coherent_check"), "with the check that makes the pair readable");
  expect(basis.includes("discount_percent_bp >= 0 and discount_percent_bp <= 10000"), "bounded at the whole quote");
  expect(
    basis.includes("round(lines_total::numeric * discount_percent_bp / 10000)::bigint"),
    "and the percentage resolved in the same statement that writes the subtotal",
  );
  expect(basis.includes("begin;") && basis.includes("commit;"), "in one transaction");
  expect(basis.includes("set search_path = ''"), "with an empty search path, as every function here has");

  // The rollback restores the function before it drops the columns the function's replacement reads.
  expect(rollback.includes("create or replace function public.estimate_items_sync_totals()"), "the rollback restores `0026`'s function");
  expect(rollback.indexOf("create or replace function") < rollback.indexOf("drop column"), "before it drops the columns, so no trigger is left naming an absent one");
  expect(rollback.indexOf("estimates_discount_basis_coherent_check") < rollback.indexOf("drop column"), "the coherent check goes first, because it names both columns");
  expect(rollback.includes("drop column if exists discount_percent_bp"), "then the two columns");
  expect(rollback.includes("drop column if exists discount_basis"), "in the reverse of the order they were added");
  expect(
    !/drop column[^;]*discount_minor/u.test(rollback),
    "and `discount_minor`, which `0025` already had, is never dropped by a rollback of `0117`'s two",
  );
  expect(!rollback.includes("drop table"), "no table is dropped by a rollback of two columns");

  // Every column the service writes on an insert exists in `0025` or `0117`: a column the fixture invents
  // and the database does not have would pass every check here and fail the first deployment.
  for (const column of [
    "company_id",
    "client_id",
    "status",
    "currency",
    "discount_minor",
    "tax_minor",
    "client_name",
    "client_email",
    "client_address",
    "memo",
    "expires_at",
  ]) {
    expect(quotes.includes(`\n  ${column} `), `the insert writes ${column}, which ` + "`0025` declares");
  }

  for (const column of ["discount_basis", "discount_percent_bp"]) {
    expect(basis.includes(column), `the discount write sets ${column}, which ` + "`0117` declares");
  }

  for (const column of [
    "company_id",
    "estimate_id",
    "position",
    "description",
    "unit",
    "quantity",
    "unit_price_minor",
    "discount_minor",
    "product_id",
    "service_id",
  ]) {
    expect(items.includes(`\n  ${column} `), `a line writes ${column}, which ` + "`0026` declares");
  }

  expect(!quotes.includes("amount_paid_minor"), "and a quote has no paid amount, because nothing is paid on a quote");
  expect(!quotes.includes("due_at"), "and no due date, because an expiry is the deadline a quote has");
}

async function checkUi(): Promise<void> {
  const formPath = "app/(dashboard)/estimates/estimate-form.tsx";
  const editorPath = "app/(dashboard)/estimates/estimate-line-editor.tsx";
  const screensPath = "app/(dashboard)/estimates/estimate-screens.tsx";
  const listPath = "app/(dashboard)/estimates/page.tsx";
  const newPath = "app/(dashboard)/estimates/new/page.tsx";
  const onePath = "app/(dashboard)/estimates/[id]/page.tsx";
  const panelPath = "app/(dashboard)/estimates/estimate-signature-panel.tsx";

  const form = await readRepositoryFile(formPath);
  const editor = await readRepositoryFile(editorPath);
  const screens = await readRepositoryFile(screensPath);
  const listPage = await readRepositoryFile(listPath);
  const newPage = await readRepositoryFile(newPath);
  const onePage = await readRepositoryFile(onePath);
  const panel = await readRepositoryFile(panelPath);
  const ui = [form, editor, screens, listPage, newPage, onePage, panel];

  for (const [name, source] of [
    [formPath, form],
    [editorPath, editor],
    [screensPath, screens],
    [listPath, listPage],
    [newPath, newPage],
    [onePath, onePage],
    [panelPath, panel],
  ] as const) {
    expect(source.startsWith(`// path: ${name}\n`), `${name} starts with its path`);
    expect(/^[\x20-\x7e\n\r\t]*$/u.test(source), `${name} is ASCII`);
  }

  // The two components that hold a box are client components; the screen that reads the session is not.
  expect(form.startsWith("// path: app/(dashboard)/estimates/estimate-form.tsx\n\"use client\";\n"), "the form is a client component");
  expect(editor.startsWith("// path: app/(dashboard)/estimates/estimate-line-editor.tsx\n\"use client\";\n"), "and so is the line editor");

  for (const [name, source] of [
    ["estimate-screens.tsx", screens],
    ["page.tsx", listPage],
    ["new/page.tsx", newPage],
    ["[id]/page.tsx", onePage],
  ] as const) {
    expect(!source.includes('"use client"'), `${name} is a server module, so it may read the session`);
  }

  // A client component imports the vocabulary and the types, never a value from a server-only module:
  // `getEstimate` reaches the database, and a bundle that carried it would carry the connection with it.
  for (const [name, source] of [["estimate-form.tsx", form], ["estimate-line-editor.tsx", editor]] as const) {
    expect(!/import \{[^}]*\} from "@\/services\/estimates\/estimates"/u.test(source), `${name} imports no value from the service`);
    expect(source.includes('import type {') && /import type \{[^}]*EstimateSnapshot/u.test(source), `${name} takes the snapshot as a type only`);
    expect(!source.includes("getEstimate("), `${name} never reads the database itself`);
  }

  // The form writes the document once; the editor writes one line, or the two amounts above the total.
  expect(form.includes('await fetch("/api/estimates", {'), "the form posts to the collection route");
  expect(editor.includes("fetch(`/api/estimates/${estimate.id}/lines`, {"), "the editor adds through the lines route");
  expect(editor.includes("fetch(`/api/estimates/${estimate.id}/lines/${lineId}`, {"), "and edits or removes one line through its own route");
  expect(editor.includes("fetch(`/api/estimates/${estimate.id}/lines/${lineId}/move`, {"), "and orders lines through the move route");
  expect(editor.includes("fetch(`/api/estimates/${estimate.id}/discount`, {"), "and writes the discount and the tax through the totals route");
  expect(editor.includes('method: "DELETE"'), "a removal is a DELETE, the verb that says a row is gone");
  expect(editor.includes('method: "POST"'), "and a line write is a POST, which is what the route answers");

  // Every mutating request carries the rotating token; the two reads that fill a selector do not need one.
  expect(countOf(form, "csrfHeaders()") === 1, "the form sends the CSRF header with its one write");
  expect(countOf(editor, "csrfHeaders()") === 5, "and the editor sends it with each of its five writes");
  expect(countOf(form, "fetch(") === 3, "the form makes three requests: two catalogue reads and the write");
  expect(form.includes('credentials: "same-origin"') && editor.includes('credentials: "same-origin"'), "both send the session cookie");

  // Rule 2 on the screen: money is text, so no box asks for a number and no layer parses a float.
  for (const source of ui) {
    expect(!source.includes('type="number"'), "no money box is a number input, which is a float in a browser");
    expect(!source.includes("parseFloat"), "and no screen parses a float");
    expect(!source.includes("toFixed("), "nor rounds with a float method");
    expect(!source.includes("dangerouslySetInnerHTML"), "nor writes markup from a string, which React escapes for it");
  }

  for (const match of form.matchAll(/Number\(/gu)) {
    expect(form.slice(match.index, (match.index ?? 0) + 18).startsWith("Number.isFinite("), "the form's only Number is a finiteness test");
  }

  expect(form.includes("priceToMinor(") && form.includes("priceFromMinor("), "the form converts with the catalogue's decimal arithmetic");
  expect(form.includes("grossLineMinor("), "and computes a line's amount with the service's own rule");
  expect(editor.includes("grossLineMinor(") && editor.includes("percentDiscountMinor("), "as does the editor");

  // The expiry is bounded on the box, so `expired_before_issue` cannot be reached by picking a day.
  expect(form.includes("min={minimumExpiryDate}"), "the expiry box has the service's floor");
  expect(form.includes("max={maximumExpiryDate}"), "and its ceiling");
  expect(form.includes('T00:00:00.000Z'), "with the zone named, so the stored instant does not depend on the server's");
  expect(screens.includes("ESTIMATE_EXPIRY_MAXIMUM_DAYS"), "the ceiling is the vocabulary's, not a second copy of it");
  expect(!form.includes("Date.now("), "the form reads no clock of its own");
  expect(countOf(screens, "dayFromNow(") === 4, "and the screen decides the three dates it hands down");

  // One maximum, one unit list, one currency: the UI takes each from the module that owns it.
  expect(form.includes("INVOICE_MAXIMUM_LINES") && editor.includes("INVOICE_MAXIMUM_LINES"), "both screens use the shared line ceiling");
  for (const source of ui) {
    expect(!/\b200\b/u.test(source), "and no screen carries its own copy of it");
  }

  expect(form.includes("INVOICE_UNITS"), "the form's unit selector is the shared vocabulary");
  expect(form.includes("ESTIMATE_CURRENCIES"), "and its currency is the estimate's own");

  // The four ways the screen can refuse are four sentences, and a fifth for a quote that is not there.
  for (const kind of ["signed-out", "forbidden", "not-found", "unavailable"]) {
    expect(screens.includes(`state.kind === "${kind}"`) || screens.includes(`kind: "${kind}"`), `the screens can reach the ${kind} refusal`);
    expect(screens.includes(`getMessage("estimates.${camelOf(kind)}")`) || screens.includes("refusalSentence(state)"), `and the ${kind} refusal has a sentence`);
  }

  expect(countOf(screens, "refusalSentence(") >= 3, "every refusal on both screens is worded through one function");

  // The editor's list is whatever the server answered, so a removal's new positions are not guessed here.
  expect(countOf(editor, "setLines(") === 1, "the editor writes its list in one place");
  expect(editor.includes("adoptLines(remaining)") && editor.includes("adoptLines(reordered)"), "and takes it from the removal's and the move's answers");
  expect(editor.includes("disabled={busy || draftLocked || index === 0}"), "moving up is disabled on the first line, not hidden");
  expect(editor.includes("index === lines.length - 1"), "and moving down is disabled on the last");
  expect(editor.includes("lines.length === 1 ? null"), "the last line offers no removal, because a quote needs one");

  // Each operation fails with its own sentence, so "the line was not removed" is never read for a move.
  for (const key of ["editorSaveFailed", "editorAddFailed", "editorRemoveFailed", "editorMoveFailed", "totalsEditorFailed"]) {
    expect(editor.includes(`"estimates.${key}"`), `a failed ${key.replace(/^editor|Failed$/gu, "")} has its own sentence`);
  }

  // A quote that is not a draft renders with its controls disabled and the reason printed.
  expect(editor.includes('estimate.status !== "draft"'), "the lock is read from the status the service sent");
  expect(editor.includes('getMessage("estimates.editorDraftOnly")'), "and the reason is printed rather than implied");

  // The routes: the collection opens on the form, and one quote is read from a decoded segment.
  expect(listPage.includes('redirect("/estimates/new")'), "the quotes route opens on the create form");
  expect(listPage.includes('dynamic = "force-dynamic"'), "and is never cached");
  expect(onePage.includes("await params"), "one quote's page awaits its params");
  expect(onePage.includes("decodeURIComponent(context.id)"), "and decodes the segment it was given");
  expect(newPage.includes("EstimateCreateScreen"), "the new page renders the create screen");
  for (const source of [listPage, newPage, onePage]) {
    expect(source.includes('export const dynamic = "force-dynamic"'), "every estimate page opts out of the cache");
  }

  // The width: one column on a phone, two only from `sm` up, and the page capped so a line of money is
  // never stretched across a 1440px screen. These are the classes that make a 360px phone usable, and they
  // are asserted because nothing in this build can click a page - the class list is the proof on offer.
  expect(screens.includes("min-h-dvh bg-background px-4 py-8 text-foreground sm:px-6 lg:px-8"), "both screens pad a phone and widen a desktop");
  expect(countOf(screens, "mx-auto flex w-full max-w-3xl flex-col gap-6") === 2, "and cap the column at a readable width on each");
  // Every grid is one column until `sm` and two after it: the two counts being equal is the assertion, and
  // it is the one that fails if a money grid is ever written as two columns on a phone.
  expect(countOf(form, "grid-cols-1") === countOf(form, "sm:grid-cols-2"), "every grid in the form is one column on a phone and two from sm up");
  expect(countOf(form, "grid-cols-1") === 3, "and the form has three of them: the saved panel, a line's amounts and the offer");
  expect(countOf(editor, "grid-cols-1") === countOf(editor, "sm:grid-cols-2"), "as does every grid in the editor");
  expect(countOf(editor, "grid-cols-1") === 2, "the editor has two: the five line boxes, shared by both forms, and the totals");
  expect(countOf(editor, "flex-wrap") >= 3, "a row's controls wrap rather than overflow");
  expect(form.includes("flex-wrap"), "and so do the form's");
  expect(editor.includes("min-w-0") && editor.includes("truncate"), "the editor's closed row truncates a long description instead of pushing its amount off the screen");
  expect(countOf(panel, "grid-cols-1") === countOf(panel, "sm:grid-cols-2"), "and the evidence list is one column on a phone, two from sm up");
  expect(countOf(panel, "grid-cols-1") === 1, "because it is one list");

  // Every sentence the screens name exists in the catalogue, and the catalogue is not padded: this build
  // uses what it declares. A key renamed here would leave a screen with no copy, and a type error is the
  // first defence - this is the record that the copy is wired end to end.
  const catalogue = await readRepositoryFile("lib/i18n/strings/en.ts");
  const sectionStart = catalogue.indexOf("\n  estimates: {\n");
  const sectionEnd = catalogue.indexOf("\n  },\n", sectionStart);

  expect(sectionStart > 0 && sectionEnd > sectionStart, "the catalogue has an estimates section");

  const section = catalogue.slice(sectionStart, sectionEnd);
  const referenced = new Set<string>();

  for (const source of ui) {
    for (const match of source.matchAll(/(?:getMessage|formatMessage)\(\s*"estimates\.([A-Za-z]+)"/gu)) {
      referenced.add(match[1] as string);
    }

    for (const match of source.matchAll(/"estimates\.((?:rule|discount|totals|editor|client|line)[A-Za-z]*)"/gu)) {
      referenced.add(match[1] as string);
    }
  }

  for (const key of [...referenced].sort()) {
    expect(section.includes(`\n    ${key}:`), `the copy for "${key}" is in the catalogue`);
  }

  expect(referenced.size >= 90, `the screens use ${String(referenced.size)} of the estimate's sentences`);

  const declared = new Set<string>();

  for (const match of section.matchAll(/\n    ([A-Za-z]+):/gu)) {
    declared.add(match[1] as string);
  }

  for (const key of [...declared].sort()) {
    // `notFound` is reached through `refusalSentence`, and the rule keys through the map: both are named
    // by a lookup rather than a literal at the call site, so they are counted as used here.
    expect(referenced.has(key) || screens.includes(key) || form.includes(key) || editor.includes(key), `the catalogue declares no sentence this build does not use: "${key}"`);
  }
}

/** How many times a literal appears, for the counts that are the assertion. */
function countOf(source: string, needle: string): number {
  let count = 0;
  let index = source.indexOf(needle);

  while (index >= 0) {
    count += 1;
    index = source.indexOf(needle, index + needle.length);
  }

  return count;
}

/** `signed-out` as the sentence key that words it. */
function camelOf(kind: string): string {
  if (kind === "signed-out") {
    return "signedOut";
  }

  return kind;
}

/** A module's code with its comments stripped, so an assertion reads the behaviour and not the prose. */
function sourceCodeOf(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\/\s*/gu, "").replaceAll(/\/\/.*/gu, "");
}

/**
 * One function's own text, from its signature to the closing brace of its body.
 *
 * The alternative is asserting over a whole module, which stops being true the moment the module grows a
 * second export - and "the hash is pure" is a claim about a function, not about a file. Braces are counted
 * over comment-stripped source, so a doc comment cannot hold the body open.
 */
function functionBodyOf(code: string, name: string): string {
  const start = code.indexOf(`function ${name}(`);

  if (start === -1) {
    throw new Error(`gate fixture: no function ${name}`);
  }

  let depth = 0;

  for (let index = start; index < code.length; index += 1) {
    const character = code[index];

    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;

      if (depth === 0) {
        return code.slice(start, index + 1);
      }
    }
  }

  throw new Error(`gate fixture: ${name} has no closing brace`);
}

/** The two captured words of a migration's own list, read out of the file rather than out of a comment. */
function matchOf(source: string, pattern: RegExp, what: string): readonly [string, string] {
  const found = pattern.exec(source);

  if (found === null) {
    throw new Error(`gate fixture: ${what} is missing from the migration`);
  }

  return [found[1] ?? "", found[2] ?? ""];
}

/**
 * The columns `0027` really has, read out of its own `create table`.
 *
 * A fixture mints its rows itself, so it never notices a column name that does not exist: a typo in the
 * read's column list, or a key in an insert that the table does not have, is a statement PostgREST refuses
 * in production and nothing refuses here. So the real list comes from the migration's text, and both sides
 * of the service's queries are compared against it rather than against the fixture's idea of the table.
 */
async function estimateSignatureTableColumns(): Promise<readonly string[]> {
  const migration = await readRepositoryFile("migrations/0027_estimate_signatures.sql");
  const start = migration.indexOf("create table public.estimate_signatures (");

  if (start === -1) {
    throw new Error("gate fixture: 0027 creates no estimate_signatures table");
  }

  const body = migration.slice(start, migration.indexOf("\n);", start));

  return body
    .split("\n")
    .map((line) => line.trim())
    .map((line) => /^([a-z_]+) (?:uuid|text|boolean|inet|integer|timestamptz)\b/u.exec(line)?.[1] ?? "")
    .filter((column) => column.length > 0);
}

/** The floor and ceiling a column's `char_length` check states. */
function boundsOf(source: string, column: string): { readonly min: number; readonly max: number } {
  const found = new RegExp(`char_length\\(${column}\\) between (\\d+) and (\\d+)`, "u").exec(source);

  if (found === null) {
    throw new Error(`gate fixture: ${column} has no length check in 0027`);
  }

  return { min: Number(found[1]), max: Number(found[2]) };
}

/** The pattern a column's `~` check states, exactly as the migration spells it. */
function patternOf(source: string, column: string): string {
  const found = new RegExp(`${column} ~ '([^']+)'`, "u").exec(source);

  if (found === null) {
    throw new Error(`gate fixture: ${column} has no pattern check`);
  }

  return found[1] ?? "";
}

/** The same value with every object's keys inserted the other way round, deeply. */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => reverseKeys(entry));
  }

  if (typeof value !== "object" || value === null) {
    return value;
  }

  const record = value as Readonly<Record<string, unknown>>;
  const out: Record<string, unknown> = {};

  for (const key of Object.keys(record).reverse()) {
    out[key] = reverseKeys(record[key]);
  }

  return out;
}

interface DecodedField {
  readonly name: string;
  readonly tag: string;
  readonly value: string;
}

/**
 * The canonical encoding read back field by field.
 *
 * This is the proof that the encoding is self-delimiting: a decoder that can recover every name, tag and
 * value from the concatenated string, without knowing anything but the lengths written in it, is a decoder
 * that cannot be misled by a value containing a colon, a pipe or a field header of its own.
 */
function decodeEncoding(encoding: string): readonly DecodedField[] {
  const bytes = new TextEncoder().encode(encoding);
  const text = new TextDecoder();
  const fields: DecodedField[] = [];
  let cursor = 0;

  while (cursor < bytes.length) {
    let nameEnd = cursor;

    while (nameEnd < bytes.length && bytes[nameEnd] !== 0x3a) {
      nameEnd += 1;
    }

    // The layout is `name:tag:length:value`, so the colon after a one-character tag sits at `nameEnd + 2`
    // and the digits begin at the byte after it. Scanning for the next colon from the colon itself would
    // find it immediately and read a length of zero digits.
    const tagEnd = nameEnd + 2;
    let lengthEnd = tagEnd + 1;

    while (lengthEnd < bytes.length && bytes[lengthEnd] !== 0x3a) {
      lengthEnd += 1;
    }

    const length = Number.parseInt(text.decode(bytes.subarray(tagEnd + 1, lengthEnd)), 10);

    if (!Number.isFinite(length) || length < 0 || lengthEnd + 1 + length > bytes.length) {
      throw new Error(`gate fixture: the encoding is not decodable at byte ${String(cursor)}`);
    }

    fields.push({
      name: text.decode(bytes.subarray(cursor, nameEnd)),
      tag: text.decode(bytes.subarray(nameEnd + 1, tagEnd)),
      value: text.decode(bytes.subarray(lengthEnd + 1, lengthEnd + 1 + length)),
    });
    cursor = lengthEnd + 1 + length;
  }

  return fields;
}

/**
 * The quote the golden digest is taken over.
 *
 * A literal rather than `draftWith()`'s answer, because the fixture database mints a fresh id for every
 * row it inserts and a digest over those would move on every run. Pinning the encoding needs a document
 * that does not move.
 *
 * Two of its values are awkward on purpose. The address holds a character that is two bytes in UTF-8, so a
 * length counted in UTF-16 units would put the next field's boundary in the wrong place and the decoder
 * would read a truncated value. The memo holds a colon and a pipe, so an encoding joined by a separator
 * would read the memo's own text as a field header. Both are recovered verbatim below, which is the proof
 * that the encoding counts bytes and delimits itself.
 *
 * The amounts are the standard fixture's arithmetic: 2.5 of 125.00 is 312.50, 1 of 99.00 less 5.00 is
 * 94.00, 4 of 75.00 is 300.00, so the subtotal is 706.50 and with 35.57 of tax the total is 742.07.
 */
/**
 * A character that is two bytes in UTF-8, built from its code point.
 *
 * Built rather than typed, because this repository's source has to be English and ASCII - rule 1, and the
 * `local/english-only-source` lint rule enforces it. A merchant's client may still be called anything at
 * all, so the gate synthesises the value a real address could hold instead of spelling it in the file. The
 * string it produces is byte for byte the one a typed character would have been, so the digest below is a
 * digest over real data and not over an escape.
 */
const TWO_BYTE_CHARACTER = String.fromCodePoint(0x00fc);

function signatureFixtureQuote(): EstimateSnapshot {
  return {
    id: "0e1a2b3c-4d5e-7f60-8192-a3b4c5d6e7f8",
    companyId: "1f2e3d4c-5b6a-7980-9182-736455463728",
    clientId: "2a3b4c5d-6e7f-7081-92a3-b4c5d6e7f809",
    number: null,
    status: "draft",
    voidReason: null,
    currency: "USD",
    client: {
      name: "Acme Ltd",
      email: "accounts@acme.example",
      address: `12 Main Road, Z${TWO_BYTE_CHARACTER}rich`,
    },
    memo: "Terms: half up front | balance on delivery",
    expiresAt: "2026-11-19T00:00:00.000Z",
    issuedAt: null,
    acceptedAt: null,
    voidedAt: null,
    convertedInvoiceId: null,
    lines: [
      {
        id: "3b4c5d6e-7f80-7192-a3b4-c5d6e7f80911",
        estimateId: "0e1a2b3c-4d5e-7f60-8192-a3b4c5d6e7f8",
        position: 1,
        description: "Consulting",
        unit: "hour",
        quantity: "2.5",
        unitPrice: "125.0000",
        unitPriceMinor: "1250000",
        discount: "0.0000",
        discountMinor: "0",
        lineTotalMinor: "3125000",
        productId: null,
        serviceId: null,
        version: 1,
        createdAtEpochMs: 1762300800000,
        updatedAtEpochMs: 1762300800000,
      },
      {
        id: "4c5d6e7f-8091-72a3-b4c5-d6e7f8091122",
        estimateId: "0e1a2b3c-4d5e-7f60-8192-a3b4c5d6e7f8",
        position: 2,
        description: "Hosting",
        unit: "month",
        quantity: "1",
        unitPrice: "99.0000",
        unitPriceMinor: "990000",
        discount: "5.0000",
        discountMinor: "50000",
        lineTotalMinor: "940000",
        productId: null,
        serviceId: null,
        version: 1,
        createdAtEpochMs: 1762300800000,
        updatedAtEpochMs: 1762300800000,
      },
      {
        id: "5d6e7f80-9112-73b4-c5d6-e7f809112233",
        estimateId: "0e1a2b3c-4d5e-7f60-8192-a3b4c5d6e7f8",
        position: 3,
        description: "Training",
        unit: "hour",
        quantity: "4",
        unitPrice: "75.0000",
        unitPriceMinor: "750000",
        discount: "0.0000",
        discountMinor: "0",
        lineTotalMinor: "3000000",
        productId: null,
        serviceId: null,
        version: 1,
        createdAtEpochMs: 1762300800000,
        updatedAtEpochMs: 1762300800000,
      },
    ],
    totals: {
      subtotal: "706.5000",
      subtotalMinor: "7065000",
      discount: "0.0000",
      discountMinor: "0",
      discountBasis: "amount",
      discountPercentBasisPoints: 0,
      discountPercent: "0",
      tax: "35.5700",
      taxMinor: "355700",
      total: "742.0700",
      totalMinor: "7420700",
    },
    version: 1,
    createdAtEpochMs: 1762300800000,
    updatedAtEpochMs: 1762300800000,
  };
}

async function checkSignature(): Promise<void> {
  /* -- the vocabulary is `0027`'s, read out of the file rather than trusted -- */

  const migration = await readRepositoryFile("migrations/0027_estimate_signatures.sql");
  const auditMigration = await readRepositoryFile("migrations/0013_audit_logs.sql");
  const fieldsSource = await readRepositoryFile("services/estimates/estimate-signature-fields.ts");
  const hasherSource = await readRepositoryFile("services/estimates/estimate-signature.ts");
  const fieldsCode = sourceCodeOf(fieldsSource);
  const hasherCode = sourceCodeOf(hasherSource);

  expect(migration.startsWith("-- path: migrations/0027_estimate_signatures.sql\n"), "`0027` starts with its path");
  expect(fieldsSource.startsWith("// path: services/estimates/estimate-signature-fields.ts\n"), "the vocabulary starts with its path");
  expect(hasherSource.startsWith("// path: services/estimates/estimate-signature.ts\n"), "and so does the hash");

  for (const [name, source] of [
    ["estimate-signature-fields.ts", fieldsSource],
    ["estimate-signature.ts", hasherSource],
  ] as const) {
    expect(/^[\x20-\x7e\n\r\t]*$/u.test(source), `${name} is ASCII`);
  }

  // Section 16's eight elements are eight columns, because evidence kept in one JSON blob can be neither
  // constrained nor indexed nor read by the chargeback pack of section 19.
  for (const column of [
    "signer_name",
    "signer_email",
    "consent_text",
    "consent_accepted",
    "signed_at",
    "ip",
    "geo_location",
    "device_fingerprint",
    "document_hash",
  ]) {
    expect(migration.includes(`\n  ${column} `), `0027 stores ${column} as its own column`);
  }

  expect(migration.includes("\n  signature_path "), "and a drawn signature's storage key, which is a key and never an image");
  expect(migration.includes("ip inet not null"), "the address is an inet, so its shape is the type's and there is no length to restate");
  expect(migration.includes("signed_at timestamptz not null"), "and the time is a zoned timestamp in server time, not a string a client sent");
  expectEqual(ESTIMATE_SIGNATURES_TABLE, "estimate_signatures", "the table has one name in this family");
  expect(migration.includes(`create table public.${ESTIMATE_SIGNATURES_TABLE} (`), "which is the table `0027` creates");

  // The read asks for a column list, and that list has to be the table's own: a name the table does not
  // have is a query refused in production while the fixture, which builds its own rows, answers it happily.
  // `deleted_at` is the one column the read filters on rather than reads, so the two lists differ by it.
  const tableColumns = await estimateSignatureTableColumns();
  const askedColumns = ESTIMATE_SIGNATURE_COLUMNS.slice("select=".length).split(",");

  expectEqual(tableColumns.length, 18, "`0027` creates eighteen columns, counted out of the file rather than remembered");

  for (const column of askedColumns) {
    expect(tableColumns.includes(column), `the read asks for "${column}", a column \`0027\` actually has`);
  }

  for (const column of tableColumns) {
    expect(
      askedColumns.includes(column) || column === "deleted_at",
      `and "${column}" is asked for, unless it is the one column the read filters on instead`,
    );
  }

  expectEqual(askedColumns.length, tableColumns.length - 1, "so the read asks for every column but that one");

  // The two decisions and the two open statuses, read out of the CHECK and out of the trigger.
  expectDeepEqual(
    [...ESTIMATE_SIGNATURE_DECISIONS],
    [...matchOf(migration, /decision in \('([a-z]+)', '([a-z]+)'\)/u, "the decision check")],
    "the vocabulary's two decisions are the column's two",
  );
  expectDeepEqual(
    [...ESTIMATE_SIGNATURE_OPEN_STATUSES],
    [...matchOf(migration, /state is distinct from '([a-z]+)' and state is distinct from '([a-z]+)'/u, "the decision guard")],
    "and a signature is writable in exactly the two statuses the trigger names",
  );

  // Every length is the column's, extracted and compared as numbers rather than spotted in prose.
  for (const [key, column] of [
    ["signerName", "signer_name"],
    ["signerEmail", "signer_email"],
    ["consentText", "consent_text"],
    ["geoLocation", "geo_location"],
    ["signaturePath", "signature_path"],
  ] as const) {
    const bounds = boundsOf(migration, column);

    expectEqual(ESTIMATE_SIGNATURE_LIMITS[key].min, bounds.min, `${column}'s floor is the column's own`);
    expectEqual(ESTIMATE_SIGNATURE_LIMITS[key].max, bounds.max, `and so is ${column}'s ceiling`);
    expect(migration.includes(`${column} = btrim(${column})`), `${column} has to arrive trimmed, so a capture path trims before it measures`);
  }

  // The three patterns are the column's, character for character.
  expectEqual(patternOf(migration, "signer_email"), ESTIMATE_SIGNATURE_EMAIL_PATTERN.source, "the address shape is the column's");
  expectEqual(patternOf(migration, "device_fingerprint"), ESTIMATE_SIGNATURE_FINGERPRINT_PATTERN.source, "as is the fingerprint's");
  expectEqual(patternOf(migration, "document_hash"), ESTIMATE_DOCUMENT_HASH_PATTERN.source, "and the hash's");
  expectEqual(ESTIMATE_DOCUMENT_HASH_LENGTH, 64, "a stored hash is 64 characters long");
  expect(/[{]64[}]/u.test(patternOf(migration, "document_hash")), "which is the length `0027`'s own pattern states");

  // The fingerprint's numbers and its pattern have to agree with each other, or one of the two is wrong.
  const fingerprintBounds = /[{](\d+),(\d+)[}]/u.exec(ESTIMATE_SIGNATURE_FINGERPRINT_PATTERN.source);

  expectEqual(Number(fingerprintBounds?.[1]), ESTIMATE_SIGNATURE_LIMITS.deviceFingerprint.min, "the fingerprint's floor is in the limits and in the pattern alike");
  expectEqual(Number(fingerprintBounds?.[2]), ESTIMATE_SIGNATURE_LIMITS.deviceFingerprint.max, "and so is its ceiling");

  // Consent is not a boolean that may be false, so an unticked box is a missing required field.
  expect(migration.includes("constraint estimate_signatures_consent_check check (consent_accepted)"), "an unticked box cannot be stored at all");
  expect(migration.includes("consent_text = btrim(consent_text)"), "and the wording shown is stored as it was shown");

  // Append-only, one decision per quote, tenant isolated.
  expect(migration.includes("before update or delete on public.estimate_signatures"), "every update and every removal is refused by a trigger");
  expect(migration.includes("raise exception 'estimate signatures are append only'"), "with a sentence that says why");
  expect(migration.includes("create unique index estimate_signatures_estimate_key"), "one quote carries one decision");
  expect(migration.includes(`on public.${ESTIMATE_SIGNATURES_TABLE} (estimate_id)`), "which is what the unique index says");
  expect(migration.includes("foreign key (estimate_id, company_id)"), "the evidence belongs to a quote through the tenant key");
  expect(migration.includes("references public.estimates (id, company_id)"), "so it cannot be attached to another merchant's quote");
  expect(migration.includes(`alter table public.${ESTIMATE_SIGNATURES_TABLE} enable row level security`), "row level security is on");
  expect(migration.includes("using (false)") && migration.includes("with check (false)"), "and default-deny, the house pattern for this family");

  // The audit entry this family earns has to be one the audit table stores.
  expect(new RegExp(patternOf(auditMigration, "action"), "u").test(ESTIMATE_SIGNATURE_RECORDED_AUDIT_ACTION), "the audit action is a shape `0013` accepts");
  expect(new RegExp(patternOf(auditMigration, "entity_type"), "u").test(ESTIMATE_SIGNATURE_AUDIT_ENTITY), "and so is the entity it names");
  expectEqual(ESTIMATE_SIGNATURE_RECORDED_AUDIT_ACTION, "estimate.signature_recorded", "in the house entity.verb shape");
  expectEqual(ESTIMATE_SIGNATURE_AUDIT_ENTITY, "estimate_signature", "naming the evidence row rather than the quote it belongs to");

  // No new rule names, so no screen needs a second map to word a signature refusal.
  for (const rule of ESTIMATE_SIGNATURE_RULES) {
    expect((ESTIMATE_RULES as readonly string[]).includes(rule), `"${rule}" is already a rule of this family`);
  }

  expectEqual(ESTIMATE_SIGNATURE_RULES.length, 7, "and seven of them cover every refusal an evidence row can earn");

  // The vocabulary is numbers, so a browser file may import it: nothing to import, nothing to call.
  expect(!/^import /mu.test(fieldsSource), "the vocabulary imports nothing, so a browser file may use it");

  // A guard over its own list is what `estimate-fields.ts` and `invoice-fields.ts` export too, so the claim
  // is not "no function at all" but "nothing that does anything": no guard may throw, await or reach a client.
  const guardNames = [...fieldsCode.matchAll(/^export function (\w+)/gmu)].map((match) => match[1] ?? "");

  expect(guardNames.every((name) => name.startsWith("is")), "every function the vocabulary exports is a guard over one of its own lists");
  expect(guardNames.includes("isEstimateSignatureDecision"), "and one of them tells a reader whether a stored decision is one of the two");
  expect(!fieldsCode.includes("throw"), "the vocabulary throws nothing");
  expect(!fieldsCode.includes("async"), "awaits nothing");
  expect(!fieldsCode.includes("RestClient"), "and holds no database client, so a browser file may import it");
  expect(!/CONSENT_TEXT\s*=/u.test(fieldsCode), "no consent wording is a service constant, because what is stored is what was shown");

  const hashBody = functionBodyOf(hasherCode, "hashEstimateDocument");

  expect(!hashBody.includes("consent"), "and the hashing function does not choose a consent wording either");

  // The vocabulary writes nothing at all. The module around it now holds the capture, so its purity is
  // claimed of the hashing function itself rather than of the file: a claim about a file goes stale the
  // moment the file grows a second export, and "the digest is computed from a snapshot" is a claim about
  // one function and its arguments.
  expect(!fieldsCode.includes("insertReturning"), "the vocabulary writes no row");
  expect(!fieldsCode.includes("RestClient"), "and holds no database client");
  expect(!fieldsCode.includes("take_invoice_number"), "and reaches for no number");
  expect(!fieldsCode.includes("status:"), "and invents no status");

  expect(!hashBody.includes("RestClient"), "the hashing function holds no database client");
  expect(!hashBody.includes("rest."), "and reads nothing: a digest of a snapshot needs no query");
  expect(!hashBody.includes("insertReturning"), "and writes no row");
  expect(!hashBody.includes("status:"), "and invents no status");
  expect(!hashBody.includes("take_invoice_number"), "and reaches for no number");
  expect(!hasherCode.includes("invoice_number_settings"), "nothing in the module generalises \`0114\`");

  /* -- the document hash -- */

  const draft = await draftWith();
  const quote = draft.snapshot;
  const digest = hashEstimateDocument(quote);

  expect(ESTIMATE_DOCUMENT_HASH_PATTERN.test(digest), "the hash is 64 lower case hex characters, which is what the column admits");
  expectEqual(digest.length, ESTIMATE_DOCUMENT_HASH_LENGTH, "and exactly as long as the column says");
  expectEqual(hashEstimateDocument(quote), digest, "one quote hashes to one digest, every time");
  /* -- the golden pin, over a document that does not move -- */

  const pinned = signatureFixtureQuote();
  const pinnedEncoding = canonicalEstimateDocumentEncoding(pinned);
  const pinnedFields = decodeEncoding(pinnedEncoding);

  expectEqual(
    hashEstimateDocument(pinned),
    "559832bb2f137d1d9eb44f0bd5e25dea30f6b5bd4cee70dde57a208c6d7965ba",
    "the pinned quote's digest is the one this encoding has always produced",
  );
  expectEqual(hashEstimateDocument(reverseKeys(pinned) as EstimateSnapshot), hashEstimateDocument(pinned), "and it does not depend on how the snapshot was built");

  const address = at(pinnedFields.filter((field) => field.name === "client_address"), 0, "the address");
  const memo = at(pinnedFields.filter((field) => field.name === "memo"), 0, "the memo");

  expectEqual(address.value, pinned.client.address, "a two-byte character is recovered verbatim, so lengths are counted in bytes");
  expect(
    new TextEncoder().encode(address.value).length > address.value.length,
    "and the address really does hold a character that is wider than one byte, which is what makes that a test",
  );
  expectEqual(memo.value, pinned.memo, "a memo holding a colon and a pipe is recovered verbatim, so the encoding delimits itself");
  expect(memo.value.includes(":") && memo.value.includes("|"), "and the memo really does hold both");

  // A function of the document, not of how the snapshot happened to be built.
  expectEqual(hashEstimateDocument(reverseKeys(quote) as EstimateSnapshot), digest, "the snapshot's key order does not reach the digest");
  expectEqual(hashEstimateDocument({ ...quote, lines: [...quote.lines].reverse() }), digest, "nor the order the lines arrived in, because they are sorted before they are hashed");

  // Every fact about the offer is in: changing one changes the digest.
  const sensitive: readonly (readonly [string, EstimateSnapshot])[] = [
    ["which document it is", { ...quote, id: randomUUID() }],
    ["the merchant whose offer it is", { ...quote, companyId: randomUUID() }],
    ["the client it is addressed to", { ...quote, clientId: randomUUID() }],
    ["the client's name", { ...quote, client: { ...quote.client, name: "Another client" } }],
    ["the client's address", { ...quote, client: { ...quote.client, address: "Another road" } }],
    ["the address the link was sent to", { ...quote, client: { ...quote.client, email: "another@example.com" } }],
    ["how long the offer stands", { ...quote, expiresAt: "2027-01-01T00:00:00.000Z" }],
    ["what else the merchant wrote on it", { ...quote, memo: "Deposit half up front." }],
    ["a line's description", { ...quote, lines: quote.lines.map((line, index) => (index === 0 ? { ...line, description: "Another thing" } : line)) }],
    ["a line's unit", { ...quote, lines: quote.lines.map((line, index) => (index === 0 ? { ...line, unit: "day" as const } : line)) }],
    ["a line's quantity", { ...quote, lines: quote.lines.map((line, index) => (index === 0 ? { ...line, quantity: "3" } : line)) }],
    ["a line's price", { ...quote, lines: quote.lines.map((line, index) => (index === 0 ? { ...line, unitPriceMinor: "1260000" } : line)) }],
    ["a line's discount", { ...quote, lines: quote.lines.map((line, index) => (index === 0 ? { ...line, discountMinor: "10000" } : line)) }],
    ["a line's amount", { ...quote, lines: quote.lines.map((line, index) => (index === 0 ? { ...line, lineTotalMinor: "3025000" } : line)) }],
    ["the product a line quoted", { ...quote, lines: quote.lines.map((line, index) => (index === 0 ? { ...line, productId: randomUUID() } : line)) }],
    ["the service a line quoted", { ...quote, lines: quote.lines.map((line, index) => (index === 0 ? { ...line, serviceId: randomUUID() } : line)) }],
    ["the order the lines are read in", { ...quote, lines: quote.lines.map((line, index) => ({ ...line, position: quote.lines.length - index })) }],
    ["the subtotal", { ...quote, totals: { ...quote.totals, subtotalMinor: "7065001" } }],
    ["how the discount was expressed", { ...quote, totals: { ...quote.totals, discountBasis: "percent" as const, discountPercentBasisPoints: 1250, discountMinor: "883125" } }],
    ["the percentage itself", { ...quote, totals: { ...quote.totals, discountBasis: "percent" as const, discountPercentBasisPoints: 1251 } }],
    ["the discount", { ...quote, totals: { ...quote.totals, discountMinor: "100" } }],
    ["the tax", { ...quote, totals: { ...quote.totals, taxMinor: "3557001" } }],
    ["the total", { ...quote, totals: { ...quote.totals, totalMinor: "7420701" } }],
    ["how many lines it has", { ...quote, lines: quote.lines.slice(0, 2) }],
  ];

  for (const [what, changed] of sensitive) {
    expect(hashEstimateDocument(changed) !== digest, `changing ${what} changes the digest`);
  }

  // The document's lifecycle is out, so the digest survives every move that does not change the offer.
  const lifecycle: readonly (readonly [string, EstimateSnapshot])[] = [
    ["the number it was issued with", { ...quote, number: "Q-2026-0001" }],
    ["its status", { ...quote, status: "sent" as const }],
    ["why it ended", { ...quote, status: "void" as const, voidReason: "withdrawn" as const, voidedAt: "2026-11-05T00:00:00.000Z" }],
    ["when it was issued", { ...quote, issuedAt: "2026-11-05T00:00:00.000Z" }],
    ["when it was accepted", { ...quote, status: "accepted" as const, acceptedAt: "2026-11-06T00:00:00.000Z" }],
    ["the invoice it became", { ...quote, status: "accepted" as const, convertedInvoiceId: randomUUID() }],
    ["its version", { ...quote, version: quote.version + 1 }],
    ["when it was written", { ...quote, createdAtEpochMs: quote.createdAtEpochMs + 1000, updatedAtEpochMs: quote.updatedAtEpochMs + 1000 }],
    ["a line's own identity", { ...quote, lines: quote.lines.map((line) => ({ ...line, id: randomUUID() })) }],
    ["a line's version and timestamps", { ...quote, lines: quote.lines.map((line) => ({ ...line, version: line.version + 1, createdAtEpochMs: 0, updatedAtEpochMs: 0 })) }],
  ];

  for (const [what, changed] of lifecycle) {
    expectEqual(hashEstimateDocument(changed), digest, `${what} does not reach the digest`);
  }

  // A print rule is not evidence: the same stored value spelled another way is the same document.
  expectEqual(
    hashEstimateDocument({
      ...quote,
      lines: quote.lines.map((line, index) => (index === 0 ? { ...line, quantity: "2.500" } : line)),
    }),
    digest,
    "a quantity spelled 2.500 rather than 2.5 is the same quantity",
  );
  expectEqual(
    hashEstimateDocument({
      ...quote,
      lines: quote.lines.map((line) => ({ ...line, unitPrice: "0.0000", discount: "0.0000" })),
      totals: { ...quote.totals, subtotal: "0.0000", discount: "0.0000", discountPercent: "0", tax: "0.0000", total: "0.0000" },
    }),
    digest,
    "and no printed amount is hashed at all, only the minor units it prints",
  );

  // The property that makes the digest usable as evidence: issuing the quote does not change the offer.
  issue(draft.db, quote.id);

  const issued = await getEstimate({ actor: owner, estimateId: quote.id }, depsOf(draft.db));

  expectEqual(issued.status, "sent", "the fixture quote is now sent");
  expect(issued.number !== null && issued.issuedAt !== null, "with the number and the issued instant `0025` requires of a sent quote");
  expectEqual(hashEstimateDocument(issued), digest, "and issuing it changed the document's life but not its offer, so the digest stands");

  // The encoding is self-delimiting, which is the only reason a digest over concatenated text is safe.
  const joined = (name: string, memo: string): string => [name, memo].join("|");
  const left: EstimateSnapshot = { ...quote, client: { ...quote.client, name: "Acme Ltd" }, memo: "Net 14|Deposit 500" };
  const right: EstimateSnapshot = { ...quote, client: { ...quote.client, name: "Acme Ltd|Net 14" }, memo: "Deposit 500" };

  expectEqual(joined(left.client.name, left.memo ?? ""), joined(right.client.name, right.memo ?? ""), "a separator join of these two quotes is one string, which is the trap");
  expect(hashEstimateDocument(left) !== hashEstimateDocument(right), "and the length-prefixed encoding keeps them two documents");

  const forged: EstimateSnapshot = { ...quote, memo: "total_minor:I:1:0" };
  const forgedFields = decodeEncoding(canonicalEstimateDocumentEncoding(forged));

  expectEqual(forgedFields.filter((field) => field.name === "total_minor").length, 1, "a memo that spells a field header still leaves one total in the encoding");
  expectEqual(
    at(forgedFields.filter((field) => field.name === "memo"), 0, "the memo").value,
    "total_minor:I:1:0",
    "and the memo comes back verbatim",
  );

  // What the encoding carries, field by field: this is the field selection, pinned.
  const lineFieldNames = [
    "line_position",
    "line_description",
    "line_unit",
    "line_quantity_thousandths",
    "line_unit_price_minor",
    "line_discount_minor",
    "line_total_minor",
    "line_product_id",
    "line_service_id",
  ];
  const decoded = decodeEncoding(canonicalEstimateDocumentEncoding(quote));

  expectDeepEqual(
    decoded.map((field) => field.name),
    [
      "encoding",
      "estimate_id",
      "company_id",
      "client_id",
      "currency",
      "client_name",
      "client_email",
      "client_address",
      "expires_at",
      "memo",
      "line_count",
      ...quote.lines.flatMap(() => lineFieldNames),
      "subtotal_minor",
      "discount_basis",
      "discount_percent_bp",
      "discount_minor",
      "tax_minor",
      "total_minor",
    ],
    "the encoding carries exactly the offer's fields, in one fixed order",
  );
  expectEqual(at(decoded, 0, "the first field").value, ESTIMATE_DOCUMENT_HASH_ENCODING, "and its first field is the encoding's own version");
  expectEqual(at(decoded, 0, "the first field").tag, "S", "tagged as text");

  const nullable = ["client_email", "client_address", "memo", "line_product_id", "line_service_id"];

  for (const field of decoded) {
    expect(["N", "S", "I"].includes(field.tag), `every field carries a type tag, and ${field.name} does`);

    if (field.tag === "N") {
      expect(nullable.includes(field.name), `${field.name} is null, and only a field that may be null is`);
      expectEqual(field.value, "", "with an empty value, so a null and an empty string never meet");
    }

    if (field.tag === "I") {
      expect(/^\d+$/u.test(field.value), `${field.name} is an integer in decimal digits, with no sign and no point`);
    }
  }

  // The quantities are hashed in the unit the column stores, not in the spelling a screen prints.
  const quantities = decoded.filter((field) => field.name === "line_quantity_thousandths");

  expectEqual(quantities.length, quote.lines.length, "one hashed quantity per line");

  for (const field of quantities) {
    expectEqual(Number(field.value) % 1, 0, "each hashed quantity is a whole number of thousandths");
  }

  /* -- the hash module's own discipline -- */

  expect(!hasherCode.includes("parseFloat"), "the hash never parses a float");
  expect(!hasherCode.includes("JSON.stringify"), "and never leans on JSON, whose key order and number spelling are not this module's to fix");
  expect(!hasherCode.includes("toFixed("), "nor rounds with a float method");
  expect(!hasherCode.includes("Number("), "nor converts through Number");
  expect(hasherCode.includes('createHash("sha256")'), "the digest is SHA-256, which is what 64 hex characters mean");
  expect(hasherCode.includes('.digest("hex")'), "and it is printed as hex, because the column refuses anything else");
  expect(hasherCode.includes("TextEncoder"), "lengths are counted in bytes rather than in UTF-16 units, so a non-ASCII description cannot move a boundary");
  expect(hasherCode.includes("quantityToThousandths"), "a quantity is put back into thousandths before it is hashed");
  expect(!/^import /mu.test(fieldsSource) === true, "the vocabulary stays import-free");

  const hasherImports = [...hasherSource.matchAll(/^import [^"]*from "([^"]+)";$/gmu)].map((match) => match[1] ?? "");

  expectDeepEqual(
    hasherImports,
    [
      "node:crypto",
      "zod",
      "../../lib/auth/audit.ts",
      "../../lib/auth/rest.ts",
      "../../lib/auth/session.ts",
      "../../lib/auth/types.ts",
      "../../lib/errors/app-error.ts",
      "../../lib/security/audit.ts",
      "../../lib/security/rate-limit.ts",
      "../../lib/security/text.ts",
      "../invoices/invoice-totals.ts",
      "../invoices/invoices.ts",
      "./estimate-fields.ts",
      "./estimate-signature-fields.ts",
      "./estimates.ts",
    ],
    "the evidence module imports these fifteen and nothing else, in the family's own relative style",
  );
}

/* ---- the capture: one decision, written once ---- */

/**
 * What a signature capture does, and the four things it must never do.
 *
 * The capture is the whole of STEP 120: the eight elements of section 16 arrive in one row, that row is
 * written once and never edited, and the digest in it is computed here rather than believed from a caller.
 * What this group proves hardest is the absences - that a capture writes no status, mints no number, issues
 * nothing and voids nothing - because those are the boundaries this STEP was given, and a boundary is only
 * real if a test would fail when it is crossed.
 */
async function checkCapture(): Promise<void> {
  const signatureSource = await readRepositoryFile("services/estimates/estimate-signature.ts");
  const signatureCode = sourceCodeOf(signatureSource);

  /* -- what the module never does -- */

  expect(!signatureCode.includes("rest.update"), "the capture updates no row, because `0027` is append only");
  expect(!signatureCode.includes("rest.delete"), "and removes none, for the same reason");
  expect(!signatureCode.includes("rest.insert("), "every write reads the row back, so there is no fire-and-forget insert");
  expect(!signatureCode.includes("take_invoice_number"), "it reaches for no number");
  expect(!signatureCode.includes("invoice_number_settings"), "and does not generalise `0114`");
  expect(!signatureCode.includes("issued_at"), "it never writes the instant a quote was issued");
  expect(!signatureCode.includes("status:"), "and it never writes a status");
  expect(signatureCode.includes("ESTIMATE_SIGNATURE_OPEN_STATUSES"), "it requires an open quote instead of making one");

  /* -- the parser, element by element -- */

  const issued = await openQuoteWith();
  const parsed = parseEstimateSignatureCapture(signatureBodyOf(issued.snapshot.id));

  expectEqual(parsed.signerName, "Rina Akter", "a signer's name is stored as it was given");
  expectEqual(parsed.signerEmail, "rina@buyer.example", "and so is the address the receipt would go to");
  expectEqual(parsed.decision, "accepted", "with the decision the signer made");
  expectEqual(parsed.consentText, "I have read this quote and I accept its terms.", "and the wording they consented to");
  expectEqual(parsed.ip, "203.0.113.44", "and the address the decision arrived from");
  expectEqual(parsed.geoLocation, "Dhaka, BD", "and where that address is");
  expectEqual(parsed.deviceFingerprint, "fp-9f2c41ab7d05", "and the device it arrived on");

  const trimmed = parseEstimateSignatureCapture(
    signatureBodyOf(issued.snapshot.id, { signer_name: "  Rina Akter  ", geo_location: "  Dhaka, BD  " }),
  );

  expectEqual(trimmed.signerName, "Rina Akter", "surrounding space is trimmed rather than refused");
  expectEqual(trimmed.geoLocation, "Dhaka, BD", "in a place as well as in a name");

  const v6 = parseEstimateSignatureCapture(signatureBodyOf(issued.snapshot.id, { ip_address: "2001:0DB8:0000::0001" }));

  expectEqual(v6.ip, "2001:db8::1", "an IPv6 address is stored in one compressed spelling, so one machine is one address");
  expectEqual(
    parseEstimateSignatureCapture(signatureBodyOf(issued.snapshot.id, { user_agent: "   " })).userAgent,
    null,
    "an agent that was only ever space becomes null, which the column and the chain both accept",
  );
  expectEqual(
    parseEstimateSignatureCapture(signatureBodyOf(issued.snapshot.id, { user_agent: "x".repeat(600) })).userAgent?.length,
    AUDIT_MAXIMUM_USER_AGENT_LENGTH,
    "and a long one is cut to the audit chain's own ceiling, so the entry is never one the chain would refuse",
  );

  // Refused rather than repaired: an element outside its column is a sentence, never a quiet edit.
  const elements: readonly [string, Record<string, unknown>, string, string][] = [
    ["signer_name", { signer_name: "" }, "too_short", "a name of nothing"],
    ["signer_name", { signer_name: "n".repeat(161) }, "too_long", "a name longer than the column"],
    ["signer_name", { signer_name: "Rina\nAkter" }, "invalid_format", "a name holding a line break"],
    ["signer_email", { signer_email: "a@" }, "too_short", "an address shorter than the column"],
    ["signer_email", { signer_email: `${"a".repeat(250)}@b.example` }, "too_long", "an address longer than the column"],
    ["signer_email", { signer_email: "rina at buyer.example" }, "invalid_format", "an address that is not one"],
    ["consent_text", { consent_text: "   " }, "required", "a consent of nothing"],
    ["consent_text", { consent_text: `${"I accept. ".repeat(210)}` }, "too_long", "a consent longer than the column"],
    ["consent_text", { consent_text: "I accept. " }, "invalid_format", "a consent the column would store trimmed"],
    ["ip_address", { ip_address: "not-an-address" }, "invalid_format", "an address that is not one"],
    ["ip_address", { ip_address: "203.0.113.44:8080" }, "invalid_format", "an address carrying a port"],
    ["ip_address", { ip_address: "" }, "invalid_format", "an address of nothing"],
    ["geo_location", { geo_location: "g".repeat(201) }, "too_long", "a place longer than the column"],
    ["device_fingerprint", { device_fingerprint: "fp-9f2c" }, "too_short", "a fingerprint shorter than the column"],
    ["device_fingerprint", { device_fingerprint: "f".repeat(129) }, "too_long", "a fingerprint longer than the column"],
    ["device_fingerprint", { device_fingerprint: "fp 9f2c41ab" }, "invalid_format", "a fingerprint holding a space"],
    ["signature_path", { signature_path: "s".repeat(301) }, "too_long", "a storage key longer than the column"],
  ];

  for (const [field, overrides, rule, what] of elements) {
    const details = await refusalOf(() =>
      Promise.resolve(parseEstimateSignatureCapture(signatureBodyOf(issued.snapshot.id, overrides))),
    );

    expectDeepEqual(details, [{ field, rule }], `${what} is refused as ${rule} on ${field}`);
  }

  expectDeepEqual(
    await refusalOf(() => Promise.resolve(parseEstimateSignatureCapture(signatureBodyOf(issued.snapshot.id, { consent_accepted: false })))),
    [{ field: "consent_accepted", rule: "required" }],
    "an unticked box is not consent, and `0027` would not store one either",
  );

  // The digest is computed, never accepted: this is the refusal that makes the column mean anything.
  expectDeepEqual(
    await refusalOf(() =>
      Promise.resolve(parseEstimateSignatureCapture(signatureBodyOf(issued.snapshot.id, { document_hash: "a".repeat(64) }))),
    ),
    [{ field: "document_hash", rule: "unknown_field" }],
    "a caller offering a digest of its own is refused with the key it offered",
  );
  expectDeepEqual(
    await refusalOf(() =>
      Promise.resolve(
        parseEstimateSignatureCapture(signatureBodyOf(issued.snapshot.id, { status: "accepted", signed_at: "2020-01-01T00:00:00.000Z" })),
      ),
    ),
    [
      { field: "status", rule: "unknown_field" },
      { field: "signed_at", rule: "unknown_field" },
    ],
    "and neither a status nor an instant of the caller's choosing is a key it may send",
  );
  expectDeepEqual(
    await refusalOf(() => Promise.resolve(parseEstimateSignatureCapture(signatureBodyOf(issued.snapshot.id, {})))),
    [],
    "so the instant a signature carries is the platform's clock and never a body's",
  );
  expectDeepEqual(
    await refusalOf(() => Promise.resolve(parseEstimateSignatureCapture(null))),
    [{ field: "estimate_signature", rule: "invalid_format" }],
    "a body that is not an object at all is named as the document, because there is no field to name",
  );
  expect(!estimateSignatureCaptureSchema.safeParse(signatureBodyOf(issued.snapshot.id, { consent_text: undefined })).success, "a missing element is a refusal");

  // Two wrong elements are both named, in the order a signer meets the boxes.
  expectDeepEqual(
    await refusalOf(() =>
      Promise.resolve(
        parseEstimateSignatureCapture(
          signatureBodyOf(issued.snapshot.id, { consent_accepted: false, signer_email: "not an address", device_fingerprint: "x" }),
        ),
      ),
    ),
    [
      { field: "signer_email", rule: "invalid_format" },
      { field: "consent_accepted", rule: "required" },
      { field: "device_fingerprint", rule: "too_short" },
    ],
    "several refusals arrive together, ordered as the boxes are on the page",
  );

  /* -- one decision, written once -- */

  const audit = createInMemoryAuditTrail();
  const insertsBefore = issued.db.inserts.length;
  const queriesBefore = issued.db.queries.length;
  const stored = await captureEstimateSignature(signatureBodyOf(issued.snapshot.id), depsOf(issued.db, audit));

  expectEqual(issued.db.signatures.length, 1, "the capture wrote exactly one evidence row");
  expectEqual(issued.db.inserts.length - insertsBefore, 1, "in exactly one insert of its own");
  expectEqual(issued.db.inserts.at(-1)?.table, ESTIMATE_SIGNATURES_TABLE, "and that insert was of `0027`'s table");
  expectEqual(issued.db.updates.length, 0, "with no update anywhere: the quote is untouched and the evidence is append only");

  expectDeepEqual(
    issued.db.queries.slice(queriesBefore).map((query) => query.split("?")[0] ?? ""),
    ["estimates", "estimate_signatures", "estimate_items"],
    "three reads of its own, in the order they are needed: is this quote open, has it been decided, what does it offer",
  );

  const row = issued.db.signatures[0] as Readonly<Record<string, unknown>>;

  expectEqual(row["signer_name"], "Rina Akter", "the row holds the signer's name");
  expectEqual(row["signer_email"], "rina@buyer.example", "their address");
  expectEqual(row["consent_text"], "I have read this quote and I accept its terms.", "the wording they were shown");
  expectEqual(row["consent_accepted"], true, "the ticked box itself");
  expectEqual(row["signed_at"], new Date(NOW).toISOString(), "the instant, from the platform's clock");
  expectEqual(row["ip"], "203.0.113.44", "the address it arrived from");
  expectEqual(row["geo_location"], "Dhaka, BD", "where that address is");
  expectEqual(row["device_fingerprint"], "fp-9f2c41ab7d05", "the device it arrived on");
  expectEqual(row["document_hash"], hashEstimateDocument(issued.snapshot), "and the digest of the offer, which is the same digest the draft had");
  expectEqual(row["version"], 1, "at version one, which is the only version an append-only row ever has");
  expectEqual(row["company_id"], COMPANY_A, "scoped to the merchant it belongs to");
  expectEqual(row["estimate_id"], issued.snapshot.id, "and to the quote's own stable id");

  // Every key the service sent, and every key the fixture stored, has to be a column the table has. The
  // fixture supplies its own defaults, so an invented key would sit in the stored row unnoticed here and
  // refuse the whole statement in production - a capture that fails only where it matters.
  const columns = await estimateSignatureTableColumns();
  const sent = issued.db.inserts.at(-1)?.rows[0] ?? {};

  expect(Object.keys(sent).length > 0, "the insert sent a row");

  for (const key of Object.keys(sent)) {
    expect(columns.includes(key), `the insert sends "${key}", a column \`0027\` actually has`);
  }

  for (const key of Object.keys(row)) {
    expect(columns.includes(key), `and the stored row's "${key}" is one too, so the fixture invents no column of its own`);
  }

  expect(!Object.keys(sent).includes("id"), "the id is the column's own default, not a value the service picks");
  expect(!Object.keys(sent).includes("version"), "and so is the version, which an append-only row never moves off one");

  expectEqual(stored.decision, "accepted", "the caller gets the decision back");
  expectEqual(stored.documentHash, String(row["document_hash"] ?? ""), "with the digest it stored");
  expectEqual(stored.signedAtEpochMs, NOW, "and the instant as an epoch, the way every other snapshot in this family carries one");
  expect(!("version" in stored), "but no version, because an append-only row offers no lock and printing one invites an edit the trigger refuses");

  // The quote the signature was written against is exactly the quote that was there before.
  const quoteRow = rowOf(issued.db, issued.snapshot.id);

  expectEqual(quoteRow["status"], "sent", "the capture wrote no status");
  expectEqual(quoteRow["number"], "Q-2026-0001", "minted no number");
  expectEqual(quoteRow["issued_at"], new Date(NOW).toISOString(), "and moved no instant of the quote's own lifecycle");
  expectEqual(quoteRow["accepted_at"], null, "an accepted signature does not accept the quote: that is STEP 121's");
  expectEqual(quoteRow["converted_invoice_id"], null, "and it creates no invoice");
  expectEqual(quoteRow["version"], Number(issued.snapshot.version), "with the quote's version exactly where it was");

  expectEqual(audit.entries.length, 1, "one audit entry, because one fact happened");
  const entry = audit.entries[0];

  if (entry === undefined) {
    throw new Error("gate fixture: the capture earned no audit entry");
  }

  expectEqual(entry.action, ESTIMATE_SIGNATURE_RECORDED_AUDIT_ACTION, "naming the action `0013` admits");
  expectEqual(entry.entityType, ESTIMATE_SIGNATURE_AUDIT_ENTITY, "and the entity it names");
  expectEqual(entry.entityId, stored.id, "pointing at the evidence row rather than at the quote");
  expectEqual(entry.actorUserId, null, "with no actor, because a client holds no account here");
  expectEqual(entry.companyId, COMPANY_A, "in the merchant's own chain");
  expectEqual(entry.ipAddress, stored.ip, "carrying the same address the evidence row carries, in the same spelling");
  expectEqual(entry.userAgent, "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36", "and the agent the decision arrived with");
  expectDeepEqual(
    entry.payload,
    {
      decision: "accepted",
      document_hash: stored.documentHash,
      consent_accepted: true,
      has_geo_location: true,
      has_device_fingerprint: true,
      has_signature_path: false,
    },
    "a payload of field facts and the digest",
  );

  const payloadText = JSON.stringify(entry.payload);

  for (const personal of ["Rina Akter", "rina@buyer.example", "Dhaka, BD", "fp-9f2c41ab7d05"]) {
    expect(!payloadText.includes(personal), `the chain holds no "${personal}": personal data lives in the one table section 16 built for it`);
  }

  // The in-memory trail pushes whatever it is handed, so it cannot refuse an entry the real chain would -
  // and `appendTolerated` swallows a refusal, which makes an invalid entry the one failure nobody sees: the
  // evidence would be stored with no link beside it, and the gap would only ever show up in a dispute. So
  // the entry is handed to the platform's own validator and then through the door that redacts and freezes
  // it, which is exactly what production runs.
  expectEqual(auditEntryProblem(entry), null, "the entry the capture produced is one the platform's own validator writes");

  // `buildAuditEntry` throws rather than returning a refusal, so it is called inside a try: an entry the
  // chain would refuse has to arrive as one more legible failure, not as a crash that swallows every
  // failure recorded before it.
  let chained: ReturnType<typeof buildAuditEntry> | null = null;

  try {
    chained = buildAuditEntry(entry);
  } catch {
    chained = null;
  }

  if (chained === null) {
    expect(false, "and the chain's own door accepts it, which is where the payload is redacted and frozen");

    return;
  }

  expectDeepEqual(chained.payload, entry.payload, "and the chain's redaction leaves every fact intact, the digest among them");
  expectEqual(chained.ipAddress, entry.ipAddress ?? null, "the address survives the chain's own canonicalisation unchanged, because it was already the canonical spelling");
  expectEqual(chained.userAgent, entry.userAgent ?? null, "as does the agent, which the service had already cut to the chain's ceiling");
  expectEqual(chained.action, entry.action, "and the action");
  expectEqual(chained.actorUserId, null, "while an entry with no actor stays an entry with no actor");
  expectEqual(chained.entityId, entry.entityId, "still pointing at the evidence row");
  expectEqual(chained.companyId, COMPANY_A, "and still in the merchant's chain");
  expect(auditPayloadBytes(entry.payload) < AUDIT_MAXIMUM_PAYLOAD_BYTES, "with a payload far inside the ceiling `audit_logs_payload_check` measures");

  /* -- what a capture refuses -- */

  for (const [status, extra, what] of [
    ["draft", {}, "a draft"],
    ["accepted", { accepted_at: new Date(NOW).toISOString() }, "an accepted quote"],
    ["void", { void_reason: "declined", voided_at: new Date(NOW).toISOString() }, "a void one"],
  ] as const) {
    const closed = await draftWith({ lines: threeLines() });

    if (status !== "draft") {
      issue(closed.db, closed.snapshot.id);
    }

    const target = rowOf(closed.db, closed.snapshot.id);

    target["status"] = status;

    for (const [column, value] of Object.entries(extra)) {
      target[column] = value;
    }

    const trail = createInMemoryAuditTrail();
    const attempted = closed.db.inserts.length;

    expectDeepEqual(
      await refusalOf(() => captureEstimateSignature(signatureBodyOf(closed.snapshot.id), depsOf(closed.db, trail))),
      [{ field: "status", rule: "already_changed" }],
      `${what} accepts no signature, and says so with the field a screen can mark`,
    );
    expectEqual(closed.db.signatures.length, 0, `${what} was left with no evidence row`);
    expectEqual(closed.db.inserts.length - attempted, 0, "and no insert was even attempted: the service checks before it writes");
    expectEqual(trail.entries.length, 0, "and earned no entry in the chain");
  }

  const viewed = await draftWith({ lines: threeLines() });

  issue(viewed.db, viewed.snapshot.id);
  rowOf(viewed.db, viewed.snapshot.id)["status"] = "viewed";

  expectEqual(
    (await captureEstimateSignature(signatureBodyOf(viewed.snapshot.id), depsOf(viewed.db))).decision,
    "accepted",
    "a quote the client has opened accepts a signature exactly as a sent one does",
  );

  const declined = await draftWith({ lines: threeLines() });

  issue(declined.db, declined.snapshot.id);
  await captureEstimateSignature(signatureBodyOf(declined.snapshot.id, { decision: "declined" }), depsOf(declined.db));

  expectEqual(declined.db.signatures[0]?.["decision"], "declined", "a refusal is recorded as the decision it is");
  expectEqual(rowOf(declined.db, declined.snapshot.id)["status"], "sent", "and voids nothing: turning a declined quote void is STEP 182's");
  expectEqual(rowOf(declined.db, declined.snapshot.id)["void_reason"], null, "so no reason is written either");

  const missing = await openQuoteWith();

  expectEqual(
    await codeOf(() => captureEstimateSignature(signatureBodyOf(randomUUID()), depsOf(missing.db))),
    "RESOURCE_NOT_FOUND",
    "a quote that is not there is a missing quote",
  );
  expectEqual(
    await refusalReason(() => captureEstimateSignature(signatureBodyOf(randomUUID()), depsOf(missing.db))),
    "not_found",
    "named as one rather than as a validation failure",
  );
  expectEqual(
    await codeOf(() => captureEstimateSignature(signatureBodyOf(missing.snapshot.id, { company_id: COMPANY_B }), depsOf(missing.db))),
    "RESOURCE_NOT_FOUND",
    "and a quote at another merchant is missing too, never somebody else's document",
  );
  expectEqual(missing.db.signatures.length, 0, "with nothing written by any of those refusals");

  const decided = await openQuoteWith();
  const first = await captureEstimateSignature(signatureBodyOf(decided.snapshot.id), depsOf(decided.db));

  expectDeepEqual(
    await refusalOf(() =>
      captureEstimateSignature(
        signatureBodyOf(decided.snapshot.id, { signer_name: "Someone Else", signer_email: "other@buyer.example" }),
        depsOf(decided.db),
      ),
    ),
    [{ field: "estimate_id", rule: "already_used" }],
    "one quote holds one decision, and a second signer is told the quote is taken",
  );
  expectEqual(decided.db.signatures.length, 1, "so there is still exactly one row");
  expectEqual(decided.db.signatures[0]?.["signer_name"], "Rina Akter", "and it is still the first signer's");
  expectEqual(first.id, String(decided.db.signatures[0]?.["id"] ?? ""), "the row the first decision wrote");

  const racing = await openQuoteWith();

  racing.db.signatureConflict = true;

  expectDeepEqual(
    await refusalOf(() => captureEstimateSignature(signatureBodyOf(racing.snapshot.id), depsOf(racing.db))),
    [{ field: "estimate_id", rule: "already_used" }],
    "two signers arriving at once meet the unique index, which the service words rather than passes through bare",
  );
  expectEqual(racing.db.signatures.length, 0, "and only one of them is stored");

  /* -- the fixture models `0027`'s own trigger, so the service's check is not the only guard -- */

  const unissued = await draftWith({ lines: threeLines() });
  const bareInsert = {
    company_id: COMPANY_A,
    estimate_id: unissued.snapshot.id,
    decision: "accepted",
    signer_name: "Rina Akter",
    signer_email: "rina@buyer.example",
    consent_text: "I accept.",
    consent_accepted: true,
    signed_at: new Date(NOW).toISOString(),
    ip: "203.0.113.44",
    document_hash: "a".repeat(ESTIMATE_DOCUMENT_HASH_LENGTH),
  };

  expectEqual(
    await refusalReason(() =>
      depsOf(unissued.db).rest.insertReturning(ESTIMATE_SIGNATURES_TABLE, [bareInsert], estimateSignatureRowSchema),
    ),
    "estimate_signatures_guard_decision",
    "a write straight to the table is refused by the trigger the fixture models, not only by the service",
  );
  expectEqual(unissued.db.signatures.length, 0, "and it left no row behind");

  // Against an open quote the trigger is satisfied, so the same straight write reaches the columns - which
  // is the point of modelling them: a service that let one of these through would still not store it.
  const guarded = await openQuoteWith();
  const straight = (overrides: Readonly<Record<string, unknown>>): (() => Promise<unknown>) => () =>
    depsOf(guarded.db).rest.insertReturning(
      ESTIMATE_SIGNATURES_TABLE,
      [{ ...bareInsert, estimate_id: guarded.snapshot.id, ...overrides }],
      estimateSignatureRowSchema,
    );

  expectEqual(await refusalReason(straight({ consent_accepted: false })), "estimate_signatures_consent_check", "an unticked box is the column's refusal as well as the parser's");
  expectEqual(await refusalReason(straight({ document_hash: "not a digest" })), "estimate_signatures_hash_check", "and so is a digest of the wrong shape");
  expectEqual(await refusalReason(straight({ signer_name: "  Rina Akter  " })), "estimate_signatures_signer_name_check", "and a name the column would store trimmed, which is why the service refuses rather than repairs");
  expectEqual(await refusalReason(straight({ decision: "maybe" })), "estimate_signatures_decision_check", "and a third decision");
  expectEqual(guarded.db.signatures.length, 0, "with no row written by any of them");
  expectEqual(await refusalReason(straight({})), null, "while the same row, whole and honest, is stored");
  expectEqual(guarded.db.signatures.length, 1, "as exactly one evidence row");

  /* -- the reader -- */

  const reading = await openQuoteWith();
  const readTrail = createInMemoryAuditTrail();

  expectEqual(
    await readEstimateSignature({ actor: owner, estimateId: reading.snapshot.id }, depsOf(reading.db, readTrail)),
    null,
    "an undecided quote reads as null rather than as a missing resource, because undecided is the normal state of a quote",
  );
  expectEqual(readTrail.entries.length, 0, "and a read earns no entry in the chain");

  const written = await captureEstimateSignature(signatureBodyOf(reading.snapshot.id), depsOf(reading.db, readTrail));
  const read: EstimateSignatureSnapshot | null = await readEstimateSignature(
    { actor: owner, estimateId: reading.snapshot.id },
    depsOf(reading.db, readTrail),
  );

  expectDeepEqual(read, written, "what was written is what is read back, element for element");
  expectEqual(readTrail.entries.length, 1, "so the reads added nothing to the one entry the capture earned");
  expect(
    reading.db.queries.filter((query) => query.startsWith(ESTIMATE_SIGNATURES_TABLE)).every((query) => (query.split("?")[1] ?? "").includes("company_id=eq.")),
    "and every read of the evidence is scoped to one merchant",
  );
  // The string the fixture records is the string the real client puts after its `?`, so this is the shape
  // PostgREST would actually receive: a read with no `select=` is not a named column list but every column,
  // and the difference is invisible to a fixture that answers from its own rows.
  expect(
    reading.db.queries
      .filter((query) => query.startsWith(ESTIMATE_SIGNATURES_TABLE))
      .every((query) => (query.split("?")[1] ?? "").startsWith("select=")),
    "and every read of the evidence asks PostgREST for a named column list, never for every column",
  );

  expectEqual(
    await codeOf(() => readEstimateSignature({ actor: owner, estimateId: randomUUID() }, depsOf(reading.db))),
    "RESOURCE_NOT_FOUND",
    "a quote that is not there is still a missing quote, never a null that looks unsigned",
  );
  expectEqual(
    await codeOf(() => readEstimateSignature({ actor: otherOwner, estimateId: reading.snapshot.id }, depsOf(reading.db))),
    "RESOURCE_NOT_FOUND",
    "and another merchant's owner finds nothing at all",
  );
  expectEqual(
    await codeOf(() => readEstimateSignature({ actor: desk, estimateId: reading.snapshot.id }, depsOf(reading.db))),
    "PERMISSION_DENIED",
    "a role that may not manage quotes is refused before any read happens",
  );

  /* -- the row shape and the reader that validates it -- */

  expectDeepEqual(
    ESTIMATE_SIGNATURE_COLUMNS.slice("select=".length).split(","),
    Object.keys(estimateSignatureRowSchema.shape),
    "the columns a read asks for are exactly the columns the reader validates, so neither can drift alone",
  );
  expect(!ESTIMATE_SIGNATURE_COLUMNS.includes("number"), "and they include no number, because the evidence is not a document");

  const storedRow = reading.db.signatures[0] as Readonly<Record<string, unknown>>;

  expect(estimateSignatureRowSchema.safeParse(storedRow).success, "a stored row passes the reader's own schema");
  expect(!estimateSignatureRowSchema.safeParse({ ...storedRow, document_hash: "nope" }).success, "and a row with a malformed digest does not");
  expect(!estimateSignatureRowSchema.safeParse({ ...storedRow, ip: "" }).success, "nor one with no address");

  // A third decision is a row the column admits and the vocabulary does not, so it can only arrive from a
  // database that has been changed behind this build's back.
  const alien = estimateSignatureRowSchema.parse({ ...storedRow, decision: "maybe" });

  expectEqual(
    await codeOf(() => Promise.resolve(estimateSignatureSnapshotOf(alien))),
    "INTERNAL_ERROR",
    "a decision outside the two `0027` admits is an internal failure",
  );
  expectDeepEqual(
    await refusalOf(() => Promise.resolve(estimateSignatureSnapshotOf(alien))),
    [{ field: "decision", rule: "invalid_format" }],
    "named with a field and a rule, because guessing which of the two a signer made would be a lie",
  );
}

/* ---- the read side: one route and one panel ---- */

/**
 * STEP 120's read side, and the claim that it is read only.
 *
 * The capture has no route and this group proves it stays that way: nothing here exports a mutation, and
 * the panel offers no control, because `0027` refuses an update and a delete and a button that can only
 * fail is worse than no button. What the group proves hardest is the third state - a read that failed is
 * not an absence - because collapsing the two is how an outage becomes a merchant believing a client's
 * decision was lost, and believing it in a dispute.
 */
async function checkEvidence(): Promise<void> {
  const routePath = "app/api/estimates/[id]/signature/route.ts";
  const panelPath = "app/(dashboard)/estimates/estimate-signature-panel.tsx";
  const routeSource = await readRepositoryFile(routePath);
  const panelSource = await readRepositoryFile(panelPath);
  const route = sourceCodeOf(routeSource);
  const panel = sourceCodeOf(panelSource);
  const screens = sourceCodeOf(await readRepositoryFile("app/(dashboard)/estimates/estimate-screens.tsx"));

  /* -- the route reads, and nothing in this build writes -- */

  expect(route.includes("export const GET"), "the evidence route answers a GET");

  for (const verb of ["POST", "PATCH", "PUT", "DELETE"]) {
    expect(!route.includes(`export const ${verb}`), `and it exports no ${verb}: nothing in this build can record or remove a decision`);
  }

  expect(!route.includes("captureEstimateSignature"), "the route does not reach the capture, so no merchant session can write evidence");
  expect(route.includes("readEstimateSignature("), "it reads through the service that owns the evidence");
  expect(route.includes("readRequestActor("), "and the session decides who is asking");
  expect(
    !/searchParams[.]get\(["']company|body[.]company|params[.]company|headers[.]get\(["']x-company/u.test(route),
    "the company comes from the session and never from the request",
  );
  expect(route.includes("decodeURIComponent("), "the id is decoded, so two spellings of one id read one document");
  expect(route.includes("status: 200"), "an undecided quote answers 200 with a null rather than a 404");
  expect(!route.includes("parseFloat") && !route.includes("Number("), "the route does no arithmetic of its own");
  expect(!route.includes("logger."), "and a read earns no log line: rule 9 is about writes");

  /* -- the panel holds no control -- */

  expect(!panelSource.includes('"use client"'), "the panel is not a client component, because it holds no box and no click");

  for (const control of ["<button", "<form", "<input", "<select", "<textarea", "useState", "onClick", "fetch("]) {
    expect(!panel.includes(control), `the panel offers no ${control === "fetch(" ? "request of its own" : control}: an append-only record has nothing to submit`);
  }

  /* -- three states, and the third is not the first -- */

  for (const kind of ["none", "recorded", "unreadable"]) {
    expect(countOf(panel, `state.kind === "${kind}"`) === 1, `the panel words "${kind}" once, as its own state`);
  }

  expect(
    panel.indexOf('state.kind === "unreadable"') < panel.indexOf('role="alert"'),
    "and a read that failed is an alert rather than a quiet empty box",
  );
  expect(panel.includes("signatureUnreadable"), "worded as a failure to read, never as an absence");
  expect(panel.includes("signatureNone"), "with a separate sentence for a quote nobody has decided");

  /* -- the eight elements of section 16, printed -- */

  for (const element of [
    "signerName",
    "signerEmail",
    "consentText",
    "signedAt",
    "ip",
    "geoLocation",
    "deviceFingerprint",
    "documentHash",
  ]) {
    expect(panel.includes(`state.signature.${element}`), `the panel prints the record's ${element}`);
  }

  expect(panel.includes("state.signature.decision"), "and the decision itself");
  expect(countOf(panel, "state.signature.signaturePath") === 1, "while a storage key is compared and never printed");
  expect(!/documentHash[.]slice|documentHash[.]substring/u.test(panel), "the digest is never truncated to fit a column");
  expect(panel.includes("break-all font-mono"), "it is wrapped in a monospace face instead, so a merchant can check it against a stored row");
  expect(panel.includes("valueOrAbsent("), "and an element that was not captured is named as absent rather than left blank");

  /* -- the screen reads the evidence on the server, tolerantly -- */

  expect(screens.includes("signatureStateOf("), "the screen reads the evidence beside the quote, on the server");
  expect(countOf(screens, "readEstimateSignature(") === 1, "through the service, once");
  expect(screens.includes('kind: "unreadable"'), "and it can answer that the read failed");
  expect(!screens.includes("/signature"), "so the page never fetches the route: the session's scope stays on the server");
  expect(
    screens.indexOf("<EstimateLineEditor") < screens.indexOf("<EstimateSignaturePanel"),
    "the evidence sits under the lines, which are what the merchant came to work on",
  );
}

/* ---- the run ---- */

async function run(): Promise<void> {
  await checkVocabulary();
  await checkCreate();
  await checkDiscount();
  await checkValidation();
  await checkConflict();
  await checkTenancy();
  await checkBoundaries();
  await checkLines();
  await checkRoutes();
  await checkCompensation();
  await checkSources();
  await checkSignature();
  await checkCapture();
  await checkUi();
  await checkEvidence();
  await checkMigration();

  if (failures.length > 0) {
    process.stderr.write(`estimate gate failed with ${String(failures.length)} problem(s):\n`);

    for (const failure of failures) {
      process.stderr.write(`  - ${failure}\n`);
    }

    process.exitCode = 1;

    return;
  }

  process.stdout.write(
    `estimate gate passed: ${String(checks)} checks, 0025/0026/0027/0117, draft only, ` +
      `${String(INVOICE_MAXIMUM_LINES)} lines, both discount bases, add/edit/remove/move, ` +
      "8 routes, one parser and one swap for one document family, the two screens that use them, " +
      "the signature evidence vocabulary with its document hash, the append-only capture that writes it, " +
      "and the read-only panel that shows it\n",
  );
}

await run();
