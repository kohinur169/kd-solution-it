// path: lib/payments/adapters/payoneer-client.ts

/**
 * The Payoneer adapter's encrypted key configuration, connection test and key rotation: the service
 * that stores Payoneer's OAuth2 credentials sealed at rest, proves them against Payoneer's
 * authorization host, and activates them only after that proof.
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
 * This file is that procedure for Payoneer, in that order: `configurePayoneerKeys` adds a key in
 * `pending_activation`, `testPayoneerConnection` proves it against the authorization host, and
 * `activatePayoneerConfig` refuses unless that proof succeeded — which is what makes "cannot be
 * enabled when its connection test fails" a property of the code rather than a promise. The old key
 * stays readable through the rotation window and is removed with `retirePayoneerConfig`.
 *
 * ## Which credentials Payoneer takes
 *
 * Payoneer authenticates platform calls with an OAuth2 client-credentials grant over TLS, and the
 * program id names the payout program the call is scoped to (STEP 154 recorded the rule and its
 * sources in `lib/payments/adapters/payoneer.ts` and `docs/final/PROVIDER_DOCS.md`). So the
 * configuration is the client id, the client secret, the program id and the environment; the client
 * secret is the credential that must never be readable anywhere but in memory.
 *
 * ## How it is encrypted, and why not with a cipher of its own
 *
 * `lib/security/encryption.ts` seals secrets with AES-256-GCM and authenticates them against an
 * additional-data string of `kd-aad-v1|<purpose>|<scope>`. This file does not run a cipher itself:
 * it seals through that module, so the repository keeps one secret format, one keyring and one
 * rotation story rather than a third copy. The scope binds every sealed value to one company, one
 * provider and one credential:
 *
 *     gateway:<companyId>:payoneer:<client_id|client_secret>
 *
 * Copying a sealed client secret into another company's row, into another provider's row or into the
 * other credential of the same row therefore fails to open rather than returning a secret, and the
 * envelope names its key id, so a rotated keyring opens what it wrote and writes with the new key.
 *
 * ## What the connection test proves, and what it does not
 *
 * The test performs the documented OAuth2 client-credentials grant against
 * `https://login.sandbox.payoneer.com` or `https://login.payoneer.com`: a token means the client id
 * and client secret are valid, the authorization host is reachable and TLS is in place. It does not
 * prove the program id — the pages read in STEP 154 publish no program-level probe, and that is
 * recorded as an open question rather than papered over — so the test reports `programVerified: false`
 * and the first program-scope read in STEP 156 is what confirms it.
 *
 * ## What this file is not
 *
 * It is not the payout client (STEP 156) and not the webhook receiver (STEP 157). It is not the
 * admin screen: no route, component or permission check is added here, and the caller passes its own
 * store, keyring, audit writer and clock. It is not an environment reader: the keyring comes from the
 * caller, which reads it from the environment once at boot, exactly as `lib/security/encryption.ts`
 * requires.
 */

import { randomUUID } from "node:crypto";
import { isSecretEnvelope, openSecret, sealSecret, type EncryptionKeyring } from "../../security/encryption.ts";
import {
  PAYONEER_PROVIDER_KEY,
  PAYONEER_PRODUCTION_AUTH_BASE,
  PAYONEER_SANDBOX_AUTH_BASE,
  sanitizePayoneerText,
} from "./payoneer.ts";

/* -------------------------------------------------------------------------------------------------
 * Endpoints and vocabulary
 * ---------------------------------------------------------------------------------------------- */

/** The authorization scope of a sealed client id, for one company. */
export function payoneerClientIdScope(companyId: string): string {
  return `gateway:${companyId}:${PAYONEER_PROVIDER_KEY}:client_id`;
}

/** The authorization scope of a sealed client secret, for one company. */
export function payoneerClientSecretScope(companyId: string): string {
  return `gateway:${companyId}:${PAYONEER_PROVIDER_KEY}:client_secret`;
}

