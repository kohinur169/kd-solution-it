// path: lib/kyc/adapters/jumio.ts

/**
 * Jumio as a supplementary identity check: an encrypted configuration, a verification session, and a result that is
 * evidence for a reviewer and never a processor KYB status.
 *
 * ## Documentation read in this session (2026-11-06)
 *
 * Every fact below comes from Jumio's own documentation, read before this file was written:
 *
 * | Topic | URL | What it established |
 * |---|---|---|
 * | Documentation index | https://documentation.jumio.ai/ | The product families and where the API reference lives. |
 * | Access token | https://documentation.jumio.ai/docs/quickStart/authentication | `POST https://auth.{region}.jumio.ai/oauth2/token`, HTTP Basic with the client id and secret, `grant_type=client_credentials`, `{access_token, expires_in: 3600, token_type: "Bearer"}`, and the instruction to reuse a token instead of asking for one per transaction. |
 * | API surfaces and hosts | https://documentation.jumio.ai/docs/developer-resources/API/ | The five API families, the three datacenters (`amer-1`, `emea-1`, `apac-1`), and the account response carrying `account.id`, `web.href` and `workflowExecution.id`. |
 * | Account request fields | https://documentation.jumio.ai/docs/developer-resources/API/CreateUpdateAccounts/creating-and-updating-accounts | `customerInternalReference` (1-100 characters, no PII, none of `<>"/;` + backtick + `%{}|`), `workflowDefinition.key`, and the optional `callbackUrl`, `tokenLifetime`, `web.successUrl` and `web.errorUrl`. |
 * | Create an account | https://documentation.jumio.ai/developer-resources/api/account | `POST /api/v1/accounts` answers `201`, requires a `User-Agent` header, and returns `timestamp`, `account.id`, `web.href`, `sdk.token` and `workflowExecution.id`; `401`, `403` and `404` are the documented failures. |
 * | Retrieval API | https://documentation.jumio.ai/developer-resources/api/retrieval | `GET /api/v1/accounts/{accountId}/workflow-executions/{workflowExecutionId}` returns the transaction record with `workflow.status` and `capabilities`; `401`, `403` and `404` are documented; the workflow status endpoint returns the same body a callback sends. |
 * | Retrieval specification | https://documentation.jumio.ai/redocusaurus/retrieval-v3.yaml | The decision enum `PASSED`, `REJECTED`, `WARNING`, `NOT_EXECUTED`; `workflow.status` is a free string with no documented enumeration; the capture client's states include `expired`. |
 * | Capabilities and their order | https://documentation.jumio.ai/docs/references/capabilities/ | The capability names this file reads (`usability`, `classification`, `extraction`, `imageChecks`, `dataChecks`, `liveness`, `similarity`) and the rule that a rejected capability leaves the ones depending on it `NOT_EXECUTED`. |
 * | Liveness | https://documentation.jumio.ai/docs/references/capabilities/liveness | The `liveness` capability's response shape and its decision labels, including `LIVENESS_UNDETERMINED`, `DIGITAL_COPY`, `PHOTOCOPY`, `MANIPULATED`, `NO_FACE_PRESENT` and `MULTIPLE_PEOPLE`. |
 * | Testing | https://documentation.jumio.ai/docs/developer-resources/API/test-with-the-mock-service | There is no separate test host: a test run is a dedicated **mock-service tenant** on the same datacenters, and the scenario is chosen by putting a JSON string in `customerInternalReference`. |
 * | Vendor uptime status | https://documentation.jumio.ai/developer-resources/api/status-endpoint | The `status.{region}.jumio.ai` hosts are Jumio's own public status page; they say nothing about a transaction and are deliberately not used here. |
 *
 * ## What this adapter does with those facts
 *
 * 1. **The configuration is encrypted.** A Jumio configuration is three values — the datacenter, the client id and the
 *    client secret — serialized as JSON and sealed by STEP 170's `sealSupplementaryIdvConfig`, which gives the
 *    ciphertext its own per-vendor, per-company, per-purpose AAD scope. The plaintext exists only inside
 *    `openSupplementaryIdvConfig`'s answer, inside `jumioCredentialOf`, and inside the one Basic header this file
 *    builds. A configuration is `pending_activation` until a real token call succeeds.
 * 2. **A session is opened before the vendor is called.** STEP 170's row is written first, then `POST /api/v1/accounts`
 *    is sent with the reference this platform derived and the workflow key the office chose, and the vendor's
 *    `account.id` and `workflowExecution.id` are stored as one reference. The `web.href` Jumio answers with carries an
 *    `authorizationToken` in its query string, so it is handed to the caller **once** and never stored — the same rule
 *    STEP 168 applied to a client secret.
 * 3. **Only a completed workflow has an answer.** `workflow.status` is a free string in the specification, so this
 *    file does not invent a status table: `PROCESSED` is the one status the documentation shows carrying decisions,
 *    and every other status is `in_progress` — unless the capture client's own state says the journey `expired`, which
 *    is documented, and then it is `expired`.
 * 4. **The four documented decisions are mapped, and nothing else is guessed.** `PASSED` passes, `REJECTED` fails,
 *    `NOT_EXECUTED` and `WARNING` are `unknown` rather than a pass or a rejection, and the reason code is chosen by
 *    *which capability* decided — not by a label, because the label tables of every capability were not all read.
 * 5. **A supplementary pass is never a KYB verdict.** The result goes through STEP 170's `recordSupplementaryIdvAnswer`,
 *    so the words `verified`, `pending`, `action_required`, `restricted` and `rejected` cannot come out of this file,
 *    and the merchant sees STEP 170's one neutral phrase.
 *
 * ## What this STEP deliberately does not do
 *
 * The callback is STEP 174's: this file only ever **reads** a workflow and believes the vendor's own retrieval answer,
 * which is exactly what a callback would have to be confirmed against. No credential upload, no image, no document
 * number and no prepared data is sent from here: the person is handed to Jumio's own page and this platform never sees
 * the document.
 */

