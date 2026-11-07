// path: app/(client-portal)/portal-payment-runtime.ts
import { getAuthRuntime } from "../../lib/auth/runtime.ts";
import {
  decryptKey,
  InMemoryNmiKeyStore,
  type NmiKeyStore,
} from "../../lib/payments/adapters/nmi-client.ts";
import type { PortalPaymentDependencies } from "./portal-payment.ts";
import { createInMemoryCardReferralQueue } from "./portal-fraud-processor.ts";
import {
  createInMemoryPortalPaymentRecorder,
  createPortalPaymentProcessor,
} from "./portal-payment-processor.ts";

/**
 * The production wiring of the payment page.
 *
 * ## What it can do today, stated plainly
 *
 * The page needs three things to take a card: the link's key ring, a company's public tokenization key, and
 * a payment operation that records what it charges. The first is the platform's own master key and is
 * present. The other two are not, and this runtime says so instead of pretending:
 *
 *   - **The key store is in memory and empty.** `provider_keys` holds the gateway credentials in the
 *     database, and the adapter that reads and decrypts them persistently is STEP 152's key management work;
 *     this build wires the adapter's own `NmiKeyStore` interface over an in-memory store, so no company has
 *     a tokenization key configured and the page reports that card payment is not available for that
 *     business. The moment a persistent store is provided, nothing in this STEP changes.
 *   - **The recorder is in memory and therefore not durable.** Recording a payment in one process is not
 *     recording it, and the STEP 117-151 review states the same finding: the payment core's stores are
 *     reference implementations, not transactional persistence. The recorder the gate uses says
 *     `durable: false`, which makes `chargePortalPayment` refuse rather than charge a card it cannot account
 *     for. A durable recorder - a `payments` row plus its idempotency key, written in one transaction - is
 *     the seam that turns the page on, and it is not this STEP's file to write.
 *
 * So a payment page in this build shows the amount, explains the fields, and answers honestly that the
 * business cannot take a card yet. That is a worse demo than a fake charge and a far better platform: the
 * flow itself - hosted fields, token, verification, routing, provider execution, idempotency, audit - is
 * built and proven in `portal-payment-verify.ts` with a durable recorder and a recording transport.
 *
 * ## Why a function and not a module level constant
 *
 * A constant would read the environment at import time, which would make a build machine need the master key
 * and would make a gate that imports this module fail before it checked anything. The runtime is built on
 * the first request and kept, exactly as `getAuthRuntime` does it.
 */

export type PortalPaymentRuntime = PortalPaymentDependencies;

let runtime: PortalPaymentRuntime | undefined;

export function getPortalPaymentRuntime(): PortalPaymentRuntime {
  if (runtime !== undefined) {
    return runtime;
  }

  const auth = getAuthRuntime();
  const masterKey = auth.masterKey();
  // `decryptKey` takes the AES key as hex, and the platform's master key is base64 of thirty two bytes.
  const encryptionKeyHex = Buffer.from(masterKey, "base64").toString("hex");
  const keyStore: NmiKeyStore = new InMemoryNmiKeyStore();

  runtime = {
    rest: auth.rest,
    audit: auth.audit,
    tokenKeys: { primary: masterKey },
    processor: createPortalPaymentProcessor({
      recorder: createInMemoryPortalPaymentRecorder(),
      keyStore,
      encryptionKeyHex,
    }),
    // STEP 186: the list a flagged card is referred to. In memory here, and reported as refused; the durable
    // list is STEP 187's table.
    referral: createInMemoryCardReferralQueue(),
    tokenizationKeyFor: (companyId) => {
      const config = keyStore.findActiveByCompany(companyId);

      if (config === null) {
        return null;
      }

      try {
        return { apiKey: decryptKey(config.apiKeyEncrypted, encryptionKeyHex), environment: config.environment };
      } catch {
        // A key that cannot be decrypted is a key the page cannot use: the company is told card payment is
        // unavailable rather than being shown fields that would fail at the gateway.
        return null;
      }
    },
  };

  return runtime;
}