/** The documented authorization endpoint of an environment; the token grant posts here. */
export function payoneerTokenEndpointFor(environment: PayoneerEnvironment): string {
  return environment === "sandbox"
    ? `${PAYONEER_SANDBOX_AUTH_BASE}/oauth2/token`
    : `${PAYONEER_PRODUCTION_AUTH_BASE}/oauth2/token`;
}

/** The configuration statuses: a key is added, then activated, then eventually retired. */
export type PayoneerConfigStatus = "pending_activation" | "active" | "superseded" | "retired";

/** The two environments the configuration can name. */
export type PayoneerEnvironment = "sandbox" | "production";

/** The four outcomes a connection test can have. */
export type PayoneerConnectionOutcome = "connected" | "rejected" | "unreachable" | "failed" | "invalid_configuration";

/** The largest token answer this file reads. */
export const PAYONEER_TOKEN_ANSWER_MAXIMUM_BYTES = 65_536;

/** The longest provider text this file keeps. */
export const PAYONEER_TEXT_MAXIMUM_LENGTH = 200;

/* -------------------------------------------------------------------------------------------------
 * Validation patterns
 * ---------------------------------------------------------------------------------------------- */

/** A company id: the platform's own id shape. */
export const PAYONEER_COMPANY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;

/** A client id: Payoneer issues a readable token, and a client id carries no spaces or quotes. */
export const PAYONEER_CLIENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u;

/** A client secret: at least sixteen characters, no whitespace and no quotation marks. */
export const PAYONEER_CLIENT_SECRET_PATTERN = /^[A-Za-z0-9._~+/=-]{16,256}$/u;

/** A program id: what the documented paths call `{program_id}`. */
export const PAYONEER_PROGRAM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

/** An OAuth2 access token as returned by a token grant: never logged, never stored. */
const ACCESS_TOKEN_PATTERN = /^[A-Za-z0-9._~+/-]{8,4096}$/u;

/* -------------------------------------------------------------------------------------------------
 * The configuration record
 * ---------------------------------------------------------------------------------------------- */

/** The last connection test recorded against one configuration. */
export interface PayoneerConnectionTest {
  readonly outcome: PayoneerConnectionOutcome;
  readonly testedAtEpochMs: number;
  /** The environment the grant ran against; a production key is never proven by a sandbox grant. */
  readonly environment: PayoneerEnvironment;
}

/** One Payoneer key configuration: sealed credentials, the program, the status and the bookkeeping. */
export interface PayoneerKeyConfig {
  readonly id: string;
  readonly companyId: string;
  readonly environment: PayoneerEnvironment;
  /** AES-256-GCM envelope of the client id, sealed for this company, provider and credential. */
  readonly clientIdSealed: string;
  /** AES-256-GCM envelope of the client secret. */
  readonly clientSecretSealed: string;
  /** The program id: an identifier, not a credential, and every documented path names it. */
  readonly programId: string;
  readonly status: PayoneerConfigStatus;
  readonly version: number;
  readonly lastTest: PayoneerConnectionTest | null;
  readonly createdAtEpochMs: number;
  readonly updatedAtEpochMs: number;
}

/** What the store reads and writes. The store is the caller's; PostgreSQL owns the real rows. */
export interface PayoneerConfigStore {
  insert(config: PayoneerKeyConfig): void;
  findById(id: string): PayoneerKeyConfig | null;
  /** Every configuration of one company, in any status. */
  findByCompany(companyId: string): PayoneerKeyConfig[];
  /** The active configuration of one company, or null. */
  findActiveByCompany(companyId: string): PayoneerKeyConfig | null;
  /** The configuration of one company that is waiting for its connection test, or null. */
  findPendingByCompany(companyId: string): PayoneerKeyConfig | null;
  /** Write the next record only when the stored version is `expectedVersion` and it advances by one. */
  save(next: PayoneerKeyConfig, expectedVersion: number): boolean;
}

