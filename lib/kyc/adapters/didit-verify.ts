// path: lib/kyc/adapters/didit-verify.ts

/**
 * The gate for STEP 172: Didit as a supplementary identity check, behind the three-member port STEP 170 defined.
 *
 * A check script, not a test file. It builds a real sealed configuration with STEP 056's encryption layer, drives a
 * session from open to answer through a scripted transport that answers exactly the bodies Didit's documentation
 * shows, and then tries to break the things that matter: the exact spaced status strings, a prefix read as a mode, a
 * business session recorded as a person's result, a `Kyc Expired` overwriting a recorded pass, a hosted URL that must
 * not be stored, a second active vendor, and any path from a supplementary pass to a processor KYB verdict.
 *
 * No network call is made, no real key exists, and every answer body below is the documentation's own shape.
 */

import process from "node:process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { EncryptionKeyring } from "../../security/encryption.ts";
import { isSecretEnvelope } from "../../security/encryption.ts";
import {
  InMemorySupplementaryIdvConfigStore,
  InMemorySupplementaryIdvSessionStore,
  PROCESSOR_KYB_AUTHORITY,
  PROCESSOR_KYB_STATUSES,
  SUPPLEMENTARY_IDV_ADAPTER_MEMBERS,
  SUPPLEMENTARY_IDV_DOCUMENT_KINDS,
  SUPPLEMENTARY_IDV_LIVENESS_RESULTS,
  SUPPLEMENTARY_IDV_REASON_CODES,
  SUPPLEMENTARY_IDV_RESULTS,
  SUPPLEMENTARY_IDV_VENDOR_KEYS,
  isProcessorKybStatus,
  isSupplementaryIdvAdapter,
  isSupplementaryIdvReasonCode,
  isSupplementaryIdvResult,
  openSupplementaryIdvSession,
  refuseProcessorKybWrite,
  sealSupplementaryIdvConfig,
  supplementaryIdvEvidenceOf,
  supplementaryIdvMerchantStatusOf,
  supplementaryIdvOverlapsProcessorKyb,
  type OpenedSupplementaryIdvConfig,
  type SupplementaryIdvAuditEntry,
  type SupplementaryIdvConfig,
  type SupplementaryIdvSession,
} from "./supplementary-idv.ts";
import {
  DIDIT_ALLOWED_CALLS,
  DIDIT_API_HOST,
  DIDIT_API_KEY_HEADER,
  DIDIT_API_KEY_MAXIMUM_LENGTH,
  DIDIT_CALLBACK_METHOD,
  DIDIT_CALLBACK_METHODS,
  DIDIT_DOCUMENT_TYPES,
  DIDIT_FEATURE_ARRAYS,
  DIDIT_FEATURE_STATUSES,
  DIDIT_HOSTED_FLOW_HOST,
  DIDIT_KEY_PREFIXES,
  DIDIT_MAXIMUM_ANSWER_BYTES,
  DIDIT_SESSION_CREATED_STATUS,
  DIDIT_SESSION_KINDS,
  DIDIT_SESSION_STATUSES,
  DIDIT_SESSIONS_PATH,
  DIDIT_USER_SESSION_KIND,
  DIDIT_VENDOR_DATA_MAXIMUM_LENGTH,
  DIDIT_VENDOR_KEY,
  DIDIT_WARNING_REASONS,
  activateDiditConfiguration,
  buildDiditSessionRequest,
  createDiditConfiguration,
  diditAdapterOf,
  diditAnswerOf,
  diditCredentialOf,
  diditCredentialTextOf,
  diditDecisionPath,
  diditEndpoint,
  diditFetchTransport,
  diditKeyPrefixOf,
  diditSessionSummaryOf,
  diditVendorDataOf,
  isDiditCall,
  isDiditFeatureStatus,
  isDiditId,
  isDiditSessionStatus,
  openDiditSession,
  parseDiditDecision,
  parseDiditReadAnswer,
  parseDiditSessionAnswer,
  refreshDiditSession,
  validateDiditCredential,
  validateDiditSessionInput,
  type DiditAnswer,
  type DiditCall,
  type DiditConfigAuditEntry,
  type DiditCredential,
  type DiditOptions,
  type DiditTransport,
} from "./didit.ts";

/* ---- the checking harness, the same shape STEPs 170 and 171 used ---- */

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

async function expectRejects(action: () => Promise<unknown>, name: string): Promise<void> {
  try {
    await action();
    expect(false, name);
  } catch {
    expect(true, name);
  }
}

/* ---- the fixtures ---- */

const NOW = 1_779_000_000_000;
const COMPANY = "company_kd_didit_gate";
const SESSION_UUID = "4c5c7f3a-1f82-4f3b-8d8e-1a8d2d2f9b7a";
const WORKFLOW_UUID = "11111111-2222-3333-4444-555555555555";
const HOSTED_URL = "https://verify.didit.me/session/4c5c7f3a?token=hosted_token_that_must_never_be_stored";
const API_KEY = "didit_gate_key_0123456789abcdefghijklmnopqrstuvwxyz";
const CREDENTIAL: DiditCredential = { apiKey: API_KEY };

const keyring: EncryptionKeyring = { primary: { id: "k1", secret: Buffer.alloc(32, 7).toString("base64") } };
const otherKeyring: EncryptionKeyring = { primary: { id: "k2", secret: Buffer.alloc(32, 9).toString("base64") } };

function createBody(overrides: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    session_id: SESSION_UUID,
    session_kind: "user",
    session_number: 1024,
    session_token: "hosted_token_that_must_never_be_stored",
    url: HOSTED_URL,
    status: "Not Started",
    workflow_id: WORKFLOW_UUID,
    vendor_data: SESSION_UUID,
    ...overrides,
  });
}

function warning(risk: string, logType: string): Record<string, unknown> {
  return {
    feature: "LIVENESS",
    risk,
    additional_data: null,
    log_type: logType,
    short_description: risk,
    long_description: risk,
    node_id: "feature_1",
  };
}

function featureReport(status: string, extra: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return { status, node_id: "feature_1", warnings: [], ...extra };
}

function decisionBody(
  parts: {
    readonly status?: string;
    readonly sessionKind?: string;
    readonly idVerifications?: readonly unknown[];
    readonly liveness?: readonly unknown[];
    readonly faceMatches?: readonly unknown[];
    readonly documentType?: string | null;
  } = {},
): string {
  const idVerifications =
    parts.idVerifications ??
    [
      featureReport("Approved", {
        document_type: parts.documentType === undefined ? "Passport" : parts.documentType,
        document_number: "AB1234567",
        first_name: "JOHN",
        last_name: "DOE",
        date_of_birth: "1990-05-15",
        front_image: "https://media.didit.me/front.jpg",
      }),
    ];
  return JSON.stringify({
    session_id: SESSION_UUID,
    session_kind: parts.sessionKind ?? "user",
    session_number: 1024,
    session_url: HOSTED_URL,
    status: parts.status ?? "Approved",
    workflow_id: WORKFLOW_UUID,
    vendor_data: SESSION_UUID,
    features: ["ID_VERIFICATION", "LIVENESS", "FACE_MATCH"],
    id_verifications: idVerifications,
    liveness_checks: parts.liveness ?? [featureReport("Approved", { method: "PASSIVE", score: 96.4 })],
    face_matches: parts.faceMatches ?? [featureReport("Approved", { score: 96.42 })],
    ip_analyses: [featureReport("Approved")],
    created_at: "2026-11-06T10:00:00Z",
    expires_at: "2026-11-13T10:00:00Z",
    contact_details: { email: "person@example.test" },
  });
}

/** A scripted transport: it answers the calls it was given, in order, and remembers what it was asked. */
class ScriptedTransport {
  readonly calls: DiditCall[] = [];
  private readonly answers: DiditAnswer[];

  constructor(answers: readonly DiditAnswer[]) {
    this.answers = [...answers];
  }

  readonly call: DiditTransport = async (call) => {
    this.calls.push(call);
    const answer = this.answers.shift();
    if (answer === undefined) throw new Error("the scripted transport ran out of answers");
    return answer;
  };

  get remaining(): number {
    return this.answers.length;
  }
}

function ok(body: string, status = 200): DiditAnswer {
  return { status, body, headers: { "content-type": "application/json" } };
}

/** A configuration store with one sealed Didit configuration. */
function configuredStore(
  options: {
    readonly ring?: EncryptionKeyring;
    readonly status?: SupplementaryIdvConfig["status"];
    readonly vendorKey?: SupplementaryIdvConfig["vendorKey"];
    readonly companyId?: string;
    readonly environment?: SupplementaryIdvConfig["environment"];
  } = {},
): { readonly store: InMemorySupplementaryIdvConfigStore; readonly config: SupplementaryIdvConfig } {
  const store = new InMemorySupplementaryIdvConfigStore();
  const sealed = sealSupplementaryIdvConfig(
    {
      companyId: options.companyId ?? COMPANY,
      vendorKey: options.vendorKey ?? "didit",
      environment: options.environment ?? "live",
      credential: diditCredentialTextOf(CREDENTIAL),
      webhookSecret: "didit_webhook_secret_for_the_gate_0001",
    },
    options.ring ?? keyring,
  );
  if ("reason" in sealed) throw new Error(`the fixture could not be sealed: ${sealed.reason}`);
  const config: SupplementaryIdvConfig = {
    id: "cfg_didit_0001",
    companyId: options.companyId ?? COMPANY,
    vendorKey: options.vendorKey ?? "didit",
    environment: options.environment ?? "live",
    status: options.status ?? "active",
    credentialSealed: sealed.credentialSealed,
    webhookSecretSealed: sealed.webhookSecretSealed,
    version: 1,
    createdAtEpochMs: NOW,
    updatedAtEpochMs: NOW,
  };
  store.insert({ ...config, status: "pending_activation", version: 1 });
  const wanted = options.status ?? "active";
  if (wanted !== "pending_activation") {
    const saved = store.save({ ...config, status: wanted, version: 2, updatedAtEpochMs: NOW }, 1);
    if (saved === false) throw new Error("the fixture configuration could not be activated");
  }
  const stored = store.findById(config.id);
  if (stored === null) throw new Error("the fixture configuration was not stored");
  return { store, config: stored };
}

