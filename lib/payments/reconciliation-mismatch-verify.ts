// path: lib/payments/reconciliation-mismatch-verify.ts
import process from "node:process";
import {
  InMemoryMismatchStore,
  addMismatch,
  resolveMismatch,
  checkOverdue,
  MISMATCH_RESOLUTION_DEADLINE_MS,
} from "./reconciliation-mismatch.ts";

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

const createdAt = 1_000_000_000_000;

function makeInput(overrides: Record<string, unknown> = {}) {
  return {
    companyId: "company-1",
    providerName: "payoneer",
    providerTransactionId: "txn-001",
    type: "amount_mismatch" as const,
    processorAmountMinor: 12_000n,
    systemAmountMinor: 10_000n,
    ...overrides,
  };
}

/* ---- scenario 1: adding a mismatch creates an open mismatch ---- */

const store1 = new InMemoryMismatchStore();
const added = addMismatch(makeInput(), { store: store1, occurredAtEpochMs: createdAt });

expect(added.status === "added", "a valid mismatch is added to the queue");
if (added.status === "added") {
  expect(added.mismatch.status === "open", "the mismatch starts in the open state");
  expect(added.mismatch.companyId === "company-1", "the mismatch carries the right company");
  expect(added.mismatch.providerName === "payoneer", "the mismatch carries the right provider");
  expect(added.mismatch.providerTransactionId === "txn-001", "the mismatch carries the right transaction id");
  expect(added.mismatch.type === "amount_mismatch", "the mismatch carries the right type");
}

/* ---- scenario 2: the resolution deadline is 3 days from creation ---- */

if (added.status === "added") {
  expect(added.mismatch.resolutionDeadlineEpochMs === createdAt + MISMATCH_RESOLUTION_DEADLINE_MS, "the resolution deadline is 3 days from creation");
  expect(added.mismatch.resolvedAtEpochMs === null, "the mismatch has no resolution time while open");
  expect(added.mismatch.resolvedBy === null, "the mismatch has no resolver while open");
  expect(added.mismatch.resolutionNote === null, "the mismatch has no resolution note while open");
}

/* ---- scenario 3: adding a duplicate mismatch is rejected ---- */

const store3 = new InMemoryMismatchStore();
const first = addMismatch(makeInput(), { store: store3, occurredAtEpochMs: createdAt });
const duplicate = addMismatch(makeInput(), { store: store3, occurredAtEpochMs: createdAt + 1_000 });
expect(first.status === "added", "the first mismatch is added");
expect(duplicate.status === "failed", "a duplicate mismatch for the same transaction id is rejected");

/* ---- scenario 4: adding a matched entry as a mismatch is rejected ---- */

const store4 = new InMemoryMismatchStore();
const matched = addMismatch(makeInput({ type: "matched" }), { store: store4, occurredAtEpochMs: createdAt });
expect(matched.status === "failed", "a matched entry is rejected as a mismatch");

/* ---- scenario 5: empty fields are rejected ---- */

const store5 = new InMemoryMismatchStore();
const emptyCompany = addMismatch(makeInput({ companyId: " " }), { store: store5, occurredAtEpochMs: createdAt });
expect(emptyCompany.status === "failed", "an empty company id is rejected");

const store5b = new InMemoryMismatchStore();
const emptyProvider = addMismatch(makeInput({ providerName: "" }), { store: store5b, occurredAtEpochMs: createdAt });
expect(emptyProvider.status === "failed", "an empty provider name is rejected");

const store5c = new InMemoryMismatchStore();
const emptyTxn = addMismatch(makeInput({ providerTransactionId: "  " }), { store: store5c, occurredAtEpochMs: createdAt });
expect(emptyTxn.status === "failed", "an empty transaction id is rejected");

/* ---- scenario 6: resolving an open mismatch ---- */

const store6 = new InMemoryMismatchStore();
const r6 = addMismatch(makeInput(), { store: store6, occurredAtEpochMs: createdAt });

