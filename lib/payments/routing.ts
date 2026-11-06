// path: lib/payments/routing.ts

/**
 * The routing rule engine: the rules that decide which provider a payment goes to, and the rejection
 * that answers when no rule matches.
 *
 * ## What routing is
 *
 * Section 6 says "routing rules decide the provider". A payment asks for a capability - a charge, a
 * payout, a connected account - and the routing engine finds the rule that says which provider handles
 * it. A rule is not a guess: it names a provider, and the engine checks that the provider can do the
 * capability the payment asks for, so a rule that points at a provider without the capability is a rule
 * that does not match. The capability comes from the registry (STEP 128), which is the one list of
 * what each provider can do.
 *
 * ## Why the engine rejects when no rule matches
 *
 * Section 6 says "when no routing rule matches, the payment is rejected and is never silently sent to
 * another provider". The rejection is the point. A payment whose rules say nothing about it is a
 * payment the platform has not decided where to send, and sending it anywhere would be a decision made
 * by default rather than by a rule. The engine answers `matched: false` with a reason, and the caller
 * rejects the payment - there is no fallback provider, no "send it to the first one that works".
 *
 * ## The priority
 *
 * When more than one rule matches, the highest priority wins. A rule with priority 200 is evaluated
 * before a rule with priority 100, so a specific rule - one country, one method - can be placed above a
 * general one. The order within a priority is the order the rules are given, which is the order the
 * configured set holds them in.
 *
 * ## What this file is not
 *
 * It is not the rule configuration. The rules are configured by the super admin and held in the
 * database; this file is the engine that reads them and answers a request. `DEFAULT_ROUTING_RULES` is a
 * starting point - one rule per capability, each routing to the first provider in registry order - not
 * the configured set. It is also not the payment creation service (STEP 130): it decides where a payment
 * goes, not how the payment is created, and it does not know whether the provider it names is enabled,
 * because enablement is a fact the database holds and the caller reads.
 */

import { deepFreeze } from "../utils/freeze.ts";
import { PLATFORM_PROVIDERS, type ProviderCapability, type ProviderKey } from "./registry.ts";

/** What a payment asks the routing engine: the capability it needs and the attributes the rules match on. */
export interface RoutingRequest {
  /** The capability the payment needs: a charge, a payout, or a connected account. */
  readonly capability: ProviderCapability;
  /** The payment method, when a rule narrows on one (card, an e-wallet). */
  readonly method?: string;
  /** The country, when a rule narrows on one. Country-level availability follows the platform switch. */
  readonly country?: string;
}

/**
 * A routing rule: the provider a payment is routed to, and the condition it matches.
 *
 * A rule matches a request when the capability matches and every attribute the rule names - method,
 * country - matches too. An attribute the rule does not name is not narrowed on: a rule without a
 * method matches any method, which is what makes a general rule and a specific one coexist.
 */
export interface RoutingRule {
  /** The rule's own identifier, so a decision can say which rule answered. */
  readonly id: string;
  /** The capability this rule routes. */
  readonly capability: ProviderCapability;
  /** The provider a matching payment is routed to. */
  readonly providerKey: ProviderKey;
  /** The payment method this rule narrows on, or undefined to match any method. */
  readonly method?: string;
  /** The country this rule narrows on, or undefined to match any country. */
  readonly country?: string;
  /** The rule's priority. Higher is evaluated first. */
  readonly priority: number;
}

/**
 * The routing decision: the provider a rule routes to, or the rejection when no rule matches.
 *
 * A matched decision carries the provider and the rule that answered, so a payment can be traced to the
 * rule that sent it. An unmatched decision carries a reason - the payment was rejected because no rule
 * matched, and it was not sent anywhere.
 */
export type RoutingDecision =
  | { readonly matched: true; readonly providerKey: ProviderKey; readonly ruleId: string }
  | { readonly matched: false; readonly reason: string };

/**
 * The default routing rules: one per capability, each routing to the first provider in registry order
 * that can do it.
 *
 * This is a starting point, not the configured set. The super admin configures the rules in the
 * database; these are what the engine answers with before that configuration exists, and what the gate
 * exercises the engine against. Each rule points at a provider the registry says can do the capability,
 * so the engine's capability check accepts it.
 */
export const DEFAULT_ROUTING_RULES: readonly RoutingRule[] = deepFreeze([
  { id: "charge-first", capability: "acceptance", providerKey: "nmi", priority: 100 },
  { id: "payout-first", capability: "payouts", providerKey: "payoneer", priority: 100 },
  { id: "submerchant-first", capability: "submerchant", providerKey: "nmi", priority: 100 },
]);

/** True when a provider can do the capability a payment asks for. */
function providerHasCapability(providerKey: ProviderKey, capability: ProviderCapability): boolean {
  const provider = PLATFORM_PROVIDERS.find((entry) => entry.key === providerKey);

  return provider !== undefined && provider.capabilities[capability];
}

/** A rule matches a request when the capability matches and every attribute the rule names does too. */
function ruleMatches(rule: RoutingRule, request: RoutingRequest): boolean {
  return (
    rule.capability === request.capability &&
    (rule.method === undefined || rule.method === request.method) &&
    (rule.country === undefined || rule.country === request.country)
  );
}

/**
 * Route a payment through the rules.
 *
 * The rules are evaluated in priority order - highest first - and the first rule that matches the
 * request and whose target provider can do the capability wins. When no rule matches, the engine
 * answers with a rejection: the payment is not sent to any provider, because section 6 says a payment
 * with no matching rule is rejected and never silently sent elsewhere.
 */
export function routePayment(request: RoutingRequest, rules: readonly RoutingRule[]): RoutingDecision {
  const ordered = [...rules].sort((a, b) => b.priority - a.priority);

  for (const rule of ordered) {
    if (ruleMatches(rule, request) && providerHasCapability(rule.providerKey, request.capability)) {
      return { matched: true, providerKey: rule.providerKey, ruleId: rule.id };
    }
  }

  return { matched: false, reason: "no routing rule matched, so the payment is rejected" };
}