/**
 * The in-memory store: a reference implementation that enforces the invariants the flow rests on —
 * one pending configuration per company, one active configuration per company, an immutable
 * company/environment/id, and a strictly increasing version.
 */
export class InMemoryPayoneerConfigStore implements PayoneerConfigStore {
  private readonly configs = new Map<string, PayoneerKeyConfig>();

  insert(config: PayoneerKeyConfig): void {
    if (this.configs.has(config.id)) throw new Error("duplicate configuration id");
    if (config.version !== 1) throw new Error("a new configuration starts at version 1");
    // A key is only ever added waiting for its test: the only route to `active` is a passing test.
    if (config.status !== "pending_activation") throw new Error("a new configuration waits for its connection test");
    if (this.findPendingByCompany(config.companyId) !== null) {
      throw new Error("this company already has a key waiting for its connection test");
    }
    this.configs.set(config.id, config);
  }

  findById(id: string): PayoneerKeyConfig | null {
    return this.configs.get(id) ?? null;
  }

  findByCompany(companyId: string): PayoneerKeyConfig[] {
    return [...this.configs.values()].filter((config) => config.companyId === companyId);
  }

  findActiveByCompany(companyId: string): PayoneerKeyConfig | null {
    return this.findByCompany(companyId).find((config) => config.status === "active") ?? null;
  }

  findPendingByCompany(companyId: string): PayoneerKeyConfig | null {
    return this.findByCompany(companyId).find((config) => config.status === "pending_activation") ?? null;
  }

