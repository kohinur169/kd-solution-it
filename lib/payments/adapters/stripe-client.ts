// path: lib/payments/adapters/stripe-client.ts

/**
 * The Stripe Connect adapter's encrypted key configuration, connection test, activation and rotation:
 * the service that stores a company's Stripe credential sealed at rest, proves it against Stripe's API,
 * and lets the provider be enabled only after that proof.
 *
 * ## What the feature list asks for
 *
 * Section 6: "Keys are AES-256-GCM encrypted before storage. The encryption key exists only in
 * environment variables. After saving, a full key is never shown again. Only the last characters and
 * last updated time are shown. A provider cannot be enabled when its connection test fails."
 *
 * Section 29: "Provider keys ... entered in admin screens are AES-256-GCM encrypted at rest and shown
 * only masked." And the rotation procedure: "add new key, run connection test, activate, then remove
 * the old key. Every rotation is audit logged."
 *
 * This file is that, in that order: `configureStripeKeys` adds a key in `pending_activation`,
 * `testStripeConnection` proves it, and `activateStripeConfig` refuses without a recorded passing test.
 * `retireStripeConfig` finishes a rotation; `rollStripeWebhookSecret` rotates the signing secret the
 * receiver (STEP 164) will verify against.
 *
 * ## Which credentials Stripe takes, and which of them is not a secret
 *
 * STEP 161 recorded the key vocabulary from Stripe's own pages: secret keys are `sk_`, restricted keys
 * `rk_`, publishable keys `pk_`, each with a `test` or `live` segment, and webhook signing secrets are
 * `whsec_` and belong to one endpoint. Three consequences shape this file.
 *
 * 1. The **secret key** is the server credential. It is sealed, scoped, masked, never returned.
 * 2. The **publishable key** is *not* a secret: it is designed to be shipped to browsers, so sealing it
 *    would be theatre. It is stored as text, shown in full on the settings view (that is how the
 *    checkout step gets it), and never confused with the secret key — passing a `pk_` value into the
 *    secret field is refused by name, not by a generic shape message.
 * 3. The **webhook signing secret** is a third credential with its own lifecycle: Stripe lets an
 *    endpoint run two secrets at once for up to 24 hours during a roll, and sends one signature per
 *    secret. So the configuration keeps the current one and, during a roll, the previous one with the
 *    time it stops being accepted — which is exactly what `verifyStripeWebhookSignature` in `stripe.ts`
 *    can already check, because it reads every `v1` signature in the header.
 *
 * ## The two decisions STEP 161 left to this STEP
 *
 * - **The account surface is Accounts v2.** `STRIPE_ACCOUNT_SURFACE` is exported with its reason, so
 *   STEP 163 creates connected accounts through `POST /v2/core/accounts` with configurations instead of
 *   the legacy Standard/Express/Custom types, which Stripe deprecated for new platforms and which
 *   cannot be changed after an account is created.
 * - **The API version is configuration, not a constant.** It is stored with the key, validated against
 *   the dated shape Stripe uses, sent as the documented `Stripe-Version` header on every call, and
 *   defaulted to the only version this repository's documentation review actually observed. A `live`
 *   configuration may not pin a `.preview` version: a preview surface is for building, and this
 *   platform's rule is that live traffic stays on a released version.
 *
 * ## How it is encrypted
 *
 * `lib/security/encryption.ts` seals with authenticated encryption and binds every envelope to
 * `kd-aad-v1|<purpose>|<scope>`. This file runs no cipher of its own: it seals through that module, so
 * the repository keeps one secret format, one keyring and one rotation story. Each sealed value is
 * bound to one company, one provider and one field:
 *
 *     gateway:<companyId>:stripe:secret_key
 *     gateway:<companyId>:stripe:webhook_secret
 *
 * A sealed secret key copied into another company's row, or into the webhook-signing slot, fails to
 * open rather than yielding a secret.
 *
 * ## What the connection test proves, and what it does not
 *
 * The test performs the documented authenticated read `GET /v1/accounts?limit=1` — the same endpoint
 * STEP 163 will use — sending `Authorization: Bearer <secret key>` and the recorded `Stripe-Version`
 * header. A `2XX` whose body is a Stripe list (`object: "list"`, a `data` array) proves the key
 * authenticated in that mode, because sandbox and live keys and objects are separate; the number of
 * accounts the read listed is reported and the accounts themselves are never read into the result.
 *
 * It does **not** prove that payments work, that the account is onboarded, or that the webhook secret is
 * correct — no charge is created, no endpoint exists, and no delivery is signed. Those are STEPs 163 and
 * 164. It also cannot tell a sandbox webhook secret from a live one, because a `whsec_` value carries no
 * mode; that limit is recorded here instead of being papered over.
 *
 * ## What this file is not
 *
 * Not the connected-account service (163), not the charge or webhook path (164), and not a screen: no
 * route, component or permission check is added. The caller passes its own store, keyring, audit writer
 * and clock, exactly as every other adapter does.
 */

import { randomUUID } from "node:crypto";
import { isSecretEnvelope, openSecret, sealSecret, type EncryptionKeyring } from "../../security/encryption.ts";
import {
  isStripePublishableKeyShaped,
  isStripeServerKeyShaped,
  isStripeWebhookSecretShaped,
  sanitizeStripeText,
  STRIPE_API_BASE,
  STRIPE_API_VERSION_HEADER,
  STRIPE_OBSERVED_API_VERSION,
  STRIPE_PROVIDER_KEY,
  STRIPE_V1_ACCOUNTS_PATH,
  stripeEnvironmentOfApiKey,
  type StripeEnvironment,
} from "./stripe.ts";

/* -------------------------------------------------------------------------------------------------
 * Endpoint, surface and vocabulary
 * ---------------------------------------------------------------------------------------------- */

/** The documented version header, re-exported so a caller has one entry point for Stripe's rules. */
export { STRIPE_API_VERSION_HEADER } from "./stripe.ts";

