// path: app/(client-portal)/portal-velocity-fields.ts
import { z } from "zod";
import { appConfig } from "../../config/app.ts";
import { deepFreeze } from "../../lib/utils/freeze.ts";
import { AppError } from "../../lib/errors/app-error.ts";
import {
  VELOCITY_MAXIMUM_LIMIT,
  VELOCITY_MAXIMUM_WINDOW_SECONDS,
  VELOCITY_MINIMUM_WINDOW_SECONDS,
  VELOCITY_SUBJECTS,
  type VelocityPolicy,
  type VelocityReading,
  type VelocitySubjectKind,
} from "../../lib/security/velocity.ts";
import { PORTAL_PAYMENT_AUDIT_ENTITY } from "./portal-payment-fields.ts";

/**
 * The vocabulary of section 18's velocity sentence: "card and IP velocity limits exist with defaults in
 * config."
 *
 * ## The counter is STEP 067's, and so are the defaults
 *
 * Nothing here counts anything. `lib/security/velocity.ts` already owns the table (`0056`), the function
 * (`0093`), the canonicalisation (a card's 64 hex fingerprint, one spelling of an address), the window
 * arithmetic and the audit entry of the hit that breached a limit. Section 18 says the *defaults* live in
 * config, and STEP 067 put them in `VELOCITY_DEFAULT_POLICY` with the note that an operator's value travels
 * in the policy argument - because a settings screen reads a database row this repository does not have yet.
 * This module therefore states the same defaults, carries them through the policy argument, and validates
 * whatever an operator hands over against the bounds `0056` already enforces.
 *
 * ## What is this STEP's own
 *
 * The page's side of the rule, and it is three things:
 *
 *   - **one attempt, two hits** - the card and the address are both counted, in that order, so a limit on
 *     neither is left unenforced by the other and an attacker rotating cards from one address is still seen;
 *   - **a refusal that says which limit it hit** - `velocity_card_limited` or `velocity_ip_limited`, with the
 *     wait the counter computed, as `429` and a `retry-after`;
 *   - **a counter that cannot answer refuses rather than passes**, because a limiter that opens when the
 *     database is down is not a limiter.
 *
 * A velocity refusal is not a payment: it is decided before a payment record is opened, so the `payments` table
 * holds no row for traffic the platform turned away. The counter holds the count and the chain holds the
 * breach, which is exactly what an operator needs to see an attack.
 */

/** The two subjects, imported from STEP 067 so a third cannot appear here alone. */
export const PORTAL_VELOCITY_SUBJECTS = VELOCITY_SUBJECTS;

export type PortalVelocitySubject = VelocitySubjectKind;

/**
 * The defaults, in the one place a payment service reads them: `config/app.ts`, where section 18 says they live.
 *
 * Card: five attempts in an hour on one card. Address: twenty attempts in an hour from one address. STEP 067
 * states the same two pairs as the platform's baseline, and the gate asserts the config and that constant agree
 * - so a change to one without the other is a failing gate rather than a page that counts differently from the
 * counter it calls.
 */
export const PORTAL_VELOCITY_POLICY: VelocityPolicy = appConfig.security.velocity;

/** The rules this page refuses with. Three rules, because a payer can act differently on each. */
export const PORTAL_VELOCITY_RULES = deepFreeze({
  /** This card has been tried too often inside the window. */
  cardLimited: "velocity_card_limited",
  /** This network has been tried too often inside the window. */
  addressLimited: "velocity_ip_limited",
  /** The counters could not be read, so nothing was attempted. */
  unavailable: "velocity_unavailable",
});

/** The audit action of this page's refusal. STEP 067's `security.velocity_limited` stays its own fact. */
export const PORTAL_VELOCITY_AUDIT_ACTION = "portal.payment_velocity_limited";

/** The audit entity: a payment attempt, read by the same subject every other payment entry uses. */
export const PORTAL_VELOCITY_AUDIT_ENTITY = PORTAL_PAYMENT_AUDIT_ENTITY;

/** The field a refusal marks, so a form has somewhere to put the sentence. */
export const PORTAL_VELOCITY_REFUSAL_FIELD = "payment";

/**
 * The policy an operator may set, validated against the bounds `0056` states.
 *
 * A limit below one, or a window outside one second to thirty days, would be a counter the table refuses - so
 * it is refused here, at the seam, rather than becoming a `DEPENDENCY_FAILED` on the first payment of the day.
 * An invalid policy is not a reason to take a payment unprotected: it is a platform failure, which is why the
 * error is `INTERNAL_ERROR` and the page answers `503`.
 */
