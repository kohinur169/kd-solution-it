// path: lib/api/shopify-connection-runtime.ts
import { getAuthRuntime } from "../auth/runtime.ts";
import { sealSecret, type SecretBox } from "../auth/secrets.ts";
import { serverEnv } from "../env/server.ts";
import type { ShopifyConnectionDependencies } from "./shopify-connections.ts";

/**
 * The production wiring of section 20's Shopify connection.
 *
 * The same projection `store-connection-runtime.ts` makes for the WooCommerce plugin - one factory over one validated
 * environment - with the one thing a connection needs that authentication does not: the ability to seal the access
 * token Shopify minted. The key is read here and nowhere else, so a module that stores a shop's token cannot also hold
 * the plaintext after it has sealed one.
 *
 * There is no transport here on purpose: STEP 210 is the handshake, and the calls the platform makes *to* Shopify with
 * this token are STEP 211's.
 */
export function getShopifyConnectionRuntime(): ShopifyConnectionDependencies {
  const runtime = getAuthRuntime();
  const masterKey = serverEnv().ENCRYPTION_MASTER_KEY;

  return {
    rest: runtime.rest,
    audit: runtime.audit,
    now: (): number => Date.now(),
    seal: (plaintext: string, context: string): SecretBox => sealSecret(masterKey, plaintext, context),
  };
}