/**
 * The account surface this adapter uses, decided by STEP 162 and consumed by STEP 163.
 *
 * The pages read in STEP 161 say new platforms use Accounts v2 with configurations, and that the
 * Standard/Express/Custom type model is legacy for new integrations and immutable after creation. A
 * platform that has never created a connected account has no reason to start on the legacy surface.
 */
export const STRIPE_ACCOUNT_SURFACE = "accounts_v2" as const;

/** Why the surface is Accounts v2, in the words the adapter's callers need. */
export const STRIPE_ACCOUNT_SURFACE_REASON =
  "Accounts v2 with configurations is the surface Stripe recommends for new platforms; the Standard, Express and Custom account types are legacy and an account's type cannot be changed after creation.";

/** The documented Accounts v2 collection STEP 163 will post to. */
export const STRIPE_ACCOUNT_SURFACE_PATH = "/v2/core/accounts";

/** The documented authenticated read this file's connection test performs. */
export const STRIPE_CONNECTION_PATH = STRIPE_V1_ACCOUNTS_PATH;

/** How many accounts the test asks for: enough to prove the read, few enough to read nothing useful. */
export const STRIPE_CONNECTION_PAGE_SIZE = 1;

/** The one URL the connection test is allowed to call. */
export function stripeConnectionEndpoint(): string {
  return `${STRIPE_API_BASE}${STRIPE_CONNECTION_PATH}?limit=${STRIPE_CONNECTION_PAGE_SIZE}`;
}

/** The API version this adapter defaults to, as recorded from the documentation in STEP 161. */
export const STRIPE_DEFAULT_API_VERSION = STRIPE_OBSERVED_API_VERSION;

/** The shape of a Stripe API version: a date, optionally a preview. */
export const STRIPE_API_VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}(?:\.preview)?$/u;

/** True when a version names a preview surface rather than a released one. */
export function stripeApiVersionIsPreview(apiVersion: string): boolean {
  return apiVersion.trim().endsWith(".preview");
}

/**
 * The documented overlap window of a webhook secret roll, in seconds.
 *
 * Stripe's pages say the previous secret can stay valid for up to 24 hours while the new one takes
 * over, and that a signature is generated for each active secret during that window.
 */
export const STRIPE_WEBHOOK_SECRET_OVERLAP_SECONDS = 86_400;

/** The company id shape every adapter in this set accepts. */
export const STRIPE_COMPANY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;

/** The largest API answer this file reads. */
export const STRIPE_API_ANSWER_MAXIMUM_BYTES = 65_536;

/** The longest provider text this file keeps. */
export const STRIPE_CLIENT_TEXT_MAXIMUM_LENGTH = 200;

/** How long the connection test waits for Stripe. */
export const STRIPE_CONNECT_TIMEOUT_MS = 15_000;

/** The authorization scope of a sealed secret key, for one company. */
export function stripeSecretKeyScope(companyId: string): string {
  return `gateway:${companyId}:${STRIPE_PROVIDER_KEY}:secret_key`;
}

/** The authorization scope of a sealed webhook signing secret, for one company. */
export function stripeWebhookSecretScope(companyId: string): string {
  return `gateway:${companyId}:${STRIPE_PROVIDER_KEY}:webhook_secret`;
}

/** The lifecycle of one key configuration. */
export type StripeConfigStatus = "pending_activation" | "active" | "superseded" | "retired";

/** What a connection test concluded. */
export type StripeConnectionOutcome =
  | "connected"
  | "rejected"
  | "not_permitted"
  | "unreachable"
  | "failed"
  | "invalid_configuration";

/* -------------------------------------------------------------------------------------------------
 * The configuration record
 * ---------------------------------------------------------------------------------------------- */

/** What a recorded connection test holds. Never carries a credential. */
export interface StripeConnectionTest {
  readonly outcome: StripeConnectionOutcome;
  readonly testedAtEpochMs: number;
  readonly environment: StripeEnvironment;
  /** The version header the test sent, so the proof names the surface it was made on. */
  readonly apiVersionSent: string;
}

/** One company's Stripe key configuration. */
export interface StripeKeyConfig {
  readonly id: string;
  readonly companyId: string;
  readonly environment: StripeEnvironment;
  /** The sealed secret or restricted key. */
  readonly secretKeySealed: string;
  /** The key family of the sealed credential: `sk_test`, `sk_live`, `rk_test`, `rk_live` or `sk_org`. */
  readonly secretKeyPrefix: string;
  /** The browser-safe key, stored as text because it is public by design. */
  readonly publishableKey: string | null;
  /** The sealed webhook signing secret, when one has been configured. */
  readonly webhookSecretSealed: string | null;
  /** The previous signing secret, kept only while a roll's overlap window is open. */
  readonly previousWebhookSecretSealed: string | null;
  /** When the previous signing secret stops being accepted, or null when there is none. */
  readonly previousWebhookSecretExpiresAtEpochMs: number | null;
  /** The dated API version every call sends. */
  readonly apiVersion: string;
  /** The account surface STEP 163 uses. Stored so a stored key names the surface it was proven on. */
  readonly accountSurface: typeof STRIPE_ACCOUNT_SURFACE;
  readonly status: StripeConfigStatus;
  readonly version: number;
  readonly lastTest: StripeConnectionTest | null;
  readonly createdAtEpochMs: number;
  readonly updatedAtEpochMs: number;
}

/** The store the caller supplies. */
export interface StripeConfigStore {
  insert(config: StripeKeyConfig): void;
  findById(id: string): StripeKeyConfig | null;
  /** Every configuration of one company, in any status. */
  findByCompany(companyId: string): StripeKeyConfig[];
  /** The active configuration of one company, or null. */
  findActiveByCompany(companyId: string): StripeKeyConfig | null;
  /** The configuration of one company waiting for its connection test, or null. */
  findPendingByCompany(companyId: string): StripeKeyConfig | null;
  /** Write the next record only when the stored version is `expectedVersion` and it advances by one. */
  save(next: StripeKeyConfig, expectedVersion: number): boolean;
}

/**
 * The in-memory store: a reference implementation that enforces the invariants the flow rests on — one
 * pending configuration per company, one active one, an immutable identity and sealed key, and a
 * strictly increasing version.
 */
