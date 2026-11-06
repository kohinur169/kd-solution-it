// path: lib/payments/adapters/nmi-status-sync-verify.ts

/**
 * The gate for STEP 152: NMI response-code mapping, transaction status sync and the sandbox
 * end-to-end cycle.
 *
 * The gate is a check script, not a test file: it exercises the service in this repository with
 * the documented NMI answers and with a recording transport, then fails the run and names every
 * check that did not hold. No network call is made and no credential is used.
 */

import { randomUUID } from "node:crypto";
import process from "node:process";
import { configureNmiKeys, InMemoryNmiKeyStore } from "./nmi-client.ts";
import { NMI_API_ENDPOINT, NMI_SANDBOX_API_ENDPOINT } from "./nmi-payment.ts";
import {
  applyNmiStatusAssessment,
  assessNmiQueryTransaction,
  assessNmiTransactResponse,
  canAdvanceNmiStatus,
  InMemoryNmiTransactionStateStore,
  mapNmiCondition,
  NMI_QUERY_ENDPOINT,
  NMI_RESPONSE_CODES,
  NMI_SANDBOX_ENDPOINTS,
  NMI_SANDBOX_QUERY_ENDPOINT,
  NMI_STATUS_SYNC_DOCUMENTATION_URLS,
  nmiQueryEndpointFor,
  nmiQueryFetchTransport,
  nmiResponseCodeMeaning,
  parseNmiQueryResponse,
  queryNmiTransaction,
  recordNmiTransactResult,
  runNmiSandboxCycle,
  sanitizeNmiText,
  syncNmiTransactionStatus,
  type NmiPlatformPaymentStatus,
  type NmiQueriedTransaction,
  type NmiStatusAuditEntry,
  type NmiTransactionState,
} from "./nmi-status-sync.ts";

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

/* ---- shared fixtures ---- */

const encryptionKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const publicKey = "public-key-12345";
const privateKey = "private-key-12345";
const token = "00000000-000000-000000-000000000000";
const transactionId = "11223344";

const sandboxKeyStore = new InMemoryNmiKeyStore();
configureNmiKeys(
  { companyId: "company", apiKey: publicKey, secretKey: privateKey, environment: "sandbox" },
  { store: sandboxKeyStore, encryptionKey, occurredAtEpochMs: 1 },
);
const productionKeyStore = new InMemoryNmiKeyStore();
configureNmiKeys(
  { companyId: "company", apiKey: "public-key-67890", secretKey: "private-key-67890", environment: "production" },
  { store: productionKeyStore, encryptionKey, occurredAtEpochMs: 1 },
);

function newState(
  status: NmiPlatformPaymentStatus,
  providerTransactionId = transactionId,
  companyId = "company",
): NmiTransactionState {
  return {
    id: randomUUID(),
    companyId,
    providerTransactionId,
    status,
    providerCondition: null,
    responseCode: null,
    version: 1,
    lastSyncedAtEpochMs: 1,
  };
}

function queried(
  condition: NmiQueriedTransaction["condition"],
  options: { readonly success?: boolean; readonly responseCode?: string | null; readonly actions?: number } = {},
): NmiQueriedTransaction {
  const count = options.actions ?? 1;
  const actions = Array.from({ length: count }, (_unused, index) => ({
    actionType: index === 0 ? "sale" : "settle",
    amount: "10.00",
    success: options.success ?? true,
    responseCode: options.responseCode === undefined ? "100" : options.responseCode,
    responseText: "Approved",
    dateUtc: "20260101120000",
  }));
  return { transactionId, condition, orderId: "order-1", transactionType: "cc", actions };
}

/* ------------------------------------------------------------------------------------------------
 * Section 1: the documented response-code table
 * --------------------------------------------------------------------------------------------- */

expectEqual(Object.keys(NMI_RESPONSE_CODES).length, 34, "every documented response code is in the table");
for (const [key, entry] of Object.entries(NMI_RESPONSE_CODES)) {
  expectEqual(entry.code, key, `the response code entry ${key} carries its own code`);
  expect(entry.description.length > 0, `the response code ${key} carries the documented description`);
  expect(
    ["approved", "declined", "rejected", "error"].includes(entry.category),
    `the response code ${key} has a documented category`,
  );
}

expectEqual(nmiResponseCodeMeaning("100").category, "approved", "100 is an approval");
expectEqual(nmiResponseCodeMeaning("100").requiresReconciliation, false, "100 needs no reconciliation");
expectEqual(nmiResponseCodeMeaning(" 100 ").category, "approved", "a response code is trimmed before lookup");
for (const code of ["200", "201", "202", "203", "204", "220", "221", "222", "223", "224", "225", "226", "240", "250", "251", "252", "253", "260", "261", "262", "263", "264", "460", "461"]) {
  expectEqual(nmiResponseCodeMeaning(code).category, "declined", `the response code ${code} is a decline`);
  expectEqual(nmiResponseCodeMeaning(code).requiresReconciliation, false, `the decline ${code} is final`);
}
expectEqual(nmiResponseCodeMeaning("300").category, "rejected", "300 is a gateway rejection");
expectEqual(nmiResponseCodeMeaning("300").requiresReconciliation, false, "a gateway rejection is final");
expectEqual(nmiResponseCodeMeaning("400").category, "error", "400 is a processor error");
expectEqual(nmiResponseCodeMeaning("410").category, "error", "410 is a merchant configuration error");
expectEqual(nmiResponseCodeMeaning("411").category, "error", "411 is an inactive merchant account");
expectEqual(nmiResponseCodeMeaning("440").category, "error", "440 is a processor format error");
expectEqual(nmiResponseCodeMeaning("441").category, "error", "441 is invalid transaction information");
expectEqual(nmiResponseCodeMeaning("420").requiresReconciliation, true, "420 is a communication error and is not final");
expectEqual(nmiResponseCodeMeaning("421").requiresReconciliation, true, "421 is a communication error with the issuer");
expectEqual(nmiResponseCodeMeaning("430").requiresReconciliation, true, "430 is a duplicate at the processor");
expectEqual(nmiResponseCodeMeaning("430").category, "rejected", "430 is a rejection, not an approval");
expectEqual(nmiResponseCodeMeaning("999").category, "unknown", "an undocumented code is unknown");
expectEqual(nmiResponseCodeMeaning("999").requiresReconciliation, true, "an undocumented code is never final");
expectEqual(nmiResponseCodeMeaning(null).category, "unknown", "a missing code is unknown");
expectEqual(nmiResponseCodeMeaning("").category, "unknown", "an empty code is unknown");

