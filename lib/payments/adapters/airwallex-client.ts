// path: lib/payments/adapters/airwallex-client.ts

/**
 * The Airwallex key configuration and its connection test: the sealed client id and API key, the documented
 * two-call proof, the short-lived token that is never stored, and the transitions that let a screen enable the
 * provider only after a test it passed.
 *
 * ## What section 6 asks of this STEP
 *
 * "Keys are AES-256-GCM encrypted before storage. The encryption key exists only in environment variables."
 * "After saving, a full key is never shown again. Only the last characters and last updated time are shown."
 * "A provider cannot be enabled when its connection test fails." Those three sentences are the whole design:
 * the credentials are sealed with STEP 062's envelope (`lib/security/encryption.ts`), the screen sees a masked
 * value, and activation reads a recorded test rather than a caller's claim.
 *
 * ## Why the proof is two calls
 *
 * STEP 165 recorded the documented flow: `POST /api/v1/authentication/login` with `x-client-id` and `x-api-key`
 * headers answers `201` with `token` and `expires_at`, and the token "is valid for 30 minutes and can be reused
 * until it expires". The sandbox guide then shows the way to use it: `GET /api/v1/balances/current` with
 * `Authorization: Bearer <token>`. A login only proves the pair was accepted and handed back a token; the
 * authenticated read proves the token works and that the scopes reach a real endpoint. This file requires
 * both, in that order, before it says `connected` — a partial proof is `unreachable` or `unknown`, never a
 * success.
 *
 * ## The mode cannot come from the key, so it comes from the host
 *
 * No Airwallex page documents a key prefix (STEP 165's open question), unlike Stripe's `sk_test_`/`sk_live_`.
 * So the mode is stored with the configuration and the test proves it by construction: the transport only
 * accepts the documented host for the stored environment, and the result names the base URL it called. A
 * sandbox key pasted into a live configuration therefore fails at the first call instead of turning into a live
 * action later.
 *
 * ## The token is not a credential this platform keeps
 *
 * The access token is short-lived, derived, and useless without a call; storing it would be a second secret to
 * protect for no benefit. It lives in an in-memory cache behind `AirwallexTokenCache`, is refreshed one minute
 * before `expires_at` (STEP 165's skew), is never written to the configuration record, never shown to a screen
 * and never audited. Only the *count* of what a read returned is recorded.
 *
 * ## The version question this STEP must close
 *
 * STEP 165 recorded a disagreement: the reference FAQ says the latest version is `2026-05-29`, the published
 * specification demonstrates `2026-08-21`. A connection test is exactly where that gets settled, so this file
 * names both in `AIRWALLEX_VERSION_CANDIDATES` and returns `version_rejected` — with the pinned value and the
 * candidates — when the API refuses the pin. `probeAirwallexApiVersions` then walks the candidates and reports
 * which one was accepted, so the operator changes the pin on evidence; nothing is rewritten automatically.
 */

import { randomUUID } from "node:crypto";
import { deepFreeze } from "../../utils/freeze.ts";
import { openSecret, sealSecret, type EncryptionKeyring } from "../../security/encryption.ts";
import {
  AIRWALLEX_API_KEY_HEADER,
  AIRWALLEX_API_KEY_MAXIMUM_LENGTH,
  AIRWALLEX_API_KEY_MINIMUM_LENGTH,
  AIRWALLEX_API_KEY_PATTERN,
  AIRWALLEX_API_VERSION_HEADER,
  AIRWALLEX_CLIENT_ID_HEADER,
  AIRWALLEX_CLIENT_ID_MAXIMUM_LENGTH,
  AIRWALLEX_CLIENT_ID_MINIMUM_LENGTH,
  AIRWALLEX_CLIENT_ID_PATTERN,
  AIRWALLEX_DEFAULT_API_VERSION,
  AIRWALLEX_OBSERVED_API_VERSIONS,
  AIRWALLEX_PROVIDER_KEY,
  AIRWALLEX_PRODUCTION_BASE,
  AIRWALLEX_SANDBOX_BASE,
  AIRWALLEX_TOKEN_LIFETIME_SECONDS,
  AIRWALLEX_TOKEN_REFRESH_SKEW_SECONDS,
  carriesAirwallexKeyShapedText,
  sanitizeAirwallexText,
  validateAirwallexCredentials,
} from "./airwallex.ts";

/* -------------------------------------------------------------------------------------------------
 * The documented surface
 * ---------------------------------------------------------------------------------------------- */

/** The two documented hosts, by mode. */
export const AIRWALLEX_BASE_URLS: Readonly<Record<"sandbox" | "live", string>> = deepFreeze({
  sandbox: AIRWALLEX_SANDBOX_BASE,
  live: AIRWALLEX_PRODUCTION_BASE,
});

/** The documented login path. */
export const AIRWALLEX_LOGIN_PATH = "/api/v1/authentication/login";

/** The documented authenticated read the connection test uses. */
export const AIRWALLEX_CONNECTION_PATH = "/api/v1/balances/current";

/** The only paths this file may call. */
export const AIRWALLEX_CLIENT_ALLOWED_PATHS: readonly string[] = deepFreeze([
  AIRWALLEX_LOGIN_PATH,
  AIRWALLEX_CONNECTION_PATH,
]);

/** The base URL a mode names, or null for an unrecorded mode. */
export function airwallexBaseUrlFor(environment: "sandbox" | "live"): string | null {
  return AIRWALLEX_BASE_URLS[environment] ?? null;
}

/** The endpoint a call is made to. */
export function airwallexClientEndpoint(environment: "sandbox" | "live", path: string): string {
  const base = airwallexBaseUrlFor(environment);
  if (base === null) throw new Error("invalid environment");
  return `${base}${path}`;
}

/**
 * The versions a probe tries, in the order this platform tries them.
 *
 * The pin comes first, then every version recorded as *newer* than the pin — which is exactly the pair STEP 165
 * could not settle: the reference FAQ names `2026-05-29`, the published specification demonstrates
 * `2026-08-21`. Older versions are not candidates, because an account that refuses the pin is refusing a version
 * that is too new to accept, not one that is too old; and the list stays inside
 * `AIRWALLEX_MAXIMUM_VERSION_PROBES`.
 */
export const AIRWALLEX_VERSION_CANDIDATES: readonly string[] = deepFreeze([
  AIRWALLEX_DEFAULT_API_VERSION,
  ...AIRWALLEX_OBSERVED_API_VERSIONS.filter((version) => version > AIRWALLEX_DEFAULT_API_VERSION),
]);

/** The most candidates one probe may walk. */
export const AIRWALLEX_MAXIMUM_VERSION_PROBES = 3;

/** The bounds every call in this file keeps. */
export const AIRWALLEX_ANSWER_MAXIMUM_BYTES = 65_536;
export const AIRWALLEX_CLIENT_TIMEOUT_MS = 15_000;
export const AIRWALLEX_CLIENT_TEXT_MAXIMUM_LENGTH = 200;

/** The company id shape this file accepts. */
export const AIRWALLEX_COMPANY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;

/* -------------------------------------------------------------------------------------------------
 * Sealed scopes
 * ---------------------------------------------------------------------------------------------- */

/** The scope the sealed client id lives under. */
export function airwallexClientIdScope(companyId: string): string {
  return `airwallex:client-id:${companyId}`;
}