export class InMemoryStripeConfigStore implements StripeConfigStore {
  private readonly configs = new Map<string, StripeKeyConfig>();

  insert(config: StripeKeyConfig): void {
    if (this.configs.has(config.id)) throw new Error("duplicate configuration id");
    if (config.version !== 1) throw new Error("a new configuration starts at version 1");
    if (config.status !== "pending_activation") throw new Error("a new configuration waits for its connection test");
    if (this.findPendingByCompany(config.companyId) !== null) {
      throw new Error("this company already has a key waiting for its connection test");
    }
    this.configs.set(config.id, config);
  }

  findById(id: string): StripeKeyConfig | null {
    return this.configs.get(id) ?? null;
  }

  findByCompany(companyId: string): StripeKeyConfig[] {
    return [...this.configs.values()].filter((config) => config.companyId === companyId);
  }

  findActiveByCompany(companyId: string): StripeKeyConfig | null {
    return this.findByCompany(companyId).find((config) => config.status === "active") ?? null;
  }

  findPendingByCompany(companyId: string): StripeKeyConfig | null {
    return this.findByCompany(companyId).find((config) => config.status === "pending_activation") ?? null;
  }

  save(next: StripeKeyConfig, expectedVersion: number): boolean {
    const current = this.configs.get(next.id);
    if (current === undefined) return false;
    if (current.companyId !== next.companyId || current.environment !== next.environment) return false;
    if (current.version !== expectedVersion) return false;
    if (next.version !== expectedVersion + 1) return false;
    // The identity of a key is immutable: a stored credential is never swapped in place.
    if (current.secretKeySealed !== next.secretKeySealed || current.secretKeyPrefix !== next.secretKeyPrefix) return false;
    if (current.publishableKey !== next.publishableKey) return false;
    if (current.apiVersion !== next.apiVersion) return false;
    if (current.accountSurface !== next.accountSurface) return false;
    // The section 6 rule at the store: a key never becomes active on a test it did not pass.
    if (next.status === "active" && current.status === "pending_activation" && next.lastTest?.outcome !== "connected") {
      return false;
    }
    if (next.status === "active" && current.status !== "pending_activation" && current.status !== "active") return false;
    if (next.status === "pending_activation" && current.status !== "pending_activation") return false;
    if (next.status === "retired" && current.status === "retired") return false;
    const active = this.findActiveByCompany(next.companyId);
    if (next.status === "active" && active !== null && active.id !== next.id) return false;
    this.configs.set(next.id, next);
    return true;
  }
}

/* -------------------------------------------------------------------------------------------------
 * Audit
 * ---------------------------------------------------------------------------------------------- */

/** One audit entry this file hands to the caller's audit writer. Never carries a credential. */
export interface StripeKeyAuditEntry {
  readonly action:
    | "provider_key.configured"
    | "provider_key.tested"
    | "provider_key.activated"
    | "provider_key.rotated"
    | "provider_key.retired"
    | "provider_webhook_secret.rolled";
  readonly providerKey: typeof STRIPE_PROVIDER_KEY;
  readonly companyId: string;
  readonly configId: string;
  readonly environment: StripeEnvironment;
  readonly outcome: string;
  readonly occurredAtEpochMs: number;
}

/* -------------------------------------------------------------------------------------------------
 * Validation and configuration
 * ---------------------------------------------------------------------------------------------- */

/** What an admin screen submits to add a key. */
export interface ConfigureStripeKeysInput {
  readonly companyId: string;
  readonly environment: StripeEnvironment;
  readonly secretKey: string;
  readonly publishableKey?: string | null;
  readonly webhookSecret?: string | null;
  /** Omitted means the recorded default; a preview value is refused for a live configuration. */
  readonly apiVersion?: string | null;
}

/** What configuring a key needs. */
export interface ConfigureStripeKeysOptions {
  readonly store: StripeConfigStore;
  readonly keyring: EncryptionKeyring;
  readonly occurredAtEpochMs: number;
  readonly recordAudit?: (entry: StripeKeyAuditEntry) => void;
}

/** What configuring a key did. */
export type ConfigureStripeKeysResult =
  | { readonly status: "configured"; readonly view: StripeKeyView; readonly config: StripeKeyConfig }
  | { readonly status: "failed"; readonly reason: string };

/** The key family of a documented Stripe credential, for display and for the immutability check. */
export function stripeKeyFamilyOf(secretKey: string): string | null {
  const match = /^(sk_test|sk_live|rk_test|rk_live|sk_org)_/u.exec(secretKey.trim());
  return match === null ? null : (match[1] ?? null);
}

/**
 * The validation failure of an input, or null when it is valid.
 *
 * Four checks matter most. A **publishable key in the secret field** is named for what it is, because
 * the two shapes are easy to confuse and the failure would otherwise appear later as a rejected call. A
 * **mode mismatch** between the secret key and the configuration is refused, because a sandbox key
 * stored as live would send the wrong credential to the live account. A **publishable key of another
 * mode** is refused for the same reason. A **preview version on a live configuration** is refused by
 * this platform's rule, which is recorded in the message rather than left as folklore.
 */