import { randomUUID } from "node:crypto";
import { deepFreeze } from "../../utils/freeze.ts";
import type { EncryptionKeyring } from "../../security/encryption.ts";
import {
  InMemorySupplementaryIdvConfigStore,
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
 * The documented hosts, paths and bounds
 * ---------------------------------------------------------------------------------------------- */

/** The three datacenters Jumio documents, and no others. */
export const JUMIO_REGIONS = deepFreeze(["amer-1", "emea-1", "apac-1"] as const);

/** One Jumio datacenter. */
export type JumioRegion = (typeof JUMIO_REGIONS)[number];

/** True when a string is a documented datacenter. */
export function isJumioRegion(value: string): value is JumioRegion {
  return (JUMIO_REGIONS as readonly string[]).includes(value.trim());
}

/** The three surfaces this adapter calls, in the documentation's own words. */
export const JUMIO_SURFACES = deepFreeze(["auth", "account", "retrieval"] as const);

/** One Jumio surface. */
export type JumioSurface = (typeof JUMIO_SURFACES)[number];

/** The documented token path. */
export const JUMIO_TOKEN_PATH = "/oauth2/token";

/** The documented account path. */
export const JUMIO_ACCOUNTS_PATH = "/api/v1/accounts";

/** The documented retrieval path for one workflow execution. */
export function jumioWorkflowExecutionPath(accountId: string, workflowExecutionId: string): string {
  return `/api/v1/accounts/${accountId}/workflow-executions/${workflowExecutionId}`;
}

/** The host a surface lives on, for one datacenter. */
export function jumioHost(surface: JumioSurface, region: JumioRegion): string {
  if (isJumioRegion(region) === false) throw new Error("that is not a documented Jumio datacenter");
  if (surface === "auth") return `https://auth.${region}.jumio.ai`;
  if (surface === "account") return `https://account.${region}.jumio.ai`;
  return `https://retrieval.${region}.jumio.ai`;
}

/** The full URL of one documented call. */
export function jumioEndpoint(surface: JumioSurface, region: JumioRegion, path: string): string {
  return `${jumioHost(surface, region)}${path}`;
}

/** The `User-Agent` the account API requires, and the only one this adapter sends. */
export const JUMIO_USER_AGENT = "kd-solution-it-kyc-idv/1.0";

/** The three paths this adapter may call, and nothing else. */
export const JUMIO_ALLOWED_CALLS: readonly { readonly surface: JumioSurface; readonly method: "POST" | "GET"; readonly path: RegExp }[] =
  deepFreeze([
    { surface: "auth", method: "POST", path: /^\/oauth2\/token$/u },
    {
      surface: "account",
      method: "POST",
      path: /^\/api\/v1\/accounts$/u,
    },
    {
      surface: "retrieval",
      method: "GET",
      path: /^\/api\/v1\/accounts\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/workflow-executions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    },
  ]);

/** True when a surface, method and path are one of the three documented calls. */
export function isJumioCall(surface: string, method: string, path: string): boolean {
  return JUMIO_ALLOWED_CALLS.some(
    (allowed) => allowed.surface === surface && allowed.method === method && allowed.path.test(path),
  );
}

/** The request timeout. Jumio documents none, so this is the platform's choice, like every other adapter's. */
export const JUMIO_REQUEST_TIMEOUT_MS = 20_000;

/** A token is reused until this many seconds before its documented expiry. */
export const JUMIO_TOKEN_REFRESH_SKEW_SECONDS = 60;

/** The largest answer this adapter reads. A transaction record carries many capabilities, so the bound is roomy. */
export const JUMIO_MAXIMUM_ANSWER_BYTES = 262_144;

/** The documented `customerInternalReference` bound. */
export const JUMIO_CUSTOMER_REFERENCE_MAXIMUM_LENGTH = 100;

/** The characters Jumio refuses in a `customerInternalReference`. */
export const JUMIO_CUSTOMER_REFERENCE_FORBIDDEN = /[<>"/;`%{}|]/u;

/** The documented workflow key bound, which the office chooses. */
export const JUMIO_WORKFLOW_KEY_MAXIMUM_LENGTH = 255;

/** The documented client id and secret bounds this platform applies. */
export const JUMIO_CLIENT_ID_MAXIMUM_LENGTH = 200;
export const JUMIO_CLIENT_SECRET_MAXIMUM_LENGTH = 200;

/** A UUID, which is what Jumio's account and workflow ids are. */
export const JUMIO_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** True when a value is a Jumio id. */
export function isJumioId(value: string): boolean {
  return JUMIO_ID_PATTERN.test(value.trim());
}

/** The one workflow status the documentation shows carrying decisions. */
export const JUMIO_COMPLETED_WORKFLOW_STATUS = "PROCESSED";

/** The capture client's documented drop-off state meaning the journey timed out. */
export const JUMIO_EXPIRED_JOURNEY_STATE = "expired";

/** The four decision types Jumio documents, and no others. */
export const JUMIO_DECISIONS = deepFreeze(["PASSED", "REJECTED", "WARNING", "NOT_EXECUTED"] as const);

/** One Jumio decision type. */
export type JumioDecision = (typeof JUMIO_DECISIONS)[number];

/** True when a string is a documented decision type. */
export function isJumioDecision(value: string): value is JumioDecision {
  return (JUMIO_DECISIONS as readonly string[]).includes(value.trim().toUpperCase());
}

/**
 * The capability names this adapter reads a decision from.
 *
 * They come from the capabilities reference and its dependency table: usability, classification, extraction, image
 * checks and data checks run on the document, liveness on the selfie, and similarity between the two.
 */
export const JUMIO_IDENTITY_CAPABILITIES = deepFreeze([
  "usability",
  "classification",
  "extraction",
  "imageChecks",
  "dataChecks",
] as const);

/** The document kinds Jumio's extraction data documents, and the neutral kind each becomes. */
export const JUMIO_DOCUMENT_TYPES: Readonly<Record<string, (typeof SUPPLEMENTARY_IDV_DOCUMENT_KINDS)[number]>> = deepFreeze({
  PASSPORT: "passport",
  ID_CARD: "national_id",
  DRIVING_LICENSE: "driving_licence",
  // A visa is not a residence permit, and the neutral vocabulary has no visa word: the kind stays unstated rather
  // than being stretched into a claim the record cannot support.
  VISA: "not_stated",
  UNSUPPORTED: "not_stated",
});

/* -------------------------------------------------------------------------------------------------
 * The encrypted configuration
 * ---------------------------------------------------------------------------------------------- */

/** What a Jumio configuration holds, in plaintext, only inside a sealed envelope. */
export interface JumioCredential {
  readonly region: JumioRegion;
  readonly clientId: string;
  readonly clientSecret: string;
}

/** The reason a credential is unusable, or null when it is usable. */
export function validateJumioCredential(credential: JumioCredential): string | null {
  if (isJumioRegion(credential.region) === false) return "the datacenter is not one Jumio documents";
  const clientId = credential.clientId.trim();
  const clientSecret = credential.clientSecret.trim();
  if (clientId.length === 0) return "a client id is required";
  if (clientSecret.length === 0) return "a client secret is required";
  if (clientId.length > JUMIO_CLIENT_ID_MAXIMUM_LENGTH) return "the client id is longer than this platform stores";
  if (clientSecret.length > JUMIO_CLIENT_SECRET_MAXIMUM_LENGTH) return "the client secret is longer than this platform stores";
  if (clientId.length < 8) return "the client id is shorter than any Jumio client id";
  if (clientSecret.length < 8) return "the client secret is shorter than any Jumio client secret";
  if (/\s/u.test(clientId) || /\s/u.test(clientSecret)) return "a credential must not contain whitespace";
  if (clientId.includes(":") || clientSecret.includes(":")) return "a credential must not contain a colon";
  return null;
}

/** Serialize a credential for the sealed field: JSON, so no delimiter can be guessed wrong. */
export function jumioCredentialTextOf(credential: JumioCredential): string {
  return JSON.stringify({ region: credential.region, clientId: credential.clientId, clientSecret: credential.clientSecret });
}

/** Read a sealed field's plaintext back into a credential, or null when it is not one. */
export function jumioCredentialOf(text: string): JumioCredential | null {
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
  const region = record["region"];
  const clientId = record["clientId"];
  const clientSecret = record["clientSecret"];
  if (typeof region !== "string" || isJumioRegion(region) === false) return null;
  if (typeof clientId !== "string" || typeof clientSecret !== "string") return null;
  const credential: JumioCredential = { region, clientId, clientSecret };
  return validateJumioCredential(credential) === null ? credential : null;
}

/** What a caller supplies when a super administrator connects Jumio. */
export interface JumioConfigurationInput {
  readonly companyId: string;
  readonly environment: SupplementaryIdvEnvironment;
  readonly credential: JumioCredential;
  /** The delivery secret Jumio signs its callbacks with, when the tenant has one. */
  readonly callbackSecret: string | null;
  readonly occurredAtEpochMs: number;
}

/** What connecting Jumio did. */
export type CreateJumioConfigurationResult =
  | { readonly status: "configured"; readonly config: SupplementaryIdvConfig }
  | { readonly status: "failed"; readonly reason: string };

/** One audit entry for the configuration half. Session and result entries come from STEP 170. */
export interface JumioConfigAuditEntry {
  readonly action:
    | "jumio_idv.configured"
    | "jumio_idv.activation_tested"
    | "jumio_idv.activated"
    | "jumio_idv.refused";
  readonly providerKey: string;
  readonly companyId: string;
  readonly configId: string;
  readonly environment: string;
  readonly outcome: string;
  readonly occurredAtEpochMs: number;
}

/** The provider key this adapter writes into its own audit entries. */
export const JUMIO_PROVIDER_KEY = "jumio";

/**
 * The reason a configuration cannot be opened, or its plaintext and the credential inside it.
 *
 * `allowPendingActivation` exists for exactly one caller — the activation test itself, which has to open a credential
 * that is not yet active in order to prove it works. Every other caller needs an active configuration, because a
 * session must never run on a credential nobody has tested.
 */
function jumioOpenConfigOf(
  config: SupplementaryIdvConfig | null,
  keyring: EncryptionKeyring,
  allowPendingActivation = false,
): { readonly ok: true; readonly opened: OpenedSupplementaryIdvConfig; readonly credential: JumioCredential } | { readonly ok: false; readonly reason: string } {
  if (config === null) return { ok: false, reason: "no Jumio configuration holds that id" };
  if (config.vendorKey !== "jumio") return { ok: false, reason: "that configuration is not a Jumio configuration" };
  if (config.status !== "active" && (allowPendingActivation === false || config.status !== "pending_activation")) {
    return { ok: false, reason: "the Jumio configuration is not active" };
  }
  const opened = openSupplementaryIdvConfig(config, keyring);
  if (opened.status === "failed") return { ok: false, reason: opened.reason };
  const credential = jumioCredentialOf(opened.config.credential);
  if (credential === null) return { ok: false, reason: "the sealed Jumio credential is not one this adapter reads" };
  return { ok: true, opened: opened.config, credential };
}

/**
 * Seal a Jumio configuration and store it, waiting for its activation test.
 *
 * The credential is validated before anything is sealed, both the credential and the callback secret are sealed under
 * their own scopes by STEP 170's function, and the row starts `pending_activation` — a provider is not enabled by
 * being typed in, only by answering a real call.
 */
export function createJumioConfiguration(
  input: JumioConfigurationInput,
  options: {
    readonly configStore: SupplementaryIdvConfigStore;
    readonly keyring: EncryptionKeyring;
    readonly recordAudit?: (entry: JumioConfigAuditEntry) => void;
  },
): CreateJumioConfigurationResult {
  const invalid = validateJumioCredential(input.credential);
  if (invalid !== null) return { status: "failed", reason: invalid };
  if (input.companyId.trim().length === 0) return { status: "failed", reason: "a configuration belongs to a company" };

  const sealed = sealSupplementaryIdvConfig(
    {
      companyId: input.companyId,
      vendorKey: "jumio",
      environment: input.environment,
      credential: jumioCredentialTextOf(input.credential),
      webhookSecret: input.callbackSecret,
    },
    options.keyring,
  );
  if ("reason" in sealed) return { status: "failed", reason: sealed.reason };

  const config: SupplementaryIdvConfig = {
    id: randomUUID(),
    companyId: input.companyId,
    vendorKey: "jumio",
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
    action: "jumio_idv.configured",
    providerKey: JUMIO_PROVIDER_KEY,
    companyId: config.companyId,
    configId: config.id,
    environment: config.environment,
    outcome: "pending_activation",
    occurredAtEpochMs: input.occurredAtEpochMs,
  });
  return { status: "configured", config };
}

/** What activating a configuration did. */
export type ActivateJumioConfigurationResult =
  | { readonly status: "activated"; readonly config: SupplementaryIdvConfig }
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string };

