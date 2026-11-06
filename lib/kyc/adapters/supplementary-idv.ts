// path: lib/kyc/adapters/supplementary-idv.ts

/**
 * The vendor-neutral contract for a supplementary identity check, and the rule that keeps it supplementary.
 *
 * ## What "supplementary" means here
 *
 * The processor decides who may charge and who may be paid out. A processor's KYB verdict lives on
 * `submerchant_provisions.status` in five words — `pending`, `action_required`, `verified`, `restricted`,
 * `rejected` — and those five words are the only ones that enable charges and payouts. A supplementary identity
 * check (Jumio, Didit or Sumsub) answers a *different* question: does the person behind the application match the
 * document they showed, and are they physically present. Its answer is **evidence for a human reviewer**, never a
 * status of its own.
 *
 * This file makes that separation structural rather than advisory:
 *
 *   - the supplementary vocabulary shares **no word** with the processor's five, so no code can pass one for the
 *     other by accident — `passed` is deliberately not `verified`, and `failed` is not `rejected`;
 *   - `refuseProcessorKybWrite` refuses every attempt by supplementary code to produce a processor status, naming
 *     the processor as authoritative;
 *   - the session record carries no processor status except an immutable **snapshot** of what the platform already
 *     knew, kept so the reviewer sees both without this module ever writing either;
 *   - the merchant sees one neutral phrase derived from the result and nothing else: never the vendor's name, never
 *     the vendor's reason, never which method ran. That is the feature list's own rule — "the merchant only sees
 *     verification status".
 *
 * ## What this STEP does not do
 *
 * No vendor is named in a request and no vendor payload is parsed: STEPs 171 (Jumio), 172 (Didit) and 173 (Sumsub)
 * read their provider's documentation and translate that provider's words into `SupplementaryIdvVendorAnswer`. STEP
 * 174 verifies and deduplicates the deliveries those vendors send, STEP 175 lets a super administrator activate at
 * most one of them and defines the manual fallback the rest of the platform reads. This file is the vocabulary and
 * the invariants all five share; it makes no network call and reads no environment variable.
 *
 * ## Manual KYC is the running mode until a vendor is connected
 *
 * `supplementaryIdvModeOf` answers `manual` when no configuration is active, `automatic` when exactly one is, and
 * `manual` again when more than one is — a defect is not resolved by picking one at random. An automatic run that is
 * late, expired, failed or unreadable becomes a manual review through `recordSupplementaryIdvAnswer`, which is why
 * every unhappy result carries a fallback rather than a rejection.
 */

import { randomUUID } from "node:crypto";
import { deepFreeze } from "../../utils/freeze.ts";
import {
  ENCRYPTION_MAXIMUM_SECRET_BYTES,
  openSecret,
  sealSecret,
  type EncryptionKeyring,
} from "../../security/encryption.ts";

/* -------------------------------------------------------------------------------------------------
 * The three vendors this contract serves
 * ---------------------------------------------------------------------------------------------- */

/** The three supplementary vendors the feature list names, in its order. */
export const SUPPLEMENTARY_IDV_VENDOR_KEYS = deepFreeze(["jumio", "didit", "sumsub"] as const);

/** One vendor of the catalogue. */
export interface SupplementaryIdvVendor {
  readonly key: SupplementaryIdvVendorKey;
  /** The vendor's own name, for office screens and documentation only — never for the merchant. */
  readonly label: string;
  /** The STEP that reads this vendor's documentation and implements its adapter. */
  readonly implementationStep: string;
}

/** A vendor key. */
export type SupplementaryIdvVendorKey = (typeof SUPPLEMENTARY_IDV_VENDOR_KEYS)[number];

/** The catalogue, with the STEP that owns each vendor's own words. */
export const SUPPLEMENTARY_IDV_VENDORS: readonly SupplementaryIdvVendor[] = deepFreeze([
  { key: "jumio", label: "Jumio", implementationStep: "STEP 171" },
  { key: "didit", label: "Didit", implementationStep: "STEP 172" },
  { key: "sumsub", label: "Sumsub", implementationStep: "STEP 173" },
]);

/** True when a value is one of the three vendor keys. */
export function isSupplementaryIdvVendorKey(value: string): value is SupplementaryIdvVendorKey {
  return (SUPPLEMENTARY_IDV_VENDOR_KEYS as readonly string[]).includes(value);
}

/** The catalogue entry for a key, or null. */
export function supplementaryIdvVendorOf(key: string): SupplementaryIdvVendor | null {
  const trimmed = key.trim();
  if (isSupplementaryIdvVendorKey(trimmed) === false) return null;
  return SUPPLEMENTARY_IDV_VENDORS.find((vendor) => vendor.key === trimmed) ?? null;
}

/* -------------------------------------------------------------------------------------------------
 * The supplementary vocabulary, which shares no word with the processor's
 * ---------------------------------------------------------------------------------------------- */

/** What a supplementary session may conclude. Five words, none of them a processor status. */
export const SUPPLEMENTARY_IDV_RESULTS = deepFreeze([
  "in_progress",
  "passed",
  "failed",
  "expired",
  "unknown",
] as const);

/** One supplementary result. */
export type SupplementaryIdvResult = (typeof SUPPLEMENTARY_IDV_RESULTS)[number];

/** The results a session never leaves. */
export const SUPPLEMENTARY_IDV_FINAL_RESULTS = deepFreeze(["passed", "failed", "expired"] as const);

