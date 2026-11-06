// path: lib/payments/adapters/payoneer.ts

/**
 * The Payoneer adapter: documentation verification and sandbox notes recording for the Payoneer
 * provider, the second of the five provider adapters (STEPs 147-169).
 *
 * ## What section 6 asks of this provider
 *
 * The feature list says "Payoneer: payouts. A bank account added in the merchant profile is also
 * added to Payoneer automatically." Payoneer accepts no card payments for this platform and creates
 * no sub-merchant: it pays money out. The provider matrix in `lib/gateways/registry.ts` records
 * exactly that (`accepts: false, payouts: true, submerchants: false`).
 *
 * ## What this file is
 *
 * Before any code is written against a provider's API, `docs/final/MASTER_PROMPT.md` requires its
 * current official documentation to be read in the same session, the URLs recorded, and what was
 * and was not verified written down plainly. This file is that record for Payoneer, as
 * `lib/payments/adapters/nmi.ts` is it for NMI:
 *
 * - **The documentation sources** read for this STEP, with the topic each one established.
 * - **The recorded rules** those pages state: the endpoints, the payout limit, the payee onboarding
 *   flow, the two status endpoints, the notification catalogue, the retry behaviour, the transport
 *   requirements, and the questions the pages left open.
 * - **The sandbox cycle** a payout provider must complete before the adapter can be called verified,
 *   and the notes from this session, which say plainly that none of those five steps was executed
 *   because no Payoneer sandbox credentials exist in this environment.
 * - **The verification record**: the checks, the notes, the calculated status and the store.
 *
 * ## The status rule, and why it is strict
 *
 * A record is `verified` only when at least one documentation check was verified, every documented
 * check passed, at least one sandbox note exists, every sandbox note passed, and the five steps of
 * the sandbox cycle are all present and passed. Anything less that still verified or passed
 * something is `partial`; a record that verified nothing and passed nothing is `not_verified`.
 * The point of the rule is that a documentation review alone can never read as a live verification:
 * this session's record is `partial`, and the gate proves it can never be anything else until
 * somebody with credentials runs the cycle.
 *
 * ## What this file is not
 *
 * It is not the Payoneer client, the token store, the payout submission, the registration link or
 * the webhook receiver — STEPs 155-157 build those, and they may only run after this record exists.
 * It is not the `lib/gateways/registry.ts` provider row (it already exists) and it is not a route, a
 * job, a migration or a table: the record here is the caller's to store, and the store shipped is a
 * reference implementation.
 */

import { randomUUID } from "node:crypto";
import { deepFreeze } from "../../utils/freeze.ts";

/* -------------------------------------------------------------------------------------------------
 * Environment, endpoints and documented limits
 * ---------------------------------------------------------------------------------------------- */

/** The provider key `lib/gateways/registry.ts` and `0029` use for this provider. */
export const PAYONEER_PROVIDER_KEY = "payoneer";

/** The display name section 6 gives the provider. */
export const PAYONEER_PROVIDER_NAME = "Payoneer";

/** The documented sandbox API base; every documented sandbox example posts here. */
export const PAYONEER_SANDBOX_API_BASE = "https://api.sandbox.payoneer.com";

/** The documented production API base; migrating to it is a base URL and credential change only. */
export const PAYONEER_PRODUCTION_API_BASE = "https://api.payoneer.com";

/** The documented sandbox authorization host, stated on the first-party sandbox environment page. */
export const PAYONEER_SANDBOX_AUTH_BASE = "https://login.sandbox.payoneer.com";

/** The documented production authorization host. */
export const PAYONEER_PRODUCTION_AUTH_BASE = "https://login.payoneer.com";

/** The documented maximum number of payouts in one mass payout call. */
export const PAYONEER_MAXIMUM_PAYOUTS_PER_CALL = 500;

/** The documented transport requirement: TLS 1.2 or better, nothing weaker. */
export const PAYONEER_MINIMUM_TLS_VERSION = "1.2";

/** The longest provider text this file keeps. */
export const PAYONEER_TEXT_MAXIMUM_LENGTH = 500;

