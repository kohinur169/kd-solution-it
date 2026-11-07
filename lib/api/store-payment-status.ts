// path: lib/api/store-payment-status.ts
import { z } from "zod";
import type { AuditEntry, AuditTrail } from "../auth/audit.ts";
import type { RestClient } from "../auth/rest.ts";
import { AppError } from "../errors/app-error.ts";
import {
  API_PAYMENT_ENTITY,
  API_PAYMENT_OBJECT,
  API_PAYMENT_TABLES,
  API_PAYMENTS_PATH,
  type ApiPaymentMethod,
} from "./payment-fields.ts";
import type { ApiPrincipal } from "./public-fields.ts";

/**
 * Section 20's second store call: the status of one payment, read by the store that made it.
 *
 * ## Why this endpoint exists at all
 *
 * `POST /payments` (STEP 203) answers `pending`, because a card is charged later, on the provider's own hosted
 * fields. The store therefore has to ask again - and asking again means an endpoint with a contract, rather than
 * a table the store is trusted to read. A checkout that never learned the outcome is a checkout with an unpaid
 * order behind it.
 *
 * ## What the answer is, and what it is not
 *
 * The payment's own identity and its money: what state it is in, what was charged, what has been returned, in
 * which mode, by which method, and when the row last moved. Not the provider's transaction id, not the processor's
 * failure sentence, not the card brand or its last four, not the fee the platform kept and not the merchant's own
 * company id. A store needs to know whether to ship and whether to refund; everything else is the platform's record
 * of a transaction the store did not perform.
 *
 * The state is served **fresh** on every call: rule 17 asks for caching of public and summary data, and a payment
 * status is neither. The pipeline already answers `cache-control: no-store`, and the gate pins that a second call
 * reads the row again rather than replaying a body the way STEP 203 deliberately does.
 *
 * ## What a caller can learn by asking
 *
 * Three refusals, and their wording is the whole of the surface's information policy:
 *
 *   - `422 payment_id_malformed` - the id is not a UUID. It costs no query and tells a developer that their own
 *     id is wrong, which is the one case where the answer is about the request rather than the platform.
 *   - `404 payment_not_found` - the id is a UUID and it is not a store payment of this merchant, in this
 *     credential's mode, that is still alive. An unknown id, another merchant's id, a test payment asked for with a
 *     live key, an invoice payment and a deleted payment are **one** answer, because telling them apart is telling
 *     a stranger which of their guesses was close.
 *
 * ## Why a refused read is in the chain and a served one is not
 *
 * STEP 202's pipeline writes one `api.call` entry per call, and that entry already carries the route, the status,
 * the mode and the tail of the key. A successful read needs nothing more: a store polls, and a chain entry per poll
 * would turn a five second poll into a write amplifier for a decision nobody made.
 *
 * A **refused** read is different: it names a payment the caller was not entitled to see, and an id being probed
 * is exactly the thing to be able to read back later. So `api.payment_read_refused` is written with the id (only
 * when it is a well formed one), the mode and the credential, and it is written best effort - a refusal is
 * refused whether or not the chain can be written.
 */

/** The route a status call is counted and recorded under: the template, so one endpoint is one bucket. */
export const API_PAYMENT_STATUS_ROUTE = `${API_PAYMENTS_PATH}/{id}`;

/** Where a store reads one payment. `API_PAYMENT_STATUS_ROUTE` is the same path with its parameter unbound. */
export function paymentStatusPathOf(paymentId: string): string {
  return `${API_PAYMENTS_PATH}/${encodeURIComponent(paymentId)}`;
}

/**
 * What a payment id looks like, in the case the platform writes them.
 *
 * Lower case only: `payments.id` is a UUID v7 generated in the database, so an upper case id is not a
 * differently-cased version of a real one, it is a string that cannot match. Refusing it here saves a query and
 * makes the refusal about the request rather than the row.
 */
