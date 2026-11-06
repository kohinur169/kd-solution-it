// path: lib/kyc/adapters/supplementary-idv-verify.ts

/**
 * The gate for STEP 170: the vendor-neutral supplementary identity contract, and the rule that keeps a KYB verdict
 * where it belongs — with the processor.
 *
 * A check script, not a test file. It builds real configurations with STEP 056's encryption layer, drives the session
 * lifecycle through every result word, and tries to break the separation on purpose: a vendor answer that says
 * `verified`, a call that wants to write a processor status, a merchant screen that would leak the vendor, a second
 * active vendor. No network call is made and no real credential exists.
 */

import process from "node:process";
import type { EncryptionKeyring } from "../../security/encryption.ts";
import { isSecretEnvelope } from "../../security/encryption.ts";
import {
  InMemorySupplementaryIdvConfigStore,
  InMemorySupplementaryIdvSessionStore,
  KYC_VERIFICATION_MODES,
  PROCESSOR_KYB_AUTHORITY,
  PROCESSOR_KYB_STATUSES,
  SUPPLEMENTARY_IDV_ADAPTER_MEMBERS,
  SUPPLEMENTARY_IDV_CONFIG_STATUSES,
  SUPPLEMENTARY_IDV_DECISION_AUTHORITY,
  SUPPLEMENTARY_IDV_DOCUMENT_KINDS,
  SUPPLEMENTARY_IDV_ENVIRONMENTS,
  SUPPLEMENTARY_IDV_FINAL_RESULTS,
  SUPPLEMENTARY_IDV_LIVENESS_RESULTS,
  SUPPLEMENTARY_IDV_MAXIMUM_ACTIVE_VENDORS,
  SUPPLEMENTARY_IDV_MAXIMUM_CREDENTIAL_BYTES,
  SUPPLEMENTARY_IDV_MERCHANT_STATUSES,
  SUPPLEMENTARY_IDV_REASON_CODES,
  SUPPLEMENTARY_IDV_RESULTS,
  SUPPLEMENTARY_IDV_RESULT_MOVES,
  SUPPLEMENTARY_IDV_VENDORS,
  SUPPLEMENTARY_IDV_VENDOR_KEYS,
  isProcessorKybAuthority,
  isProcessorKybStatus,
  isSupplementaryIdvAdapter,
  isSupplementaryIdvDocumentKind,
  isSupplementaryIdvLiveness,
  isSupplementaryIdvReasonCode,
  isSupplementaryIdvResult,
  isSupplementaryIdvResultFinal,
  isSupplementaryIdvVendorKey,
  openSupplementaryIdvConfig,
  openSupplementaryIdvSession,
  recordSupplementaryIdvAnswer,
  recordSupplementaryIdvProcessorWriteRefusal,
  refuseProcessorKybWrite,
  sealSupplementaryIdvConfig,
  supplementaryIdvCredentialScope,
  supplementaryIdvEvidenceOf,
  supplementaryIdvMerchantStatusOf,
  supplementaryIdvModeOf,
  supplementaryIdvOverlapsProcessorKyb,
  supplementaryIdvVendorOf,
  supplementaryIdvVocabularyIsDisjoint,
  supplementaryIdvWebhookScope,
  validateSupplementaryIdvConfigs,
  validateSupplementaryIdvCredential,
  validateSupplementaryIdvVendorAnswer,
  type OpenedSupplementaryIdvConfig,
  type SupplementaryIdvAdapter,
  type SupplementaryIdvAuditEntry,
  type SupplementaryIdvConfig,
  type SupplementaryIdvOptions,
  type SupplementaryIdvSession,
  type SupplementaryIdvSessionStore,
  type SupplementaryIdvVendorAnswer,
  type SupplementaryIdvVendorKey,
} from "./supplementary-idv.ts";

/* ---- the check book ---- */

let checks = 0;
const failures: string[] = [];

/** Render any value for a failure message, including the bigint amounts a session may eventually carry. */
function asText(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));
}

function expect(condition: boolean, description: string): void {
  checks += 1;
  if (!condition) failures.push(description);
}

function expectEqual(actual: unknown, expected: unknown, description: string): void {
  checks += 1;
  if (actual !== expected) {
    failures.push(`${description} (expected ${asText(expected)}, received ${asText(actual)})`);
  }
}

function expectThrows(action: () => void, description: string): void {
  checks += 1;
  try {
    action();
  } catch {
    return;
  }
  failures.push(description);
}

/* ---- fixtures ---- */

const NOW = 1_760_000_000_000;
const companyId = "9b2d3e4f-0000-4000-8000-0000000000a1";
const otherCompanyId = "9b2d3e4f-0000-4000-8000-0000000000a2";
const credential = "jumio_token_AbCd1234567890";
const webhookSecret = "jumio_whsec_9876543210";
const keyring: EncryptionKeyring = { primary: { id: "k1", secret: Buffer.alloc(32, 7).toString("base64") } };
const otherKeyring: EncryptionKeyring = { primary: { id: "k2", secret: Buffer.alloc(32, 9).toString("base64") } };

function passingAnswer(overrides: Partial<SupplementaryIdvVendorAnswer> = {}): SupplementaryIdvVendorAnswer {
  return {
    reference: "session_KdJumio0000000001",
    result: "passed",
    liveness: "passed",
    documentKind: "passport",
    reasonCode: "not_stated",
    ...overrides,
  };
}

function configOf(
  overrides: Partial<SupplementaryIdvConfig> = {},
): SupplementaryIdvConfig {
  return {
    id: "0b1c2d3e-0000-4000-8000-0000000000c1",
    companyId,
    vendorKey: "jumio",
    environment: "sandbox",
    status: "active",
    credentialSealed: "kd1.placeholder",
    webhookSecretSealed: null,
    version: 3,
    createdAtEpochMs: NOW - 100_000,
    updatedAtEpochMs: NOW - 50_000,
    ...overrides,
  };
}

interface Harness {
  readonly sessionStore: InMemorySupplementaryIdvSessionStore;
  readonly audits: SupplementaryIdvAuditEntry[];
  readonly options: SupplementaryIdvOptions;
}

function harnessOf(store = new InMemorySupplementaryIdvSessionStore()): Harness {
  const audits: SupplementaryIdvAuditEntry[] = [];
  return {
    sessionStore: store,
    audits,
    options: { sessionStore: store, occurredAtEpochMs: NOW, recordAudit: (entry) => audits.push(entry) },
  };
}

