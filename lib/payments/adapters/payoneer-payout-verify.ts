// path: lib/payments/adapters/payoneer-payout-verify.ts

/**
 * The gate for STEP 156: Payoneer automatic bank linking, payout execution and status handling.
 *
 * A check script, not a test file: it exercises the adapter with recorded provider answers and
 * locally verified notifications, then fails and names every check that did not hold. No network
 * call is made and no credential is used.
 */

import process from "node:process";
import {
  applyPayoneerPayoutNotification,
  buildPayoneerPayoutBody,
  buildPayoneerPayoutMethodDetails,
  buildPayoneerRegisterPayeeBody,
  InMemoryPayoneerSubmissionStore,
  mapPayoneerPayoutStatus,
  PAYONEER_API_PATHS_ARE_DOCUMENTED,
  PAYONEER_BANK_TRANSFER_METHOD,
  PAYONEER_MASS_PAYOUT_PATH,
  PAYONEER_PAYOUT_NOTIFICATIONS,
  PAYONEER_PAYOUT_STATUS_PATH,
  PAYONEER_REGISTER_PAYEE_PATH,
  PAYONEER_TRANSFERRED_STATUS,
  payoneerAmountString,
  payoneerApiBaseFor,
  payoneerFetchApiTransport,
  payoneerPayoutStatusOfNotification,
  payoneerProgramPath,
  readPayoneerPayoutStatus,
  registerPayoneerPayee,
  submitPayoneerPayout,
  toPayoutStatus,
  toProviderLinkResult,
  toProviderPayoutResult,
  validatePayoneerBankDetails,
  validatePayoneerPayeeProfile,
  withinPayoneerPayoutLimit,
  type PayoneerApiAnswer,
  type PayoneerApiRequest,
  type PayoneerBankDetails,
  type PayoneerPayeeProfile,
  type PayoneerPayoutAuditEntry,
  type PayoneerPayoutInstruction,
  type PayoneerSubmission,
} from "./payoneer-payout.ts";

/* ---- the check book ---- */

let checks = 0;
const failures: string[] = [];

function expect(condition: boolean, description: string): void {
  checks += 1;
  if (!condition) failures.push(description);
}

function expectEqual(actual: unknown, expected: unknown, description: string): void {
  checks += 1;
  if (actual !== expected) {
    failures.push(`${description} (expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)})`);
  }
}

function expectThrows(action: () => void, description: string): void {
  try {
    action();
  } catch {
    checks += 1;
    return;
  }
  checks += 1;
  failures.push(description);
}

async function expectRejection(action: () => Promise<unknown>, description: string): Promise<void> {
  try {
    await action();
  } catch {
    checks += 1;
    return;
  }
  checks += 1;
  failures.push(description);
}

/* ---- fixtures ---- */

const accessToken = "token_SANDBOX0123456789";
const programId = "program_100200300";
const clientReferenceId = "payout-0001-abcd";
const companyId = "018f2b8a-0000-4000-8000-0000000b0001";

const bank: PayoneerBankDetails = {
  bankName: "Bank of America",
  accountName: "Acme Incorporated",
  accountNumber: "827078555",
  routingNumber: "122105155",
  swiftCode: null,
  country: "US",
};

const swiftBank: PayoneerBankDetails = {
  bankName: "Deutsche Bank",
  accountName: "Acme Incorporated",
  accountNumber: "9876543210",
  routingNumber: null,
  swiftCode: "DEUTDEFF100",
  country: "DE",
};

const profile: PayoneerPayeeProfile = {
  companyId,
  payeeId: "payee-acme-0001",
  companyName: "Acme Incorporated",
  companyUrl: "https://acme.example.com",
  legalType: "INC",
  address1: "8742 Main St.",
  address2: null,
  city: "New York",
  state: "NY",
  zipCode: "10001",
  country: "US",
  currency: "USD",
};

function instructionOf(overrides: Partial<PayoneerPayoutInstruction> = {}): PayoneerPayoutInstruction {
  return {
    environment: "sandbox",
    accessToken,
    programId,
    companyId,
    clientReferenceId,
    providerPayeeId: "payee-acme-0001",
    amountMinor: 2_020n,
    currency: "USD",
    description: "Payout for June",
    bank: null,
    payeeName: "Acme Incorporated",
    ...overrides,
  };
}

const answer = (status: number, body: string): PayoneerApiAnswer => ({ status, body });

function transportOf(
  seen: PayoneerApiRequest[],
  reply: PayoneerApiAnswer,
): (request: PayoneerApiRequest) => Promise<PayoneerApiAnswer> {
  return async (request) => {
    seen.push(request);
    return reply;
  };
}

/* ------------------------------------------------------------------------------------------------
 * Section 1: the documented paths
 * ---------------------------------------------------------------------------------------------- */

expectEqual(PAYONEER_REGISTER_PAYEE_PATH, "/v4/programs/{program_id}/payees/register-payee-with-token", "the registration path is the documented one");
expectEqual(PAYONEER_MASS_PAYOUT_PATH, "/v4/programs/{program_id}/masspayouts", "the mass payout path is the documented one");
expectEqual(
  PAYONEER_PAYOUT_STATUS_PATH,
  "/v4/programs/{program_id}/payouts/{client_reference_id}/status",
  "the payout status path is the documented one",
);
expect(PAYONEER_API_PATHS_ARE_DOCUMENTED, "every path constant is a documented program path");
expectEqual(PAYONEER_TRANSFERRED_STATUS, "Transferred", "the transferred status is the documented one");
expectEqual(PAYONEER_BANK_TRANSFER_METHOD, "BANKTRANSFER", "the bank transfer method is the documented one");
expectEqual(payoneerApiBaseFor("sandbox"), "https://api.sandbox.payoneer.com", "the sandbox base is the documented one");
expectEqual(payoneerApiBaseFor("production"), "https://api.payoneer.com", "the production base is the documented one");
expectEqual(
  payoneerProgramPath(PAYONEER_MASS_PAYOUT_PATH, programId),
  "/v4/programs/program_100200300/masspayouts",
  "the program placeholder is filled",
);
expect(payoneerProgramPath(PAYONEER_MASS_PAYOUT_PATH, "a/b").includes("a%2Fb"), "the program id is encoded when it is filled");

/* ------------------------------------------------------------------------------------------------
 * Section 2: amounts
 * --------------------------------------------------------------------------------------------- */

