// path: app/(client-portal)/portal-fraud-processor.ts
import { randomUUID } from "node:crypto";
import type {
  PortalCardReferral,
  PortalCardReferralQueue,
  PortalCardReferred,
} from "./portal-fraud.ts";

/**
 * The card referral queue section 18's blacklist sentence runs on, and what this build can say about it.
 *
 * ## Why a queue and not a write
 *
 * Section 18's next sentence is "card blacklist entries use card token or provider card fingerprint", and the
 * list itself is STEP 187's table. A payment page that wrote a risk list would be a second writer of a list the
 * risk STEPs own, and a rejection that could be *undone* by failing to write it would be a refusal that depends
 * on a side effect. So the referral is a port: the money stops here, the list is told, and the two are recorded
 * separately.
 *
 * ## Why this one says `durable: false`
 *
 * A referral kept in one process is a list that forgets, so it says so, and `handlePortalProviderSignal`
 * reports the referral as refused while the rejection stands. The durable implementation writes STEP 187's
 * blacklist row; it is named in this STEP's handoff rather than built here.
 */

/** A referral queue that keeps what it is told in this process, and says so. */
export function createInMemoryCardReferralQueue(): PortalCardReferralQueue {
  const referrals = new Map<string, PortalCardReferral & { readonly referralId: string }>();

  return {
    durable: false,
    async refer(card: PortalCardReferral): Promise<PortalCardReferred> {
      const referralId = randomUUID();

      referrals.set(referralId, { ...card, referralId });

      return { status: "referred", referralId };
    },
  };
}
