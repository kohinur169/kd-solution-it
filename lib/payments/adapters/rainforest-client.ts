// path: lib/payments/adapters/rainforest-client.ts

/**
 * The Rainforest adapter's encrypted key configuration, connection test and key rotation: the service
 * that stores Rainforest's API key sealed at rest, proves it against Rainforest's API, and activates
 * it only after that proof.
 *
 * ## What the feature list asks for
 *
 * Section 6: "Keys are AES-256-GCM encrypted before storage. The encryption key exists only in
 * environment variables. After saving, a full key is never shown again. Only the last characters and
 * last updated time are shown. A provider cannot be enabled when its connection test fails."
 *
 * Section 29: "Provider keys ... entered in admin screens are AES-256-GCM encrypted at rest and
 * shown only masked." And: "Key rotation procedure exists for provider keys and email secrets: add
 * new key, run connection test, activate, then remove the old key. Every rotation is audit logged."
 *
 * This file is that procedure for Rainforest, in that order: `configureRainforestKeys` adds a key in
 * `pending_activation`, `testRainforestConnection` proves it against the API, and
 * `activateRainforestConfig` refuses unless that proof succeeded — which is what makes "cannot be
 * enabled when its connection test fails" a property of the code rather than a promise. The old key
 * stays readable through the rotation window and is removed with `retireRainforestConfig`.
 *
 * ## Which credential Rainforest takes
 *
 * Rainforest authenticates platform calls with a bearer API key (STEP 157 recorded the rule and its
 * sources in `lib/payments/adapters/rainforest.ts` and `docs/final/PROVIDER_DOCS.md`): production keys
 * are prefixed `apikey_`, sandbox keys are prefixed `sbx_apikey_`, and the key is a server credential
 * that must never reach a browser. So the configuration is the API key and the environment — and the
 * documented prefix is checked against the environment before anything is sealed, because a sandbox
 * key stored as a production key would be silently useless at the production base URL.
 *
 * ## How it is encrypted, and why not with a cipher of its own
 *
 * `lib/security/encryption.ts` seals secrets with authenticated encryption and binds every envelope to
 * an additional-data string of `kd-aad-v1|<purpose>|<scope>`. This file does not run a cipher itself:
 * it seals through that module, so the repository keeps one secret format, one keyring and one
 * rotation story rather than another copy. The scope binds every sealed value to one company and one
 * provider:
 *
 *     gateway:<companyId>:rainforest:api_key
 *
 * Copying a sealed API key into another company's row or into another provider's row therefore fails
 * to open rather than returning a secret, and the envelope names its key id, so a rotated keyring
 * opens what it wrote and writes with the new key.
 *
 * ## What the connection test proves, and what it does not
 *
 * The test performs the documented authenticated read `GET /v1/api_keys` against
 * `https://api.sandbox.rainforestpay.com` or `https://api.rainforestpay.com`, sending the documented
 * `Authorization: Bearer` header and the documented `Rainforest-Api-Version` header explicitly (the
 * platform's minimum version is a portal setting the documentation does not expose). A `2XX` with a
 * parseable body means the key authenticated against that environment, because sandbox and production
 * keys and data are separate — so the test reports `apiKeyAccepted: true` and
 * `environmentVerified: true`.
 *
 * It does not prove anything about payments or merchants: no payin is created and no merchant is read.
 * Those are STEP 159 and STEP 160, and they may only run once this key is active. The count of keys the
 * read listed is reported; the keys themselves are never read into the result.
 *
 * ## What this file is not
 *
 * It is not the acceptance adapter (STEP 159) and not the webhook receiver (STEP 160). It is not the
 * admin screen: no route, component or permission check is added here, and the caller passes its own
 * store, keyring, audit writer and clock. It is not an environment reader: the keyring comes from the
 * caller, which reads it from the environment once at boot, exactly as `lib/security/encryption.ts`
 * requires.
 */

import { randomUUID } from "node:crypto";
import { isSecretEnvelope, openSecret, sealSecret, type EncryptionKeyring } from "../../security/encryption.ts";
import {
  isRainforestApiKeyShaped,
  RAINFOREST_API_VERSION,
  RAINFOREST_API_VERSION_HEADER,
  RAINFOREST_PROVIDER_KEY,
  rainforestApiBaseFor,
  rainforestEnvironmentOfApiKey,
  sanitizeRainforestText,
  type RainforestEnvironment,
} from "./rainforest.ts";