/* ------------------------------------------------------------------------------------------------
 * Section 2: provider text sanitisation
 * --------------------------------------------------------------------------------------------- */

expectEqual(sanitizeNmiText("<script>alert(1)</script>"), "scriptalert(1)/script", "markup is stripped from provider text");
expectEqual(sanitizeNmiText("line1\nline2\ttabbed"), "line1 line2 tabbed", "control characters and whitespace collapse");
expectEqual(sanitizeNmiText(null), "", "missing provider text is empty");
expectEqual(sanitizeNmiText("x".repeat(500)).length, 200, "provider text is capped");
expectEqual(sanitizeNmiText("  padded  "), "padded", "provider text is trimmed");

/* ------------------------------------------------------------------------------------------------
 * Section 3: the transact.php answer assessment
 * --------------------------------------------------------------------------------------------- */

const approvedSale = assessNmiTransactResponse(
  { response: "1", response_code: "100", responsetext: "Approved", transactionid: transactionId, authcode: "A1" },
  "sale",
);
expectEqual(approvedSale.category, "approved", "an approved sale is categorised as approved");
expectEqual(approvedSale.targetStatus, "captured", "an approved sale is captured and awaits settlement");
expectEqual(approvedSale.providerCondition, "pendingsettlement", "an approved sale ends pending settlement");
expectEqual(approvedSale.requiresReconciliation, false, "an approved sale needs no reconciliation");
expectEqual(approvedSale.transactionId, transactionId, "the assessment keeps the transaction id");

const approvedAuth = assessNmiTransactResponse(
  { response: "1", response_code: "100", transactionid: transactionId },
  "authorization",
);
expectEqual(approvedAuth.targetStatus, "authorized", "an approved auth is authorized");
expectEqual(approvedAuth.providerCondition, "pending", "an approved auth waits in pending");

expectEqual(
  assessNmiTransactResponse({ response: "1", response_code: "100", transactionid: transactionId }, "capture").targetStatus,
  "captured",
  "an approved capture leaves the transaction captured",
);
expectEqual(
  assessNmiTransactResponse({ response: "1", response_code: "100", transactionid: transactionId }, "void").targetStatus,
  "voided",
  "an approved void is voided",
);
expectEqual(
  assessNmiTransactResponse({ response: "1", response_code: "100", transactionid: transactionId }, "void").providerCondition,
  "canceled",
  "an approved void ends canceled",
);
const approvedRefund = assessNmiTransactResponse(
  { response: "1", response_code: "100", transactionid: transactionId },
  "refund",
);
expectEqual(approvedRefund.targetStatus, null, "a refund does not move a payment status");
expectEqual(approvedRefund.requiresReconciliation, false, "a refund is not an unresolved outcome");

const declined = assessNmiTransactResponse({ response: "2", response_code: "202", responsetext: "Insufficient funds" }, "sale");
expectEqual(declined.targetStatus, "failed", "a documented decline is a failed payment");
expectEqual(declined.category, "declined", "the decline keeps its documented category");
expectEqual(declined.requiresReconciliation, false, "a documented decline is final");

const gatewayRejection = assessNmiTransactResponse({ response: "3", response_code: "300" }, "sale");
expectEqual(gatewayRejection.targetStatus, "failed", "a gateway rejection is a failed payment");
expectEqual(gatewayRejection.category, "rejected", "a gateway rejection keeps its category");

const communicationError = assessNmiTransactResponse({ response: "3", response_code: "420" }, "sale");
expectEqual(communicationError.targetStatus, null, "a communication error is never written as a status");
expectEqual(communicationError.requiresReconciliation, true, "a communication error must be reconciled");

const duplicate = assessNmiTransactResponse({ response: "3", response_code: "430" }, "sale");
expectEqual(duplicate.targetStatus, null, "a duplicate at the processor is never written as a status");

const noTransactionId = assessNmiTransactResponse({ response: "1", response_code: "100" }, "sale");
expectEqual(noTransactionId.targetStatus, null, "an approval without a transaction id is not a status");
expectEqual(noTransactionId.requiresReconciliation, true, "an approval without an id must be reconciled");

const undocumentedResponse = assessNmiTransactResponse({ response: "4", response_code: "100" }, "sale");
expectEqual(undocumentedResponse.targetStatus, null, "an undocumented response value is not a status");
expectEqual(undocumentedResponse.requiresReconciliation, true, "an undocumented response value must be reconciled");

const contradictoryApproval = assessNmiTransactResponse({ response: "1", response_code: "200", transactionid: transactionId }, "sale");
expectEqual(contradictoryApproval.targetStatus, null, "an approval contradicted by its response code is not a status");
expectEqual(contradictoryApproval.requiresReconciliation, true, "a contradiction must be reconciled");

const contradictoryDecline = assessNmiTransactResponse({ response: "2", response_code: "100" }, "sale");
expectEqual(contradictoryDecline.targetStatus, null, "a decline contradicted by its response code is not a status");

const noCode = assessNmiTransactResponse({ response: "1", transactionid: transactionId }, "sale");
expectEqual(noCode.targetStatus, "captured", "an approval without a response code still maps by its transaction type");
expectEqual(noCode.category, "unknown", "a missing response code keeps the unknown category");

const undocumentedCode = assessNmiTransactResponse({ response: "3", response_code: "999" }, "sale");
expectEqual(undocumentedCode.targetStatus, null, "an undocumented failure code is never a status");

/* ------------------------------------------------------------------------------------------------
 * Section 4: condition mapping and the transition graph
 * --------------------------------------------------------------------------------------------- */

