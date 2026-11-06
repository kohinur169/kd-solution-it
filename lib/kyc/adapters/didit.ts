// path: lib/kyc/adapters/didit.ts

/**
 * Didit as a supplementary identity check: one encrypted configuration, one verification session, and a result that is
 * evidence for a reviewer and never a processor KYB status.
 *
 * ## Documentation read in this session (2026-11-06)
 *
 * Every fact below comes from Didit's own documentation, read before this file was written. Where a page is named with
 * a `.md` suffix that is the agent-readable version of the same page.
 *
 * | Topic | URL | What it established |
 * |---|---|---|
 * | Documentation index | https://docs.didit.me/ | The product lines and the page map. |
 * | API authentication | https://docs.didit.me/getting-started/api-authentication | Two hosts with two schemes: `verification.didit.me` for every `/v3/...` route authenticated by a long-lived `x-api-key` header, and `apx.didit.me` for account management with a JWT. The **verification API does not use OAuth**; keys are `sk_live_`/`sk_test_` plus 43 characters **but older keys carry no prefix and keep working, so a key is never validated by its prefix**. Errors: `401` for a bad key, `403` for a missing header, a scoped key or an address outside the key's IP list, `404` on a session route outside the key's scope, `429` with a `wait` field in seconds. |
 * | Create session | https://docs.didit.me/sessions-api/create-session.md | `POST /v3/session/` answers `201` with `session_id`, `session_kind` (`user`/`business`), `session_number`, `session_token`, `url`, `status` (`"Not Started"`), `workflow_id`, `workflow_version`, `vendor_data`. `workflow_id` is a required UUID, `vendor_data` is the caller's stable identifier, `callback` is where the hosted flow returns, `callback_method` is one of `initiator`/`completer`/`both`. Failures: `400` keyed by field (`workflow_id`, `vendor_data`, `callback`), `401`, `403` without `write:sessions`, `429` at 600 calls a minute honouring `Retry-After`. **Documented idempotency**: within one application only one unfinished session may exist per `(workflow_id, vendor_data)`, and calling create again returns that session. |
 * | Retrieve session | https://docs.didit.me/sessions-api/retrieve-session.md | `GET /v3/session/{session_id}/decision/` returns the decision: `status`, `session_kind`, and the per-feature **plural arrays** (`id_verifications`, `liveness_checks`, `face_matches`, `nfc_verifications`, `poa_verifications`, `database_validations`, `aml_screenings`, `ip_analyses`, `phone_verifications`, `email_verifications`, `questionnaire_responses`). A feature that did not run is absent or null, never a placeholder; `session_kind` must always be branched on. `404` `{"detail":"Not found."}`, `403` without `read:sessions`, `401` for a bad key. |
 * | Status vocabulary | https://docs.didit.me/integration/verification-statuses | The ten exact, case-sensitive, space-bearing session strings and their transitions: `"Not Started"`, `"In Progress"`, `"Approved"`, `"Declined"`, `"In Review"`, `"Awaiting User"`, `"Resubmitted"`, `"Expired"`, `"Abandoned"`, `"Kyc Expired"` (a single capital K). `"Expired"` is terminal: the session timed out **before** the person opened the link. |
 * | Data models | https://docs.didit.me/reference/data-models.md | The five feature-level statuses (`Not Finished`, `Approved`, `Declined`, `In Review`, `Resub Requested`), the warning object (`feature`, `risk`, `log_type`, `short_description`, `long_description`, `node_id`), and `id_verifications[].document_type` as a human-readable class: `Passport`, `Identity Card`, `Driver's License`, `Residence Permit`, `Health Insurance Card`, `Tax Card`, `Social Security Card`, `Work Permit`, `Visa`, `Public Service Card`, `Birth Certificate`, `Firearm License`, `Other`. |
 * | Liveness report | https://docs.didit.me/core-technology/liveness/report-liveness.md | `liveness_checks[]` carries `status`, `method` (`ACTIVE_3D`/`FLASHING`/`PASSIVE`), `score` 0-100, `age_estimation`, and the documented decline triggers `NO_FACE_DETECTED`, `LIVENESS_FACE_ATTACK`, `FACE_IN_BLOCKLIST` and the score thresholds. |
 * | Face match report | https://docs.didit.me/core-technology/face-match/report-face-match.md | `face_matches[]` carries `status` and a 0-100 `score`; a decline comes from a score at or below the threshold, `NO_REFERENCE_IMAGE`, or a not-computed action of `DECLINE`. The warning risks include `LOW_FACE_MATCH_SIMILARITY` and `NO_REFERENCE_IMAGE`. |
 *
 * ## What this adapter does with those facts
 *
 * 1. **One host, one header, and no token dance.** Didit authenticates every verification call with `x-api-key`, so
 *    there is no OAuth exchange to cache and no bearer token to leak; the key is opened per call and lives only in the
 *    header of that call. The account-management host (`apx.didit.me`) is never called — it manages organizations, not
 *    verifications, and it uses a different scheme entirely.
 * 2. **The mode is declared, never inferred.** Didit documents that a key may be `sk_live_`, `sk_test_` or carry no
 *    prefix at all and still work, so this adapter does not read the mode out of the key: the configuration says which
 *    mode it is, and the gate proves a prefix cannot change it.
 * 3. **Activation is proved without creating anything billable.** `activateDiditConfiguration` reads the decision of a
 *    random UUID: `404` means the key authenticated and Didit simply does not know that session, `401`/`403` means it did
 *    not, and anything else leaves the configuration waiting. No session, no charge, no personal data.
 * 4. **The reference this platform stores is Didit's session id, and `vendor_data` is ours.** Create is sent with the
 *    session id as `vendor_data`, which is the field Didit documents for "an unfinished session already exists" — so a
 *    retry after an unclear answer returns the same session instead of a second one, and the documented idempotency is
 *    used rather than reinvented.
 * 5. **The exact status strings are the vocabulary, spacing included.** Didit's statuses are case-sensitive and carry
 *    spaces (`"In Review"`, `"Kyc Expired"` with one capital K). This file holds them verbatim in a frozen table and
 *    refuses anything else rather than guessing, which is why an unrecognised word becomes `unknown` and a person's work.
 * 6. **A KYB session is refused.** Create answers `session_kind`, and the decision has to be branched on; a `business`
 *    session is not a person check, so this adapter never records one as a person's result.
 * 7. **A supplementary pass is never a KYB verdict.** Every answer goes through STEP 170's
 *    `recordSupplementaryIdvAnswer`, so the words `verified`, `pending`, `action_required`, `restricted` and `rejected`
 *    cannot come out of this file, and the merchant sees STEP 170's one neutral phrase.
 *
 * ## What this STEP deliberately does not do
 *
 * The delivery (Didit's `X-Signature-V2` over `X-Timestamp` and the raw body) is STEP 174's, and this file never trusts
 * a delivery: it reads the canonical decision and nothing else. No image, no document, no OCR field and no
 * `expected_details` is ever sent from here — the person is handed to Didit's hosted page, so no name, date of birth,
 * document number or face enters this platform through this module.
 */

