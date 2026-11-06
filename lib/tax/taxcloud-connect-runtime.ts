// path: lib/tax/taxcloud-connect-runtime.ts
import { getAuthRuntime } from "../auth/runtime.ts";
import { openSecret, sealSecret } from "../auth/secrets.ts";
import type { SecretBox } from "../auth/secrets.ts";
import { serverEnv } from "../env/server.ts";
import { createTaxCloudRestStore, taxCloudFetchTransport } from "./taxcloud-connect.ts";
import type { TaxCloudConnectOptions } from "./taxcloud-connect.ts";

/**
 * The production wiring of the connect flow: who owns the row, who signs the audit entry, where the key
 * comes from, and which transport decides a ping.
 *
 * The reason this is a module rather than a factory call in a route is the same reason
 * `lib/gateways/runtime.ts` exists: the settings screen, the route and any later job must reach the
 * same four things, and spelling the trio out twice is how one of them ends up with a different key or
 * no audit trail at all.
 *
 * The key is read lazily on every seal and open, so nothing touches a secret at module load, no copy
 * of it survives the call and `TaxCloudConnectOptions` holds nothing worth logging. The store is the
 * platform's own REST client with the service role key, which is what STEP 0073's merchant policies
 * intend: a merchant's session may enter credentials and only the server may mark them verified.
 */
export interface TaxCloudConnectRuntime extends TaxCloudConnectOptions {
  readonly now: () => number;
}

/** The four dependencies, wired once. */
export function getTaxCloudConnectRuntime(): TaxCloudConnectRuntime {
  const runtime = getAuthRuntime();

  return {
    store: createTaxCloudRestStore(runtime.rest),
    sealer: {
      seal: (plaintext: string, context: string): SecretBox =>
        sealSecret(serverEnv().ENCRYPTION_MASTER_KEY, plaintext, context),
      open: (box: SecretBox, context: string): string =>
        openSecret(serverEnv().ENCRYPTION_MASTER_KEY, box, context),
    },
    audit: runtime.audit,
    transport: taxCloudFetchTransport,
    now: (): number => Date.now(),
  };
}