const conditionCases: readonly (readonly [NmiQueriedTransaction["condition"], NmiPlatformPaymentStatus | null])[] = [
  ["pending", "authorized"],
  ["pendingsettlement", "captured"],
  ["complete", "settled"],
  ["canceled", "voided"],
  ["failed", "failed"],
  ["in_progress", "pending"],
  ["abandoned", "failed"],
  ["unknown", null],
];
for (const [condition, expectedStatus] of conditionCases) {
  const mapping = mapNmiCondition(condition);
  if (expectedStatus === null) {
    expectEqual(mapping.outcome, "unresolved", `the condition ${condition} is unresolved`);
  } else {
    expectEqual(mapping.outcome, "mapped", `the condition ${condition} maps to a status`);
    if (mapping.outcome === "mapped") expectEqual(mapping.status, expectedStatus, `the condition ${condition} maps to ${expectedStatus}`);
  }
}

expect(canAdvanceNmiStatus("pending", "authorized"), "pending may become authorized");
expect(canAdvanceNmiStatus("pending", "failed"), "pending may become failed");
expect(canAdvanceNmiStatus("authorized", "captured"), "authorized may become captured");
expect(canAdvanceNmiStatus("authorized", "voided"), "authorized may become voided");
expect(canAdvanceNmiStatus("captured", "settled"), "captured may become settled");
expect(canAdvanceNmiStatus("captured", "voided"), "captured may be voided before settlement");
expect(canAdvanceNmiStatus("settled", "settled") === false, "settled is terminal for a provider status");
expect(canAdvanceNmiStatus("settled", "captured") === false, "settled never moves back to captured");
expect(canAdvanceNmiStatus("failed", "settled") === false, "a failed payment never becomes settled");
expect(canAdvanceNmiStatus("voided", "captured") === false, "a voided payment never becomes captured");
expect(canAdvanceNmiStatus("captured", "failed") === false, "a captured payment never becomes failed");

/* ------------------------------------------------------------------------------------------------
 * Section 5: the Query API parser
 * --------------------------------------------------------------------------------------------- */

const settledXml = `<?xml version="1.0" encoding="UTF-8"?>
<nm_response>
  <transaction>
    <transaction_id>11223344</transaction_id>
    <transaction_type>cc</transaction_type>
    <condition>complete</condition>
    <order_id>order-1</order_id>
    <action>
      <amount>10.00</amount>
      <action_type>sale</action_type>
      <date>20260101120000</date>
      <success>1</success>
      <response_text>Approved &amp; captured</response_text>
      <response_code>100</response_code>
    </action>
    <action>
      <amount>10.00</amount>
      <action_type>settle</action_type>
      <date>20260102120000</date>
      <success>1</success>
      <response_text>ACCEPTED</response_text>
      <response_code>100</response_code>
    </action>
  </transaction>
</nm_response>`;

const parsedSettled = parseNmiQueryResponse(settledXml);
expectEqual(parsedSettled.status, "found", "a transaction record is parsed as found");
if (parsedSettled.status === "found") {
  expectEqual(parsedSettled.transaction.transactionId, transactionId, "the parsed record keeps the transaction id");
  expectEqual(parsedSettled.transaction.condition, "complete", "the parsed record keeps the condition");
  expectEqual(parsedSettled.transaction.orderId, "order-1", "the parsed record keeps the order id");
  expectEqual(parsedSettled.transaction.transactionType, "cc", "the parsed record keeps the transaction type");
  expectEqual(parsedSettled.transaction.actions.length, 2, "every action is parsed");
  expectEqual(parsedSettled.transaction.actions[0]?.responseText, "Approved & captured", "XML entities are decoded");
  expectEqual(parsedSettled.transaction.actions[1]?.actionType, "settle", "the newest action is last");
  expectEqual(parsedSettled.transaction.actions[1]?.responseCode, "100", "the action response code is parsed");
  expectEqual(parsedSettled.transaction.actions[0]?.amount, "10.00", "the action amount is parsed");
}

const errorXml = `<nm_response><error_response><response_code>300</response_code><responsetext>Invalid security key</responsetext></error_response></nm_response>`;
const parsedError = parseNmiQueryResponse(errorXml);
expectEqual(parsedError.status, "gateway_error", "an error response is parsed as a gateway error");
if (parsedError.status === "gateway_error") {
  expectEqual(parsedError.responseCode, "300", "the gateway error keeps the response code");
  expectEqual(parsedError.responseText, "Invalid security key", "the gateway error keeps the text");
}

expectEqual(parseNmiQueryResponse("<nm_response></nm_response>").status, "not_found", "an empty response is not found");
expectEqual(parseNmiQueryResponse("<html>nope</html>").status, "unparsable", "a foreign document is unparsable");
expectEqual(parseNmiQueryResponse("").status, "unparsable", "an empty body is unparsable");
expectEqual(
  parseNmiQueryResponse(`<nm_response>${"x".repeat(300_000)}</nm_response>`).status,
  "unparsable",
  "an oversized body is unparsable",
);
expectEqual(
  parseNmiQueryResponse("<nm_response><transaction><condition>complete</condition></transaction></nm_response>").status,
  "unparsable",
  "a record without a transaction id is unparsable",
);
expectEqual(
  parseNmiQueryResponse("<nm_response><transaction><transaction_id>11;DROP</transaction_id></transaction></nm_response>").status,
  "unparsable",
  "a record with a non-numeric transaction id is unparsable",
);

const unknownCondition = parseNmiQueryResponse(
  "<nm_response><transaction><transaction_id>11223344</transaction_id><condition>mystery</condition></transaction></nm_response>",
);
expectEqual(unknownCondition.status, "found", "a record with an undocumented condition is still parsed");
if (unknownCondition.status === "found") {
  expectEqual(unknownCondition.transaction.condition, "unknown", "an undocumented condition becomes unknown");
  const assessment = assessNmiQueryTransaction(unknownCondition.transaction);
  expectEqual(assessment.targetStatus, null, "an unknown condition writes no status");
  expectEqual(assessment.requiresReconciliation, true, "an unknown condition goes to reconciliation");
}