/** The scope the sealed API key lives under. */
export function airwallexApiKeyScope(companyId: string): string {
  return `airwallex:api-key:${companyId}`;
}

/** The scope the sealed webhook signing secret lives under. */
export function airwallexWebhookSecretScope(companyId: string): string {
  return `airwallex:webhook-secret:${companyId}`;
}

/** The documented maximum length of a webhook signing secret this platform accepts. */
export const AIRWALLEX_WEBHOOK_SECRET_MAXIMUM_LENGTH = 256;

/** The documented minimum length of a webhook signing secret this platform accepts. */
export const AIRWALLEX_WEBHOOK_SECRET_MINIMUM_LENGTH = 8;

/* -------------------------------------------------------------------------------------------------
 * The configuration record
 * ---------------------------------------------------------------------------------------------- */

/** Where a configuration stands. */
export type AirwallexConfigStatus = "pending_activation" | "active" | "superseded" | "retired";

/** What a connection test concluded. */
export type AirwallexConnectionOutcome =
  | "connected"
  | "credentials_rejected"
  | "not_permitted"
  | "version_rejected"
  | "rejected"
  | "unreachable"
  | "unknown"
  | "invalid_configuration";

/** What a recorded test holds. Never carries a credential or a token. */
export interface AirwallexConnectionTest {
  readonly outcome: AirwallexConnectionOutcome;
  readonly testedAtEpochMs: number;
  readonly environment: "sandbox" | "live";
  /** The version header the test sent, so the proof names the version it was made on. */
  readonly apiVersionSent: string;
  /** The documented host the test called, so the proof names the mode it was made in. */
  readonly baseUrlUsed: string;
  /** True only when the login answered a token *and* the authenticated read answered too. */
  readonly tokenProven: boolean;
}

/** One company's Airwallex configuration. */
export interface AirwallexKeyConfig {
  readonly id: string;
  readonly companyId: string;
  readonly environment: "sandbox" | "live";
  readonly baseUrl: string;
  /** The sealed client id. */
  readonly clientIdSealed: string;
  /** The sealed API key. */
  readonly apiKeySealed: string;
  /** The sealed webhook signing secret, when one has been configured for this company's endpoint. */
  readonly webhookSecretSealed: string | null;
  /** The dated version every call sends. */
  readonly apiVersion: string;
  readonly status: AirwallexConfigStatus;
  readonly version: number;
  readonly lastTest: AirwallexConnectionTest | null;
  readonly createdAtEpochMs: number;
  readonly updatedAtEpochMs: number;
}

/** The store the caller supplies. */
export interface AirwallexConfigStore {
  insert(config: AirwallexKeyConfig): void;
  findById(id: string): AirwallexKeyConfig | null;
  findByCompany(companyId: string): AirwallexKeyConfig[];
  findActiveByCompany(companyId: string): AirwallexKeyConfig | null;
  findPendingByCompany(companyId: string): AirwallexKeyConfig | null;
  save(next: AirwallexKeyConfig, expectedVersion: number): boolean;
}

/**
 * The in-memory store: a reference implementation of the invariants the flow rests on — one pending
 * configuration per company, one active one, an immutable identity and sealed credentials, a version guard, and
 * the section 6 rule that a configuration never becomes active on a test it did not pass.
 */
export class InMemoryAirwallexConfigStore implements AirwallexConfigStore {
  private readonly configs = new Map<string, AirwallexKeyConfig>();

  insert(config: AirwallexKeyConfig): void {
    if (this.configs.has(config.id)) throw new Error("duplicate configuration id");
    if (config.version !== 1) throw new Error("a new configuration starts at version 1");
    if (config.status !== "pending_activation") throw new Error("a new configuration waits for its connection test");
    if (this.findPendingByCompany(config.companyId) !== null) {
      throw new Error("this company already has a key waiting for its connection test");
    }
    this.configs.set(config.id, config);
  }

  findById(id: string): AirwallexKeyConfig | null {
    return this.configs.get(id) ?? null;
  }

  findByCompany(companyId: string): AirwallexKeyConfig[] {
    return [...this.configs.values()].filter((config) => config.companyId === companyId);
  }

  findActiveByCompany(companyId: string): AirwallexKeyConfig | null {
    return this.findByCompany(companyId).find((config) => config.status === "active") ?? null;
  }

  findPendingByCompany(companyId: string): AirwallexKeyConfig | null {
    return this.findByCompany(companyId).find((config) => config.status === "pending_activation") ?? null;
  }

  save(next: AirwallexKeyConfig, expectedVersion: number): boolean {
    const current = this.configs.get(next.id);
    if (current === undefined) return false;
    if (current.companyId !== next.companyId || current.environment !== next.environment) return false;
    if (current.baseUrl !== next.baseUrl) return false;
    if (current.version !== expectedVersion) return false;
    if (next.version !== expectedVersion + 1) return false;
    // A stored credential is never swapped in place.
    if (current.clientIdSealed !== next.clientIdSealed || current.apiKeySealed !== next.apiKeySealed) return false;
    if (current.apiVersion !== next.apiVersion) return false;
    // The webhook signing secret is the one credential a stored configuration may replace in place: rotating it
    // is what `rotateAirwallexWebhookSecret` is for, and Airwallex gives each notification URL its own secret.
    // Section 6 at the store: never active on a test it did not pass, on this version, on this host.
    if (next.status === "active" && current.status === "pending_activation") {
      const test = next.lastTest;
      if (test === null || test.outcome !== "connected") return false;
      if (test.apiVersionSent !== next.apiVersion) return false;
      if (test.baseUrlUsed !== next.baseUrl) return false;
      if (test.tokenProven !== true) return false;
    }
    if (next.status === "active" && current.status !== "pending_activation" && current.status !== "active") return false;
    if (next.status === "pending_activation" && current.status !== "pending_activation") return false;
    if (next.status === "retired" && current.status === "retired") return false;
    if (next.status === "superseded" && current.status !== "active") return false;
    const active = this.findActiveByCompany(next.companyId);
    if (next.status === "active" && active !== null && active.id !== next.id) return false;
    this.configs.set(next.id, next);
    return true;
  }
}

/* -------------------------------------------------------------------------------------------------
 * Audit
 * ---------------------------------------------------------------------------------------------- */

/** One audit entry this file hands to the caller's audit writer. Never carries a credential or a token. */
export interface AirwallexKeyAuditEntry {
  readonly action:
    | "provider_key.configured"
    | "provider_key.tested"
    | "provider_key.activated"
    | "provider_key.rotated"
    | "provider_key.retired"
    | "provider_webhook_secret.rotated";
  readonly providerKey: typeof AIRWALLEX_PROVIDER_KEY;
  readonly companyId: string;
  readonly configId: string;
  readonly environment: "sandbox" | "live";
  readonly outcome: string;
  readonly occurredAtEpochMs: number;
}

/* -------------------------------------------------------------------------------------------------
 * Configuring
 * ---------------------------------------------------------------------------------------------- */

/** What an admin screen submits. */
export interface ConfigureAirwallexKeysInput {
  readonly companyId: string;
  readonly environment: "sandbox" | "live";
  readonly clientId: string;
  readonly apiKey: string;
  readonly webhookSecret?: string | null;
  readonly apiVersion?: string | null;
}

