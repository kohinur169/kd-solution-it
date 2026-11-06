// path: lib/payments/adapters/nmi-status-sync.ts

/**
 * The NMI adapter's response-code mapping, transaction status sync and sandbox end-to-end
 * verification: the service that turns what the NMI gateway says into the payment status the
 * platform stores, and that proves the whole token-to-refund path in NMI's sandbox.
 *
 * ## The documentation this file is coded from
 *
 * Section 6 of the feature list says the NMI integration "follows the official NMI API
 * documentation and Collect.js rules … response codes and error handling all follow the
 * documentation read in the coding session", and the provider documentation rule in
 * `docs/final/MASTER_PROMPT.md` says the same. The documentation below was read in this
 * coding session:
 *
 * - Response codes: https://docs.nmi.com/reference/response-codes
 *   `response` is 1 approved, 2 declined, 3 error in the transaction data or a system error.
 *   `response_code` is the detailed processor or gateway code: 100 approved, 200-264 declined,
 *   300 rejected by the gateway, 400-461 processor and communication errors.
 * - Transaction processing: https://docs.nmi.com/reference/transactions-processing and
 *   https://docs.nmi.com/docs/processing - the sale, auth, capture, refund and void types, the
 *   `security_key`, `payment_token`, `transactionid` fields and the query-string response.
 * - Query API: https://docs.nmi.com/reference/query - `POST /api/query.php` with
 *   `security_key` and `transaction_id`, answered as `<nm_response>` XML whose transaction
 *   record carries the documented `condition`.
 * - Test mode: https://docs.nmi.com/docs/enable-test-mode-1 - every valid card is approved in
 *   test mode and nothing is sent to a processor.
 * - Collect.js: https://docs.nmi.com/docs/collectjs (STEP 149 already owns the hosted fields).
 *
 * Sandbox endpoints used here: https://sandbox.nmi.com/api/transact.php (STEP 151) and
 * https://sandbox.nmi.com/api/query.php (this file). Production endpoints:
 * https://secure.nmi.com/api/transact.php and https://secure.nmi.com/api/query.php.
 *
 * ## Why response codes are a table rather than a boolean
 *
 * The gateway answers with two values, and neither one alone is the answer to "did the money
 * move". `response` says approved, declined or error; `response_code` says why. A decline
 * (200-264) is a final answer and nothing moved. A gateway rejection (300) is a final answer and
 * nothing moved. A processor error (400-461) is mostly a final answer and nothing moved - but a
 * communication error (420, 421) and a duplicate at the processor (430) are not: the charge may
 * have been taken and the answer lost, and retrying them is how a card is charged twice. The
 * table below therefore carries a category and a `requiresReconciliation` flag per documented
 * code, so a code whose outcome is unknown never becomes a status and never becomes a retry.
 *
 * ## Why a status transition is a graph
 *
 * NMI's conditions are `pending`, `pendingsettlement`, `in_progress`, `abandoned`, `failed`,
 * `canceled`, `complete` and `unknown`. The platform's payment status vocabulary is the one the
 * database constraint already enforces in `migrations/0037_payments.sql`: `pending`,
 * `authorized`, `captured`, `settled`, `failed`, `voided`, `partially_refunded`, `refunded`,
 * `under_review`. This file maps the provider's vocabulary onto the six statuses a provider
 * transaction can move between and refuses to move backwards: a settled payment reported as
 * pending by a stale query is not un-settled, and a voided payment reported as captured is not
 * captured again. A report that would move backwards is refused and named, not applied.
 *
 * ## What a sync writes
 *
 * Every applied sync is one versioned write guarded by optimistic locking: the state carries a
 * version, the store writes only when the version it holds is the version the caller read, and
 * a competing write loses with a refusal instead of overwriting the other one. The write is
 * paired with an audit entry handed to the caller's audit writer (the platform's audit log is
 * another STEP's module; this file never writes it directly). Nothing in the state or the audit
 * entry holds a credential, a card value or a Collect.js token.
 *
 * ## What the sandbox cycle is
 *
 * The master prompt's production readiness rules say a provider STEP completes a sandbox cycle
 * (payment, refund where supported, and webhook delivery) and records the documentation URLs,
 * the sandbox URLs and the result. `runNmiSandboxCycle` is that cycle as executable code: a
 * sale, an auth, a capture of that auth, a partial refund of the sale, a second auth and a void
 * of it, each one exchanging a Collect.js token through STEP 151's payment module against the
 * sandbox endpoint, each one classified through this file's response-code table. It refuses to
 * run against a production key configuration and refuses any endpoint that is not the sandbox
 * one, so a mistake in the environment can never become a live charge.
 *
 * ## What this file is not
 *
 * It is not the HTTP transport for payments (STEP 151 owns the transact.php transport and this
 * file reuses it). It is not the key store or the encryption (STEP 148 owns both). It is not the
 * Collect.js hosted fields (STEP 149) and not the transaction payload builder (STEP 150). It is
 * not the webhook receiver (STEP 153) and not the refund service that owns a payment's refunded
 * total (STEP 191+). It is not an API route, a UI or a migration: the route that exposes a
 * status sync, the database adapter that implements the store and the audit writer behind the
 * callback all belong to later STEPs, and the in-memory store here is a reference store, not a
 * persistence guarantee.
 */

import { randomUUID } from "node:crypto";
import { deepFreeze } from "../../utils/freeze.ts";
import { decryptKey, type NmiKeyStore } from "./nmi-client.ts";
import {
  NMI_SANDBOX_API_ENDPOINT,
  nmiFetchTransport,
  processNmiPayment,
  type NmiHttpTransport,
  type NmiPaymentRequest,
  type ProcessNmiPaymentOptions,
} from "./nmi-payment.ts";
import type { NmiTransactionType } from "./nmi-api.ts";

/* -------------------------------------------------------------------------------------------------
 * Endpoints and documentation
 * ---------------------------------------------------------------------------------------------- */

/** The production Query API endpoint, per https://docs.nmi.com/reference/query. */
export const NMI_QUERY_ENDPOINT = "https://secure.nmi.com/api/query.php";

/** The sandbox Query API endpoint, per https://docs.nmi.com/reference/query. */
export const NMI_SANDBOX_QUERY_ENDPOINT = "https://sandbox.nmi.com/api/query.php";

/** The largest Query API body this file accepts; a larger body is refused as unparsable. */
export const NMI_QUERY_RESPONSE_MAXIMUM_BYTES = 262_144;

/** The longest piece of provider text this file keeps; provider text is untrusted input. */
export const NMI_TEXT_MAXIMUM_LENGTH = 200;

/** The documentation read in this coding session, recorded with every sandbox cycle report. */
export const NMI_STATUS_SYNC_DOCUMENTATION_URLS: readonly string[] = deepFreeze([
  "https://docs.nmi.com/reference/response-codes",
  "https://docs.nmi.com/reference/query",
  "https://docs.nmi.com/reference/transactions-processing",
  "https://docs.nmi.com/docs/processing",
  "https://docs.nmi.com/docs/enable-test-mode-1",
  "https://docs.nmi.com/docs/collectjs",
]);