/* -------------------------------------------------------------------------------------------------
 * Endpoint and vocabulary
 * ---------------------------------------------------------------------------------------------- */

/**
 * The documented API version and its request header, re-exported so a caller of this service has one
 * entry point for the Rainforest credential rules.
 */
export { RAINFOREST_API_VERSION, RAINFOREST_API_VERSION_HEADER } from "./rainforest.ts";

/** The documented authenticated read the connection test performs. */
export const RAINFOREST_API_KEYS_PATH = "/v1/api_keys";

/** The authorization scope of a sealed API key, for one company. */
export function rainforestApiKeyScope(companyId: string): string {
  return `gateway:${companyId}:${RAINFOREST_PROVIDER_KEY}:api_key`;
}

/** The documented key-list endpoint of an environment; the connection test calls here. */
export function rainforestKeyListEndpointFor(environment: RainforestEnvironment): string {
  return `${rainforestApiBaseFor(environment)}${RAINFOREST_API_KEYS_PATH}`;
}

/** The configuration statuses: a key is added, then activated, then eventually retired. */
export type RainforestConfigStatus = "pending_activation" | "active" | "superseded" | "retired";

/** The outcomes a connection test can have. */
export type RainforestConnectionOutcome = "connected" | "rejected" | "unreachable" | "failed" | "invalid_configuration";

/** The largest API answer this file reads. */
export const RAINFOREST_API_ANSWER_MAXIMUM_BYTES = 65_536;

/** The longest provider text this file keeps. */
export const RAINFOREST_CLIENT_TEXT_MAXIMUM_LENGTH = 200;

/** The documented API key prefixes, as the environment check names them. */
export const RAINFOREST_SANDBOX_API_KEY_PREFIX = "sbx_apikey_";

/** The documented production API key prefix. */
export const RAINFOREST_PRODUCTION_API_KEY_PREFIX = "apikey_";

/* -------------------------------------------------------------------------------------------------
 * Validation patterns
 * ---------------------------------------------------------------------------------------------- */

/** A company id: the platform's own id shape. */
export const RAINFOREST_COMPANY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;

/** A documented API key: one of the two prefixes, then an opaque run of URL-safe characters. */
export const RAINFOREST_API_KEY_PATTERN = /^(?:sbx_apikey_|apikey_)[A-Za-z0-9_-]{16,256}$/u;

/* -------------------------------------------------------------------------------------------------
 * The configuration record
 * ---------------------------------------------------------------------------------------------- */

/** The last connection test recorded against one configuration. */
export interface RainforestConnectionTest {
  readonly outcome: RainforestConnectionOutcome;
  readonly testedAtEpochMs: number;
  /** The environment the read ran against; a production key is never proven by a sandbox read. */
  readonly environment: RainforestEnvironment;
}

/** One Rainforest key configuration: the sealed key, the environment, the status and the bookkeeping. */
export interface RainforestKeyConfig {
  readonly id: string;
  readonly companyId: string;
  readonly environment: RainforestEnvironment;
  /** The sealed envelope of the API key, bound to this company and provider. */
  readonly apiKeySealed: string;
  /** The documented prefix of the stored key: an environment marker, not key material. */
  readonly apiKeyPrefix: string;
  readonly status: RainforestConfigStatus;
  readonly version: number;
  readonly lastTest: RainforestConnectionTest | null;
  readonly createdAtEpochMs: number;
  readonly updatedAtEpochMs: number;
}

/** What the store reads and writes. The store is the caller's; PostgreSQL owns the real rows. */
export interface RainforestConfigStore {
  insert(config: RainforestKeyConfig): void;
  findById(id: string): RainforestKeyConfig | null;
  /** Every configuration of one company, in any status. */
  findByCompany(companyId: string): RainforestKeyConfig[];
  /** The active configuration of one company, or null. */
  findActiveByCompany(companyId: string): RainforestKeyConfig | null;
  /** The configuration of one company that is waiting for its connection test, or null. */
  findPendingByCompany(companyId: string): RainforestKeyConfig | null;
  /** Write the next record only when the stored version is `expectedVersion` and it advances by one. */
  save(next: RainforestKeyConfig, expectedVersion: number): boolean;
}

/**
 * The in-memory store: a reference implementation that enforces the invariants the flow rests on —
 * one pending configuration per company, one active configuration per company, an immutable
 * company/environment/id/sealed key, and a strictly increasing version.
 */