import { randomUUID } from "node:crypto";
import { deepFreeze } from "../../utils/freeze.ts";
import type { EncryptionKeyring } from "../../security/encryption.ts";
import {
  openSupplementaryIdvConfig,
  recordSupplementaryIdvAnswer,
  sealSupplementaryIdvConfig,
  type OpenedSupplementaryIdvConfig,
  type SupplementaryIdvAdapter,
  type SupplementaryIdvAuditEntry,
  type SupplementaryIdvConfig,
  type SupplementaryIdvConfigStore,
  type SupplementaryIdvEnvironment,
  type SupplementaryIdvLiveness,
  type SupplementaryIdvReasonCode,
  type SupplementaryIdvResult,
  type SupplementaryIdvSession,
  type SupplementaryIdvSessionStore,
  type SupplementaryIdvVendorAnswer,
  type SupplementaryIdvVendorKey,
} from "./supplementary-idv.ts";
import type { SUPPLEMENTARY_IDV_DOCUMENT_KINDS } from "./supplementary-idv.ts";

/* -------------------------------------------------------------------------------------------------
 * The documented host, paths and bounds
 * ---------------------------------------------------------------------------------------------- */

/** The one host every verification call goes to. */
export const DIDIT_API_HOST = "https://verification.didit.me";

/** The host Didit's hosted flow lives on, which is where a person is sent. */
export const DIDIT_HOSTED_FLOW_HOST = "https://verify.didit.me";

/** The account-management host, which this adapter never calls and names only to say so. */
export const DIDIT_ACCOUNT_HOST_REFUSED = "https://apx.didit.me";

/** The documented session collection path. */
export const DIDIT_SESSIONS_PATH = "/v3/session/";

/** The documented decision path for one session. */
export function diditDecisionPath(sessionId: string): string {
  return `/v3/session/${sessionId}/decision/`;
}

/** The full URL of one documented call. */
export function diditEndpoint(path: string): string {
  return `${DIDIT_API_HOST}${path}`;
}

/** The two calls this adapter may make, and nothing else. */
export const DIDIT_ALLOWED_CALLS: readonly {
  readonly method: "POST" | "GET";
  readonly path: RegExp;
}[] = deepFreeze([
  { method: "POST", path: /^\/v3\/session\/$/u },
  {
    method: "GET",
    path: /^\/v3\/session\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/decision\/$/u,
  },
]);

/** True when a method and path are one of the two documented calls. */
export function isDiditCall(method: string, path: string): boolean {
  return DIDIT_ALLOWED_CALLS.some((allowed) => allowed.method === method && allowed.path.test(path));
}

/** The header Didit authenticates with. */
export const DIDIT_API_KEY_HEADER = "x-api-key";

/** The platform's own request timeout. Didit documents none for these two routes. */
export const DIDIT_REQUEST_TIMEOUT_MS = 20_000;

/** The largest answer this adapter reads: a decision carries every feature's report. */
export const DIDIT_MAXIMUM_ANSWER_BYTES = 524_288;

/** The documented `vendor_data` bound this platform applies; Didit documents no length of its own. */
export const DIDIT_VENDOR_DATA_MAXIMUM_LENGTH = 100;

/** The documented key formats, kept only so this file can say they are not validation. */
export const DIDIT_KEY_PREFIXES = deepFreeze(["sk_live_", "sk_test_"] as const);

/** The platform's own API key bound. */
export const DIDIT_API_KEY_MAXIMUM_LENGTH = 200;

/** A UUID, which is what Didit's session and workflow ids are. */
export const DIDIT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** True when a value is a Didit id. */
export function isDiditId(value: string): boolean {
  return DIDIT_ID_PATTERN.test(value.trim());
}

/**
 * The ten session statuses, exactly as Didit spells them.
 *
 * Case-sensitive and space-bearing on purpose: Didit's own page says to match them with `===`, and `"Kyc Expired"`
 * carries a single capital K. A word outside this table is never guessed at.
 */
export const DIDIT_SESSION_STATUSES = deepFreeze([
  "Not Started",
  "In Progress",
  "Approved",
  "Declined",
  "In Review",
  "Awaiting User",
  "Resubmitted",
  "Expired",
  "Abandoned",
  "Kyc Expired",
] as const);

/** One Didit session status. */
export type DiditSessionStatus = (typeof DIDIT_SESSION_STATUSES)[number];

/** True when a string is a documented session status, spacing and case included. */
export function isDiditSessionStatus(value: string): value is DiditSessionStatus {
  return (DIDIT_SESSION_STATUSES as readonly string[]).includes(value);
}

/** The five feature-level statuses, exactly as Didit spells them. */
export const DIDIT_FEATURE_STATUSES = deepFreeze([
  "Not Finished",
  "Approved",
  "Declined",
  "In Review",
  "Resub Requested",
] as const);

/** One Didit feature status. */
export type DiditFeatureStatus = (typeof DIDIT_FEATURE_STATUSES)[number];

/** True when a string is a documented feature status. */
export function isDiditFeatureStatus(value: string): value is DiditFeatureStatus {
  return (DIDIT_FEATURE_STATUSES as readonly string[]).includes(value);
}

/** The status a freshly created session carries, as the documentation shows. */
export const DIDIT_SESSION_CREATED_STATUS = "Not Started";

/** The session kinds the create answer and the decision carry. */
export const DIDIT_SESSION_KINDS = deepFreeze(["user", "business"] as const);

/** The kind of session this adapter is allowed to treat as a person's check. */
export const DIDIT_USER_SESSION_KIND = "user";

/**
 * The feature arrays this adapter reads, in the documentation's own names.
 *
 * `id_verifications`, `liveness_checks` and `face_matches` decide the neutral answer; the rest are collected so the
 * office can see what ran, and an absent array means the feature did not run on that session.
 */
export const DIDIT_FEATURE_ARRAYS = deepFreeze([
  "id_verifications",
  "liveness_checks",
  "face_matches",
  "nfc_verifications",
  "poa_verifications",
  "database_validations",
  "aml_screenings",
  "ip_analyses",
  "phone_verifications",
  "email_verifications",
  "questionnaire_responses",
] as const);

/** The document classes Didit's ID report documents, and the neutral kind each becomes. */
export const DIDIT_DOCUMENT_TYPES: Readonly<Record<string, (typeof SUPPLEMENTARY_IDV_DOCUMENT_KINDS)[number]>> = deepFreeze({
  Passport: "passport",
  "Identity Card": "national_id",
  "Driver's License": "driving_licence",
  "Residence Permit": "residence_permit",
  // Everything else Didit can read — a health insurance card, a tax card, a visa, a birth certificate — is a document
  // this platform has no neutral word for, so the kind stays unstated rather than being stretched into a claim.
  "Health Insurance Card": "not_stated",
  "Tax Card": "not_stated",
  "Social Security Card": "not_stated",
  "Work Permit": "not_stated",
  Visa: "not_stated",
  "Public Service Card": "not_stated",
  "Birth Certificate": "not_stated",
  "Firearm License": "not_stated",
  Other: "not_stated",
});

