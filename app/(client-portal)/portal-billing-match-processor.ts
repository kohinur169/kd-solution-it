// path: app/(client-portal)/portal-billing-match-processor.ts
import { randomUUID } from "node:crypto";
import type {
  PortalCountryResolver,
  PortalPaymentReviewQueue,
  PortalPaymentReviewRequest,
  PortalPaymentReviewRouted,
} from "./portal-billing-match.ts";

/**
 * The two pieces section 18's routing runs on, and what this build can honestly say about them.
 *
 * ## The resolver
 *
 * `noPortalCountryResolver` is not a stub of a service this platform has: it is the absence of one. Turning an
 * address into a country needs a geolocation database or a lookup service, neither of which exists in this
 * repository or its configuration, and a table of prefixes in a portal file would be a second, unaccountable
 * source of truth about where a cardholder is. So the resolver says `available: false`, the comparison treats
 * the country as unmatched, and the flow captures nothing without 3D Secure - which is what section 18 asks for
 * when one of its two conditions cannot be checked.
 *
 * ## The queue
 *
 * A review that lives in one process is a review nobody reads, so the in-memory queue says `durable: false` and
 * `routePortalPaymentReview` reports the routing as refused rather than claiming it happened. The durable
 * destination already exists in schema: `0037_payments.sql` carries `status = 'under_review'`,
 * `risk_decision = 'review'` and an index on the first, and the row is written by STEP 130/132's payment
 * operation - the file that owns the payments table. This STEP names the destination and the desk; it does not
 * write a money row of its own.
 */

/** A review queue that keeps what it routes in this process, and says so. */
export function createInMemoryPaymentReviewQueue(): PortalPaymentReviewQueue {
  const reviews = new Map<string, PortalPaymentReviewRequest & { readonly reviewId: string }>();

  return {
    durable: false,
    async route(input: PortalPaymentReviewRequest): Promise<PortalPaymentReviewRouted> {
      const reviewId = randomUUID();

      reviews.set(reviewId, { ...input, reviewId });

      return { status: "routed", reviewId };
    },
  };
}

/**
 * A resolver for a deployment that has none.
 *
 * It answers `null` when it is called, which is the truth - but it is never called in the flow, because
 * `evaluatePortalBillingMatch` checks `available` first. Both exist so a caller cannot mistake "not configured"
 * for "the address is in no country we know".
 */
export const noPortalCountryResolver: PortalCountryResolver = {
  available: false,
  async countryOf(_ipAddress: string): Promise<string | null> {
    return null;
  },
};