export class InMemoryRainforestConfigStore implements RainforestConfigStore {
  private readonly configs = new Map<string, RainforestKeyConfig>();

  insert(config: RainforestKeyConfig): void {
    if (this.configs.has(config.id)) throw new Error("duplicate configuration id");
    if (config.version !== 1) throw new Error("a new configuration starts at version 1");
    // A key is only ever added waiting for its test: the only route to `active` is a passing test.
    if (config.status !== "pending_activation") throw new Error("a new configuration waits for its connection test");
    if (this.findPendingByCompany(config.companyId) !== null) {
      throw new Error("this company already has a key waiting for its connection test");
    }
    this.configs.set(config.id, config);
  }

  findById(id: string): RainforestKeyConfig | null {
    return this.configs.get(id) ?? null;
  }

  findByCompany(companyId: string): RainforestKeyConfig[] {
    return [...this.configs.values()].filter((config) => config.companyId === companyId);
  }

  findActiveByCompany(companyId: string): RainforestKeyConfig | null {
    return this.findByCompany(companyId).find((config) => config.status === "active") ?? null;
  }

  findPendingByCompany(companyId: string): RainforestKeyConfig | null {
    return this.findByCompany(companyId).find((config) => config.status === "pending_activation") ?? null;
  }

  save(next: RainforestKeyConfig, expectedVersion: number): boolean {
    const current = this.configs.get(next.id);
    if (current === undefined) return false;
    if (current.companyId !== next.companyId || current.environment !== next.environment) return false;
    if (current.version !== expectedVersion) return false;
    if (next.version !== expectedVersion + 1) return false;
    if (current.apiKeySealed !== next.apiKeySealed || current.apiKeyPrefix !== next.apiKeyPrefix) return false;
    if (next.status === "active" && current.status !== "pending_activation" && current.status !== "active") return false;
    // The section 6 rule at the store: a key cannot become active without a passing test on itself.
    if (next.status === "active" && current.status === "pending_activation" && next.lastTest?.outcome !== "connected") {
      return false;
    }
    if (next.status === "retired" && current.status === "retired") return false;
    if (next.status === "pending_activation" && current.status !== "pending_activation") return false;
    if (next.status === "active" && this.findActiveByCompany(next.companyId) !== null) {
      const active = this.findActiveByCompany(next.companyId);
      if (active !== null && active.id !== next.id) return false;
    }
    this.configs.set(next.id, next);
    return true;
  }
}

/* -------------------------------------------------------------------------------------------------
 * The masked view
 * ---------------------------------------------------------------------------------------------- */

/** What an admin screen may show: the masked key, its prefix, the status and the bookkeeping. */
export interface RainforestKeyView {
  readonly id: string;
  readonly companyId: string;
  readonly environment: RainforestEnvironment;
  readonly apiKeyMasked: string;
  /** The documented prefix, which is what names the environment without naming the key. */
  readonly apiKeyPrefix: string;
  readonly status: RainforestConfigStatus;
  readonly lastTestOutcome: RainforestConnectionOutcome | null;
  readonly lastTestedAtEpochMs: number | null;
  readonly updatedAtEpochMs: number;
}

/**
 * Mask a credential for display: keep the last four characters, hide the rest.
 *
 * The last four are what section 6 allows ("Only the last characters and last updated time are
 * shown"), and a value of four characters or fewer is hidden entirely rather than shown whole.
 */
export function maskRainforestCredential(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 4) return "*".repeat(Math.max(1, trimmed.length));
  return `${"*".repeat(Math.min(12, trimmed.length - 4))}${trimmed.slice(-4)}`;
}

/* -------------------------------------------------------------------------------------------------
 * Audit
 * ---------------------------------------------------------------------------------------------- */

/** One audit entry this file hands to the caller's audit writer. Never carries a credential. */
export interface RainforestKeyAuditEntry {
  readonly action:
    | "provider_key.configured"
    | "provider_key.tested"
    | "provider_key.activated"
    | "provider_key.rotated"
    | "provider_key.retired";
  readonly providerKey: typeof RAINFOREST_PROVIDER_KEY;
  readonly companyId: string;
  readonly configId: string;
  readonly environment: RainforestEnvironment;
  readonly outcome: string;
  readonly occurredAtEpochMs: number;
}

/* -------------------------------------------------------------------------------------------------
 * Configuration
 * ---------------------------------------------------------------------------------------------- */