/** The sandbox endpoints the cycle uses, recorded with every sandbox cycle report. */
export const NMI_SANDBOX_ENDPOINTS: readonly string[] = deepFreeze([
  NMI_SANDBOX_API_ENDPOINT,
  NMI_SANDBOX_QUERY_ENDPOINT,
]);

/** The Query API endpoint that belongs to an environment. */
export function nmiQueryEndpointFor(environment: "sandbox" | "production"): string {
  return environment === "sandbox" ? NMI_SANDBOX_QUERY_ENDPOINT : NMI_QUERY_ENDPOINT;
}

/* -------------------------------------------------------------------------------------------------
 * Provider vocabulary mapped onto the platform vocabulary
 * ---------------------------------------------------------------------------------------------- */

/**
 * The transaction conditions NMI documents for the Query API.
 *
 * Taken verbatim from https://docs.nmi.com/reference/query: `pending` is an auth awaiting
 * capture, `pendingsettlement` waits for settlement, `in_progress` is a three-step redirect that
 * has not finished, `abandoned` is that redirect timing out, `failed` is a failure, `canceled`
 * is a void, `complete` has settled and `unknown` is an error while processing.
 */
export type NmiProviderCondition =
  | "pending"
  | "pendingsettlement"
  | "in_progress"
  | "abandoned"
  | "failed"
  | "canceled"
  | "complete"
  | "unknown";

/**
 * The payment statuses a provider transaction can move between.
 *
 * These six are the statuses of the `payments.status` constraint in
 * `migrations/0037_payments.sql`. The refund statuses (`partially_refunded`, `refunded`) and
 * `under_review` are deliberately absent: a refund's total is written by the refund service
 * (STEP 191+) and a review status is a platform decision, not a gateway condition.
 */
export type NmiPlatformPaymentStatus =
  | "pending"
  | "authorized"
  | "captured"
  | "settled"
  | "failed"
  | "voided";

/** The documented categories a response code belongs to. */
export type NmiResponseCategory = "approved" | "declined" | "rejected" | "error" | "unknown";

/** One documented response code: its official description, category and retry safety. */
export interface NmiResponseCodeMeaning {
  readonly code: string;
  readonly description: string;
  readonly category: NmiResponseCategory;
  /**
   * True when the documented outcome is not a final answer: the charge may have been taken and
   * the answer lost, so the transaction must be reconciled before anything is retried.
   */
  readonly requiresReconciliation: boolean;
}

function meaningOf(
  code: string,
  description: string,
  category: NmiResponseCategory,
  requiresReconciliation = false,
): NmiResponseCodeMeaning {
  return Object.freeze({ code, description, category, requiresReconciliation });
}

/**
 * Every `response_code` documented at https://docs.nmi.com/reference/response-codes, with the
 * official description and the category this file maps it to.
 *
 * The `declined` codes are final declines: the issuer or the processor refused and nothing
 * moved. `300` is the gateway rejecting the transaction and `400`, `410`, `411`, `440`, `441`
 * are failures where nothing moved either. `420` and `421` are the communication errors and
 * `430` is the duplicate at the processor: those three are the ones where the answer is not
 * final, so they carry `requiresReconciliation`.
 */
export const NMI_RESPONSE_CODES: Readonly<Record<string, NmiResponseCodeMeaning>> = deepFreeze({
  "100": meaningOf("100", "Transaction was approved.", "approved"),
  "200": meaningOf("200", "Transaction was declined by processor.", "declined"),
  "201": meaningOf("201", "Do not honor.", "declined"),
  "202": meaningOf("202", "Insufficient funds.", "declined"),
  "203": meaningOf("203", "Over limit.", "declined"),
  "204": meaningOf("204", "Transaction not allowed.", "declined"),
  "220": meaningOf("220", "Incorrect payment information.", "declined"),
  "221": meaningOf("221", "No such card issuer.", "declined"),
  "222": meaningOf("222", "No card number on file with issuer.", "declined"),
  "223": meaningOf("223", "Expired card.", "declined"),
  "224": meaningOf("224", "Invalid expiration date.", "declined"),
  "225": meaningOf("225", "Invalid card security code.", "declined"),
  "226": meaningOf("226", "Invalid PIN.", "declined"),
  "240": meaningOf("240", "Call issuer for further information.", "declined"),
  "250": meaningOf("250", "Pick up card.", "declined"),
  "251": meaningOf("251", "Lost card.", "declined"),
  "252": meaningOf("252", "Stolen card.", "declined"),
  "253": meaningOf("253", "Fraudulent card.", "declined"),
  "260": meaningOf("260", "Declined with further instructions available.", "declined"),
  "261": meaningOf("261", "Declined, stop all recurring payments.", "declined"),
  "262": meaningOf("262", "Declined, stop this recurring program.", "declined"),
  "263": meaningOf("263", "Declined, update cardholder data available.", "declined"),
  "264": meaningOf("264", "Declined, retry in a few days.", "declined"),
  "300": meaningOf("300", "Transaction was rejected by gateway.", "rejected"),
  "400": meaningOf("400", "Transaction error returned by processor.", "error"),
  "410": meaningOf("410", "Invalid merchant configuration.", "error"),
  "411": meaningOf("411", "Merchant account is inactive.", "error"),
  "420": meaningOf("420", "Communication error.", "error", true),
  "421": meaningOf("421", "Communication error with issuer.", "error", true),
  "430": meaningOf("430", "Duplicate transaction at processor.", "rejected", true),
  "440": meaningOf("440", "Processor format error.", "error"),
  "441": meaningOf("441", "Invalid transaction information.", "error"),
  "460": meaningOf("460", "Processor feature not available.", "declined"),
  "461": meaningOf("461", "Unsupported card type.", "declined"),
});

/** The meaning of a `response_code`, or the documented unknown fallback. */
export function nmiResponseCodeMeaning(code: string | null | undefined): NmiResponseCodeMeaning {
  const normalized = code === null || code === undefined ? "" : code.trim();
  if (normalized.length === 0) {
    return meaningOf("", "The gateway did not return a response code.", "unknown", true);
  }
  const known = NMI_RESPONSE_CODES[normalized];
  if (known !== undefined) return known;
  // A code nobody documented cannot be a final answer: its effect is unknown by definition.
  return meaningOf(normalized, "The response code is not in the documented table.", "unknown", true);
}

/* -------------------------------------------------------------------------------------------------
 * Provider text sanitisation
 * ---------------------------------------------------------------------------------------------- */

/**
 * Clean provider text before it leaves this file.
 *
 * `responsetext` and the Query API's `<response_text>` are provider strings the platform did not
 * write, so they are treated as untrusted: control characters (which could rewrite a log line or
 * break a header) are removed, angle brackets are removed so the text can never be markup if a
 * screen renders it as HTML, runs of whitespace are collapsed, and the result is capped.
 */