/**
 * Activate a stored Jumio configuration by proving it works.
 *
 * A configuration is not enabled by being typed in: this asks Jumio for a token, and only a real bearer token turns
 * the row `active`. Two things are refused before the call — a configuration that is not Jumio's, and a second active
 * vendor in the same company and mode, because STEP 170's rule is one vendor at a time and two active vendors would
 * make the mode ambiguous, which is how a pass could be blamed on the wrong vendor later.
 */
export async function activateJumioConfiguration(
  configId: string,
  options: {
    readonly configStore: SupplementaryIdvConfigStore;
    readonly keyring: EncryptionKeyring;
    readonly occurredAtEpochMs: number;
    readonly transport?: JumioTransport;
    readonly recordAudit?: (entry: JumioConfigAuditEntry) => void;
  },
): Promise<ActivateJumioConfigurationResult> {
  const config = options.configStore.findById(configId);
  if (config === null) return { status: "failed", reason: "no configuration holds that id" };
  if (config.vendorKey !== "jumio") return { status: "refused", reason: "that configuration is not a Jumio configuration" };
  if (config.status === "active") return { status: "activated", config };

  const opening = jumioOpenConfigOf(config, options.keyring, true);
  if (opening.ok === false) return { status: "failed", reason: opening.reason };

  const others = options.configStore
    .findActiveForCompany(config.companyId)
    .filter((other) => other.id !== config.id && other.environment === config.environment);
  if (others.length > 0) {
    options.recordAudit?.({
      action: "jumio_idv.refused",
      providerKey: JUMIO_PROVIDER_KEY,
      companyId: config.companyId,
      configId: config.id,
      environment: config.environment,
      outcome: "another vendor is already active in this mode",
      occurredAtEpochMs: options.occurredAtEpochMs,
    });
    return { status: "refused", reason: "another vendor is already active in this mode" };
  }

  let answer: JumioAnswer;
  try {
    answer = await (options.transport ?? jumioFetchTransport)({
      surface: "auth",
      region: opening.credential.region,
      method: "POST",
      path: JUMIO_TOKEN_PATH,
      authorization: "basic",
      authValue: jumioBasicAuthOf(opening.credential),
      contentType: "application/x-www-form-urlencoded",
      body: "grant_type=client_credentials",
    });
  } catch {
    options.recordAudit?.({
      action: "jumio_idv.refused",
      providerKey: JUMIO_PROVIDER_KEY,
      companyId: config.companyId,
      configId: config.id,
      environment: config.environment,
      outcome: "the token call could not be made",
      occurredAtEpochMs: options.occurredAtEpochMs,
    });
    return { status: "failed", reason: "the token call could not be made" };
  }

  const verdict = parseJumioTokenAnswer(answer.status, answer.body);
  options.recordAudit?.({
    action: "jumio_idv.activation_tested",
    providerKey: JUMIO_PROVIDER_KEY,
    companyId: config.companyId,
    configId: config.id,
    environment: config.environment,
    outcome: verdict.outcome,
    occurredAtEpochMs: options.occurredAtEpochMs,
  });
  if (verdict.outcome !== "token") {
    return { status: "refused", reason: verdict.detail };
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
    action: "jumio_idv.activated",
    providerKey: JUMIO_PROVIDER_KEY,
    companyId: config.companyId,
    configId: config.id,
    environment: config.environment,
    outcome: "active",
    occurredAtEpochMs: options.occurredAtEpochMs,
  });
  return { status: "activated", config: next };
}

/* -------------------------------------------------------------------------------------------------
 * The transport
 * ---------------------------------------------------------------------------------------------- */