/** The credential an admin enters. It exists in memory for the length of this call only. */
export interface ConfigureRainforestKeysInput {
  readonly companyId: string;
  readonly environment: RainforestEnvironment;
  readonly apiKey: string;
}

/** The options a configuration needs. */
export interface ConfigureRainforestKeysOptions {
  readonly store: RainforestConfigStore;
  /** The keyring the environment supplies: one primary key, optional previous keys while rotating. */
  readonly keyring: EncryptionKeyring;
  readonly occurredAtEpochMs: number;
  readonly recordAudit?: (entry: RainforestKeyAuditEntry) => void;
}

/** What configuring a key did. */
export type ConfigureRainforestKeysResult =
  | { readonly status: "configured"; readonly view: RainforestKeyView; readonly config: RainforestKeyConfig }
  | { readonly status: "failed"; readonly reason: string };

/**
 * The validation failure of an input, or null when it is valid.
 *
 * The prefix check is the important one: the documented prefixes are the only way to tell a sandbox
 * key from a production key, and a mismatched pair would send the wrong key to the wrong base URL and
 * report a rejection that says nothing about the key the admin meant to configure.
 */
export function validateRainforestCredentials(input: ConfigureRainforestKeysInput): string | null {
  if (RAINFOREST_COMPANY_ID_PATTERN.test(input.companyId) === false) return "the company id is invalid";
  if (input.environment !== "sandbox" && input.environment !== "production") {
    return "the environment must be sandbox or production";
  }
  if (isRainforestApiKeyShaped(input.apiKey) === false || RAINFOREST_API_KEY_PATTERN.test(input.apiKey) === false) {
    return "the API key must carry the documented apikey_ or sbx_apikey_ prefix and at least 16 characters after it";
  }
  const keyEnvironment = rainforestEnvironmentOfApiKey(input.apiKey);
  if (keyEnvironment !== input.environment) {
    return input.environment === "sandbox"
      ? "the API key is a production key, but the configuration names the sandbox environment"
      : "the API key is a sandbox key, but the configuration names the production environment";
  }
  return null;
}

/**
 * Add a Rainforest key configuration, sealed and waiting for its connection test.
 *
 * The key is validated before anything is sealed, so an invalid value never becomes an envelope; it is
 * sealed for this company and this provider only; and the configuration is stored in
 * `pending_activation`, because section 6 says a provider "cannot be enabled when its connection test
 * fails" and a key that was never tested has no proof. Only one key per company can wait for a test at
 * a time, so a half-finished rotation cannot leave two unproven keys behind.
 */