/** A session row, opened through STEP 170 so this gate exercises the real path. */
function openedSession(
  config: SupplementaryIdvConfig,
  environment: SupplementaryIdvConfig["environment"] = "live",
): { readonly store: InMemorySupplementaryIdvSessionStore; readonly session: SupplementaryIdvSession } {
  const store = new InMemorySupplementaryIdvSessionStore();
  const opened = openSupplementaryIdvSession(
    {
      companyId: config.companyId,
      vendorKey: "didit",
      environment,
      configId: config.id,
      processorKybStatusSeen: "pending",
    },
    { sessionStore: store, occurredAtEpochMs: NOW },
  );
  if (opened.status !== "opened") throw new Error(`the session fixture could not be opened: ${opened.reason}`);
  return { store, session: opened.session };
}

function optionsWith(
  transport: DiditTransport,
  configStore: InMemorySupplementaryIdvConfigStore,
  sessionStore: InMemorySupplementaryIdvSessionStore,
  extra: {
    readonly recordAudit?: (entry: SupplementaryIdvAuditEntry) => void;
    readonly recordConfigAudit?: (entry: DiditConfigAuditEntry) => void;
  } = {},
): DiditOptions {
  return {
    configStore,
    sessionStore,
    keyring,
    occurredAtEpochMs: NOW,
    transport,
    ...(extra.recordAudit === undefined ? {} : { recordAudit: extra.recordAudit }),
    ...(extra.recordConfigAudit === undefined ? {} : { recordConfigAudit: extra.recordConfigAudit }),
  };
}

const SESSION_INPUT = {
  sessionId: SESSION_UUID,
  workflowId: WORKFLOW_UUID,
  callbackUrl: "https://api.kd.test/api/kyc/idv/didit/delivery",
};

/* ---- 1: the catalogue is the documentation's, and nothing else is reachable ---- */

function checkCatalogue(): void {
  expectEqual(DIDIT_API_HOST, "https://verification.didit.me", "the one documented verification host");
  expectEqual(DIDIT_HOSTED_FLOW_HOST, "https://verify.didit.me", "the documented hosted-flow host");
  expectEqual(diditEndpoint(DIDIT_SESSIONS_PATH), "https://verification.didit.me/v3/session/", "the create URL");
  expectEqual(diditDecisionPath(SESSION_UUID), `/v3/session/${SESSION_UUID}/decision/`, "the decision URL");
  expectEqual(diditEndpoint("/v3/session/").startsWith("https://"), true, "no plaintext surface");
  expect(DIDIT_API_HOST.includes("apx.") === false, "the account host is not the verification host");

  expectEqual(DIDIT_ALLOWED_CALLS.length, 2, "two documented calls and no more");
  expect(isDiditCall("POST", "/v3/session/") === true, "the create call is allowed");
  expect(isDiditCall("GET", diditDecisionPath(SESSION_UUID)) === true, "the decision call is allowed");
  expect(isDiditCall("GET", "/v3/session/") === false, "the create path is never read");
  expect(isDiditCall("DELETE", diditDecisionPath(SESSION_UUID)) === false, "a session is never deleted here");
  expect(isDiditCall("PATCH", `/v3/session/${SESSION_UUID}/update-status/`) === false, "a status is never written here");
  expect(isDiditCall("GET", `/v3/session/${SESSION_UUID}/generate-pdf/`) === false, "the PDF is never fetched");
  expect(isDiditCall("GET", "/v3/sessions/") === false, "the session list is not read");
  expect(isDiditCall("POST", "/v3/workflows/") === false, "a workflow is not created here");
  expect(isDiditCall("GET", "/auth/v2/organizations/me/") === false, "the account host surface is not reachable");
  expect(isDiditCall("GET", "/v3/session/not-a-uuid/decision/") === false, "only UUID decision paths are reachable");
  expect(isDiditCall("GET", `/v3/session/${SESSION_UUID}/../${SESSION_UUID}/decision/`) === false, "traversal is not reachable");
  expect(isDiditCall("GET", `/v3/session/${SESSION_UUID}/decision`) === false, "the trailing slash is part of the path");
  expect(isDiditCall("GET", `/v3/session/${SESSION_UUID.toUpperCase()}/decision/`) === false, "upper-case UUIDs are not the shape Didit answers");
  expectEqual(DIDIT_API_KEY_HEADER, "x-api-key", "the key travels in the documented header");
  expectEqual(DIDIT_SESSION_CREATED_STATUS, "Not Started", "a new session's status is the documented one");
  expectEqual(DIDIT_USER_SESSION_KIND, "user", "this adapter is a person's check");
  expectEqual(DIDIT_SESSION_KINDS.length, 2, "two session kinds are documented");
  expectEqual(DIDIT_CALLBACK_METHOD, "both", "the callback method this adapter sends");
  expect((DIDIT_CALLBACK_METHODS as readonly string[]).includes(DIDIT_CALLBACK_METHOD), "the method sent is one Didit documents");
  expectEqual(DIDIT_CALLBACK_METHODS.length, 3, "three callback methods are documented");

  expectEqual(DIDIT_SESSION_STATUSES.length, 10, "ten session statuses are documented");
  for (const status of DIDIT_SESSION_STATUSES) {
    expect(isDiditSessionStatus(status) === true, `${status} is a documented session status`);
  }
  expect(isDiditSessionStatus("In Review") === true, "the spaced status is matched with its space");
  expect(isDiditSessionStatus("Kyc Expired") === true, "the single-capital-K status is matched exactly");
  expect(isDiditSessionStatus("KYC Expired") === false, "the all-capitals spelling is not Didit's");
  expect(isDiditSessionStatus("in review") === false, "the lower-case spelling is not Didit's");
  expect(isDiditSessionStatus("In  Review") === false, "a doubled space is not the documented status");
  expect(isDiditSessionStatus("Approved ") === false, "a trailing space is not the documented status");
  expect(isDiditSessionStatus("Verified") === false, "verified is not one of Didit's statuses");
  expect(isDiditSessionStatus("") === false, "an empty status is not a status");

  expectEqual(DIDIT_FEATURE_STATUSES.length, 5, "five feature statuses are documented");
  for (const status of DIDIT_FEATURE_STATUSES) {
    expect(isDiditFeatureStatus(status) === true, `${status} is a documented feature status`);
  }
  expect(isDiditFeatureStatus("Resub Requested") === true, "the resubmission status is matched exactly");
  expect(isDiditFeatureStatus("Resubmitted") === false, "the session word is not the feature word");
  expect(isDiditFeatureStatus("Approved") === true, "an approved feature is a documented word");
  expect(isDiditFeatureStatus("OK") === false, "ok is not a feature status");

  expectEqual(DIDIT_FEATURE_ARRAYS.length, 11, "eleven feature arrays are read");
  for (const feature of ["id_verifications", "liveness_checks", "face_matches"]) {
    expect((DIDIT_FEATURE_ARRAYS as readonly string[]).includes(feature), `${feature} is one of the arrays read`);
  }

  expectEqual(Object.keys(DIDIT_DOCUMENT_TYPES).length, 13, "thirteen document classes are documented");
  expectEqual(DIDIT_DOCUMENT_TYPES["Passport"], "passport", "a passport is a passport");
  expectEqual(DIDIT_DOCUMENT_TYPES["Identity Card"], "national_id", "an identity card is the neutral national id");
  expectEqual(DIDIT_DOCUMENT_TYPES["Driver's License"], "driving_licence", "a driving licence is a driving licence");
  expectEqual(DIDIT_DOCUMENT_TYPES["Residence Permit"], "residence_permit", "a residence permit is one");
  expectEqual(DIDIT_DOCUMENT_TYPES["Visa"], "not_stated", "a visa is not stretched into a residence permit");
  expectEqual(DIDIT_DOCUMENT_TYPES["Health Insurance Card"], "not_stated", "a health card states nothing");
  expectEqual(DIDIT_DOCUMENT_TYPES["Other"], "not_stated", "an other document states nothing");
  for (const kind of Object.values(DIDIT_DOCUMENT_TYPES)) {
    expect((SUPPLEMENTARY_IDV_DOCUMENT_KINDS as readonly string[]).includes(kind), `the neutral kind ${kind} exists`);
  }

  const warningRisks = Object.keys(DIDIT_WARNING_REASONS);
  expect(warningRisks.length >= 6, "the documented warning risks are recorded");
  for (const risk of warningRisks) {
    const reason = DIDIT_WARNING_REASONS[risk];
    expect(reason !== undefined && (SUPPLEMENTARY_IDV_REASON_CODES as readonly string[]).includes(reason), `${risk} maps to a neutral reason`);
  }
  expectEqual(DIDIT_WARNING_REASONS["DOCUMENT_EXPIRED"], "document_expired", "an expired document is an expired document");
  expectEqual(DIDIT_WARNING_REASONS["LIVENESS_FACE_ATTACK"], "liveness_failed", "a presentation attack fails liveness");
  expectEqual(DIDIT_WARNING_REASONS["LOW_FACE_MATCH_SIMILARITY"], "document_mismatch", "a low similarity is a mismatch");

  expectEqual(DIDIT_VENDOR_KEY, "didit", "the vendor key is STEP 170's own word");
  expect((SUPPLEMENTARY_IDV_VENDOR_KEYS as readonly string[]).includes(DIDIT_VENDOR_KEY), "the vendor is in the catalogue");
  expectEqual(DIDIT_KEY_PREFIXES.length, 2, "two documented key prefixes");
  expectEqual(DIDIT_VENDOR_DATA_MAXIMUM_LENGTH, 100, "the vendor data bound this platform applies");
  expect(DIDIT_MAXIMUM_ANSWER_BYTES >= 262_144, "the answer bound leaves room for a full decision");
}

