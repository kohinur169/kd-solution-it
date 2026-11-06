// path: lib/payments/creation-verify.ts
import process from "node:process";
import {
  createPayment,
  InMemoryPaymentStore,
  type PaymentCreationResult,
} from "./creation.ts";
import { DEFAULT_ROUTING_RULES } from "./routing.ts";

/* ---- the check book ---- */

let checks = 0;
const failures: string[] = [];

function expect(condition: boolean, description: string): void {
  checks += 1;

  if (!condition) {
    failures.push(description);
  }
}

function expectEqual<T>(actual: T, expected: T, description: string): void {
  checks += 1;

  if (actual !== expected) {
    failures.push(`${description} (expected ${format(expected)}, received ${format(actual)})`);
  }
}

/** A value in a message: bigint prints as digits, everything else as JSON. */
function format(value: unknown): string {
  if (typeof value === "bigint") {
    return value.toString();
  }

  return JSON.stringify(value);
}

/** The result was a new payment. */
function expectCreated(result: PaymentCreationResult): void {
  checks += 1;

  if (result.status !== "created") {
    failures.push(`expected a new payment, received ${result.status} (${result.status === "rejected" ? result.reason : ""})`);
  }
}

/** The result was a refusal, and the reason says what was wrong. */
function expectRejected(result: PaymentCreationResult): void {
  checks += 1;

  if (result.status !== "rejected") {
    failures.push(`expected a refusal, received ${result.status}`);
  }
}

/* ---- the scenarios ---- */

/** A new idempotency key creates a payment, routed to the provider the rules name. */
function checkCreatesNewPayment(): void {
  const store = new InMemoryPaymentStore();
  const result = createPayment(
    { companyId: "c1", amountMinor: 100_000n, capability: "acceptance", idempotencyKey: "key-1" },
    { routingRules: DEFAULT_ROUTING_RULES, store },
  );

  expectCreated(result);
  expect(result.status === "created" && result.payment.providerKey === "nmi", "and it is routed to NMI");
  expect(result.status === "created" && result.payment.amountMinor === 100_000n, "and it carries the amount");
  expect(result.status === "created" && result.payment.companyId === "c1", "and it belongs to the company");
}

/** The same key, the same request, answers with the payment the key already produced. */
function checkDeduplicatesSameKey(): void {
  const store = new InMemoryPaymentStore();
  const first = createPayment(
    { companyId: "c1", amountMinor: 100_000n, capability: "acceptance", idempotencyKey: "key-1" },
    { routingRules: DEFAULT_ROUTING_RULES, store },
  );
  const second = createPayment(
    { companyId: "c1", amountMinor: 100_000n, capability: "acceptance", idempotencyKey: "key-1" },
    { routingRules: DEFAULT_ROUTING_RULES, store },
  );

  expectEqual(first.status, "created", "the first request creates the payment");
  expectEqual(second.status, "deduplicated", "and the repeat answers with the payment it already made");
  expect(
    first.status === "created" && second.status === "deduplicated" && first.payment.id === second.payment.id,
    "and the deduplicated payment is the one the key produced",
  );
}

/** The same key with different details is a mistake, and is refused. */
function checkRefusesConflictingKey(): void {
  const store = new InMemoryPaymentStore();
  createPayment(
    { companyId: "c1", amountMinor: 100_000n, capability: "acceptance", idempotencyKey: "key-1" },
    { routingRules: DEFAULT_ROUTING_RULES, store },
  );
  const conflict = createPayment(
    { companyId: "c1", amountMinor: 200_000n, capability: "acceptance", idempotencyKey: "key-1" },
    { routingRules: DEFAULT_ROUTING_RULES, store },
  );

  expectRejected(conflict);
  expect(
    conflict.status === "rejected" && conflict.reason.includes("different details"),
    "and the reason names the idempotency conflict",
  );
}

/** A payment whose routing rules say nothing about it is rejected, not sent anywhere. */
function checkRejectsOnNoMatch(): void {
  const store = new InMemoryPaymentStore();
  const rejected = createPayment(
    { companyId: "c1", amountMinor: 100_000n, capability: "acceptance", idempotencyKey: "key-1" },
    { routingRules: [], store },
  );

  expectRejected(rejected);
  expect(
    rejected.status === "rejected" && rejected.reason.includes("no routing rule matched"),
    "and the reason names the missing rule",
  );
}