const settledAssessment = assessNmiQueryTransaction(queried("complete"));
expectEqual(settledAssessment.targetStatus, "settled", "a settled record maps to settled");
expectEqual(settledAssessment.category, "approved", "a settled record carries an approved action");

expectEqual(
  assessNmiQueryTransaction(queried("failed", { success: false, responseCode: "202" })).targetStatus,
  "failed",
  "a declined record maps to failed",
);
expectEqual(
  assessNmiQueryTransaction(queried("canceled")).targetStatus,
  "voided",
  "a canceled record maps to voided",
);
expectEqual(
  assessNmiQueryTransaction(queried("pending")).targetStatus,
  "authorized",
  "a pending record maps to authorized",
);

const contradictoryRecord = assessNmiQueryTransaction(queried("complete", { success: false }));
expectEqual(contradictoryRecord.targetStatus, null, "a condition contradicted by its action writes no status");
expectEqual(contradictoryRecord.requiresReconciliation, true, "a contradiction goes to reconciliation");

const lostOutcomeRecord = assessNmiQueryTransaction(queried("failed", { success: false, responseCode: "420" }));
expectEqual(lostOutcomeRecord.targetStatus, null, "a record whose newest action was a communication error writes no status");

/* ------------------------------------------------------------------------------------------------
 * Section 6: the Query API transport
 * --------------------------------------------------------------------------------------------- */

expectEqual(nmiQueryEndpointFor("sandbox"), NMI_SANDBOX_QUERY_ENDPOINT, "the sandbox environment selects the sandbox query endpoint");
expectEqual(nmiQueryEndpointFor("production"), NMI_QUERY_ENDPOINT, "the production environment selects the production query endpoint");

const originalFetch = globalThis.fetch;
try {
  let seenUrl = "";
  let seenInit: RequestInit | undefined;
  globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    seenUrl = String(url);
    seenInit = init;
    return new Response(settledXml, { status: 200 });
  };
  const body = await nmiQueryFetchTransport(NMI_SANDBOX_QUERY_ENDPOINT, { security_key: "private&value", transaction_id: transactionId });
  expectEqual(seenUrl, NMI_SANDBOX_QUERY_ENDPOINT, "the query transport posts to the documented endpoint");
  expectEqual(seenInit?.method, "POST", "the query transport posts");
  expectEqual(seenInit?.redirect, "error", "the query transport refuses redirects");
  expectEqual(seenInit?.body, "security_key=private%26value&transaction_id=11223344", "the query transport form encodes the payload");
  expectEqual(body.includes("<condition>complete</condition>"), true, "the query transport returns the raw body");

  globalThis.fetch = async () => new Response("nope", { status: 500 });
  await expectRejection(() => nmiQueryFetchTransport(NMI_SANDBOX_QUERY_ENDPOINT, {}), "a non-2xx query answer is refused");

  globalThis.fetch = async () => new Response("", { status: 200 });
  await expectRejection(() => nmiQueryFetchTransport(NMI_SANDBOX_QUERY_ENDPOINT, {}), "an empty query answer is refused");

  globalThis.fetch = async () => new Response(settledXml, { status: 200 });
  await expectRejection(() => nmiQueryFetchTransport("https://example.com/api/query.php", {}), "an undocumented query endpoint is refused");
} finally {
  globalThis.fetch = originalFetch;
}

/* ------------------------------------------------------------------------------------------------
 * Section 7: querying one transaction
 * --------------------------------------------------------------------------------------------- */

const queriedFound = await queryNmiTransaction("company", transactionId, {
  keyStore: sandboxKeyStore,
  encryptionKey,
  queryTransport: async (endpoint, payload) => {
    expectEqual(endpoint, NMI_SANDBOX_QUERY_ENDPOINT, "a sandbox key reads the sandbox endpoint");
    expectEqual(payload["security_key"], privateKey, "the query sends the decrypted security key");
    expectEqual(payload["transaction_id"], transactionId, "the query sends the transaction id");
    return settledXml;
  },
});
expectEqual(queriedFound.status, "found", "a found transaction is returned");
if (queriedFound.status === "found") {
  expectEqual(queriedFound.environment, "sandbox", "the result names the environment it read");
  expectEqual(queriedFound.transaction.condition, "complete", "the found transaction keeps its condition");
}
expectEqual(JSON.stringify(queriedFound).includes(privateKey), false, "the query result never carries the security key");

const queriedProduction = await queryNmiTransaction("company", transactionId, {
  keyStore: productionKeyStore,
  encryptionKey,
  queryTransport: async (endpoint) => {
    expectEqual(endpoint, NMI_QUERY_ENDPOINT, "a production key reads the production endpoint");
    return settledXml;
  },
});
expectEqual(queriedProduction.status, "found", "a production key reads production");

expectEqual(
  (await queryNmiTransaction("nobody", transactionId, { keyStore: sandboxKeyStore, encryptionKey })).status,
  "rejected",
  "a company without keys is rejected",
);
expectEqual(
  (await queryNmiTransaction("company", "11;DROP", { keyStore: sandboxKeyStore, encryptionKey })).status,
  "rejected",
  "a non-numeric transaction id is rejected before a call",
);
expectEqual(
  (await queryNmiTransaction("", transactionId, { keyStore: sandboxKeyStore, encryptionKey })).status,
  "rejected",
  "an empty company id is rejected",
);
expectEqual(
  (await queryNmiTransaction("company", transactionId, { keyStore: sandboxKeyStore, encryptionKey: "f".repeat(64) })).status,
  "rejected",
  "an undecryptable key configuration is refused",
);

const queriedUnknown = await queryNmiTransaction("company", transactionId, {
  keyStore: sandboxKeyStore,
  encryptionKey,
  queryTransport: async () => {
    throw new Error(privateKey);
  },
});
expectEqual(queriedUnknown.status, "unknown", "a lost query answer is unknown");
expectEqual(JSON.stringify(queriedUnknown).includes(privateKey), false, "a lost query answer leaks no credential");

