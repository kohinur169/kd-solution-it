// path: lib/payments/routing-verify.ts
import process from "node:process";
import {
  DEFAULT_ROUTING_RULES,
  routePayment,
  type RoutingDecision,
  type RoutingRule,
} from "./routing.ts";
import type { ProviderKey } from "./registry.ts";

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

/** The decision was a match, to the provider and by the rule named. */
function expectMatched(decision: RoutingDecision, providerKey: ProviderKey, ruleId: string): void {
  checks += 1;

  if (!decision.matched || decision.providerKey !== providerKey || decision.ruleId !== ruleId) {
    failures.push(
      `expected a match to ${providerKey} by ${ruleId}, received ${format(decision)}`,
    );
  }
}

/** The decision was a rejection, not a match to any provider. */
function expectRejected(decision: RoutingDecision): void {
  checks += 1;

  if (decision.matched) {
    failures.push(`expected a rejection, received a match to ${decision.providerKey}`);
  }
}

/* ---- the scenarios ---- */

/** A rule that matches routes the payment to the provider it names. */
function checkRoutesToMatchingRule(): void {
  const chargeNmi: RoutingRule = {
    id: "charge-nmi",
    capability: "acceptance",
    providerKey: "nmi",
    priority: 100,
  };
  const payoutPayoneer: RoutingRule = {
    id: "payout-payoneer",
    capability: "payouts",
    providerKey: "payoneer",
    priority: 100,
  };
  const submerchantNmi: RoutingRule = {
    id: "submerchant-nmi",
    capability: "submerchant",
    providerKey: "nmi",
    priority: 100,
  };

  expectMatched(routePayment({ capability: "acceptance" }, [chargeNmi]), "nmi", "charge-nmi");
  expectMatched(routePayment({ capability: "payouts" }, [payoutPayoneer]), "payoneer", "payout-payoneer");
  expectMatched(routePayment({ capability: "submerchant" }, [submerchantNmi]), "nmi", "submerchant-nmi");
}

/** The reject-on-no-match rule: no matching rule means no provider, and the reason says so. */
function checkRejectsOnNoMatch(): void {
  // No rules at all.
  const empty = routePayment({ capability: "acceptance" }, []);
  expectRejected(empty);
  expect(empty.matched === false && empty.reason.includes("no routing rule matched"), "and the reason names the missing rule");

  // A rule for a different capability.
  const wrongCapability = routePayment(
    { capability: "acceptance" },
    [{ id: "payout-only", capability: "payouts", providerKey: "payoneer", priority: 100 }],
  );
  expectRejected(wrongCapability);

  // A rule that narrows on an attribute the request does not carry.
  const wrongCountry = routePayment(
    { capability: "acceptance", country: "BD" },
    [{ id: "us-only", capability: "acceptance", providerKey: "nmi", country: "US", priority: 100 }],
  );
  expectRejected(wrongCountry);

  // The payment is never silently sent to another provider: an unmatched decision is not a match.
  const neverFallback = routePayment({ capability: "acceptance" }, []);
  expect(neverFallback.matched === false, "an unmatched payment is not sent to any provider");
}

/** The priority: a higher priority rule is evaluated before a lower one. */
function checkRespectsPriority(): void {
  const general: RoutingRule = { id: "general", capability: "acceptance", providerKey: "nmi", priority: 100 };
  const specific: RoutingRule = { id: "specific", capability: "acceptance", providerKey: "rainforest", priority: 200 };

  // The specific rule (priority 200) is evaluated before the general one (priority 100), even though
  // the general rule is given first.
  expectMatched(routePayment({ capability: "acceptance" }, [general, specific]), "rainforest", "specific");

  // And a rule given first with the same priority wins the tie, because the order within a priority is
  // the order the rules are given.
  const first: RoutingRule = { id: "first", capability: "acceptance", providerKey: "nmi", priority: 100 };
  const second: RoutingRule = { id: "second", capability: "acceptance", providerKey: "rainforest", priority: 100 };
  expectMatched(routePayment({ capability: "acceptance" }, [first, second]), "nmi", "first");
}