/** What configuring needs. */
export interface ConfigureAirwallexKeysOptions {
  readonly store: AirwallexConfigStore;
  readonly keyring: EncryptionKeyring;
  readonly occurredAtEpochMs: number;
  readonly recordAudit?: (entry: AirwallexKeyAuditEntry) => void;
}

/** What configuring did. */
export type ConfigureAirwallexKeysResult =
  | { readonly status: "configured"; readonly config: AirwallexKeyConfig; readonly view: AirwallexKeyView }
  | { readonly status: "failed"; readonly reason: string };

/**
 * The validation failure of an input, or null when it is valid.
 *
 * STEP 165's finding is the reason this returns the messages it does: with no documented prefix there is no
 * "this is a live key" check to run, so the checks that remain are the ones that can be made honestly —
 * characters and bounds, a body that is clearly a token or a pasted header rather than a credential, a company
 * id, and a version that is a date. The mode is checked by the call the test makes, not by the key's shape.
 */
export function validateAirwallexKeyInput(input: ConfigureAirwallexKeysInput): string | null {
  if (AIRWALLEX_COMPANY_ID_PATTERN.test(input.companyId) === false) return "the company id is invalid";
  if (input.environment !== "sandbox" && input.environment !== "live") return "the environment must be sandbox or live";

  const clientId = input.clientId.trim();
  const apiKey = input.apiKey.trim();
  if (clientId.length < AIRWALLEX_CLIENT_ID_MINIMUM_LENGTH || clientId.length > AIRWALLEX_CLIENT_ID_MAXIMUM_LENGTH) {
    return "the client id must be 8 to 128 characters";
  }
  if (apiKey.length < AIRWALLEX_API_KEY_MINIMUM_LENGTH || apiKey.length > AIRWALLEX_API_KEY_MAXIMUM_LENGTH) {
    return "the API key must be 16 to 256 characters";
  }
  if (carriesAirwallexKeyShapedText(clientId)) {
    return "the client id looks like a token or a pasted header, not a client id";
  }
  if (carriesAirwallexKeyShapedText(apiKey)) {
    return "the API key looks like an access token or a pasted header; store the key, not the token";
  }
  if (clientId === apiKey) return "the client id and the API key cannot be the same value";
  if (AIRWALLEX_CLIENT_ID_PATTERN.test(clientId) === false) {
    return "the client id must be 8 to 128 letters, digits, dashes or underscores";
  }
  if (AIRWALLEX_API_KEY_PATTERN.test(apiKey) === false) {
    return "the API key must be 16 to 256 letters, digits, dashes or underscores";
  }

  const baseUrl = airwallexBaseUrlFor(input.environment);
  if (baseUrl === null) return "the environment names no documented host";
  const credentialCheck = validateAirwallexCredentials({
    clientId,
    apiKey,
    baseUrl,
    apiVersion: (input.apiVersion ?? "").trim().length === 0 ? AIRWALLEX_DEFAULT_API_VERSION : (input.apiVersion ?? "").trim(),
  });
  if (credentialCheck !== null) return credentialCheck;

  const webhookSecret = (input.webhookSecret ?? "").trim();
  if (webhookSecret.length > 0) {
    if (webhookSecret.length < AIRWALLEX_WEBHOOK_SECRET_MINIMUM_LENGTH) return "the webhook secret is too short to be usable";
    if (webhookSecret.length > AIRWALLEX_WEBHOOK_SECRET_MAXIMUM_LENGTH) return "the webhook secret is too long";
    if (/\s/u.test(webhookSecret)) return "the webhook secret must not contain whitespace";
  }

  return null;
}

/**
 * Add a configuration, sealed and waiting for its connection test.
 *
 * The input is validated before anything is sealed, so an invalid value never becomes an envelope; both
 * credentials are sealed under their own scopes; the webhook signing secret, when given, is sealed under
 * its own; and the configuration starts `pending_activation`, because a provider "cannot be enabled when its
 * connection test fails".
 */
export function configureAirwallexKeys(
  input: ConfigureAirwallexKeysInput,
  options: ConfigureAirwallexKeysOptions,
): ConfigureAirwallexKeysResult {
  const invalid = validateAirwallexKeyInput(input);
  if (invalid !== null) return { status: "failed", reason: invalid };

  if (options.store.findPendingByCompany(input.companyId) !== null) {
    return { status: "failed", reason: "this company already has a key waiting for its connection test" };
  }

  const clientId = input.clientId.trim();
  const apiKey = input.apiKey.trim();
  const baseUrl = airwallexBaseUrlFor(input.environment);
  if (baseUrl === null) return { status: "failed", reason: "the environment names no documented host" };
  const apiVersion = (input.apiVersion ?? "").trim().length > 0 ? (input.apiVersion ?? "").trim() : AIRWALLEX_DEFAULT_API_VERSION;
  const webhookSecret = (input.webhookSecret ?? "").trim();

  let clientIdSealed: string;
  let apiKeySealed: string;
  let webhookSecretSealed: string | null;
  try {
    clientIdSealed = sealSecret(options.keyring, clientId, {
      purpose: "secret",
      scope: airwallexClientIdScope(input.companyId),
    });
    apiKeySealed = sealSecret(options.keyring, apiKey, { purpose: "secret", scope: airwallexApiKeyScope(input.companyId) });
    webhookSecretSealed =
      webhookSecret.length === 0
        ? null
        : sealSecret(options.keyring, webhookSecret, {
            purpose: "secret",
            scope: airwallexWebhookSecretScope(input.companyId),
          });
  } catch {
    return { status: "failed", reason: "the encryption keyring cannot seal a credential" };
  }

  const config: AirwallexKeyConfig = {
    id: randomUUID(),
    companyId: input.companyId,
    environment: input.environment,
    baseUrl,
    clientIdSealed,
    apiKeySealed,
    webhookSecretSealed,
    apiVersion,
    status: "pending_activation",
    version: 1,
    lastTest: null,
    createdAtEpochMs: options.occurredAtEpochMs,
    updatedAtEpochMs: options.occurredAtEpochMs,
  };

  try {
    options.store.insert(config);
  } catch {
    return { status: "failed", reason: "this company already has a key in that state" };
  }

  options.recordAudit?.({
    action: "provider_key.configured",
    providerKey: AIRWALLEX_PROVIDER_KEY,
    companyId: config.companyId,
    configId: config.id,
    environment: config.environment,
    outcome: "pending_activation",
    occurredAtEpochMs: options.occurredAtEpochMs,
  });

  return { status: "configured", config, view: viewOf(config, clientId, apiKey, webhookSecret.length === 0 ? null : webhookSecret) };
}

/* -------------------------------------------------------------------------------------------------
 * The masked view
 * ---------------------------------------------------------------------------------------------- */

/** What an admin screen may show. */
export interface AirwallexKeyView {
  readonly id: string;
  readonly companyId: string;
  readonly environment: "sandbox" | "live";
  readonly baseUrl: string;
  /** The client id, masked to its last four characters. */
  readonly clientIdMasked: string;
  /** The API key, masked to its last four characters. */
  readonly apiKeyMasked: string;
  readonly webhookSecretMasked: string | null;
  readonly apiVersion: string;
  readonly status: AirwallexConfigStatus;
  readonly lastTestOutcome: AirwallexConnectionOutcome | null;
  readonly lastTestedAtEpochMs: number | null;
  readonly updatedAtEpochMs: number;
}

