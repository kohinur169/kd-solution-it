// path: lib/payments/adapters/payoneer-payout.ts

/**
 * The Payoneer adapter's automatic bank linking, payout execution and payout status handling: the
 * service that registers a merchant as a Payoneer payee with its payout method, submits one payout
 * instruction for it, and reads that payout's status back without ever claiming more than the
 * provider said.
 *
 * ## What the feature list asks for
 *
 * Section 10: "Merchants add a payout bank account in profile payout settings. The bank is added
 * automatically to Payoneer or Airwallex." Section 6 records Payoneer's row in the provider matrix
 * as payouts only. Section 10 also says "failed payouts are reported to the merchant by email" —
 * which is why this file makes failure a claim it never makes on its own.
 *
 * ## The documented flow this follows
 *
 * Read in the STEP 156 session from Payoneer's own pages (URLs in `docs/final/PROVIDER_DOCS.md`):
 *
 * - White Label Registration & Payouts: the partner collects the payee's details, **registers the
 *   payee with Payoneer**, funds the program, then submits payout instructions.
 * - Register Payee with token: `POST /v4/programs/{program_id}/payees/register-payee-with-token`
 *   with `payee_id`, a `payee` object (`type: "company"`, `company { name, url, legal_type,
 *   incorporated_address_1, incorporated_address_2, incorporated_city, incorporated_state,
 *   incorporated_zipcode, incorporated_country }`) and a `payout_method` object
 *   (`type: "BANKTRANSFER"`, `bank_account_type`, `country`, `currency`). The response carries a
 *   token the payee continues with.
 * - White Label Payouts: submit to `POST /v4/programs/{program_id}/masspayouts` with a `Payments`
 *   array; each payment carries `client_reference_id`, `payee_id`, `amount`, `description`,
 *   `currency` and optionally `payout_method_details` (the payee, the payout method and its bank
 *   `details`: `bank_name`, `account_name`, `account_number`, `account_type`, `routing_number`).
 *   Payoneer validates the batch and "the API response lists the specific `client_reference_id`
 *   values that failed"; each instruction is then reported by its own webhook.
 * - Payout status: `GET /v4/programs/{program_id}/payouts/{client_reference_id}/status`, answered
 *   with `result.status` and, once the funds are transferred, `result.load_date`.
 * - Notifications: request received, request accepted, account/card loaded, sent to bank, failed
 *   bank transfer, payout canceled. The signing scheme is **not** readable from the pages fetched in
 *   STEP 154, so a notification is only ever applied through a verifier the caller supplies, and a
 *   delivery with no verifier is refused instead of believed.
 *
 * ## The three money rules this file keeps
 *
 * 1. **Only documented status strings mean anything.** `Transferred` is the one status value the
 *    pages read publish, and it is the only string that maps to success. Any other value is
 *    `unknown`, which the platform keeps pending and reconciles — it is never success and never
 *    failed, because a wrong failure sends the merchant an email about money that may have arrived.
 * 2. **A submit answer is not a delivery.** An accepted instruction is `pending`: Payoneer processes
 *    payouts asynchronously and reports them by status query or webhook. Only the status endpoints
 *    can move a payout to success or failure.
 * 3. **A credential or transport problem is never a refusal.** A `401`, `403`, `404`, `408`, `429`,
 *    `5xx`, an unreadable body or a thrown transport is `unknown` with `requiresReconciliation`,
 *    not `rejected`; only the documented validation answers (`400`, `409`, `422`) refuse an
 *    instruction, because only those prove the instruction was judged.
 *
 * ## Idempotency
 *
 * `client_reference_id` is the platform's payout identity and Payoneer's own payment key. A
 * submission is stored against it before the answer is applied and re-submission reads that record
 * instead of sending a second instruction, so a retried job cannot pay twice. The store write is
 * version-guarded, and the amount and payee of an existing reference can never change.
 *
 * ## What this file is not
 *
 * It is not the payout core (`lib/payments/payout-execution.ts` owns the execution record, the
 * failure email and the platform statuses; this file answers its ports and offers the mapping), not
 * the payout threshold or cooling checks (STEPs 141-142), not the bank change verification flow
 * (STEP 140), not the key configuration or token grant (STEP 155 owns those, and the access token is
 * handed in), not the webhook endpoint (no route is added), and not a migration: the reference store
 * is the caller's to replace with PostgreSQL.
 */

import { randomUUID } from "node:crypto";
import { deepFreeze } from "../../utils/freeze.ts";
import type { ProviderLinkResult } from "../payout-bank-account.ts";
import type { PayoutStatus, ProviderPayoutResult } from "../payout-execution.ts";
import {
  PAYONEER_MAXIMUM_PAYOUTS_PER_CALL,
  PAYONEER_PRODUCTION_API_BASE,
  PAYONEER_SANDBOX_API_BASE,
  PAYONEER_PROVIDER_KEY,
  sanitizePayoneerText,
} from "./payoneer.ts";

/* -------------------------------------------------------------------------------------------------
 * Documented paths and limits
 * ---------------------------------------------------------------------------------------------- */

/** The documented payee registration path, with the program in the documented placeholder. */
export const PAYONEER_REGISTER_PAYEE_PATH = "/v4/programs/{program_id}/payees/register-payee-with-token";

/** The documented mass payout path. */
export const PAYONEER_MASS_PAYOUT_PATH = "/v4/programs/{program_id}/masspayouts";

/** The documented payout status path. */
export const PAYONEER_PAYOUT_STATUS_PATH = "/v4/programs/{program_id}/payouts/{client_reference_id}/status";

/** True when every path constant above is a documented program path; asserted by the gate. */
export const PAYONEER_API_PATHS_ARE_DOCUMENTED: boolean =
  PAYONEER_REGISTER_PAYEE_PATH.startsWith("/v4/programs/{program_id}/") &&
  PAYONEER_MASS_PAYOUT_PATH.startsWith("/v4/programs/{program_id}/") &&
  PAYONEER_PAYOUT_STATUS_PATH.startsWith("/v4/programs/{program_id}/") &&
  PAYONEER_REGISTER_PAYEE_PATH.endsWith("/payees/register-payee-with-token") &&
  PAYONEER_MASS_PAYOUT_PATH.endsWith("/masspayouts") &&
  PAYONEER_PAYOUT_STATUS_PATH.endsWith("/status");

/** The documented status value that means the funds were transferred to the payee. */
export const PAYONEER_TRANSFERRED_STATUS = "Transferred";

/** The documented payout method type for a bank transfer. */
export const PAYONEER_BANK_TRANSFER_METHOD = "BANKTRANSFER";

/** The currency this platform pays out in; section 8 fixes USD for the platform. */
export const PAYONEER_PAYOUT_CURRENCY = "USD";

/** The largest provider answer this file reads. */
export const PAYONEER_PAYOUT_ANSWER_MAXIMUM_BYTES = 262_144;

/** The longest provider text this file keeps. */
export const PAYONEER_PAYOUT_TEXT_MAXIMUM_LENGTH = 300;