/** The only moves a session's result may make: forward, and out of `unknown` once the vendor says something. */
export const SUPPLEMENTARY_IDV_RESULT_MOVES: Readonly<
  Record<SupplementaryIdvResult, readonly SupplementaryIdvResult[]>
> = deepFreeze({
  in_progress: ["in_progress", "passed", "failed", "expired"],
  passed: ["passed"],
  failed: ["failed"],
  expired: ["expired"],
  unknown: ["unknown", "in_progress", "passed", "failed", "expired"],
});

/** True when a word is one of the five supplementary results. */
export function isSupplementaryIdvResult(value: string): value is SupplementaryIdvResult {
  return (SUPPLEMENTARY_IDV_RESULTS as readonly string[]).includes(value);
}

/** True when a result is final. */
export function isSupplementaryIdvResultFinal(result: SupplementaryIdvResult): boolean {
  return (SUPPLEMENTARY_IDV_FINAL_RESULTS as readonly string[]).includes(result);
}

/**
 * The processor's five KYB statuses, exactly as migration 0054 constrains them.
 *
 * Recorded here so this file can prove it never produces one; it is not a vocabulary this module writes.
 */
export const PROCESSOR_KYB_STATUSES = deepFreeze([
  "pending",
  "action_required",
  "verified",
  "restricted",
  "rejected",
] as const);

/** One processor KYB status. */
export type ProcessorKybStatus = (typeof PROCESSOR_KYB_STATUSES)[number];

/** True when a word is a processor KYB status. */
export function isProcessorKybStatus(value: string): value is ProcessorKybStatus {
  return (PROCESSOR_KYB_STATUSES as readonly string[]).includes(value);
}

/**
 * True when a value is a word the supplementary side must never use as its own result.
 *
 * This is the guard that makes the separation executable: a vendor adapter that maps `verified` — a processor word
 * meaning "charges and payouts are enabled" — into a supplementary result is refused here by name, because the two
 * vocabularies must stay disjoint.
 */
export function supplementaryIdvOverlapsProcessorKyb(value: string): boolean {
  return isProcessorKybStatus(value.trim());
}

/** Every supplementary result is checked against the processor's five when this module loads. */
const SUPPLEMENTARY_VOCABULARY_IS_DISJOINT: boolean = SUPPLEMENTARY_IDV_RESULTS.every(
  (result) => isProcessorKybStatus(result) === false,
);

/** True when the two vocabularies share no word; the gate asserts this and every write path relies on it. */
export function supplementaryIdvVocabularyIsDisjoint(): boolean {
  return SUPPLEMENTARY_VOCABULARY_IS_DISJOINT;
}

/** The closed set of neutral reasons a session may carry. Never a vendor's own code. */
export const SUPPLEMENTARY_IDV_REASON_CODES = deepFreeze([
  "document_unreadable",
  "document_expired",
  "document_mismatch",
  "liveness_failed",
  "session_expired",
  "vendor_incomplete",
  "vendor_unreachable",
  "not_stated",
] as const);

/** One neutral reason code. */
export type SupplementaryIdvReasonCode = (typeof SUPPLEMENTARY_IDV_REASON_CODES)[number];

/** True when a value is one of the neutral reason codes. */
export function isSupplementaryIdvReasonCode(value: string): value is SupplementaryIdvReasonCode {
  return (SUPPLEMENTARY_IDV_REASON_CODES as readonly string[]).includes(value);
}

/** The document kinds this platform records, and nothing finer: a document number is never stored. */
export const SUPPLEMENTARY_IDV_DOCUMENT_KINDS = deepFreeze([
  "passport",
  "national_id",
  "driving_licence",
  "residence_permit",
  "not_stated",
] as const);

/** One document kind. */
export type SupplementaryIdvDocumentKind = (typeof SUPPLEMENTARY_IDV_DOCUMENT_KINDS)[number];

/** True when a value is a recorded document kind. */
export function isSupplementaryIdvDocumentKind(value: string): value is SupplementaryIdvDocumentKind {
  return (SUPPLEMENTARY_IDV_DOCUMENT_KINDS as readonly string[]).includes(value);
}

/** The three liveness answers, kept separate from identity because a person can match a document without being present. */
export const SUPPLEMENTARY_IDV_LIVENESS_RESULTS = deepFreeze(["in_progress", "passed", "failed", "unknown"] as const);

/** One liveness answer. */
export type SupplementaryIdvLiveness = (typeof SUPPLEMENTARY_IDV_LIVENESS_RESULTS)[number];

/** True when a value is a liveness answer. */
export function isSupplementaryIdvLiveness(value: string): value is SupplementaryIdvLiveness {
  return (SUPPLEMENTARY_IDV_LIVENESS_RESULTS as readonly string[]).includes(value);
}

/* -------------------------------------------------------------------------------------------------
 * The session record
 * ---------------------------------------------------------------------------------------------- */

/** The modes a session may run in, from the configuration it belongs to. */
export const SUPPLEMENTARY_IDV_ENVIRONMENTS = deepFreeze(["sandbox", "live"] as const);

/** One session's environment. */
export type SupplementaryIdvEnvironment = (typeof SUPPLEMENTARY_IDV_ENVIRONMENTS)[number];

/** What happens when a session cannot give the merchant an automatic answer. */
export interface SupplementaryIdvFallback {
  readonly mode: "manual";
  readonly reason: string;
  /** Always false: the merchant is never told which method ran, or why it stopped. */
  readonly merchantVisible: false;
}