/**
 * The warning risks that name a neutral reason, and only the ones the pages read here list.
 *
 * Any other risk code stays in the office view and never becomes a reason: a code this file has not read is not a
 * reason it may invent.
 */
export const DIDIT_WARNING_REASONS: Readonly<Record<string, SupplementaryIdvReasonCode>> = deepFreeze({
  DOCUMENT_EXPIRED: "document_expired",
  NO_FACE_DETECTED: "liveness_failed",
  LIVENESS_FACE_ATTACK: "liveness_failed",
  LOW_LIVENESS_SCORE: "liveness_failed",
  LOW_FACE_MATCH_SIMILARITY: "document_mismatch",
  NO_REFERENCE_IMAGE: "document_mismatch",
});

/* -------------------------------------------------------------------------------------------------
 * The encrypted configuration
 * ---------------------------------------------------------------------------------------------- */

/** What a Didit configuration holds, in plaintext, only inside a sealed envelope. */
export interface DiditCredential {
  readonly apiKey: string;
}

/** The reason a credential is unusable, or null when it is usable. */
export function validateDiditCredential(credential: DiditCredential): string | null {
  const apiKey = credential.apiKey.trim();
  if (apiKey.length === 0) return "an API key is required";
  if (apiKey.length < 8) return "the API key is shorter than any Didit key";
  if (apiKey.length > DIDIT_API_KEY_MAXIMUM_LENGTH) return "the API key is longer than this platform stores";
  if (/\s/u.test(apiKey)) return "an API key must not contain whitespace";
  // The prefix is recorded, never enforced: Didit documents that keys without a prefix keep working.
  return null;
}

/** Serialize a credential for the sealed field: JSON, so no delimiter can be guessed wrong. */
export function diditCredentialTextOf(credential: DiditCredential): string {
  return JSON.stringify({ apiKey: credential.apiKey });
}

/** Read a sealed field's plaintext back into a credential, or null when it is not one. */
export function diditCredentialOf(text: string): DiditCredential | null {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 2_000) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const apiKey = record["apiKey"];
  if (typeof apiKey !== "string") return null;
  const credential: DiditCredential = { apiKey };
  return validateDiditCredential(credential) === null ? credential : null;
}

/** The documented prefix a key carries, or null when it carries none — which is not an error. */
export function diditKeyPrefixOf(credential: DiditCredential): string | null {
  const apiKey = credential.apiKey.trim();
  return (DIDIT_KEY_PREFIXES as readonly string[]).find((prefix) => apiKey.startsWith(prefix)) ?? null;
}

/** What a caller supplies when a super administrator connects Didit. */
export interface DiditConfigurationInput {
  readonly companyId: string;
  readonly environment: SupplementaryIdvEnvironment;
  readonly credential: DiditCredential;
  /** The delivery secret Didit signs its webhooks with, when the tenant has one. */
  readonly webhookSecret: string | null;
  readonly occurredAtEpochMs: number;
}

/** What connecting Didit did. */
export type CreateDiditConfigurationResult =
  | { readonly status: "configured"; readonly config: SupplementaryIdvConfig }
  | { readonly status: "failed"; readonly reason: string };

/** One audit entry for the configuration half. Session and result entries come from STEP 170. */
export interface DiditConfigAuditEntry {
  readonly action: "didit_idv.configured" | "didit_idv.activation_tested" | "didit_idv.activated" | "didit_idv.refused";
  readonly providerKey: string;
  readonly companyId: string;
  readonly configId: string;
  readonly environment: string;
  readonly outcome: string;
  readonly occurredAtEpochMs: number;
}

/** The provider key this adapter writes into its own audit entries. */
export const DIDIT_PROVIDER_KEY = "didit";

/** The reason a configuration cannot be opened, or its plaintext and the credential inside it. */
function diditOpenConfigOf(
  config: SupplementaryIdvConfig | null,
  keyring: EncryptionKeyring,
  allowPendingActivation = false,
): { readonly ok: true; readonly opened: OpenedSupplementaryIdvConfig; readonly credential: DiditCredential } | { readonly ok: false; readonly reason: string } {
  if (config === null) return { ok: false, reason: "no Didit configuration holds that id" };
  if (config.vendorKey !== "didit") return { ok: false, reason: "that configuration is not a Didit configuration" };
  if (config.status !== "active" && (allowPendingActivation === false || config.status !== "pending_activation")) {
    return { ok: false, reason: "the Didit configuration is not active" };
  }
  const opened = openSupplementaryIdvConfig(config, keyring);
  if (opened.status === "failed") return { ok: false, reason: opened.reason };
  const credential = diditCredentialOf(opened.config.credential);
  if (credential === null) return { ok: false, reason: "the sealed Didit credential is not one this adapter reads" };
  return { ok: true, opened: opened.config, credential };
}

/**
 * Seal a Didit configuration and store it, waiting for its activation test.
 *
 * The credential is validated before anything is sealed, both the key and the delivery secret are sealed under their
 * own scopes by STEP 170's function, and the row starts `pending_activation` — a provider is not enabled by being
 * typed in, only by answering a real call.
 */
export function createDiditConfiguration(
  input: DiditConfigurationInput,
  options: {
    readonly configStore: SupplementaryIdvConfigStore;
    readonly keyring: EncryptionKeyring;
    readonly recordAudit?: (entry: DiditConfigAuditEntry) => void;
  },
): CreateDiditConfigurationResult {
  const invalid = validateDiditCredential(input.credential);
  if (invalid !== null) return { status: "failed", reason: invalid };
  if (input.companyId.trim().length === 0) return { status: "failed", reason: "a configuration belongs to a company" };

  const sealed = sealSupplementaryIdvConfig(
    {
      companyId: input.companyId,
      vendorKey: "didit",
      environment: input.environment,
      credential: diditCredentialTextOf(input.credential),
      webhookSecret: input.webhookSecret,
    },
    options.keyring,
  );
  if ("reason" in sealed) return { status: "failed", reason: sealed.reason };

  const config: SupplementaryIdvConfig = {
    id: randomUUID(),
    companyId: input.companyId,
    vendorKey: "didit",
    environment: input.environment,
    status: "pending_activation",
    credentialSealed: sealed.credentialSealed,
    webhookSecretSealed: sealed.webhookSecretSealed,
    version: 1,
    createdAtEpochMs: input.occurredAtEpochMs,
    updatedAtEpochMs: input.occurredAtEpochMs,
  };

  try {
    options.configStore.insert(config);
  } catch {
    return { status: "failed", reason: "the configuration could not be stored" };
  }

  options.recordAudit?.({
    action: "didit_idv.configured",
    providerKey: DIDIT_PROVIDER_KEY,
    companyId: config.companyId,
    configId: config.id,
    environment: config.environment,
    outcome: "pending_activation",
    occurredAtEpochMs: input.occurredAtEpochMs,
  });
  return { status: "configured", config };
}