export function configureRainforestKeys(
  input: ConfigureRainforestKeysInput,
  options: ConfigureRainforestKeysOptions,
): ConfigureRainforestKeysResult {
  const invalid = validateRainforestCredentials(input);
  if (invalid !== null) return { status: "failed", reason: invalid };

  const pending = options.store.findPendingByCompany(input.companyId);
  if (pending !== null) {
    return { status: "failed", reason: "this company already has a key waiting for its connection test" };
  }

  let apiKeySealed: string;
  try {
    apiKeySealed = sealSecret(options.keyring, input.apiKey, {
      purpose: "secret",
      scope: rainforestApiKeyScope(input.companyId),
    });
  } catch {
    // The keyring is unusable: nothing is written and no reason describes the key material.
    return { status: "failed", reason: "the encryption keyring cannot seal a credential" };
  }

  const prefix = input.environment === "sandbox" ? RAINFOREST_SANDBOX_API_KEY_PREFIX : RAINFOREST_PRODUCTION_API_KEY_PREFIX;
  const config: RainforestKeyConfig = {
    id: randomUUID(),
    companyId: input.companyId,
    environment: input.environment,
    apiKeySealed,
    apiKeyPrefix: prefix,
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

  if (options.recordAudit !== undefined) {
    options.recordAudit({
      action: "provider_key.configured",
      providerKey: RAINFOREST_PROVIDER_KEY,
      companyId: config.companyId,
      configId: config.id,
      environment: config.environment,
      outcome: "pending_activation",
      occurredAtEpochMs: options.occurredAtEpochMs,
    });
  }

  return {
    status: "configured",
    config,
    view: viewOf(config, input.apiKey),
  };
}

/** Build the masked view from the plaintext a configuring call still holds. */
function viewOf(config: RainforestKeyConfig, apiKey: string): RainforestKeyView {
  return {
    id: config.id,
    companyId: config.companyId,
    environment: config.environment,
    apiKeyMasked: maskRainforestCredential(apiKey),
    apiKeyPrefix: config.apiKeyPrefix,
    status: config.status,
    lastTestOutcome: config.lastTest === null ? null : config.lastTest.outcome,
    lastTestedAtEpochMs: config.lastTest === null ? null : config.lastTest.testedAtEpochMs,
    updatedAtEpochMs: config.updatedAtEpochMs,
  };
}

/**
 * Read the masked view of a stored configuration.
 *
 * The plaintext is opened only to be masked, so the screen can show which key is stored without ever
 * holding a form field that carries it. A configuration whose envelope no longer opens — a rotation
 * that dropped a key too early — is reported as unreadable rather than shown blank.
 */
export function rainforestKeyViewOf(
  config: RainforestKeyConfig,
  keyring: EncryptionKeyring,
):
  | { readonly status: "shown"; readonly view: RainforestKeyView }
  | { readonly status: "failed"; readonly reason: string } {
  try {
    const apiKey = openSecret(keyring, config.apiKeySealed, {
      purpose: "secret",
      scope: rainforestApiKeyScope(config.companyId),
    });
    return { status: "shown", view: viewOf(config, apiKey) };
  } catch {
    return { status: "failed", reason: "the sealed credentials cannot be opened with this keyring" };
  }
}

/* -------------------------------------------------------------------------------------------------
 * The API transport
 * ---------------------------------------------------------------------------------------------- */

/** The HTTP answer of an API read: the status code and the raw body. */
export interface RainforestApiAnswer {
  readonly status: number;
  readonly body: string;
}

/** The transport port: endpoint and key in; the raw answer out. */
export type RainforestApiTransport = (endpoint: string, apiKey: string) => Promise<RainforestApiAnswer>;

/**
 * Performs the documented authenticated read against the documented API base.
 *
 * The endpoint is allowlisted to the two environments' key-list URLs, the call is refused without a
 * key, redirects are refused (a redirect is not an answer), the timeout is bounded and an oversized
 * answer is refused. The documented `Rainforest-Api-Version` header is always sent, so the test does
 * not depend on the platform's portal-side minimum version. A throw means the host was not reached,
 * never that the key was wrong.
 */
export const rainforestFetchApiTransport: RainforestApiTransport = async (endpoint, apiKey) => {
  if (endpoint !== rainforestKeyListEndpointFor("sandbox") && endpoint !== rainforestKeyListEndpointFor("production")) {
    throw new Error("invalid API endpoint");
  }
  if (apiKey.trim().length === 0) throw new Error("an API key is required");

  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      [RAINFOREST_API_VERSION_HEADER]: RAINFOREST_API_VERSION,
    },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });

  const text = await response.text();
  if (text.length > RAINFOREST_API_ANSWER_MAXIMUM_BYTES) throw new Error("invalid API answer");
  return { status: response.status, body: text };
};

/* -------------------------------------------------------------------------------------------------
 * The connection test
 * ---------------------------------------------------------------------------------------------- */

/** What a key-list answer means for the configuration it was made with. */
export type RainforestKeyListVerdict =
  | { readonly outcome: "connected"; readonly keysVisible: number | null }
  | { readonly outcome: "rejected"; readonly detail: string }
  | { readonly outcome: "unreachable"; readonly detail: string }
  | { readonly outcome: "failed"; readonly detail: string };

/** Read one provider message out of an answer, sanitised, or the empty string. */
function providerMessageOf(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "";
  const record = payload as Readonly<Record<string, unknown>>;
  for (const key of ["message", "detail", "title", "error", "error_description"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return sanitizeRainforestText(value).slice(0, RAINFOREST_CLIENT_TEXT_MAXIMUM_LENGTH);
    }
  }
  const errors = record["errors"];
  if (Array.isArray(errors)) {
    for (const entry of errors) {
      if (typeof entry === "string" && entry.trim().length > 0) {
        return sanitizeRainforestText(entry).slice(0, RAINFOREST_CLIENT_TEXT_MAXIMUM_LENGTH);
      }
      if (typeof entry === "object" && entry !== null) {
        const message = (entry as Readonly<Record<string, unknown>>)["message"];
        if (typeof message === "string" && message.trim().length > 0) {
          return sanitizeRainforestText(message).slice(0, RAINFOREST_CLIENT_TEXT_MAXIMUM_LENGTH);
        }
      }
    }
  }
  return "";
}