/* -------------------------------------------------------------------------------------------------
 * Documentation sources
 * ---------------------------------------------------------------------------------------------- */

/** One page read for this STEP: what it is, where it is, and what it established. */
export interface PayoneerDocumentationSource {
  readonly topic: string;
  readonly url: string;
  readonly establishes: string;
}

/**
 * The pages read in the STEP 154 session.
 *
 * Both hosts are Payoneer's own: `developer.payoneer.com` serves the program API reference and
 * `www.payoneer.com/developers-docs/` serves the product guides. The list is the allowlist the
 * validator enforces, so a later review cannot mark an unrelated page as a Payoneer verification.
 */
export const PAYONEER_DOCUMENTATION_SOURCES: readonly PayoneerDocumentationSource[] = deepFreeze([
  {
    topic: "Developer platform index and product map",
    url: "https://www.payoneer.com/developers-docs/",
    establishes: "The product families; payouts live under Mass Payout, and the API reference is the program-scope document.",
  },
  {
    topic: "Mass Payout product index",
    url: "https://www.payoneer.com/developers-docs/mass-payout/",
    establishes: "The three payout pages: payee onboarding, submit mass payout, and China SAFE.",
  },
  {
    topic: "Submit mass payout",
    url: "https://www.payoneer.com/developers-docs/mass-payout/mass-submit-payout/",
    establishes:
      "POST /v4/programs/{program_id}/masspayouts, the Payments array fields, the 500 payout limit, pre-deposited funds and asynchronous processing.",
  },
  {
    topic: "Payee onboarding",
    url: "https://www.payoneer.com/developers-docs/mass-payout/mass-payee-onboarding/",
    establishes:
      "POST /v4/programs/{program_id}/payees/registration-link and its redirect URL, the prefill and lock_type fields, and the payee status endpoint.",
  },
  {
    topic: "Payout status query",
    url: "https://www.payoneer.com/developers-docs/business-funding/business-funding-getting-started/",
    establishes:
      "GET /v4/programs/{program_id}/payouts/{client_reference_id}/status and the result fields it returns, including load_date when the status is Transferred.",
  },
  {
    topic: "Program API reference",
    url: "https://developer.payoneer.com/docs/mass-payouts-and-services.html",
    establishes:
      "The endpoint catalogue, token management APIs, payee and payout submission groups, the webhook catalogue, and the reference tables for errors and payout reasons.",
  },
  {
    topic: "White-label payouts integration guide V4",
    url: "https://developer.payoneer.com/docs/white-label-payouts-v4.html",
    establishes:
      "The integration flow, the IPCN notification sections, and the posting rules for correcting and resubmitting instructions.",
  },
  {
    topic: "Sandbox environment and communication security",
    url: "https://developer.payoneer.com/psd2/get-started",
    establishes:
      "The sandbox and production authorization hosts (login.sandbox.payoneer.com, login.payoneer.com) and the TLS 1.2 requirement.",
  },
]);

/** The hosts a Payoneer documentation check may name. */
export const PAYONEER_DOCUMENTATION_HOSTS: readonly string[] = deepFreeze([
  "developer.payoneer.com",
  "www.payoneer.com",
]);

/* -------------------------------------------------------------------------------------------------
 * The recorded rules
 * ---------------------------------------------------------------------------------------------- */

/**
 * What the pages above state, recorded so that STEPs 155-157 code against the rules rather than
 * against a memory of the pages.
 */