if (r6.status === "added") {
  const resolved = resolveMismatch(r6.mismatch.id, {
    resolverId: "office-user-1",
    note: "Verified with processor report",
    store: store6,
    nowEpochMs: createdAt + 1_000,
  });

  expect(resolved.status === "resolved", "an open mismatch is resolved");
  if (resolved.status === "resolved") {
    expect(resolved.mismatch.status === "resolved", "the mismatch is marked resolved");
    expect(resolved.mismatch.resolvedBy === "office-user-1", "the resolver is recorded");
    expect(resolved.mismatch.resolvedAtEpochMs === createdAt + 1_000, "the resolution time is recorded");
    expect(resolved.mismatch.resolutionNote === "Verified with processor report", "the resolution note is stored");
  }
}

/* ---- scenario 7: resolving a non-existent mismatch is rejected ---- */

const store7 = new InMemoryMismatchStore();
const noMismatch = resolveMismatch("nonexistent", {
  resolverId: "office-user-1",
  note: null,
  store: store7,
  nowEpochMs: createdAt,
});
expect(noMismatch.status === "failed", "resolving a non-existent mismatch is rejected");

/* ---- scenario 8: resolving a non-open mismatch is rejected ---- */

const store8 = new InMemoryMismatchStore();
const r8 = addMismatch(makeInput(), { store: store8, occurredAtEpochMs: createdAt });

if (r8.status === "added") {
  resolveMismatch(r8.mismatch.id, {
    resolverId: "office-user-1",
    note: null,
    store: store8,
    nowEpochMs: createdAt + 1_000,
  });

  const reResolve = resolveMismatch(r8.mismatch.id, {
    resolverId: "office-user-2",
    note: null,
    store: store8,
    nowEpochMs: createdAt + 2_000,
  });
  expect(reResolve.status === "failed", "resolving a non-open mismatch is rejected");
}

/* ---- scenario 9: checking an overdue mismatch ---- */

const store9 = new InMemoryMismatchStore();
const r9 = addMismatch(makeInput(), { store: store9, occurredAtEpochMs: createdAt });

if (r9.status === "added") {
  const overdue = checkOverdue(r9.mismatch.id, createdAt + MISMATCH_RESOLUTION_DEADLINE_MS, { store: store9 });

  expect(overdue.status === "overdue", "a mismatch past the 3-day deadline is marked overdue");
  if (overdue.status === "overdue") {
    expect(overdue.mismatch.status === "overdue", "the mismatch status is updated to overdue");
  }
}

/* ---- scenario 10: checking a non-overdue mismatch returns ok ---- */

const store10 = new InMemoryMismatchStore();
const r10 = addMismatch(makeInput(), { store: store10, occurredAtEpochMs: createdAt });

if (r10.status === "added") {
  const ok = checkOverdue(r10.mismatch.id, createdAt + 1_000, { store: store10 });
  expect(ok.status === "ok", "a mismatch within the 3-day window is not overdue");
}

/* ---- scenario 11: checking a non-existent mismatch is rejected ---- */

const store11 = new InMemoryMismatchStore();
const noMismatch11 = checkOverdue("nonexistent", createdAt, { store: store11 });
expect(noMismatch11.status === "failed", "checking a non-existent mismatch is rejected");

/* ---- scenario 12: findOpenByCompany returns only open mismatches ---- */

const store12 = new InMemoryMismatchStore();
const r12a = addMismatch(makeInput({ providerTransactionId: "txn-a" }), { store: store12, occurredAtEpochMs: createdAt });
const r12b = addMismatch(makeInput({ providerTransactionId: "txn-b" }), { store: store12, occurredAtEpochMs: createdAt });

if (r12a.status === "added" && r12b.status === "added") {
  resolveMismatch(r12b.mismatch.id, {
    resolverId: "office-user-1",
    note: null,
    store: store12,
    nowEpochMs: createdAt + 1_000,
  });

  expect(store12.findOpenByCompany("company-1").length === 1, "findOpenByCompany returns only open mismatches");
  expect(store12.findOpenByCompany("company-1")[0]?.providerTransactionId === "txn-a", "the open mismatch is the unresolved one");
}

