// path: app/(client-portal)/portal-velocity.ts
import type { AuditTrail } from "../../lib/auth/audit.ts";
import type { FraudSignalLookups } from "../../lib/security/fraud.ts";
import {
  consumeVelocity,
  velocityAuditEntry,
  velocityCardFingerprint,
  type VelocityCounterClient,
  type VelocityPolicy,
  type VelocityReading,
} from "../../lib/security/velocity.ts";
import {
  portalVelocityLimitedOf,
  portalVelocityReadingOf,
  type PortalVelocityLimited,
  type PortalVelocitySubjectReading,
} from "./portal-velocity-fields.ts";

/**
 * The velocity limits, enforced on the payment page.
 *
 * ## One attempt is two hits
 *
 * Section 18 asks for both limits, so both fire: the card is counted first and the address second, and an
 * attempt that breaches either is refused. Counting only the first would leave one of the two sentences
 * unenforced; counting neither would leave the page open to the attack the limits exist for - a stolen card
 * tried until it works, or one address cycling through cards.
 *
 * A hit is counted even when the attempt is refused, which is the point of a counter: a refused attempt is
 * exactly the traffic a limit is measuring.
 *
 * ## The count is the database's
 *
 * `consumeVelocity` of STEP 067 is called, not reimplemented: one RPC, one atomic statement, the window aligned
 * to the epoch by `0093`, and the limit frozen in the row at its first hit. The value the page passes for a card
 * is the same 64 hex fingerprint STEP 187 matches the blacklist with (`portalCardFingerprintOf`), and STEP 067's
 * canonicalisation accepts a value that is already a fingerprint - so the list and the counter name the same
 * card, and neither hashes a card number. A value that looks like a card number is refused by that module before
 * it is hashed, which is the boundary that keeps this page from ever holding one.
 *
 * ## Fail closed, and cheaply
 *
 * A counter that cannot answer is `unavailable`, and the page refuses. The two calls are sequential on purpose:
 * if the card counter cannot answer, the address counter is not spent on an attempt that will be refused
 * anyway, and the refusal is the same either way.
 *
 * ## The audit entry is STEP 067's
 *
 * The hit that reaches a limit writes `security.velocity_limited` through `velocityAuditEntry`, once per window
 * and not once per refusal - the same rule that keeps an attack from turning the chain into a copy of itself.
 * This module adds nothing to that entry; what the page adds is its own refusal, in the payment's chain.
 */

/** The part of the REST client a counter needs, so this module does not depend on the whole auth client. */
export interface PortalVelocityDependencies {
  readonly rest: VelocityCounterClient;
  readonly audit?: AuditTrail;
  readonly policy?: VelocityPolicy;
  readonly now?: () => number;
}

/** What the two counters said about one attempt. */
export type PortalVelocityReading =
  | {
      readonly status: "within";
      readonly card: PortalVelocitySubjectReading;
      readonly ip: PortalVelocitySubjectReading;
    }
  | { readonly status: "limited"; readonly limited: PortalVelocityLimited }
  | { readonly status: "unavailable"; readonly reason: "card_counter_failed" | "address_counter_failed" };

/** The check the payment operation runs before a payment record is opened or the gateway is asked. */
export interface PortalVelocityCheck {
  check(input: {
    readonly token: string;
    readonly clientAddress: string;
    readonly userAgent: string | null;
  }): Promise<PortalVelocityReading>;
}

/** What one attempt asks the counters about: the token the fields handed back, and where it came from. */
export interface PortalVelocityAttempt {
  readonly cardToken: string;
  readonly clientAddress: string;
  readonly userAgent?: string | null;
}

/** The fingerprint the counter and STEP 187's blacklist both name one card by. */
export function portalVelocityCardFingerprint(cardToken: string): string {
  return velocityCardFingerprint(cardToken);
}

/** Count one attempt against both limits, and answer which, if either, it breached. */
export async function consumePortalPaymentVelocity(
  attempt: PortalVelocityAttempt,
  dependencies: PortalVelocityDependencies,
): Promise<PortalVelocityReading> {
  const policy = dependencies.policy;
  const options = {
    rest: dependencies.rest,
    ...(policy === undefined ? {} : { policy }),
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  };

  let card: VelocityReading;

  try {
    card = await consumeVelocity({ kind: "card", value: attempt.cardToken }, options);
  } catch {
    return { status: "unavailable", reason: "card_counter_failed" };
  }

  await recordBreach(card, attempt, dependencies);

  let address: VelocityReading;

  try {
    address = await consumeVelocity({ kind: "ip", value: attempt.clientAddress }, options);
  } catch {
    // The card's hit already stands: it was a real attempt, and a counter that lost its second call has still
    // counted one of them. What it must not do is let the payment through.
    return { status: "unavailable", reason: "address_counter_failed" };
  }

  await recordBreach(address, attempt, dependencies);

  const limited = portalVelocityLimitedOf({ card, ip: address });

  return limited === null
    ? {
        status: "within",
        card: portalVelocityReadingOf(card),
        ip: portalVelocityReadingOf(address),
      }
    : { status: "limited", limited };
}

/**
 * The audit entry of a breach, written when the counter says this hit was the one that reached the limit.
 *
 * A trail that cannot be reached never fails the payment: the counter has already moved, and the audit writer
 * has its own retry. That is STEP 067's own bargain, kept here rather than restated.
 */
async function recordBreach(
  reading: VelocityReading,
  attempt: PortalVelocityAttempt,
  dependencies: PortalVelocityDependencies,
): Promise<void> {
  const audit = dependencies.audit;

  if (audit === undefined) {
    return;
  }

  const entry = velocityAuditEntry(reading, {
    ipAddress: attempt.clientAddress,
    userAgent: attempt.userAgent ?? null,
  });

  if (entry === null) {
    // Not the hit that reached the limit: an attack would otherwise fill the chain with itself.
    return;
  }

  try {
    await audit.append(entry);
  } catch {
    // Deliberate: the counter is the fact, and a chain that is down must not turn a counted attempt into a pass.
  }
}

/**
 * The two counters in the shape STEP 066's fraud evaluation asks for.
 *
 * `FraudSignalLookups.readVelocity` is one subject, one reading, and it is what the payment operation of STEP
 * 130/132 will pass into `fraudDecide`. Both subjects are supported, so that operation does not need a second
 * client of its own.
 */
export function createPortalVelocityLookup(
  dependencies: PortalVelocityDependencies,
): Pick<FraudSignalLookups, "readVelocity"> {
  return {
    async readVelocity(subject): Promise<{ readonly hits: number; readonly limit: number }> {
      const reading = await consumeVelocity(
        { kind: subject.kind, value: subject.value },
        {
          rest: dependencies.rest,
          ...(dependencies.policy === undefined ? {} : { policy: dependencies.policy }),
          ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
        },
      );

      return { hits: reading.hits, limit: reading.limit };
    },
  };
}
