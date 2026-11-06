# STEP 128 — Provider registry with capability matrix for five providers

Branch `arena/17762737-kd-solution-it`.
Previous handoff: `docs/handoffs/STEP_127_COMPLETED.md`.

## What this STEP is, in one paragraph

The payment core's registry of the five payment processors and what each one can do: NMI, Payoneer,
Rainforest, Stripe Connect and Airwallex, with the capability matrix section 6 states line by line
(NMI takes cards and creates sub-merchants; Payoneer is payouts only; Rainforest accepts payments and
creates sub-merchants; Stripe Connect and Airwallex do all three). The registry is the fact the
routing engine (STEP 129) routes on, the fact the adapters (147-169) are built against, and the fact
the ledger and settlement (131-146) ask "which providers can payout". It lives in
`lib/payments/registry.ts`, the payment core's own file, and it answers the payment core's question -
"which providers can do this capability" - through `providersWithCapability`, `chargingProviders` and
`payoutProviders`, in registry order.

## What it is not

- **It is not a second copy of the five providers.** The five providers, their keys and their capability
  matrix are declared once, in `lib/gateways/registry.ts`, because the gateway configuration system
  (the super admin gateway page, the connection test, the stored keys) was built first and owns the
  fact "these are the five providers". This file imports that list rather than repeating it, so there
  is one list of five providers in the codebase and the gateway gate's proof that it agrees with the
  seed migration (`0094_seed_payment_providers.sql`) covers the payment core too. A second copy here
  would drift, and a payment routed to a provider the gateways panel cannot configure would be a
  payment that can never be enabled.
- **It is not the gateway configuration system.** It does not store keys, test connections, or know
  which role may open the panel. Those are `lib/gateways/registry.ts`'s business, and they are why
  that registry holds the key modes, the secret bounds and the connection-test seam. This file holds
  the fact the payment core routes on: the providers and their capabilities.
- **It is not the routing engine.** It answers "which providers can do this"; it does not decide which
  one a payment goes to. That is STEP 129's job, and it reads this registry to ask the question.
- **It does not need a migration.** The registry is a code file, not a schema change. The
  `payment_providers` table already exists (`0094`), and the gateway gate already proves the gateways
  registry agrees with it key by key and boolean by boolean. Sub-step 3 was "if any", and it was not.
- **It does not need a sandbox cycle.** It is a static declaration of what each provider can do, not a
  call to any provider's API. The master prompt's sandbox cycle rule (payment, refund, webhook) is
  about STEPs that drive a provider's API, which are the adapter STEPs (147-169). This STEP declares
  the providers; the adapters will call them.

## Sub-steps, as executed

| # | Sub-step | Deliverable | Gate |
|---|---|---|---|
| 1 | Read FEATURE_LIST §6, MASTER_PROMPT provider rules, STEP 127 handoff | — | — |
| 2 | Confirm owned paths | `lib/payments/registry.ts` - STEP 128 owns it, shared with later payment core STEPs | — |
| 3 | Database part | **none needed** - `payment_providers` exists (`0094`); the registry is a code file | migrations **3495 checks, 120 migrations** (unchanged) |
| 4 | Core service and logic | `lib/payments/registry.ts`: the five providers, the capability matrix, the routing views | payments-registry gate |
| 5 | API route | **none** - a library, not an endpoint | — |
| 6 | UI | **none** - a library, not a screen | build 0 (156 routes) |
| 7 | Security | the registry is a static declaration (no RLS, no audit - it is not a mutation); the gateway gate proves it agrees with the seed migration | gateway **467 checks** (unchanged) |
| 8 | typecheck, lint, build, commit, push, handoff | tsc 0, eslint 0, build 0 | `npm run verify` exit 0 |

## The rules, where each one lives

- **The five providers** - NMI, Payoneer, Rainforest, Stripe Connect, Airwallex, in the order section 6
  introduces them. The keys are `nmi`, `payoneer`, `rainforest`, `stripe_connect`, `airwallex`.
- **The capability matrix** - read from section 6 line by line. NMI: acceptance and submerchant.
  Payoneer: payouts only. Rainforest: acceptance and submerchant. Stripe Connect and Airwallex: all
  three. At least one capability is true for every provider, as the seed migration's capability check
  requires.
- **One list, no duplication** - `lib/payments/registry.ts` imports `PLATFORM_PROVIDERS`,
  `PROVIDER_KEYS`, `isProviderKey` and `providerDefinitionOf` from `lib/gateways/registry.ts` and
  re-exports them. The gate proves the re-export is the same object (`===`), so there is one list.
- **The routing views** - `providersWithCapability(capability)` filters the list by a capability;
  `chargingProviders()` is the providers with `acceptance` (NMI, Rainforest, Stripe Connect,
  Airwallex); `payoutProviders()` is the providers with `payouts` (Payoneer, Stripe Connect,
  Airwallex). Each view is in registry order, which is the order the panel shows and the seed writes.
- **The extension point** - the registry is a list, so a new provider is an entry appended to it, and
  the routing views read it because they filter the list. A key the registry does not hold is answered
  with null (`providerDefinitionOf`), and a capability no provider supports is an empty view, which the
  routing engine treats as a refusal to route - the same rule it applies when no routing rule matches.

## Verification

| Gate | Result |
|---|---|
| payments-registry (`lib/payments/registry-verify.ts`) | **42 checks PASSING** - five providers, capability matrix, agreement with the gateways registry, routing views, extension point |
| payments-money (STEP 127) | 66 checks PASSING (unchanged) |
| gateway gate (`lib/gateways/verify.ts`) | 467 checks PASSING (unchanged) |
| `npm run typecheck` | 0 errors |
| `npm run lint` (eslint) | 0 errors |
| `npm run build` | 0 errors, 156 routes |
| `npm run verify` | exit 0 |
| auth gate | 2811 checks PASSING (unchanged) |
| KYC gate | 4142 checks PASSING (unchanged) |
| migrations gate | 3495 checks, 120 migrations (unchanged) |

## The provider rules, and what they mean for this STEP

The master prompt has two rules about providers, and both name the adapter STEPs, not this one:

- **The sandbox cycle rule** - "Every STEP that touches a provider must complete a sandbox cycle
  (payment, refund where supported, and webhook delivery)". This STEP declares the providers; it does
  not drive any provider's API. The sandbox cycle is the adapter STEPs' (147-169) job, and they will
  record the provider documentation URLs, the sandbox URLs and the sandbox result in their own
  handoffs.
- **The Provider Documentation Rule** - "Before coding a payment or verification adapter, fetch and
  read the provider's latest official documentation and sandbox or testing pages from the provider's
  own website in that session and record the verified URLs." This STEP's capability matrix is read
  from FEATURE_LIST §6, which states each provider's capabilities. The adapter STEPs must verify
  against the provider's own documentation before coding.

One constraint the adapter STEPs will face: the sandbox's outbound internet access is limited to
`github.com`, `registry.npmjs.org`, `pypi.org` and `files.pythonhosted.org`, so the provider websites
(`nmi.com`, `payoneer.com`, `rainforestpay.com`, `stripe.com`, `airwallex.com`) cannot be reached
from this environment. The integrator must supply the provider documentation, or the adapter STEPs
must be run in an environment with access to the provider sites.

## Package request

None. The registry is a plain TypeScript module with no dependencies beyond what the platform already
carries.

## What is next

STEP 129 - "Routing rule engine with reject on no match" - owns the routing engine and reads this
registry to decide which provider a payment goes to. When no routing rule matches, the payment is
rejected and is never silently sent to another provider. The registry this STEP built is the fact the
routing engine asks its questions against.
