// path: lib/tax/taxcloud-tax-line-runtime.ts
import { getAuthRuntime } from "../auth/runtime.ts";
import { createTaxCloudTaxLineRestStore } from "./taxcloud-tax-line.ts";
import type { RecordInvoiceTaxOptions, TaxCloudTaxLineStore } from "./taxcloud-tax-line.ts";

/**
 * The production wiring of the tax line: `0121`'s table through the platform's rest client, and the
 * audit trail every other TaxCloud write appends to.
 *
 * Nothing is cached and nothing is sealed: a tax line holds no credential, so the only secret this
 * module touches is the session's, and that belongs to the route that called it.
 */
export interface TaxCloudTaxLineRuntime extends RecordInvoiceTaxOptions {
  readonly store: TaxCloudTaxLineStore;
}

/** The two dependencies, wired once per call. */
export function getTaxCloudTaxLineRuntime(): TaxCloudTaxLineRuntime {
  const runtime = getAuthRuntime();

  return {
    store: createTaxCloudTaxLineRestStore(runtime.rest),
    audit: runtime.audit,
  };
}
