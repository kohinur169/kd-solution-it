// path: lib/api/store-connection-runtime.ts
import { getAuthRuntime } from "../auth/runtime.ts";
import { sealSecret, type SecretBox } from "../auth/secrets.ts";
import { serverEnv } from "../env/server.ts";
import type { StoreConnectionDependencies } from "./store-connections.ts";

/**
 * The production wiring of section 20's store connections.
 *
 * The same projection `credential-runtime.ts` and `public-runtime.ts` make - one factory over one validated environment
 * - with the one thing a connection needs that authentication does not: the ability to seal the store's token. The key
 * is read here and nowhere else, so a module that stores a store token cannot also hold the plaintext after it has
 * sealed one.
 *
 * There is no transport and no reader here on purpose: STEP 208 is the handshake, and the calls the platform makes *to*
 * a store are STEP 209's.
 */
export function getStoreConnectionRuntime(): StoreConnectionDependencies {
  const runtime = getAuthRuntime();
  const masterKey = serverEnv().ENCRYPTION_MASTER_KEY;

  return {
    rest: runtime.rest,
    audit: runtime.audit,
    now: (): number => Date.now(),
    seal: (plaintext: string, context: string): SecretBox => sealSecret(masterKey, plaintext, context),
  };
}