/** Open one session and return it, failing loudly when the fixture does not open. */
function openedSession(harness: Harness, processorKybStatusSeen: "pending" | "action_required" | "verified" | "restricted" | "rejected" | null = "pending"): SupplementaryIdvSession {
  const opened = openSupplementaryIdvSession(
    {
      companyId,
      vendorKey: "jumio",
      environment: "sandbox",
      configId: configOf().id,
      processorKybStatusSeen,
    },
    harness.options,
  );
  if (opened.status !== "opened") throw new Error(`the fixture session did not open: ${opened.reason}`);
  return opened.session;
}

/* ---- the catalogue ---- */

function checkCatalogue(): void {
  expectEqual(SUPPLEMENTARY_IDV_VENDOR_KEYS.join(","), "jumio,didit,sumsub", "the three vendors are the feature list's");
  expectEqual(SUPPLEMENTARY_IDV_VENDORS.length, 3, "the catalogue holds three vendors");
  expectEqual(SUPPLEMENTARY_IDV_VENDORS.map((vendor) => vendor.key).join(","), SUPPLEMENTARY_IDV_VENDOR_KEYS.join(","), "the catalogue and the key list agree");
  expectEqual(SUPPLEMENTARY_IDV_VENDORS[0]?.label, "Jumio", "the first vendor is Jumio");
  expectEqual(SUPPLEMENTARY_IDV_VENDORS[1]?.label, "Didit", "the second vendor is Didit");
  expectEqual(SUPPLEMENTARY_IDV_VENDORS[2]?.label, "Sumsub", "the third vendor is Sumsub");
  expectEqual(SUPPLEMENTARY_IDV_VENDORS[0]?.implementationStep, "STEP 171", "Jumio's adapter is STEP 171");
  expectEqual(SUPPLEMENTARY_IDV_VENDORS[1]?.implementationStep, "STEP 172", "Didit's adapter is STEP 172");
  expectEqual(SUPPLEMENTARY_IDV_VENDORS[2]?.implementationStep, "STEP 173", "Sumsub's adapter is STEP 173");
  expectEqual(new Set(SUPPLEMENTARY_IDV_VENDORS.map((value) => value.key)).size, 3, "no vendor is listed twice");
  expect(Object.isFrozen(SUPPLEMENTARY_IDV_VENDORS), "the catalogue is frozen");

  expectEqual(isSupplementaryIdvVendorKey("jumio"), true, "a known vendor key is accepted");
  expectEqual(isSupplementaryIdvVendorKey("stripe"), false, "another provider is not a supplementary vendor");
  expectEqual(isSupplementaryIdvVendorKey(""), false, "an empty key is not a vendor");
  expectEqual(isSupplementaryIdvVendorKey("JUMIO"), false, "a vendor key is lower case, and no case folding is invented");
  expectEqual(supplementaryIdvVendorOf("sumsub")?.label, "Sumsub", "a padded lookup finds the vendor");
  expectEqual(supplementaryIdvVendorOf(" didit ")?.key, "didit", "a lookup trims its input");
  expectEqual(supplementaryIdvVendorOf("nmi"), null, "a payment provider has no entry here");
}

/* ---- the vocabulary, and the separation it carries ---- */

function checkVocabulary(): void {
  expectEqual(SUPPLEMENTARY_IDV_RESULTS.length, 5, "five supplementary results are recorded");
  expectEqual(SUPPLEMENTARY_IDV_RESULTS.join(","), "in_progress,passed,failed,expired,unknown", "the results are the five this file defines");
  expectEqual(PROCESSOR_KYB_STATUSES.length, 5, "five processor statuses exist");
  expectEqual(PROCESSOR_KYB_STATUSES.join(","), "pending,action_required,verified,restricted,rejected", "the processor's five are migration 0054's");
  expectEqual(supplementaryIdvVocabularyIsDisjoint(), true, "the two vocabularies share no word");

  for (const result of SUPPLEMENTARY_IDV_RESULTS) {
    expectEqual(isProcessorKybStatus(result), false, `the result ${result} is not a processor status`);
    expectEqual(supplementaryIdvOverlapsProcessorKyb(result), false, `no write path accepts ${result} as a KYB word`);
  }
  for (const status of PROCESSOR_KYB_STATUSES) {
    expectEqual(isSupplementaryIdvResult(status), false, `the processor status ${status} is not a supplementary result`);
    expectEqual(supplementaryIdvOverlapsProcessorKyb(status), true, `the overlap guard names ${status}`);
  }
  const resultWords: readonly string[] = SUPPLEMENTARY_IDV_RESULTS;
  expectEqual(resultWords.includes("passed"), true, "a pass is called passed");
  expectEqual(resultWords.includes("verified"), false, "a supplementary pass is never called verified");
  expectEqual(resultWords.includes("rejected"), false, "a supplementary failure is never called rejected");
  expectEqual(resultWords.includes("approved"), false, "there is no approval word here at all");

  expectEqual(SUPPLEMENTARY_IDV_FINAL_RESULTS.join(","), "passed,failed,expired", "three results are final");
  expectEqual(isSupplementaryIdvResultFinal("in_progress"), false, "an in-progress session is not final");
  expectEqual(isSupplementaryIdvResultFinal("unknown"), false, "an unknown session is not final, it may still settle");
  expectEqual(isSupplementaryIdvResultFinal("passed"), true, "a pass is final");
  expectEqual(isSupplementaryIdvResultFinal("expired"), true, "an expiry is final");

  for (const result of SUPPLEMENTARY_IDV_RESULTS) {
    const moves = SUPPLEMENTARY_IDV_RESULT_MOVES[result];
    expect(Array.isArray(moves), `the outcome table has an entry for ${result}`);
    if (isSupplementaryIdvResultFinal(result)) {
      expectEqual(moves.join(","), result, `the final result ${result} never moves`);
    }
    for (const move of moves) expectEqual(isSupplementaryIdvResult(move), true, `${result} may only move to a recorded word`);
  }
  expectEqual(SUPPLEMENTARY_IDV_RESULT_MOVES.in_progress.includes("passed"), true, "a running session may pass");
  expectEqual(SUPPLEMENTARY_IDV_RESULT_MOVES.in_progress.includes("failed"), true, "a running session may fail");
  expectEqual(SUPPLEMENTARY_IDV_RESULT_MOVES.in_progress.includes("expired"), true, "a running session may expire");
  expectEqual(SUPPLEMENTARY_IDV_RESULT_MOVES.passed.includes("failed"), false, "a recorded pass never becomes a failure");
  expectEqual(SUPPLEMENTARY_IDV_RESULT_MOVES.failed.includes("passed"), false, "a recorded failure never becomes a pass");
  expectEqual(SUPPLEMENTARY_IDV_RESULT_MOVES.unknown.includes("in_progress"), true, "an unknown session may still be running");
  expect(Object.isFrozen(SUPPLEMENTARY_IDV_RESULT_MOVES), "the outcome table is frozen");

  expectEqual(SUPPLEMENTARY_IDV_REASON_CODES.length, 8, "eight neutral reasons are recorded");
  for (const reason of SUPPLEMENTARY_IDV_REASON_CODES) {
    expectEqual(isSupplementaryIdvReasonCode(reason), true, `the reason ${reason} is one of the closed set`);
    expectEqual(/^[a-z_]+$/u.test(reason), true, `the reason ${reason} is a neutral code, not prose`);
  }
  expectEqual(isSupplementaryIdvReasonCode("document_unreadable"), true, "a known reason is accepted");
  expectEqual(isSupplementaryIdvReasonCode("jumio_9102"), false, "a vendor's own code is not a neutral reason");

  expectEqual(SUPPLEMENTARY_IDV_DOCUMENT_KINDS.includes("not_stated"), true, "an unstated document is recorded as such");
  expectEqual(SUPPLEMENTARY_IDV_DOCUMENT_KINDS.includes("passport"), true, "a passport is a recorded kind");
  expectEqual(isSupplementaryIdvDocumentKind("national_id"), true, "a national id is a recorded kind");
  expectEqual(isSupplementaryIdvDocumentKind("document_number"), false, "a document number is not a kind");
  expectEqual(SUPPLEMENTARY_IDV_LIVENESS_RESULTS.includes("in_progress"), true, "liveness may be running");
  expectEqual(isSupplementaryIdvLiveness("passed"), true, "liveness may pass");
  expectEqual(isSupplementaryIdvLiveness("verified"), false, "liveness never uses a processor word");
  expectEqual(SUPPLEMENTARY_IDV_ENVIRONMENTS.join(","), "sandbox,live", "two environments are recorded");
}

