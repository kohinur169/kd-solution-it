// path: lib/payments/adapters/payoneer-verify.ts

/**
 * The gate for STEP 154: Payoneer documentation verification and sandbox notes recording.
 *
 * A check script, not a test file: it exercises the recording service with the documentation review
 * this session actually produced and with records that must be refused, then fails the run and names
 * every check that did not hold. No network call is made and no credential is used.
 */

import process from "node:process";
import {
  calculatePayoneerStatus,
  InMemoryPayoneerVerificationStore,
  isPayoneerDocumentationUrl,
  PAYONEER_DOCUMENTATION_HOSTS,
  PAYONEER_DOCUMENTATION_SOURCES,
  PAYONEER_MAXIMUM_PAYOUTS_PER_CALL,
  PAYONEER_MINIMUM_TLS_VERSION,
  PAYONEER_OPEN_QUESTIONS,
  PAYONEER_PRODUCTION_API_BASE,
  PAYONEER_PRODUCTION_AUTH_BASE,
  PAYONEER_PROVIDER_KEY,
  PAYONEER_PROVIDER_NAME,
  PAYONEER_RECORDED_RULES,
  PAYONEER_SANDBOX_API_BASE,
  PAYONEER_SANDBOX_AUTH_BASE,
  PAYONEER_SANDBOX_CYCLE,
  PAYONEER_SANDBOX_STEP_IDS,
  PAYONEER_SESSION_CHECKS,
  PAYONEER_SESSION_SANDBOX_NOTES,
  PAYONEER_SESSION_STATUS,
  payoneerDocumentationHostOf,
  recordPayoneerVerification,
  sanitizePayoneerText,
  validatePayoneerDocumentationCheck,
  validatePayoneerSandboxNote,
  type PayoneerDocumentationCheck,
  type PayoneerSandboxNote,
  type PayoneerVerificationAuditEntry,
  type PayoneerVerificationRecord,
} from "./payoneer.ts";

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

/* ------------------------------------------------------------------------------------------------
 * Section 1: the constants
 * --------------------------------------------------------------------------------------------- */

expectEqual(PAYONEER_PROVIDER_KEY, "payoneer", "the provider key is the registry key");
expectEqual(PAYONEER_PROVIDER_NAME, "Payoneer", "the provider name is the registered one");
expectEqual(PAYONEER_SANDBOX_API_BASE, "https://api.sandbox.payoneer.com", "the sandbox API base is the documented one");
expectEqual(PAYONEER_PRODUCTION_API_BASE, "https://api.payoneer.com", "the production API base is the documented one");
expectEqual(PAYONEER_SANDBOX_AUTH_BASE, "https://login.sandbox.payoneer.com", "the sandbox auth host is the documented one");
expectEqual(PAYONEER_PRODUCTION_AUTH_BASE, "https://login.payoneer.com", "the production auth host is the documented one");
expectEqual(PAYONEER_MAXIMUM_PAYOUTS_PER_CALL, 500, "the documented payout limit is recorded");
expectEqual(PAYONEER_MINIMUM_TLS_VERSION, "1.2", "the documented TLS floor is recorded");
expectEqual(PAYONEER_DOCUMENTATION_HOSTS.join(","), "developer.payoneer.com,www.payoneer.com", "only Payoneer's own documentation hosts are allowed");

/* ------------------------------------------------------------------------------------------------
 * Section 2: the documentation sources
 * --------------------------------------------------------------------------------------------- */

expectEqual(PAYONEER_DOCUMENTATION_SOURCES.length, 8, "every page read in this session is recorded");
expectEqual(new Set(PAYONEER_DOCUMENTATION_SOURCES.map((source) => source.url)).size, 8, "the source urls are unique");
for (const source of PAYONEER_DOCUMENTATION_SOURCES) {
  expect(isPayoneerDocumentationUrl(source.url), `the source ${source.url} is on Payoneer's documentation hosts`);
  expect(source.topic.trim().length >= 3, `the source ${source.url} names its topic`);
  expect(source.establishes.trim().length >= 20, `the source ${source.url} records what it established`);
  expect(source.url.startsWith("https://"), `the source ${source.url} is https`);
}
const sourceUrls = PAYONEER_DOCUMENTATION_SOURCES.map((source) => source.url).join(" ");
expect(sourceUrls.includes("mass-submit-payout"), "the mass payout page is recorded");
expect(sourceUrls.includes("mass-payee-onboarding"), "the payee onboarding page is recorded");
expect(sourceUrls.includes("mass-payouts-and-services"), "the program API reference is recorded");
expect(sourceUrls.includes("white-label-payouts-v4"), "the white-label integration guide is recorded");
expect(sourceUrls.includes("psd2/get-started"), "the sandbox environment page is recorded");