export function validateStripeCredentials(input: ConfigureStripeKeysInput): string | null {
  if (STRIPE_COMPANY_ID_PATTERN.test(input.companyId) === false) return "the company id is invalid";
  if (input.environment !== "sandbox" && input.environment !== "live") {
    return "the environment must be sandbox or live";
  }

  const secretKey = input.secretKey.trim();
  if (isStripePublishableKeyShaped(secretKey)) {
    return "a publishable key is not a secret key; it belongs in the publishable key field";
  }
  if (secretKey.startsWith("sk_org_")) {
    return "an organization key manages several Stripe accounts; this adapter needs one account's secret or restricted key";
  }
  if (isStripeServerKeyShaped(secretKey) === false) {
    return "the secret key must be an sk_test_, sk_live_, rk_test_ or rk_live_ key";
  }
  const secretMode = stripeEnvironmentOfApiKey(secretKey);
  if (secretMode !== input.environment) {
    return input.environment === "sandbox"
      ? "the secret key is a live key, but the configuration names the sandbox environment"
      : "the secret key is a sandbox key, but the configuration names the live environment";
  }

  const publishableKey = input.publishableKey ?? null;
  if (publishableKey !== null && publishableKey.trim().length > 0) {
    if (isStripePublishableKeyShaped(publishableKey.trim()) === false) {
      return "the publishable key must be a pk_test_ or pk_live_ key";
    }
    if (stripeEnvironmentOfApiKey(publishableKey.trim()) !== input.environment) {
      return "the publishable key belongs to another environment than the secret key";
    }
  }

  const webhookSecret = input.webhookSecret ?? null;
  if (webhookSecret !== null && webhookSecret.trim().length > 0) {
    if (isStripeWebhookSecretShaped(webhookSecret.trim()) === false) {
      return "the webhook signing secret must be a whsec_ value";
    }
  }

  const apiVersion = (input.apiVersion ?? "").trim();
  if (apiVersion.length > 0) {
    if (STRIPE_API_VERSION_PATTERN.test(apiVersion) === false) {
      return "the API version must be a date such as 2026-10-28, optionally .preview";
    }
    if (input.environment === "live" && stripeApiVersionIsPreview(apiVersion)) {
      return "a live configuration may not pin a preview API version; preview surfaces are for building";
    }
  }

  return null;
}

/**
 * Add a Stripe key configuration, sealed and waiting for its connection test.
 *
 * The input is validated before anything is sealed, so an invalid value never becomes an envelope; the
 * secret key and the webhook signing secret are sealed under their own scopes; the publishable key is
 * stored as text because it is public by design; and the configuration starts in `pending_activation`,
 * because a provider "cannot be enabled when its connection test fails" and an untested key has no proof.
 */
export function configureStripeKeys(
  input: ConfigureStripeKeysInput,
  options: ConfigureStripeKeysOptions,
): ConfigureStripeKeysResult {
  const invalid = validateStripeCredentials(input);
  if (invalid !== null) return { status: "failed", reason: invalid };

  if (options.store.findPendingByCompany(input.companyId) !== null) {
    return { status: "failed", reason: "this company already has a key waiting for its connection test" };
  }

  const secretKey = input.secretKey.trim();
  const publishableKey = (input.publishableKey ?? "").trim();
  const webhookSecret = (input.webhookSecret ?? "").trim();
  const apiVersion = (input.apiVersion ?? "").trim().length > 0 ? (input.apiVersion ?? "").trim() : STRIPE_DEFAULT_API_VERSION;

  let secretKeySealed: string;
  let webhookSecretSealed: string | null;
  try {
    secretKeySealed = sealSecret(options.keyring, secretKey, {
      purpose: "secret",
      scope: stripeSecretKeyScope(input.companyId),
    });
    webhookSecretSealed =
      webhookSecret.length === 0
        ? null
        : sealSecret(options.keyring, webhookSecret, {
            purpose: "secret",
            scope: stripeWebhookSecretScope(input.companyId),
          });
  } catch {
    // The keyring is unusable: nothing is written and no reason describes the key material.
    return { status: "failed", reason: "the encryption keyring cannot seal a credential" };
  }

  const config: StripeKeyConfig = {
    id: randomUUID(),
    companyId: input.companyId,
    environment: input.environment,
    secretKeySealed,
    secretKeyPrefix: stripeKeyFamilyOf(secretKey) ?? "",
    publishableKey: publishableKey.length === 0 ? null : publishableKey,
    webhookSecretSealed,
    previousWebhookSecretSealed: null,
    previousWebhookSecretExpiresAtEpochMs: null,
    apiVersion,
    accountSurface: STRIPE_ACCOUNT_SURFACE,
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
      providerKey: STRIPE_PROVIDER_KEY,
      companyId: config.companyId,
      configId: config.id,
      environment: config.environment,
      outcome: "pending_activation",
      occurredAtEpochMs: options.occurredAtEpochMs,
    });
  }

  return { status: "configured", config, view: viewOf(config, secretKey, webhookSecret.length === 0 ? null : webhookSecret) };
}

/* -------------------------------------------------------------------------------------------------
 * The masked view
 * ---------------------------------------------------------------------------------------------- */

/**
 * What an admin screen may show: the masked credentials, the public key in full, the surface, the
 * version and the bookkeeping.
 */
export interface StripeKeyView {
  readonly id: string;
  readonly companyId: string;
  readonly environment: StripeEnvironment;
  readonly secretKeyMasked: string;
  readonly secretKeyPrefix: string;
  /** The publishable key in full: it is designed to be public. */
  readonly publishableKey: string | null;
  readonly webhookSecretMasked: string | null;
  /** True while a previous signing secret is still accepted. */
  readonly webhookSecretRolling: boolean;
  readonly previousWebhookSecretExpiresAtEpochMs: number | null;
  readonly apiVersion: string;
  readonly accountSurface: typeof STRIPE_ACCOUNT_SURFACE;
  readonly status: StripeConfigStatus;
  readonly lastTestOutcome: StripeConnectionOutcome | null;
  readonly lastTestedAtEpochMs: number | null;
  readonly updatedAtEpochMs: number;
}

/**
 * Mask a credential for display: keep the documented family prefix and the last four characters.
 *
 * The prefix is not secret material — it is the `sk_test_`/`rk_live_`/`whsec_` marker the pages define
 * it as — and showing it lets an operator see at a glance which mode and which key family is stored.
 * The body of the key is never shown, and a value short enough for the last four to be most of it is
 * hidden entirely.
 */
export function maskStripeCredential(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 8) return "*".repeat(Math.max(1, trimmed.length));
  const family = /^(sk_test_|sk_live_|rk_test_|rk_live_|sk_org_|pk_test_|pk_live_|whsec_)/u.exec(trimmed);
  const prefix = family === null ? "" : (family[1] ?? "");
  const hidden = Math.max(1, trimmed.length - prefix.length - 4);
  return `${prefix}${"*".repeat(Math.min(12, hidden))}${trimmed.slice(-4)}`;
}