export const API_PAYMENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** The longest id this endpoint will look at. A UUID is 36 characters; the rest is a bounded refusal. */
export const API_PAYMENT_ID_MAXIMUM_LENGTH = 64;

/** The field a refusal names: the path's parameter, not a body field, because there is no body. */
export const API_PAYMENT_STATUS_FIELD = "id";

/** The two reasons a status read is refused. */
export const API_PAYMENT_STATUS_RULES = Object.freeze({
  malformed: "payment_id_malformed",
  notFound: "payment_not_found",
} as const);

/**
 * Every state a payment can be in, from `payments_status_check`.
 *
 * The list is the schema's, in the schema's order, and the gate reads the migration to prove it. A state that
 * arrives in the database before this file knows it would fail the row schema rather than reach a store as an
 * unknown word - a loud failure at the seam, which is the right place for it.
 */
export const API_STORE_PAYMENT_STATUSES = Object.freeze([
  "pending",
  "authorized",
  "captured",
  "settled",
  "failed",
  "voided",
  "partially_refunded",
  "refunded",
  "under_review",
] as const);

export type ApiStorePaymentStatus = (typeof API_STORE_PAYMENT_STATUSES)[number];

/** The method vocabulary, re-read from the schema so a store's answer and its request cannot disagree. */
const API_STORE_PAYMENT_METHODS = Object.freeze(["card", "bank_transfer", "e_wallet"] as const);

/**
 * The columns this endpoint reads: nine, all of them scalars, none of them a card field.
 *
 * Selected rather than starred, because a `select=*` would one day read a column nobody meant to publish - and on
 * this table that column would be `failure_detail`, a processor's free sentence about a customer.
 */
export const API_PAYMENT_STATUS_COLUMNS =
  "id,status,amount_minor,refunded_minor,currency,mode,payment_method,failure_code,created_at,updated_at";

/** The chain entry a refused read writes. The call entry STEP 202 writes is separate and always written. */
export const API_PAYMENT_READ_AUDIT = Object.freeze({ refused: "api.payment_read_refused" } as const);

/** What a store is told about one payment. */
export interface ApiStorePaymentStatusView {
  readonly id: string;
  readonly object: typeof API_PAYMENT_OBJECT;
  readonly status: ApiStorePaymentStatus;
  readonly amount_minor: number;
  readonly refunded_minor: number;
  /**
   * The row's own currency. Rule 2 makes it USD and the platform writes nothing else, but the answer repeats what
   * the row holds rather than the constant: an answer that could not disagree with the database would be an answer
   * that hides a bug in it.
   */
  readonly currency: string;
  readonly mode: "test" | "live";
  readonly payment_method: ApiPaymentMethod;
  /** The processor's machine code when the payment failed, and null otherwise. Never the free text sentence. */
  readonly failure_code: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const rowSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(API_STORE_PAYMENT_STATUSES),
  amount_minor: z.number().int(),
  refunded_minor: z.number().int(),
  currency: z.string(),
  mode: z.enum(["test", "live"]),
  payment_method: z.enum(API_STORE_PAYMENT_METHODS),
  failure_code: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

type PaymentRow = z.infer<typeof rowSchema>;

/** What this read needs from the outside world, injected so the gate can drive it without a database. */
export interface StorePaymentStatusDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now: () => number;
}

/** One status read: the id from the path, the caller the pipeline proved, and the address it came from. */
export interface StorePaymentStatusInput {
  readonly paymentId: string;
  readonly principal: ApiPrincipal;
  readonly clientAddress: string | null;
}

function refusal(code: "VALIDATION_FAILED" | "RESOURCE_NOT_FOUND", rule: string): AppError {
  return new AppError(code, { details: [{ field: API_PAYMENT_STATUS_FIELD, rule }] });
}

/**
 * The id as a value this endpoint will query with, or a refusal.
 *
 * Bounded before it is matched: a path segment is caller controlled and can be a kilobyte, and a regular
 * expression is not the place to discover that.
 */