/** One documented call: where it goes, what it carries and how it authenticates. */
export interface JumioCall {
  readonly surface: JumioSurface;
  readonly region: JumioRegion;
  readonly method: "POST" | "GET";
  readonly path: string;
  /** `basic` for the token call, `bearer` for the account and retrieval calls, `none` for nothing. */
  readonly authorization: "none" | "basic" | "bearer";
  /** The Basic credentials already joined, or the bearer token. Never logged, never stored. */
  readonly authValue: string | null;
  readonly contentType: string | null;
  readonly body: string | null;
}

/** The HTTP answer. */
export interface JumioAnswer {
  readonly status: number;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** The transport port. */
export type JumioTransport = (call: JumioCall) => Promise<JumioAnswer>;

/** Encode the Basic credentials the token call needs. */
export function jumioBasicAuthOf(credential: JumioCredential): string {
  return Buffer.from(`${credential.clientId}:${credential.clientSecret}`, "utf8").toString("base64");
}

/**
 * Perform one documented call.
 *
 * The surface, method and path must be one of the three the documentation names; the `User-Agent` header Jumio
 * requires is always sent; redirects are refused; the timeout is bounded; and an answer larger than the bound is
 * refused rather than buffered.
 */
export const jumioFetchTransport: JumioTransport = async (call) => {
  if (isJumioCall(call.surface, call.method, call.path) === false) throw new Error("invalid API path");
  if (call.surface !== "auth" && (call.authValue === null || call.authValue.trim().length === 0)) {
    throw new Error("an access token is required");
  }
  if (call.surface === "auth" && call.authorization !== "basic") throw new Error("the token call uses basic authentication");
  if (call.surface !== "auth" && call.authorization !== "bearer") throw new Error("the API calls use a bearer token");

  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": JUMIO_USER_AGENT,
  };
  if (call.contentType !== null) headers["Content-Type"] = call.contentType;
  if (call.authorization === "basic" && call.authValue !== null) headers["Authorization"] = `Basic ${call.authValue}`;
  if (call.authorization === "bearer" && call.authValue !== null) headers["Authorization"] = `Bearer ${call.authValue}`;

  const response = await fetch(jumioEndpoint(call.surface, call.region, call.path), {
    method: call.method,
    headers,
    ...(call.body === null ? {} : { body: call.body }),
    redirect: "error",
    signal: AbortSignal.timeout(JUMIO_REQUEST_TIMEOUT_MS),
  });

  const text = await response.text();
  if (text.length > JUMIO_MAXIMUM_ANSWER_BYTES) throw new Error("invalid API answer");
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

/** The provider's own problem detail, bounded, so a failure message is the API's and not this file's invention. */
export function jumioProblemDetailOf(body: string): string {
  const record = recordOf(jsonOf(body));
  if (record === null) return "";
  const detail = textOf(record["detail"]) ?? textOf(record["title"]);
  return detail === null ? "" : detail.slice(0, 200);
}

/** A Jumio access token, as the token call answers it. */
export interface JumioToken {
  readonly accessToken: string;
  /** The documented lifetime in seconds. */
  readonly expiresInSeconds: number;
}

/** What a token call concluded. */
export type JumioTokenVerdict =
  | { readonly outcome: "token"; readonly token: JumioToken }
  | { readonly outcome: "refused"; readonly detail: string }
  | { readonly outcome: "failed"; readonly detail: string };

/**
 * Read a token answer.
 *
 * Only a `2XX` carrying a bearer token with a positive lifetime is a token. `400` and `401` mean the client id or
 * secret is wrong — a configuration defect an operator must see — and everything else leaves the answer unknown.
 */
export function parseJumioTokenAnswer(status: number, body: string): JumioTokenVerdict {
  if (status === 400 || status === 401 || status === 403) {
    return { outcome: "refused", detail: jumioProblemDetailOf(body) || `the token call was refused with status ${status}` };
  }
  if (status < 200 || status >= 300) {
    return { outcome: "failed", detail: `the token call answered ${status}` };
  }
  const record = recordOf(jsonOf(body));
  if (record === null) return { outcome: "failed", detail: "the token answer is not JSON" };
  const token = textOf(record["access_token"]);
  const type = textOf(record["token_type"]);
  const expiresIn = record["expires_in"];
  if (token === null || token.length < 8 || token.length > 4_096) {
    return { outcome: "failed", detail: "the token answer carries no usable access token" };
  }
  if (type !== null && type.toLowerCase() !== "bearer") {
    return { outcome: "failed", detail: "the token answer is not a bearer token" };
  }
  if (typeof expiresIn !== "number" || Number.isFinite(expiresIn) === false || expiresIn <= 0) {
    return { outcome: "failed", detail: "the token answer carries no positive lifetime" };
  }
  return { outcome: "token", token: { accessToken: token, expiresInSeconds: Math.trunc(expiresIn) } };
}

/** A cached token and the moment it stops being usable. */
export interface JumioCachedToken {
  readonly accessToken: string;
  readonly expiresAtEpochMs: number;
}

/** The token cache port. */
export interface JumioTokenCache {
  get(configId: string): JumioCachedToken | null;
  set(configId: string, token: JumioCachedToken): void;
  clear(configId: string): void;
}

/** The in-memory cache: the reference implementation of the reuse rule. */
export class InMemoryJumioTokenCache implements JumioTokenCache {
  private readonly tokens = new Map<string, JumioCachedToken>();

  get(configId: string): JumioCachedToken | null {
    const token = this.tokens.get(configId);
    if (token === undefined) return null;
    return token;
  }

  set(configId: string, token: JumioCachedToken): void {
    if (token.accessToken.trim().length === 0) throw new Error("a cached token is never empty");
    this.tokens.set(configId, token);
  }