expectEqual(
  (
    await queryNmiTransaction("company", transactionId, {
      keyStore: sandboxKeyStore,
      encryptionKey,
      queryTransport: async () => errorXml,
    })
  ).status,
  "gateway_error",
  "a gateway error answer is reported as a gateway error",
);
expectEqual(
  (
    await queryNmiTransaction("company", transactionId, {
      keyStore: sandboxKeyStore,
      encryptionKey,
      queryTransport: async () => "<html>proxy</html>",
    })
  ).status,
  "unknown",
  "an unparsable answer is unknown, not a failure",
);
expectEqual(
  (
    await queryNmiTransaction("company", transactionId, {
      keyStore: sandboxKeyStore,
      encryptionKey,
      queryTransport: async () => "<nm_response></nm_response>",
    })
  ).status,
  "not_found",
  "an empty answer is a missing transaction",
);

/* ------------------------------------------------------------------------------------------------
 * Section 8: the transaction state store
 * --------------------------------------------------------------------------------------------- */

const storeRules = new InMemoryNmiTransactionStateStore();
const storedState = newState("pending");
storeRules.insert(storedState);
expectEqual(storeRules.findById(storedState.id)?.status, "pending", "a stored state is readable by id");
expectEqual(
  storeRules.findByProviderTransactionId("company", transactionId)?.id,
  storedState.id,
  "a stored state is readable by provider transaction id",
);
expectEqual(storeRules.findByProviderTransactionId("other", transactionId), null, "a provider transaction id is scoped to its company");
expectEqual(storeRules.findByCompany("company").length, 1, "the company's states are listed");
expectEqual(storeRules.findByCompany("other").length, 0, "another company lists nothing");

const duplicateIdState = newState("pending", "55667788");
storeRules.insert(duplicateIdState);
expectThrows(() => storeRules.insert(duplicateIdState), "a duplicate state id is refused");
expectThrows(
  () => storeRules.insert(newState("pending", transactionId)),
  "a duplicate provider transaction id in one company is refused",
);

const otherCompanyStore = new InMemoryNmiTransactionStateStore();
otherCompanyStore.insert(newState("pending", transactionId, "company"));
otherCompanyStore.insert(newState("pending", transactionId, "other"));
expectEqual(otherCompanyStore.findByCompany("other").length, 1, "two companies may hold the same provider transaction id");

const saveStore = new InMemoryNmiTransactionStateStore();
const saveState = newState("pending");
saveStore.insert(saveState);
expectEqual(
  saveStore.save({ ...saveState, status: "authorized", version: 2 }, 1),
  true,
  "a write from the stored version succeeds",
);
expectEqual(saveStore.findById(saveState.id)?.version, 2, "the accepted write advanced the version");
expectEqual(
  saveStore.save({ ...saveState, status: "failed", version: 2 }, 1),
  false,
  "a write from a stale version is refused",
);
const crossCompany: NmiTransactionState = { ...saveState, companyId: "intruder", status: "failed", version: 3 };
expectEqual(saveStore.save(crossCompany, 2), false, "a write that changes the company is refused");
expectEqual(saveStore.save({ ...saveState, status: "failed", version: 9 }, 2), false, "a version jump is refused");
expectEqual(
  saveStore.save({ ...saveState, id: randomUUID(), version: 3 }, 2),
  false,
  "a write for an unknown id is refused",
);

/* ------------------------------------------------------------------------------------------------
 * Section 9: applying an assessment
 * --------------------------------------------------------------------------------------------- */

const applyStore = new InMemoryNmiTransactionStateStore();
const applyAudits: NmiStatusAuditEntry[] = [];
const authorizedState = newState("authorized");
applyStore.insert(authorizedState);

const applied = applyNmiStatusAssessment(authorizedState, settledAssessment, {
  store: applyStore,
  occurredAtEpochMs: 42,
  recordAudit: (entry) => applyAudits.push(entry),
});
expectEqual(applied.status, "synced", "a forward transition is applied");
expectEqual(applied.previousStatus, "authorized", "the outcome names the previous status");
expectEqual(applyStore.findById(authorizedState.id)?.status, "settled", "the stored status advanced");
expectEqual(applyStore.findById(authorizedState.id)?.version, 2, "the applied sync advanced the version");
expectEqual(applyStore.findById(authorizedState.id)?.lastSyncedAtEpochMs, 42, "the applied sync records its time");
expectEqual(applyAudits.length, 1, "an applied sync writes one audit entry");
expectEqual(applyAudits[0]?.action, "payment.nmi.status_synced", "the audit entry names the action");
expectEqual(applyAudits[0]?.fromStatus, "authorized", "the audit entry names the previous status");
expectEqual(applyAudits[0]?.toStatus, "settled", "the audit entry names the new status");
expectEqual(applyAudits[0]?.provider, "nmi", "the audit entry names the provider");
expectEqual(JSON.stringify(applyAudits).includes(privateKey), false, "the audit entry carries no credential");

const unchanged = applyNmiStatusAssessment(applyStore.findById(authorizedState.id) ?? authorizedState, settledAssessment, {
  store: applyStore,
  occurredAtEpochMs: 43,
  recordAudit: (entry) => applyAudits.push(entry),
});
expectEqual(unchanged.status, "unchanged", "a repeated sync changes nothing");
expectEqual(applyStore.findById(authorizedState.id)?.version, 2, "a repeated sync does not bump the version");
expectEqual(applyAudits.length, 1, "a repeated sync writes no audit entry");

const regression = applyNmiStatusAssessment(applyStore.findById(authorizedState.id) ?? authorizedState, assessNmiQueryTransaction(queried("pendingsettlement")), {
  store: applyStore,
  occurredAtEpochMs: 44,
  recordAudit: (entry) => applyAudits.push(entry),
});
expectEqual(regression.status, "refused", "a report that moves backwards is refused");
expectEqual(regression.reason.includes("settled"), true, "the refusal names the stored status");
expectEqual(applyStore.findById(authorizedState.id)?.status, "settled", "a refused report changes nothing");
expectEqual(applyAudits.length, 1, "a refused report writes no audit entry");