/* -------------------------------------------------------------------------------------------------
 * The transport
 * ---------------------------------------------------------------------------------------------- */

/** One documented call: where it goes, what it carries and which key authenticates it. */
export interface DiditCall {
  readonly method: "POST" | "GET";
  readonly path: string;
  /** The API key, sent as `x-api-key`. Never logged, never stored, never put in a URL. */
  readonly apiKey: string;
  readonly contentType: string | null;
  readonly body: string | null;
}

/** The HTTP answer. */
export interface DiditAnswer {
  readonly status: number;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** The transport port. */
export type DiditTransport = (call: DiditCall) => Promise<DiditAnswer>;

/**
 * Perform one documented call.
 *
 * The method and path must be one of the two the documentation names; the key travels only in the `x-api-key` header;
 * redirects are refused; the timeout is bounded; and an answer larger than the bound is refused rather than buffered.
 */
export const diditFetchTransport: DiditTransport = async (call) => {
  if (isDiditCall(call.method, call.path) === false) throw new Error("invalid API path");
  if (call.apiKey.trim().length === 0) throw new Error("an API key is required");

  const headers: Record<string, string> = {
    Accept: "application/json",
    [DIDIT_API_KEY_HEADER]: call.apiKey,
  };
  if (call.contentType !== null) headers["Content-Type"] = call.contentType;

  const response = await fetch(diditEndpoint(call.path), {
    method: call.method,
    headers,
    ...(call.body === null ? {} : { body: call.body }),
    redirect: "error",
    signal: AbortSignal.timeout(DIDIT_REQUEST_TIMEOUT_MS),
  });

  const text = await response.text();
  if (text.length > DIDIT_MAXIMUM_ANSWER_BYTES) throw new Error("invalid API answer");
  const collected: Record<string, string> = {};
  for (const [name, value] of response.headers.entries()) collected[name.toLowerCase()] = value;
  return { status: response.status, body: text, headers: collected };
};

/* -------------------------------------------------------------------------------------------------
 * Reading answers
 * ---------------------------------------------------------------------------------------------- */

function jsonOf(body: string): unknown {
  try {
    return body.trim().length === 0 ? null : (JSON.parse(body) as unknown);
  } catch {
    return null;
  }
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function arrayOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function textOf(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Read a string exactly, without trimming.
 *
 * Didit documents its statuses and its session kind as case-sensitive strings that must be matched with `===`, so a
 * trimmed `"Approved "` would quietly become a pass. This reader keeps the spaces it was given and lets the frozen
 * tables refuse the value.
 */
function exactTextOf(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The vendor's own words about a failure, bounded.
 *
 * Didit answers `401` and `403` with `{"detail": "..."}`, and `400` with an object keyed by the field it refused, so
 * both shapes are read and neither is invented.
 */
export function diditProblemDetailOf(body: string): string {
  const record = recordOf(jsonOf(body));
  if (record === null) return "";
  const detail = textOf(record["detail"]);
  if (detail !== null) return detail.slice(0, 200);
  for (const field of Object.keys(record)) {
    const value = record[field];
    const first = Array.isArray(value) ? textOf(value[0]) : textOf(value);
    if (first !== null) return `${field}: ${first}`.slice(0, 200);
  }
  return "";
}

/** The field a `400` answer refused, when it named one. */
export function diditRefusedFieldOf(body: string): string | null {
  const record = recordOf(jsonOf(body));
  if (record === null) return null;
  const fields = Object.keys(record).filter((field) => field !== "detail");
  return fields.length === 1 ? (fields[0] ?? null) : null;
}

/** What a session creation concluded. */
export type DiditSessionVerdict =
  | { readonly outcome: "created"; readonly sessionId: string; readonly redirectUrl: string; readonly sessionKind: string }
  | { readonly outcome: "rejected"; readonly detail: string; readonly field: string | null }
  | { readonly outcome: "failed"; readonly detail: string }
  | { readonly outcome: "unknown"; readonly detail: string };

/**
 * Read a create answer.
 *
 * `201` with a UUID, the `user` kind, the `"Not Started"` status and an https URL on Didit's hosted-flow host is a
 * session. `400` is a refusal — the field it names decides whether the request or the configuration is wrong — `401`
 * and `403` are a configuration defect, and a redirect, `404`, `429` or a `5XX` leaves the outcome unknown.
 */
export function parseDiditSessionAnswer(status: number, body: string): DiditSessionVerdict {
  if (status === 400 || status === 422) {
    return {
      outcome: "rejected",
      detail: diditProblemDetailOf(body) || `Didit refused the request with status ${status}`,
      field: diditRefusedFieldOf(body),
    };
  }
  if (status === 401 || status === 403) {
    return { outcome: "failed", detail: diditProblemDetailOf(body) || "Didit refused the API key" };
  }
  if (status === 404) {
    return { outcome: "failed", detail: "Didit answered 404 on the session path, which is a configuration defect" };
  }
  if (status >= 300 && status < 400) {
    return { outcome: "unknown", detail: "Didit answered with a redirect, which proves nothing" };
  }
  if (status === 408 || status === 429 || status >= 500) {
    return { outcome: "unknown", detail: "Didit did not answer finally, so no session was confirmed" };
  }
  if (status < 200 || status >= 300) {
    return { outcome: "failed", detail: `Didit answered ${status}` };
  }

  const record = recordOf(jsonOf(body));
  if (record === null) return { outcome: "unknown", detail: "the create answer is not JSON" };
  const sessionId = textOf(record["session_id"]);
  if (sessionId === null || isDiditId(sessionId) === false) {
    return { outcome: "unknown", detail: "the create answer carries no session id that is a UUID" };
  }
  const sessionKind = textOf(record["session_kind"]);
  if (sessionKind !== DIDIT_USER_SESSION_KIND) {
    return { outcome: "unknown", detail: "the create answer is not a person's session" };
  }
  const sessionStatus = exactTextOf(record["status"]);
  if (sessionStatus !== null && sessionStatus !== DIDIT_SESSION_CREATED_STATUS) {
    return { outcome: "unknown", detail: "the create answer carries a status a new session does not have" };
  }
  const url = textOf(record["url"]);
  if (url === null) return { outcome: "unknown", detail: "the create answer carries no hosted verification URL" };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { outcome: "unknown", detail: "the hosted verification URL is not a URL" };
  }
  if (parsed.protocol !== "https:") return { outcome: "unknown", detail: "the hosted verification URL is not https" };
  if (parsed.hostname !== new URL(DIDIT_HOSTED_FLOW_HOST).hostname) {
    return { outcome: "unknown", detail: "the hosted verification URL is not on Didit's hosted-flow host" };
  }
  return { outcome: "created", sessionId, redirectUrl: url, sessionKind };
}

/* -------------------------------------------------------------------------------------------------
 * The request this platform builds
 * ---------------------------------------------------------------------------------------------- */

/** The `callback_method` values Didit documents. */
export const DIDIT_CALLBACK_METHODS = deepFreeze(["initiator", "completer", "both"] as const);

/** The one this adapter sends, and the documentation's own reason: the callback sometimes fails to fire. */
export const DIDIT_CALLBACK_METHOD = "both";

/** The body of a create request, in the documented shape and nothing more. */
export interface DiditSessionRequest {
  readonly workflow_id: string;
  readonly vendor_data: string;
  readonly callback: string | null;
  readonly callback_method: string | null;
}

/** What the platform asks Didit for. */
export interface DiditSessionInput {
  /** The row STEP 170 opened, which must still be `in_progress` and must carry no vendor reference. */
  readonly sessionId: string;
  /** The workflow UUID the office configured in the Didit console. */
  readonly workflowId: string;
  /** Where Didit returns the person, when the tenant has an endpoint for it. */
  readonly callbackUrl: string | null;
}

/** The `vendor_data` this platform sends: the session id, which is opaque and personal-data free. */
export function diditVendorDataOf(sessionId: string): string {
  const vendorData = sessionId.trim();
  return vendorData.length > DIDIT_VENDOR_DATA_MAXIMUM_LENGTH ? vendorData.slice(0, DIDIT_VENDOR_DATA_MAXIMUM_LENGTH) : vendorData;
}

/** Build the documented create body. No name, no date of birth, no document, no image, no expected details. */
export function buildDiditSessionRequest(input: {
  readonly workflowId: string;
  readonly sessionId: string;
  readonly callbackUrl: string | null;
}): DiditSessionRequest {
  return {
    workflow_id: input.workflowId.trim(),
    vendor_data: diditVendorDataOf(input.sessionId),
    callback: input.callbackUrl,
    callback_method: input.callbackUrl === null ? null : DIDIT_CALLBACK_METHOD,
  };
}

/** The reason a session request is unusable, or null. */
export function validateDiditSessionInput(input: DiditSessionInput): string | null {
  if (isDiditId(input.workflowId) === false) return "the workflow id must be the UUID Didit's console shows";
  const vendorData = diditVendorDataOf(input.sessionId);
  if (vendorData.length === 0) return "a vendor data value is required";
  if (vendorData.length > DIDIT_VENDOR_DATA_MAXIMUM_LENGTH) return "the vendor data value is longer than this platform sends";
  if (/\s/u.test(vendorData)) return "the vendor data value must not contain whitespace";
  if (input.callbackUrl !== null) {
    let parsed: URL;
    try {
      parsed = new URL(input.callbackUrl);
    } catch {
      return "the callback is not a URL";
    }
    if (parsed.protocol !== "https:") return "the callback must use https";
  }
  return null;
}

/* -------------------------------------------------------------------------------------------------
 * Opening a session
 * ---------------------------------------------------------------------------------------------- */

/** A session Didit created. */
export interface DiditOpenedSession {
  readonly sessionId: string;
  /** The reference this platform stores: Didit's own session id. */
  readonly reference: string;
  /** Didit's hosted page for the person, returned once and never stored. */
  readonly redirectUrl: string;
  readonly session: SupplementaryIdvSession;
}

/** What opening a Didit session did. */
export type OpenDiditSessionResult =
  | { readonly status: "opened"; readonly opened: DiditOpenedSession }
  | { readonly status: "rejected"; readonly reason: string; readonly configurationDefect: boolean }
  | { readonly status: "failed"; readonly reason: string; readonly requiresReconciliation: boolean };

/** The options every call here needs. */
export interface DiditOptions {
  readonly configStore: SupplementaryIdvConfigStore;
  readonly sessionStore: SupplementaryIdvSessionStore;
  readonly keyring: EncryptionKeyring;
  readonly occurredAtEpochMs: number;
  readonly transport?: DiditTransport;
  readonly recordAudit?: (entry: SupplementaryIdvAuditEntry) => void;
  readonly recordConfigAudit?: (entry: DiditConfigAuditEntry) => void;
}

/**
 * Open one Didit session for a session row this platform already recorded.
 *
 * The order is STEP 170's: the row exists first, then the vendor is called, then the reference is recorded. A retry is
 * safe because Didit documents that only one unfinished session can exist per `(workflow_id, vendor_data)` and that a
 * second create returns that session — so an unclear answer is reconciled by calling create again, not by guessing
 * which session was made.
 */
export async function openDiditSession(
  input: DiditSessionInput,
  options: DiditOptions,
): Promise<OpenDiditSessionResult> {
  const invalid = validateDiditSessionInput(input);
  if (invalid !== null) return { status: "failed", reason: invalid, requiresReconciliation: false };

  const session = options.sessionStore.findById(input.sessionId);
  if (session === null) return { status: "failed", reason: "no session holds that id", requiresReconciliation: false };
  if (session.vendorKey !== "didit") return { status: "failed", reason: "that session belongs to another vendor", requiresReconciliation: false };
  if (session.result !== "in_progress") return { status: "failed", reason: "the session is no longer in progress", requiresReconciliation: false };
  if (session.reference !== null) return { status: "failed", reason: "the session already carries a Didit reference", requiresReconciliation: false };

  const config = options.configStore.findById(session.configId);
  if (config !== null && config.environment !== session.environment) {
    return { status: "failed", reason: "the session and its configuration disagree about the mode", requiresReconciliation: false };
  }
  const opening = diditOpenConfigOf(config, options.keyring);
  if (opening.ok === false) return { status: "failed", reason: opening.reason, requiresReconciliation: false };

  const request = buildDiditSessionRequest({
    workflowId: input.workflowId,
    sessionId: session.id,
    callbackUrl: input.callbackUrl,
  });

  let answer: DiditAnswer;
  try {
    answer = await (options.transport ?? diditFetchTransport)({
      method: "POST",
      path: DIDIT_SESSIONS_PATH,
      apiKey: opening.credential.apiKey,
      contentType: "application/json",
      body: JSON.stringify({
        workflow_id: request.workflow_id,
        vendor_data: request.vendor_data,
        ...(request.callback === null ? {} : { callback: request.callback }),
        ...(request.callback_method === null ? {} : { callback_method: request.callback_method }),
      }),
    });
  } catch {
    return {
      status: "failed",
      reason: "the create call could not be made, so the session's outcome is unknown",
      requiresReconciliation: true,
    };
  }

  const verdict = parseDiditSessionAnswer(answer.status, answer.body);
  if (verdict.outcome === "rejected") {
    // A refused callback is the office's configuration, not the person's failure; a refused workflow id is the same;
    // only a refused vendor_data is about the person, and even then it is a manual case and not a recorded failure.
    const configurationDefect = verdict.field === "callback" || verdict.field === "workflow_id";
    return { status: "rejected", reason: verdict.detail, configurationDefect };
  }
  if (verdict.outcome === "failed") return { status: "failed", reason: verdict.detail, requiresReconciliation: false };
  if (verdict.outcome === "unknown") return { status: "failed", reason: verdict.detail, requiresReconciliation: true };

  const reference = verdict.sessionId;
  const recorded = recordSupplementaryIdvAnswer(
    session.id,
    { reference, result: "in_progress", liveness: "in_progress", documentKind: "not_stated", reasonCode: "vendor_incomplete" },
    {
      sessionStore: options.sessionStore,
      occurredAtEpochMs: options.occurredAtEpochMs,
      ...(options.recordAudit === undefined ? {} : { recordAudit: options.recordAudit }),
    },
  );
  if (recorded.status !== "recorded") {
    return {
      status: "failed",
      reason: `Didit created the session but it was not recorded: ${recorded.reason}`,
      requiresReconciliation: true,
    };
  }

  return {
    status: "opened",
    opened: {
      sessionId: session.id,
      reference,
      redirectUrl: verdict.redirectUrl,
      session: recorded.session,
    },
  };
}

/* -------------------------------------------------------------------------------------------------
 * Reading a decision
 * ---------------------------------------------------------------------------------------------- */

/** One feature's status, as the office sees it. */
export interface DiditFeatureReport {
  /** The documented array name, e.g. `liveness_checks`. */
  readonly feature: string;
  readonly status: DiditFeatureStatus | null;
  readonly warnings: readonly string[];
}

/** What one decision says, as far as this adapter reads it. */
export interface DiditDecision {
  readonly sessionId: string | null;
  readonly sessionKind: string | null;
  readonly status: string;
  readonly features: readonly DiditFeatureReport[];
  readonly documentType: string | null;
  readonly warningRisks: readonly string[];
}

/** Read the warnings of one feature report into their documented risk codes. */
function warningRisksOf(entry: Readonly<Record<string, unknown>>): string[] {
  return arrayOf(entry["warnings"])
    .map((warning) => recordOf(warning))
    .filter((warning): warning is Readonly<Record<string, unknown>> => warning !== null)
    .map((warning) => textOf(warning["risk"]))
    .filter((risk): risk is string => risk !== null);
}

/** Read one decision body into the neutral shape this adapter maps. */
export function parseDiditDecision(body: string): DiditDecision | null {
  const record = recordOf(jsonOf(body));
  if (record === null) return null;
  const status = exactTextOf(record["status"]);
  if (status === null) return null;

  const features: DiditFeatureReport[] = [];
  const allRisks: string[] = [];
  for (const feature of DIDIT_FEATURE_ARRAYS) {
    // A feature that did not run is absent or null, which the documentation says explicitly; that is not an error.
    for (const entry of arrayOf(record[feature])) {
      const report = recordOf(entry);
      if (report === null) continue;
      const featureStatus = exactTextOf(report["status"]);
      const risks = warningRisksOf(report);
      allRisks.push(...risks);
      features.push({
        feature,
        status: featureStatus !== null && isDiditFeatureStatus(featureStatus) ? featureStatus : null,
        warnings: risks,
      });
    }
  }

  const idReport = features.find((feature) => feature.feature === "id_verifications") ?? null;
  let documentType: string | null = null;
  if (idReport !== null) {
    const firstId = recordOf(arrayOf(record["id_verifications"])[0]);
    documentType = firstId === null ? null : textOf(firstId["document_type"]);
  }

  return {
    sessionId: textOf(record["session_id"]),
    sessionKind: exactTextOf(record["session_kind"]),
    status,
    features,
    documentType,
    warningRisks: allRisks,
  };
}

/** The first status of one feature, or null when that feature did not run. */
function featureStatusOf(decision: DiditDecision, feature: string): DiditFeatureStatus | null {
  return decision.features.find((entry) => entry.feature === feature)?.status ?? null;
}

/**
 * Turn a decision into the neutral answer STEP 170 records.
 *
 * The rules, and why each is what it is:
 *
 *   - The session status is Didit's own word and is matched exactly. `Approved` passes, `Declined` fails, `In Review`
 *     is `unknown` because Didit itself says a reviewer decides, `Expired` and `Abandoned` are `expired` because the
 *     session ended without an answer, `Kyc Expired` is `expired` for the same reason. `Not Started`, `In Progress`,
 *     `Awaiting User` and `Resubmitted` are `in_progress` because a person still has work to do.
 *   - A feature status is read only when the session says something: `Approved` passed, `Declined` failed,
 *     `In Review` unknown, `Not Finished` and `Resub Requested` in progress. A status this file has not read is null,
 *     never a guess.
 *   - The reason comes from a documented warning risk first (`DOCUMENT_EXPIRED`, `LIVENESS_FACE_ATTACK`,
 *     `LOW_FACE_MATCH_SIMILARITY` and the rest of the short table above), and otherwise from the feature that decided.
 *   - A session whose kind is not `user` produces `unknown`: this adapter is a person's check, and a business session is
 *     somebody else's answer.
 */
export function diditAnswerOf(decision: DiditDecision, reference: string): SupplementaryIdvVendorAnswer {
  const livenessFeature = featureStatusOf(decision, "liveness_checks");
  const liveness: SupplementaryIdvLiveness =
    livenessFeature === "Approved"
      ? "passed"
      : livenessFeature === "Declined"
        ? "failed"
        : livenessFeature === "In Review"
          ? "unknown"
          : "in_progress";

  const documentKind =
    decision.documentType === null
      ? "not_stated"
      : (DIDIT_DOCUMENT_TYPES[decision.documentType] ?? "not_stated");

  const documentedReason = decision.warningRisks
    .map((risk) => DIDIT_WARNING_REASONS[risk])
    .find((reason): reason is SupplementaryIdvReasonCode => reason !== undefined);

  const idFeature = featureStatusOf(decision, "id_verifications");
  const faceFeature = featureStatusOf(decision, "face_matches");

  let result: SupplementaryIdvResult;
  let reasonCode: SupplementaryIdvReasonCode;

  if (decision.sessionKind !== null && decision.sessionKind !== DIDIT_USER_SESSION_KIND) {
    result = "unknown";
    reasonCode = "vendor_incomplete";
  } else if (decision.status === "Approved") {
    result = "passed";
    reasonCode = "not_stated";
  } else if (decision.status === "Declined") {
    result = "failed";
    reasonCode = documentedReason ?? (livenessFeature === "Declined" ? "liveness_failed" : faceFeature === "Declined" ? "document_mismatch" : "document_unreadable");
  } else if (decision.status === "In Review") {
    result = "unknown";
    reasonCode = documentedReason ?? "vendor_incomplete";
  } else if (decision.status === "Expired" || decision.status === "Abandoned" || decision.status === "Kyc Expired") {
    result = "expired";
    reasonCode = "session_expired";
  } else if (isDiditSessionStatus(decision.status)) {
    result = "in_progress";
    reasonCode = "vendor_incomplete";
  } else {
    // A status this file has not read is not a pass, not a failure and not an expiry.
    result = "unknown";
    reasonCode = "vendor_incomplete";
  }

  // A document that could not be read is never described as a mismatch, and a decided document keeps its warning reason.
  if (result === "failed" && idFeature === "Declined" && documentedReason === undefined) {
    reasonCode = "document_unreadable";
  }

  return { reference, result, liveness, documentKind, reasonCode };
}

/** What reading a decision concluded. */
export type DiditReadVerdict =
  | { readonly outcome: "read"; readonly answer: SupplementaryIdvVendorAnswer }
  | { readonly outcome: "in_flight"; readonly answer: SupplementaryIdvVendorAnswer }
  | { readonly outcome: "not_found"; readonly detail: string }
  | { readonly outcome: "failed"; readonly detail: string }
  | { readonly outcome: "unknown"; readonly detail: string };

/**
 * Read a decision answer.
 *
 * A `2XX` carrying a session status is a read; `404` means Didit does not know the session (or the key is scoped away
 * from it), which this adapter reports as not found rather than as a pass or a failure; `401`/`403` is a configuration
 * defect; a redirect, `429`, `5XX` or a thrown transport leaves it unknown.
 */
export function parseDiditReadAnswer(status: number, body: string, reference: string): DiditReadVerdict {
  if (status === 404) return { outcome: "not_found", detail: "Didit does not know that session, or the key is scoped away from it" };
  if (status === 400) return { outcome: "failed", detail: diditProblemDetailOf(body) || "Didit refused the read" };
  if (status === 401 || status === 403) return { outcome: "failed", detail: "Didit refused the configured API key" };
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return { outcome: "unknown", detail: "Didit did not answer finally, so the decision was not read" };
  }
  if (status >= 300 && status < 400) return { outcome: "unknown", detail: "Didit answered with a redirect, which proves nothing" };
  if (status < 200 || status >= 300) return { outcome: "failed", detail: `Didit answered ${status}` };

  const decision = parseDiditDecision(body);
  if (decision === null) return { outcome: "unknown", detail: "the decision carries no session status" };
  const answer = diditAnswerOf(decision, reference);
  return answer.result === "in_progress" ? { outcome: "in_flight", answer } : { outcome: "read", answer };
}

/** What refreshing a session did. */
export type RefreshDiditSessionResult =
  | { readonly status: "recorded"; readonly session: SupplementaryIdvSession; readonly changed: boolean }
  | { readonly status: "in_flight"; readonly session: SupplementaryIdvSession; readonly changed: boolean }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "refused"; readonly reason: string };

/**
 * Read one session's decision and record what it says.
 *
 * The record is written through STEP 170's `recordSupplementaryIdvAnswer`, so results are forward-only and an unhappy
 * answer carries the manual-review fallback. A `Kyc Expired` session on a row already recorded `passed` is therefore
 * refused by that function rather than overwriting the pass: a document that expired after approval is a reason for a
 * new session, not for rewriting an old result.
 */
export async function refreshDiditSession(sessionId: string, options: DiditOptions): Promise<RefreshDiditSessionResult> {
  const session = options.sessionStore.findById(sessionId);
  if (session === null) return { status: "failed", reason: "no session holds that id" };
  if (session.vendorKey !== "didit") return { status: "failed", reason: "that session belongs to another vendor" };
  const reference = session.reference;
  if (reference === null || isDiditId(reference) === false) {
    return { status: "failed", reason: "the session carries no usable Didit reference" };
  }

  const config = options.configStore.findById(session.configId);
  const opening = diditOpenConfigOf(config, options.keyring);
  if (opening.ok === false) return { status: "failed", reason: opening.reason };

  let answer: DiditAnswer;
  try {
    answer = await (options.transport ?? diditFetchTransport)({
      method: "GET",
      path: diditDecisionPath(reference),
      apiKey: opening.credential.apiKey,
      contentType: null,
      body: null,
    });
  } catch {
    return { status: "failed", reason: "Didit could not be reached, so the decision is unknown" };
  }

  const verdict = parseDiditReadAnswer(answer.status, answer.body, reference);
  if (verdict.outcome === "not_found" || verdict.outcome === "failed" || verdict.outcome === "unknown") {
    return { status: "failed", reason: verdict.detail };
  }

  const recorded = recordSupplementaryIdvAnswer(sessionId, { ...verdict.answer, reference }, {
    sessionStore: options.sessionStore,
    occurredAtEpochMs: options.occurredAtEpochMs,
    ...(options.recordAudit === undefined ? {} : { recordAudit: options.recordAudit }),
  });
  if (recorded.status === "refused") return { status: "refused", reason: recorded.reason };
  if (recorded.status === "failed") return { status: "failed", reason: recorded.reason };
  return verdict.outcome === "in_flight"
    ? { status: "in_flight", session: recorded.session, changed: recorded.changed }
    : { status: "recorded", session: recorded.session, changed: recorded.changed };
}

/* -------------------------------------------------------------------------------------------------
 * Activation
 * ---------------------------------------------------------------------------------------------- */

/** What activating a configuration did. */
export type ActivateDiditConfigurationResult =
  | { readonly status: "activated"; readonly config: SupplementaryIdvConfig }
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string };