  save(next: PayoneerKeyConfig, expectedVersion: number): boolean {
    const current = this.configs.get(next.id);
    if (current === undefined) return false;
    if (current.companyId !== next.companyId || current.environment !== next.environment) return false;
    if (current.version !== expectedVersion) return false;
    if (next.version !== expectedVersion + 1) return false;
    if (current.clientIdSealed !== next.clientIdSealed || current.clientSecretSealed !== next.clientSecretSealed) {
      return false;
    }
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

/** What an admin screen may show: the masked credentials, the program and the bookkeeping. */
export interface PayoneerKeyView {
  readonly id: string;
  readonly companyId: string;
  readonly environment: PayoneerEnvironment;
  readonly clientIdMasked: string;
  readonly clientSecretMasked: string;
  readonly programId: string;
  readonly status: PayoneerConfigStatus;
  readonly lastTestOutcome: PayoneerConnectionOutcome | null;
  readonly lastTestedAtEpochMs: number | null;
  readonly updatedAtEpochMs: number;
}

/**
 * Mask a credential for display: keep the last four characters, hide the rest.
 *
 * The last four are what section 6 allows ("Only the last characters and last updated time are
 * shown"), and a value of four characters or fewer is hidden entirely rather than shown whole.
 */
export function maskPayoneerCredential(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 4) return "*".repeat(Math.max(1, trimmed.length));
  return `${"*".repeat(Math.min(12, trimmed.length - 4))}${trimmed.slice(-4)}`;
}

/* -------------------------------------------------------------------------------------------------
 * Audit
 * ---------------------------------------------------------------------------------------------- */

/** One audit entry this file hands to the caller's audit writer. Never carries a credential. */
export interface PayoneerKeyAuditEntry {
  readonly action:
    | "provider_key.configured"
    | "provider_key.tested"
    | "provider_key.activated"
    | "provider_key.rotated"
    | "provider_key.retired";
  readonly providerKey: typeof PAYONEER_PROVIDER_KEY;
  readonly companyId: string;
  readonly configId: string;
  readonly environment: PayoneerEnvironment;
  readonly outcome: string;
  readonly occurredAtEpochMs: number;
}

/* -------------------------------------------------------------------------------------------------
 * Configuration
 * ---------------------------------------------------------------------------------------------- */

/** The credentials an admin enters. They exist in memory for the length of this call only. */
export interface ConfigurePayoneerKeysInput {
  readonly companyId: string;
  readonly environment: PayoneerEnvironment;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly programId: string;
}

/** The options a configuration needs. */
export interface ConfigurePayoneerKeysOptions {
  readonly store: PayoneerConfigStore;
  /** The keyring the environment supplies: AES-256-GCM, 32 bytes per key. */
  readonly keyring: EncryptionKeyring;
  readonly occurredAtEpochMs: number;
  readonly recordAudit?: (entry: PayoneerKeyAuditEntry) => void;
}

/** What configuring a key did. */
export type ConfigurePayoneerKeysResult =
  | { readonly status: "configured"; readonly view: PayoneerKeyView; readonly config: PayoneerKeyConfig }
  | { readonly status: "failed"; readonly reason: string };

/** The validation failure of an input, or null when it is valid. */
export function validatePayoneerCredentials(input: ConfigurePayoneerKeysInput): string | null {
  if (PAYONEER_COMPANY_ID_PATTERN.test(input.companyId) === false) return "the company id is invalid";
  if (input.environment !== "sandbox" && input.environment !== "production") return "the environment must be sandbox or production";
  if (PAYONEER_CLIENT_ID_PATTERN.test(input.clientId) === false) {
    return "the client id must be 8 to 128 characters of letters, digits, dot, dash or underscore";
  }
  if (PAYONEER_CLIENT_SECRET_PATTERN.test(input.clientSecret) === false) {
    return "the client secret must be at least 16 characters and carry no spaces or quotation marks";
  }
  if (PAYONEER_PROGRAM_ID_PATTERN.test(input.programId) === false) {
    return "the program id must be 1 to 64 characters of letters, digits, dash or underscore";
  }
  if (input.clientId === input.clientSecret) return "the client id and the client secret cannot be the same value";
  return null;
}

/**
 * Add a Payoneer key configuration, sealed and waiting for its connection test.
 *
 * The credentials are validated before anything is sealed, so an invalid value never becomes an
 * envelope; the client id and the client secret are sealed for this company and this credential
 * only; and the configuration is stored in `pending_activation`, because section 6 says a provider
 * "cannot be enabled when its connection test fails" and a key that was never tested has no proof.
 * Only one key per company can wait for a test at a time, so a half-finished rotation cannot leave
 * two unproven keys behind.
 */
export function configurePayoneerKeys(
  input: ConfigurePayoneerKeysInput,
  options: ConfigurePayoneerKeysOptions,
): ConfigurePayoneerKeysResult {
  const invalid = validatePayoneerCredentials(input);
  if (invalid !== null) return { status: "failed", reason: invalid };

  const pending = options.store.findPendingByCompany(input.companyId);
  if (pending !== null) {
    return { status: "failed", reason: "this company already has a key waiting for its connection test" };
  }

  let clientIdSealed: string;
  let clientSecretSealed: string;
  try {
    clientIdSealed = sealSecret(options.keyring, input.clientId, {
      purpose: "secret",
      scope: payoneerClientIdScope(input.companyId),
    });
    clientSecretSealed = sealSecret(options.keyring, input.clientSecret, {
      purpose: "secret",
      scope: payoneerClientSecretScope(input.companyId),
    });
  } catch {
    // The keyring is unusable: nothing is written and no reason describes the key material.
    return { status: "failed", reason: "the encryption keyring cannot seal a credential" };
  }

  const config: PayoneerKeyConfig = {
    id: randomUUID(),
    companyId: input.companyId,
    environment: input.environment,
    clientIdSealed,
    clientSecretSealed,
    programId: input.programId,
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
      providerKey: PAYONEER_PROVIDER_KEY,
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
    view: viewOf(config, input.clientId, input.clientSecret),
  };
}

/** Build the masked view from the plaintext a configuring call still holds. */
function viewOf(config: PayoneerKeyConfig, clientId: string, clientSecret: string): PayoneerKeyView {
  return {
    id: config.id,
    companyId: config.companyId,
    environment: config.environment,
    clientIdMasked: maskPayoneerCredential(clientId),
    clientSecretMasked: maskPayoneerCredential(clientSecret),
    programId: config.programId,
    status: config.status,
    lastTestOutcome: config.lastTest === null ? null : config.lastTest.outcome,
    lastTestedAtEpochMs: config.lastTest === null ? null : config.lastTest.testedAtEpochMs,
    updatedAtEpochMs: config.updatedAtEpochMs,
  };
}

/**
 * Read the masked view of a stored configuration.
 *
 * The plaintext is opened only to be masked, so the screen can show which key is stored without
 * ever holding a form field that carries it. A configuration whose envelope no longer opens — a
 * rotation that dropped a key too early — is reported as unreadable rather than shown blank.
 */
export function payoneerKeyViewOf(
  config: PayoneerKeyConfig,
  keyring: EncryptionKeyring,
):
  | { readonly status: "shown"; readonly view: PayoneerKeyView }
  | { readonly status: "failed"; readonly reason: string } {
  try {
    const clientId = openSecret(keyring, config.clientIdSealed, {
      purpose: "secret",
      scope: payoneerClientIdScope(config.companyId),
    });
    const clientSecret = openSecret(keyring, config.clientSecretSealed, {
      purpose: "secret",
      scope: payoneerClientSecretScope(config.companyId),
    });
    return { status: "shown", view: viewOf(config, clientId, clientSecret) };
  } catch {
    return { status: "failed", reason: "the sealed credentials cannot be opened with this keyring" };
  }
}

/* -------------------------------------------------------------------------------------------------
 * The token transport
 * ---------------------------------------------------------------------------------------------- */

/** The HTTP answer of a token grant: the status code and the raw body. */
export interface PayoneerTokenAnswer {
  readonly status: number;
  readonly body: string;
}

/** The transport port: endpoint, client credentials in; the raw answer out. */
export type PayoneerTokenTransport = (
  endpoint: string,
  clientId: string,
  clientSecret: string,
) => Promise<PayoneerTokenAnswer>;

/**
 * Posts the OAuth2 client-credentials grant to the documented authorization host.
 *
 * The endpoint is allowlisted to the two documented hosts, the call is refused without both
 * credentials, redirects are refused (a redirect is not a token), the timeout is bounded and an
 * oversized answer is refused. The certificate chain is verified by the platform's fetch, which is
 * what keeps the TLS 1.2 floor meaningful. A throw means the host was not reached, never that the
 * credentials were wrong.
 */
export const payoneerFetchTokenTransport: PayoneerTokenTransport = async (endpoint, clientId, clientSecret) => {
  if (
    endpoint !== payoneerTokenEndpointFor("sandbox") &&
    endpoint !== payoneerTokenEndpointFor("production")
  ) {
    throw new Error("invalid token endpoint");
  }
  if (clientId.trim().length === 0 || clientSecret.trim().length === 0) {
    throw new Error("both client credentials are required");
  }

  const form = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: form.toString(),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });

  const text = await response.text();
  if (text.length > PAYONEER_TOKEN_ANSWER_MAXIMUM_BYTES) throw new Error("invalid token answer");
  return { status: response.status, body: text };
};

