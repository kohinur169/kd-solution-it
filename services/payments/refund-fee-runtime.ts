// path: services/payments/refund-fee-runtime.ts
import { getAuthRuntime } from "../../lib/auth/runtime.ts";
import type { RefundFeeDependencies } from "./refund-fee.ts";

/**
 * The production wiring of STEP 193: the database, the signed chain, and the ledger store.
 *
 * ## Why the switch and the answer share one runtime
 *
 * Three callers ask the same two questions - the fees screen, the two routes, and the execution route that
 * applies the rule to the refund it just settled. Each of them needs the PostgREST client, the Ed25519 signing
 * trail and the clock, and `getAuthRuntime()` already validated the environment and built all three, so this is
 * a projection of it rather than a second factory.
 *
 * ## Why the ledger is null, and what that costs
 *
 * `lib/payments/ledger-posting.ts` posts a balanced group through a `LedgerEntryStore`, and this build has no
 * production implementation of that interface: STEP 132 built the posting rules and STEP 135 the fee
 * calculation, and both are exercised against an in-memory store in their gates. A store written here would be
 * the first, and it must be transactional - the interface says so, and a pair of PostgREST inserts is exactly
 * the half-posted group the database's deferred balance trigger exists to refuse.
 *
 * So the deployment records the answer where it can: on the refund (`platform_fee_returned` and
 * `platform_fee_returned_minor`) and in the signed chain, with the ledger group id derived from the refund and
 * reported as `ledger: "absent"`. The day a store exists, it is passed here and every later return posts a real
 * pair; the returns already recorded keep their amount and their chain entry, and a reconciliation can post
 * them from the chain because the group id of each is derivable from its refund. The handoff names this as a
 * gap rather than leaving it as a surprise.
 */

/** The dependencies the fees screen and the three routes use. */
export type RefundFeeRuntime = RefundFeeDependencies & { readonly now: () => number };

export function getRefundFeeRuntime(): RefundFeeRuntime {
  const runtime = getAuthRuntime();

  return {
    rest: runtime.rest,
    audit: runtime.audit,
    ledger: null,
    now: (): number => Date.now(),
  };
}