/** The two environments the adapter can call. */
export type PayoneerPayoutEnvironment = "sandbox" | "production";

/** The API base of an environment. */
export function payoneerApiBaseFor(environment: PayoneerPayoutEnvironment): string {
  return environment === "sandbox" ? PAYONEER_SANDBOX_API_BASE : PAYONEER_PRODUCTION_API_BASE;
}

/** Fill the documented program placeholder in a path. */
export function payoneerProgramPath(path: string, programId: string): string {
  return path.replace("{program_id}", encodeURIComponent(programId));
}

/* -------------------------------------------------------------------------------------------------
 * Shapes
 * ---------------------------------------------------------------------------------------------- */

/** The bank details section 10 collects, in the documented payout-method vocabulary. */
export interface PayoneerBankDetails {
  readonly bankName: string;
  readonly accountName: string;
  readonly accountNumber: string;
  /** The documented nine digit routing number for a US account. */
  readonly routingNumber: string | null;
  /** The SWIFT/BIC for an account outside the routing-number system. */
  readonly swiftCode: string | null;
  /** The ISO-3166 alpha-2 country of the bank account. */
  readonly country: string;
}

/** The merchant a payee registration describes. */
export interface PayoneerPayeeProfile {
  readonly companyId: string;
  /** The platform's payee reference: the payout bank account record id. */
  readonly payeeId: string;
  readonly companyName: string;
  readonly companyUrl: string | null;
  readonly legalType: string;
  readonly address1: string;
  readonly address2: string | null;
  readonly city: string;
  readonly state: string;
  readonly zipCode: string;
  readonly country: string;
  readonly currency: string;
}

/** What registering a payee did. */
export type PayoneerPayeeLinkResult =
  | {
      readonly outcome: "linked";
      /** Payoneer's payee reference: what every later payout names. */
      readonly providerPayeeId: string;
      /** The registration token or url Payoneer returned, when it returned one. */
      readonly registrationReference: string | null;
      readonly programConfirmed: boolean;
    }
  | {
      readonly outcome: "rejected";
      readonly reason: string;
      readonly programConfirmed: boolean;
    }
  | {
      readonly outcome: "unknown";
      readonly reason: string;
      readonly requiresReconciliation: boolean;
      readonly programConfirmed: boolean;
    };

/** The payee registration request. */
export interface PayoneerPayeeRegistration {
  readonly environment: PayoneerPayoutEnvironment;
  readonly accessToken: string;
  readonly programId: string;
  readonly profile: PayoneerPayeeProfile;
  readonly bank: PayoneerBankDetails;
}

/** What submitting a payout did. */
export type PayoneerPayoutSubmitResult =
  | {
      readonly outcome: "pending";
      readonly providerPayoutId: string | null;
      readonly clientReferenceId: string;
      readonly requiresReconciliation: boolean;
      readonly programConfirmed: boolean;
    }
  | {
      readonly outcome: "rejected";
      readonly reason: string;
      readonly clientReferenceId: string;
      readonly programConfirmed: boolean;
    }
  | {
      readonly outcome: "unknown";
      readonly reason: string;
      readonly clientReferenceId: string;
      readonly requiresReconciliation: boolean;
      readonly programConfirmed: boolean;
    };

/** One payout instruction. */
export interface PayoneerPayoutInstruction {
  readonly environment: PayoneerPayoutEnvironment;
  readonly accessToken: string;
  readonly programId: string;
  readonly companyId: string;
  /** The platform's payout identity and Payoneer's payment key: the idempotency key. */
  readonly clientReferenceId: string;
  readonly providerPayeeId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly description: string;
  /** The bank details, sent with the payment when the platform has them (one step payments). */
  readonly bank: PayoneerBankDetails | null;
  readonly payeeName: string | null;
}

/** What reading a payout's status found. */
export type PayoneerPayoutStatusResult =
  | {
      readonly outcome: "success";
      readonly providerStatus: string;
      readonly clientReferenceId: string;
      readonly loadedAtIso: string | null;
    }
  | {
      readonly outcome: "pending";
      readonly providerStatus: string;
      readonly clientReferenceId: string;
    }
  | {
      readonly outcome: "failed";
      readonly providerStatus: string;
      readonly reason: string;
      readonly clientReferenceId: string;
    }
  | {
      readonly outcome: "unknown";
      readonly providerStatus: string | null;
      readonly reason: string;
      readonly clientReferenceId: string;
      readonly requiresReconciliation: boolean;
    };

/* -------------------------------------------------------------------------------------------------
 * Text, numbers and validation
 * ---------------------------------------------------------------------------------------------- */

/**
 * Format a minor-unit amount as the documented decimal string.
 *
 * Money is integer minor units here and a decimal string on the wire, so the only arithmetic is a
 * division by one hundred and a two digit remainder: no floating point ever touches an amount.
 */
export function payoneerAmountString(amountMinor: bigint): string | null {
  if (amountMinor <= 0n) return null;
  const whole = amountMinor / 100n;
  const cents = amountMinor % 100n;
  return `${whole.toString()}.${cents.toString().padStart(2, "0")}`;
}

const PAYEE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;
const CLIENT_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;
const PROGRAM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const CURRENCY_PATTERN = /^[A-Z]{3}$/u;
const COUNTRY_PATTERN = /^[A-Z]{2}$/u;
const TEXT_PATTERN = /^[^\u0000-\u001f\u007f]{1,120}$/u;
const BANK_NAME_PATTERN = /^[^\u0000-\u001f\u007f]{2,120}$/u;
const ACCOUNT_NAME_PATTERN = /^[^\u0000-\u001f\u007f]{2,120}$/u;
const ACCOUNT_NUMBER_PATTERN = /^[0-9]{6,34}$/u;
const ROUTING_NUMBER_PATTERN = /^[0-9]{9}$/u;
const SWIFT_PATTERN = /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/u;
const STATE_PATTERN = /^[A-Za-z]{2}$/u;
const ZIP_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 -]{0,11}$/u;
const LEGAL_TYPE_PATTERN = /^[A-Z][A-Z_]{1,31}$/u;
const HTTPS_URL_PATTERN = /^https:\/\/[A-Za-z0-9][A-Za-z0-9.-]{0,190}(\/[!-~]{0,190})?$/u;

/** The reason a bank block is invalid, or null when it is valid. */
export function validatePayoneerBankDetails(bank: PayoneerBankDetails): string | null {
  if (BANK_NAME_PATTERN.test(bank.bankName) === false) return "the bank name must be 2 to 120 characters";
  if (ACCOUNT_NAME_PATTERN.test(bank.accountName) === false) return "the account name must be 2 to 120 characters";
  if (ACCOUNT_NUMBER_PATTERN.test(bank.accountNumber) === false) return "the account number must be 6 to 34 digits";
  if (bank.routingNumber === null && bank.swiftCode === null) {
    return "either a routing number or a SWIFT code is required";
  }
  if (bank.routingNumber !== null && ROUTING_NUMBER_PATTERN.test(bank.routingNumber) === false) {
    return "the routing number must be 9 digits";
  }
  if (bank.swiftCode !== null && SWIFT_PATTERN.test(bank.swiftCode) === false) return "the SWIFT code is not valid";
  if (COUNTRY_PATTERN.test(bank.country) === false) return "the bank country must be a two letter code";
  return null;
}

