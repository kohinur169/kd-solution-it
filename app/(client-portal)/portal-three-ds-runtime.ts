// path: app/(client-portal)/portal-three-ds-runtime.ts
import { getAuthRuntime } from "../../lib/auth/runtime.ts";
import { openSecret, packSecretBox, sealSecret, unpackSecretBox } from "../../lib/auth/secrets.ts";
import { getPortalBillingMatchRuntime } from "./portal-billing-match-runtime.ts";
import { getPortalPaymentRuntime } from "./portal-payment-runtime.ts";
import type { PortalThreeDsDependencies, PortalThreeDsSecrets } from "./portal-three-ds.ts";
import {
  createInMemoryPortalThreeDsRecorder,
  noPortalThreeDsPort,
} from "./portal-three-ds-processor.ts";

/**
 * The production wiring of the 3D Secure step, and the two things it cannot do yet.
 *
 * ## What is real
 *
 * The cipher is. A handle is sealed with the deployment's own master key through `lib/auth/secrets.ts` - the
 * AES-256-GCM box that already protects the Turnstile secret and every TOTP secret - and packed into one
 * string, exactly as `provider_keys` packs its boxes. The context is this challenge's, so a handle moved to
 * another challenge does not open. The payment operation is STEP 183's, unchanged: a card that authentication
 * clears is charged by the one charge path the repository has.
 *
 * ## What is not, and who owns it
 *
 *   - **The authentication operation.** STEP 149-152's NMI adapter exchanges a Collect.js token for a sale; it
 *     has no operation that asks the issuer to authenticate a card first. `noPortalThreeDsPort` states that
 *     absence rather than imitating a provider, so the page says card payment is not available instead of
 *     sending a payer to a bank that was never asked.
 *   - **The challenge record.** Opening a challenge needs a record that outlives the request. The recorder
 *     here is in memory and says `durable: false`, which makes the flow refuse to start - a payer sent to a
 *     bank page whose return has nowhere to land is worse than a page that says "not yet". The durable
 *     implementation is STEP 130/132's payment operation, which already owns the payment record and the
 *     idempotency key this flow charges with.
 *
 * Neither is a gap this STEP may paper over. Section 18 asks for authentication on every payment where
 * possible, and "where possible" is a fact about the adapter, not an opinion this page can improve by
 * pretending.
 *
 * ## Why a function and not a constant
 *
 * A constant would read the environment at import time, which would make a build machine need the master key
 * and a gate that imports this module fail before it checked anything. It is built on the first request and
 * kept, exactly as `getAuthRuntime` and `getPortalPaymentRuntime` do it.
 */

export type PortalThreeDsRuntime = PortalThreeDsDependencies;

let runtime: PortalThreeDsRuntime | undefined;

export function getPortalThreeDsRuntime(): PortalThreeDsRuntime {
  if (runtime !== undefined) {
    return runtime;
  }

  const auth = getAuthRuntime();
  const masterKey = auth.masterKey();

  const secrets: PortalThreeDsSecrets = {
    seal: (plaintext, context) => packSecretBox(sealSecret(masterKey, plaintext, context)),
    open: (box, context) => {
      const unpacked = unpackSecretBox(box);

      if (unpacked === null) {
        // The flow turns this into its own refusal; the cipher's error is not a fact a page should print.
        throw new Error("the sealed handle is not a box this build wrote");
      }

      return openSecret(masterKey, unpacked, context);
    },
  };

  const built: PortalThreeDsRuntime = {
    payment: getPortalPaymentRuntime(),
    port: noPortalThreeDsPort,
    recorder: createInMemoryPortalThreeDsRecorder(),
    secrets,
    billing: getPortalBillingMatchRuntime(),
  };

  runtime = built;

  return runtime;
}
