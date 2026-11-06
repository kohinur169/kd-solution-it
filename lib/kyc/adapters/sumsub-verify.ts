// path: lib/kyc/adapters/sumsub-verify.ts

/**
 * The gate for the Sumsub supplementary adapter.
 *
 * It is run directly because STEP 170's ownership rule keeps `package.json` out of this STEP's hands:
 *
 *   node --experimental-strip-types lib/kyc/adapters/sumsub-verify.ts
 *
 * Eleven sections, the same shape STEPs 170 to 172 used: the catalogue, the credential, the sealed configuration and
 * its activation, the signature, the request this platform builds, opening a session, the decision mapping, reading a
 * decision over the wire, refreshing forwards only, the port STEP 170 defined, and the transport's own guards plus a
 * scan of the adapter's source.
 *
 * Nothing here reaches the network: every call is answered by a scripted transport, and the two documented hosts are
 * only ever compared as strings.
 */

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import type { EncryptionKeyring } from "../../security/encryption.ts";
import {
  InMemorySupplementaryIdvConfigStore,
  InMemorySupplementaryIdvSessionStore,
  PROCESSOR_KYB_STATUSES,
  SUPPLEMENTARY_IDV_DOCUMENT_KINDS,
  SUPPLEMENTARY_IDV_LIVENESS_RESULTS,
  SUPPLEMENTARY_IDV_REASON_CODES,
  SUPPLEMENTARY_IDV_RESULTS,
  isSupplementaryIdvAdapter,
  openSupplementaryIdvConfig,
  openSupplementaryIdvSession,
  sealSupplementaryIdvConfig,
  supplementaryIdvMerchantStatusOf,
  validateSupplementaryIdvVendorAnswer,
} from "./supplementary-idv.ts";
import type {
  OpenedSupplementaryIdvConfig,
  SupplementaryIdvAuditEntry,
  SupplementaryIdvConfig,
  SupplementaryIdvEnvironment,
  SupplementaryIdvSession,
  SupplementaryIdvVendorAnswer,
} from "./supplementary-idv.ts";
import {
  SUMSUB_ACCESS_TOKEN_DEFAULT_TTL_SECONDS,
  SUMSUB_ACCESS_TOKEN_MAXIMUM_TTL_SECONDS,
  SUMSUB_ACCESS_TOKEN_PATH,
  SUMSUB_ALLOWED_CALLS,
  SUMSUB_API_HOST,
  SUMSUB_APPLICANT_ID_PATTERN,
  SUMSUB_APP_TOKEN_MAXIMUM_LENGTH,
  SUMSUB_DOCUMENT_TYPES,
  SUMSUB_EXTERNAL_USER_ID_MAXIMUM_LENGTH,
  SUMSUB_IDENTITY_STEPS,
  SUMSUB_REJECT_LABEL_REASONS,
  SUMSUB_REVIEW_ANSWERS,
  SUMSUB_REVIEW_STATUSES,
  SUMSUB_SECRET_KEY_MAXIMUM_LENGTH,
  SUMSUB_SELFIE_STEPS,
  SUMSUB_STEP_TYPES,
  SUMSUB_TIMESTAMP_TOLERANCE_SECONDS,
  SUMSUB_VENDOR_KEY,
  activateSumsubConfiguration,
  buildSumsubApplicantBody,
  createSumsubAccessToken,
  createSumsubConfiguration,
  isSumsubApplicantId,
  isSumsubCall,
  isSumsubReviewAnswer,
  isSumsubReviewStatus,
  openSumsubSession,
  parseSumsubApplicantAnswer,
  parseSumsubExistenceAnswer,
  parseSumsubReadAnswers,
  parseSumsubStatus,
  parseSumsubSteps,
  refreshSumsubSession,
  sumsubAdapterOf,
  sumsubAnswerOf,
  sumsubCredentialOf,
  sumsubCredentialTextOf,
  sumsubCreatePath,
  sumsubEndpoint,
  sumsubExistencePath,
  sumsubExternalUserIdOf,
  sumsubFetchTransport,
  sumsubProblemDetailOf,
  sumsubRequestOf,
  sumsubSessionSummaryOf,
  sumsubSignatureOf,
  sumsubSignaturePayloadOf,
  sumsubStatusPath,
  sumsubStepsPath,
  validateSumsubCredential,
  validateSumsubSessionInput,
} from "./sumsub.ts";
import type {
  SumsubAnswer,
  SumsubConfigAuditEntry,
  SumsubCredential,
  SumsubDecision,
  SumsubOptions,
  SumsubReadVerdict,
  SumsubRequest,
  SumsubStepResult,
  SumsubTransport,
} from "./sumsub.ts";

/* ---- the checking harness, the same shape STEPs 170 to 172 used ---- */

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

function expectThrows(action: () => unknown, name: string): void {
  try {
    action();
    expect(false, name);
  } catch {
    expect(true, name);
  }
}

async function expectRejectsWith(action: () => Promise<unknown>, message: string, name: string): Promise<void> {
  try {
    await action();
    expect(false, name);
  } catch (error) {
    // The message matters: a guard that throws its own words is not the same as a socket that failed.
    expect(error instanceof Error && error.message === message, `${name} (the refusal names the guard)`);
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
const NOW_SECONDS = 1_779_000_000;
const COMPANY = "company_kd_sumsub_gate";
const SESSION_UUID = "0f4d8a26-6b1f-4a3b-9f21-5c7e3d2a1b40";
const APPLICANT_ID = "5b594ade0a975a36c9349e66";
const SECOND_APPLICANT_ID = "67b3659550a9ed51c7770000";
const LEVEL = "basic-kyc-level";
const APP_TOKEN = "sumsub_gate_app_token_0123456789";
const SECRET_KEY = "sumsub_gate_secret_key_0123456789";
const ACCESS_TOKEN = "_act-gate-token-that-must-never-be-stored";

const CREDENTIAL: SumsubCredential = { appToken: APP_TOKEN, secretKey: SECRET_KEY };

const keyring: EncryptionKeyring = { primary: { id: "k1", secret: Buffer.alloc(32, 7).toString("base64") } };
const otherKeyring: EncryptionKeyring = { primary: { id: "k2", secret: Buffer.alloc(32, 9).toString("base64") } };

function ok(body: string, status = 200): SumsubAnswer {
  return { status, body, headers: { "content-type": "application/json" } };
}

/** A transport that answers from a script and records what it was asked. An `Error` in the script is a throw. */
class ScriptedTransport {
  readonly calls: SumsubRequest[] = [];
  private readonly answers: (SumsubAnswer | Error)[];

  constructor(answers: readonly (SumsubAnswer | Error)[]) {
    this.answers = [...answers];
  }

  readonly call: SumsubTransport = async (request) => {
    this.calls.push(request);
    const next = this.answers.shift();
    if (next === undefined) throw new Error("the script has no answer for this call");
    if (next instanceof Error) throw next;
    return next;
  };
}

/** A transport that decides its answer from the request itself, which is how a two-read refresh is scripted. */
function routed(handler: (request: SumsubRequest) => SumsubAnswer): {
  readonly calls: SumsubRequest[];
  readonly transport: SumsubTransport;
} {
  const calls: SumsubRequest[] = [];
  const transport: SumsubTransport = async (request) => {
    calls.push(request);
    return handler(request);
  };
  return { calls, transport };
}

function createBody(overrides: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    id: APPLICANT_ID,
    createdAt: "2026-11-06 05:05:14",
    clientId: "your_cool_id",
    inspectionId: "5b594ade0a975a36c9379e67",
    externalUserId: SESSION_UUID,
    requiredIdDocs: {
      docSets: [
        { idDocSetType: "IDENTITY", types: ["PASSPORT", "ID_CARD"] },
        { idDocSetType: "SELFIE", types: ["SELFIE"] },
      ],
    },
    review: { reviewId: "QtIxN", attemptId: "ZlZlO", attemptCnt: 0, levelName: LEVEL, reviewStatus: "init" },
    type: "individual",
    ...overrides,
  });
}

function statusBody(
  input: {
    readonly status: string;
    readonly answer?: string | null;
    readonly labels?: readonly string[];
    readonly rejectType?: string | null;
    readonly levelName?: string;
  },
): string {
  return JSON.stringify({
    reviewId: "QtIxN",
    attemptId: "ZlZlO",
    attemptCnt: 0,
    levelName: input.levelName ?? LEVEL,
    createDate: "2026-11-06 05:05:14",
    reviewDate: "2026-11-06 05:06:14",
    reviewStatus: input.status,
    reviewResult:
      input.answer === undefined || input.answer === null
        ? {}
        : {
            reviewAnswer: input.answer,
            rejectLabels: input.labels ?? [],
            reviewRejectType: input.rejectType ?? null,
          },
  });
}

function stepsBody(
  input: {
    readonly identity?: string | null;
    readonly idDocType?: string | null;
    readonly selfie?: string | null;
    readonly labels?: readonly string[];
  } = {},
): string {
  const body: Record<string, unknown> = {};
  if (input.identity !== null) {
    body["IDENTITY"] = {
      idDocType: input.idDocType === undefined ? "PASSPORT" : input.idDocType,
      country: "GBR",
      reviewResult:
        input.identity === undefined || input.identity === null
          ? {}
          : { reviewAnswer: input.identity, rejectLabels: input.labels ?? [] },
    };
  }
  if (input.selfie !== null) {
    body["SELFIE"] = {
      reviewResult:
        input.selfie === undefined || input.selfie === null
          ? {}
          : { reviewAnswer: input.selfie, rejectLabels: [] },
    };
  }
  return JSON.stringify(body);
}

function existenceBody(exists: boolean, applicantId = APPLICANT_ID): string {
  return exists
    ? JSON.stringify({ exists: true, applicant: { id: applicantId, externalUserId: SESSION_UUID, type: "individual" } })
    : JSON.stringify({ exists: false });
}