export const PAYONEER_RECORDED_RULES: readonly string[] = deepFreeze([
  "Sandbox API base is https://api.sandbox.payoneer.com and production is https://api.payoneer.com; the sandbox and production credentials differ, so migrating environment changes the base URL and the credentials only.",
  "Authorization hosts are https://login.sandbox.payoneer.com and https://login.payoneer.com; calls carry an OAuth2 bearer token, and the token management APIs cover access tokens, application tokens, refresh and revoke.",
  "Communications require TLS 1.2 or better.",
  "Mass payout is POST /v4/programs/{program_id}/masspayouts with a Payments array; each payment carries client_reference_id, payee_id, amount, currency and description.",
  "One mass payout call carries at most 500 payouts, and the program must already hold deposited funds to cover them; insufficient funds means the payouts are not processed.",
  "Payout processing is asynchronous, so the platform follows it through the payout status endpoint or the IPCN notifications, never through the submit answer alone.",
  "Payee onboarding is POST /v4/programs/{program_id}/payees/registration-link, which answers a URL the payee is redirected to; payee_id is the platform's own identifier and is what every later payout names.",
  "The registration link can pre-fill payee data and lock fields with lock_type, and already_have_an_account links an existing Payoneer account instead of starting a sign-up.",
  "A payee must be Active on Payoneer before it can receive payments; the status is read with GET /v4/programs/{program_id}/payees/{ClientPayeeID}/status or notified by webhook.",
  "Payout status is GET /v4/programs/{program_id}/payouts/{client_reference_id}/status, answered with a result object carrying status, amount, currency, target_amount, target_currency, payee_id, payout_id, scheduled_payout_date and load_date, the last being present only once the funds are transferred.",
  "Webhook consumer URLs are configured per notification in the Settings tab of the Payoneer Admin Console; the documented notifications cover payee approved and declined, payout request received and accepted, account or card loaded, sent to bank, failed bank transfer, payout canceled, and account funded.",
  "A failed notification delivery is retried; the published integration guide documents five additional attempts before an email is sent to a pre-configured address in the client's organization.",
  "The API reference publishes error, field-validation, payee-declined, pending-payout and cancel-payout reason tables; STEP 156 must map against those tables rather than inventing status strings.",
]);

/** The questions the pages read in this session did not answer, kept so nobody assumes an answer. */
export const PAYONEER_OPEN_QUESTIONS: readonly string[] = deepFreeze([
  "The webhook signing scheme is not written on the pages read: the reference lists a Webhooks Security section, but its text is rendered by script and was not readable here. The exact header and digest must be read from that section before STEP 157 implements verification, and until then no signature may be trusted.",
  "Token lifetime is not stated on the pages read; STEP 155 must treat the expiry as unknown and refresh on the token answer rather than assuming a fixed lifetime.",
  "Sandbox credentials are issued by Payoneer during account setup, so none exist in this environment and no sandbox call in this record was executed.",
]);

/* -------------------------------------------------------------------------------------------------
 * The sandbox cycle a payout provider must complete
 * ---------------------------------------------------------------------------------------------- */

/** One step of the cycle, with the documented call it exercises. */
export interface PayoneerSandboxStep {
  readonly id: string;
  readonly test: string;
  readonly method: "POST" | "GET";
  readonly path: string;
}

/** The five steps, in the order a payout integration has to run them. */
export const PAYONEER_SANDBOX_CYCLE: readonly PayoneerSandboxStep[] = deepFreeze([
  {
    id: "registration_link",
    test: "Create a registration link for a new payee and receive a redirect URL",
    method: "POST",
    path: "/v4/programs/{program_id}/payees/registration-link",
  },
  {
    id: "payee_status",
    test: "Read the payee status and see the payee become Active",
    method: "GET",
    path: "/v4/programs/{program_id}/payees/{payee_id}/status",
  },
  {
    id: "mass_payout",
    test: "Submit a single payout and receive the accepted instruction",
    method: "POST",
    path: "/v4/programs/{program_id}/masspayouts",
  },
  {
    id: "payout_status",
    test: "Read the payout status through to Transferred",
    method: "GET",
    path: "/v4/programs/{program_id}/payouts/{client_reference_id}/status",
  },
  {
    id: "ipcn_received",
    test: "Receive a signed IPCN notification and verify it",
    method: "POST",
    path: "/ipcn/{notification}",
  },
]);

/** The cycle step ids, in the documented order. */
export const PAYONEER_SANDBOX_STEP_IDS: readonly string[] = deepFreeze(
  PAYONEER_SANDBOX_CYCLE.map((step) => step.id),
);

/* -------------------------------------------------------------------------------------------------
 * Provider text
 * ---------------------------------------------------------------------------------------------- */

