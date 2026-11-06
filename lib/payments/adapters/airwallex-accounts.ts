// path: lib/payments/adapters/airwallex-accounts.ts

/**
 * The Airwallex connected account: creating it for a KYC-approved company, submitting it for verification, and
 * syncing what Airwallex says about it afterwards.
 *
 * ## What STEP 167 has to answer for
 *
 * STEP 165's record has the five documented statuses (`CREATED`, `SUBMITTED`, `ACTIVE`, `ACTION_REQUIRED`,
 * `SUSPENDED`), the create body with both agreement flags, the submit call, and one honest warning: the sandbox
 * covers "all products … except Connected Account APIs", so none of this can be exercised here. This file
 * therefore implements the cycle the page documents — create, submit, read — and gates it against recorded
 * answers, claiming nothing more.
 *
 * ## The order that makes a retry safe
 *
 * STEP 163's rule carries over unchanged: a `pending` row is written **before** the provider is asked, so a crash
 * cannot silently create a second account. Here one thing is added. The access token STEP 166 issues must be
 * fetched before that row is written, because the token comes from a call of its own: a login that fails leaves
 * no half-attempt behind, while a create call that fails after the row exists leaves exactly the `unknown` row
 * that asks for reconciliation instead of a second attempt.
 *
 * ## The id is not proof of ownership
 *
 * STEP 165 recorded that Airwallex and Stripe both prefix connected-account ids with `acct_`, so the prefix alone
 * cannot say whose id it is. The record therefore carries `providerKey` and the store exposes
 * `findByAccountId`, which only ever answers an Airwallex row; a caller that looks an `acct_` id up must name the
 * provider it believes owns it.
 *
 * ## Reads never invent a state
 *
 * A verification read answers one of five statuses, and only those five are recorded; a status this adapter does
 * not know is refused rather than stored, and a read that could not settle (`401`, `403`, a redirect, a timeout,
 * a `5XX`, a thrown transport, a body with no readable status) changes nothing except, where the answer proves the
 * account may be gone, a `requiresReconciliation` flag. A `404` is recorded as exactly that: the id this platform
 * stored is not at Airwallex, which a person must settle.
 */

import { randomUUID } from "node:crypto";
import { deepFreeze } from "../../utils/freeze.ts";
import type { EncryptionKeyring } from "../../security/encryption.ts";
import {
  AIRWALLEX_ACCOUNT_STATUSES,
  AIRWALLEX_PROVIDER_KEY,
  airwallexOnboardingStateOf,
  buildAirwallexConnectedAccountBody,
  isAirwallexAccountId,
  sanitizeAirwallexText,
  validateAirwallexAccountRequest,
  type AirwallexAccountRequest,
  type AirwallexOnboardingState,
} from "./airwallex.ts";
import {
  airwallexAccessTokenFor,
  airwallexClientCodeOf,
  airwallexClientEndpoint,
  airwallexClientMessageOf,
  AIRWALLEX_ANSWER_MAXIMUM_BYTES,
  type AirwallexClientTransport,
  type AirwallexConfigStore,
  type AirwallexKeyConfig,
  type AirwallexTokenCache,
} from "./airwallex-client.ts";

/* -------------------------------------------------------------------------------------------------
 * The documented surface
 * ---------------------------------------------------------------------------------------------- */

/** The documented create path, kept beside the record's own endpoint table. */
export const AIRWALLEX_ACCOUNTS_CREATE_PATH = "/api/v1/accounts/create";

/** The documented read path, as a shape: an account id sits between the two halves. */
export const AIRWALLEX_ACCOUNT_READ_PATH_PREFIX = "/api/v1/accounts/";

/** The documented submit suffix. */
export const AIRWALLEX_ACCOUNT_SUBMIT_SUFFIX = "/submit";

/** A read path for one documented connected-account id. */
export const AIRWALLEX_ACCOUNT_READ_PATH_PATTERN = /^\/api\/v1\/accounts\/acct_[A-Za-z0-9]{6,64}$/u;

/** A submit path for one documented connected-account id. */
export const AIRWALLEX_ACCOUNT_SUBMIT_PATH_PATTERN = /^\/api\/v1\/accounts\/acct_[A-Za-z0-9]{6,64}\/submit$/u;

/** The only paths this file may call: the create endpoint plus the two id-shaped ones. */
export const AIRWALLEX_ACCOUNT_ALLOWED_PATH_PATTERNS: readonly RegExp[] = deepFreeze([
  /^\/api\/v1\/accounts\/create$/u,
  AIRWALLEX_ACCOUNT_READ_PATH_PATTERN,
  AIRWALLEX_ACCOUNT_SUBMIT_PATH_PATTERN,
]);

