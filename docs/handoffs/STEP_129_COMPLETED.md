# STEP 129 — Routing rule engine with reject on no match

Branch `arena/17762737-kd-solution-it`.
Previous handoff: `docs/handoffs/STEP_128_COMPLETED.md`.

## What this STEP is, in one paragraph

The routing rule engine: the rules that decide which provider a payment goes to, and the rejection that
answers when no rule matches. A payment asks for a capability - a charge, a payout, a connected account -
and the engine finds the rule that says which provider handles it. A rule is not a guess: it names a
provider, and the engine checks that the provider can do the capability the payment asks for, so a rule
that points at a provider without the capability is a rule that does not match. The capability comes from
the registry (STEP 128), which is the one list of what each provider can do. When no rule matches, the
engine answers with a rejection - the payment is not sent to any provider, because section 6 says a
payment with no matching rule is rejected and never silently sent to another provider. There is no
fallback provider, no "send it to the first one that works".

## What it is not

- **It is not the rule configuration.** The rules are configured by the super admin and held in the
  database. `DEFAULT_ROUTING_RULES` is a starting point - one rule per capability, each routing to the
  first provider in registry order - not the configured set. This file is the engine that reads the
  rules and answers a request.
- **It is not the payment creation service.** It decides where a payment goes, not how the payment is
  created. The payment creation service (STEP 130) calls `routePayment` and acts on the decision.
- **It does not know whether a provider is enabled.** Enablement is a fact the database holds (a
  provider cannot be enabled when its connection test fails). The engine routes on rules and
  capabilities; the caller reads enablement and refuses a route to a provider that is off.
- **It does not touch money.** It routes a payment to a provider; it does not do money arithmetic (STEP
  127 owns that) and it does not post ledger entries (a later STEP owns that). The double-entry proof
  rule applies to STEPs that move money; this STEP moves a decision, not a value.
- **It does not call a provider.** It is a rule engine, not an adapter. The sandbox cycle rule applies
  to the adapter STEPs (147-169), which drive the providers' APIs.
- **It does not need a migration.** The engine is a code file. The routing rules are configured by the
  super admin; where they are stored is a configuration STEP's decision, not this one's. Sub-step 3 was
  "if any", and it was not.

## Sub-steps, as executed

| # | Sub-step | Deliverable | Gate |
|---|---|---|---|
| 1 | Read FEATURE_LIST §6, MASTER_PROMPT rules, STEP 128 handoff | — | — |
| 2 | Confirm owned paths | `lib/payments/routing.ts` - STEP 129 owns it | — |
| 3 | Database part | **none needed** - the engine is a code file | migrations **3495 checks, 120 migrations** (unchanged) |
| 4 | Core service and logic | `lib/payments/routing.ts`: the routing rule engine with reject on no match | payments-routing gate |
| 5 | API route | **none** - a library, not an endpoint | — |
| 6 | UI | **none** - a library, not a screen | build 0 (156 routes) |
| 7 | Security | the engine is a static decision (no RLS, no audit - it is not a mutation); it does not touch money or call a provider | gate + auth gate |
| 8 | typecheck, lint, build, commit, push, handoff | tsc 0, eslint 0, build 0 | `npm run verify` exit 0 |

## The rules, where each one lives

- **The request** - a `RoutingRequest` carries the capability the payment needs and the attributes the
  rules match on: an optional method (card, an e-wallet) and an optional country. Country-level
  availability follows the platform country switch (section 6).
- **The rule** - a `RoutingRule` names a provider, the capability it routes, and the attributes it
  narrows on. A rule matches a request when the capability matches and every attribute the rule names
  matches too. An attribute the rule does not name is not narrowed on: a rule without a method matches
  any method, which is what lets a general rule and a specific one coexist.
- **The priority** - when more than one rule matches, the highest priority wins. A rule with priority
  200 is evaluated before a rule with priority 100, so a specific rule - one country, one method - can
  be placed above a general one. The order within a priority is the order the rules are given.
- **The capability check** - the engine does not trust the rule's providerKey; it checks the registry
  that the provider can do the capability the payment asks for. A rule that points at a provider without
  the capability is a rule that does not match.
- **The rejection** - when no rule matches, the engine answers `matched: false` with a reason. The
  payment is not sent to any provider. This is the rule section 6 states: a payment with no matching
  rule is rejected and never silently sent to another provider.
- **The default rules** - `DEFAULT_ROUTING_RULES` is one rule per capability, each routing to the first
  provider in registry order that can do it: charge to NMI, payout to Payoneer, submerchant to NMI.

## Verification

| Gate | Result |
|---|---|
| payments-routing (`lib/payments/routing-verify.ts`) | **24 checks PASSING** - routes to a matching rule, rejects on no match, respects priority, capability and attributes, and the default rules |
| payments-registry (STEP 128) | 42 checks PASSING (unchanged) |
| payments-money (STEP 127) | 66 checks PASSING (unchanged) |
| `npm run typecheck` | 0 errors |
| `npm run lint` (eslint) | 0 errors |
| `npm run build` | 0 errors, 156 routes |
| `npm run verify` | exit 0 |
| auth gate | 2811 checks PASSING (unchanged) |
| migrations gate | 3495 checks, 120 migrations (unchanged) |

## The reject-on-no-match proof, as recorded

The STEP title names the behaviour, and the gate proves it four ways:

1. **No rules at all.** `routePayment({ capability: "acceptance" }, [])` answers `matched: false`. An
   empty rule set is not a default route to the first provider.
2. **A rule for a different capability.** A payout rule does not answer a charge request.
3. **A rule that narrows on an attribute the request does not carry.** A US-only rule does not answer a
   BD request.
4. **A rule to a provider without the capability.** A rule pointing at Payoneer for a charge does not
   match, because the registry says Payoneer has no acceptance.

In every case the decision is `matched: false` with a reason that names the missing rule, and the
payment is not sent to any provider. The same proof carries into STEP 130: the payment creation service
calls `routePayment` and rejects the payment when the decision is unmatched.

## Package request

None. The routing engine is a plain TypeScript module with no dependencies beyond the registry (STEP
128) and `deepFreeze`.

## What is next

STEP 130 - "Payment creation service with idempotency key handling" - owns the payment creation service,
which calls this routing engine to decide where a payment goes, and rejects the payment when no rule
matches. The engine this STEP built is the decision STEP 130 acts on.