export function sanitizeNmiText(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  // The cap is applied to the input first so a hostile body cannot make this loop expensive.
  const source = value.length > 4 * NMI_TEXT_MAXIMUM_LENGTH ? value.slice(0, 4 * NMI_TEXT_MAXIMUM_LENGTH) : value;
  let cleaned = "";

  for (const character of source) {
    const point = character.codePointAt(0) ?? 0;
    if (point < 0x20 || point === 0x7f) {
      cleaned += " ";
      continue;
    }
    if (character === "<" || character === ">") continue;
    cleaned += character;
  }

  cleaned = cleaned.replace(/\s+/gu, " ").trim();
  if (cleaned.length <= NMI_TEXT_MAXIMUM_LENGTH) return cleaned;
  return cleaned.slice(0, NMI_TEXT_MAXIMUM_LENGTH);
}

/* -------------------------------------------------------------------------------------------------
 * Condition and status mapping
 * ---------------------------------------------------------------------------------------------- */

/** The result of mapping a provider condition onto a platform payment status. */
export type NmiConditionMapping =
  | { readonly outcome: "mapped"; readonly status: NmiPlatformPaymentStatus }
  | { readonly outcome: "unresolved"; readonly reason: string };

/**
 * Map an NMI condition onto the platform status it means.
 *
 * - `pending` - a successful auth awaits capture: `authorized`.
 * - `pendingsettlement` - a successful sale awaits settlement: `captured`.
 * - `complete` - the transaction settled: `settled`.
 * - `canceled` - the transaction was voided: `voided`.
 * - `failed` - the transaction failed: `failed`.
 * - `in_progress` - a hosted redirect that has not finished: `pending`.
 * - `abandoned` - that redirect timed out without finishing: `failed`.
 * - `unknown` - an error while processing, or a condition the documentation does not name:
 *   unresolved, so no status is written and the transaction goes to reconciliation.
 */
export function mapNmiCondition(condition: NmiProviderCondition): NmiConditionMapping {
  switch (condition) {
    case "pending":
      return { outcome: "mapped", status: "authorized" };
    case "pendingsettlement":
      return { outcome: "mapped", status: "captured" };
    case "complete":
      return { outcome: "mapped", status: "settled" };
    case "canceled":
      return { outcome: "mapped", status: "voided" };
    case "failed":
      return { outcome: "mapped", status: "failed" };
    case "in_progress":
      return { outcome: "mapped", status: "pending" };
    case "abandoned":
      return { outcome: "mapped", status: "failed" };
    case "unknown":
      return {
        outcome: "unresolved",
        reason: "the gateway reported an unknown transaction condition",
      };
  }
}

/**
 * The documented condition an approved transaction of each type leaves behind.
 *
 * From https://docs.nmi.com/docs/asyncstatus-polling: a sale and a credit end
 * `pendingsettlement`, an auth ends `pending` until it is captured, and a void ends `canceled`.
 * A capture settles the auth it captures, so it leaves `pendingsettlement`. A refund is listed
 * with `complete`, but a refund does not move a payment's own status - the refund service owns
 * the refunded total - so `assessNmiTransactResponse` gives a refund no target status.
 */
function conditionAfterApproval(type: NmiTransactionType): NmiProviderCondition {
  switch (type) {
    case "sale":
      return "pendingsettlement";
    case "authorization":
      return "pending";
    case "capture":
      return "pendingsettlement";
    case "refund":
      return "complete";
    case "void":
      return "canceled";
  }
}

/**
 * The statuses a stored payment status may move to.
 *
 * Forward only. `settled`, `failed` and `voided` are terminal for a provider transaction:
 * a settled payment is reversed by a refund (the refund service's business), not by a gateway
 * condition. A refunded payment's status comes from that service, never from this graph.
 */
const NMI_STATUS_TRANSITIONS: Readonly<Record<NmiPlatformPaymentStatus, readonly NmiPlatformPaymentStatus[]>> =
  deepFreeze({
    pending: ["authorized", "captured", "settled", "failed", "voided"],
    authorized: ["captured", "settled", "failed", "voided"],
    captured: ["settled", "voided"],
    settled: [],
    failed: [],
    voided: [],
  });

/** Whether a stored status may move to the reported status. */
export function canAdvanceNmiStatus(
  from: NmiPlatformPaymentStatus,
  to: NmiPlatformPaymentStatus,
): boolean {
  return NMI_STATUS_TRANSITIONS[from].includes(to);
}

/* -------------------------------------------------------------------------------------------------
 * Response assessment
 * ---------------------------------------------------------------------------------------------- */

/**
 * What one gateway answer means, in the platform's terms.
 *
 * `targetStatus` is null whenever the answer must not become a status: either because the
 * outcome is unknown (`requiresReconciliation`) or because the answer is a provider action that
 * does not move a payment's own status (a refund). `category` is the documented category of the
 * response code, or null when the gateway sent no code at all.
 */
export interface NmiStatusAssessment {
  readonly providerCondition: NmiProviderCondition | null;
  readonly targetStatus: NmiPlatformPaymentStatus | null;
  readonly category: NmiResponseCategory | null;
  readonly responseCode: string | null;
  readonly responseText: string;
  readonly transactionId: string | null;
  readonly requiresReconciliation: boolean;
  readonly reason: string;
}

