// path: lib/gateways/registry.ts
import type { PlatformRole } from "../auth/types.ts";
import { deepFreeze } from "../utils/freeze.ts";

/**
 * The adapter registry of section 6: the five providers, their capability matrix, and the seam a
 * later adapter plugs its connection test into.
 *
 * ## Why the catalogue is in code and the rows are in the database
 *
 * Section 6 asks for two things that look like one: "one registry file listing all five with a
 * capability matrix", and "a provider without an adapter in code cannot be added from the
 * dashboard". Both are statements about *this build*, not about a row somebody edited, so the five
 * keys, their display names, their capability matrix and their order on the panel are written here.
 * `migrations/0094_seed_payment_providers.sql` seeds the same five values into
 * `public.payment_providers`, because a provider carries state (enabled or not, when it was last
 * tested, which keys it holds) that only a row can hold, and the gateway gate proves the two lists
 * agree: the migration's `values` clause is compared to this file, key by key and boolean by boolean.
 *
 * The registry is therefore the authority on *what can exist*, and the table is the authority on
 * *what is*. A row whose key is not in this file is shown as having no adapter and cannot be
 * enabled, which is the rule section 6 states rather than a defensive branch nobody can reach.
 *
 * ## The seam
 *
 * A connection test is provider specific and arrives with that provider's adapter STEP (147-169).
 * `ADAPTER_CONNECTION_TESTS` is the one place such a STEP registers it: adding an entry there is the
 * whole change, because the service below asks its dependencies for the tester and knows nothing
 * else about any provider. Until then the registry answers with no tester, and a test records the
 * honest failure "no adapter is installed" - which is also why nothing can be enabled today: an
 * enable refuses without a passing test, and no test can pass without an adapter.
 */

/** The five provider keys, in the order `0029` lists them and section 6 introduces them. */
export type ProviderKey = "nmi" | "payoneer" | "rainforest" | "stripe_connect" | "airwallex";

/** What one provider can be used for. At least one of the three is true, as `0029` requires. */
export interface ProviderCapabilities {
  readonly acceptance: boolean;
  readonly payouts: boolean;
  readonly submerchant: boolean;
}

/** One entry of the registry: its key, the name the panel shows, its place, and what it can do. */
export interface ProviderDefinition {
  readonly key: ProviderKey;
  readonly displayName: string;
  readonly displayOrder: number;
  readonly capabilities: ProviderCapabilities;
}

/**
 * The five of section 6, with the capability matrix read from that section line by line.
 *
 * NMI takes cards and creates sub-merchants; Payoneer is payouts only; Rainforest accepts payments
 * and creates sub-merchants; Stripe Connect and Airwallex do all three. A provider with every
 * capability false would be refused by `payment_providers_capability_check`, so the matrix is not
 * merely descriptive - it is the same fact the table holds.
 */
export const PLATFORM_PROVIDERS: readonly ProviderDefinition[] = deepFreeze([
  {
    key: "nmi",
    displayName: "NMI",
    displayOrder: 1,
    capabilities: { acceptance: true, payouts: false, submerchant: true },
  },
  {
    key: "payoneer",
    displayName: "Payoneer",
    displayOrder: 2,
    capabilities: { acceptance: false, payouts: true, submerchant: false },
  },
  {
    key: "rainforest",
    displayName: "Rainforest",
    displayOrder: 3,
    capabilities: { acceptance: true, payouts: false, submerchant: true },
  },
  {
    key: "stripe_connect",
    displayName: "Stripe Connect",
    displayOrder: 4,
    capabilities: { acceptance: true, payouts: true, submerchant: true },
  },
  {
    key: "airwallex",
    displayName: "Airwallex",
    displayOrder: 5,
    capabilities: { acceptance: true, payouts: true, submerchant: true },
  },
]);

/** The five keys in registry order, which is the order the panel shows and the seed writes. */
export const PROVIDER_KEYS: readonly ProviderKey[] = deepFreeze(
  PLATFORM_PROVIDERS.map((provider) => provider.key),
);

const providerKeySet: ReadonlySet<string> = new Set<string>(PROVIDER_KEYS);

/** True when a value is one of the five keys this build has an adapter entry for. */
export function isProviderKey(value: unknown): value is ProviderKey {
  return typeof value === "string" && providerKeySet.has(value);
}

/**
 * The registry entry for a key, or null when this build has none.
 *
 * Null is a real answer, not a failure: a database restored from a later deployment can hold a row
 * this build cannot drive, and the panel says so instead of pretending the provider works.
 */
export function providerDefinitionOf(key: string): ProviderDefinition | null {
  return PLATFORM_PROVIDERS.find((provider) => provider.key === key) ?? null;
}

