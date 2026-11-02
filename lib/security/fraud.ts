// path: lib/security/fraud.ts
import { AppError } from "../errors/app-error.ts";
import { deepFreeze } from "../utils/freeze.ts";
import { isIpLiteral } from "./host.ts";

/**
 * The fraud signals of one payment attempt, and the decision they add up to.
 *
 * ## What this module is
 *
 * FEATURE_LIST section 18 fixes four rules a payment has to pass, and section 5 fixes a fifth. A
 * provider fraud signal rejects the payment at once; a blacklisted card is refused; card and IP
 * velocity limits exist; a payment whose 3D Secure was not completed may only be captured when the
 * billing postal code *and* the payer IP country both match the invoice; and an unusually large
 * transaction is held for review. This module turns those five sentences plus the provider's own
 * verdict into one value - `allow`, `review` or `reject` - and the trace that produced it.
 *
 * The value is not a new vocabulary: `payments.risk_decision` already stores exactly those three
 * words (`payments_risk_check`), and the capture rule below is `payments_three_ds_capture_check`
 * written once more in TypeScript, so the service and the row cannot disagree. The gate reads the
 * migration and compares the two.
 *
 * ## Every signal is evaluated, and the decision is the maximum
 *
 * A short circuit is tempting - the provider already said fraud, so why ask the blacklist - and it
 * is wrong for the reason this platform keeps a hash chained audit log: the row has to say what was
 * checked, and an investigation cannot ask a question nobody wrote down. So the signals are
 * evaluated in a fixed order, every one of them produces a result, and the decision is the highest
 * outcome present (`reject`, then `review`, then `allow`). A later signal can raise a verdict and
 * can never lower one, which is a property of the assembly rather than of each branch.
 *
 * ## Fail closed
 *
 * Two signal sources live outside this module: the card blacklist of STEP 030 and the velocity
 * counters of STEP 067. Either can fail. A failed lookup throws `DEPENDENCY_FAILED` rather than
 * returning `clear`, because "we could not check" and "we checked and it was fine" are opposite
 * facts and only one of them is safe to act on. A reading that is not a count and a limit is the
 * same failure: the counter has to answer in the shape the rule uses.
 *
 * ## What never enters a decision, and what never leaves one
 *
 * A card number, an expiry, a CVV and a provider token are not inputs and cannot be: the card side
 * of this module is a 64 character fingerprint, which is what section 18 and the `0055` column
 * already name. The trace is a vocabulary of fixed words - `blacklisted`, `ip_over_limit` - never a
 * value, so the audit entry this module offers cannot carry a fingerprint, an address or an amount
 * by accident, and the gate asserts every detail is one of the words and nothing else.
 *
 * ## No clock, no randomness, no state
 *
 * The evaluation is a function of the attempt, the policy and two lookups. It reads no environment
 * variable, writes nothing and holds nothing between calls, so the same attempt always produces the
 * same decision and the gate can build the whole corpus without a database.
 */

/** The rule name a failure of this module states, so a log line says where it came from. */
export const FRAUD_RULE = "fraud";

/** The audit action of a decision that was not `allow`. */
export const FRAUD_AUDIT_ACTION = "payment.fraud_evaluated";

/** The only currency this platform charges, so a threshold in minor units is a threshold in cents. */
export const FRAUD_CURRENCY = "USD";

/** The failure code a rejected payment carries, inside the `payments_failure_code_check` bounds. */
export const FRAUD_FAILURE_CODE = "risk_rejected";

/** What a provider says about an attempt. Its own vocabulary, not a score. */
export const FRAUD_PROVIDER_SIGNALS = deepFreeze(["clear", "suspicious", "fraud"] as const);

export type FraudProviderSignal = (typeof FRAUD_PROVIDER_SIGNALS)[number];

/** The 3DS outcomes `payments_three_ds_check` allows, in the same order. */
export const FRAUD_THREE_DS_OUTCOMES = deepFreeze([
  "authenticated",
  "attempted",
  "not_completed",
  "not_requested",
] as const);

export type FraudThreeDsOutcome = (typeof FRAUD_THREE_DS_OUTCOMES)[number];

/** The payment methods `payments_method_check` allows. A fingerprint exists only for `card`. */
export const FRAUD_PAYMENT_METHODS = deepFreeze(["card", "bank_transfer", "e_wallet"] as const);

export type FraudPaymentMethod = (typeof FRAUD_PAYMENT_METHODS)[number];

/**
 * The signals, in the order they are evaluated.
 *
 * The order is a property of the trace: two evaluations of one attempt produce the same list in the
 * same order, so a diff between two rows means a rule changed rather than a hash table reordered.
 */