const unresolvedApply = applyNmiStatusAssessment(authorizedState, assessNmiQueryTransaction(queried("unknown")), {
  store: applyStore,
  occurredAtEpochMs: 45,
});
expectEqual(unresolvedApply.status, "unresolved", "an unresolved assessment is not applied");
expectEqual(unresolvedApply.assessment?.requiresReconciliation, true, "the unresolved outcome keeps the reconciliation flag");

const refundState = newState("captured");
const refundStore = new InMemoryNmiTransactionStateStore();
refundStore.insert(refundState);
const refundApply = applyNmiStatusAssessment(refundState, approvedRefund, { store: refundStore, occurredAtEpochMs: 46 });
expectEqual(refundApply.status, "not_applicable", "a refund is not a payment status change");
expectEqual(refundStore.findById(refundState.id)?.status, "captured", "a refund leaves the payment status alone");
expectEqual(refundStore.findById(refundState.id)?.version, 1, "a refund does not bump the version");

const conflictStore = new InMemoryNmiTransactionStateStore();
const conflictState = newState("authorized");
conflictStore.insert(conflictState);
const firstWriter = applyNmiStatusAssessment(conflictState, assessNmiQueryTransaction(queried("pendingsettlement")), {
  store: conflictStore,
  occurredAtEpochMs: 47,
});
const secondWriter = applyNmiStatusAssessment(conflictState, settledAssessment, {
  store: conflictStore,
  occurredAtEpochMs: 48,
});
expectEqual(firstWriter.status, "synced", "the first competing write wins");
expectEqual(secondWriter.status, "refused", "the second competing write is refused");
expectEqual(secondWriter.reason.includes("changed"), true, "the losing write names the conflict");
expectEqual(conflictStore.findById(conflictState.id)?.status, "captured", "the losing write does not overwrite the winner");

/* ------------------------------------------------------------------------------------------------
 * Section 10: recording a transact.php answer
 * --------------------------------------------------------------------------------------------- */

const transactStore = new InMemoryNmiTransactionStateStore();
const transactAudits: NmiStatusAuditEntry[] = [];
const recordOptions = {
  store: transactStore,
  occurredAtEpochMs: 100,
  recordAudit: (entry: NmiStatusAuditEntry) => transactAudits.push(entry),
};
const saleRaw = { response: "1", response_code: "100", responsetext: "Approved", transactionid: "99887766" };

const created = recordNmiTransactResult({ companyId: "company", transactionType: "sale", raw: saleRaw }, recordOptions);
expectEqual(created.status, "created", "an approved sale creates the transaction state");
expectEqual(created.state?.status, "captured", "the created state is captured");
expectEqual(created.state?.version, 1, "the created state starts at version 1");
expectEqual(created.state?.providerTransactionId, "99887766", "the created state keeps the provider transaction id");
expectEqual(transactAudits.length, 1, "the creation writes one audit entry");
expectEqual(transactAudits[0]?.fromStatus, null, "the creation audit entry has no previous status");
expectEqual(JSON.stringify(created).includes(privateKey), false, "the created state carries no credential");

const repeated = recordNmiTransactResult({ companyId: "company", transactionType: "sale", raw: saleRaw }, recordOptions);
expectEqual(repeated.status, "unchanged", "recording the same answer twice changes nothing");
expectEqual(transactAudits.length, 1, "recording the same answer twice writes no audit entry");

const staleDecline = recordNmiTransactResult(
  { companyId: "company", transactionType: "sale", raw: { response: "2", response_code: "202", transactionid: "99887766" } },
  recordOptions,
);
expectEqual(staleDecline.status, "refused", "a decline reported for a captured payment is refused");

const pendingCreated = recordNmiTransactResult(
  {
    companyId: "company",
    transactionType: "authorization",
    raw: { response: "1", response_code: "100", transactionid: "11112222" },
  },
  recordOptions,
);
expectEqual(pendingCreated.state?.status, "authorized", "an approved auth is stored as authorized");

const authorizedThenDeclined = recordNmiTransactResult(
  { companyId: "company", transactionType: "sale", raw: { response: "2", response_code: "202", transactionid: "11112222" } },
  recordOptions,
);
expectEqual(authorizedThenDeclined.status, "synced", "an authorized payment may be declined later");
expectEqual(transactStore.findByProviderTransactionId("company", "11112222")?.status, "failed", "the decline is stored");

const unresolvedRecord = recordNmiTransactResult(
  { companyId: "company", transactionType: "sale", raw: { response: "1", response_code: "100" } },
  recordOptions,
);
expectEqual(unresolvedRecord.status, "unresolved", "an answer without a transaction id records nothing");
expectEqual(unresolvedRecord.state, null, "an unresolved answer creates no state");

const refundRecord = recordNmiTransactResult(
  { companyId: "company", transactionType: "refund", raw: { response: "1", response_code: "100", transactionid: "33334444" } },
  recordOptions,
);
expectEqual(refundRecord.status, "not_applicable", "a refund answer creates no payment status");
expectEqual(transactStore.findByProviderTransactionId("company", "33334444"), null, "a refund answer creates no state");

/* ------------------------------------------------------------------------------------------------
 * Section 11: syncing a transaction status from the gateway
 * --------------------------------------------------------------------------------------------- */

const syncStore = new InMemoryNmiTransactionStateStore();
const syncAudits: NmiStatusAuditEntry[] = [];
const syncState = newState("captured");
syncStore.insert(syncState);
const syncOptions = {
  keyStore: sandboxKeyStore,
  encryptionKey,
  store: syncStore,
  occurredAtEpochMs: 200,
  recordAudit: (entry: NmiStatusAuditEntry) => syncAudits.push(entry),
  queryTransport: async () => settledXml,
};

const syncedSettled = await syncNmiTransactionStatus(
  { companyId: "company", providerTransactionId: transactionId },
  syncOptions,
);
expectEqual(syncedSettled.status, "synced", "a settled gateway record settles the payment");
expectEqual(syncedSettled.state?.status, "settled", "the synced status is settled");
expectEqual(syncAudits.length, 1, "the sync writes one audit entry");