/**
 * Mask a credential: keep the last four characters and nothing else.
 *
 * Airwallex documents no prefix to keep — and STEP 165 refuses to pretend it does — so there is no family
 * marker to show. A value short enough for its last four characters to be most of it is hidden entirely.
 */
export function maskAirwallexCredential(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 8) return "*".repeat(Math.max(1, trimmed.length));
  return `${"*".repeat(12)}${trimmed.slice(-4)}`;
}

function viewOf(
  config: AirwallexKeyConfig,
  clientId: string,
  apiKey: string,
  webhookSecret: string | null,
): AirwallexKeyView {
  return {
    id: config.id,
    companyId: config.companyId,
    environment: config.environment,
    baseUrl: config.baseUrl,
    clientIdMasked: maskAirwallexCredential(clientId),
    apiKeyMasked: maskAirwallexCredential(apiKey),
    webhookSecretMasked: webhookSecret === null ? null : maskAirwallexCredential(webhookSecret),
    apiVersion: config.apiVersion,
    status: config.status,
    lastTestOutcome: config.lastTest === null ? null : config.lastTest.outcome,
    lastTestedAtEpochMs: config.lastTest === null ? null : config.lastTest.testedAtEpochMs,
    updatedAtEpochMs: config.updatedAtEpochMs,
  };
}

/**
 * Read the masked view of a stored configuration.
 *
 * The sealed values are opened only to be masked, so a screen can show what is stored without holding it. A
 * configuration whose envelopes no longer open — a keyring rotation that dropped a key too early — is reported
 * as unreadable rather than shown blank.
 */
export function airwallexKeyViewOf(
  config: AirwallexKeyConfig,
  keyring: EncryptionKeyring,
): { readonly status: "shown"; readonly view: AirwallexKeyView } | { readonly status: "failed"; readonly reason: string } {
  let clientId: string;
  let apiKey: string;
  try {
    clientId = openSecret(keyring, config.clientIdSealed, { purpose: "secret", scope: airwallexClientIdScope(config.companyId) });
    apiKey = openSecret(keyring, config.apiKeySealed, { purpose: "secret", scope: airwallexApiKeyScope(config.companyId) });
  } catch {
    return { status: "failed", reason: "the sealed credentials cannot be opened with this keyring" };
  }

  let webhookMasked: string | null = null;
  if (config.webhookSecretSealed !== null) {
    try {
      webhookMasked = maskAirwallexCredential(
        openSecret(keyring, config.webhookSecretSealed, {
          purpose: "secret",
          scope: airwallexWebhookSecretScope(config.companyId),
        }),
      );
    } catch {
      return { status: "failed", reason: "the sealed webhook secret cannot be opened with this keyring" };
    }
  }

  return { status: "shown", view: { ...viewOf(config, clientId, apiKey, null), webhookSecretMasked: webhookMasked } };
}

/* -------------------------------------------------------------------------------------------------
 * The transport
 * ---------------------------------------------------------------------------------------------- */

/** One call: what it is for, where it goes, and what it carries. */
export interface AirwallexClientCall {
  readonly method: "GET" | "POST";
  readonly environment: "sandbox" | "live";
  readonly path: string;
  readonly clientId: string | null;
  readonly apiKey: string | null;
  readonly accessToken: string | null;
  readonly apiVersion: string;
}

/** The HTTP answer. */
export interface AirwallexClientAnswer {
  readonly status: number;
  readonly body: string;
}

/** The transport port. */
export type AirwallexClientTransport = (call: AirwallexClientCall) => Promise<AirwallexClientAnswer>;

/**
 * Perform one documented call.
 *
 * The path is allowlisted to the two endpoints this file may use; the host comes from the stored environment and
 * nowhere else; the login send `x-client-id`/`x-api-key` and no body, the read sends the bearer token and the
 * pinned `x-api-version`; redirects are refused; the timeout is bounded and an oversized answer is refused. No
 * credential ever reaches a URL.
 */
export const airwallexFetchTransport: AirwallexClientTransport = async (call) => {
  if (AIRWALLEX_CLIENT_ALLOWED_PATHS.includes(call.path) === false) throw new Error("invalid API path");
  if (call.apiVersion.trim().length === 0) throw new Error("an API version is required");
  const endpoint = airwallexClientEndpoint(call.environment, call.path);

  const headers: Record<string, string> = { Accept: "application/json" };
  if (call.path === AIRWALLEX_LOGIN_PATH) {
    if (call.clientId === null || call.apiKey === null) throw new Error("a client id and an API key are required");
    headers[AIRWALLEX_CLIENT_ID_HEADER] = call.clientId;
    headers[AIRWALLEX_API_KEY_HEADER] = call.apiKey;
  } else {
    if (call.accessToken === null || call.accessToken.trim().length === 0) throw new Error("an access token is required");
    headers["Authorization"] = `Bearer ${call.accessToken}`;
    headers[AIRWALLEX_API_VERSION_HEADER] = call.apiVersion.trim();
  }

  const response = await fetch(endpoint, {
    method: call.method,
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(AIRWALLEX_CLIENT_TIMEOUT_MS),
  });
  const text = await response.text();
  if (text.length > AIRWALLEX_ANSWER_MAXIMUM_BYTES) throw new Error("invalid API answer");
  return { status: response.status, body: text };
};

/* -------------------------------------------------------------------------------------------------
 * Reading answers
 * ---------------------------------------------------------------------------------------------- */