export const FRAUD_SIGNALS = deepFreeze([
  "provider_signal",
  "card_blacklist",
  "card_velocity",
  "ip_velocity",
  "three_ds_verification",
  "amount_review",
] as const);

export type FraudSignal = (typeof FRAUD_SIGNALS)[number];

/** What one signal found. `clear` is not a decision, it is the absence of one. */
export const FRAUD_OUTCOMES = deepFreeze(["clear", "review", "reject"] as const);

export type FraudOutcome = (typeof FRAUD_OUTCOMES)[number];

/** The decision, in the words `payments_risk_check` stores. */
export const FRAUD_DECISIONS = deepFreeze(["allow", "review", "reject"] as const);

export type FraudDecisionName = (typeof FRAUD_DECISIONS)[number];

/**
 * Every detail a signal may report.
 *
 * A closed vocabulary on purpose: a detail is written into an audit row that can never be edited,
 * so it must never be assembled from an amount, an address or a fingerprint. The gate asserts each
 * one is lowercase words without a digit, and that no other string can be produced.
 */
export const FRAUD_DETAILS = deepFreeze([
  "provider_clear",
  "provider_suspicious",
  "provider_fraud",
  "not_listed",
  "blacklisted",
  "no_card",
  "card_within_limit",
  "card_over_limit",
  "ip_within_limit",
  "ip_over_limit",
  "three_ds_authenticated",
  "three_ds_verified_by_billing",
  "three_ds_unverified",
  "amount_within_limits",
  "amount_over_review",
] as const);

export type FraudDetail = (typeof FRAUD_DETAILS)[number];

/** Why an evaluation could not produce a decision. Machine reasons, never a sentence a client sees. */
export const FRAUD_PROBLEMS = deepFreeze(["attempt_invalid", "policy_invalid", "lookup_failed"] as const);

export type FraudProblem = (typeof FRAUD_PROBLEMS)[number];

/**
 * The default policy, until a setting replaces it.
 *
 * Section 18 says the velocity limits have "defaults in config"; the amount that is large enough to
 * hold is the same kind of number, so it has a default here and a caller such as the payment service
 * passes the operator's value in. Ten thousand dollars in minor units is roughly the point where a
 * single card payment stops being routine for the merchants of section 5.
 */
export const FRAUD_DEFAULT_POLICY = deepFreeze({ reviewAmountMinor: 1_000_000n });

/** The fingerprint of `0055`: 64 lowercase hex characters, a hash and never a card. */
export const FRAUD_CARD_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;

/** The smallest limit a counter may apply, the floor `velocity_counters_limit_check` states. */
export const FRAUD_VELOCITY_LIMIT_MINIMUM = 1;

/** What one payment attempt looks like to the signals. It has no card data, by construction. */
export interface FraudAttempt {
  readonly companyId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly paymentMethod: FraudPaymentMethod;
  readonly providerSignal: FraudProviderSignal;
  readonly threeDsOutcome: FraudThreeDsOutcome;
  readonly postalCodeMatched: boolean;
  readonly ipCountryMatched: boolean;
  /** The `0055` fingerprint for a card payment, null for every other method. */
  readonly cardFingerprint: string | null;
  readonly ipAddress: string;
}

/** The numbers an operator may set. Only the amount threshold moves a decision. */
export interface FraudPolicy {
  readonly reviewAmountMinor: bigint;
}

/** What a velocity counter is asked about: one card or one address for one attempt. */
export interface FraudVelocitySubject {
  readonly kind: "card" | "ip";
  /** The fingerprint or the address, matching the kind and nothing else. */
  readonly value: string;
}

/**
 * What a counter answers: the hits inside the window and the limit it applied.
 *
 * `limit` is at least one, because `velocity_counters_limit_check` says so, and a reading that
 * reports otherwise is a counter this module will not act on.
 */
export interface FraudVelocityReading {
  readonly hits: number;
  readonly limit: number;
}

/**
 * The two sources outside this module.
 *
 * Both are injected so the service has no client of its own, and both are `Promise` returning
 * because the rows they read are in the database the payment attempt is being written against.
 */
export interface FraudSignalLookups {
  readonly isCardBlocked: (cardFingerprint: string) => Promise<boolean>;
  readonly readVelocity: (subject: FraudVelocitySubject) => Promise<FraudVelocityReading>;
}

export interface FraudEvaluationOptions {
  readonly lookups: FraudSignalLookups;
  readonly policy?: FraudPolicy;
}