expectEqual(payoneerAmountString(2_020n), "20.20", "a whole and cents amount is formatted as the documented decimal string");
expectEqual(payoneerAmountString(100n), "1.00", "one dollar keeps its cents");
expectEqual(payoneerAmountString(5n), "0.05", "five cents is formatted with a leading zero");
expectEqual(payoneerAmountString(1_000_000n), "10000.00", "a large amount keeps every digit");
expectEqual(payoneerAmountString(1n), "0.01", "the smallest amount is one cent");
expectEqual(payoneerAmountString(0n), null, "a zero amount is refused");
expectEqual(payoneerAmountString(-100n), null, "a negative amount is refused");

/* ------------------------------------------------------------------------------------------------
 * Section 3: validation
 * ---------------------------------------------------------------------------------------------- */

expectEqual(validatePayoneerBankDetails(bank), null, "the documented US bank block is valid");
expectEqual(validatePayoneerBankDetails(swiftBank), null, "the documented SWIFT bank block is valid");
expectEqual(validatePayoneerBankDetails({ ...bank, bankName: "" }), "the bank name must be 2 to 120 characters", "an empty bank name is refused");
expectEqual(validatePayoneerBankDetails({ ...bank, accountName: "a" }), "the account name must be 2 to 120 characters", "a one character account name is refused");
expectEqual(validatePayoneerBankDetails({ ...bank, accountNumber: "12345" }), "the account number must be 6 to 34 digits", "a short account number is refused");
expectEqual(validatePayoneerBankDetails({ ...bank, accountNumber: "12345abc" }), "the account number must be 6 to 34 digits", "an alphanumeric account number is refused");
expectEqual(
  validatePayoneerBankDetails({ ...bank, routingNumber: null, swiftCode: null }),
  "either a routing number or a SWIFT code is required",
  "a bank block with neither routing nor SWIFT is refused",
);
expectEqual(validatePayoneerBankDetails({ ...bank, routingNumber: "12210515" }), "the routing number must be 9 digits", "an eight digit routing number is refused");
expectEqual(validatePayoneerBankDetails({ ...bank, routingNumber: null, swiftCode: "DEUTDEFF" }), null, "an eight character SWIFT is valid");
expectEqual(validatePayoneerBankDetails({ ...bank, routingNumber: null, swiftCode: "deutdeff" }), "the SWIFT code is not valid", "a lowercase SWIFT is refused");
expectEqual(validatePayoneerBankDetails({ ...bank, country: "USA" }), "the bank country must be a two letter code", "a three letter country is refused");

expectEqual(validatePayoneerPayeeProfile(profile), null, "the documented payee profile is valid");
expectEqual(validatePayoneerPayeeProfile({ ...profile, payeeId: "bad payee!" }), "the payee id is invalid", "an invalid payee id is refused");
expectEqual(validatePayoneerPayeeProfile({ ...profile, companyName: "" }), "the company name must not be empty", "an empty company name is refused");
expectEqual(validatePayoneerPayeeProfile({ ...profile, companyUrl: "http://acme.example.com" }), "the company url must be an https url", "a non-https url is refused");
expectEqual(validatePayoneerPayeeProfile({ ...profile, legalType: "inc" }), "the legal type must be an upper case code", "a lowercase legal type is refused");
expectEqual(validatePayoneerPayeeProfile({ ...profile, address1: "" }), "the address line must not be empty", "an empty address is refused");
expectEqual(validatePayoneerPayeeProfile({ ...profile, city: "" }), "the city must not be empty", "an empty city is refused");
expectEqual(validatePayoneerPayeeProfile({ ...profile, state: "New York" }), "the state must be a two letter code", "a spelled-out state is refused");
expectEqual(validatePayoneerPayeeProfile({ ...profile, zipCode: "-10001" }), "the postal code is invalid", "an invalid postal code is refused");
expectEqual(validatePayoneerPayeeProfile({ ...profile, country: "USA" }), "the country must be a two letter code", "a three letter country is refused");
expectEqual(validatePayoneerPayeeProfile({ ...profile, currency: "usd" }), "the currency must be a three letter code", "a lowercase currency is refused");

/* ------------------------------------------------------------------------------------------------
 * Section 4: the documented request bodies
 * ---------------------------------------------------------------------------------------------- */

const registerBody = buildPayoneerRegisterPayeeBody(profile, bank) as Readonly<Record<string, unknown>>;
expectEqual(Object.keys(registerBody).sort().join(","), "payee,payee_id,payout_method", "the registration body carries the documented top level keys");
expectEqual(registerBody["payee_id"], "payee-acme-0001", "the body carries the platform's payee id");
const payeeBlock = registerBody["payee"] as Readonly<Record<string, unknown>>;
expectEqual(payeeBlock["type"], "company", "the payee is a company");
const companyBlock = payeeBlock["company"] as Readonly<Record<string, unknown>>;
expectEqual(Object.keys(companyBlock).sort().join(","), "incorporated_address_1,incorporated_city,incorporated_country,incorporated_state,incorporated_zipcode,legal_type,name,url", "the company block carries the documented fields");
expectEqual(companyBlock["name"], "Acme Incorporated", "the company name is sent");
expectEqual(companyBlock["legal_type"], "INC", "the legal type is sent");
expectEqual(companyBlock["incorporated_country"], "US", "the country is sent");
expectEqual(companyBlock["url"], "https://acme.example.com", "the company url is sent when present");
const methodBlock = registerBody["payout_method"] as Readonly<Record<string, unknown>>;
expectEqual(methodBlock["type"], "BANKTRANSFER", "the payout method is a bank transfer");
expectEqual(methodBlock["bank_account_type"], "company", "the account holder is a company");
expectEqual(methodBlock["country"], "US", "the payout method names the country");
expectEqual(methodBlock["currency"], "USD", "the payout method names the currency");

const minimalRegisterBody = buildPayoneerRegisterPayeeBody({ ...profile, companyUrl: null, address2: null }, bank) as Readonly<Record<string, unknown>>;
const minimalCompany = (minimalRegisterBody["payee"] as Readonly<Record<string, unknown>>)["company"] as Readonly<Record<string, unknown>>;
expectEqual(minimalCompany["url"], undefined, "an absent url is omitted");
expectEqual(minimalCompany["incorporated_address_2"], undefined, "an absent second address line is omitted");
const withAddress2 = buildPayoneerRegisterPayeeBody({ ...profile, address2: "Suite 4" }, bank) as Readonly<Record<string, unknown>>;
expectEqual(
  ((withAddress2["payee"] as Readonly<Record<string, unknown>>)["company"] as Readonly<Record<string, unknown>>)["incorporated_address_2"],
  "Suite 4",
  "a present second address line is sent",
);
expectThrows(() => buildPayoneerRegisterPayeeBody({ ...profile, companyName: "" }, bank), "an invalid profile is never built into a registration body");
expectThrows(() => buildPayoneerRegisterPayeeBody(profile, { ...bank, accountNumber: "12" }), "an invalid bank block is never built into a registration body");