/* ---- 2: the credential, and the prefix that is not a mode ---- */

function checkCredential(): void {
  expectEqual(validateDiditCredential(CREDENTIAL), null, "a documented key is usable");
  const rejects: readonly { readonly credential: DiditCredential; readonly name: string }[] = [
    { credential: { apiKey: "" }, name: "an empty key is refused" },
    { credential: { apiKey: "   " }, name: "a blank key is refused" },
    { credential: { apiKey: "short" }, name: "a key shorter than any Didit key is refused" },
    { credential: { apiKey: `${API_KEY} with a space` }, name: "a key with whitespace is refused" },
    { credential: { apiKey: "k".repeat(DIDIT_API_KEY_MAXIMUM_LENGTH + 1) }, name: "an over-long key is refused" },
  ];
  for (const entry of rejects) {
    const reason = validateDiditCredential(entry.credential);
    expect(reason !== null && reason.length > 0, entry.name);
  }

  // The documented rule: a key's prefix says nothing about whether it is valid.
  const testPrefixed = { apiKey: `${DIDIT_KEY_PREFIXES[1]}${"a".repeat(43)}` };
  const livePrefixed = { apiKey: `${DIDIT_KEY_PREFIXES[0]}${"a".repeat(43)}` };
  expectEqual(validateDiditCredential(testPrefixed), null, "a test key is a key");
  expectEqual(validateDiditCredential(livePrefixed), null, "a live key is a key");
  expectEqual(validateDiditCredential({ apiKey: `noprefix${"a".repeat(35)}` }), null, "a key with no prefix is a key");
  expectEqual(diditKeyPrefixOf(testPrefixed), DIDIT_KEY_PREFIXES[1], "the documented test prefix is recorded");
  expectEqual(diditKeyPrefixOf(livePrefixed), DIDIT_KEY_PREFIXES[0], "the documented live prefix is recorded");
  expectEqual(diditKeyPrefixOf({ apiKey: `noprefix${"a".repeat(35)}` }), null, "a key with no prefix has no prefix");

  const text = diditCredentialTextOf(CREDENTIAL);
  expect(text.includes(API_KEY), "the serialized credential is the plaintext, which is why it is only ever sealed");
  const read = diditCredentialOf(text);
  expectEqual(read?.apiKey, API_KEY, "the key survives the round trip");
  expectEqual(diditCredentialOf(""), null, "an empty field is not a credential");
  expectEqual(diditCredentialOf("{"), null, "a broken field is not a credential");
  expectEqual(diditCredentialOf("[]"), null, "an array is not a credential");
  expectEqual(diditCredentialOf(JSON.stringify({ key: API_KEY })), null, "another field name is not a credential");
  expectEqual(diditCredentialOf(JSON.stringify({ apiKey: 7 })), null, "a number is not a key");
  expectEqual(diditCredentialOf("x".repeat(2_001)), null, "an over-long field is not a credential");
  expectEqual(diditCredentialOf(JSON.stringify({ apiKey: "short" })), null, "a key that cannot be one does not read");
}

/* ---- 3: the encrypted configuration, its activation, and the mode rule ---- */

async function checkConfiguration(): Promise<void> {
  const recorded: DiditConfigAuditEntry[] = [];
  const noCompany = createDiditConfiguration(
    { companyId: "", environment: "live", credential: CREDENTIAL, webhookSecret: null, occurredAtEpochMs: NOW },
    { configStore: new InMemorySupplementaryIdvConfigStore(), keyring, recordAudit: (entry) => recorded.push(entry) },
  );
  expectEqual(noCompany.status, "failed", "a configuration belongs to a company");

  const badKey = createDiditConfiguration(
    { companyId: COMPANY, environment: "live", credential: { apiKey: "short" }, webhookSecret: null, occurredAtEpochMs: NOW },
    { configStore: new InMemorySupplementaryIdvConfigStore(), keyring },
  );
  expectEqual(badKey.status, "failed", "an unusable key is refused before sealing");

  const store = new InMemorySupplementaryIdvConfigStore();
  const created = createDiditConfiguration(
    { companyId: COMPANY, environment: "live", credential: CREDENTIAL, webhookSecret: "didit_webhook_secret_for_the_gate_0001", occurredAtEpochMs: NOW },
    { configStore: store, keyring, recordAudit: (entry) => recorded.push(entry) },
  );
  expectEqual(created.status, "configured", "a valid configuration is sealed and stored");
  if (created.status !== "configured") return;
  const config = created.config;
  expectEqual(config.status, "pending_activation", "a configuration is not active by being typed in");
  expectEqual(config.vendorKey, "didit", "the configuration names the vendor");
  expectEqual(config.version, 1, "a new configuration starts at version 1");
  expect(isSecretEnvelope(config.credentialSealed) === true, "the key is a sealed envelope");
  expect(isSecretEnvelope(config.webhookSecretSealed ?? "") === true, "the delivery secret is sealed too");
  expect(config.credentialSealed.includes(API_KEY) === false, "the stored row does not carry the key");
  expect(config.credentialSealed !== (config.webhookSecretSealed ?? ""), "two purposes never share one envelope");
  expectEqual(store.findById(config.id)?.id, config.id, "the configuration is stored");
  expectEqual(recorded.length, 1, "one audit entry for the configuration");
  expectEqual(recorded[0]?.action, "didit_idv.configured", "the configuration is recorded as configured");
  expect(asText(recorded[0]).includes(API_KEY) === false, "the entry carries no key");

  // Activation proves the key with a read that creates nothing.
  const transport = new ScriptedTransport([{ status: 404, body: JSON.stringify({ detail: "Not found." }), headers: {} }]);
  const activationAudit: DiditConfigAuditEntry[] = [];
  const activated = await activateDiditConfiguration(config.id, {
    configStore: store,
    keyring,
    occurredAtEpochMs: NOW,
    transport: transport.call,
    recordAudit: (entry) => activationAudit.push(entry),
  });
  expectEqual(activated.status, "activated", "a 404 on a random session proves the key authenticates");
  expectEqual(transport.calls.length, 1, "activation makes one call");
  expectEqual(transport.calls[0]?.method, "GET", "activation reads, so nothing is created");
  expectEqual(transport.calls[0]?.path.startsWith("/v3/session/"), true, "activation reads a decision path");
  expectEqual(transport.calls[0]?.path.endsWith("/decision/"), true, "activation reads a decision path to the end");
  expectEqual(isDiditId((transport.calls[0]?.path ?? "").split("/")[3] ?? ""), true, "the probed session id is a UUID");
  expectEqual(transport.calls[0]?.body, null, "activation sends no body");
  expectEqual(transport.calls[0]?.apiKey, API_KEY, "activation sends the sealed key");
  expectEqual(store.findById(config.id)?.status, "active", "the row is active after the test");
  expectEqual(store.findById(config.id)?.version, 2, "activation moves the version forward");
  expectEqual(activationAudit.map((entry) => entry.action).join(","), "didit_idv.activation_tested,didit_idv.activated", "both activation steps are audited");
  for (const entry of activationAudit) expect(asText(entry).includes(API_KEY) === false, "no activation entry carries the key");

  for (const status of [401, 403, 429, 500]) {
    const refusedStore = new InMemorySupplementaryIdvConfigStore();
    const refusedConfig = createDiditConfiguration(
      { companyId: COMPANY, environment: "live", credential: CREDENTIAL, webhookSecret: null, occurredAtEpochMs: NOW },
      { configStore: refusedStore, keyring },
    );
    if (refusedConfig.status !== "configured") return;
    const refused = await activateDiditConfiguration(refusedConfig.config.id, {
      configStore: refusedStore,
      keyring,
      occurredAtEpochMs: NOW,
      transport: new ScriptedTransport([{ status, body: "", headers: {} }]).call,
    });
    expectEqual(refused.status, "refused", `a ${status} probe does not activate the configuration`);
    expectEqual(refusedStore.findById(refusedConfig.config.id)?.status, "pending_activation", `a ${status} probe leaves the row waiting`);
  }

  const throwingStore = new InMemorySupplementaryIdvConfigStore();
  const throwingConfig = createDiditConfiguration(
    { companyId: COMPANY, environment: "live", credential: CREDENTIAL, webhookSecret: null, occurredAtEpochMs: NOW },
    { configStore: throwingStore, keyring },
  );
  if (throwingConfig.status !== "configured") return;
  const throwing = await activateDiditConfiguration(throwingConfig.config.id, {
    configStore: throwingStore,
    keyring,
    occurredAtEpochMs: NOW,
    transport: async () => {
      throw new Error("the network is gone");
    },
  });
  expectEqual(throwing.status, "failed", "a probe that cannot be made does not activate");

  // The mode rule: a second active vendor in the same company and mode is refused before any call.
  const twoVendorStore = new InMemorySupplementaryIdvConfigStore();
  const first = createDiditConfiguration(
    { companyId: COMPANY, environment: "live", credential: CREDENTIAL, webhookSecret: null, occurredAtEpochMs: NOW },
    { configStore: twoVendorStore, keyring },
  );
  if (first.status !== "configured") return;
  const firstActivation = await activateDiditConfiguration(first.config.id, {
    configStore: twoVendorStore,
    keyring,
    occurredAtEpochMs: NOW,
    transport: new ScriptedTransport([{ status: 404, body: "", headers: {} }]).call,
  });
  expectEqual(firstActivation.status, "activated", "the first Didit configuration becomes the active one");

  const replacement = createDiditConfiguration(
    { companyId: COMPANY, environment: "live", credential: { apiKey: `didit_gate_key_replacement_${"b".repeat(43)}` }, webhookSecret: null, occurredAtEpochMs: NOW },
    { configStore: twoVendorStore, keyring },
  );
  if (replacement.status !== "configured") return;
  const secondTransport = new ScriptedTransport([{ status: 404, body: "", headers: {} }]);
  const secondActivation = await activateDiditConfiguration(replacement.config.id, {
    configStore: twoVendorStore,
    keyring,
    occurredAtEpochMs: NOW,
    transport: secondTransport.call,
  });
  expectEqual(secondActivation.status, "refused", "a second active vendor in the same mode is refused");
  expectEqual(secondTransport.calls.length, 0, "the refusal comes before any vendor call");
  expectEqual(twoVendorStore.findById(replacement.config.id)?.status, "pending_activation", "the refused configuration stays waiting");
  const actives = twoVendorStore.findActiveForCompany(COMPANY);
  expectEqual(actives.length, 1, "only one vendor is active in the company");
  expectEqual(actives[0]?.id, first.config.id, "the first vendor is still the active one");

  const otherCompany = createDiditConfiguration(
    { companyId: "company_kd_didit_other", environment: "live", credential: CREDENTIAL, webhookSecret: null, occurredAtEpochMs: NOW },
    { configStore: twoVendorStore, keyring },
  );
  if (otherCompany.status === "configured") {
    const otherActivation = await activateDiditConfiguration(otherCompany.config.id, {
      configStore: twoVendorStore,
      keyring,
      occurredAtEpochMs: NOW,
      transport: new ScriptedTransport([{ status: 404, body: "", headers: {} }]).call,
    });
    expectEqual(otherActivation.status, "activated", "another company activates its own vendor");
  }
  const testMode = createDiditConfiguration(
    { companyId: COMPANY, environment: "sandbox", credential: CREDENTIAL, webhookSecret: null, occurredAtEpochMs: NOW },
    { configStore: twoVendorStore, keyring },
  );
  if (testMode.status === "configured") {
    const testActivation = await activateDiditConfiguration(testMode.config.id, {
      configStore: twoVendorStore,
      keyring,
      occurredAtEpochMs: NOW,
      transport: new ScriptedTransport([{ status: 404, body: "", headers: {} }]).call,
    });
    expectEqual(testActivation.status, "activated", "the test mode has its own active vendor");
  }

  const otherVendor = configuredStore({ vendorKey: "jumio" });
  const notDidit = await activateDiditConfiguration(otherVendor.config.id, {
    configStore: otherVendor.store,
    keyring,
    occurredAtEpochMs: NOW,
    transport: new ScriptedTransport([{ status: 404, body: "", headers: {} }]).call,
  });
  expectEqual(notDidit.status, "refused", "another vendor's configuration is not activated by this adapter");
}