/* ------------------------------------------------------------------------------------------------
 * Section 3: the recorded rules and the open questions
 * --------------------------------------------------------------------------------------------- */

expect(PAYONEER_RECORDED_RULES.length >= 12, "the recorded rules cover the documented behaviour");
expectEqual(new Set(PAYONEER_RECORDED_RULES).size, PAYONEER_RECORDED_RULES.length, "the recorded rules are unique");
const rules = PAYONEER_RECORDED_RULES.join("\n");
expect(rules.includes("api.sandbox.payoneer.com"), "the rules record the sandbox base");
expect(rules.includes("api.payoneer.com"), "the rules record the production base");
expect(rules.includes("login.sandbox.payoneer.com"), "the rules record the sandbox auth host");
expect(rules.includes("TLS 1.2"), "the rules record the transport requirement");
expect(rules.includes("/v4/programs/{program_id}/masspayouts"), "the rules record the mass payout endpoint");
expect(rules.includes("500"), "the rules record the documented payout limit");
expect(rules.includes("/v4/programs/{program_id}/payees/registration-link"), "the rules record the registration link endpoint");
expect(rules.includes("/v4/programs/{program_id}/payees/{ClientPayeeID}/status"), "the rules record the payee status endpoint");
expect(rules.includes("/v4/programs/{program_id}/payouts/{client_reference_id}/status"), "the rules record the payout status endpoint");
expect(rules.includes("load_date"), "the rules record the transferred marker");
expect(rules.includes("Admin Console"), "the rules record where webhook urls are configured");
expect(rules.includes("five additional attempts"), "the rules record the retry behaviour");
expect(rules.includes("reason tables"), "the rules record the published reason tables");
expect(/bearer|token/i.test(rules), "the rules record the token scheme");
expect(/Bearer [A-Za-z0-9]{8,}/u.test(rules) === false, "the rules carry no credential");

expectEqual(PAYONEER_OPEN_QUESTIONS.length, 3, "the pages' unanswered questions are recorded");
const questions = PAYONEER_OPEN_QUESTIONS.join("\n");
expect(questions.includes("webhook signing scheme"), "the open question about webhook signing is recorded");
expect(questions.includes("STEP 157"), "the open question names the STEP that must read it");
expect(questions.includes("Token lifetime"), "the open question about token lifetime is recorded");
expect(questions.includes("no sandbox call"), "the open question about missing credentials is recorded");

/* ------------------------------------------------------------------------------------------------
 * Section 4: the sandbox cycle
 * --------------------------------------------------------------------------------------------- */

expectEqual(PAYONEER_SANDBOX_CYCLE.length, 5, "the payout cycle has the five documented steps");
expectEqual(PAYONEER_SANDBOX_STEP_IDS.join(","), "registration_link,payee_status,mass_payout,payout_status,ipcn_received", "the cycle order is the documented one");
expectEqual(new Set(PAYONEER_SANDBOX_STEP_IDS).size, 5, "the cycle step ids are unique");
for (const step of PAYONEER_SANDBOX_CYCLE) {
  expect(step.test.trim().length >= 10, `the step ${step.id} names what it proves`);
  expect(step.method === "POST" || step.method === "GET", `the step ${step.id} names its method`);
  expect(step.path.startsWith("/"), `the step ${step.id} names its path`);
}
expectEqual(PAYONEER_SANDBOX_CYCLE[0]?.path, "/v4/programs/{program_id}/payees/registration-link", "the first step is the registration link");
expectEqual(PAYONEER_SANDBOX_CYCLE[2]?.path, "/v4/programs/{program_id}/masspayouts", "the third step is the mass payout");
expectEqual(PAYONEER_SANDBOX_CYCLE[3]?.path, "/v4/programs/{program_id}/payouts/{client_reference_id}/status", "the fourth step is the payout status");

/* ------------------------------------------------------------------------------------------------
 * Section 5: provider text
 * --------------------------------------------------------------------------------------------- */