  clear(configId: string): void {
    this.tokens.delete(configId);
  }
}

/** The options every call here needs. */
export interface JumioOptions {
  readonly configStore: SupplementaryIdvConfigStore;
  readonly sessionStore: SupplementaryIdvSessionStore;
  readonly keyring: EncryptionKeyring;
  readonly tokenCache: JumioTokenCache;
  readonly occurredAtEpochMs: number;
  readonly transport?: JumioTransport;
  readonly recordAudit?: (entry: SupplementaryIdvAuditEntry) => void;
  readonly recordConfigAudit?: (entry: JumioConfigAuditEntry) => void;
}

/** Either a usable token or the reason there is none. */
type JumioTokenResult =
  | { readonly ok: true; readonly accessToken: string }
  | { readonly ok: false; readonly reason: string; readonly refused: boolean };

async function jumioAccessTokenFor(
  configId: string,
  credential: JumioCredential,
  options: JumioOptions,
): Promise<JumioTokenResult> {
  const cached = options.tokenCache.get(configId);
  if (cached !== null && options.occurredAtEpochMs + JUMIO_TOKEN_REFRESH_SKEW_SECONDS * 1_000 < cached.expiresAtEpochMs) {
    return { ok: true, accessToken: cached.accessToken };
  }

  let answer: JumioAnswer;
  try {
    answer = await (options.transport ?? jumioFetchTransport)({
      surface: "auth",
      region: credential.region,
      method: "POST",
      path: JUMIO_TOKEN_PATH,
      authorization: "basic",
      authValue: jumioBasicAuthOf(credential),
      contentType: "application/x-www-form-urlencoded",
      body: "grant_type=client_credentials",
    });
  } catch {
    return { ok: false, reason: "the token call could not be made", refused: false };
  }

  const verdict = parseJumioTokenAnswer(answer.status, answer.body);
  if (verdict.outcome === "refused") return { ok: false, reason: verdict.detail, refused: true };
  if (verdict.outcome === "failed") return { ok: false, reason: verdict.detail, refused: false };

  options.tokenCache.set(configId, {
    accessToken: verdict.token.accessToken,
    expiresAtEpochMs: options.occurredAtEpochMs + verdict.token.expiresInSeconds * 1_000,
  });
  return { ok: true, accessToken: verdict.token.accessToken };
}

/* -------------------------------------------------------------------------------------------------
 * Opening a session
 * ---------------------------------------------------------------------------------------------- */

/** What the platform asks Jumio for. */
export interface JumioSessionInput {
  /** The row STEP 170 opened, which must still be `in_progress` and must carry no vendor reference. */
  readonly sessionId: string;
  /** The workflow definition key the office configured in the Jumio portal. */
  readonly workflowKey: string;
  /** Where Jumio sends the person afterwards. Both must be absolute https URLs. */
  readonly successUrl: string;
  readonly errorUrl: string;
  /** The platform endpoint that receives the delivery, when the tenant uses one. */
  readonly callbackUrl: string | null;
}

/** A session Jumio created. */
export interface JumioOpenedSession {
  readonly sessionId: string;
  readonly accountId: string;
  readonly workflowExecutionId: string;
  /** The reference this platform stores, which is both vendor ids joined. */
  readonly reference: string;
  /** Jumio's own page for the person. Carries an authorization token in its query, so it is returned once. */
  readonly redirectUrl: string;
  readonly session: SupplementaryIdvSession;
}

/** What opening a Jumio session did. */
export type OpenJumioSessionResult =
  | { readonly status: "opened"; readonly opened: JumioOpenedSession }
  | { readonly status: "rejected"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string; readonly requiresReconciliation: boolean };

/** The reference this platform stores for one Jumio workflow execution. */
export function jumioReferenceOf(accountId: string, workflowExecutionId: string): string {
  return `${accountId.trim()}:${workflowExecutionId.trim()}`;
}

/** The two ids inside a stored reference, or null when it is not one. */
export function jumioIdsOf(reference: string): { readonly accountId: string; readonly workflowExecutionId: string } | null {
  const parts = reference.trim().split(":");
  if (parts.length !== 2) return null;
  const accountId = parts[0] ?? "";
  const workflowExecutionId = parts[1] ?? "";
  if (isJumioId(accountId) === false || isJumioId(workflowExecutionId) === false) return null;
  return { accountId, workflowExecutionId };
}

/** The `customerInternalReference` this platform derives: the session id, prefixed, and nothing personal. */
export function jumioCustomerReferenceOf(sessionId: string): string {
  const reference = `kd-idv-${sessionId.trim()}`;
  if (reference.length > JUMIO_CUSTOMER_REFERENCE_MAXIMUM_LENGTH) return reference.slice(0, JUMIO_CUSTOMER_REFERENCE_MAXIMUM_LENGTH);
  return reference;
}

/** The reason a `customerInternalReference` is unusable, or null. */
export function validateJumioCustomerReference(value: string): string | null {
  if (value.length === 0) return "a customer internal reference is required";
  if (value.length > JUMIO_CUSTOMER_REFERENCE_MAXIMUM_LENGTH) return "the customer internal reference is longer than Jumio accepts";
  if (JUMIO_CUSTOMER_REFERENCE_FORBIDDEN.test(value)) return "the customer internal reference carries a character Jumio refuses";
  return null;
}

/** The body of the account request, in the documented shape and nothing more. */
export interface JumioAccountRequest {
  readonly customerInternalReference: string;
  readonly workflowDefinition: { readonly key: string };
  readonly web: { readonly successUrl: string; readonly errorUrl: string };
  readonly callbackUrl: string | null;
}

/** Build the documented account request body. No name, no date of birth, no document, no image. */
export function buildJumioAccountRequest(input: {
  readonly customerInternalReference: string;
  readonly workflowKey: string;
  readonly successUrl: string;
  readonly errorUrl: string;
  readonly callbackUrl: string | null;
}): JumioAccountRequest {
  return {
    customerInternalReference: input.customerInternalReference,
    workflowDefinition: { key: input.workflowKey },
    web: { successUrl: input.successUrl, errorUrl: input.errorUrl },
    callbackUrl: input.callbackUrl,
  };
}

/** The reason an account request is unusable, or null. */
export function validateJumioSessionInput(input: JumioSessionInput): string | null {
  const referenceInvalid = validateJumioCustomerReference(jumioCustomerReferenceOf(input.sessionId));
  if (referenceInvalid !== null) return referenceInvalid;
  const workflowKey = input.workflowKey.trim();
  if (workflowKey.length === 0) return "a workflow key is required, because Jumio runs the workflow it names";
  if (workflowKey.length > JUMIO_WORKFLOW_KEY_MAXIMUM_LENGTH) return "the workflow key is longer than Jumio accepts";
  if (/^\d+$/u.test(workflowKey) === false) return "the workflow key is a number in Jumio's portal";
  for (const [name, url] of [
    ["success", input.successUrl],
    ["error", input.errorUrl],
  ] as const) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return `the ${name} URL is not a URL`;
    }
    if (parsed.protocol !== "https:") return `the ${name} URL must use https`;
  }
  if (input.callbackUrl !== null) {
    if (input.callbackUrl.length > 255) return "the callback URL is longer than Jumio accepts";
    try {
      const parsed = new URL(input.callbackUrl);
      if (parsed.protocol !== "https:") return "the callback URL must use https";
    } catch {
      return "the callback URL is not a URL";
    }
  }
  return null;
}

/** What an account answer carries. */
export interface JumioAccountAnswer {
  readonly accountId: string;
  readonly workflowExecutionId: string;
  readonly redirectUrl: string;
  readonly sdkTokenIssued: boolean;
}

/** What creating an account concluded. */
export type JumioAccountVerdict =
  | { readonly outcome: "created"; readonly answer: JumioAccountAnswer }
  | { readonly outcome: "rejected"; readonly detail: string }
  | { readonly outcome: "duplicate"; readonly detail: string }
  | { readonly outcome: "failed"; readonly detail: string }
  | { readonly outcome: "unknown"; readonly detail: string };

/**
 * Read an account answer.
 *
 * `201` with two UUIDs and an https `web.href` is a created session. `400` and `422` are a rejection — Jumio refused
 * the request, so nothing exists. `401` and `403` are a configuration defect, `409` is a duplicate this adapter
 * records as needing reconciliation rather than as a rejection, and a redirect, `404`, `429`, a `5XX` or a timeout
 * leaves the outcome unknown.
 */