/** One signal, its outcome and the word that says why. */
export interface FraudSignalResult {
  readonly signal: FraudSignal;
  readonly outcome: FraudOutcome;
  readonly detail: FraudDetail;
}

/** The decision, the trace behind it, and whether money may move now. */
export interface FraudDecision {
  readonly decision: FraudDecisionName;
  readonly captureAllowed: boolean;
  readonly signals: readonly FraudSignalResult[];
  /** The details of every signal that was not clear, in evaluation order. */
  readonly reasons: readonly FraudDetail[];
}

/** The entry this module offers to the audit chain. Structurally the entry STEP 063 accepts. */
export interface FraudAuditEntry {
  readonly action: string;
  readonly actorUserId: string | null;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly companyId: string | null;
  readonly sessionId?: string | null;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
}

/** The trail a caller passes when it wants a decision recorded. */
export interface FraudAuditTrail {
  append(entry: FraudAuditEntry): Promise<void>;
}

/** Who and where the attempt came from, for the audit row the caller writes. */
export interface FraudAuditContext {
  /** The payment row, when it already exists. The attempt is usually evaluated before it does. */
  readonly paymentId?: string | null;
  readonly actorUserId?: string | null;
  readonly sessionId?: string | null;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const providerSignalSet: ReadonlySet<string> = new Set<string>(FRAUD_PROVIDER_SIGNALS);
const threeDsOutcomeSet: ReadonlySet<string> = new Set<string>(FRAUD_THREE_DS_OUTCOMES);
const paymentMethodSet: ReadonlySet<string> = new Set<string>(FRAUD_PAYMENT_METHODS);

/** True when a value is a provider verdict this platform acts on. */
export function isFraudProviderSignal(value: unknown): value is FraudProviderSignal {
  return typeof value === "string" && providerSignalSet.has(value);
}

/** True when a value is a 3DS outcome the payments row accepts. */
export function isFraudThreeDsOutcome(value: unknown): value is FraudThreeDsOutcome {
  return typeof value === "string" && threeDsOutcomeSet.has(value);
}

/** True when a value is a payment method the payments row accepts. */
export function isFraudPaymentMethod(value: unknown): value is FraudPaymentMethod {
  return typeof value === "string" && paymentMethodSet.has(value);
}

/** An attempt this module will not evaluate. The caller built it, so the fault is the caller's. */
function attemptFailure(reason: FraudProblem): AppError {
  return new AppError("INTERNAL_ERROR", { cause: { rule: FRAUD_RULE, reason } });
}

/**
 * A signal that could not be read.
 *
 * `DEPENDENCY_FAILED` rather than a decision: the payment service retries or holds, and neither of
 * those is what "the blacklist says the card is fine" would have caused.
 */
function lookupFailure(): AppError {
  return new AppError("DEPENDENCY_FAILED", { cause: { rule: FRAUD_RULE, reason: "lookup_failed" } });
}

/**
 * The capture rule of section 18, in one place.
 *
 * A payment may be captured when 3D Secure authenticated, and otherwise only when the billing postal
 * code and the payer IP country both matched the invoice. `payments_three_ds_capture_check` states
 * the same rule in the database, and the gate compares the two, so a caller cannot capture money the
 * schema would refuse and cannot refuse money the schema would allow.
 */
export function threeDsVerified(attempt: Pick<FraudAttempt, "threeDsOutcome" | "postalCodeMatched" | "ipCountryMatched">): boolean {
  return (
    attempt.threeDsOutcome === "authenticated" ||
    (attempt.postalCodeMatched && attempt.ipCountryMatched)
  );
}

/**
 * The decision of a trace: the highest outcome present.
 *
 * Exported because it is the one rule a caller may want to reason about on its own, and because a
 * property this important deserves to be exercised without building six signals first.
 */
export function fraudDecisionOf(signals: readonly FraudSignalResult[]): FraudDecisionName {
  if (signals.some((result) => result.outcome === "reject")) {
    return "reject";
  }

  if (signals.some((result) => result.outcome === "review")) {
    return "review";
  }

  return "allow";
}

/** The attempt, or the refusal. Every field a rule reads is checked before a rule reads it. */
function requireAttempt(attempt: FraudAttempt): void {
  if (!uuidPattern.test(attempt.companyId)) {
    throw attemptFailure("attempt_invalid");
  }

  if (attempt.currency !== FRAUD_CURRENCY) {
    throw attemptFailure("attempt_invalid");
  }

  if (typeof attempt.amountMinor !== "bigint" || attempt.amountMinor <= 0n) {
    throw attemptFailure("attempt_invalid");
  }

  if (!isFraudPaymentMethod(attempt.paymentMethod) || !isFraudProviderSignal(attempt.providerSignal)) {
    throw attemptFailure("attempt_invalid");
  }

  if (!isFraudThreeDsOutcome(attempt.threeDsOutcome)) {
    throw attemptFailure("attempt_invalid");
  }

  if (typeof attempt.postalCodeMatched !== "boolean" || typeof attempt.ipCountryMatched !== "boolean") {
    throw attemptFailure("attempt_invalid");
  }

  if (attempt.paymentMethod === "card") {
    if (attempt.cardFingerprint === null || !FRAUD_CARD_FINGERPRINT_PATTERN.test(attempt.cardFingerprint)) {
      throw attemptFailure("attempt_invalid");
    }
  } else if (attempt.cardFingerprint !== null) {
    // A fingerprint on a bank transfer is a card that this attempt does not have, and trusting it
    // would let a caller choose which card the blacklist is asked about.
    throw attemptFailure("attempt_invalid");
  }

  if (!isIpLiteral(attempt.ipAddress)) {
    throw attemptFailure("attempt_invalid");
  }
}

/** The policy, or the refusal. A negative threshold would hold every payment. */
function requirePolicy(policy: FraudPolicy): FraudPolicy {
  if (typeof policy.reviewAmountMinor !== "bigint" || policy.reviewAmountMinor < 0n) {
    throw attemptFailure("policy_invalid");
  }

  return policy;
}

/** A reading, or the refusal: a counter that answers in another shape cannot be trusted. */
function requireReading(reading: FraudVelocityReading): FraudVelocityReading {
  if (
    !Number.isSafeInteger(reading.hits) ||
    reading.hits < 0 ||
    !Number.isSafeInteger(reading.limit) ||
    reading.limit < FRAUD_VELOCITY_LIMIT_MINIMUM
  ) {
    throw lookupFailure();
  }

  return reading;
}

/** The blacklist of STEP 030, asked once for one fingerprint. */
async function cardBlocked(fingerprint: string, lookups: FraudSignalLookups): Promise<boolean> {
  let blocked: boolean;

  try {
    blocked = await lookups.isCardBlocked(fingerprint);
  } catch {
    throw lookupFailure();
  }

  if (typeof blocked !== "boolean") {
    throw lookupFailure();
  }

  return blocked;
}

/** One counter, read once. A failure to read is a failure to clear. */
async function readVelocity(
  subject: FraudVelocitySubject,
  lookups: FraudSignalLookups,
): Promise<FraudVelocityReading> {
  let reading: FraudVelocityReading;

  try {
    reading = await lookups.readVelocity(subject);
  } catch {
    throw lookupFailure();
  }

  return requireReading(reading);
}

function providerSignalResult(attempt: FraudAttempt): FraudSignalResult {
  if (attempt.providerSignal === "fraud") {
    return { signal: "provider_signal", outcome: "reject", detail: "provider_fraud" };
  }

  if (attempt.providerSignal === "suspicious") {
    return { signal: "provider_signal", outcome: "review", detail: "provider_suspicious" };
  }

  return { signal: "provider_signal", outcome: "clear", detail: "provider_clear" };
}

function cardBlacklistResult(attempt: FraudAttempt, blocked: boolean | null): FraudSignalResult {
  if (attempt.cardFingerprint === null || blocked === null) {
    return { signal: "card_blacklist", outcome: "clear", detail: "no_card" };
  }

  return blocked
    ? { signal: "card_blacklist", outcome: "reject", detail: "blacklisted" }
    : { signal: "card_blacklist", outcome: "clear", detail: "not_listed" };
}

/**
 * A card's own velocity.
 *
 * A card used more times in its window than the limit allows is the signature of card testing, so
 * this one rejects: the card is the subject of the attack and refusing it costs nothing that is
 * legitimate.
 */
function cardVelocityResult(attempt: FraudAttempt, reading: FraudVelocityReading | null): FraudSignalResult {
  if (attempt.cardFingerprint === null || reading === null) {
    return { signal: "card_velocity", outcome: "clear", detail: "no_card" };
  }

  return reading.hits >= reading.limit
    ? { signal: "card_velocity", outcome: "reject", detail: "card_over_limit" }
    : { signal: "card_velocity", outcome: "clear", detail: "card_within_limit" };
}

/**
 * An address's velocity.
 *
 * A busy address is often a household, an office or a mobile carrier's NAT, so this one reviews
 * rather than rejects: the pattern is worth a person's look and not worth refusing a payment that
 * may be the fourth member of one family.
 */
function ipVelocityResult(reading: FraudVelocityReading): FraudSignalResult {
  return reading.hits >= reading.limit
    ? { signal: "ip_velocity", outcome: "review", detail: "ip_over_limit" }
    : { signal: "ip_velocity", outcome: "clear", detail: "ip_within_limit" };
}

function threeDsResult(attempt: FraudAttempt): FraudSignalResult {
  if (attempt.threeDsOutcome === "authenticated") {
    return { signal: "three_ds_verification", outcome: "clear", detail: "three_ds_authenticated" };
  }

  if (threeDsVerified(attempt)) {
    return { signal: "three_ds_verification", outcome: "clear", detail: "three_ds_verified_by_billing" };
  }

  return { signal: "three_ds_verification", outcome: "review", detail: "three_ds_unverified" };
}

function amountResult(attempt: FraudAttempt, policy: FraudPolicy): FraudSignalResult {
  return attempt.amountMinor >= policy.reviewAmountMinor
    ? { signal: "amount_review", outcome: "review", detail: "amount_over_review" }
    : { signal: "amount_review", outcome: "clear", detail: "amount_within_limits" };
}

/**
 * Evaluate one attempt.
 *
 * The attempt and the policy are validated first, so no rule below can read a value the platform
 * would not store. Then the signals run in the fixed order of `FRAUD_SIGNALS`, the two lookups are
 * asked only about the subjects the method actually has, and the decision is assembled from the
 * trace rather than chosen in a branch.
 */
export async function evaluateFraudSignals(
  attempt: FraudAttempt,
  options: FraudEvaluationOptions,
): Promise<FraudDecision> {
  requireAttempt(attempt);

  const policy = requirePolicy(options.policy ?? FRAUD_DEFAULT_POLICY);

  const blocked = attempt.cardFingerprint === null ? null : await cardBlocked(attempt.cardFingerprint, options.lookups);
  const cardReading =
    attempt.cardFingerprint === null
      ? null
      : await readVelocity({ kind: "card", value: attempt.cardFingerprint }, options.lookups);
  const ipReading = await readVelocity({ kind: "ip", value: attempt.ipAddress }, options.lookups);

  const signals: readonly FraudSignalResult[] = [
    providerSignalResult(attempt),
    cardBlacklistResult(attempt, blocked),
    cardVelocityResult(attempt, cardReading),
    ipVelocityResult(ipReading),
    threeDsResult(attempt),
    amountResult(attempt, policy),
  ];

  const decision = fraudDecisionOf(signals);

  return deepFreeze({
    decision,
    // A review is a hold, and the 3D Secure rule is one of the signals above: an `allow` therefore
    // already means the payment authenticated or the address pair matched. `threeDsVerified` is
    // exported for the caller that clears a review and captures afterwards, where the database
    // check still has to pass.
    captureAllowed: decision === "allow",
    signals,
    reasons: signals.filter((result) => result.outcome !== "clear").map((result) => result.detail),
  });
}

/**
 * The audit row for a decision that was not `allow`.
 *
 * A cleared payment needs no entry of its own: the payment row is the record, and its own write is
 * audited by the payment STEP. A held or refused payment is the case a person will ask about later,
 * so it gets the trace, the amount in minor units as a string (a `bigint` is not JSON), the method
 * and the fingerprint the decision was made on - and no address beyond the canonical one the audit
 * module already validates.
 */
export function fraudAuditEntry(
  attempt: FraudAttempt,
  decision: FraudDecision,
  context: FraudAuditContext = {},
): FraudAuditEntry | null {
  if (decision.decision === "allow") {
    return null;
  }

  const paymentId = context.paymentId ?? null;

  return {
    action: FRAUD_AUDIT_ACTION,
    actorUserId: context.actorUserId ?? null,
    entityType: paymentId === null ? null : "payment",
    entityId: paymentId,
    payload: {
      rule: FRAUD_RULE,
      decision: decision.decision,
      capture_allowed: decision.captureAllowed,
      payment_method: attempt.paymentMethod,
      amount_minor: attempt.amountMinor.toString(),
      currency: attempt.currency,
      three_ds_outcome: attempt.threeDsOutcome,
      postal_code_matched: attempt.postalCodeMatched,
      ip_country_matched: attempt.ipCountryMatched,
      card_fingerprint: attempt.cardFingerprint,
      signals: decision.signals.map((result) => ({
        signal: result.signal,
        outcome: result.outcome,
        detail: result.detail,
      })),
      reasons: decision.reasons,
    },
    companyId: attempt.companyId,
    sessionId: context.sessionId ?? null,
    ipAddress: context.ipAddress ?? null,
    userAgent: context.userAgent ?? null,
  };
}
