// path: lib/payments/adapters/nmi-verify.ts
import process from "node:process";
import {
  InMemoryNmiVerificationStore,
  recordNmiVerification,
  type NmiDocumentationCheck,
  type NmiSandboxNote,
} from "./nmi.ts";

/* ---- the check book ---- */

let checks = 0;
const failures: string[] = [];

function expect(condition: boolean, description: string): void {
  if (condition) {
    checks++;
  } else {
    failures.push(description);
  }
}

const verifiedAt = 1_000_000_000_000;

function makeChecks(allVerified: boolean): NmiDocumentationCheck[] {
  return [
    { topic: "NMI API documentation", url: "https://docs.nmi.com", verified: allVerified, notes: null },
    { topic: "Collect.js hosted fields", url: "https://secure.nmi.com/token/Collect.js", verified: allVerified, notes: null },
    { topic: "NMI gateway integration", url: "https://docs.nmi.com/gateway", verified: allVerified, notes: null },
  ];
}

function makeNotes(allPass: boolean): NmiSandboxNote[] {
  return [
    { test: "Token generation via Collect.js", result: allPass ? "pass" : "fail", details: null },
    { test: "Charge via NMI API", result: allPass ? "pass" : "fail", details: null },
    { test: "Refund via NMI API", result: allPass ? "pass" : "fail", details: null },
  ];
}

/* ---- scenario 1: all checks and tests pass -> verified ---- */

const store1 = new InMemoryNmiVerificationStore();
const result1 = recordNmiVerification(
  { documentationChecks: makeChecks(true), sandboxNotes: makeNotes(true), verifiedBy: "admin-1" },
  { store: store1, occurredAtEpochMs: verifiedAt },
);

expect(result1.status === "recorded", "a verification with all checks passing is recorded");
if (result1.status === "recorded") {
  expect(result1.record.providerName === "nmi", "the record carries the provider name nmi");
  expect(result1.record.overallStatus === "verified", "all checks passing gives overall status verified");
  expect(result1.record.verifiedBy === "admin-1", "the verifier is recorded");
  expect(result1.record.verifiedAtEpochMs === verifiedAt, "the verification time is recorded");
}

/* ---- scenario 2: some checks fail -> partial ---- */

const store2 = new InMemoryNmiVerificationStore();
const result2 = recordNmiVerification(
  { documentationChecks: makeChecks(false), sandboxNotes: makeNotes(false), verifiedBy: "admin-1" },
  { store: store2, occurredAtEpochMs: verifiedAt },
);

expect(result2.status === "recorded", "a verification with some checks failing is recorded");
if (result2.status === "recorded") {
  expect(result2.record.overallStatus === "not_verified", "no checks passing gives overall status not_verified");
}

/* ---- scenario 3: mixed checks -> partial ---- */

const store3 = new InMemoryNmiVerificationStore();
const mixedChecks: NmiDocumentationCheck[] = [
  { topic: "NMI API documentation", url: "https://docs.nmi.com", verified: true, notes: null },
  { topic: "Collect.js hosted fields", url: "https://secure.nmi.com/token/Collect.js", verified: false, notes: "Needs review" },
  { topic: "NMI gateway integration", url: "https://docs.nmi.com/gateway", verified: true, notes: null },
];
const mixedNotes: NmiSandboxNote[] = [
  { test: "Token generation via Collect.js", result: "pass", details: null },
  { test: "Charge via NMI API", result: "fail", details: "Timeout in sandbox" },
  { test: "Refund via NMI API", result: "not_tested", details: null },
];
const result3 = recordNmiVerification(
  { documentationChecks: mixedChecks, sandboxNotes: mixedNotes, verifiedBy: "admin-2" },
  { store: store3, occurredAtEpochMs: verifiedAt },
);

expect(result3.status === "recorded", "a verification with mixed checks is recorded");
if (result3.status === "recorded") {
  expect(result3.record.overallStatus === "partial", "mixed checks give overall status partial");
  expect(result3.record.documentationChecks.length === 3, "the record carries all three documentation checks");
  expect(result3.record.sandboxNotes.length === 3, "the record carries all three sandbox notes");
  expect(result3.record.documentationChecks[1]?.notes === "Needs review", "the documentation check notes are stored");
  expect(result3.record.sandboxNotes[1]?.details === "Timeout in sandbox", "the sandbox note details are stored");
}

/* ---- scenario 4: the record is stored ---- */

if (result1.status === "recorded") {
  expect(store1.findById(result1.record.id) !== null, "the record is stored in the store");
  expect(store1.findByProvider("nmi").length === 1, "the record is findable by provider");
  expect(store1.findLatest("nmi")?.id === result1.record.id, "findLatest returns the record");
}