/**
 * Clean provider text before it is recorded.
 *
 * A provider message is a string the platform did not write: control characters are removed so the
 * text cannot rewrite a log line, angle brackets are removed so it can never be markup, whitespace
 * is collapsed, and the result is capped.
 */
export function sanitizePayoneerText(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  const source =
    value.length > 4 * PAYONEER_TEXT_MAXIMUM_LENGTH ? value.slice(0, 4 * PAYONEER_TEXT_MAXIMUM_LENGTH) : value;
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
  return cleaned.length <= PAYONEER_TEXT_MAXIMUM_LENGTH ? cleaned : cleaned.slice(0, PAYONEER_TEXT_MAXIMUM_LENGTH);
}

/** The host of a documentation URL, or null when the URL is not an https URL with a host. */
export function payoneerDocumentationHostOf(url: string): string | null {
  if (url.length === 0 || url.length > 300) return null;
  const match = /^https:\/\/([A-Za-z0-9][A-Za-z0-9.-]{0,190})\/[!-~]{0,200}$/u.exec(url);
  return match === null ? null : (match[1] ?? null);
}

/** True when a URL belongs to one of Payoneer's own documentation hosts. */
export function isPayoneerDocumentationUrl(url: string): boolean {
  const host = payoneerDocumentationHostOf(url);
  return host !== null && PAYONEER_DOCUMENTATION_HOSTS.includes(host);
}

/* -------------------------------------------------------------------------------------------------
 * The record
 * ---------------------------------------------------------------------------------------------- */

/** One documentation check: one topic reviewed, where it was read, and whether it verified. */
export interface PayoneerDocumentationCheck {
  readonly topic: string;
  readonly url: string;
  readonly verified: boolean;
  readonly notes: string | null;
}

/** One sandbox note: one cycle step and what actually happened when it was run. */
export interface PayoneerSandboxNote {
  /** One of `PAYONEER_SANDBOX_STEP_IDS`. */
  readonly test: string;
  readonly result: "pass" | "fail" | "not_tested";
  readonly details: string | null;
}

/** The calculated verification status. */
export type PayoneerVerificationStatus = "verified" | "partial" | "not_verified";

/** One verification record for the Payoneer provider. */
export interface PayoneerVerificationRecord {
  readonly id: string;
  readonly providerKey: typeof PAYONEER_PROVIDER_KEY;
  readonly providerName: typeof PAYONEER_PROVIDER_NAME;
  /** Sandbox or production: which environment the notes were taken in. */
  readonly environment: "sandbox" | "production";
  readonly documentationChecks: readonly PayoneerDocumentationCheck[];
  readonly sandboxNotes: readonly PayoneerSandboxNote[];
  readonly status: PayoneerVerificationStatus;
  readonly verifiedAtEpochMs: number;
  readonly verifiedBy: string;
}

/** What the store reads and writes. The store is the caller's. */
export interface PayoneerVerificationStore {
  insert(record: PayoneerVerificationRecord): void;
  findById(id: string): PayoneerVerificationRecord | null;
  findByProvider(): PayoneerVerificationRecord[];
  findLatest(): PayoneerVerificationRecord | null;
}

/** The in-memory store: a reference implementation keyed on record id. */
export class InMemoryPayoneerVerificationStore implements PayoneerVerificationStore {
  private readonly records = new Map<string, PayoneerVerificationRecord>();

  insert(record: PayoneerVerificationRecord): void {
    if (this.records.has(record.id)) throw new Error("duplicate verification record id");
    this.records.set(record.id, record);
  }

  findById(id: string): PayoneerVerificationRecord | null {
    return this.records.get(id) ?? null;
  }

  findByProvider(): PayoneerVerificationRecord[] {
    return [...this.records.values()];
  }

  findLatest(): PayoneerVerificationRecord | null {
    const records = this.findByProvider();
    records.sort((left, right) => right.verifiedAtEpochMs - left.verifiedAtEpochMs);
    return records[0] ?? null;
  }
}

/* -------------------------------------------------------------------------------------------------
 * Validation
 * ---------------------------------------------------------------------------------------------- */