/** The capability check: a rule to a provider without the capability does not match. */
function checkRespectsCapability(): void {
  // Payoneer has no acceptance, so a rule pointing at it for a charge does not match.
  const chargePayoneer: RoutingRule = {
    id: "charge-payoneer",
    capability: "acceptance",
    providerKey: "payoneer",
    priority: 100,
  };
  expectRejected(routePayment({ capability: "acceptance" }, [chargePayoneer]));

  // The same rule for a payout does match, because Payoneer has payouts.
  const payoutPayoneer: RoutingRule = {
    id: "payout-payoneer",
    capability: "payouts",
    providerKey: "payoneer",
    priority: 100,
  };
  expectMatched(routePayment({ capability: "payouts" }, [payoutPayoneer]), "payoneer", "payout-payoneer");

  // And a rule to a provider that can do the capability is accepted.
  const chargeStripe: RoutingRule = {
    id: "charge-stripe",
    capability: "acceptance",
    providerKey: "stripe_connect",
    priority: 100,
  };
  expectMatched(routePayment({ capability: "acceptance" }, [chargeStripe]), "stripe_connect", "charge-stripe");
}

/** The attributes: a rule narrows on the method and country it names, and matches any it does not. */
function checkRespectsAttributes(): void {
  const cardNmi: RoutingRule = {
    id: "card-nmi",
    capability: "acceptance",
    providerKey: "nmi",
    method: "card",
    priority: 100,
  };

  // The rule matches a card request.
  expectMatched(routePayment({ capability: "acceptance", method: "card" }, [cardNmi]), "nmi", "card-nmi");

  // And rejects a request for another method, because the rule names card.
  expectRejected(routePayment({ capability: "acceptance", method: "wallet" }, [cardNmi]));

  // A rule that names a country matches that country and rejects another.
  const usNmi: RoutingRule = {
    id: "us-nmi",
    capability: "acceptance",
    providerKey: "nmi",
    country: "US",
    priority: 100,
  };
  expectMatched(routePayment({ capability: "acceptance", country: "US" }, [usNmi]), "nmi", "us-nmi");
  expectRejected(routePayment({ capability: "acceptance", country: "BD" }, [usNmi]));

  // A rule that names neither method nor country matches any request of its capability.
  const anyNmi: RoutingRule = { id: "any-nmi", capability: "acceptance", providerKey: "nmi", priority: 100 };
  expectMatched(routePayment({ capability: "acceptance", method: "wallet", country: "BD" }, [anyNmi]), "nmi", "any-nmi");
}

/** The default rules: one per capability, each routing to the first provider in registry order. */
function checkDefaultRules(): void {
  expectEqual(DEFAULT_ROUTING_RULES.length, 3, "the default set has one rule per capability");
  expect(Object.isFrozen(DEFAULT_ROUTING_RULES), "the default set is frozen");

  expectMatched(routePayment({ capability: "acceptance" }, DEFAULT_ROUTING_RULES), "nmi", "charge-first");
  expectMatched(routePayment({ capability: "payouts" }, DEFAULT_ROUTING_RULES), "payoneer", "payout-first");
  expectMatched(routePayment({ capability: "submerchant" }, DEFAULT_ROUTING_RULES), "nmi", "submerchant-first");

  // And a capability the default set has no rule for is rejected, not routed to a default provider.
  expectRejected(routePayment({ capability: "payouts" }, []));
}

/* ---- the run ---- */

function run(): void {
  checkRoutesToMatchingRule();
  checkRejectsOnNoMatch();
  checkRespectsPriority();
  checkRespectsCapability();
  checkRespectsAttributes();
  checkDefaultRules();

  if (failures.length > 0) {
    process.stderr.write(`payments routing gate failed with ${String(failures.length)} problem(s):\n`);

    for (const failure of failures) {
      process.stderr.write(`  - ${failure}\n`);
    }

    process.exitCode = 1;

    return;
  }

  process.stdout.write(
    `payments routing gate passed: ${String(checks)} checks, a rule engine that routes a payment to ` +
      `the provider a matching rule names and checks the provider can do it, and a rejection - never a ` +
      `silent fallback - when no rule matches\n`,
  );
}

run();