expectEqual(sanitizePayoneerText("<b>Invalid</b> payee"), "bInvalid/b payee", "markup is stripped");
expectEqual(sanitizePayoneerText("line1\nline2\ttab"), "line1 line2 tab", "control characters collapse");
expectEqual(sanitizePayoneerText(null), "", "missing text is empty");
expectEqual(sanitizePayoneerText(" padded "), "padded", "text is trimmed");
expectEqual(sanitizePayoneerText("x".repeat(900)).length, 500, "text is capped");
expect(sanitizePayoneerText("x".repeat(901)) === sanitizePayoneerText("x".repeat(900)), "text beyond twice the cap is cut the same way");

/* ------------------------------------------------------------------------------------------------
 * Section 6: the documentation url allowlist
 * ---------------------------------------------------------------------------------------------- */

expectEqual(payoneerDocumentationHostOf("https://www.payoneer.com/developers-docs/"), "www.payoneer.com", "a product page host is read");
expectEqual(payoneerDocumentationHostOf("https://developer.payoneer.com/docs/mass-payouts-and-services.html"), "developer.payoneer.com", "the reference host is read");
expectEqual(payoneerDocumentationHostOf("http://www.payoneer.com/developers-docs/"), null, "a plain http url is refused");
expectEqual(payoneerDocumentationHostOf("https://www.payoneer.com"), null, "a url without a path is refused");
expectEqual(payoneerDocumentationHostOf("ftp://www.payoneer.com/docs/"), null, "a non-https scheme is refused");
expectEqual(payoneerDocumentationHostOf(""), null, "an empty url is refused");
expectEqual(payoneerDocumentationHostOf(`https://www.payoneer.com/${"x".repeat(320)}`), null, "an over-long url is refused");
expectEqual(payoneerDocumentationHostOf("https://www.payoneer.com/developers-docs/ index"), null, "a url with a space is refused");

expect(isPayoneerDocumentationUrl("https://www.payoneer.com/developers-docs/mass-payout/"), "a product page is a Payoneer page");
expect(isPayoneerDocumentationUrl("https://developer.payoneer.com/docs/white-label-payouts-v4.html"), "the guide is a Payoneer page");
expect(isPayoneerDocumentationUrl("https://payoneer.evil.example/docs/") === false, "a look-alike host is refused");
expect(isPayoneerDocumentationUrl("https://www.payoneer.com.evil.example/docs/") === false, "a suffixed host is refused");
expect(isPayoneerDocumentationUrl("https://docs.nmi.com/reference/overview") === false, "another provider's page is refused");
expect(isPayoneerDocumentationUrl("https://www.payoneer.community/docs/") === false, "a community host is refused");

/* ------------------------------------------------------------------------------------------------
 * Section 7: check and note validation
 * ---------------------------------------------------------------------------------------------- */

const validCheck: PayoneerDocumentationCheck = {
  topic: "Submit mass payout",
  url: "https://www.payoneer.com/developers-docs/mass-payout/mass-submit-payout/",
  verified: true,
  notes: "The documented request carries the Payments array and the 500 payout limit.",
};
expectEqual(validatePayoneerDocumentationCheck(validCheck), null, "the documented source is a valid check");
expectEqual(validatePayoneerDocumentationCheck({ ...validCheck, topic: "" }), "a documentation check needs a topic of 3 to 120 characters", "an empty topic is refused");
expectEqual(validatePayoneerDocumentationCheck({ ...validCheck, topic: "ab" }), "a documentation check needs a topic of 3 to 120 characters", "a two character topic is refused");
expectEqual(validatePayoneerDocumentationCheck({ ...validCheck, topic: "<script>" }), "a documentation check needs a topic of 3 to 120 characters", "a markup topic is refused");
expectEqual(
  validatePayoneerDocumentationCheck({ ...validCheck, url: "https://docs.nmi.com/reference/overview" }),
  "a documentation check must name a page on Payoneer's own documentation hosts",
  "another provider's page is refused as a check",
);
expectEqual(
  validatePayoneerDocumentationCheck({ ...validCheck, url: "http://www.payoneer.com/developers-docs/" }),
  "a documentation check must name a page on Payoneer's own documentation hosts",
  "a plain http page is refused as a check",
);