/* -------------------------------------------------------------------------------------------------
 * The connection test
 * ---------------------------------------------------------------------------------------------- */

/** What a token answer means for the configuration it was made with. */
export type PayoneerTokenVerdict =
  | { readonly outcome: "connected" }
  | { readonly outcome: "rejected"; readonly detail: string }
  | { readonly outcome: "unreachable"; readonly detail: string }
  | { readonly outcome: "failed"; readonly detail: string };

/** Read one provider message out of a JSON answer, sanitised, or the empty string. */
function providerMessageOf(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "";
  const record = payload as Readonly<Record<string, unknown>>;
  for (const key of ["error_description", "error", "message", "detail"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return sanitizePayoneerText(value).slice(0, PAYONEER_TEXT_MAXIMUM_LENGTH);
    }
  }
  return "";
}

/**
 * Read a token grant answer.
 *
 * A `200` carrying an `access_token` is the proof the credentials are valid. The token itself is read
 * only to prove it is a token and is then dropped: it is never returned, stored, logged or audited.
 * A `400`, `401` or `403` is a rejected credential (the documented `invalid_client` answer lands
 * here). A timeout-class code, `429` or any `5xx` is unreachable, because the credentials were never
 * judged. A `200` without a token, or a body that does not parse, is a failure that proves nothing.
 */