/**
 * One supplementary session.
 *
 * The record holds what the platform already knew about the processor's verdict as a **snapshot**, never as an
 * outcome, and it holds no personal data beyond the document *kind*: no name, no date of birth, no document number,
 * no image and no vendor payload. The vendor's own session id is stored only so a delivery or a read can be matched
 * to this row.
 */
export interface SupplementaryIdvSession {
  readonly id: string;
  readonly companyId: string;
  readonly vendorKey: SupplementaryIdvVendorKey;
  readonly environment: SupplementaryIdvEnvironment;
  readonly configId: string;
  /** The vendor's own session id, once it has one. Opaque to this module. */
  readonly reference: string | null;
  readonly result: SupplementaryIdvResult;
  readonly liveness: SupplementaryIdvLiveness;
  readonly documentKind: SupplementaryIdvDocumentKind;
  /** The processor's status when the session was recorded; a snapshot, never a claim this module can change. */
  readonly processorKybStatusSeen: ProcessorKybStatus | null;
  readonly fallback: SupplementaryIdvFallback | null;
  readonly reasonCode: SupplementaryIdvReasonCode | null;
  readonly requiresHumanReview: boolean;
  readonly version: number;
  readonly createdAtEpochMs: number;
  readonly updatedAtEpochMs: number;
}

/** What the store reads and writes. One row per session, unique on the vendor reference per company. */
export interface SupplementaryIdvSessionStore {
  insert(session: SupplementaryIdvSession): void;
  findById(id: string): SupplementaryIdvSession | null;
  findByReference(companyId: string, vendorKey: SupplementaryIdvVendorKey, reference: string): SupplementaryIdvSession | null;
  save(next: SupplementaryIdvSession, expectedVersion: number): boolean;
}

/**
 * The in-memory store: the invariants the real table must carry — a unique row id, a unique vendor reference per
 * company and vendor, an immutable company, vendor, mode, configuration and creation snapshot, a version guard,
 * and forward-only results so a recorded pass can never be replayed into a failure or the other way round.
 */
export class InMemorySupplementaryIdvSessionStore implements SupplementaryIdvSessionStore {
  private readonly sessions = new Map<string, SupplementaryIdvSession>();

  insert(session: SupplementaryIdvSession): void {
    if (this.sessions.has(session.id)) throw new Error("duplicate session id");
    if (session.version !== 1) throw new Error("a new session starts at version 1");
    if (session.result !== "in_progress" && session.result !== "unknown") {
      throw new Error("a new session starts in progress");
    }
    if (session.reference !== null) {
      const existing = this.findByReference(session.companyId, session.vendorKey, session.reference);
      if (existing !== null) throw new Error("this vendor reference is already recorded");
    }
    this.sessions.set(session.id, session);
  }

  findById(id: string): SupplementaryIdvSession | null {
    return this.sessions.get(id) ?? null;
  }

  findByReference(
    companyId: string,
    vendorKey: SupplementaryIdvVendorKey,
    reference: string,
  ): SupplementaryIdvSession | null {
    const trimmed = reference.trim();
    return (
      [...this.sessions.values()].find(
        (session) =>
          session.companyId === companyId &&
          session.vendorKey === vendorKey &&
          session.reference === trimmed,
      ) ?? null
    );
  }

  save(next: SupplementaryIdvSession, expectedVersion: number): boolean {
    const current = this.sessions.get(next.id);
    if (current === undefined) return false;
    if (current.companyId !== next.companyId || current.vendorKey !== next.vendorKey) return false;
    if (current.environment !== next.environment || current.configId !== next.configId) return false;
    if (current.createdAtEpochMs !== next.createdAtEpochMs) return false;
    if (current.processorKybStatusSeen !== next.processorKybStatusSeen) return false;
    if (current.reference !== null && next.reference !== current.reference) return false;
    if (current.version !== expectedVersion) return false;
    if (next.version !== expectedVersion + 1) return false;
    if (SUPPLEMENTARY_IDV_RESULT_MOVES[current.result].includes(next.result) === false) return false;
    this.sessions.set(next.id, next);
    return true;
  }
}

/* -------------------------------------------------------------------------------------------------
 * The configuration, sealed
 * ---------------------------------------------------------------------------------------------- */

/** What a configuration may be. */
export const SUPPLEMENTARY_IDV_CONFIG_STATUSES = deepFreeze([
  "pending_activation",
  "active",
  "retired",
] as const);

/** One configuration status. */
export type SupplementaryIdvConfigStatus = (typeof SUPPLEMENTARY_IDV_CONFIG_STATUSES)[number];

/**
 * One vendor configuration for one company.
 *
 * Both secrets are stored sealed, under their own scopes — one per vendor and purpose — so a token sealed for Jumio
 * can never be opened as a Didit token, and a webhook secret can never be opened as a credential. The plaintext
 * exists only inside `openSupplementaryIdvConfig`'s answer.
 */
export interface SupplementaryIdvConfig {
  readonly id: string;
  readonly companyId: string;
  readonly vendorKey: SupplementaryIdvVendorKey;
  readonly environment: SupplementaryIdvEnvironment;
  readonly status: SupplementaryIdvConfigStatus;
  readonly credentialSealed: string;
  readonly webhookSecretSealed: string | null;
  readonly version: number;
  readonly createdAtEpochMs: number;
  readonly updatedAtEpochMs: number;
}