/** Count the entries a list answer carried, without reading any of them. */
function listedCountOf(payload: unknown): number | null {
  if (Array.isArray(payload)) return payload.length;
  if (typeof payload !== "object" || payload === null) return null;
  const data = (payload as Readonly<Record<string, unknown>>)["data"];
  return Array.isArray(data) ? data.length : null;
}

/**
 * Read a key-list answer.
 *
 * `401` and `403` are the only statuses that judge the key, so they are the only ones that reject the
 * credentials; the documented `errors` answer is sanitised into the reason. A timeout-class code,
 * `429` or any `5xx` is unreachable, because the key was never judged. A `400` means the request
 * itself was refused — the documented cause is an API version below the platform's minimum — so the
 * key is not proven either way and the outcome is `failed`. A `2XX` with a parseable body is the proof
 * the key authenticated against that environment; a `2XX` with an empty or unparseable body proves
 * nothing and is `failed`.
 */
export function parseRainforestKeyListAnswer(status: number, body: string): RainforestKeyListVerdict {
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return { outcome: "unreachable", detail: "the API did not answer finally; retry later" };
  }

  let payload: unknown;
  try {
    payload = body.trim().length === 0 ? null : (JSON.parse(body) as unknown);
  } catch {
    payload = null;
  }

  if (status === 401 || status === 403) {
    const message = providerMessageOf(payload);
    return {
      outcome: "rejected",
      detail: message.length > 0 ? message : "the API rejected the API key",
    };
  }

  if (status === 400) {
    const message = providerMessageOf(payload);
    return {
      outcome: "failed",
      detail:
        message.length > 0
          ? message
          : "the API refused the request, so the key was not proven; the API version may be below the platform minimum",
    };
  }

  if (status >= 300 && status < 400) {
    return { outcome: "failed", detail: "the API answered with a redirect, which proves nothing" };
  }

  if (status < 200 || status >= 300) {
    const message = providerMessageOf(payload);
    return {
      outcome: "failed",
      detail: message.length > 0 ? message : `the API refused the read with status ${status}`,
    };
  }

  if (payload === null || typeof payload !== "object") {
    return { outcome: "failed", detail: "the answer carries no readable body, so nothing was proven" };
  }

  return { outcome: "connected", keysVisible: listedCountOf(payload) };
}

/** The options a connection test needs. */
export interface TestRainforestConnectionOptions {
  readonly store: RainforestConfigStore;
  readonly keyring: EncryptionKeyring;
  readonly occurredAtEpochMs: number;
  readonly transport?: RainforestApiTransport;
  readonly recordAudit?: (entry: RainforestKeyAuditEntry) => void;
}

/** What one connection test did. Never carries the key. */
export interface RainforestConnectionResult {
  readonly outcome: RainforestConnectionOutcome;
  readonly configId: string | null;
  readonly environment: RainforestEnvironment | null;
  readonly reason: string;
  /** True only when the API answered a `2XX` to an authenticated read with this key. */
  readonly apiKeyAccepted: boolean;
  /** True with `apiKeyAccepted`: the two environments are separate, so the key belongs to this one. */
  readonly environmentVerified: boolean;
  /** The documented version header this test sent. */
  readonly apiVersionSent: string;
  /** How many keys the read listed, or null when the answer carried no list. Never the keys. */
  readonly keysVisible: number | null;
  readonly testedAtEpochMs: number;
  readonly version: number | null;
}

/**
 * Test one stored configuration against Rainforest's API.
 *
 * The plaintext is opened in memory, used for exactly one read, and dropped. The outcome is written
 * back onto the configuration as its `lastTest`, because activation reads it — a test that is not
 * recorded cannot authorize anything. A rejected or unreachable outcome is recorded too, so an
 * activation attempt after a failure is refused by the record rather than by a caller's memory.
 */