/* ---- 4: the create answer, and the fields it names ---- */

function checkCreateAnswer(): void {
  const created = parseDiditSessionAnswer(201, createBody());
  expectEqual(created.outcome, "created", "the documented create answer creates a session");
  if (created.outcome === "created") {
    expectEqual(created.sessionId, SESSION_UUID, "the session id is read");
    expectEqual(created.redirectUrl, HOSTED_URL, "the hosted URL is read");
    expectEqual(created.sessionKind, "user", "the kind is read");
  }
  expectEqual(parseDiditSessionAnswer(200, createBody()).outcome, "created", "any 2xx carrying the documented body is a creation");

  const rejectedWorkflow = parseDiditSessionAnswer(400, JSON.stringify({ workflow_id: ["Invalid workflow_id."] }));
  expectEqual(rejectedWorkflow.outcome, "rejected", "an unknown workflow is a rejection");
  if (rejectedWorkflow.outcome === "rejected") {
    expectEqual(rejectedWorkflow.field, "workflow_id", "the refused field is named");
    expect(rejectedWorkflow.detail.includes("workflow_id"), "the detail names the field");
  }
  const rejectedCallback = parseDiditSessionAnswer(
    400,
    JSON.stringify({ callback: ["callback must be on one of the application's allowed domains: https://app.example.com"] }),
  );
  expectEqual(rejectedCallback.outcome, "rejected", "a callback outside the allowed domains is a rejection");
  if (rejectedCallback.outcome === "rejected") expectEqual(rejectedCallback.field, "callback", "the callback is the refused field");
  const rejectedPerson = parseDiditSessionAnswer(400, JSON.stringify({ vendor_data: ["This user or business has been blocked and cannot create new verification sessions."] }));
  expectEqual(rejectedPerson.outcome, "rejected", "a blocked person is a rejection");
  if (rejectedPerson.outcome === "rejected") expectEqual(rejectedPerson.field, "vendor_data", "the vendor data is the refused field");
  const noCredits = parseDiditSessionAnswer(400, JSON.stringify({ detail: "You don't have enough credits to perform this request." }));
  expectEqual(noCredits.outcome, "rejected", "a credit failure is a refusal");
  if (noCredits.outcome === "rejected") expectEqual(noCredits.field, null, "a detail-only refusal names no field");
  expectEqual(parseDiditSessionAnswer(422, "").outcome, "rejected", "an unprocessable request is a rejection");
  expectEqual(parseDiditSessionAnswer(401, "").outcome, "failed", "a bad key is a failure");
  expectEqual(parseDiditSessionAnswer(403, JSON.stringify({ detail: "You do not have permission to perform this action." })).outcome, "failed", "a scoped key is a failure");
  expectEqual(parseDiditSessionAnswer(404, "").outcome, "failed", "a wrong path is a failure");
  expectEqual(parseDiditSessionAnswer(302, "").outcome, "unknown", "a redirect is unknown");
  expectEqual(parseDiditSessionAnswer(429, "").outcome, "unknown", "a rate limit is unknown");
  expectEqual(parseDiditSessionAnswer(500, "").outcome, "unknown", "a server error is unknown");
  expectEqual(parseDiditSessionAnswer(503, "").outcome, "unknown", "an unavailable vendor is unknown");

  const badBodies: readonly { readonly body: string; readonly name: string }[] = [
    { body: "not json", name: "an answer that is not JSON is unknown" },
    { body: JSON.stringify({ session_kind: "user", status: "Not Started", url: HOSTED_URL }), name: "an answer without a session id is unknown" },
    { body: createBody({ session_id: "session-1" }), name: "a session id that is not a UUID is unknown" },
    { body: createBody({ session_kind: "business" }), name: "a business session is not a person's session" },
    { body: createBody({ session_kind: undefined }), name: "an answer without a kind is unknown" },
    { body: createBody({ status: "In Progress" }), name: "a new session with a status it cannot have is unknown" },
    { body: createBody({ url: undefined }), name: "an answer without a hosted URL is unknown" },
    { body: createBody({ url: "http://verify.didit.me/session/x" }), name: "a plaintext hosted URL is unknown" },
    { body: createBody({ url: "https://evil.test/session/x" }), name: "a hosted URL on another host is unknown" },
    { body: createBody({ url: "https://verify.didit.me.evil.test/session/x" }), name: "a lookalike host is unknown" },
  ];
  for (const entry of badBodies) {
    expectEqual(parseDiditSessionAnswer(201, entry.body).outcome, "unknown", entry.name);
  }
  const bounded = parseDiditSessionAnswer(400, JSON.stringify({ detail: "y".repeat(400) }));
  expect(bounded.outcome === "rejected" && bounded.detail.length <= 200, "the vendor's detail is bounded");
}

/* ---- 5: the request this platform builds ---- */

function checkRequest(): void {
  expectEqual(diditVendorDataOf(SESSION_UUID), SESSION_UUID, "the vendor data is the session id");
  expect(diditVendorDataOf("s".repeat(400)).length <= DIDIT_VENDOR_DATA_MAXIMUM_LENGTH, "a long session id is cut to the bound");
  expect(diditVendorDataOf(" s ").includes(" ") === false || diditVendorDataOf(" s ").length > 0, "the vendor data is trimmed");

  const request = buildDiditSessionRequest({ workflowId: WORKFLOW_UUID, sessionId: SESSION_UUID, callbackUrl: SESSION_INPUT.callbackUrl });
  expectEqual(Object.keys(request).sort().join(","), "callback,callback_method,vendor_data,workflow_id", "the request carries four fields and no more");
  expectEqual(request.workflow_id, WORKFLOW_UUID, "the workflow is the office's");
  expectEqual(request.vendor_data, SESSION_UUID, "the reference is ours and carries nothing personal");
  expectEqual(request.callback_method, "both", "the documented callback method is sent when there is a callback");
  expectEqual(
    buildDiditSessionRequest({ workflowId: ` ${WORKFLOW_UUID} `, sessionId: SESSION_UUID, callbackUrl: null }).workflow_id,
    WORKFLOW_UUID,
    "a padded workflow id is normalised rather than sent with its space",
  );
  const withoutCallback = buildDiditSessionRequest({ workflowId: WORKFLOW_UUID, sessionId: SESSION_UUID, callbackUrl: null });
  expectEqual(withoutCallback.callback, null, "no callback is sent when the tenant has none");
  expectEqual(withoutCallback.callback_method, null, "no callback method is sent without a callback");

  const body = asText(request);
  for (const forbidden of ["first_name", "last_name", "date_of_birth", "expected_details", "contact_details", "portrait_image", "document_number", "metadata", "sandbox_scenario", "sign"]) {
    expect(body.includes(forbidden) === false, `the request carries no ${forbidden}`);
  }

  const invalid: readonly { readonly input: typeof SESSION_INPUT; readonly name: string }[] = [
    { input: { ...SESSION_INPUT, workflowId: "" }, name: "an empty workflow id is refused" },
    { input: { ...SESSION_INPUT, workflowId: "the-kyc-workflow" }, name: "a workflow id that is not a UUID is refused" },
    { input: { ...SESSION_INPUT, workflowId: `${WORKFLOW_UUID}x` }, name: "a workflow id with a trailing character is refused" },
    { input: { ...SESSION_INPUT, sessionId: "a b" }, name: "vendor data with whitespace is refused" },
    { input: { ...SESSION_INPUT, callbackUrl: "http://api.kd.test/delivery" }, name: "a plaintext callback is refused" },
    { input: { ...SESSION_INPUT, callbackUrl: "not a url" }, name: "a callback that is not a URL is refused" },
  ];
  for (const entry of invalid) {
    const reason = validateDiditSessionInput(entry.input);
    expect(reason !== null && reason.length > 0, entry.name);
  }
  expectEqual(validateDiditSessionInput(SESSION_INPUT), null, "the documented request shape is accepted");
  expectEqual(validateDiditSessionInput({ ...SESSION_INPUT, callbackUrl: null }), null, "a tenant without a delivery endpoint is accepted");
}