const validNote: PayoneerSandboxNote = { test: "mass_payout", result: "pass", details: "Accepted with a payout id." };
expectEqual(validatePayoneerSandboxNote(validNote), null, "a passed cycle step is a valid note");
expectEqual(
  validatePayoneerSandboxNote({ ...validNote, test: "charge" }),
  "a sandbox note must name one step of the documented sandbox cycle",
  "an undocumented step is refused",
);
expectEqual(
  validatePayoneerSandboxNote({ test: "mass_payout", result: "not_tested", details: null }),
  "a sandbox note for a step that was not run must state why",
  "an unrun step without a reason is refused",
);
expectEqual(
  validatePayoneerSandboxNote({ test: "mass_payout", result: "not_tested", details: "   " }),
  "a sandbox note for a step that was not run must state why",
  "an unrun step with a blank reason is refused",
);
expectEqual(
  validatePayoneerSandboxNote({ test: "mass_payout", result: "fail", details: null }),
  "a failed sandbox step must carry the provider's answer",
  "a failed step without an answer is refused",
);

/* ------------------------------------------------------------------------------------------------
 * Section 8: the status rule
 * ---------------------------------------------------------------------------------------------- */

const verifiedChecks: PayoneerDocumentationCheck[] = [{ ...validCheck }];
const passedNotes: PayoneerSandboxNote[] = PAYONEER_SANDBOX_STEP_IDS.map((id) => ({ test: id, result: "pass", details: "Ran." }));

expectEqual(calculatePayoneerStatus(verifiedChecks, passedNotes), "verified", "a complete cycle with verified pages is verified");
expectEqual(
  calculatePayoneerStatus([{ ...validCheck, verified: false }], passedNotes),
  "partial",
  "an unverified page makes the record partial",
);
expectEqual(calculatePayoneerStatus(verifiedChecks, []), "partial", "verified pages with no sandbox note are only partial");
expectEqual(
  calculatePayoneerStatus(verifiedChecks, PAYONEER_SANDBOX_STEP_IDS.slice(0, 4).map((id) => ({ test: id, result: "pass", details: "Ran." }))),
  "partial",
  "a cycle missing one step is only partial",
);
expectEqual(
  calculatePayoneerStatus(verifiedChecks, [...passedNotes.slice(0, 4), { test: "ipcn_received", result: "not_tested", details: "No endpoint." }]),
  "partial",
  "an unrun step makes the cycle incomplete",
);
expectEqual(
  calculatePayoneerStatus(verifiedChecks, [...passedNotes.slice(0, 4), { test: "ipcn_received", result: "fail", details: "Rejected." }]),
  "partial",
  "a failed step makes the cycle incomplete",
);
expectEqual(
  calculatePayoneerStatus([{ ...validCheck, verified: false }], [{ test: "mass_payout", result: "not_tested", details: "No credentials." }]),
  "not_verified",
  "nothing verified and nothing run is not verified",
);
expectEqual(calculatePayoneerStatus([], []), "not_verified", "an empty record is not verified");
expectEqual(
  calculatePayoneerStatus([{ ...validCheck, verified: false }], []),
  "not_verified",
  "an unverified page with no notes is not verified",
);

/* ------------------------------------------------------------------------------------------------
 * Section 9: recording
 * ---------------------------------------------------------------------------------------------- */

const store = new InMemoryPayoneerVerificationStore();
const audits: PayoneerVerificationAuditEntry[] = [];
const recorded = recordPayoneerVerification(
  {
    environment: "sandbox",
    documentationChecks: [validCheck],
    sandboxNotes: passedNotes,
    verifiedBy: "compliance@example.com",
  },
  { store, occurredAtEpochMs: 1_000, recordAudit: (entry) => audits.push(entry) },
);
expectEqual(recorded.status, "recorded", "a complete review is recorded");
if (recorded.status === "recorded") {
  expectEqual(recorded.record.status, "verified", "a complete review is verified");
  expectEqual(recorded.record.providerKey, "payoneer", "the record names the provider key");
  expectEqual(recorded.record.providerName, "Payoneer", "the record names the provider");
  expectEqual(recorded.record.environment, "sandbox", "the record names the environment");
  expectEqual(recorded.record.verifiedBy, "compliance@example.com", "the record names the verifier");
  expectEqual(recorded.record.verifiedAtEpochMs, 1_000, "the record carries its instant");
  expectEqual(recorded.record.documentationChecks.length, 1, "the record keeps its checks");
  expectEqual(recorded.record.sandboxNotes.length, 5, "the record keeps its notes");
  expect(/^[0-9a-f-]{36}$/u.test(recorded.record.id), "the record id is a uuid");
  expectEqual(store.findById(recorded.record.id)?.id, recorded.record.id, "the record is stored");
  expectEqual(store.findLatest()?.id, recorded.record.id, "the latest record is the one just written");
}
expectEqual(audits.length, 1, "recording writes one audit entry");
expectEqual(audits[0]?.action, "provider_verification.recorded", "the audit entry names the action");
expectEqual(audits[0]?.providerKey, "payoneer", "the audit entry names the provider");
expectEqual(audits[0]?.status, "verified", "the audit entry records the calculated status");
expectEqual(audits[0]?.occurredAtEpochMs, 1_000, "the audit entry carries its instant");
expect(JSON.stringify(audits).includes("Bearer") === false, "the audit entry carries no credential");

