// path: lib/kyc/adapters/sumsub.ts

/**
 * Sumsub as a supplementary identity check: one encrypted configuration, one signed request path, one applicant, and a
 * result that is evidence for a reviewer and never a processor KYB status.
 *
 * ## Documentation read in this session (2026-11-06)
 *
 * Every fact below comes from Sumsub's own documentation, read before this file was written. The `.md` suffix is the
 * agent-readable rendering of the same page.
 *
 * | Topic | URL | What it established |
 * |---|---|---|
 * | Documentation index | https://docs.sumsub.com/llms.txt | The page map used to find the reference pages below. |
 * | Authentication | https://docs.sumsub.com/reference/authentication | Every call carries three headers - `X-App-Token`, `X-App-Access-Sig` (lower-case hex), `X-App-Access-Ts` (seconds since the Unix epoch) - and the signature is `HMAC-SHA256(secret, ts + METHOD + uri + body)` where the URI starts with `/`, **includes every query parameter**, and the body is sent exactly as signed and omitted when there is none. The timestamp must be within **one minute** of server time, and plain HTTP is refused. |
 * | Create applicant | https://docs.sumsub.com/reference/create-applicant.md | `POST /resources/applicants?levelName={level}` creates an applicant and needs the **Create applicants** permission. Sandbox allows 500 applicants per 24 hours. The individual response carries `id` (24 characters), `createdAt`, `clientId`, `inspectionId`, `externalUserId`, `requiredIdDocs.docSets[]`, `review.reviewStatus` and `type`. |
 * | Review status | https://docs.sumsub.com/reference/get-applicant-review-status.md | `GET /resources/applicants/{applicantId}/status` returns `reviewStatus` (`init`, `pending`, `prechecked`, `queued`, `completed`, `onHold`, `awaitingService`, `awaitingUser`), `reviewResult.reviewAnswer` (`GREEN` approved, `RED` declared with `rejectLabels[]` and `reviewRejectType`), plus `levelName`, `attemptId` and the review dates. |
 * | Verification steps | https://docs.sumsub.com/reference/get-status-of-verification-steps.md | `GET /resources/applicants/{applicantId}/requiredIdDocsStatus` breaks the result down per required step - `IDENTITY`, `IDENTITY2..4`, `SELFIE`, `SELFIE2`, `PROOF_OF_RESIDENCE`, `QUESTIONNAIRE`, `APPLICANT_DATA`, `COMPANY` - with each step's own `reviewResult` and the `idDocType`/`country` it was approved for. |
 * | Applicant by external id | https://docs.sumsub.com/reference/get-applicant-data-via-externaluserid.md | An applicant id is **24 digits and lower-case Latin characters**, not a UUID, and `externalUserId` supports up to 512 characters. |
 * | Applicant existence | https://docs.sumsub.com/reference/check-applicant-existence-by-externaluserid.md | `GET /resources/applicants/-/byExternalUserId/{externalUserId}` answers `{"exists": true, "applicant": {...}}` or `{"exists": false}`, which is the documented way to find an applicant whose id is not known. |
 * | Access token | https://docs.sumsub.com/reference/generate-access-token.md | `POST /resources/accessTokens/sdk` with `{userId, levelName, ttlInSecs?}` answers `{token, userId}`; the token's lifespan is `ttlInSecs` (default 600), it is bound to **one** applicant, and failures come back as `{description, code, correlationId, errorCode, errorName}`. It also states that **a Sandbox run uses an app token and secret pair created in Sandbox mode**, with no separate host. |
 * | Sandbox | https://docs.sumsub.com/docs/test-in-sandbox.md | Sandbox is an isolated environment with no approval algorithms and no billing, capped at 500 applicants per 24 hours, driven by verification presets. |
 * | ID results | https://docs.sumsub.com/reference/get-id-verification-results.md | `idDocType` is the document type specified in the level, for example `PASSPORT`, and it appears per document alongside its recognition result. |
 * | Error codes | https://docs.sumsub.com/reference/error-codes.md | The `91xx` codes are applicant-facing verification errors; the transport's own failures are the HTTP status plus `{description, code, errorName}`. |
 *
 * ## What this adapter does with those facts
 *
 * 1. **Every request is signed, and the signature covers the query string.** `sumsubRequestOf` builds the exact bytes
 *    Sumsub documents - timestamp, upper-case method, the path **with its query**, and the body - and signs them with
 *    HMAC-SHA256, answering the three headers. The transport then sends those exact bytes; a query string that is
 *    signed but not sent, or sent but not signed, is the failure mode this design removes.
 * 2. **The mode is declared, never inferred.** Sumsub documents one host for both environments and says a Sandbox run
 *    uses a Sandbox app token and secret pair. Nothing in a token's shape is a mode, so the configuration carries the
 *    mode and this adapter never reads one out of a credential.
 * 3. **Activation is proved without creating anything.** `activateSumsubConfiguration` asks the documented existence
 *    endpoint about an identifier that cannot exist; `{"exists": false}` with a `2XX` means the pair authenticated and
 *    signed correctly, `401`/`403` means it did not, and anything else leaves the configuration waiting.
 * 4. **The applicant is the session, and our reference is `externalUserId`.** Create is sent with the platform's own
 *    session id as `externalUserId`, which Sumsub documents as the caller's identifier of up to 512 characters. A
 *    create that comes back `409` is reconciled through the documented existence lookup rather than by guessing, and
 *    the applicant id Sumsub answers becomes the single stored reference.
 * 5. **The SDK token is answered once and never stored.** Text cannot be verified by a URL in Sumsub, so the person is
 *    handed to the WebSDK with an access token: `POST /resources/accessTokens/sdk` answers a token with a documented
 *    default life of 600 seconds, bound to one applicant. Like Jumio's redirect URL and Didit's hosted URL, it is
 *    returned to the caller and written nowhere.
 * 6. **A step result is read from the steps endpoint, not guessed.** `requiredIdDocsStatus` gives each required step its
 *    own answer, so liveness is the `SELFIE` step's answer and the document kind is the `IDENTITY` step's `idDocType`.
 *    A step that was never configured is `unknown`, because a check that did not run is not a check that passed.
 * 7. **A supplementary pass is never a KYB verdict.** Every answer goes through STEP 170's
 *    `recordSupplementaryIdvAnswer`, so the words `verified`, `pending`, `action_required`, `restricted` and `rejected`
 *    cannot come out of this file, and the merchant sees STEP 170's one neutral phrase.
 *
 * ## What this STEP deliberately does not do
 *
 * The delivery is STEP 174's (Sumsub signs webhooks with its own digest header over the raw body, and that verifier is
 * not written here), and this file therefore trusts no delivery: it reads the review status and the step results, which
 * is what a delivery would have to be confirmed against. No document, selfie, `fixedInfo`, `info` or personal field is
 * ever sent from here, so no name, date of birth, document number or face enters this platform through this module.
 */

import { createHmac, randomUUID } from "node:crypto";
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
import type { SUPPLEMENTARY_IDV_DOCUMENT_KINDS, SupplementaryIdvDocumentKind } from "./supplementary-idv.ts";

/* -------------------------------------------------------------------------------------------------
 * The documented host, paths and bounds
 * ---------------------------------------------------------------------------------------------- */

/** The one host both environments use, as the access-token page states. */
export const SUMSUB_API_HOST = "https://api.sumsub.com";

/** The documented applicant collection path. */
export const SUMSUB_APPLICANTS_PATH = "/resources/applicants";