/** What reads and writes a configuration. STEP 175 owns the settings screen that drives it. */
export interface SupplementaryIdvConfigStore {
  findById(id: string): SupplementaryIdvConfig | null;
  findActiveForCompany(companyId: string): readonly SupplementaryIdvConfig[];
  listForCompany(companyId: string): readonly SupplementaryIdvConfig[];
  insert(config: SupplementaryIdvConfig): void;
  save(next: SupplementaryIdvConfig, expectedVersion: number): boolean;
}

/** The largest credential this platform accepts, matching the encryption layer's own bound. */
export const SUPPLEMENTARY_IDV_MAXIMUM_CREDENTIAL_BYTES = ENCRYPTION_MAXIMUM_SECRET_BYTES;

/** The AAD scope of a vendor's credential, which is why one vendor's token cannot be opened as another's. */
export function supplementaryIdvCredentialScope(vendorKey: SupplementaryIdvVendorKey, companyId: string): string {
  return `kyc-idv:${vendorKey}:credential:${companyId}`;
}

/** The AAD scope of a vendor's delivery secret. */
export function supplementaryIdvWebhookScope(vendorKey: SupplementaryIdvVendorKey, companyId: string): string {
  return `kyc-idv:${vendorKey}:webhook:${companyId}`;
}

/** The reason a credential is unusable, or null when it is usable. */
export function validateSupplementaryIdvCredential(value: string): string | null {
  if (value.trim().length === 0) return "a credential is required";
  if (value.length !== value.trim().length) return "a credential must not carry surrounding whitespace";
  if (Buffer.byteLength(value, "utf8") > SUPPLEMENTARY_IDV_MAXIMUM_CREDENTIAL_BYTES) {
    return "the credential is larger than this platform stores";
  }
  if (/\s/u.test(value)) return "a credential must not contain whitespace";
  return null;
}

/** A configuration with its secrets opened, for one call only. */
export interface OpenedSupplementaryIdvConfig {
  readonly vendorKey: SupplementaryIdvVendorKey;
  readonly environment: SupplementaryIdvEnvironment;
  readonly credential: string;
  readonly webhookSecret: string | null;
}

/** Either the opened secrets or the reason they could not be opened. */
export type OpenSupplementaryIdvConfigResult =
  | { readonly status: "opened"; readonly config: OpenedSupplementaryIdvConfig }
  | { readonly status: "failed"; readonly reason: string };

/**
 * Seal a credential and an optional delivery secret for one vendor and company.
 *
 * The vendor adapters call this when a super administrator saves a configuration; a plaintext credential is never
 * returned and never stored.
 */
export function sealSupplementaryIdvConfig(
  input: {
    readonly companyId: string;
    readonly vendorKey: SupplementaryIdvVendorKey;
    readonly environment: SupplementaryIdvEnvironment;
    readonly credential: string;
    readonly webhookSecret: string | null;
  },
  keyring: EncryptionKeyring,
): { readonly credentialSealed: string; readonly webhookSecretSealed: string | null } | { readonly reason: string } {
  const invalid = validateSupplementaryIdvCredential(input.credential);
  if (invalid !== null) return { reason: invalid };
  if (input.webhookSecret !== null) {
    const secretInvalid = validateSupplementaryIdvCredential(input.webhookSecret);
    if (secretInvalid !== null) return { reason: secretInvalid };
  }
  try {
    const credentialSealed = sealSecret(keyring, input.credential, {
      purpose: "secret",
      scope: supplementaryIdvCredentialScope(input.vendorKey, input.companyId),
    });
    const webhookSecretSealed =
      input.webhookSecret === null
        ? null
        : sealSecret(keyring, input.webhookSecret, {
            purpose: "secret",
            scope: supplementaryIdvWebhookScope(input.vendorKey, input.companyId),
          });
    return { credentialSealed, webhookSecretSealed };
  } catch {
    return { reason: "the encryption keyring cannot seal a credential" };
  }
}

/**
 * Open one configuration's secrets with the keyring.
 *
 * A configuration sealed for another company, another vendor or another purpose cannot be opened, which is what the
 * scope strings are for; a missing webhook secret is not a failure, because a vendor may not send deliveries.
 */
export function openSupplementaryIdvConfig(
  config: SupplementaryIdvConfig,
  keyring: EncryptionKeyring,
): OpenSupplementaryIdvConfigResult {
  try {
    const credential = openSecret(keyring, config.credentialSealed, {
      purpose: "secret",
      scope: supplementaryIdvCredentialScope(config.vendorKey, config.companyId),
    });
    const webhookSecret =
      config.webhookSecretSealed === null
        ? null
        : openSecret(keyring, config.webhookSecretSealed, {
            purpose: "secret",
            scope: supplementaryIdvWebhookScope(config.vendorKey, config.companyId),
          });
    return {
      status: "opened",
      config: {
        vendorKey: config.vendorKey,
        environment: config.environment,
        credential,
        webhookSecret,
      },
    };
  } catch {
    return { status: "failed", reason: "the sealed configuration cannot be opened with this keyring" };
  }
}

/** The in-memory configuration store, with the invariants the real table must carry. */
export class InMemorySupplementaryIdvConfigStore implements SupplementaryIdvConfigStore {
  private readonly configs = new Map<string, SupplementaryIdvConfig>();