/** Normalise a raw response code: trimmed, empty becomes null. */
function normalizeResponseCode(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Assess the query-string answer of a `transact.php` call.
 *
 * The documented response values are `1` approved, `2` declined and `3` an error in the
 * transaction data or a system error; anything else is not a documented answer and is unknown.
 * An approval must carry a transaction id and must not contradict its own response code: an
 * approval with `response_code=200` is a response nobody documented, and treating it as money
 * would be a guess.
 */
export function assessNmiTransactResponse(
  raw: Readonly<Record<string, string>>,
  type: NmiTransactionType,
): NmiStatusAssessment {
  const responseValue = (raw["response"] ?? "").trim();
  const responseCode = normalizeResponseCode(raw["response_code"]);
  const meaning = nmiResponseCodeMeaning(responseCode);
  const responseText = sanitizeNmiText(raw["responsetext"]);
  const transactionId = (raw["transactionid"] ?? "").trim();
  const transactionIdOrNull = transactionId.length === 0 ? null : transactionId;

  const unresolved = (reason: string, condition: NmiProviderCondition | null): NmiStatusAssessment => ({
    providerCondition: condition,
    targetStatus: null,
    category: meaning.category,
    responseCode,
    responseText,
    transactionId: transactionIdOrNull,
    requiresReconciliation: true,
    reason,
  });

  if (responseValue !== "1" && responseValue !== "2" && responseValue !== "3") {
    return unresolved("the gateway answer is not one of the documented response values", null);
  }

  if (responseValue === "1") {
    if (transactionIdOrNull === null) {
      return unresolved("the gateway approved without a transaction id", null);
    }
    if (meaning.category !== "approved" && responseCode !== null) {
      return unresolved("the gateway approved with a response code the documentation calls a failure", null);
    }
    const condition = conditionAfterApproval(type);
    const mapping = mapNmiCondition(condition);
    if (type === "refund") {
      return {
        providerCondition: condition,
        targetStatus: null,
        category: meaning.category,
        responseCode,
        responseText,
        transactionId: transactionIdOrNull,
        requiresReconciliation: false,
        reason: "a refund is recorded by the refund service and does not move a payment status",
      };
    }
    return {
      providerCondition: condition,
      targetStatus: mapping.outcome === "mapped" ? mapping.status : null,
      category: meaning.category,
      responseCode,
      responseText,
      transactionId: transactionIdOrNull,
      requiresReconciliation: mapping.outcome === "unresolved",
      reason:
        mapping.outcome === "mapped"
          ? "the gateway approved the transaction"
          : "the gateway approved a condition this file cannot map",
    };
  }

  if (meaning.category === "approved") {
    return unresolved("the gateway reported a failure carrying an approval response code", "unknown");
  }

  if (meaning.requiresReconciliation || meaning.category === "unknown") {
    return unresolved(
      "the gateway reported a failure whose documented outcome is not final or is not documented",
      "unknown",
    );
  }

  return {
    providerCondition: "failed",
    targetStatus: "failed",
    category: meaning.category,
    responseCode,
    responseText,
    transactionId: transactionIdOrNull,
    requiresReconciliation: false,
    reason: "the gateway reported a documented failure and nothing moved",
  };
}

/* -------------------------------------------------------------------------------------------------
 * Query API
 * ---------------------------------------------------------------------------------------------- */

/** The Query API transport: endpoint and form payload in, raw response body out. */
export type NmiQueryTransport = (
  endpoint: string,
  payload: Readonly<Record<string, string>>,
) => Promise<string>;

/**
 * Posts form-encoded data to the Query API and returns the raw body.
 *
 * The endpoint is allowlisted to the two documented URLs, redirects are refused (a redirect is
 * not an answer), the timeout is bounded and a body that is empty or too large is refused. A
 * throw from here means the outcome is unknown, never that the transaction failed.
 */
export const nmiQueryFetchTransport: NmiQueryTransport = async (endpoint, payload) => {
  if (endpoint !== NMI_QUERY_ENDPOINT && endpoint !== NMI_SANDBOX_QUERY_ENDPOINT) {
    throw new Error("invalid query endpoint");
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(payload).toString(),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("NMI query HTTP error");
  const text = await response.text();
  if (text.length === 0 || text.length > NMI_QUERY_RESPONSE_MAXIMUM_BYTES) {
    throw new Error("invalid query response");
  }
  return text;
};

/** One action the Query API reports for a transaction, oldest first. */
export interface NmiQueriedAction {
  readonly actionType: string;
  readonly amount: string | null;
  readonly success: boolean;
  readonly responseCode: string | null;
  readonly responseText: string;
  readonly dateUtc: string | null;
}

/** One transaction record the Query API reports. */
export interface NmiQueriedTransaction {
  readonly transactionId: string;
  readonly condition: NmiProviderCondition;
  readonly orderId: string | null;
  readonly transactionType: string | null;
  readonly actions: readonly NmiQueriedAction[];
}

/** The result of parsing a Query API body. */
export type NmiQueryParseResult =
  | { readonly status: "found"; readonly transaction: NmiQueriedTransaction }
  | { readonly status: "not_found" }
  | { readonly status: "gateway_error"; readonly responseCode: string | null; readonly responseText: string }
  | { readonly status: "unparsable"; readonly reason: string };

const PREDEFINED_XML_ENTITIES: Readonly<Record<string, string>> = deepFreeze({
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
});

/** Decode the XML entities the Query API can emit. */
function decodeXmlText(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/gu, (match: string, entity: string): string => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const point = Number.parseInt(entity.slice(2), 16);
      return Number.isInteger(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
    }
    if (entity.startsWith("#")) {
      const point = Number.parseInt(entity.slice(1), 10);
      return Number.isInteger(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
    }
    const named = PREDEFINED_XML_ENTITIES[entity];
    return named === undefined ? match : named;
  });
}

/** The text of the first `<tag>` element, decoded and trimmed; null when the element is absent. */
function elementText(xml: string, tag: string): string | null {
  const pattern = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "u");
  const match = pattern.exec(xml);
  if (match === null) return null;
  return decodeXmlText(match[1] ?? "").trim();
}

/** Every `<tag>` element body, in document order. */
function elementBlocks(xml: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "gu");
  return [...xml.matchAll(pattern)].map((match) => match[1] ?? "");
}

/**
 * Parse an NMI transaction id.
 *
 * The documented ids are numeric (`1234567890`). The value becomes a form field sent to the
 * gateway, so anything that is not 1 to 20 digits is refused rather than encoded and sent.
 */
export function isNmiTransactionId(value: string): boolean {
  return /^[0-9]{1,20}$/u.test(value);
}

/** Turn whatever the gateway put in `<condition>` into a documented condition, or `unknown`. */
function parseProviderCondition(value: string | null): NmiProviderCondition {
  switch (value) {
    case "pending":
      return "pending";
    case "pendingsettlement":
      return "pendingsettlement";
    case "in_progress":
      return "in_progress";
    case "abandoned":
      return "abandoned";
    case "failed":
      return "failed";
    case "canceled":
      return "canceled";
    case "complete":
      return "complete";
    default:
      return "unknown";
  }
}

/**
 * Parse a Query API response body.
 *
 * The body is `<nm_response>` XML. A transaction record gives the condition and its actions; an
 * `<error_response>` gives the gateway's own error; an empty `<nm_response>` means the gateway
 * has no transaction with that id. Anything else - a body without the root element, a record
 * without a numeric transaction ref, a body over the size cap - is unparsable, which the caller
 * treats as an unknown outcome rather than as a missing transaction.
 */