/** The documented SDK access-token path. */
export const SUMSUB_ACCESS_TOKEN_PATH = "/resources/accessTokens/sdk";

/** The documented create path, with the level whose name is case-sensitive. */
export function sumsubCreatePath(levelName: string): string {
  return `${SUMSUB_APPLICANTS_PATH}?levelName=${encodeURIComponent(levelName.trim())}`;
}

/** The documented review-status path for one applicant. */
export function sumsubStatusPath(applicantId: string): string {
  return `${SUMSUB_APPLICANTS_PATH}/${applicantId.trim()}/status`;
}

/** The documented per-step results path for one applicant. */
export function sumsubStepsPath(applicantId: string): string {
  return `${SUMSUB_APPLICANTS_PATH}/${applicantId.trim()}/requiredIdDocsStatus`;
}

/** The documented existence path for one `externalUserId`. */
export function sumsubExistencePath(externalUserId: string): string {
  return `${SUMSUB_APPLICANTS_PATH}/-/byExternalUserId/${encodeURIComponent(externalUserId.trim())}`;
}

/** The full URL of one documented call. */
export function sumsubEndpoint(path: string): string {
  return `${SUMSUB_API_HOST}${path}`;
}

/** The heading of every call: three documented headers and nothing else that authenticates. */
export const SUMSUB_APP_TOKEN_HEADER = "X-App-Token";
export const SUMSUB_SIGNATURE_HEADER = "X-App-Access-Sig";
export const SUMSUB_TIMESTAMP_HEADER = "X-App-Access-Ts";

/** The applicant id shape the documentation states: 24 digits and lower-case Latin characters. */
export const SUMSUB_APPLICANT_ID_PATTERN = /^[0-9a-z]{24}$/u;

/** True when a value is an applicant id. */
export function isSumsubApplicantId(value: string): boolean {
  return SUMSUB_APPLICANT_ID_PATTERN.test(value.trim());
}

/** The documented `externalUserId` bound. */
export const SUMSUB_EXTERNAL_USER_ID_MAXIMUM_LENGTH = 512;

/** The platform's own credential bounds. */
export const SUMSUB_APP_TOKEN_MAXIMUM_LENGTH = 200;
export const SUMSUB_SECRET_KEY_MAXIMUM_LENGTH = 200;

/** The documented clock tolerance: the timestamp must be within one minute of server time. */
export const SUMSUB_TIMESTAMP_TOLERANCE_SECONDS = 60;

/** The platform's own request timeout. Sumsub documents none for these routes. */
export const SUMSUB_REQUEST_TIMEOUT_MS = 20_000;

/** The largest answer this adapter reads. */
export const SUMSUB_MAXIMUM_ANSWER_BYTES = 524_288;

/** The documented default SDK-token life, in seconds. */
export const SUMSUB_ACCESS_TOKEN_DEFAULT_TTL_SECONDS = 600;

/** The longest SDK-token life this platform asks for. */
export const SUMSUB_ACCESS_TOKEN_MAXIMUM_TTL_SECONDS = 3_600;

/**
 * The review statuses, exactly as the documentation spells them.
 *
 * Camel case with no spaces, and `awaitingService`/`awaitingUser` are real words rather than typos for "awaiting
 * service". A status outside this table is never guessed at.
 */
export const SUMSUB_REVIEW_STATUSES = deepFreeze([
  "init",
  "pending",
  "prechecked",
  "queued",
  "completed",
  "onHold",
  "awaitingService",
  "awaitingUser",
] as const);

/** One Sumsub review status. */
export type SumsubReviewStatus = (typeof SUMSUB_REVIEW_STATUSES)[number];

/** True when a string is a documented review status. */
export function isSumsubReviewStatus(value: string): value is SumsubReviewStatus {
  return (SUMSUB_REVIEW_STATUSES as readonly string[]).includes(value);
}

/** The two documented review answers. */
export const SUMSUB_REVIEW_ANSWERS = deepFreeze(["GREEN", "RED"] as const);

/** One Sumsub review answer. */
export type SumsubReviewAnswer = (typeof SUMSUB_REVIEW_ANSWERS)[number];

/** True when a string is a documented review answer. */
export function isSumsubReviewAnswer(value: string): value is SumsubReviewAnswer {
  return (SUMSUB_REVIEW_ANSWERS as readonly string[]).includes(value);
}

/** The required steps the steps endpoint documents. */
export const SUMSUB_STEP_TYPES = deepFreeze([
  "IDENTITY",
  "IDENTITY2",
  "IDENTITY3",
  "IDENTITY4",
  "SELFIE",
  "SELFIE2",
  "PROOF_OF_RESIDENCE",
  "PROOF_OF_RESIDENCE2",
  "QUESTIONNAIRE",
  "QUESTIONNAIRE2",
  "APPLICANT_DATA",
  "COMPANY",
] as const);

/** The steps that carry a document, in the order this adapter reads them. */
export const SUMSUB_IDENTITY_STEPS = deepFreeze(["IDENTITY", "IDENTITY2", "IDENTITY3", "IDENTITY4"] as const);

/** The steps that carry a liveness capture. */
export const SUMSUB_SELFIE_STEPS = deepFreeze(["SELFIE", "SELFIE2"] as const);

/** The document types the documentation names, and the neutral kind each becomes. */
export const SUMSUB_DOCUMENT_TYPES: Readonly<Record<string, (typeof SUPPLEMENTARY_IDV_DOCUMENT_KINDS)[number]>> = deepFreeze({
  PASSPORT: "passport",
  ID_CARD: "national_id",
  RESIDENCE_PERMIT: "residence_permit",
  // Every other code Sumsub can return - a utility bill, a vehicle registration certificate, a code this file has not
  // read - is a document this platform has no neutral word for, so the kind stays unstated rather than stretched.
});

/**
 * The rejection labels that name a neutral reason, and only the ones the pages read here show.
 *
 * The documentation's own example lists `GRAPHIC_EDITOR`, `UNSATISFACTORY_PHOTOS` and `FORGERY`. Only the middle one
 * has a neutral meaning this platform owns; an edited document and a forged one stay in the office view as labels,
 * because the neutral vocabulary has no word for fraud and this file will not invent one.
 */
export const SUMSUB_REJECT_LABEL_REASONS: Readonly<Record<string, SupplementaryIdvReasonCode>> = deepFreeze({
  UNSATISFACTORY_PHOTOS: "document_unreadable",
});

/* -------------------------------------------------------------------------------------------------
 * The signature, which is the whole authentication
 * ---------------------------------------------------------------------------------------------- */

/** The exact bytes Sumsub documents as signed. */
export function sumsubSignaturePayloadOf(
  timestampSeconds: number,
  method: string,
  path: string,
  body: string | null,
): string {
  const seconds = Math.trunc(timestampSeconds);
  if (Number.isFinite(seconds) === false || seconds <= 0) throw new Error("a timestamp is required");
  if (path.startsWith("/") === false) throw new Error("the uri starts with a slash");
  return `${seconds}${method.trim().toUpperCase()}${path}${body ?? ""}`;
}

/** The lower-case hex HMAC-SHA256 signature of one request. */
export function sumsubSignatureOf(
  secretKey: string,
  timestampSeconds: number,
  method: string,
  path: string,
  body: string | null,
): string {
  const secret = secretKey.trim();
  if (secret.length === 0) throw new Error("a secret key is required");
  return createHmac("sha256", secret).update(sumsubSignaturePayloadOf(timestampSeconds, method, path, body), "utf8").digest("hex");
}

