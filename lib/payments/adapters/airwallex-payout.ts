// path: lib/payments/adapters/airwallex-payout.ts

/**
 * Paying a merchant out through Airwallex: booking the payout, tracking the documented transfer statuses, and never
 * treating `PAID` as the end of the story.
 *
 * ## What is implemented, and what is deliberately refused
 *
 * STEP 165 recorded the transfer endpoints (`POST /api/v1/transfers/create`, `GET /api/v1/transfers/{id}`), all
 * eleven statuses, and the page's two warnings that a transfer that reads `PAID` "may subsequently fail if it is
 * rejected by the local clearing system or the recipient bank". It did **not** record the transfer create body's
 * field names, nor the beneficiary create body's. Those pages were never read for this record, so this file does not
 * invent them: `createAirwallexTransfer` and `createAirwallexBeneficiary` answer `unsupported` with the reason
 * naming the unread page, and the create path is **not** on the callable allowlist. A payout is therefore booked by
 * this platform (STEP 144's execution decides it), the provider's transfer id is attached when the surface that
 * created the transfer reports it, and everything after that — reading the status, applying it, and closing the
 * late-failure window — is implemented here.
 *
 * ## `PAID` is provisional, and this file can prove it
 *
 * A `PAID` transfer is recorded as outcome `paid` with `provisional: true` and `final: false`. Only
 * `closeAirwallexPayoutWindow` — called by the ledger once the platform's own window has elapsed, exactly as STEP 141
 * defines it — makes a paid payout final, and only a `FAILED` or `CANCELLED` status is final on its own. That is why
 * an outcome table exists here: `paid` may move to `failed`, but neither may move back.
 *
 * ## The id has no documented prefix
 *
 * STEP 165 named no prefix for a transfer id, so nothing is assumed: any bounded token is accepted, and a connected
 * account id (`acct_…`) is refused by name, because that is the one id this platform is certain about and it would
 * mean an account had been pasted where a transfer belongs.
 */

import { randomUUID } from "node:crypto";
import { deepFreeze } from "../../utils/freeze.ts";
import type { EncryptionKeyring } from "../../security/encryption.ts";
import {
  AIRWALLEX_API_VERSION_HEADER,
  AIRWALLEX_ON_BEHALF_OF_HEADER,
  AIRWALLEX_PROVIDER_KEY,
  AIRWALLEX_TRANSFER_STATUSES,
  AIRWALLEX_TRANSFER_TERMINAL_STATUSES,
  airwallexAmountFromPlatformMinor,
  airwallexRequestIdFor,
  airwallexTransferOutcomeOf,
  isAirwallexAccountId,
  carriesAirwallexKeyShapedText,
  sanitizeAirwallexText,
  type AirwallexTransferOutcome,
} from "./airwallex.ts";
import {
  airwallexAccessTokenFor,
  airwallexClientEndpoint,
  airwallexClientMessageOf,
  AIRWALLEX_ANSWER_MAXIMUM_BYTES,
  type AirwallexClientTransport,
  type AirwallexConfigStore,
  type AirwallexKeyConfig,
  type AirwallexTokenCache,
} from "./airwallex-client.ts";
import { airwallexAccountReadinessOf, type AirwallexAccountProvision } from "./airwallex-accounts.ts";

/* -------------------------------------------------------------------------------------------------
 * The documented surface
 * ---------------------------------------------------------------------------------------------- */

/** The documented transfer create path. Recorded, and deliberately not callable: see the header. */
export const AIRWALLEX_TRANSFER_CREATE_PATH = "/api/v1/transfers/create";

/** The documented transfer read path's prefix. */
export const AIRWALLEX_TRANSFER_READ_PATH_PREFIX = "/api/v1/transfers/";

/** The documented beneficiary create path. Recorded, and deliberately not callable: see the header. */
export const AIRWALLEX_BENEFICIARY_CREATE_PATH = "/api/v1/beneficiaries/create";

/** A transfer id shape: bounded, and with no prefix assumed. */
export const AIRWALLEX_TRANSFER_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/u;

/** A beneficiary id shape: bounded, and with no prefix assumed either. */
export const AIRWALLEX_BENEFICIARY_ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/u;

/** The read path for one transfer. */
export const AIRWALLEX_TRANSFER_READ_PATH_PATTERN = /^\/api\/v1\/transfers\/[A-Za-z0-9_-]{8,64}$/u;