/* ---- the configuration, sealed ---- */

async function checkConfiguration(): Promise<void> {
  const sealed = sealSupplementaryIdvConfig(
    { companyId, vendorKey: "jumio", environment: "sandbox", credential, webhookSecret },
    keyring,
  );
  expect("reason" in sealed === false, "a valid credential seals");
  if ("reason" in sealed) throw new Error(`the fixture configuration did not seal: ${sealed.reason}`);

  expect(isSecretEnvelope(sealed.credentialSealed), "the credential is stored as an envelope");
  expect(sealed.webhookSecretSealed !== null && isSecretEnvelope(sealed.webhookSecretSealed), "the delivery secret is stored as an envelope");
  expect(sealed.credentialSealed.includes(credential) === false, "the sealed credential carries no plaintext");
  expect(sealed.webhookSecretSealed?.includes(webhookSecret) === false, "the sealed secret carries no plaintext");
  expect(sealed.credentialSealed !== sealed.webhookSecretSealed, "the two secrets seal differently");

  const opened = openSupplementaryIdvConfig(configOf({ credentialSealed: sealed.credentialSealed, webhookSecretSealed: sealed.webhookSecretSealed }), keyring);
  expectEqual(opened.status, "opened", "the configuration opens with the right keyring");
  if (opened.status === "opened") {
    expectEqual(opened.config.credential, credential, "the credential comes back exactly");
    expectEqual(opened.config.webhookSecret, webhookSecret, "the delivery secret comes back exactly");
    expectEqual(opened.config.vendorKey, "jumio", "the opened configuration names its vendor");
    expectEqual(opened.config.environment, "sandbox", "the opened configuration names its mode");
  }

  const wrongRing = openSupplementaryIdvConfig(configOf({ credentialSealed: sealed.credentialSealed }), otherKeyring);
  expectEqual(wrongRing.status, "failed", "another keyring cannot open the configuration");

  // The scope is what stops one vendor's token from opening as another's.
  const crossVendor = openSupplementaryIdvConfig(
    configOf({ vendorKey: "didit", credentialSealed: sealed.credentialSealed }),
    keyring,
  );
  expectEqual(crossVendor.status, "failed", "a Jumio credential does not open for Didit");
  if (crossVendor.status === "failed") expect(crossVendor.reason.includes("keyring"), "the failure names the keyring");

  const crossPurpose = openSupplementaryIdvConfig(
    configOf({ credentialSealed: sealed.webhookSecretSealed ?? "" }),
    keyring,
  );
  expectEqual(crossPurpose.status, "failed", "a delivery secret does not open as a credential");

  const crossCompany = openSupplementaryIdvConfig(
    configOf({ companyId: otherCompanyId, credentialSealed: sealed.credentialSealed }),
    keyring,
  );
  expectEqual(crossCompany.status, "failed", "one company's credential does not open for another company");

  expect(
    supplementaryIdvCredentialScope("jumio", companyId) !== supplementaryIdvCredentialScope("didit", companyId),
    "each vendor's credential scope differs",
  );
  expect(
    supplementaryIdvCredentialScope("jumio", companyId) !== supplementaryIdvCredentialScope("jumio", otherCompanyId),
    "each company's credential scope differs",
  );
  expect(
    supplementaryIdvCredentialScope("jumio", companyId) !== supplementaryIdvWebhookScope("jumio", companyId),
    "a credential scope differs from a delivery-secret scope",
  );
  expect(supplementaryIdvCredentialScope("jumio", companyId).includes(companyId), "the scope carries the company");
  expect(supplementaryIdvCredentialScope("jumio", companyId).length <= 200, "the scope stays inside the encryption layer's bound");
  expect(supplementaryIdvWebhookScope("sumsub", companyId).includes("sumsub"), "the webhook scope carries the vendor");

  expectEqual(validateSupplementaryIdvCredential(credential), null, "a well-formed credential is accepted");
  expectEqual(validateSupplementaryIdvCredential(""), "a credential is required", "an empty credential is refused");
  expectEqual(validateSupplementaryIdvCredential("   "), "a credential is required", "a blank credential is refused");
  expectEqual(
    validateSupplementaryIdvCredential(` ${credential}`),
    "a credential must not carry surrounding whitespace",
    "a padded credential is refused",
  );
  expectEqual(
    validateSupplementaryIdvCredential("jumio token with spaces"),
    "a credential must not contain whitespace",
    "a credential with an inner space is refused",
  );
  expectEqual(
    validateSupplementaryIdvCredential("a".repeat(SUPPLEMENTARY_IDV_MAXIMUM_CREDENTIAL_BYTES + 1)),
    "the credential is larger than this platform stores",
    "an oversized credential is refused",
  );
  expectEqual(SUPPLEMENTARY_IDV_MAXIMUM_CREDENTIAL_BYTES, 8_192, "the credential bound is the encryption layer's");

  const refusedSeal = sealSupplementaryIdvConfig(
    { companyId, vendorKey: "jumio", environment: "sandbox", credential: " ", webhookSecret: null },
    keyring,
  );
  expect("reason" in refusedSeal, "an unusable credential is never sealed");

  const store = new InMemorySupplementaryIdvConfigStore();
  store.insert(
    configOf({ status: "pending_activation", version: 1, credentialSealed: sealed.credentialSealed, webhookSecretSealed: null }),
  );
  expectEqual(store.findById(configOf().id)?.status, "pending_activation", "a stored configuration is waiting");
  expectThrows(() => store.insert(configOf({ status: "pending_activation", version: 1 })), "a configuration is inserted once");
  expectThrows(
    () => store.insert(configOf({ id: "second", status: "active", version: 1 })),
    "a new configuration cannot start active",
  );
  expectEqual(
    store.save({ ...configOf({ status: "active", version: 2 }), credentialSealed: sealed.credentialSealed }, 1),
    true,
    "a waiting configuration may be activated",
  );
  expectEqual(
    store.save({ ...configOf({ status: "pending_activation", version: 3 }), credentialSealed: sealed.credentialSealed }, 2),
    false,
    "an active configuration never goes back to waiting",
  );
  expectEqual(
    store.save({ ...configOf({ status: "active", version: 9 }), credentialSealed: sealed.credentialSealed }, 2),
    false,
    "a stale version cannot be saved",
  );
  expectEqual(
    store.save({ ...configOf({ status: "active", version: 3, vendorKey: "didit" }), credentialSealed: sealed.credentialSealed }, 2),
    false,
    "a configuration never changes vendor",
  );
  expectEqual(
    store.save({ ...configOf({ status: "active", version: 3, companyId: otherCompanyId }), credentialSealed: sealed.credentialSealed }, 2),
    false,
    "a configuration never changes company",
  );
  expectEqual(
    store.save({ ...configOf({ status: "retired", version: 3 }), credentialSealed: sealed.credentialSealed }, 2),
    true,
    "an active configuration may be retired",
  );
  expectEqual(
    store.save({ ...configOf({ status: "active", version: 4 }), credentialSealed: sealed.credentialSealed }, 3),
    false,
    "a retired configuration never comes back",
  );
  expectEqual(SUPPLEMENTARY_IDV_CONFIG_STATUSES.join(","), "pending_activation,active,retired", "three configuration statuses exist");
}