export function parsePayoneerTokenAnswer(status: number, body: string): PayoneerTokenVerdict {
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return { outcome: "unreachable", detail: "the authorization host did not answer finally; retry later" };
  }

  let payload: unknown;
  try {
    payload = body.trim().length === 0 ? null : (JSON.parse(body) as unknown);
  } catch {
    payload = null;
  }

  if (status === 400 || status === 401 || status === 403) {
    const message = providerMessageOf(payload);
    return {
      outcome: "rejected",
      detail: message.length > 0 ? message : "the authorization host rejected the client credentials",
    };
  }

  if (status < 200 || status >= 300) {
    return { outcome: "rejected", detail: `the authorization host refused the grant with status ${status}` };
  }

  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { outcome: "failed", detail: "the token answer is not an object, so nothing was proven" };
  }

  const record = payload as Readonly<Record<string, unknown>>;
  const token = record["access_token"] ?? record["token"];
  if (typeof token !== "string" || ACCESS_TOKEN_PATTERN.test(token.trim()) === false) {
    return { outcome: "failed", detail: "the token answer carries no usable access token" };
  }

  return { outcome: "connected" };
}

/** The options a connection test needs. */
export interface TestPayoneerConnectionOptions {
  readonly store: PayoneerConfigStore;
  readonly keyring: EncryptionKeyring;
  readonly occurredAtEpochMs: number;
  readonly transport?: PayoneerTokenTransport;
  readonly recordAudit?: (entry: PayoneerKeyAuditEntry) => void;
}

/** What one connection test did. Never carries a credential or a token. */
export interface PayoneerConnectionResult {
  readonly outcome: PayoneerConnectionOutcome;
  readonly configId: string | null;
  readonly environment: PayoneerEnvironment | null;
  readonly reason: string;
  /** True only when the grant returned a token; the token itself is never part of this result. */
  readonly tokenObtained: boolean;
  /** Always false: the pages read publish no program-level probe, so the program is not proven here. */
  readonly programVerified: boolean;
  readonly testedAtEpochMs: number;
  readonly version: number | null;
}

/**
 * Test one stored configuration against Payoneer's authorization host.
 *
 * The plaintext is opened in memory, used for exactly one grant, and dropped. The outcome is written
 * back onto the configuration as its `lastTest`, because activation reads it — a test that is not
 * recorded cannot authorize anything. A rejected or unreachable outcome is recorded too, so an
 * activation attempt after a failure is refused by the record rather than by a caller's memory.
 */