function parseAnswerBody(body: string): unknown {
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

/** Read the provider's own words out of an answer, sanitised and bounded. */
export function airwallexClientMessageOf(payload: unknown): string {
  const record = answerRecord(payload);
  if (record === null) return "";
  for (const key of ["message", "detail", "error"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return sanitizeAirwallexText(value, AIRWALLEX_CLIENT_TEXT_MAXIMUM_LENGTH);
    }
  }
  return "";
}

/** Read the documented error code out of an answer, when there is one. */
export function airwallexClientCodeOf(payload: unknown): string | null {
  const record = answerRecord(payload);
  if (record === null) return null;
  for (const key of ["code", "error_code"]) {
    const value = record[key];
    if (typeof value === "string" && /^[a-z0-9_.]{2,64}$/u.test(value)) return value;
  }
  return null;
}

/** What a login answer produced. */
export type AirwallexLoginVerdict =
  | { readonly outcome: "token_issued"; readonly token: string; readonly expiresAtEpochMs: number }
  | { readonly outcome: "credentials_rejected"; readonly detail: string; readonly code: string | null }
  | { readonly outcome: "not_permitted"; readonly detail: string }
  | { readonly outcome: "version_rejected"; readonly detail: string }
  | { readonly outcome: "rejected"; readonly detail: string }
  | { readonly outcome: "unknown"; readonly detail: string };

/** True when an answer's code names the documented version refusal. */
export function airwallexVersionRefusalCodeIs(code: string | null): boolean {
  if (code === null) return false;
  return code === "incorrect_version" || code === "request.api_version_unsupported";
}

/**
 * Read the documented login answer.
 *
 * `201` with a `token` and a readable `expires_at` is the only success. `401` is `credentials_rejected` and its
 * documented codes (`credentials_invalid`, `credentials_expired`) are kept, because an expired key and a wrong
 * key are different things to tell an operator. `403` is `not_permitted`; `400` is `rejected`, unless its code
 * names the version, in which case it is `version_rejected` — the answer to STEP 165's open question. `429`,
 * a timeout-class code, a `5XX`, a thrown transport and a `2XX` with no token are `unknown`: a token may exist.
 */
export function parseAirwallexLoginAnswer(status: number, body: string): AirwallexLoginVerdict {
  const payload = parseAnswerBody(body);
  const message = airwallexClientMessageOf(payload);
  const code = airwallexClientCodeOf(payload);
  const detailOr = (fallback: string): string => (message.length > 0 ? message : fallback);

  if (status === 400) {
    if (airwallexVersionRefusalCodeIs(code)) {
      return {
        outcome: "version_rejected",
        detail: detailOr("the account does not accept the pinned API version"),
      };
    }
    return { outcome: "rejected", detail: detailOr("the API refused the request") };
  }
  if (status === 401) {
    return { outcome: "credentials_rejected", detail: detailOr("the API rejected the client id or the API key"), code };
  }
  if (status === 403) return { outcome: "not_permitted", detail: detailOr("the API key lacks the permission this call needs") };
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return { outcome: "unknown", detail: "the API did not answer finally" };
  }
  if (status >= 300 && status < 400) return { outcome: "unknown", detail: "the API answered with a redirect, which proves nothing" };
  if (status < 200 || status >= 300) return { outcome: "rejected", detail: detailOr(`the API refused the call with status ${status}`) };

  const token = answerRecord(payload)?.["token"];
  const expiresAt = answerRecord(payload)?.["expires_at"];
  if (typeof token !== "string" || token.trim().length < 20) {
    return { outcome: "unknown", detail: "the answer carries no usable token" };
  }
  if (typeof expiresAt !== "string") {
    return { outcome: "unknown", detail: "the answer carries no expires_at, so the token cannot be trusted" };
  }
  const expiresAtMs = Date.parse(expiresAt);
  if (Number.isFinite(expiresAtMs) === false) {
    return { outcome: "unknown", detail: "the answer's expires_at cannot be read" };
  }
  return { outcome: "token_issued", token: token.trim(), expiresAtEpochMs: expiresAtMs };
}

/** What the authenticated read produced. */
export type AirwallexBalancesVerdict =
  | { readonly outcome: "accepted"; readonly balanceCount: number }
  | { readonly outcome: "token_rejected"; readonly detail: string }
  | { readonly outcome: "not_permitted"; readonly detail: string }
  | { readonly outcome: "version_rejected"; readonly detail: string }
  | { readonly outcome: "rejected"; readonly detail: string }
  | { readonly outcome: "unknown"; readonly detail: string };

/**
 * Read the documented balances answer.
 *
 * The endpoint answers a list of balance objects. Only a `200` carrying an object or a list counts; the count is
 * recorded and the currencies are not, because a connection test has no business storing what a company holds.
 * A `401` here means the token was refused even though the login answered, which is a real and honest failure.
 */
export function parseAirwallexBalancesAnswer(status: number, body: string): AirwallexBalancesVerdict {
  const payload = parseAnswerBody(body);
  const message = airwallexClientMessageOf(payload);
  const code = airwallexClientCodeOf(payload);

  if (status === 400) {
    return airwallexVersionRefusalCodeIs(code)
      ? { outcome: "version_rejected", detail: message.length > 0 ? message : "the account does not accept the pinned API version" }
      : { outcome: "rejected", detail: message.length > 0 ? message : "the API refused the read" };
  }
  if (status === 401) return { outcome: "token_rejected", detail: message.length > 0 ? message : "the API rejected the token" };
  if (status === 403) return { outcome: "not_permitted", detail: message.length > 0 ? message : "the key lacks the balance read permission" };
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return { outcome: "unknown", detail: "the API did not answer finally" };
  }
  if (status >= 300 && status < 400) return { outcome: "unknown", detail: "the API answered with a redirect, which proves nothing" };
  if (status < 200 || status >= 300) return { outcome: "rejected", detail: message.length > 0 ? message : `the API refused the read with status ${status}` };

  if (payload === null) return { outcome: "unknown", detail: "the read returned no readable body" };
  if (Array.isArray(payload)) return { outcome: "accepted", balanceCount: payload.length };
  const record = answerRecord(payload);
  if (record === null) return { outcome: "unknown", detail: "the read returned no readable body" };
  const items = record["items"];
  if (Array.isArray(items)) return { outcome: "accepted", balanceCount: items.length };
  if (Object.keys(record).length === 0) return { outcome: "unknown", detail: "the read returned an empty object" };
  return { outcome: "accepted", balanceCount: 1 };
}

/* -------------------------------------------------------------------------------------------------
 * The token, which is never stored
 * ---------------------------------------------------------------------------------------------- */

/** One cached token. In memory only; nothing writes this to the configuration record. */
export interface AirwallexCachedToken {
  readonly token: string;
  readonly expiresAtEpochMs: number;
}

/** The token cache port. */
export interface AirwallexTokenCache {
  get(configId: string): AirwallexCachedToken | null;
  set(configId: string, token: AirwallexCachedToken): void;
  clear(configId: string): void;
}

/** The in-memory cache, which is the only place a token ever lives. */
export class InMemoryAirwallexTokenCache implements AirwallexTokenCache {
  private readonly tokens = new Map<string, AirwallexCachedToken>();

  get(configId: string): AirwallexCachedToken | null {
    return this.tokens.get(configId) ?? null;
  }

  set(configId: string, token: AirwallexCachedToken): void {
    if (token.token.trim().length === 0) throw new Error("a token cannot be empty");
    if (Number.isFinite(token.expiresAtEpochMs) === false) throw new Error("a token must carry an expiry");
    this.tokens.set(configId, token);
  }

  clear(configId: string): void {
    this.tokens.delete(configId);
  }
}

/** True when a cached token still has usable life at `nowEpochMs`, with the documented skew. */
export function airwallexTokenIsUsable(token: AirwallexCachedToken, nowEpochMs: number): boolean {
  return nowEpochMs + AIRWALLEX_TOKEN_REFRESH_SKEW_SECONDS * 1_000 < token.expiresAtEpochMs;
}

/* -------------------------------------------------------------------------------------------------
 * The connection test
 * ---------------------------------------------------------------------------------------------- */

/** What a test needs. */
export interface TestAirwallexConnectionOptions {
  readonly store: AirwallexConfigStore;
  readonly keyring: EncryptionKeyring;
  readonly occurredAtEpochMs: number;
  readonly transport?: AirwallexClientTransport;
  readonly tokenCache?: AirwallexTokenCache;
  readonly recordAudit?: (entry: AirwallexKeyAuditEntry) => void;
}

/** What one test did. Never carries a credential or a token. */
export interface AirwallexConnectionResult {
  readonly outcome: AirwallexConnectionOutcome;
  readonly configId: string | null;
  readonly environment: "sandbox" | "live" | null;
  readonly reason: string;
  /** True only when the login answered a token. */
  readonly tokenIssued: boolean;
  /** True only when the login answered a token **and** the authenticated read answered with the same token. */
  readonly tokenProven: boolean;
  /** The documented host the test called. */
  readonly baseUrlUsed: string | null;
  readonly apiVersionSent: string;
  /** How many balances the read listed, or null. Never the balances themselves. */
  readonly balancesVisible: number | null;
  /** Whether a webhook signing secret is configured; a connection test cannot prove it. */
  readonly webhookSecretConfigured: boolean;
  readonly testedAtEpochMs: number;
  readonly version: number | null;
}

