// path: lib/kyc/adapters/jumio-verify.ts

/**
 * The gate for STEP 171: Jumio as a supplementary identity check, behind the three-member port STEP 170 defined.
 *
 * A check script, not a test file. It builds a real sealed configuration with STEP 056's encryption layer, drives a
 * session from open to answer through a scripted transport that answers exactly the bodies Jumio's documentation
 * shows, and then tries to break the things that matter: a decision word the vendor never documents, a workflow
 * status this adapter would have to invent, a redirect URL that must not be stored, a second active vendor, a
 * forward-only result being replayed backwards, and any path from a supplementary pass to a processor KYB verdict.
 *
 * No network call is made, no real credential exists, and every answer body below is the documentation's own shape.
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
  InMemoryJumioTokenCache,
  JUMIO_ALLOWED_CALLS,
  JUMIO_COMPLETED_WORKFLOW_STATUS,
  JUMIO_CUSTOMER_REFERENCE_FORBIDDEN,
  JUMIO_CUSTOMER_REFERENCE_MAXIMUM_LENGTH,
  JUMIO_DECISIONS,
  JUMIO_DOCUMENT_TYPES,
  JUMIO_EXPIRED_JOURNEY_STATE,
  JUMIO_IDENTITY_CAPABILITIES,
  JUMIO_MAXIMUM_ANSWER_BYTES,
  JUMIO_REGIONS,
  JUMIO_SURFACES,
  JUMIO_TOKEN_PATH,
  JUMIO_VENDOR_KEY,
  activateJumioConfiguration,
  buildJumioAccountRequest,
  createJumioConfiguration,
  isJumioCall,
  isJumioDecision,
  isJumioId,
  isJumioRegion,
  jumioAdapterOf,
  jumioAnswerOf,
  jumioBasicAuthOf,
  jumioCredentialOf,
  jumioCredentialTextOf,
  jumioCustomerReferenceOf,
  jumioEndpoint,
  jumioFetchTransport,
  jumioHost,
  jumioIdsOf,
  jumioReferenceOf,
  jumioSessionSummaryOf,
  jumioWorkflowExecutionPath,
  openJumioSession,
  parseJumioAccountAnswer,
  parseJumioReadAnswer,
  parseJumioTokenAnswer,
  parseJumioWorkflow,
  refreshJumioSession,
  validateJumioCredential,
  validateJumioCustomerReference,
  validateJumioSessionInput,
  type JumioAnswer,
  type JumioCall,
  type JumioConfigAuditEntry,
  type JumioCredential,
  type JumioOptions,
  type JumioTransport,
} from "./jumio.ts";

/* ---- the checking harness, the same shape STEP 170 used ---- */

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
const COMPANY = "company_kd_jumio_gate";
const ACCOUNT_ID = "497f6eca-6276-4993-bfeb-53cbbbba6f08";
const EXECUTION_ID = "f203a9d4-31d7-4241-811e-35c68dc7a513";
const REDIRECT = `https://web.amer-1.jumio.ai/web/v4/app?authorizationToken=token_that_must_never_be_stored&locale=en`;
const ACCESS_TOKEN = "eyJhbGciOiJSUzI1NiJ9.access_token_for_the_gate";
const CREDENTIAL: JumioCredential = {
  region: "amer-1",
  clientId: "client_id_for_the_gate_0001",
  clientSecret: "client_secret_for_the_gate_0001",
};

const keyring: EncryptionKeyring = { primary: { id: "k1", secret: Buffer.alloc(32, 7).toString("base64") } };
const otherKeyring: EncryptionKeyring = { primary: { id: "k2", secret: Buffer.alloc(32, 9).toString("base64") } };

const TOKEN_BODY = JSON.stringify({ access_token: ACCESS_TOKEN, expires_in: 3600, token_type: "Bearer" });

function accountBody(overrides: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    timestamp: "2026-11-06T10:00:00Z",
    account: { id: ACCOUNT_ID },
    web: { href: REDIRECT, successUrl: "https://app.kd.test/kyc/done", errorUrl: "https://app.kd.test/kyc/error" },
    sdk: { token: "sdk_token_for_the_gate" },
    workflowExecution: { id: EXECUTION_ID, credentials: [] },
    ...overrides,
  });
}

/** One documented capability entry, in the shape the retrieval API returns. */
function capability(type: string, label: string | null): Record<string, unknown> {
  return {
    id: "497f6eca-6276-4993-bfeb-53cbbbba6f08",
    credentials: [{ id: "f203a9d4-31d7-4241-811e-35c68dc7a513", category: "ID" }],
    decision: { type, ...(label === null ? {} : { details: { label } }) },
  };
}

function detailsBody(
  capabilities: Readonly<Record<string, readonly unknown[]>>,
  options: {
    readonly status?: string;
    readonly documentType?: string | null;
    readonly journeyState?: readonly string[];
  } = {},
): string {
  const extraction =
    options.documentType === undefined
      ? capabilities["extraction"]
      : [{ ...capability("PASSED", "OK"), data: { type: options.documentType } }];
  return JSON.stringify({
    workflow: {
      id: EXECUTION_ID,
      status: options.status ?? "PROCESSED",
      definitionKey: "10549",
      account: { id: ACCOUNT_ID },
      createdAt: "2026-11-06T10:00:00Z",
      startedAt: "2026-11-06T10:01:00Z",
      completedAt: "2026-11-06T10:02:00Z",
    },
    account: { id: ACCOUNT_ID },
    capabilities: { ...capabilities, ...(extraction === undefined ? {} : { extraction }) },
    ...(options.journeyState === undefined ? {} : { captureClient: { client: "web", state: options.journeyState } }),
  });
}

/** A clean pass: the document read, the person present, the faces matching. */
const PASSING_CAPABILITIES = {
  usability: [capability("PASSED", "OK")],
  classification: [capability("PASSED", "OK")],
  extraction: [capability("PASSED", "OK")],
  imageChecks: [capability("PASSED", "OK")],
  dataChecks: [capability("PASSED", "OK")],
  liveness: [capability("PASSED", "OK")],
  similarity: [capability("PASSED", "OK")],
} as const;

/** A scripted transport: it answers the calls it was given, in order, and remembers what it was asked. */
class ScriptedTransport {
  readonly calls: JumioCall[] = [];
  private readonly answers: JumioAnswer[];

  constructor(answers: readonly JumioAnswer[]) {
    this.answers = [...answers];
  }

  readonly call: JumioTransport = async (call) => {
    this.calls.push(call);
    const answer = this.answers.shift();
    if (answer === undefined) throw new Error("the scripted transport ran out of answers");
    return answer;
  };

  get remaining(): number {
    return this.answers.length;
  }
}

function tokenAnswer(): JumioAnswer {
  return { status: 200, body: TOKEN_BODY, headers: { "content-type": "application/json" } };
}

function ok(body: string, status = 200): JumioAnswer {
  return { status, body, headers: { "content-type": "application/json" } };
}

/** A configuration store with one sealed Jumio configuration, activated by script. */
function configuredStore(options: {
  readonly ring?: EncryptionKeyring;
  readonly status?: SupplementaryIdvConfig["status"];
  readonly vendorKey?: SupplementaryIdvConfig["vendorKey"];
  readonly companyId?: string;
  readonly environment?: SupplementaryIdvConfig["environment"];
} = {}): { readonly store: InMemorySupplementaryIdvConfigStore; readonly config: SupplementaryIdvConfig } {
  const store = new InMemorySupplementaryIdvConfigStore();
  const sealed = sealSupplementaryIdvConfig(
    {
      companyId: options.companyId ?? COMPANY,
      vendorKey: options.vendorKey ?? "jumio",
      environment: options.environment ?? "live",
      credential: jumioCredentialTextOf(CREDENTIAL),
      webhookSecret: "callback_secret_for_the_gate_0001",
    },
    options.ring ?? keyring,
  );
  if ("reason" in sealed) throw new Error(`the fixture could not be sealed: ${sealed.reason}`);
  const config: SupplementaryIdvConfig = {
    id: "cfg_jumio_0001",
    companyId: options.companyId ?? COMPANY,
    vendorKey: options.vendorKey ?? "jumio",
    environment: options.environment ?? "live",
    status: options.status ?? "active",
    credentialSealed: sealed.credentialSealed,
    webhookSecretSealed: sealed.webhookSecretSealed,
    version: 1,
    createdAtEpochMs: NOW,
    updatedAtEpochMs: NOW,
  };
  // STEP 170's store refuses to insert a configuration that is already active, which is the rule a real table must
  // carry: a row is created waiting, and only an activation test moves it. The fixture therefore inserts it waiting and
  // moves it forward through the same guarded save.
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
      vendorKey: "jumio",
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
  transport: JumioTransport,
  configStore: InMemorySupplementaryIdvConfigStore,
  sessionStore: InMemorySupplementaryIdvSessionStore,
  extra: { readonly recordAudit?: (entry: SupplementaryIdvAuditEntry) => void; readonly recordConfigAudit?: (entry: JumioConfigAuditEntry) => void; readonly tokenCache?: InMemoryJumioTokenCache } = {},
): JumioOptions {
  return {
    configStore,
    sessionStore,
    keyring,
    tokenCache: extra.tokenCache ?? new InMemoryJumioTokenCache(),
    occurredAtEpochMs: NOW,
    transport,
    ...(extra.recordAudit === undefined ? {} : { recordAudit: extra.recordAudit }),
    ...(extra.recordConfigAudit === undefined ? {} : { recordConfigAudit: extra.recordConfigAudit }),
  };
}

interface GateSessionInput {
  readonly sessionId: string;
  readonly workflowKey: string;
  readonly successUrl: string;
  readonly errorUrl: string;
  readonly callbackUrl: string | null;
}

