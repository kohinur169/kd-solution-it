// path: app/(client-portal)/portal-velocity-processor.ts
import type { AuditTrail } from "../../lib/auth/audit.ts";
import type { VelocityCounterClient } from "../../lib/security/velocity.ts";
import { portalVelocityPolicyOf } from "./portal-velocity-fields.ts";
import {
  consumePortalPaymentVelocity,
  type PortalVelocityCheck,
  type PortalVelocityReading,
} from "./portal-velocity.ts";

/**
 * The velocity check, wired for the payment page.
 *
 * ## Why one factory and not a module constant
 *
 * The policy is validated once, at the moment the page's operation is built: an operator's limit that the
 * counter table would refuse must fail there, on the first boot, rather than on the first payment of the day.
 * The clock is a parameter for the same reason STEP 067's is - a gate stands on a window boundary without
 * waiting an hour - and the audit trail is optional for the same reason it is optional there.
 *
 * ## What this adapter does not do
 *
 * It does not decide. `consumePortalPaymentVelocity` counts both subjects and answers; the payment operation
 * turns a breach into a refusal and STEP 067's own module writes the breach. An adapter that made the decision
 * would be a second place a limit is enforced, and two places is one place that is wrong.
 */

/** What the factory needs: the counter client, the trail, and the operator's policy when there is one. */
export interface PortalVelocityCheckOptions {
  readonly rest: VelocityCounterClient;
  readonly audit?: AuditTrail;
  /** The operator's policy. Absent means STEP 067's defaults. */
  readonly policy?: unknown;
  readonly now?: () => number;
}

/** The check the payment operation asks before it opens a record. */
export function createPortalVelocityCheck(options: PortalVelocityCheckOptions): PortalVelocityCheck {
  const policy = portalVelocityPolicyOf(options.policy);

  return {
    async check(input: {
      readonly token: string;
      readonly clientAddress: string;
      readonly userAgent: string | null;
    }): Promise<PortalVelocityReading> {
      return consumePortalPaymentVelocity(
        { cardToken: input.token, clientAddress: input.clientAddress, userAgent: input.userAgent },
        {
          rest: options.rest,
          policy,
          ...(options.audit === undefined ? {} : { audit: options.audit }),
          ...(options.now === undefined ? {} : { now: options.now }),
        },
      );
    },
  };
}
