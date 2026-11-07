// path: app/(client-portal)/portal-three-ds-processor.ts
import type {
  PortalThreeDsCompleteAnswer,
  PortalThreeDsCompleteRequest,
  PortalThreeDsPort,
  PortalThreeDsRecorder,
  PortalThreeDsRecord,
  PortalThreeDsRequest,
  PortalThreeDsRequestAnswer,
  PortalThreeDsSettlement,
} from "./portal-three-ds.ts";

/**
 * The two pieces the 3D Secure flow runs on, and what this build can honestly say about them.
 *
 * ## The recorder
 *
 * A challenge is state that outlives the request that started it: the payer leaves for a bank's page and comes
 * back minutes later. The flow therefore needs somewhere to keep the challenge, the token it was started for
 * and the payer's own idempotency key, and it needs that place to be the same place the completion reads. The
 * in-memory recorder below is exactly that shape and exactly not durable: it lives in one process and dies
 * with it, which is why it says `durable: false` and why `startPortalThreeDs` refuses to begin a challenge on
 * top of it. A challenge nobody can finish would leave a payer at a bank page with nowhere to return.
 *
 * The durable implementation is STEP 130/132's payment operation writing its own record - the same record the
 * charge needs - with the token and the key sealed the way `provider_keys` is. That is named in this STEP's
 * handoff rather than invented here, because a payment record written by a portal file is the fourth place
 * money is recorded and the review calls that a defect.
 *
 * ## The port
 *
 * `noPortalThreeDsPort` is not a fake provider: it is the truth about this build. STEP 149-152's NMI adapter
 * handles a Collect.js token as a sale; it has no operation that asks the issuer to authenticate a card, and
 * the file that would carry one is not this STEP's to edit. So the production wiring binds this value, the
 * page says card payment is not available, and the whole flow is exercised against a recording port in
 * `portal-three-ds-verify.ts` instead of against a provider this repository cannot call.
 */

/** A challenge recorder that keeps its records in this process, and says so. */
export function createInMemoryPortalThreeDsRecorder(): PortalThreeDsRecorder {
  const records = new Map<string, PortalThreeDsRecord>();
  const spent = new Set<string>();
  const settlements = new Map<string, PortalThreeDsSettlement>();

  return {
    durable: false,
    open(record: PortalThreeDsRecord): { readonly status: "opened" } | { readonly status: "refused"; readonly reason: string } {
      if (records.has(record.challengeId)) {
        return { status: "refused", reason: "challenge_exists" };
      }

      records.set(record.challengeId, record);

      return { status: "opened" };
    },
    claim(challengeId: string) {
      const record = records.get(challengeId);

      if (record === undefined) {
        return { status: "unknown" } as const;
      }

      if (spent.has(challengeId)) {
        return { status: "spent" } as const;
      }

      spent.add(challengeId);

      return { status: "claimed", record } as const;
    },
    settle(input: PortalThreeDsSettlement): void {
      settlements.set(input.challengeId, input);
    },
  };
}

/** Every answer the port can give when this deployment has no operation to authenticate a card with. */
export const noPortalThreeDsPort: PortalThreeDsPort = {
  available: false,
  async request(_input: PortalThreeDsRequest): Promise<PortalThreeDsRequestAnswer> {
    return { status: "unavailable", reason: "no_three_ds_operation" };
  },
  async complete(_input: PortalThreeDsCompleteRequest): Promise<PortalThreeDsCompleteAnswer> {
    return { status: "unavailable", reason: "no_three_ds_operation" };
  },
};