/* ---- the mode the platform runs in ---- */

function checkMode(): void {
  expectEqual(SUPPLEMENTARY_IDV_MAXIMUM_ACTIVE_VENDORS, 1, "at most one vendor may be active");
  expectEqual(KYC_VERIFICATION_MODES.join(","), "automatic,manual", "two verification modes exist");

  const none = supplementaryIdvModeOf([]);
  expectEqual(none.mode, "manual", "no configuration means manual KYC runs");
  expectEqual(none.vendorKey, null, "manual mode chooses no vendor");
  expect(none.reason.includes("no supplementary"), "the manual reason says why");

  const waiting = supplementaryIdvModeOf([configOf({ status: "pending_activation" })]);
  expectEqual(waiting.mode, "manual", "a waiting configuration is not the automatic mode");

  const retired = supplementaryIdvModeOf([configOf({ status: "retired" })]);
  expectEqual(retired.mode, "manual", "a retired configuration is not the automatic mode");

  const one = supplementaryIdvModeOf([configOf({ status: "active" })]);
  expectEqual(one.mode, "automatic", "one active vendor makes the mode automatic");
  expectEqual(one.vendorKey, "jumio", "the automatic mode names the vendor");
  expect(one.reason.includes("jumio"), "the automatic reason names the vendor for the office");

  const two = supplementaryIdvModeOf([
    configOf({ status: "active" }),
    configOf({ id: "second", vendorKey: "didit", status: "active" }),
  ]);
  expectEqual(two.mode, "manual", "two active vendors fall back to manual");
  expectEqual(two.vendorKey, null, "two active vendors choose none");
  expect(two.reason.includes("more than one"), "the reason says the configuration is defective");

  const mixed = supplementaryIdvModeOf([
    configOf({ status: "active" }),
    configOf({ id: "second", vendorKey: "didit", status: "pending_activation" }),
  ]);
  expectEqual(mixed.mode, "automatic", "a waiting second vendor does not disturb the active one");
  expectEqual(mixed.vendorKey, "jumio", "the active vendor is the one used");

  expectEqual(validateSupplementaryIdvConfigs([configOf({ status: "active" })]), null, "one active configuration is valid");
  expectEqual(
    validateSupplementaryIdvConfigs([
      configOf({ status: "active" }),
      configOf({ id: "second", vendorKey: "didit", status: "active" }),
    ]),
    "at most one supplementary identity vendor may be active for a company",
    "two active configurations are refused",
  );
  expectEqual(
    validateSupplementaryIdvConfigs([configOf({ status: "active" }), configOf({ id: "second", status: "active" })]),
    "the vendor jumio is active twice for this company",
    "the same vendor active twice is refused by name",
  );
  expectEqual(
    validateSupplementaryIdvConfigs([configOf({ vendorKey: "stripe" as SupplementaryIdvVendorKey, status: "active" })]),
    "the configuration 0b1c2d3e-0000-4000-8000-0000000000c1 names no known vendor",
    "an unknown vendor is refused by name",
  );
  expectEqual(
    validateSupplementaryIdvConfigs([
      configOf({ status: "active", companyId }),
      configOf({ id: "second", vendorKey: "didit", status: "active", companyId: otherCompanyId }),
    ]),
    null,
    "two companies may each have one active vendor",
  );
}

/* ---- opening a session ---- */