/** The reason a payee profile is invalid, or null when it is valid. */
export function validatePayoneerPayeeProfile(profile: PayoneerPayeeProfile): string | null {
  if (PAYEE_ID_PATTERN.test(profile.payeeId) === false) return "the payee id is invalid";
  if (TEXT_PATTERN.test(profile.companyName) === false) return "the company name must not be empty";
  if (profile.companyUrl !== null && profile.companyUrl.length > 0 && HTTPS_URL_PATTERN.test(profile.companyUrl) === false) {
    return "the company url must be an https url";
  }
  if (LEGAL_TYPE_PATTERN.test(profile.legalType) === false) return "the legal type must be an upper case code";
  if (TEXT_PATTERN.test(profile.address1) === false) return "the address line must not be empty";
  if (profile.address2 !== null && TEXT_PATTERN.test(profile.address2) === false) return "the second address line is invalid";
  if (TEXT_PATTERN.test(profile.city) === false) return "the city must not be empty";
  if (STATE_PATTERN.test(profile.state) === false) return "the state must be a two letter code";
  if (ZIP_PATTERN.test(profile.zipCode) === false) return "the postal code is invalid";
  if (COUNTRY_PATTERN.test(profile.country) === false) return "the country must be a two letter code";
  if (CURRENCY_PATTERN.test(profile.currency) === false) return "the currency must be a three letter code";
  return null;
}

/* -------------------------------------------------------------------------------------------------
 * The documented request bodies
 * ---------------------------------------------------------------------------------------------- */

/**
 * Build the documented Register Payee with token body.
 *
 * The field names and nesting are the ones the published example uses. `payout_method` names a bank
 * transfer, the account holder type and the currency, which is what tells Payoneer which banking
 * fields the payee will be asked for; the bank numbers themselves travel with the payout in the one
 * step flow, because the pages read publish no request that carries them at registration.
 */
export function buildPayoneerRegisterPayeeBody(
  profile: PayoneerPayeeProfile,
  bank: PayoneerBankDetails,
): Readonly<Record<string, unknown>> {
  const invalidProfile = validatePayoneerPayeeProfile(profile);
  if (invalidProfile !== null) throw new Error(invalidProfile);
  const invalidBank = validatePayoneerBankDetails(bank);
  if (invalidBank !== null) throw new Error(invalidBank);

  const company: Record<string, unknown> = {
    name: profile.companyName.trim(),
    legal_type: profile.legalType,
    incorporated_address_1: profile.address1.trim(),
    incorporated_city: profile.city.trim(),
    incorporated_state: profile.state.toUpperCase(),
    incorporated_zipcode: profile.zipCode.trim(),
    incorporated_country: profile.country,
  };

  if (profile.companyUrl !== null && profile.companyUrl.trim().length > 0) {
    company["url"] = profile.companyUrl.trim();
  }
  if (profile.address2 !== null && profile.address2.trim().length > 0) {
    company["incorporated_address_2"] = profile.address2.trim();
  }

  return {
    payee_id: profile.payeeId,
    payee: { type: "company", company },
    payout_method: {
      type: PAYONEER_BANK_TRANSFER_METHOD,
      bank_account_type: "company",
      country: bank.country,
      currency: profile.currency,
    },
  };
}

/**
 * Build the documented bank `details` block of a payout method.
 *
 * The published example sends `account_type: "C"` for a US routing-number account, so that value is
 * sent only in that shape. A SWIFT account sends no account type: the pages read publish no example
 * for one, and inventing a code would be a guess in a money path.
 */
export function buildPayoneerPayoutMethodDetails(
  bank: PayoneerBankDetails,
  currency: string,
): Readonly<Record<string, unknown>> {
  const invalid = validatePayoneerBankDetails(bank);
  if (invalid !== null) throw new Error(invalid);
  if (CURRENCY_PATTERN.test(currency) === false) throw new Error("the currency must be a three letter code");

  const details: Record<string, unknown> = {
    bank_name: bank.bankName.trim(),
    account_name: bank.accountName.trim(),
    account_number: bank.accountNumber,
  };

  if (bank.routingNumber !== null) {
    details["routing_number"] = bank.routingNumber;
    details["account_type"] = "C";
  } else if (bank.swiftCode !== null) {
    details["swift_code"] = bank.swiftCode;
  }

  return {
    bank_account_type: "company",
    currency,
    country: bank.country,
    details,
  };
}

/**
 * Build the documented mass payout body for one instruction.
 *
 * One payment per call keeps a merchant payout a single provider instruction with its own
 * `client_reference_id`, so a partial batch can never pay one merchant twice. The documented limit
 * of 500 per call is asserted anyway, because this builder is the only place a body is made.
 */
export function buildPayoneerPayoutBody(instruction: PayoneerPayoutInstruction): Readonly<Record<string, unknown>> {
  if (PROGRAM_ID_PATTERN.test(instruction.programId) === false) throw new Error("the program id is invalid");
  if (PAYEE_ID_PATTERN.test(instruction.providerPayeeId) === false) throw new Error("the payee id is invalid");
  if (CLIENT_REFERENCE_PATTERN.test(instruction.clientReferenceId) === false) {
    throw new Error("the client reference id is invalid");
  }
  if (CURRENCY_PATTERN.test(instruction.currency) === false) throw new Error("the currency must be a three letter code");

  // The description is provider text the platform writes for the merchant's bank statement: it is
  // cleaned first, so a newline or a markup tag can neither shorten it nor reach the provider raw.
  const description = sanitizePayoneerText(instruction.description);
  if (description.length === 0) throw new Error("the description must not be empty");
  if (description.length > PAYONEER_PAYOUT_TEXT_MAXIMUM_LENGTH) throw new Error("the description is too long");

  const amount = payoneerAmountString(instruction.amountMinor);
  if (amount === null) throw new Error("the amount must be a positive number of minor units");
  if (instruction.amountMinor > 1_000_000_000_000n) throw new Error("the amount is out of range");

  const payment: Record<string, unknown> = {
    client_reference_id: instruction.clientReferenceId,
    payee_id: instruction.providerPayeeId,
    amount,
    currency: instruction.currency,
    description,
  };

  if (instruction.bank !== null) {
    const payoutMethod = buildPayoneerPayoutMethodDetails(instruction.bank, instruction.currency);
    const payee: Record<string, unknown> = { type: "company" };
    if (instruction.payeeName !== null && instruction.payeeName.trim().length > 0) {
      payee["company"] = { name: instruction.payeeName.trim() };
    }
    payment["payout_method_details"] = { payee, payout_method: payoutMethod };
  }

  return { Payments: [payment] };
}