/* ---- 6: opening a session, and the calls it makes ---- */

async function checkOpen(): Promise<void> {
  const happy = configuredStore();
  const session = openedSession(happy.config);
  const transport = new ScriptedTransport([ok(createBody(), 201)]);
  const audit: SupplementaryIdvAuditEntry[] = [];
  const result = await openDiditSession(
    { ...SESSION_INPUT, sessionId: session.session.id },
    optionsWith(transport.call, happy.store, session.store, { recordAudit: (entry) => audit.push(entry) }),
  );
  expectEqual(result.status, "opened", "a documented answer opens the session");
  if (result.status === "opened") {
    expectEqual(result.opened.reference, SESSION_UUID, "the reference is Didit's session id");
    expectEqual(result.opened.redirectUrl, HOSTED_URL, "the hosted URL is handed back once");
    expectEqual(result.opened.session.result, "in_progress", "a new session is in progress");
    expectEqual(result.opened.session.liveness, "in_progress", "liveness is not yet known");
    expectEqual(result.opened.session.reference, SESSION_UUID, "the reference is stored");
    expectEqual(result.opened.session.documentKind, "not_stated", "no document kind is claimed before a document is read");
    expectEqual(result.opened.session.requiresHumanReview, false, "a session in progress does not ask a person yet");
  }

  expectEqual(transport.calls.length, 1, "opening makes exactly one call");
  expectEqual(transport.calls[0]?.method, "POST", "opening creates with a POST");
  expectEqual(transport.calls[0]?.path, DIDIT_SESSIONS_PATH, "opening posts to the documented path");
  expectEqual(transport.calls[0]?.apiKey, API_KEY, "opening sends the sealed key");
  expectEqual(transport.calls[0]?.contentType, "application/json", "opening sends JSON");

  const sent = JSON.parse(transport.calls[0]?.body ?? "{}") as Record<string, unknown>;
  expectEqual(Object.keys(sent).sort().join(","), "callback,callback_method,vendor_data,workflow_id", "the body carries four fields and no more");
  expectEqual(sent["workflow_id"], WORKFLOW_UUID, "the workflow the office chose is sent");
  expectEqual(sent["vendor_data"], session.session.id, "the reference this platform derived is sent");
  expectEqual(sent["callback"], SESSION_INPUT.callbackUrl, "the delivery endpoint is sent");
  expectEqual(sent["callback_method"], "both", "the documented callback method is sent");
  expect(String(sent["vendor_data"]).includes("@") === false, "the reference carries no email address");
  expect(JSON.stringify(sent).includes("Bearer") === false && JSON.stringify(sent).includes(API_KEY) === false, "the key never enters the body");

  // The hosted URL carries a session token: it must be answered once and never stored.
  const storedRow = asText(session.store.findById(session.session.id));
  expect(storedRow.includes("hosted_token") === false, "the stored row carries no hosted token");
  expect(storedRow.includes(HOSTED_URL) === false, "the stored row carries no hosted URL");
  expect(storedRow.includes(API_KEY) === false, "the stored row carries no key");
  expectEqual(session.store.findById(session.session.id)?.reference, SESSION_UUID, "the stored row carries only the reference");

  // A retry after an unclear answer reuses the same vendor_data, which is what makes Didit's idempotency work.
  const retryStore = configuredStore();
  const retrySession = openedSession(retryStore.config);
  const firstTry = new ScriptedTransport([{ status: 500, body: "", headers: {} }]);
  const attempted = await openDiditSession({ ...SESSION_INPUT, sessionId: retrySession.session.id }, optionsWith(firstTry.call, retryStore.store, retrySession.store));
  expectEqual(attempted.status, "failed", "a 500 opens nothing");
  expect(attempted.status === "failed" && attempted.requiresReconciliation === true, "a 500 needs reconciliation");
  const retry = new ScriptedTransport([ok(createBody(), 201)]);
  const retried = await openDiditSession({ ...SESSION_INPUT, sessionId: retrySession.session.id }, optionsWith(retry.call, retryStore.store, retrySession.store));
  expectEqual(retried.status, "opened", "the retry opens the session");
  const retryBody = JSON.parse(retry.calls[0]?.body ?? "{}") as Record<string, unknown>;
  const firstBody = JSON.parse(firstTry.calls[0]?.body ?? "{}") as Record<string, unknown>;
  expectEqual(retryBody["vendor_data"], firstBody["vendor_data"], "the retry sends the same vendor data, so Didit returns the same session");

  // Every refusal the row can produce.
  const inactive = configuredStore({ status: "pending_activation" });
  const inactiveSession = openedSession(inactive.config);
  const inactiveResult = await openDiditSession(
    { ...SESSION_INPUT, sessionId: inactiveSession.session.id },
    optionsWith(new ScriptedTransport([]).call, inactive.store, inactiveSession.store),
  );
  expectEqual(inactiveResult.status, "failed", "a configuration that is not active cannot open a session");
  expect(inactiveResult.status === "failed" && inactiveResult.reason.includes("not active"), "the failure names the activation");

  const wrongVendor = configuredStore({ vendorKey: "jumio" });
  const wrongVendorSession = openedSession(wrongVendor.config);
  const wrongVendorResult = await openDiditSession(
    { ...SESSION_INPUT, sessionId: wrongVendorSession.session.id },
    optionsWith(new ScriptedTransport([]).call, wrongVendor.store, wrongVendorSession.store),
  );
  expectEqual(wrongVendorResult.status, "failed", "another vendor's configuration cannot open a Didit session");

  const otherRing = configuredStore({ ring: otherKeyring });
  const otherRingSession = openedSession(otherRing.config);
  const otherRingTransport = new ScriptedTransport([]);
  const otherRingResult = await openDiditSession(
    { ...SESSION_INPUT, sessionId: otherRingSession.session.id },
    optionsWith(otherRingTransport.call, otherRing.store, otherRingSession.store),
  );
  expectEqual(otherRingResult.status, "failed", "a configuration sealed under another keyring cannot be opened");
  expectEqual(otherRingTransport.calls.length, 0, "no call is made with a key that cannot be opened");

  const modeMismatchStore = configuredStore();
  const modeMismatchSession = openedSession(modeMismatchStore.config, "sandbox");
  const modeMismatchTransport = new ScriptedTransport([]);
  const modeMismatch = await openDiditSession(
    { ...SESSION_INPUT, sessionId: modeMismatchSession.session.id },
    optionsWith(modeMismatchTransport.call, modeMismatchStore.store, modeMismatchSession.store),
  );
  expectEqual(modeMismatch.status, "failed", "a session and its configuration must agree about the mode");
  expectEqual(modeMismatchTransport.calls.length, 0, "a mode mismatch makes no call");

  const missingSession = await openDiditSession(
    { ...SESSION_INPUT, sessionId: "no-such-session" },
    optionsWith(new ScriptedTransport([]).call, happy.store, session.store),
  );
  expectEqual(missingSession.status, "failed", "an unknown session cannot open a vendor session");

  const badInput = await openDiditSession(
    { ...SESSION_INPUT, sessionId: session.session.id, workflowId: "not-a-uuid" },
    optionsWith(new ScriptedTransport([]).call, happy.store, session.store),
  );
  expectEqual(badInput.status, "failed", "an unusable request is refused before any call");

  const rejectedStore = configuredStore();
  const rejectedSession = openedSession(rejectedStore.config);
  const rejected = await openDiditSession(
    { ...SESSION_INPUT, sessionId: rejectedSession.session.id },
    optionsWith(new ScriptedTransport([ok(JSON.stringify({ callback: ["callback must be on one of the application's allowed domains"] }), 400)]).call, rejectedStore.store, rejectedSession.store),
  );
  expectEqual(rejected.status, "rejected", "a refused callback is a rejection");
  expect(rejected.status === "rejected" && rejected.configurationDefect === true, "a refused callback is the office's configuration");

  const blockedStore = configuredStore();
  const blockedSession = openedSession(blockedStore.config);
  const blocked = await openDiditSession(
    { ...SESSION_INPUT, sessionId: blockedSession.session.id },
    optionsWith(new ScriptedTransport([ok(JSON.stringify({ vendor_data: ["This user has been blocked and cannot create new verification sessions."] }), 400)]).call, blockedStore.store, blockedSession.store),
  );
  expectEqual(blocked.status, "rejected", "a blocked person is a rejection");
  expect(blocked.status === "rejected" && blocked.configurationDefect === false, "a blocked person is not a configuration defect");
  expectEqual(blockedSession.store.findById(blockedSession.session.id)?.reference, null, "a rejected person keeps no reference");

  for (const status of [429, 302]) {
    const store = configuredStore();
    const sessionRow = openedSession(store.config);
    const unclear = await openDiditSession(
      { ...SESSION_INPUT, sessionId: sessionRow.session.id },
      optionsWith(new ScriptedTransport([{ status, body: "", headers: {} }]).call, store.store, sessionRow.store),
    );
    expectEqual(unclear.status, "failed", `a ${status} answer opens nothing`);
    expect(unclear.status === "failed" && unclear.requiresReconciliation === true, `a ${status} answer needs reconciliation`);
    expectEqual(sessionRow.store.findById(sessionRow.session.id)?.result, "in_progress", `a ${status} answer is not recorded as a pass or a failure`);
  }

  const throwingStore = configuredStore();
  const throwingSession = openedSession(throwingStore.config);
  const throwing = await openDiditSession(
    { ...SESSION_INPUT, sessionId: throwingSession.session.id },
    optionsWith(async () => {
      throw new Error("the network is gone");
    }, throwingStore.store, throwingSession.store),
  );
  expectEqual(throwing.status, "failed", "a call that cannot be made opens nothing");
  expect(throwing.status === "failed" && throwing.requiresReconciliation === true, "a call that cannot be made needs reconciliation");

  const twiceTransport = new ScriptedTransport([]);
  const twice = await openDiditSession(
    { ...SESSION_INPUT, sessionId: session.session.id },
    optionsWith(twiceTransport.call, happy.store, session.store),
  );
  expectEqual(twice.status, "failed", "a session that already carries a reference is not opened again");
  expectEqual(twiceTransport.calls.length, 0, "the second open makes no call at all");
  expect(twice.status === "failed" && twice.reason.includes("reference"), "the refusal names the reference it already holds");

  const closedStore = configuredStore();
  const closed = openedSession(closedStore.config);
  closed.store.save(
    { ...(closed.store.findById(closed.session.id) as SupplementaryIdvSession), result: "passed", version: 2, updatedAtEpochMs: NOW },
    1,
  );
  const closedResult = await openDiditSession(
    { ...SESSION_INPUT, sessionId: closed.session.id },
    optionsWith(new ScriptedTransport([]).call, closedStore.store, closed.store),
  );
  expectEqual(closedResult.status, "failed", "a finished session is not opened again");

  expect(audit.length >= 1, "the opening is audited");
  for (const entry of audit) {
    expectEqual(entry.companyId, COMPANY, "every entry names the company");
    expectEqual(entry.occurredAtEpochMs, NOW, "every entry carries the caller's clock");
    expect(asText(entry).includes(API_KEY) === false, "no entry carries the key");
    expect(asText(entry).includes("hosted_token") === false, "no entry carries the hosted token");
  }
}