/** The only path this file may call. The create path is absent until its body's fields are read. */
export const AIRWALLEX_PAYOUT_ALLOWED_PATH_PATTERNS: readonly RegExp[] = deepFreeze([
  AIRWALLEX_TRANSFER_READ_PATH_PATTERN,
]);

/** True when a path is one this file may call. */
export function isAirwallexPayoutPath(path: string): boolean {
  return AIRWALLEX_PAYOUT_ALLOWED_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

/** True when a string is a plausible transfer id and not a connected-account id. */
export function isAirwallexTransferId(value: string): boolean {
  const trimmed = value.trim();
  if (isAirwallexAccountId(trimmed)) return false;
  return AIRWALLEX_TRANSFER_ID_PATTERN.test(trimmed);
}

/** True when a string is a plausible beneficiary id and not a connected-account id. */
export function isAirwallexBeneficiaryId(value: string): boolean {
  const trimmed = value.trim();
  if (isAirwallexAccountId(trimmed)) return false;
  return AIRWALLEX_BENEFICIARY_ID_PATTERN.test(trimmed);
}

/** The read path for one transfer, refusing an id this file cannot read. */
export function airwallexTransferPath(transferId: string): string {
  const id = transferId.trim();
  if (isAirwallexTransferId(id) === false) throw new Error("invalid transfer id");
  return `${AIRWALLEX_TRANSFER_READ_PATH_PREFIX}${id}`;
}

/** The bounds every call here keeps. */
export const AIRWALLEX_PAYOUT_TIMEOUT_MS = 20_000;
export const AIRWALLEX_PAYOUT_TEXT_MAXIMUM_LENGTH = 200;

/** Why the transfer create body is not built, in one sentence, so no caller has to guess. */
export const AIRWALLEX_TRANSFER_BODY_NOT_RECORDED =
  "the transfer create body's field names were not read for this record, so this adapter does not build one";

/** Why the beneficiary create body is not built. */
export const AIRWALLEX_BENEFICIARY_BODY_NOT_RECORDED =
  "the beneficiary create body's field names were not read for this record, so this adapter does not build one";

/** What a create attempt answers: a refusal that names the unread page, and nothing sent. */
export interface AirwallexPayoutUnsupported {
  readonly status: "unsupported";
  readonly reason: string;
}

/**
 * Refuse to create a transfer.
 *
 * The endpoint is documented; its body is not. A guessed field name in a payout body is the one mistake that moves
 * real money the wrong way, so this answers `unsupported` and sends nothing. When the page is read, this function
 * gains a body builder and the create path joins the allowlist — and the gate that asserts the refusal will have to
 * be changed deliberately.
 */
export function createAirwallexTransfer(): AirwallexPayoutUnsupported {
  return { status: "unsupported", reason: AIRWALLEX_TRANSFER_BODY_NOT_RECORDED };
}

/** Refuse to create a beneficiary, for the same reason: the body's fields were never read. */
export function createAirwallexBeneficiary(): AirwallexPayoutUnsupported {
  return { status: "unsupported", reason: AIRWALLEX_BENEFICIARY_BODY_NOT_RECORDED };
}

/* -------------------------------------------------------------------------------------------------
 * The transport
 * ---------------------------------------------------------------------------------------------- */

/** One call: the mode, the read path, the token, the pin and the account acted for. */
export interface AirwallexPayoutCall {
  readonly method: "GET";
  readonly environment: "sandbox" | "live";
  readonly path: string;
  readonly accessToken: string;
  readonly apiVersion: string;
  readonly onBehalfOf: string | null;
}

/** The HTTP answer. */
export interface AirwallexPayoutAnswer {
  readonly status: number;
  readonly body: string;
}

/** The transport port. */
export type AirwallexPayoutTransport = (call: AirwallexPayoutCall) => Promise<AirwallexPayoutAnswer>;

/**
 * Perform one documented payout read.
 *
 * The path must be an id-shaped transfer read; the host comes from the stored mode; the token and the pin are
 * required; the acting account is sent as `x-on-behalf-of` when the platform holds one; redirects are refused; the
 * timeout is bounded and an oversized answer is refused.
 */
export const airwallexPayoutFetchTransport: AirwallexPayoutTransport = async (call) => {
  if (isAirwallexPayoutPath(call.path) === false) throw new Error("invalid API path");
  if (call.accessToken.trim().length === 0) throw new Error("an access token is required");
  if (call.apiVersion.trim().length === 0) throw new Error("an API version is required");
  if (call.onBehalfOf !== null && isAirwallexAccountId(call.onBehalfOf) === false) {
    throw new Error("x-on-behalf-of must name a connected account");
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${call.accessToken}`,
    Accept: "application/json",
    [AIRWALLEX_API_VERSION_HEADER]: call.apiVersion.trim(),
  };
  if (call.onBehalfOf !== null) headers[AIRWALLEX_ON_BEHALF_OF_HEADER] = call.onBehalfOf.trim();

  const response = await fetch(airwallexClientEndpoint(call.environment, call.path), {
    method: "GET",
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(AIRWALLEX_PAYOUT_TIMEOUT_MS),
  });

  const text = await response.text();
  if (text.length > AIRWALLEX_ANSWER_MAXIMUM_BYTES) throw new Error("invalid API answer");
  return { status: response.status, body: text };
};

/* -------------------------------------------------------------------------------------------------
 * Reading answers
 * ---------------------------------------------------------------------------------------------- */

function parseJsonBody(body: string): unknown {
  try {
    return body.trim().length === 0 ? null : (JSON.parse(body) as unknown);
  } catch {
    return null;
  }
}

function answerRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

/** The provider's own words, sanitised and bounded. */
export function airwallexPayoutMessageOf(body: string): string {
  return airwallexClientMessageOf(parseJsonBody(body));
}

/** The documented transfer status an answer names, or null when it names one this adapter does not record. */
export function airwallexTransferStatusOf(body: string): string | null {
  const record = answerRecord(parseJsonBody(body));
  if (record === null) return null;
  const named = record["status"];
  if (typeof named !== "string" || named.trim().length === 0) return null;
  const normalized = named.trim().toUpperCase();
  return AIRWALLEX_TRANSFER_STATUSES.includes(normalized) ? normalized : null;
}

/** The transfer id an answer names, or null. */
export function airwallexTransferIdOf(body: string): string | null {
  const record = answerRecord(parseJsonBody(body));
  if (record === null) return null;
  const id = record["id"];
  return typeof id === "string" && isAirwallexTransferId(id) ? id.trim() : null;
}

/** What a read of one transfer means. */
export type AirwallexTransferReadVerdict =
  | {
      readonly outcome: "read";
      readonly transferId: string;
      readonly status: string;
      readonly transferOutcome: AirwallexTransferOutcome;
      readonly provisional: boolean;
    }
  | { readonly outcome: "not_found"; readonly detail: string }
  | { readonly outcome: "failed"; readonly detail: string }
  | { readonly outcome: "unknown"; readonly detail: string };

/**
 * Read a transfer answer.
 *
 * `2XX` carrying one of the eleven documented statuses is the only `read`; a status this adapter does not record is
 * `unknown` rather than `paid`. `404` is `not_found`, `400`/`401`/`403` are `failed`, and a redirect, a timeout class,
 * `429`, a `5XX` or a thrown transport leave the state unread.
 */
export function parseAirwallexTransferReadAnswer(status: number, body: string): AirwallexTransferReadVerdict {
  if (status === 404) return { outcome: "not_found", detail: "Airwallex does not know that transfer id" };
  const message = airwallexPayoutMessageOf(body);
  if (status === 400 || status === 401 || status === 403) {
    return { outcome: "failed", detail: message.length > 0 ? message : `the API refused the read with status ${status}` };
  }
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return { outcome: "unknown", detail: "the API did not answer finally, so the transfer status was not read" };
  }
  if (status >= 300 && status < 400) {
    return { outcome: "unknown", detail: "the API answered with a redirect, which proves nothing" };
  }
  if (status < 200 || status >= 300) {
    return { outcome: "failed", detail: message.length > 0 ? message : `the API refused the read with status ${status}` };
  }

  const transferId = airwallexTransferIdOf(body);
  const named = airwallexTransferStatusOf(body);
  if (transferId === null || named === null) {
    return { outcome: "unknown", detail: "the answer carries no id or no status this adapter records" };
  }
  const mapped = airwallexTransferOutcomeOf(named);
  return { outcome: "read", transferId, status: named, transferOutcome: mapped.outcome, provisional: mapped.provisional };
}

/* -------------------------------------------------------------------------------------------------
 * The payout record
 * ---------------------------------------------------------------------------------------------- */

/** What this platform's ledger may do with a payout's state. */
export type AirwallexPayoutOutcome = "in_flight" | "paid" | "failed" | "cancelled" | "unknown";

/** One booked payout. Never carries a token or a credential. */
export interface AirwallexPayoutRecord {
  readonly id: string;
  readonly providerKey: typeof AIRWALLEX_PROVIDER_KEY;
  readonly companyId: string;
  readonly environment: "sandbox" | "live";
  readonly beneficiaryId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  /** The documented `request_id` this payout was booked under. */
  readonly requestId: string;
  readonly transferId: string | null;
  readonly providerStatus: string | null;
  /** Null until a status has been read: booking proves the platform decided to pay, not that Airwallex moved money. */
  readonly outcome: AirwallexPayoutOutcome | null;
  /** True while a `PAID` payout may still fail. */
  readonly provisional: boolean;
  /** True only when a failure or cancellation is recorded, or the platform's window has closed on a paid payout. */
  readonly final: boolean;
  readonly reason: string | null;
  readonly requiresReconciliation: boolean;
  readonly version: number;
  readonly createdAtEpochMs: number;
  readonly updatedAtEpochMs: number;
}

/** The only moves a payout's outcome may make. */
export const AIRWALLEX_PAYOUT_OUTCOME_MOVES: Readonly<
  Record<AirwallexPayoutOutcome, readonly AirwallexPayoutOutcome[]>
> = deepFreeze({
  in_flight: ["in_flight", "paid", "failed", "cancelled", "unknown"],
  paid: ["paid", "failed"],
  failed: ["failed"],
  cancelled: ["cancelled"],
  unknown: ["unknown", "in_flight", "paid", "failed", "cancelled"],
});

/** What the store reads and writes. One row per booked payout, unique on the derived request id. */
export interface AirwallexPayoutStore {
  insert(record: AirwallexPayoutRecord): void;
  findById(id: string): AirwallexPayoutRecord | null;
  findByRequestId(companyId: string, requestId: string): AirwallexPayoutRecord | null;
  findByTransferId(companyId: string, transferId: string): AirwallexPayoutRecord | null;
  save(next: AirwallexPayoutRecord, expectedVersion: number): boolean;
}

/**
 * The in-memory store: the invariants the real table must carry — a unique row id, a unique `request_id` per
 * company, an immutable company, provider, mode, beneficiary, amount, currency and request id, a version guard, a
 * transfer id that never changes once written, forward-only outcomes, `final` that never becomes false again, and a
 * `final` row that only ever holds a terminal outcome.
 */
export class InMemoryAirwallexPayoutStore implements AirwallexPayoutStore {
  private readonly payouts = new Map<string, AirwallexPayoutRecord>();

  insert(record: AirwallexPayoutRecord): void {
    if (this.payouts.has(record.id)) throw new Error("duplicate payout id");
    if (record.version !== 1) throw new Error("a new payout starts at version 1");
    if (record.outcome !== null) throw new Error("a booked payout has no provider outcome yet");
    if (record.transferId !== null) throw new Error("a booked payout carries no transfer id");
    if (record.final) throw new Error("a booked payout is not final");
    if (this.findByRequestId(record.companyId, record.requestId) !== null) {
      throw new Error("this request id is already booked");
    }
    this.payouts.set(record.id, record);
  }

  findById(id: string): AirwallexPayoutRecord | null {
    return this.payouts.get(id) ?? null;
  }

  findByRequestId(companyId: string, requestId: string): AirwallexPayoutRecord | null {
    return (
      [...this.payouts.values()].find(
        (record) => record.companyId === companyId && record.requestId === requestId,
      ) ?? null
    );
  }

  findByTransferId(companyId: string, transferId: string): AirwallexPayoutRecord | null {
    return (
      [...this.payouts.values()].find(
        (record) =>
          record.companyId === companyId &&
          record.providerKey === AIRWALLEX_PROVIDER_KEY &&
          record.transferId === transferId,
      ) ?? null
    );
  }

  save(next: AirwallexPayoutRecord, expectedVersion: number): boolean {
    const current = this.payouts.get(next.id);
    if (current === undefined) return false;
    if (current.providerKey !== next.providerKey) return false;
    if (current.companyId !== next.companyId || current.environment !== next.environment) return false;
    if (current.beneficiaryId !== next.beneficiaryId) return false;
    if (current.amountMinor !== next.amountMinor || current.currency !== next.currency) return false;
    if (current.requestId !== next.requestId) return false;
    if (current.version !== expectedVersion) return false;
    if (next.version !== expectedVersion + 1) return false;
    if (current.transferId !== null && next.transferId !== current.transferId) return false;
    if (current.outcome !== null && next.outcome !== null) {
      if (AIRWALLEX_PAYOUT_OUTCOME_MOVES[current.outcome].includes(next.outcome) === false) return false;
    }
    if (next.final) {
      if (next.outcome !== "paid" && next.outcome !== "failed" && next.outcome !== "cancelled") return false;
      if (current.final && current.outcome !== next.outcome) return false;
    }
    if (current.final && next.final === false) return false;
    if (next.outcome === "paid" && next.final && next.provisional) return false;
    this.payouts.set(next.id, next);
    return true;
  }
}

/* -------------------------------------------------------------------------------------------------
 * Audit
 * ---------------------------------------------------------------------------------------------- */

/** One audit entry this file hands to the caller's audit writer. Never carries a token. */
export interface AirwallexPayoutAuditEntry {
  readonly action:
    | "airwallex_payout.booked"
    | "airwallex_payout.transfer_attached"
    | "airwallex_payout.status_read"
    | "airwallex_payout.failed"
    | "airwallex_payout.closed";
  readonly providerKey: typeof AIRWALLEX_PROVIDER_KEY;
  readonly companyId: string;
  readonly payoutId: string;
  readonly transferId: string | null;
  readonly environment: "sandbox" | "live";
  readonly outcome: string;
  readonly occurredAtEpochMs: number;
}

/* -------------------------------------------------------------------------------------------------
 * Options and helpers
 * ---------------------------------------------------------------------------------------------- */

/** What every function here needs. */
export interface AirwallexPayoutOptions {
  readonly provision: AirwallexAccountProvision;
  readonly configStore: AirwallexConfigStore;
  readonly keyring: EncryptionKeyring;
  readonly tokenCache: AirwallexTokenCache;
  readonly payoutStore: AirwallexPayoutStore;
  readonly occurredAtEpochMs: number;
  readonly transport?: AirwallexPayoutTransport;
  readonly loginTransport?: AirwallexClientTransport;
  readonly recordAudit?: (entry: AirwallexPayoutAuditEntry) => void;
}

type PayoutContext =
  | { readonly ok: true; readonly config: AirwallexKeyConfig; readonly token: string }
  | { readonly ok: false; readonly reason: string };

async function payoutContextOf(companyId: string, options: AirwallexPayoutOptions): Promise<PayoutContext> {
  const config = options.configStore.findActiveByCompany(companyId);
  if (config === null) return { ok: false, reason: "no active Airwallex key configuration exists for this company" };
  const token = await airwallexAccessTokenFor(config.id, {
    store: options.configStore,
    keyring: options.keyring,
    tokenCache: options.tokenCache,
    nowEpochMs: options.occurredAtEpochMs,
    ...(options.loginTransport === undefined ? {} : { transport: options.loginTransport }),
  });
  if (token.status !== "token") return { ok: false, reason: token.reason };
  return { ok: true, config, token: token.token };
}

function auditPayout(
  action: AirwallexPayoutAuditEntry["action"],
  record: AirwallexPayoutRecord,
  outcome: string,
  options: { readonly occurredAtEpochMs: number; readonly recordAudit?: (entry: AirwallexPayoutAuditEntry) => void },
): void {
  options.recordAudit?.({
    action,
    providerKey: AIRWALLEX_PROVIDER_KEY,
    companyId: record.companyId,
    payoutId: record.id,
    transferId: record.transferId,
    environment: record.environment,
    outcome,
    occurredAtEpochMs: options.occurredAtEpochMs,
  });
}

/* -------------------------------------------------------------------------------------------------
 * Booking
 * ---------------------------------------------------------------------------------------------- */

/** What a caller books. */
export interface AirwallexPayoutRequest {
  readonly companyId: string;
  readonly amountMinor: bigint;
  /** The beneficiary the bank account is registered as. No body is built here, so the id is all that is needed. */
  readonly beneficiaryId: string;
  readonly currency: string;
  /** The payout reference the documented `request_id` derives from. */
  readonly reference: string;
}

/** The documented `request_id` for one payout, namespaced so it cannot collide with a payment's. */
export function airwallexPayoutRequestId(request: AirwallexPayoutRequest): string {
  return airwallexRequestIdFor(request.companyId, `payout|${request.reference.trim()}`);
}

/** The reason a payout request is unusable, or null when it is usable. */
export function validateAirwallexPayoutRequest(request: AirwallexPayoutRequest): string | null {
  const amount = airwallexAmountFromPlatformMinor(request.amountMinor, request.currency);
  if (amount.ok === false) return amount.reason;
  if (isAirwallexBeneficiaryId(request.beneficiaryId) === false) return "the beneficiary id is not one this adapter records";
  const reference = request.reference.trim();
  if (reference.length === 0) return "a payout reference is required, because the request id derives from it";
  if (reference.length > 120) return "the payout reference is longer than 120 characters";
  if (carriesAirwallexKeyShapedText(reference)) return "the payout reference must not carry a credential";
  return null;
}

/** What booking did. */
export type BookAirwallexPayoutResult =
  | { readonly status: "booked"; readonly record: AirwallexPayoutRecord }
  | { readonly status: "already_booked"; readonly record: AirwallexPayoutRecord }
  | { readonly status: "failed"; readonly reason: string };

/**
 * Book a payout for a merchant whose connected account is ready.
 *
 * Booking is this platform's own decision, recorded before anything moves: the readiness of the connected account is
 * checked, the request is validated, the documented `request_id` is derived, and the row is written with no outcome
 * and no transfer id. No provider call is made, because the transfer create body's fields were never read — the
 * transfer id arrives through `attachAirwallexTransferId` once the surface that created it reports it, and the status
 * arrives through a read or a webhook. A second booking with the same reference answers `already_booked`.
 */
export function bookAirwallexPayout(
  request: AirwallexPayoutRequest,
  options: AirwallexPayoutOptions,
): BookAirwallexPayoutResult {
  const readiness = airwallexAccountReadinessOf(options.provision, options.occurredAtEpochMs);
  if (readiness.canReceivePayouts === false) {
    return {
      status: "failed",
      reason: readiness.blockingReason ?? "the connected account cannot receive a payout",
    };
  }
  if (options.provision.companyId !== request.companyId) {
    return { status: "failed", reason: "the connected account belongs to another company" };
  }

  const invalid = validateAirwallexPayoutRequest(request);
  if (invalid !== null) return { status: "failed", reason: invalid };

  const requestId = airwallexPayoutRequestId(request);
  const existing = options.payoutStore.findByRequestId(request.companyId, requestId);
  if (existing !== null) return { status: "already_booked", record: existing };

  const config = options.configStore.findActiveByCompany(request.companyId);
  if (config === null) return { status: "failed", reason: "no active Airwallex key configuration exists for this company" };

  const record: AirwallexPayoutRecord = {
    id: randomUUID(),
    providerKey: AIRWALLEX_PROVIDER_KEY,
    companyId: request.companyId,
    environment: config.environment,
    beneficiaryId: request.beneficiaryId.trim(),
    amountMinor: request.amountMinor,
    currency: request.currency.trim().toLowerCase(),
    requestId,
    transferId: null,
    providerStatus: null,
    outcome: null,
    provisional: false,
    final: false,
    reason: null,
    requiresReconciliation: false,
    version: 1,
    createdAtEpochMs: options.occurredAtEpochMs,
    updatedAtEpochMs: options.occurredAtEpochMs,
  };

  try {
    options.payoutStore.insert(record);
  } catch {
    return { status: "failed", reason: "this payout request id is already booked" };
  }

  auditPayout("airwallex_payout.booked", record, "booked", options);
  return { status: "booked", record };
}

/** What attaching a transfer id did. */
export type AttachAirwallexTransferIdResult =
  | { readonly status: "attached"; readonly record: AirwallexPayoutRecord }
  | { readonly status: "already_attached"; readonly record: AirwallexPayoutRecord }
  | { readonly status: "failed"; readonly reason: string };

/**
 * Attach the provider's transfer id to a booked payout.
 *
 * The id proves a transfer exists at Airwallex; it proves nothing about its status, so the outcome stays null until a
 * read or a webhook reports one. Attaching a second, different id is refused, and so is attaching one to a payout
 * that is already final.
 */
export function attachAirwallexTransferId(
  payoutId: string,
  transferId: string,
  options: AirwallexPayoutOptions,
): AttachAirwallexTransferIdResult {
  const record = options.payoutStore.findById(payoutId);
  if (record === null) return { status: "failed", reason: "no payout holds that id" };
  if (isAirwallexTransferId(transferId) === false) return { status: "failed", reason: "the transfer id is not one this adapter records" };
  if (record.transferId !== null) {
    return record.transferId === transferId.trim()
      ? { status: "already_attached", record }
      : { status: "failed", reason: "the payout already carries another transfer id" };
  }
  if (record.final) return { status: "failed", reason: "a final payout takes no new transfer id" };

  const next: AirwallexPayoutRecord = {
    ...record,
    transferId: transferId.trim(),
    version: record.version + 1,
    updatedAtEpochMs: options.occurredAtEpochMs,
  };
  if (options.payoutStore.save(next, record.version) === false) {
    return { status: "failed", reason: "the payout moved while the transfer id was being attached" };
  }
  auditPayout("airwallex_payout.transfer_attached", next, "attached", options);
  return { status: "attached", record: next };
}

/* -------------------------------------------------------------------------------------------------
 * Reading and applying a status
 * ---------------------------------------------------------------------------------------------- */

/** What a read of one payout's transfer said. */
export type ReadAirwallexTransferResult =
  | {
      readonly status: "read";
      readonly transferId: string;
      readonly providerStatus: string;
      readonly outcome: AirwallexTransferOutcome;
      readonly provisional: boolean;
    }
  | { readonly status: "not_found"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string };

/** Read one transfer's status with the company's active configuration. */
export async function readAirwallexTransfer(
  transferId: string,
  options: AirwallexPayoutOptions,
): Promise<ReadAirwallexTransferResult> {
  if (isAirwallexTransferId(transferId) === false) {
    return { status: "failed", reason: "the transfer id is not one this adapter records" };
  }
  const context = await payoutContextOf(options.provision.companyId, options);
  if (context.ok === false) return { status: "failed", reason: context.reason };

  let verdict: AirwallexTransferReadVerdict;
  try {
    const answer = await (options.transport ?? airwallexPayoutFetchTransport)({
      method: "GET",
      environment: context.config.environment,
      path: airwallexTransferPath(transferId),
      accessToken: context.token,
      apiVersion: context.config.apiVersion,
      onBehalfOf: options.provision.accountId,
    });
    verdict = parseAirwallexTransferReadAnswer(answer.status, answer.body);
  } catch {
    return { status: "failed", reason: "the API could not be reached, so the transfer status is unknown" };
  }

  if (verdict.outcome === "read") {
    // An answer about another transfer proves nothing about this one: the read must be about the id that was asked for.
    if (verdict.transferId !== transferId.trim()) {
      return { status: "failed", reason: "the API answered about another transfer, so this one's status is unknown" };
    }
    return {
      status: "read",
      transferId: verdict.transferId,
      providerStatus: verdict.status,
      outcome: verdict.transferOutcome,
      provisional: verdict.provisional,
    };
  }
  if (verdict.outcome === "not_found") return { status: "not_found", reason: verdict.detail };
  return { status: "failed", reason: verdict.detail };
}

/** What applying a status did. */
export type ApplyAirwallexPayoutStatusResult =
  | { readonly status: "applied"; readonly record: AirwallexPayoutRecord; readonly changed: boolean }
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string };

/**
 * Apply one transfer status to a booked payout, from a read or from a webhook.
 *
 * The mapping is STEP 165's, unchanged: `PAID` is `paid` **and provisional**, `FAILED` and `CANCELLED` are final,
 * everything else is in flight, and an unrecorded status is `unknown` rather than a success. The outcome table then
 * decides whether the move is allowed, which is what stops a `PAID` payout from drifting back to `PROCESSING` because
 * a stale read arrived late.
 */
export function applyAirwallexPayoutStatus(
  payoutId: string,
  providerStatus: string,
  options: AirwallexPayoutOptions & { readonly source: "read" | "webhook" },
): ApplyAirwallexPayoutStatusResult {
  const record = options.payoutStore.findById(payoutId);
  if (record === null) return { status: "failed", reason: "no payout holds that id" };

  const normalized = providerStatus.trim().toUpperCase();
  if (record.providerStatus === normalized) {
    // A read or a delivery that repeats the status already held proves nothing new, and writing it again would move the
    // version without moving the payout, so it is refused rather than counted as progress.
    return { status: "refused", reason: "the payout already holds this status" };
  }
  const mapped = airwallexTransferOutcomeOf(normalized);
  const outcome: AirwallexPayoutOutcome =
    mapped.outcome === "paid"
      ? "paid"
      : mapped.outcome === "failed"
        ? "failed"
        : mapped.outcome === "cancelled"
          ? "cancelled"
          : mapped.outcome === "in_flight"
            ? "in_flight"
            : "unknown";

  const final = outcome === "failed" || outcome === "cancelled";
  const changed = record.outcome !== outcome || record.providerStatus !== normalized;
  const next: AirwallexPayoutRecord = {
    ...record,
    providerStatus: normalized,
    outcome,
    provisional: mapped.provisional,
    final: record.final || final,
    requiresReconciliation: outcome === "unknown",
    reason:
      outcome === "unknown"
        ? `the transfer status ${sanitizeAirwallexText(normalized, AIRWALLEX_PAYOUT_TEXT_MAXIMUM_LENGTH)} is not one this adapter records`
        : null,
    version: record.version + 1,
    updatedAtEpochMs: options.occurredAtEpochMs,
  };

  if (options.payoutStore.save(next, record.version) === false) {
    const current = options.payoutStore.findById(payoutId);
    if (current !== null && current.providerStatus === normalized) {
      return { status: "refused", reason: "the payout already holds this status" };
    }
    return { status: "refused", reason: "the payout may not move to that status" };
  }

  auditPayout(
    outcome === "failed" ? "airwallex_payout.failed" : "airwallex_payout.status_read",
    next,
    normalized,
    options,
  );
  return { status: "applied", record: next, changed };
}

/**
 * Close the late-failure window on a paid payout.
 *
 * The window itself is the platform's, not Airwallex's: STEP 141's settlement policy decides how long a `PAID` transfer
 * is watched, and this function is how that policy records the decision. It refuses anything that is not a paid,
 * still-provisional payout, so a failure can never be quietly blessed as final money.
 */
export function closeAirwallexPayoutWindow(
  payoutId: string,
  options: AirwallexPayoutOptions,
): ApplyAirwallexPayoutStatusResult {
  const record = options.payoutStore.findById(payoutId);
  if (record === null) return { status: "failed", reason: "no payout holds that id" };
  if (record.outcome !== "paid") return { status: "refused", reason: "only a paid payout has a window to close" };
  if (record.final) return { status: "refused", reason: "the payout is already final" };

  const next: AirwallexPayoutRecord = {
    ...record,
    provisional: false,
    final: true,
    version: record.version + 1,
    updatedAtEpochMs: options.occurredAtEpochMs,
  };
  if (options.payoutStore.save(next, record.version) === false) {
    return { status: "failed", reason: "the payout moved while its window was being closed" };
  }
  auditPayout("airwallex_payout.closed", next, "closed", options);
  return { status: "applied", record: next, changed: true };
}

/* -------------------------------------------------------------------------------------------------
 * What a payout means for the ledger
 * ---------------------------------------------------------------------------------------------- */

/** What the ledger may record for one payout. */
export interface AirwallexPayoutLedgerOutcome {
  readonly outcome: AirwallexPayoutOutcome | "none";
  /** True while a paid payout may still fail, which is the flag STEP 141 must honour. */
  readonly provisional: boolean;
  readonly final: boolean;
  /** True when a person has to look at this payout. */
  readonly needsAttention: boolean;
  readonly reason: string | null;
}

/**
 * Read a payout as a ledger entry.
 *
 * `none` means the platform has booked the payout but has no provider status yet: money is committed, not moved, and
 * the ledger must not debit anything on the strength of it. A `paid` payout stays `provisional` until the window
 * closes, and only then may the ledger treat the funds as gone for good.
 */
export function airwallexPayoutLedgerOutcome(record: AirwallexPayoutRecord): AirwallexPayoutLedgerOutcome {
  if (record.outcome === null) {
    return {
      outcome: "none",
      provisional: false,
      final: false,
      needsAttention: record.requiresReconciliation,
      reason: record.transferId === null ? "the payout has no provider transfer id yet" : "the payout's status has not been read yet",
    };
  }
  return {
    outcome: record.outcome,
    provisional: record.provisional,
    final: record.final,
    needsAttention: record.requiresReconciliation,
    reason: record.reason,
  };
}

/** True when a paid payout may still fail: the question STEP 165 says must be asked before money is called gone. */
export function airwallexPayoutCanStillFail(record: AirwallexPayoutRecord): boolean {
  return record.outcome === "paid" && record.provisional && record.final === false;
}

/** The documented terminal statuses, exported so a caller can see what this file treats as final on its own. */
export const AIRWALLEX_PAYOUT_FINAL_STATUSES: readonly string[] = deepFreeze([...AIRWALLEX_TRANSFER_TERMINAL_STATUSES, "FAILED"]);