export function parseNmiQueryResponse(body: string): NmiQueryParseResult {
  if (body.length === 0) return { status: "unparsable", reason: "the gateway answer is empty" };
  if (body.length > NMI_QUERY_RESPONSE_MAXIMUM_BYTES) {
    return { status: "unparsable", reason: "the gateway answer is too large" };
  }
  if (/<nm_response>/u.test(body) === false || /<\/nm_response>/u.test(body) === false) {
    return { status: "unparsable", reason: "the gateway answer is not an nm_response document" };
  }

  const errorBlock = elementBlocks(body, "error_response")[0];
  if (errorBlock !== undefined) {
    return {
      status: "gateway_error",
      responseCode: normalizeResponseCode(elementText(errorBlock, "response_code") ?? undefined),
      responseText: sanitizeNmiText(elementText(errorBlock, "responsetext")),
    };
  }

  const transactionBlock = elementBlocks(body, "transaction")[0];
  if (transactionBlock === undefined) return { status: "not_found" };

  const transactionId = elementText(transactionBlock, "transaction_id") ?? "";
  if (isNmiTransactionId(transactionId) === false) {
    return { status: "unparsable", reason: "the transaction record has no numeric transaction id" };
  }

  const actions: NmiQueriedAction[] = elementBlocks(transactionBlock, "action").map((actionBlock) => {
    const success = elementText(actionBlock, "success");
    const amount = elementText(actionBlock, "amount");
    const responseCode = elementText(actionBlock, "response_code");
    return {
      actionType: sanitizeNmiText(elementText(actionBlock, "action_type")),
      amount: amount !== null && /^[0-9]+\.[0-9]{2,4}$/u.test(amount) ? amount : null,
      success: success === "1",
      responseCode: normalizeResponseCode(responseCode ?? undefined),
      responseText: sanitizeNmiText(elementText(actionBlock, "response_text")),
      dateUtc: elementText(actionBlock, "date"),
    };
  });

  return {
    status: "found",
    transaction: {
      transactionId,
      condition: parseProviderCondition(elementText(transactionBlock, "condition")),
      orderId: elementText(transactionBlock, "order_id"),
      transactionType: elementText(transactionBlock, "transaction_type"),
      actions,
    },
  };
}

/**
 * Assess a transaction the Query API reported.
 *
 * The condition decides the status through `mapNmiCondition`. The newest action's documented
 * response code decides the category, and a record whose condition says money moved but whose
 * newest action says the action failed is a contradiction: unresolved, so nothing is written.
 */
export function assessNmiQueryTransaction(transaction: NmiQueriedTransaction): NmiStatusAssessment {
  const mapping = mapNmiCondition(transaction.condition);
  const oldestToNewest = transaction.actions;
  const newestAction: NmiQueriedAction | null =
    oldestToNewest.length === 0 ? null : (oldestToNewest[oldestToNewest.length - 1] ?? null);
  const meaning = nmiResponseCodeMeaning(newestAction?.responseCode ?? null);
  const responseText = newestAction?.responseText ?? "";

  if (mapping.outcome === "unresolved") {
    return {
      providerCondition: transaction.condition,
      targetStatus: null,
      category: newestAction === null ? null : meaning.category,
      responseCode: newestAction?.responseCode ?? null,
      responseText,
      transactionId: transaction.transactionId,
      requiresReconciliation: true,
      reason: mapping.reason,
    };
  }

  if (
    newestAction !== null &&
    newestAction.success === false &&
    mapping.status !== "failed" &&
    mapping.status !== "voided"
  ) {
    return {
      providerCondition: transaction.condition,
      targetStatus: null,
      category: meaning.category,
      responseCode: newestAction.responseCode,
      responseText,
      transactionId: transaction.transactionId,
      requiresReconciliation: true,
      reason: "the gateway condition and its newest action disagree",
    };
  }

  if (newestAction !== null && meaning.requiresReconciliation) {
    return {
      providerCondition: transaction.condition,
      targetStatus: null,
      category: meaning.category,
      responseCode: newestAction.responseCode,
      responseText,
      transactionId: transaction.transactionId,
      requiresReconciliation: true,
      reason: "the newest action carries a code whose documented outcome is not final",
    };
  }

  return {
    providerCondition: transaction.condition,
    targetStatus: mapping.status,
    category: newestAction === null ? null : meaning.category,
    responseCode: newestAction?.responseCode ?? null,
    responseText,
    transactionId: transaction.transactionId,
    requiresReconciliation: false,
    reason: "the gateway reported the transaction condition",
  };
}

/** The options a Query API lookup needs. */
export interface NmiQueryOptions {
  readonly keyStore: NmiKeyStore;
  readonly encryptionKey: string;
  readonly queryTransport?: NmiQueryTransport;
}

/** The result of asking the gateway about one transaction. */
export type NmiTransactionQueryResult =
  | { readonly status: "found"; readonly transaction: NmiQueriedTransaction; readonly environment: "sandbox" | "production" }
  | { readonly status: "not_found"; readonly environment: "sandbox" | "production" }
  | {
      readonly status: "gateway_error";
      readonly responseCode: string | null;
      readonly responseText: string;
      readonly environment: "sandbox" | "production";
    }
  | { readonly status: "rejected"; readonly reason: string }
  | { readonly status: "unknown"; readonly reason: string };

/**
 * Ask the gateway what happened to one transaction.
 *
 * The active key configuration of the company decides the endpoint, so a sandbox key can never
 * read production data and a production key can never read sandbox data. The private security
 * key is decrypted in memory, sent as `security_key` and never returned or logged. Every
 * transport failure is `unknown`, which the sync turns into reconciliation rather than a failed
 * payment.
 */
export async function queryNmiTransaction(
  companyId: string,
  providerTransactionId: string,
  options: NmiQueryOptions,
): Promise<NmiTransactionQueryResult> {
  if (companyId.trim().length === 0) {
    return { status: "rejected", reason: "the company id must not be empty" };
  }
  if (isNmiTransactionId(providerTransactionId) === false) {
    return { status: "rejected", reason: "the provider transaction id must be 1 to 20 digits" };
  }

  const config = options.keyStore.findActiveByCompany(companyId);
  if (config === null) {
    return { status: "rejected", reason: "no NMI key configuration exists for this company" };
  }

  let secretKey: string;
  try {
    secretKey = decryptKey(config.secretKeyEncrypted, options.encryptionKey);
  } catch {
    return { status: "rejected", reason: "failed to decrypt the stored NMI keys" };
  }

  let body: string;
  try {
    body = await (options.queryTransport ?? nmiQueryFetchTransport)(nmiQueryEndpointFor(config.environment), {
      security_key: secretKey,
      transaction_id: providerTransactionId,
    });
  } catch {
    // A lost answer may follow a settled transaction. Never surface the error text: it can echo
    // the request, and the request carries the security key.
    return { status: "unknown", reason: "NMI outcome unknown; reconcile before retrying" };
  }

  const parsed = parseNmiQueryResponse(body);
  switch (parsed.status) {
    case "found":
      return { status: "found", transaction: parsed.transaction, environment: config.environment };
    case "not_found":
      return { status: "not_found", environment: config.environment };
    case "gateway_error":
      return {
        status: "gateway_error",
        responseCode: parsed.responseCode,
        responseText: parsed.responseText,
        environment: config.environment,
      };
    case "unparsable":
      return { status: "unknown", reason: `NMI outcome unknown; reconcile before retrying (${parsed.reason})` };
  }
}

/* -------------------------------------------------------------------------------------------------
 * Transaction state and its store
 * ---------------------------------------------------------------------------------------------- */