async function checkOpen(): Promise<void> {
  const harness = harnessOf();
  const session = openedSession(harness, "pending");

  expectEqual(session.result, "in_progress", "a new session is in progress");
  expectEqual(session.liveness, "in_progress", "a new session's liveness is in progress");
  expectEqual(session.documentKind, "not_stated", "a new session states no document");
  expectEqual(session.reference, null, "a new session has no vendor reference");
  expectEqual(session.fallback, null, "a new session has no fallback");
  expectEqual(session.reasonCode, null, "a new session carries no reason");
  expectEqual(session.requiresHumanReview, false, "a new session asks no one anything yet");
  expectEqual(session.processorKybStatusSeen, "pending", "the processor's status is snapshotted");
  expectEqual(session.version, 1, "a new session starts at version 1");
  expectEqual(session.createdAtEpochMs, NOW, "the opening time is the caller's clock");
  expectEqual(session.environment, "sandbox", "a new session keeps its mode");
  expectEqual(session.companyId, companyId, "a new session keeps its company");

  expectEqual(harness.audits.length, 1, "opening a session writes one audit entry");
  expectEqual(harness.audits[0]?.action, "supplementary_idv.session_opened", "the audit names the opening");
  expectEqual(harness.audits[0]?.officeOnly, true, "the audit is office-only");
  expectEqual(harness.audits[0]?.vendorKey, "jumio", "the audit names the vendor inside the office");
  expectEqual(harness.audits[0]?.sessionId, session.id, "the audit names the session");

  const keys = Object.keys(session).sort();
  expectEqual(
    keys.join(","),
    [
      "companyId",
      "configId",
      "createdAtEpochMs",
      "documentKind",
      "environment",
      "fallback",
      "id",
      "liveness",
      "processorKybStatusSeen",
      "reasonCode",
      "reference",
      "requiresHumanReview",
      "result",
      "updatedAtEpochMs",
      "vendorKey",
      "version",
    ].join(","),
    "the session record holds exactly the documented keys",
  );
  for (const forbidden of [
    "name",
    "fullName",
    "dateOfBirth",
    "documentNumber",
    "document_number",
    "address",
    "email",
    "phone",
    "image",
    "selfie",
    "payload",
    "vendorPayload",
    "credential",
    "merchantStatus",
    "processorStatus",
  ]) {
    expect(keys.includes(forbidden) === false, `the session record carries no ${forbidden}`);
  }
  expect(asText(session).includes(credential) === false, "the session record carries no credential");
  expect(asText(session).includes(webhookSecret) === false, "the session record carries no delivery secret");

  const unknownVendor = openSupplementaryIdvSession(
    { companyId, vendorKey: "nmi" as SupplementaryIdvVendorKey, environment: "sandbox", configId: configOf().id, processorKybStatusSeen: null },
    harness.options,
  );
  expectEqual(unknownVendor.status, "failed", "a session is not opened for a payment provider");
  const noCompany = openSupplementaryIdvSession(
    { companyId: "  ", vendorKey: "jumio", environment: "sandbox", configId: configOf().id, processorKybStatusSeen: null },
    harness.options,
  );
  expectEqual(noCompany.status, "failed", "a session without a company is refused");
  const noConfig = openSupplementaryIdvSession(
    { companyId, vendorKey: "jumio", environment: "sandbox", configId: "", processorKybStatusSeen: null },
    harness.options,
  );
  expectEqual(noConfig.status, "failed", "a session without a configuration is refused");
  const badSnapshot = openSupplementaryIdvSession(
    {
      companyId,
      vendorKey: "jumio",
      environment: "sandbox",
      configId: configOf().id,
      processorKybStatusSeen: "passed" as unknown as "pending",
    },
    harness.options,
  );
  expectEqual(badSnapshot.status, "failed", "a snapshot that is not a processor status is refused");
  expectEqual(harness.sessionStore.findById("nothing") === null, true, "the store finds nothing it does not hold");
}

/* ---- record invariants ---- */

async function checkStore(): Promise<void> {
  const harness = harnessOf();
  const session = openedSession(harness);

  expectThrows(() => harness.sessionStore.insert(session), "a session id is used once");
  expectThrows(
    () => harness.sessionStore.insert({ ...session, id: "second", version: 1, result: "passed" }),
    "a new session cannot start settled",
  );
  expectThrows(
    () => harness.sessionStore.insert({ ...session, id: "third", version: 2 }),
    "a new session starts at version 1",
  );

  const passed = recordSupplementaryIdvAnswer(session.id, passingAnswer(), harness.options);
  if (passed.status !== "recorded") throw new Error(`the fixture answer was not recorded: ${passed.reason}`);
  const stored = harness.sessionStore.findById(session.id);
  if (stored === null) throw new Error("the session vanished");

  expectThrows(
    () => harness.sessionStore.insert({ ...stored, id: "fourth", version: 1, result: "in_progress" }),
    "a vendor reference is recorded once per company",
  );
  expectEqual(harness.sessionStore.findByReference(companyId, "jumio", passingAnswer().reference)?.id, session.id, "the reference finds its session");
  expectEqual(harness.sessionStore.findByReference(companyId, "didit", passingAnswer().reference), null, "the reference belongs to its vendor");
  expectEqual(harness.sessionStore.findByReference(otherCompanyId, "jumio", passingAnswer().reference), null, "the reference belongs to its company");

  expectEqual(harness.sessionStore.save({ ...stored, version: 9 }, 1), false, "a stale version cannot be saved");
  expectEqual(harness.sessionStore.save({ ...stored, version: stored.version + 2 }, stored.version), false, "a version may only move by one");
  expectEqual(
    harness.sessionStore.save({ ...stored, companyId: otherCompanyId, version: stored.version + 1 }, stored.version),
    false,
    "a session never changes company",
  );
  expectEqual(
    harness.sessionStore.save({ ...stored, vendorKey: "didit", version: stored.version + 1 }, stored.version),
    false,
    "a session never changes vendor",
  );
  expectEqual(
    harness.sessionStore.save({ ...stored, environment: "live", version: stored.version + 1 }, stored.version),
    false,
    "a session never changes mode",
  );
  expectEqual(
    harness.sessionStore.save({ ...stored, configId: "another", version: stored.version + 1 }, stored.version),
    false,
    "a session never changes configuration",
  );
  expectEqual(
    harness.sessionStore.save({ ...stored, createdAtEpochMs: NOW - 1, version: stored.version + 1 }, stored.version),
    false,
    "a session keeps its creation time",
  );
  expectEqual(
    harness.sessionStore.save({ ...stored, processorKybStatusSeen: "verified", version: stored.version + 1 }, stored.version),
    false,
    "the processor snapshot never changes",
  );
  expectEqual(
    harness.sessionStore.save({ ...stored, reference: "another_reference", version: stored.version + 1 }, stored.version),
    false,
    "a session's vendor reference never changes",
  );
  expectEqual(
    harness.sessionStore.save({ ...stored, result: "failed", version: stored.version + 1 }, stored.version),
    false,
    "a recorded pass never becomes a failure",
  );
  expectEqual(
    harness.sessionStore.save({ ...stored, result: "expired", version: stored.version + 1 }, stored.version),
    false,
    "a recorded pass never expires either",
  );
  expectEqual(
    harness.sessionStore.save({ ...stored, result: "passed", version: stored.version + 1 }, stored.version),
    true,
    "a recorded pass may be recorded again",
  );
}

