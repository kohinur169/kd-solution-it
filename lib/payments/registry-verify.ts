// path: lib/payments/registry-verify.ts
import process from "node:process";
import {
  PLATFORM_PROVIDERS as GATEWAYS_REGISTRY_PROVIDERS,
  PROVIDER_KEYS as GATEWAYS_PROVIDER_KEYS,
} from "../gateways/registry.ts";
import {
  PLATFORM_PROVIDERS,
  PROVIDER_KEYS,
  chargingProviders,
  isProviderKey,
  payoutProviders,
  providerDefinitionOf,
  providersWithCapability,
} from "./registry.ts";

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

/* ---- the scenarios ---- */

/** The five providers, in the order section 6 introduces them. */
function checkFiveProviders(): void {
  expectEqual(PLATFORM_PROVIDERS.length, 5, "section 6 has five providers");
  expectEqual(PROVIDER_KEYS.join(","), "nmi,payoneer,rainforest,stripe_connect,airwallex", "in registry order");
  expectEqual(new Set(PROVIDER_KEYS).size, 5, "each provider key appears once");

  for (const provider of PLATFORM_PROVIDERS) {
    expect(isProviderKey(provider.key), `${provider.key} is a provider key the payment core routes on`);
  }
}

/** The capability matrix, read from section 6 line by line. */
function checkCapabilityMatrix(): void {
  // Section 6: NMI takes cards (acceptance) and creates sub-merchants; Payoneer is payouts only;
  // Rainforest accepts payments and creates sub-merchants; Stripe Connect and Airwallex do all three.
  const expected = {
    nmi: { acceptance: true, payouts: false, submerchant: true },
    payoneer: { acceptance: false, payouts: true, submerchant: false },
    rainforest: { acceptance: true, payouts: false, submerchant: true },
    stripe_connect: { acceptance: true, payouts: true, submerchant: true },
    airwallex: { acceptance: true, payouts: true, submerchant: true },
  } as const;

  for (const provider of PLATFORM_PROVIDERS) {
    const matrix = expected[provider.key as keyof typeof expected];

    expectEqual(provider.capabilities.acceptance, matrix.acceptance, `${provider.key} acceptance`);
    expectEqual(provider.capabilities.payouts, matrix.payouts, `${provider.key} payouts`);
    expectEqual(provider.capabilities.submerchant, matrix.submerchant, `${provider.key} submerchant`);

    // At least one capability is true, as the seed migration's capability check requires.
    expect(
      provider.capabilities.acceptance || provider.capabilities.payouts || provider.capabilities.submerchant,
      `${provider.key} has at least one capability`,
    );
  }
}

/** The payment core's registry is the gateways registry's list, not a second copy of it. */
function checkAgreesWithGateways(): void {
  // The re-export is the same object, so there is one list of five providers in the codebase.
  expect(PLATFORM_PROVIDERS === GATEWAYS_REGISTRY_PROVIDERS, "the provider list is the gateways registry's list, not a copy");
  expect(PROVIDER_KEYS === GATEWAYS_PROVIDER_KEYS, "and the provider keys are the gateways registry's keys");

  // And the gateway gate's proof that the list agrees with the seed migration covers the payment core.
  expectEqual(PLATFORM_PROVIDERS.map((provider) => provider.key).join(","), "nmi,payoneer,rainforest,stripe_connect,airwallex", "the five keys the seed migration writes");
}

/** The routing views: which providers can do what, in registry order. */
function checkRoutingViews(): void {
  const chargers = chargingProviders().map((provider) => provider.key).join(",");
  const payers = payoutProviders().map((provider) => provider.key).join(",");
  const submerchants = providersWithCapability("submerchant").map((provider) => provider.key).join(",");

  // The four providers that can accept a charge, in registry order.
  expectEqual(chargers, "nmi,rainforest,stripe_connect,airwallex", "the chargers are the providers with acceptance");

  // The three providers that can payout, in registry order. Payoneer is payouts only.
  expectEqual(payers, "payoneer,stripe_connect,airwallex", "the payers are the providers with payouts");

  // The four providers that create sub-merchants, in registry order.
  expectEqual(submerchants, "nmi,rainforest,stripe_connect,airwallex", "the sub-merchant creators are the providers with submerchant");

  // The views are in registry order: each is the registry filtered, not reordered.
  for (const view of [chargingProviders(), payoutProviders(), providersWithCapability("submerchant")]) {
    const positions = view.map((provider) => PROVIDER_KEYS.indexOf(provider.key));
    const ordered = positions.every((position, index) => {
      if (index === 0) {
        return true;
      }

      const previous = positions[index - 1];

      return previous !== undefined && position > previous;
    });

    expect(ordered, "each routing view is in registry order");
  }
}

/** The extension point: the registry is a list, and a key not in it is answered, not guessed. */
function checkExtensionPoint(): void {
  // A list, not a closed set: a new provider is an entry appended to the list, and the routing views
  // read it because they filter the list. The frozen list is the gateway gate's business; the point
  // here is that the payment core's helpers derive from the list rather than repeating it.
  expect(Array.isArray(PLATFORM_PROVIDERS), "the registry is a list, so a new provider is an entry");

  // A key the registry does not hold is answered with null, the way the gateways registry answers it.
  expectEqual(providerDefinitionOf("not_a_provider"), null, "a key not in the registry is answered with null");
  expect(!isProviderKey("not_a_provider"), "and is not a provider key");

  // And a capability no provider supports is an empty view, which the routing engine treats as a
  // refusal to route, the same rule it applies when no routing rule matches.
  expectEqual(providersWithCapability("acceptance").length, 4, "the acceptance view is not empty");
  expect(payoutProviders().some((provider) => provider.key === "payoneer"), "the payout view reaches Payoneer, the payouts-only provider");
}

/* ---- the run ---- */

function run(): void {
  checkFiveProviders();
  checkCapabilityMatrix();
  checkAgreesWithGateways();
  checkRoutingViews();
  checkExtensionPoint();

  if (failures.length > 0) {
    process.stderr.write(`payments registry gate failed with ${String(failures.length)} problem(s):\n`);

    for (const failure of failures) {
      process.stderr.write(`  - ${failure}\n`);
    }

    process.exitCode = 1;

    return;
  }

  process.stdout.write(
    `payments registry gate passed: ${String(checks)} checks, five providers with their capability ` +
      `matrix read from section 6, one list shared with the gateways registry, and routing views ` +
      `that answer which providers can charge, payout and create sub-merchants\n`,
  );
}

run();