/** True when a body is within the documented payout limit; the builder emits one payment. */
export function withinPayoneerPayoutLimit(body: Readonly<Record<string, unknown>>): boolean {
  const payments = body["Payments"];
  return Array.isArray(payments) && payments.length >= 1 && payments.length <= PAYONEER_MAXIMUM_PAYOUTS_PER_CALL;
}

/* -------------------------------------------------------------------------------------------------
 * The transport
 * ---------------------------------------------------------------------------------------------- */

/** The answer of one API call: the status code and the raw body. */
export interface PayoneerApiAnswer {
  readonly status: number;
  readonly body: string;
}

/** One request the transport sends. */
export interface PayoneerApiRequest {
  readonly method: "GET" | "POST";
  readonly environment: PayoneerPayoutEnvironment;
  readonly path: string;
  readonly accessToken: string;
  readonly body?: Readonly<Record<string, unknown>>;
}

/** The transport port: a documented request in, the raw answer out. */
export type PayoneerApiTransport = (request: PayoneerApiRequest) => Promise<PayoneerApiAnswer>;

/**
 * Sends one request to the documented API base of the environment.
 *
 * The base is allowlisted to the two documented hosts, the path must be one of the three documented
 * paths, the bearer token is required, redirects are refused (a redirect is not an answer), the
 * timeout is bounded and an oversized answer is refused. A throw means the call was not answered,
 * never that the provider refused it.
 */