/* ---- recording answers ---- */

async function checkAnswers(): Promise<void> {
  // A pass.
  const passing = harnessOf();
  const passSession = openedSession(passing, "pending");
  const pass = recordSupplementaryIdvAnswer(passSession.id, passingAnswer(), passing.options);
  expectEqual(pass.status, "recorded", "a passing answer is recorded");
  if (pass.status !== "recorded") throw new Error(`the pass was refused: ${pass.reason}`);
  expectEqual(pass.changed, true, "the first pass changed the session");
  expectEqual(pass.session.result, "passed", "the session reads passed");
  expectEqual(pass.session.liveness, "passed", "the session keeps the liveness answer");
  expectEqual(pass.session.documentKind, "passport", "the session keeps the document kind");
  expectEqual(pass.session.reasonCode, "not_stated", "the session keeps the neutral reason");
  expectEqual(pass.session.reference, passingAnswer().reference, "the session keeps the vendor reference");
  expectEqual(pass.session.fallback, null, "a pass needs no fallback");
  expectEqual(pass.session.requiresHumanReview, false, "a pass asks no one anything");
  expectEqual(pass.session.version, 2, "recording an answer moves the session once");
  expectEqual(
    passing.audits.map((entry) => entry.action).join(","),
    "supplementary_idv.session_opened,supplementary_idv.result_passed",
    "a pass writes the pass action",
  );
  expectEqual(pass.session.processorKybStatusSeen, "pending", "the processor snapshot is untouched by a pass");

  // The same answer twice.
  const repeat = recordSupplementaryIdvAnswer(passSession.id, passingAnswer(), passing.options);
  expectEqual(repeat.status, "recorded", "the same answer is accepted again");
  if (repeat.status === "recorded") {
    expectEqual(repeat.changed, false, "the same answer changes nothing");
    expectEqual(repeat.session.version, 2, "the same answer writes no second version");
  }
  expectEqual(passing.audits.length, 2, "the same answer writes no second audit entry");

  // An unhappy ending falls back to manual review.
  for (const [result, reason] of [
    ["failed", "document_mismatch"],
    ["expired", "session_expired"],
  ] as const) {
    const failing = harnessOf();
    const session = openedSession(failing, "action_required");
    const applied = recordSupplementaryIdvAnswer(
      session.id,
      passingAnswer({ result, liveness: result === "failed" ? "failed" : "in_progress", reasonCode: reason }),
      failing.options,
    );
    expectEqual(applied.status, "recorded", `${result} is recorded`);
    if (applied.status !== "recorded") continue;
    expectEqual(applied.session.result, result, `the session reads ${result}`);
    expectEqual(applied.session.requiresHumanReview, true, `${result} asks a person to look`);
    expect(applied.session.fallback !== null, `${result} carries a fallback`);
    if (applied.session.fallback !== null) {
      expectEqual(applied.session.fallback.mode, "manual", `${result} falls back to manual review`);
      expectEqual(applied.session.fallback.merchantVisible, false, `${result} never tells the merchant why`);
      expect(applied.session.fallback.reason.length > 0, `${result}'s fallback says why in the office's words`);
    }
    expectEqual(applied.session.reasonCode, reason, `${result} keeps the neutral reason`);
    expectEqual(
      failing.audits.map((entry) => entry.action).join(","),
      `supplementary_idv.session_opened,supplementary_idv.result_failed,supplementary_idv.fallback_manual`,
      `${result} writes the failure and the fallback`,
    );
  }

  // A session still running.
  const running = harnessOf();
  const runningSession = openedSession(running);
  const stillRunning = recordSupplementaryIdvAnswer(
    runningSession.id,
    passingAnswer({ result: "in_progress", liveness: "in_progress", reasonCode: "vendor_incomplete" }),
    running.options,
  );
  expectEqual(stillRunning.status, "recorded", "an in-progress answer is recorded");
  if (stillRunning.status === "recorded") {
    expectEqual(stillRunning.session.result, "in_progress", "the session stays in progress");
    expectEqual(stillRunning.session.requiresHumanReview, false, "a running session asks no one yet");
    expect(stillRunning.session.fallback === null, "a running session falls back to nothing yet");
  }
  expectEqual(running.audits[running.audits.length - 1]?.action, "supplementary_idv.result_pending", "the pending answer is audited");

  // An unknown session.
  const unknownSession = recordSupplementaryIdvAnswer("no-such-session", passingAnswer(), running.options);
  expectEqual(unknownSession.status, "failed", "an answer for an unknown session is a failure");

  // The processor's five words are refused by name, which is the separation in one line.
  for (const processorWord of PROCESSOR_KYB_STATUSES) {
    const guarded = harnessOf();
    const session = openedSession(guarded);
    const refused = recordSupplementaryIdvAnswer(
      session.id,
      passingAnswer({ result: processorWord as unknown as "passed" }),
      guarded.options,
    );
    expectEqual(refused.status, "refused", `an answer of ${processorWord} is refused`);
    if (refused.status === "refused") {
      expect(refused.reason.includes(processorWord), `the refusal names ${processorWord}`);
      expect(refused.reason.includes("processor KYB status"), `the refusal says what ${processorWord} really is`);
    }
    expectEqual(guarded.sessionStore.findById(session.id)?.result, "in_progress", `the refused ${processorWord} changed nothing`);
    expectEqual(guarded.audits.length, 1, `the refused ${processorWord} wrote no second audit entry`);
  }

  // Everything else out of vocabulary.
  const invalidAnswers: readonly [SupplementaryIdvVendorAnswer, string][] = [
    [passingAnswer({ result: "approved" as unknown as "passed" }), "the result approved"],
    [passingAnswer({ liveness: "verified" as unknown as "passed" }), "the liveness verified"],
    [passingAnswer({ documentKind: "document_number" as unknown as "passport" }), "the document kind"],
    [passingAnswer({ reasonCode: "jumio_9102" as unknown as "not_stated" }), "the vendor's own reason"],
    [passingAnswer({ reference: "" }), "an empty reference"],
    [passingAnswer({ reference: "  " }), "a blank reference"],
    [passingAnswer({ reference: "with space" }), "a reference with a space"],
    [passingAnswer({ reference: "r".repeat(201) }), "an over-long reference"],
  ];
  for (const [answer, description] of invalidAnswers) {
    const guarded = harnessOf();
    const session = openedSession(guarded);
    const refused = recordSupplementaryIdvAnswer(session.id, answer, guarded.options);
    expectEqual(refused.status, "refused", `${description} is refused`);
    expectEqual(guarded.sessionStore.findById(session.id)?.result, "in_progress", `${description} changed nothing`);
    expectEqual(validateSupplementaryIdvVendorAnswer(answer) === null, false, `${description} fails validation on its own`);
  }

  // A session's vendor reference belongs to one session.
  const single = harnessOf();
  const first = openedSession(single);
  recordSupplementaryIdvAnswer(first.id, passingAnswer(), single.options);
  const secondOpened = openSupplementaryIdvSession(
    { companyId, vendorKey: "jumio", environment: "sandbox", configId: configOf().id, processorKybStatusSeen: null },
    single.options,
  );
  if (secondOpened.status !== "opened") throw new Error("the second fixture session did not open");
  const stolen = recordSupplementaryIdvAnswer(secondOpened.session.id, passingAnswer(), single.options);
  expectEqual(stolen.status, "refused", "another session's reference is refused");
  if (stolen.status === "refused") expect(stolen.reason.includes("already recorded"), "the refusal says the reference is taken");
  const otherReference = recordSupplementaryIdvAnswer(secondOpened.session.id, passingAnswer({ reference: "session_Other0001" }), single.options);
  expectEqual(otherReference.status, "recorded", "a fresh reference is recorded");

  const moved = recordSupplementaryIdvAnswer(secondOpened.session.id, passingAnswer({ reference: "session_Third0001" }), single.options);
  expectEqual(moved.status, "refused", "a recorded session refuses another reference");
  if (moved.status === "refused") expect(moved.reason.includes("another vendor reference"), "the refusal says the reference is held");
}