/** One signed request: what to send, and the three headers that prove it. */
export interface SumsubRequest {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body: string | null;
  readonly appToken: string;
  readonly timestampSeconds: number;
  readonly signature: string;
}

/** Build the documented request for one call. Nothing here is stored or logged. */
export function sumsubRequestOf(
  credential: { readonly appToken: string; readonly secretKey: string },
  input: { readonly method: "GET" | "POST"; readonly path: string; readonly body: string | null; readonly occurredAtEpochMs: number },
): SumsubRequest {
  const timestampSeconds = Math.floor(input.occurredAtEpochMs / 1_000);
  return {
    method: input.method,
    path: input.path,
    body: input.body,
    appToken: credential.appToken.trim(),
    timestampSeconds,
    signature: sumsubSignatureOf(credential.secretKey, timestampSeconds, input.method, input.path, input.body),
  };
}

/* -------------------------------------------------------------------------------------------------
 * The encrypted configuration
 * ---------------------------------------------------------------------------------------------- */

/** What a Sumsub configuration holds, in plaintext, only inside a sealed envelope. */
export interface SumsubCredential {
  readonly appToken: string;
  readonly secretKey: string;
}

/** The reason a credential is unusable, or null when it is usable. */
export function validateSumsubCredential(credential: SumsubCredential): string | null {
  const appToken = credential.appToken.trim();
  const secretKey = credential.secretKey.trim();
  if (appToken.length === 0) return "an app token is required";
  if (secretKey.length === 0) return "a secret key is required";
  if (appToken.length < 8) return "the app token is shorter than any Sumsub app token";
  if (secretKey.length < 8) return "the secret key is shorter than any Sumsub secret key";
  if (appToken.length > SUMSUB_APP_TOKEN_MAXIMUM_LENGTH) return "the app token is longer than this platform stores";
  if (secretKey.length > SUMSUB_SECRET_KEY_MAXIMUM_LENGTH) return "the secret key is longer than this platform stores";
  if (/\s/u.test(appToken) || /\s/u.test(secretKey)) return "a credential must not contain whitespace";
  if (/[\u0000-\u001f\u007f]/u.test(appToken) || /[\u0000-\u001f\u007f]/u.test(secretKey)) {
    return "a credential must not contain a control character";
  }
  // No prefix is read and no punctuation is refused: Sumsub documents neither the shape of an app token nor a host
  // that differs between its environments, and it pairs the mode to the credential itself. A colon, a dash or a
  // prefix in an app token is therefore carried as opaque text, never as a mode.
  return null;
}

/** Serialize a credential for the sealed field: JSON, so no delimiter can be guessed wrong. */
export function sumsubCredentialTextOf(credential: SumsubCredential): string {
  return JSON.stringify({ appToken: credential.appToken, secretKey: credential.secretKey });
}

/** Read a sealed field's plaintext back into a credential, or null when it is not one. */
export function sumsubCredentialOf(text: string): SumsubCredential | null {
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
  const appToken = record["appToken"];
  const secretKey = record["secretKey"];
  if (typeof appToken !== "string" || typeof secretKey !== "string") return null;
  const credential: SumsubCredential = { appToken, secretKey };
  return validateSumsubCredential(credential) === null ? credential : null;
}

/** What a caller supplies when a super administrator connects Sumsub. */
export interface SumsubConfigurationInput {
  readonly companyId: string;
  readonly environment: SupplementaryIdvEnvironment;
  readonly credential: SumsubCredential;
  /** The webhook secret Sumsub signs its deliveries with, when the tenant has one. */
  readonly webhookSecret: string | null;
  readonly occurredAtEpochMs: number;
}

/** What connecting Sumsub did. */
export type CreateSumsubConfigurationResult =
  | { readonly status: "configured"; readonly config: SupplementaryIdvConfig }
  | { readonly status: "failed"; readonly reason: string };

/** One audit entry for the configuration half. Session and result entries come from STEP 170. */
export interface SumsubConfigAuditEntry {
  readonly action: "sumsub_idv.configured" | "sumsub_idv.activation_tested" | "sumsub_idv.activated" | "sumsub_idv.refused";
  readonly providerKey: string;
  readonly companyId: string;
  readonly configId: string;
  readonly environment: string;
  readonly outcome: string;
  readonly occurredAtEpochMs: number;
}

/** The provider key this adapter writes into its own audit entries. */
export const SUMSUB_PROVIDER_KEY = "sumsub";

/** The reason a configuration cannot be opened, or its plaintext and the credential inside it. */
function sumsubOpenConfigOf(
  config: SupplementaryIdvConfig | null,
  keyring: EncryptionKeyring,
  allowPendingActivation = false,
): { readonly ok: true; readonly opened: OpenedSupplementaryIdvConfig; readonly credential: SumsubCredential } | { readonly ok: false; readonly reason: string } {
  if (config === null) return { ok: false, reason: "no Sumsub configuration holds that id" };
  if (config.vendorKey !== "sumsub") return { ok: false, reason: "that configuration is not a Sumsub configuration" };
  if (config.status !== "active" && (allowPendingActivation === false || config.status !== "pending_activation")) {
    return { ok: false, reason: "the Sumsub configuration is not active" };
  }
  const opened = openSupplementaryIdvConfig(config, keyring);
  if (opened.status === "failed") return { ok: false, reason: opened.reason };
  const credential = sumsubCredentialOf(opened.config.credential);
  if (credential === null) return { ok: false, reason: "the sealed Sumsub credential is not one this adapter reads" };
  return { ok: true, opened: opened.config, credential };
}

/**
 * Seal a Sumsub configuration and store it, waiting for its activation test.
 *
 * The credential is validated before anything is sealed, both the pair and the delivery secret are sealed under their
 * own scopes by STEP 170's function, and the row starts `pending_activation`.
 */