export async function testRainforestConnection(
  configId: string,
  options: TestRainforestConnectionOptions,
): Promise<RainforestConnectionResult> {
  const config = options.store.findById(configId);

  if (config === null) {
    return {
      outcome: "invalid_configuration",
      configId: null,
      environment: null,
      reason: "no Rainforest key configuration holds that id",
      apiKeyAccepted: false,
      environmentVerified: false,
      apiVersionSent: RAINFOREST_API_VERSION,
      keysVisible: null,
      testedAtEpochMs: options.occurredAtEpochMs,
      version: null,
    };
  }

  if (config.status === "retired") {
    return {
      outcome: "invalid_configuration",
      configId: config.id,
      environment: config.environment,
      reason: "the configuration is retired and can no longer be tested",
      apiKeyAccepted: false,
      environmentVerified: false,
      apiVersionSent: RAINFOREST_API_VERSION,
      keysVisible: null,
      testedAtEpochMs: options.occurredAtEpochMs,
      version: config.version,
    };
  }

  let apiKey: string;
  try {
    apiKey = openSecret(options.keyring, config.apiKeySealed, {
      purpose: "secret",
      scope: rainforestApiKeyScope(config.companyId),
    });
  } catch {
    return {
      outcome: "invalid_configuration",
      configId: config.id,
      environment: config.environment,
      reason: "the sealed credentials cannot be opened with this keyring",
      apiKeyAccepted: false,
      environmentVerified: false,
      apiVersionSent: RAINFOREST_API_VERSION,
      keysVisible: null,
      testedAtEpochMs: options.occurredAtEpochMs,
      version: config.version,
    };
  }

  let verdict: RainforestKeyListVerdict;
  try {
    const answer = await (options.transport ?? rainforestFetchApiTransport)(
      rainforestKeyListEndpointFor(config.environment),
      apiKey,
    );
    verdict = parseRainforestKeyListAnswer(answer.status, answer.body);
  } catch {
    verdict = { outcome: "unreachable", detail: "the API could not be reached" };
  }

  const outcome: RainforestConnectionOutcome = verdict.outcome;
  const next: RainforestKeyConfig = {
    ...config,
    version: config.version + 1,
    lastTest: { outcome, testedAtEpochMs: options.occurredAtEpochMs, environment: config.environment },
    updatedAtEpochMs: options.occurredAtEpochMs,
  };
  const stored = options.store.save(next, config.version);
  const recorded = stored ? next : options.store.findById(config.id);

  if (options.recordAudit !== undefined) {
    options.recordAudit({
      action: "provider_key.tested",
      providerKey: RAINFOREST_PROVIDER_KEY,
      companyId: config.companyId,
      configId: config.id,
      environment: config.environment,
      outcome,
      occurredAtEpochMs: options.occurredAtEpochMs,
    });
  }

  return {
    outcome,
    configId: config.id,
    environment: config.environment,
    reason: verdict.outcome === "connected" ? "the API accepted the key and listed its keys" : verdict.detail,
    apiKeyAccepted: verdict.outcome === "connected",
    environmentVerified: verdict.outcome === "connected",
    apiVersionSent: RAINFOREST_API_VERSION,
    keysVisible: verdict.outcome === "connected" ? verdict.keysVisible : null,
    testedAtEpochMs: options.occurredAtEpochMs,
    version: recorded === null ? null : recorded.version,
  };
}

/* -------------------------------------------------------------------------------------------------
 * Activation and retirement
 * ---------------------------------------------------------------------------------------------- */

/** The options activation and retirement need. */
export interface RainforestConfigTransitionOptions {
  readonly store: RainforestConfigStore;
  readonly occurredAtEpochMs: number;
  readonly recordAudit?: (entry: RainforestKeyAuditEntry) => void;
}

/** What a transition did. */
export type RainforestTransitionResult =
  | { readonly status: "activated"; readonly config: RainforestKeyConfig; readonly supersededConfigId: string | null }
  | { readonly status: "retired"; readonly config: RainforestKeyConfig }
  | { readonly status: "failed"; readonly reason: string };

/**
 * Activate a configuration whose connection test passed.
 *
 * The refusal order is the section 6 rule made concrete: a configuration must exist, must not be
 * retired, must be the pending one, and must carry a `connected` test recorded by this file for its
 * own environment. Only then does the previous active configuration become `superseded` and this one
 * become `active`, both writes version-guarded, with one audit entry for the activation and one for
 * the rotation when there was a predecessor.
 */