  findById(id: string): SupplementaryIdvConfig | null {
    return this.configs.get(id) ?? null;
  }

  findActiveForCompany(companyId: string): readonly SupplementaryIdvConfig[] {
    return [...this.configs.values()].filter(
      (config) => config.companyId === companyId && config.status === "active",
    );
  }

  listForCompany(companyId: string): readonly SupplementaryIdvConfig[] {
    return [...this.configs.values()].filter((config) => config.companyId === companyId);
  }

  insert(config: SupplementaryIdvConfig): void {
    if (this.configs.has(config.id)) throw new Error("duplicate configuration id");
    if (config.version !== 1) throw new Error("a new configuration starts at version 1");
    if (config.status !== "pending_activation") throw new Error("a new configuration waits for its activation");
    if (config.webhookSecretSealed !== null && config.webhookSecretSealed.trim().length === 0) {
      throw new Error("a sealed delivery secret is never empty");
    }
    this.configs.set(config.id, config);
  }

  save(next: SupplementaryIdvConfig, expectedVersion: number): boolean {
    const current = this.configs.get(next.id);
    if (current === undefined) return false;
    if (current.companyId !== next.companyId || current.vendorKey !== next.vendorKey) return false;
    if (current.environment !== next.environment) return false;
    if (current.credentialSealed !== next.credentialSealed) return false;
    if (current.version !== expectedVersion) return false;
    if (next.version !== expectedVersion + 1) return false;
    if (current.status === "retired") return false;
    if (current.status === "active" && next.status === "pending_activation") return false;
    this.configs.set(next.id, next);
    return true;
  }
}

/* -------------------------------------------------------------------------------------------------
 * Selection and the mode the platform runs in
 * ---------------------------------------------------------------------------------------------- */

/** The most vendors a company may have active at once. */
export const SUPPLEMENTARY_IDV_MAXIMUM_ACTIVE_VENDORS = 1;

/** The two modes the platform may be in. */
export const KYC_VERIFICATION_MODES = deepFreeze(["automatic", "manual"] as const);

/** One verification mode. */
export type KycVerificationMode = (typeof KYC_VERIFICATION_MODES)[number];

/** What the platform should do for this company, and why. */
export interface SupplementaryIdvMode {
  readonly mode: KycVerificationMode;
  /** The one active vendor, or null when the platform runs manually. */
  readonly vendorKey: SupplementaryIdvVendorKey | null;
  readonly reason: string;
}

/**
 * The verification mode for a company's configurations.
 *
 * No active configuration means manual, which is the feature list's running mode. Exactly one active configuration
 * means automatic with that vendor. More than one means manual with the reason saying so: a configuration defect is
 * not repaired by choosing a vendor at random, and it must be visible to the office rather than silently resolved.
 */
export function supplementaryIdvModeOf(configs: readonly SupplementaryIdvConfig[]): SupplementaryIdvMode {
  const active = configs.filter((config) => config.status === "active");
  if (active.length === 0) {
    return { mode: "manual", vendorKey: null, reason: "no supplementary identity vendor is active" };
  }
  if (active.length > SUPPLEMENTARY_IDV_MAXIMUM_ACTIVE_VENDORS) {
    return {
      mode: "manual",
      vendorKey: null,
      reason: "more than one supplementary identity vendor is active, so none is chosen until the office fixes it",
    };
  }
  const only = active[0];
  if (only === undefined || isSupplementaryIdvVendorKey(only.vendorKey) === false) {
    return { mode: "manual", vendorKey: null, reason: "the active configuration names no known vendor" };
  }
  return {
    mode: "automatic",
    vendorKey: only.vendorKey,
    reason: `${only.vendorKey} is the one active supplementary identity vendor`,
  };
}

/** The reason a set of configurations is unusable, or null when it is usable. */
export function validateSupplementaryIdvConfigs(configs: readonly SupplementaryIdvConfig[]): string | null {
  const activePerCompany = new Map<string, number>();
  const activeVendors = new Set<string>();
  for (const config of configs) {
    if (isSupplementaryIdvVendorKey(config.vendorKey) === false) return `the configuration ${config.id} names no known vendor`;
    if (SUPPLEMENTARY_IDV_CONFIG_STATUSES.includes(config.status) === false) {
      return `the configuration ${config.id} has a status this platform does not record`;
    }
    if (config.status !== "active") continue;
    const company = `${config.companyId}|${config.environment}`;
    const vendorKey = `${company}|${config.vendorKey}`;
    if (activeVendors.has(vendorKey)) return `the vendor ${config.vendorKey} is active twice for this company`;
    activeVendors.add(vendorKey);
    const count = (activePerCompany.get(company) ?? 0) + 1;
    if (count > SUPPLEMENTARY_IDV_MAXIMUM_ACTIVE_VENDORS) {
      return "at most one supplementary identity vendor may be active for a company";
    }
    activePerCompany.set(company, count);
  }
  return null;
}

/* -------------------------------------------------------------------------------------------------
 * The vendor adapter port
 * ---------------------------------------------------------------------------------------------- */

/** What the platform asks a vendor for when it opens a session. */
export interface SupplementaryIdvSessionRequest {
  readonly companyId: string;
  /** This platform's own session id, so the vendor's answer can be matched to the row. */
  readonly sessionId: string;
  readonly environment: SupplementaryIdvEnvironment;
  /** Where the person is sent to complete the check. The vendor owns the page; the platform never sees the document. */
  readonly returnUrl: string;
}