/** Build the masked view from the plaintext a configuring call still holds. */
function viewOf(config: StripeKeyConfig, secretKey: string, webhookSecret: string | null): StripeKeyView {
  const webhookMasked = config.webhookSecretSealed === null || webhookSecret === null ? null : maskStripeCredential(webhookSecret);
  return {
    id: config.id,
    companyId: config.companyId,
    environment: config.environment,
    secretKeyMasked: maskStripeCredential(secretKey),
    secretKeyPrefix: config.secretKeyPrefix,
    publishableKey: config.publishableKey,
    webhookSecretMasked: webhookMasked,
    webhookSecretRolling: config.previousWebhookSecretSealed !== null,
    previousWebhookSecretExpiresAtEpochMs: config.previousWebhookSecretExpiresAtEpochMs,
    apiVersion: config.apiVersion,
    accountSurface: config.accountSurface,
    status: config.status,
    lastTestOutcome: config.lastTest === null ? null : config.lastTest.outcome,
    lastTestedAtEpochMs: config.lastTest === null ? null : config.lastTest.testedAtEpochMs,
    updatedAtEpochMs: config.updatedAtEpochMs,
  };
}

/**
 * Read the masked view of a stored configuration.
 *
 * The sealed values are opened only to be masked, so a screen can show which credentials are stored
 * without holding them. A configuration whose envelopes no longer open — a keyring rotation that
 * dropped a key too early — is reported as unreadable rather than shown blank.
 */
export function stripeKeyViewOf(
  config: StripeKeyConfig,
  keyring: EncryptionKeyring,
): { readonly status: "shown"; readonly view: StripeKeyView } | { readonly status: "failed"; readonly reason: string } {
  let secretKey: string;
  try {
    secretKey = openSecret(keyring, config.secretKeySealed, {
      purpose: "secret",
      scope: stripeSecretKeyScope(config.companyId),
    });
  } catch {
    return { status: "failed", reason: "the sealed secret key cannot be opened with this keyring" };
  }

  let webhookMasked: string | null = null;
  if (config.webhookSecretSealed !== null) {
    try {
      webhookMasked = maskStripeCredential(
        openSecret(keyring, config.webhookSecretSealed, {
          purpose: "secret",
          scope: stripeWebhookSecretScope(config.companyId),
        }),
      );
    } catch {
      return { status: "failed", reason: "the sealed webhook signing secret cannot be opened with this keyring" };
    }
  }

  return {
    status: "shown",
    view: {
      ...viewOf(config, secretKey, null),
      webhookSecretMasked: webhookMasked,
      webhookSecretRolling: config.previousWebhookSecretSealed !== null,
    },
  };
}

/* -------------------------------------------------------------------------------------------------
 * The API transport
 * ---------------------------------------------------------------------------------------------- */

/** The HTTP answer of an API read: the status code and the raw body. */
export interface StripeApiAnswer {
  readonly status: number;
  readonly body: string;
}

/** The transport port: endpoint, secret key and version in; the raw answer out. */
export type StripeApiTransport = (
  endpoint: string,
  secretKey: string,
  apiVersion: string,
) => Promise<StripeApiAnswer>;

/**
 * Performs the documented authenticated read against the documented API base.
 *
 * The endpoint is allowlisted to the single connection URL, the call is refused without a key or a
 * version, redirects are refused (a redirect is not an answer, and Stripe counts a `3xx` as a delivery
 * failure), the timeout is bounded and an oversized answer is refused. The documented `Stripe-Version`
 * header is always sent, so the proof names the surface it was made on. A throw means the host was not
 * reached, never that the key was wrong.
 */
export const stripeFetchApiTransport: StripeApiTransport = async (endpoint, secretKey, apiVersion) => {
  if (endpoint !== stripeConnectionEndpoint()) throw new Error("invalid API endpoint");
  if (secretKey.trim().length === 0) throw new Error("a secret key is required");
  if (STRIPE_API_VERSION_PATTERN.test(apiVersion.trim()) === false) throw new Error("an API version is required");

  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      Accept: "application/json",
      [STRIPE_API_VERSION_HEADER]: apiVersion.trim(),
    },
    redirect: "error",
    signal: AbortSignal.timeout(STRIPE_CONNECT_TIMEOUT_MS),
  });

  const text = await response.text();
  if (text.length > STRIPE_API_ANSWER_MAXIMUM_BYTES) throw new Error("invalid API answer");
  return { status: response.status, body: text };
};

/* -------------------------------------------------------------------------------------------------
 * The connection test
 * ---------------------------------------------------------------------------------------------- */

/** What an account-list answer means for the configuration it was made with. */
export type StripeAccountListVerdict =
  | { readonly outcome: "connected"; readonly accountsVisible: number | null }
  | { readonly outcome: "rejected"; readonly detail: string }
  | { readonly outcome: "not_permitted"; readonly detail: string }
  | { readonly outcome: "unreachable"; readonly detail: string }
  | { readonly outcome: "failed"; readonly detail: string };

/**
 * Read one provider message out of an answer, sanitised, or the empty string.
 *
 * Stripe's documented error shape is `{ "error": { "type", "code", "message" } }`; a bare `message` is
 * accepted as well, because an intermediary may answer one. Nothing else from the body is read.
 */