export function activateRainforestConfig(
  configId: string,
  options: RainforestConfigTransitionOptions,
): RainforestTransitionResult {
  const config = options.store.findById(configId);
  if (config === null) return { status: "failed", reason: "no Rainforest key configuration holds that id" };
  if (config.status === "retired") return { status: "failed", reason: "a retired configuration cannot be activated" };
  if (config.status === "active") return { status: "failed", reason: "the configuration is already active" };
  if (config.status === "superseded") {
    return { status: "failed", reason: "a superseded configuration cannot be activated again; add a new key instead" };
  }
  if (config.status !== "pending_activation") {
    return { status: "failed", reason: "the configuration is not waiting for activation" };
  }
  if (config.lastTest === null) {
    return { status: "failed", reason: "the connection test has not been run for this key" };
  }
  if (config.lastTest.outcome !== "connected") {
    return { status: "failed", reason: "the last connection test did not pass, so this key cannot be activated" };
  }
  if (config.lastTest.environment !== config.environment) {
    return { status: "failed", reason: "the connection test ran against another environment" };
  }

  const previousActive = options.store.findActiveByCompany(config.companyId);

  if (previousActive !== null && previousActive.id !== config.id) {
    const superseded: RainforestKeyConfig = {
      ...previousActive,
      status: "superseded",
      version: previousActive.version + 1,
      updatedAtEpochMs: options.occurredAtEpochMs,
    };
    if (options.store.save(superseded, previousActive.version) === false) {
      return { status: "failed", reason: "the active key changed while this key was being activated" };
    }
  }

  const activated: RainforestKeyConfig = {
    ...config,
    status: "active",
    version: config.version + 1,
    updatedAtEpochMs: options.occurredAtEpochMs,
  };
  if (options.store.save(activated, config.version) === false) {
    return { status: "failed", reason: "the key changed while it was being activated" };
  }

  if (options.recordAudit !== undefined) {
    options.recordAudit({
      action: "provider_key.activated",
      providerKey: RAINFOREST_PROVIDER_KEY,
      companyId: activated.companyId,
      configId: activated.id,
      environment: activated.environment,
      outcome: "active",
      occurredAtEpochMs: options.occurredAtEpochMs,
    });

    if (previousActive !== null && previousActive.id !== config.id) {
      options.recordAudit({
        action: "provider_key.rotated",
        providerKey: RAINFOREST_PROVIDER_KEY,
        companyId: activated.companyId,
        configId: previousActive.id,
        environment: previousActive.environment,
        outcome: "superseded",
        occurredAtEpochMs: options.occurredAtEpochMs,
      });
    }
  }

  return {
    status: "activated",
    config: activated,
    supersededConfigId: previousActive === null || previousActive.id === config.id ? null : previousActive.id,
  };
}

/**
 * Remove a configuration the rotation has finished with.
 *
 * The active key cannot be retired — that would leave the provider with no usable credential — and a
 * retired key cannot be retired twice. A pending key may be retired, which is how an aborted rotation
 * is cancelled before it ever activates anything.
 */
export function retireRainforestConfig(
  configId: string,
  options: RainforestConfigTransitionOptions,
): RainforestTransitionResult {
  const config = options.store.findById(configId);
  if (config === null) return { status: "failed", reason: "no Rainforest key configuration holds that id" };
  if (config.status === "retired") return { status: "failed", reason: "the configuration is already retired" };
  if (config.status === "active") {
    return { status: "failed", reason: "the active key cannot be retired; activate its replacement first" };
  }

  const retired: RainforestKeyConfig = {
    ...config,
    status: "retired",
    version: config.version + 1,
    updatedAtEpochMs: options.occurredAtEpochMs,
  };
  if (options.store.save(retired, config.version) === false) {
    return { status: "failed", reason: "the key changed while it was being retired" };
  }

  if (options.recordAudit !== undefined) {
    options.recordAudit({
      action: "provider_key.retired",
      providerKey: RAINFOREST_PROVIDER_KEY,
      companyId: retired.companyId,
      configId: retired.id,
      environment: retired.environment,
      outcome: "retired",
      occurredAtEpochMs: options.occurredAtEpochMs,
    });
  }

  return { status: "retired", config: retired };
}

/* -------------------------------------------------------------------------------------------------
 * The sealed-shape check
 * ---------------------------------------------------------------------------------------------- */

/**
 * True when the stored key of a configuration is a sealed envelope this platform wrote.
 *
 * The check exists so a stored configuration can be audited without opening it: an envelope names its
 * key id and its format, and a plaintext credential cannot accidentally pass for one.
 */
export function rainforestConfigIsSealed(config: RainforestKeyConfig): boolean {
  return isSecretEnvelope(config.apiKeySealed);
}