/**
 * Activate a stored Didit configuration by proving the key authenticates.
 *
 * The probe reads the decision of a random UUID. That is the cheapest documented read and it creates nothing: `404`
 * means Didit authenticated the key and simply does not know that session, `401`/`403` means the key is wrong or
 * scoped away, and `429`/`5XX`/a redirect leaves the configuration waiting. Two things are refused before the call — a
 * configuration that is not Didit's, and a second active vendor in the same company and mode.
 */
export async function activateDiditConfiguration(
  configId: string,
  options: {
    readonly configStore: SupplementaryIdvConfigStore;
    readonly keyring: EncryptionKeyring;
    readonly occurredAtEpochMs: number;
    readonly transport?: DiditTransport;
    readonly recordAudit?: (entry: DiditConfigAuditEntry) => void;
  },
): Promise<ActivateDiditConfigurationResult> {
  const config = options.configStore.findById(configId);
  if (config === null) return { status: "failed", reason: "no configuration holds that id" };
  if (config.vendorKey !== "didit") return { status: "refused", reason: "that configuration is not a Didit configuration" };
  if (config.status === "active") return { status: "activated", config };

  const opening = diditOpenConfigOf(config, options.keyring, true);
  if (opening.ok === false) return { status: "failed", reason: opening.reason };

  const others = options.configStore
    .findActiveForCompany(config.companyId)
    .filter((other) => other.id !== config.id && other.environment === config.environment);
  if (others.length > 0) {
    options.recordAudit?.({
      action: "didit_idv.refused",
      providerKey: DIDIT_PROVIDER_KEY,
      companyId: config.companyId,
      configId: config.id,
      environment: config.environment,
      outcome: "another vendor is already active in this mode",
      occurredAtEpochMs: options.occurredAtEpochMs,
    });
    return { status: "refused", reason: "another vendor is already active in this mode" };
  }

  let answer: DiditAnswer;
  try {
    answer = await (options.transport ?? diditFetchTransport)({
      method: "GET",
      path: diditDecisionPath(randomUUID()),
      apiKey: opening.credential.apiKey,
      contentType: null,
      body: null,
    });
  } catch {
    options.recordAudit?.({
      action: "didit_idv.refused",
      providerKey: DIDIT_PROVIDER_KEY,
      companyId: config.companyId,
      configId: config.id,
      environment: config.environment,
      outcome: "the activation probe could not be made",
      occurredAtEpochMs: options.occurredAtEpochMs,
    });
    return { status: "failed", reason: "the activation probe could not be made" };
  }

  const authenticated = answer.status === 404 || (answer.status >= 200 && answer.status < 300);
  options.recordAudit?.({
    action: "didit_idv.activation_tested",
    providerKey: DIDIT_PROVIDER_KEY,
    companyId: config.companyId,
    configId: config.id,
    environment: config.environment,
    outcome: authenticated ? "authenticated" : `answered ${answer.status}`,
    occurredAtEpochMs: options.occurredAtEpochMs,
  });
  if (authenticated === false) {
    return {
      status: "refused",
      reason:
        answer.status === 429 || answer.status >= 500
          ? "Didit did not answer finally, so the key was not proved"
          : "Didit refused the API key",
    };
  }

  const next: SupplementaryIdvConfig = {
    ...config,
    status: "active",
    version: config.version + 1,
    updatedAtEpochMs: options.occurredAtEpochMs,
  };
  const saved = options.configStore.save(next, config.version);
  if (saved === false) return { status: "failed", reason: "the configuration changed while it was being activated" };

  options.recordAudit?.({
    action: "didit_idv.activated",
    providerKey: DIDIT_PROVIDER_KEY,
    companyId: config.companyId,
    configId: config.id,
    environment: config.environment,
    outcome: "active",
    occurredAtEpochMs: options.occurredAtEpochMs,
  });
  return { status: "activated", config: next };
}