/** The platform's record of one provider transaction's status. */
export interface NmiTransactionState {
  readonly id: string;
  readonly companyId: string;
  readonly providerTransactionId: string;
  readonly status: NmiPlatformPaymentStatus;
  readonly providerCondition: NmiProviderCondition | null;
  readonly responseCode: string | null;
  /** The optimistic locking version: every applied sync adds one. */
  readonly version: number;
  readonly lastSyncedAtEpochMs: number;
}

/**
 * What the store reads and writes: the transaction states. The store is the caller's; the
 * in-memory implementation below is a reference store for the service and its gate.
 */
export interface NmiTransactionStateStore {
  /** Store a new state. An id or provider transaction id already stored is refused. */
  insert(state: NmiTransactionState): void;
  /** The state an id holds, or null. */
  findById(id: string): NmiTransactionState | null;
  /** The state a company holds for a provider transaction, or null. */
  findByProviderTransactionId(companyId: string, providerTransactionId: string): NmiTransactionState | null;
  /** Every state a company holds. */
  findByCompany(companyId: string): NmiTransactionState[];
  /**
   * Write the next state only when the stored version is `expectedVersion`, the company is
   * unchanged and the version advances by exactly one. Returns false when the write loses.
   */
  save(next: NmiTransactionState, expectedVersion: number): boolean;
}

/** The key a provider transaction is unique under: the company plus the provider's id. */
function stateKeyOf(companyId: string, providerTransactionId: string): string {
  return `${companyId}\u0000${providerTransactionId}`;
}

/**
 * The in-memory store: a reference implementation that keys on state id and enforces the rules
 * the claimed guarantees rest on - one state per provider transaction per company, an immutable
 * company, a strictly increasing version and no write from a stale read.
 */
export class InMemoryNmiTransactionStateStore implements NmiTransactionStateStore {
  private readonly states = new Map<string, NmiTransactionState>();
  private readonly keys = new Map<string, string>();

  insert(state: NmiTransactionState): void {
    if (this.states.has(state.id)) throw new Error("duplicate transaction state id");
    const key = stateKeyOf(state.companyId, state.providerTransactionId);
    if (this.keys.has(key)) throw new Error("duplicate provider transaction id");
    if (state.version !== 1) throw new Error("a new transaction state starts at version 1");
    this.states.set(state.id, state);
    this.keys.set(key, state.id);
  }

  findById(id: string): NmiTransactionState | null {
    return this.states.get(id) ?? null;
  }

  findByProviderTransactionId(companyId: string, providerTransactionId: string): NmiTransactionState | null {
    const id = this.keys.get(stateKeyOf(companyId, providerTransactionId));
    return id === undefined ? null : this.findById(id);
  }

  findByCompany(companyId: string): NmiTransactionState[] {
    return [...this.states.values()].filter((state) => state.companyId === companyId);
  }

  save(next: NmiTransactionState, expectedVersion: number): boolean {
    const current = this.states.get(next.id);
    if (current === undefined) return false;
    if (current.companyId !== next.companyId) return false;
    if (current.providerTransactionId !== next.providerTransactionId) return false;
    if (current.version !== expectedVersion) return false;
    if (next.version !== expectedVersion + 1) return false;
    this.states.set(next.id, next);
    return true;
  }
}

/* -------------------------------------------------------------------------------------------------
 * Status sync
 * ---------------------------------------------------------------------------------------------- */

/** The audit entry one applied sync hands to the caller's audit writer. Never carries a secret. */
export interface NmiStatusAuditEntry {
  readonly action: "payment.nmi.status_synced";
  readonly companyId: string;
  readonly provider: "nmi";
  readonly providerTransactionId: string;
  readonly fromStatus: NmiPlatformPaymentStatus | null;
  readonly toStatus: NmiPlatformPaymentStatus;
  readonly providerCondition: NmiProviderCondition | null;
  readonly responseCode: string | null;
  readonly occurredAtEpochMs: number;
}

/** What one status sync did. */
export type NmiStatusSyncStatus =
  | "created"
  | "synced"
  | "unchanged"
  | "not_applicable"
  | "unresolved"
  | "refused";

/** The outcome of one status sync, in one shape so every caller handles every case. */
export interface NmiStatusSyncOutcome {
  readonly status: NmiStatusSyncStatus;
  readonly reason: string;
  readonly assessment: NmiStatusAssessment | null;
  readonly state: NmiTransactionState | null;
  readonly previousStatus: NmiPlatformPaymentStatus | null;
}

/** The options a status write needs. */
export interface NmiStatusApplyOptions {
  readonly store: NmiTransactionStateStore;
  readonly occurredAtEpochMs: number;
  readonly recordAudit?: (entry: NmiStatusAuditEntry) => void;
}

/**
 * Apply an assessment to a stored transaction state.
 *
 * The order is the whole safety argument: an unknown outcome writes nothing; a status the state
 * already holds writes nothing; a status the state may not move to is refused; and the write
 * itself only succeeds when nobody else changed the row since it was read. The audit entry is
 * written only after the store accepted the write, so the log never claims a change the
 * database refused.
 */
export function applyNmiStatusAssessment(
  current: NmiTransactionState,
  assessment: NmiStatusAssessment,
  options: NmiStatusApplyOptions,
): NmiStatusSyncOutcome {
  if (assessment.targetStatus === null) {
    if (assessment.requiresReconciliation) {
      return {
        status: "unresolved",
        reason: assessment.reason,
        assessment,
        state: current,
        previousStatus: current.status,
      };
    }
    return {
      status: "not_applicable",
      reason: assessment.reason,
      assessment,
      state: current,
      previousStatus: current.status,
    };
  }

  if (assessment.targetStatus === current.status) {
    return {
      status: "unchanged",
      reason: `the transaction is already ${current.status}`,
      assessment,
      state: current,
      previousStatus: current.status,
    };
  }

  if (canAdvanceNmiStatus(current.status, assessment.targetStatus) === false) {
    return {
      status: "refused",
      reason: `the gateway reported ${assessment.targetStatus} for a transaction the platform holds as ${current.status}`,
      assessment,
      state: current,
      previousStatus: current.status,
    };
  }

  const next: NmiTransactionState = {
    id: current.id,
    companyId: current.companyId,
    providerTransactionId: current.providerTransactionId,
    status: assessment.targetStatus,
    providerCondition: assessment.providerCondition,
    responseCode: assessment.responseCode,
    version: current.version + 1,
    lastSyncedAtEpochMs: options.occurredAtEpochMs,
  };

  if (options.store.save(next, current.version) === false) {
    return {
      status: "refused",
      reason: "the transaction state changed while the status was syncing",
      assessment,
      state: options.store.findById(current.id),
      previousStatus: current.status,
    };
  }

  if (options.recordAudit !== undefined) {
    options.recordAudit({
      action: "payment.nmi.status_synced",
      companyId: next.companyId,
      provider: "nmi",
      providerTransactionId: next.providerTransactionId,
      fromStatus: current.status,
      toStatus: next.status,
      providerCondition: next.providerCondition,
      responseCode: next.responseCode,
      occurredAtEpochMs: options.occurredAtEpochMs,
    });
  }

  return {
    status: "synced",
    reason: assessment.reason,
    assessment,
    state: next,
    previousStatus: current.status,
  };
}