/* ---- scenario 13: findOverdue returns only overdue mismatches ---- */

const store13 = new InMemoryMismatchStore();
const r13a = addMismatch(makeInput({ providerTransactionId: "txn-overdue" }), { store: store13, occurredAtEpochMs: createdAt });
const r13b = addMismatch(makeInput({ providerTransactionId: "txn-ok" }), { store: store13, occurredAtEpochMs: createdAt + 1_000 });

if (r13a.status === "added" && r13b.status === "added") {
  const now = createdAt + MISMATCH_RESOLUTION_DEADLINE_MS;
  checkOverdue(r13a.mismatch.id, now, { store: store13 });
  checkOverdue(r13b.mismatch.id, now - 1_000, { store: store13 });

  expect(store13.findOverdue(now).length === 1, "findOverdue returns only overdue mismatches");
  expect(store13.findOverdue(now)[0]?.providerTransactionId === "txn-overdue", "the overdue mismatch is the one past the deadline");
}

/* ---- scenario 14: multiple mismatches can be added for the same company ---- */

const store14 = new InMemoryMismatchStore();
const r14a = addMismatch(makeInput({ providerTransactionId: "txn-1" }), { store: store14, occurredAtEpochMs: createdAt });
const r14b = addMismatch(makeInput({ providerTransactionId: "txn-2" }), { store: store14, occurredAtEpochMs: createdAt });
const r14c = addMismatch(makeInput({ providerTransactionId: "txn-3" }), { store: store14, occurredAtEpochMs: createdAt });

expect(r14a.status === "added" && r14b.status === "added" && r14c.status === "added", "three mismatches are added for the same company");
expect(store14.findOpenByCompany("company-1").length === 3, "all three are open");

/* ---- scenario 15: two mismatches have different ids ---- */

if (r14a.status === "added" && r14b.status === "added") {
  expect(r14a.mismatch.id !== r14b.mismatch.id, "two mismatches have different ids");
}

/* ---- scenario 16: the mismatch carries the right processor and system amounts ---- */

if (added.status === "added") {
  expect(added.mismatch.processorAmountMinor === 12_000n, "the mismatch carries the processor amount");
  expect(added.mismatch.systemAmountMinor === 10_000n, "the mismatch carries the system amount");
}

/* ---- scenario 17: a processor-only mismatch has null system amount ---- */

const store17 = new InMemoryMismatchStore();
const r17 = addMismatch(makeInput({ type: "processor_only", systemAmountMinor: null }), { store: store17, occurredAtEpochMs: createdAt });
if (r17.status === "added") {
  expect(r17.mismatch.systemAmountMinor === null, "a processor-only mismatch has null system amount");
}

/* ---- scenario 18: a system-only mismatch has the system amount ---- */

const store18 = new InMemoryMismatchStore();
const r18 = addMismatch(makeInput({ type: "system_only", processorAmountMinor: 0n }), { store: store18, occurredAtEpochMs: createdAt });
if (r18.status === "added") {
  expect(r18.mismatch.processorAmountMinor === 0n, "a system-only mismatch has zero processor amount");
  expect(r18.mismatch.systemAmountMinor === 10_000n, "a system-only mismatch carries the system amount");
}

/* ---- the verdict ---- */

if (failures.length > 0) {
  process.stderr.write(`payments reconciliation mismatch gate failed with ${String(failures.length)} problem(s):\n`);
  for (const failure of failures) {
    process.stderr.write(`  - ${failure}\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `payments reconciliation mismatch gate passed: ${checks} checks, a queue that holds mismatches from the reconciliation import and tracks their resolution within the 3-day window - a mismatch starts open with a 3-day deadline, is resolved with the resolver and note, is marked overdue when the deadline passes, and the queue answers open and overdue queries by company and by deadline\n`,
);
