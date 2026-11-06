// path: lib/kyc/adapters/deliveries-verify.ts

/**
 * The gate for the supplementary identity delivery receiver.
 *
 * Run directly, because STEP 170's ownership rule keeps `package.json` out of these STEPs' hands:
 *
 *   node lib/kyc/adapters/deliveries-verify.ts
 *
 * Eleven sections, the shape STEPs 170 to 173 established: the catalogue, headers, the signature primitives, the three
 * verification methods, the three parsers, the receiver's happy paths, its refusals, its deduplication, what it keeps of
 * a body (nothing but a hash), and the source itself.
 *
 * Nothing here reaches the network: the read a delivery triggers is injected, so `readSession` is a function this gate
 * scripts, and no vendor adapter is imported.
 */

import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import type { EncryptionKeyring } from "../../security/encryption.ts";
import {
  InMemorySupplementaryIdvConfigStore,
  InMemorySupplementaryIdvSessionStore,
  PROCESSOR_KYB_STATUSES,
  recordSupplementaryIdvAnswer,
  sealSupplementaryIdvConfig,
  openSupplementaryIdvSession,
} from "./supplementary-idv.ts";
import type {
  OpenedSupplementaryIdvConfig,
  SupplementaryIdvConfig,
  SupplementaryIdvEnvironment,
  SupplementaryIdvSession,
  SupplementaryIdvVendorAnswer,
} from "./supplementary-idv.ts";
import {
  DELIVERY_UUID_PATTERN,
  DIDIT_DELIVERY_ADDRESS,
  DIDIT_DELIVERY_STATUSES,
  DIDIT_DELIVERY_USER_AGENT,
  DIDIT_READ_STATUSES,
  DIDIT_SIGNATURE_HEADER,
  DIDIT_SIGNATURE_PREVIOUS_HEADER,
  DIDIT_SIGNATURE_SIMPLE_HEADER,
  DIDIT_SIGNATURE_TOLERANCE_SECONDS,
  DIDIT_SIGNATURE_V2_HEADER,
  DIDIT_STATUS_EVENT_TYPE,
  DIDIT_TIMESTAMP_HEADER,
  InMemorySupplementaryIdvDeliveryStore,
  JUMIO_CALLBACK_ADDRESSES,
  JUMIO_CALLBACK_IPS,
  JUMIO_DELIVERY_STATUSES,
  JUMIO_READ_STATUSES,
  SUMSUB_DECISION_DELIVERY_TYPE,
  SUMSUB_DEPRECATED_DIGEST_ALGORITHM,
  SUMSUB_DIGEST_ALGORITHMS,
  SUMSUB_DIGEST_ALGORITHM_HEADER,
  SUMSUB_DIGEST_HEADER,
  SUMSUB_DELIVERY_TYPES,
  SUPPLEMENTARY_IDV_ACKNOWLEDGED_OUTCOMES,
  SUPPLEMENTARY_IDV_DELIVERY_ANSWERS,
  SUPPLEMENTARY_IDV_DELIVERY_BODY_LIMIT_BYTES,
  SUPPLEMENTARY_IDV_DELIVERY_OUTCOMES,
  SUPPLEMENTARY_IDV_MAXIMUM_DELIVERY_BYTES,
  SUPPLEMENTARY_IDV_VERIFICATION_REASONS,
  deliveryBodyHashOf,
  deliveryDigestsMatch,
  deliveryHeaderOf,
  deliveryHmacHexOf,
  isDeliveryUuid,
  isDiditDeliveryStatus,
  isDiditReadStatus,
  isJumioCallbackAddress,
  isJumioDeliveryStatus,
  isJumioReadStatus,
  isSumsubDeliveryType,
  isSupplementaryIdvDeliveryOutcome,
  parseSupplementaryIdvDelivery,
  receiveSupplementaryIdvDelivery,
  supplementaryIdvDeliveryAnswerOf,
  supplementaryIdvDeliverySummaryOf,
  verifyDiditDelivery,
  verifyJumioDelivery,
  verifySumsubDelivery,
  verifySupplementaryIdvDelivery,
} from "./deliveries.ts";
import type {
  SupplementaryIdvDeliveryAuditEntry,
  SupplementaryIdvDeliveryInput,
  SupplementaryIdvDeliveryOptions,
  SupplementaryIdvDeliveryRecord,
  SupplementaryIdvHeaders,
} from "./deliveries.ts";

/* ---- the checking harness, the same shape STEPs 170 to 173 used ---- */

let checks = 0;
const failures: string[] = [];

function expect(condition: boolean, name: string): void {
  checks += 1;
  if (condition !== true) failures.push(name);
}

function expectEqual(actual: unknown, expected: unknown, name: string): void {
  checks += 1;
  if (actual !== expected) failures.push(`${name} (read ${asText(actual)}, wanted ${asText(expected)})`);
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/* ---- fixtures ---- */

const NOW = 1_779_000_000_000;
const NOW_SECONDS = 1_779_000_000;
const COMPANY = "company_kd_deliveries_gate";
const SESSION_ID = "0f4d8a26-6b1f-4a3b-9f21-5c7e3d2a1b40";
const SUMSUB_APPLICANT = "5b594ade0a975a36c9349e66";
const DIDIT_SESSION = "11111111-2222-4333-8444-555555555555";
const JUMIO_EXECUTION = "66666666-7777-4888-9999-aaaaaaaaaaaa";
const EVENT_ID = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const WEBHOOK_SECRET = "sumsub_webhook_secret_for_the_deliveries_gate_0001";
const LIVE_WEBHOOK_SECRET = "didit_webhook_secret_for_the_deliveries_gate_0001";

const keyring: EncryptionKeyring = { primary: { id: "k1", secret: Buffer.alloc(32, 7).toString("base64") } };
const otherKeyring: EncryptionKeyring = { primary: { id: "k2", secret: Buffer.alloc(32, 9).toString("base64") } };

function configuredStore(
  options: {
    readonly vendorKey?: SupplementaryIdvConfig["vendorKey"];
    readonly status?: SupplementaryIdvConfig["status"];
    readonly environment?: SupplementaryIdvEnvironment;
    readonly companyId?: string;
    readonly ring?: EncryptionKeyring;
    readonly secret?: string | null;
  } = {},
): { readonly store: InMemorySupplementaryIdvConfigStore; readonly config: SupplementaryIdvConfig } {
  const store = new InMemorySupplementaryIdvConfigStore();
  const sealed = sealSupplementaryIdvConfig(
    {
      companyId: options.companyId ?? COMPANY,
      vendorKey: options.vendorKey ?? "sumsub",
      environment: options.environment ?? "live",
      credential: "deliveries_gate_credential_0123456789",
      webhookSecret: options.secret === undefined ? WEBHOOK_SECRET : options.secret,
    },
    options.ring ?? keyring,
  );
  if ("reason" in sealed) throw new Error(`the fixture could not be sealed: ${sealed.reason}`);
  const config: SupplementaryIdvConfig = {
    id: "cfg_delivery_0001",
    companyId: options.companyId ?? COMPANY,
    vendorKey: options.vendorKey ?? "sumsub",
    environment: options.environment ?? "live",
    status: "pending_activation",
    credentialSealed: sealed.credentialSealed,
    webhookSecretSealed: sealed.webhookSecretSealed,
    version: 1,
    createdAtEpochMs: NOW,
    updatedAtEpochMs: NOW,
  };
  store.insert(config);
  const wanted = options.status ?? "active";
  if (wanted !== "pending_activation" && store.save({ ...config, status: wanted, version: 2, updatedAtEpochMs: NOW }, 1) === false) {
    throw new Error("the fixture configuration could not be moved");
  }
  const stored = store.findById(config.id);
  if (stored === null) throw new Error("the fixture configuration was not stored");
  return { store, config: stored };
}

/** A session row that already carries a vendor reference, exactly as the adapter would leave it. */
function readySession(
  config: SupplementaryIdvConfig,
  reference: string,
): { readonly store: InMemorySupplementaryIdvSessionStore; readonly session: SupplementaryIdvSession } {
  const store = new InMemorySupplementaryIdvSessionStore();
  const opened = openSupplementaryIdvSession(
    {
      companyId: config.companyId,
      vendorKey: config.vendorKey,
      environment: config.environment,
      configId: config.id,
      processorKybStatusSeen: "pending",
    },
    { sessionStore: store, occurredAtEpochMs: NOW },
  );
  if (opened.status !== "opened") throw new Error(`the session fixture could not be opened: ${opened.reason}`);
  const recorded = recordSupplementaryIdvAnswer(
    opened.session.id,
    { reference, result: "in_progress", liveness: "in_progress", documentKind: "not_stated", reasonCode: "vendor_incomplete" },
    { sessionStore: store, occurredAtEpochMs: NOW },
  );
  if (recorded.status !== "recorded") throw new Error(`the session fixture could not record a reference: ${recorded.reason}`);
  return { store, session: recorded.session };
}

/* -- Sumsub bodies -- */

function sumsubBody(overrides: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    applicantId: SUMSUB_APPLICANT,
    inspectionId: "5cb56e8e0a975a35f333cb84",
    applicantType: "individual",
    correlationId: "req-a260b669-4f14-4bb5-a4c5-ac0218acb9a4",
    externalUserId: SESSION_ID,
    levelName: "basic-kyc-level",
    type: SUMSUB_DECISION_DELIVERY_TYPE,
    sandboxMode: false,
    reviewResult: { reviewAnswer: "GREEN" },
    reviewStatus: "completed",
    createdAt: "2026-11-07 05:05:14+0000",
    createdAtMs: "2026-11-07 05:05:14.321",
    clientId: "coolClientId",
    ...overrides,
  });
}

function sumsubHeaders(body: string, algorithm = "HMAC_SHA256_HEX", secret = WEBHOOK_SECRET): SupplementaryIdvHeaders {
  const cryptoName = algorithm === "HMAC_SHA512_HEX" ? "sha512" : "sha256";
  return {
    "Content-Type": "application/json",
    [SUMSUB_DIGEST_ALGORITHM_HEADER]: algorithm,
    [SUMSUB_DIGEST_HEADER]: createHmac(cryptoName, secret).update(body, "utf8").digest("hex"),
  };
}

/* -- Didit bodies -- */

function diditBody(overrides: Readonly<Record<string, unknown>> = {}, decision: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    event_id: EVENT_ID,
    session_id: DIDIT_SESSION,
    status: "Approved",
    webhook_type: DIDIT_STATUS_EVENT_TYPE,
    created_at: NOW_SECONDS,
    timestamp: NOW_SECONDS,
    application_id: "99999999-8888-4777-8666-555555555555",
    environment: "live",
    sandbox_scenario: null,
    workflow_id: "2176a1f4-1f27-4a1b-a2f7-5b1a1a2c3d4e",
    workflow_version: 1,
    vendor_data: SESSION_ID,
    metadata: {},
    decision: {
      session_id: DIDIT_SESSION,
      status: "Approved",
      id_verifications: [{ node_id: "n1", document_type: "PASSPORT", document_number: "X1234567" }],
      liveness_checks: [{ node_id: "n2", status: "Approved" }],
      first_name: "Ahmed",
      last_name: "Rahman",
      date_of_birth: "1990-01-01",
      ...decision,
    },
    ...overrides,
  });
}

function diditHeaders(body: string, timestampSeconds = NOW_SECONDS, secret = LIVE_WEBHOOK_SECRET): SupplementaryIdvHeaders {
  return {
    "Content-Type": "application/json",
    [DIDIT_TIMESTAMP_HEADER]: String(timestampSeconds),
    [DIDIT_SIGNATURE_HEADER]: createHmac("sha256", secret).update(body, "utf8").digest("hex"),
    "User-Agent": DIDIT_DELIVERY_USER_AGENT,
  };
}

/* -- Jumio bodies -- */