/** The input of recording the answer of a `transact.php` call. */
export interface NmiTransactResultInput {
  readonly companyId: string;
  readonly transactionType: NmiTransactionType;
  readonly raw: Readonly<Record<string, string>>;
}

/**
 * Record the answer of a payment call: assess it, then create the state or advance it.
 *
 * This is the seam STEP 151's caller uses right after a payment: the gateway's answer arrives as
 * a field map, and the platform's record of that transaction starts (or moves) from it. A new
 * transaction the gateway approved and identified is created at the assessed status; an existing
 * one goes through the same optimistic, forward-only write as a queried one.
 */
export function recordNmiTransactResult(
  input: NmiTransactResultInput,
  options: NmiStatusApplyOptions,
): NmiStatusSyncOutcome {
  const assessment = assessNmiTransactResponse(input.raw, input.transactionType);
  const providerTransactionId = assessment.transactionId;

  if (providerTransactionId === null) {
    return {
      status: "unresolved",
      reason: assessment.reason,
      assessment,
      state: null,
      previousStatus: null,
    };
  }

  const current = options.store.findByProviderTransactionId(input.companyId, providerTransactionId);

  if (current !== null) return applyNmiStatusAssessment(current, assessment, options);

  if (assessment.targetStatus === null) {
    return {
      status: assessment.requiresReconciliation ? "unresolved" : "not_applicable",
      reason: assessment.reason,
      assessment,
      state: null,
      previousStatus: null,
    };
  }

  const state: NmiTransactionState = {
    id: randomUUID(),
    companyId: input.companyId,
    providerTransactionId,
    status: assessment.targetStatus,
    providerCondition: assessment.providerCondition,
    responseCode: assessment.responseCode,
    version: 1,
    lastSyncedAtEpochMs: options.occurredAtEpochMs,
  };

  try {
    options.store.insert(state);
  } catch {
    return {
      status: "refused",
      reason: "the transaction state could not be created",
      assessment,
      state: null,
      previousStatus: null,
    };
  }

  if (options.recordAudit !== undefined) {
    options.recordAudit({
      action: "payment.nmi.status_synced",
      companyId: state.companyId,
      provider: "nmi",
      providerTransactionId: state.providerTransactionId,
      fromStatus: null,
      toStatus: state.status,
      providerCondition: state.providerCondition,
      responseCode: state.responseCode,
      occurredAtEpochMs: options.occurredAtEpochMs,
    });
  }

  return {
    status: "created",
    reason: assessment.reason,
    assessment,
    state,
    previousStatus: null,
  };
}

/** The options a queried sync needs: the query credentials and the state write. */
export interface NmiStatusSyncOptions extends NmiQueryOptions, NmiStatusApplyOptions {}

/**
 * Sync one transaction's status by asking the gateway.
 *
 * A transaction the platform does not hold is refused rather than created: the gateway knows
 * transactions the platform never made, and importing one from a sync would be inventing a
 * payment. A transaction the gateway does not know, a gateway error and a lost answer are all
 * unresolved: they go to reconciliation, never to a status.
 */
export async function syncNmiTransactionStatus(
  input: { readonly companyId: string; readonly providerTransactionId: string },
  options: NmiStatusSyncOptions,
): Promise<NmiStatusSyncOutcome> {
  const current = options.store.findByProviderTransactionId(input.companyId, input.providerTransactionId);
  if (current === null) {
    return {
      status: "refused",
      reason: "the platform holds no transaction state for this provider transaction",
      assessment: null,
      state: null,
      previousStatus: null,
    };
  }

  const query = await queryNmiTransaction(input.companyId, input.providerTransactionId, options);

  switch (query.status) {
    case "found":
      return applyNmiStatusAssessment(current, assessNmiQueryTransaction(query.transaction), options);
    case "not_found":
      return {
        status: "unresolved",
        reason: "the gateway has no record of this transaction; reconcile before retrying",
        assessment: null,
        state: current,
        previousStatus: current.status,
      };
    case "gateway_error":
      return {
        status: "unresolved",
        reason: `the gateway reported error ${query.responseCode ?? "unknown"} for the query`,
        assessment: null,
        state: current,
        previousStatus: current.status,
      };
    case "unknown":
      return {
        status: "unresolved",
        reason: query.reason,
        assessment: null,
        state: current,
        previousStatus: current.status,
      };
    case "rejected":
      return {
        status: "refused",
        reason: query.reason,
        assessment: null,
        state: current,
        previousStatus: current.status,
      };
  }
}

/* -------------------------------------------------------------------------------------------------
 * Sandbox end-to-end verification
 * ---------------------------------------------------------------------------------------------- */

/** The steps of the documented cycle, in the order NMI's documentation supports them. */
export type NmiSandboxStepName =
  | "sale"
  | "authorization"
  | "capture"
  | "refund"
  | "authorization_for_void"
  | "void";

/** What one cycle step did. */
export type NmiSandboxStepOutcome =
  | "approved"
  | "declined"
  | "error"
  | "rejected"
  | "unknown"
  | "not_attempted";

/** One step of the cycle. */
export interface NmiSandboxStepResult {
  readonly step: NmiSandboxStepName;
  readonly outcome: NmiSandboxStepOutcome;
  readonly responseCode: string | null;
  readonly providerTransactionId: string | null;
  readonly detail: string;
}

/** The cycle's answer: whether the sandbox path works end to end, and what each step did. */
export interface NmiSandboxCycleReport {
  readonly status: "verified" | "failed" | "blocked";
  readonly environment: "sandbox";
  readonly steps: readonly NmiSandboxStepResult[];
  readonly blockedReason: string | null;
  readonly documentationUrls: readonly string[];
  readonly sandboxEndpoints: readonly string[];
  readonly completedAtEpochMs: number;
}

/** What the cycle charges and refunds. */
export interface NmiSandboxCycleInput {
  readonly companyId: string;
  /** A Collect.js sandbox token; the platform never sees a card value. */
  readonly token: string;
  /** The sale and auth amount, in dollars and cents. */
  readonly amount: string;
  /** The partial refund amount, in dollars and cents, at most `amount`. */
  readonly refundAmount: string;
  readonly reference: string | null;
}

/** The options the cycle needs. */
export interface NmiSandboxCycleOptions {
  readonly keyStore: NmiKeyStore;
  readonly encryptionKey: string;
  readonly transport?: NmiHttpTransport;
  readonly occurredAtEpochMs: number;
}

const MONEY_PATTERN = /^(?:0|[1-9][0-9]*)\.(?:[0-9]{2})$/u;