export function stripeProviderMessageOf(payload: unknown): string {
  const clean = (value: string): string => sanitizeStripeText(value).slice(0, STRIPE_CLIENT_TEXT_MAXIMUM_LENGTH);

  if (typeof payload !== "object" || payload === null) return "";
  const record = payload as Readonly<Record<string, unknown>>;

  const error = record["error"];
  if (typeof error === "object" && error !== null) {
    const fields = error as Readonly<Record<string, unknown>>;
    for (const key of ["message", "code", "type"]) {
      const value = fields[key];
      if (typeof value === "string" && value.trim().length > 0) return clean(value);
    }
  }
  for (const key of ["message", "detail"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return clean(value);
  }
  return "";
}

/** Count the entries a list answer carried, without reading any of them. */
function accountsCountOf(payload: unknown): number | null {
  if (typeof payload !== "object" || payload === null) return null;
  const data = (payload as Readonly<Record<string, unknown>>)["data"];
  return Array.isArray(data) ? data.length : null;
}

/** True when an answer is a documented Stripe list object. */
function isStripeList(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const record = payload as Readonly<Record<string, unknown>>;
  if (record["object"] !== "list") return false;
  return Array.isArray(record["data"]);
}

/**
 * Read an account-list answer.
 *
 * `401` is the documented authentication error, so it rejects the key. `403` is different in a way
 * worth keeping: the credential authenticated but is not allowed to perform this read — a restricted
 * key without the accounts permission — so it is `not_permitted` and a screen can say "fix the key's
 * permissions" instead of "replace the key". `429`, `408`, `425` and any `5xx` judged nothing and are
 * `unreachable`. `400` is the request being refused (most often an unusable version) and proves nothing.
 * A `2XX` proves the key only when it carries a Stripe list; an empty or unparseable body is `failed`.
 */
export function parseStripeAccountListAnswer(status: number, body: string): StripeAccountListVerdict {
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return { outcome: "unreachable", detail: "the API did not answer finally; retry later" };
  }

  let payload: unknown;
  try {
    payload = body.trim().length === 0 ? null : (JSON.parse(body) as unknown);
  } catch {
    payload = null;
  }

  if (status === 401) {
    const message = stripeProviderMessageOf(payload);
    return {
      outcome: "rejected",
      detail: message.length > 0 ? message : "the API rejected the secret key with an authentication error",
    };
  }

  if (status === 403) {
    const message = stripeProviderMessageOf(payload);
    return {
      outcome: "not_permitted",
      detail:
        message.length > 0
          ? message
          : "the key authenticated but is not permitted to read accounts; a restricted key needs that permission",
    };
  }

  if (status === 400) {
    const message = stripeProviderMessageOf(payload);
    return {
      outcome: "failed",
      detail:
        message.length > 0
          ? message
          : "the API refused the request, so the key was not proven; the pinned API version may be unusable",
    };
  }

  if (status >= 300 && status < 400) {
    return { outcome: "failed", detail: "the API answered with a redirect, which proves nothing" };
  }

  if (status < 200 || status >= 300) {
    const message = stripeProviderMessageOf(payload);
    return {
      outcome: "failed",
      detail: message.length > 0 ? message : `the API refused the read with status ${status}`,
    };
  }

  if (isStripeList(payload) === false) {
    return { outcome: "failed", detail: "the answer is not a Stripe list, so nothing was proven" };
  }

  return { outcome: "connected", accountsVisible: accountsCountOf(payload) };
}

/** The options a connection test needs. */
export interface TestStripeConnectionOptions {
  readonly store: StripeConfigStore;
  readonly keyring: EncryptionKeyring;
  readonly occurredAtEpochMs: number;
  readonly transport?: StripeApiTransport;
  readonly recordAudit?: (entry: StripeKeyAuditEntry) => void;
}

/** What one connection test did. Never carries a credential. */
export interface StripeConnectionResult {
  readonly outcome: StripeConnectionOutcome;
  readonly configId: string | null;
  readonly environment: StripeEnvironment | null;
  readonly reason: string;
  /** True only when the API answered a Stripe list to an authenticated read with this key. */
  readonly secretKeyAccepted: boolean;
  /** True with `secretKeyAccepted`: the two modes are separate, so the key belongs to this one. */
  readonly environmentVerified: boolean;
  /** The documented version header this test sent. */
  readonly apiVersionSent: string;
  /** How many accounts the read listed, or null. Never the accounts. */
  readonly accountsVisible: number | null;
  /** Whether a webhook signing secret is configured; the test itself cannot prove it. */
  readonly webhookSecretConfigured: boolean;
  /** The account surface STEP 163 will use. */
  readonly accountSurface: typeof STRIPE_ACCOUNT_SURFACE;
  readonly testedAtEpochMs: number;
  readonly version: number | null;
}

/**
 * Test one stored configuration against Stripe's API.
 *
 * The sealed key is opened in memory, used for exactly one read, and dropped. The outcome is written
 * back as the configuration's `lastTest`, because activation reads it — a test that is not recorded
 * cannot authorize anything, and a failure is recorded too, so a later activation is refused by the
 * record rather than by a caller's memory.
 */