function jumioBody(overrides: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    callbackSentAt: "2026-11-07T05:05:14.776Z",
    userReference: "user_reference_not_used",
    workflowExecution: {
      id: JUMIO_EXECUTION,
      href: `https://retrieval.emea-1.jumio.ai/api/v1/workflow-executions/${JUMIO_EXECUTION}`,
      definitionKey: "10172",
      status: "PROCESSED",
    },
    account: { id: "11111111-xxxx-xxxx-xxxx-xxxxxxxxxxxx", href: "https://retrieval.emea-1.jumio.ai/api/v1/accounts/1" },
    ...overrides,
  });
}

/** A read this gate scripts: it answers what it is told, and remembers what it was asked. */
function readFixture(answer: SupplementaryIdvVendorAnswer | Error): {
  readonly calls: { readonly sessionId: string; readonly environment: string }[];
  readonly readSession: (session: SupplementaryIdvSession, opened: OpenedSupplementaryIdvConfig) => Promise<SupplementaryIdvVendorAnswer>;
} {
  const calls: { readonly sessionId: string; readonly environment: string }[] = [];
  const readSession = async (session: SupplementaryIdvSession, opened: OpenedSupplementaryIdvConfig): Promise<SupplementaryIdvVendorAnswer> => {
    calls.push({ sessionId: session.id, environment: opened.environment });
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { calls, readSession };
}

function passedAnswer(reference: string): SupplementaryIdvVendorAnswer {
  return { reference, result: "passed", liveness: "passed", documentKind: "passport", reasonCode: "not_stated" };
}

/** A delivery input, with the fixtures' defaults. */
function inputOf(overrides: Partial<SupplementaryIdvDeliveryInput> = {}): SupplementaryIdvDeliveryInput {
  return {
    vendorKey: "sumsub",
    configId: "cfg_delivery_0001",
    companyId: COMPANY,
    headers: {},
    rawBody: "",
    receivedAtEpochMs: NOW,
    peerAddress: null,
    ...overrides,
  };
}

interface StorePair {
  readonly configStore: InMemorySupplementaryIdvConfigStore;
  readonly sessionStore: InMemorySupplementaryIdvSessionStore;
}

function optionsOf(
  stores: StorePair,
  read: (session: SupplementaryIdvSession, opened: OpenedSupplementaryIdvConfig) => Promise<SupplementaryIdvVendorAnswer>,
  extra: {
    readonly deliveries?: InMemorySupplementaryIdvDeliveryStore;
    readonly ring?: EncryptionKeyring;
    readonly recordAudit?: (entry: SupplementaryIdvDeliveryAuditEntry) => void;
    readonly recordSessionAudit?: (entry: {
      readonly action: string;
      readonly vendorKey: string;
      readonly companyId: string;
      readonly sessionId: string;
      readonly officeOnly: true;
      readonly occurredAtEpochMs: number;
    }) => void;
  } = {},
): {
  readonly options: SupplementaryIdvDeliveryOptions;
  readonly deliveries: InMemorySupplementaryIdvDeliveryStore;
  readonly audits: SupplementaryIdvDeliveryAuditEntry[];
  readonly sessionAudits: { readonly action: string; readonly sessionId: string }[];
} {
  const deliveries = extra.deliveries ?? new InMemorySupplementaryIdvDeliveryStore();
  const audits: SupplementaryIdvDeliveryAuditEntry[] = [];
  const sessionAudits: { readonly action: string; readonly sessionId: string }[] = [];
  const options: SupplementaryIdvDeliveryOptions = {
    configStore: stores.configStore,
    sessionStore: stores.sessionStore,
    deliveryStore: deliveries,
    keyring: extra.ring ?? keyring,
    readSession: read,
    recordAudit: (entry) => {
      audits.push(entry);
      extra.recordAudit?.(entry);
    },
    recordSessionAudit: (entry) => {
      sessionAudits.push({ action: entry.action, sessionId: entry.sessionId });
      extra.recordSessionAudit?.(entry);
    },
  };
  return { options, deliveries, audits, sessionAudits };
}

/* ---- 1: the catalogue is the documentation's ---- */

function checkCatalogue(): void {
  expectEqual(SUPPLEMENTARY_IDV_DELIVERY_OUTCOMES.length, 9, "nine delivery outcomes");
  expectEqual(
    SUPPLEMENTARY_IDV_DELIVERY_OUTCOMES.join(","),
    "accepted,duplicate,ignored,test,unverified,malformed,unknown_session,refused,failed",
    "the outcomes are the ones this file handles",
  );
  for (const outcome of SUPPLEMENTARY_IDV_DELIVERY_OUTCOMES) {
    expect(isSupplementaryIdvDeliveryOutcome(outcome), `${outcome} is an outcome`);
    expect((PROCESSOR_KYB_STATUSES as readonly string[]).includes(outcome) === false, `${outcome} is never a processor status`);
  }
  for (const notAnOutcome of ["ok", "success", "verified", "rejected", "", "Accepted"]) {
    expect(isSupplementaryIdvDeliveryOutcome(notAnOutcome) === false, `"${notAnOutcome}" is not an outcome`);
  }
  expectEqual(SUPPLEMENTARY_IDV_ACKNOWLEDGED_OUTCOMES.join(","), "accepted,duplicate,ignored,test", "four outcomes are acknowledgements");

  for (const vendorKey of ["jumio", "didit", "sumsub"] as const) {
    const answers = SUPPLEMENTARY_IDV_DELIVERY_ANSWERS[vendorKey];
    expectEqual(Object.keys(answers).length, 9, `${vendorKey} answers every outcome`);
    for (const outcome of SUPPLEMENTARY_IDV_DELIVERY_OUTCOMES) {
      const answer = supplementaryIdvDeliveryAnswerOf(vendorKey, outcome);
      expectEqual(answers[outcome], answer, `${vendorKey}/${outcome} answers one status`);
      expect([200, 400, 401, 404, 500].includes(answer), `${vendorKey}/${outcome} answers a status this receiver uses`);
      expect(answer !== 403, `${vendorKey}/${outcome} never answers 403, which no documented class needs`);
    }
    expectEqual(supplementaryIdvDeliveryAnswerOf(vendorKey, "accepted"), 200, `${vendorKey} acknowledges a handled delivery`);
    expectEqual(supplementaryIdvDeliveryAnswerOf(vendorKey, "duplicate"), 200, `${vendorKey} acknowledges a duplicate`);
    expectEqual(supplementaryIdvDeliveryAnswerOf(vendorKey, "ignored"), 200, `${vendorKey} acknowledges an ignored delivery`);
    expectEqual(supplementaryIdvDeliveryAnswerOf(vendorKey, "test"), 200, `${vendorKey} acknowledges a test delivery`);
    expectEqual(supplementaryIdvDeliveryAnswerOf(vendorKey, "unverified"), 401, `${vendorKey} answers 401 for an unverified delivery`);
    expectEqual(supplementaryIdvDeliveryAnswerOf(vendorKey, "malformed"), 400, `${vendorKey} answers 400 for a body it cannot parse`);
    expectEqual(supplementaryIdvDeliveryAnswerOf(vendorKey, "unknown_session"), 404, `${vendorKey} answers 404 for an unknown session`);
    expectEqual(supplementaryIdvDeliveryAnswerOf(vendorKey, "refused"), 500, `${vendorKey} asks for a retry when it cannot act`);
    expectEqual(supplementaryIdvDeliveryAnswerOf(vendorKey, "failed"), 500, `${vendorKey} asks for a retry when recording failed`);
  }

  expectEqual(SUMSUB_DIGEST_HEADER, "x-payload-digest", "the Sumsub digest header is spelled as documented");
  expectEqual(SUMSUB_DIGEST_ALGORITHM_HEADER, "x-payload-digest-alg", "the Sumsub algorithm header is spelled as documented");
  expectEqual(Object.keys(SUMSUB_DIGEST_ALGORITHMS).length, 2, "two Sumsub digest algorithms are accepted");
  expectEqual(SUMSUB_DIGEST_ALGORITHMS["HMAC_SHA256_HEX"], "sha256", "the dashboard default is SHA-256");
  expectEqual(SUMSUB_DIGEST_ALGORITHMS["HMAC_SHA512_HEX"], "sha512", "SHA-512 is the other accepted algorithm");
  expectEqual(SUMSUB_DEPRECATED_DIGEST_ALGORITHM, "HMAC_SHA1_HEX", "SHA-1 is named as the deprecated one");
  expect(SUMSUB_DIGEST_ALGORITHMS["HMAC_SHA1_HEX"] === undefined, "SHA-1 is not in the accepted table");

  expectEqual(DIDIT_SIGNATURE_HEADER, "X-Signature", "Didit's raw-body signature header");
  expectEqual(DIDIT_SIGNATURE_PREVIOUS_HEADER, "X-Signature-Previous", "Didit's rotation header");
  expectEqual(DIDIT_SIGNATURE_V2_HEADER, "X-Signature-V2", "Didit's canonical-JSON header");
  expectEqual(DIDIT_SIGNATURE_SIMPLE_HEADER, "X-Signature-Simple", "Didit's envelope-only header");
  expectEqual(DIDIT_TIMESTAMP_HEADER, "X-Timestamp", "Didit's clock header");
  expectEqual(DIDIT_SIGNATURE_TOLERANCE_SECONDS, 300, "Didit documents a five-minute window");
  expectEqual(DIDIT_DELIVERY_ADDRESS, "18.203.201.92", "Didit's documented delivery address");
  expect(DIDIT_DELIVERY_USER_AGENT.startsWith("DiditWebhook/"), "Didit's documented user agent");

  expectEqual(Object.keys(JUMIO_CALLBACK_ADDRESSES).length, 3, "three Jumio data centres");
  expectEqual(JUMIO_CALLBACK_IPS.length, 18, "eighteen documented Jumio callback addresses");
  expectEqual(JUMIO_CALLBACK_ADDRESSES["us"]?.hostname, "callback.amer-1.jumio.ai", "the US callback hostname");
  expectEqual(JUMIO_CALLBACK_ADDRESSES["eu"]?.hostname, "callback.emea-1.jumio.ai", "the EU callback hostname");
  expectEqual(JUMIO_CALLBACK_ADDRESSES["sgp"]?.hostname, "callback.apac-1.jumio.ai", "the SGP callback hostname");
  for (const region of Object.values(JUMIO_CALLBACK_ADDRESSES)) {
    expectEqual(region.addresses.length, 6, `${region.hostname} documents six addresses`);
    for (const address of region.addresses) {
      expect(isJumioCallbackAddress(address), `${address} is a Jumio callback address`);
      expect(/^\d{1,3}(\.\d{1,3}){3}$/u.test(address), `${address} is an address, not a hostname`);
    }
  }
  expect(isJumioCallbackAddress("34.202.241.227"), "the first US address is allowlisted");
  expect(isJumioCallbackAddress("  34.202.241.227  "), "a padded address is allowlisted");
  expect(isJumioCallbackAddress("callback.amer-1.jumio.ai") === false, "a hostname is not an address in the allowlist");
  expect(isJumioCallbackAddress("10.0.0.1") === false, "a private address is not a Jumio callback address");
  expect(isJumioCallbackAddress("") === false, "an empty address is not allowlisted");

  expectEqual(SUMSUB_DELIVERY_TYPES.length, 3, "three Sumsub delivery types are read");
  expect(SUMSUB_DELIVERY_TYPES.includes("applicantCreated"), "applicantCreated is documented");
  expect(SUMSUB_DELIVERY_TYPES.includes("applicantPending"), "applicantPending is documented");
  expect(isSumsubDeliveryType(SUMSUB_DECISION_DELIVERY_TYPE), "the decision type is one of them");
  expectEqual(SUMSUB_DECISION_DELIVERY_TYPE, "applicantReviewed", "the decision type is applicantReviewed");
  expect(isSumsubDeliveryType("applicantOnHold") === false, "a type this file has not read is not in the catalogue");

  expectEqual(DIDIT_DELIVERY_STATUSES.length, 10, "ten Didit statuses");
  expectEqual(
    DIDIT_DELIVERY_STATUSES.join("|"),
    "Approved|Declined|In Review|In Progress|Not Started|Abandoned|Expired|Kyc Expired|Resubmitted|Awaiting User",
    "the Didit statuses are exact and case-sensitive",
  );
  expect(isDiditDeliveryStatus("Kyc Expired"), "Kyc Expired is the documented spelling with one capital K");
  expect(isDiditDeliveryStatus("kyc expired") === false, "a lower-case Kyc Expired is not a documented status");
  expect(isDiditDeliveryStatus("Approve") === false, "a truncated status is not documented");
  expectEqual(DIDIT_READ_STATUSES.length, 6, "six Didit statuses ask for a read");
  for (const status of DIDIT_READ_STATUSES) {
    expect(isDiditReadStatus(status), `${status} asks for a read`);
    expect(isDiditDeliveryStatus(status), `${status} is a documented status`);
  }
  for (const status of ["In Progress", "Not Started", "Resubmitted", "Awaiting User"]) {
    expect(isDiditReadStatus(status) === false, `${status} asks for no read`);
  }

  expectEqual(JUMIO_DELIVERY_STATUSES.length, 6, "six Jumio statuses");
  expectEqual(
    JUMIO_DELIVERY_STATUSES.join("|"),
    "INITIATED|PROCESSED|ACQUISITION_STARTED|ACQUIRED|SESSION_EXPIRED|TOKEN_EXPIRED",
    "the Jumio statuses are exact and upper case",
  );
  expect(isJumioDeliveryStatus("PROCESSED"), "PROCESSED is documented");
  expect(isJumioDeliveryStatus("processed") === false, "a lower-case status is not documented");
  expectEqual(JUMIO_READ_STATUSES.length, 4, "four Jumio statuses ask for a read");
  expect(isJumioReadStatus("PROCESSED") && isJumioReadStatus("ACQUIRED"), "a processed and an acquired workflow ask for a read");
  expect(isJumioReadStatus("SESSION_EXPIRED") && isJumioReadStatus("TOKEN_EXPIRED"), "both expiries ask for a read");
  expect(isJumioReadStatus("INITIATED") === false, "an initiated workflow asks for no read");
  expect(isJumioReadStatus("ACQUISITION_STARTED") === false, "a started acquisition asks for no read");

  expect(DELIVERY_UUID_PATTERN.test(DIDIT_SESSION), "a Didit session id is a UUID");
  expect(isDeliveryUuid(JUMIO_EXECUTION), "a Jumio workflow execution id is a UUID");
  expect(isDeliveryUuid(JUMIO_EXECUTION.toUpperCase()), "a UUID is accepted in either case");
  expect(isDeliveryUuid(SUMSUB_APPLICANT) === false, "a Sumsub applicant id is not a UUID");
  expect(isDeliveryUuid("11111111-2222-4333-8444") === false, "a truncated UUID is refused");

  expectEqual(SUPPLEMENTARY_IDV_MAXIMUM_DELIVERY_BYTES, 262_144, "the body bound");
  expectEqual(SUPPLEMENTARY_IDV_DELIVERY_BODY_LIMIT_BYTES, SUPPLEMENTARY_IDV_MAXIMUM_DELIVERY_BYTES, "the route's body limit is the same number");
  expectEqual(SUPPLEMENTARY_IDV_VERIFICATION_REASONS.length, 17, "seventeen documented refusal reasons");
  for (const reason of SUPPLEMENTARY_IDV_VERIFICATION_REASONS) {
    expect(/^[a-z_]+$/u.test(reason), `${reason} is a snake-case reason`);
  }
}

/* ---- 2: headers are read the one way ---- */

function checkHeaders(): void {
  const headers: SupplementaryIdvHeaders = {
    "Content-Type": "application/json",
    "x-payload-digest": "  abc123  ",
    "X-Timestamp": "1779000000",
    "X-Signature": "",
    "X-Signature-V2-Empty": "   ",
  };
  expectEqual(deliveryHeaderOf(headers, "x-payload-digest"), "abc123", "a lower-case header is found and trimmed");
  expectEqual(deliveryHeaderOf(headers, "X-Payload-Digest"), "abc123", "the lookup is case-insensitive");
  expectEqual(deliveryHeaderOf(headers, "X-PAYLOAD-DIGEST"), "abc123", "any casing is the same header");
  expectEqual(deliveryHeaderOf(headers, "X-Timestamp"), "1779000000", "a mixed-case header is found");
  expectEqual(deliveryHeaderOf(headers, "x-timestamp"), "1779000000", "either spelling of the clock header works");
  expectEqual(deliveryHeaderOf(headers, "X-Signature"), null, "an empty header is absent");
  expectEqual(deliveryHeaderOf(headers, "X-Signature-V2-Empty"), null, "a whitespace header is absent");
  expectEqual(deliveryHeaderOf(headers, "X-Missing"), null, "a missing header is absent");
  expectEqual(deliveryHeaderOf(headers, "payload-digest"), null, "a partial name does not match");
  expectEqual(deliveryHeaderOf(headers, "  x-payload-digest  "), "abc123", "the requested name is trimmed");
  expectEqual(deliveryHeaderOf({}, "x-payload-digest"), null, "an empty map holds nothing");
  expectEqual(deliveryHeaderOf({ "X-A": "1", "x-a": "2" }, "x-a"), "1", "the first spelling wins, deterministically");
}

/* ---- 3: the signature primitives ---- */

function checkPrimitives(): void {
  const body = sumsubBody();
  const hash = deliveryBodyHashOf(body);
  expectEqual(hash.length, 64, "the body hash is a SHA-256 digest");
  expect(/^[0-9a-f]{64}$/u.test(hash), "the body hash is lower-case hex");
  expectEqual(hash, deliveryBodyHashOf(body), "the body hash is deterministic");
  expectEqual(hash, createHash("sha256").update(body, "utf8").digest("hex"), "the body hash is SHA-256 over the bytes");
  expect(deliveryBodyHashOf(`${body} `) !== hash, "one extra byte is a different hash");
  expect(deliveryBodyHashOf("") !== deliveryBodyHashOf(" "), "an empty body and a space are different bytes");
  expect(deliveryBodyHashOf("") !== hash && deliveryBodyHashOf(" ") !== hash, "neither is the body it was compared with");

  const sha256 = deliveryHmacHexOf("sha256", WEBHOOK_SECRET, body);
  const sha512 = deliveryHmacHexOf("sha512", WEBHOOK_SECRET, body);
  expectEqual(sha256.length, 64, "an HMAC-SHA256 digest is 64 hex characters");
  expectEqual(sha512.length, 128, "an HMAC-SHA512 digest is 128 hex characters");
  expectEqual(sha256, createHmac("sha256", WEBHOOK_SECRET).update(body, "utf8").digest("hex"), "the HMAC is the documented HMAC");
  expectEqual(sha512, createHmac("sha512", WEBHOOK_SECRET).update(body, "utf8").digest("hex"), "the SHA-512 HMAC is the documented HMAC");
  expect(sha256 !== sha512, "the two algorithms differ");
  expect(deliveryHmacHexOf("sha256", `${WEBHOOK_SECRET}x`, body) !== sha256, "a different secret is a different digest");
  expect(deliveryHmacHexOf("sha256", WEBHOOK_SECRET, `${body}x`) !== sha256, "a different body is a different digest");

  expect(deliveryDigestsMatch(sha256, sha256), "a digest matches itself");
  expect(deliveryDigestsMatch(sha256, sha256.toUpperCase()), "the comparison ignores case");
  expect(deliveryDigestsMatch(sha256, `  ${sha256}  `), "the comparison ignores padding");
  expect(deliveryDigestsMatch(sha256, sha512) === false, "digests of different lengths do not match");
  expect(deliveryDigestsMatch(sha256, "") === false, "an empty candidate does not match");
  expect(deliveryDigestsMatch("", "") === false, "two empty digests do not match");
  expect(deliveryDigestsMatch(sha256, `${sha256.slice(0, 63)}0`) === false, "a one-character difference does not match");
  expect(deliveryDigestsMatch("not-hex", "not-hex") === true, "the comparison is over strings, not parsers");
}

/* ---- 4: Verifying a Sumsub delivery ---- */

function checkSumsubVerification(): void {
  const body = sumsubBody();
  const good = sumsubHeaders(body);
  const verified = verifySumsubDelivery(good, body, { webhookSecret: WEBHOOK_SECRET });
  expectEqual(verified.verdict, "verified", "a correct digest verifies");
  if (verified.verdict === "verified") {
    expectEqual(verified.vendorKey, "sumsub", "the verdict names Sumsub");
    expectEqual(verified.method, "HMAC_SHA256_HEX", "the method is the documented algorithm name");
  }

  const sha512 = sumsubHeaders(body, "HMAC_SHA512_HEX");
  const verified512 = verifySumsubDelivery(sha512, body, { webhookSecret: WEBHOOK_SECRET });
  expectEqual(verified512.verdict, "verified", "a SHA-512 digest verifies");

  const lowerCaseHeaders = { "X-Payload-Digest": good[SUMSUB_DIGEST_HEADER] ?? "", [SUMSUB_DIGEST_ALGORITHM_HEADER]: "HMAC_SHA256_HEX" };
  expectEqual(verifySumsubDelivery(lowerCaseHeaders, body, { webhookSecret: WEBHOOK_SECRET }).verdict, "verified", "a differently cased header still verifies");

  const cases: readonly (readonly [SupplementaryIdvHeaders, string, string | null, string, string])[] = [
    [{ [SUMSUB_DIGEST_ALGORITHM_HEADER]: "HMAC_SHA256_HEX" }, body, WEBHOOK_SECRET, "refused", "a missing digest is refused"],
    [{ [SUMSUB_DIGEST_HEADER]: good[SUMSUB_DIGEST_HEADER] ?? "" }, body, WEBHOOK_SECRET, "refused", "a missing algorithm is refused"],
    [{ [SUMSUB_DIGEST_HEADER]: good[SUMSUB_DIGEST_HEADER] ?? "", [SUMSUB_DIGEST_ALGORITHM_HEADER]: "HMAC_SHA1_HEX" }, body, WEBHOOK_SECRET, "refused", "the deprecated SHA-1 algorithm is refused"],
    [{ [SUMSUB_DIGEST_HEADER]: good[SUMSUB_DIGEST_HEADER] ?? "", [SUMSUB_DIGEST_ALGORITHM_HEADER]: "HMAC_SHA3_256_HEX" }, body, WEBHOOK_SECRET, "refused", "an algorithm this file has not read is refused"],
    [{ [SUMSUB_DIGEST_HEADER]: "0".repeat(64), [SUMSUB_DIGEST_ALGORITHM_HEADER]: "HMAC_SHA256_HEX" }, body, WEBHOOK_SECRET, "refused", "a wrong digest is refused"],
    [{ [SUMSUB_DIGEST_HEADER]: good[SUMSUB_DIGEST_HEADER] ?? "", [SUMSUB_DIGEST_ALGORITHM_HEADER]: "HMAC_SHA256_HEX" }, body, null, "refused", "a missing secret is refused"],
    [{ [SUMSUB_DIGEST_HEADER]: good[SUMSUB_DIGEST_HEADER] ?? "", [SUMSUB_DIGEST_ALGORITHM_HEADER]: "HMAC_SHA256_HEX" }, "", WEBHOOK_SECRET, "refused", "an empty body is refused"],
  ];
  for (const [headers, rawBody, secret, verdict, name] of cases) {
    expectEqual(verifySumsubDelivery(headers, rawBody, { webhookSecret: secret }).verdict, verdict, name);
  }

  const reasonOf = (headers: SupplementaryIdvHeaders, rawBody: string, secret: string | null): string => {
    const result = verifySumsubDelivery(headers, rawBody, { webhookSecret: secret });
    return result.verdict === "verified" ? "verified" : result.reason;
  };
  expectEqual(reasonOf({ [SUMSUB_DIGEST_ALGORITHM_HEADER]: "HMAC_SHA256_HEX" }, body, WEBHOOK_SECRET), "digest_missing", "the reason names the missing digest");
  expectEqual(reasonOf({ [SUMSUB_DIGEST_HEADER]: "x" }, body, WEBHOOK_SECRET), "digest_algorithm_missing", "the reason names the missing algorithm");
  expectEqual(
    reasonOf({ [SUMSUB_DIGEST_HEADER]: "x", [SUMSUB_DIGEST_ALGORITHM_HEADER]: "HMAC_SHA1_HEX" }, body, WEBHOOK_SECRET),
    "digest_algorithm_deprecated",
    "the reason names the deprecated algorithm",
  );
  expectEqual(
    reasonOf({ [SUMSUB_DIGEST_HEADER]: "x", [SUMSUB_DIGEST_ALGORITHM_HEADER]: "NOPE" }, body, WEBHOOK_SECRET),
    "digest_algorithm_unknown",
    "the reason names the unknown algorithm",
  );
  expectEqual(
    reasonOf({ [SUMSUB_DIGEST_HEADER]: "0".repeat(64), [SUMSUB_DIGEST_ALGORITHM_HEADER]: "HMAC_SHA256_HEX" }, body, WEBHOOK_SECRET),
    "digest_mismatch",
    "the reason names the mismatch",
  );
  expectEqual(
    reasonOf({ [SUMSUB_DIGEST_HEADER]: good[SUMSUB_DIGEST_HEADER] ?? "", [SUMSUB_DIGEST_ALGORITHM_HEADER]: "HMAC_SHA256_HEX" }, body, null),
    "secret_missing",
    "the reason names the missing secret",
  );

  // The bytes, not a re-encoding: a digest of the re-serialized payload does not verify.
  const reparsed = JSON.stringify(JSON.parse(body) as unknown);
  const reEncodedDigest = createHmac("sha256", WEBHOOK_SECRET).update(reparsed, "utf8").digest("hex");
  const reEncodedHeaders = { [SUMSUB_DIGEST_HEADER]: reEncodedDigest, [SUMSUB_DIGEST_ALGORITHM_HEADER]: "HMAC_SHA256_HEX" };
  if (reparsed === body) {
    expectEqual(verifySumsubDelivery(reEncodedHeaders, body, { webhookSecret: WEBHOOK_SECRET }).verdict, "verified", "a body with no re-encoding difference verifies");
  } else {
    expectEqual(verifySumsubDelivery(reEncodedHeaders, body, { webhookSecret: WEBHOOK_SECRET }).verdict, "refused", "a digest of a re-serialized body does not verify");
  }
  const spacedBody = `${body.slice(0, 1)} ${body.slice(1)}`;
  expectEqual(verifySumsubDelivery(good, spacedBody, { webhookSecret: WEBHOOK_SECRET }).verdict, "refused", "one extra space breaks the digest");
  expectEqual(verifySumsubDelivery(good, ` ${body}`, { webhookSecret: WEBHOOK_SECRET }).verdict, "refused", "a leading space breaks the digest");
}

/* ---- 5: Verifying a Didit delivery ---- */

function checkDiditVerification(): void {
  const body = diditBody();
  const good = diditHeaders(body);
  const verified = verifyDiditDelivery(good, body, { webhookSecret: LIVE_WEBHOOK_SECRET }, NOW);
  expectEqual(verified.verdict, "verified", "a correct X-Signature verifies");
  if (verified.verdict === "verified") {
    expectEqual(verified.vendorKey, "didit", "the verdict names Didit");
    expectEqual(verified.method, "X-Signature", "the method names the raw-body header");
  }

  const previous = {
    [DIDIT_TIMESTAMP_HEADER]: String(NOW_SECONDS),
    [DIDIT_SIGNATURE_HEADER]: "0".repeat(64),
    [DIDIT_SIGNATURE_PREVIOUS_HEADER]: createHmac("sha256", LIVE_WEBHOOK_SECRET).update(body, "utf8").digest("hex"),
  };
  const viaPrevious = verifyDiditDelivery(previous, body, { webhookSecret: LIVE_WEBHOOK_SECRET }, NOW);
  expectEqual(viaPrevious.verdict, "verified", "the previous signature is accepted during a rotation");
  if (viaPrevious.verdict === "verified") expectEqual(viaPrevious.method, "X-Signature-Previous", "the method names the previous header");

  const currentWins = {
    [DIDIT_TIMESTAMP_HEADER]: String(NOW_SECONDS),
    [DIDIT_SIGNATURE_HEADER]: createHmac("sha256", LIVE_WEBHOOK_SECRET).update(body, "utf8").digest("hex"),
    [DIDIT_SIGNATURE_PREVIOUS_HEADER]: "0".repeat(64),
  };
  expectEqual(verifyDiditDelivery(currentWins, body, { webhookSecret: LIVE_WEBHOOK_SECRET }, NOW).verdict, "verified", "a current signature wins over a wrong previous one");

  const reasonOf = (headers: SupplementaryIdvHeaders, rawBody: string, secret: string | null, now = NOW): string => {
    const result = verifyDiditDelivery(headers, rawBody, { webhookSecret: secret }, now);
    return result.verdict === "verified" ? "verified" : result.reason;
  };
  const at = (seconds: number): SupplementaryIdvHeaders => ({ ...good, [DIDIT_TIMESTAMP_HEADER]: String(NOW_SECONDS + seconds) });

  expectEqual(reasonOf(at(DIDIT_SIGNATURE_TOLERANCE_SECONDS), body, LIVE_WEBHOOK_SECRET), "verified", "exactly the allowed window still verifies");
  expectEqual(reasonOf(at(-DIDIT_SIGNATURE_TOLERANCE_SECONDS), body, LIVE_WEBHOOK_SECRET), "verified", "the window is two-sided");
  expectEqual(reasonOf(at(DIDIT_SIGNATURE_TOLERANCE_SECONDS + 1), body, LIVE_WEBHOOK_SECRET), "timestamp_stale", "one second outside the window is stale");
  expectEqual(reasonOf(at(-(DIDIT_SIGNATURE_TOLERANCE_SECONDS + 1)), body, LIVE_WEBHOOK_SECRET), "timestamp_stale", "one second early is stale too");
  expectEqual(reasonOf({ ...good, [DIDIT_TIMESTAMP_HEADER]: "soon" }, body, LIVE_WEBHOOK_SECRET), "timestamp_malformed", "a word is not a timestamp");
  expectEqual(reasonOf({ ...good, [DIDIT_TIMESTAMP_HEADER]: "1e9" }, body, LIVE_WEBHOOK_SECRET), "timestamp_malformed", "an exponent is not a timestamp");
  expectEqual(reasonOf({ [DIDIT_SIGNATURE_HEADER]: good[DIDIT_SIGNATURE_HEADER] ?? "" }, body, LIVE_WEBHOOK_SECRET), "timestamp_missing", "a missing clock is refused");
  expectEqual(reasonOf({ [DIDIT_TIMESTAMP_HEADER]: String(NOW_SECONDS) }, body, LIVE_WEBHOOK_SECRET), "signature_missing", "a missing signature is refused");
  expectEqual(
    reasonOf({ [DIDIT_TIMESTAMP_HEADER]: String(NOW_SECONDS), [DIDIT_SIGNATURE_V2_HEADER]: "a".repeat(64) }, body, LIVE_WEBHOOK_SECRET),
    "signature_only_canonical_json",
    "a V2-only delivery is refused rather than half-checked",
  );
  expectEqual(
    reasonOf({ [DIDIT_TIMESTAMP_HEADER]: String(NOW_SECONDS), [DIDIT_SIGNATURE_SIMPLE_HEADER]: "a".repeat(64) }, body, LIVE_WEBHOOK_SECRET),
    "signature_only_envelope",
    "an envelope-only signature is refused",
  );
  expectEqual(reasonOf({ ...good, [DIDIT_SIGNATURE_HEADER]: "0".repeat(64) }, body, LIVE_WEBHOOK_SECRET), "signature_mismatch", "a wrong signature is refused");
  expectEqual(reasonOf(good, body, `${LIVE_WEBHOOK_SECRET}x`), "signature_mismatch", "a wrong secret is a mismatch");
  expectEqual(reasonOf(good, body, null), "secret_missing", "a configuration with no secret refuses every delivery");
  expectEqual(reasonOf(good, `${body} `, LIVE_WEBHOOK_SECRET), "signature_mismatch", "a body with one extra byte is a mismatch");

  // A V2 header alongside a valid X-Signature does not weaken the check.
  expectEqual(
    reasonOf({ ...good, [DIDIT_SIGNATURE_V2_HEADER]: "a".repeat(64) }, body, LIVE_WEBHOOK_SECRET),
    "verified",
    "a valid X-Signature verifies even beside a V2 header this file does not compute",
  );
}

/* ---- 6: Verifying a Jumio delivery ---- */

function checkJumioVerification(): void {
  expectEqual(verifyJumioDelivery(null).verdict, "unsigned", "no peer address means unsigned, not verified");
  if (verifyJumioDelivery(null).verdict === "unsigned") {
    const unsigned = verifyJumioDelivery(null);
    if (unsigned.verdict === "unsigned") expectEqual(unsigned.reason, "peer_address_missing", "the reason names the missing address");
  }
  expectEqual(verifyJumioDelivery("").verdict, "unsigned", "an empty address means unsigned");
  expectEqual(verifyJumioDelivery("   ").verdict, "unsigned", "a whitespace address means unsigned");

  const allowlisted = verifyJumioDelivery("34.202.241.227");
  expectEqual(allowlisted.verdict, "verified", "a documented address verifies by allowlist");
  if (allowlisted.verdict === "verified") {
    expectEqual(allowlisted.vendorKey, "jumio", "the verdict names Jumio");
    expectEqual(allowlisted.method, "IP allowlist", "the method says what was actually checked");
  }
  expectEqual(verifyJumioDelivery(" 34.202.241.227 ").verdict, "verified", "a padded documented address verifies");

  const refused = verifyJumioDelivery("203.0.113.9");
  expectEqual(refused.verdict, "refused", "an address outside the allowlist is refused");
  if (refused.verdict === "refused") expectEqual(refused.reason, "peer_address_refused", "the reason names the address");

  let allowlistedCount = 0;
  for (const address of JUMIO_CALLBACK_IPS) {
    if (verifyJumioDelivery(address).verdict === "verified") allowlistedCount += 1;
  }
  expectEqual(allowlistedCount, 18, "every documented Jumio address verifies");

  expectEqual(verifyJumioDelivery("callback.amer-1.jumio.ai").verdict, "refused", "the hostname is not an address and is refused");
  expectEqual(verifyJumioDelivery("34.202.241.2270").verdict, "refused", "a look-alike address is refused");
  expectEqual(verifyJumioDelivery("::1").verdict, "refused", "an IPv6 loopback is refused");

  // The dispatcher, which is what a route calls.
  const sumsubBodyText = sumsubBody();
  expectEqual(
    verifySupplementaryIdvDelivery("sumsub", sumsubHeaders(sumsubBodyText), sumsubBodyText, { webhookSecret: WEBHOOK_SECRET }, { nowEpochMs: NOW, peerAddress: null }).verdict,
    "verified",
    "the dispatcher verifies a Sumsub body",
  );
  const diditBodyText = diditBody();
  expectEqual(
    verifySupplementaryIdvDelivery("didit", diditHeaders(diditBodyText), diditBodyText, { webhookSecret: LIVE_WEBHOOK_SECRET }, { nowEpochMs: NOW, peerAddress: null }).verdict,
    "verified",
    "the dispatcher verifies a Didit body",
  );
  expectEqual(
    verifySupplementaryIdvDelivery("didit", diditHeaders(diditBodyText), diditBodyText, { webhookSecret: LIVE_WEBHOOK_SECRET }, { nowEpochMs: NOW + 600_000, peerAddress: null }).verdict,
    "refused",
    "the dispatcher applies the Didit clock window",
  );
  expectEqual(
    verifySupplementaryIdvDelivery("jumio", {}, "{}", { webhookSecret: null }, { nowEpochMs: NOW, peerAddress: "34.202.241.227" }).verdict,
    "verified",
    "the dispatcher verifies a Jumio address",
  );
  const oversized = verifySupplementaryIdvDelivery("sumsub", {}, "x".repeat(SUPPLEMENTARY_IDV_MAXIMUM_DELIVERY_BYTES + 1), { webhookSecret: WEBHOOK_SECRET }, { nowEpochMs: NOW, peerAddress: null });
  expectEqual(oversized.verdict, "refused", "the dispatcher refuses a body beyond the bound");
  if (oversized.verdict === "refused") expectEqual(oversized.reason, "body_too_large", "and names the bound as the reason");
}

/* ---- 7: reading a delivery ---- */

function checkParsing(): void {
  const sumsub = parseSupplementaryIdvDelivery("sumsub", sumsubBody());
  expect(sumsub !== null, "a Sumsub delivery parses");
  if (sumsub !== null) {
    expectEqual(sumsub.vendorKey, "sumsub", "the vendor is Sumsub");
    expectEqual(sumsub.deliveryType, "applicantReviewed", "the type is read");
    expectEqual(sumsub.status, "completed", "the review status is kept as the vendor's word");
    expectEqual(sumsub.reference, SUMSUB_APPLICANT, "the applicant id is the reference");
    expectEqual(sumsub.sessionId, SESSION_ID, "our own id is read from externalUserId");
    expectEqual(sumsub.environment, "live", "sandboxMode false is the live environment");
    expectEqual(sumsub.testMode, false, "a production body is not a test");
    expectEqual(sumsub.wantsRead, true, "an applicantReviewed delivery asks for a read");
    expectEqual(sumsub.deliveryKey, deliveryBodyHashOf(sumsubBody()), "Sumsub has no delivery id, so the body hash is the key");
    expect(sumsub.deliveryKey.startsWith("event:") === false, "a Sumsub delivery never claims an event key");
    expectEqual(sumsub.bodyHash, deliveryBodyHashOf(sumsubBody()), "the body hash is kept");
    expectEqual(sumsub.occurredAtEpochMs, null, "a formatted date string is not invented into an epoch");
  }

  const sandbox = parseSupplementaryIdvDelivery("sumsub", sumsubBody({ sandboxMode: true }));
  expectEqual(sandbox?.environment, "sandbox", "sandboxMode true is the sandbox environment");
  const test = parseSupplementaryIdvDelivery("sumsub", sumsubBody({ testMode: true }));
  expectEqual(test?.testMode, true, "testMode true is a test delivery");
  const pending = parseSupplementaryIdvDelivery("sumsub", sumsubBody({ type: "applicantPending" }));
  expectEqual(pending?.wantsRead, false, "an applicantPending delivery asks for no read");
  const created = parseSupplementaryIdvDelivery("sumsub", sumsubBody({ type: "applicantCreated" }));
  expectEqual(created?.wantsRead, false, "an applicantCreated delivery asks for no read");
  const unread = parseSupplementaryIdvDelivery("sumsub", sumsubBody({ type: "applicantOnHold" }));
  expect(unread !== null, "a type this file has not read still parses");
  expectEqual(unread?.wantsRead, false, "and asks for no read");
  expectEqual(unread?.deliveryType, "applicantOnHold", "and keeps the vendor's own type");
  const noType = parseSupplementaryIdvDelivery("sumsub", JSON.stringify({ applicantId: SUMSUB_APPLICANT }));
  expectEqual(noType, null, "a body without a type is not a Sumsub delivery");
  const badApplicant = parseSupplementaryIdvDelivery("sumsub", sumsubBody({ applicantId: "not-an-id" }));
  expectEqual(badApplicant?.reference, null, "an applicant id that is not 24 characters is not a reference");
  expectEqual(parseSupplementaryIdvDelivery("sumsub", "not json"), null, "a non-JSON body is not a delivery");
  expectEqual(parseSupplementaryIdvDelivery("sumsub", "[1,2,3]"), null, "an array is not a delivery");
  expectEqual(parseSupplementaryIdvDelivery("sumsub", "null"), null, "null is not a delivery");

  const didit = parseSupplementaryIdvDelivery("didit", diditBody());
  expect(didit !== null, "a Didit delivery parses");
  if (didit !== null) {
    expectEqual(didit.vendorKey, "didit", "the vendor is Didit");
    expectEqual(didit.deliveryType, "status.updated", "the event family is read");
    expectEqual(didit.status, "Approved", "the status is exact");
    expectEqual(didit.reference, DIDIT_SESSION, "the Didit session id is the reference");
    expectEqual(didit.sessionId, SESSION_ID, "our own id is read from vendor_data");
    expectEqual(didit.environment, "live", "the environment is read");
    expectEqual(didit.deliveryKey, `event:${EVENT_ID}`, "Didit's event id is the deduplication key");
    expectEqual(didit.wantsRead, true, "an Approved status asks for a read");
    expectEqual(didit.occurredAtEpochMs, NOW, "Didit sends Unix seconds, which become milliseconds");
    expectEqual(didit.testMode, false, "Didit sends no test marker");
  }

  const noEventId = parseSupplementaryIdvDelivery("didit", diditBody({ event_id: undefined }));
  expectEqual(noEventId?.deliveryKey, deliveryBodyHashOf(diditBody({ event_id: undefined })), "without an event id the body hash is the key");
  const kycExpired = parseSupplementaryIdvDelivery("didit", diditBody({ status: "Kyc Expired" }));
  expectEqual(kycExpired?.status, "Kyc Expired", "Kyc Expired survives exactly");
  expectEqual(kycExpired?.wantsRead, true, "Kyc Expired asks for a read");
  const lowerExpired = parseSupplementaryIdvDelivery("didit", diditBody({ status: "kyc expired" }));
  expectEqual(lowerExpired?.status, null, "a status the documentation does not spell keeps no status word");
  expectEqual(lowerExpired?.wantsRead, false, "and asks for no read");
  const inProgress = parseSupplementaryIdvDelivery("didit", diditBody({ status: "In Progress" }));
  expectEqual(inProgress?.wantsRead, false, "In Progress asks for no read");
  const sandboxDidit = parseSupplementaryIdvDelivery("didit", diditBody({ environment: "sandbox" }));
  expectEqual(sandboxDidit?.environment, "sandbox", "the sandbox environment is read");
  const userEvent = parseSupplementaryIdvDelivery("didit", diditBody({ webhook_type: "user.status.updated" }));
  expectEqual(userEvent?.wantsRead, false, "a user entity event asks for no read");
  expectEqual(userEvent?.deliveryType, "user.status.updated", "and keeps its own type");
  const companySession = parseSupplementaryIdvDelivery("didit", diditBody({ session_kind: "business", business_session_id: "x" }));
  expectEqual(companySession?.sessionId, SESSION_ID, "a business session still names our own id");
  const badSession = parseSupplementaryIdvDelivery("didit", diditBody({ session_id: "not-a-uuid" }));
  expectEqual(badSession?.reference, null, "a session id that is not a UUID is not a reference");
  expectEqual(parseSupplementaryIdvDelivery("didit", JSON.stringify({ status: "Approved" })), null, "a body without an event family is not a delivery");

  const jumio = parseSupplementaryIdvDelivery("jumio", jumioBody());
  expect(jumio !== null, "a Jumio callback parses");
  if (jumio !== null) {
    expectEqual(jumio.vendorKey, "jumio", "the vendor is Jumio");
    expectEqual(jumio.deliveryType, "callback", "the delivery type is the callback itself");
    expectEqual(jumio.status, "PROCESSED", "the workflow status is exact");
    expectEqual(jumio.reference, JUMIO_EXECUTION, "the workflow execution id is the reference");
    expectEqual(jumio.sessionId, null, "Jumio echoes no id of ours, so none is invented");
    expectEqual(jumio.environment, null, "Jumio names no environment in the callback");
    expectEqual(jumio.wantsRead, true, "PROCESSED asks for a read");
    expectEqual(jumio.deliveryKey, deliveryBodyHashOf(jumioBody()), "the body hash is the key");
    expectEqual(jumio.occurredAtEpochMs, null, "callbackSentAt is a formatted string this file does not invent an epoch from");
  }
  expectEqual(parseSupplementaryIdvDelivery("jumio", jumioBody({ workflowExecution: { id: JUMIO_EXECUTION, status: "INITIATED" } }))?.wantsRead, false, "INITIATED asks for no read");
  expectEqual(parseSupplementaryIdvDelivery("jumio", jumioBody({ workflowExecution: { id: JUMIO_EXECUTION, status: "ACQUIRED" } }))?.wantsRead, true, "ACQUIRED asks for a read");
  expectEqual(parseSupplementaryIdvDelivery("jumio", jumioBody({ workflowExecution: { id: JUMIO_EXECUTION, status: "SESSION_EXPIRED" } }))?.wantsRead, true, "an expiry asks for a read");
  const unknownJumioStatus = parseSupplementaryIdvDelivery("jumio", jumioBody({ workflowExecution: { id: JUMIO_EXECUTION, status: "REFUNDED" } }));
  expect(unknownJumioStatus !== null, "an unknown workflow status still parses");
  expectEqual(unknownJumioStatus?.wantsRead, false, "and asks for no read");
  expectEqual(parseSupplementaryIdvDelivery("jumio", jumioBody({ workflowExecution: { id: "nope", status: "PROCESSED" } }))?.reference, null, "a workflow id that is not a UUID is not a reference");
  expectEqual(parseSupplementaryIdvDelivery("jumio", JSON.stringify({ callbackSentAt: "x" })), null, "a body without a workflow execution is not a callback");
  expectEqual(parseSupplementaryIdvDelivery("jumio", JSON.stringify({ workflowExecution: { id: JUMIO_EXECUTION } })), null, "a callback without a status is not a callback");
}

/* ---- 8: receiving, the paths that record ---- */

async function checkHappyPaths(): Promise<void> {
  // Sumsub: verified, read, recorded.
  {
    const config = configuredStore();
    const session = readySession(config.config, SUMSUB_APPLICANT);
    const body = sumsubBody();
    const read = readFixture(passedAnswer(SUMSUB_APPLICANT));
    const { options, deliveries, audits } = optionsOf({ configStore: config.store, sessionStore: session.store }, read.readSession);
    const report = await receiveSupplementaryIdvDelivery(
      inputOf({ headers: sumsubHeaders(body), rawBody: body }),
      options,
    );
    expectEqual(report.outcome, "accepted", "a verified Sumsub delivery is accepted");
    expectEqual(report.httpStatus, 200, "and answered 200");
    expectEqual(report.recorded, true, "and records an answer");
    expectEqual(report.changed, true, "which changed the row");
    expectEqual(read.calls.length, 1, "the delivery caused exactly one read");
    expectEqual(read.calls[0]?.sessionId, session.session.id, "the read was made for the session the delivery named");
    expectEqual(read.calls[0]?.environment, "live", "the read was handed the opened configuration");
    expectEqual(session.store.findById(session.session.id)?.result, "passed", "the session passed");
    expectEqual(session.store.findById(session.session.id)?.liveness, "passed", "the liveness word was recorded from the read");
    expectEqual(session.store.findById(session.session.id)?.reference, SUMSUB_APPLICANT, "the reference is unchanged");
    expectEqual(audits.length, 1, "one audit entry for the delivery");
    expectEqual(audits[0]?.outcome, "accepted", "the audit names the outcome");
    expectEqual(audits[0]?.officeOnly, true, "the audit is the office's");
    expectEqual(audits[0]?.action, "supplementary_idv.delivery_accepted", "the audit action names an acceptance");
    expectEqual(deliveries.find("sumsub", COMPANY, deliveryBodyHashOf(body))?.outcome, "accepted", "the store settled the delivery as accepted");
  }

  // Didit: verified by X-Signature, read, recorded.
  {
    const config = configuredStore({ vendorKey: "didit", secret: LIVE_WEBHOOK_SECRET });
    const session = readySession(config.config, DIDIT_SESSION);
    const body = diditBody();
    const read = readFixture(passedAnswer(DIDIT_SESSION));
    const { options } = optionsOf({ configStore: config.store, sessionStore: session.store }, read.readSession);
    const report = await receiveSupplementaryIdvDelivery(inputOf({ vendorKey: "didit", headers: diditHeaders(body), rawBody: body }), options);
    expectEqual(report.outcome, "accepted", "a verified Didit delivery is accepted");
    expectEqual(report.httpStatus, 200, "and answered 200");
    expectEqual(report.verification?.verdict, "verified", "the report carries the verification verdict");
    expectEqual(read.calls.length, 1, "the delivery caused one read");
    expectEqual(session.store.findById(session.session.id)?.result, "passed", "the session passed");
  }

  // Jumio: verified by allowlist, read, recorded.
  {
    const config = configuredStore({ vendorKey: "jumio", secret: null });
    const session = readySession(config.config, JUMIO_EXECUTION);
    const body = jumioBody();
    const read = readFixture(passedAnswer(JUMIO_EXECUTION));
    const { options } = optionsOf({ configStore: config.store, sessionStore: session.store }, read.readSession);
    const report = await receiveSupplementaryIdvDelivery(
      inputOf({ vendorKey: "jumio", headers: { "Content-Type": "application/json" }, rawBody: body, peerAddress: "34.202.241.227" }),
      options,
    );
    expectEqual(report.outcome, "accepted", "a Jumio callback from an allowlisted address is accepted");
    expectEqual(report.verification?.verdict, "verified", "the allowlist verdict is verified");
    expectEqual(read.calls.length, 1, "the callback caused one read");
    expectEqual(session.store.findById(session.session.id)?.result, "passed", "the session passed");
  }

  // A Jumio callback without a trusted address is a hint: it is heard, read, and recorded, under an unsigned verdict.
  {
    const config = configuredStore({ vendorKey: "jumio", secret: null });
    const session = readySession(config.config, JUMIO_EXECUTION);
    const body = jumioBody();
    const read = readFixture(passedAnswer(JUMIO_EXECUTION));
    const { options } = optionsOf({ configStore: config.store, sessionStore: session.store }, read.readSession);
    const report = await receiveSupplementaryIdvDelivery(inputOf({ vendorKey: "jumio", rawBody: body, peerAddress: null }), options);
    expectEqual(report.outcome, "accepted", "an unsigned Jumio callback is accepted, because it decides nothing itself");
    expectEqual(report.verification?.verdict, "unsigned", "the verdict says unsigned");
    expectEqual(read.calls.length, 1, "the unsigned callback still causes a read of the vendor's own record");
  }

  // A delivery that announces no decision is acknowledged without a read.
  {
    const config = configuredStore();
    const session = readySession(config.config, SUMSUB_APPLICANT);
    const body = sumsubBody({ type: "applicantPending" });
    const read = readFixture(passedAnswer(SUMSUB_APPLICANT));
    const { options } = optionsOf({ configStore: config.store, sessionStore: session.store }, read.readSession);
    const report = await receiveSupplementaryIdvDelivery(inputOf({ headers: sumsubHeaders(body), rawBody: body }), options);
    expectEqual(report.outcome, "ignored", "an applicantPending delivery is ignored");
    expectEqual(report.httpStatus, 200, "and acknowledged");
    expectEqual(read.calls.length, 0, "without a vendor read");
    expectEqual(session.store.findById(session.session.id)?.version, 2, "and without moving the row");
  }

  // A test delivery is never a result, even when it claims an approval.
  {
    const config = configuredStore();
    const session = readySession(config.config, SUMSUB_APPLICANT);
    const body = sumsubBody({ testMode: true });
    const read = readFixture(passedAnswer(SUMSUB_APPLICANT));
    const { options, deliveries } = optionsOf({ configStore: config.store, sessionStore: session.store }, read.readSession);
    const report = await receiveSupplementaryIdvDelivery(inputOf({ headers: sumsubHeaders(body), rawBody: body }), options);
    expectEqual(report.outcome, "test", "a test delivery is its own outcome");
    expectEqual(report.httpStatus, 200, "and is acknowledged");
    expectEqual(read.calls.length, 0, "a test delivery is never read");
    expectEqual(session.store.findById(session.session.id)?.result, "in_progress", "a test delivery never sets a result");
    expectEqual(deliveries.find("sumsub", COMPANY, deliveryBodyHashOf(body)), null, "a test delivery claims no key");
    expectEqual(report.recorded, false, "nothing is recorded for a test");
  }
}

/* ---- 9: receiving, the paths that refuse ---- */

async function checkRefusals(): Promise<void> {
  // Unverified: a wrong digest is 401, never a read, never a record.
  {
    const config = configuredStore();
    const session = readySession(config.config, SUMSUB_APPLICANT);
    const body = sumsubBody();
    const read = readFixture(passedAnswer(SUMSUB_APPLICANT));
    const { options, deliveries, audits } = optionsOf({ configStore: config.store, sessionStore: session.store }, read.readSession);
    const headers = { [SUMSUB_DIGEST_HEADER]: "0".repeat(64), [SUMSUB_DIGEST_ALGORITHM_HEADER]: "HMAC_SHA256_HEX" };
    const report = await receiveSupplementaryIdvDelivery(inputOf({ headers, rawBody: body }), options);
    expectEqual(report.outcome, "unverified", "a wrong digest is unverified");
    expectEqual(report.httpStatus, 401, "and answered 401");
    expectEqual(read.calls.length, 0, "an unverified delivery is never read");
    expectEqual(session.store.findById(session.session.id)?.version, 2, "and never moves the row");
    expectEqual(deliveries.find("sumsub", COMPANY, deliveryBodyHashOf(body)), null, "and claims no key, so a real retry is not lost");
    expectEqual(audits[0]?.action, "supplementary_idv.delivery_refused", "the audit names a refusal");
    expectEqual(report.recorded, false, "nothing was recorded");
  }

  // A body that is not a delivery at all is 400.
  {
    const config = configuredStore();
    const session = readySession(config.config, SUMSUB_APPLICANT);
    const read = readFixture(passedAnswer(SUMSUB_APPLICANT));
    const { options } = optionsOf({ configStore: config.store, sessionStore: session.store }, read.readSession);
    const report = await receiveSupplementaryIdvDelivery(inputOf({ headers: sumsubHeaders("{}"), rawBody: "{}" }), options);
    expectEqual(report.outcome, "malformed", "a body without a type is malformed");
    expectEqual(report.httpStatus, 400, "and answered 400");
    const huge = await receiveSupplementaryIdvDelivery(inputOf({ headers: {}, rawBody: "x".repeat(SUPPLEMENTARY_IDV_MAXIMUM_DELIVERY_BYTES + 1) }), options);
    expectEqual(huge.outcome, "malformed", "a body beyond the bound is malformed");
    expectEqual(huge.httpStatus, 400, "and answered 400");
  }

  // The configuration is chosen by the route, so a body cannot borrow another company's secret.
  {
    const config = configuredStore();
    const session = readySession(config.config, SUMSUB_APPLICANT);
    const body = sumsubBody();
    const read = readFixture(passedAnswer(SUMSUB_APPLICANT));
    const cases: readonly (readonly [Partial<SupplementaryIdvDeliveryInput>, string])[] = [
      [{ configId: "cfg_absent" }, "an unknown configuration is refused"],
      [{ vendorKey: "didit" }, "a delivery claiming another vendor is refused"],
      [{ companyId: "company_someone_else" }, "a delivery claiming another company is refused"],
    ];
    for (const [overrides, name] of cases) {
      const { options } = optionsOf({ configStore: config.store, sessionStore: session.store }, read.readSession);
      const report = await receiveSupplementaryIdvDelivery(inputOf({ headers: sumsubHeaders(body), rawBody: body, ...overrides }), options);
      expectEqual(report.outcome, "refused", name);
      expectEqual(report.httpStatus, 500, `${name} (and asks for a retry)`);
    }
    const pending = configuredStore({ status: "pending_activation" });
    const pendingSession = readySession({ ...pending.config, status: "active" }, SUMSUB_APPLICANT);
    const pendingOptions = optionsOf({ configStore: pending.store, sessionStore: pendingSession.store }, read.readSession);
    const notActive = await receiveSupplementaryIdvDelivery(inputOf({ headers: sumsubHeaders(body), rawBody: body }), pendingOptions.options);
    expectEqual(notActive.outcome, "refused", "an inactive configuration is refused");
    expectEqual(notActive.httpStatus, 500, "and asks for a retry");

    const foreign = configuredStore({ ring: otherKeyring });
    const foreignSession = readySession(foreign.config, SUMSUB_APPLICANT);
    const foreignOptions = optionsOf({ configStore: foreign.store, sessionStore: foreignSession.store }, read.readSession);
    const foreignKey = await receiveSupplementaryIdvDelivery(inputOf({ headers: sumsubHeaders(body), rawBody: body }), foreignOptions.options);
    expectEqual(foreignKey.outcome, "refused", "another keyring cannot open the delivery secret");
    expectEqual(foreignKey.httpStatus, 500, "and asks for a retry");
  }

  // A delivery from the other environment is refused rather than recorded.
  {
    const config = configuredStore({ environment: "live" });
    const session = readySession(config.config, SUMSUB_APPLICANT);
    const body = sumsubBody({ sandboxMode: true });
    const read = readFixture(passedAnswer(SUMSUB_APPLICANT));
    const { options } = optionsOf({ configStore: config.store, sessionStore: session.store }, read.readSession);
    const report = await receiveSupplementaryIdvDelivery(inputOf({ headers: sumsubHeaders(body), rawBody: body }), options);
    expectEqual(report.outcome, "refused", "a sandbox delivery on a live configuration is refused");
    expectEqual(read.calls.length, 0, "and never read");
    expectEqual(session.store.findById(session.session.id)?.result, "in_progress", "and never recorded");

    const diditConfig = configuredStore({ vendorKey: "didit", environment: "live", secret: LIVE_WEBHOOK_SECRET });
    const diditSession = readySession(diditConfig.config, DIDIT_SESSION);
    const diditSandbox = diditBody({ environment: "sandbox" });
    const diditOptions = optionsOf({ configStore: diditConfig.store, sessionStore: diditSession.store }, read.readSession);
    const diditReport = await receiveSupplementaryIdvDelivery(
      inputOf({ vendorKey: "didit", headers: diditHeaders(diditSandbox), rawBody: diditSandbox }),
      diditOptions.options,
    );
    expectEqual(diditReport.outcome, "refused", "a sandbox Didit delivery on a live configuration is refused");
  }

  // A session this company does not hold is 404, and the claim is released so a later delivery is heard.
  {
    const config = configuredStore();
    const session = readySession(config.config, SUMSUB_APPLICANT);
    const body = sumsubBody({ externalUserId: "ffffffff-0000-4000-8000-000000000000", applicantId: "aaaaaaaaaaaaaaaaaaaaaaab" });
    const read = readFixture(passedAnswer("aaaaaaaaaaaaaaaaaaaaaaab"));
    const { options, deliveries } = optionsOf({ configStore: config.store, sessionStore: session.store }, read.readSession);
    const report = await receiveSupplementaryIdvDelivery(inputOf({ headers: sumsubHeaders(body), rawBody: body }), options);
    expectEqual(report.outcome, "unknown_session", "a delivery naming an unknown session is 404");
    expectEqual(report.httpStatus, 404, "and answered 404");
    expectEqual(deliveries.find("sumsub", COMPANY, deliveryBodyHashOf(body)), null, "the claim was released");

    const second = await receiveSupplementaryIdvDelivery(inputOf({ headers: sumsubHeaders(body), rawBody: body }), options);
    expectEqual(second.outcome, "unknown_session", "a retry of the same delivery is heard again rather than deduplicated");
  }

  // A row that holds another reference is refused, not read.
  {
    const config = configuredStore();
    const session = readySession(config.config, SUMSUB_APPLICANT);
    const body = sumsubBody({ applicantId: "bbbbbbbbbbbbbbbbbbbbbbbb", externalUserId: session.session.id });
    const read = readFixture(passedAnswer("bbbbbbbbbbbbbbbbbbbbbbbb"));
    const { options } = optionsOf({ configStore: config.store, sessionStore: session.store }, read.readSession);
    const report = await receiveSupplementaryIdvDelivery(inputOf({ headers: sumsubHeaders(body), rawBody: body }), options);
    expectEqual(report.outcome, "unknown_session", "a delivery naming another applicant for the same session is refused");
    expectEqual(read.calls.length, 0, "and never read");
  }

  // A read that fails is 500 and the claim is released, so the vendor's retry is heard.
  {
    const config = configuredStore();
    const session = readySession(config.config, SUMSUB_APPLICANT);
    const body = sumsubBody();
    const failing = readFixture(new Error("the vendor is down"));
    const { options, deliveries, audits } = optionsOf({ configStore: config.store, sessionStore: session.store }, failing.readSession);
    const report = await receiveSupplementaryIdvDelivery(inputOf({ headers: sumsubHeaders(body), rawBody: body }), options);
    expectEqual(report.outcome, "failed", "a read that throws is a failure");
    expectEqual(report.httpStatus, 500, "and answered 500 so the vendor retries");
    expectEqual(report.recorded, false, "nothing is recorded");
    expectEqual(deliveries.find("sumsub", COMPANY, deliveryBodyHashOf(body)), null, "the claim was released");
    expectEqual(audits[0]?.action, "supplementary_idv.delivery_refused", "the audit records the failure as a refusal");

    const healing = readFixture(passedAnswer(SUMSUB_APPLICANT));
    const retry = await receiveSupplementaryIdvDelivery(inputOf({ headers: sumsubHeaders(body), rawBody: body }), optionsOf({ configStore: config.store, sessionStore: session.store }, healing.readSession, { deliveries }).options);
    expectEqual(retry.outcome, "accepted", "the retry after the release is accepted");
    expectEqual(session.store.findById(session.session.id)?.result, "passed", "and records the answer");
  }

  // A vendor that answers about another session is not recorded.
  {
    const config = configuredStore();
    const session = readySession(config.config, SUMSUB_APPLICANT);
    const body = sumsubBody();
    const wrongSession = readFixture(passedAnswer("cccccccccccccccccccccccc"));
    const { options } = optionsOf({ configStore: config.store, sessionStore: session.store }, wrongSession.readSession);
    const report = await receiveSupplementaryIdvDelivery(inputOf({ headers: sumsubHeaders(body), rawBody: body }), options);
    expectEqual(report.outcome, "failed", "an answer about another session is a failure");
    expectEqual(report.httpStatus, 500, "and answered 500");
    expectEqual(session.store.findById(session.session.id)?.result, "in_progress", "and records nothing");
  }

  // The forward-only recorder outranks a late delivery.
  {
    const config = configuredStore();
    const session = readySession(config.config, SUMSUB_APPLICANT);
    session.store.save({ ...(session.store.findById(session.session.id) as SupplementaryIdvSession), result: "passed", version: 3 }, 2);
    const body = sumsubBody({ reviewStatus: "pending" });
    const running = readFixture({ reference: SUMSUB_APPLICANT, result: "in_progress", liveness: "unknown", documentKind: "not_stated", reasonCode: "vendor_incomplete" });
    const { options, deliveries, sessionAudits } = optionsOf({ configStore: config.store, sessionStore: session.store }, running.readSession, {
      recordSessionAudit: (entry) => sessionAudits.push(entry),
    });
    const report = await receiveSupplementaryIdvDelivery(inputOf({ headers: sumsubHeaders(body), rawBody: body }), options);
    expectEqual(report.outcome, "ignored", "a late running review is ignored rather than rewriting a pass");
    expectEqual(report.httpStatus, 200, "and acknowledged");
    expectEqual(session.store.findById(session.session.id)?.result, "passed", "the pass survives");
    expectEqual(session.store.findById(session.session.id)?.version, 3, "the row does not move");
    expectEqual(deliveries.find("sumsub", COMPANY, deliveryBodyHashOf(body))?.outcome, "ignored", "the delivery is settled as ignored, so a retry is a duplicate");
    expectEqual(sessionAudits[0]?.action, "supplementary_idv.delivery_outranked", "the outranking is audited");
  }
}

/* ---- 10: deduplication, and what a delivery can never touch ---- */

async function checkDeduplication(): Promise<void> {
  {
    const config = configuredStore();
    const session = readySession(config.config, SUMSUB_APPLICANT);
    const body = sumsubBody();
    const read = readFixture(passedAnswer(SUMSUB_APPLICANT));
    const { options, deliveries } = optionsOf({ configStore: config.store, sessionStore: session.store }, read.readSession);

    const first = await receiveSupplementaryIdvDelivery(inputOf({ headers: sumsubHeaders(body), rawBody: body }), options);
    const second = await receiveSupplementaryIdvDelivery(inputOf({ headers: sumsubHeaders(body), rawBody: body }), options);
    expectEqual(first.outcome, "accepted", "the first delivery is accepted");
    expectEqual(second.outcome, "duplicate", "the identical second delivery is a duplicate");
    expectEqual(second.httpStatus, 200, "and is acknowledged");
    expectEqual(read.calls.length, 1, "the duplicate caused no second read");
    expectEqual(session.store.findById(session.session.id)?.version, 3, "the duplicate did not move the row again");
    expectEqual(deliveries.find("sumsub", COMPANY, deliveryBodyHashOf(body))?.outcome, "accepted", "the settled record is kept");
  }

  {
    // Didit's retries carry the same event id but a fresh signature, so the event id is what deduplicates them.
    const config = configuredStore({ vendorKey: "didit", secret: LIVE_WEBHOOK_SECRET });
    const session = readySession(config.config, DIDIT_SESSION);
    const body = diditBody();
    const read = readFixture(passedAnswer(DIDIT_SESSION));
    const { options } = optionsOf({ configStore: config.store, sessionStore: session.store }, read.readSession);
    const later = NOW + 90_000;
    const first = await receiveSupplementaryIdvDelivery(inputOf({ vendorKey: "didit", headers: diditHeaders(body), rawBody: body }), options);
    const second = await receiveSupplementaryIdvDelivery(
      inputOf({ vendorKey: "didit", headers: diditHeaders(body, NOW_SECONDS + 90), rawBody: body, receivedAtEpochMs: later }),
      options,
    );
    expectEqual(first.outcome, "accepted", "the first Didit delivery is accepted");
    expectEqual(second.outcome, "duplicate", "a re-signed retry of the same event is a duplicate");
    expectEqual(read.calls.length, 1, "and causes no second read");
  }

  {
    // A different body is a different delivery, even for the same session.
    const config = configuredStore();
    const session = readySession(config.config, SUMSUB_APPLICANT);
    const read = readFixture(passedAnswer(SUMSUB_APPLICANT));
    const { options } = optionsOf({ configStore: config.store, sessionStore: session.store }, read.readSession);
    const first = sumsubBody();
    const second = sumsubBody({ correlationId: "req-2" });
    const one = await receiveSupplementaryIdvDelivery(inputOf({ headers: sumsubHeaders(first), rawBody: first }), options);
    const two = await receiveSupplementaryIdvDelivery(inputOf({ headers: sumsubHeaders(second), rawBody: second }), options);
    expectEqual(one.outcome, "accepted", "the first body is accepted");
    expectEqual(two.outcome, "accepted", "a different body is its own delivery");
    expectEqual(read.calls.length, 2, "and causes its own read");
  }

  {
    // A delivery about another company's session cannot borrow that company's row.
    const config = configuredStore();
    const other = configuredStore({ companyId: "company_two" });
    const otherSession = readySession(other.config, SUMSUB_APPLICANT);
    const body = sumsubBody({ externalUserId: otherSession.session.id });
    const read = readFixture(passedAnswer(SUMSUB_APPLICANT));
    const { options } = optionsOf({ configStore: config.store, sessionStore: otherSession.store }, read.readSession);
    const report = await receiveSupplementaryIdvDelivery(inputOf({ headers: sumsubHeaders(body), rawBody: body }), options);
    expectEqual(report.outcome, "unknown_session", "a session of another company is unknown to this endpoint");
    expectEqual(read.calls.length, 0, "and is never read");
  }
}

/* ---- 10b: the body never decides, the read does ---- */

async function checkBodyNeverDecides(): Promise<void> {
  {
    // A body that shouts RED and a vendor that answers passed: the vendor's answer is what is recorded.
    const config = configuredStore();
    const session = readySession(config.config, SUMSUB_APPLICANT);
    const body = sumsubBody({
      reviewStatus: "completed",
      reviewResult: { reviewAnswer: "RED", rejectLabels: ["FORGERY"], reviewRejectType: "FINAL" },
    });
    const read = readFixture(passedAnswer(SUMSUB_APPLICANT));
    const { options } = optionsOf({ configStore: config.store, sessionStore: session.store }, read.readSession);
    const report = await receiveSupplementaryIdvDelivery(inputOf({ headers: sumsubHeaders(body), rawBody: body }), options);
    expectEqual(report.outcome, "accepted", "a red body is still only a hint");
    expectEqual(session.store.findById(session.session.id)?.result, "passed", "the vendor's read decides, not the body's answer");
    expectEqual(session.store.findById(session.session.id)?.reasonCode, "not_stated", "the body's rejection label is not the reason");
  }

  {
    // A body that says GREEN and a vendor that answers failed: the failure is recorded.
    const config = configuredStore();
    const session = readySession(config.config, SUMSUB_APPLICANT);
    const body = sumsubBody({ reviewStatus: "completed", reviewResult: { reviewAnswer: "GREEN" } });
    const read = readFixture({ reference: SUMSUB_APPLICANT, result: "failed", liveness: "failed", documentKind: "not_stated", reasonCode: "liveness_failed" });
    const { options } = optionsOf({ configStore: config.store, sessionStore: session.store }, read.readSession);
    const report = await receiveSupplementaryIdvDelivery(inputOf({ headers: sumsubHeaders(body), rawBody: body }), options);
    expectEqual(report.outcome, "accepted", "a green body is recorded as a delivery");
    expectEqual(session.store.findById(session.session.id)?.result, "failed", "a green body does not rescue a failed read");
    expectEqual(session.store.findById(session.session.id)?.reasonCode, "liveness_failed", "the reason comes from the read");
    expectEqual(session.store.findById(session.session.id)?.requiresHumanReview, true, "and STEP 170's fallback rule applies");
  }

  {
    // Only the documented booleans are test and sandbox markers: a string is a production delivery.
    const config = configuredStore();
    const session = readySession(config.config, SUMSUB_APPLICANT);
    const read = readFixture(passedAnswer(SUMSUB_APPLICANT));
    const { options } = optionsOf({ configStore: config.store, sessionStore: session.store }, read.readSession);
    const stringTest = sumsubBody({ testMode: "true" });
    const testReport = await receiveSupplementaryIdvDelivery(inputOf({ headers: sumsubHeaders(stringTest), rawBody: stringTest }), options);
    expectEqual(testReport.outcome, "accepted", "a string testMode is not the documented marker");
    const stringSandbox = sumsubBody({ sandboxMode: "true", correlationId: "req-2" });
    const sandboxReport = await receiveSupplementaryIdvDelivery(inputOf({ headers: sumsubHeaders(stringSandbox), rawBody: stringSandbox }), options);
    expectEqual(sandboxReport.outcome, "accepted", "a string sandboxMode is not the documented marker");
  }

  {
    // A delivery naming a session of another vendor is unknown here.
    const diditConfig = configuredStore({ vendorKey: "didit", secret: LIVE_WEBHOOK_SECRET });
    const diditSession = readySession(diditConfig.config, SUMSUB_APPLICANT);
    const sumsubConfig = configuredStore();
    const body = sumsubBody({ externalUserId: diditSession.session.id });
    const read = readFixture(passedAnswer(SUMSUB_APPLICANT));
    const { options } = optionsOf({ configStore: sumsubConfig.store, sessionStore: diditSession.store }, read.readSession);
    const report = await receiveSupplementaryIdvDelivery(inputOf({ headers: sumsubHeaders(body), rawBody: body }), options);
    expectEqual(report.outcome, "unknown_session", "a session of another vendor is not this vendor's session");
    expectEqual(read.calls.length, 0, "and is never read");
    expectEqual(diditSession.store.findById(diditSession.session.id)?.version, 2, "and never moves");
  }

  {
    // A Jumio callback from an address outside the documented allowlist is refused, not read.
    const config = configuredStore({ vendorKey: "jumio", secret: null });
    const session = readySession(config.config, JUMIO_EXECUTION);
    const body = jumioBody();
    const read = readFixture(passedAnswer(JUMIO_EXECUTION));
    const { options } = optionsOf({ configStore: config.store, sessionStore: session.store }, read.readSession);
    const report = await receiveSupplementaryIdvDelivery(inputOf({ vendorKey: "jumio", rawBody: body, peerAddress: "203.0.113.9" }), options);
    expectEqual(report.outcome, "unverified", "an address outside the allowlist is unverified");
    expectEqual(report.httpStatus, 401, "and answered 401");
    expectEqual(read.calls.length, 0, "and never read");
    expectEqual(session.store.findById(session.session.id)?.result, "in_progress", "and never recorded");
  }

  {
    // A Didit delivery outside the clock window is refused, not read.
    const config = configuredStore({ vendorKey: "didit", secret: LIVE_WEBHOOK_SECRET });
    const session = readySession(config.config, DIDIT_SESSION);
    const body = diditBody();
    const read = readFixture(passedAnswer(DIDIT_SESSION));
    const { options } = optionsOf({ configStore: config.store, sessionStore: session.store }, read.readSession);
    const stale = await receiveSupplementaryIdvDelivery(
      inputOf({ vendorKey: "didit", headers: diditHeaders(body, NOW_SECONDS - 3_600), rawBody: body }),
      options,
    );
    expectEqual(stale.outcome, "unverified", "a stale Didit delivery is unverified");
    expectEqual(stale.httpStatus, 401, "and answered 401");
    expectEqual(read.calls.length, 0, "and never read");
    expectEqual(session.store.findById(session.session.id)?.result, "in_progress", "and never recorded");
  }
}

/* ---- 11: what is kept, what is never touched, and the source ---- */

async function checkNothingKept(): Promise<void> {
  const config = configuredStore({ vendorKey: "didit", secret: LIVE_WEBHOOK_SECRET });
  const session = readySession(config.config, DIDIT_SESSION);
  const body = diditBody();
  const read = readFixture(passedAnswer(DIDIT_SESSION));
  const sessionAudits: { readonly action: string }[] = [];
  const { options, deliveries, audits } = optionsOf({ configStore: config.store, sessionStore: session.store }, read.readSession, {
    recordSessionAudit: (entry) => sessionAudits.push(entry),
  });
  const before = session.store.findById(session.session.id)?.processorKybStatusSeen;
  const report = await receiveSupplementaryIdvDelivery(inputOf({ vendorKey: "didit", headers: diditHeaders(body), rawBody: body }), options);
  expectEqual(report.outcome, "accepted", "the personal-data fixture is accepted");

  const parsed = parseSupplementaryIdvDelivery("didit", body);
  const parsedText = JSON.stringify(parsed);
  for (const personal of ["Ahmed", "Rahman", "1990-01-01", "X1234567", "PASSPORT", "first_name", "date_of_birth", "document_number"]) {
    expect(parsedText.includes(personal) === false, `the parsed delivery carries no ${personal}`);
  }
  const stored = JSON.stringify(deliveries.find("didit", COMPANY, `event:${EVENT_ID}`));
  for (const personal of ["Ahmed", "Rahman", "1990-01-01", "X1234567", "decision", "id_verifications"]) {
    expect(stored.includes(personal) === false, `the delivery record carries no ${personal}`);
  }
  const auditText = JSON.stringify(audits);
  for (const personal of ["Ahmed", "Rahman", "1990-01-01", "X1234567"]) {
    expect(auditText.includes(personal) === false, `the audit entry carries no ${personal}`);
  }
  expect(auditText.includes(body) === false, "the audit entry carries no body");
  expectEqual(audits[0]?.bodyHash, deliveryBodyHashOf(body), "the audit keeps the body's hash instead");
  const sessionText = JSON.stringify(session.store.findById(session.session.id));
  for (const personal of ["Ahmed", "Rahman", "X1234567"]) {
    expect(sessionText.includes(personal) === false, `the session row carries no ${personal}`);
  }
  expectEqual(session.store.findById(session.session.id)?.processorKybStatusSeen, before, "the processor snapshot is untouched");
  expectEqual(before, "pending", "the snapshot is the one STEP 170 copied in");
  expectEqual(sessionAudits.length, 1, "one session audit entry");
  expectEqual(sessionAudits[0]?.action, "supplementary_idv.delivery_recorded", "the session audit names the recording");

  const summary = supplementaryIdvDeliverySummaryOf(report);
  expectEqual(summary.changesProcessorKyb, false, "the summary never changes a processor status");
  expectEqual(summary.outcome, "accepted", "the summary keeps the outcome");
  expectEqual(summary.httpStatus, 200, "the summary keeps the answer");
  expectEqual(summary.verification, "verified", "the summary keeps the verification verdict");
  expectEqual(summary.sessionId, session.session.id, "the summary keeps the session");
  expectEqual(summary.vendorKey, "didit", "the summary keeps the vendor");
  expectEqual(summary.deliveryKey, `event:${EVENT_ID}`, "the summary keeps the delivery key");

  const unread = supplementaryIdvDeliverySummaryOf({
    outcome: "unverified",
    httpStatus: 401,
    vendorKey: "sumsub",
    deliveryKey: null,
    deliveryType: null,
    verification: null,
    reason: "digest_mismatch",
    sessionId: null,
    recorded: false,
    changed: false,
  });
  expectEqual(unread.deliveryType, "unread", "a summary of an unread body says so");
  expectEqual(unread.verification, "none", "and names no verification");
  expectEqual(unread.changesProcessorKyb, false, "and still claims no processor change");
}

function checkStore(): void {
  const store = new InMemorySupplementaryIdvDeliveryStore();
  const entry = { vendorKey: "sumsub" as const, companyId: COMPANY, deliveryKey: "key-1", occurredAtEpochMs: NOW };
  expectEqual(store.claim(entry), true, "the first claim is taken");
  expectEqual(store.claim(entry), false, "a second claim of the same key is refused");
  expectEqual(store.find("sumsub", COMPANY, "key-1"), null, "an unsettled claim reads as nothing");
  store.release("sumsub", COMPANY, "key-1");
  expectEqual(store.claim(entry), true, "a released claim can be taken again, because nothing was recorded");

  const settledRecord: SupplementaryIdvDeliveryRecord = {
    vendorKey: "sumsub",
    companyId: COMPANY,
    deliveryKey: "key-1",
    outcome: "accepted",
    httpStatus: 200,
    occurredAtEpochMs: NOW,
  };
  store.settle(settledRecord);
  expectEqual(store.find("sumsub", COMPANY, "key-1")?.outcome, "accepted", "a settled claim reads back");
  expectEqual(store.claim(entry), false, "a settled claim cannot be taken again");
  store.release("sumsub", COMPANY, "key-1");
  expectEqual(store.claim(entry), false, "a settled claim is not released");
  expectEqual(store.find("sumsub", COMPANY, "key-1")?.httpStatus, 200, "and its record survives the release attempt");
  expectEqual(store.find("didit", COMPANY, "key-1"), null, "a key is scoped by vendor");
  expectEqual(store.find("sumsub", "company_two", "key-1"), null, "a key is scoped by company");

  expectThrowsSettling(() => {
    new InMemorySupplementaryIdvDeliveryStore().settle({ ...settledRecord, deliveryKey: "never-claimed" });
  }, "settling a claim that was never taken throws");
}

function expectThrowsSettling(action: () => void, name: string): void {
  try {
    action();
    expect(false, name);
  } catch {
    expect(true, name);
  }
}

async function checkSource(): Promise<void> {
  const source = readFileSync(new URL("./deliveries.ts", import.meta.url), "utf8");
  expect([...source].every((char) => char.charCodeAt(0) <= 127), "the receiver's source is ASCII");
  const consoleNeedles = ["log", "error", "warn"].map((name) => ["console", `${name}(`].join("."));
  for (const needle of consoleNeedles) {
    expect(source.includes(needle) === false, "the receiver's source carries no console call");
  }
  expect(source.includes("process.env") === false, "the receiver reads no environment variable");
  expect(source.includes("http://") === false, "the receiver never names plain HTTP");
  expect(source.includes("await fetch(") === false, "the receiver never calls a vendor itself");
  expect(source.includes("next/server") === false, "the receiver imports no route helper");
  expect(source.includes("migrations") === false, "the receiver knows nothing of the database layout");
  expect(source.includes('import { createHash, createHmac, timingSafeEqual } from "node:crypto"') === true, "hashing and comparison come from node:crypto");
  expect(source.includes("timingSafeEqual") === true, "the digest comparison is constant time");
  expect(source.includes("readSession(") === true, "the receiver reads through the injected port");
  expect(source.includes("recordSupplementaryIdvAnswer") === true, "the receiver records through STEP 170");
  expect(source.includes("deliveryStore.release(") === true, "the receiver gives a claim back when nothing was recorded");
  expect(source.includes("officeOnly: true") === true, "every audit entry is the office's");
  for (const processorWord of ["verified", "action_required", "restricted", "rejected"]) {
    expect(source.includes(`result: "${processorWord}"`) === false, `the receiver never writes ${processorWord} as a result`);
  }
  expect(source.includes('processorKybStatus: "') === false, "the receiver never writes a processor status");
  expect(source.includes("changesProcessorKyb: false") === true, "the summary states that it changes no processor status");
  for (const personal of ["firstName", "first_name", "dateOfBirth", "date_of_birth", "documentNumber", "document_number", "idDocs"]) {
    expect(source.includes(personal) === false, `the receiver never names the ${personal} field`);
  }
  expect(source.includes("JSON.parse") === true, "the body is parsed once, after verification");
  const verifyIndex = source.indexOf("verifySupplementaryIdvDelivery(vendorKey");
  const parseIndex = source.indexOf("parseSupplementaryIdvDelivery(vendorKey, input.rawBody)");
  expect(verifyIndex > 0 && parseIndex > verifyIndex, "the bytes are verified before the body is parsed");
  const testIndex = source.indexOf("if (delivery.testMode)");
  const claimIndex = source.indexOf("options.deliveryStore.claim(");
  expect(testIndex > 0 && claimIndex > testIndex, "a test delivery is dropped before a claim is taken");
  const claimCall = source.indexOf("options.deliveryStore.claim(");
  const recordCall = source.indexOf("recordSupplementaryIdvAnswer(resolved.id");
  expect(claimCall > 0 && recordCall > claimCall, "a claim is taken before anything is recorded");
}

/* ---- running ---- */

checkCatalogue();
checkHeaders();
checkPrimitives();
checkSumsubVerification();
checkDiditVerification();
checkJumioVerification();
checkParsing();
await checkHappyPaths();
await checkRefusals();
await checkDeduplication();
await checkBodyNeverDecides();
await checkNothingKept();
checkStore();
await checkSource();

if (failures.length > 0) {
  process.stderr.write(
    `deliveries gate failed: ${failures.length} of ${checks} checks\n${failures.map((failure) => `  - ${failure}`).join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `deliveries gate passed: ${checks} checks (a raw body verified before it is parsed, Sumsub's documented x-payload-digest with HMAC_SHA256_HEX or HMAC_SHA512_HEX and its deprecated SHA-1 refused, Didit's X-Signature over the exact bytes with a 300 second window and the rotation header honoured while a V2-only or envelope-only signature is refused, Jumio authenticated by its documented IP allowlist and otherwise unsigned because it documents no signature at all, a test delivery that is never a result, a delivery from the other environment refused, one claim per verified body released again when nothing was recorded so a retry is heard, a duplicate that answers 200 and changes nothing, a session resolved only inside the route's own company, the result read from the vendor rather than taken from the body, STEP 170's forward-only recorder refusing to let a late delivery rewrite a pass, no payload stored beyond its hash, and a processor KYB status that no delivery can touch)\n`,
);