export function createSumsubConfiguration(
  input: SumsubConfigurationInput,
  options: {
    readonly configStore: SupplementaryIdvConfigStore;
    readonly keyring: EncryptionKeyring;
    readonly recordAudit?: (entry: SumsubConfigAuditEntry) => void;
  },
): CreateSumsubConfigurationResult {
  const invalid = validateSumsubCredential(input.credential);
  if (invalid !== null) return { status: "failed", reason: invalid };
  if (input.companyId.trim().length === 0) return { status: "failed", reason: "a configuration belongs to a company" };

  const sealed = sealSupplementaryIdvConfig(
    {
      companyId: input.companyId,
      vendorKey: "sumsub",
      environment: input.environment,
      credential: sumsubCredentialTextOf(input.credential),
      webhookSecret: input.webhookSecret,
    },
    options.keyring,
  );
  if ("reason" in sealed) return { status: "failed", reason: sealed.reason };

  const config: SupplementaryIdvConfig = {
    id: randomUUID(),
    companyId: input.companyId,
    vendorKey: "sumsub",
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
    action: "sumsub_idv.configured",
    providerKey: SUMSUB_PROVIDER_KEY,
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

/** The HTTP answer. */
export interface SumsubAnswer {
  readonly status: number;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** The transport port: it is handed a signed request and sends exactly that. */
export type SumsubTransport = (request: SumsubRequest) => Promise<SumsubAnswer>;

/** The five paths this adapter may call, and nothing else. */
export const SUMSUB_ALLOWED_CALLS: readonly {
  readonly method: "GET" | "POST";
  readonly path: RegExp;
}[] = deepFreeze([
  { method: "POST", path: /^\/resources\/applicants\?levelName=[^?&]+$/u },
  { method: "POST", path: /^\/resources\/accessTokens\/sdk$/u },
  { method: "GET", path: /^\/resources\/applicants\/[0-9a-z]{24}\/status$/u },
  { method: "GET", path: /^\/resources\/applicants\/[0-9a-z]{24}\/requiredIdDocsStatus$/u },
  { method: "GET", path: /^\/resources\/applicants\/-\/byExternalUserId\/[^/?#]+$/u },
]);

/** True when a method and path are one of the five documented calls. */
export function isSumsubCall(method: string, path: string): boolean {
  return SUMSUB_ALLOWED_CALLS.some((allowed) => allowed.method === method && allowed.path.test(path));
}

/**
 * Perform one signed call.
 *
 * The method and path must be one of the five the documentation names; the signature must be a lower-case hex digest;
 * the credential travels only in headers; redirects are refused; the timeout is bounded; and an answer larger than the
 * bound is refused rather than buffered.
 */
export const sumsubFetchTransport: SumsubTransport = async (request) => {
  if (isSumsubCall(request.method, request.path) === false) throw new Error("invalid API path");
  if (request.appToken.trim().length === 0) throw new Error("an app token is required");
  if (/^[0-9a-f]{64}$/u.test(request.signature) === false) throw new Error("invalid request signature");

  const response = await fetch(sumsubEndpoint(request.path), {
    method: request.method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      [SUMSUB_APP_TOKEN_HEADER]: request.appToken,
      [SUMSUB_SIGNATURE_HEADER]: request.signature,
      [SUMSUB_TIMESTAMP_HEADER]: String(request.timestampSeconds),
    },
    ...(request.body === null ? {} : { body: request.body }),
    redirect: "error",
    signal: AbortSignal.timeout(SUMSUB_REQUEST_TIMEOUT_MS),
  });

  const text = await response.text();
  if (text.length > SUMSUB_MAXIMUM_ANSWER_BYTES) throw new Error("invalid API answer");
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
 * The exact text of a value, with no trimming.
 *
 * Sumsub's status words are exact camel-case tokens, so a padded or re-cased answer must stay unknown rather than
 * becoming an approval this platform never received.
 */
function exactTextOf(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** Sumsub's own words about a failure, bounded. Failures carry `{description, code, errorName}`. */
export function sumsubProblemDetailOf(body: string): string {
  const record = recordOf(jsonOf(body));
  if (record === null) return "";
  const description = textOf(record["description"]);
  const errorName = textOf(record["errorName"]);
  if (description !== null && errorName !== null) return `${description} (${errorName})`.slice(0, 200);
  if (description !== null) return description.slice(0, 200);
  if (errorName !== null) return errorName.slice(0, 200);
  return "";
}

/** What creating an applicant concluded. */
export type SumsubApplicantVerdict =
  | { readonly outcome: "created"; readonly applicantId: string; readonly reviewStatus: string }
  | { readonly outcome: "duplicate"; readonly detail: string | null }
  | { readonly outcome: "refused"; readonly detail: string }
  | { readonly outcome: "failed"; readonly detail: string }
  | { readonly outcome: "unknown"; readonly detail: string };

/**
 * Read a create answer.
 *
 * `2XX` with a 24-character applicant id and the `individual` type is an applicant. `409` is the duplicate this adapter
 * reconciles through the documented existence lookup, a `400` is a refusal, `401`/`403` are a configuration defect, and
 * a redirect, `429` or a `5XX` leaves the outcome unknown.
 */
export function parseSumsubApplicantAnswer(status: number, body: string): SumsubApplicantVerdict {
  if (status === 409) return { outcome: "duplicate", detail: sumsubProblemDetailOf(body) || null };
  if (status === 400 || status === 422) {
    return { outcome: "refused", detail: sumsubProblemDetailOf(body) || `Sumsub refused the request with status ${status}` };
  }
  if (status === 401 || status === 403) {
    return { outcome: "failed", detail: sumsubProblemDetailOf(body) || "Sumsub refused the signed credentials" };
  }
  if (status === 404) {
    return { outcome: "failed", detail: "Sumsub answered 404 on the applicant path, which is a configuration defect" };
  }
  if (status >= 300 && status < 400) {
    return { outcome: "unknown", detail: "Sumsub answered with a redirect, which proves nothing" };
  }
  if (status === 408 || status === 429 || status >= 500) {
    return { outcome: "unknown", detail: "Sumsub did not answer finally, so no applicant was confirmed" };
  }
  if (status < 200 || status >= 300) {
    return { outcome: "failed", detail: `Sumsub answered ${status}` };
  }

  const record = recordOf(jsonOf(body));
  if (record === null) return { outcome: "unknown", detail: "the create answer is not JSON" };
  const applicantId = textOf(record["id"]);
  if (applicantId === null || isSumsubApplicantId(applicantId) === false) {
    return { outcome: "unknown", detail: "the create answer carries no applicant id of 24 characters" };
  }
  const type = textOf(record["type"]);
  if (type !== null && type !== "individual") {
    return { outcome: "unknown", detail: "the create answer is not an individual's applicant" };
  }
  const review = recordOf(record["review"]);
  const reviewStatus = review === null ? null : textOf(review["reviewStatus"]);
  return { outcome: "created", applicantId, reviewStatus: reviewStatus ?? "" };
}

/** What the existence lookup concluded. */
export type SumsubExistenceVerdict =
  | { readonly outcome: "found"; readonly applicantId: string }
  | { readonly outcome: "absent" }
  | { readonly outcome: "failed"; readonly detail: string }
  | { readonly outcome: "unknown"; readonly detail: string };

/** Read an existence answer: `{"exists": true, "applicant": {...}}` or `{"exists": false}`. */
export function parseSumsubExistenceAnswer(status: number, body: string): SumsubExistenceVerdict {
  if (status === 401 || status === 403) return { outcome: "failed", detail: "Sumsub refused the signed credentials" };
  if (status >= 300 && status < 400) return { outcome: "unknown", detail: "Sumsub answered with a redirect, which proves nothing" };
  if (status === 408 || status === 429 || status >= 500) {
    return { outcome: "unknown", detail: "Sumsub did not answer finally, so nothing was confirmed" };
  }
  if (status < 200 || status >= 300) return { outcome: "failed", detail: `Sumsub answered ${status}` };

  const record = recordOf(jsonOf(body));
  if (record === null) return { outcome: "unknown", detail: "the existence answer is not JSON" };
  const exists = record["exists"];
  if (exists === false) return { outcome: "absent" };
  if (exists !== true) return { outcome: "unknown", detail: "the existence answer carries no exists flag" };
  const applicant = recordOf(record["applicant"]);
  const applicantId = applicant === null ? null : textOf(applicant["id"]);
  if (applicantId === null || isSumsubApplicantId(applicantId) === false) {
    return { outcome: "unknown", detail: "the existence answer names no applicant id of 24 characters" };
  }
  return { outcome: "found", applicantId };
}

/** The review answer and its labels, as the status endpoint gives them. */
export interface SumsubReview {
  readonly reviewStatus: string;
  readonly reviewAnswer: SumsubReviewAnswer | null;
  readonly rejectLabels: readonly string[];
  readonly rejectType: string | null;
  readonly levelName: string | null;
}

/** Read the status endpoint's answer. */
export function parseSumsubStatus(body: string): SumsubReview | null {
  const record = recordOf(jsonOf(body));
  if (record === null) return null;
  const reviewStatus = exactTextOf(record["reviewStatus"]);
  if (reviewStatus === null) return null;
  const result = recordOf(record["reviewResult"]);
  const answer = result === null ? null : exactTextOf(result["reviewAnswer"]);
  return {
    reviewStatus,
    reviewAnswer: answer !== null && isSumsubReviewAnswer(answer) ? answer : null,
    rejectLabels: result === null ? [] : arrayOf(result["rejectLabels"]).map((label) => textOf(label)).filter((label): label is string => label !== null),
    rejectType: result === null ? null : textOf(result["reviewRejectType"]),
    levelName: textOf(record["levelName"]),
  };
}

/** One required step's result. */
export interface SumsubStepResult {
  readonly step: string;
  readonly reviewAnswer: SumsubReviewAnswer | null;
  readonly idDocType: string | null;
  readonly rejectLabels: readonly string[];
}

/** Read the steps endpoint's answer into the steps this adapter uses. */
export function parseSumsubSteps(body: string): SumsubStepResult[] | null {
  const record = recordOf(jsonOf(body));
  if (record === null) return null;
  const steps: SumsubStepResult[] = [];
  for (const step of SUMSUB_STEP_TYPES) {
    const entry = recordOf(record[step]);
    if (entry === null) continue;
    const result = recordOf(entry["reviewResult"]);
    const answer = result === null ? null : exactTextOf(result["reviewAnswer"]);
    steps.push({
      step,
      reviewAnswer: answer !== null && isSumsubReviewAnswer(answer) ? answer : null,
      idDocType: textOf(entry["idDocType"]),
      rejectLabels: result === null ? [] : arrayOf(result["rejectLabels"]).map((label) => textOf(label)).filter((label): label is string => label !== null),
    });
  }
  return steps;
}

/** What one session says, as far as this adapter reads it. */
export interface SumsubDecision {
  readonly review: SumsubReview;
  readonly steps: readonly SumsubStepResult[];
}

/** The first identity step's document type, or null when no identity step ran. */
function sumsubDocumentTypeOf(steps: readonly SumsubStepResult[]): string | null {
  for (const step of steps) {
    if ((SUMSUB_IDENTITY_STEPS as readonly string[]).includes(step.step) && step.idDocType !== null) return step.idDocType;
  }
  return null;
}

/** The first selfie step's answer, or null when no selfie step was configured. */
function sumsubSelfieAnswerOf(steps: readonly SumsubStepResult[]): SumsubReviewAnswer | null {
  for (const step of steps) {
    if ((SUMSUB_SELFIE_STEPS as readonly string[]).includes(step.step) && step.reviewAnswer !== null) return step.reviewAnswer;
  }
  return null;
}

/** The first identity step's answer, or null when no identity step ran. */
function sumsubIdentityAnswerOf(steps: readonly SumsubStepResult[]): SumsubReviewAnswer | null {
  for (const step of steps) {
    if ((SUMSUB_IDENTITY_STEPS as readonly string[]).includes(step.step) && step.reviewAnswer !== null) return step.reviewAnswer;
  }
  return null;
}

/**
 * Turn a status and its step results into the neutral answer STEP 170 records.
 *
 * The rules, and why each is what it is:
 *
 *   - `completed` with `GREEN` passes, and `completed` with `RED` fails, exactly as the documentation defines the two
 *     answers.
 *   - Every other status is still moving: `init`, `pending`, `prechecked`, `queued`, `awaitingService` and
 *     `awaitingUser` are `in_progress`, because the applicant or Sumsub still has work to do.
 *   - `onHold` is also `in_progress`: the documentation says a compliance expert's assistance is required, so the
 *     review is not decided yet. It cannot become `unknown`, because STEP 170's record moves a running session only
 *     to a decided word, and Sumsub's own `onHold` is kept beside the neutral result for the office to read.
 *   - A status this file has not read is `unknown`, never a guess.
 *   - Liveness is the `SELFIE` step's own answer: `GREEN` passed, `RED` failed, present but unanswered `in_progress`,
 *     and absent `unknown` - a check the level never configured did not pass.
 *   - The reason comes from a documented rejection label first, then from the step that decided; a label this file has
 *     not read stays in the office view and never becomes a reason.
 */
export function sumsubAnswerOf(decision: SumsubDecision, reference: string): SupplementaryIdvVendorAnswer {
  const selfie = sumsubSelfieAnswerOf(decision.steps);
  const liveness: SupplementaryIdvLiveness =
    selfie === "GREEN" ? "passed" : selfie === "RED" ? "failed" : decision.steps.some((step) => (SUMSUB_SELFIE_STEPS as readonly string[]).includes(step.step)) ? "in_progress" : "unknown";

  const documentType = sumsubDocumentTypeOf(decision.steps);
  const documentKind = documentType === null ? "not_stated" : (SUMSUB_DOCUMENT_TYPES[documentType] ?? "not_stated");

  const labels = [...decision.review.rejectLabels, ...decision.steps.flatMap((step) => step.rejectLabels)];
  const documentedReason = labels
    .map((label) => SUMSUB_REJECT_LABEL_REASONS[label])
    .find((reason): reason is SupplementaryIdvReasonCode => reason !== undefined);

  let result: SupplementaryIdvResult;
  let reasonCode: SupplementaryIdvReasonCode;

  if (decision.review.reviewStatus === "completed") {
    if (decision.review.reviewAnswer === "GREEN") {
      result = "passed";
      reasonCode = "not_stated";
    } else if (decision.review.reviewAnswer === "RED") {
      result = "failed";
      reasonCode =
        documentedReason ??
        (selfie === "RED"
          ? "liveness_failed"
          : sumsubIdentityAnswerOf(decision.steps) === "RED"
            ? "document_unreadable"
            : "not_stated");
    } else {
      // `completed` with no answer is a record this file cannot read.
      result = "unknown";
      reasonCode = "vendor_incomplete";
    }
  } else if (isSumsubReviewStatus(decision.review.reviewStatus)) {
    result = "in_progress";
    reasonCode = "vendor_incomplete";
  } else {
    result = "unknown";
    reasonCode = "vendor_incomplete";
  }

  return { reference, result, liveness, documentKind, reasonCode };
}

/** What reading a session concluded. */
export type SumsubReadVerdict =
  | { readonly outcome: "read"; readonly answer: SupplementaryIdvVendorAnswer }
  | { readonly outcome: "in_flight"; readonly answer: SupplementaryIdvVendorAnswer }
  | { readonly outcome: "not_found"; readonly detail: string }
  | { readonly outcome: "failed"; readonly detail: string }
  | { readonly outcome: "unknown"; readonly detail: string };

/**
 * Read the two answers a decision needs.
 *
 * The status answer is authoritative: a `404` on it means Sumsub does not know the applicant, and a `401`/`403` is a
 * configuration defect. The step answer enriches the result but never overrides it - a steps read that fails leaves the
 * liveness and the document kind unknown rather than turning a decided session into a failure.
 */
export function parseSumsubReadAnswers(
  statusCode: number,
  statusBody: string,
  stepsCode: number,
  stepsBody: string,
  reference: string,
): SumsubReadVerdict {
  if (statusCode === 404) return { outcome: "not_found", detail: "Sumsub does not know that applicant under this client" };
  if (statusCode === 400) return { outcome: "failed", detail: sumsubProblemDetailOf(statusBody) || "Sumsub refused the read" };
  if (statusCode === 401 || statusCode === 403) return { outcome: "failed", detail: "Sumsub refused the signed credentials" };
  if (statusCode === 408 || statusCode === 425 || statusCode === 429 || statusCode >= 500) {
    return { outcome: "unknown", detail: "Sumsub did not answer finally, so the review status was not read" };
  }
  if (statusCode >= 300 && statusCode < 400) return { outcome: "unknown", detail: "Sumsub answered with a redirect, which proves nothing" };
  if (statusCode < 200 || statusCode >= 300) return { outcome: "failed", detail: `Sumsub answered ${statusCode}` };

  const review = parseSumsubStatus(statusBody);
  if (review === null) return { outcome: "unknown", detail: "the status answer carries no review status" };
  const steps = stepsCode >= 200 && stepsCode < 300 ? parseSumsubSteps(stepsBody) : [];
  const answer = sumsubAnswerOf({ review, steps: steps ?? [] }, reference);
  return answer.result === "in_progress" ? { outcome: "in_flight", answer } : { outcome: "read", answer };
}

/* -------------------------------------------------------------------------------------------------
 * The request this platform builds
 * ---------------------------------------------------------------------------------------------- */

/** The `externalUserId` this platform sends: the session id, which is opaque and personal-data free. */
export function sumsubExternalUserIdOf(sessionId: string): string {
  const value = sessionId.trim();
  return value.length > SUMSUB_EXTERNAL_USER_ID_MAXIMUM_LENGTH ? value.slice(0, SUMSUB_EXTERNAL_USER_ID_MAXIMUM_LENGTH) : value;
}

/** What the platform asks Sumsub for. */
export interface SumsubSessionInput {
  /** The row STEP 170 opened, which must still be `in_progress` and must carry no vendor reference. */
  readonly sessionId: string;
  /** The verification level the office configured; its name is case-sensitive and must exist in that environment. */
  readonly levelName: string;
}

/** The reason a session request is unusable, or null. */
export function validateSumsubSessionInput(input: SumsubSessionInput): string | null {
  const level = input.levelName.trim();
  if (level.length === 0) return "a level name is required, because Sumsub verifies against the level it names";
  if (level.length > 200) return "the level name is longer than this platform sends";
  if (/\s/u.test(level)) return "the level name must not contain whitespace";
  if (/^[A-Za-z0-9._-]+$/u.test(level) === false) return "the level name carries a character this platform does not send";
  const external = sumsubExternalUserIdOf(input.sessionId);
  if (external.length === 0) return "an external user id is required";
  if (/\s/u.test(external)) return "the external user id must not contain whitespace";
  return null;
}

/** The body of a create request. One field: our own identifier, and nothing personal. */
export function buildSumsubApplicantBody(input: { readonly sessionId: string }): { readonly externalUserId: string } {
  return { externalUserId: sumsubExternalUserIdOf(input.sessionId) };
}

/* -------------------------------------------------------------------------------------------------
 * Opening a session
 * ---------------------------------------------------------------------------------------------- */

/** A session Sumsub created. */
export interface SumsubOpenedSession {
  readonly sessionId: string;
  /** The reference this platform stores: Sumsub's applicant id. */
  readonly reference: string;
  readonly session: SupplementaryIdvSession;
}

/** What opening a Sumsub session did. */
export type OpenSumsubSessionResult =
  | { readonly status: "opened"; readonly opened: SumsubOpenedSession; readonly reconciled: boolean }
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string; readonly requiresReconciliation: boolean };

/** The options every call here needs. */
export interface SumsubOptions {
  readonly configStore: SupplementaryIdvConfigStore;
  readonly sessionStore: SupplementaryIdvSessionStore;
  readonly keyring: EncryptionKeyring;
  readonly occurredAtEpochMs: number;
  readonly transport?: SumsubTransport;
  readonly recordAudit?: (entry: SupplementaryIdvAuditEntry) => void;
  readonly recordConfigAudit?: (entry: SumsubConfigAuditEntry) => void;
}

/** Find an applicant by our own identifier, through the documented existence lookup. */
async function sumsubLookupApplicant(
  credential: SumsubCredential,
  externalUserId: string,
  options: SumsubOptions,
): Promise<SumsubExistenceVerdict> {
  let answer: SumsubAnswer;
  try {
    answer = await (options.transport ?? sumsubFetchTransport)(
      sumsubRequestOf(credential, {
        method: "GET",
        path: sumsubExistencePath(externalUserId),
        body: null,
        occurredAtEpochMs: options.occurredAtEpochMs,
      }),
    );
  } catch {
    return { outcome: "unknown", detail: "the existence lookup could not be made" };
  }
  return parseSumsubExistenceAnswer(answer.status, answer.body);
}

/**
 * Open one Sumsub session for a session row this platform already recorded.
 *
 * The order is STEP 170's: the row exists first, then the vendor is called, then the reference is recorded. A `409`
 * from create is reconciled through the documented existence lookup - the applicant that already holds our
 * `externalUserId` is adopted rather than a second one created - and the applicant id becomes the stored reference.
 */
export async function openSumsubSession(
  input: SumsubSessionInput,
  options: SumsubOptions,
): Promise<OpenSumsubSessionResult> {
  const invalid = validateSumsubSessionInput(input);
  if (invalid !== null) return { status: "failed", reason: invalid, requiresReconciliation: false };

  const session = options.sessionStore.findById(input.sessionId);
  if (session === null) return { status: "failed", reason: "no session holds that id", requiresReconciliation: false };
  if (session.vendorKey !== "sumsub") return { status: "failed", reason: "that session belongs to another vendor", requiresReconciliation: false };
  if (session.result !== "in_progress") return { status: "failed", reason: "the session is no longer in progress", requiresReconciliation: false };
  if (session.reference !== null) return { status: "failed", reason: "the session already carries a Sumsub reference", requiresReconciliation: false };

  const config = options.configStore.findById(session.configId);
  if (config !== null && config.environment !== session.environment) {
    return { status: "failed", reason: "the session and its configuration disagree about the mode", requiresReconciliation: false };
  }
  const opening = sumsubOpenConfigOf(config, options.keyring);
  if (opening.ok === false) return { status: "failed", reason: opening.reason, requiresReconciliation: false };

  const externalUserId = sumsubExternalUserIdOf(session.id);
  let answer: SumsubAnswer;
  try {
    answer = await (options.transport ?? sumsubFetchTransport)(
      sumsubRequestOf(opening.credential, {
        method: "POST",
        path: sumsubCreatePath(input.levelName),
        body: JSON.stringify(buildSumsubApplicantBody({ sessionId: session.id })),
        occurredAtEpochMs: options.occurredAtEpochMs,
      }),
    );
  } catch {
    return {
      status: "failed",
      reason: "the create call could not be made, so the session's outcome is unknown",
      requiresReconciliation: true,
    };
  }

  const verdict = parseSumsubApplicantAnswer(answer.status, answer.body);
  let applicantId: string | null = null;
  let reconciled = false;

  if (verdict.outcome === "created") {
    applicantId = verdict.applicantId;
  } else if (verdict.outcome === "duplicate") {
    const lookup = await sumsubLookupApplicant(opening.credential, externalUserId, options);
    if (lookup.outcome === "found") {
      applicantId = lookup.applicantId;
      reconciled = true;
    } else if (lookup.outcome === "absent") {
      return { status: "failed", reason: "Sumsub reported a duplicate but does not hold that applicant", requiresReconciliation: true };
    } else {
      return { status: "failed", reason: lookup.detail, requiresReconciliation: true };
    }
  } else if (verdict.outcome === "refused") {
    return { status: "refused", reason: verdict.detail };
  } else if (verdict.outcome === "failed") {
    return { status: "failed", reason: verdict.detail, requiresReconciliation: false };
  } else {
    return { status: "failed", reason: verdict.detail, requiresReconciliation: true };
  }

  const recorded = recordSupplementaryIdvAnswer(
    session.id,
    { reference: applicantId, result: "in_progress", liveness: "in_progress", documentKind: "not_stated", reasonCode: "vendor_incomplete" },
    {
      sessionStore: options.sessionStore,
      occurredAtEpochMs: options.occurredAtEpochMs,
      ...(options.recordAudit === undefined ? {} : { recordAudit: options.recordAudit }),
    },
  );
  if (recorded.status !== "recorded") {
    return {
      status: "failed",
      reason: `Sumsub created the applicant but it was not recorded: ${recorded.reason}`,
      requiresReconciliation: true,
    };
  }

  return {
    status: "opened",
    reconciled,
    opened: { sessionId: session.id, reference: applicantId, session: recorded.session },
  };
}

/* -------------------------------------------------------------------------------------------------
 * The SDK token, which is what the person is handed
 * ---------------------------------------------------------------------------------------------- */

/** What creating an SDK access token did. */
export type CreateSumsubAccessTokenResult =
  | { readonly status: "issued"; readonly token: string; readonly ttlSeconds: number }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "refused"; readonly reason: string };

/**
 * Ask Sumsub for a WebSDK access token for one session.
 *
 * The token is answered once and never stored: it is a credential bound to one applicant, with a documented default
 * life of 600 seconds, and the caller hands it to the SDK in the browser. The level name is the office's, and the
 * `userId` is our own identifier - the same `externalUserId` the applicant was created with, because that is what the
 * documentation binds the token to.
 */
export async function createSumsubAccessToken(
  input: { readonly sessionId: string; readonly levelName: string; readonly ttlSeconds?: number },
  options: SumsubOptions,
): Promise<CreateSumsubAccessTokenResult> {
  const session = options.sessionStore.findById(input.sessionId);
  if (session === null) return { status: "failed", reason: "no session holds that id" };
  if (session.vendorKey !== "sumsub") return { status: "failed", reason: "that session belongs to another vendor" };
  if (session.reference === null) return { status: "failed", reason: "the session has no Sumsub applicant yet" };

  const invalid = validateSumsubSessionInput({ sessionId: session.id, levelName: input.levelName });
  if (invalid !== null) return { status: "failed", reason: invalid };

  const config = options.configStore.findById(session.configId);
  const opening = sumsubOpenConfigOf(config, options.keyring);
  if (opening.ok === false) return { status: "failed", reason: opening.reason };

  const ttl = Math.min(
    Math.max(input.ttlSeconds ?? SUMSUB_ACCESS_TOKEN_DEFAULT_TTL_SECONDS, 60),
    SUMSUB_ACCESS_TOKEN_MAXIMUM_TTL_SECONDS,
  );

  let answer: SumsubAnswer;
  try {
    answer = await (options.transport ?? sumsubFetchTransport)(
      sumsubRequestOf(opening.credential, {
        method: "POST",
        path: SUMSUB_ACCESS_TOKEN_PATH,
        body: JSON.stringify({ userId: sumsubExternalUserIdOf(session.id), levelName: input.levelName.trim(), ttlInSecs: ttl }),
        occurredAtEpochMs: options.occurredAtEpochMs,
      }),
    );
  } catch {
    return { status: "failed", reason: "the access-token call could not be made" };
  }

  if (answer.status === 401 || answer.status === 403) {
    return { status: "refused", reason: sumsubProblemDetailOf(answer.body) || "Sumsub refused the signed credentials" };
  }
  if (answer.status < 200 || answer.status >= 300) {
    return { status: "failed", reason: sumsubProblemDetailOf(answer.body) || `Sumsub answered ${answer.status}` };
  }

  const record = recordOf(jsonOf(answer.body));
  const token = record === null ? null : textOf(record["token"]);
  if (token === null || token.length < 8 || token.length > 2_048) {
    return { status: "failed", reason: "the access-token answer carries no usable token" };
  }
  return { status: "issued", token, ttlSeconds: ttl };
}

/* -------------------------------------------------------------------------------------------------
 * Reading a session
 * ---------------------------------------------------------------------------------------------- */

/** What refreshing a session did. */
export type RefreshSumsubSessionResult =
  | { readonly status: "recorded"; readonly session: SupplementaryIdvSession; readonly changed: boolean }
  | { readonly status: "in_flight"; readonly session: SupplementaryIdvSession; readonly changed: boolean }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "refused"; readonly reason: string };

/**
 * Read one session's review status and step results, and record what they say.
 *
 * The record is written through STEP 170's `recordSupplementaryIdvAnswer`, so results are forward-only: a completed
 * review cannot be replayed into a running one, and an `onHold` that arrives after a recorded pass is refused rather
 * than overwriting it.
 */
export async function refreshSumsubSession(sessionId: string, options: SumsubOptions): Promise<RefreshSumsubSessionResult> {
  const session = options.sessionStore.findById(sessionId);
  if (session === null) return { status: "failed", reason: "no session holds that id" };
  if (session.vendorKey !== "sumsub") return { status: "failed", reason: "that session belongs to another vendor" };
  const reference = session.reference;
  if (reference === null || isSumsubApplicantId(reference) === false) {
    return { status: "failed", reason: "the session carries no usable Sumsub reference" };
  }

  const config = options.configStore.findById(session.configId);
  const opening = sumsubOpenConfigOf(config, options.keyring);
  if (opening.ok === false) return { status: "failed", reason: opening.reason };

  const transport = options.transport ?? sumsubFetchTransport;
  let statusAnswer: SumsubAnswer;
  let stepsAnswer: SumsubAnswer;
  try {
    statusAnswer = await transport(
      sumsubRequestOf(opening.credential, {
        method: "GET",
        path: sumsubStatusPath(reference),
        body: null,
        occurredAtEpochMs: options.occurredAtEpochMs,
      }),
    );
    // The step answer enriches the result; when it cannot be read, the status answer still decides.
    stepsAnswer = { status: 0, body: "", headers: {} };
    if (statusAnswer.status >= 200 && statusAnswer.status < 300) {
      try {
        stepsAnswer = await transport(
          sumsubRequestOf(opening.credential, {
            method: "GET",
            path: sumsubStepsPath(reference),
            body: null,
            occurredAtEpochMs: options.occurredAtEpochMs,
          }),
        );
      } catch {
        stepsAnswer = { status: 0, body: "", headers: {} };
      }
    }
  } catch {
    return { status: "failed", reason: "Sumsub could not be reached, so the review status is unknown" };
  }

  const verdict = parseSumsubReadAnswers(statusAnswer.status, statusAnswer.body, stepsAnswer.status, stepsAnswer.body, reference);
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
export type ActivateSumsubConfigurationResult =
  | { readonly status: "activated"; readonly config: SupplementaryIdvConfig }
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string };

/**
 * Activate a stored Sumsub configuration by proving the pair signs.
 *
 * The probe asks the documented existence endpoint about an identifier that cannot exist. `{"exists": false}` proves
 * the app token, the secret and the timestamp arithmetic all reached Sumsub and were accepted - and it creates
 * nothing, charges nothing and holds no personal data. `401`/`403` is a refusal; a redirect, `429`, a `5XX`, a throw
 * or any other answer leaves the configuration waiting.
 */
export async function activateSumsubConfiguration(
  configId: string,
  options: {
    readonly configStore: SupplementaryIdvConfigStore;
    readonly keyring: EncryptionKeyring;
    readonly occurredAtEpochMs: number;
    readonly transport?: SumsubTransport;
    readonly recordAudit?: (entry: SumsubConfigAuditEntry) => void;
  },
): Promise<ActivateSumsubConfigurationResult> {
  const config = options.configStore.findById(configId);
  if (config === null) return { status: "failed", reason: "no configuration holds that id" };
  if (config.vendorKey !== "sumsub") return { status: "refused", reason: "that configuration is not a Sumsub configuration" };
  if (config.status === "active") return { status: "activated", config };

  const opening = sumsubOpenConfigOf(config, options.keyring, true);
  if (opening.ok === false) return { status: "failed", reason: opening.reason };

  const others = options.configStore
    .findActiveForCompany(config.companyId)
    .filter((other) => other.id !== config.id && other.environment === config.environment);
  if (others.length > 0) {
    options.recordAudit?.({
      action: "sumsub_idv.refused",
      providerKey: SUMSUB_PROVIDER_KEY,
      companyId: config.companyId,
      configId: config.id,
      environment: config.environment,
      outcome: "another vendor is already active in this mode",
      occurredAtEpochMs: options.occurredAtEpochMs,
    });
    return { status: "refused", reason: "another vendor is already active in this mode" };
  }

  const probe = await sumsubLookupApplicant(
    opening.credential,
    `kd-probe-${randomUUID()}`,
    {
      configStore: options.configStore,
      sessionStore: { insert: () => undefined, findById: () => null, findByReference: () => null, save: () => false },
      keyring: options.keyring,
      occurredAtEpochMs: options.occurredAtEpochMs,
      ...(options.transport === undefined ? {} : { transport: options.transport }),
    },
  );

  const proven = probe.outcome === "absent" || probe.outcome === "found";
  options.recordAudit?.({
    action: "sumsub_idv.activation_tested",
    providerKey: SUMSUB_PROVIDER_KEY,
    companyId: config.companyId,
    configId: config.id,
    environment: config.environment,
    outcome: probe.outcome,
    occurredAtEpochMs: options.occurredAtEpochMs,
  });
  if (proven === false) {
    return {
      status: "refused",
      reason: probe.outcome === "unknown" ? "Sumsub did not answer finally, so the pair was not proved" : "Sumsub refused the signed credentials",
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
    action: "sumsub_idv.activated",
    providerKey: SUMSUB_PROVIDER_KEY,
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

/** The configuration a Sumsub adapter needs beyond the opened secrets. */
export interface SumsubAdapterOptions {
  readonly transport: SumsubTransport;
  readonly levelName: string;
  readonly occurredAtEpochMs: () => number;
}

/**
 * Build the `SupplementaryIdvAdapter` STEP 170 defines for Sumsub.
 *
 * The port has three members and this factory returns exactly those three. The level name and the clock are the
 * office's configuration - a Sumsub request cannot be signed without a timestamp - so they are bound here once.
 */
export function sumsubAdapterOf(options: SumsubAdapterOptions): SupplementaryIdvAdapter {
  return {
    vendorKey: "sumsub",
    createSession: async (
      request: { readonly companyId: string; readonly sessionId: string; readonly environment: SupplementaryIdvEnvironment; readonly returnUrl: string },
      config: OpenedSupplementaryIdvConfig,
    ): Promise<SupplementaryIdvVendorAnswer> => {
      const credential = sumsubCredentialOf(config.credential);
      if (credential === null) throw new Error("the opened Sumsub configuration carries no usable credential");
      const created = await options.transport(
        sumsubRequestOf(credential, {
          method: "POST",
          path: sumsubCreatePath(options.levelName),
          body: JSON.stringify(buildSumsubApplicantBody({ sessionId: request.sessionId })),
          occurredAtEpochMs: options.occurredAtEpochMs(),
        }),
      );
      const verdict = parseSumsubApplicantAnswer(created.status, created.body);
      if (verdict.outcome !== "created") throw new Error(verdict.detail ?? "Sumsub did not create an applicant");
      return {
        reference: verdict.applicantId,
        result: "in_progress",
        liveness: "in_progress",
        documentKind: "not_stated",
        reasonCode: "vendor_incomplete",
      };
    },
    readSession: async (reference: string, config: OpenedSupplementaryIdvConfig): Promise<SupplementaryIdvVendorAnswer> => {
      const credential = sumsubCredentialOf(config.credential);
      if (credential === null) throw new Error("the opened Sumsub configuration carries no usable credential");
      if (isSumsubApplicantId(reference) === false) throw new Error("that is not a Sumsub applicant id");
      const status = await options.transport(
        sumsubRequestOf(credential, {
          method: "GET",
          path: sumsubStatusPath(reference),
          body: null,
          occurredAtEpochMs: options.occurredAtEpochMs(),
        }),
      );
      // The status answer is authoritative; a steps read that fails leaves liveness and the document kind unknown.
      let steps: SumsubAnswer = { status: 0, body: "", headers: {} };
      try {
        steps = await options.transport(
          sumsubRequestOf(credential, {
            method: "GET",
            path: sumsubStepsPath(reference),
            body: null,
            occurredAtEpochMs: options.occurredAtEpochMs(),
          }),
        );
      } catch {
        steps = { status: 0, body: "", headers: {} };
      }
      const verdict = parseSumsubReadAnswers(status.status, status.body, steps.status, steps.body, reference.trim());
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

/** A session as the office sees it: Sumsub's own review and steps, and the neutral result they became. */
export interface SumsubSessionSummary {
  readonly sessionId: string;
  readonly reference: string | null;
  readonly result: SupplementaryIdvResult;
  readonly liveness: SupplementaryIdvLiveness;
  readonly documentKind: SupplementaryIdvDocumentKind;
  readonly reasonCode: SupplementaryIdvReasonCode | null;
  readonly reviewStatus: string;
  readonly reviewAnswer: SumsubReviewAnswer | null;
  readonly rejectLabels: readonly string[];
  readonly steps: readonly SumsubStepResult[];
  /** Always false: nothing here changes a charge flag, a payout flag or a processor status. */
  readonly changesProcessorKyb: false;
}

/** Summarise a review and its steps for the office, keeping Sumsub's words beside the neutral result. */
export function sumsubSessionSummaryOf(session: SupplementaryIdvSession, decision: SumsubDecision): SumsubSessionSummary {
  return {
    sessionId: session.id,
    reference: session.reference,
    result: session.result,
    liveness: session.liveness,
    documentKind: session.documentKind,
    reasonCode: session.reasonCode,
    reviewStatus: decision.review.reviewStatus,
    reviewAnswer: decision.review.reviewAnswer,
    rejectLabels: decision.review.rejectLabels,
    steps: decision.steps,
    changesProcessorKyb: false,
  };
}

/** The supplementary vendor key this file implements, spelled once. */
export const SUMSUB_VENDOR_KEY: SupplementaryIdvVendorKey = "sumsub";