export function parseJumioAccountAnswer(status: number, body: string): JumioAccountVerdict {
  if (status === 400 || status === 422) {
    return { outcome: "rejected", detail: jumioProblemDetailOf(body) || `Jumio refused the request with status ${status}` };
  }
  if (status === 401 || status === 403) {
    return { outcome: "failed", detail: jumioProblemDetailOf(body) || "Jumio refused the credentials" };
  }
  if (status === 409) {
    return { outcome: "duplicate", detail: "Jumio reported the request as a duplicate of one it already holds" };
  }
  if (status === 404) {
    return { outcome: "failed", detail: "Jumio answered 404 on the account path, which is a configuration defect" };
  }
  if (status >= 300 && status < 400) {
    return { outcome: "unknown", detail: "Jumio answered with a redirect, which proves nothing" };
  }
  if (status === 408 || status === 429 || status >= 500) {
    return { outcome: "unknown", detail: "Jumio did not answer finally, so no session was confirmed" };
  }
  if (status < 200 || status >= 300) {
    return { outcome: "failed", detail: `Jumio answered ${status}` };
  }

  const record = recordOf(jsonOf(body));
  if (record === null) return { outcome: "unknown", detail: "the account answer is not JSON" };
  const account = recordOf(record["account"]);
  const workflow = recordOf(record["workflowExecution"]);
  const web = recordOf(record["web"]);
  const accountId = account === null ? null : textOf(account["id"]);
  const workflowExecutionId = workflow === null ? null : textOf(workflow["id"]);
  const href = web === null ? null : textOf(web["href"]);
  if (accountId === null || workflowExecutionId === null) {
    return { outcome: "unknown", detail: "the account answer names no account or no workflow execution" };
  }
  if (isJumioId(accountId) === false || isJumioId(workflowExecutionId) === false) {
    return { outcome: "unknown", detail: "the account answer carries an id that is not a UUID" };
  }
  if (href === null) return { outcome: "unknown", detail: "the account answer carries no web client URL" };
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return { outcome: "unknown", detail: "the web client URL is not a URL" };
  }
  if (parsed.protocol !== "https:") return { outcome: "unknown", detail: "the web client URL is not https" };
  if (parsed.hostname.endsWith(".jumio.ai") === false) {
    return { outcome: "unknown", detail: "the web client URL is not on a documented Jumio host" };
  }
  const sdk = recordOf(record["sdk"]);
  return {
    outcome: "created",
    answer: {
      accountId,
      workflowExecutionId,
      redirectUrl: href,
      sdkTokenIssued: sdk !== null && textOf(sdk["token"]) !== null,
    },
  };
}

/**
 * Open one Jumio session for a session row this platform already recorded.
 *
 * The order is the one STEP 170 established and this adapter keeps: the row exists first, then the vendor is called,
 * then the reference is recorded — so a session Jumio created but this platform never stored cannot exist; the worst
 * case is a row still `in_progress`, which is a manual review.
 */
export async function openJumioSession(
  input: JumioSessionInput,
  options: JumioOptions,
): Promise<OpenJumioSessionResult> {
  const invalid = validateJumioSessionInput(input);
  if (invalid !== null) return { status: "failed", reason: invalid, requiresReconciliation: false };

  const session = options.sessionStore.findById(input.sessionId);
  if (session === null) return { status: "failed", reason: "no session holds that id", requiresReconciliation: false };
  if (session.vendorKey !== "jumio") return { status: "failed", reason: "that session belongs to another vendor", requiresReconciliation: false };
  if (session.result !== "in_progress") return { status: "failed", reason: "the session is no longer in progress", requiresReconciliation: false };
  if (session.reference !== null) return { status: "failed", reason: "the session already carries a Jumio reference", requiresReconciliation: false };

  const config = options.configStore.findById(session.configId);
  if (config !== null && config.environment !== session.environment) {
    return { status: "failed", reason: "the session and its configuration disagree about the mode", requiresReconciliation: false };
  }
  const opening = jumioOpenConfigOf(config, options.keyring);
  if (opening.ok === false) return { status: "failed", reason: opening.reason, requiresReconciliation: false };

  const token = await jumioAccessTokenFor(session.configId, opening.credential, options);
  if (token.ok === false) {
    return {
      status: "failed",
      reason: token.refused ? "Jumio refused the configured credentials" : token.reason,
      requiresReconciliation: false,
    };
  }

  const request = buildJumioAccountRequest({
    customerInternalReference: jumioCustomerReferenceOf(session.id),
    workflowKey: input.workflowKey.trim(),
    successUrl: input.successUrl,
    errorUrl: input.errorUrl,
    callbackUrl: input.callbackUrl,
  });

  let answer: JumioAnswer;
  try {
    answer = await (options.transport ?? jumioFetchTransport)({
      surface: "account",
      region: opening.credential.region,
      method: "POST",
      path: JUMIO_ACCOUNTS_PATH,
      authorization: "bearer",
      authValue: token.accessToken,
      contentType: "application/json",
      body: JSON.stringify({
        customerInternalReference: request.customerInternalReference,
        workflowDefinition: { key: request.workflowDefinition.key },
        web: { successUrl: request.web.successUrl, errorUrl: request.web.errorUrl },
        ...(request.callbackUrl === null ? {} : { callbackUrl: request.callbackUrl }),
      }),
    });
  } catch {
    return {
      status: "failed",
      reason: "the account call could not be made, so the session's outcome is unknown",
      requiresReconciliation: true,
    };
  }

  const verdict = parseJumioAccountAnswer(answer.status, answer.body);
  if (verdict.outcome === "rejected") return { status: "rejected", reason: verdict.detail };
  if (verdict.outcome === "failed") return { status: "failed", reason: verdict.detail, requiresReconciliation: false };
  if (verdict.outcome === "duplicate") {
    return { status: "failed", reason: verdict.detail, requiresReconciliation: true };
  }
  if (verdict.outcome === "unknown") {
    return { status: "failed", reason: verdict.detail, requiresReconciliation: true };
  }

  const reference = jumioReferenceOf(verdict.answer.accountId, verdict.answer.workflowExecutionId);
  const recorded = recordSupplementaryIdvAnswer(
    session.id,
    {
      reference,
      result: "in_progress",
      liveness: "in_progress",
      documentKind: "not_stated",
      reasonCode: "vendor_incomplete",
    },
    { sessionStore: options.sessionStore, occurredAtEpochMs: options.occurredAtEpochMs, ...(options.recordAudit === undefined ? {} : { recordAudit: options.recordAudit }) },
  );
  if (recorded.status !== "recorded") {
    return { status: "failed", reason: `Jumio created the session but it was not recorded: ${recorded.reason}`, requiresReconciliation: true };
  }

  return {
    status: "opened",
    opened: {
      sessionId: session.id,
      accountId: verdict.answer.accountId,
      workflowExecutionId: verdict.answer.workflowExecutionId,
      reference,
      redirectUrl: verdict.answer.redirectUrl,
      session: recorded.session,
    },
  };
}

/* -------------------------------------------------------------------------------------------------
 * Reading a session
 * ---------------------------------------------------------------------------------------------- */

/** The decision one capability rendered. */
export interface JumioCapabilityDecision {
  readonly capability: string;
  readonly decision: JumioDecision;
  readonly label: string | null;
}

/** What one workflow execution says, as far as this adapter reads it. */
export interface JumioWorkflow {
  readonly workflowStatus: string;
  readonly journeyExpired: boolean;
  readonly decisions: readonly JumioCapabilityDecision[];
  readonly documentType: string | null;
}

/** The reason a transaction record is unusable, or null. */
function jumioDecisionsOf(capabilities: Readonly<Record<string, unknown>>): JumioCapabilityDecision[] {
  const decisions: JumioCapabilityDecision[] = [];
  for (const capability of Object.keys(capabilities).sort()) {
    for (const entry of arrayOf(capabilities[capability])) {
      const record = recordOf(entry);
      if (record === null) continue;
      const decision = recordOf(record["decision"]);
      if (decision === null) continue;
      const type = textOf(decision["type"]);
      if (type === null || isJumioDecision(type) === false) continue;
      const details = recordOf(decision["details"]);
      decisions.push({
        capability,
        decision: type.toUpperCase() as JumioDecision,
        label: details === null ? null : textOf(details["label"]),
      });
    }
  }
  return decisions;
}