const routingMethod = buildPayoneerPayoutMethodDetails(bank, "USD") as Readonly<Record<string, unknown>>;
const routingDetails = routingMethod["details"] as Readonly<Record<string, unknown>>;
expectEqual(routingDetails["bank_name"], "Bank of America", "the bank name is sent");
expectEqual(routingDetails["account_name"], "Acme Incorporated", "the account name is sent");
expectEqual(routingDetails["account_number"], "827078555", "the account number is sent");
expectEqual(routingDetails["routing_number"], "122105155", "the routing number is sent");
expectEqual(routingDetails["account_type"], "C", "the documented account type of the published example is sent for a routing account");
expectEqual(routingDetails["swift_code"], undefined, "no SWIFT code is sent for a routing account");
expectEqual(routingMethod["country"], "US", "the payout method names the bank country");
expectEqual(routingMethod["currency"], "USD", "the payout method names the currency");

const swiftMethod = buildPayoneerPayoutMethodDetails(swiftBank, "EUR") as Readonly<Record<string, unknown>>;
const swiftDetails = swiftMethod["details"] as Readonly<Record<string, unknown>>;
expectEqual(swiftDetails["swift_code"], "DEUTDEFF100", "the SWIFT code is sent for a SWIFT account");
expectEqual(swiftDetails["account_type"], undefined, "no account type is invented for a SWIFT account");
expectEqual(swiftDetails["routing_number"], undefined, "no routing number is sent for a SWIFT account");
expectThrows(() => buildPayoneerPayoutMethodDetails({ ...bank, accountNumber: "x" }, "USD"), "an invalid bank block is never built into a payout method");
expectThrows(() => buildPayoneerPayoutMethodDetails(bank, "usd"), "an invalid currency is never built into a payout method");

const payoutBody = buildPayoneerPayoutBody(instructionOf()) as Readonly<Record<string, unknown>>;
const payments = payoutBody["Payments"] as readonly Readonly<Record<string, unknown>>[];
expectEqual(payments.length, 1, "one instruction makes one payment");
const payment = payments[0] as Readonly<Record<string, unknown>>;
expectEqual(payment["client_reference_id"], clientReferenceId, "the payment carries the platform's reference");
expectEqual(payment["payee_id"], "payee-acme-0001", "the payment names the payee");
expectEqual(payment["amount"], "20.20", "the amount is the documented decimal string");
expectEqual(payment["currency"], "USD", "the payment carries the currency");
expectEqual(payment["description"], "Payout for June", "the payment carries the description");
expectEqual(payment["payout_method_details"], undefined, "no bank details are sent when the payee is already registered");
expect(withinPayoneerPayoutLimit(payoutBody), "one payment is within the documented limit");

const withBank = buildPayoneerPayoutBody(instructionOf({ bank })) as Readonly<Record<string, unknown>>;
const bankPayment = (withBank["Payments"] as readonly Readonly<Record<string, unknown>>[])[0] as Readonly<Record<string, unknown>>;
const bankDetails = bankPayment["payout_method_details"] as Readonly<Record<string, unknown>>;
expectEqual((bankDetails["payout_method"] as Readonly<Record<string, unknown>>)["country"], "US", "the payout method details name the country");
expectEqual(
  ((bankDetails["payee"] as Readonly<Record<string, unknown>>)["company"] as Readonly<Record<string, unknown>>)["name"],
  "Acme Incorporated",
  "the payout method details name the payee company",
);
expectThrows(() => buildPayoneerPayoutBody(instructionOf({ programId: "bad program" })), "an invalid program id is never built into a payout body");
expectThrows(() => buildPayoneerPayoutBody(instructionOf({ providerPayeeId: "bad payee!" })), "an invalid payee id is never built into a payout body");
expectThrows(() => buildPayoneerPayoutBody(instructionOf({ clientReferenceId: "bad ref!" })), "an invalid reference is never built into a payout body");
expectThrows(() => buildPayoneerPayoutBody(instructionOf({ currency: "usd" })), "an invalid currency is never built into a payout body");
expectThrows(() => buildPayoneerPayoutBody(instructionOf({ amountMinor: 0n })), "a zero amount is never built into a payout body");
expectThrows(() => buildPayoneerPayoutBody(instructionOf({ description: "" })), "an empty description is never built into a payout body");
expectThrows(() => buildPayoneerPayoutBody(instructionOf({ amountMinor: 2_000_000_000_000n })), "an out of range amount is never built into a payout body");

const sanitisedDescription = buildPayoneerPayoutBody(instructionOf({ description: "<b>Payout</b>\nfor June" })) as Readonly<Record<string, unknown>>;
expectEqual(
  ((sanitisedDescription["Payments"] as readonly Readonly<Record<string, unknown>>[])[0] as Readonly<Record<string, unknown>>)["description"],
  "bPayout/b for June",
  "the description is sanitised before it is sent",
);

/* ------------------------------------------------------------------------------------------------
 * Section 5: the transport
 * ---------------------------------------------------------------------------------------------- */