const failureCases: readonly (readonly [Parameters<typeof recordPayoneerVerification>[0], string])[] = [
  [{ environment: "sandbox", documentationChecks: [], sandboxNotes: [], verifiedBy: "a@b.example" }, "a review without a documentation check is refused"],
  [{ environment: "sandbox", documentationChecks: [validCheck], sandboxNotes: passedNotes, verifiedBy: "ab" }, "a review without a named verifier is refused"],
  [{ environment: "sandbox", documentationChecks: [{ ...validCheck, url: "https://docs.nmi.com/reference/overview" }], sandboxNotes: [], verifiedBy: "a@b.example" }, "a review naming another provider's page is refused"],
  [{ environment: "sandbox", documentationChecks: [validCheck], sandboxNotes: [{ test: "charge", result: "pass", details: "x" }], verifiedBy: "a@b.example" }, "a review naming an undocumented step is refused"],
  [{ environment: "sandbox", documentationChecks: [validCheck], sandboxNotes: [validNote, validNote], verifiedBy: "a@b.example" }, "a duplicated cycle step is refused"],
  [{ environment: "sandbox", documentationChecks: [validCheck], sandboxNotes: [{ test: "mass_payout", result: "not_tested", details: null }], verifiedBy: "a@b.example" }, "a review with an unexplained unrun step is refused"],
];
for (const [input, description] of failureCases) {
  const outcome = recordPayoneerVerification(input, { store: new InMemoryPayoneerVerificationStore(), occurredAtEpochMs: 1 });
  expectEqual(outcome.status, "failed", description);
}

const inflateStore = new InMemoryPayoneerVerificationStore();
const inflated = recordPayoneerVerification(
  {
    environment: "sandbox",
    documentationChecks: [validCheck],
    sandboxNotes: [{ test: "mass_payout", result: "not_tested", details: "No credentials." }],
    verifiedBy: "a@b.example",
  },
  { store: inflateStore, occurredAtEpochMs: 2 },
);
expectEqual(inflated.status, "recorded", "an honest partial review is recorded");
if (inflated.status === "recorded") {
  expectEqual(inflated.record.status, "partial", "the caller cannot make a partial review verified");
  expectEqual(inflated.record.sandboxNotes[0]?.result, "not_tested", "the recorded note keeps its result");
}
const latestOfTwo = recordPayoneerVerification(
  { environment: "production", documentationChecks: [validCheck], sandboxNotes: passedNotes, verifiedBy: "ops@example.com" },
  { store: inflateStore, occurredAtEpochMs: 3 },
);
expectEqual(latestOfTwo.status, "recorded", "a second review is recorded");
expectEqual(inflateStore.findByProvider().length, 2, "both reviews are kept");
expectEqual(inflateStore.findLatest()?.verifiedAtEpochMs, 3, "the newest review is the latest");
expectEqual(inflateStore.findLatest()?.environment, "production", "the newest review is the newest environment");

/* ------------------------------------------------------------------------------------------------
 * Section 10: this session's review is partial, and can never be anything else
 * --------------------------------------------------------------------------------------------- */

