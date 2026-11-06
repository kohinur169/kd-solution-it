// path: lib/payments/adapters/airwallex-payout-verify.ts

/**
 * The gate for STEP 169's payout half: paying a merchant out.
 *
 * A check script, not a test file. It builds a real configuration with STEP 166's code, a ready connected account with
 * STEP 167's record shape, then books a payout, attaches a transfer id, reads statuses through a recording transport
 * and applies them — including the case the whole file exists for, a `PAID` transfer that later fails. No network call
 * is made and no real credential exists.
 */

import process from "node:process";
import type { EncryptionKeyring } from "../../security/encryption.ts";
import {
  AIRWALLEX_PAYOUT_ALLOWED_PATH_PATTERNS,
  AIRWALLEX_PAYOUT_FINAL_STATUSES,
  AIRWALLEX_PAYOUT_OUTCOME_MOVES,
  AIRWALLEX_PAYOUT_TEXT_MAXIMUM_LENGTH,
  AIRWALLEX_PAYOUT_TIMEOUT_MS,
  AIRWALLEX_BENEFICIARY_CREATE_PATH,
  AIRWALLEX_TRANSFER_BODY_NOT_RECORDED,
  AIRWALLEX_TRANSFER_CREATE_PATH,
  AIRWALLEX_TRANSFER_READ_PATH_PREFIX,
  InMemoryAirwallexPayoutStore,
  airwallexPayoutCanStillFail,
  airwallexPayoutFetchTransport,
  airwallexPayoutLedgerOutcome,
  airwallexPayoutMessageOf,
  airwallexPayoutRequestId,
  airwallexTransferIdOf,
  airwallexTransferPath,
  airwallexTransferStatusOf,
  applyAirwallexPayoutStatus,
  attachAirwallexTransferId,
  bookAirwallexPayout,
  closeAirwallexPayoutWindow,
  createAirwallexBeneficiary,
  createAirwallexTransfer,
  isAirwallexBeneficiaryId,
  isAirwallexPayoutPath,
  isAirwallexTransferId,
  parseAirwallexTransferReadAnswer,
  readAirwallexTransfer,
  validateAirwallexPayoutRequest,
  type AirwallexPayoutAuditEntry,
  type AirwallexPayoutCall,
  type AirwallexPayoutOptions,
  type AirwallexPayoutRecord,
  type AirwallexPayoutRequest,
} from "./airwallex-payout.ts";
import {
  AIRWALLEX_ENDPOINTS,
  AIRWALLEX_ON_BEHALF_OF_HEADER,
  AIRWALLEX_PROVIDER_KEY,
  AIRWALLEX_REQUEST_ID_PATTERN,
  AIRWALLEX_TRANSFER_TERMINAL_STATUSES,
} from "./airwallex.ts";
import {
  activateAirwallexConfig,
  configureAirwallexKeys,
  InMemoryAirwallexConfigStore,
  InMemoryAirwallexTokenCache,
  testAirwallexConnection,
  AIRWALLEX_LOGIN_PATH,
} from "./airwallex-client.ts";
import type { AirwallexAccountProvision } from "./airwallex-accounts.ts";

/* ---- the check book ---- */

let checks = 0;
const failures: string[] = [];

/** Render any value for a failure message, including the bigint amounts this file records. */
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

async function expectRejects(action: () => Promise<unknown>, description: string): Promise<void> {
  checks += 1;
  try {
    await action();
  } catch {
    return;
  }
  failures.push(description);
}