export function parsePaymentId(value: unknown): string {
  if (typeof value !== "string") {
    throw refusal("VALIDATION_FAILED", API_PAYMENT_STATUS_RULES.malformed);
  }

  const paymentId = value.trim();

  if (
    paymentId.length === 0 ||
    paymentId.length > API_PAYMENT_ID_MAXIMUM_LENGTH ||
    !API_PAYMENT_ID_PATTERN.test(paymentId)
  ) {
    throw refusal("VALIDATION_FAILED", API_PAYMENT_STATUS_RULES.malformed);
  }

  return paymentId;
}

/**
 * One line in the chain for a read the platform did not serve.
 *
 * The id is recorded only when it is a payment id; a probe of `/payments/%00` has nothing worth keeping in the
 * `entityId`, and a caller's arbitrary string is not a safe thing to store.
 */
async function noteRefusedRead(
  dependencies: StorePaymentStatusDependencies,
  input: StorePaymentStatusInput,
  paymentId: string | null,
  rule: string,
): Promise<void> {
  const entry: AuditEntry = {
    action: API_PAYMENT_READ_AUDIT.refused,
    actorUserId: null,
    entityType: API_PAYMENT_ENTITY,
    entityId: paymentId,
    payload: {
      rule,
      mode: input.principal.mode,
      credential_id: input.principal.credentialId,
    },
    companyId: input.principal.companyId,
    sessionId: null,
    ipAddress: input.clientAddress,
    userAgent: null,
  };

  try {
    await dependencies.audit.append(entry);
  } catch {
    // The refusal is the answer. A chain that cannot be written does not make the read allowed.
  }
}

function viewOf(row: PaymentRow): ApiStorePaymentStatusView {
  return {
    id: row.id,
    object: API_PAYMENT_OBJECT,
    status: row.status,
    amount_minor: row.amount_minor,
    refunded_minor: row.refunded_minor,
    currency: row.currency,
    mode: row.mode,
    payment_method: row.payment_method,
    failure_code: row.failure_code,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Read one store payment, or refuse it.
 *
 * One query, on the primary key, narrowed by tenant and mode and by the schema's own definition of a store
 * payment - `invoice_id is null`, which `0037`'s column comment states in as many words: *"the invoice this payment
 * settles, or null for a store payment that has no invoice yet."* A merchant's invoice payments are therefore not
 * reachable through the public API at all, which is what section 20's "for online store payments only" asks for.
 *
 * The row is read on every call. There is no cache, no replay and no `ETag`: a payment that is `pending` when a
 * store asks and `captured` a second later is the whole reason the endpoint exists.
 */
export async function readStorePaymentStatus(
  input: StorePaymentStatusInput,
  dependencies: StorePaymentStatusDependencies,
): Promise<ApiStorePaymentStatusView> {
  let paymentId: string;

  try {
    paymentId = parsePaymentId(input.paymentId);
  } catch (error) {
    await noteRefusedRead(dependencies, input, null, API_PAYMENT_STATUS_RULES.malformed);

    throw error;
  }

  const rows = await dependencies.rest.select(
    API_PAYMENT_TABLES.payments,
    `select=${API_PAYMENT_STATUS_COLUMNS}` +
      `&id=eq.${paymentId}` +
      `&company_id=eq.${encodeURIComponent(input.principal.companyId)}` +
      `&mode=eq.${encodeURIComponent(input.principal.mode)}` +
      "&invoice_id=is.null&deleted_at=is.null&limit=1",
    rowSchema,
  );
  const row = rows[0];

  if (row === undefined) {
    await noteRefusedRead(dependencies, input, paymentId, API_PAYMENT_STATUS_RULES.notFound);

    // One answer for five states: unknown, another merchant's, another mode's, an invoice payment, a deleted one.
    throw refusal("RESOURCE_NOT_FOUND", API_PAYMENT_STATUS_RULES.notFound);
  }

  return viewOf(row);
}