/* ---- scenario 5: empty documentation checks is rejected ---- */

const store5 = new InMemoryNmiVerificationStore();
const emptyChecks = recordNmiVerification(
  { documentationChecks: [], sandboxNotes: [], verifiedBy: "admin-1" },
  { store: store5, occurredAtEpochMs: verifiedAt },
);
expect(emptyChecks.status === "failed", "empty documentation checks are rejected");

/* ---- scenario 6: empty verifiedBy is rejected ---- */

const store6 = new InMemoryNmiVerificationStore();
const emptyVerifier = recordNmiVerification(
  { documentationChecks: makeChecks(true), sandboxNotes: makeNotes(true), verifiedBy: "  " },
  { store: store6, occurredAtEpochMs: verifiedAt },
);
expect(emptyVerifier.status === "failed", "an empty verifier is rejected");

/* ---- scenario 7: a documentation check without a topic is rejected ---- */

const store7 = new InMemoryNmiVerificationStore();
const noTopic = recordNmiVerification(
  {
    documentationChecks: [{ topic: "  ", url: "https://docs.nmi.com", verified: true, notes: null }],
    sandboxNotes: [],
    verifiedBy: "admin-1",
  },
  { store: store7, occurredAtEpochMs: verifiedAt },
);
expect(noTopic.status === "failed", "a documentation check without a topic is rejected");

/* ---- scenario 8: a documentation check without a url is rejected ---- */

const store8 = new InMemoryNmiVerificationStore();
const noUrl = recordNmiVerification(
  {
    documentationChecks: [{ topic: "NMI API", url: "", verified: true, notes: null }],
    sandboxNotes: [],
    verifiedBy: "admin-1",
  },
  { store: store8, occurredAtEpochMs: verifiedAt },
);
expect(noUrl.status === "failed", "a documentation check without a url is rejected");

/* ---- scenario 9: a sandbox note without a test name is rejected ---- */

const store9 = new InMemoryNmiVerificationStore();
const noTest = recordNmiVerification(
  {
    documentationChecks: makeChecks(true),
    sandboxNotes: [{ test: "  ", result: "pass", details: null }],
    verifiedBy: "admin-1",
  },
  { store: store9, occurredAtEpochMs: verifiedAt },
);
expect(noTest.status === "failed", "a sandbox note without a test name is rejected");

/* ---- scenario 10: multiple records for the same provider ---- */

const store10 = new InMemoryNmiVerificationStore();
const r10a = recordNmiVerification(
  { documentationChecks: makeChecks(true), sandboxNotes: makeNotes(true), verifiedBy: "admin-1" },
  { store: store10, occurredAtEpochMs: verifiedAt },
);
const r10b = recordNmiVerification(
  { documentationChecks: makeChecks(false), sandboxNotes: makeNotes(false), verifiedBy: "admin-2" },
  { store: store10, occurredAtEpochMs: verifiedAt + 1_000 },
);

expect(r10a.status === "recorded" && r10b.status === "recorded", "two records are created for the same provider");
expect(store10.findByProvider("nmi").length === 2, "two records are stored for the provider");
if (r10b.status === "recorded") {
  expect(store10.findLatest("nmi")?.id === r10b.record.id, "findLatest returns the most recent record");
}

/* ---- scenario 11: not_tested sandbox notes ---- */

const store11 = new InMemoryNmiVerificationStore();
const notTestedNotes: NmiSandboxNote[] = [
  { test: "Token generation", result: "not_tested", details: "Sandbox unavailable" },
  { test: "Charge", result: "not_tested", details: null },
];
const result11 = recordNmiVerification(
  { documentationChecks: makeChecks(true), sandboxNotes: notTestedNotes, verifiedBy: "admin-1" },
  { store: store11, occurredAtEpochMs: verifiedAt },
);

expect(result11.status === "recorded", "a verification with not_tested sandbox notes is recorded");
if (result11.status === "recorded") {
  expect(result11.record.overallStatus === "partial", "verified checks but not_tested notes gives partial");
}

/* ---- scenario 12: two records have different ids ---- */

if (r10a.status === "recorded" && r10b.status === "recorded") {
  expect(r10a.record.id !== r10b.record.id, "two records have different ids");
}

/* ---- the verdict ---- */

if (failures.length > 0) {
  process.stderr.write(`payments NMI adapter gate failed with ${String(failures.length)} problem(s):\n`);
  for (const failure of failures) {
    process.stderr.write(`  - ${failure}\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `payments NMI adapter gate passed: ${checks} checks, a service that records NMI documentation verification and sandbox notes - the record carries the documentation checks, sandbox notes, and an overall status calculated from them, the record is stored and findable by provider, and validation rejects empty or incomplete inputs\n`,
);