const syncedAgain = await syncNmiTransactionStatus(
  { companyId: "company", providerTransactionId: transactionId },
  syncOptions,
);
expectEqual(syncedAgain.status, "unchanged", "syncing an already settled payment changes nothing");

const refusedUnknownTransaction = await syncNmiTransactionStatus(
  { companyId: "company", providerTransactionId: "77778888" },
  syncOptions,
);
expectEqual(refusedUnknownTransaction.status, "refused", "a transaction the platform never made is refused");

const notFoundQuery = await syncNmiTransactionStatus(
  { companyId: "company", providerTransactionId: transactionId },
  { ...syncOptions, queryTransport: async () => "<nm_response></nm_response>" },
);
expectEqual(notFoundQuery.status, "unresolved", "a missing gateway record is unresolved");
expectEqual(notFoundQuery.reason.includes("reconcile"), true, "a missing gateway record asks for reconciliation");

const lostQuery = await syncNmiTransactionStatus(
  { companyId: "company", providerTransactionId: transactionId },
  {
    ...syncOptions,
    queryTransport: async () => {
      throw new Error("socket hangup");
    },
  },
);
expectEqual(lostQuery.status, "unresolved", "a lost query is unresolved");
expectEqual(lostQuery.reason.includes("reconcile before retrying"), true, "a lost query asks for reconciliation");

const gatewayErrorQuery = await syncNmiTransactionStatus(
  { companyId: "company", providerTransactionId: transactionId },
  { ...syncOptions, queryTransport: async () => errorXml },
);
expectEqual(gatewayErrorQuery.status, "unresolved", "a gateway query error is unresolved");
expectEqual(gatewayErrorQuery.reason.includes("300"), true, "a gateway query error names its code");

const regressionStore = new InMemoryNmiTransactionStateStore();
const regressionState = newState("settled");
regressionStore.insert(regressionState);
const regressedSync = await syncNmiTransactionStatus(
  { companyId: "company", providerTransactionId: transactionId },
  {
    keyStore: sandboxKeyStore,
    encryptionKey,
    store: regressionStore,
    occurredAtEpochMs: 210,
    queryTransport: async () => "<nm_response><transaction><transaction_id>11223344</transaction_id><condition>pending</condition></transaction></nm_response>",
  },
);
expectEqual(regressedSync.status, "refused", "a stale gateway condition never moves a settled payment backwards");
expectEqual(regressionStore.findById(regressionState.id)?.status, "settled", "the settled payment is unchanged");

const crossTenantStore = new InMemoryNmiTransactionStateStore();
crossTenantStore.insert(newState("captured", transactionId, "other-company"));
const crossTenantSync = await syncNmiTransactionStatus(
  { companyId: "company", providerTransactionId: transactionId },
  { ...syncOptions, store: crossTenantStore, queryTransport: async () => settledXml },
);
expectEqual(crossTenantSync.status, "refused", "a sync for another company's transaction is refused");

/* ------------------------------------------------------------------------------------------------
 * Section 12: the sandbox end-to-end cycle
 * --------------------------------------------------------------------------------------------- */

const cycleInput = {
  companyId: "company",
  token,
  amount: "10.00",
  refundAmount: "5.00",
  reference: "step-152-cycle",
};

let productionCalls = 0;
const productionCycle = await runNmiSandboxCycle(cycleInput, {
  keyStore: productionKeyStore,
  encryptionKey,
  occurredAtEpochMs: 300,
  transport: async () => {
    productionCalls += 1;
    return { response: "1", response_code: "100", transactionid: "1" };
  },
});
expectEqual(productionCycle.status, "blocked", "the cycle refuses a production key configuration");
expectEqual(productionCycle.blockedReason?.includes("production"), true, "the refusal names the production configuration");
expectEqual(productionCalls, 0, "a blocked cycle sends nothing");

const missingKeyCycle = await runNmiSandboxCycle(
  { ...cycleInput, companyId: "nobody" },
  { keyStore: sandboxKeyStore, encryptionKey, occurredAtEpochMs: 301 },
);
expectEqual(missingKeyCycle.status, "blocked", "the cycle refuses a company without keys");

expectEqual(
  (await runNmiSandboxCycle({ ...cycleInput, token: "" }, { keyStore: sandboxKeyStore, encryptionKey, occurredAtEpochMs: 302 })).status,
  "blocked",
  "the cycle refuses a missing token",
);
expectEqual(
  (await runNmiSandboxCycle({ ...cycleInput, amount: "10" }, { keyStore: sandboxKeyStore, encryptionKey, occurredAtEpochMs: 303 })).status,
  "blocked",
  "the cycle refuses an amount that is not dollars and cents",
);
expectEqual(
  (await runNmiSandboxCycle({ ...cycleInput, refundAmount: "0.00" }, { keyStore: sandboxKeyStore, encryptionKey, occurredAtEpochMs: 304 })).status,
  "blocked",
  "the cycle refuses a zero refund",
);
expectEqual(
  (await runNmiSandboxCycle({ ...cycleInput, companyId: "" }, { keyStore: sandboxKeyStore, encryptionKey, occurredAtEpochMs: 305 })).status,
  "blocked",
  "the cycle refuses an empty company id",
);