function blockedReport(reason: string, steps: readonly NmiSandboxStepResult[], occurredAtEpochMs: number): NmiSandboxCycleReport {
  return {
    status: "blocked",
    environment: "sandbox",
    steps,
    blockedReason: reason,
    documentationUrls: NMI_STATUS_SYNC_DOCUMENTATION_URLS,
    sandboxEndpoints: NMI_SANDBOX_ENDPOINTS,
    completedAtEpochMs: occurredAtEpochMs,
  };
}

/**
 * Run the documented sandbox cycle: sale, auth, capture, partial refund, auth and void.
 *
 * Every step goes through STEP 151's `processNmiPayment`, which resolves this company's
 * decrypted keys and posts to the endpoint the key configuration's environment selects. The
 * cycle refuses a production key configuration before it sends anything and wraps the transport
 * so that only the sandbox endpoint is reachable, so a live charge cannot be produced by a
 * misconfiguration. A step whose outcome is unknown stops the cycle: the remaining steps are
 * `not_attempted` and the report says to reconcile before retrying, because a retried sale after
 * a lost answer is how a card is charged twice.
 */
export async function runNmiSandboxCycle(
  input: NmiSandboxCycleInput,
  options: NmiSandboxCycleOptions,
): Promise<NmiSandboxCycleReport> {
  if (input.companyId.trim().length === 0) {
    return blockedReport("the company id must not be empty", [], options.occurredAtEpochMs);
  }
  if (input.token.trim().length === 0) {
    return blockedReport("a Collect.js sandbox token is required", [], options.occurredAtEpochMs);
  }
  if (MONEY_PATTERN.test(input.amount) === false || input.amount === "0.00") {
    return blockedReport("the amount must be positive dollars and cents", [], options.occurredAtEpochMs);
  }
  if (MONEY_PATTERN.test(input.refundAmount) === false || input.refundAmount === "0.00") {
    return blockedReport("the refund amount must be positive dollars and cents", [], options.occurredAtEpochMs);
  }

  const config = options.keyStore.findActiveByCompany(input.companyId);
  if (config === null) {
    return blockedReport("no NMI key configuration exists for this company", [], options.occurredAtEpochMs);
  }
  if (config.environment !== "sandbox") {
    return blockedReport(
      "the sandbox cycle refuses to run against a production key configuration",
      [],
      options.occurredAtEpochMs,
    );
  }

  const transport = options.transport ?? nmiFetchTransport;
  const sandboxOnly: NmiHttpTransport = async (endpoint, payload) => {
    if (endpoint !== NMI_SANDBOX_API_ENDPOINT) {
      throw new Error("the sandbox cycle refuses a non-sandbox endpoint");
    }
    return transport(endpoint, payload);
  };

  const paymentOptions: ProcessNmiPaymentOptions = {
    store: options.keyStore,
    encryptionKey: options.encryptionKey,
    transport: sandboxOnly,
    occurredAtEpochMs: options.occurredAtEpochMs,
  };

  const steps: NmiSandboxStepResult[] = [];

  const attempt = async (
    step: NmiSandboxStepName,
    request: NmiPaymentRequest,
  ): Promise<{ approved: boolean; transactionId: string | null }> => {
    const result = await processNmiPayment(request, paymentOptions);

    if (result.status === "success") {
      steps.push({
        step,
        outcome: "approved",
        responseCode: "100",
        providerTransactionId: result.transactionId,
        detail: `${step} approved by the sandbox gateway`,
      });
      return { approved: true, transactionId: result.transactionId };
    }

    if (result.status === "transport_error") {
      steps.push({
        step,
        outcome: "unknown",
        responseCode: null,
        providerTransactionId: null,
        detail: `${step} has an unknown outcome; reconcile before retrying`,
      });
      return { approved: false, transactionId: null };
    }

    if (result.status === "rejected") {
      steps.push({
        step,
        outcome: "rejected",
        responseCode: null,
        providerTransactionId: null,
        detail: `${step} was rejected before it was sent: ${sanitizeNmiText(result.reason)}`,
      });
      return { approved: false, transactionId: null };
    }

    const meaning = nmiResponseCodeMeaning(result.responseCode);
    const outcome: NmiSandboxStepOutcome =
      meaning.category === "declined"
        ? "declined"
        : meaning.category === "rejected"
          ? "rejected"
          : meaning.category === "error"
            ? "error"
            : "unknown";
    steps.push({
      step,
      outcome,
      responseCode: result.responseCode,
      providerTransactionId: null,
      detail: `${step} failed with response code ${result.responseCode}: ${sanitizeNmiText(result.responseMessage)}`,
    });
    return { approved: false, transactionId: null };
  };

  const notAttempted = (names: readonly NmiSandboxStepName[]): void => {
    for (const name of names) {
      steps.push({
        step: name,
        outcome: "not_attempted",
        responseCode: null,
        providerTransactionId: null,
        detail: `${name} was not attempted because an earlier step did not complete`,
      });
    }
  };

  const base: NmiPaymentRequest = {
    companyId: input.companyId,
    type: "sale",
    amount: input.amount,
    token: input.token,
    customerId: null,
    reference: input.reference,
    originalTransactionId: null,
    capture: false,
  };

  const report = (status: "verified" | "failed"): NmiSandboxCycleReport => ({
    status,
    environment: "sandbox",
    steps,
    blockedReason: null,
    documentationUrls: NMI_STATUS_SYNC_DOCUMENTATION_URLS,
    sandboxEndpoints: NMI_SANDBOX_ENDPOINTS,
    completedAtEpochMs: options.occurredAtEpochMs,
  });

  const sale = await attempt("sale", base);
  if (!sale.approved || sale.transactionId === null) {
    notAttempted(["authorization", "capture", "refund", "authorization_for_void", "void"]);
    return report("failed");
  }

  const authorization = await attempt("authorization", { ...base, type: "authorization" });
  if (!authorization.approved || authorization.transactionId === null) {
    notAttempted(["capture", "refund", "authorization_for_void", "void"]);
    return report("failed");
  }

  const capture = await attempt("capture", {
    ...base,
    type: "capture",
    token: null,
    amount: input.amount,
    originalTransactionId: authorization.transactionId,
  });
  if (!capture.approved) {
    notAttempted(["refund", "authorization_for_void", "void"]);
    return report("failed");
  }

  const refund = await attempt("refund", {
    ...base,
    type: "refund",
    token: null,
    amount: input.refundAmount,
    originalTransactionId: sale.transactionId,
  });
  if (!refund.approved) {
    notAttempted(["authorization_for_void", "void"]);
    return report("failed");
  }

  const secondAuthorization = await attempt("authorization_for_void", { ...base, type: "authorization" });
  if (!secondAuthorization.approved || secondAuthorization.transactionId === null) {
    notAttempted(["void"]);
    return report("failed");
  }

  const voided = await attempt("void", {
    ...base,
    type: "void",
    token: null,
    amount: null,
    originalTransactionId: secondAuthorization.transactionId,
  });
  if (!voided.approved) return report("failed");

  return report("verified");
}