export const payoneerFetchApiTransport: PayoneerApiTransport = async (request) => {
  const base = payoneerApiBaseFor(request.environment);
  if (request.path.startsWith("/v4/programs/") === false) throw new Error("the path is not a documented program path");
  if (request.path.length > 400) throw new Error("the path is too long");
  if (request.accessToken.trim().length === 0) throw new Error("the access token is required");

  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${request.accessToken}`,
  };
  if (request.body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch(`${base}${request.path}`, {
    method: request.method,
    headers,
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });

  const text = await response.text();
  if (text.length > PAYONEER_PAYOUT_ANSWER_MAXIMUM_BYTES) throw new Error("invalid payout answer");
  return { status: response.status, body: text };
};

/* -------------------------------------------------------------------------------------------------
 * Answer reading
 * ---------------------------------------------------------------------------------------------- */

function parsedBodyOf(body: string): unknown {
  try {
    return body.trim().length === 0 ? null : (JSON.parse(body) as unknown);
  } catch {
    return null;
  }
}

/** The provider message of an answer, sanitised, or the empty string. */
function providerMessageOf(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "";
  const record = payload as Readonly<Record<string, unknown>>;
  for (const key of ["message", "error_description", "error", "detail", "description"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return sanitizePayoneerText(value).slice(0, PAYONEER_PAYOUT_TEXT_MAXIMUM_LENGTH);
    }
  }
  const errors = record["errors"];
  if (Array.isArray(errors)) {
    for (const entry of errors) {
      if (typeof entry === "string" && entry.trim().length > 0) {
        return sanitizePayoneerText(entry).slice(0, PAYONEER_PAYOUT_TEXT_MAXIMUM_LENGTH);
      }
      if (typeof entry === "object" && entry !== null) {
        const message = (entry as Readonly<Record<string, unknown>>)["message"];
        if (typeof message === "string") return sanitizePayoneerText(message).slice(0, PAYONEER_PAYOUT_TEXT_MAXIMUM_LENGTH);
      }
    }
  }
  return "";
}

/** A provider identifier read from a JSON answer, or null when the value is not one. */
function identifierOf(value: unknown, pattern: RegExp): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return pattern.test(trimmed) ? trimmed : null;
}

/**
 * True when a non-2xx answer proves the program exists.
 *
 * A `400`, `409` or `422` is the provider validating a request, which it can only do for a program it
 * knows; a `401`, `403` or `404` may be a wrong program, so nothing is claimed. This is how STEP 155's
 * open question — the token grant did not prove the program — gets its answer: the first
 * program-scope read that comes back as a validation answer confirms it.
 */
function programConfirmedByStatus(status: number): boolean {
  return status >= 200 && status < 300 ? true : status === 400 || status === 409 || status === 422;
}

/** True when the status is one of the documented validation refusals. */
function isValidationRefusal(status: number): boolean {
  return status === 400 || status === 409 || status === 422;
}

/* -------------------------------------------------------------------------------------------------
 * Payee registration (the automatic bank link)
 * ---------------------------------------------------------------------------------------------- */

/** What registering a payee needs. */
export interface RegisterPayoneerPayeeOptions {
  readonly transport?: PayoneerApiTransport;
  readonly occurredAtEpochMs: number;
  readonly recordAudit?: (entry: PayoneerPayoutAuditEntry) => void;
}

/**
 * Register the merchant as a Payoneer payee with its payout method — the automatic bank link.
 *
 * The section 10 sentence "the bank is added automatically to Payoneer" is this call: the platform
 * submits the merchant's identity and its payout method, Payoneer creates the payee entity and
 * answers with the reference the payouts name plus a registration reference the payee continues
 * with. A refusal is only claimed on the documented validation answers; a credential, transport or
 * unreadable answer is `unknown` and asks for reconciliation, because a payee may exist by then.
 */
export async function registerPayoneerPayee(
  registration: PayoneerPayeeRegistration,
  options: RegisterPayoneerPayeeOptions,
): Promise<PayoneerPayeeLinkResult> {
  if (PROGRAM_ID_PATTERN.test(registration.programId) === false) {
    return { outcome: "unknown", reason: "the program id is invalid", requiresReconciliation: false, programConfirmed: false };
  }
  if (registration.accessToken.trim().length === 0) {
    return { outcome: "unknown", reason: "an access token is required", requiresReconciliation: false, programConfirmed: false };
  }

  const invalidProfile = validatePayoneerPayeeProfile(registration.profile);
  if (invalidProfile !== null) {
    return { outcome: "rejected", reason: invalidProfile, programConfirmed: false };
  }
  const invalidBank = validatePayoneerBankDetails(registration.bank);
  if (invalidBank !== null) {
    return { outcome: "rejected", reason: invalidBank, programConfirmed: false };
  }

  let body: Readonly<Record<string, unknown>>;
  try {
    body = buildPayoneerRegisterPayeeBody(registration.profile, registration.bank);
  } catch {
    return { outcome: "rejected", reason: "the payee details could not be built into a request", programConfirmed: false };
  }

  let answer: PayoneerApiAnswer;
  try {
    answer = await (options.transport ?? payoneerFetchApiTransport)({
      method: "POST",
      environment: registration.environment,
      path: payoneerProgramPath(PAYONEER_REGISTER_PAYEE_PATH, registration.programId),
      accessToken: registration.accessToken,
      body,
    });
  } catch {
    return {
      outcome: "unknown",
      reason: "the provider did not answer the registration; reconcile before retrying",
      requiresReconciliation: true,
      programConfirmed: false,
    };
  }

  const programConfirmed = programConfirmedByStatus(answer.status);
  const payload = parsedBodyOf(answer.body);

  if (isValidationRefusal(answer.status)) {
    const message = providerMessageOf(payload);
    const result: PayoneerPayeeLinkResult = {
      outcome: "rejected",
      reason: message.length > 0 ? message : `the provider refused the payee with status ${answer.status}`,
      programConfirmed,
    };
    audit(options, registration.profile.companyId, "payee_link", result.outcome, options.occurredAtEpochMs);
    return result;
  }

  if (answer.status < 200 || answer.status >= 300) {
    return {
      outcome: "unknown",
      reason: "the provider did not answer finally; reconcile before retrying",
      requiresReconciliation: true,
      programConfirmed,
    };
  }

  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return {
      outcome: "unknown",
      reason: "the registration answer is not an object; reconcile before retrying",
      requiresReconciliation: true,
      programConfirmed,
    };
  }

  const record = payload as Readonly<Record<string, unknown>>;
  const providerPayeeId =
    identifierOf(record["payee_id"], PAYEE_ID_PATTERN) ?? identifierOf(record["id"], PAYEE_ID_PATTERN);
  if (providerPayeeId === null) {
    return {
      outcome: "unknown",
      reason: "the registration answer carries no payee id; reconcile before retrying",
      requiresReconciliation: true,
      programConfirmed,
    };
  }

  const registrationReference =
    identifierOf(record["token"], /^[A-Za-z0-9._~+/=-]{8,2048}$/u) ??
    identifierOf(record["registration_link"], /^https:\/\/[!-~]{8,2048}$/u) ??
    identifierOf(record["link"], /^https:\/\/[!-~]{8,2048}$/u);

  audit(options, registration.profile.companyId, "payee_link", "linked", options.occurredAtEpochMs);
  return { outcome: "linked", providerPayeeId, registrationReference, programConfirmed };
}

/* -------------------------------------------------------------------------------------------------
 * Payout submission
 * ---------------------------------------------------------------------------------------------- */

/** What one stored submission remembers, so a retry cannot pay twice. */
export interface PayoneerSubmission {
  readonly id: string;
  readonly companyId: string;
  readonly clientReferenceId: string;
  readonly providerPayeeId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly outcome: "pending" | "rejected" | "unknown";
  readonly providerPayoutId: string | null;
  readonly reason: string | null;
  readonly version: number;
  readonly createdAtEpochMs: number;
  readonly updatedAtEpochMs: number;
}

/** The forward-only outcome transitions a stored submission may take. */
const SUBMISSION_TRANSITIONS: Readonly<Record<string, readonly ("pending" | "rejected" | "unknown")[]>> = Object.freeze({
  pending: deepFreeze(["pending", "rejected", "unknown"] as const),
  unknown: deepFreeze(["unknown", "rejected"] as const),
  rejected: deepFreeze(["rejected"] as const),
});

/** The store the submissions are kept in. The store is the caller's; PostgreSQL owns the real rows. */
export interface PayoneerSubmissionStore {
  insert(submission: PayoneerSubmission): void;
  findByClientReferenceId(clientReferenceId: string): PayoneerSubmission | null;
  save(next: PayoneerSubmission, expectedVersion: number): boolean;
}

/** The in-memory store: keyed on the client reference, immutable amount and payee, version guarded. */
export class InMemoryPayoneerSubmissionStore implements PayoneerSubmissionStore {
  private readonly submissions = new Map<string, PayoneerSubmission>();

  insert(submission: PayoneerSubmission): void {
    if (this.submissions.has(submission.clientReferenceId)) throw new Error("duplicate client reference id");
    if (submission.version !== 1) throw new Error("a new submission starts at version 1");
    this.submissions.set(submission.clientReferenceId, submission);
  }

  findByClientReferenceId(clientReferenceId: string): PayoneerSubmission | null {
    return this.submissions.get(clientReferenceId) ?? null;
  }

  save(next: PayoneerSubmission, expectedVersion: number): boolean {
    const current = this.submissions.get(next.clientReferenceId);
    if (current === undefined) return false;
    if (current.version !== expectedVersion) return false;
    if (next.version !== expectedVersion + 1) return false;
    if (current.companyId !== next.companyId || current.providerPayeeId !== next.providerPayeeId) return false;
    if (current.amountMinor !== next.amountMinor || current.currency !== next.currency) return false;
    // An outcome only moves forward: a pending instruction may settle, an unknown instruction may
    // settle as a refusal, and a refusal is final. Nothing ever returns to pending.
    const allowed = SUBMISSION_TRANSITIONS[current.outcome];
    if (allowed === undefined || allowed.includes(next.outcome) === false) return false;
    this.submissions.set(next.clientReferenceId, next);
    return true;
  }
}

/** The payout audit entry this file hands to the caller's audit writer. */
export interface PayoneerPayoutAuditEntry {
  readonly action: "payee_link.payoneer" | "payout.payoneer_submitted" | "payout.payoneer_status";
  readonly providerKey: typeof PAYONEER_PROVIDER_KEY;
  readonly companyId: string;
  readonly clientReferenceId: string | null;
  readonly outcome: string;
  readonly occurredAtEpochMs: number;
}

function audit(
  options: { readonly recordAudit?: (entry: PayoneerPayoutAuditEntry) => void },
  companyId: string,
  area: "payee_link" | "payout_submitted" | "payout_status",
  outcome: string,
  occurredAtEpochMs: number,
  clientReferenceId: string | null = null,
): void {
  if (options.recordAudit === undefined) return;
  options.recordAudit({
    action:
      area === "payee_link" ? "payee_link.payoneer" : area === "payout_submitted" ? "payout.payoneer_submitted" : "payout.payoneer_status",
    providerKey: PAYONEER_PROVIDER_KEY,
    companyId,
    clientReferenceId,
    outcome,
    occurredAtEpochMs,
  });
}

/** What submitting a payout needs. */
export interface SubmitPayoneerPayoutOptions {
  readonly store: PayoneerSubmissionStore;
  readonly transport?: PayoneerApiTransport;
  readonly occurredAtEpochMs: number;
  readonly recordAudit?: (entry: PayoneerPayoutAuditEntry) => void;
}

/**
 * Submit one payout instruction, idempotently.
 *
 * The instruction is validated, stored against its `client_reference_id` before the call, and then
 * sent. A second call for the same reference reads the stored submission: a reference already sent
 * is answered with its recorded outcome and makes no provider call, and an amount or payee that
 * differs from the stored one is refused rather than paid under someone else's reference. The
 * documented validation answers refuse an instruction; everything else that is not an acceptance is
 * `unknown` with `requiresReconciliation`, which the platform keeps pending.
 */
export async function submitPayoneerPayout(
  instruction: PayoneerPayoutInstruction,
  options: SubmitPayoneerPayoutOptions,
): Promise<PayoneerPayoutSubmitResult> {
  if (PROGRAM_ID_PATTERN.test(instruction.programId) === false) {
    return {
      outcome: "unknown",
      reason: "the program id is invalid",
      clientReferenceId: instruction.clientReferenceId,
      requiresReconciliation: false,
      programConfirmed: false,
    };
  }
  if (CLIENT_REFERENCE_PATTERN.test(instruction.clientReferenceId) === false) {
    return {
      outcome: "unknown",
      reason: "the client reference id is invalid",
      clientReferenceId: instruction.clientReferenceId,
      requiresReconciliation: false,
      programConfirmed: false,
    };
  }

  const existing = options.store.findByClientReferenceId(instruction.clientReferenceId);

  if (existing !== null) {
    if (existing.companyId !== instruction.companyId || existing.providerPayeeId !== instruction.providerPayeeId) {
      return {
        outcome: "rejected",
        reason: "the client reference id already names another payee",
        clientReferenceId: instruction.clientReferenceId,
        programConfirmed: false,
      };
    }
    if (existing.amountMinor !== instruction.amountMinor || existing.currency !== instruction.currency) {
      return {
        outcome: "rejected",
        reason: "the client reference id already names another amount",
        clientReferenceId: instruction.clientReferenceId,
        programConfirmed: false,
      };
    }
    if (existing.outcome === "pending") {
      return {
        outcome: "pending",
        providerPayoutId: existing.providerPayoutId,
        clientReferenceId: instruction.clientReferenceId,
        requiresReconciliation: existing.providerPayoutId === null,
        programConfirmed: true,
      };
    }
    if (existing.outcome === "rejected") {
      return {
        outcome: "rejected",
        reason: existing.reason ?? "the provider refused this instruction",
        clientReferenceId: instruction.clientReferenceId,
        programConfirmed: true,
      };
    }
    return {
      outcome: "unknown",
      reason: existing.reason ?? "the provider did not answer this instruction",
      clientReferenceId: instruction.clientReferenceId,
      requiresReconciliation: true,
      programConfirmed: true,
    };
  }

  if (instruction.accessToken.trim().length === 0) {
    return {
      outcome: "unknown",
      reason: "an access token is required",
      clientReferenceId: instruction.clientReferenceId,
      requiresReconciliation: false,
      programConfirmed: false,
    };
  }
  if (CURRENCY_PATTERN.test(instruction.currency) === false) {
    return {
      outcome: "rejected",
      reason: "the currency must be a three letter code",
      clientReferenceId: instruction.clientReferenceId,
      programConfirmed: false,
    };
  }

  let body: Readonly<Record<string, unknown>>;
  try {
    body = buildPayoneerPayoutBody(instruction);
  } catch {
    return {
      outcome: "rejected",
      reason: "the instruction could not be built into a documented request",
      clientReferenceId: instruction.clientReferenceId,
      programConfirmed: false,
    };
  }

  const pendingSubmission: PayoneerSubmission = {
    id: randomUUID(),
    companyId: instruction.companyId,
    clientReferenceId: instruction.clientReferenceId,
    providerPayeeId: instruction.providerPayeeId,
    amountMinor: instruction.amountMinor,
    currency: instruction.currency,
    outcome: "pending",
    providerPayoutId: null,
    reason: null,
    version: 1,
    createdAtEpochMs: options.occurredAtEpochMs,
    updatedAtEpochMs: options.occurredAtEpochMs,
  };

  try {
    options.store.insert(pendingSubmission);
  } catch {
    // Another run of the same instruction is already in flight: answer from the store, never resend.
    return {
      outcome: "unknown",
      reason: "the instruction is already in flight; reconcile before sending it again",
      clientReferenceId: instruction.clientReferenceId,
      requiresReconciliation: true,
      programConfirmed: false,
    };
  }

  let answer: PayoneerApiAnswer;
  try {
    answer = await (options.transport ?? payoneerFetchApiTransport)({
      method: "POST",
      environment: instruction.environment,
      path: payoneerProgramPath(PAYONEER_MASS_PAYOUT_PATH, instruction.programId),
      accessToken: instruction.accessToken,
      body,
    });
  } catch {
    const stored = settle(options.store, pendingSubmission, "unknown", null, "the provider did not answer the payout", options.occurredAtEpochMs);
    audit(options, instruction.companyId, "payout_submitted", "unknown", options.occurredAtEpochMs, instruction.clientReferenceId);
    return {
      outcome: "unknown",
      reason: stored.reason ?? "the provider did not answer the payout",
      clientReferenceId: instruction.clientReferenceId,
      requiresReconciliation: true,
      programConfirmed: false,
    };
  }

  const programConfirmed = programConfirmedByStatus(answer.status);
  const payload = parsedBodyOf(answer.body);

  if (isValidationRefusal(answer.status)) {
    const message = providerMessageOf(payload);
    const reason = message.length > 0 ? message : `the provider refused the payout with status ${answer.status}`;
    settle(options.store, pendingSubmission, "rejected", null, reason, options.occurredAtEpochMs);
    audit(options, instruction.companyId, "payout_submitted", "rejected", options.occurredAtEpochMs, instruction.clientReferenceId);
    return { outcome: "rejected", reason, clientReferenceId: instruction.clientReferenceId, programConfirmed };
  }

  if (answer.status < 200 || answer.status >= 300) {
    const reason = "the provider did not answer finally; reconcile before retrying";
    settle(options.store, pendingSubmission, "unknown", null, reason, options.occurredAtEpochMs);
    audit(options, instruction.companyId, "payout_submitted", "unknown", options.occurredAtEpochMs, instruction.clientReferenceId);
    return {
      outcome: "unknown",
      reason,
      clientReferenceId: instruction.clientReferenceId,
      requiresReconciliation: true,
      programConfirmed,
    };
  }

  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    const reason = "the payout answer is not an object; reconcile before retrying";
    settle(options.store, pendingSubmission, "unknown", null, reason, options.occurredAtEpochMs);
    audit(options, instruction.companyId, "payout_submitted", "unknown", options.occurredAtEpochMs, instruction.clientReferenceId);
    return {
      outcome: "unknown",
      reason,
      clientReferenceId: instruction.clientReferenceId,
      requiresReconciliation: true,
      programConfirmed,
    };
  }

  const record = payload as Readonly<Record<string, unknown>>;

  // The documented answer lists the client references the provider refused.
  if (listedAsFailed(record, instruction.clientReferenceId)) {
    const message = listedFailureMessageOf(record, instruction.clientReferenceId) || providerMessageOf(record);
    const reason = message.length > 0 ? message : "the provider listed this instruction as failed";
    settle(options.store, pendingSubmission, "rejected", null, reason, options.occurredAtEpochMs);
    audit(options, instruction.companyId, "payout_submitted", "rejected", options.occurredAtEpochMs, instruction.clientReferenceId);
    return { outcome: "rejected", reason, clientReferenceId: instruction.clientReferenceId, programConfirmed };
  }

  const providerPayoutId =
    identifierOf(record["payout_id"], /^[A-Za-z0-9._:-]{1,64}$/u) ??
    identifierOf(record["payment_id"], /^[A-Za-z0-9._:-]{1,64}$/u) ??
    identifierOf(record["id"], /^[A-Za-z0-9._:-]{1,64}$/u);

  settle(options.store, pendingSubmission, "pending", providerPayoutId, null, options.occurredAtEpochMs);
  audit(options, instruction.companyId, "payout_submitted", "pending", options.occurredAtEpochMs, instruction.clientReferenceId);

  return {
    outcome: "pending",
    providerPayoutId,
    clientReferenceId: instruction.clientReferenceId,
    requiresReconciliation: providerPayoutId === null,
    programConfirmed,
  };
}

/** Write the settled outcome onto a submission, version guarded; returns the stored row. */
function settle(
  store: PayoneerSubmissionStore,
  submission: PayoneerSubmission,
  outcome: "pending" | "rejected" | "unknown",
  providerPayoutId: string | null,
  reason: string | null,
  occurredAtEpochMs: number,
): PayoneerSubmission {
  const next: PayoneerSubmission = {
    ...submission,
    outcome,
    providerPayoutId,
    reason,
    version: submission.version + 1,
    updatedAtEpochMs: occurredAtEpochMs,
  };
  return store.save(next, submission.version) ? next : (store.findByClientReferenceId(submission.clientReferenceId) ?? next);
}

/**
 * The provider's message for this client reference, when the answer carries one beside it.
 *
 * The documented batch answer lists the failed references; a listed entry may also carry the reason
 * the instruction failed, and that reason is what the merchant's failure notice should say.
 */
function listedFailureMessageOf(record: Readonly<Record<string, unknown>>, clientReferenceId: string): string {
  for (const key of ["invalid_payments", "failed_payments", "rejected_payments", "errors"]) {
    const list = record[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (typeof entry !== "object" || entry === null) continue;
      const candidate = entry as Readonly<Record<string, unknown>>;
      if (candidate["client_reference_id"] !== clientReferenceId) continue;
      for (const messageKey of ["message", "reason", "description", "error"]) {
        const message = candidate[messageKey];
        if (typeof message === "string" && message.trim().length > 0) {
          return sanitizePayoneerText(message).slice(0, PAYONEER_PAYOUT_TEXT_MAXIMUM_LENGTH);
        }
      }
    }
  }
  return "";
}

/**
 * True when the answer names this client reference among the failed instructions.
 *
 * The documented batch answer "lists the specific `client_reference_id` values that failed", so the
 * reference is looked for in every documented list shape rather than assumed to be absent when the
 * answer is a 2xx.
 */
function listedAsFailed(record: Readonly<Record<string, unknown>>, clientReferenceId: string): boolean {
  for (const key of ["invalid_payments", "failed_payments", "rejected_payments", "errors"]) {
    const list = record[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (typeof entry === "string" && entry === clientReferenceId) return true;
      if (typeof entry === "object" && entry !== null) {
        const candidate = (entry as Readonly<Record<string, unknown>>)["client_reference_id"];
        if (typeof candidate === "string" && candidate === clientReferenceId) return true;
      }
    }
  }
  return false;
}

/* -------------------------------------------------------------------------------------------------
 * Status handling
 * ---------------------------------------------------------------------------------------------- */

/** What reading a payout's status needs. */
export interface ReadPayoneerPayoutStatusOptions {
  readonly transport?: PayoneerApiTransport;
  readonly occurredAtEpochMs: number;
  readonly companyId: string;
  readonly recordAudit?: (entry: PayoneerPayoutAuditEntry) => void;
}

/**
 * Map a documented provider status string to the platform's payout status.
 *
 * `Transferred` is the one status value the pages read publish, and it is the only one that means
 * success. Everything else — including a status this file has never seen — is `unknown`, which the
 * caller keeps pending and reconciles. That is deliberate: guessing "failed" sends the merchant an
 * email about money that may have arrived, and guessing "success" tells them money arrived when it
 * did not.
 */
export function mapPayoneerPayoutStatus(providerStatus: string): "success" | "unknown" {
  return providerStatus === PAYONEER_TRANSFERRED_STATUS ? "success" : "unknown";
}

/**
 * Read one payout's status from the documented status endpoint.
 *
 * The documented answer is `{ result: { status, load_date, payout_date, amount, currency, payee_id,
 * payout_id } }`. A `Transferred` status is success; any other documented status stays pending for
 * the caller to poll again; a status string that is not `Transferred` but that the provider pairs
 * with a cancel or failure meaning is only reached through the notification mapping below, because
 * the pages read publish no other status value.
 */
export async function readPayoneerPayoutStatus(
  query: {
    readonly environment: PayoneerPayoutEnvironment;
    readonly accessToken: string;
    readonly programId: string;
    readonly clientReferenceId: string;
  },
  options: ReadPayoneerPayoutStatusOptions,
): Promise<PayoneerPayoutStatusResult> {
  if (PROGRAM_ID_PATTERN.test(query.programId) === false) {
    return {
      outcome: "unknown",
      providerStatus: null,
      reason: "the program id is invalid",
      clientReferenceId: query.clientReferenceId,
      requiresReconciliation: false,
    };
  }
  if (CLIENT_REFERENCE_PATTERN.test(query.clientReferenceId) === false) {
    return {
      outcome: "unknown",
      providerStatus: null,
      reason: "the client reference id is invalid",
      clientReferenceId: query.clientReferenceId,
      requiresReconciliation: false,
    };
  }
  if (query.accessToken.trim().length === 0) {
    return {
      outcome: "unknown",
      providerStatus: null,
      reason: "an access token is required",
      clientReferenceId: query.clientReferenceId,
      requiresReconciliation: false,
    };
  }

  let answer: PayoneerApiAnswer;
  try {
    answer = await (options.transport ?? payoneerFetchApiTransport)({
      method: "GET",
      environment: query.environment,
      path: payoneerProgramPath(PAYONEER_PAYOUT_STATUS_PATH, query.programId).replace(
        "{client_reference_id}",
        encodeURIComponent(query.clientReferenceId),
      ),
      accessToken: query.accessToken,
    });
  } catch {
    return {
      outcome: "unknown",
      providerStatus: null,
      reason: "the provider did not answer the status query",
      clientReferenceId: query.clientReferenceId,
      requiresReconciliation: true,
    };
  }

  const payload = parsedBodyOf(answer.body);
  const result = resultObjectOf(payload);

  if (answer.status === 404) {
    // A submitted payout the provider cannot find is not a failed payout: it is an unknown one.
    return {
      outcome: "unknown",
      providerStatus: null,
      reason: "the provider does not know this payout; reconcile before concluding anything",
      clientReferenceId: query.clientReferenceId,
      requiresReconciliation: true,
    };
  }

  if (answer.status < 200 || answer.status >= 300) {
    return {
      outcome: "unknown",
      providerStatus: null,
      reason: "the status query was not answered finally",
      clientReferenceId: query.clientReferenceId,
      requiresReconciliation: true,
    };
  }

  if (result === null) {
    return {
      outcome: "unknown",
      providerStatus: null,
      reason: "the status answer carries no result object",
      clientReferenceId: query.clientReferenceId,
      requiresReconciliation: true,
    };
  }

  const providerStatus = typeof result["status"] === "string" ? sanitizePayoneerText(result["status"]) : "";
  if (providerStatus.length === 0) {
    return {
      outcome: "unknown",
      providerStatus: null,
      reason: "the status answer carries no status",
      clientReferenceId: query.clientReferenceId,
      requiresReconciliation: true,
    };
  }

  const loadedAt = typeof result["load_date"] === "string" ? result["load_date"] : null;
  const mapped = mapPayoneerPayoutStatus(providerStatus);
  audit(options, options.companyId, "payout_status", mapped === "success" ? "success" : "unknown", options.occurredAtEpochMs, query.clientReferenceId);

  if (mapped === "success" && loadedAt !== null) {
    return {
      outcome: "success",
      providerStatus,
      clientReferenceId: query.clientReferenceId,
      loadedAtIso: loadedAt,
    };
  }

  // A status the pages read do not document, or a success without its documented marker.
  return {
    outcome: "unknown",
    providerStatus,
    reason: "the provider status is not one the documented pages describe as transferred",
    clientReferenceId: query.clientReferenceId,
    requiresReconciliation: true,
  };
}

/** The `result` object of a status answer, or null. */
function resultObjectOf(payload: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const record = payload as Readonly<Record<string, unknown>>;
  const result = record["result"] ?? record;
  if (typeof result !== "object" || result === null || Array.isArray(result)) return null;
  return result as Readonly<Record<string, unknown>>;
}

/* -------------------------------------------------------------------------------------------------
 * Notifications
 * ---------------------------------------------------------------------------------------------- */

/** The documented payout notification names, and the platform status each one means. */
export const PAYONEER_PAYOUT_NOTIFICATIONS: Readonly<Record<string, PayoutStatus | "unknown">> = Object.freeze({
  "Request received": "pending",
  "Request accepted": "pending",
  "Account/card loaded": "success",
  "Sent to bank": "pending",
  "Failed bank transfer": "failed",
  "Payout canceled": "failed",
});

/** The platform status a documented notification means, or null when it is not a payout notification. */
export function payoneerPayoutStatusOfNotification(notificationName: string): PayoutStatus | "unknown" | null {
  const mapped = PAYONEER_PAYOUT_NOTIFICATIONS[notificationName.trim()];
  return mapped ?? (notificationName.trim().length > 0 ? "unknown" : null);
}

/** What applying a payout notification did. */
export type PayoneerNotificationResult =
  | { readonly status: "applied"; readonly payoutStatus: PayoutStatus; readonly clientReferenceId: string; readonly notificationName: string }
  | { readonly status: "ignored"; readonly reason: string; readonly notificationName: string }
  | { readonly status: "refused"; readonly reason: string };

/**
 * Apply one payout notification, but only through a verifier.
 *
 * The signing scheme is not readable from the pages fetched in STEP 154, so this file will not
 * believe an unsigned delivery: the caller supplies a `verify` port, and without one every delivery
 * is refused. That is the fail-closed half of section 6's "webhooks are accepted only after
 * signature verification". Until the scheme is read, payouts are followed by the status query above,
 * which is documented and does not depend on a signature.
 */
export function applyPayoneerPayoutNotification(
  delivery: { readonly rawBody: string; readonly notificationName: string; readonly clientReferenceId: string | null },
  options: {
    readonly verify: ((rawBody: string) => boolean) | null;
    readonly occurredAtEpochMs: number;
    readonly companyId: string;
    readonly recordAudit?: (entry: PayoneerPayoutAuditEntry) => void;
  },
): PayoneerNotificationResult {
  if (options.verify === null) {
    return { status: "refused", reason: "no verifier is configured, so no notification is believed" };
  }

  let verified: boolean;
  try {
    verified = options.verify(delivery.rawBody);
  } catch {
    verified = false;
  }
  if (verified === false) {
    return { status: "refused", reason: "the delivery did not verify" };
  }

  const mapped = payoneerPayoutStatusOfNotification(delivery.notificationName);
  if (mapped === null) return { status: "ignored", reason: "the delivery names no notification", notificationName: "" };

  if (delivery.clientReferenceId === null || CLIENT_REFERENCE_PATTERN.test(delivery.clientReferenceId) === false) {
    return { status: "ignored", reason: "the notification names no payment this platform sent", notificationName: delivery.notificationName };
  }

  if (mapped === "unknown") {
    audit(options, options.companyId, "payout_status", "unknown", options.occurredAtEpochMs, delivery.clientReferenceId);
    return { status: "ignored", reason: "the notification is not one the documented pages describe", notificationName: delivery.notificationName };
  }

  audit(options, options.companyId, "payout_status", mapped, options.occurredAtEpochMs, delivery.clientReferenceId);
  return {
    status: "applied",
    payoutStatus: mapped,
    clientReferenceId: delivery.clientReferenceId,
    notificationName: delivery.notificationName,
  };
}

/* -------------------------------------------------------------------------------------------------
 * The core's ports
 * ---------------------------------------------------------------------------------------------- */

/**
 * The core's bank-link answer for an awaited registration.
 *
 * `lib/payments/payout-bank-account.ts` takes a synchronous port, and a provider call is
 * asynchronous, so the route awaits the registration and then calls the core with this mapping. A
 * link that is still pending is a failure of the link, never a silent success: the merchant's bank
 * is only linked once Payoneer named the payee.
 */
export function toProviderLinkResult(result: PayoneerPayeeLinkResult): ProviderLinkResult {
  if (result.outcome === "linked") return { status: "linked", providerBankAccountId: result.providerPayeeId };
  return {
    status: "failed",
    reason: result.outcome === "rejected" ? result.reason : "the provider did not confirm the bank link; reconcile before retrying",
  };
}

/**
 * The core's payout answer for an awaited submission.
 *
 * An accepted instruction is `pending` (the provider processes asynchronously), a refusal is
 * `failed` (documented validation only), and an unknown is also `pending` — never `failed`, because
 * the core emails the merchant on failure and an unknown is not a failure.
 */
export function toProviderPayoutResult(result: PayoneerPayoutSubmitResult): ProviderPayoutResult {
  if (result.outcome === "pending") return { status: "pending" };
  if (result.outcome === "rejected") return { status: "failed", reason: result.reason };
  return { status: "pending" };
}

/** The platform payout status a status read means, for a caller that stores it directly. */
export function toPayoutStatus(result: PayoneerPayoutStatusResult): PayoutStatus {
  if (result.outcome === "success") return "success";
  if (result.outcome === "failed") return "failed";
  return "pending";
}