const originalFetch = globalThis.fetch;
try {
  let seenUrl = "";
  let seenInit: RequestInit | undefined;
  globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    seenUrl = String(url);
    seenInit = init;
    return new Response(JSON.stringify({ result: {} }), { status: 200 });
  };
  const posted = await payoneerFetchApiTransport({
    method: "POST",
    environment: "sandbox",
    path: payoneerProgramPath(PAYONEER_MASS_PAYOUT_PATH, programId),
    accessToken,
    body: { Payments: [] },
  });
  expectEqual(seenUrl, "https://api.sandbox.payoneer.com/v4/programs/program_100200300/masspayouts", "the transport posts to the documented endpoint");
  expectEqual(seenInit?.method, "POST", "the transport posts");
  expectEqual(seenInit?.redirect, "error", "the transport refuses redirects");
  expectEqual(JSON.stringify(seenInit?.headers).includes("Bearer"), true, "the transport sends a bearer token");
  expectEqual(JSON.stringify(seenInit?.headers).includes("application/json"), true, "the transport sends json");
  expectEqual(typeof seenInit?.body, "string", "the transport sends a json body");
  expectEqual(posted.status, 200, "the transport returns the status");

  const read = await payoneerFetchApiTransport({
    method: "GET",
    environment: "production",
    path: `/v4/programs/${programId}/payouts/${clientReferenceId}/status`,
    accessToken,
  });
  expectEqual(seenUrl, `https://api.payoneer.com/v4/programs/${programId}/payouts/${clientReferenceId}/status`, "a production read goes to the production base");
  expectEqual(seenInit?.method, "GET", "a status read is a GET");
  expectEqual(seenInit?.body, undefined, "a GET carries no body");
  expectEqual(read.status, 200, "the transport returns the read status");

  globalThis.fetch = async () => new Response("", { status: 422 });
  const refused = await payoneerFetchApiTransport({
    method: "POST",
    environment: "sandbox",
    path: payoneerProgramPath(PAYONEER_MASS_PAYOUT_PATH, programId),
    accessToken,
    body: { Payments: [] },
  });
  expectEqual(refused.status, 422, "a validation answer is returned, not thrown");

  globalThis.fetch = async () => new Response("x".repeat(300_000), { status: 200 });
  await expectRejection(
    () =>
      payoneerFetchApiTransport({
        method: "GET",
        environment: "sandbox",
        path: `/v4/programs/${programId}/payouts/${clientReferenceId}/status`,
        accessToken,
      }),
    "an oversized answer is refused",
  );

  await expectRejection(
    () => payoneerFetchApiTransport({ method: "GET", environment: "sandbox", path: "/v4/other/thing", accessToken }),
    "a path that is not a documented program path is refused",
  );
  await expectRejection(
    () =>
      payoneerFetchApiTransport({
        method: "GET",
        environment: "sandbox",
        path: `/v4/programs/${programId}/payouts/${clientReferenceId}/status`,
        accessToken: " ",
      }),
    "a call without an access token is refused",
  );
} finally {
  globalThis.fetch = originalFetch;
}

/* ------------------------------------------------------------------------------------------------
 * Section 6: payee registration — the automatic bank link
 * ---------------------------------------------------------------------------------------------- */

const seen: PayoneerApiRequest[] = [];
const audits: PayoneerPayoutAuditEntry[] = [];
const linked = await registerPayoneerPayee(
  { environment: "sandbox", accessToken, programId, profile, bank },
  { transport: transportOf(seen, answer(200, JSON.stringify({ payee_id: "payee-acme-0001", token: "reg-token-abcdef123456" }))), occurredAtEpochMs: 1_000, recordAudit: (entry) => audits.push(entry) },
);
expectEqual(seen.length, 1, "registration makes one call");
expectEqual(seen[0]?.method, "POST", "registration posts");
expectEqual(seen[0]?.path, "/v4/programs/program_100200300/payees/register-payee-with-token", "registration calls the documented path");
expectEqual(linked.outcome, "linked", "a named payee is a linked bank");
if (linked.outcome === "linked") {
  expectEqual(linked.providerPayeeId, "payee-acme-0001", "the payee id is read");
  expectEqual(linked.registrationReference, "reg-token-abcdef123456", "the registration token is kept for the payee");
  expectEqual(linked.programConfirmed, true, "a 2xx program call confirms the program");
}
expectEqual(audits.length, 1, "registration is audited");
expectEqual(audits[0]?.action, "payee_link.payoneer", "the audit entry names the link");
expectEqual(JSON.stringify(linked).includes(accessToken), false, "the link result carries no token");

const linkedById = await registerPayoneerPayee(
  { environment: "sandbox", accessToken, programId, profile, bank },
  { transport: async () => answer(201, JSON.stringify({ id: "payee-acme-0002", registration_link: "https://payouts.sandbox.payoneer.com/partners/lp.aspx?token=abc" })), occurredAtEpochMs: 1_001 },
);
expectEqual(linkedById.outcome, "linked", "a 201 answer links the payee");
if (linkedById.outcome === "linked") {
  expectEqual(linkedById.providerPayeeId, "payee-acme-0002", "an id field is read as the payee reference");
  expectEqual(linkedById.registrationReference?.startsWith("https://"), true, "a registration link is kept as the reference");
}

const refusedPayee = await registerPayoneerPayee(
  { environment: "sandbox", accessToken, programId, profile, bank },
  { transport: async () => answer(400, JSON.stringify({ message: "<b>payee_id</b> already exists" })), occurredAtEpochMs: 1_002 },
);
expectEqual(refusedPayee.outcome, "rejected", "a documented validation answer refuses the registration");
if (reusedCheck(refusedPayee)) {
  expectEqual(refusedPayee.reason, "bpayee_id/b already exists", "the provider message is carried sanitised");
  expectEqual(refusedPayee.programConfirmed, true, "a validation answer proves the program exists");
}

const payeeQueued = await registerPayoneerPayee(
  { environment: "sandbox", accessToken, programId, profile, bank },
  { transport: async () => answer(422, "{}"), occurredAtEpochMs: 1_003 },
);
expectEqual(payeeQueued.outcome, "rejected", "422 refuses the registration");

const payeeConflict = await registerPayoneerPayee(
  { environment: "sandbox", accessToken, programId, profile, bank },
  { transport: async () => answer(409, "{}"), occurredAtEpochMs: 1_004 },
);
expectEqual(payeeConflict.outcome, "rejected", "409 refuses the registration");

for (const status of [401, 403, 404, 429, 500]) {
  const unknown = await registerPayoneerPayee(
    { environment: "sandbox", accessToken, programId, profile, bank },
    { transport: async () => answer(status, "{}"), occurredAtEpochMs: 1_005 },
  );
  expectEqual(unknown.outcome, "unknown", `${status} is an unknown registration, never a refusal`);
  if (unknown.outcome === "unknown") {
    expectEqual(unknown.requiresReconciliation, true, `${status} asks for reconciliation`);
    expectEqual(unknown.programConfirmed, false, `${status} proves nothing about the program`);
  }
}

const payeeThrown = await registerPayoneerPayee(
  { environment: "sandbox", accessToken, programId, profile, bank },
  { transport: async () => { throw new Error(accessToken); }, occurredAtEpochMs: 1_006 },
);
expectEqual(payeeThrown.outcome, "unknown", "a transport failure is unknown");
expect(JSON.stringify(payeeThrown).includes(accessToken) === false, "a thrown error never leaks the token");