/* -------------------------------------------------------------------------------------------------
 * The port STEP 170 defined
 * ---------------------------------------------------------------------------------------------- */

/** The configuration a Didit adapter needs beyond the opened secrets. */
export interface DiditAdapterOptions {
  readonly transport: DiditTransport;
  readonly workflowId: string;
  readonly callbackUrl: string | null;
}

/**
 * Build the `SupplementaryIdvAdapter` STEP 170 defines for Didit.
 *
 * The port has three members and this factory returns exactly those three, so a caller holding the port cannot reach a
 * processor status through it. The workflow UUID and the return endpoint are the office's configuration, not the
 * request's, so they are bound here once.
 */
export function diditAdapterOf(options: DiditAdapterOptions): SupplementaryIdvAdapter {
  return {
    vendorKey: "didit",
    createSession: async (
      request: { readonly companyId: string; readonly sessionId: string; readonly environment: SupplementaryIdvEnvironment; readonly returnUrl: string },
      config: OpenedSupplementaryIdvConfig,
    ): Promise<SupplementaryIdvVendorAnswer> => {
      const credential = diditCredentialOf(config.credential);
      if (credential === null) throw new Error("the opened Didit configuration carries no usable credential");
      const body = buildDiditSessionRequest({
        workflowId: options.workflowId,
        sessionId: request.sessionId,
        callbackUrl: options.callbackUrl ?? request.returnUrl,
      });
      const created = await options.transport({
        method: "POST",
        path: DIDIT_SESSIONS_PATH,
        apiKey: credential.apiKey,
        contentType: "application/json",
        body: JSON.stringify({
          workflow_id: body.workflow_id,
          vendor_data: body.vendor_data,
          ...(body.callback === null ? {} : { callback: body.callback }),
          ...(body.callback_method === null ? {} : { callback_method: body.callback_method }),
        }),
      });
      const verdict = parseDiditSessionAnswer(created.status, created.body);
      if (verdict.outcome !== "created") throw new Error(verdict.detail);
      return {
        reference: verdict.sessionId,
        result: "in_progress",
        liveness: "in_progress",
        documentKind: "not_stated",
        reasonCode: "vendor_incomplete",
      };
    },
    readSession: async (reference: string, config: OpenedSupplementaryIdvConfig): Promise<SupplementaryIdvVendorAnswer> => {
      const credential = diditCredentialOf(config.credential);
      if (credential === null) throw new Error("the opened Didit configuration carries no usable credential");
      if (isDiditId(reference) === false) throw new Error("that is not a Didit session id");
      const read = await options.transport({
        method: "GET",
        path: diditDecisionPath(reference.trim()),
        apiKey: credential.apiKey,
        contentType: null,
        body: null,
      });
      const verdict = parseDiditReadAnswer(read.status, read.body, reference.trim());
      if (verdict.outcome === "not_found" || verdict.outcome === "failed" || verdict.outcome === "unknown") {
        throw new Error(verdict.detail);
      }
      return verdict.answer;
    },
  };
}