/**
 * What a vendor adapter answers, in the neutral vocabulary.
 *
 * A vendor adapter's whole job is to read its provider's payload and fill this in: the reference it minted, the
 * result word, the liveness word, the document kind and a neutral reason. It never fills in a processor status, and
 * it never returns a card, a document number or a face image.
 */
export interface SupplementaryIdvVendorAnswer {
  readonly reference: string;
  readonly result: SupplementaryIdvResult;
  readonly liveness: SupplementaryIdvLiveness;
  readonly documentKind: SupplementaryIdvDocumentKind;
  readonly reasonCode: SupplementaryIdvReasonCode;
}

/**
 * The port every supplementary vendor implements.
 *
 * Three members, and none of them can read or write a processor status: `createSession` opens a check,
 * `readSession` asks what became of one, and `vendorKey` says which vendor it is. STEPs 171-173 implement it;
 * STEP 174 turns the deliveries a vendor sends into the same `SupplementaryIdvVendorAnswer`.
 */
export interface SupplementaryIdvAdapter {
  readonly vendorKey: SupplementaryIdvVendorKey;
  readonly createSession: (
    request: SupplementaryIdvSessionRequest,
    config: OpenedSupplementaryIdvConfig,
  ) => Promise<SupplementaryIdvVendorAnswer>;
  readonly readSession: (
    reference: string,
    config: OpenedSupplementaryIdvConfig,
  ) => Promise<SupplementaryIdvVendorAnswer>;
}

/** The members a vendor adapter must expose, so a gate can prove the port carries nothing else. */
export const SUPPLEMENTARY_IDV_ADAPTER_MEMBERS: readonly string[] = deepFreeze([
  "vendorKey",
  "createSession",
  "readSession",
]);

/** True when an object exposes exactly the port's members. */
export function isSupplementaryIdvAdapter(value: unknown): value is SupplementaryIdvAdapter {
  if (typeof value !== "object" || value === null) return false;
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== [...SUPPLEMENTARY_IDV_ADAPTER_MEMBERS].sort().join(",")) return false;
  const candidate = value as Partial<SupplementaryIdvAdapter>;
  return (
    typeof candidate.vendorKey === "string" &&
    isSupplementaryIdvVendorKey(candidate.vendorKey) &&
    typeof candidate.createSession === "function" &&
    typeof candidate.readSession === "function"
  );
}

/* -------------------------------------------------------------------------------------------------
 * The processor stays authoritative
 * ---------------------------------------------------------------------------------------------- */

/** The one authority a KYB verdict comes from, as the type the evidence carries. */
export const PROCESSOR_KYB_AUTHORITY = "processor" as const;

/** True when a value names the processor as the authority; the only answer this module accepts. */
export function isProcessorKybAuthority(value: string): boolean {
  return value === PROCESSOR_KYB_AUTHORITY;
}

/** What a supplementary result may be used for: evidence for a reviewer, and nothing else. */
export interface SupplementaryIdvEvidence {
  readonly sessionId: string;
  readonly vendorKey: SupplementaryIdvVendorKey;
  readonly result: SupplementaryIdvResult;
  readonly liveness: SupplementaryIdvLiveness;
  readonly documentKind: SupplementaryIdvDocumentKind;
  readonly reasonCode: SupplementaryIdvReasonCode | null;
  /** The processor's own status, as a snapshot the reviewer can compare against. */
  readonly processorKybStatusSeen: ProcessorKybStatus | null;
  readonly processorKybAuthority: typeof PROCESSOR_KYB_AUTHORITY;
  /** Always false: this evidence changes no charge or payout flag. */
  readonly changesProcessorKyb: false;
  /** Always true: a person decides, because a supplementary check is not a verdict. */
  readonly requiresHumanDecision: true;
}

/** Read a session as what it is: evidence. */
export function supplementaryIdvEvidenceOf(session: SupplementaryIdvSession): SupplementaryIdvEvidence {
  return {
    sessionId: session.id,
    vendorKey: session.vendorKey,
    result: session.result,
    liveness: session.liveness,
    documentKind: session.documentKind,
    reasonCode: session.reasonCode,
    processorKybStatusSeen: session.processorKybStatusSeen,
    processorKybAuthority: PROCESSOR_KYB_AUTHORITY,
    changesProcessorKyb: false,
    requiresHumanDecision: true,
  };
}

/** What a refused processor write answers. */
export interface SupplementaryIdvProcessorWriteRefusal {
  readonly status: "refused";
  readonly reason: string;
}

/**
 * Refuse to write a processor KYB status from supplementary code.
 *
 * Every call refuses, whatever it is handed: the processor's own adapter reads its own verdict, and nothing a
 * person did on Jumio's page can turn charges on. When the candidate is one of the five processor words the refusal
 * says so by name, which is the message a future caller will need.
 */
export function refuseProcessorKybWrite(candidate: string): SupplementaryIdvProcessorWriteRefusal {
  const trimmed = candidate.trim();
  return {
    status: "refused",
    reason: isProcessorKybStatus(trimmed)
      ? `${trimmed} is a processor KYB status, and only the processor adapter may record one`
      : `a supplementary identity check never writes a processor KYB status, whatever it is handed`,
  };
}

/** What the compliance reviewer is told to do, which is never an approval. */
export const SUPPLEMENTARY_IDV_DECISION_AUTHORITY = "human_reviewer";

