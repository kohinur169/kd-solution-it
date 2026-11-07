// path: services/disputes/dispute-runtime.ts
import { getAuthRuntime } from "../../lib/auth/runtime.ts";
import type { DisputeDependencies } from "./dispute.ts";
import type { DisputeWebhookDependencies } from "./dispute-webhook.ts";

/**
 * The production wiring of section 19's disputes: the PostgREST client, the signed audit trail, the settings
 * reader the webhook opens its signing secret from, and a clock.
 *
 * ## Why this is a module and not three lines in each caller
 *
 * Four callers reach the dispute service - the merchant's list route and screen, the office queue's route and
 * screen - and one reaches the receiver. Five copies of a dependency object is how one of them ends up
 * reading rows without a chain entry or verifying a delivery against a secret nobody configured.
 * `getAuthRuntime()` already validates the environment, builds the service role client, the Ed25519 signing
 * trail and the settings reader that holds the platform's secrets, so this module is a projection of it
 * rather than a second factory.
 *
 * ## What is deliberately absent
 *
 * No provider client and no key ring. A dispute moves no money in this STEP: it is a row a processor
 * reported and the platform tracked. The evidence pack (STEP 198) and the chargeback fee (section 18's own
 * STEP) will add their dependencies here rather than to a second runtime.
 */

/** The dependencies the four reading callers use. */
export type DisputeRuntime = DisputeDependencies & { readonly now: () => number };

/** The dependencies the webhook route uses: the same, plus the settings reader that holds the secret. */
export type DisputeWebhookRuntime = DisputeWebhookDependencies;

export function getDisputeRuntime(): DisputeRuntime {
  const runtime = getAuthRuntime();

  return {
    rest: runtime.rest,
    audit: runtime.audit,
    now: (): number => Date.now(),
  };
}

/**
 * The webhook's wiring.
 *
 * `settings` is `getAuthRuntime().settings`, the same reader the sign-in screen takes its Turnstile secret
 * from: a signing secret is a platform secret, not a merchant key, and `provider_keys` holds merchants' keys
 * with no read path at all. So the endpoint's secret lives where every other platform secret lives, is
 * opened with the master key, and is never returned to a caller.
 */
export function getDisputeWebhookRuntime(): DisputeWebhookRuntime {
  const runtime = getAuthRuntime();

  return {
    rest: runtime.rest,
    audit: runtime.audit,
    settings: runtime.settings,
    now: (): number => Date.now(),
  };
}