const shapelessPayee = await registerPayoneerPayee(
  { environment: "sandbox", accessToken, programId, profile, bank },
  { transport: async () => answer(200, JSON.stringify({ ok: true })), occurredAtEpochMs: 1_007 },
);
expectEqual(shapelessPayee.outcome, "unknown", "an answer without a payee id proves nothing");
const arrayPayee = await registerPayoneerPayee(
  { environment: "sandbox", accessToken, programId, profile, bank },
  { transport: async () => answer(200, "[]"), occurredAtEpochMs: 1_008 },
);
expectEqual(arrayPayee.outcome, "unknown", "an array answer proves nothing");

const noCall: PayoneerApiRequest[] = [];
expectEqual(
  (await registerPayoneerPayee(
    { environment: "sandbox", accessToken, programId, profile: { ...profile, companyName: "" }, bank },
    { transport: transportOf(noCall, answer(200, "{}")), occurredAtEpochMs: 1_009 },
  )).outcome,
  "rejected",
  "an invalid profile is refused before any call",
);
expectEqual(
  (await registerPayoneerPayee(
    { environment: "sandbox", accessToken, programId, profile, bank: { ...bank, accountNumber: "1" } },
    { transport: transportOf(noCall, answer(200, "{}")), occurredAtEpochMs: 1_010 },
  )).outcome,
  "rejected",
  "an invalid bank block is refused before any call",
);
expectEqual(
  (await registerPayoneerPayee(
    { environment: "sandbox", accessToken, programId: "bad program", profile, bank },
    { transport: transportOf(noCall, answer(200, "{}")), occurredAtEpochMs: 1_011 },
  )).outcome,
  "unknown",
  "an invalid program id is refused before any call",
);
expectEqual(
  (await registerPayoneerPayee(
    { environment: "sandbox", accessToken: " ", programId, profile, bank },
    { transport: transportOf(noCall, answer(200, "{}")), occurredAtEpochMs: 1_012 },
  )).outcome,
  "unknown",
  "a missing token is refused before any call",
);
expectEqual(noCall.length, 0, "the refusals make no call");

/* ---- the core's link port ---- */

const linkPort = toProviderLinkResult({ outcome: "linked", providerPayeeId: "payee-acme-0001", registrationReference: null, programConfirmed: true });
expectEqual(linkPort.status, "linked", "a linked payee satisfies the core's link port");
if (linkPort.status === "linked") expectEqual(linkPort.providerBankAccountId, "payee-acme-0001", "the core receives the payee reference");
const failedLinkPort = toProviderLinkResult({ outcome: "rejected", reason: "payee exists", programConfirmed: true });
expectEqual(failedLinkPort.status, "failed", "a refused registration fails the link");
if (failedLinkPort.status === "failed") expectEqual(failedLinkPort.reason, "payee exists", "the refusal reason reaches the core");
const unknownLinkPort = toProviderLinkResult({ outcome: "unknown", reason: "no answer", requiresReconciliation: true, programConfirmed: false });
expectEqual(unknownLinkPort.status, "failed", "an unknown registration never silently links");

/* ------------------------------------------------------------------------------------------------
 * Section 7: payout submission and its idempotency
 * ---------------------------------------------------------------------------------------------- */

const store = new InMemoryPayoneerSubmissionStore();
const submitAudits: PayoneerPayoutAuditEntry[] = [];
const submitSeen: PayoneerApiRequest[] = [];
const submitted = await submitPayoneerPayout(instructionOf(), {
  store,
  transport: transportOf(submitSeen, answer(200, JSON.stringify({ payout_id: "1636595702" }))),
  occurredAtEpochMs: 2_000,
  recordAudit: (entry) => submitAudits.push(entry),
});
expectEqual(submitSeen.length, 1, "a submission makes one call");
expectEqual(submitSeen[0]?.path, "/v4/programs/program_100200300/masspayouts", "the submission calls the documented path");
expectEqual(submitted.outcome, "pending", "an accepted instruction is pending, never success");
if (submitted.outcome === "pending") {
  expectEqual(submitted.providerPayoutId, "1636595702", "the provider payout id is read");
  expectEqual(submitted.requiresReconciliation, false, "a named payout needs no reconciliation");
}
expectEqual(store.findByClientReferenceId(clientReferenceId)?.outcome, "pending", "the submission is stored");
expectEqual(store.findByClientReferenceId(clientReferenceId)?.version, 2, "the settled outcome advances the stored version");
expectEqual(submitAudits.at(-1)?.action, "payout.payoneer_submitted", "the submission is audited");
expectEqual(submitAudits.at(-1)?.clientReferenceId, clientReferenceId, "the audit entry names the payout");

const replay = await submitPayoneerPayout(instructionOf(), {
  store,
  transport: transportOf(submitSeen, answer(200, JSON.stringify({ payout_id: "second" }))),
  occurredAtEpochMs: 2_001,
});
expectEqual(replay.outcome, "pending", "a replay answers with the stored outcome");
expectEqual(submitSeen.length, 1, "a replay makes no second provider call");

const replayOtherAmount = await submitPayoneerPayout(instructionOf({ amountMinor: 9_999n }), {
  store,
  transport: transportOf(submitSeen, answer(200, "{}")),
  occurredAtEpochMs: 2_002,
});
expectEqual(replayOtherAmount.outcome, "rejected", "a reference reused for another amount is refused");
if (replayOtherAmount.outcome === "rejected") expectEqual(replayOtherAmount.reason, "the client reference id already names another amount", "the refusal names the amount");

const replayOtherPayee = await submitPayoneerPayout(instructionOf({ providerPayeeId: "payee-other-0002" }), {
  store,
  transport: transportOf(submitSeen, answer(200, "{}")),
  occurredAtEpochMs: 2_003,
});
expectEqual(replayOtherPayee.outcome, "rejected", "a reference reused for another payee is refused");
expectEqual(submitSeen.length, 1, "the refused replays make no call");