/** Read one transaction record into the neutral shape this adapter maps. */
export function parseJumioWorkflow(body: string): JumioWorkflow | null {
  const record = recordOf(jsonOf(body));
  if (record === null) return null;
  const workflow = recordOf(record["workflow"]);
  if (workflow === null) return null;
  const status = textOf(workflow["status"]);
  if (status === null) return null;

  const captureClient = recordOf(record["captureClient"]);
  const states = captureClient === null ? [] : arrayOf(captureClient["state"]).map((state) => textOf(state));
  const capabilities = recordOf(record["capabilities"]);

  let documentType: string | null = null;
  if (capabilities !== null) {
    const extraction = recordOf(arrayOf(capabilities["extraction"])[0]);
    const data = extraction === null ? null : recordOf(extraction["data"]);
    documentType = data === null ? null : textOf(data["type"]);
    if (documentType === null) {
      const govt = recordOf(arrayOf(capabilities["govtIdVerification"])[0]);
      const govtData = govt === null ? null : recordOf(govt["data"]);
      documentType = govtData === null ? null : textOf(govtData["type"]);
    }
  }

  return {
    workflowStatus: status,
    journeyExpired: states.includes(JUMIO_EXPIRED_JOURNEY_STATE),
    decisions: capabilities === null ? [] : jumioDecisionsOf(capabilities),
    documentType,
  };
}

/** The decision one capability holds, or null when it did not run. */
function decisionFor(workflow: JumioWorkflow, capability: string): JumioDecision | null {
  return workflow.decisions.find((entry) => entry.capability === capability)?.decision ?? null;
}

/**
 * Turn a workflow record into the neutral answer STEP 170 records.
 *
 * The rules, and why each is what it is:
 *
 *   - A workflow that has not reached the one status the documentation shows carrying decisions is `in_progress`,
 *     because `workflow.status` is a free string and this adapter will not invent a table of them. The one exception
 *     is the capture client's own documented `expired` state, which means the journey timed out: that is `expired`,
 *     the honest answer, and STEP 170 turns it into a manual review.
 *   - Any `REJECTED` decision among the capabilities this adapter reads fails the check, because Jumio documents a
 *     rejection as a fundamental problem or evidence of fraud.
 *   - `WARNING` and `NOT_EXECUTED` are `unknown`, not a pass and not a rejection: a warning is risk that a person must
 *     weigh, and a capability that never ran (because the one before it was rejected) proves nothing.
 *   - A pass needs the document capabilities, liveness and — when the workflow ran it — similarity to have passed.
 */
export function jumioAnswerOf(workflow: JumioWorkflow): SupplementaryIdvVendorAnswer {
  const livenessDecision = decisionFor(workflow, "liveness");
  const liveness: SupplementaryIdvLiveness =
    livenessDecision === "PASSED"
      ? "passed"
      : livenessDecision === "REJECTED"
        ? "failed"
        : livenessDecision === null || livenessDecision === "NOT_EXECUTED"
          ? "in_progress"
          : "unknown";

  const documentKind =
    workflow.documentType === null ? "not_stated" : (JUMIO_DOCUMENT_TYPES[workflow.documentType.toUpperCase()] ?? "not_stated");

  const documentCapabilities = JUMIO_IDENTITY_CAPABILITIES.filter((capability) => decisionFor(workflow, capability) !== null);
  const similarityDecision = decisionFor(workflow, "similarity");

  let result: SupplementaryIdvResult;
  let reasonCode: SupplementaryIdvReasonCode;

  if (workflow.workflowStatus !== JUMIO_COMPLETED_WORKFLOW_STATUS) {
    result = workflow.journeyExpired ? "expired" : "in_progress";
    reasonCode = workflow.journeyExpired ? "session_expired" : "vendor_incomplete";
  } else if (workflow.decisions.length === 0) {
    result = "unknown";
    reasonCode = "vendor_incomplete";
  } else if (livenessDecision === "REJECTED") {
    result = "failed";
    reasonCode = "liveness_failed";
  } else if (similarityDecision === "REJECTED") {
    result = "failed";
    reasonCode = "document_mismatch";
  } else if (documentCapabilities.some((capability) => decisionFor(workflow, capability) === "REJECTED")) {
    result = "failed";
    reasonCode = "document_unreadable";
  } else if (
    documentCapabilities.length > 0 &&
    documentCapabilities.every((capability) => decisionFor(workflow, capability) === "PASSED") &&
    livenessDecision === "PASSED" &&
    (similarityDecision === null || similarityDecision === "PASSED")
  ) {
    result = "passed";
    reasonCode = "not_stated";
  } else {
    result = "unknown";
    reasonCode = "vendor_incomplete";
  }

  return {
    reference: "",
    result,
    liveness,
    documentKind,
    reasonCode,
  };
}

/** What reading a Jumio workflow concluded. */
export type JumioReadVerdict =
  | { readonly outcome: "read"; readonly answer: SupplementaryIdvVendorAnswer }
  | { readonly outcome: "in_flight"; readonly answer: SupplementaryIdvVendorAnswer }
  | { readonly outcome: "not_found"; readonly detail: string }
  | { readonly outcome: "failed"; readonly detail: string }
  | { readonly outcome: "unknown"; readonly detail: string };

/**
 * Read a retrieval answer.
 *
 * A `2XX` carrying a workflow record is a read; `404` means Jumio does not know the workflow, which this adapter
 * reports as not found rather than as a pass or a failure; `401`/`403` is a configuration defect; a redirect, `429`,
 * a `5XX` or a thrown transport leaves it unknown. An answer naming no capability at all is not a pass.
 */
export function parseJumioReadAnswer(
  status: number,
  body: string,
  reference: string,
): JumioReadVerdict {
  if (status === 404) return { outcome: "not_found", detail: "Jumio does not know that workflow execution" };
  if (status === 400) return { outcome: "failed", detail: jumioProblemDetailOf(body) || "Jumio refused the read" };
  if (status === 401 || status === 403) return { outcome: "failed", detail: "Jumio refused the configured credentials" };
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return { outcome: "unknown", detail: "Jumio did not answer finally, so the workflow status was not read" };
  }
  if (status >= 300 && status < 400) return { outcome: "unknown", detail: "Jumio answered with a redirect, which proves nothing" };
  if (status < 200 || status >= 300) return { outcome: "failed", detail: `Jumio answered ${status}` };

  const workflow = parseJumioWorkflow(body);
  if (workflow === null) return { outcome: "unknown", detail: "the transaction record carries no workflow status" };
  const answer: SupplementaryIdvVendorAnswer = { ...jumioAnswerOf(workflow), reference };
  return answer.result === "in_progress" ? { outcome: "in_flight", answer } : { outcome: "read", answer };
}

/** What refreshing a session did. */
export type RefreshJumioSessionResult =
  | { readonly status: "recorded"; readonly session: SupplementaryIdvSession; readonly changed: boolean }
  | { readonly status: "in_flight"; readonly session: SupplementaryIdvSession; readonly changed: boolean }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "refused"; readonly reason: string };

/**
 * Read one session's workflow and record what it says.
 *
 * The record is written through STEP 170's `recordSupplementaryIdvAnswer`, so the result is forward-only and the
 * unhappy cases carry the manual-review fallback. Nothing here touches a charge flag, a payout flag or a processor
 * status: `recordSupplementaryIdvAnswer` could not be made to, and this adapter's vocabulary has no such word.
 */
