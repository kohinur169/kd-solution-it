// path: lib/tax/taxcloud-invoice-tax-runtime.ts
import { getAuthRuntime } from "../auth/runtime.ts";
import { openSecret, sealSecret } from "../auth/secrets.ts";
import type { SecretBox } from "../auth/secrets.ts";
import { serverEnv } from "../env/server.ts";
import { createTaxCloudRestStore, taxCloudFetchTransport } from "./taxcloud-connect.ts";
import type { TaxCloudInvoiceTaxOptions } from "./taxcloud-invoice-tax.ts";

/**
 * The production wiring of the invoice calculation: the same store, sealer and transport STEP 177's
 * settings use, so a merchant's connection is read once and by one rule whichever surface asked.
 *
 * The key is read lazily on every open, and no copy of it survives the call, so this object holds
 * nothing worth logging. The transport is STEP 177's, which is the one place a request leaves for
 * TaxCloud - including the response headers STEP 179 needs for `Retry-After`.
 */
export interface TaxCloudInvoiceTaxRuntime extends TaxCloudInvoiceTaxOptions {
  readonly now: () => number;
}

/** The five dependencies, wired once. */
export function getTaxCloudInvoiceTaxRuntime(): TaxCloudInvoiceTaxRuntime {
  const runtime = getAuthRuntime();

  return {
    store: createTaxCloudRestStore(runtime.rest),
    sealer: {
      seal: (plaintext: string, context: string): SecretBox =>
        sealSecret(serverEnv().ENCRYPTION_MASTER_KEY, plaintext, context),
      open: (box: SecretBox, context: string): string =>
        openSecret(serverEnv().ENCRYPTION_MASTER_KEY, box, context),
    },
    transport: taxCloudFetchTransport,
    now: (): number => Date.now(),
    sleep: (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  };
}