const SESSION_INPUT: GateSessionInput = {
  sessionId: "",
  workflowKey: "10549",
  successUrl: "https://app.kd.test/kyc/done",
  errorUrl: "https://app.kd.test/kyc/error",
  callbackUrl: "https://api.kd.test/api/kyc/idv/jumio/delivery",
};

/* ---- 1: the catalogue is the documentation's, and nothing else is reachable ---- */

function checkCatalogue(): void {
  expectEqual(JUMIO_REGIONS.length, 3, "three datacenters, as documented");
  expectEqual(JUMIO_SURFACES.length, 3, "three surfaces this adapter calls");
  expectEqual(JUMIO_DECISIONS.length, 4, "four decision types, as documented");
  expectEqual(JUMIO_IDENTITY_CAPABILITIES.length, 5, "five document capabilities");

  for (const region of JUMIO_REGIONS) {
    const auth = jumioHost("auth", region);
    const account = jumioHost("account", region);
    const retrieval = jumioHost("retrieval", region);
    expectEqual(auth, `https://auth.${region}.jumio.ai`, `the token host for ${region} is documented`);
    expectEqual(account, `https://account.${region}.jumio.ai`, `the account host for ${region} is documented`);
    expectEqual(retrieval, `https://retrieval.${region}.jumio.ai`, `the retrieval host for ${region} is documented`);
    expect(auth.startsWith("https://"), "no plaintext surface");
    expect(auth.includes("status.") === false, "the vendor's uptime status host is not used");
    expectEqual(jumioEndpoint("auth", region, JUMIO_TOKEN_PATH), `${auth}${JUMIO_TOKEN_PATH}`, "the token URL is built from the host");
  }

  expectEqual(jumioHost("auth", "amer-1"), "https://auth.amer-1.jumio.ai", "the American token host");
  expectEqual(jumioHost("retrieval", "emea-1"), "https://retrieval.emea-1.jumio.ai", "the European retrieval host");
  expectEqual(jumioHost("account", "apac-1"), "https://account.apac-1.jumio.ai", "the Singapore account host");

  expect(isJumioRegion("amer-1") === true, "amer-1 is a datacenter");
  expect(isJumioRegion(" emea-1 ") === true, "surrounding space does not make it another datacenter");
  expect(isJumioRegion("eu-1") === false, "eu-1 is not a datacenter");
  expect(isJumioRegion("us") === false, "us is not a datacenter");
  expect(isJumioRegion("") === false, "an empty string is not a datacenter");
  expect(isJumioRegion("amer-1.evil.test") === false, "a lookalike host is not a datacenter");

  expectEqual(jumioWorkflowExecutionPath(ACCOUNT_ID, EXECUTION_ID), `/api/v1/accounts/${ACCOUNT_ID}/workflow-executions/${EXECUTION_ID}`, "the retrieval path is documented");

  expectEqual(JUMIO_ALLOWED_CALLS.length, 3, "three documented calls and no more");
  expect(isJumioCall("auth", "POST", "/oauth2/token") === true, "the token call is allowed");
  expect(isJumioCall("account", "POST", "/api/v1/accounts") === true, "the account call is allowed");
  expect(isJumioCall("retrieval", "GET", jumioWorkflowExecutionPath(ACCOUNT_ID, EXECUTION_ID)) === true, "the retrieval call is allowed");
  expect(isJumioCall("auth", "GET", "/oauth2/token") === false, "the token is never read");
  expect(isJumioCall("account", "PUT", "/api/v1/accounts") === false, "an account is never updated here");
  expect(isJumioCall("account", "POST", "/api/v1/accounts/x/workflow-executions") === false, "a credential is never uploaded here");
  expect(isJumioCall("retrieval", "DELETE", jumioWorkflowExecutionPath(ACCOUNT_ID, EXECUTION_ID)) === false, "a wipe is not this adapter's business");
  expect(isJumioCall("retrieval", "GET", "/api/v1/accounts/not-a-uuid/workflow-executions/x") === false, "only UUID paths are reachable");
  expect(isJumioCall("retrieval", "GET", `/api/v1/accounts/${ACCOUNT_ID}/workflow-executions/${EXECUTION_ID}/generate`) === false, "the PDF is never fetched");
  expect(isJumioCall("retrieval", "GET", `/api/v1/accounts/${ACCOUNT_ID}/workflow-executions/${EXECUTION_ID}/status`) === false, "only the transaction record is read");
  expect(isJumioCall("retrieval", "GET", `/api/v1/accounts/${ACCOUNT_ID}/../${EXECUTION_ID}`) === false, "traversal is not reachable");
  expect(isJumioCall("status", "GET", "/") === false, "the uptime status host is not reachable");
  expect(isJumioCall("auth", "POST", "/oauth2/token/../accounts") === false, "a rewritten path is not reachable");

  expect(isJumioId(ACCOUNT_ID) === true, "a UUID is an id");
  expect(isJumioId("497F6ECA-6276-4993-BFEB-53CBBBBBA6F08") === false, "an upper-case UUID is not the shape Jumio answers");
  expect(isJumioId("account-1") === false, "a made-up id is not an id");
  expect(isJumioId("") === false, "an empty string is not an id");

  for (const decision of JUMIO_DECISIONS) expect(isJumioDecision(decision) === true, `${decision} is documented`);
  expect(isJumioDecision("passed") === true, "a lower-case decision is read");
  expect(isJumioDecision("APPROVED") === false, "approved is not a Jumio decision");
  expect(isJumioDecision("VERIFIED") === false, "verified is not a decision of the vendor either");
  expect(isJumioDecision("") === false, "an empty decision is not a decision");

  expectEqual(JUMIO_COMPLETED_WORKFLOW_STATUS, "PROCESSED", "the one status the documentation shows carrying decisions");
  expectEqual(JUMIO_EXPIRED_JOURNEY_STATE, "expired", "the documented drop-off state");
  expectEqual(Object.keys(JUMIO_DOCUMENT_TYPES).length, 5, "five documented document types");
  expectEqual(JUMIO_DOCUMENT_TYPES["PASSPORT"], "passport", "a passport stays a passport");
  expectEqual(JUMIO_DOCUMENT_TYPES["ID_CARD"], "national_id", "an identity card is the neutral national id");
  expectEqual(JUMIO_DOCUMENT_TYPES["DRIVING_LICENSE"], "driving_licence", "a driving licence stays one");
  expectEqual(JUMIO_DOCUMENT_TYPES["VISA"], "not_stated", "a visa is not stretched into a residence permit");
  expectEqual(JUMIO_DOCUMENT_TYPES["UNSUPPORTED"], "not_stated", "an unsupported document states nothing");
  for (const kind of Object.values(JUMIO_DOCUMENT_TYPES)) {
    expect((SUPPLEMENTARY_IDV_DOCUMENT_KINDS as readonly string[]).includes(kind), `the neutral kind ${kind} exists`);
  }

  expectEqual(JUMIO_VENDOR_KEY, "jumio", "the vendor key is STEP 170's own word");
  expect((SUPPLEMENTARY_IDV_VENDOR_KEYS as readonly string[]).includes(JUMIO_VENDOR_KEY), "the vendor is in the catalogue");
  expect(JUMIO_MAXIMUM_ANSWER_BYTES >= 65_536, "the answer bound leaves room for a real transaction record");
  expectEqual(JUMIO_CUSTOMER_REFERENCE_MAXIMUM_LENGTH, 100, "the documented reference bound");
}

/* ---- 2: the credential, in and out of the sealed envelope ---- */

function checkCredential(): void {
  expectEqual(validateJumioCredential(CREDENTIAL), null, "a documented credential is usable");
  const rejects: readonly { readonly credential: JumioCredential; readonly name: string }[] = [
    { credential: { ...CREDENTIAL, region: "eu-1" as JumioCredential["region"] }, name: "an undocumented datacenter is refused" },
    { credential: { ...CREDENTIAL, clientId: "" }, name: "an empty client id is refused" },
    { credential: { ...CREDENTIAL, clientSecret: "" }, name: "an empty client secret is refused" },
    { credential: { ...CREDENTIAL, clientId: "short" }, name: "a short client id is refused" },
    { credential: { ...CREDENTIAL, clientSecret: "short" }, name: "a short client secret is refused" },
    { credential: { ...CREDENTIAL, clientId: "client id with space" }, name: "a space in the id is refused" },
    { credential: { ...CREDENTIAL, clientSecret: "client:secret" }, name: "a colon in the secret is refused" },
    { credential: { ...CREDENTIAL, clientId: "x".repeat(201) }, name: "an over-long id is refused" },
  ];
  for (const entry of rejects) {
    const reason = validateJumioCredential(entry.credential);
    expect(reason !== null && reason.length > 0, entry.name);
  }

  const text = jumioCredentialTextOf(CREDENTIAL);
  expect(text.includes(CREDENTIAL.clientSecret), "the serialized credential is the plaintext, which is why it is only ever sealed");
  const read = jumioCredentialOf(text);
  expect(read !== null, "a serialized credential reads back");
  expectEqual(read?.clientId, CREDENTIAL.clientId, "the id survives the round trip");
  expectEqual(read?.clientSecret, CREDENTIAL.clientSecret, "the secret survives the round trip");
  expectEqual(read?.region, CREDENTIAL.region, "the datacenter survives the round trip");

  expectEqual(jumioCredentialOf(""), null, "an empty field is not a credential");
  expectEqual(jumioCredentialOf("{"), null, "a broken field is not a credential");
  expectEqual(jumioCredentialOf("[]"), null, "an array is not a credential");
  expectEqual(jumioCredentialOf(JSON.stringify({ region: "amer-1" })), null, "a field without a secret is not a credential");
  expectEqual(jumioCredentialOf(JSON.stringify({ region: "eu-1", clientId: CREDENTIAL.clientId, clientSecret: CREDENTIAL.clientSecret })), null, "a credential on an undocumented host does not read");
  expectEqual(jumioCredentialOf(JSON.stringify({ region: "amer-1", clientId: 1, clientSecret: 2 })), null, "numbers are not a credential");
  expectEqual(jumioCredentialOf("x".repeat(2_001)), null, "an over-long field is not a credential");

  const basic = jumioBasicAuthOf(CREDENTIAL);
  expectEqual(Buffer.from(basic, "base64").toString("utf8"), `${CREDENTIAL.clientId}:${CREDENTIAL.clientSecret}`, "basic authentication carries id and secret");
  expect(basic.includes(CREDENTIAL.clientSecret) === false, "the base64 header does not carry the secret literally");
}