/** A configuration store with one sealed Sumsub configuration, active unless asked otherwise. */
function configuredStore(
  options: {
    readonly ring?: EncryptionKeyring;
    readonly status?: SupplementaryIdvConfig["status"];
    readonly vendorKey?: SupplementaryIdvConfig["vendorKey"];
    readonly companyId?: string;
    readonly environment?: SupplementaryIdvEnvironment;
    readonly credential?: SumsubCredential;
    readonly webhookSecret?: string | null;
  } = {},
): { readonly store: InMemorySupplementaryIdvConfigStore; readonly config: SupplementaryIdvConfig } {
  const store = new InMemorySupplementaryIdvConfigStore();
  const sealed = sealSupplementaryIdvConfig(
    {
      companyId: options.companyId ?? COMPANY,
      vendorKey: options.vendorKey ?? "sumsub",
      environment: options.environment ?? "live",
      credential: sumsubCredentialTextOf(options.credential ?? CREDENTIAL),
      webhookSecret: options.webhookSecret === undefined ? "sumsub_webhook_secret_for_the_gate_0001" : options.webhookSecret,
    },
    options.ring ?? keyring,
  );
  if ("reason" in sealed) throw new Error(`the fixture could not be sealed: ${sealed.reason}`);
  const wanted = options.status ?? "active";
  const config: SupplementaryIdvConfig = {
    id: "cfg_sumsub_0001",
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
  if (wanted !== "pending_activation") {
    if (store.save({ ...config, status: wanted, version: 2, updatedAtEpochMs: NOW }, 1) === false) {
      throw new Error("the fixture configuration could not be moved");
    }
  }
  const stored = store.findById(config.id);
  if (stored === null) throw new Error("the fixture configuration was not stored");
  return { store, config: stored };
}

/** A session row, opened through STEP 170 so this gate exercises the real path. */
function openedSession(
  config: SupplementaryIdvConfig,
  environment: SupplementaryIdvEnvironment = config.environment,
): { readonly store: InMemorySupplementaryIdvSessionStore; readonly session: SupplementaryIdvSession } {
  const store = new InMemorySupplementaryIdvSessionStore();
  const opened = openSupplementaryIdvSession(
    {
      companyId: config.companyId,
      vendorKey: "sumsub",
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
  transport: SumsubTransport,
  configStore: InMemorySupplementaryIdvConfigStore,
  sessionStore: InMemorySupplementaryIdvSessionStore,
  extra: {
    readonly recordAudit?: (entry: SupplementaryIdvAuditEntry) => void;
    readonly recordConfigAudit?: (entry: SumsubConfigAuditEntry) => void;
    readonly ring?: EncryptionKeyring;
  } = {},
): SumsubOptions {
  return {
    configStore,
    sessionStore,
    keyring: extra.ring ?? keyring,
    occurredAtEpochMs: NOW,
    transport,
    ...(extra.recordAudit === undefined ? {} : { recordAudit: extra.recordAudit }),
    ...(extra.recordConfigAudit === undefined ? {} : { recordConfigAudit: extra.recordConfigAudit }),
  };
}

const SESSION_INPUT = { sessionId: SESSION_UUID, levelName: LEVEL };

/** A decision fixture, in the shape `sumsubAnswerOf` reads. */
function decisionOf(review: SumsubDecision["review"], steps: readonly SumsubStepResult[] = []): SumsubDecision {
  return { review, steps };
}

/* ---- 1: the catalogue is the documentation's, and nothing else is reachable ---- */

function checkCatalogue(): void {
  expectEqual(SUMSUB_API_HOST, "https://api.sumsub.com", "the one documented host, for both environments");
  expect(SUMSUB_API_HOST.startsWith("https://") === true, "the host is https only");
  expect(SUMSUB_API_HOST.endsWith("/") === false, "the host carries no trailing slash");
  expectEqual(sumsubEndpoint("/resources/x"), "https://api.sumsub.com/resources/x", "an endpoint is host plus path");
  expectEqual(sumsubEndpoint(sumsubStatusPath(APPLICANT_ID)), `https://api.sumsub.com/resources/applicants/${APPLICANT_ID}/status`, "a full URL is built from the path");
  expectEqual(SUMSUB_ACCESS_TOKEN_PATH, "/resources/accessTokens/sdk", "the documented access-token path");

  expectEqual(sumsubCreatePath(LEVEL), `/resources/applicants?levelName=${LEVEL}`, "the create path carries the level as a query");
  expectEqual(sumsubCreatePath(`  ${LEVEL}  `), `/resources/applicants?levelName=${LEVEL}`, "a padded level is trimmed before it is signed");
  expectEqual(sumsubCreatePath("a b"), "/resources/applicants?levelName=a%20b", "a level is encoded, not concatenated");
  expectEqual(sumsubCreatePath("a&b"), "/resources/applicants?levelName=a%26b", "an ampersand in a level cannot add a parameter");
  expectEqual(sumsubCreatePath("a?b"), "/resources/applicants?levelName=a%3Fb", "a question mark in a level cannot add a query");
  expectEqual(sumsubStatusPath(APPLICANT_ID), `/resources/applicants/${APPLICANT_ID}/status`, "the documented review-status path");
  expectEqual(sumsubStatusPath(` ${APPLICANT_ID} `), `/resources/applicants/${APPLICANT_ID}/status`, "a padded id is trimmed");
  expectEqual(sumsubStepsPath(APPLICANT_ID), `/resources/applicants/${APPLICANT_ID}/requiredIdDocsStatus`, "the documented per-step path");
  expectEqual(sumsubExistencePath(SESSION_UUID), `/resources/applicants/-/byExternalUserId/${SESSION_UUID}`, "the documented existence path");
  expectEqual(sumsubExistencePath("kd session/1"), "/resources/applicants/-/byExternalUserId/kd%20session%2F1", "an external id is encoded");
  expectEqual(sumsubExistencePath("kd#1"), "/resources/applicants/-/byExternalUserId/kd%231", "a fragment marker is encoded");

  expectEqual(SUMSUB_ALLOWED_CALLS.length, 5, "five documented calls, and no more");
  const allowed: readonly (readonly [string, string])[] = [
    ["POST", sumsubCreatePath(LEVEL)],
    ["POST", SUMSUB_ACCESS_TOKEN_PATH],
    ["GET", sumsubStatusPath(APPLICANT_ID)],
    ["GET", sumsubStepsPath(APPLICANT_ID)],
    ["GET", sumsubExistencePath(SESSION_UUID)],
  ];
  for (const [method, path] of allowed) {
    expect(isSumsubCall(method, path) === true, `the allowlist admits ${method} ${path.replace(/[0-9a-z]{24}/u, "<id>")}`);
  }
  const refused: readonly (readonly [string, string])[] = [
    ["GET", `/resources/applicants/${APPLICANT_ID}`],
    ["GET", `/resources/applicants/${APPLICANT_ID}/one`],
    ["GET", `/resources/applicants/${APPLICANT_ID}/status/`],
    ["GET", `/resources/applicants/${APPLICANT_ID}/status?extra=1`],
    ["POST", `/resources/applicants/${APPLICANT_ID}/status`],
    ["GET", sumsubCreatePath(LEVEL)],
    ["POST", "/resources/applicants"],
    ["POST", `/resources/applicants?levelName=${LEVEL}&other=1`],
    ["POST", "/resources/accessTokens/app"],
    ["POST", "/resources/accessTokens"],
    ["GET", "/resources/accessTokens/sdk"],
    ["POST", `/resources/applicants/${APPLICANT_ID}/reset`],
    ["POST", `/resources/applicants/${APPLICANT_ID}/deactivate`],
    ["GET", `/resources/applicants/${APPLICANT_ID.toUpperCase()}/status`],
    ["GET", `/resources/applicants/${APPLICANT_ID.slice(1)}/status`],
    ["GET", `/resources/applicants/${APPLICANT_ID}0/status`],
    ["GET", `/resources/applicants/${APPLICANT_ID}-/status`],
    ["GET", "/resources/applicants/-/byExternalUserId/"],
    ["GET", "/resources/applicants/-/byExternalUserId/a/b"],
    ["GET", "/resources/applicants/-/byExternalUserId/a?x=1"],
    ["GET", `${SUMSUB_API_HOST}${sumsubStatusPath(APPLICANT_ID)}`],
    ["GET", "//api.sumsub.com/resources/applicants/x/status"],
    ["GET", "/resources/status"],
    ["DELETE", sumsubStatusPath(APPLICANT_ID)],
    ["PUT", sumsubStatusPath(APPLICANT_ID)],
  ];
  for (const [method, path] of refused) {
    expect(isSumsubCall(method, path) === false, `the allowlist refuses ${method} ${path.slice(0, 48)}`);
  }

  expectEqual(SUMSUB_REVIEW_STATUSES.length, 8, "eight documented review statuses");
  expectEqual(
    SUMSUB_REVIEW_STATUSES.join(","),
    "init,pending,prechecked,queued,completed,onHold,awaitingService,awaitingUser",
    "the statuses are exactly the documentation's, in its order",
  );
  for (const status of SUMSUB_REVIEW_STATUSES) {
    expect(isSumsubReviewStatus(status) === true, `${status} is a review status`);
    expect(status.trim() === status, `${status} carries no surrounding space`);
    expect(status.includes(" ") === false, `${status} is one token`);
  }
  for (const notAStatus of ["", "Completed", "completed ", " completed", "onhold", "on_hold", "approved", "GREEN", "awaiting", "onHold "]) {
    expect(isSumsubReviewStatus(notAStatus) === false, `"${notAStatus}" is not a review status`);
  }
  expect(isSumsubReviewStatus("onHold") === true, "onHold is camel case and exact");
  expect(isSumsubReviewStatus("awaitingService") === true, "awaitingService is exact");
  expect(isSumsubReviewStatus("awaitingUser") === true, "awaitingUser is exact");

  expectEqual(SUMSUB_REVIEW_ANSWERS.length, 2, "two documented review answers");
  expectEqual(SUMSUB_REVIEW_ANSWERS.join(","), "GREEN,RED", "the answers are upper case, as documented");
  expect(isSumsubReviewAnswer("GREEN") === true, "GREEN is an answer");
  expect(isSumsubReviewAnswer("RED") === true, "RED is an answer");
  for (const notAnAnswer of ["green", "Green", "GREEN ", "APPROVED", "", "red"]) {
    expect(isSumsubReviewAnswer(notAnAnswer) === false, `"${notAnAnswer}" is not a review answer`);
  }

  for (const step of ["IDENTITY", "IDENTITY2", "IDENTITY3", "IDENTITY4", "SELFIE", "SELFIE2", "PROOF_OF_RESIDENCE", "QUESTIONNAIRE", "APPLICANT_DATA", "COMPANY"]) {
    expect((SUMSUB_STEP_TYPES as readonly string[]).includes(step), `${step} is a documented step`);
  }
  expectEqual(SUMSUB_IDENTITY_STEPS.length, 4, "four identity steps");
  expectEqual(SUMSUB_SELFIE_STEPS.length, 2, "two selfie steps");
  expect((SUMSUB_STEP_TYPES as readonly string[]).includes("PROOF_OF_RESIDENCE2"), "the second address step is documented");
  expect((SUMSUB_STEP_TYPES as readonly string[]).includes("QUESTIONNAIRE2"), "the second questionnaire step is documented");

  expectEqual(SUMSUB_DOCUMENT_TYPES["PASSPORT"], "passport", "a passport is a passport");
  expectEqual(SUMSUB_DOCUMENT_TYPES["ID_CARD"], "national_id", "an ID card is a national id");
  expectEqual(SUMSUB_DOCUMENT_TYPES["RESIDENCE_PERMIT"], "residence_permit", "a residence permit is a residence permit");
  expectEqual(Object.keys(SUMSUB_DOCUMENT_TYPES).length, 3, "only the three document types the pages read here name");
  expect(SUMSUB_DOCUMENT_TYPES["UTILITY_BILL"] === undefined, "a utility bill is not stretched into a document kind");
  expect(SUMSUB_DOCUMENT_TYPES["DRIVERS"] === undefined, "a code this file has not read is not mapped");
  for (const [type, kind] of Object.entries(SUMSUB_DOCUMENT_TYPES)) {
    expect((SUPPLEMENTARY_IDV_DOCUMENT_KINDS as readonly string[]).includes(kind), `${type} maps into STEP 170's document kinds`);
  }

  expectEqual(Object.keys(SUMSUB_REJECT_LABEL_REASONS).length, 1, "one rejection label has a neutral reason");
  expectEqual(SUMSUB_REJECT_LABEL_REASONS["UNSATISFACTORY_PHOTOS"], "document_unreadable", "an unsatisfactory photo is unreadable");
  expect(SUMSUB_REJECT_LABEL_REASONS["FORGERY"] === undefined, "forgery is not stretched into a neutral reason");
  expect(SUMSUB_REJECT_LABEL_REASONS["GRAPHIC_EDITOR"] === undefined, "an edited image is not stretched into a neutral reason");
  for (const reason of Object.values(SUMSUB_REJECT_LABEL_REASONS)) {
    expect((SUPPLEMENTARY_IDV_REASON_CODES as readonly string[]).includes(reason), `${reason} is STEP 170's reason`);
  }

  expect(SUMSUB_APPLICANT_ID_PATTERN.test(APPLICANT_ID) === true, "the documented example id is an applicant id");
  expect(isSumsubApplicantId(APPLICANT_ID) === true, "a 24 character id is accepted");
  expect(isSumsubApplicantId(` ${APPLICANT_ID} `) === true, "a padded id is accepted after trimming");
  expect(isSumsubApplicantId(APPLICANT_ID.slice(0, 23)) === false, "a 23 character id is refused");
  expect(isSumsubApplicantId(`${APPLICANT_ID}0`) === false, "a 25 character id is refused");
  expect(isSumsubApplicantId(APPLICANT_ID.toUpperCase()) === false, "an upper-case id is refused, because the documentation says lower case");
  expect(isSumsubApplicantId("5b594ade-0a97-5a36-c934-9e6600000000") === false, "a UUID is not an applicant id");
  expect(isSumsubApplicantId("") === false, "an empty string is not an applicant id");
  expect(isSumsubApplicantId("5b594ade0a975a36c9349e6!") === false, "an id with punctuation is refused");
  expect(isSumsubApplicantId("5b594ade0a975a36c9349e6z") === true, "a lower-case letter anywhere in the id is accepted");

  expectEqual(SUMSUB_EXTERNAL_USER_ID_MAXIMUM_LENGTH, 512, "the documented external id bound");
  expect(SUMSUB_TIMESTAMP_TOLERANCE_SECONDS === 60, "the documented one-minute clock window");
  expect(SUMSUB_ACCESS_TOKEN_DEFAULT_TTL_SECONDS === 600, "the documented default token life");
  expect(SUMSUB_ACCESS_TOKEN_MAXIMUM_TTL_SECONDS > SUMSUB_ACCESS_TOKEN_DEFAULT_TTL_SECONDS, "the platform's ceiling is above the default");
  expect(SUMSUB_APP_TOKEN_MAXIMUM_LENGTH >= 8, "the app-token bound admits a real token");
  expect(SUMSUB_SECRET_KEY_MAXIMUM_LENGTH >= 8, "the secret bound admits a real secret");
  expectEqual(SUMSUB_VENDOR_KEY, "sumsub", "the vendor key is spelled once");
}

/* ---- 2: the credential, and the prefix that is not a mode ---- */

function checkCredential(): void {
  expect(validateSumsubCredential(CREDENTIAL) === null, "a plausible pair is usable");
  expectEqual(sumsubCredentialTextOf(CREDENTIAL), `{"appToken":"${APP_TOKEN}","secretKey":"${SECRET_KEY}"}`, "the sealed text is JSON with no spaces");
  expect(/\s/u.test(sumsubCredentialTextOf(CREDENTIAL)) === false, "the sealed text carries no whitespace, which STEP 170 refuses");
  expect(sumsubCredentialTextOf(CREDENTIAL).length < 512, "the sealed text fits STEP 170's credential bound");
  expect(sumsubCredentialTextOf(CREDENTIAL).includes("\n") === false, "the sealed text is one line");

  const roundTrip = sumsubCredentialOf(sumsubCredentialTextOf(CREDENTIAL));
  expect(roundTrip !== null, "the sealed text reads back");
  expectEqual(roundTrip?.appToken, APP_TOKEN, "the app token survives the round trip");
  expectEqual(roundTrip?.secretKey, SECRET_KEY, "the secret survives the round trip");

  const prefixed: SumsubCredential = { appToken: `sbx:${APP_TOKEN}`, secretKey: SECRET_KEY };
  expect(validateSumsubCredential(prefixed) === null, "an app token with a colon is opaque text, not a mode");
  expectEqual(sumsubCredentialOf(sumsubCredentialTextOf(prefixed))?.appToken, `sbx:${APP_TOKEN}`, "a prefixed token is carried verbatim");
  const productionPrefixed: SumsubCredential = { appToken: `prd:${APP_TOKEN}`, secretKey: SECRET_KEY };
  expect(validateSumsubCredential(productionPrefixed) === null, "a production-prefixed token is accepted too");
  expectEqual(sumsubCredentialTextOf(productionPrefixed).includes("live"), false, "no mode word is written into the sealed text");
  expectEqual(sumsubCredentialTextOf(prefixed).includes("sandbox"), false, "a sandbox-prefixed token does not become the word sandbox");

  const bad: readonly (readonly [SumsubCredential, string])[] = [
    [{ appToken: "", secretKey: SECRET_KEY }, "an empty app token is refused"],
    [{ appToken: APP_TOKEN, secretKey: "" }, "an empty secret is refused"],
    [{ appToken: "   ", secretKey: SECRET_KEY }, "a whitespace app token is refused"],
    [{ appToken: "short", secretKey: SECRET_KEY }, "an implausibly short app token is refused"],
    [{ appToken: APP_TOKEN, secretKey: "short" }, "an implausibly short secret is refused"],
    [{ appToken: `${APP_TOKEN} ${SECRET_KEY}`, secretKey: SECRET_KEY }, "an embedded space in an app token is refused"],
    [{ appToken: APP_TOKEN, secretKey: `${SECRET_KEY.slice(0, 8)}\n${SECRET_KEY.slice(8)}` }, "an embedded newline in a secret is refused"],
    [{ appToken: "a".repeat(SUMSUB_APP_TOKEN_MAXIMUM_LENGTH + 1), secretKey: SECRET_KEY }, "an over-long app token is refused"],
    [{ appToken: APP_TOKEN, secretKey: "s".repeat(SUMSUB_SECRET_KEY_MAXIMUM_LENGTH + 1) }, "an over-long secret is refused"],
    [{ appToken: `a\u0001${APP_TOKEN}`, secretKey: SECRET_KEY }, "a control character in a token is refused"],
  ];
  for (const [credential, name] of bad) {
    expect(validateSumsubCredential(credential) !== null, name);
    expect(sumsubCredentialOf(sumsubCredentialTextOf(credential)) === null, `${name} (and the round trip refuses it)`);
  }

  for (const text of ["", "  ", "not json", "null", "[]", "42", '{"appToken":"x"}', '{"secretKey":"y"}', '{"appToken":1,"secretKey":2}', "{}"]) {
    expect(sumsubCredentialOf(text) === null, `"${text.slice(0, 24)}" is not a credential`);
  }
  const withExtra = sumsubCredentialOf(JSON.stringify({ appToken: APP_TOKEN, secretKey: SECRET_KEY, extra: "kept out" }));
  expect(withExtra !== null, "an extra field does not break the credential");
  expectEqual(Object.keys(withExtra ?? {}).length, 2, "an extra field is not carried into the credential");
  expect(sumsubCredentialOf("x".repeat(2_001)) === null, "an over-long text is refused before it is parsed");
}

/* ---- 3: the encrypted configuration, its activation, and the mode rule ---- */

async function checkConfiguration(): Promise<void> {
  const store = new InMemorySupplementaryIdvConfigStore();
  const audits: SumsubConfigAuditEntry[] = [];
  const created = createSumsubConfiguration(
    { companyId: COMPANY, environment: "live", credential: CREDENTIAL, webhookSecret: "sumsub_webhook_secret_for_the_gate_0001", occurredAtEpochMs: NOW },
    { configStore: store, keyring, recordAudit: (entry) => audits.push(entry) },
  );
  expectEqual(created.status, "configured", "a plausible configuration is sealed");
  if (created.status !== "configured") return;
  expectEqual(created.config.status, "pending_activation", "a new configuration waits for its activation test");
  expectEqual(created.config.version, 1, "a new configuration starts at version 1");
  expectEqual(created.config.vendorKey, "sumsub", "the configuration is a Sumsub one");
  expectEqual(created.config.environment, "live", "the mode is the declared one");
  expectEqual(created.config.companyId, COMPANY, "the configuration belongs to the company");
  expect(created.config.credentialSealed.length > 20, "the credential is sealed rather than stored");
  expect(created.config.credentialSealed.includes(APP_TOKEN) === false, "the app token is not in the sealed field");
  expect(created.config.credentialSealed.includes(SECRET_KEY) === false, "the secret is not in the sealed field");
  expect(created.config.webhookSecretSealed !== null, "the delivery secret is sealed too");
  expect(created.config.webhookSecretSealed?.includes("sumsub_webhook_secret") === false, "the delivery secret is not in the sealed field");
  expectEqual(audits.length, 1, "one audit entry for the configuration");
  expectEqual(audits[0]?.action, "sumsub_idv.configured", "the audit action names the configuration");
  expectEqual(store.findById(created.config.id)?.status, "pending_activation", "the row is stored as waiting");

  const refusedCredential = createSumsubConfiguration(
    { companyId: COMPANY, environment: "live", credential: { appToken: "", secretKey: SECRET_KEY }, webhookSecret: null, occurredAtEpochMs: NOW },
    { configStore: new InMemorySupplementaryIdvConfigStore(), keyring },
  );
  expectEqual(refusedCredential.status, "failed", "an empty app token is refused before sealing");
  const anonymous = createSumsubConfiguration(
    { companyId: "  ", environment: "live", credential: CREDENTIAL, webhookSecret: null, occurredAtEpochMs: NOW },
    { configStore: new InMemorySupplementaryIdvConfigStore(), keyring },
  );
  expectEqual(anonymous.status, "failed", "a configuration without a company is refused");

  // Activation: one signed read that creates nothing.
  const probe = new ScriptedTransport([ok(existenceBody(false), 200)]);
  const activated = await activateSumsubConfiguration(created.config.id, {
    configStore: store,
    keyring,
    occurredAtEpochMs: NOW,
    transport: probe.call,
    recordAudit: (entry) => audits.push(entry),
  });
  expectEqual(activated.status, "activated", "a signed read with a false existence answer activates the pair");
  expectEqual(store.findById(created.config.id)?.status, "active", "the stored row becomes active");
  expectEqual(store.findById(created.config.id)?.version, 2, "activation moves the row one version");
  expectEqual(probe.calls.length, 1, "activation is one call");
  expectEqual(probe.calls[0]?.method, "GET", "activation reads rather than writes");
  expect(probe.calls.every((call) => call.method === "GET"), "activation creates nothing");
  expect(probe.calls[0]?.path.startsWith("/resources/applicants/-/byExternalUserId/kd-probe-") === true, "the probe asks about an id that cannot exist");
  expect(probe.calls[0]?.path.includes(SESSION_UUID) === false, "the probe does not reuse a real external id");
  expectEqual(probe.calls[0]?.appToken, APP_TOKEN, "the probe carries the app token");
  expect(/^[0-9a-f]{64}$/u.test(probe.calls[0]?.signature ?? ""), "the probe is signed with a lower-case hex digest");
  expectEqual(probe.calls[0]?.timestampSeconds, NOW_SECONDS, "the probe's timestamp is the clock's seconds");
  expectEqual(audits.filter((entry) => entry.action === "sumsub_idv.activation_tested").length, 1, "the activation test is audited");
  expectEqual(audits.filter((entry) => entry.action === "sumsub_idv.activated").length, 1, "the activation is audited");
  expectEqual(audits[audits.length - 1]?.action, "sumsub_idv.activated", "the last audit entry is the activation");

  const activatedAgain = await activateSumsubConfiguration(created.config.id, { configStore: store, keyring, occurredAtEpochMs: NOW });
  expectEqual(activatedAgain.status, "activated", "an active configuration answers without a call");
  if (activatedAgain.status === "activated") expectEqual(activatedAgain.config.version, 2, "an already-active configuration is not moved again");

  // Every answer that does not prove the pair leaves it waiting.
  const unproven: readonly (readonly [SumsubAnswer | Error, string])[] = [
    [ok('{"description":"Request signature mismatch","code":401,"errorCode":4003,"errorName":"app-token-signature mismatch"}', 401), "a 401 is a refusal"],
    [ok('{"description":"Access denied","code":403}', 403), "a 403 is a refusal"],
    [ok("", 429), "a 429 leaves the pair unproved"],
    [ok("", 500), "a 500 leaves the pair unproved"],
    [ok("", 302), "a redirect proves nothing"],
    [ok("not json", 200), "an unreadable answer proves nothing"],
    [ok('{"exists":"yes"}', 200), "an answer without a boolean proves nothing"],
    [ok('{"exists":false}', 400), "a 400 leaves the pair unproved"],
    [new Error("network down"), "a thrown call leaves the pair unproved"],
  ];
  for (const [answer, name] of unproven) {
    const fresh = configuredStore({ status: "pending_activation" });
    const transport = new ScriptedTransport([answer]);
    const result = await activateSumsubConfiguration(fresh.config.id, {
      configStore: fresh.store,
      keyring,
      occurredAtEpochMs: NOW,
      transport: transport.call,
    });
    expectEqual(result.status, "refused", name);
    expectEqual(fresh.store.findById(fresh.config.id)?.status, "pending_activation", `${name} (and the row keeps waiting)`);
  }

  // A found applicant is proof too: the pair authenticated and read a real record.
  const foundStore = configuredStore({ status: "pending_activation" });
  const foundTransport = new ScriptedTransport([ok(existenceBody(true), 200)]);
  const found = await activateSumsubConfiguration(foundStore.config.id, {
    configStore: foundStore.store,
    keyring,
    occurredAtEpochMs: NOW,
    transport: foundTransport.call,
  });
  expectEqual(found.status, "activated", "a found applicant also proves the pair");

  // A keyring that did not seal the row cannot activate it.
  const foreign = configuredStore({ ring: otherKeyring, status: "pending_activation" });
  const foreignResult = await activateSumsubConfiguration(foreign.config.id, {
    configStore: foreign.store,
    keyring,
    occurredAtEpochMs: NOW,
  });
  expectEqual(foreignResult.status, "failed", "another keyring cannot open the configuration");

  const wrongVendor = configuredStore({ vendorKey: "didit", status: "pending_activation" });
  const wrongVendorResult = await activateSumsubConfiguration(wrongVendor.config.id, {
    configStore: wrongVendor.store,
    keyring,
    occurredAtEpochMs: NOW,
  });
  expectEqual(wrongVendorResult.status, "refused", "a Didit configuration is not activated as Sumsub");

  const retired = configuredStore({ status: "retired" });
  const retiredResult = await activateSumsubConfiguration(retired.config.id, {
    configStore: retired.store,
    keyring,
    occurredAtEpochMs: NOW,
  });
  expectEqual(retiredResult.status, "failed", "a retired configuration is not activated");

  expectEqual(
    (await activateSumsubConfiguration("cfg_absent", { configStore: store, keyring, occurredAtEpochMs: NOW })).status,
    "failed",
    "an unknown configuration id is refused",
  );

  // One active vendor per company and mode.
  const shared = configuredStore({ status: "pending_activation" });
  const competitor = sealSupplementaryIdvConfig(
    { companyId: COMPANY, vendorKey: "didit", environment: "live", credential: "didit_gate_key_for_the_crosscheck_0001", webhookSecret: null },
    keyring,
  );
  if ("reason" in competitor) throw new Error(competitor.reason);
  shared.store.insert({
    id: "cfg_didit_0001",
    companyId: COMPANY,
    vendorKey: "didit",
    environment: "live",
    status: "pending_activation",
    credentialSealed: competitor.credentialSealed,
    webhookSecretSealed: null,
    version: 1,
    createdAtEpochMs: NOW,
    updatedAtEpochMs: NOW,
  });
  expect(shared.store.save({ ...(shared.store.findById("cfg_didit_0001") as SupplementaryIdvConfig), status: "active", version: 2 }, 1) === true, "the competing vendor is active");
  const blocked = await activateSumsubConfiguration(shared.config.id, {
    configStore: shared.store,
    keyring,
    occurredAtEpochMs: NOW,
  });
  expectEqual(blocked.status, "refused", "a second vendor in the same mode is refused");

  // A configuration in the other mode is a different decision.
  const otherModeStore = new InMemorySupplementaryIdvConfigStore();
  const sandbox = createSumsubConfiguration(
    { companyId: COMPANY, environment: "sandbox", credential: CREDENTIAL, webhookSecret: null, occurredAtEpochMs: NOW },
    { configStore: otherModeStore, keyring },
  );
  if (sandbox.status !== "configured") throw new Error(sandbox.reason);
  const liveActive = createSumsubConfiguration(
    { companyId: COMPANY, environment: "live", credential: CREDENTIAL, webhookSecret: null, occurredAtEpochMs: NOW },
    { configStore: otherModeStore, keyring },
  );
  if (liveActive.status !== "configured") throw new Error(liveActive.reason);
  const liveProbe = new ScriptedTransport([ok(existenceBody(false), 200)]);
  expectEqual(
    (await activateSumsubConfiguration(liveActive.config.id, { configStore: otherModeStore, keyring, occurredAtEpochMs: NOW, transport: liveProbe.call })).status,
    "activated",
    "the live configuration activates",
  );
  const sandboxProbe = new ScriptedTransport([ok(existenceBody(false), 200)]);
  expectEqual(
    (await activateSumsubConfiguration(sandbox.config.id, { configStore: otherModeStore, keyring, occurredAtEpochMs: NOW, transport: sandboxProbe.call })).status,
    "activated",
    "a sandbox configuration is not blocked by a live one",
  );
}

/* ---- 4: the signature, which is the whole authentication ---- */

function checkSignature(): void {
  const documentedBody = '{"ttlInSecs": 600, "userId": "johndoeID", "levelName": "basic-kyc-level"}';
  const documented = sumsubSignaturePayloadOf(1607551635, "POST", "/resources/accessTokens/sdk", documentedBody);
  expectEqual(
    documented,
    `1607551635POST/resources/accessTokens/sdk${documentedBody}`,
    "the signed bytes are the documentation's example, timestamp then method then uri then body",
  );
  expect(documented.startsWith("1607551635") === true, "the timestamp comes first");
  expect(documented.includes("POST") === true, "the method is upper case");
  expect(documented.endsWith(documentedBody) === true, "the body is the last part, exactly as sent");

  expectEqual(sumsubSignaturePayloadOf(1607551635, "post", "/x", null), "1607551635POST/x", "a lower-case method becomes upper case");
  expectEqual(sumsubSignaturePayloadOf(1607551635, "GET", "/x", null), sumsubSignaturePayloadOf(1607551635, "GET", "/x", ""), "no body and an empty body sign the same bytes, and a GET has no body");
  expectEqual(sumsubSignaturePayloadOf(1607551635, "GET", "/resources/applicants/5b594ade0a975a36c9349e66?fields=info", null), "1607551635GET/resources/applicants/5b594ade0a975a36c9349e66?fields=info", "the query is part of the signed uri");
  expectEqual(sumsubSignaturePayloadOf(1607551635, "POST", sumsubCreatePath("lvl"), '{"externalUserId":"x"}'), `1607551635POST${sumsubCreatePath("lvl")}{"externalUserId":"x"}`, "a create path with its query is signed whole");
  expectEqual(sumsubSignaturePayloadOf(1607551635.9, "GET", "/x", null), "1607551635GET/x", "a fractional timestamp is truncated");
  expectThrows(() => sumsubSignaturePayloadOf(0.5, "GET", "/x", null), "a sub-second timestamp becomes zero, which is refused");
  expectThrows(() => sumsubSignaturePayloadOf(0, "GET", "/x", null), "a zero timestamp is refused");
  expectThrows(() => sumsubSignaturePayloadOf(-1, "GET", "/x", null), "a negative timestamp is refused");
  expectThrows(() => sumsubSignaturePayloadOf(Number.NaN, "GET", "/x", null), "a NaN timestamp is refused");
  expectThrows(() => sumsubSignaturePayloadOf(1607551635, "GET", "resources/x", null), "a uri without a leading slash is refused");

  const signature = sumsubSignatureOf(SECRET_KEY, NOW_SECONDS, "GET", sumsubStatusPath(APPLICANT_ID), null);
  expectEqual(signature.length, 64, "the signature is a SHA-256 digest in hex");
  expect(/^[0-9a-f]{64}$/u.test(signature), "the signature is lower-case hex, as the documentation says");
  expect(signature === signature.toLowerCase(), "the signature carries no upper-case hex");
  expectEqual(signature, sumsubSignatureOf(SECRET_KEY, NOW_SECONDS, "GET", sumsubStatusPath(APPLICANT_ID), null), "signing is deterministic");
  expectEqual(signature, sumsubSignatureOf(` ${SECRET_KEY} `, NOW_SECONDS, "GET", sumsubStatusPath(APPLICANT_ID), null), "a padded secret signs the same");

  const independent = createHmac("sha256", SECRET_KEY)
    .update(`${NOW_SECONDS}GET${sumsubStatusPath(APPLICANT_ID)}`, "utf8")
    .digest("hex");
  expectEqual(signature, independent, "the signature is HMAC-SHA256 over exactly the documented bytes");
  const independentPost = createHmac("sha256", SECRET_KEY)
    .update(`${NOW_SECONDS}POST${sumsubCreatePath(LEVEL)}{"externalUserId":"${SESSION_UUID}"}`, "utf8")
    .digest("hex");
  expectEqual(
    sumsubSignatureOf(SECRET_KEY, NOW_SECONDS, "POST", sumsubCreatePath(LEVEL), `{"externalUserId":"${SESSION_UUID}"}`),
    independentPost,
    "a signed create body is signed byte for byte",
  );

  expect(sumsubSignatureOf(SECRET_KEY, NOW_SECONDS + 1, "GET", sumsubStatusPath(APPLICANT_ID), null) !== signature, "a different timestamp is a different signature");
  expect(sumsubSignatureOf(`${SECRET_KEY}x`, NOW_SECONDS, "GET", sumsubStatusPath(APPLICANT_ID), null) !== signature, "a different secret is a different signature");
  expect(sumsubSignatureOf(SECRET_KEY, NOW_SECONDS, "POST", sumsubStatusPath(APPLICANT_ID), null) !== signature, "a different method is a different signature");
  expect(sumsubSignatureOf(SECRET_KEY, NOW_SECONDS, "GET", sumsubStepsPath(APPLICANT_ID), null) !== signature, "a different path is a different signature");
  expect(sumsubSignatureOf(SECRET_KEY, NOW_SECONDS, "GET", `${sumsubStatusPath(APPLICANT_ID)}?x=1`, null) !== signature, "a different query is a different signature");
  expect(sumsubSignatureOf(SECRET_KEY, NOW_SECONDS, "GET", sumsubStatusPath(APPLICANT_ID), " ") !== signature, "a different body is a different signature");
  expectThrows(() => sumsubSignatureOf("", NOW_SECONDS, "GET", "/x", null), "an empty secret cannot sign");
  expectThrows(() => sumsubSignatureOf("   ", NOW_SECONDS, "GET", "/x", null), "a whitespace secret cannot sign");

  const request = sumsubRequestOf(CREDENTIAL, { method: "GET", path: sumsubStatusPath(APPLICANT_ID), body: null, occurredAtEpochMs: NOW });
  expectEqual(request.method, "GET", "the request carries its method");
  expectEqual(request.path, sumsubStatusPath(APPLICANT_ID), "the request carries its path exactly");
  expectEqual(request.body, null, "a GET carries no body");
  expectEqual(request.appToken, APP_TOKEN, "the app token is the credential's");
  expectEqual(request.timestampSeconds, NOW_SECONDS, "the timestamp is the clock's seconds, not milliseconds");
  expectEqual(request.signature, sumsubSignatureOf(SECRET_KEY, NOW_SECONDS, "GET", sumsubStatusPath(APPLICANT_ID), null), "the request carries the documented signature");
  expectEqual(request.signature.length, 64, "the request signature is 64 hex characters");

  const padded = sumsubRequestOf({ appToken: `  ${APP_TOKEN}  `, secretKey: SECRET_KEY }, { method: "POST", path: SUMSUB_ACCESS_TOKEN_PATH, body: "{}", occurredAtEpochMs: NOW });
  expectEqual(padded.appToken, APP_TOKEN, "a padded app token is trimmed before it is sent");
  expectEqual(padded.signature, sumsubSignatureOf(SECRET_KEY, NOW_SECONDS, "POST", SUMSUB_ACCESS_TOKEN_PATH, "{}"), "the trimmed token does not change the signature");
  expectEqual(padded.body, "{}", "the body is carried as the exact string");
  expectEqual(Object.keys(padded).length, 6, "a request is method, path, body, app token, timestamp and signature and nothing else");
}

/* ---- 5: the request this platform builds ---- */

function checkRequest(): void {
  expect(validateSumsubSessionInput(SESSION_INPUT) === null, "a plausible level name is usable");
  for (const level of [LEVEL, "lvl_1", "lvl.1", "Lvl-1", "a".repeat(200)]) {
    expect(validateSumsubSessionInput({ sessionId: SESSION_UUID, levelName: level }) === null, `"${level.slice(0, 12)}" is a level name`);
  }
  for (const level of ["", "   ", "lvl one", "lvl/one", "lvl?one", "lvl&one", "lvl:one", "lvl\u00e9", "a".repeat(201)]) {
    expect(validateSumsubSessionInput({ sessionId: SESSION_UUID, levelName: level }) !== null, `"${level.slice(0, 12)}" is not a level name this platform sends`);
  }
  expect(validateSumsubSessionInput({ sessionId: SESSION_UUID, levelName: ` ${LEVEL} ` }) === null, "a padded level name is usable");

  expectEqual(sumsubExternalUserIdOf(SESSION_UUID), SESSION_UUID, "the session id is the external user id");
  expectEqual(sumsubExternalUserIdOf(`  ${SESSION_UUID}  `), SESSION_UUID, "a padded session id is trimmed");
  expectEqual(sumsubExternalUserIdOf("x".repeat(600)).length, SUMSUB_EXTERNAL_USER_ID_MAXIMUM_LENGTH, "an over-long identifier is cut to the documented bound");
  expectEqual(sumsubExternalUserIdOf(""), "", "an empty identifier stays empty, and is refused elsewhere");
  expect(validateSumsubSessionInput({ sessionId: "", levelName: LEVEL }) !== null, "a session without an id is refused");

  const body = buildSumsubApplicantBody({ sessionId: SESSION_UUID });
  expectEqual(JSON.stringify(body), `{"externalUserId":"${SESSION_UUID}"}`, "the create body is one field");
  expectEqual(Object.keys(body).length, 1, "no name, date of birth, document or address is ever sent");
  const bodyText = JSON.stringify(body);
  for (const personal of ["firstName", "lastName", "dateOfBirth", "dob", "idDoc", "documentNumber", "email", "phone", "address", "selfie", "fixedInfo", "info"]) {
    expect(bodyText.includes(personal) === false, `the create body carries no ${personal}`);
  }
  expectEqual(buildSumsubApplicantBody({ sessionId: ` ${SESSION_UUID} ` }).externalUserId, SESSION_UUID, "a padded session id is trimmed in the body");
}

/* ---- 6: opening a session, and the calls it makes ---- */

async function checkOpen(): Promise<void> {
  const createdAnswer = parseSumsubApplicantAnswer(201, createBody());
  expectEqual(createdAnswer.outcome, "created", "a 201 with a 24 character id is an applicant");
  if (createdAnswer.outcome === "created") expectEqual(createdAnswer.reviewStatus, "init", "a new applicant starts init");
  expectEqual(parseSumsubApplicantAnswer(409, '{"description":"already exists"}').outcome, "duplicate", "a 409 is a duplicate");
  expectEqual(parseSumsubApplicantAnswer(400, "{}").outcome, "refused", "a 400 is a refusal");
  expectEqual(parseSumsubApplicantAnswer(422, "{}").outcome, "refused", "a 422 is a refusal");
  expectEqual(parseSumsubApplicantAnswer(401, "{}").outcome, "failed", "a 401 is a configuration defect");
  expectEqual(parseSumsubApplicantAnswer(403, "{}").outcome, "failed", "a 403 is a configuration defect");
  expectEqual(parseSumsubApplicantAnswer(404, "{}").outcome, "failed", "a 404 on the create path is a configuration defect");
  expectEqual(parseSumsubApplicantAnswer(429, "{}").outcome, "unknown", "a 429 is unknown");
  expectEqual(parseSumsubApplicantAnswer(500, "{}").outcome, "unknown", "a 500 is unknown");
  expectEqual(parseSumsubApplicantAnswer(302, "{}").outcome, "unknown", "a redirect is unknown");
  expectEqual(parseSumsubApplicantAnswer(201, createBody({ review: undefined })).outcome, "created", "an answer without a review is still an applicant");
  expectEqual(parseSumsubApplicantAnswer(201, createBody({ type: undefined })).outcome, "created", "an answer without a type is still an applicant");
  expectEqual(parseSumsubExistenceAnswer(200, existenceBody(false)).outcome, "absent", "a false existence answer is absent");
  const foundAnswer = parseSumsubExistenceAnswer(200, existenceBody(true, SECOND_APPLICANT_ID));
  expectEqual(foundAnswer.outcome, "found", "a true existence answer is found");
  if (foundAnswer.outcome === "found") expectEqual(foundAnswer.applicantId, SECOND_APPLICANT_ID, "the found applicant id is read");
  expectEqual(parseSumsubExistenceAnswer(401, "{}").outcome, "failed", "a 401 on the lookup is a configuration defect");
  expectEqual(parseSumsubExistenceAnswer(500, "{}").outcome, "unknown", "a 500 on the lookup is unknown");
  expectEqual(parseSumsubExistenceAnswer(200, '{"exists":true}').outcome, "unknown", "an existence answer without an applicant is unknown");
  expectEqual(parseSumsubExistenceAnswer(200, '{"exists":true,"applicant":{"id":"x"}}').outcome, "unknown", "an existence answer with a bad id is unknown");
  expectEqual(
    sumsubProblemDetailOf('{"description":"Request signature mismatch","code":401,"errorCode":4003,"errorName":"app-token-signature mismatch"}'),
    "Request signature mismatch (app-token-signature mismatch)",
    "a failure carries Sumsub's own words, bounded",
  );
  expectEqual(sumsubProblemDetailOf('{"code":401}'), "", "a failure without words is empty rather than invented");
  expectEqual(sumsubProblemDetailOf("not json"), "", "an unreadable failure is empty");

  const store = configuredStore();
  const session = openedSession(store.config);
  const transport = new ScriptedTransport([ok(createBody(), 201)]);
  const opened = await openSumsubSession({ ...SESSION_INPUT, sessionId: session.session.id }, optionsWith(transport.call, store.store, session.store));
  expectEqual(opened.status, "opened", "a created applicant opens the session");
  if (opened.status !== "opened") return;
  expectEqual(opened.reconciled, false, "a first create is not a reconciliation");
  expectEqual(opened.opened.reference, APPLICANT_ID, "the applicant id is the stored reference");
  expectEqual(opened.opened.session.result, "in_progress", "an applicant that was just created is in progress");
  expectEqual(opened.opened.session.reference, APPLICANT_ID, "the row holds the reference");
  expectEqual(opened.opened.session.version, 2, "the row moves one version");
  expectEqual(session.store.findById(session.session.id)?.reference, APPLICANT_ID, "the stored row carries the reference");
  expectEqual(session.store.findById(session.session.id)?.result, "in_progress", "the stored row is in progress");
  expectEqual(transport.calls.length, 1, "opening is one create call");
  expectEqual(transport.calls[0]?.method, "POST", "opening creates rather than reads");
  expectEqual(transport.calls[0]?.path, sumsubCreatePath(LEVEL), "the create path carries the level");
  expectEqual(transport.calls[0]?.appToken, APP_TOKEN, "the create call carries the app token");
  expect(/^[0-9a-f]{64}$/u.test(transport.calls[0]?.signature ?? ""), "the create call is signed");
  expectEqual(transport.calls[0]?.timestampSeconds, NOW_SECONDS, "the create call is stamped once");
  const sentBody = transport.calls[0]?.body ?? "";
  expectEqual(sentBody, JSON.stringify({ externalUserId: session.session.id }), "the create body names our own session id");
  expect(sentBody.includes("externalUserId") === true, "the body names the external user id");
  expect(bodyHasNoPersonalData(sentBody), "the create body carries no personal data");
  expectEqual(opened.opened.session.processorKybStatusSeen, "pending", "the processor snapshot is copied in, never written");

  // A duplicate is reconciled through the documented existence lookup.
  const duplicateStore = configuredStore();
  const duplicateSession = openedSession(duplicateStore.config);
  const duplicateTransport = new ScriptedTransport([
    ok('{"description":"Applicant with externalUserId already exists","code":409}', 409),
    ok(existenceBody(true, SECOND_APPLICANT_ID), 200),
  ]);
  const duplicate = await openSumsubSession({ ...SESSION_INPUT, sessionId: duplicateSession.session.id }, optionsWith(duplicateTransport.call, duplicateStore.store, duplicateSession.store));
  expectEqual(duplicate.status, "opened", "a duplicate applicant is reconciled rather than refused");
  if (duplicate.status === "opened") {
    expectEqual(duplicate.reconciled, true, "the reconciliation is reported");
    expectEqual(duplicate.opened.reference, SECOND_APPLICANT_ID, "the existing applicant is adopted");
  }
  expectEqual(duplicateTransport.calls.length, 2, "a reconciliation is a create and a lookup");
  expectEqual(duplicateTransport.calls[1]?.method, "GET", "the lookup is a read");
  expectEqual(duplicateTransport.calls[1]?.path, sumsubExistencePath(duplicateSession.session.id), "the lookup asks about our own identifier");
  expectEqual(duplicateTransport.calls[1]?.body, null, "the lookup carries no body");

  const absentLookup = new ScriptedTransport([ok('{"code":409}', 409), ok(existenceBody(false), 200)]);
  const absentStore = configuredStore();
  const absentSession = openedSession(absentStore.config);
  const absent = await openSumsubSession({ ...SESSION_INPUT, sessionId: absentSession.session.id }, optionsWith(absentLookup.call, absentStore.store, absentSession.store));
  expectEqual(absent.status, "failed", "a duplicate that the lookup cannot find is a failure");
  if (absent.status === "failed") expectEqual(absent.requiresReconciliation, true, "an unexplainable duplicate needs reconciliation");
  expectEqual(absentSession.store.findById(absentSession.session.id)?.reference, null, "the row keeps no reference");
  expectEqual(absentSession.store.findById(absentSession.session.id)?.version, 1, "the row does not move");

  const failedLookup = new ScriptedTransport([ok('{"code":409}', 409), ok("", 500)]);
  const failedLookupStore = configuredStore();
  const failedLookupSession = openedSession(failedLookupStore.config);
  const failedLookupResult = await openSumsubSession({ ...SESSION_INPUT, sessionId: failedLookupSession.session.id }, optionsWith(failedLookup.call, failedLookupStore.store, failedLookupSession.store));
  expectEqual(failedLookupResult.status, "failed", "a lookup that does not answer leaves the session failed");
  if (failedLookupResult.status === "failed") expectEqual(failedLookupResult.requiresReconciliation, true, "a failed lookup needs reconciliation");

  const outcomes: readonly (readonly [SumsubAnswer | Error, string, string, boolean])[] = [
    [ok('{"description":"Level not found","code":400,"errorName":"level-not-found"}', 400), "refused", "a 400 is a refusal", false],
    [ok('{"description":"Unauthorized","code":401}', 401), "failed", "a 401 is a configuration defect", false],
    [ok('{"description":"Forbidden","code":403}', 403), "failed", "a 403 is a configuration defect", false],
    [ok("", 422), "refused", "a 422 is a refusal", false],
    [ok("", 429), "failed", "a 429 leaves the outcome unknown", true],
    [ok("", 500), "failed", "a 500 leaves the outcome unknown", true],
    [ok("", 302), "failed", "a redirect leaves the outcome unknown", true],
    [new Error("socket hang up"), "failed", "a thrown call leaves the outcome unknown", true],
    [ok(createBody({ id: "not-an-applicant-id" }), 201), "failed", "an answer without a 24 character id is not an applicant", true],
    [ok(createBody({ type: "company" }), 201), "failed", "a company applicant is not a person's check", true],
    [ok("not json", 201), "failed", "an unreadable create answer is not an applicant", true],
  ];
  for (const [answer, status, name, reconciling] of outcomes) {
    const fresh = configuredStore();
    const row = openedSession(fresh.config);
    const one = new ScriptedTransport([answer]);
    const result = await openSumsubSession({ ...SESSION_INPUT, sessionId: row.session.id }, optionsWith(one.call, fresh.store, row.store));
    expectEqual(result.status, status, name);
    if (result.status === "failed") expectEqual(result.requiresReconciliation, reconciling, `${name} (reconciliation is ${String(reconciling)})`);
    expectEqual(row.store.findById(row.session.id)?.version, 1, `${name} (the row does not move)`);
  }

  const detailStore = configuredStore();
  const detailSession = openedSession(detailStore.config);
  const refusedDetail = await openSumsubSession({ ...SESSION_INPUT, sessionId: detailSession.session.id }, optionsWith(
    new ScriptedTransport([ok('{"description":"Level not found","errorName":"level-not-found"}', 400)]).call,
    detailStore.store,
    detailSession.store,
  ));
  expectEqual(refusedDetail.status === "refused" ? refusedDetail.reason.includes("Level not found") : false, true, "a refusal carries Sumsub's own words");

  // The guards before any call.
  const guardStore = configuredStore();
  const passingSession = openedSession(guardStore.config);
  const noSession = await openSumsubSession(SESSION_INPUT, optionsWith(new ScriptedTransport([]).call, guardStore.store, passingSession.store));
  expectEqual(noSession.status, "failed", "an unknown session is refused before any call");

  const wrongVendorConfig = configuredStore({ vendorKey: "didit" });
  const wrongVendorSession = openedSession(wrongVendorConfig.config);
  const wrongVendor = await openSumsubSession({ ...SESSION_INPUT, sessionId: wrongVendorSession.session.id }, optionsWith(new ScriptedTransport([]).call, wrongVendorConfig.store, wrongVendorSession.store));
  expectEqual(wrongVendor.status, "failed", "a Didit session is not opened as Sumsub");

  const mismatchConfig = configuredStore({ environment: "live" });
  const mismatchSession = openedSession(mismatchConfig.config, "sandbox");
  const mismatch = await openSumsubSession({ ...SESSION_INPUT, sessionId: mismatchSession.session.id }, optionsWith(new ScriptedTransport([]).call, mismatchConfig.store, mismatchSession.store));
  expectEqual(mismatch.status, "failed", "a session and its configuration must agree about the mode");

  const doneStore = configuredStore();
  const doneSession = openedSession(doneStore.config);
  doneSession.store.save({ ...doneSession.session, result: "passed", version: 2 }, 1);
  const done = await openSumsubSession({ ...SESSION_INPUT, sessionId: doneSession.session.id }, optionsWith(new ScriptedTransport([]).call, doneStore.store, doneSession.store));
  expectEqual(done.status, "failed", "a session that already ended is not opened again");

  const referencedStore = configuredStore();
  const referencedSession = openedSession(referencedStore.config);
  referencedSession.store.save({ ...referencedSession.session, reference: APPLICANT_ID, version: 2 }, 1);
  const referenced = await openSumsubSession({ ...SESSION_INPUT, sessionId: referencedSession.session.id }, optionsWith(new ScriptedTransport([]).call, referencedStore.store, referencedSession.store));
  expectEqual(referenced.status, "failed", "a session that already holds a reference is not opened twice");

  const missingConfigStore = configuredStore();
  const orphan = openedSession(missingConfigStore.config);
  const noConfig = await openSumsubSession({ ...SESSION_INPUT, sessionId: orphan.session.id }, {
    sessionStore: orphan.store,
    configStore: new InMemorySupplementaryIdvConfigStore(),
    keyring,
    occurredAtEpochMs: NOW,
    transport: new ScriptedTransport([]).call,
  });
  expectEqual(noConfig.status, "failed", "a session without its configuration is refused");

  const foreignKeyStore = configuredStore({ ring: otherKeyring });
  const foreignKeySession = openedSession(foreignKeyStore.config);
  const foreignKey = await openSumsubSession({ ...SESSION_INPUT, sessionId: foreignKeySession.session.id }, optionsWith(new ScriptedTransport([]).call, foreignKeyStore.store, foreignKeySession.store));
  expectEqual(foreignKey.status, "failed", "another keyring cannot open the credential for a call");

  const invalidInput = await openSumsubSession({ sessionId: SESSION_UUID, levelName: "lvl one" }, optionsWith(new ScriptedTransport([]).call, guardStore.store, passingSession.store));
  expectEqual(invalidInput.status, "failed", "an unusable level name is refused before any call");
}

function bodyHasNoPersonalData(body: string): boolean {
  return ["firstName", "lastName", "dateOfBirth", "idDoc", "documentNumber", "email", "phone", "fixedInfo", "selfie", "address"].every(
    (field) => body.includes(field) === false,
  );
}

/* ---- 7: the decision, and the exact words it becomes ---- */

function checkDecisionMapping(): void {
  const reference = APPLICANT_ID;

  for (const status of SUMSUB_REVIEW_STATUSES) {
    const answer = sumsubAnswerOf(decisionOf({ reviewStatus: status, reviewAnswer: null, rejectLabels: [], rejectType: null, levelName: LEVEL }), reference);
    const wanted = status === "completed" ? "unknown" : "in_progress";
    expectEqual(answer.result, wanted, `${status} without an answer is ${wanted}`);
    expectEqual(answer.liveness, "unknown", `${status} without a selfie step has unknown liveness`);
    expectEqual(answer.documentKind, "not_stated", `${status} without an identity step states no document kind`);
    expectEqual(answer.reasonCode, "vendor_incomplete", `${status} without an answer is an incomplete vendor record`);
    expectEqual(answer.reference, reference, `${status} keeps the reference`);
    expect((SUPPLEMENTARY_IDV_RESULTS as readonly string[]).includes(answer.result), `${status} maps into STEP 170's results`);
    expect((PROCESSOR_KYB_STATUSES as readonly string[]).includes(answer.result) === false, `${status} is never a processor status`);
  }

  for (const status of SUMSUB_REVIEW_STATUSES) {
    const green = sumsubAnswerOf(decisionOf({ reviewStatus: status, reviewAnswer: "GREEN", rejectLabels: [], rejectType: null, levelName: LEVEL }), reference);
    expectEqual(green.result, status === "completed" ? "passed" : "in_progress", `GREEN on ${status} is ${status === "completed" ? "a pass" : "still running"}`);
    const red = sumsubAnswerOf(decisionOf({ reviewStatus: status, reviewAnswer: "RED", rejectLabels: [], rejectType: null, levelName: LEVEL }), reference);
    expectEqual(red.result, status === "completed" ? "failed" : "in_progress", `RED on ${status} is ${status === "completed" ? "a failure" : "still running"}`);
  }

  const unknownStatus = sumsubAnswerOf(decisionOf({ reviewStatus: "approved", reviewAnswer: "GREEN", rejectLabels: [], rejectType: null, levelName: LEVEL }), reference);
  expectEqual(unknownStatus.result, "unknown", "a status this file has not read is unknown, even with a green answer");
  const paddedStatus = sumsubAnswerOf(decisionOf({ reviewStatus: "completed ", reviewAnswer: "GREEN", rejectLabels: [], rejectType: null, levelName: LEVEL }), reference);
  expectEqual(paddedStatus.result, "unknown", "a padded status is unknown rather than a pass");
  const casedStatus = sumsubAnswerOf(decisionOf({ reviewStatus: "Completed", reviewAnswer: "GREEN", rejectLabels: [], rejectType: null, levelName: LEVEL }), reference);
  expectEqual(casedStatus.result, "unknown", "a re-cased status is unknown rather than a pass");

  const lowerAnswer = sumsubAnswerOf(decisionOf({ reviewStatus: "completed", reviewAnswer: null, rejectLabels: [], rejectType: null, levelName: LEVEL }), reference);
  expectEqual(lowerAnswer.result, "unknown", "a completed review with no readable answer is unknown");

  const documents: readonly (readonly [string | null, string])[] = [
    ["PASSPORT", "passport"],
    ["ID_CARD", "national_id"],
    ["RESIDENCE_PERMIT", "residence_permit"],
    ["UTILITY_BILL", "not_stated"],
    ["VEHICLE_REGISTRATION_CERTIFICATE", "not_stated"],
    ["passport", "not_stated"],
    ["", "not_stated"],
    [null, "not_stated"],
  ];
  for (const [idDocType, kind] of documents) {
    const answer = sumsubAnswerOf(
      decisionOf({ reviewStatus: "completed", reviewAnswer: "GREEN", rejectLabels: [], rejectType: null, levelName: LEVEL }, [
        { step: "IDENTITY", reviewAnswer: "GREEN", idDocType, rejectLabels: [] },
      ]),
      reference,
    );
    expectEqual(answer.documentKind, kind, `an identity step with ${String(idDocType)} states ${kind}`);
  }
  const selfieDocType = sumsubAnswerOf(
    decisionOf({ reviewStatus: "completed", reviewAnswer: "GREEN", rejectLabels: [], rejectType: null, levelName: LEVEL }, [
      { step: "SELFIE", reviewAnswer: "GREEN", idDocType: "SELFIE", rejectLabels: [] },
      { step: "IDENTITY2", reviewAnswer: "GREEN", idDocType: "ID_CARD", rejectLabels: [] },
    ]),
    reference,
  );
  expectEqual(selfieDocType.documentKind, "national_id", "the second identity step feeds the document kind");
  expectEqual(selfieDocType.liveness, "passed", "a green selfie step passes liveness");

  const livenessCases: readonly (readonly [SumsubStepResult[], string, string])[] = [
    [[], "unknown", "no selfie step means liveness never ran"],
    [[{ step: "SELFIE", reviewAnswer: "GREEN", idDocType: null, rejectLabels: [] }], "passed", "a green selfie passes"],
    [[{ step: "SELFIE", reviewAnswer: "RED", idDocType: null, rejectLabels: [] }], "failed", "a red selfie fails"],
    [[{ step: "SELFIE", reviewAnswer: null, idDocType: null, rejectLabels: [] }], "in_progress", "an unanswered selfie is still running"],
    [[{ step: "SELFIE2", reviewAnswer: "GREEN", idDocType: null, rejectLabels: [] }], "passed", "the second selfie step counts"],
    [[{ step: "PROOF_OF_RESIDENCE", reviewAnswer: "GREEN", idDocType: null, rejectLabels: [] }], "unknown", "an address step is not a liveness check"],
  ];
  for (const [steps, liveness, name] of livenessCases) {
    const answer = sumsubAnswerOf(decisionOf({ reviewStatus: "completed", reviewAnswer: "GREEN", rejectLabels: [], rejectType: null, levelName: LEVEL }, steps), reference);
    expectEqual(answer.liveness, liveness, name);
    expect((SUPPLEMENTARY_IDV_LIVENESS_RESULTS as readonly string[]).includes(answer.liveness), `${name} (the word is STEP 170's)`);
  }

  const labelCases: readonly (readonly [readonly string[], readonly SumsubStepResult[], string, string])[] = [
    [["UNSATISFACTORY_PHOTOS"], [], "document_unreadable", "an unsatisfactory photo is an unreadable document"],
    [["FORGERY"], [], "not_stated", "forgery keeps no neutral reason"],
    [["GRAPHIC_EDITOR"], [], "not_stated", "an edited image keeps no neutral reason"],
    [["UNKNOWN_LABEL"], [], "not_stated", "a label this file has not read keeps no reason"],
    [["UNSATISFACTORY_PHOTOS"], [{ step: "SELFIE", reviewAnswer: "RED", idDocType: null, rejectLabels: [] }], "document_unreadable", "a documented label wins over the step that failed"],
    [[], [{ step: "SELFIE", reviewAnswer: "RED", idDocType: null, rejectLabels: [] }], "liveness_failed", "a red selfie with no label is a liveness failure"],
    [[], [{ step: "IDENTITY", reviewAnswer: "RED", idDocType: "PASSPORT", rejectLabels: [] }], "document_unreadable", "a red identity step with no label is an unreadable document"],
    [[], [{ step: "IDENTITY", reviewAnswer: "RED", idDocType: "PASSPORT", rejectLabels: ["FORGERY"] }], "document_unreadable", "a step label this file has not read falls back to the step's answer"],
  ];
  for (const [labels, steps, reason, name] of labelCases) {
    const answer = sumsubAnswerOf(
      decisionOf({ reviewStatus: "completed", reviewAnswer: "RED", rejectLabels: labels, rejectType: "FINAL", levelName: LEVEL }, steps),
      reference,
    );
    expectEqual(answer.result, "failed", `${name} (the review failed)`);
    expectEqual(answer.reasonCode, reason, name);
    expect((SUPPLEMENTARY_IDV_REASON_CODES as readonly string[]).includes(answer.reasonCode), `${name} (the reason is STEP 170's)`);
  }

  const retry = sumsubAnswerOf(decisionOf({ reviewStatus: "completed", reviewAnswer: "RED", rejectLabels: [], rejectType: "RETRY", levelName: LEVEL }), reference);
  expectEqual(retry.result, "failed", "a resubmission-requested rejection is still a failed review of this attempt");
  const onHold = sumsubAnswerOf(decisionOf({ reviewStatus: "onHold", reviewAnswer: null, rejectLabels: [], rejectType: null, levelName: LEVEL }), reference);
  expectEqual(onHold.result, "in_progress", "onHold is a compliance expert's review, so it is still running rather than a pass");
  expectEqual(onHold.reasonCode, "vendor_incomplete", "onHold has no neutral reason of its own");

  for (const status of SUMSUB_REVIEW_STATUSES) {
    for (const answer of [null, "GREEN", "RED"] as const) {
      for (const steps of [[], [{ step: "SELFIE", reviewAnswer: "GREEN", idDocType: null, rejectLabels: [] }], [{ step: "IDENTITY", reviewAnswer: "RED", idDocType: "PASSPORT", rejectLabels: ["UNSATISFACTORY_PHOTOS"] }]] as readonly SumsubStepResult[][]) {
        const produced = sumsubAnswerOf(decisionOf({ reviewStatus: status, reviewAnswer: answer, rejectLabels: [], rejectType: null, levelName: LEVEL }, steps), reference);
        expect((SUPPLEMENTARY_IDV_RESULTS as readonly string[]).includes(produced.result), `${status}/${String(answer)} yields a STEP 170 result`);
        expect((PROCESSOR_KYB_STATUSES as readonly string[]).includes(produced.result) === false, `${status}/${String(answer)} yields no processor status`);
        expect((SUPPLEMENTARY_IDV_LIVENESS_RESULTS as readonly string[]).includes(produced.liveness), `${status}/${String(answer)} yields a liveness word`);
        expect((SUPPLEMENTARY_IDV_DOCUMENT_KINDS as readonly string[]).includes(produced.documentKind), `${status}/${String(answer)} yields a document kind`);
        expect((SUPPLEMENTARY_IDV_REASON_CODES as readonly string[]).includes(produced.reasonCode), `${status}/${String(answer)} yields a reason`);
        expect(validateSupplementaryIdvVendorAnswer(produced) === null, `${status}/${String(answer)} is an answer STEP 170 accepts`);
      }
    }
  }
}

/* ---- 8: reading a decision over the wire ---- */

function checkReadAnswer(): void {
  const read = (statusCode: number, statusText: string, stepsCode: number, stepsText: string): SumsubReadVerdict =>
    parseSumsubReadAnswers(statusCode, statusText, stepsCode, stepsText, APPLICANT_ID);

  const passed = read(200, statusBody({ status: "completed", answer: "GREEN" }), 200, stepsBody({ identity: "GREEN", selfie: "GREEN", idDocType: "PASSPORT" }));
  expectEqual(passed.outcome, "read", "a completed green review is a read");
  if (passed.outcome === "read") {
    expectEqual(passed.answer.result, "passed", "the review passed");
    expectEqual(passed.answer.liveness, "passed", "the selfie step passed");
    expectEqual(passed.answer.documentKind, "passport", "the document kind is read from the identity step");
    expectEqual(passed.answer.reference, APPLICANT_ID, "the reference is the applicant id");
  }

  const failedRead = read(200, statusBody({ status: "completed", answer: "RED", labels: ["UNSATISFACTORY_PHOTOS"], rejectType: "FINAL" }), 200, stepsBody({ identity: "RED" }));
  expectEqual(failedRead.outcome, "read", "a completed red review is a read");
  if (failedRead.outcome === "read") {
    expectEqual(failedRead.answer.result, "failed", "the review failed");
    expectEqual(failedRead.answer.reasonCode, "document_unreadable", "the label is the reason");
  }

  const running = read(200, statusBody({ status: "pending" }), 200, stepsBody({}));
  expectEqual(running.outcome, "in_flight", "a pending review is in flight");
  if (running.outcome === "in_flight") expectEqual(running.answer.result, "in_progress", "a pending review is in progress");

  const prechecked = read(200, statusBody({ status: "prechecked" }), 200, stepsBody({}));
  expectEqual(prechecked.outcome, "in_flight", "a prechecked review is in flight");
  const queued = read(200, statusBody({ status: "queued" }), 200, stepsBody({}));
  expectEqual(queued.outcome, "in_flight", "a queued review is in flight");
  const awaitingService = read(200, statusBody({ status: "awaitingService" }), 200, stepsBody({}));
  expectEqual(awaitingService.outcome, "in_flight", "awaiting service is in flight");
  const awaitingUser = read(200, statusBody({ status: "awaitingUser" }), 200, stepsBody({}));
  expectEqual(awaitingUser.outcome, "in_flight", "awaiting user is in flight");
  const initial = read(200, statusBody({ status: "init" }), 200, stepsBody({}));
  expectEqual(initial.outcome, "in_flight", "an initial review is in flight");

  const held = read(200, statusBody({ status: "onHold" }), 200, stepsBody({}));
  expectEqual(held.outcome, "in_flight", "a hold is still in flight");
  if (held.outcome === "in_flight") expectEqual(held.answer.result, "in_progress", "a hold is a compliance expert's review, not a verdict");

  const missing = read(404, '{"description":"Applicant not found","code":404}', 200, stepsBody({}));
  expectEqual(missing.outcome, "not_found", "a 404 on the status read is not found");
  for (const code of [401, 403, 400]) {
    expectEqual(read(code, "{}", 200, "").outcome, "failed", `a ${code} on the status read is a failure`);
  }
  for (const code of [429, 500, 503, 302, 408, 425]) {
    expectEqual(read(code, "{}", 200, "").outcome, "unknown", `a ${code} on the status read is unknown`);
  }
  expectEqual(read(200, "not json", 200, "").outcome, "unknown", "an unreadable status answer is unknown");
  expectEqual(read(200, "{}", 200, "").outcome, "unknown", "a status answer without a review status is unknown");
  const paddedRead = read(200, statusBody({ status: "completed ", answer: "GREEN" }), 200, "");
  expectEqual(paddedRead.outcome, "read", "a padded status is still read");
  if (paddedRead.outcome === "read") expectEqual(paddedRead.answer.result, "unknown", "a padded status is unknown rather than a pass");
  const casedRead = read(200, statusBody({ status: "Completed", answer: "GREEN" }), 200, "");
  expectEqual(casedRead.outcome, "read", "a re-cased status is still read");
  if (casedRead.outcome === "read") expectEqual(casedRead.answer.result, "unknown", "a re-cased status is unknown rather than a pass");
  const lowerRead = read(200, statusBody({ status: "completed", answer: "green" }), 200, "");
  expectEqual(lowerRead.outcome, "read", "a lower-case answer is still read");
  if (lowerRead.outcome === "read") expectEqual(lowerRead.answer.result, "unknown", "a lower-case answer is not a pass");
  expectEqual(read(204, "", 204, "").outcome, "unknown", "an empty answer is unknown");

  const stepsFailed = read(200, statusBody({ status: "completed", answer: "GREEN" }), 500, "");
  expectEqual(stepsFailed.outcome, "read", "a failed steps read does not undo a decided review");
  if (stepsFailed.outcome === "read") {
    expectEqual(stepsFailed.answer.result, "passed", "the status answer still decides");
    expectEqual(stepsFailed.answer.liveness, "unknown", "a failed steps read leaves liveness unknown");
    expectEqual(stepsFailed.answer.documentKind, "not_stated", "a failed steps read states no document kind");
  }
  const stepsGarbage = read(200, statusBody({ status: "completed", answer: "GREEN" }), 200, "not json");
  expectEqual(stepsGarbage.outcome, "read", "an unreadable steps answer does not undo a decided review");
  if (stepsGarbage.outcome === "read") expectEqual(stepsGarbage.answer.documentKind, "not_stated", "an unreadable steps answer states no document kind");

  const stepsOnlySelfie = read(200, statusBody({ status: "completed", answer: "GREEN" }), 200, stepsBody({ selfie: "GREEN", identity: null }));
  if (stepsOnlySelfie.outcome === "read") {
    expectEqual(stepsOnlySelfie.answer.liveness, "passed", "a steps answer with only a selfie still passes liveness");
    expectEqual(stepsOnlySelfie.answer.documentKind, "not_stated", "a steps answer without an identity step states no document kind");
  }

  const parsedStatus = parseSumsubStatus(statusBody({ status: "completed", answer: "RED", labels: ["FORGERY", "UNSATISFACTORY_PHOTOS"], rejectType: "FINAL", levelName: "lvl_2" }));
  expectEqual(parsedStatus?.reviewStatus, "completed", "the status is read exactly");
  expectEqual(parsedStatus?.reviewAnswer, "RED", "the answer is read exactly");
  expectEqual(parsedStatus?.rejectLabels.join(","), "FORGERY,UNSATISFACTORY_PHOTOS", "the labels are read in order");
  expectEqual(parsedStatus?.rejectType, "FINAL", "the rejection type is read");
  expectEqual(parsedStatus?.levelName, "lvl_2", "the level is read");
  expectEqual(parseSumsubStatus(statusBody({ status: "pending" }))?.reviewAnswer, null, "an empty review result is no answer");
  expectEqual(parseSumsubStatus(statusBody({ status: "pending" }))?.rejectLabels.length, 0, "an empty review result has no labels");
  expectEqual(parseSumsubStatus("not json"), null, "an unreadable status answer is null");
  expectEqual(parseSumsubStatus("{}"), null, "a status answer without a status is null");
  expectEqual(parseSumsubStatus(statusBody({ status: "completed", answer: "GREEN" }))?.reviewStatus, "completed", "a status with a green answer reads");
  expectEqual(parseSumsubStatus(statusBody({ status: "completed ", answer: "GREEN" }))?.reviewStatus, "completed ", "the status is not trimmed");
  expectEqual(parseSumsubStatus(statusBody({ status: "completed", answer: "green" }))?.reviewAnswer, null, "a lower-case answer is not read as an answer");
  expectEqual(parseSumsubStatus(statusBody({ status: "completed", answer: "GREEN " }))?.reviewAnswer, null, "a padded answer is not read as an answer");

  const parsedSteps = parseSumsubSteps(stepsBody({ identity: "GREEN", selfie: "RED", idDocType: "ID_CARD" }));
  expectEqual(parsedSteps?.length, 2, "two step results are read");
  expectEqual(parsedSteps?.find((step) => step.step === "IDENTITY")?.idDocType, "ID_CARD", "the identity step's document type is read");
  expectEqual(parsedSteps?.find((step) => step.step === "SELFIE")?.reviewAnswer, "RED", "the selfie step's answer is read");
  expectEqual(parseSumsubSteps("not json"), null, "an unreadable steps answer is null");
  expectEqual(parseSumsubSteps("{}")?.length, 0, "an empty steps answer has no steps");
  expectEqual(parseSumsubSteps(JSON.stringify({ UNKNOWN_STEP: { reviewResult: { reviewAnswer: "GREEN" } } }))?.length, 0, "a step this file has not read is ignored");
  expectEqual(parseSumsubSteps(stepsBody({ identity: "green" }))?.find((step) => step.step === "IDENTITY")?.reviewAnswer, null, "a lower-case step answer is not an answer");
}

/* ---- 9: refreshing a session, forward only ---- */

async function checkRefresh(): Promise<void> {
  const store = configuredStore();
  const row = openedSession(store.config);
  const create = new ScriptedTransport([ok(createBody(), 201)]);
  const opened = await openSumsubSession({ ...SESSION_INPUT, sessionId: row.session.id }, optionsWith(create.call, store.store, row.store));
  if (opened.status !== "opened") throw new Error("the refresh fixture could not open a session");

  const audits: SupplementaryIdvAuditEntry[] = [];
  const passing = routed((request) => {
    if (request.path.endsWith("/status")) return ok(statusBody({ status: "completed", answer: "GREEN" }));
    if (request.path.endsWith("/requiredIdDocsStatus")) {
      return ok(stepsBody({ identity: "GREEN", selfie: "GREEN", idDocType: "PASSPORT" }));
    }
    throw new Error("the refresh fixture was asked for an unexpected path");
  });
  const refreshed = await refreshSumsubSession(row.session.id, optionsWith(passing.transport, store.store, row.store, { recordAudit: (entry) => audits.push(entry) }));
  expectEqual(refreshed.status, "recorded", "a completed review is recorded");
  if (refreshed.status === "recorded") {
    expectEqual(refreshed.session.result, "passed", "the session passed");
    expectEqual(refreshed.session.liveness, "passed", "the liveness word is recorded");
    expectEqual(refreshed.session.documentKind, "passport", "the document kind is recorded");
    expectEqual(refreshed.session.reference, APPLICANT_ID, "the reference is unchanged");
    expectEqual(refreshed.session.version, 3, "the row moves one version per recorded answer");
    expectEqual(refreshed.changed, true, "the answer changed the row");
  }
  expectEqual(passing.calls.length, 2, "a refresh reads the status and the steps");
  expectEqual(passing.calls[0]?.path, sumsubStatusPath(APPLICANT_ID), "the first read is the review status");
  expectEqual(passing.calls[1]?.path, sumsubStepsPath(APPLICANT_ID), "the second read is the step results");
  expect(passing.calls.every((call) => call.method === "GET"), "a refresh only reads");
  expect(passing.calls.every((call) => call.body === null), "a refresh sends no body");
  expectEqual(audits.filter((entry) => entry.action === "supplementary_idv.result_passed").length, 1, "the pass is audited once");
  expectEqual(audits[0]?.officeOnly, true, "the audit entry is the office's");
  expectEqual(row.store.findById(row.session.id)?.processorKybStatusSeen, "pending", "the refresh never writes the processor's status");

  const same = routed((request) => (request.path.endsWith("/status") ? ok(statusBody({ status: "completed", answer: "GREEN" })) : ok(stepsBody({ identity: "GREEN", selfie: "GREEN", idDocType: "PASSPORT" }))));
  const repeated = await refreshSumsubSession(row.session.id, optionsWith(same.transport, store.store, row.store));
  expectEqual(repeated.status, "recorded", "a repeated read is recorded as unchanged");
  if (repeated.status === "recorded") {
    expectEqual(repeated.changed, false, "a repeated read does not move the row");
    expectEqual(repeated.session.version, 3, "a repeated read does not move the version");
    expectEqual(repeated.session.result, "passed", "a repeated read keeps the pass");
  }

  const late = routed((request) => (request.path.endsWith("/status") ? ok(statusBody({ status: "pending" })) : ok(stepsBody({}))));
  const replay = await refreshSumsubSession(row.session.id, optionsWith(late.transport, store.store, row.store));
  expectEqual(replay.status, "refused", "a running review cannot rewrite a recorded pass");
  expectEqual(row.store.findById(row.session.id)?.result, "passed", "the recorded pass survives the refusal");
  expectEqual(row.store.findById(row.session.id)?.version, 3, "a refused replay does not move the row");

  // A hold is a person's decision.
  const holdStore = configuredStore();
  const holdRow = openedSession(holdStore.config);
  await openSumsubSession({ ...SESSION_INPUT, sessionId: holdRow.session.id }, optionsWith(new ScriptedTransport([ok(createBody(), 201)]).call, holdStore.store, holdRow.store));
  const holdAudits: SupplementaryIdvAuditEntry[] = [];
  const holding = routed((request) => (request.path.endsWith("/status") ? ok(statusBody({ status: "onHold" })) : ok("{}")));
  const held = await refreshSumsubSession(holdRow.session.id, optionsWith(holding.transport, holdStore.store, holdRow.store, { recordAudit: (entry) => holdAudits.push(entry) }));
  expectEqual(held.status, "in_flight", "a hold is still in flight");
  if (held.status === "in_flight") {
    expectEqual(held.session.result, "in_progress", "a hold is a compliance expert's review, so the row keeps running");
    expectEqual(held.session.requiresHumanReview, false, "a running review is not yet a manual case");
    expectEqual(held.session.fallback, null, "a running review has no fallback");
  }
  expectEqual(holdAudits[0]?.action, "supplementary_idv.result_pending", "STEP 170 audits a running review as pending");

  // A failure sets the manual fallback through STEP 170's own rule.
  const failStore = configuredStore();
  const failRow = openedSession(failStore.config);
  await openSumsubSession({ ...SESSION_INPUT, sessionId: failRow.session.id }, optionsWith(new ScriptedTransport([ok(createBody(), 201)]).call, failStore.store, failRow.store));
  const failing = routed((request) =>
    request.path.endsWith("/status")
      ? ok(statusBody({ status: "completed", answer: "RED", labels: ["UNSATISFACTORY_PHOTOS"], rejectType: "FINAL" }))
      : ok(stepsBody({ identity: "RED", selfie: "RED" })),
  );
  const failedAudits: SupplementaryIdvAuditEntry[] = [];
  const failed = await refreshSumsubSession(failRow.session.id, optionsWith(failing.transport, failStore.store, failRow.store, { recordAudit: (entry) => failedAudits.push(entry) }));
  expectEqual(failed.status, "recorded", "a failure is recorded");
  if (failed.status === "recorded") {
    expectEqual(failed.session.result, "failed", "the session failed");
    expectEqual(failed.session.reasonCode, "document_unreadable", "the documented label is the reason");
    expectEqual(failed.session.requiresHumanReview, true, "a failed automatic check needs a person");
    expectEqual(failed.session.fallback?.mode, "manual", "a failed automatic check falls back to manual review");
    expectEqual(failed.session.fallback?.merchantVisible, false, "the fallback is not shown to the merchant");
    expectEqual(supplementaryIdvMerchantStatusOf(failed.session.result), "verification_incomplete", "the merchant sees STEP 170's one neutral phrase");
  }
  expectEqual(failedAudits.filter((entry) => entry.action === "supplementary_idv.fallback_manual").length, 1, "the fallback is audited");

  // Guards and unreachable vendors.
  const noReferenceStore = configuredStore();
  const noReferenceRow = openedSession(noReferenceStore.config);
  expectEqual((await refreshSumsubSession(noReferenceRow.session.id, optionsWith(new ScriptedTransport([]).call, noReferenceStore.store, noReferenceRow.store))).status, "failed", "a session without a reference is not refreshed");

  const badReferenceStore = configuredStore();
  const badReferenceRow = openedSession(badReferenceStore.config);
  badReferenceRow.store.save({ ...badReferenceRow.session, reference: "not-an-applicant", version: 2 }, 1);
  expectEqual(
    (await refreshSumsubSession(badReferenceRow.session.id, optionsWith(new ScriptedTransport([]).call, badReferenceStore.store, badReferenceRow.store))).status,
    "failed",
    "a reference that is not an applicant id is refused",
  );

  expectEqual((await refreshSumsubSession(SESSION_UUID, optionsWith(new ScriptedTransport([]).call, store.store, row.store))).status, "failed", "an unknown session is refused");

  const unreachable = new ScriptedTransport([new Error("network down")]);
  expectEqual((await refreshSumsubSession(holdRow.session.id, optionsWith(unreachable.call, holdStore.store, holdRow.store))).status, "failed", "an unreachable vendor is a failure");

  const stepsThrow = routed((request) => {
    if (request.path.endsWith("/status")) return ok(statusBody({ status: "completed", answer: "GREEN" }));
    throw new Error("the steps read failed");
  });
  const tolerated = await refreshSumsubSession(holdRow.session.id, optionsWith(stepsThrow.transport, holdStore.store, holdRow.store));
  expectEqual(tolerated.status, "recorded", "a steps read that throws does not undo the status answer");
  if (tolerated.status === "recorded") {
    expectEqual(tolerated.session.result, "passed", "the status answer still passes the session");
    expectEqual(tolerated.session.liveness, "unknown", "a steps read that throws leaves liveness unknown");
  }

  const notFound = new ScriptedTransport([ok('{"description":"Applicant not found","code":404}', 404)]);
  expectEqual((await refreshSumsubSession(holdRow.session.id, optionsWith(notFound.call, holdStore.store, holdRow.store))).status, "failed", "a 404 on the status read is a failure");

  const foreignKey = configuredStore({ ring: otherKeyring });
  const foreignRow = openedSession(foreignKey.config);
  expectEqual((await refreshSumsubSession(foreignRow.session.id, optionsWith(new ScriptedTransport([]).call, foreignKey.store, foreignRow.store))).status, "failed", "another keyring cannot refresh");

  // The SDK token is answered once and stored nowhere.
  const tokenStore = configuredStore();
  const tokenRow = openedSession(tokenStore.config);
  await openSumsubSession({ ...SESSION_INPUT, sessionId: tokenRow.session.id }, optionsWith(new ScriptedTransport([ok(createBody(), 201)]).call, tokenStore.store, tokenRow.store));
  const tokenTransport = new ScriptedTransport([ok(JSON.stringify({ token: ACCESS_TOKEN, userId: tokenRow.session.id }), 201)]);
  const issued = await createSumsubAccessToken({ sessionId: tokenRow.session.id, levelName: LEVEL }, optionsWith(tokenTransport.call, tokenStore.store, tokenRow.store));
  expectEqual(issued.status, "issued", "an access token is issued");
  if (issued.status === "issued") {
    expectEqual(issued.token, ACCESS_TOKEN, "the token is handed to the caller");
    expectEqual(issued.ttlSeconds, SUMSUB_ACCESS_TOKEN_DEFAULT_TTL_SECONDS, "the token's life is the documented default");
  }
  expectEqual(tokenTransport.calls.length, 1, "the token is one call");
  expectEqual(tokenTransport.calls[0]?.method, "POST", "the token is a POST");
  expectEqual(tokenTransport.calls[0]?.path, SUMSUB_ACCESS_TOKEN_PATH, "the token call is the documented path");
  const tokenBody = JSON.parse(tokenTransport.calls[0]?.body ?? "{}") as Record<string, unknown>;
  expectEqual(tokenBody["userId"], tokenRow.session.id, "the token is bound to our own identifier");
  expectEqual(tokenBody["levelName"], LEVEL, "the token names the office's level");
  expectEqual(tokenBody["ttlInSecs"], SUMSUB_ACCESS_TOKEN_DEFAULT_TTL_SECONDS, "the token names its life");
  expectEqual(Object.keys(tokenBody).length, 3, "the token body carries no applicant id, no document and no personal data");
  expect(JSON.stringify(tokenStore.store.findById(tokenStore.config.id)).includes(ACCESS_TOKEN) === false, "the token is not written into the configuration");
  expect(JSON.stringify(tokenRow.store.findById(tokenRow.session.id)).includes(ACCESS_TOKEN) === false, "the token is not written into the session");

  const shortLife = new ScriptedTransport([ok(JSON.stringify({ token: ACCESS_TOKEN }), 201)]);
  const clampedLow = await createSumsubAccessToken({ sessionId: tokenRow.session.id, levelName: LEVEL, ttlSeconds: 5 }, optionsWith(shortLife.call, tokenStore.store, tokenRow.store));
  if (clampedLow.status === "issued") expectEqual(clampedLow.ttlSeconds, 60, "a token life below a minute is raised to a minute");
  const longLife = new ScriptedTransport([ok(JSON.stringify({ token: ACCESS_TOKEN }), 201)]);
  const clampedHigh = await createSumsubAccessToken({ sessionId: tokenRow.session.id, levelName: LEVEL, ttlSeconds: 999_999 }, optionsWith(longLife.call, tokenStore.store, tokenRow.store));
  if (clampedHigh.status === "issued") expectEqual(clampedHigh.ttlSeconds, SUMSUB_ACCESS_TOKEN_MAXIMUM_TTL_SECONDS, "an over-long token life is cut to the ceiling");
  expectEqual((await createSumsubAccessToken({ sessionId: tokenRow.session.id, levelName: LEVEL }, optionsWith(new ScriptedTransport([ok('{"description":"Unauthorized","code":401}', 401)]).call, tokenStore.store, tokenRow.store))).status, "refused", "a refused token is a refusal");
  expectEqual((await createSumsubAccessToken({ sessionId: tokenRow.session.id, levelName: LEVEL }, optionsWith(new ScriptedTransport([ok("not json", 201)]).call, tokenStore.store, tokenRow.store))).status, "failed", "an answer without a token is a failure");
  expectEqual((await createSumsubAccessToken({ sessionId: noReferenceRow.session.id, levelName: LEVEL }, optionsWith(new ScriptedTransport([]).call, noReferenceStore.store, noReferenceRow.store))).status, "failed", "a session without an applicant has no token");
  expectEqual((await createSumsubAccessToken({ sessionId: tokenRow.session.id, levelName: "lvl one" }, optionsWith(new ScriptedTransport([]).call, tokenStore.store, tokenRow.store))).status, "failed", "an unusable level name gets no token");
}

/* ---- 10: the port STEP 170 defined, and its three members ---- */

async function checkAdapter(): Promise<void> {
  const adapter = sumsubAdapterOf({ transport: async () => ok("{}"), levelName: LEVEL, occurredAtEpochMs: () => NOW });
  expectEqual(adapter.vendorKey, "sumsub", "the adapter names Sumsub");
  expect(isSupplementaryIdvAdapter(adapter) === true, "the adapter is exactly the port STEP 170 defined");
  expectEqual(Object.keys(adapter).sort().join(","), "createSession,readSession,vendorKey", "the adapter carries three members and no more");

  const store = configuredStore();
  const opened = await sumsubCreateThrough(store, APPLICANT_ID);
  expect(opened !== null, "the adapter creates a session");
  if (opened !== null) {
    expectEqual(opened.reference, APPLICANT_ID, "the adapter's reference is the applicant id");
    expectEqual(opened.result, "in_progress", "a created applicant is in progress for the adapter");
    expectEqual(validateSupplementaryIdvVendorAnswer(opened), null, "the adapter's answer is one STEP 170 accepts");
  }

  await expectRejects(
    async () => {
      const rejected = sumsubAdapterOf({
        transport: async () => ok('{"description":"Level not found","errorName":"level-not-found"}', 400),
        levelName: LEVEL,
        occurredAtEpochMs: () => NOW,
      });
      await rejected.createSession(
        { companyId: COMPANY, sessionId: SESSION_UUID, environment: "live", returnUrl: "https://api.kd.test/return" },
        openedConfigOf(store),
      );
    },
    "a refused create throws rather than answering a reference",
  );

  const readTransport = routed((request) =>
    request.path.endsWith("/status")
      ? ok(statusBody({ status: "completed", answer: "GREEN" }))
      : ok(stepsBody({ identity: "GREEN", selfie: "GREEN", idDocType: "ID_CARD" })),
  );
  const reader = sumsubAdapterOf({ transport: readTransport.transport, levelName: LEVEL, occurredAtEpochMs: () => NOW });
  const readAnswer = await reader.readSession(APPLICANT_ID, openedConfigOf(store));
  expectEqual(readAnswer.result, "passed", "the adapter reads a pass");
  expectEqual(readAnswer.documentKind, "national_id", "the adapter reads the document kind");
  expectEqual(validateSupplementaryIdvVendorAnswer(readAnswer), null, "the read answer is one STEP 170 accepts");
  expectEqual(readTransport.calls.length, 2, "the adapter's read is two calls");

  await expectRejects(async () => reader.readSession(APPLICANT_ID, openedConfigOf(store, otherKeyring)), "a credential sealed by another keyring cannot be read");
  await expectRejects(async () => reader.readSession("not-an-applicant", openedConfigOf(store)), "a reference that is not an applicant id is refused");
  await expectRejects(
    async () => {
      const missing = sumsubAdapterOf({ transport: async () => ok('{"description":"Applicant not found","code":404}', 404), levelName: LEVEL, occurredAtEpochMs: () => NOW });
      await missing.readSession(APPLICANT_ID, openedConfigOf(store));
    },
    "a 404 on the status read throws",
  );

  const stepsThrow = sumsubAdapterOf({
    transport: routed((request) => {
      if (request.path.endsWith("/status")) return ok(statusBody({ status: "completed", answer: "GREEN" }));
      throw new Error("the steps read failed");
    }).transport,
    levelName: LEVEL,
    occurredAtEpochMs: () => NOW,
  });
  const tolerated = await stepsThrow.readSession(APPLICANT_ID, openedConfigOf(store));
  expectEqual(tolerated.result, "passed", "a steps read that throws does not undo the adapter's status answer");
  expectEqual(tolerated.liveness, "unknown", "a steps read that throws leaves the adapter's liveness unknown");

  const summary = sumsubSessionSummaryOf(
    { ...openedSession(store.config).session, reference: APPLICANT_ID, result: "failed", reasonCode: "document_unreadable", documentKind: "passport" },
    decisionOf({ reviewStatus: "completed", reviewAnswer: "RED", rejectLabels: ["FORGERY"], rejectType: "FINAL", levelName: LEVEL }, [
      { step: "IDENTITY", reviewAnswer: "RED", idDocType: "PASSPORT", rejectLabels: [] },
    ]),
  );
  expectEqual(summary.changesProcessorKyb, false, "the summary never changes a processor status");
  expectEqual(summary.reviewStatus, "completed", "the summary keeps Sumsub's status");
  expectEqual(summary.reviewAnswer, "RED", "the summary keeps Sumsub's answer");
  expectEqual(summary.rejectLabels.join(","), "FORGERY", "the summary keeps Sumsub's labels");
  expectEqual(summary.steps.length, 1, "the summary keeps the steps");
  expectEqual(summary.reference, APPLICANT_ID, "the summary keeps the reference");
  expectEqual(summary.result, "failed", "the summary keeps the neutral result");
}

function openedConfigOf(
  fixture: { readonly store: InMemorySupplementaryIdvConfigStore; readonly config: SupplementaryIdvConfig },
  ring: EncryptionKeyring = keyring,
): OpenedSupplementaryIdvConfig {
  const config = fixture.store.findById(fixture.config.id);
  if (config === null) throw new Error("the fixture configuration vanished");
  const opened = openSupplementaryIdvConfig(config, ring);
  if (opened.status === "failed") throw new Error(opened.reason);
  return opened.config;
}

/** The adapter's create path, driven through the port. */
async function sumsubCreateThrough(
  fixture: { readonly store: InMemorySupplementaryIdvConfigStore; readonly config: SupplementaryIdvConfig },
  applicantId: string,
): Promise<SupplementaryIdvVendorAnswer | null> {
  const adapter = sumsubAdapterOf({ transport: async () => ok(createBody({ id: applicantId }), 201), levelName: LEVEL, occurredAtEpochMs: () => NOW });
  try {
    return await adapter.createSession(
      { companyId: COMPANY, sessionId: SESSION_UUID, environment: "live", returnUrl: "https://api.kd.test/return" },
      openedConfigOf(fixture),
    );
  } catch {
    return null;
  }
}

/* ---- 11: the transport's own guards, and the source ---- */

async function checkTransport(): Promise<void> {
  const base: SumsubRequest = {
    method: "GET",
    path: sumsubStatusPath(APPLICANT_ID),
    body: null,
    appToken: APP_TOKEN,
    timestampSeconds: NOW_SECONDS,
    signature: sumsubSignatureOf(SECRET_KEY, NOW_SECONDS, "GET", sumsubStatusPath(APPLICANT_ID), null),
  };

  await expectRejectsWith(() => sumsubFetchTransport({ ...base, path: "/resources/applicants" }), "invalid API path", "a path outside the allowlist is refused before a socket is opened");
  await expectRejectsWith(() => sumsubFetchTransport({ ...base, path: `${SUMSUB_API_HOST}${base.path}` }), "invalid API path", "a full URL is refused before a socket is opened");
  await expectRejectsWith(() => sumsubFetchTransport({ ...base, method: "POST", path: sumsubStatusPath(APPLICANT_ID) }), "invalid API path", "a method outside the allowlist is refused before a socket is opened");
  await expectRejectsWith(() => sumsubFetchTransport({ ...base, path: `/resources/applicants/${APPLICANT_ID}/one` }), "invalid API path", "the applicant-data path is refused by name");
  await expectRejectsWith(() => sumsubFetchTransport({ ...base, signature: "deadbeef" }), "invalid request signature", "a signature that is not a SHA-256 digest is refused");
  await expectRejectsWith(() => sumsubFetchTransport({ ...base, signature: base.signature.toUpperCase() }), "invalid request signature", "an upper-case signature is refused, because Sumsub documents lower-case hex");
  await expectRejectsWith(() => sumsubFetchTransport({ ...base, appToken: "   " }), "an app token is required", "an empty app token is refused");

  const source = readFileSync(new URL("./sumsub.ts", import.meta.url), "utf8");
  expect([...source].every((char) => char.charCodeAt(0) <= 127), "the adapter's source is ASCII, so the English-only rule holds");

  const consoleNeedles = ["log", "error", "warn"].map((name) => ["console", `${name}(`].join("."));
  for (const needle of consoleNeedles) {
    expect(source.includes(needle) === false, `the adapter's source carries no ${needle.replace(/\(/g, "(")}`);
  }
  expect(source.includes("sk_live_") === false, "the adapter's source carries no Stripe-shaped key");
  expect(source.includes("sk_test_") === false, "the adapter's source carries no test Stripe-shaped key");

  for (const processorWord of ["verified", "action_required", "restricted", "rejected"]) {
    expect(source.includes(`"${processorWord}"`) === false, `the adapter never spells ${processorWord}`);
  }
  expect(source.includes('result: "pending"') === false, "the adapter never writes a processor status into a result");
  expect(source.includes('processorKybStatus: "') === false, "the adapter never writes a processor status at all");
  expect(source.split(`"pending"`).length - 1 === 1, "the only bare pending is Sumsub's own review status");

  for (const endpoint of ["/reset", "/deactivate", "/one", "accessTokens/app", "/requiredIdDocsStatus/", "/applicants/-;externalUserId"]) {
    expect(source.includes(endpoint) === false, `the adapter never calls ${endpoint}`);
  }
  for (const personal of ["firstName", "lastName", "dateOfBirth", "documentNumber", "idDocFile", "selfieImage"]) {
    expect(source.includes(personal) === false, `the adapter's source carries no ${personal} field`);
  }
  expect(source.includes("SSN") === false, "the adapter's source mentions no national identifier");
  expect(source.includes("http://") === false, "the adapter refuses plain HTTP by never naming it");
  expect(source.includes('redirect: "error"') === true, "the transport refuses redirects rather than following one");
  expect(source.includes("AbortSignal.timeout(") === true, "the transport bounds every call with a timeout");
  expect(source.includes("SUMSUB_ALLOWED_CALLS") === true, "the transport checks the allowlist");
  expect(
    source.includes('if (isSumsubCall(request.method, request.path) === false) throw new Error("invalid API path");'),
    "the transport refuses a path outside the allowlist before it reaches fetch",
  );
  expect(source.includes("await fetch(sumsubEndpoint(request.path)") === true, "the transport builds its URL from the documented host and the signed path");
  expect(source.includes("createHmac(\"sha256\"") === true, "the transport signs with HMAC-SHA256");
  expect(source.includes('digest("hex")') === true, "the signature is hex");
}

/* ---- running ---- */

checkCatalogue();
checkCredential();
await checkConfiguration();
checkSignature();
checkRequest();
await checkOpen();
checkDecisionMapping();
checkReadAnswer();
await checkRefresh();
await checkAdapter();
await checkTransport();

if (failures.length > 0) {
  process.stderr.write(
    `sumsub adapter gate failed: ${failures.length} of ${checks} checks\n${failures.map((failure) => `  - ${failure}`).join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `sumsub adapter gate passed: ${checks} checks (one documented host for both environments and five documented calls behind an allowlist, an HMAC-SHA256 signature over the timestamp, the upper-case method, the path with its query and the raw body, a pair sealed by STEP 170's own scopes and inert until a signed read proves it without creating an applicant, an app token read as opaque text and never as a mode, a session row written before Sumsub is called and a duplicate reconciled by the documented existence lookup instead of a second applicant, eight exact camel-case review statuses matched without trimming so a padded or re-cased approval is unknown rather than a pass, GREEN and RED read as the documentation defines them and onHold kept running because a compliance expert, not this platform, owns that decision, liveness taken from the SELFIE step and the document kind from the IDENTITY step so neither is guessed, an SDK access token answered once and stored nowhere, a late review refused rather than rewriting a recorded pass, and a supplementary result that stays disjoint from the processor's five statuses at every step)\n`,
);