function outcomeOfLogin(verdict: AirwallexLoginVerdict): AirwallexConnectionOutcome {
  switch (verdict.outcome) {
    case "token_issued":
      return "connected";
    case "credentials_rejected":
      return "credentials_rejected";
    case "not_permitted":
      return "not_permitted";
    case "version_rejected":
      return "version_rejected";
    case "rejected":
      return "rejected";
    case "unknown":
      return "unknown";
  }
}

function outcomeOfBalances(verdict: AirwallexBalancesVerdict): AirwallexConnectionOutcome {
  switch (verdict.outcome) {
    case "accepted":
      return "connected";
    case "token_rejected":
      return "credentials_rejected";
    case "not_permitted":
      return "not_permitted";
    case "version_rejected":
      return "version_rejected";
    case "rejected":
      return "rejected";
    case "unknown":
      return "unknown";
  }
}

/**
 * Test one stored configuration against the documented API, with the documented two calls.
 *
 * The sealed credentials are opened in memory, used for the login, and the token is used for exactly one read.
 * The outcome is written back as the configuration's `lastTest` — including a failure — because activation reads
 * the record and a test nobody recorded cannot authorise anything. A result that names `connected` is the only
 * one with `tokenProven: true`, and only the balance *count* is kept.
 */
export async function testAirwallexConnection(
  configId: string,
  options: TestAirwallexConnectionOptions,
): Promise<AirwallexConnectionResult> {
  const config = options.store.findById(configId);
  const transport = options.transport ?? airwallexFetchTransport;
  const failed = (outcome: AirwallexConnectionOutcome, reason: string, extra: Partial<AirwallexConnectionResult> = {}): AirwallexConnectionResult => ({
    outcome,
    configId: config === null ? null : config.id,
    environment: config === null ? null : config.environment,
    reason,
    tokenIssued: false,
    tokenProven: false,
    baseUrlUsed: config === null ? null : config.baseUrl,
    apiVersionSent: config === null ? AIRWALLEX_DEFAULT_API_VERSION : config.apiVersion,
    balancesVisible: null,
    webhookSecretConfigured: config === null ? false : config.webhookSecretSealed !== null,
    testedAtEpochMs: options.occurredAtEpochMs,
    version: config === null ? null : config.version,
    ...extra,
  });

  if (config === null) return failed("invalid_configuration", "no Airwallex configuration holds that id");
  if (config.status === "retired") return failed("invalid_configuration", "the configuration is retired and can no longer be tested");
  if (config.baseUrl !== airwallexBaseUrlFor(config.environment)) {
    return failed("invalid_configuration", "the configuration's stored host is not the documented host for its environment");
  }

  let clientId: string;
  let apiKey: string;
  try {
    clientId = openSecret(options.keyring, config.clientIdSealed, { purpose: "secret", scope: airwallexClientIdScope(config.companyId) });
    apiKey = openSecret(options.keyring, config.apiKeySealed, { purpose: "secret", scope: airwallexApiKeyScope(config.companyId) });
  } catch {
    return failed("invalid_configuration", "the sealed credentials cannot be opened with this keyring");
  }

  let login: AirwallexLoginVerdict;
  try {
    const answer = await transport({
      method: "POST",
      environment: config.environment,
      path: AIRWALLEX_LOGIN_PATH,
      clientId,
      apiKey,
      accessToken: null,
      apiVersion: config.apiVersion,
    });
    login = parseAirwallexLoginAnswer(answer.status, answer.body);
  } catch {
    login = { outcome: "unknown", detail: "the API could not be reached" };
  }

  let outcome: AirwallexConnectionOutcome = outcomeOfLogin(login);
  let reason: string;
  let tokenIssued = false;
  let tokenProven = false;
  let balancesVisible: number | null = null;

  if (login.outcome === "token_issued") {
    tokenIssued = true;
    options.tokenCache?.set(config.id, { token: login.token, expiresAtEpochMs: login.expiresAtEpochMs });

    let balances: AirwallexBalancesVerdict;
    try {
      const answer = await transport({
        method: "GET",
        environment: config.environment,
        path: AIRWALLEX_CONNECTION_PATH,
        clientId: null,
        apiKey: null,
        accessToken: login.token,
        apiVersion: config.apiVersion,
      });
      balances = parseAirwallexBalancesAnswer(answer.status, answer.body);
    } catch {
      balances = { outcome: "unknown", detail: "the API could not be reached for the authenticated read" };
    }

    outcome = outcomeOfBalances(balances);
    if (balances.outcome === "accepted") {
      tokenProven = true;
      balancesVisible = balances.balanceCount;
      reason = `the login answered a token and the authenticated read answered ${balances.balanceCount} balance entr${balances.balanceCount === 1 ? "y" : "ies"}`;
    } else {
      options.tokenCache?.clear(config.id);
      reason = balances.detail;
    }
  } else if (login.outcome === "credentials_rejected") {
    reason = login.code === "credentials_expired" ? `${login.detail} (the key is expired)` : login.detail;
  } else if (login.outcome === "version_rejected") {
    reason = `${login.detail}; the pinned version is ${config.apiVersion} and the recorded candidates are ${AIRWALLEX_VERSION_CANDIDATES.join(", ")}`;
  } else {
    reason = login.detail;
  }

  const next: AirwallexKeyConfig = {
    ...config,
    version: config.version + 1,
    lastTest: {
      outcome,
      testedAtEpochMs: options.occurredAtEpochMs,
      environment: config.environment,
      apiVersionSent: config.apiVersion,
      baseUrlUsed: config.baseUrl,
      tokenProven,
    },
    updatedAtEpochMs: options.occurredAtEpochMs,
  };
  const stored = options.store.save(next, config.version);
  const recorded = stored ? next : options.store.findById(config.id);

  options.recordAudit?.({
    action: "provider_key.tested",
    providerKey: AIRWALLEX_PROVIDER_KEY,
    companyId: config.companyId,
    configId: config.id,
    environment: config.environment,
    outcome,
    occurredAtEpochMs: options.occurredAtEpochMs,
  });

  return {
    outcome,
    configId: config.id,
    environment: config.environment,
    reason,
    tokenIssued,
    tokenProven,
    baseUrlUsed: config.baseUrl,
    apiVersionSent: config.apiVersion,
    balancesVisible,
    webhookSecretConfigured: config.webhookSecretSealed !== null,
    testedAtEpochMs: options.occurredAtEpochMs,
    version: recorded === null ? null : recorded.version,
  };
}

/* -------------------------------------------------------------------------------------------------
 * Settling the version question
 * ---------------------------------------------------------------------------------------------- */

/** One candidate the probe tried. Never carries a credential or a token. */
export interface AirwallexVersionProbe {
  readonly apiVersion: string;
  readonly outcome: AirwallexConnectionOutcome;
  readonly reason: string;
}

/** What a probe found. */
export interface AirwallexVersionProbeResult {
  readonly configId: string;
  readonly pinnedApiVersion: string;
  readonly probes: readonly AirwallexVersionProbe[];
  /** The first candidate the account accepted, or null when none was. */
  readonly acceptedApiVersion: string | null;
}