/* -------------------------------------------------------------------------------------------------
 * What the merchant sees
 * ---------------------------------------------------------------------------------------------- */

/** The three phrases a merchant may see. None names a vendor, a reason or a method. */
export const SUPPLEMENTARY_IDV_MERCHANT_STATUSES = deepFreeze([
  "verification_in_progress",
  "verification_complete",
  "verification_incomplete",
] as const);

/** One merchant-facing phrase. */
export type SupplementaryIdvMerchantStatus = (typeof SUPPLEMENTARY_IDV_MERCHANT_STATUSES)[number];

/**
 * The merchant's view of a session.
 *
 * `passed` is `verification_complete`, a failure, an expiry and an unreadable answer are all
 * `verification_incomplete` — the merchant is never told a vendor ran, which vendor it was, or why it stopped, which
 * is the feature list's own rule. A session still running is `verification_in_progress`.
 */
export function supplementaryIdvMerchantStatusOf(result: SupplementaryIdvResult): SupplementaryIdvMerchantStatus {
  if (result === "in_progress") return "verification_in_progress";
  if (result === "passed") return "verification_complete";
  return "verification_incomplete";
}

/* -------------------------------------------------------------------------------------------------
 * Recording an answer
 * ---------------------------------------------------------------------------------------------- */

/** One audit entry this file hands to the caller's audit writer. Office-only, and free of personal data. */
export interface SupplementaryIdvAuditEntry {
  readonly action:
    | "supplementary_idv.session_opened"
    | "supplementary_idv.result_passed"
    | "supplementary_idv.result_failed"
    | "supplementary_idv.result_pending"
    | "supplementary_idv.fallback_manual"
    | "supplementary_idv.processor_write_refused";
  readonly vendorKey: SupplementaryIdvVendorKey;
  readonly companyId: string;
  readonly sessionId: string;
  readonly result: string;
  readonly reasonCode: string | null;
  /** Always true: the audit trail is for the office, and the merchant's own screen reads one neutral phrase. */
  readonly officeOnly: true;
  readonly occurredAtEpochMs: number;
}

/** What every function below needs. */
export interface SupplementaryIdvOptions {
  readonly sessionStore: SupplementaryIdvSessionStore;
  readonly occurredAtEpochMs: number;
  readonly recordAudit?: (entry: SupplementaryIdvAuditEntry) => void;
}

/** A new session, before any vendor has answered. */
export interface SupplementaryIdvSessionInput {
  readonly companyId: string;
  readonly vendorKey: SupplementaryIdvVendorKey;
  readonly environment: SupplementaryIdvEnvironment;
  readonly configId: string;
  /** The processor's status now, read from the processor's own record; null when it is not known yet. */
  readonly processorKybStatusSeen: ProcessorKybStatus | null;
}

/** What opening a session did. */
export type OpenSupplementaryIdvSessionResult =
  | { readonly status: "opened"; readonly session: SupplementaryIdvSession }
  | { readonly status: "failed"; readonly reason: string };

/**
 * Open a supplementary session.
 *
 * The row is written before the vendor is called, so a session the vendor created but the platform never recorded
 * cannot exist: the worst case is a row still `in_progress`, which is a manual review, not a lost check. The
 * processor's status is copied in as a snapshot and the record starts with no reference, no fallback and no reason.
 */
export function openSupplementaryIdvSession(
  input: SupplementaryIdvSessionInput,
  options: SupplementaryIdvOptions,
): OpenSupplementaryIdvSessionResult {
  if (isSupplementaryIdvVendorKey(input.vendorKey) === false) return { status: "failed", reason: "that is not a supplementary identity vendor" };
  if (input.companyId.trim().length === 0) return { status: "failed", reason: "a session belongs to a company" };
  if (input.configId.trim().length === 0) return { status: "failed", reason: "a session belongs to a configuration" };
  if (input.processorKybStatusSeen !== null && isProcessorKybStatus(input.processorKybStatusSeen) === false) {
    return { status: "failed", reason: "the processor snapshot is not one of the processor's statuses" };
  }

  const session: SupplementaryIdvSession = {
    id: randomUUID(),
    companyId: input.companyId,
    vendorKey: input.vendorKey,
    environment: input.environment,
    configId: input.configId,
    reference: null,
    result: "in_progress",
    liveness: "in_progress",
    documentKind: "not_stated",
    processorKybStatusSeen: input.processorKybStatusSeen,
    fallback: null,
    reasonCode: null,
    requiresHumanReview: false,
    version: 1,
    createdAtEpochMs: options.occurredAtEpochMs,
    updatedAtEpochMs: options.occurredAtEpochMs,
  };

  try {
    options.sessionStore.insert(session);
  } catch {
    return { status: "failed", reason: "the session could not be recorded" };
  }

  options.recordAudit?.({
    action: "supplementary_idv.session_opened",
    vendorKey: session.vendorKey,
    companyId: session.companyId,
    sessionId: session.id,
    result: session.result,
    reasonCode: null,
    officeOnly: true,
    occurredAtEpochMs: options.occurredAtEpochMs,
  });
  return { status: "opened", session };
}