export async function testPayoneerConnection(
  configId: string,
  options: TestPayoneerConnectionOptions,
): Promise<PayoneerConnectionResult> {
  const config = options.store.findById(configId);

  if (config === null) {
    return {
      outcome: "invalid_configuration",
      configId: null,
      environment: null,
      reason: "no Payoneer key configuration holds that id",
      tokenObtained: false,
      programVerified: false,
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
      tokenObtained: false,
      programVerified: false,
      testedAtEpochMs: options.occurredAtEpochMs,
      version: config.version,
    };
  }

  let clientId: string;
  let clientSecret: string;
  try {
    clientId = openSecret(options.keyring, config.clientIdSealed, {
      purpose: "secret",
      scope: payoneerClientIdScope(config.companyId),
    });
    clientSecret = openSecret(options.keyring, config.clientSecretSealed, {
      purpose: "secret",
      scope: payoneerClientSecretScope(config.companyId),
    });
  } catch {
    return {
      outcome: "invalid_configuration",
      configId: config.id,
      environment: config.environment,
      reason: "the sealed credentials cannot be opened with this keyring",
      tokenObtained: false,
      programVerified: false,
      testedAtEpochMs: options.occurredAtEpochMs,
      version: config.version,
    };
  }

  let verdict: PayoneerTokenVerdict;
  try {
    const answer = await (options.transport ?? payoneerFetchTokenTransport)(
      payoneerTokenEndpointFor(config.environment),
      clientId,
      clientSecret,
    );
    verdict = parsePayoneerTokenAnswer(answer.status, answer.body);
  } catch {
    verdict = { outcome: "unreachable", detail: "the authorization host could not be reached" };
  }

  const outcome: PayoneerConnectionOutcome = verdict.outcome;
  const next: PayoneerKeyConfig = {
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
      providerKey: PAYONEER_PROVIDER_KEY,
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
    reason: verdict.outcome === "connected" ? "the authorization host issued a token for these credentials" : verdict.detail,
    tokenObtained: verdict.outcome === "connected",
    programVerified: false,
    testedAtEpochMs: options.occurredAtEpochMs,
    version: recorded === null ? null : recorded.version,
  };
}

/* -------------------------------------------------------------------------------------------------
 * Activation and retirement
 * ---------------------------------------------------------------------------------------------- */

/** The options activation and retirement need. */
export interface PayoneerConfigTransitionOptions {
  readonly store: PayoneerConfigStore;
  readonly occurredAtEpochMs: number;
  readonly recordAudit?: (entry: PayoneerKeyAuditEntry) => void;
}

/** What a transition did. */
export type PayoneerTransitionResult =
  | { readonly status: "activated"; readonly config: PayoneerKeyConfig; readonly supersededConfigId: string | null }
  | { readonly status: "retired"; readonly config: PayoneerKeyConfig }
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
export function activatePayoneerConfig(
  configId: string,
  options: PayoneerConfigTransitionOptions,
): PayoneerTransitionResult {
  const config = options.store.findById(configId);
  if (config === null) return { status: "failed", reason: "no Payoneer key configuration holds that id" };
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
    const superseded: PayoneerKeyConfig = {
      ...previousActive,
      status: "superseded",
      version: previousActive.version + 1,
      updatedAtEpochMs: options.occurredAtEpochMs,
    };
    if (options.store.save(superseded, previousActive.version) === false) {
      return { status: "failed", reason: "the active key changed while this key was being activated" };
    }
  }

  const activated: PayoneerKeyConfig = {
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
      providerKey: PAYONEER_PROVIDER_KEY,
      companyId: activated.companyId,
      configId: activated.id,
      environment: activated.environment,
      outcome: "active",
      occurredAtEpochMs: options.occurredAtEpochMs,
    });

    if (previousActive !== null && previousActive.id !== config.id) {
      options.recordAudit({
        action: "provider_key.rotated",
        providerKey: PAYONEER_PROVIDER_KEY,
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
export function retirePayoneerConfig(
  configId: string,
  options: PayoneerConfigTransitionOptions,
): PayoneerTransitionResult {
  const config = options.store.findById(configId);
  if (config === null) return { status: "failed", reason: "no Payoneer key configuration holds that id" };
  if (config.status === "retired") return { status: "failed", reason: "the configuration is already retired" };
  if (config.status === "active") {
    return { status: "failed", reason: "the active key cannot be retired; activate its replacement first" };
  }

  const retired: PayoneerKeyConfig = {
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
      providerKey: PAYONEER_PROVIDER_KEY,
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
 * True when both credentials of a configuration are sealed envelopes this platform wrote.
 *
 * The check exists so a stored configuration can be audited without opening it: an envelope names its
 * key id and its format, and a plaintext credential cannot accidentally pass for one.
 */
export function payoneerConfigIsSealed(config: PayoneerKeyConfig): boolean {
  return isSecretEnvelope(config.clientIdSealed) && isSecretEnvelope(config.clientSecretSealed);
}