/**
 * Try the recorded candidate versions against one configuration's credentials.
 *
 * This exists for exactly one reason: STEP 165 could not settle whether the account accepts `2026-05-29` or
 * `2026-08-21`. The probe reports which candidates the API accepts and **changes nothing** — the pin is stored
 * on the configuration and an operator changes it, so a probe can never quietly move a live configuration onto a
 * version nobody chose. At most three candidates are tried, and only recorded ones.
 */
export async function probeAirwallexApiVersions(
  configId: string,
  options: {
    readonly store: AirwallexConfigStore;
    readonly keyring: EncryptionKeyring;
    readonly transport?: AirwallexClientTransport;
    readonly candidates?: readonly string[];
  },
): Promise<AirwallexVersionProbeResult | { readonly status: "failed"; readonly reason: string }> {
  const config = options.store.findById(configId);
  if (config === null) return { status: "failed", reason: "no Airwallex configuration holds that id" };
  if (config.status === "retired") return { status: "failed", reason: "the configuration is retired" };

  const requested = options.candidates ?? AIRWALLEX_VERSION_CANDIDATES;
  if (requested.length === 0) return { status: "failed", reason: "no candidate version was given" };
  if (requested.length > AIRWALLEX_MAXIMUM_VERSION_PROBES) {
    return { status: "failed", reason: `at most ${AIRWALLEX_MAXIMUM_VERSION_PROBES} candidates may be probed` };
  }
  const unrecorded = requested.find((version) => AIRWALLEX_OBSERVED_API_VERSIONS.includes(version) === false);
  if (unrecorded !== undefined) return { status: "failed", reason: `${unrecorded} is not a recorded API version` };

  let clientId: string;
  let apiKey: string;
  try {
    clientId = openSecret(options.keyring, config.clientIdSealed, { purpose: "secret", scope: airwallexClientIdScope(config.companyId) });
    apiKey = openSecret(options.keyring, config.apiKeySealed, { purpose: "secret", scope: airwallexApiKeyScope(config.companyId) });
  } catch {
    return { status: "failed", reason: "the sealed credentials cannot be opened with this keyring" };
  }

  const transport = options.transport ?? airwallexFetchTransport;
  const probes: AirwallexVersionProbe[] = [];
  let accepted: string | null = null;

  for (const candidate of requested) {
    let verdict: AirwallexLoginVerdict;
    try {
      const answer = await transport({
        method: "POST",
        environment: config.environment,
        path: AIRWALLEX_LOGIN_PATH,
        clientId,
        apiKey,
        accessToken: null,
        apiVersion: candidate,
      });
      verdict = parseAirwallexLoginAnswer(answer.status, answer.body);
    } catch {
      verdict = { outcome: "unknown", detail: "the API could not be reached" };
    }
    const outcome = outcomeOfLogin(verdict);
    const reason =
      verdict.outcome === "token_issued" ? "the API accepted this version and answered a token" : verdict.detail;
    probes.push({ apiVersion: candidate, outcome, reason });
    if (outcome === "connected" && accepted === null) accepted = candidate;
  }

  return { configId: config.id, pinnedApiVersion: config.apiVersion, probes, acceptedApiVersion: accepted };
}

/* -------------------------------------------------------------------------------------------------
 * Activation, retirement and rotation
 * ---------------------------------------------------------------------------------------------- */

/** What a transition needs. */
export interface AirwallexConfigTransitionOptions {
  readonly store: AirwallexConfigStore;
  readonly occurredAtEpochMs: number;
  readonly recordAudit?: (entry: AirwallexKeyAuditEntry) => void;
}

/** What a transition did. */
export type AirwallexTransitionResult =
  | { readonly status: "activated"; readonly config: AirwallexKeyConfig; readonly supersededConfigId: string | null }
  | { readonly status: "retired"; readonly config: AirwallexKeyConfig }
  | { readonly status: "failed"; readonly reason: string };

/**
 * Enable a configuration.
 *
 * The refusals are the point: a retired configuration cannot come back; one with no recorded test cannot be
 * enabled; one whose last test did not say `connected` cannot be enabled; and one whose test was made on another
 * version or another host than the stored ones cannot be enabled either, because that test proved something
 * else. On success the previous active configuration is superseded in the same call, so a company never has two.
 */
export function activateAirwallexConfig(
  configId: string,
  options: AirwallexConfigTransitionOptions,
): AirwallexTransitionResult {
  const config = options.store.findById(configId);
  if (config === null) return { status: "failed", reason: "no Airwallex configuration holds that id" };
  if (config.status === "retired") return { status: "failed", reason: "a retired configuration cannot be enabled again" };
  if (config.status === "active") return { status: "failed", reason: "the configuration is already active" };
  if (config.status === "superseded") return { status: "failed", reason: "a superseded configuration cannot be enabled again" };

  const test = config.lastTest;
  if (test === null) return { status: "failed", reason: "the configuration has not been tested, so nothing may be enabled" };
  if (test.outcome !== "connected") {
    return { status: "failed", reason: `the last connection test was ${test.outcome}, so the provider cannot be enabled` };
  }
  if (test.tokenProven !== true) {
    return { status: "failed", reason: "the last test issued a token but never proved it with an authenticated read" };
  }
  if (test.apiVersionSent !== config.apiVersion) {
    return { status: "failed", reason: "the last test was made on another API version than the stored one" };
  }
  if (test.baseUrlUsed !== config.baseUrl) {
    return { status: "failed", reason: "the last test was made against another host than the stored one" };
  }

  // The store keeps one active configuration per company and refuses a second, so the old one is superseded
  // first and the new one enabled second: an exchange in that order never leaves two active at once.
  const previous = options.store.findActiveByCompany(config.companyId);
  let supersededConfigId: string | null = null;
  if (previous !== null && previous.id !== config.id) {
    const superseded: AirwallexKeyConfig = {
      ...previous,
      status: "superseded",
      version: previous.version + 1,
      updatedAtEpochMs: options.occurredAtEpochMs,
    };
    if (options.store.save(superseded, previous.version) === false) {
      return { status: "failed", reason: "the active configuration moved while it was being superseded; re-read both" };
    }
    supersededConfigId = previous.id;
  }

  const next: AirwallexKeyConfig = {
    ...config,
    status: "active",
    version: config.version + 1,
    updatedAtEpochMs: options.occurredAtEpochMs,
  };
  if (options.store.save(next, config.version) === false) {
    return {
      status: "failed",
      reason:
        supersededConfigId === null
          ? "the configuration moved while it was being activated; re-read it"
          : "the configuration moved while it was being activated, and the previously active one is now superseded",
    };
  }

  options.recordAudit?.({
    action: "provider_key.activated",
    providerKey: AIRWALLEX_PROVIDER_KEY,
    companyId: next.companyId,
    configId: next.id,
    environment: next.environment,
    outcome: supersededConfigId === null ? "active" : "rotated",
    occurredAtEpochMs: options.occurredAtEpochMs,
  });

  const stored = options.store.findById(next.id);
  return { status: "activated", config: stored ?? next, supersededConfigId };
}