/* -------------------------------------------------------------------------------------------------
 * What the office sees
 * ---------------------------------------------------------------------------------------------- */

/** A session as the office sees it: the vendor's own status and features, and the neutral result they became. */
export interface DiditSessionSummary {
  readonly sessionId: string;
  readonly reference: string | null;
  readonly result: SupplementaryIdvResult;
  readonly liveness: SupplementaryIdvLiveness;
  readonly documentKind: string;
  readonly reasonCode: string | null;
  readonly sessionStatus: string;
  readonly features: readonly DiditFeatureReport[];
  /** Always false: nothing here changes a charge flag, a payout flag or a processor status. */
  readonly changesProcessorKyb: false;
}

/** Summarise a decision for the office, keeping Didit's own words beside the neutral result. */
export function diditSessionSummaryOf(session: SupplementaryIdvSession, decision: DiditDecision): DiditSessionSummary {
  return {
    sessionId: session.id,
    reference: session.reference,
    result: session.result,
    liveness: session.liveness,
    documentKind: session.documentKind,
    reasonCode: session.reasonCode,
    sessionStatus: decision.status,
    features: decision.features,
    changesProcessorKyb: false,
  };
}

/** The supplementary vendor key this file implements, spelled once. */
export const DIDIT_VENDOR_KEY: SupplementaryIdvVendorKey = "didit";