const listedStore = new InMemoryPayoneerSubmissionStore();
const listedAsFailed = await submitPayoneerPayout(instructionOf({ clientReferenceId: "payout-listed-0002" }), {
  store: listedStore,
  transport: async () =>
    answer(200, JSON.stringify({ invalid_payments: [{ client_reference_id: "payout-listed-0002", message: "bank details are invalid" }] })),
  occurredAtEpochMs: 2_100,
});
expectEqual(listedAsFailed.outcome, "rejected", "an instruction the answer lists as failed is refused");
if (listedAsFailed.outcome === "rejected") expect(listedAsFailed.reason.includes("bank details are invalid"), "the listed reason is carried");
expectEqual(listedStore.findByClientReferenceId("payout-listed-0002")?.outcome, "rejected", "the refusal is stored");

const listedPlain = await submitPayoneerPayout(instructionOf({ clientReferenceId: "payout-listed-0003" }), {
  store: new InMemoryPayoneerSubmissionStore(),
  transport: async () => answer(200, JSON.stringify({ errors: ["payout-listed-0003"] })),
  occurredAtEpochMs: 2_101,
});
expectEqual(listedPlain.outcome, "rejected", "a plain list of failed references is read");

const unlisted = await submitPayoneerPayout(instructionOf({ clientReferenceId: "payout-ok-0004" }), {
  store: new InMemoryPayoneerSubmissionStore(),
  transport: async () => answer(200, JSON.stringify({ invalid_payments: [{ client_reference_id: "somebody-else" }] })),
  occurredAtEpochMs: 2_102,
});
expectEqual(unlisted.outcome, "pending", "a failure listed for another reference does not refuse this one");

for (const [status, expected] of [
  [400, "rejected"],
  [422, "rejected"],
  [409, "rejected"],
  [401, "unknown"],
  [403, "unknown"],
  [404, "unknown"],
  [429, "unknown"],
  [503, "unknown"],
  [302, "unknown"],
  [201, "pending"],
] as readonly (readonly [number, string])[]) {
  const run = await submitPayoneerPayout(instructionOf({ clientReferenceId: `payout-status-${status}` }), {
    store: new InMemoryPayoneerSubmissionStore(),
    transport: async () => answer(status, "{}"),
    occurredAtEpochMs: 2_200,
  });
  expectEqual(run.outcome, expected, `a ${status} submission answer is ${expected}`);
}

const submitThrown = await submitPayoneerPayout(instructionOf({ clientReferenceId: "payout-thrown-0005" }), {
  store: new InMemoryPayoneerSubmissionStore(),
  transport: async () => { throw new Error(accessToken); },
  occurredAtEpochMs: 2_300,
});
expectEqual(submitThrown.outcome, "unknown", "a transport failure is an unknown payout");
if (submitThrown.outcome === "unknown") expectEqual(submitThrown.requiresReconciliation, true, "an unknown payout asks for reconciliation");
expect(JSON.stringify(submitThrown).includes(accessToken) === false, "a thrown error never leaks the token");

const unreadableSubmit = await submitPayoneerPayout(instructionOf({ clientReferenceId: "payout-unreadable-0006" }), {
  store: new InMemoryPayoneerSubmissionStore(),
  transport: async () => answer(200, "not json"),
  occurredAtEpochMs: 2_301,
});
expectEqual(unreadableSubmit.outcome, "unknown", "an unreadable 200 proves nothing");

const noIdSubmit = await submitPayoneerPayout(instructionOf({ clientReferenceId: "payout-noid-0007" }), {
  store: new InMemoryPayoneerSubmissionStore(),
  transport: async () => answer(200, "{}"),
  occurredAtEpochMs: 2_302,
});
expectEqual(noIdSubmit.outcome, "pending", "an accepted instruction without an id is still pending");
if (noIdSubmit.outcome === "pending") expectEqual(noIdSubmit.requiresReconciliation, true, "an unnamed payout asks for reconciliation");

const invalidStore = new InMemoryPayoneerSubmissionStore();
const invalidCurrency = await submitPayoneerPayout(instructionOf({ currency: "usd" }), {
  store: invalidStore,
  transport: async () => answer(200, "{}"),
  occurredAtEpochMs: 2_400,
});
expectEqual(invalidCurrency.outcome, "rejected", "an invalid currency is refused before any call");
const zeroAmount = await submitPayoneerPayout(instructionOf({ amountMinor: 0n }), {
  store: invalidStore,
  transport: async () => answer(200, "{}"),
  occurredAtEpochMs: 2_401,
});
expectEqual(zeroAmount.outcome, "rejected", "a zero amount is refused before any call");
const noTokenSubmit = await submitPayoneerPayout(instructionOf({ accessToken: " " }), {
  store: invalidStore,
  transport: async () => answer(200, "{}"),
  occurredAtEpochMs: 2_402,
});
expectEqual(noTokenSubmit.outcome, "unknown", "a submission without a token is unknown");
expectEqual(invalidStore.findByClientReferenceId(clientReferenceId), null, "the refused submissions store nothing");

/* ---- the core's payout port ---- */

expectEqual(toProviderPayoutResult({ outcome: "pending", providerPayoutId: "x", clientReferenceId, requiresReconciliation: false, programConfirmed: true }).status, "pending", "an accepted instruction is pending for the core");
const coreRefusal = toProviderPayoutResult({ outcome: "rejected", reason: "bank invalid", clientReferenceId, programConfirmed: true });
expectEqual(coreRefusal.status, "failed", "a documented refusal is a failure for the core");
if (coreRefusal.status === "failed") expectEqual(coreRefusal.reason, "bank invalid", "the refusal reason reaches the core");
expectEqual(
  toProviderPayoutResult({ outcome: "unknown", reason: "no answer", clientReferenceId, requiresReconciliation: true, programConfirmed: false }).status,
  "pending",
  "an unknown is pending for the core, so no failure email is sent",
);

/* ------------------------------------------------------------------------------------------------
 * Section 8: status handling
 * ---------------------------------------------------------------------------------------------- */

const statusAudits: PayoneerPayoutAuditEntry[] = [];
const transferred = await readPayoneerPayoutStatus(
  { environment: "sandbox", accessToken, programId, clientReferenceId },
  {
    transport: async (request) => {
      expectEqual(request.method, "GET", "the status read is a GET");
      expectEqual(request.path, `/v4/programs/${programId}/payouts/${clientReferenceId}/status`, "the status read uses the documented path");
      return answer(200, JSON.stringify({ result: { status: "Transferred", load_date: "2021-03-17T14:09:39.54-04:00", amount: 5.1, currency: "USD" } }));
    },
    occurredAtEpochMs: 3_000,
    companyId,
    recordAudit: (entry) => statusAudits.push(entry),
  },
);
expectEqual(transferred.outcome, "success", "Transferred is the documented success status");
if (transferred.outcome === "success") {
  expectEqual(transferred.providerStatus, "Transferred", "the provider status is carried");
  expectEqual(transferred.loadedAtIso, "2021-03-17T14:09:39.54-04:00", "the documented load date is carried");
}
expectEqual(statusAudits.at(-1)?.action, "payout.payoneer_status", "the status read is audited");
expectEqual(statusAudits.at(-1)?.outcome, "success", "the audit entry records the mapped status");