/**
 * The roles that may open section 6's gateway page.
 *
 * The page is `super_admin` only, which is also the policy `0074` writes on
 * `public.payment_providers` (`payment_providers_super_admin_all`): the role that can read the
 * catalogue in the database is the role the screen offers it to. The navigation imports this
 * constant rather than repeating the list, so the sidebar and the service cannot disagree.
 */
export const GATEWAY_MANAGEMENT_ROLES: readonly PlatformRole[] = deepFreeze([
  "super_admin",
] as const satisfies readonly PlatformRole[]);

/**
 * The roles that may open the office home.
 *
 * Today the home carries the gateway readiness summary of section 6, so it is the same role. It is a
 * separate constant because the two facts are separate: when STEP 070 adds the approval queues the
 * home's role list changes and the gateway page's does not.
 */
export const OFFICE_DASHBOARD_ROLES: readonly PlatformRole[] = deepFreeze([
  "super_admin",
] as const satisfies readonly PlatformRole[]);

/**
 * The two modes a stored key can be in.
 *
 * Section 8 keeps sandbox and live apart, and `provider_keys_mode_check` closes the vocabulary.
 * `provider_keys_active_key` allows one active key per provider *and* mode, so a provider may hold a
 * sandbox key and a live key at the same time and can never hold two of either.
 */
export type GatewayKeyMode = "test" | "live";

export const GATEWAY_KEY_MODES: readonly GatewayKeyMode[] = deepFreeze(["test", "live"]);

const gatewayKeyModeSet: ReadonlySet<string> = new Set<string>(GATEWAY_KEY_MODES);

/** True when a value is `test` or `live`. */
export function isGatewayKeyMode(value: unknown): value is GatewayKeyMode {
  return typeof value === "string" && gatewayKeyModeSet.has(value);
}

/** What the super admin calls a key on the panel. `provider_keys_label_check` allows 1 to 80. */
export const GATEWAY_LABEL_MAXIMUM_LENGTH = 80;

/**
 * The shortest secret this module accepts, and why twelve.
 *
 * `provider_keys_ciphertext_check` refuses a ciphertext shorter than 16 characters, and base64url
 * of 12 bytes is exactly 16; a shorter secret could not be stored, so it is refused before it is
 * sealed rather than after, with a message that says what to do. Twelve is also below every
 * provider's own minimum key length, so no real key is turned away by this floor.
 */
export const GATEWAY_SECRET_MINIMUM_LENGTH = 12;

/** The longest secret, which is generous and still bounds the request body. */
export const GATEWAY_SECRET_MAXIMUM_LENGTH = 512;

/** What a failed test may say. `provider_keys_test_detail_check` allows 1 to 280. */
export const GATEWAY_TEST_DETAIL_MAXIMUM_LENGTH = 280;

/**
 * The sentence a test records when this build has no adapter for the provider.
 *
 * It is stored, so it is code owned English like every other persisted detail, and it is short
 * enough for the 280 character column by construction.
 */
export const NO_ADAPTER_TEST_DETAIL =
  "No adapter is installed for this provider, so its connection cannot be tested.";

/** What one connection test is given: the key it drives, in the mode it was stored for. */
export interface ConnectionTestInput {
  readonly providerKey: ProviderKey;
  readonly mode: GatewayKeyMode;
  /** The decrypted key, held in memory for the length of one call and never returned. */
  readonly secret: string;
  /** The instant the test starts, so a fake in the gate can be deterministic. */
  readonly now: number;
}

/** What one connection test answers. A failure always carries a reason worth recording. */
export type ConnectionTestOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly detail: string };

/** One provider's connection test. Asynchronous, because every real one is a network call. */
export type ConnectionTester = (
  input: ConnectionTestInput,
) => Promise<ConnectionTestOutcome>;

/**
 * The tests this build can run, keyed by provider.
 *
 * Empty until the adapter STEPs of 147-169 land. Each of them adds one line here and nothing else:
 * the gateway service never imports a provider module, so a provider becomes testable without
 * touching the service, the route or the screen. That is what "a new adapter added to the registry
 * becomes available in the super admin panel" means in code.
 */
export const ADAPTER_CONNECTION_TESTS: Readonly<Partial<Record<ProviderKey, ConnectionTester>>> =
  deepFreeze({});

/** The tester for one provider, or null when this build has no adapter for it. */
export function connectionTesterFor(key: string): ConnectionTester | null {
  if (!isProviderKey(key)) {
    return null;
  }

  return ADAPTER_CONNECTION_TESTS[key] ?? null;
}

/** True when this build can test, and therefore enable, the provider. */
export function hasConnectionTest(key: string): boolean {
  return connectionTesterFor(key) !== null;
}