const cycleCalls: { endpoint: string; payload: Readonly<Record<string, string>> }[] = [];
const verifiedCycle = await runNmiSandboxCycle(cycleInput, {
  keyStore: sandboxKeyStore,
  encryptionKey,
  occurredAtEpochMs: 306,
  transport: async (endpoint, payload) => {
    cycleCalls.push({ endpoint, payload });
    return {
      response: "1",
      response_code: "100",
      responsetext: "Approved",
      transactionid: String(900_000 + cycleCalls.length),
      authcode: "A1",
    };
  },
});
expectEqual(verifiedCycle.status, "verified", "the documented cycle verifies end to end");
expectEqual(verifiedCycle.environment, "sandbox", "the report names the sandbox environment");
expectEqual(verifiedCycle.steps.length, 6, "the cycle has its six documented steps");
expectEqual(verifiedCycle.steps.every((step) => step.outcome === "approved"), true, "every cycle step is approved");
expectEqual(cycleCalls.length, 6, "the cycle sends six transactions");
expectEqual(
  cycleCalls.every((call) => call.endpoint === NMI_SANDBOX_API_ENDPOINT),
  true,
  "every cycle transaction goes to the sandbox endpoint",
);
expectEqual(
  cycleCalls.map((call) => call.payload["type"]).join(","),
  "sale,auth,capture,refund,auth,void",
  "the cycle sends the documented transaction types in order",
);
expectEqual(cycleCalls[0]?.payload["payment_token"], token, "the sale exchanges the Collect.js token");
expectEqual(cycleCalls[1]?.payload["payment_token"], token, "the auth exchanges the Collect.js token");
expectEqual(cycleCalls[2]?.payload["transactionid"], "900002", "the capture captures the auth it followed");
expectEqual(cycleCalls[3]?.payload["transactionid"], "900001", "the refund refunds the sale");
expectEqual(cycleCalls[3]?.payload["amount"], "5.00", "the refund is the partial amount");
expectEqual(cycleCalls[4]?.payload["payment_token"], token, "the second auth exchanges the Collect.js token");
expectEqual(cycleCalls[5]?.payload["transactionid"], "900005", "the void voids the second auth");
expectEqual(cycleCalls[5]?.payload["amount"], undefined, "a void sends no amount");
expectEqual(JSON.stringify(verifiedCycle).includes(privateKey), false, "the cycle report leaks no credential");
expectEqual(JSON.stringify(verifiedCycle).includes(token), false, "the cycle report carries no payment token");
expectEqual(verifiedCycle.documentationUrls.length >= 5, true, "the report records the documentation URLs");
expectEqual(
  verifiedCycle.documentationUrls.includes("https://docs.nmi.com/reference/response-codes"),
  true,
  "the report records the response-code documentation",
);
expectEqual(
  verifiedCycle.documentationUrls.includes("https://docs.nmi.com/reference/query"),
  true,
  "the report records the query documentation",
);
expectEqual(NMI_SANDBOX_ENDPOINTS.length, 2, "the report records both sandbox endpoints");
expectEqual(NMI_SANDBOX_ENDPOINTS.includes(NMI_SANDBOX_QUERY_ENDPOINT), true, "the sandbox query endpoint is recorded");
expectEqual(NMI_SANDBOX_ENDPOINTS.includes(NMI_SANDBOX_API_ENDPOINT), true, "the sandbox transact endpoint is recorded");
expectEqual(NMI_STATUS_SYNC_DOCUMENTATION_URLS.length >= 5, true, "the documentation list is complete");
expectEqual(NMI_API_ENDPOINT.includes("secure.nmi.com"), true, "the payment endpoint is the documented production endpoint");

const declinedCycle = await runNmiSandboxCycle(cycleInput, {
  keyStore: sandboxKeyStore,
  encryptionKey,
  occurredAtEpochMs: 307,
  transport: async () => ({ response: "2", response_code: "202", responsetext: "Insufficient funds" }),
});
expectEqual(declinedCycle.status, "failed", "a declined sale fails the cycle");
expectEqual(declinedCycle.steps.length, 6, "the failed cycle still reports every step");
expectEqual(declinedCycle.steps[0]?.step, "sale", "the failed cycle names the sale first");
expectEqual(declinedCycle.steps[0]?.outcome, "declined", "a decline is classified as a decline");
expectEqual(declinedCycle.steps[0]?.responseCode, "202", "the declined step keeps its response code");
expectEqual(declinedCycle.steps[1]?.outcome, "not_attempted", "the steps after a decline are not attempted");
expectEqual(declinedCycle.steps[5]?.outcome, "not_attempted", "every later step is not attempted");
expectEqual(JSON.stringify(declinedCycle).includes(privateKey), false, "the failed cycle leaks no credential");

let unknownCalls = 0;
const unknownCycle = await runNmiSandboxCycle(cycleInput, {
  keyStore: sandboxKeyStore,
  encryptionKey,
  occurredAtEpochMs: 308,
  transport: async () => {
    unknownCalls += 1;
    throw new Error("timeout");
  },
});
expectEqual(unknownCycle.status, "failed", "a lost answer fails the cycle");
expectEqual(unknownCalls, 1, "a lost answer stops the cycle instead of retrying");
expectEqual(unknownCycle.steps[0]?.outcome, "unknown", "a lost answer is unknown");
expectEqual(unknownCycle.steps[0]?.detail.includes("reconcile"), true, "a lost answer asks for reconciliation");
expectEqual(unknownCycle.steps[1]?.outcome, "not_attempted", "nothing after a lost answer is attempted");

let captureCalls = 0;
const captureFailureCycle = await runNmiSandboxCycle(cycleInput, {
  keyStore: sandboxKeyStore,
  encryptionKey,
  occurredAtEpochMs: 309,
  transport: async (_endpoint, payload) => {
    captureCalls += 1;
    if (payload["type"] === "capture") return { response: "3", response_code: "300", responsetext: "Rejected" };
    return { response: "1", response_code: "100", transactionid: String(800_000 + captureCalls) };
  },
});
expectEqual(captureFailureCycle.status, "failed", "a rejected capture fails the cycle");
expectEqual(captureFailureCycle.steps[2]?.outcome, "rejected", "a gateway rejection is classified as rejected");
expectEqual(captureFailureCycle.steps[3]?.outcome, "not_attempted", "the refund after a rejected capture is not attempted");
expectEqual(captureCalls, 3, "the cycle stops at the rejected capture");

/* ---- the verdict ---- */

if (failures.length > 0) {
  process.stderr.write(
    `payments NMI status sync gate failed: ${failures.length} of ${checks} checks\n${failures.map((failure) => `  - ${failure}`).join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `payments NMI status sync gate passed: ${checks} checks (documented response codes, condition mapping, Query API parsing, optimistic status sync, sandbox cycle)\n`,
);

/** Await a rejected promise and count it as a passed check. */
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