/** Retire one configuration, which no test and no activation may then use. */
export function retireAirwallexConfig(configId: string, options: AirwallexConfigTransitionOptions): AirwallexTransitionResult {
  const config = options.store.findById(configId);
  if (config === null) return { status: "failed", reason: "no Airwallex configuration holds that id" };
  if (config.status === "retired") return { status: "failed", reason: "the configuration is already retired" };

  const next: AirwallexKeyConfig = {
    ...config,
    status: "retired",
    version: config.version + 1,
    updatedAtEpochMs: options.occurredAtEpochMs,
  };
  if (options.store.save(next, config.version) === false) {
    return { status: "failed", reason: "the configuration moved while it was being retired; re-read it" };
  }

  options.recordAudit?.({
    action: "provider_key.retired",
    providerKey: AIRWALLEX_PROVIDER_KEY,
    companyId: next.companyId,
    configId: next.id,
    environment: next.environment,
    outcome: "retired",
    occurredAtEpochMs: options.occurredAtEpochMs,
  });

  return { status: "retired", config: options.store.findById(next.id) ?? next };
}

/** What rotating the webhook signing secret needs. */
export interface RotateAirwallexWebhookSecretOptions extends AirwallexConfigTransitionOptions {
  readonly keyring: EncryptionKeyring;
  readonly webhookSecret: string;
}

/** What rotating the webhook signing secret did. */
export type RotateAirwallexWebhookSecretResult =
  | { readonly status: "rotated"; readonly config: AirwallexKeyConfig }
  | { readonly status: "failed"; readonly reason: string };

/**
 * Replace the sealed webhook signing secret, after the subscription is re-pointed.
 *
 * STEP 165 recorded that Airwallex gives each notification URL its own secret. That makes the roll simpler than
 * Stripe's: there is one secret per URL, and once the endpoint is registered with the new one the old one is not
 * accepted by Airwallex at all. This transition therefore replaces the value and records it; STEP 169's receiver
 * verifies with whatever is stored, and the gate proves the previous envelope does not open the new one.
 */
export function rotateAirwallexWebhookSecret(
  configId: string,
  options: RotateAirwallexWebhookSecretOptions,
): RotateAirwallexWebhookSecretResult {
  const config = options.store.findById(configId);
  if (config === null) return { status: "failed", reason: "no Airwallex configuration holds that id" };
  if (config.status === "retired") return { status: "failed", reason: "the configuration is retired" };

  const secret = options.webhookSecret.trim();
  if (secret.length < AIRWALLEX_WEBHOOK_SECRET_MINIMUM_LENGTH) return { status: "failed", reason: "the webhook secret is too short to be usable" };
  if (secret.length > AIRWALLEX_WEBHOOK_SECRET_MAXIMUM_LENGTH) return { status: "failed", reason: "the webhook secret is too long" };
  if (/\s/u.test(secret)) return { status: "failed", reason: "the webhook secret must not contain whitespace" };
  if (config.webhookSecretSealed !== null) {
    // A roll to the value already stored is not a roll; the caller is told instead of being charged an audit
    // entry for a change that changed nothing.
    let stored: string | null = null;
    try {
      stored = openSecret(options.keyring, config.webhookSecretSealed, {
        purpose: "secret",
        scope: airwallexWebhookSecretScope(config.companyId),
      });
    } catch {
      return { status: "failed", reason: "the sealed webhook secret cannot be opened with this keyring" };
    }
    if (stored === secret) return { status: "failed", reason: "the webhook secret is unchanged" };
  }

  let sealed: string;
  try {
    sealed = sealSecret(options.keyring, secret, { purpose: "secret", scope: airwallexWebhookSecretScope(config.companyId) });
  } catch {
    return { status: "failed", reason: "the encryption keyring cannot seal a credential" };
  }

  const next: AirwallexKeyConfig = {
    ...config,
    webhookSecretSealed: sealed,
    version: config.version + 1,
    updatedAtEpochMs: options.occurredAtEpochMs,
  };
  if (options.store.save(next, config.version) === false) {
    return { status: "failed", reason: "the configuration moved while its secret was being rotated; re-read it" };
  }

  options.recordAudit?.({
    action: "provider_webhook_secret.rotated",
    providerKey: AIRWALLEX_PROVIDER_KEY,
    companyId: next.companyId,
    configId: next.id,
    environment: next.environment,
    outcome: config.webhookSecretSealed === null ? "configured" : "rotated",
    occurredAtEpochMs: options.occurredAtEpochMs,
  });

  return { status: "rotated", config: options.store.findById(next.id) ?? next };
}

/* -------------------------------------------------------------------------------------------------
 * The token a later STEP uses
 * ---------------------------------------------------------------------------------------------- */

/**
 * The token an authenticated call needs, from the cache when it is still good and from a fresh login otherwise.
 *
 * This is the only way a later STEP gets a token, and it is deliberately narrow: the token is returned to the
 * caller, cached in memory, and never written anywhere. Only an `active` configuration may produce one, so a key
 * nobody enabled cannot quietly make calls.
 */
export async function airwallexAccessTokenFor(
  configId: string,
  options: {
    readonly store: AirwallexConfigStore;
    readonly keyring: EncryptionKeyring;
    readonly tokenCache: AirwallexTokenCache;
    readonly nowEpochMs: number;
    readonly transport?: AirwallexClientTransport;
  },
): Promise<
  | { readonly status: "token"; readonly token: string; readonly expiresAtEpochMs: number; readonly fromCache: boolean }
  | { readonly status: "failed"; readonly reason: string }
> {
  const config = options.store.findById(configId);
  if (config === null) return { status: "failed", reason: "no Airwallex configuration holds that id" };
  if (config.status !== "active") return { status: "failed", reason: "only an active configuration may obtain an access token" };

  const cached = options.tokenCache.get(config.id);
  if (cached !== null && airwallexTokenIsUsable(cached, options.nowEpochMs)) {
    return { status: "token", token: cached.token, expiresAtEpochMs: cached.expiresAtEpochMs, fromCache: true };
  }

  let clientId: string;
  let apiKey: string;
  try {
    clientId = openSecret(options.keyring, config.clientIdSealed, { purpose: "secret", scope: airwallexClientIdScope(config.companyId) });
    apiKey = openSecret(options.keyring, config.apiKeySealed, { purpose: "secret", scope: airwallexApiKeyScope(config.companyId) });
  } catch {
    return { status: "failed", reason: "the sealed credentials cannot be opened with this keyring" };
  }

  let login: AirwallexLoginVerdict;
  try {
    const answer = await (options.transport ?? airwallexFetchTransport)({
      method: "POST",
      environment: config.environment,
      path: AIRWALLEX_LOGIN_PATH,
      clientId,
      apiKey,
      accessToken: null,
      apiVersion: config.apiVersion,
    });
    login = parseAirwallexLoginAnswer(answer.status, answer.body);
  } catch {
    return { status: "failed", reason: "the API could not be reached, so no token was obtained" };
  }

  if (login.outcome !== "token_issued") {
    return { status: "failed", reason: login.outcome === "version_rejected" ? `${login.detail}; the pinned version may be wrong` : login.detail };
  }

  options.tokenCache.set(config.id, { token: login.token, expiresAtEpochMs: login.expiresAtEpochMs });
  return { status: "token", token: login.token, expiresAtEpochMs: login.expiresAtEpochMs, fromCache: false };
}

/** The documented token lifetime, exported so a caller can budget its cache. */
export const AIRWALLEX_TOKEN_CACHE_BUDGET_SECONDS = AIRWALLEX_TOKEN_LIFETIME_SECONDS;