const TOPIC_PATTERN = /^[^\u0000-\u001f\u007f<>]{3,120}$/u;
const VERIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._@:-]{2,119}$/u;

/** The reason a documentation check is invalid, or null when it is valid. */
export function validatePayoneerDocumentationCheck(check: PayoneerDocumentationCheck): string | null {
  if (TOPIC_PATTERN.test(check.topic.trim()) === false) return "a documentation check needs a topic of 3 to 120 characters";
  if (isPayoneerDocumentationUrl(check.url) === false) {
    return "a documentation check must name a page on Payoneer's own documentation hosts";
  }
  if (check.notes !== null && sanitizePayoneerText(check.notes).length === 0 && check.notes.trim().length > 0) {
    return "a documentation note must carry readable text";
  }
  return null;
}

/** The reason a sandbox note is invalid, or null when it is valid. */
export function validatePayoneerSandboxNote(note: PayoneerSandboxNote): string | null {
  if (PAYONEER_SANDBOX_STEP_IDS.includes(note.test) === false) {
    return "a sandbox note must name one step of the documented sandbox cycle";
  }
  if (note.result === "not_tested" && (note.details === null || sanitizePayoneerText(note.details).length === 0)) {
    return "a sandbox note for a step that was not run must state why";
  }
  if (note.result === "fail" && (note.details === null || sanitizePayoneerText(note.details).length === 0)) {
    return "a failed sandbox step must carry the provider's answer";
  }
  return null;
}

/* -------------------------------------------------------------------------------------------------
 * Status
 * ---------------------------------------------------------------------------------------------- */

/**
 * Calculate the status of a record.
 *
 * `verified` requires a documentation check that verified, every check verified, at least one
 * sandbox note, every note passed, and every step of the documented cycle present and passed. The
 * last clause is what stops a documentation review from being recorded as a live verification.
 */
export function calculatePayoneerStatus(
  checks: readonly PayoneerDocumentationCheck[],
  notes: readonly PayoneerSandboxNote[],
): PayoneerVerificationStatus {
  const everyCheckVerified = checks.length > 0 && checks.every((check) => check.verified);
  const everyNotePassed = notes.length > 0 && notes.every((note) => note.result === "pass");
  const cycleComplete = PAYONEER_SANDBOX_STEP_IDS.every((id) => notes.some((note) => note.test === id && note.result === "pass"));

  if (everyCheckVerified && everyNotePassed && cycleComplete) return "verified";

  const anyVerified = checks.some((check) => check.verified);
  const anyPassed = notes.some((note) => note.result === "pass");
  return anyVerified || anyPassed ? "partial" : "not_verified";
}

/* -------------------------------------------------------------------------------------------------
 * Recording
 * ---------------------------------------------------------------------------------------------- */

/** The input to recording a verification. */
export interface RecordPayoneerVerificationInput {
  readonly environment: "sandbox" | "production";
  readonly documentationChecks: readonly PayoneerDocumentationCheck[];
  readonly sandboxNotes: readonly PayoneerSandboxNote[];
  readonly verifiedBy: string;
}

/** The audit entry a recording hands to the caller's audit writer. */
export interface PayoneerVerificationAuditEntry {
  readonly action: "provider_verification.recorded";
  readonly providerKey: typeof PAYONEER_PROVIDER_KEY;
  readonly status: PayoneerVerificationStatus;
  readonly environment: "sandbox" | "production";
  readonly verifiedBy: string;
  readonly occurredAtEpochMs: number;
}

/** The result of recording a verification. */
export type RecordPayoneerVerificationResult =
  | { readonly status: "recorded"; readonly record: PayoneerVerificationRecord }
  | { readonly status: "failed"; readonly reason: string };

/**
 * Record one verification: validate every part, calculate the status, store it, hand the audit entry
 * to the caller.
 *
 * The first invalid part fails the whole recording, so a record never mixes a verified page with a
 * check that names a page outside Payoneer's documentation, and never carries a duplicate step.
 * The status is calculated here, never supplied by the caller, so it cannot be inflated.
 */