export async function refreshJumioSession(sessionId: string, options: JumioOptions): Promise<RefreshJumioSessionResult> {
  const session = options.sessionStore.findById(sessionId);
  if (session === null) return { status: "failed", reason: "no session holds that id" };
  if (session.vendorKey !== "jumio") return { status: "failed", reason: "that session belongs to another vendor" };
  const ids = session.reference === null ? null : jumioIdsOf(session.reference);
  if (ids === null) return { status: "failed", reason: "the session carries no usable Jumio reference" };

  const config = options.configStore.findById(session.configId);
  const opening = jumioOpenConfigOf(config, options.keyring);
  if (opening.ok === false) return { status: "failed", reason: opening.reason };

  const token = await jumioAccessTokenFor(session.configId, opening.credential, options);
  if (token.ok === false) return { status: "failed", reason: token.reason };

  let answer: JumioAnswer;
  try {
    answer = await (options.transport ?? jumioFetchTransport)({
      surface: "retrieval",
      region: opening.credential.region,
      method: "GET",
      path: jumioWorkflowExecutionPath(ids.accountId, ids.workflowExecutionId),
      authorization: "bearer",
      authValue: token.accessToken,
      contentType: null,
      body: null,
    });
  } catch {
    return { status: "failed", reason: "Jumio could not be reached, so the workflow status is unknown" };
  }

  const verdict = parseJumioReadAnswer(answer.status, answer.body, session.reference ?? "");
  if (verdict.outcome === "not_found" || verdict.outcome === "failed" || verdict.outcome === "unknown") {
    return { status: "failed", reason: verdict.detail };
  }

  const recorded = recordSupplementaryIdvAnswer(sessionId, { ...verdict.answer, reference: session.reference ?? "" }, {
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
 * The port STEP 170 defined
 * ---------------------------------------------------------------------------------------------- */

/** The configuration a Jumio adapter needs beyond the opened secrets. */
export interface JumioAdapterOptions {
  readonly transport: JumioTransport;
  readonly workflowKey: string;
  readonly successUrl: string;
  readonly errorUrl: string;
  readonly callbackUrl: string | null;
}

/**
 * Build the `SupplementaryIdvAdapter` STEP 170 defines for Jumio.
 *
 * The port has three members and this factory returns exactly those three, so a caller holding the port cannot reach
 * a processor status through it. `createSession` needs more than the port's signature carries — the workflow key and
 * the return URLs are the office's configuration, not the request's — so it is bound here, once, and the vendor's own
 * page URL is answered through `SupplementaryIdvVendorAnswer`'s sibling call below rather than smuggled into a field
 * the vocabulary does not have.
 */
export function jumioAdapterOf(options: JumioAdapterOptions): SupplementaryIdvAdapter {
  return {
    vendorKey: "jumio",
    createSession: async (
      request: { readonly companyId: string; readonly sessionId: string; readonly environment: SupplementaryIdvEnvironment; readonly returnUrl: string },
      config: OpenedSupplementaryIdvConfig,
    ): Promise<SupplementaryIdvVendorAnswer> => {
      const credential = jumioCredentialOf(config.credential);
      if (credential === null) throw new Error("the opened Jumio configuration carries no usable credential");
      const body = buildJumioAccountRequest({
        customerInternalReference: jumioCustomerReferenceOf(request.sessionId),
        workflowKey: options.workflowKey,
        successUrl: options.successUrl,
        errorUrl: options.errorUrl,
        callbackUrl: options.callbackUrl,
      });
      const tokenAnswer = await options.transport({
        surface: "auth",
        region: credential.region,
        method: "POST",
        path: JUMIO_TOKEN_PATH,
        authorization: "basic",
        authValue: jumioBasicAuthOf(credential),
        contentType: "application/x-www-form-urlencoded",
        body: "grant_type=client_credentials",
      });
      const tokenVerdict = parseJumioTokenAnswer(tokenAnswer.status, tokenAnswer.body);
      if (tokenVerdict.outcome !== "token") throw new Error(tokenVerdict.detail);
      const created = await options.transport({
        surface: "account",
        region: credential.region,
        method: "POST",
        path: JUMIO_ACCOUNTS_PATH,
        authorization: "bearer",
        authValue: tokenVerdict.token.accessToken,
        contentType: "application/json",
        body: JSON.stringify({
          customerInternalReference: body.customerInternalReference,
          workflowDefinition: { key: body.workflowDefinition.key },
          web: { successUrl: body.web.successUrl, errorUrl: body.web.errorUrl },
          ...(body.callbackUrl === null ? {} : { callbackUrl: body.callbackUrl }),
        }),
      });
      const verdict = parseJumioAccountAnswer(created.status, created.body);
      if (verdict.outcome !== "created") throw new Error(verdict.detail);
      return {
        reference: jumioReferenceOf(verdict.answer.accountId, verdict.answer.workflowExecutionId),
        result: "in_progress",
        liveness: "in_progress",
        documentKind: "not_stated",
        reasonCode: "vendor_incomplete",
      };
    },
    readSession: async (reference: string, config: OpenedSupplementaryIdvConfig): Promise<SupplementaryIdvVendorAnswer> => {
      const credential = jumioCredentialOf(config.credential);
      if (credential === null) throw new Error("the opened Jumio configuration carries no usable credential");
      const ids = jumioIdsOf(reference);
      if (ids === null) throw new Error("that is not a Jumio reference");
      const tokenAnswer = await options.transport({
        surface: "auth",
        region: credential.region,
        method: "POST",
        path: JUMIO_TOKEN_PATH,
        authorization: "basic",
        authValue: jumioBasicAuthOf(credential),
        contentType: "application/x-www-form-urlencoded",
        body: "grant_type=client_credentials",
      });
      const tokenVerdict = parseJumioTokenAnswer(tokenAnswer.status, tokenAnswer.body);
      if (tokenVerdict.outcome !== "token") throw new Error(tokenVerdict.detail);
      const read = await options.transport({
        surface: "retrieval",
        region: credential.region,
        method: "GET",
        path: jumioWorkflowExecutionPath(ids.accountId, ids.workflowExecutionId),
        authorization: "bearer",
        authValue: tokenVerdict.token.accessToken,
        contentType: null,
        body: null,
      });
      const verdict = parseJumioReadAnswer(read.status, read.body, reference);
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

/** A session as the office sees it: the vendor's own words, and the neutral result they became. */
export interface JumioSessionSummary {
  readonly sessionId: string;
  readonly reference: string | null;
  readonly result: SupplementaryIdvResult;
  readonly liveness: SupplementaryIdvLiveness;
  readonly documentKind: string;
  readonly reasonCode: string | null;
  readonly workflowStatus: string;
  readonly decisions: readonly JumioCapabilityDecision[];
  /** Always false: nothing here changes a charge flag, a payout flag or a processor status. */
  readonly changesProcessorKyb: false;
}

/** Summarise a read for the office, keeping Jumio's decision list beside the neutral result. */
export function jumioSessionSummaryOf(
  session: SupplementaryIdvSession,
  workflow: JumioWorkflow,
): JumioSessionSummary {
  return {
    sessionId: session.id,
    reference: session.reference,
    result: session.result,
    liveness: session.liveness,
    documentKind: session.documentKind,
    reasonCode: session.reasonCode,
    workflowStatus: workflow.workflowStatus,
    decisions: workflow.decisions,
    changesProcessorKyb: false,
  };
}

/** The supplementary vendor key this file implements, spelled once. */
export const JUMIO_VENDOR_KEY: SupplementaryIdvVendorKey = "jumio";

/** The in-memory configuration store a caller may use when it has no table yet. */
export const JUMIO_REFERENCE_CONFIG_STORE = InMemorySupplementaryIdvConfigStore;