/* ---- what the merchant sees ---- */

function checkMerchantView(): void {
  expectEqual(SUPPLEMENTARY_IDV_MERCHANT_STATUSES.join(","), "verification_in_progress,verification_complete,verification_incomplete", "three phrases exist");
  expectEqual(supplementaryIdvMerchantStatusOf("in_progress"), "verification_in_progress", "a running session reads in progress");
  expectEqual(supplementaryIdvMerchantStatusOf("passed"), "verification_complete", "a pass reads complete");
  expectEqual(supplementaryIdvMerchantStatusOf("failed"), "verification_incomplete", "a failure reads incomplete");
  expectEqual(supplementaryIdvMerchantStatusOf("expired"), "verification_incomplete", "an expiry reads incomplete");
  expectEqual(supplementaryIdvMerchantStatusOf("unknown"), "verification_incomplete", "an unknown answer reads incomplete");

  for (const result of SUPPLEMENTARY_IDV_RESULTS) {
    const phrase = supplementaryIdvMerchantStatusOf(result);
    expect((SUPPLEMENTARY_IDV_MERCHANT_STATUSES as readonly string[]).includes(phrase), `the phrase for ${result} is one of the three`);
    for (const vendor of SUPPLEMENTARY_IDV_VENDORS) {
      expect(phrase.toLowerCase().includes(vendor.label.toLowerCase()) === false, `the phrase for ${result} never names ${vendor.label}`);
      expect(phrase.toLowerCase().includes(vendor.key) === false, `the phrase for ${result} never carries the ${vendor.key} key`);
    }
    for (const reason of SUPPLEMENTARY_IDV_REASON_CODES) {
      expect(phrase.includes(reason) === false, `the phrase for ${result} never leaks the reason ${reason}`);
    }
    expect(phrase.includes("processor") === false, `the phrase for ${result} mentions no processor`);
    expect(phrase.includes("kyb") === false, `the phrase for ${result} mentions no KYB`);
  }
}

/* ---- the processor stays authoritative ---- */