/* ---- 3: the encrypted configuration, and its activation test ---- */

async function checkConfiguration(): Promise<void> {
  const recorded: JumioConfigAuditEntry[] = [];
  const failing = createJumioConfiguration(
    { companyId: "", environment: "live", credential: CREDENTIAL, callbackSecret: null, occurredAtEpochMs: NOW },
    { configStore: new InMemorySupplementaryIdvConfigStore(), keyring, recordAudit: (entry) => recorded.push(entry) },
  );
  expectEqual(failing.status, "failed", "a configuration belongs to a company");

  const badRegion = createJumioConfiguration(
    { companyId: COMPANY, environment: "live", credential: { ...CREDENTIAL, region: "eu-1" as JumioCredential["region"] }, callbackSecret: null, occurredAtEpochMs: NOW },
    { configStore: new InMemorySupplementaryIdvConfigStore(), keyring },
  );
  expectEqual(badRegion.status, "failed", "an undocumented datacenter is refused before sealing");

  const store = new InMemorySupplementaryIdvConfigStore();
  const created = createJumioConfiguration(
    { companyId: COMPANY, environment: "live", credential: CREDENTIAL, callbackSecret: "callback_secret_for_the_gate_0001", occurredAtEpochMs: NOW },
    { configStore: store, keyring, recordAudit: (entry) => recorded.push(entry) },
  );
  expectEqual(created.status, "configured", "a valid configuration is sealed and stored");
  if (created.status !== "configured") return;
  const config = created.config;
  expectEqual(config.status, "pending_activation", "a configuration is not active by being typed in");
  expectEqual(config.vendorKey, "jumio", "the configuration names the vendor");
  expectEqual(config.version, 1, "a new configuration starts at version 1");
  expect(isSecretEnvelope(config.credentialSealed) === true, "the credential is a sealed envelope");
  expect(config.webhookSecretSealed !== null, "the callback secret is kept when the tenant has one");
  expect(isSecretEnvelope(config.webhookSecretSealed ?? "") === true, "the callback secret is sealed too");
  expect(config.credentialSealed.includes(CREDENTIAL.clientSecret) === false, "the stored row does not carry the secret");
  expect(config.credentialSealed.includes(CREDENTIAL.clientId) === false, "the stored row does not carry the client id");
  expect(config.credentialSealed !== (config.webhookSecretSealed ?? ""), "two purposes never share one envelope");
  expectEqual(store.findById(config.id)?.id, config.id, "the configuration is stored");
  expectEqual(recorded.length, 1, "one audit entry for the configuration");
  expectEqual(recorded[0]?.action, "jumio_idv.configured", "the configuration is recorded as configured");
  expect(asText(recorded[0]).includes(CREDENTIAL.clientSecret) === false, "the entry carries no secret");
  expect(asText(recorded[0]).includes(CREDENTIAL.clientId) === false, "the entry carries no client id");

  // The activation test: only a real token makes a configuration active.
  const transport = new ScriptedTransport([tokenAnswer()]);
  const activationAudit: JumioConfigAuditEntry[] = [];
  const activated = await activateJumioConfiguration(config.id, {
    configStore: store,
    keyring,
    occurredAtEpochMs: NOW,
    transport: transport.call,
    recordAudit: (entry) => activationAudit.push(entry),
  });
  expectEqual(activated.status, "activated", "a working credential activates the configuration");
  expectEqual(transport.calls.length, 1, "activation makes one call");
  expectEqual(transport.calls[0]?.surface, "auth", "activation asks for a token");
  expectEqual(transport.calls[0]?.method, "POST", "activation posts for a token");
  expectEqual(transport.calls[0]?.region, "amer-1", "activation calls the configured datacenter");
  expectEqual(transport.calls[0]?.body, "grant_type=client_credentials", "activation asks for a client-credentials token");
  expectEqual(transport.calls[0]?.authorization, "basic", "the token call authenticates with the client id and secret");
  const after = store.findById(config.id);
  expectEqual(after?.status, "active", "the row is active after the test");
  expectEqual(after?.version, 2, "activation moves the version forward");
  expectEqual(activationAudit.map((entry) => entry.action).join(","), "jumio_idv.activation_tested,jumio_idv.activated", "both activation steps are audited");
  for (const entry of activationAudit) expect(asText(entry).includes(CREDENTIAL.clientSecret) === false, "no activation entry carries a secret");

  // A refused credential leaves the row waiting, which is what an operator must see.
  const refusedStore = new InMemorySupplementaryIdvConfigStore();
  const refusedConfig = createJumioConfiguration(
    { companyId: COMPANY, environment: "live", credential: CREDENTIAL, callbackSecret: null, occurredAtEpochMs: NOW },
    { configStore: refusedStore, keyring },
  );
  if (refusedConfig.status !== "configured") return;
  const refusedTransport = new ScriptedTransport([{ status: 401, body: JSON.stringify({ title: "Unauthorized", status: 401, detail: "the provided credentials are invalid" }), headers: {} }]);
  const refused = await activateJumioConfiguration(refusedConfig.config.id, {
    configStore: refusedStore,
    keyring,
    occurredAtEpochMs: NOW,
    transport: refusedTransport.call,
  });
  expectEqual(refused.status, "refused", "a refused credential does not activate");
  expectEqual(refusedStore.findById(refusedConfig.config.id)?.status, "pending_activation", "the row keeps waiting");

  // The mode rule: a second active vendor in the same company and mode is refused. The second configuration is a real
  // Jumio one — a replacement credential, a migration between tenants — because that is the case the guard exists for.
  const twoVendorStore = new InMemorySupplementaryIdvConfigStore();
  const first = createJumioConfiguration(
    { companyId: COMPANY, environment: "live", credential: CREDENTIAL, callbackSecret: null, occurredAtEpochMs: NOW },
    { configStore: twoVendorStore, keyring },
  );
  if (first.status !== "configured") return;
  const firstActivation = await activateJumioConfiguration(first.config.id, {
    configStore: twoVendorStore,
    keyring,
    occurredAtEpochMs: NOW,
    transport: new ScriptedTransport([tokenAnswer()]).call,
  });
  expectEqual(firstActivation.status, "activated", "the first Jumio configuration becomes the active one");

  const replacement = createJumioConfiguration(
    {
      companyId: COMPANY,
      environment: "live",
      credential: { ...CREDENTIAL, clientId: "client_id_for_the_replacement_0002", clientSecret: "client_secret_for_the_replacement_0002" },
      callbackSecret: null,
      occurredAtEpochMs: NOW,
    },
    { configStore: twoVendorStore, keyring },
  );
  if (replacement.status !== "configured") return;
  const secondTransport = new ScriptedTransport([tokenAnswer()]);
  const secondActivation = await activateJumioConfiguration(replacement.config.id, {
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

  // Another company may activate a vendor of its own, because the rule is per company and mode.
  const otherCompany = createJumioConfiguration(
    { companyId: "company_kd_jumio_other", environment: "live", credential: CREDENTIAL, callbackSecret: null, occurredAtEpochMs: NOW },
    { configStore: twoVendorStore, keyring },
  );
  if (otherCompany.status === "configured") {
    const otherActivation = await activateJumioConfiguration(otherCompany.config.id, {
      configStore: twoVendorStore,
      keyring,
      occurredAtEpochMs: NOW,
      transport: new ScriptedTransport([tokenAnswer()]).call,
    });
    expectEqual(otherActivation.status, "activated", "another company activates its own vendor");
  }
  const testMode = createJumioConfiguration(
    { companyId: COMPANY, environment: "sandbox", credential: CREDENTIAL, callbackSecret: null, occurredAtEpochMs: NOW },
    { configStore: twoVendorStore, keyring },
  );
  if (testMode.status === "configured") {
    const testActivation = await activateJumioConfiguration(testMode.config.id, {
      configStore: twoVendorStore,
      keyring,
      occurredAtEpochMs: NOW,
      transport: new ScriptedTransport([tokenAnswer()]).call,
    });
    expectEqual(testActivation.status, "activated", "the test mode has its own active vendor");
  }
}

/* ---- 4: the bodies the documentation shows ---- */

function checkTokenAnswer(): void {
  const parsed = parseJumioTokenAnswer(200, TOKEN_BODY);
  expectEqual(parsed.outcome, "token", "the documented token answer is a token");
  if (parsed.outcome === "token") {
    expectEqual(parsed.token.accessToken, ACCESS_TOKEN, "the token is read");
    expectEqual(parsed.token.expiresInSeconds, 3600, "the documented lifetime is read");
  }
  expectEqual(parseJumioTokenAnswer(200, JSON.stringify({ access_token: ACCESS_TOKEN, expires_in: 3600, token_type: "mac" })).outcome, "failed", "a non-bearer token is refused");
  expectEqual(parseJumioTokenAnswer(200, JSON.stringify({ access_token: "short", expires_in: 3600, token_type: "Bearer" })).outcome, "failed", "a token that cannot be one is refused");
  expectEqual(parseJumioTokenAnswer(200, JSON.stringify({ access_token: ACCESS_TOKEN, token_type: "Bearer" })).outcome, "failed", "a token with no lifetime is refused");
  expectEqual(parseJumioTokenAnswer(200, JSON.stringify({ access_token: ACCESS_TOKEN, expires_in: 0, token_type: "Bearer" })).outcome, "failed", "a token that expires now is refused");
  expectEqual(parseJumioTokenAnswer(200, "not json").outcome, "failed", "a token answer that is not JSON is refused");
  expectEqual(parseJumioTokenAnswer(401, "").outcome, "refused", "a bad credential is a refusal");
  expectEqual(parseJumioTokenAnswer(403, "").outcome, "refused", "a forbidden credential is a refusal");
  expectEqual(parseJumioTokenAnswer(400, "").outcome, "refused", "a malformed token request is a refusal");
  expectEqual(parseJumioTokenAnswer(500, "").outcome, "failed", "a server error is not a refusal");
  expectEqual(parseJumioTokenAnswer(429, "").outcome, "failed", "a rate limit is not a refusal");
  expectEqual(parseJumioTokenAnswer(302, "").outcome, "failed", "a redirect proves nothing");

  const documented = parseJumioAccountAnswer(201, accountBody());
  expectEqual(documented.outcome, "created", "the documented account answer creates a session");
  if (documented.outcome === "created") {
    expectEqual(documented.answer.accountId, ACCOUNT_ID, "the account id is read");
    expectEqual(documented.answer.workflowExecutionId, EXECUTION_ID, "the workflow execution id is read");
    expectEqual(documented.answer.redirectUrl, REDIRECT, "the web client URL is read");
    expectEqual(documented.answer.sdkTokenIssued, true, "the SDK token is noticed but never used");
  }

  const rejections: readonly { readonly status: number; readonly outcome: string; readonly name: string }[] = [
    { status: 400, outcome: "rejected", name: "a malformed request is a rejection" },
    { status: 422, outcome: "rejected", name: "an unprocessable request is a rejection" },
    { status: 401, outcome: "failed", name: "a bad token is a failure" },
    { status: 403, outcome: "failed", name: "a forbidden call is a failure" },
    { status: 404, outcome: "failed", name: "a wrong path is a failure" },
    { status: 409, outcome: "duplicate", name: "a duplicate needs reconciliation" },
    { status: 302, outcome: "unknown", name: "a redirect is unknown" },
    { status: 429, outcome: "unknown", name: "a rate limit is unknown" },
    { status: 500, outcome: "unknown", name: "a server error is unknown" },
    { status: 503, outcome: "unknown", name: "an unavailable vendor is unknown" },
  ];
  for (const entry of rejections) {
    expectEqual(parseJumioAccountAnswer(entry.status, "").outcome, entry.outcome, entry.name);
  }

  const badAnswers: readonly { readonly body: string; readonly name: string }[] = [
    { body: "not json", name: "an answer that is not JSON is unknown" },
    { body: JSON.stringify({ account: { id: ACCOUNT_ID } }), name: "an answer without a workflow is unknown" },
    { body: JSON.stringify({ web: { href: REDIRECT }, workflowExecution: { id: EXECUTION_ID } }), name: "an answer without an account is unknown" },
    { body: accountBody({ account: { id: "account-1" } }), name: "an account id that is not a UUID is unknown" },
    { body: accountBody({ workflowExecution: { id: "x" } }), name: "a workflow id that is not a UUID is unknown" },
    { body: accountBody({ web: { href: "http://web.amer-1.jumio.ai/app" } }), name: "a plaintext client URL is unknown" },
    { body: accountBody({ web: { href: "https://evil.test/app?authorizationToken=x" } }), name: "a client URL on another host is unknown" },
  ];
  for (const entry of badAnswers) {
    expectEqual(parseJumioAccountAnswer(201, entry.body).outcome, "unknown", entry.name);
  }
  expectEqual(parseJumioAccountAnswer(400, JSON.stringify({ detail: "customerInternalReference is invalid" })).outcome, "rejected", "the vendor's own problem detail is a rejection");
  const detail = parseJumioAccountAnswer(400, JSON.stringify({ detail: "y".repeat(400) }));
  expect(detail.outcome === "rejected" && detail.detail.length <= 200, "the vendor's detail is bounded");
}

/* ---- 5: the request this platform builds ---- */

function checkRequest(): void {
  const reference = jumioCustomerReferenceOf("9f9dd1c1-1111-4222-8333-444455556666");
  expectEqual(reference, "kd-idv-9f9dd1c1-1111-4222-8333-444455556666", "the customer reference is the session id, prefixed");
  expect(reference.length <= JUMIO_CUSTOMER_REFERENCE_MAXIMUM_LENGTH, "the reference fits the documented bound");
  expect(validateJumioCustomerReference(reference) === null, "the derived reference is one Jumio accepts");
  expect(validateJumioCustomerReference("a;b") !== null, "a semicolon is refused");
  expect(validateJumioCustomerReference("a<b") !== null, "an angle bracket is refused");
  expect(validateJumioCustomerReference("a`b") !== null, "a backtick is refused");
  expect(validateJumioCustomerReference("a%b") !== null, "a percent sign is refused");
  expect(validateJumioCustomerReference("a|b") !== null, "a pipe is refused");
  expect(validateJumioCustomerReference('a"b') !== null, "a quote is refused");
  expect(validateJumioCustomerReference("a{b}") !== null, "a brace is refused");
  expect(validateJumioCustomerReference("x".repeat(101)) !== null, "an over-long reference is refused");
  expect(validateJumioCustomerReference("") !== null, "an empty reference is refused");
  expect(JUMIO_CUSTOMER_REFERENCE_FORBIDDEN.test("plain-reference-0001") === false, "an ordinary reference carries nothing refused");
  expect(jumioCustomerReferenceOf("s".repeat(400)).length <= JUMIO_CUSTOMER_REFERENCE_MAXIMUM_LENGTH, "a long session id is cut to the bound");

  const ids = jumioIdsOf(jumioReferenceOf(ACCOUNT_ID, EXECUTION_ID));
  expectEqual(ids?.accountId, ACCOUNT_ID, "the stored reference carries the account id");
  expectEqual(ids?.workflowExecutionId, EXECUTION_ID, "the stored reference carries the workflow id");
  expectEqual(jumioReferenceOf(` ${ACCOUNT_ID} `, `${EXECUTION_ID} `), jumioReferenceOf(ACCOUNT_ID, EXECUTION_ID), "surrounding space does not make another reference");
  expectEqual(jumioIdsOf("account-1:workflow-1"), null, "a reference that is not two UUIDs is refused");
  expectEqual(jumioIdsOf(`${ACCOUNT_ID}`), null, "one id is not a reference");
  expectEqual(jumioIdsOf(`${ACCOUNT_ID}:${EXECUTION_ID}:extra`), null, "three parts are not a reference");
  expectEqual(jumioIdsOf(""), null, "an empty reference is refused");

  const request = buildJumioAccountRequest({
    customerInternalReference: reference,
    workflowKey: "10549",
    successUrl: SESSION_INPUT.successUrl,
    errorUrl: SESSION_INPUT.errorUrl,
    callbackUrl: SESSION_INPUT.callbackUrl,
  });
  const body = asText(request);
  expectEqual(Object.keys(request).sort().join(","), "callbackUrl,customerInternalReference,web,workflowDefinition", "the request carries four fields and no more");
  expectEqual(request.workflowDefinition.key, "10549", "the workflow key is the office's");
  expect(body.includes("firstName") === false && body.includes("lastName") === false, "no name is sent");
  expect(body.includes("dateOfBirth") === false, "no date of birth is sent");
  expect(body.includes("idNumber") === false, "no document number is sent");
  expect(body.includes("parts") === false, "no document part is uploaded");
  expect(body.includes("Bearer") === false && body.includes(ACCESS_TOKEN) === false, "no token leaks into the body");

  const invalid: readonly { readonly input: GateSessionInput; readonly name: string }[] = [
    { input: { ...SESSION_INPUT, workflowKey: "" }, name: "an empty workflow key is refused" },
    { input: { ...SESSION_INPUT, workflowKey: "the-passport-workflow" }, name: "a workflow key that is not a key is refused" },
    { input: { ...SESSION_INPUT, workflowKey: "9".repeat(300) }, name: "an over-long workflow key is refused" },
    { input: { ...SESSION_INPUT, successUrl: "http://app.kd.test/done" }, name: "a plaintext success URL is refused" },
    { input: { ...SESSION_INPUT, errorUrl: "not a url" }, name: "an error URL that is not a URL is refused" },
    { input: { ...SESSION_INPUT, callbackUrl: "http://api.kd.test/delivery" }, name: "a plaintext callback URL is refused" },
    { input: { ...SESSION_INPUT, callbackUrl: "https://api.kd.test/" + "x".repeat(300) }, name: "an over-long callback URL is refused" },
  ];
  for (const entry of invalid) {
    const reason = validateJumioSessionInput(entry.input);
    expect(reason !== null && reason.length > 0, entry.name);
  }
  expectEqual(validateJumioSessionInput(SESSION_INPUT), null, "the documented request shape is accepted");
  expectEqual(validateJumioSessionInput({ ...SESSION_INPUT, callbackUrl: null }), null, "a tenant without a delivery endpoint is accepted");
}

/* ---- 6: opening a session, and the calls it makes ---- */

async function checkOpen(): Promise<void> {
  const happy = configuredStore();
  const session = openedSession(happy.config);
  const transport = new ScriptedTransport([tokenAnswer(), ok(accountBody(), 201)]);
  const cache = new InMemoryJumioTokenCache();
  const audit: SupplementaryIdvAuditEntry[] = [];
  const result = await openJumioSession(
    { ...SESSION_INPUT, sessionId: session.session.id },
    optionsWith(transport.call, happy.store, session.store, { tokenCache: cache, recordAudit: (entry) => audit.push(entry) }),
  );
  expectEqual(result.status, "opened", "a documented answer opens the session");
  if (result.status === "opened") {
    expectEqual(result.opened.accountId, ACCOUNT_ID, "the account id is kept");
    expectEqual(result.opened.workflowExecutionId, EXECUTION_ID, "the workflow id is kept");
    expectEqual(result.opened.reference, jumioReferenceOf(ACCOUNT_ID, EXECUTION_ID), "the two ids become one reference");
    expectEqual(result.opened.redirectUrl, REDIRECT, "the web client URL is handed back once");
    expectEqual(result.opened.session.result, "in_progress", "a new session is in progress");
    expectEqual(result.opened.session.liveness, "in_progress", "liveness is not yet known");
    expectEqual(result.opened.session.reference, jumioReferenceOf(ACCOUNT_ID, EXECUTION_ID), "the reference is stored");
    expectEqual(result.opened.session.documentKind, "not_stated", "no document kind is claimed before a document is read");
    expectEqual(result.opened.session.requiresHumanReview, false, "a session in progress does not ask a person yet");
  }

  expectEqual(transport.calls.length, 2, "opening makes two calls: a token and an account");
  expectEqual(transport.calls[0]?.surface, "auth", "the first call is the token");
  expectEqual(transport.calls[0]?.path, JUMIO_TOKEN_PATH, "the token call is the documented path");
  expectEqual(transport.calls[1]?.surface, "account", "the second call is the account");
  expectEqual(transport.calls[1]?.path, "/api/v1/accounts", "the account call is the documented path");
  expectEqual(transport.calls[1]?.method, "POST", "an account is created with a POST");
  expectEqual(transport.calls[1]?.authorization, "bearer", "the account call carries a bearer token");
  expectEqual(transport.calls[1]?.authValue, ACCESS_TOKEN, "the account call carries the token Jumio issued");
  expectEqual(transport.calls[1]?.contentType, "application/json", "the account call is JSON");
  expectEqual(transport.calls[1]?.region, "amer-1", "the account call goes to the configured datacenter");

  const sent = JSON.parse(transport.calls[1]?.body ?? "{}") as Record<string, unknown>;
  expectEqual(Object.keys(sent).sort().join(","), "callbackUrl,customerInternalReference,web,workflowDefinition", "the body carries four fields and no more");
  expect(String(sent["customerInternalReference"]).startsWith("kd-idv-"), "the reference this platform derived is sent");
  expect(String(sent["customerInternalReference"]).includes(session.session.id), "the reference names the session and nothing personal");
  expectEqual((sent["workflowDefinition"] as Record<string, unknown>)["key"], "10549", "the workflow key the office chose is sent");
  expectEqual((sent["web"] as Record<string, unknown>)["successUrl"], SESSION_INPUT.successUrl, "the success URL is sent");
  expectEqual((sent["web"] as Record<string, unknown>)["errorUrl"], SESSION_INPUT.errorUrl, "the error URL is sent");
  expectEqual(sent["callbackUrl"], SESSION_INPUT.callbackUrl, "the delivery endpoint is sent when the tenant uses one");
  for (const forbidden of ["firstName", "lastName", "dateOfBirth", "idNumber", "parts", "userConsent"]) {
    expect(JSON.stringify(sent).includes(forbidden) === false, `the body carries no ${forbidden}`);
  }

  // The redirect URL carries an authorization token: it must be answered once and never stored.
  const storedRow = asText(session.store.findById(session.session.id));
  expect(storedRow.includes("authorizationToken") === false, "the stored row carries no authorization token");
  expect(storedRow.includes(REDIRECT) === false, "the stored row carries no redirect URL");
  expect(storedRow.includes("client_secret") === false, "the stored row carries no credential");
  expectEqual(session.store.findById(session.session.id)?.reference, jumioReferenceOf(ACCOUNT_ID, EXECUTION_ID), "the stored row carries only the reference");

  // The token is reused, which is what the documentation asks for.
  expect(cache.get(happy.config.id) !== null, "the token is cached");
  const secondSession = openedSession(happy.config);
  const reuse = new ScriptedTransport([ok(accountBody(), 201)]);
  const second = await openJumioSession(
    { ...SESSION_INPUT, sessionId: secondSession.session.id },
    optionsWith(reuse.call, happy.store, secondSession.store, { tokenCache: cache }),
  );
  expectEqual(second.status, "opened", "a second session opens on the cached token");
  expectEqual(reuse.calls.length, 1, "the second open asks Jumio for nothing but an account");
  expectEqual(reuse.calls[0]?.surface, "account", "the reused token needs no second token call");
  expectEqual(cache.get(happy.config.id)?.accessToken, ACCESS_TOKEN, "the cached token is the one Jumio issued");

  // Every refusal the row can produce.
  const inactive = configuredStore({ status: "pending_activation" });
  const inactiveSession = openedSession(inactive.config);
  const inactiveResult = await openJumioSession(
    { ...SESSION_INPUT, sessionId: inactiveSession.session.id },
    optionsWith(new ScriptedTransport([]).call, inactive.store, inactiveSession.store),
  );
  expectEqual(inactiveResult.status, "failed", "a configuration that is not active cannot open a session");
  expect(inactiveResult.status === "failed" && inactiveResult.reason.includes("not active"), "the failure names the activation");

  const wrongVendor = configuredStore({ vendorKey: "didit" });
  const wrongVendorSession = openedSession(wrongVendor.config);
  const wrongVendorResult = await openJumioSession(
    { ...SESSION_INPUT, sessionId: wrongVendorSession.session.id },
    optionsWith(new ScriptedTransport([]).call, wrongVendor.store, wrongVendorSession.store),
  );
  expectEqual(wrongVendorResult.status, "failed", "another vendor's configuration cannot open a Jumio session");

  const otherRing = configuredStore({ ring: otherKeyring });
  const otherRingSession = openedSession(otherRing.config);
  const otherRingTransport = new ScriptedTransport([]);
  const otherRingResult = await openJumioSession(
    { ...SESSION_INPUT, sessionId: otherRingSession.session.id },
    optionsWith(otherRingTransport.call, otherRing.store, otherRingSession.store),
  );
  expectEqual(otherRingResult.status, "failed", "a configuration sealed under another keyring cannot be opened");
  expectEqual(otherRingTransport.calls.length, 0, "no call is made with a credential that cannot be opened");

  const missingSession = await openJumioSession(
    { ...SESSION_INPUT, sessionId: "no-such-session" },
    optionsWith(new ScriptedTransport([]).call, happy.store, session.store),
  );
  expectEqual(missingSession.status, "failed", "an unknown session cannot open a vendor session");

  const badInput = await openJumioSession(
    { ...SESSION_INPUT, sessionId: session.session.id, workflowKey: "" },
    optionsWith(new ScriptedTransport([]).call, happy.store, session.store),
  );
  expectEqual(badInput.status, "failed", "an unusable request is refused before any call");

  // A refused token is a configuration defect, not a merchant failure.
  const refusedTokenStore = configuredStore();
  const refusedTokenSession = openedSession(refusedTokenStore.config);
  const refusedTokenTransport = new ScriptedTransport([
    { status: 401, body: JSON.stringify({ title: "Unauthorized", detail: "the provided credentials are invalid" }), headers: {} },
  ]);
  const refusedToken = await openJumioSession(
    { ...SESSION_INPUT, sessionId: refusedTokenSession.session.id },
    optionsWith(refusedTokenTransport.call, refusedTokenStore.store, refusedTokenSession.store),
  );
  expectEqual(refusedToken.status, "failed", "a refused token does not open a session");
  expectEqual(refusedTokenTransport.calls.length, 1, "a refused token stops before the account call");
  expect(refusedToken.status === "failed" && refusedToken.reason.includes("credentials"), "the failure names the credentials");
  expectEqual(refusedTokenSession.store.findById(refusedTokenSession.session.id)?.reference, null, "a refused session keeps no reference");

  // A rejection by Jumio means nothing exists; an unclear answer means someone must look.
  const rejectedStore = configuredStore();
  const rejectedSession = openedSession(rejectedStore.config);
  const rejected = await openJumioSession(
    { ...SESSION_INPUT, sessionId: rejectedSession.session.id },
    optionsWith(new ScriptedTransport([tokenAnswer(), ok(JSON.stringify({ detail: "workflowDefinition.key is unknown" }), 400)]).call, rejectedStore.store, rejectedSession.store),
  );
  expectEqual(rejected.status, "rejected", "a 400 is a rejection and nothing exists");

  for (const status of [500, 429, 302]) {
    const store = configuredStore();
    const sessionRow = openedSession(store.config);
    const unclear = await openJumioSession(
      { ...SESSION_INPUT, sessionId: sessionRow.session.id },
      optionsWith(new ScriptedTransport([tokenAnswer(), { status, body: "", headers: {} }]).call, store.store, sessionRow.store),
    );
    expectEqual(unclear.status, "failed", `a ${status} answer opens nothing`);
    expect(unclear.status === "failed" && unclear.requiresReconciliation === true, `a ${status} answer needs reconciliation`);
    expectEqual(sessionRow.store.findById(sessionRow.session.id)?.result, "in_progress", `a ${status} answer is not recorded as a pass or a failure`);
  }

  const throwingStore = configuredStore();
  const throwingSession = openedSession(throwingStore.config);
  let call = 0;
  const throwing = await openJumioSession(
    { ...SESSION_INPUT, sessionId: throwingSession.session.id },
    optionsWith(async (request) => {
      call += 1;
      if (call === 1) return tokenAnswer();
      throw new Error(`the network is gone on ${request.surface}`);
    }, throwingStore.store, throwingSession.store),
  );
  expectEqual(throwing.status, "failed", "a call that cannot be made opens nothing");
  expect(throwing.status === "failed" && throwing.requiresReconciliation === true, "a call that cannot be made needs reconciliation");

  // Opening twice on the same row is refused, so one row cannot hold two vendor sessions.
  const twiceTransport = new ScriptedTransport([]);
  const twice = await openJumioSession(
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
  const closedResult = await openJumioSession(
    { ...SESSION_INPUT, sessionId: closed.session.id },
    optionsWith(new ScriptedTransport([]).call, closedStore.store, closed.store),
  );
  expectEqual(closedResult.status, "failed", "a finished session is not opened again");

  // The audit trail names the action, the company and the clock, and carries no credential.
  expect(audit.length >= 1, "the opening is audited");
  for (const entry of audit) {
    expectEqual(entry.companyId, COMPANY, "every entry names the company");
    expectEqual(entry.occurredAtEpochMs, NOW, "every entry carries the caller's clock");
    expect(asText(entry).includes(CREDENTIAL.clientSecret) === false, "no entry carries the secret");
    expect(asText(entry).includes(ACCESS_TOKEN) === false, "no entry carries the access token");
    expect(asText(entry).includes("authorizationToken") === false, "no entry carries the redirect URL");
  }
}

/* ---- 7: reading a transaction record, and the words it becomes ---- */

function checkWorkflowReading(): void {
  const passing = detailsBody(PASSING_CAPABILITIES, { documentType: "PASSPORT" });
  const workflow = parseJumioWorkflow(passing);
  expect(workflow !== null, "a documented transaction record is read");
  if (workflow !== null) {
    expectEqual(workflow.workflowStatus, "PROCESSED", "the workflow status is read");
    expectEqual(workflow.documentType, "PASSPORT", "the document type is read");
    expectEqual(workflow.journeyExpired, false, "a finished journey is not expired");
    expectEqual(workflow.decisions.length, 7, "every capability decision is read");
    const capabilities = workflow.decisions.map((entry) => entry.capability).sort();
    expectEqual(capabilities.join(","), "classification,dataChecks,extraction,imageChecks,liveness,similarity,usability", "the documented capability names are kept");
  }

  const answer = jumioAnswerOf(workflow as NonNullable<typeof workflow>);
  expectEqual(answer.result, "passed", "a clean record passes");
  expectEqual(answer.liveness, "passed", "liveness passed");
  expectEqual(answer.documentKind, "passport", "a passport is a passport");
  expectEqual(answer.reasonCode, "not_stated", "a pass carries no reason");
  expect(SUPPLEMENTARY_IDV_RESULTS.includes(answer.result), "the result is a supplementary word");
  expect(isProcessorKybStatus(answer.result) === false, "the result is not a processor status");
  expectEqual(isSupplementaryIdvResult(answer.result), true, "the result is one of the five");

  const shapes: readonly {
    readonly body: string;
    readonly result: string;
    readonly liveness: string;
    readonly documentKind: string;
    readonly reason: string | null;
    readonly name: string;
  }[] = [
    {
      body: detailsBody({ ...PASSING_CAPABILITIES, liveness: [capability("REJECTED", "DIGITAL_COPY")] }),
      result: "failed",
      liveness: "failed",
      documentKind: "not_stated",
      reason: "liveness_failed",
      name: "a selfie taken from a screen fails as liveness",
    },
    {
      body: detailsBody({ ...PASSING_CAPABILITIES, liveness: [capability("REJECTED", "NO_FACE_PRESENT")] }),
      result: "failed",
      liveness: "failed",
      documentKind: "not_stated",
      reason: "liveness_failed",
      name: "no face fails as liveness",
    },
    {
      body: detailsBody({ ...PASSING_CAPABILITIES, similarity: [capability("REJECTED", "NO_MATCH")] }),
      result: "failed",
      liveness: "passed",
      documentKind: "not_stated",
      reason: "document_mismatch",
      name: "a face that is not the document's owner fails as a mismatch",
    },
    {
      body: detailsBody({ ...PASSING_CAPABILITIES, usability: [capability("REJECTED", "BLURRED")] }),
      result: "failed",
      liveness: "passed",
      documentKind: "not_stated",
      reason: "document_unreadable",
      name: "an unreadable document fails as unreadable",
    },
    {
      body: detailsBody({ ...PASSING_CAPABILITIES, extraction: [capability("REJECTED", "DATA_MISMATCH")] }),
      result: "failed",
      liveness: "passed",
      documentKind: "not_stated",
      reason: "document_unreadable",
      name: "an extraction the vendor rejects fails as unreadable",
    },
    {
      body: detailsBody({ ...PASSING_CAPABILITIES, liveness: [capability("WARNING", "MULTIPLE_PEOPLE")] }),
      result: "unknown",
      liveness: "unknown",
      documentKind: "not_stated",
      reason: "vendor_incomplete",
      name: "a warning is neither a pass nor a rejection",
    },
    {
      body: detailsBody({ ...PASSING_CAPABILITIES, liveness: [capability("WARNING", "BAD_QUALITY")] }),
      result: "unknown",
      liveness: "unknown",
      documentKind: "not_stated",
      reason: "vendor_incomplete",
      name: "a quality warning is unknown",
    },
    {
      body: detailsBody({ ...PASSING_CAPABILITIES, liveness: [capability("NOT_EXECUTED", "PRECONDITION_NOT_FULFILLED")] }),
      result: "unknown",
      liveness: "in_progress",
      documentKind: "not_stated",
      reason: "vendor_incomplete",
      name: "a capability that never ran proves nothing",
    },
    {
      body: detailsBody({ ...PASSING_CAPABILITIES, similarity: [capability("NOT_EXECUTED", "PRECONDITION_NOT_FULFILLED")] }),
      result: "unknown",
      liveness: "passed",
      documentKind: "not_stated",
      reason: "vendor_incomplete",
      name: "a comparison that never ran leaves the pass to a person",
    },
    {
      body: detailsBody({ extraction: [capability("PASSED", "OK")] }),
      result: "unknown",
      liveness: "in_progress",
      documentKind: "not_stated",
      reason: "vendor_incomplete",
      name: "a document with no liveness is unknown, not a pass",
    },
    {
      body: detailsBody({}, { status: "PROCESSING" }),
      result: "in_progress",
      liveness: "in_progress",
      documentKind: "not_stated",
      reason: "vendor_incomplete",
      name: "a workflow still running is in progress",
    },
    {
      body: detailsBody({}, { status: "PENDING" }),
      result: "in_progress",
      liveness: "in_progress",
      documentKind: "not_stated",
      reason: "vendor_incomplete",
      name: "an undocumented status is in progress, not a failure",
    },
    {
      body: detailsBody({}, { status: "SOMETHING_NEW" }),
      result: "in_progress",
      liveness: "in_progress",
      documentKind: "not_stated",
      reason: "vendor_incomplete",
      name: "a status this adapter has never seen is in progress",
    },
    {
      body: detailsBody({}, { status: "SESSION_INITIATED", journeyState: ["started", "id-front-uploaded"] }),
      result: "in_progress",
      liveness: "in_progress",
      documentKind: "not_stated",
      reason: "vendor_incomplete",
      name: "a person who stopped half way is in progress",
    },
    {
      body: detailsBody({}, { status: "SESSION_INITIATED", journeyState: ["started", "id-front-uploaded", "expired"] }),
      result: "expired",
      liveness: "in_progress",
      documentKind: "not_stated",
      reason: "session_expired",
      name: "the documented expired state is expired",
    },
    {
      body: detailsBody({}, { documentType: "ID_CARD" }),
      result: "unknown",
      liveness: "in_progress",
      documentKind: "national_id",
      reason: "vendor_incomplete",
      name: "an identity card is the neutral national id",
    },
    {
      body: detailsBody({}, { documentType: "DRIVING_LICENSE" }),
      result: "unknown",
      liveness: "in_progress",
      documentKind: "driving_licence",
      reason: "vendor_incomplete",
      name: "a driving licence is a driving licence",
    },
    {
      body: detailsBody({}, { documentType: "VISA" }),
      result: "unknown",
      liveness: "in_progress",
      documentKind: "not_stated",
      reason: "vendor_incomplete",
      name: "a visa makes no residence claim",
    },
    {
      body: detailsBody({}, { documentType: "UNSUPPORTED" }),
      result: "unknown",
      liveness: "in_progress",
      documentKind: "not_stated",
      reason: "vendor_incomplete",
      name: "an unsupported document states nothing",
    },
    {
      body: detailsBody({}, { documentType: "SOMETHING_NEW" }),
      result: "unknown",
      liveness: "in_progress",
      documentKind: "not_stated",
      reason: "vendor_incomplete",
      name: "a document type this adapter has never seen states nothing",
    },
    {
      body: detailsBody({ liveness: [capability("PASSED", "OK")] }),
      result: "unknown",
      liveness: "passed",
      documentKind: "not_stated",
      reason: "vendor_incomplete",
      name: "a live person with no document read is unknown",
    },
  ];

  for (const shape of shapes) {
    const parsed = parseJumioWorkflow(shape.body);
    expect(parsed !== null, `${shape.name}: the record is read`);
    if (parsed === null) continue;
    const mapped = jumioAnswerOf(parsed);
    expectEqual(mapped.result, shape.result, shape.name);
    expectEqual(mapped.liveness, shape.liveness, `${shape.name}: liveness`);
    expectEqual(mapped.documentKind, shape.documentKind, `${shape.name}: document kind`);
    expectEqual(mapped.reasonCode, shape.reason, `${shape.name}: reason`);
    expect((SUPPLEMENTARY_IDV_LIVENESS_RESULTS as readonly string[]).includes(mapped.liveness), `${shape.name}: liveness is a supplementary word`);
    expect((SUPPLEMENTARY_IDV_DOCUMENT_KINDS as readonly string[]).includes(mapped.documentKind), `${shape.name}: kind is a supplementary word`);
    expect(mapped.reasonCode === null || isSupplementaryIdvReasonCode(mapped.reasonCode), `${shape.name}: reason is a supplementary word`);
    expect(isProcessorKybStatus(mapped.result) === false, `${shape.name}: the result is not a processor status`);
  }

  // A decision word the vendor never documents is dropped, not believed.
  const invented = JSON.parse(
    detailsBody({ ...PASSING_CAPABILITIES, liveness: [capability("APPROVED", "OK")] }),
  ) as Record<string, unknown>;
  const parsedInvented = parseJumioWorkflow(JSON.stringify(invented));
  expect(parsedInvented !== null, "a record with an invented decision is still read");
  if (parsedInvented !== null) {
    expect(parsedInvented.decisions.some((entry) => entry.capability === "liveness") === false, "an invented decision is dropped");
    const mapped = jumioAnswerOf(parsedInvented);
    expectEqual(mapped.result !== "passed", true, "an invented decision cannot make a pass");
    expect(mapped.result !== "failed", "an invented decision cannot make a failure either");
  }

  // An answer never carries a processor word, whatever the vendor says.
  const hostile = detailsBody({
    extraction: [capability("VERIFIED", "OK")],
    liveness: [capability("verified", "OK")],
    similarity: [capability("REJECTED", "NO_MATCH")],
  }, { documentType: "PASSPORT", status: "PROCESSED" });
  const hostileParsed = parseJumioWorkflow(hostile);
  expect(hostileParsed !== null, "a hostile record is read");
  if (hostileParsed !== null) {
    const mapped = jumioAnswerOf(hostileParsed);
    expectEqual(mapped.result, "failed", "a rejection still fails even beside an invented pass");
    expect(PROCESSOR_KYB_STATUSES.includes(mapped.result as never) === false, "the answer is not one of the processor's five");
    expectEqual(supplementaryIdvOverlapsProcessorKyb(mapped.result), false, "the supplementary result stays disjoint");
  }

  expectEqual(parseJumioWorkflow("not json"), null, "a record that is not JSON is not read");
  expectEqual(parseJumioWorkflow(JSON.stringify({ account: { id: ACCOUNT_ID } })), null, "a record with no workflow is not read");
  expectEqual(parseJumioWorkflow(JSON.stringify({ workflow: { id: EXECUTION_ID } })), null, "a record with no status is not read");

  // The read answer's verdicts.
  const readPass = parseJumioReadAnswer(200, passing, "ref:1");
  expectEqual(readPass.outcome, "read", "a finished record is a read");
  if (readPass.outcome === "read") {
    expectEqual(readPass.answer.result, "passed", "the read carries the neutral result");
    expectEqual(readPass.answer.reference, "ref:1", "the read carries the reference it was asked about");
  }
  expectEqual(parseJumioReadAnswer(200, detailsBody({}, { status: "PROCESSING" }), "ref:1").outcome, "in_flight", "a running workflow is in flight");
  expectEqual(parseJumioReadAnswer(404, "", "ref:1").outcome, "not_found", "a workflow Jumio does not know is not found");
  expectEqual(parseJumioReadAnswer(401, "", "ref:1").outcome, "failed", "a refused token fails the read");
  expectEqual(parseJumioReadAnswer(403, "", "ref:1").outcome, "failed", "a forbidden read fails");
  expectEqual(parseJumioReadAnswer(400, "", "ref:1").outcome, "failed", "a malformed read fails");
  for (const status of [302, 429, 500, 503]) {
    expectEqual(parseJumioReadAnswer(status, "", "ref:1").outcome, "unknown", `a ${status} read answer is unknown`);
  }
  expectEqual(parseJumioReadAnswer(200, JSON.stringify({ account: { id: ACCOUNT_ID } }), "ref:1").outcome, "unknown", "a read with no workflow status is unknown");
}

/* ---- 8: refreshing a session, forward only ---- */

async function checkRefresh(): Promise<void> {
  const store = configuredStore();
  const session = openedSession(store.config);
  const openTransport = new ScriptedTransport([tokenAnswer(), ok(accountBody(), 201)]);
  const cache = new InMemoryJumioTokenCache();
  const options = optionsWith(openTransport.call, store.store, session.store, { tokenCache: cache });
  const opened = await openJumioSession({ ...SESSION_INPUT, sessionId: session.session.id }, options);
  expectEqual(opened.status, "opened", "the session opens before it is refreshed");

  const readOptions = optionsWith(
    new ScriptedTransport([ok(detailsBody(PASSING_CAPABILITIES, { documentType: "PASSPORT" }))]).call,
    store.store,
    session.store,
    { tokenCache: cache },
  );
  const first = await refreshJumioSession(session.session.id, readOptions);
  expectEqual(first.status, "recorded", "a finished record is recorded");
  if (first.status === "recorded") {
    expectEqual(first.session.result, "passed", "the session passes");
    expectEqual(first.session.liveness, "passed", "liveness is recorded");
    expectEqual(first.session.documentKind, "passport", "the document kind is recorded");
    expectEqual(first.session.requiresHumanReview, false, "a pass needs no person");
    expectEqual(first.changed, true, "the first read changes the row");
  }

  // A second read of the same answer changes nothing.
  const again = await refreshJumioSession(
    session.session.id,
    optionsWith(new ScriptedTransport([ok(detailsBody(PASSING_CAPABILITIES, { documentType: "PASSPORT" }))]).call, store.store, session.store, { tokenCache: cache }),
  );
  expectEqual(again.status, "recorded", "a second read is recorded");
  expectEqual(again.status === "recorded" ? again.changed : null, false, "the same answer changes nothing");

  // A pass can never be replayed into a failure.
  const backwards = await refreshJumioSession(
    session.session.id,
    optionsWith(new ScriptedTransport([ok(detailsBody({ ...PASSING_CAPABILITIES, liveness: [capability("REJECTED", "DIGITAL_COPY")] }))]).call, store.store, session.store, { tokenCache: cache }),
  );
  expectEqual(backwards.status, "refused", "a pass is not replayed into a failure");
  expectEqual(session.store.findById(session.session.id)?.result, "passed", "the recorded pass stays");

  // An unhappy result is a manual review, and the merchant phrase stays neutral.
  const unhappyStore = configuredStore();
  const unhappySession = openedSession(unhappyStore.config);
  const unhappyCache = new InMemoryJumioTokenCache();
  unhappyCache.set(unhappyStore.config.id, { accessToken: ACCESS_TOKEN, expiresAtEpochMs: NOW + 3_600_000 });
  await openJumioSession(
    { ...SESSION_INPUT, sessionId: unhappySession.session.id },
    optionsWith(new ScriptedTransport([ok(accountBody(), 201)]).call, unhappyStore.store, unhappySession.store, { tokenCache: unhappyCache }),
  );
  const unhappy = await refreshJumioSession(
    unhappySession.session.id,
    optionsWith(new ScriptedTransport([ok(detailsBody({ ...PASSING_CAPABILITIES, liveness: [capability("REJECTED", "LIVENESS_UNDETERMINED")] }))]).call, unhappyStore.store, unhappySession.store, { tokenCache: unhappyCache }),
  );
  expectEqual(unhappy.status, "recorded", "a failed check is recorded, not thrown");
  if (unhappy.status === "recorded") {
    expectEqual(unhappy.session.result, "failed", "the session fails");
    expectEqual(unhappy.session.requiresHumanReview, true, "a failed check is a manual case");
    expect(unhappy.session.fallback !== null, "a failed check falls back to manual review");
    const phrase = supplementaryIdvMerchantStatusOf("failed");
    expect(asText(phrase).toLowerCase().includes("jumio") === false, "the merchant phrase names no vendor");
    expect(asText(phrase).toLowerCase().includes("failed") === false, "the merchant phrase uses no vendor word");
    expect(asText(unhappy.session).includes("DIGITAL_COPY") === false, "the vendor's label is not stored");
    expect(asText(unhappy.session).includes("authorizationToken") === false, "no redirect token is stored");
  }

  // The expired and unreadable paths land in the same manual place.
  const expiredStore = configuredStore();
  const expiredSession = openedSession(expiredStore.config);
  const expiredCache = new InMemoryJumioTokenCache();
  expiredCache.set(expiredStore.config.id, { accessToken: ACCESS_TOKEN, expiresAtEpochMs: NOW + 3_600_000 });
  await openJumioSession({ ...SESSION_INPUT, sessionId: expiredSession.session.id }, optionsWith(new ScriptedTransport([ok(accountBody(), 201)]).call, expiredStore.store, expiredSession.store, { tokenCache: expiredCache }));
  const expired = await refreshJumioSession(
    expiredSession.session.id,
    optionsWith(new ScriptedTransport([ok(detailsBody({}, { status: "SESSION_INITIATED", journeyState: ["started", "expired"] }))]).call, expiredStore.store, expiredSession.store, { tokenCache: expiredCache }),
  );
  expectEqual(expired.status, "recorded", "an expired journey is recorded");
  if (expired.status === "recorded") {
    expectEqual(expired.session.result, "expired", "the session expires");
    expectEqual(expired.session.requiresHumanReview, true, "an expired journey is a manual case");
  }

  for (const status of [404, 401, 429, 500]) {
    const failing = await refreshJumioSession(
      expiredSession.session.id,
      optionsWith(new ScriptedTransport([{ status, body: "", headers: {} }]).call, expiredStore.store, expiredSession.store, { tokenCache: expiredCache }),
    );
    expect(failing.status === "failed", `a ${status} refresh does not record an answer`);
  }
  const unreadable = await refreshJumioSession(
    session.session.id,
    optionsWith(new ScriptedTransport([ok("not json")]).call, store.store, session.store, { tokenCache: cache }),
  );
  expectEqual(unreadable.status, "failed", "an unreadable record is not recorded");

  const throwing = await refreshJumioSession(
    session.session.id,
    optionsWith(async () => {
      throw new Error("the network is gone");
    }, store.store, session.store, { tokenCache: cache }),
  );
  expectEqual(throwing.status, "failed", "a read that cannot be made records nothing");

  const unreferenced = openedSession(configuredStore().config);
  const noReference = await refreshJumioSession(
    unreferenced.session.id,
    optionsWith(new ScriptedTransport([]).call, store.store, unreferenced.store),
  );
  expectEqual(noReference.status, "failed", "a session with no reference cannot be read");

  const unknownSession = await refreshJumioSession("no-such-session", optionsWith(new ScriptedTransport([]).call, store.store, session.store));
  expectEqual(unknownSession.status, "failed", "an unknown session cannot be read");

  // The summary the office sees keeps the vendor's words beside the neutral result.
  const parsed = parseJumioWorkflow(detailsBody(PASSING_CAPABILITIES, { documentType: "PASSPORT" }));
  const finalSession = session.store.findById(session.session.id) as SupplementaryIdvSession;
  if (parsed !== null) {
    const summary = jumioSessionSummaryOf(finalSession, parsed);
    expectEqual(summary.changesProcessorKyb, false, "the summary changes no processor status");
    expectEqual(summary.result, "passed", "the summary carries the neutral result");
    expectEqual(summary.workflowStatus, "PROCESSED", "the summary keeps the vendor's status for the office");
    expectEqual(summary.decisions.length, 7, "the summary keeps every decision");
    expectEqual(summary.documentKind, "passport", "the summary carries the document kind");
  }
  const evidence = supplementaryIdvEvidenceOf(finalSession);
  expect(asText(evidence).includes("passport"), "the evidence carries the document kind");
  expect(isProcessorKybStatus(asText(evidence) as never) === false, "the evidence is not a processor status");
  expectEqual(refuseProcessorKybWrite("verified").status, "refused", "a processor write is refused at the boundary");
  expectEqual(PROCESSOR_KYB_AUTHORITY, "processor", "the processor keeps the verdict");
}

/* ---- 9: the port STEP 170 defined, and its three members ---- */

async function checkAdapter(): Promise<void> {
  const transport = new ScriptedTransport([tokenAnswer(), ok(accountBody(), 201), tokenAnswer(), ok(detailsBody(PASSING_CAPABILITIES, { documentType: "PASSPORT" }))]);
  const adapter = jumioAdapterOf({
    transport: transport.call,
    workflowKey: "10549",
    successUrl: SESSION_INPUT.successUrl,
    errorUrl: SESSION_INPUT.errorUrl,
    callbackUrl: SESSION_INPUT.callbackUrl,
  });

  expectEqual(isSupplementaryIdvAdapter(adapter), true, "the adapter fits STEP 170's port");
  expectEqual(adapter.vendorKey, "jumio", "the adapter names its vendor");
  expectEqual(Object.keys(adapter).sort().join(","), [...SUPPLEMENTARY_IDV_ADAPTER_MEMBERS].sort().join(","), "the adapter has exactly the port's members");
  expect(Object.keys(adapter).includes("setStatus") === false, "the port has no status writer");
  expect(Object.keys(adapter).includes("writeKyb") === false, "the port has no KYB writer");

  const sealedConfig = configuredStore();
  const opened = await adapter.createSession(
    { companyId: COMPANY, sessionId: "9f9dd1c1-1111-4222-8333-444455556666", environment: "live", returnUrl: SESSION_INPUT.successUrl },
    { configId: sealedConfig.config.id, companyId: COMPANY, vendorKey: "jumio", environment: "live", credential: jumioCredentialTextOf(CREDENTIAL), webhookSecret: null } as OpenedSupplementaryIdvConfig,
  );
  expectEqual(opened.result, "in_progress", "the port's create answers in progress");
  expectEqual(opened.reference, jumioReferenceOf(ACCOUNT_ID, EXECUTION_ID), "the port's create answers the reference");
  expectEqual(opened.liveness, "in_progress", "no liveness is claimed at creation");
  expectEqual(transport.calls.length, 2, "the port's create makes two calls");

  const read = await adapter.readSession(jumioReferenceOf(ACCOUNT_ID, EXECUTION_ID), {
    configId: sealedConfig.config.id,
    companyId: COMPANY,
    vendorKey: "jumio",
    environment: "live",
    credential: jumioCredentialTextOf(CREDENTIAL),
    webhookSecret: null,
  } as OpenedSupplementaryIdvConfig);
  expectEqual(read.result, "passed", "the port's read answers the neutral result");
  expectEqual(read.documentKind, "passport", "the port's read answers the document kind");
  expect(isProcessorKybStatus(read.result) === false, "the port's read never answers a processor status");

  const brokenConfiguration = {
    configId: sealedConfig.config.id,
    companyId: COMPANY,
    vendorKey: "jumio",
    environment: "live",
    credential: "not a credential",
    webhookSecret: null,
  } as OpenedSupplementaryIdvConfig;
  await expectRejects(
    async () => adapter.readSession(jumioReferenceOf(ACCOUNT_ID, EXECUTION_ID), brokenConfiguration),
    "the port refuses an opened configuration that holds no credential",
  );
  await expectRejects(
    async () => adapter.readSession("account-1:workflow-1", { configId: sealedConfig.config.id, companyId: COMPANY, vendorKey: "jumio", environment: "live", credential: jumioCredentialTextOf(CREDENTIAL), webhookSecret: null } as OpenedSupplementaryIdvConfig),
    "the port refuses a reference that is not two UUIDs",
  );

  const refusalTransport: JumioTransport = async () => ({ status: 401, body: "", headers: {} });
  const refusing = jumioAdapterOf({
    transport: refusalTransport,
    workflowKey: "10549",
    successUrl: SESSION_INPUT.successUrl,
    errorUrl: SESSION_INPUT.errorUrl,
    callbackUrl: null,
  });
  await expectRejects(
    async () => refusing.createSession({ companyId: COMPANY, sessionId: "9f9dd1c1-1111-4222-8333-444455556666", environment: "live", returnUrl: SESSION_INPUT.successUrl }, brokenConfiguration),
    "the port throws rather than answering when the credential is refused",
  );
}

/* ---- 10: the transport's own guards ---- */

async function checkTransport(): Promise<void> {
  const documented: JumioCall = {
    surface: "auth",
    region: "amer-1",
    method: "POST",
    path: JUMIO_TOKEN_PATH,
    authorization: "basic",
    authValue: "abc",
    contentType: "application/x-www-form-urlencoded",
    body: "grant_type=client_credentials",
  };
  expect(isJumioCall(documented.surface, documented.method, documented.path) === true, "the transport's first call is documented");

  await expectRejects(
    async () => jumioFetchTransport({ ...documented, path: "/api/v1/accounts" }),
    "the transport refuses an account path on the token host",
  );
  await expectRejects(
    async () => jumioFetchTransport({ ...documented, surface: "account", authorization: "basic" }),
    "the transport refuses basic authentication on the account host",
  );
  await expectRejects(
    async () => jumioFetchTransport({ ...documented, surface: "account", path: "/api/v1/accounts", authValue: null }),
    "the transport refuses to call the API without a token",
  );
  await expectRejects(
    async () => jumioFetchTransport({ ...documented, path: "/api/v1/accounts" }),
    "the transport refuses a path it does not know",
  );

  // The source itself carries no credential, no token and no hard-coded host that is not Jumio's.
  const source = readFileSync(fileURLToPath(new URL("./jumio.ts", import.meta.url)), "utf8");
  expect(source.includes("authorizationToken=") === false, "the adapter hard-codes no redirect token");
  expect(source.includes("client_secret_for_the_gate") === false, "the adapter carries no credential");
  expect(/https:\/\/(?!auth\.|account\.|retrieval\.|documentation\.jumio\.ai|tools\.ietf\.org)/u.test(source) === false, "the adapter names no host but Jumio's");
  expect(source.includes("status.amer-1.jumio.ai") === false, "the uptime status host is not in the adapter");
  expect(source.includes("console.") === false, "the adapter logs nothing");
  expect(source.includes("process.env") === false, "the adapter reads no ambient environment for a credential");

  // The credential never travels in a URL.
  const transport = new ScriptedTransport([tokenAnswer(), ok(accountBody(), 201)]);
  const store = configuredStore();
  const session = openedSession(store.config);
  await openJumioSession({ ...SESSION_INPUT, sessionId: session.session.id }, optionsWith(transport.call, store.store, session.store));
  for (const call of transport.calls) {
    expect(call.path.includes("?") === false, "no call carries a query string");
    expect(call.path.includes(CREDENTIAL.clientSecret) === false, "no path carries the secret");
    expect(JSON.stringify(call).includes("authorizationToken") === false, "no call replays the redirect token");
  }
}

/* ---- running ---- */

checkCatalogue();
checkCredential();
await checkConfiguration();
checkTokenAnswer();
checkRequest();
await checkOpen();
checkWorkflowReading();
await checkRefresh();
await checkAdapter();
await checkTransport();

if (failures.length > 0) {
  process.stderr.write(
    `jumio adapter gate failed: ${failures.length} of ${checks} checks\n${failures.map((failure) => `  - ${failure}`).join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `jumio adapter gate passed: ${checks} checks (three documented datacenter hosts and three documented calls behind an allowlist, an OAuth2 token reused until shortly before its documented hour, a client id and secret sealed by STEP 170's own scopes and inert until a real token call proves them, one active vendor per company and mode, a session row written before Jumio is called and a redirect URL that carries an authorization token and is therefore never stored, a supplier's four decision words mapped so that PASSED is passed, REJECTED is failed, and WARNING and NOT_EXECUTED are a person's work rather than a verdict, a workflow status this adapter refuses to invent, and a supplementary pass that stays disjoint from the processor's five statuses at every step)\n`,
);