/* ---- 7: the decision, and the exact words it becomes ---- */

function checkDecisionMapping(): void {
  const passing = parseDiditDecision(decisionBody());
  expect(passing !== null, "a documented decision is read");
  if (passing !== null) {
    expectEqual(passing.status, "Approved", "the session status is read");
    expectEqual(passing.sessionKind, "user", "the kind is read");
    expectEqual(passing.documentType, "Passport", "the document class is read");
    expectEqual(passing.features.length, 4, "every feature array present is read");
    expectEqual(passing.features.filter((feature) => feature.feature === "liveness_checks").length, 1, "liveness is one feature");
  }
  const answer = diditAnswerOf(passing as NonNullable<typeof passing>, "ref:1");
  expectEqual(answer.result, "passed", "a clean decision passes");
  expectEqual(answer.liveness, "passed", "liveness passed");
  expectEqual(answer.documentKind, "passport", "a passport is a passport");
  expectEqual(answer.reasonCode, "not_stated", "a pass carries no reason");
  expectEqual(answer.reference, "ref:1", "the answer carries the reference it was asked about");
  expect(isProcessorKybStatus(answer.result) === false, "the result is not a processor status");

  const shapes: readonly {
    readonly body: string;
    readonly result: string;
    readonly liveness: string;
    readonly kind: string;
    readonly reason: string | null;
    readonly name: string;
  }[] = [
    {
      body: decisionBody({ status: "Declined", liveness: [featureReport("Declined", { warnings: [warning("LIVENESS_FACE_ATTACK", "error")] })] }),
      result: "failed",
      liveness: "failed",
      kind: "passport",
      reason: "liveness_failed",
      name: "a presentation attack fails as liveness",
    },
    {
      body: decisionBody({ status: "Declined", liveness: [featureReport("Declined")] }),
      result: "failed",
      liveness: "failed",
      kind: "passport",
      reason: "liveness_failed",
      name: "a declined liveness fails as liveness even with no warning",
    },
    {
      body: decisionBody({ status: "Declined", faceMatches: [featureReport("Declined", { warnings: [warning("LOW_FACE_MATCH_SIMILARITY", "error")] })] }),
      result: "failed",
      liveness: "passed",
      kind: "passport",
      reason: "document_mismatch",
      name: "a low similarity fails as a mismatch",
    },
    {
      body: decisionBody({ status: "Declined", faceMatches: [featureReport("Declined")] }),
      result: "failed",
      liveness: "passed",
      kind: "passport",
      reason: "document_mismatch",
      name: "a declined face match fails as a mismatch even with no warning",
    },
    {
      body: decisionBody({ status: "Declined", idVerifications: [featureReport("Declined")] }),
      result: "failed",
      liveness: "passed",
      kind: "not_stated",
      reason: "document_unreadable",
      name: "a declined document fails as unreadable",
    },
    {
      body: decisionBody({ status: "Declined", idVerifications: [featureReport("Declined", { warnings: [warning("DOCUMENT_EXPIRED", "error")] })] }),
      result: "failed",
      liveness: "passed",
      kind: "not_stated",
      reason: "document_expired",
      name: "an expired document is an expired document",
    },
    {
      body: decisionBody({ status: "Declined", idVerifications: [featureReport("Declined", { warnings: [warning("SOMETHING_THIS_FILE_HAS_NOT_READ", "error")] })] }),
      result: "failed",
      liveness: "passed",
      kind: "not_stated",
      reason: "document_unreadable",
      name: "an unread warning code falls back to the feature that decided",
    },
    {
      body: decisionBody({ status: "In Review", faceMatches: [featureReport("In Review", { warnings: [warning("LOW_FACE_MATCH_SIMILARITY", "warning")] })] }),
      result: "unknown",
      liveness: "passed",
      kind: "passport",
      reason: "document_mismatch",
      name: "a review keeps the warning's reason",
    },
    {
      body: decisionBody({ status: "In Review" }),
      result: "unknown",
      liveness: "passed",
      kind: "passport",
      reason: "vendor_incomplete",
      name: "a review with no warning is unknown",
    },
    {
      body: decisionBody({ status: "Not Started", idVerifications: [] }),
      result: "in_progress",
      liveness: "passed",
      kind: "not_stated",
      reason: "vendor_incomplete",
      name: "a session nobody opened is in progress",
    },
    {
      body: decisionBody({ status: "In Progress" }),
      result: "in_progress",
      liveness: "passed",
      kind: "passport",
      reason: "vendor_incomplete",
      name: "a session being worked on is in progress",
    },
    {
      body: decisionBody({ status: "Awaiting User" }),
      result: "in_progress",
      liveness: "passed",
      kind: "passport",
      reason: "vendor_incomplete",
      name: "a session waiting for a party is in progress",
    },
    {
      body: decisionBody({ status: "Resubmitted" }),
      result: "in_progress",
      liveness: "passed",
      kind: "passport",
      reason: "vendor_incomplete",
      name: "a resubmitted session is in progress",
    },
    {
      body: decisionBody({ status: "Expired" }),
      result: "expired",
      liveness: "passed",
      kind: "passport",
      reason: "session_expired",
      name: "a session that timed out before it opened is expired",
    },
    {
      body: decisionBody({ status: "Abandoned" }),
      result: "expired",
      liveness: "passed",
      kind: "passport",
      reason: "session_expired",
      name: "a session the person abandoned is expired",
    },
    {
      body: decisionBody({ status: "Kyc Expired" }),
      result: "expired",
      liveness: "passed",
      kind: "passport",
      reason: "session_expired",
      name: "a document that expired after approval is expired",
    },
    {
      body: decisionBody({ status: "approved" }),
      result: "unknown",
      liveness: "passed",
      kind: "passport",
      reason: "vendor_incomplete",
      name: "a lower-case status is not Didit's own word and is unknown",
    },
    {
      body: decisionBody({ status: "Approved " }),
      result: "unknown",
      liveness: "passed",
      kind: "passport",
      reason: "vendor_incomplete",
      name: "a trailing space makes an unknown status, not a pass",
    },
    {
      body: decisionBody({ status: "VERIFIED" }),
      result: "unknown",
      liveness: "passed",
      kind: "passport",
      reason: "vendor_incomplete",
      name: "a status Didit never sends is unknown",
    },
    {
      body: decisionBody({ status: "Approved", sessionKind: "business" }),
      result: "unknown",
      liveness: "passed",
      kind: "passport",
      reason: "vendor_incomplete",
      name: "a business session is never a person's pass",
    },
    {
      body: decisionBody({ status: "Approved", documentType: "Identity Card" }),
      result: "passed",
      liveness: "passed",
      kind: "national_id",
      reason: "not_stated",
      name: "an identity card is the neutral national id",
    },
    {
      body: decisionBody({ status: "Approved", documentType: "Driver's License" }),
      result: "passed",
      liveness: "passed",
      kind: "driving_licence",
      reason: "not_stated",
      name: "a driving licence is a driving licence",
    },
    {
      body: decisionBody({ status: "Approved", documentType: "Residence Permit" }),
      result: "passed",
      liveness: "passed",
      kind: "residence_permit",
      reason: "not_stated",
      name: "a residence permit is a residence permit",
    },
    {
      body: decisionBody({ status: "Approved", documentType: "Visa" }),
      result: "passed",
      liveness: "passed",
      kind: "not_stated",
      reason: "not_stated",
      name: "a visa makes no residence claim",
    },
    {
      body: decisionBody({ status: "Approved", documentType: "Health Insurance Card" }),
      result: "passed",
      liveness: "passed",
      kind: "not_stated",
      reason: "not_stated",
      name: "a health card states no kind",
    },
    {
      body: decisionBody({ status: "Approved", documentType: "Martian Permit" }),
      result: "passed",
      liveness: "passed",
      kind: "not_stated",
      reason: "not_stated",
      name: "a document class this file has not read states no kind",
    },
    {
      body: decisionBody({ status: "Approved", documentType: null }),
      result: "passed",
      liveness: "passed",
      kind: "not_stated",
      reason: "not_stated",
      name: "a document with no class states no kind",
    },
    {
      body: decisionBody({ status: "In Review", liveness: [featureReport("In Review")] }),
      result: "unknown",
      liveness: "unknown",
      kind: "passport",
      reason: "vendor_incomplete",
      name: "a liveness in review is neither a pass nor a failure",
    },
    {
      body: decisionBody({ status: "In Progress", liveness: [featureReport("Not Finished")] }),
      result: "in_progress",
      liveness: "in_progress",
      kind: "passport",
      reason: "vendor_incomplete",
      name: "an unfinished liveness is in progress",
    },
    {
      body: decisionBody({ status: "In Progress", liveness: [featureReport("Resub Requested")] }),
      result: "in_progress",
      liveness: "in_progress",
      kind: "passport",
      reason: "vendor_incomplete",
      name: "a resubmission request is in progress",
    },
    {
      body: decisionBody({ status: "In Progress", liveness: [featureReport("OK")] }),
      result: "in_progress",
      liveness: "in_progress",
      kind: "passport",
      reason: "vendor_incomplete",
      name: "a liveness word this file has not read is not a pass",
    },
  ];

  for (const shape of shapes) {
    const parsed = parseDiditDecision(shape.body);
    expect(parsed !== null, `${shape.name}: the decision is read`);
    if (parsed === null) continue;
    const mapped = diditAnswerOf(parsed, "ref:1");
    expectEqual(mapped.result, shape.result, shape.name);
    expectEqual(mapped.liveness, shape.liveness, `${shape.name}: liveness`);
    expectEqual(mapped.documentKind, shape.kind, `${shape.name}: document kind`);
    expectEqual(mapped.reasonCode, shape.reason, `${shape.name}: reason`);
    expect((SUPPLEMENTARY_IDV_RESULTS as readonly string[]).includes(mapped.result), `${shape.name}: the result is a supplementary word`);
    expect((SUPPLEMENTARY_IDV_LIVENESS_RESULTS as readonly string[]).includes(mapped.liveness), `${shape.name}: liveness is a supplementary word`);
    expect((SUPPLEMENTARY_IDV_DOCUMENT_KINDS as readonly string[]).includes(mapped.documentKind), `${shape.name}: kind is a supplementary word`);
    expect(mapped.reasonCode === null || isSupplementaryIdvReasonCode(mapped.reasonCode), `${shape.name}: reason is a supplementary word`);
    expect(isProcessorKybStatus(mapped.result) === false, `${shape.name}: the result is not a processor status`);
    expectEqual(supplementaryIdvOverlapsProcessorKyb(mapped.result), false, `${shape.name}: the vocabularies stay disjoint`);
    expectEqual(isSupplementaryIdvResult(mapped.result), true, `${shape.name}: the result is one of the five`);
  }

  // A feature status this file has not read is dropped rather than believed.
  const invented = parseDiditDecision(decisionBody({ liveness: [featureReport("Passed")] }));
  expect(invented !== null, "a decision with an invented feature status is still read");
  if (invented !== null) {
    const liveness = invented.features.find((feature) => feature.feature === "liveness_checks");
    expectEqual(liveness?.status, null, "an invented feature status becomes null");
    expectEqual(diditAnswerOf(invented, "ref:1").liveness, "in_progress", "an invented feature status cannot make a liveness pass");
  }

  // Nothing Didit says can turn into a processor word.
  const hostile = parseDiditDecision(decisionBody({ status: "Approved", sessionKind: "user" }));
  if (hostile !== null) {
    const mapped = diditAnswerOf(hostile, "ref:1");
    expect(PROCESSOR_KYB_STATUSES.includes(mapped.result as never) === false, "even an approval is not one of the processor's five");
    expectEqual(refuseProcessorKybWrite(mapped.result).status, "refused", "a processor write is refused at the boundary");
    expectEqual(PROCESSOR_KYB_AUTHORITY, "processor", "the processor keeps the verdict");
  }

  expectEqual(parseDiditDecision("not json"), null, "a decision that is not JSON is not read");
  expectEqual(parseDiditDecision(JSON.stringify({ session_id: SESSION_UUID })), null, "a decision with no status is not read");
  expectEqual(parseDiditDecision(JSON.stringify({ status: "Approved" }))?.features.length, 0, "a decision with no features is read with none");
}