const pendingStatus = await readPayoneerPayoutStatus(
  { environment: "sandbox", accessToken, programId, clientReferenceId },
  { transport: async () => answer(200, JSON.stringify({ result: { status: "Pending" } })), occurredAtEpochMs: 3_001, companyId },
);
expectEqual(pendingStatus.outcome, "unknown", "an undocumented status value is never claimed as success");
if (pendingStatus.outcome === "unknown") expectEqual(pendingStatus.requiresReconciliation, true, "an undocumented status asks for reconciliation");

const transferredWithoutLoad = await readPayoneerPayoutStatus(
  { environment: "sandbox", accessToken, programId, clientReferenceId },
  { transport: async () => answer(200, JSON.stringify({ result: { status: "Transferred" } })), occurredAtEpochMs: 3_002, companyId },
);
expectEqual(transferredWithoutLoad.outcome, "unknown", "Transferred without its documented marker is not claimed as success");

const flatStatus = await readPayoneerPayoutStatus(
  { environment: "sandbox", accessToken, programId, clientReferenceId },
  { transport: async () => answer(200, JSON.stringify({ status: "Transferred", load_date: "2021-03-17T14:09:39-04:00" })), occurredAtEpochMs: 3_003, companyId },
);
expectEqual(flatStatus.outcome, "success", "an unwrapped result object is also read");

const missingStatus = await readPayoneerPayoutStatus(
  { environment: "sandbox", accessToken, programId, clientReferenceId },
  { transport: async () => answer(200, JSON.stringify({ result: {} })), occurredAtEpochMs: 3_004, companyId },
);
expectEqual(missingStatus.outcome, "unknown", "a status answer without a status proves nothing");

for (const [status, expected] of [[404, "unknown"], [401, "unknown"], [500, "unknown"], [429, "unknown"]] as readonly (readonly [number, string])[]) {
  const run = await readPayoneerPayoutStatus(
    { environment: "sandbox", accessToken, programId, clientReferenceId },
    { transport: async () => answer(status, "{}"), occurredAtEpochMs: 3_005, companyId },
  );
  expectEqual(run.outcome, expected, `a ${status} status answer is unknown`);
}
const statusThrown = await readPayoneerPayoutStatus(
  { environment: "sandbox", accessToken, programId, clientReferenceId },
  { transport: async () => { throw new Error("timeout"); }, occurredAtEpochMs: 3_006, companyId },
);
expectEqual(statusThrown.outcome, "unknown", "a transport failure on a status read is unknown");
expectEqual(
  (await readPayoneerPayoutStatus(
    { environment: "sandbox", accessToken, programId, clientReferenceId: "bad ref!" },
    { transport: async () => answer(200, "{}"), occurredAtEpochMs: 3_007, companyId },
  )).outcome,
  "unknown",
  "an invalid reference is refused before any call",
);

expectEqual(mapPayoneerPayoutStatus("Transferred"), "success", "the documented status maps to success");
expectEqual(mapPayoneerPayoutStatus("Pending"), "unknown", "any other status maps to unknown");
expectEqual(mapPayoneerPayoutStatus(""), "unknown", "an empty status maps to unknown");
expectEqual(toPayoutStatus({ outcome: "success", providerStatus: "Transferred", clientReferenceId, loadedAtIso: null }), "success", "a success read stores success");
expectEqual(toPayoutStatus({ outcome: "pending", providerStatus: "Pending", clientReferenceId }), "pending", "a pending read stores pending");
expectEqual(toPayoutStatus({ outcome: "failed", providerStatus: "Failed", reason: "x", clientReferenceId }), "failed", "a failed read stores failed");
expectEqual(
  toPayoutStatus({ outcome: "unknown", providerStatus: null, reason: "x", clientReferenceId, requiresReconciliation: true }),
  "pending",
  "an unknown read stores pending, never failed",
);

/* ------------------------------------------------------------------------------------------------
 * Section 9: notifications are only believed through a verifier
 * ---------------------------------------------------------------------------------------------- */

const notificationAudits: PayoneerPayoutAuditEntry[] = [];
const refusedNoVerifier = applyPayoneerPayoutNotification(
  { rawBody: "{}", notificationName: "Payout canceled", clientReferenceId },
  { verify: null, occurredAtEpochMs: 4_000, companyId, recordAudit: (entry) => notificationAudits.push(entry) },
);
expectEqual(refusedNoVerifier.status, "refused", "a delivery with no verifier is refused");
if (refusedNoVerifier.status === "refused") {
  expect(refusedNoVerifier.reason.includes("no verifier"), "the refusal says why");
}
expectEqual(notificationAudits.length, 0, "a refused delivery is not audited as applied");

expectEqual(
  applyPayoneerPayoutNotification(
    { rawBody: "{}", notificationName: "Payout canceled", clientReferenceId },
    { verify: () => false, occurredAtEpochMs: 4_001, companyId },
  ).status,
  "refused",
  "a delivery that does not verify is refused",
);
expectEqual(
  applyPayoneerPayoutNotification(
    { rawBody: "{}", notificationName: "Payout canceled", clientReferenceId },
    { verify: () => { throw new Error("bad verifier"); }, occurredAtEpochMs: 4_002, companyId },
  ).status,
  "refused",
  "a verifier that throws refuses the delivery",
);

const appliedCancel = applyPayoneerPayoutNotification(
  { rawBody: "{}", notificationName: "Payout canceled", clientReferenceId },
  { verify: (raw) => raw === "{}", occurredAtEpochMs: 4_003, companyId, recordAudit: (entry) => notificationAudits.push(entry) },
);
expectEqual(appliedCancel.status, "applied", "a verified cancel notification is applied");
if (appliedCancel.status === "applied") expectEqual(appliedCancel.payoutStatus, "failed", "a cancel is a failed payout");
expectEqual(notificationAudits.at(-1)?.outcome, "failed", "the notification outcome is audited");