export function recordPayoneerVerification(
  input: RecordPayoneerVerificationInput,
  options: {
    readonly store: PayoneerVerificationStore;
    readonly occurredAtEpochMs: number;
    readonly recordAudit?: (entry: PayoneerVerificationAuditEntry) => void;
  },
): RecordPayoneerVerificationResult {
  if (input.documentationChecks.length === 0) {
    return { status: "failed", reason: "a verification needs at least one documentation check" };
  }
  if (VERIFIER_PATTERN.test(input.verifiedBy.trim()) === false) {
    return { status: "failed", reason: "a verification needs the name of who verified it" };
  }

  for (const check of input.documentationChecks) {
    const reason = validatePayoneerDocumentationCheck(check);
    if (reason !== null) return { status: "failed", reason };
  }
  for (const note of input.sandboxNotes) {
    const reason = validatePayoneerSandboxNote(note);
    if (reason !== null) return { status: "failed", reason };
  }

  const seen = new Set<string>();
  for (const note of input.sandboxNotes) {
    if (seen.has(note.test)) return { status: "failed", reason: "a sandbox step may be recorded once per verification" };
    seen.add(note.test);
  }

  const record: PayoneerVerificationRecord = {
    id: randomUUID(),
    providerKey: PAYONEER_PROVIDER_KEY,
    providerName: PAYONEER_PROVIDER_NAME,
    environment: input.environment,
    documentationChecks: deepFreeze(
      input.documentationChecks.map((check) => ({
        topic: check.topic.trim(),
        url: check.url,
        verified: check.verified,
        notes: check.notes === null ? null : sanitizePayoneerText(check.notes),
      })),
    ),
    sandboxNotes: deepFreeze(
      input.sandboxNotes.map((note) => ({
        test: note.test,
        result: note.result,
        details: note.details === null ? null : sanitizePayoneerText(note.details),
      })),
    ),
    status: calculatePayoneerStatus(input.documentationChecks, input.sandboxNotes),
    verifiedAtEpochMs: options.occurredAtEpochMs,
    verifiedBy: input.verifiedBy.trim(),
  };

  options.store.insert(record);

  if (options.recordAudit !== undefined) {
    options.recordAudit({
      action: "provider_verification.recorded",
      providerKey: PAYONEER_PROVIDER_KEY,
      status: record.status,
      environment: record.environment,
      verifiedBy: record.verifiedBy,
      occurredAtEpochMs: options.occurredAtEpochMs,
    });
  }

  return { status: "recorded", record };
}

/* -------------------------------------------------------------------------------------------------
 * This session's review
 * ---------------------------------------------------------------------------------------------- */

/**
 * The review this STEP actually produced: every source read and verified as documentation, and every
 * sandbox step recorded as not run, with the reason, because no Payoneer sandbox credentials exist in
 * this environment.
 *
 * The record these produce is `partial` by construction, which is the honest status: the
 * documentation was read and the platform's rules are recorded, and nothing was paid out at Payoneer.
 */
export const PAYONEER_SESSION_CHECKS: readonly PayoneerDocumentationCheck[] = deepFreeze(
  PAYONEER_DOCUMENTATION_SOURCES.map((source) => ({
    topic: source.topic,
    url: source.url,
    verified: true,
    notes: source.establishes,
  })),
);

/** The sandbox notes of this session: five steps, none run, each with the reason stated. */
export const PAYONEER_SESSION_SANDBOX_NOTES: readonly PayoneerSandboxNote[] = deepFreeze(
  PAYONEER_SANDBOX_CYCLE.map((step) => ({
    test: step.id,
    result: "not_tested" as const,
    details:
      "No Payoneer sandbox credentials exist in this environment; Payoneer issues sandbox credentials during account setup, so this step has not been run and must not be recorded as passed.",
  })),
);

/** The status this session's review yields; asserted by the gate so nobody can claim otherwise. */
export const PAYONEER_SESSION_STATUS: PayoneerVerificationStatus = calculatePayoneerStatus(
  PAYONEER_SESSION_CHECKS,
  PAYONEER_SESSION_SANDBOX_NOTES,
);