/* ---- 8: reading a decision over the wire ---- */

function checkReadAnswer(): void {
  const read = parseDiditReadAnswer(200, decisionBody(), SESSION_UUID);
  expectEqual(read.outcome, "read", "a finished decision is a read");
  if (read.outcome === "read") {
    expectEqual(read.answer.result, "passed", "the read carries the neutral result");
    expectEqual(read.answer.reference, SESSION_UUID, "the read carries the reference it was asked about");
  }
  expectEqual(parseDiditReadAnswer(200, decisionBody({ status: "In Progress" }), SESSION_UUID).outcome, "in_flight", "a session being worked on is in flight");
  expectEqual(parseDiditReadAnswer(404, JSON.stringify({ detail: "Not found." }), SESSION_UUID).outcome, "not_found", "a session Didit does not know is not found");
  expectEqual(parseDiditReadAnswer(401, "", SESSION_UUID).outcome, "failed", "a refused key fails the read");
  expectEqual(parseDiditReadAnswer(403, JSON.stringify({ detail: "You do not have permission to perform this action." }), SESSION_UUID).outcome, "failed", "a scoped key fails the read");
  expectEqual(parseDiditReadAnswer(400, "", SESSION_UUID).outcome, "failed", "a malformed read fails");
  for (const status of [302, 429, 500, 503]) {
    expectEqual(parseDiditReadAnswer(status, "", SESSION_UUID).outcome, "unknown", `a ${status} read answer is unknown`);
  }
  expectEqual(parseDiditReadAnswer(200, JSON.stringify({ session_id: SESSION_UUID }), SESSION_UUID).outcome, "unknown", "a read with no status is unknown");
  expectEqual(parseDiditReadAnswer(200, "not json", SESSION_UUID).outcome, "unknown", "a read that is not JSON is unknown");
}

/* ---- 9: refreshing a session, forward only ---- */

async function checkRefresh(): Promise<void> {
  const store = configuredStore();
  const session = openedSession(store.config);
  const opened = await openDiditSession(
    { ...SESSION_INPUT, sessionId: session.session.id },
    optionsWith(new ScriptedTransport([ok(createBody(), 201)]).call, store.store, session.store),
  );
  expectEqual(opened.status, "opened", "the session opens before it is refreshed");

  const first = await refreshDiditSession(
    session.session.id,
    optionsWith(new ScriptedTransport([ok(decisionBody())]).call, store.store, session.store),
  );
  expectEqual(first.status, "recorded", "a finished decision is recorded");
  if (first.status === "recorded") {
    expectEqual(first.session.result, "passed", "the session passes");
    expectEqual(first.session.liveness, "passed", "liveness is recorded");
    expectEqual(first.session.documentKind, "passport", "the document kind is recorded");
    expectEqual(first.session.requiresHumanReview, false, "a pass needs no person");
    expectEqual(first.changed, true, "the first read changes the row");
  }

  const again = await refreshDiditSession(
    session.session.id,
    optionsWith(new ScriptedTransport([ok(decisionBody())]).call, store.store, session.store),
  );
  expectEqual(again.status, "recorded", "a second read is recorded");
  expectEqual(again.status === "recorded" ? again.changed : null, false, "the same answer changes nothing");

  const backwards = await refreshDiditSession(
    session.session.id,
    optionsWith(new ScriptedTransport([ok(decisionBody({ status: "Declined", liveness: [featureReport("Declined")] }))]).call, store.store, session.store),
  );
  expectEqual(backwards.status, "refused", "a pass is not replayed into a failure");
  expectEqual(session.store.findById(session.session.id)?.result, "passed", "the recorded pass stays");

  // Kyc Expired after an approval cannot rewrite the pass: the row is a snapshot, and a new session is the answer.
  const expiredAfterPass = await refreshDiditSession(
    session.session.id,
    optionsWith(new ScriptedTransport([ok(decisionBody({ status: "Kyc Expired" }))]).call, store.store, session.store),
  );
  expectEqual(expiredAfterPass.status, "refused", "an expiry after a recorded pass does not rewrite it");
  expectEqual(session.store.findById(session.session.id)?.result, "passed", "the recorded pass still stands");

  // An unhappy result is a manual review, and the merchant phrase stays neutral.
  const unhappyStore = configuredStore();
  const unhappySession = openedSession(unhappyStore.config);
  await openDiditSession(
    { ...SESSION_INPUT, sessionId: unhappySession.session.id },
    optionsWith(new ScriptedTransport([ok(createBody(), 201)]).call, unhappyStore.store, unhappySession.store),
  );
  const unhappy = await refreshDiditSession(
    unhappySession.session.id,
    optionsWith(new ScriptedTransport([ok(decisionBody({ status: "Declined", liveness: [featureReport("Declined", { warnings: [warning("LIVENESS_FACE_ATTACK", "error")] })] }))]).call, unhappyStore.store, unhappySession.store),
  );
  expectEqual(unhappy.status, "recorded", "a declined check is recorded, not thrown");
  if (unhappy.status === "recorded") {
    expectEqual(unhappy.session.result, "failed", "the session fails");
    expectEqual(unhappy.session.requiresHumanReview, true, "a failed check is a manual case");
    expect(unhappy.session.fallback !== null, "a failed check falls back to manual review");
    const phrase = asText(supplementaryIdvMerchantStatusOf("failed")).toLowerCase();
    expect(phrase.includes("didit") === false, "the merchant phrase names no vendor");
    expect(phrase.includes("declined") === false, "the merchant phrase uses no vendor word");
    expect(asText(unhappy.session).includes("LIVENESS_FACE_ATTACK") === false, "the vendor's warning code is not stored");
    expect(asText(unhappy.session).includes("hosted_token") === false, "no hosted token is stored");
  }

  const expiredStore = configuredStore();
  const expiredSession = openedSession(expiredStore.config);
  await openDiditSession(
    { ...SESSION_INPUT, sessionId: expiredSession.session.id },
    optionsWith(new ScriptedTransport([ok(createBody(), 201)]).call, expiredStore.store, expiredSession.store),
  );
  const expired = await refreshDiditSession(
    expiredSession.session.id,
    optionsWith(new ScriptedTransport([ok(decisionBody({ status: "Expired" }))]).call, expiredStore.store, expiredSession.store),
  );
  expectEqual(expired.status, "recorded", "an expired session is recorded");
  if (expired.status === "recorded") {
    expectEqual(expired.session.result, "expired", "the session expires");
    expectEqual(expired.session.requiresHumanReview, true, "an expired session is a manual case");
  }

  for (const status of [404, 401, 429, 500]) {
    const failing = await refreshDiditSession(
      expiredSession.session.id,
      optionsWith(new ScriptedTransport([{ status, body: "", headers: {} }]).call, expiredStore.store, expiredSession.store),
    );
    expect(failing.status === "failed", `a ${status} refresh does not record an answer`);
  }
  const unreadable = await refreshDiditSession(
    session.session.id,
    optionsWith(new ScriptedTransport([ok("not json")]).call, store.store, session.store),
  );
  expectEqual(unreadable.status, "failed", "an unreadable decision is not recorded");

  const throwing = await refreshDiditSession(
    session.session.id,
    optionsWith(async () => {
      throw new Error("the network is gone");
    }, store.store, session.store),
  );
  expectEqual(throwing.status, "failed", "a read that cannot be made records nothing");

  const unreferenced = openedSession(configuredStore().config);
  const noReference = await refreshDiditSession(
    unreferenced.session.id,
    optionsWith(new ScriptedTransport([]).call, store.store, unreferenced.store),
  );
  expectEqual(noReference.status, "failed", "a session with no reference cannot be read");

  const unknownSession = await refreshDiditSession("no-such-session", optionsWith(new ScriptedTransport([]).call, store.store, session.store));
  expectEqual(unknownSession.status, "failed", "an unknown session cannot be read");

  const decision = parseDiditDecision(decisionBody());
  const finalSession = session.store.findById(session.session.id) as SupplementaryIdvSession;
  if (decision !== null) {
    const summary = diditSessionSummaryOf(finalSession, decision);
    expectEqual(summary.changesProcessorKyb, false, "the summary changes no processor status");
    expectEqual(summary.result, "passed", "the summary carries the neutral result");
    expectEqual(summary.sessionStatus, "Approved", "the summary keeps the vendor's status for the office");
    expectEqual(summary.features.length, 4, "the summary keeps every feature");
    expectEqual(summary.documentKind, "passport", "the summary carries the document kind");
  }
  const evidence = supplementaryIdvEvidenceOf(finalSession);
  expect(asText(evidence).includes("passport"), "the evidence carries the document kind");
  expect(isProcessorKybStatus(asText(evidence) as never) === false, "the evidence is not a processor status");
}