const loadedNotification = applyPayoneerPayoutNotification(
  { rawBody: "{}", notificationName: "Account/card loaded", clientReferenceId },
  { verify: () => true, occurredAtEpochMs: 4_004, companyId },
);
expectEqual(loadedNotification.status === "applied" && loadedNotification.payoutStatus === "success", true, "a loaded account is a delivered payout");

const sentToBank = applyPayoneerPayoutNotification(
  { rawBody: "{}", notificationName: "Sent to bank", clientReferenceId },
  { verify: () => true, occurredAtEpochMs: 4_005, companyId },
);
expectEqual(sentToBank.status === "applied" && sentToBank.payoutStatus === "pending", true, "a bank dispatch stays pending until it lands");

for (const name of ["Request received", "Request accepted"]) {
  const early = applyPayoneerPayoutNotification(
    { rawBody: "{}", notificationName: name, clientReferenceId },
    { verify: () => true, occurredAtEpochMs: 4_006, companyId },
  );
  expectEqual(early.status === "applied" && early.payoutStatus === "pending", true, `the ${name} notification stays pending`);
}

const failedBank = applyPayoneerPayoutNotification(
  { rawBody: "{}", notificationName: "Failed bank transfer", clientReferenceId },
  { verify: () => true, occurredAtEpochMs: 4_007, companyId },
);
expectEqual(failedBank.status === "applied" && failedBank.payoutStatus === "failed", true, "a failed bank transfer is a failed payout");

expectEqual(
  applyPayoneerPayoutNotification(
    { rawBody: "{}", notificationName: "Unknown notification", clientReferenceId },
    { verify: () => true, occurredAtEpochMs: 4_008, companyId },
  ).status,
  "ignored",
  "an undocumented notification is ignored",
);
expectEqual(
  applyPayoneerPayoutNotification(
    { rawBody: "{}", notificationName: "Payout canceled", clientReferenceId: null },
    { verify: () => true, occurredAtEpochMs: 4_009, companyId },
  ).status,
  "ignored",
  "a notification with no payment reference is ignored",
);

expectEqual(Object.isFrozen(PAYONEER_PAYOUT_NOTIFICATIONS), true, "the notification table is frozen");
expectEqual(Object.keys(PAYONEER_PAYOUT_NOTIFICATIONS).length, 6, "every documented payout notification is mapped");
for (const [name, expected] of Object.entries(PAYONEER_PAYOUT_NOTIFICATIONS)) {
  expectEqual(payoneerPayoutStatusOfNotification(name), expected, `the ${name} notification maps to ${String(expected)}`);
}
expectEqual(payoneerPayoutStatusOfNotification("Something else"), "unknown", "an unknown notification name maps to unknown");
expectEqual(payoneerPayoutStatusOfNotification(""), null, "an empty notification name maps to nothing");

/* ------------------------------------------------------------------------------------------------
 * Section 10: the submission store's rules
 * ---------------------------------------------------------------------------------------------- */

const storeRules = new InMemoryPayoneerSubmissionStore();
const seed: PayoneerSubmission = {
  id: "00000000-0000-4000-8000-0000000000aa",
  companyId,
  clientReferenceId: "payout-seed-0001",
  providerPayeeId: "payee-acme-0001",
  amountMinor: 1_000n,
  currency: "USD",
  outcome: "pending",
  providerPayoutId: null,
  reason: null,
  version: 1,
  createdAtEpochMs: 5_000,
  updatedAtEpochMs: 5_000,
};
storeRules.insert(seed);
expectThrows(() => storeRules.insert(seed), "a duplicate reference is refused");
expectThrows(() => storeRules.insert({ ...seed, clientReferenceId: "payout-seed-0002", version: 3 }), "a submission starts at version 1");
expectEqual(storeRules.save({ ...seed, version: 3 }, 1), false, "a version jump is refused");
expectEqual(storeRules.save({ ...seed, version: 2, amountMinor: 2_000n }, 1), false, "a stored amount never changes");
expectEqual(storeRules.save({ ...seed, version: 2, providerPayeeId: "payee-other-0009" }, 1), false, "a stored payee never changes");
expectEqual(storeRules.save({ ...seed, version: 2, currency: "EUR" }, 1), false, "a stored currency never changes");
expectEqual(storeRules.save({ ...seed, version: 2, outcome: "unknown", reason: "no answer" }, 1), true, "a pending submission may settle as unknown");
expectEqual(storeRules.save({ ...seed, version: 3, outcome: "pending" }, 2), false, "an unknown submission never returns to pending");
expectEqual(storeRules.save({ ...seed, version: 3, outcome: "rejected", reason: "x" }, 2), true, "an unknown submission may settle as rejected");
expectEqual(storeRules.save({ ...seed, version: 4, outcome: "unknown", reason: "y" }, 3), false, "a refusal is final and never returns to unknown");
expectEqual(storeRules.save({ ...seed, version: 9, outcome: "rejected", reason: "y" }, 3), false, "a version jump on a settled submission is refused");
expectEqual(storeRules.findByClientReferenceId("nothing"), null, "an unknown reference reads as nothing");

/* ---- nothing anywhere carries the access token ---- */

const everything = JSON.stringify({
  linked,
  linkedById,
  submitted,
  replay,
  transferred,
  pendingStatus,
  appliedCancel,
  audits,
  submitAudits,
  statusAudits,
  notificationAudits,
  stored: store.findByClientReferenceId(clientReferenceId),
}, (_key: string, value: unknown) => (typeof value === "bigint" ? value.toString() : value));
expect(everything.includes(accessToken) === false, "no outcome, audit entry or stored row carries the access token");
expect(everything.includes("secret") === false, "no outcome carries a credential-shaped value");

/* ---- the verdict ---- */

if (failures.length > 0) {
  process.stderr.write(
    `payments Payoneer payout gate failed: ${failures.length} of ${checks} checks\n${failures.map((failure) => `  - ${failure}`).join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `payments Payoneer payout gate passed: ${checks} checks (documented registration and payout bodies, idempotent submissions, only Transferred is success, unknown never becomes failed, and notifications are only believed through a verifier)\n`,
);

/** The refused-payee shape, narrowed for reading its reason. */
function reusedCheck(value: unknown): value is { readonly outcome: "rejected"; readonly reason: string; readonly programConfirmed: boolean } {
  return typeof value === "object" && value !== null && (value as { outcome?: string }).outcome === "rejected";
}
