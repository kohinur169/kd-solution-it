// path: lib/gateways/runtime.ts
import { getAuthRuntime } from "../auth/runtime.ts";
import { openSecret, sealSecret } from "../auth/secrets.ts";
import { serverEnv } from "../env/server.ts";
import { connectionTesterFor } from "./registry.ts";
import type { GatewayDependencies } from "./service.ts";

/**
 * The production wiring of the gateway service: who owns the rows, who signs the audit entries, and
 * where the one encryption key comes from.
 *
 * ## Why this is a separate module and not a factory call in the route
 *
 * The screen, the route and any later job must reach the same dependencies, and each of them spells
 * three things: the PostgREST client the authentication block built, the audit trail that signs
 * `AUDIT_SIGNING_KEY`, and the master key in `ENCRYPTION_MASTER_KEY`. Writing that trio twice is how
 * one of them ends up with a different key or no audit trail at all. It lives here once.
 *
 * ## The key is read lazily and never held
 *
 * `serverEnv()` validates and memoises the environment on first use, so this module imports nothing
 * that touches a secret at module load. The sealer below reads the master key at the moment it seals
 * or opens one value and hands it straight to `lib/auth/secrets.ts`; no copy of it survives the call,
 * it is never placed in a dependency object, and `GatewayDependencies` therefore has nothing worth
 * logging in it.
 *
 * ## Encryption is `lib/auth/secrets.ts`, not a second cipher
 *
 * Section 6 asks for AES-256-GCM with the key in the environment, and the platform already has that
 * cipher, its base64url box and its additional authenticated data: it is the code that seals the
 * Turnstile secret and every TOTP secret. `provider_keys` has a column per part of a box
 * (`key_ciphertext`, `key_iv`, `key_tag`), which is exactly the shape `sealSecret` returns, so this
 * module uses it rather than adding a fourth cipher to the repository. The context binds a box to
 * one provider, one mode and one fingerprint, so a ciphertext copied between rows fails to open.
 */

/**
 * The dependencies the screen and the route use.
 *
 * `now` is required on this type even though the service treats it as optional: the production
 * clock is the same one the service would default to, and stating it here means a server component
 * can read the instant from the dependency it was already given instead of calling the clock itself.
 */
export type GatewayRuntime = GatewayDependencies & { readonly now: () => number };

/** The dependencies the screen and the route use. */
export function getGatewayRuntime(): GatewayRuntime {
  const runtime = getAuthRuntime();

  return {
    store: runtime.rest,
    audit: runtime.audit,
    secrets: {
      seal: (plaintext: string, context: string): ReturnType<typeof sealSecret> =>
        sealSecret(serverEnv().ENCRYPTION_MASTER_KEY, plaintext, context),
      open: (box, context: string): string =>
        openSecret(serverEnv().ENCRYPTION_MASTER_KEY, box, context),
    },
    testerFor: connectionTesterFor,
    now: (): number => Date.now(),
  };
}
