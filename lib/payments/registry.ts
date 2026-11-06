// path: lib/payments/registry.ts

/**
 * The payment core's registry of the five providers and what each one can do.
 *
 * ## Why this file exists when the five providers are already declared in `lib/gateways/registry.ts`
 *
 * The five providers, their keys and their capability matrix are declared once, in the gateways
 * registry, because the gateway configuration system - the super admin gateway page, the connection
 * test, the stored keys - was built first and owns the fact "these are the five providers and what
 * they can do". This file is the payment core's entry to that fact. The routing engine (STEP 129),
 * the adapters (147-169) and the ledger and settlement (131-146) import the registry from here, not
 * from the gateways directory, so the payment core's dependency on the registry is one file it owns
 * and the gateways system's dependency is one file it owns.
 *
 * ## Why this file is not a second copy of the five providers
 *
 * It imports the definitions from the gateways registry rather than repeating them. There is one list
 * of five providers in the codebase, and the gateway gate already proves that list agrees with the
 * seed migration (`0094_seed_payment_providers.sql`) key by key and boolean by boolean. A second copy
 * here would drift from that list, and a payment routed to a provider the gateways panel cannot
 * configure would be a payment that can never be enabled - the failure the gateway gate exists to
 * prevent, reached through a different door.
 *
 * ## What this file adds
 *
 * The gateways registry answers "what is this provider and what can it do" for a key the panel holds.
 * The payment core asks a different question: "which providers can do this capability". The routing
 * engine needs the providers that can accept a charge; the settlement engine needs the providers that
 * can payout; the adapter STEPs need the capability matrix to know what their provider was built for.
 * `providersWithCapability` and its two named views answer those questions, and they read the
 * capability vocabulary the gateways registry already owns.
 *
 * ## What this file is not
 *
 * It is not the gateway configuration system. It does not store keys, test connections, or know which
 * role may open the panel. Those are the gateways registry's business, and they are why that registry
 * holds the keys, the modes and the connection-test seam. This file holds the fact the payment core
 * routes on: the providers and their capabilities.
 */

import {
  PLATFORM_PROVIDERS,
  PROVIDER_KEYS,
  isProviderKey,
  providerDefinitionOf,
  type ProviderCapabilities,
  type ProviderDefinition,
  type ProviderKey,
} from "../gateways/registry.ts";

/**
 * The payment core's view of the five providers, re-exported from the gateways registry.
 *
 * The payment core reads the registry through these names, so a later STEP that changes the payment
 * core's relationship to the registry changes one file it owns.
 */
export {
  PLATFORM_PROVIDERS,
  PROVIDER_KEYS,
  isProviderKey,
  providerDefinitionOf,
};

export type { ProviderCapabilities, ProviderDefinition, ProviderKey };

/**
 * The capability the payment core asks the registry about.
 *
 * The vocabulary is the gateways registry's own: `acceptance` is the provider's ability to accept a
 * charge, `payouts` is its ability to make a payout, and `submerchant` is its ability to create a
 * connected or sub-merchant account. A capability the payment core needs that the gateways registry
 * does not name is a change to that registry, not a new name here.
 */
export type ProviderCapability = "acceptance" | "payouts" | "submerchant";

/**
 * The providers that can do a capability, in registry order.
 *
 * An empty answer is a real answer, not a failure: a capability no provider supports is a capability
 * the routing engine must refuse to route to. That is the same rule the routing engine applies when no
 * routing rule matches - a payment is never silently sent to a provider that cannot do what it asks.
 */
export function providersWithCapability(capability: ProviderCapability): readonly ProviderDefinition[] {
  return PLATFORM_PROVIDERS.filter((provider) => provider.capabilities[capability]);
}

/**
 * The providers that can accept a charge, in registry order.
 *
 * The routing engine's default question: a payment that needs a charge is routed to a provider that
 * can accept one, and this is the list it routes to. The order is the registry's order, which is the
 * order the panel shows and the seed writes.
 */
export function chargingProviders(): readonly ProviderDefinition[] {
  return providersWithCapability("acceptance");
}

/**
 * The providers that can payout, in registry order.
 *
 * The settlement engine's question: a payout is routed to a provider that can make one, and this is
 * the list it routes to. Payoneer is payouts only, so it is the one provider a payout can be routed to
 * that cannot also accept the charge that funded it.
 */
export function payoutProviders(): readonly ProviderDefinition[] {
  return providersWithCapability("payouts");
}
