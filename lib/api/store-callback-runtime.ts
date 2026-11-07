// path: lib/api/store-callback-runtime.ts
import { getAuthRuntime } from "../auth/runtime.ts";
import { openSecret, type SecretBox } from "../auth/secrets.ts";
import { serverEnv } from "../env/server.ts";
import type { StoreCallbackDependencies } from "./store-callbacks.ts";
import { createStoreWebhookTransport } from "./store-webhooks.ts";

/**
 * The production wiring of section 20's store callbacks.
 *
 * Two things a connection's handshake did not need: the ability to **open** a sealed store token, and a **transport**
 * to a shop. The key is read here and nowhere else, and the transport is STEP 205's own - `redirect: "manual"`,
 * `cache: "no-store"`, an abort signal and the response body never read - because a callback and a webhook are the same
 * request to a merchant's server and must not be able to behave differently.
 */
export function getStoreCallbackRuntime(): StoreCallbackDependencies {
  const runtime = getAuthRuntime();
  const masterKey = serverEnv().ENCRYPTION_MASTER_KEY;

  return {
    rest: runtime.rest,
    audit: runtime.audit,
    now: (): number => Date.now(),
    openSecret: (box: SecretBox, context: string): string => openSecret(masterKey, box, context),
    send: createStoreWebhookTransport(),
  };
}