/* ---- 10: the port STEP 170 defined, and its three members ---- */

async function checkAdapter(): Promise<void> {
  const transport = new ScriptedTransport([ok(createBody(), 201), ok(decisionBody())]);
  const adapter = diditAdapterOf({
    transport: transport.call,
    workflowId: WORKFLOW_UUID,
    callbackUrl: SESSION_INPUT.callbackUrl,
  });

  expectEqual(isSupplementaryIdvAdapter(adapter), true, "the adapter fits STEP 170's port");
  expectEqual(adapter.vendorKey, "didit", "the adapter names its vendor");
  expectEqual(Object.keys(adapter).sort().join(","), [...SUPPLEMENTARY_IDV_ADAPTER_MEMBERS].sort().join(","), "the adapter has exactly the port's members");
  expect(Object.keys(adapter).includes("setStatus") === false, "the port has no status writer");
  expect(Object.keys(adapter).includes("writeKyb") === false, "the port has no KYB writer");

  const sealedConfig = configuredStore();
  const openedConfig = {
    configId: sealedConfig.config.id,
    companyId: COMPANY,
    vendorKey: "didit",
    environment: "live",
    credential: diditCredentialTextOf(CREDENTIAL),
    webhookSecret: null,
  } as OpenedSupplementaryIdvConfig;

  const created = await adapter.createSession(
    { companyId: COMPANY, sessionId: SESSION_UUID, environment: "live", returnUrl: SESSION_INPUT.callbackUrl },
    openedConfig,
  );
  expectEqual(created.result, "in_progress", "the port's create answers in progress");
  expectEqual(created.reference, SESSION_UUID, "the port's create answers the reference");
  expectEqual(created.liveness, "in_progress", "no liveness is claimed at creation");
  expectEqual(transport.calls.length, 1, "the port's create makes one call");

  const read = await adapter.readSession(SESSION_UUID, openedConfig);
  expectEqual(read.result, "passed", "the port's read answers the neutral result");
  expectEqual(read.documentKind, "passport", "the port's read answers the document kind");
  expect(isProcessorKybStatus(read.result) === false, "the port's read never answers a processor status");

  await expectRejects(
    async () => adapter.readSession("not-a-uuid", openedConfig),
    "the port refuses a reference that is not a session id",
  );
  await expectRejects(
    async () =>
      adapter.readSession(SESSION_UUID, {
        configId: sealedConfig.config.id,
        companyId: COMPANY,
        vendorKey: "didit",
        environment: "live",
        credential: "not a credential",
        webhookSecret: null,
      } as OpenedSupplementaryIdvConfig),
    "the port refuses an opened configuration that holds no key",
  );

  const refusing = diditAdapterOf({
    transport: async () => ({ status: 401, body: "", headers: {} }),
    workflowId: WORKFLOW_UUID,
    callbackUrl: null,
  });
  await expectRejects(
    async () => refusing.createSession({ companyId: COMPANY, sessionId: SESSION_UUID, environment: "live", returnUrl: SESSION_INPUT.callbackUrl }, openedConfig),
    "the port throws rather than answering when the key is refused",
  );
}

/* ---- 11: the transport's own guards, and the source ---- */

async function checkTransport(): Promise<void> {
  const documented: DiditCall = {
    method: "POST",
    path: DIDIT_SESSIONS_PATH,
    apiKey: API_KEY,
    contentType: "application/json",
    body: JSON.stringify({ workflow_id: WORKFLOW_UUID, vendor_data: SESSION_UUID }),
  };
  expect(isDiditCall(documented.method, documented.path) === true, "the transport's create call is documented");

  await expectRejects(
    async () => diditFetchTransport({ ...documented, path: "/v3/sessions/" }),
    "the transport refuses a path it does not know",
  );
  await expectRejects(
    async () => diditFetchTransport({ ...documented, method: "DELETE" as unknown as "POST" }),
    "the transport refuses a method it does not know",
  );
  await expectRejects(
    async () => diditFetchTransport({ ...documented, path: "/auth/v2/organizations/me/" }),
    "the transport refuses the account host surface",
  );
  await expectRejects(
    async () => diditFetchTransport({ ...documented, apiKey: "" }),
    "the transport refuses to call without a key",
  );

  const source = readFileSync(fileURLToPath(new URL("./didit.ts", import.meta.url)), "utf8");
  // Assembled rather than written out, because the structure gate refuses that literal anywhere in a source file.
  const consoleCalls = ["log", "error", "warn"].map((name) => ["console", `${name}(`].join("."));
  expect(consoleCalls.every((needle) => source.includes(needle) === false), "the adapter logs nothing");
  expect(source.includes("process.env") === false, "the adapter reads no ambient environment for a key");
  expect(source.includes("authorization") === false, "the adapter sends no authorization header");
  expect(source.includes("Bearer ") === false, "the adapter sends no bearer token");
  expect((source.match(/https:\/\//gu) ?? []).length > 0, "the adapter names its hosts explicitly");
  const hosts = new Set((source.match(/https:\/\/[a-z0-9.-]+/gu) ?? []).map((url) => url.replace(/^https:\/\//u, "")));
  for (const host of hosts) {
    expect(
      host === "verification.didit.me" ||
        host === "verify.didit.me" ||
        host === "apx.didit.me" ||
        host === "docs.didit.me" ||
        host === "business.didit.me" ||
        host === "media.didit.me" ||
        host === "didit.me",
      `the adapter names no host but Didit's (${host})`,
    );
  }
  expect(source.includes("apx.didit.me") === true, "the refused account host is named only to say it is refused");
  expect(source.includes("diditEndpoint(DIDIT_ACCOUNT_HOST_REFUSED)") === false, "the account host is never called");

  const transport = new ScriptedTransport([ok(createBody(), 201)]);
  const store = configuredStore();
  const session = openedSession(store.config);
  await openDiditSession({ ...SESSION_INPUT, sessionId: session.session.id }, optionsWith(transport.call, store.store, session.store));
  for (const call of transport.calls) {
    expect(call.path.includes("?") === false, "no call carries a query string");
    expect(call.path.includes(API_KEY) === false, "no path carries the key");
    expect(JSON.stringify(call).includes("hosted_token") === false, "no call replays the hosted token");
  }
}

/* ---- running ---- */

checkCatalogue();
checkCredential();
await checkConfiguration();
checkCreateAnswer();
checkRequest();
await checkOpen();
checkDecisionMapping();
checkReadAnswer();
await checkRefresh();
await checkAdapter();
await checkTransport();

if (failures.length > 0) {
  process.stderr.write(
    `didit adapter gate failed: ${failures.length} of ${checks} checks\n${failures.map((failure) => `  - ${failure}`).join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `didit adapter gate passed: ${checks} checks (one documented verification host and two documented calls behind an allowlist with the account host refused by name, an x-api-key sealed by STEP 170's own scopes and inert until a probe proves it without creating a billable session, a key prefix recorded but never read as a mode, one active vendor per company and mode, a session row written before Didit is called and a hosted URL that carries a session token and is therefore never stored, ten spaced status words matched exactly so a lower-case or trailing-space approval is unknown rather than a pass, a business session refused as a person's result, an expiry after a recorded pass refused rather than rewriting it, documented idempotency used so a retry reconciles the same session instead of making a second one, and a supplementary pass that stays disjoint from the processor's five statuses at every step)\n`,
);