/** The reason a refused result carries, whichever union it is. */
function reasonOf(result: { readonly status: string }): string {
  return "reason" in result && typeof result.reason === "string" ? result.reason : result.status;
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
const companyId = "9b2d3e4f-0000-4000-8000-000000000001";
const otherCompanyId = "9b2d3e4f-0000-4000-8000-000000000002";
const accountId = "acct_A1b2C3d4E5f6G7h8I9j0";
const transferId = "tra_KdPayout0000000001";
const otherTransferId = "tra_KdPayout0000000002";
const beneficiaryId = "ben_KdPayoutBeneficiary01";
const clientId = "cid_AbCd1234EfGh5678";
const apiKey = "key_ZzYyXx9876WwVvUuTtSsRrQq";
const accessToken = "eyJhbGciOiJSUzI1NiJ9.eyJpYXQiOjE2MjQwMDAwMDB9.c2lnbmF0dXJlLXZhbHVl";
const keyring: EncryptionKeyring = { primary: { id: "k1", secret: Buffer.alloc(32, 7).toString("base64") } };
const loginAnswer = JSON.stringify({ token: accessToken, expires_at: "2026-01-01T12:30:00+0000" });
const balancesAnswer = JSON.stringify([{ currency: "USD", available_amount: 1 }]);

const request: AirwallexPayoutRequest = {
  companyId,
  amountMinor: 250_000n,
  beneficiaryId,
  currency: "usd",
  reference: "payout-2026-0001",
};

/** A connected account that is ready: created, ACTIVE, read a moment ago. */
function activeProvision(overrides: Partial<AirwallexAccountProvision> = {}): AirwallexAccountProvision {
  return {
    id: "0a1b2c3d-0000-4000-8000-000000000001",
    providerKey: AIRWALLEX_PROVIDER_KEY,
    companyId,
    environment: "sandbox",
    kycSubmissionId: "kyc-submission-1",
    accountKind: "business",
    accountId,
    attemptStatus: "created",
    accountStatus: "ACTIVE",
    onboardingState: "ready",
    submittedAtEpochMs: NOW - 60_000,
    verificationCheckedAtEpochMs: NOW - 1_000,
    verificationCheckCount: 2,
    reason: null,
    requiresReconciliation: false,
    version: 4,
    createdAtEpochMs: NOW - 600_000,
    updatedAtEpochMs: NOW - 1_000,
    ...overrides,
  };
}

/** An active, proven Airwallex configuration, built with STEP 166's own functions. */
async function activeConfigStore(): Promise<{
  readonly configStore: InMemoryAirwallexConfigStore;
  readonly tokenCache: InMemoryAirwallexTokenCache;
}> {
  const configStore = new InMemoryAirwallexConfigStore();
  const tokenCache = new InMemoryAirwallexTokenCache();
  const configured = configureAirwallexKeys(
    { companyId, environment: "sandbox", clientId, apiKey, webhookSecret: null },
    { store: configStore, keyring, occurredAtEpochMs: NOW },
  );
  if (configured.status !== "configured") throw new Error("the fixture configuration failed");
  await testAirwallexConnection(configured.config.id, {
    store: configStore,
    keyring,
    occurredAtEpochMs: NOW,
    tokenCache,
    transport: async (call) =>
      call.path === AIRWALLEX_LOGIN_PATH ? { status: 201, body: loginAnswer } : { status: 200, body: balancesAnswer },
  });
  const activated = activateAirwallexConfig(configured.config.id, { store: configStore, occurredAtEpochMs: NOW });
  if (activated.status !== "activated") throw new Error("the fixture configuration was not activated");
  tokenCache.clear(configured.config.id);
  return { configStore, tokenCache };
}

const transferAnswer = (status: string, id = transferId): string => JSON.stringify({ id, status });

async function optionsFor(
  answerFor: (call: AirwallexPayoutCall) => { readonly status: number; readonly body: string } = () => ({
    status: 200,
    body: transferAnswer("PAID"),
  }),
  provision: AirwallexAccountProvision = activeProvision(),
): Promise<{
  readonly options: AirwallexPayoutOptions;
  readonly calls: AirwallexPayoutCall[];
  readonly audit: AirwallexPayoutAuditEntry[];
  readonly payoutStore: InMemoryAirwallexPayoutStore;
}> {
  const company = await activeConfigStore();
  const calls: AirwallexPayoutCall[] = [];
  const audit: AirwallexPayoutAuditEntry[] = [];
  const payoutStore = new InMemoryAirwallexPayoutStore();
  return {
    calls,
    audit,
    payoutStore,
    options: {
      provision,
      configStore: company.configStore,
      keyring,
      tokenCache: company.tokenCache,
      payoutStore,
      occurredAtEpochMs: NOW,
      transport: async (call) => {
        calls.push(call);
        return answerFor(call);
      },
      loginTransport: async (call) =>
        call.path === AIRWALLEX_LOGIN_PATH ? { status: 201, body: loginAnswer } : { status: 200, body: balancesAnswer },
      recordAudit: (entry) => audit.push(entry),
    },
  };
}

/** Book one payout and attach a transfer id, the state most checks below start from. */
async function bookedPayout(
  overrides: Partial<AirwallexPayoutRecord> = {},
): Promise<{
  readonly options: AirwallexPayoutOptions;
  readonly payoutStore: InMemoryAirwallexPayoutStore;
  readonly payoutId: string;
  readonly audit: AirwallexPayoutAuditEntry[];
  readonly calls: AirwallexPayoutCall[];
}> {
  const { options, payoutStore, audit, calls } = await optionsFor();
  const booked = bookAirwallexPayout(request, options);
  if (booked.status !== "booked") throw new Error(`the payout fixture did not book: ${reasonOf(booked)}`);
  const attached = attachAirwallexTransferId(booked.record.id, overrides.transferId ?? transferId, options);
  if (attached.status !== "attached" && attached.status !== "already_attached") {
    throw new Error(`the payout fixture did not attach a transfer id: ${reasonOf(attached)}`);
  }
  return { options, payoutStore, payoutId: booked.record.id, audit, calls };
}

/* ---- the documented surface ---- */

function checkSurface(): void {
  expectEqual(AIRWALLEX_TRANSFER_CREATE_PATH, "/api/v1/transfers/create", "the create path is the documented one");
  expectEqual(AIRWALLEX_ENDPOINTS["transferCreate"], AIRWALLEX_TRANSFER_CREATE_PATH, "the create path matches STEP 165's");
  expectEqual(AIRWALLEX_ENDPOINTS["transferRetrieve"], "/api/v1/transfers/{id}", "the read path is the documented one");
  expectEqual(AIRWALLEX_TRANSFER_READ_PATH_PREFIX, "/api/v1/transfers/", "the read prefix is the documented one");
  expectEqual(AIRWALLEX_BENEFICIARY_CREATE_PATH, "/api/v1/beneficiaries/create", "the beneficiary path is documented");
  expectEqual(AIRWALLEX_ENDPOINTS["beneficiaryCreate"], AIRWALLEX_BENEFICIARY_CREATE_PATH, "it matches STEP 165's too");
  expectEqual(AIRWALLEX_PAYOUT_TIMEOUT_MS, 20_000, "the timeout is twenty seconds");
  expectEqual(AIRWALLEX_PAYOUT_TEXT_MAXIMUM_LENGTH, 200, "the stored text is bounded");

  // The one path this file may call.
  expectEqual(isAirwallexPayoutPath(`/api/v1/transfers/${transferId}`), true, "a transfer read is callable");
  expectEqual(isAirwallexPayoutPath(AIRWALLEX_TRANSFER_CREATE_PATH), false, "the create path is not callable");
  expectEqual(isAirwallexPayoutPath(AIRWALLEX_BENEFICIARY_CREATE_PATH), false, "the beneficiary path is not callable");
  expectEqual(isAirwallexPayoutPath("/api/v1/transfers/"), false, "the bare prefix is not a read");
  expectEqual(isAirwallexPayoutPath("/api/v1/transfers/short"), false, "a short id is not a read");
  expectEqual(isAirwallexPayoutPath("/api/v1/transfers/../accounts/create"), false, "a traversal is not a read");
  expectEqual(AIRWALLEX_PAYOUT_ALLOWED_PATH_PATTERNS.length, 1, "exactly one path shape is allowed");
  expect(Object.isFrozen(AIRWALLEX_PAYOUT_ALLOWED_PATH_PATTERNS), "the allowlist is frozen");

  expectEqual(isAirwallexTransferId(transferId), true, "a transfer id is accepted");
  expectEqual(isAirwallexTransferId(transferId.trim()), true, "a padded transfer id is accepted");
  expectEqual(isAirwallexTransferId("short"), false, "a short id is refused");
  expectEqual(isAirwallexTransferId(accountId), false, "a connected-account id is never a transfer id");
  expectEqual(isAirwallexTransferId("tra_Kd payout 1"), false, "an id with a space is refused");
  expectEqual(isAirwallexBeneficiaryId(beneficiaryId), true, "a beneficiary id is accepted");
  expectEqual(isAirwallexBeneficiaryId(accountId), false, "a connected-account id is never a beneficiary id");
  expectEqual(isAirwallexBeneficiaryId("ben"), false, "a short beneficiary id is refused");

  expectEqual(airwallexTransferPath(transferId), `/api/v1/transfers/${transferId}`, "the read path is built from the id");
  expectThrows(() => airwallexTransferPath("nope"), "a short id builds no read path");
  expectThrows(() => airwallexTransferPath(accountId), "an account id builds no transfer path");

  // The two refusals, which are the whole story of the unread pages.
  const refusedTransfer = createAirwallexTransfer();
  expectEqual(refusedTransfer.status, "unsupported", "creating a transfer is refused");
  expectEqual(refusedTransfer.reason, AIRWALLEX_TRANSFER_BODY_NOT_RECORDED, "the refusal names the unread body");
  expect(refusedTransfer.reason.includes("not read"), "the refusal says the page was never read");
  const refusedBeneficiary = createAirwallexBeneficiary();
  expectEqual(refusedBeneficiary.status, "unsupported", "creating a beneficiary is refused");
  expect(refusedBeneficiary.reason.includes("not read"), "the beneficiary refusal says the page was never read");

  expectEqual(AIRWALLEX_PAYOUT_FINAL_STATUSES.includes("FAILED"), true, "FAILED is final");
  expectEqual(AIRWALLEX_PAYOUT_FINAL_STATUSES.includes("CANCELLED"), true, "CANCELLED is final");
  expectEqual(AIRWALLEX_TRANSFER_TERMINAL_STATUSES.includes("PAID"), false, "STEP 165 records PAID as non-terminal");
  expectEqual(AIRWALLEX_PAYOUT_FINAL_STATUSES.includes("PAID"), false, "PAID is never final on its own");
  expectEqual(AIRWALLEX_PAYOUT_FINAL_STATUSES.includes("IN_APPROVAL"), false, "an approval state is not final");
}

/** The real transport refuses the shapes it must before a socket is opened, so this half needs no network either. */
async function checkTransport(): Promise<void> {
  const good = {
    method: "GET" as const,
    environment: "sandbox" as const,
    path: `/api/v1/transfers/${transferId}`,
    accessToken,
    apiVersion: "2026-01-01",
    onBehalfOf: accountId,
  };
  await expectRejects(
    () => airwallexPayoutFetchTransport({ ...good, path: AIRWALLEX_TRANSFER_CREATE_PATH }),
    "the transport refuses the create path it does not own",
  );
  await expectRejects(
    () => airwallexPayoutFetchTransport({ ...good, path: AIRWALLEX_BENEFICIARY_CREATE_PATH }),
    "the transport refuses the beneficiary path",
  );
  await expectRejects(
    () => airwallexPayoutFetchTransport({ ...good, path: "/api/v1/transfers/short" }),
    "the transport refuses a malformed read path",
  );
  await expectRejects(() => airwallexPayoutFetchTransport({ ...good, accessToken: "  " }), "the transport refuses an empty token");
  await expectRejects(() => airwallexPayoutFetchTransport({ ...good, apiVersion: "" }), "the transport refuses an empty API version");
  await expectRejects(
    () => airwallexPayoutFetchTransport({ ...good, onBehalfOf: "not-an-account" }),
    "the transport refuses an acting account that is not one",
  );
}

/* ---- validation and the derived request id ---- */

function checkValidation(): void {
  expectEqual(validateAirwallexPayoutRequest(request), null, "a documented request validates");
  expectEqual(
    validateAirwallexPayoutRequest({ ...request, amountMinor: 0n }),
    "the amount must be greater than zero",
    "a zero amount is refused",
  );
  expectEqual(
    validateAirwallexPayoutRequest({ ...request, amountMinor: -1n }),
    "the amount must be greater than zero",
    "a negative amount is refused",
  );
  const eur = validateAirwallexPayoutRequest({ ...request, currency: "eur" });
  expectEqual(eur === null, false, "a currency other than USD is refused");
  expectEqual(
    validateAirwallexPayoutRequest({ ...request, beneficiaryId: "ben" }),
    "the beneficiary id is not one this adapter records",
    "a malformed beneficiary id is refused",
  );
  expectEqual(
    validateAirwallexPayoutRequest({ ...request, beneficiaryId: accountId }),
    "the beneficiary id is not one this adapter records",
    "an account id is refused as a beneficiary",
  );
  expectEqual(
    validateAirwallexPayoutRequest({ ...request, reference: "   " }),
    "a payout reference is required, because the request id derives from it",
    "an empty reference is refused",
  );
  expectEqual(
    validateAirwallexPayoutRequest({ ...request, reference: "x".repeat(121) }),
    "the payout reference is longer than 120 characters",
    "an over-long reference is refused",
  );
  expectEqual(
    validateAirwallexPayoutRequest({ ...request, reference: "payout x-api-key abc123" }),
    "the payout reference must not carry a credential",
    "a reference carrying a credential is refused",
  );

  const id = airwallexPayoutRequestId(request);
  expectEqual(id, airwallexPayoutRequestId({ ...request, reference: `  ${request.reference}  ` }), "the request id ignores padding");
  expectEqual(id === airwallexPayoutRequestId({ ...request, reference: "payout-2026-0002" }), false, "another reference derives another id");
  expectEqual(id === airwallexPayoutRequestId({ ...request, companyId: otherCompanyId }), false, "another company derives another id");
  expect(AIRWALLEX_REQUEST_ID_PATTERN.test(id), "the derived id is a documented request id");
  expectEqual(id.length, 43, "the derived id is a fixed-width digest");
  expect(id.includes("payout-2026-0001") === false, "the reference itself is not in the id");
}

/* ---- booking ---- */

async function checkBooking(): Promise<void> {
  const { options, payoutStore, audit } = await optionsFor();

  const booked = bookAirwallexPayout(request, options);
  expectEqual(booked.status, "booked", "a ready account books a payout");
  if (booked.status !== "booked") throw new Error(`booking failed: ${reasonOf(booked)}`);
  const record = booked.record;
  expectEqual(record.providerKey, AIRWALLEX_PROVIDER_KEY, "the record names the provider");
  expectEqual(record.companyId, companyId, "the record names the company");
  expectEqual(record.environment, "sandbox", "the record takes the configuration's mode");
  expectEqual(record.amountMinor, 250_000n, "the record keeps the platform's minor units");
  expectEqual(record.currency, "usd", "the record keeps the currency");
  expectEqual(record.beneficiaryId, beneficiaryId, "the record keeps the beneficiary");
  expectEqual(record.requestId, airwallexPayoutRequestId(request), "the record keeps the derived request id");
  expectEqual(record.transferId, null, "a booked payout carries no transfer id");
  expectEqual(record.providerStatus, null, "a booked payout has no provider status");
  expectEqual(record.outcome, null, "a booked payout claims no outcome");
  expectEqual(record.provisional, false, "a booked payout is not provisional");
  expectEqual(record.final, false, "a booked payout is not final");
  expectEqual(record.requiresReconciliation, false, "a booked payout needs no reconciliation");
  expectEqual(record.version, 1, "a booked payout starts at version 1");
  expectEqual(record.createdAtEpochMs, NOW, "the booking time is the caller's clock");
  expectEqual(record.reason, null, "a booked payout carries no reason");

  expectEqual(audit.length, 1, "booking writes one audit entry");
  expectEqual(audit[0]?.action, "airwallex_payout.booked", "the audit names a booking");
  expectEqual(audit[0]?.payoutId, record.id, "the audit names the payout");
  expectEqual(audit[0]?.transferId, null, "the audit names no transfer yet");
  expect(asText(audit).includes(accessToken) === false, "no audit entry carries a token");
  expect(asText(audit).includes(apiKey) === false, "no audit entry carries the API key");
  expect(asText(record).includes(accessToken) === false, "the record carries no token");

  const again = bookAirwallexPayout(request, options);
  expectEqual(again.status, "already_booked", "the same reference books once");
  if (again.status === "already_booked") expectEqual(again.record.id, record.id, "the second booking answers the first row");
  expectEqual(audit.length, 1, "a duplicate booking writes no second audit entry");

  const ledger = airwallexPayoutLedgerOutcome(record);
  expectEqual(ledger.outcome, "none", "a booked payout is nothing for the ledger yet");
  expectEqual(ledger.provisional, false, "a booked payout is not provisional money");
  expectEqual(ledger.final, false, "a booked payout is not final");
  expectEqual(ledger.needsAttention, false, "a booked payout needs no attention");
  expect(ledger.reason !== null && ledger.reason.includes("transfer id"), "the ledger says why there is nothing yet");
  expectEqual(airwallexPayoutCanStillFail(record), false, "a booked payout cannot fail yet, it has not been sent");

  // The two refusals booking owes.
  const other = bookAirwallexPayout({ ...request, companyId: companyId, reference: "payout-2026-0003" }, {
    ...options,
    provision: activeProvision({ companyId: otherCompanyId }),
  });
  expectEqual(other.status, "failed", "another company's account cannot book this company's payout");
  if (other.status === "failed") expect(other.reason.includes("another company"), "the refusal names the mismatch");

  const waiting = bookAirwallexPayout({ ...request, reference: "payout-2026-0004" }, {
    ...options,
    provision: activeProvision({ accountStatus: "CREATED" }),
  });
  expectEqual(waiting.status, "failed", "an account that is not ACTIVE cannot receive a payout");
  if (waiting.status === "failed") expect(waiting.reason.length > 0, "the refusal says why");

  const unknown = bookAirwallexPayout({ ...request, reference: "payout-2026-0005" }, {
    ...options,
    provision: activeProvision({ attemptStatus: "unknown" }),
  });
  expectEqual(unknown.status, "failed", "an account whose creation is unknown cannot receive a payout");
  if (unknown.status === "failed") expect(unknown.reason.includes("reconciliation"), "the refusal asks for reconciliation");

  const missing = bookAirwallexPayout({ ...request, reference: "payout-2026-0006" }, {
    ...options,
    provision: activeProvision({ attemptStatus: "created", accountId: null }),
  });
  expectEqual(missing.status, "failed", "an account that was never created cannot receive a payout");

  const unconfigured = bookAirwallexPayout({ ...request, reference: "payout-2026-0007" }, {
    ...options,
    configStore: new InMemoryAirwallexConfigStore(),
    provision: activeProvision(),
  });
  expectEqual(unconfigured.status, "failed", "a company with no active configuration books nothing");

  const invalid = bookAirwallexPayout({ ...request, amountMinor: 0n, reference: "payout-2026-0008" }, options);
  expectEqual(invalid.status, "failed", "an invalid amount books nothing");
  expectEqual(payoutStore.findByRequestId(companyId, airwallexPayoutRequestId({ ...request, amountMinor: 0n, reference: "payout-2026-0008" })), null, "nothing was written for it");
}

/* ---- attaching a transfer id ---- */

async function checkAttach(): Promise<void> {
  const { options, payoutStore, audit } = await optionsFor();
  const booked = bookAirwallexPayout(request, options);
  if (booked.status !== "booked") throw new Error("the fixture payout did not book");

  expectEqual(attachAirwallexTransferId(booked.record.id, "short", options).status, "failed", "a short transfer id is refused");
  expectEqual(attachAirwallexTransferId(booked.record.id, accountId, options).status, "failed", "an account id is refused as a transfer id");
  expectEqual(attachAirwallexTransferId("no-such-payout", transferId, options).status, "failed", "an unknown payout takes no id");
  expectEqual(payoutStore.findById(booked.record.id)?.transferId, null, "no refused attach wrote an id");

  const attached = attachAirwallexTransferId(booked.record.id, transferId, options);
  expectEqual(attached.status, "attached", "a transfer id attaches once");
  if (attached.status !== "attached") throw new Error(`attach failed: ${reasonOf(attached)}`);
  expectEqual(attached.record.transferId, transferId, "the record keeps the transfer id");
  expectEqual(attached.record.outcome, null, "an attached id proves no status");
  expectEqual(attached.record.version, 2, "attaching moves the record once");
  expectEqual(attached.record.updatedAtEpochMs, NOW, "the attach time is the caller's clock");
  expectEqual(audit[audit.length - 1]?.action, "airwallex_payout.transfer_attached", "the attach is audited");
  expectEqual(audit[audit.length - 1]?.transferId, transferId, "the audit names the transfer");

  expectEqual(attachAirwallexTransferId(booked.record.id, transferId, options).status, "already_attached", "the same id attaches once");
  expectEqual(attachAirwallexTransferId(booked.record.id, otherTransferId, options).status, "failed", "another id is refused");
  expectEqual(payoutStore.findById(booked.record.id)?.transferId, transferId, "the first id is the one kept");
  expectEqual(payoutStore.findByTransferId(companyId, transferId)?.id, booked.record.id, "the transfer id finds its payout");
  expectEqual(payoutStore.findByTransferId(companyId, otherTransferId), null, "the refused id finds nothing");

  const ledger = airwallexPayoutLedgerOutcome(payoutStore.findById(booked.record.id) as AirwallexPayoutRecord);
  expectEqual(ledger.outcome, "none", "an attached id is still nothing for the ledger");
  expect(ledger.reason !== null && ledger.reason.includes("status"), "the ledger says the status is unread");
}

/* ---- reading a transfer ---- */

async function checkRead(): Promise<void> {
  const paid = await bookedPayout();
  const read = await readAirwallexTransfer(transferId, paid.options);
  expectEqual(read.status, "read", "a documented answer is a read");
  if (read.status === "read") {
    expectEqual(read.transferId, transferId, "the read names the transfer");
    expectEqual(read.providerStatus, "PAID", "the read names the status");
    expectEqual(read.outcome, "paid", "PAID reads paid");
    expectEqual(read.provisional, true, "PAID reads provisional");
  }
  expectEqual(paid.calls.length, 1, "one read makes one call");
  const call = paid.calls[0];
  expectEqual(call?.method, "GET", "the read is a GET");
  expectEqual(call?.path, `/api/v1/transfers/${transferId}`, "the read uses the transfer path");
  expectEqual(call?.environment, "sandbox", "the read uses the stored mode");
  expectEqual(call?.accessToken, accessToken, "the read carries the cached token");
  expectEqual(call?.onBehalfOf, accountId, "the read acts for the connected account");
  expect(AIRWALLEX_ON_BEHALF_OF_HEADER.length > 0, "the acting account travels in the documented header");
  expect((call?.apiVersion ?? "").length > 0, "the read pins the stored API version");
  expect(Object.keys(call ?? {}).includes("body") === false, "a read carries no body");

  const inFlight = await bookedPayout();
  const processing = await readAirwallexTransfer(transferId, {
    ...inFlight.options,
    transport: async () => ({ status: 200, body: transferAnswer("PROCESSING") }),
  });
  expectEqual(processing.status === "read" ? processing.outcome : "none", "in_flight", "PROCESSING is in flight");
  expectEqual(processing.status === "read" ? processing.provisional : true, false, "an in-flight transfer is not provisional");

  for (const [status, expected] of [
    ["FAILED", "failed"],
    ["CANCELLED", "cancelled"],
    ["SCHEDULED", "in_flight"],
    ["IN_APPROVAL", "in_flight"],
    ["SENT", "in_flight"],
    ["OVERDUE", "in_flight"],
    ["APPROVAL_BLOCKED", "in_flight"],
    ["APPROVAL_REJECTED", "in_flight"],
  ] as const) {
    const each = await bookedPayout();
    const answer = await readAirwallexTransfer(transferId, {
      ...each.options,
      transport: async () => ({ status: 200, body: transferAnswer(status) }),
    });
    expectEqual(answer.status === "read" ? answer.outcome : "not_read", expected, `${status} reads ${expected}`);
    expectEqual(answer.status === "read" ? answer.provisional : null, false, `${status} claims no provisional payment`);
  }

  const notFound = await bookedPayout();
  expectEqual(
    (await readAirwallexTransfer(transferId, { ...notFound.options, transport: async () => ({ status: 404, body: "{}" }) })).status,
    "not_found",
    "404 is not_found",
  );

  for (const status of [400, 401, 403, 500, 502, 429, 302, 418]) {
    const each = await bookedPayout();
    const answer = await readAirwallexTransfer(transferId, {
      ...each.options,
      transport: async () => ({ status, body: JSON.stringify({ message: "nope" }) }),
    });
    expectEqual(answer.status === "read", false, `${status} never settles a status`);
    expect(answer.status === "failed", `${status} is reported as a failure`);
  }

  const unrecorded = await bookedPayout();
  const mystery = await readAirwallexTransfer(transferId, {
    ...unrecorded.options,
    transport: async () => ({ status: 200, body: transferAnswer("MYSTERY") }),
  });
  expectEqual(mystery.status, "failed", "an undocumented status is not a read");
  if (mystery.status === "failed") expect(mystery.reason.includes("no id or no status"), "the failure says what was missing");
  expectEqual(mystery.status === "read" ? mystery.outcome : "paid", "paid", "an undocumented status never reads paid");

  const otherId = await bookedPayout();
  const mismatch = await readAirwallexTransfer(transferId, {
    ...otherId.options,
    transport: async () => ({ status: 200, body: transferAnswer("PAID", otherTransferId) }),
  });
  expectEqual(mismatch.status, "failed", "an answer about another transfer is not a read");
  if (mismatch.status === "failed") expect(mismatch.reason.includes("another transfer"), "the failure names the mismatch");

  const broken = await bookedPayout();
  const unreachable = await readAirwallexTransfer(transferId, {
    ...broken.options,
    transport: async () => {
      throw new Error("the socket closed");
    },
  });
  expectEqual(unreachable.status, "failed", "an unreachable API leaves the status unread");
  if (unreachable.status === "failed") expect(unreachable.reason.includes("unknown"), "the failure says the status is unknown");

  const noCall = await bookedPayout();
  const badId = await readAirwallexTransfer("short", noCall.options);
  expectEqual(badId.status, "failed", "a short id is refused before any call");
  expectEqual(noCall.calls.length, 0, "a refused id makes no call");

  // The answer readers, on their own.
  expectEqual(airwallexTransferStatusOf(transferAnswer("PAID")), "PAID", "the status reader finds the status");
  expectEqual(airwallexTransferStatusOf(JSON.stringify({ status: "paid" })), "PAID", "the status reader upper-cases");
  expectEqual(airwallexTransferStatusOf(JSON.stringify({ status: "MYSTERY" })), null, "an undocumented status reads null");
  expectEqual(airwallexTransferStatusOf("not json"), null, "an unreadable body reads null");
  expectEqual(airwallexTransferIdOf(transferAnswer("PAID")), transferId, "the id reader finds the id");
  expectEqual(airwallexTransferIdOf(JSON.stringify({ id: accountId })), null, "an account id is not a transfer id");
  expectEqual(airwallexPayoutMessageOf(JSON.stringify({ message: "  refused  " })), "refused", "the provider's own words are read");
  expectEqual(airwallexPayoutMessageOf("{}"), "", "a silent answer reads nothing");

  const verdict = parseAirwallexTransferReadAnswer(200, transferAnswer("PAID"));
  expectEqual(verdict.outcome, "read", "a 200 with a status is a read");
  expectEqual(parseAirwallexTransferReadAnswer(201, transferAnswer("PAID")).outcome, "read", "any 2XX is a read");
  expectEqual(parseAirwallexTransferReadAnswer(200, "{}").outcome, "unknown", "a 200 without a status is unknown");
  expectEqual(parseAirwallexTransferReadAnswer(404, "{}").outcome, "not_found", "404 is not_found");
  expectEqual(parseAirwallexTransferReadAnswer(400, "{}").outcome, "failed", "400 is a failure");
  expectEqual(parseAirwallexTransferReadAnswer(401, "{}").outcome, "failed", "401 is a failure");
  expectEqual(parseAirwallexTransferReadAnswer(429, "{}").outcome, "unknown", "429 leaves it unread");
  expectEqual(parseAirwallexTransferReadAnswer(503, "{}").outcome, "unknown", "503 leaves it unread");
  expectEqual(parseAirwallexTransferReadAnswer(302, "{}").outcome, "unknown", "a redirect proves nothing");
}

/* ---- applying a status ---- */

async function checkApply(): Promise<void> {
  const paid = await bookedPayout();
  const applied = applyAirwallexPayoutStatus(paid.payoutId, "PAID", { ...paid.options, source: "read" });
  expectEqual(applied.status, "applied", "PAID is applied");
  if (applied.status !== "applied") throw new Error(`applying PAID failed: ${applied.reason}`);
  expectEqual(applied.record.outcome, "paid", "PAID records paid");
  expectEqual(applied.record.providerStatus, "PAID", "the provider's status is kept");
  expectEqual(applied.record.provisional, true, "a paid payout is provisional");
  expectEqual(applied.record.final, false, "a paid payout is not final");
  expectEqual(applied.record.version, 3, "applying moves the record once");
  expectEqual(applied.changed, true, "the first application changed the record");
  expectEqual(airwallexPayoutCanStillFail(applied.record), true, "a paid payout may still fail");
  expectEqual(paid.audit[paid.audit.length - 1]?.action, "airwallex_payout.status_read", "the application is audited");

  const ledger = airwallexPayoutLedgerOutcome(applied.record);
  expectEqual(ledger.outcome, "paid", "the ledger reads a paid payout");
  expectEqual(ledger.provisional, true, "the ledger is told it is provisional");
  expectEqual(ledger.final, false, "the ledger is told it is not final");

  const again = applyAirwallexPayoutStatus(paid.payoutId, "PAID", { ...paid.options, source: "webhook" });
  expectEqual(again.status, "refused", "the same status is not applied twice");
  if (again.status === "refused") expect(again.reason.includes("already holds"), "the refusal says the status is held");
  expectEqual(paid.payoutStore.findById(paid.payoutId)?.version, 3, "a refused application changes nothing");

  const backwards = applyAirwallexPayoutStatus(paid.payoutId, "PROCESSING", { ...paid.options, source: "read" });
  expectEqual(backwards.status, "refused", "a paid payout never drifts back to PROCESSING");
  if (backwards.status === "refused") expect(backwards.reason.includes("may not move"), "the refusal names the move");
  expectEqual(paid.payoutStore.findById(paid.payoutId)?.outcome, "paid", "the outcome stays paid");

  const late = applyAirwallexPayoutStatus(paid.payoutId, "FAILED", { ...paid.options, source: "webhook" });
  expectEqual(late.status, "applied", "a paid payout that later fails is applied");
  if (late.status !== "applied") throw new Error(`applying FAILED failed: ${late.reason}`);
  expectEqual(late.record.outcome, "failed", "the later failure records failed");
  expectEqual(late.record.final, true, "a failure is final");
  expectEqual(late.record.provisional, false, "a failure is no longer provisional");
  expectEqual(airwallexPayoutCanStillFail(late.record), false, "a failed payout has nothing left to fail");
  expectEqual(paid.audit[paid.audit.length - 1]?.action, "airwallex_payout.failed", "the failure is audited as a failure");
  expectEqual(airwallexPayoutLedgerOutcome(late.record).final, true, "the ledger is told the failure is final");

  const resurrect = applyAirwallexPayoutStatus(paid.payoutId, "PAID", { ...paid.options, source: "webhook" });
  expectEqual(resurrect.status, "refused", "a failed payout is never made paid again");

  const unknown = await bookedPayout();
  const unknownApplied = applyAirwallexPayoutStatus(unknown.payoutId, "MYSTERY", { ...unknown.options, source: "read" });
  expectEqual(unknownApplied.status, "applied", "an undocumented status is recorded");
  if (unknownApplied.status === "applied") {
    expectEqual(unknownApplied.record.outcome, "unknown", "an undocumented status is unknown");
    expectEqual(unknownApplied.record.requiresReconciliation, true, "an undocumented status asks for reconciliation");
    expectEqual(unknownApplied.record.final, false, "an undocumented status is not final");
    expect(unknownApplied.record.reason !== null && unknownApplied.record.reason.includes("MYSTERY"), "the record names the status");
    expectEqual(airwallexPayoutLedgerOutcome(unknownApplied.record).needsAttention, true, "the ledger is told a person is needed");
  }
  const settled = applyAirwallexPayoutStatus(unknown.payoutId, "PAID", { ...unknown.options, source: "read" });
  expectEqual(settled.status, "applied", "an unknown status may still settle");
  if (settled.status === "applied") {
    expectEqual(settled.record.outcome, "paid", "a later read settles it paid");
    expectEqual(settled.record.requiresReconciliation, false, "settling clears the reconciliation flag");
  }

  const cancelled = await bookedPayout();
  const cancelledApplied = applyAirwallexPayoutStatus(cancelled.payoutId, "CANCELLED", { ...cancelled.options, source: "webhook" });
  expectEqual(cancelledApplied.status, "applied", "CANCELLED is applied");
  if (cancelledApplied.status === "applied") {
    expectEqual(cancelledApplied.record.outcome, "cancelled", "CANCELLED records cancelled");
    expectEqual(cancelledApplied.record.final, true, "a cancellation is final");
  }

  const inFlight = await bookedPayout();
  const scheduled = applyAirwallexPayoutStatus(inFlight.payoutId, "SCHEDULED", { ...inFlight.options, source: "webhook" });
  expectEqual(scheduled.status, "applied", "SCHEDULED is applied");
  if (scheduled.status === "applied") {
    expectEqual(scheduled.record.outcome, "in_flight", "SCHEDULED is in flight");
    expectEqual(scheduled.record.final, false, "an approval state is not final");
    expectEqual(airwallexPayoutCanStillFail(scheduled.record), false, "nothing has been paid yet");
  }
  const fromScheduled = applyAirwallexPayoutStatus(inFlight.payoutId, "PAID", { ...inFlight.options, source: "webhook" });
  expectEqual(fromScheduled.status, "applied", "an in-flight transfer may become paid");
  if (fromScheduled.status === "applied") expectEqual(fromScheduled.record.provisional, true, "it is paid and provisional");

  expectEqual(applyAirwallexPayoutStatus("no-such-payout", "PAID", { ...paid.options, source: "read" }).status, "failed", "an unknown payout takes no status");
}

/* ---- closing the window ---- */

async function checkWindow(): Promise<void> {
  const booked = await bookedPayout();
  const early = closeAirwallexPayoutWindow(booked.payoutId, booked.options);
  expectEqual(early.status, "refused", "a payout with no status has no window to close");
  if (early.status === "refused") expect(early.reason.includes("paid payout"), "the refusal says only a paid payout has a window");

  applyAirwallexPayoutStatus(booked.payoutId, "PROCESSING", { ...booked.options, source: "read" });
  expectEqual(closeAirwallexPayoutWindow(booked.payoutId, booked.options).status, "refused", "an in-flight payout has no window to close");

  const paid = await bookedPayout();
  applyAirwallexPayoutStatus(paid.payoutId, "PAID", { ...paid.options, source: "read" });
  const closed = closeAirwallexPayoutWindow(paid.payoutId, { ...paid.options, occurredAtEpochMs: NOW + 7 * 24 * 3_600_000 });
  expectEqual(closed.status, "applied", "a paid payout's window can be closed");
  if (closed.status !== "applied") throw new Error(`closing failed: ${closed.reason}`);
  expectEqual(closed.record.final, true, "closing makes the payout final");
  expectEqual(closed.record.provisional, false, "closing ends the provisional claim");
  expectEqual(closed.record.outcome, "paid", "closing never changes the outcome");
  expectEqual(closed.record.updatedAtEpochMs, NOW + 7 * 24 * 3_600_000, "closing records when it happened");
  expectEqual(airwallexPayoutCanStillFail(closed.record), false, "a closed payout cannot still fail");
  expectEqual(paid.audit[paid.audit.length - 1]?.action, "airwallex_payout.closed", "closing is audited");

  const ledger = airwallexPayoutLedgerOutcome(closed.record);
  expectEqual(ledger.outcome, "paid", "the ledger reads a paid payout");
  expectEqual(ledger.final, true, "the ledger may treat it as gone for good");
  expectEqual(ledger.provisional, false, "the ledger is no longer told it is provisional");

  expectEqual(closeAirwallexPayoutWindow(paid.payoutId, paid.options).status, "refused", "a closed payout has no window left");
  expectEqual(paid.payoutStore.findById(paid.payoutId)?.version, closed.record.version, "a second close changes nothing");

  const afterClose = applyAirwallexPayoutStatus(paid.payoutId, "FAILED", { ...paid.options, source: "webhook" });
  expectEqual(afterClose.status, "refused", "a failure after the window closed is refused, so a person sees it");
  expectEqual(paid.payoutStore.findById(paid.payoutId)?.outcome, "paid", "final money is not moved by a late delivery");
}

/* ---- the store's invariants ---- */

async function checkStore(): Promise<void> {
  const { options, payoutStore } = await optionsFor();
  const booked = bookAirwallexPayout(request, options);
  if (booked.status !== "booked") throw new Error("the store fixture did not book");
  const base = booked.record;

  expectThrows(() => payoutStore.insert(base), "a payout row cannot be inserted twice");
  expectThrows(() => payoutStore.insert({ ...base, id: "another" }), "a request id books one payout");
  expectThrows(
    () => payoutStore.insert({ ...base, id: "third", requestId: "kd1-third", outcome: "paid" }),
    "a booked payout claims no outcome",
  );
  expectThrows(
    () => payoutStore.insert({ ...base, id: "fourth", requestId: "kd1-fourth", transferId }),
    "a booked payout carries no transfer id",
  );
  expectThrows(
    () => payoutStore.insert({ ...base, id: "fifth", requestId: "kd1-fifth", final: true }),
    "a booked payout is not final",
  );

  const attach = attachAirwallexTransferId(base.id, transferId, options);
  if (attach.status !== "attached") throw new Error("the store fixture did not attach");
  const attached = attach.record;

  expectEqual(payoutStore.save({ ...attached, version: 9 }, 1), false, "a stale version cannot be saved");
  expectEqual(payoutStore.save({ ...attached, version: attached.version + 2 }, attached.version), false, "a version may only move by one");
  expectEqual(payoutStore.save({ ...attached, amountMinor: 1n, version: attached.version + 1 }, attached.version), false, "an amount never changes");
  expectEqual(payoutStore.save({ ...attached, currency: "eur", version: attached.version + 1 }, attached.version), false, "a currency never changes");
  expectEqual(payoutStore.save({ ...attached, requestId: "kd1-other", version: attached.version + 1 }, attached.version), false, "a request id never changes");
  expectEqual(payoutStore.save({ ...attached, companyId: otherCompanyId, version: attached.version + 1 }, attached.version), false, "a company never changes");
  expectEqual(payoutStore.save({ ...attached, environment: "live", version: attached.version + 1 }, attached.version), false, "a mode never changes");
  expectEqual(payoutStore.save({ ...attached, beneficiaryId: "ben_OtherBeneficiary01", version: attached.version + 1 }, attached.version), false, "a beneficiary never changes");
  expectEqual(payoutStore.save({ ...attached, transferId: null, version: attached.version + 1 }, attached.version), false, "a transfer id is never cleared");
  expectEqual(payoutStore.save({ ...attached, transferId: otherTransferId, version: attached.version + 1 }, attached.version), false, "a transfer id is never replaced");

  const paidRow: AirwallexPayoutRecord = {
    ...attached,
    providerStatus: "PAID",
    outcome: "paid",
    provisional: true,
    version: attached.version + 1,
  };
  expectEqual(payoutStore.save(paidRow, attached.version), true, "a paid provisional row saves");
  expectEqual(
    payoutStore.save({ ...paidRow, outcome: "in_flight", provisional: false, version: paidRow.version + 1 }, paidRow.version),
    false,
    "a paid row never drifts back to in flight",
  );
  expectEqual(
    payoutStore.save({ ...paidRow, outcome: "paid", final: true, provisional: true, version: paidRow.version + 1 }, paidRow.version),
    false,
    "a final row is never still provisional",
  );

  const failedRow: AirwallexPayoutRecord = {
    ...paidRow,
    providerStatus: "FAILED",
    outcome: "failed",
    provisional: false,
    final: true,
    version: paidRow.version + 1,
  };
  expectEqual(payoutStore.save(failedRow, paidRow.version), true, "a paid row may fail");
  expectEqual(
    payoutStore.save({ ...failedRow, outcome: "paid", final: false, provisional: true, version: failedRow.version + 1 }, failedRow.version),
    false,
    "a failed row is never made paid again",
  );
  expectEqual(
    payoutStore.save({ ...failedRow, outcome: "cancelled", version: failedRow.version + 1 }, failedRow.version),
    false,
    "a failed row is never cancelled either",
  );
  expectEqual(
    payoutStore.save({ ...failedRow, final: false, outcome: "failed", version: failedRow.version + 1 }, failedRow.version),
    false,
    "final never becomes false",
  );

  expectEqual(AIRWALLEX_PAYOUT_OUTCOME_MOVES.paid.includes("in_flight"), false, "the outcome table forbids paid to in flight");
  expectEqual(AIRWALLEX_PAYOUT_OUTCOME_MOVES.paid.includes("failed"), true, "the outcome table allows paid to fail");
  expectEqual(AIRWALLEX_PAYOUT_OUTCOME_MOVES.failed.join(","), "failed", "the outcome table makes failure final");
  expectEqual(AIRWALLEX_PAYOUT_OUTCOME_MOVES.cancelled.join(","), "cancelled", "the outcome table makes cancellation final");
  expectEqual(AIRWALLEX_PAYOUT_OUTCOME_MOVES.in_flight.includes("paid"), true, "an in-flight transfer may be paid");
  expect(Object.isFrozen(AIRWALLEX_PAYOUT_OUTCOME_MOVES) === true, "the outcome table is frozen");
}

/* ---- running ---- */

checkSurface();
checkValidation();
await checkBooking();
await checkAttach();
await checkTransport();
await checkRead();
await checkApply();
await checkWindow();
await checkStore();

if (failures.length > 0) {
  process.stderr.write(
    `payments Airwallex payout gate failed: ${failures.length} of ${checks} checks\n${failures
      .map((failure) => `  - ${failure}`)
      .join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `payments Airwallex payout gate passed: ${checks} checks (a payout is booked only for an ACTIVE connected account the company owns, the unread transfer and beneficiary create bodies are refused by name and their paths are not callable, the transfer id attaches once and proves no status, a read is accepted only for the id that was asked about, PAID is recorded paid and provisional so it may still fail while a failure or cancellation is final, and only the platform closing its window makes a paid payout final)\n`,
);