/** The routing decides the provider: a payout goes to the provider the payout rule names. */
function checkRoutesToProvider(): void {
  const store = new InMemoryPaymentStore();
  const payout = createPayment(
    { companyId: "c1", amountMinor: 50_000n, capability: "payouts", idempotencyKey: "key-payout" },
    { routingRules: DEFAULT_ROUTING_RULES, store },
  );

  expectCreated(payout);
  expect(payout.status === "created" && payout.payment.providerKey === "payoneer", "a payout is routed to Payoneer");
}

/** The idempotency key is scoped to the company: the same key in two companies is two payments. */
function checkKeyScopedToCompany(): void {
  const store = new InMemoryPaymentStore();
  const companyA = createPayment(
    { companyId: "cA", amountMinor: 100_000n, capability: "acceptance", idempotencyKey: "shared-key" },
    { routingRules: DEFAULT_ROUTING_RULES, store },
  );
  const companyB = createPayment(
    { companyId: "cB", amountMinor: 100_000n, capability: "acceptance", idempotencyKey: "shared-key" },
    { routingRules: DEFAULT_ROUTING_RULES, store },
  );

  expectEqual(companyA.status, "created", "the key in company A creates a payment");
  expectEqual(companyB.status, "created", "and the same key in company B creates another");
  expect(
    companyA.status === "created" && companyB.status === "created" && companyA.payment.id !== companyB.payment.id,
    "and they are two different payments",
  );
}

/** The balanced proof: no matter how many times a key arrives, one payment exists. */
function checkBalancedOnePaymentPerKey(): void {
  const store = new InMemoryPaymentStore();
  const key = "balanced-key";

  let createdId: string | null = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = createPayment(
      { companyId: "c1", amountMinor: 100_000n, capability: "acceptance", idempotencyKey: key },
      { routingRules: DEFAULT_ROUTING_RULES, store },
    );

    if (result.status === "created") {
      createdId = result.payment.id;
    }

    expectEqual(result.status, attempt === 0 ? "created" : "deduplicated", `attempt ${attempt + 1} is ${attempt === 0 ? "created" : "deduplicated"}`);
  }

  expect(createdId !== null, "the first attempt created the payment");

  // And the key answers with the same payment every time, so the store holds one payment for it.
  const stored = store.findByIdempotencyKey("c1", key);

  expect(stored !== null && stored.id === createdId, "the key answers with the one payment it produced, every time");
}

/** The amount is money: a payment that is not positive is refused before it is routed. */
function checkRejectsNonPositiveAmount(): void {
  const store = new InMemoryPaymentStore();
  const zero = createPayment(
    { companyId: "c1", amountMinor: 0n, capability: "acceptance", idempotencyKey: "key-zero" },
    { routingRules: DEFAULT_ROUTING_RULES, store },
  );
  const negative = createPayment(
    { companyId: "c1", amountMinor: -100n, capability: "acceptance", idempotencyKey: "key-negative" },
    { routingRules: DEFAULT_ROUTING_RULES, store },
  );

  expectRejected(zero);
  expectRejected(negative);
  expect(zero.status === "rejected" && zero.reason.includes("positive"), "and the zero refusal says the amount must be positive");
}

/* ---- the run ---- */

function run(): void {
  checkCreatesNewPayment();
  checkDeduplicatesSameKey();
  checkRefusesConflictingKey();
  checkRejectsOnNoMatch();
  checkRoutesToProvider();
  checkKeyScopedToCompany();
  checkBalancedOnePaymentPerKey();
  checkRejectsNonPositiveAmount();

  if (failures.length > 0) {
    process.stderr.write(`payments creation gate failed with ${String(failures.length)} problem(s):\n`);

    for (const failure of failures) {
      process.stderr.write(`  - ${failure}\n`);
    }

    process.exitCode = 1;

    return;
  }

  process.stdout.write(
    `payments creation gate passed: ${String(checks)} checks, a payment created once per idempotency ` +
      `key - a repeat returns the payment the key produced, a repeat with different details is refused, ` +
      `and a payment with no matching rule is rejected\n`,
  );
}

run();