export const portalVelocityPolicySchema = z
  .object({
    card: z
      .object({
        limit: z.number().int().min(1).max(VELOCITY_MAXIMUM_LIMIT),
        windowSeconds: z
          .number()
          .int()
          .min(VELOCITY_MINIMUM_WINDOW_SECONDS)
          .max(VELOCITY_MAXIMUM_WINDOW_SECONDS),
      })
      .strict(),
    ip: z
      .object({
        limit: z.number().int().min(1).max(VELOCITY_MAXIMUM_LIMIT),
        windowSeconds: z
          .number()
          .int()
          .min(VELOCITY_MINIMUM_WINDOW_SECONDS)
          .max(VELOCITY_MAXIMUM_WINDOW_SECONDS),
      })
      .strict(),
  })
  .strict();

/** The policy a caller asked for, or the platform's defaults when it asked for nothing. */
export function portalVelocityPolicyOf(input?: unknown): VelocityPolicy {
  if (input === undefined) {
    return PORTAL_VELOCITY_POLICY;
  }

  const parsed = portalVelocityPolicySchema.safeParse(input);

  if (!parsed.success) {
    throw new AppError("INTERNAL_ERROR", { cause: { rule: "portal_velocity_policy" } });
  }

  return parsed.data;
}

/** One subject's state after this attempt's hit, as the page and the chain report it. */
export interface PortalVelocitySubjectReading {
  readonly subject: PortalVelocitySubject;
  readonly hits: number;
  readonly limit: number;
  readonly windowSeconds: number;
  readonly retryAfterSeconds: number;
}

/** What a refusal carries: the subject that breached, and both counters as they stood after the hit. */
export interface PortalVelocityLimited {
  /** The subject whose limit this attempt reached. The card is reported first, because it is counted first. */
  readonly subject: PortalVelocitySubject;
  readonly hits: number;
  readonly limit: number;
  readonly windowSeconds: number;
  readonly retryAfterSeconds: number;
  readonly card: PortalVelocitySubjectReading;
  readonly ip: PortalVelocitySubjectReading;
}

/**
 * The refusal, or null when neither limit was breached.
 *
 * The card is checked first because it is counted first, so an attempt that breaches both is reported as the
 * card's - the wait a payer is told about is the same either way, and the audit entry carries both counters.
 */
export function portalVelocityLimitedOf(input: {
  readonly card: VelocityReading;
  readonly ip: VelocityReading;
}): PortalVelocityLimited | null {
  const breached = input.card.exceeded ? input.card : input.ip.exceeded ? input.ip : null;

  if (breached === null) {
    return null;
  }

  return {
    subject: breached.kind,
    hits: breached.hits,
    limit: breached.limit,
    windowSeconds: breached.windowSeconds,
    retryAfterSeconds: breached.retryAfterSeconds,
    card: portalVelocityReadingOf(input.card),
    ip: portalVelocityReadingOf(input.ip),
  };
}

/** The smaller shape a reading becomes: the numbers, and neither the subject's value nor the window instant. */
export function portalVelocityReadingOf(reading: VelocityReading): PortalVelocitySubjectReading {
  return {
    subject: reading.kind,
    hits: reading.hits,
    limit: reading.limit,
    windowSeconds: reading.windowSeconds,
    retryAfterSeconds: reading.retryAfterSeconds,
  };
}

/** The rule a breach is refused with, by subject. */
export function portalVelocityRuleOf(subject: PortalVelocitySubject): string {
  return subject === "card" ? PORTAL_VELOCITY_RULES.cardLimited : PORTAL_VELOCITY_RULES.addressLimited;
}

/**
 * The audit payload of a refusal.
 *
 * It names the limit, the count that reached it and the wait - and the card's fingerprint when the card was
 * the subject, because a fingerprint is a hash `0055` already stores and never a card. The address is not
 * repeated here: the entry's own address field is where an operator reads it.
 */
export function portalVelocityPayloadOf(input: {
  readonly invoiceId: string;
  readonly number: string | null;
  readonly amountMinor: string;
  readonly limited: PortalVelocityLimited;
  readonly cardFingerprint: string;
  readonly rule: string;
}): Record<string, unknown> {
  return {
    invoice_id: input.invoiceId,
    number: input.number,
    amount_minor: input.amountMinor,
    rule: input.rule,
    subject: input.limited.subject,
    hits: input.limited.hits,
    limit: input.limited.limit,
    window_seconds: input.limited.windowSeconds,
    retry_after_seconds: input.limited.retryAfterSeconds,
    card_fingerprint: input.limited.subject === "card" ? input.cardFingerprint : null,
    card: {
      hits: input.limited.card.hits,
      limit: input.limited.card.limit,
      window_seconds: input.limited.card.windowSeconds,
    },
    ip: {
      hits: input.limited.ip.hits,
      limit: input.limited.ip.limit,
      window_seconds: input.limited.ip.windowSeconds,
    },
  };
}