/** The reason an answer is unusable, or null when it is usable. */
export function validateSupplementaryIdvVendorAnswer(answer: SupplementaryIdvVendorAnswer): string | null {
  const reference = answer.reference.trim();
  if (reference.length === 0) return "an answer must name the vendor's reference";
  if (reference.length > 200) return "the vendor reference is longer than this platform stores";
  if (/\s/u.test(reference)) return "a vendor reference must not contain whitespace";
  if (supplementaryIdvOverlapsProcessorKyb(answer.result)) {
    return `${answer.result} is a processor KYB status, so it is not a supplementary result`;
  }
  if (isSupplementaryIdvResult(answer.result) === false) return "the answer carries a result this platform does not record";
  if (isSupplementaryIdvLiveness(answer.liveness) === false) return "the answer carries a liveness word this platform does not record";
  if (isSupplementaryIdvDocumentKind(answer.documentKind) === false) return "the answer carries a document kind this platform does not record";
  if (isSupplementaryIdvReasonCode(answer.reasonCode) === false) return "the answer carries a reason this platform does not record";
  return null;
}

/** What recording an answer did. */
export type RecordSupplementaryIdvAnswerResult =
  | { readonly status: "recorded"; readonly session: SupplementaryIdvSession; readonly changed: boolean }
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string };

/**
 * Record one vendor answer against a session.
 *
 * The answer is validated against the closed vocabularies — and against the processor's five, which it may never
 * use — then applied forward-only. An unhappy terminal answer sets `requiresHumanReview` and a fallback to manual
 * review, because an incomplete or unsuccessful automatic check is a manual case and not a rejection. Nothing here
 * touches a charge flag, a payout flag or a processor status.
 */
export function recordSupplementaryIdvAnswer(
  sessionId: string,
  answer: SupplementaryIdvVendorAnswer,
  options: SupplementaryIdvOptions,
): RecordSupplementaryIdvAnswerResult {
  const session = options.sessionStore.findById(sessionId);
  if (session === null) return { status: "failed", reason: "no session holds that id" };

  const invalid = validateSupplementaryIdvVendorAnswer(answer);
  if (invalid !== null) return { status: "refused", reason: invalid };

  const reference = answer.reference.trim();
  if (session.reference !== null && session.reference !== reference) {
    return { status: "refused", reason: "the session already holds another vendor reference" };
  }
  if (session.reference === null) {
    const existing = options.sessionStore.findByReference(session.companyId, session.vendorKey, reference);
    if (existing !== null) return { status: "refused", reason: "that vendor reference is already recorded" };
  }
  if (session.result === answer.result && session.liveness === answer.liveness && session.reference === reference) {
    return { status: "recorded", session, changed: false };
  }
  if (SUPPLEMENTARY_IDV_RESULT_MOVES[session.result].includes(answer.result) === false) {
    return { status: "refused", reason: `a session that is ${session.result} may not become ${answer.result}` };
  }

  const terminal = isSupplementaryIdvResultFinal(answer.result);
  const unhappy = answer.result !== "passed";
  const fallback: SupplementaryIdvFallback | null =
    terminal && unhappy
      ? { mode: "manual", reason: "the automatic check did not complete successfully", merchantVisible: false }
      : null;

  const next: SupplementaryIdvSession = {
    ...session,
    reference,
    result: answer.result,
    liveness: answer.liveness,
    documentKind: answer.documentKind,
    reasonCode: answer.reasonCode,
    fallback,
    requiresHumanReview: fallback !== null,
    version: session.version + 1,
    updatedAtEpochMs: options.occurredAtEpochMs,
  };

  if (options.sessionStore.save(next, session.version) === false) {
    return { status: "refused", reason: "the session moved while its answer was being recorded" };
  }

  const action: SupplementaryIdvAuditEntry["action"] =
    answer.result === "passed"
      ? "supplementary_idv.result_passed"
      : answer.result === "in_progress"
        ? "supplementary_idv.result_pending"
        : "supplementary_idv.result_failed";
  options.recordAudit?.({
    action,
    vendorKey: next.vendorKey,
    companyId: next.companyId,
    sessionId: next.id,
    result: next.result,
    reasonCode: next.reasonCode,
    officeOnly: true,
    occurredAtEpochMs: options.occurredAtEpochMs,
  });
  if (fallback !== null) {
    options.recordAudit?.({
      action: "supplementary_idv.fallback_manual",
      vendorKey: next.vendorKey,
      companyId: next.companyId,
      sessionId: next.id,
      result: next.result,
      reasonCode: next.reasonCode,
      officeOnly: true,
      occurredAtEpochMs: options.occurredAtEpochMs,
    });
  }

  return { status: "recorded", session: next, changed: true };
}

/**
 * Record that supplementary code tried to write a processor status.
 *
 * The refusal itself is audited, so an attempt to turn a Jumio pass into `verified` leaves a trail rather than a
 * silent exception.
 */
export function recordSupplementaryIdvProcessorWriteRefusal(
  sessionId: string,
  candidate: string,
  options: SupplementaryIdvOptions & { readonly vendorKey: SupplementaryIdvVendorKey; readonly companyId: string },
): SupplementaryIdvProcessorWriteRefusal {
  if (options.sessionStore.findById(sessionId) === null) {
    return { status: "refused", reason: "no session holds that id, so there is nothing an attempt could write" };
  }
  options.recordAudit?.({
    action: "supplementary_idv.processor_write_refused",
    vendorKey: options.vendorKey,
    companyId: options.companyId,
    sessionId,
    result: candidate.trim().slice(0, 40),
    reasonCode: null,
    officeOnly: true,
    occurredAtEpochMs: options.occurredAtEpochMs,
  });
  return refuseProcessorKybWrite(candidate);
}