export async function testStripeConnection(
  configId: string,
  options: TestStripeConnectionOptions,
): Promise<StripeConnectionResult> {
  const config = options.store.findById(configId);

  if (config === null) {
    return {
      outcome: "invalid_configuration",
      configId: null,
      environment: null,
      reason: "no Stripe key configuration holds that id",
      secretKeyAccepted: false,
      environmentVerified: false,
      apiVersionSent: STRIPE_DEFAULT_API_VERSION,
      accountsVisible: null,
      webhookSecretConfigured: false,
      accountSurface: STRIPE_ACCOUNT_SURFACE,
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
      secretKeyAccepted: false,
      environmentVerified: false,
      apiVersionSent: config.apiVersion,
      accountsVisible: null,
      webhookSecretConfigured: config.webhookSecretSealed !== null,
      accountSurface: config.accountSurface,
      testedAtEpochMs: options.occurredAtEpochMs,
      version: config.version,
    };
  }

  let secretKey: string;
  try {
    secretKey = openSecret(options.keyring, config.secretKeySealed, {
      purpose: "secret",
      scope: stripeSecretKeyScope(config.companyId),
    });
  } catch {
    return {
      outcome: "invalid_configuration",
      configId: config.id,
      environment: config.environment,
      reason: "the sealed secret key cannot be opened with this keyring",
      secretKeyAccepted: false,
      environmentVerified: false,
      apiVersionSent: config.apiVersion,
      accountsVisible: null,
      webhookSecretConfigured: config.webhookSecretSealed !== null,
      accountSurface: config.accountSurface,
      testedAtEpochMs: options.occurredAtEpochMs,
      version: config.version,
    };
  }

  let verdict: StripeAccountListVerdict;
  try {
    const answer = await (options.transport ?? stripeFetchApiTransport)(
      stripeConnectionEndpoint(),
      secretKey,
      config.apiVersion,
    );
    verdict = parseStripeAccountListAnswer(answer.status, answer.body);
  } catch {
    verdict = { outcome: "unreachable", detail: "the API could not be reached" };
  }

  const outcome: StripeConnectionOutcome = verdict.outcome;
  const next: StripeKeyConfig = {
    ...config,
    version: config.version + 1,
    lastTest: {
      outcome,
      testedAtEpochMs: options.occurredAtEpochMs,
      environment: config.environment,
      apiVersionSent: config.apiVersion,
    },
    updatedAtEpochMs: options.occurredAtEpochMs,
  };
  const stored = options.store.save(next, config.version);
  const recorded = stored ? next : options.store.findById(config.id);

  if (options.recordAudit !== undefined) {
    options.recordAudit({
      action: "provider_key.tested",
      providerKey: STRIPE_PROVIDER_KEY,
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
    reason: verdict.outcome === "connected" ? "the API accepted the key and answered with its accounts list" : verdict.detail,
    secretKeyAccepted: verdict.outcome === "connected",
    environmentVerified: verdict.outcome === "connected",
    apiVersionSent: config.apiVersion,
    accountsVisible: verdict.outcome === "connected" ? verdict.accountsVisible : null,
    webhookSecretConfigured: config.webhookSecretSealed !== null,
    accountSurface: config.accountSurface,
    testedAtEpochMs: options.occurredAtEpochMs,
    version: recorded === null ? null : recorded.version,
  };
}

/* -------------------------------------------------------------------------------------------------
 * Activation, retirement and the signing-secret roll
 * ---------------------------------------------------------------------------------------------- */

/** The options a transition needs. */
export interface StripeConfigTransitionOptions {
  readonly store: StripeConfigStore;
  readonly occurredAtEpochMs: number;
  readonly recordAudit?: (entry: StripeKeyAuditEntry) => void;
}

/** What a transition did. */
export type StripeTransitionResult =
  | { readonly status: "activated"; readonly config: StripeKeyConfig; readonly supersededConfigId: string | null }
  | { readonly status: "retired"; readonly config: StripeKeyConfig }
  | { readonly status: "failed"; readonly reason: string };

/**
 * Activate a configuration whose connection test passed.
 *
 * The refusals are the section 6 rule made concrete: the configuration must exist, must be pending,
 * must carry a `connected` test recorded for its own environment and its own API version, and must hold
 * a webhook signing secret — because a provider that can take money while its deliveries cannot be
 * verified would leave every payment in an unknown state, and this platform's rule is that no delivery
 * is trusted without a signature. Only then does the previous active configuration become `superseded`
 * and this one `active`, both version-guarded, with one audit entry for the activation and one for the
 * rotation when there was a predecessor.
 */
export function activateStripeConfig(
  configId: string,
  options: StripeConfigTransitionOptions,
): StripeTransitionResult {
  const config = options.store.findById(configId);
  if (config === null) return { status: "failed", reason: "no Stripe key configuration holds that id" };
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
  if (config.lastTest.apiVersionSent !== config.apiVersion) {
    return { status: "failed", reason: "the connection test ran on another API version than the one stored" };
  }
  if (config.webhookSecretSealed === null) {
    return {
      status: "failed",
      reason: "the webhook signing secret is not configured, so deliveries could not be verified",
    };
  }

  const previousActive = options.store.findActiveByCompany(config.companyId);

  if (previousActive !== null && previousActive.id !== config.id) {
    const superseded: StripeKeyConfig = {
      ...previousActive,
      status: "superseded",
      version: previousActive.version + 1,
      updatedAtEpochMs: options.occurredAtEpochMs,
    };
    if (options.store.save(superseded, previousActive.version) === false) {
      return { status: "failed", reason: "the active key changed while this key was being activated" };
    }
  }

  const activated: StripeKeyConfig = {
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
      providerKey: STRIPE_PROVIDER_KEY,
      companyId: activated.companyId,
      configId: activated.id,
      environment: activated.environment,
      outcome: "active",
      occurredAtEpochMs: options.occurredAtEpochMs,
    });

    if (previousActive !== null && previousActive.id !== config.id) {
      options.recordAudit({
        action: "provider_key.rotated",
        providerKey: STRIPE_PROVIDER_KEY,
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
 * retired key cannot be retired twice. A pending key may be retired, which is how an aborted rotation is
 * cancelled before it ever activates anything.
 */
export function retireStripeConfig(
  configId: string,
  options: StripeConfigTransitionOptions,
): StripeTransitionResult {
  const config = options.store.findById(configId);
  if (config === null) return { status: "failed", reason: "no Stripe key configuration holds that id" };
  if (config.status === "retired") return { status: "failed", reason: "the configuration is already retired" };
  if (config.status === "active") {
    return { status: "failed", reason: "the active key cannot be retired; activate its replacement first" };
  }

  const retired: StripeKeyConfig = {
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
      providerKey: STRIPE_PROVIDER_KEY,
      companyId: retired.companyId,
      configId: retired.id,
      environment: retired.environment,
      outcome: "retired",
      occurredAtEpochMs: options.occurredAtEpochMs,
    });
  }

  return { status: "retired", config: retired };
}

/** The options a signing-secret roll needs. */
export interface RollStripeWebhookSecretOptions extends StripeConfigTransitionOptions {
  readonly keyring: EncryptionKeyring;
}

/** What a signing-secret roll did. */
export type RollStripeWebhookSecretResult =
  | {
      readonly status: "rolled";
      readonly config: StripeKeyConfig;
      /** When the previous secret stops being accepted. */
      readonly previousValidUntilEpochMs: number;
    }
  | { readonly status: "failed"; readonly reason: string };

/**
 * Roll the webhook signing secret while keeping the previous one accepted for the documented window.
 *
 * Stripe lets an endpoint run two secrets at once for up to 24 hours, sending one signature per secret,
 * so the receiver must accept both for a while and then only the new one. That is why the previous
 * secret is kept with an expiry instead of being overwritten: STEP 164's receiver asks
 * `stripeWebhookSecretsFor` for the secrets valid at the moment a delivery arrives, and the platform's
 * verifier already reads every `v1` signature in the header.
 *
 * The secret is rolled on a pending or active configuration — the two states whose secret will be used —
 * and the new value is refused when it is identical to the current one, because a "roll" that changes
 * nothing is a mistake worth naming.
 */
export function rollStripeWebhookSecret(
  configId: string,
  webhookSecret: string,
  options: RollStripeWebhookSecretOptions,
): RollStripeWebhookSecretResult {
  const config = options.store.findById(configId);
  if (config === null) return { status: "failed", reason: "no Stripe key configuration holds that id" };
  if (config.status === "retired") return { status: "failed", reason: "a retired configuration cannot be rolled" };
  if (config.status === "superseded") {
    return { status: "failed", reason: "a superseded configuration is not receiving deliveries; roll the active one" };
  }

  const nextSecret = webhookSecret.trim();
  if (isStripeWebhookSecretShaped(nextSecret) === false) {
    return { status: "failed", reason: "the webhook signing secret must be a whsec_ value" };
  }

  if (config.webhookSecretSealed !== null) {
    let currentSecret: string;
    try {
      currentSecret = openSecret(options.keyring, config.webhookSecretSealed, {
        purpose: "secret",
        scope: stripeWebhookSecretScope(config.companyId),
      });
    } catch {
      return { status: "failed", reason: "the sealed webhook signing secret cannot be opened with this keyring" };
    }
    if (currentSecret === nextSecret) {
      return { status: "failed", reason: "the new signing secret is the same as the current one" };
    }
  }

  let nextSealed: string;
  try {
    nextSealed = sealSecret(options.keyring, nextSecret, {
      purpose: "secret",
      scope: stripeWebhookSecretScope(config.companyId),
    });
  } catch {
    return { status: "failed", reason: "the encryption keyring cannot seal a credential" };
  }

  const previousValidUntilEpochMs = options.occurredAtEpochMs + STRIPE_WEBHOOK_SECRET_OVERLAP_SECONDS * 1_000;
  const rolled: StripeKeyConfig = {
    ...config,
    webhookSecretSealed: nextSealed,
    previousWebhookSecretSealed: config.webhookSecretSealed,
    previousWebhookSecretExpiresAtEpochMs:
      config.webhookSecretSealed === null ? null : previousValidUntilEpochMs,
    version: config.version + 1,
    updatedAtEpochMs: options.occurredAtEpochMs,
  };
  if (options.store.save(rolled, config.version) === false) {
    return { status: "failed", reason: "the key changed while its signing secret was being rolled" };
  }

  if (options.recordAudit !== undefined) {
    options.recordAudit({
      action: "provider_webhook_secret.rolled",
      providerKey: STRIPE_PROVIDER_KEY,
      companyId: rolled.companyId,
      configId: rolled.id,
      environment: rolled.environment,
      outcome: config.webhookSecretSealed === null ? "configured" : "overlap_open",
      occurredAtEpochMs: options.occurredAtEpochMs,
    });
  }

  return { status: "rolled", config: rolled, previousValidUntilEpochMs };
}

/** The secrets a receiver may verify a delivery against right now. Never handed to a screen. */
export type StripeWebhookSecrets =
  | { readonly status: "opened"; readonly current: string | null; readonly previous: string | null }
  | { readonly status: "failed"; readonly reason: string };

/**
 * Open the signing secrets valid at one instant.
 *
 * `previous` is returned only while its documented overlap window is open, so a delivery signed by a
 * retired secret is refused once the window closes, exactly as Stripe stops sending that signature.
 */
export function stripeWebhookSecretsFor(
  config: StripeKeyConfig,
  keyring: EncryptionKeyring,
  nowEpochMs: number,
): StripeWebhookSecrets {
  let current: string | null = null;
  if (config.webhookSecretSealed !== null) {
    try {
      current = openSecret(keyring, config.webhookSecretSealed, {
        purpose: "secret",
        scope: stripeWebhookSecretScope(config.companyId),
      });
    } catch {
      return { status: "failed", reason: "the sealed webhook signing secret cannot be opened with this keyring" };
    }
  }

  let previous: string | null = null;
  if (
    config.previousWebhookSecretSealed !== null &&
    config.previousWebhookSecretExpiresAtEpochMs !== null &&
    nowEpochMs < config.previousWebhookSecretExpiresAtEpochMs
  ) {
    try {
      previous = openSecret(keyring, config.previousWebhookSecretSealed, {
        purpose: "secret",
        scope: stripeWebhookSecretScope(config.companyId),
      });
    } catch {
      return { status: "failed", reason: "the sealed webhook signing secret cannot be opened with this keyring" };
    }
  }

  return { status: "opened", current, previous };
}

/* -------------------------------------------------------------------------------------------------
 * The sealed-shape checks
 * ---------------------------------------------------------------------------------------------- */

/**
 * True when the stored credentials of a configuration are envelopes this platform wrote.
 *
 * The secret key and the webhook signing secret must be sealed; the publishable key must not be, because
 * it is public by design. The pair of checks is what lets an audit see, without opening anything, that
 * the configuration was built by this file and not assembled by hand.
 */
export function stripeConfigIsSealed(config: StripeKeyConfig): boolean {
  if (isSecretEnvelope(config.secretKeySealed) === false) return false;
  if (config.webhookSecretSealed !== null && isSecretEnvelope(config.webhookSecretSealed) === false) return false;
  if (config.previousWebhookSecretSealed !== null && isSecretEnvelope(config.previousWebhookSecretSealed) === false) {
    return false;
  }
  return true;
}

/** True when a configuration holds a credential a browser may receive. */
export function stripeConfigIsPublishable(config: StripeKeyConfig): boolean {
  return config.publishableKey !== null && isStripePublishableKeyShaped(config.publishableKey);
}