/** True when a path is one this file may call. */
export function isAirwallexAccountPath(path: string): boolean {
  return AIRWALLEX_ACCOUNT_ALLOWED_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

/** The read path for one account, refusing anything that is not a documented id. */
export function airwallexAccountPath(accountId: string): string {
  const id = accountId.trim();
  if (isAirwallexAccountId(id) === false) throw new Error("invalid connected-account id");
  return `${AIRWALLEX_ACCOUNT_READ_PATH_PREFIX}${id}`;
}

/** The submit path for one account, refusing anything that is not a documented id. */
export function airwallexAccountSubmitPath(accountId: string): string {
  return `${airwallexAccountPath(accountId)}${AIRWALLEX_ACCOUNT_SUBMIT_SUFFIX}`;
}

/** The bounds every call here keeps. */
export const AIRWALLEX_ACCOUNT_TIMEOUT_MS = 20_000;
export const AIRWALLEX_ACCOUNT_TEXT_MAXIMUM_LENGTH = 200;

/** The KYC decision that authorizes an account, and the only status that does. */
export const AIRWALLEX_KYC_APPROVED_STATUS = "approved";

/** The statuses a submit may follow. A `CREATED` account has not been sent, an `ACTION_REQUIRED` one is re-sent. */
export const AIRWALLEX_SUBMITTABLE_STATUSES: readonly string[] = deepFreeze(["CREATED", "ACTION_REQUIRED"]);

/** How long a recorded verification read is treated as current. */
export const AIRWALLEX_VERIFICATION_STALE_AFTER_SECONDS = 24 * 60 * 60;

/* -------------------------------------------------------------------------------------------------
 * The transport
 * ---------------------------------------------------------------------------------------------- */

/** One call: the method, the mode, the path, the token, the pin and (for a POST) the body. */
export interface AirwallexAccountCall {
  readonly method: "GET" | "POST";
  readonly environment: "sandbox" | "live";
  readonly path: string;
  readonly accessToken: string;
  readonly apiVersion: string;
  readonly body: string | null;
}

/** The HTTP answer. */
export interface AirwallexAccountAnswer {
  readonly status: number;
  readonly body: string;
}

/** The transport port. */
export type AirwallexAccountTransport = (call: AirwallexAccountCall) => Promise<AirwallexAccountAnswer>;

/**
 * Perform one documented connected-account call.
 *
 * The path must be the create endpoint or an id-shaped read/submit path; the host comes from the stored mode and
 * nowhere else; the token is required and never reaches the URL; the pin is required because STEP 165 recorded
 * that omitting `x-api-version` falls back to the account's default, which can differ per merchant; a POST needs a
 * body and a GET refuses one; redirects are refused; the timeout is bounded and an oversized answer is refused.
 */
export const airwallexAccountFetchTransport: AirwallexAccountTransport = async (call) => {
  if (isAirwallexAccountPath(call.path) === false) throw new Error("invalid API path");
  if (call.accessToken.trim().length === 0) throw new Error("an access token is required");
  if (call.apiVersion.trim().length === 0) throw new Error("an API version is required");
  if (call.method === "POST" && (call.body === null || call.body.length === 0)) {
    throw new Error("a request body is required");
  }
  if (call.method === "GET" && call.body !== null) throw new Error("a read carries no body");

  const headers: Record<string, string> = {
    Authorization: `Bearer ${call.accessToken}`,
    Accept: "application/json",
    "x-api-version": call.apiVersion.trim(),
  };
  if (call.body !== null) headers["Content-Type"] = "application/json";

  const response = await fetch(airwallexClientEndpoint(call.environment, call.path), {
    method: call.method,
    headers,
    ...(call.body === null ? {} : { body: call.body }),
    redirect: "error",
    signal: AbortSignal.timeout(AIRWALLEX_ACCOUNT_TIMEOUT_MS),
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

function textAt(value: unknown, key: string): string | null {
  const record = answerRecord(value);
  if (record === null) return null;
  const field = record[key];
  return typeof field === "string" && field.trim().length > 0 ? field.trim() : null;
}

/** The provider's own words, sanitised and bounded. */
export function airwallexAccountMessageOf(body: string): string {
  return airwallexClientMessageOf(parseJsonBody(body));
}

/** The documented status an answer names, or null when it names one this adapter does not record. */
export function airwallexAccountStatusOf(body: string): string | null {
  const named = textAt(parseJsonBody(body), "status");
  if (named === null) return null;
  const normalized = named.toUpperCase();
  return AIRWALLEX_ACCOUNT_STATUSES.includes(normalized) ? normalized : null;
}

/** The `acct_` id an answer names, or null. */
export function airwallexAccountIdOf(body: string): string | null {
  const id = textAt(parseJsonBody(body), "id");
  return id !== null && isAirwallexAccountId(id) ? id.trim() : null;
}

/** What a create answer means. */
export type AirwallexAccountCreateVerdict =
  | { readonly outcome: "created"; readonly accountId: string; readonly accountStatus: string | null }
  | { readonly outcome: "rejected"; readonly detail: string; readonly code: string | null }
  | { readonly outcome: "failed"; readonly detail: string }
  | { readonly outcome: "unknown"; readonly detail: string };

/**
 * Read a create answer.
 *
 * `2XX` with an `acct_` id is the only success; the status beside it is read when it is one of the five the
 * documentation names and is `null` when it is not, because a create answer that omits the status proves the id
 * and nothing else. `400` is `rejected` — the page's own `field_required` and `invalid_argument` codes are kept,
 * because one means a missing field and the other means a bad value. `401`/`403` and every other refusal are
 * `failed`, so nothing was created. A timeout class, `429`, any `5XX`, a thrown transport and a `2XX` naming no id
 * are `unknown`: the account may exist, and only a replay or a person can settle it.
 */
export function parseAirwallexAccountCreateAnswer(status: number, body: string): AirwallexAccountCreateVerdict {
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return { outcome: "unknown", detail: "the API did not answer finally; the account may exist" };
  }
  const message = airwallexAccountMessageOf(body);
  const detailOr = (fallback: string): string => (message.length > 0 ? message : fallback);

  if (status === 400 || status === 409 || status === 422) {
    return {
      outcome: "rejected",
      detail: detailOr(`Airwallex refused the account with status ${status}`),
      code: airwallexClientCodeOf(parseJsonBody(body)),
    };
  }
  if (status === 401 || status === 403) {
    return { outcome: "failed", detail: detailOr("the API rejected the token or refused the permission") };
  }
  if (status >= 300 && status < 400) {
    return { outcome: "failed", detail: "the API answered with a redirect, which proves nothing" };
  }
  if (status < 200 || status >= 300) {
    return { outcome: "failed", detail: detailOr(`the API refused the call with status ${status}`) };
  }

  const accountId = airwallexAccountIdOf(body);
  if (accountId === null) {
    return { outcome: "unknown", detail: "the answer names no connected-account id, so the account may or may not exist" };
  }
  return { outcome: "created", accountId, accountStatus: airwallexAccountStatusOf(body) };
}

/** What a read or a submit answer means. */
export type AirwallexAccountStatusVerdict =
  | { readonly outcome: "answered"; readonly accountStatus: string }
  | { readonly outcome: "not_found"; readonly detail: string }
  | { readonly outcome: "refused"; readonly detail: string }
  | { readonly outcome: "unknown"; readonly detail: string };

/**
 * Read a read-or-submit answer.
 *
 * `2XX` carrying one of the five documented statuses is the only `answered`. `404` is `not_found`: the id this
 * platform stored is not at Airwallex, which is a reconciliation, not a state. `400`/`401`/`403` are `refused` —
 * the call was rejected, so nothing about the account changed. A redirect, a timeout class, `429`, any `5XX`, a
 * thrown transport and a `2XX` whose status this adapter does not record are `unknown`: the account exists but its
 * state was not read.
 */
export function parseAirwallexAccountStatusAnswer(status: number, body: string): AirwallexAccountStatusVerdict {
  if (status === 404) return { outcome: "not_found", detail: "Airwallex does not know the stored connected-account id" };
  if (status === 400 || status === 401 || status === 403) {
    const message = airwallexAccountMessageOf(body);
    return { outcome: "refused", detail: message.length > 0 ? message : `the API refused the call with status ${status}` };
  }
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return { outcome: "unknown", detail: "the API did not answer finally, so the account status was not read" };
  }
  if (status >= 300 && status < 400) {
    return { outcome: "unknown", detail: "the API answered with a redirect, which proves nothing" };
  }
  if (status < 200 || status >= 300) {
    const message = airwallexAccountMessageOf(body);
    return { outcome: "refused", detail: message.length > 0 ? message : `the API refused the call with status ${status}` };
  }

  const accountStatus = airwallexAccountStatusOf(body);
  if (accountStatus === null) {
    return { outcome: "unknown", detail: "the answer carries no status this adapter records, so the state was not read" };
  }
  return { outcome: "answered", accountStatus };
}

/* -------------------------------------------------------------------------------------------------
 * The record
 * ---------------------------------------------------------------------------------------------- */

/** Where the creation attempt stands. */
export type AirwallexAccountAttemptStatus = "pending" | "created" | "rejected" | "unknown";

/** One company's connected account, with what Airwallex last said about it. */
export interface AirwallexAccountProvision {
  readonly id: string;
  /** The provider that owns this id. Airwallex and Stripe share the `acct_` prefix, so the record says whose. */
  readonly providerKey: typeof AIRWALLEX_PROVIDER_KEY;
  readonly companyId: string;
  readonly environment: "sandbox" | "live";
  /** The KYC submission that authorized the attempt. */
  readonly kycSubmissionId: string;
  readonly accountKind: "individual" | "business";
  readonly accountId: string | null;
  readonly attemptStatus: AirwallexAccountAttemptStatus;
  /** The documented status Airwallex last answered, or null before the first read. */
  readonly accountStatus: string | null;
  /** The platform's reading of `accountStatus`. */
  readonly onboardingState: AirwallexOnboardingState | null;
  readonly submittedAtEpochMs: number | null;
  readonly verificationCheckedAtEpochMs: number | null;
  readonly verificationCheckCount: number;
  readonly reason: string | null;
  readonly requiresReconciliation: boolean;
  readonly version: number;
  readonly createdAtEpochMs: number;
  readonly updatedAtEpochMs: number;
}

/** The only moves an attempt may make. A row carrying an account id never leaves `created`. */
export const AIRWALLEX_ACCOUNT_ATTEMPT_OUTCOMES: Readonly<
  Record<AirwallexAccountAttemptStatus, readonly AirwallexAccountAttemptStatus[]>
> = deepFreeze({
  pending: ["pending", "created", "rejected", "unknown"],
  unknown: ["unknown", "created", "rejected", "pending"],
  rejected: ["rejected", "pending"],
  created: ["created"],
});

/** What provisioning reads and writes. One row per company. */
export interface AirwallexAccountProvisionStore {
  insert(provision: AirwallexAccountProvision): void;
  findById(id: string): AirwallexAccountProvision | null;
  findByCompany(companyId: string): AirwallexAccountProvision | null;
  /** The Airwallex row that carries this account id, never another provider's row with the same prefix. */
  findByAccountId(accountId: string): AirwallexAccountProvision | null;
  /** Write the next record only when the stored version is `expectedVersion` and it advances by one. */
  save(next: AirwallexAccountProvision, expectedVersion: number): boolean;
}

/**
 * The in-memory store: a reference implementation of the invariants the real table must carry — one row per
 * company, an immutable company, mode, provider, id, authorizing KYC submission and account kind, a version
 * guard, forward-only attempt outcomes, a `created` row that carries an `acct_` id, an id that never changes once
 * written, a status that is one of the documented five, an onboarding state that always matches that status, a
 * submit time that never moves once written, and a check counter that only climbs.
 */
export class InMemoryAirwallexAccountProvisionStore implements AirwallexAccountProvisionStore {
  private readonly provisions = new Map<string, AirwallexAccountProvision>();

  insert(provision: AirwallexAccountProvision): void {
    if (this.provisions.has(provision.id)) throw new Error("duplicate provision id");
    if (provision.version !== 1) throw new Error("a new provision starts at version 1");
    if (provision.attemptStatus !== "pending") throw new Error("a new provision is pending");
    if (provision.accountId !== null) throw new Error("a new provision carries no account id");
    if (this.findByCompany(provision.companyId) !== null) throw new Error("this company already has an attempt");
    this.provisions.set(provision.id, provision);
  }

  findById(id: string): AirwallexAccountProvision | null {
    return this.provisions.get(id) ?? null;
  }

  findByCompany(companyId: string): AirwallexAccountProvision | null {
    return [...this.provisions.values()].find((provision) => provision.companyId === companyId) ?? null;
  }

  findByAccountId(accountId: string): AirwallexAccountProvision | null {
    return (
      [...this.provisions.values()].find(
        (provision) => provision.providerKey === AIRWALLEX_PROVIDER_KEY && provision.accountId === accountId,
      ) ?? null
    );
  }

  save(next: AirwallexAccountProvision, expectedVersion: number): boolean {
    const current = this.provisions.get(next.id);
    if (current === undefined) return false;
    if (current.providerKey !== next.providerKey) return false;
    if (current.companyId !== next.companyId || current.environment !== next.environment) return false;
    if (current.kycSubmissionId !== next.kycSubmissionId) return false;
    if (current.accountKind !== next.accountKind) return false;
    if (current.version !== expectedVersion) return false;
    if (next.version !== expectedVersion + 1) return false;
    if (AIRWALLEX_ACCOUNT_ATTEMPT_OUTCOMES[current.attemptStatus].includes(next.attemptStatus) === false) return false;
    if (current.accountId !== null && next.accountId !== current.accountId) return false;
    if (next.attemptStatus === "created" && next.accountId === null) return false;
    if (next.accountId !== null && next.attemptStatus !== "created") return false;
    if (next.accountStatus !== null) {
      if (AIRWALLEX_ACCOUNT_STATUSES.includes(next.accountStatus) === false) return false;
      if (next.onboardingState !== airwallexOnboardingStateOf(next.accountStatus).state) return false;
    } else if (next.onboardingState !== null) {
      return false;
    }
    if (current.submittedAtEpochMs !== null && next.submittedAtEpochMs !== current.submittedAtEpochMs) return false;
    if (next.verificationCheckCount < current.verificationCheckCount) return false;
    this.provisions.set(next.id, next);
    return true;
  }
}

/* -------------------------------------------------------------------------------------------------
 * Audit
 * ---------------------------------------------------------------------------------------------- */

/** One audit entry this file hands to the caller's audit writer. Never carries a token or an id in clear text. */
export interface AirwallexAccountAuditEntry {
  readonly action:
    | "connected_account.created"
    | "connected_account.rejected"
    | "connected_account.unknown"
    | "connected_account.submitted"
    | "connected_account.verification_synced"
    | "connected_account.verification_failed";
  readonly providerKey: typeof AIRWALLEX_PROVIDER_KEY;
  readonly companyId: string;
  readonly provisionId: string;
  readonly accountId: string | null;
  readonly environment: "sandbox" | "live";
  readonly outcome: string;
  readonly occurredAtEpochMs: number;
}

/* -------------------------------------------------------------------------------------------------
 * Options and the context one call needs
 * ---------------------------------------------------------------------------------------------- */

/** What the KYC decision this platform recorded says. */
export interface AirwallexKycApproval {
  readonly submissionId: string;
  readonly companyId: string;
  readonly status: string;
  readonly decidedAtEpochMs: number;
}

/** What a caller asks for. */
export interface ProvisionAirwallexAccountInput {
  readonly companyId: string;
  readonly request: AirwallexAccountRequest;
  readonly kyc: AirwallexKycApproval;
}

/** What every function in this file needs. */
export interface AirwallexAccountOptions {
  readonly configStore: AirwallexConfigStore;
  readonly provisionStore: AirwallexAccountProvisionStore;
  readonly keyring: EncryptionKeyring;
  /** STEP 166's in-memory token cache: a token is never stored anywhere else. */
  readonly tokenCache: AirwallexTokenCache;
  readonly occurredAtEpochMs: number;
  readonly transport?: AirwallexAccountTransport;
  /** How a token is obtained; the real login transport is the default. */
  readonly loginTransport?: AirwallexClientTransport;
  readonly recordAudit?: (entry: AirwallexAccountAuditEntry) => void;
}

/** The active configuration and the token one call is made with, or the reason there is none. */
type AccountContext =
  | { readonly ok: true; readonly config: AirwallexKeyConfig; readonly token: string }
  | { readonly ok: false; readonly reason: string };

async function accountContextOf(companyId: string, options: AirwallexAccountOptions): Promise<AccountContext> {
  const config = options.configStore.findActiveByCompany(companyId);
  if (config === null) return { ok: false, reason: "no active Airwallex key configuration exists for this company" };
  if (config.status !== "active") return { ok: false, reason: "the Airwallex key configuration is not active" };

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

function auditProvision(
  action: AirwallexAccountAuditEntry["action"],
  provision: AirwallexAccountProvision,
  outcome: string,
  options: AirwallexAccountOptions,
): void {
  options.recordAudit?.({
    action,
    providerKey: AIRWALLEX_PROVIDER_KEY,
    companyId: provision.companyId,
    provisionId: provision.id,
    accountId: provision.accountId,
    environment: provision.environment,
    outcome,
    occurredAtEpochMs: options.occurredAtEpochMs,
  });
}

/** Write the next record, version-guarded, and answer the row as it now stands. */
function settle(
  provision: AirwallexAccountProvision,
  next: AirwallexAccountProvision,
  options: AirwallexAccountOptions,
): AirwallexAccountProvision {
  const saved = options.provisionStore.save(next, provision.version);
  return saved ? next : (options.provisionStore.findById(provision.id) ?? provision);
}

/* -------------------------------------------------------------------------------------------------
 * Creating the account
 * ---------------------------------------------------------------------------------------------- */

/** What one provisioning attempt did. */
export type ProvisionAirwallexAccountResult =
  | { readonly status: "created"; readonly provision: AirwallexAccountProvision }
  | { readonly status: "already_created"; readonly provision: AirwallexAccountProvision }
  | {
      readonly status: "in_flight";
      readonly requiresReconciliation: true;
      readonly reason: string;
      readonly provision: AirwallexAccountProvision;
    }
  | { readonly status: "rejected"; readonly reason: string; readonly provision: AirwallexAccountProvision }
  | { readonly status: "failed"; readonly reason: string }
  | {
      readonly status: "unknown";
      readonly requiresReconciliation: true;
      readonly reason: string;
      readonly provision: AirwallexAccountProvision;
    };

/**
 * Create the connected account for a KYC-approved company, once.
 *
 * The refusals come first and write nothing: an approval that is not `approved`, an approval belonging to another
 * company, an approval naming no submission, a request the page's own rules reject, no active key configuration
 * and a login that yields no token. Then the existing row decides — `created` answers without a call, `unknown`
 * asks for reconciliation rather than a second account, `rejected` may be reopened because Airwallex created
 * nothing. Only after a `pending` row exists is Airwallex asked.
 */
export async function provisionAirwallexAccount(
  input: ProvisionAirwallexAccountInput,
  options: AirwallexAccountOptions,
): Promise<ProvisionAirwallexAccountResult> {
  if (input.kyc.status !== AIRWALLEX_KYC_APPROVED_STATUS) {
    return { status: "failed", reason: "the company's KYC review is not approved, so no account may be created" };
  }
  if (input.kyc.companyId !== input.companyId) {
    return { status: "failed", reason: "the KYC approval belongs to another company" };
  }
  if (input.kyc.submissionId.trim().length === 0) {
    return { status: "failed", reason: "the KYC approval names no submission" };
  }

  const requestProblem = validateAirwallexAccountRequest(input.request);
  if (requestProblem !== null) return { status: "failed", reason: requestProblem };

  const existing = options.provisionStore.findByCompany(input.companyId);
  if (existing !== null) {
    if (existing.attemptStatus === "created") return { status: "already_created", provision: existing };
    if (existing.attemptStatus === "unknown") {
      return {
        status: "in_flight",
        requiresReconciliation: true,
        reason: "an earlier attempt has an unknown outcome; reconcile it before creating another account",
        provision: existing,
      };
    }
    if (existing.attemptStatus !== "rejected") {
      return { status: "failed", reason: "an attempt for this company is already in flight" };
    }
    const context = await accountContextOf(input.companyId, options);
    if (context.ok === false) return { status: "failed", reason: context.reason };
    const reopened: AirwallexAccountProvision = {
      ...existing,
      attemptStatus: "pending",
      reason: null,
      requiresReconciliation: false,
      version: existing.version + 1,
      updatedAtEpochMs: options.occurredAtEpochMs,
    };
    if (options.provisionStore.save(reopened, existing.version) === false) {
      return { status: "failed", reason: "the attempt changed while it was being reopened; re-read it" };
    }
    return await attemptCreation(reopened, input.request, context.config, context.token, options);
  }

  const context = await accountContextOf(input.companyId, options);
  if (context.ok === false) return { status: "failed", reason: context.reason };

  const provision: AirwallexAccountProvision = {
    id: randomUUID(),
    providerKey: AIRWALLEX_PROVIDER_KEY,
    companyId: input.companyId,
    environment: context.config.environment,
    kycSubmissionId: input.kyc.submissionId,
    accountKind: input.request.kind,
    accountId: null,
    attemptStatus: "pending",
    accountStatus: null,
    onboardingState: null,
    submittedAtEpochMs: null,
    verificationCheckedAtEpochMs: null,
    verificationCheckCount: 0,
    reason: null,
    requiresReconciliation: false,
    version: 1,
    createdAtEpochMs: options.occurredAtEpochMs,
    updatedAtEpochMs: options.occurredAtEpochMs,
  };

  try {
    options.provisionStore.insert(provision);
  } catch {
    return { status: "failed", reason: "this company already has a connected-account attempt" };
  }

  return await attemptCreation(provision, input.request, context.config, context.token, options);
}

/** The call itself, made only after the pending row exists. */
async function attemptCreation(
  provision: AirwallexAccountProvision,
  request: AirwallexAccountRequest,
  config: AirwallexKeyConfig,
  token: string,
  options: AirwallexAccountOptions,
): Promise<ProvisionAirwallexAccountResult> {
  let verdict: AirwallexAccountCreateVerdict;
  try {
    const answer = await (options.transport ?? airwallexAccountFetchTransport)({
      method: "POST",
      environment: config.environment,
      path: AIRWALLEX_ACCOUNTS_CREATE_PATH,
      accessToken: token,
      apiVersion: config.apiVersion,
      body: JSON.stringify(buildAirwallexConnectedAccountBody(request)),
    });
    verdict = parseAirwallexAccountCreateAnswer(answer.status, answer.body);
  } catch {
    verdict = { outcome: "unknown", detail: "the API could not be reached, so the account may or may not exist" };
  }

  if (verdict.outcome === "created") {
    const created = settle(
      provision,
      {
        ...provision,
        attemptStatus: "created",
        accountId: verdict.accountId,
        accountStatus: verdict.accountStatus,
        onboardingState: verdict.accountStatus === null ? null : airwallexOnboardingStateOf(verdict.accountStatus).state,
        reason: verdict.accountStatus === null ? "the account was created and its status has not been read yet" : null,
        requiresReconciliation: false,
        version: provision.version + 1,
        updatedAtEpochMs: options.occurredAtEpochMs,
      },
      options,
    );
    auditProvision("connected_account.created", created, verdict.accountStatus ?? "created", options);
    return { status: "created", provision: created };
  }

  if (verdict.outcome === "rejected") {
    const rejected = settle(
      provision,
      {
        ...provision,
        attemptStatus: "rejected",
        reason: verdict.detail,
        requiresReconciliation: false,
        version: provision.version + 1,
        updatedAtEpochMs: options.occurredAtEpochMs,
      },
      options,
    );
    auditProvision("connected_account.rejected", rejected, verdict.code ?? "rejected", options);
    return { status: "rejected", reason: verdict.detail, provision: rejected };
  }

  if (verdict.outcome === "unknown") {
    const unknown = settle(
      provision,
      {
        ...provision,
        attemptStatus: "unknown",
        reason: verdict.detail,
        requiresReconciliation: true,
        version: provision.version + 1,
        updatedAtEpochMs: options.occurredAtEpochMs,
      },
      options,
    );
    auditProvision("connected_account.unknown", unknown, "unknown", options);
    return { status: "unknown", requiresReconciliation: true, reason: verdict.detail, provision: unknown };
  }

  // `failed` means the API refused the call outright, so nothing was created and no row changes: the pending row
  // is left exactly as it was, which is what lets the next attempt pass through it.
  return { status: "failed", reason: verdict.detail };
}

/* -------------------------------------------------------------------------------------------------
 * Submitting and syncing
 * ---------------------------------------------------------------------------------------------- */

/** What a submit did. */
export type SubmitAirwallexAccountResult =
  | {
      readonly status: "submitted";
      readonly provision: AirwallexAccountProvision;
      readonly accountStatus: string;
      readonly onboardingState: AirwallexOnboardingState;
    }
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string }
  | {
      readonly status: "not_found";
      readonly requiresReconciliation: true;
      readonly reason: string;
      readonly provision: AirwallexAccountProvision;
    }
  | {
      readonly status: "unknown";
      readonly requiresReconciliation: true;
      readonly reason: string;
      readonly provision: AirwallexAccountProvision;
    };

/** What one verification read did. */
export type AirwallexVerificationSyncResult =
  | {
      readonly status: "synced";
      readonly provision: AirwallexAccountProvision;
      readonly accountStatus: string;
      readonly onboardingState: AirwallexOnboardingState;
      readonly changed: boolean;
    }
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string }
  | {
      readonly status: "not_found";
      readonly requiresReconciliation: true;
      readonly reason: string;
      readonly provision: AirwallexAccountProvision;
    }
  | {
      readonly status: "unknown";
      readonly requiresReconciliation: true;
      readonly reason: string;
      readonly provision: AirwallexAccountProvision;
    };

/** The row a call may act on, or the reason there is none. */
function readyProvisionOf(
  provisionId: string,
  options: AirwallexAccountOptions,
): { readonly ok: true; readonly provision: AirwallexAccountProvision } | { readonly ok: false; readonly reason: string } {
  const provision = options.provisionStore.findById(provisionId);
  if (provision === null) return { ok: false, reason: "no connected-account attempt holds that id" };
  if (provision.attemptStatus !== "created" || provision.accountId === null) {
    return {
      ok: false,
      reason:
        provision.attemptStatus === "unknown"
          ? "the account's creation has an unknown outcome and needs reconciliation"
          : "no connected account exists yet, so there is nothing to submit or read",
    };
  }
  return { ok: true, provision };
}

/**
 * Send a created account to Airwallex for verification.
 *
 * The page's order is create then submit, and a `CREATED` or `ACTION_REQUIRED` account is the only one that may
 * be sent; a `SUBMITTED`, `ACTIVE` or `SUSPENDED` one is refused without a call, because sending it again would
 * say nothing new. The answer's status is recorded as Airwallex states it — this file does not assume `SUBMITTED`
 * because the page says so; a `SUBMITTED` answer after a `CREATED` account is what the gate sees, and anything
 * else is stored as the truth it is.
 */
export async function submitAirwallexAccount(
  provisionId: string,
  options: AirwallexAccountOptions,
): Promise<SubmitAirwallexAccountResult> {
  const ready = readyProvisionOf(provisionId, options);
  if (ready.ok === false) return { status: "failed", reason: ready.reason };
  const provision = ready.provision;
  const accountId = provision.accountId;
  if (accountId === null) return { status: "failed", reason: "no connected account exists yet" };
  if (provision.accountStatus === null) {
    return { status: "failed", reason: "the account's status has not been read, so it cannot be submitted yet" };
  }
  if (AIRWALLEX_SUBMITTABLE_STATUSES.includes(provision.accountStatus) === false) {
    return {
      status: "failed",
      reason: `an account that is ${provision.accountStatus} is not submitted again`,
    };
  }

  const context = await accountContextOf(provision.companyId, options);
  if (context.ok === false) return { status: "failed", reason: context.reason };

  let verdict: AirwallexAccountStatusVerdict;
  try {
    const answer = await (options.transport ?? airwallexAccountFetchTransport)({
      method: "POST",
      environment: provision.environment,
      path: airwallexAccountSubmitPath(accountId),
      accessToken: context.token,
      apiVersion: context.config.apiVersion,
      body: JSON.stringify({}),
    });
    verdict = parseAirwallexAccountStatusAnswer(answer.status, answer.body);
  } catch {
    verdict = { outcome: "unknown", detail: "the API could not be reached, so the submission may or may not have happened" };
  }

  const applied = applyStatusAnswer(provision, verdict, "submitted", options);
  if (applied.kind === "answered") {
    return {
      status: "submitted",
      provision: applied.provision,
      accountStatus: applied.accountStatus,
      onboardingState: applied.onboardingState,
    };
  }
  if (applied.kind === "refused") return { status: "refused", reason: applied.reason };
  return {
    status: applied.outcome,
    requiresReconciliation: true,
    reason: applied.reason,
    provision: applied.provision,
  };
}

/**
 * Read what Airwallex says about a created account.
 *
 * This is the sync: one authenticated read, the documented status recorded with the state this platform derives
 * from it, the time of the read, and one more check counted. A read that refused changes nothing but is audited;
 * a `404` and an unsettled answer mark the row for reconciliation, because a row that keeps a status nobody can
 * confirm is worse than one that says it needs a person.
 */
export async function syncAirwallexAccountVerification(
  provisionId: string,
  options: AirwallexAccountOptions,
): Promise<AirwallexVerificationSyncResult> {
  const ready = readyProvisionOf(provisionId, options);
  if (ready.ok === false) return { status: "failed", reason: ready.reason };
  const provision = ready.provision;
  const accountId = provision.accountId;
  if (accountId === null) return { status: "failed", reason: "no connected account exists yet" };

  const context = await accountContextOf(provision.companyId, options);
  if (context.ok === false) return { status: "failed", reason: context.reason };

  let verdict: AirwallexAccountStatusVerdict;
  try {
    const answer = await (options.transport ?? airwallexAccountFetchTransport)({
      method: "GET",
      environment: provision.environment,
      path: airwallexAccountPath(accountId),
      accessToken: context.token,
      apiVersion: context.config.apiVersion,
      body: null,
    });
    verdict = parseAirwallexAccountStatusAnswer(answer.status, answer.body);
  } catch {
    verdict = { outcome: "unknown", detail: "the API could not be reached, so the account status was not read" };
  }

  const applied = applyStatusAnswer(provision, verdict, "synced", options);
  if (applied.kind === "answered") {
    return {
      status: "synced",
      provision: applied.provision,
      accountStatus: applied.accountStatus,
      onboardingState: applied.onboardingState,
      changed: applied.changed,
    };
  }
  if (applied.kind === "refused") return { status: "refused", reason: applied.reason };
  return {
    status: applied.outcome,
    requiresReconciliation: true,
    reason: applied.reason,
    provision: applied.provision,
  };
}

/** What one read-or-submit answer means for the row, before the caller's own vocabulary is applied. */
type StatusAnswerOutcome =
  | {
      readonly kind: "answered";
      readonly provision: AirwallexAccountProvision;
      readonly accountStatus: string;
      readonly onboardingState: AirwallexOnboardingState;
      readonly changed: boolean;
    }
  | { readonly kind: "refused"; readonly reason: string }
  | {
      readonly kind: "flagged";
      readonly outcome: "not_found" | "unknown";
      readonly reason: string;
      readonly provision: AirwallexAccountProvision;
    };

/** Apply a read-or-submit answer to the row, in one place, so both paths behave identically. */
function applyStatusAnswer(
  provision: AirwallexAccountProvision,
  verdict: AirwallexAccountStatusVerdict,
  mode: "submitted" | "synced",
  options: AirwallexAccountOptions,
): StatusAnswerOutcome {
  if (verdict.outcome === "answered") {
    const onboardingState = airwallexOnboardingStateOf(verdict.accountStatus).state;
    const changed = provision.accountStatus !== verdict.accountStatus;
    const next = settle(
      provision,
      {
        ...provision,
        accountStatus: verdict.accountStatus,
        onboardingState,
        submittedAtEpochMs:
          mode === "submitted" && provision.submittedAtEpochMs === null
            ? options.occurredAtEpochMs
            : provision.submittedAtEpochMs,
        verificationCheckedAtEpochMs: options.occurredAtEpochMs,
        verificationCheckCount: provision.verificationCheckCount + 1,
        reason: null,
        requiresReconciliation: false,
        version: provision.version + 1,
        updatedAtEpochMs: options.occurredAtEpochMs,
      },
      options,
    );
    if (next.version !== provision.version + 1) {
      return { kind: "refused", reason: "the attempt changed while the answer was being recorded; re-read it" };
    }
    auditProvision(
      mode === "submitted" ? "connected_account.submitted" : "connected_account.verification_synced",
      next,
      verdict.accountStatus,
      options,
    );
    return { kind: "answered", provision: next, accountStatus: verdict.accountStatus, onboardingState, changed };
  }

  if (verdict.outcome === "refused") {
    auditProvision("connected_account.verification_failed", provision, "refused", options);
    return { kind: "refused", reason: verdict.detail };
  }

  const next = settle(
    provision,
    {
      ...provision,
      reason: sanitizeAirwallexText(verdict.detail, AIRWALLEX_ACCOUNT_TEXT_MAXIMUM_LENGTH),
      requiresReconciliation: true,
      verificationCheckedAtEpochMs: options.occurredAtEpochMs,
      verificationCheckCount: provision.verificationCheckCount + 1,
      version: provision.version + 1,
      updatedAtEpochMs: options.occurredAtEpochMs,
    },
    options,
  );
  auditProvision("connected_account.verification_failed", next, verdict.outcome, options);
  return { kind: "flagged", outcome: verdict.outcome, reason: verdict.detail, provision: next };
}

/* -------------------------------------------------------------------------------------------------
 * What a provision means for the platform
 * ---------------------------------------------------------------------------------------------- */

/** Whether a company's account can transact yet, and what stops it. */
export interface AirwallexAccountReadiness {
  readonly accountId: string | null;
  readonly accountStatus: string | null;
  readonly state: AirwallexOnboardingState;
  /** True only when the account exists and Airwallex says `ACTIVE`. */
  readonly canAcceptPayments: boolean;
  /** True under the same rule: an account that cannot transact cannot receive a payout. */
  readonly canReceivePayouts: boolean;
  readonly onboardingComplete: boolean;
  /** True when no read is recorded, or the last one is older than 24 hours. */
  readonly verificationStale: boolean;
  readonly blockingReason: string | null;
}

/**
 * Read a provision as readiness for payment acceptance.
 *
 * STEP 165 mapped `ACTIVE` to `ready` and everything else to `waiting` or `blocked`; this file takes that mapping
 * as the answer and adds the two questions a caller actually asks: can this account transact, and how old is the
 * answer? Staleness is reported, never used to block — a late sync is not evidence that an active account stopped
 * working, and refusing payments because a job is behind would be a self-inflicted outage.
 */
export function airwallexAccountReadinessOf(
  provision: AirwallexAccountProvision,
  nowEpochMs: number,
): AirwallexAccountReadiness {
  const checkedAt = provision.verificationCheckedAtEpochMs;
  const verificationStale =
    checkedAt === null || nowEpochMs - checkedAt > AIRWALLEX_VERIFICATION_STALE_AFTER_SECONDS * 1_000;

  if (provision.attemptStatus !== "created" || provision.accountId === null) {
    return {
      accountId: null,
      accountStatus: null,
      state: "blocked",
      canAcceptPayments: false,
      canReceivePayouts: false,
      onboardingComplete: false,
      verificationStale,
      blockingReason:
        provision.attemptStatus === "unknown"
          ? "the account's creation has an unknown outcome and needs reconciliation"
          : provision.attemptStatus === "rejected"
            ? "Airwallex refused the account request"
            : "the connected account has not been created",
    };
  }

  if (provision.accountStatus === null) {
    return {
      accountId: provision.accountId,
      accountStatus: null,
      state: "waiting",
      canAcceptPayments: false,
      canReceivePayouts: false,
      onboardingComplete: false,
      verificationStale,
      blockingReason: "the account's status has not been read yet",
    };
  }

  const mapping = airwallexOnboardingStateOf(provision.accountStatus);
  const ready = mapping.state === "ready";
  return {
    accountId: provision.accountId,
    accountStatus: provision.accountStatus,
    state: mapping.state,
    canAcceptPayments: ready,
    canReceivePayouts: ready,
    onboardingComplete: ready,
    verificationStale,
    blockingReason: ready ? null : mapping.reason,
  };
}