expectEqual(PAYONEER_SESSION_CHECKS.length, PAYONEER_DOCUMENTATION_SOURCES.length, "the session checked every recorded source");
expect(PAYONEER_SESSION_CHECKS.every((check) => check.verified), "every session check verified its page");
expect(PAYONEER_SESSION_CHECKS.every((check) => isPayoneerDocumentationUrl(check.url)), "every session check names a Payoneer page");
expectEqual(PAYONEER_SESSION_SANDBOX_NOTES.length, 5, "the session recorded all five cycle steps");
expect(PAYONEER_SESSION_SANDBOX_NOTES.every((note) => note.result === "not_tested"), "no session step claims a pass");
expect(
  PAYONEER_SESSION_SANDBOX_NOTES.every((note) => (note.details ?? "").includes("has not been run")),
  "every unrun step states plainly that it was not run",
);
expect(
  PAYONEER_SESSION_SANDBOX_NOTES.every((note) => (note.details ?? "").includes("Payoneer sandbox credentials")),
  "every unrun step states the missing credential as the reason",
);
expectEqual(PAYONEER_SESSION_STATUS, "partial", "this session's review is partial");
expect(PAYONEER_SESSION_STATUS !== "verified", "this session's review can never read as verified");

const sessionStore = new InMemoryPayoneerVerificationStore();
const sessionRecord = recordPayoneerVerification(
  {
    environment: "sandbox",
    documentationChecks: PAYONEER_SESSION_CHECKS,
    sandboxNotes: PAYONEER_SESSION_SANDBOX_NOTES,
    verifiedBy: "step-154-review",
  },
  { store: sessionStore, occurredAtEpochMs: 1_760_000_000_000 },
);
expectEqual(sessionRecord.status, "recorded", "this session's review is recorded honestly");
if (sessionRecord.status === "recorded") {
  expectEqual(sessionRecord.record.status, "partial", "the recorded session review is partial");
  expectEqual(sessionRecord.record.documentationChecks.length, 8, "the recorded session review keeps every check");
  expectEqual(
    sessionRecord.record.sandboxNotes.filter((note) => note.result === "not_tested").length,
    5,
    "the recorded session review keeps every unrun step",
  );
}

/* ---- the store's own rules ---- */

const storeRules = new InMemoryPayoneerVerificationStore();
const seedRecord: PayoneerVerificationRecord = {
  id: "00000000-0000-4000-8000-000000000001",
  providerKey: "payoneer",
  providerName: "Payoneer",
  environment: "sandbox",
  documentationChecks: deepFrozenChecks(),
  sandboxNotes: [],
  status: "partial",
  verifiedAtEpochMs: 5,
  verifiedBy: "seed",
};
storeRules.insert(seedRecord);
expectEqual(storeRules.findByProvider().length, 1, "the store finds the provider's records");
expectThrows(() => storeRules.insert(seedRecord), "a duplicate record id is refused");
expectEqual(storeRules.findLatest()?.id, seedRecord.id, "the single record is the latest");
expectEqual(new InMemoryPayoneerVerificationStore().findLatest(), null, "an empty store has no latest");

/* ---- the constants are frozen ---- */

expect(Object.isFrozen(PAYONEER_DOCUMENTATION_SOURCES), "the documentation sources are frozen");
expect(Object.isFrozen(PAYONEER_RECORDED_RULES), "the recorded rules are frozen");
expect(Object.isFrozen(PAYONEER_OPEN_QUESTIONS), "the open questions are frozen");
expect(Object.isFrozen(PAYONEER_SANDBOX_CYCLE), "the sandbox cycle is frozen");
expect(Object.isFrozen(PAYONEER_SANDBOX_STEP_IDS), "the sandbox step ids are frozen");
expect(Object.isFrozen(PAYONEER_SESSION_CHECKS), "the session checks are frozen");
expect(Object.isFrozen(PAYONEER_SESSION_SANDBOX_NOTES), "the session notes are frozen");
expect(Object.isFrozen(PAYONEER_DOCUMENTATION_HOSTS), "the documentation hosts are frozen");

/** A minimal frozen check list for the store fixture. */
function deepFrozenChecks(): readonly PayoneerDocumentationCheck[] {
  return [{ ...validCheck }];
}

/* ---- the verdict ---- */

if (failures.length > 0) {
  process.stderr.write(
    `payments Payoneer documentation gate failed: ${failures.length} of ${checks} checks\n${failures.map((failure) => `  - ${failure}`).join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `payments Payoneer documentation gate passed: ${checks} checks (sources on Payoneer's own hosts, recorded rules, the five step sandbox cycle, the honest partial status, and a record that cannot be inflated to verified)\n`,
);