async function checkSeparation(): Promise<void> {
  for (const processorWord of PROCESSOR_KYB_STATUSES) {
    const refusal = refuseProcessorKybWrite(processorWord);
    expectEqual(refusal.status, "refused", `a write of ${processorWord} is refused`);
    expect(refusal.reason.includes(processorWord), `the refusal names ${processorWord}`);
    expect(refusal.reason.includes("processor adapter"), `the refusal points at the processor adapter`);
  }
  for (const word of ["passed", "failed", "expired", "approved", "anything"]) {
    const refusal = refuseProcessorKybWrite(word);
    expectEqual(refusal.status, "refused", `a write of ${word} is refused too`);
    expect(refusal.reason.includes("never writes a processor KYB status"), `the refusal is the same rule for ${word}`);
  }

  expectEqual(PROCESSOR_KYB_AUTHORITY, "processor", "the processor is the authority");
  expectEqual(isProcessorKybAuthority("processor"), true, "the processor is accepted as the authority");
  expectEqual(isProcessorKybAuthority("vendor"), false, "a vendor is never the authority");
  expectEqual(isProcessorKybAuthority("supplementary"), false, "this module is never the authority");
  expectEqual(SUPPLEMENTARY_IDV_DECISION_AUTHORITY, "human_reviewer", "a person decides");

  expectEqual(SUPPLEMENTARY_IDV_ADAPTER_MEMBERS.join(","), "vendorKey,createSession,readSession", "the port has three members");
  expectEqual(SUPPLEMENTARY_IDV_ADAPTER_MEMBERS.includes("readProcessorKyb"), false, "the port cannot read a processor status");
  expectEqual(SUPPLEMENTARY_IDV_ADAPTER_MEMBERS.includes("writeProcessorStatus"), false, "the port cannot write one");

  const adapter: SupplementaryIdvAdapter = {
    vendorKey: "jumio",
    createSession: async (): Promise<SupplementaryIdvVendorAnswer> => passingAnswer(),
    readSession: async (): Promise<SupplementaryIdvVendorAnswer> => passingAnswer(),
  };
  expectEqual(isSupplementaryIdvAdapter(adapter), true, "a three-member adapter satisfies the port");
  const overreaching = { ...adapter, writeProcessorStatus: async (): Promise<void> => undefined };
  expectEqual(isSupplementaryIdvAdapter(overreaching), false, "an adapter with a processor writer is not the port");
  const partial = { vendorKey: "jumio", createSession: adapter.createSession };
  expectEqual(isSupplementaryIdvAdapter(partial), false, "an adapter missing a member is not the port");
  expectEqual(isSupplementaryIdvAdapter({ ...adapter, vendorKey: "stripe" }), false, "a payment provider is not an idv adapter");
  expectEqual(isSupplementaryIdvAdapter(null), false, "null is not an adapter");
  expectEqual(isSupplementaryIdvAdapter("jumio"), false, "a string is not an adapter");
  expect(Object.isFrozen(SUPPLEMENTARY_IDV_ADAPTER_MEMBERS) === true, "the member list is frozen");

  const opened: OpenedSupplementaryIdvConfig = { vendorKey: "jumio", environment: "sandbox", credential, webhookSecret };
  const created = await adapter.createSession(
    { companyId, sessionId: "session-1", environment: "sandbox", returnUrl: "https://app.example.com/kyc/return" },
    opened,
  );
  expectEqual(created.result, "passed", "the adapter answers in the neutral vocabulary");
  expectEqual(isSupplementaryIdvVendorKey(adapter.vendorKey), true, "the adapter's vendor key is a catalogued one");
  const read = await adapter.readSession(created.reference, opened);
  expectEqual(validateSupplementaryIdvVendorAnswer(read), null, "the adapter's read answer satisfies the contract");

  const harness = harnessOf();
  const session = openedSession(harness, "pending");
  const recorded = recordSupplementaryIdvAnswer(session.id, passingAnswer(), harness.options);
  if (recorded.status !== "recorded") throw new Error("the separation fixture did not record");
  const evidence = supplementaryIdvEvidenceOf(recorded.session);
  expectEqual(evidence.processorKybAuthority, "processor", "the evidence names the processor as the authority");
  expectEqual(evidence.changesProcessorKyb, false, "the evidence changes no processor status");
  expectEqual(evidence.requiresHumanDecision, true, "the evidence needs a person");
  expectEqual(evidence.processorKybStatusSeen, "pending", "the evidence carries the snapshot");
  expectEqual(evidence.result, "passed", "the evidence carries the supplementary result");
  expectEqual(evidence.vendorKey, "jumio", "the evidence names the vendor for the office");
  const evidenceKeys = Object.keys(evidence);
  expect(evidenceKeys.includes("processorStatus") === false, "the evidence has no writable processor status");
  expect(evidenceKeys.includes("kybStatus") === false, "the evidence has no KYB field at all");
  expect(evidenceKeys.includes("chargesEnabled") === false, "nothing here touches a charge flag");
  expect(evidenceKeys.includes("payoutsEnabled") === false, "nothing here touches a payout flag");

  const refusedWrite = recordSupplementaryIdvProcessorWriteRefusal(session.id, "verified", {
    ...harness.options,
    vendorKey: "jumio",
    companyId,
  });
  expectEqual(refusedWrite.status, "refused", "a processor write is refused and recorded");
  expectEqual(harness.audits[harness.audits.length - 1]?.action, "supplementary_idv.processor_write_refused", "the attempt is audited");
  expectEqual(harness.audits[harness.audits.length - 1]?.officeOnly, true, "the attempt is office-only");
  expectEqual(harness.audits[harness.audits.length - 1]?.result, "verified", "the audit names what was attempted");

  const before = harness.audits.length;
  const orphanWrite = recordSupplementaryIdvProcessorWriteRefusal("no-such-session", "verified", {
    ...harness.options,
    vendorKey: "jumio",
    companyId,
  });
  expectEqual(orphanWrite.status, "refused", "an attempt against no session is refused");
  expectEqual(harness.audits.length, before, "an attempt against no session writes no audit row");
}

/* ---- audits keep nothing they must not ---- */

async function checkAuditHygiene(): Promise<void> {
  const harness = harnessOf();
  const session = openedSession(harness, "pending");
  recordSupplementaryIdvAnswer(session.id, passingAnswer(), harness.options);

  const failing = harnessOf();
  const failingSession = openedSession(failing, "pending");
  recordSupplementaryIdvAnswer(
    failingSession.id,
    passingAnswer({ result: "failed", liveness: "failed", reasonCode: "liveness_failed" }),
    failing.options,
  );

  const all = [...harness.audits, ...failing.audits];
  expect(all.length >= 4, "the fixtures wrote audit entries");
  for (const entry of all) {
    expectEqual(entry.officeOnly, true, "every audit entry is office-only");
    expectEqual(entry.action.startsWith("supplementary_idv."), true, "every action is in this module's vocabulary");
    expectEqual(entry.companyId, companyId, "every entry names the company");
    expectEqual(entry.occurredAtEpochMs, NOW, "every entry carries the caller's clock");
    const text = asText(entry);
    expect(text.includes(credential) === false, "no entry carries the credential");
    expect(text.includes(webhookSecret) === false, "no entry carries the delivery secret");
    expect(text.includes("session_KdJumio0000000001") === false, "no entry carries the vendor reference");
    expect(text.includes(companyId) === true, "the entry names the company, which is not personal data");
  }
  const actions = new Set(all.map((entry) => entry.action));
  expectEqual(actions.has("supplementary_idv.session_opened"), true, "the opening is recorded");
  expectEqual(actions.has("supplementary_idv.result_passed"), true, "the pass is recorded");
  expectEqual(actions.has("supplementary_idv.result_failed"), true, "the failure is recorded");
  expectEqual(actions.has("supplementary_idv.fallback_manual"), true, "the fallback is recorded");
  expectEqual(actions.has("supplementary_idv.processor_write_refused"), false, "no processor write was attempted here");
}

/* ---- running ---- */

checkCatalogue();
checkVocabulary();
await checkConfiguration();
checkMode();
await checkOpen();
await checkStore();
await checkAnswers();
checkMerchantView();
await checkSeparation();
await checkAuditHygiene();

// A last guard on the store the platform will persist: the ports are what the later STEPs bind to.
const portStore: SupplementaryIdvSessionStore = new InMemorySupplementaryIdvSessionStore();
expectEqual(portStore.findById("nothing"), null, "the port answers null for a session it does not hold");

if (failures.length > 0) {
  process.stderr.write(
    `supplementary identity contract gate failed: ${failures.length} of ${checks} checks\n${failures
      .map((failure) => `  - ${failure}`)
      .join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `supplementary identity contract gate passed: ${checks} checks (three vendors behind one port that can neither read nor write a processor KYB status, a supplementary vocabulary that shares no word with the processor's five so a pass is never called verified, sealed per-vendor and per-company credentials that no other keyring or scope opens, manual KYC while no vendor is active and only one vendor ever active, an unhappy or unreadable check that falls back to manual review, and one neutral phrase for the merchant that names no vendor and gives no reason)\n`,
);
