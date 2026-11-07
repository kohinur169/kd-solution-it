// path: app/(client-portal)/portal-payment-link-runtime.ts
import { z } from "zod";
import { getAuthRuntime } from "../../lib/auth/runtime.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import { getServerConfig } from "../../config/server.ts";
import { getPortalPaymentRuntime } from "./portal-payment-runtime.ts";
import type { PortalPaymentLinkStore } from "./portal-payment-link-store.ts";
import { createInMemoryPortalPaymentLinkStore } from "./portal-payment-link-store.ts";
import { PORTAL_PAYMENT_LINK_SERVICE_KEY } from "./portal-payment-link-fields.ts";
import type { PortalPaymentLinkDependencies } from "./portal-payment-link.ts";
import type { PortalPaymentLinkCheckoutDependencies } from "./portal-payment-link-checkout.ts";

/**
 * The production wiring of payment links.
 *
 * ## The one part that is real, and the one that is not
 *
 *   - **The entitlement is real.** Section 16 makes payment links a plan entitlement, and both halves of that
 *     sentence already exist in the schema: `subscriptions` says which plan a company is on, and
 *     `plan_entitlements` says which services a plan includes. The reader below is those two reads, so a
 *     merchant whose plan does not carry `payment_links` is refused by a real answer rather than a constant.
 *   - **The link store is in memory and therefore not durable.** `portal_payment_links` is not in this STEP's
 *     migrations, and the store states `durable: false`, which makes `createPortalPaymentLink` and
 *     `reissuePortalPaymentLink` refuse instead of minting a credential that disappears at the next deploy.
 *
 * That is the same shape STEP 183's payment page shipped in: the flow is built and proven by
 * `portal-payment-link-verify.ts` with a durable store, and this runtime says honestly which half is missing,
 * so the browser is told "the business cannot take payments through a link yet" rather than shown a dead page.
 *
 * ## Why a function
 *
 * The environment is read on the first request, not at import time, so `next build` does not need the master
 * key and a gate that imports this module does not fail before it checks anything.
 */

export type PortalPaymentLinkRuntime = PortalPaymentLinkDependencies & {
  /** The gateway to the database, which this STEP's rate limit and audit writes need. */
  readonly rest: RestClient;
  readonly processor: PortalPaymentLinkCheckoutDependencies["processor"];
  readonly referral: Exclude<PortalPaymentLinkCheckoutDependencies["referral"], undefined>;
  readonly tokenizationKeyFor: Exclude<PortalPaymentLinkCheckoutDependencies["tokenizationKeyFor"], undefined>;
};

let runtime: PortalPaymentLinkRuntime | undefined;

/** The statuses that still grant a plan's services. A cancelled subscription does not. */
const ENTITLED_SUBSCRIPTION_STATUSES = ["active", "past_due"];

const subscriptionRowSchema = z.object({ plan_id: z.string() });
const entitlementRowSchema = z.object({ plan_id: z.string() });

/**
 * Does this company's subscription carry the `payment_links` service?
 *
 * Two reads, in the order the question is asked: which plan is the company on, then which services that plan
 * includes. The second read is skipped when there is no live subscription, which is also the answer for a
 * merchant on no plan at all.
 *
 * A read that fails is answered as "not entitled": an entitlement check that cannot be made must not hand out
 * the feature, and the caller renders the same refusal a merchant on a smaller plan sees.
 */
async function readPaymentLinksEntitlement(rest: RestClient, companyId: string): Promise<boolean> {
  try {
    const subscriptions = await rest.select(
      "subscriptions",
      `company_id=eq.${companyId}&status=in.(${ENTITLED_SUBSCRIPTION_STATUSES.join(",")})` +
        "&deleted_at=is.null&select=plan_id",
      subscriptionRowSchema,
    );
    const planIds = [...new Set(subscriptions.map((row) => row.plan_id))];

    if (planIds.length === 0) {
      return false;
    }

    const entitlements = await rest.select(
      "plan_entitlements",
      `plan_id=in.(${planIds.join(",")})&service=eq.${PORTAL_PAYMENT_LINK_SERVICE_KEY}` +
        "&deleted_at=is.null&select=plan_id",
      entitlementRowSchema,
    );

    return entitlements.length > 0;
  } catch {
    return false;
  }
}

export function getPortalPaymentLinkRuntime(): PortalPaymentLinkRuntime {
  if (runtime !== undefined) {
    return runtime;
  }

  const auth = getAuthRuntime();
  const store: PortalPaymentLinkStore = createInMemoryPortalPaymentLinkStore();

  const built: PortalPaymentLinkRuntime = {
    store,
    rest: auth.rest,
    audit: auth.audit,
    tokenKeys: { primary: auth.masterKey() },
    entitled: (companyId) => readPaymentLinksEntitlement(auth.rest, companyId),
    appUrl: getServerConfig().appUrl,
    // The checkout goes through the payment page's own processor rather than a second one: the key ring, the
    // blacklist and the velocity policy must be the same ones for a link payment as for an invoice payment,
    // and a second processor would be a second place for them to drift.
    processor: getPortalPaymentRuntime().processor,
    referral: getPortalPaymentRuntime().referral ?? null,
    tokenizationKeyFor: getPortalPaymentRuntime().tokenizationKeyFor,
  };

  runtime = built;

  return built;
}
