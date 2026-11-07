// path: services/disputes/chargeback-fields.ts
import type { PlatformRole } from "../../lib/auth/types.ts";
import { deepFreeze } from "../../lib/utils/freeze.ts";

/**
 * The browser-safe vocabulary of section 18's chargeback programme.
 *
 * ## What section 18 asks for, and what follows from it
 *
 * One sentence: "Chargeback handling follows international card network rules: rate and transaction count are
 * both considered, a minimum transaction count must be reached before a percentage threshold applies, and action
 * is graduated: warning and monitoring, then extra reserve, then suspension. Every threshold value is
 * configurable by super_admin." Four things follow, and each has a name in this file:
 *
 *   1. **A rate and a count, both looked at.** A rate is a division, so the two halves are separate numbers:
 *      `CHARGEBACK_KINDS` is the ladder, and the measurement carries `paymentsCount`, `chargebacksCount` and
 *      `rateBps` rather than a single percentage.
 *   2. **A minimum before a percentage.** `minimumTransactions` is not a threshold on the rate; it is the gate
 *      in front of it, which is why the decision function asks it first and returns `null` below it.
 *   3. **Three steps, in one order.** `chargebackRank` is the order, and `0128`'s check constraint uses the same
 *      three names, so a step this module can name is a step the table accepts.
 *   4. **Every threshold configurable.** The seven numbers live in `platform_settings` (`0080`) under the
 *      `chargeback.*` keys below, each with a default and a bound here, so the settings are typed at the edge of
 *      the platform rather than inside a screen.
 *
 * ## Why basis points
 *
 * Percentages are integers here, in hundredths of a percent: `241` is 2.41 percent. `0128` stores the same unit
 * and re-derives the step from it, so no float ever decides whether a merchant is suspended - which matters
 * because the alternative is a rounding difference deciding it.
 *
 * ## What is deliberately absent
 *
 * No money, no currency and no wallet: this file is about counting transactions, and the reserve step's percent
 * is a term of `0044`'s agreement. No dispute status vocabulary either - a chargeback here is a `0039` dispute
 * row, and its status is `dispute-fields.ts`'s business.
 */

/** The table the graduated actions live in. */
export const CHARGEBACK_ACTIONS_TABLE = "chargeback_actions";

/** The audit entity name of one action. */
export const CHARGEBACK_ACTION_ENTITY = "chargeback_action";

/** The three steps of section 18, in the order they are climbed. */
export const CHARGEBACK_KINDS = deepFreeze(["warning", "reserve", "suspension"] as const);

export type ChargebackKind = (typeof CHARGEBACK_KINDS)[number];

/**
 * How a step was taken.
 *
 * `automatic` is the platform acting on its own clock, which is what a warning and an extra reserve are.
 * `manual` is a named officer, which a suspension always is: `0111` refuses a suspension with no actor, so the
 * platform cannot stop a merchant's business without a person's name on it.
 */
export const CHARGEBACK_MODES = deepFreeze(["automatic", "manual"] as const);

export type ChargebackMode = (typeof CHARGEBACK_MODES)[number];

/** The one role that sets the thresholds: section 18's "configurable by super_admin". */
export const CHARGEBACK_POLICY_ROLES: readonly PlatformRole[] = deepFreeze([
  "super_admin",
] as const satisfies readonly PlatformRole[]);

/** The roles that may read the watchlist: the desk that watches, the desk that answers, and oversight. */
export const CHARGEBACK_READ_ROLES: readonly PlatformRole[] = deepFreeze([
  "super_admin",
  "compliance_kyc",
  "ceo",
] as const satisfies readonly PlatformRole[]);

/** The one role that may take the manual step, which is the suspension. */
export const CHARGEBACK_SUSPEND_ROLES: readonly PlatformRole[] = deepFreeze([
  "super_admin",
] as const satisfies readonly PlatformRole[]);

/** The steps a named officer may clear once the rate has come back down. */
export const CHARGEBACK_CLEARABLE_KINDS = deepFreeze(["warning", "reserve"] as const);

/** Whether a word is one of the three steps. */
export function isChargebackKind(value: unknown): value is ChargebackKind {
  return typeof value === "string" && (CHARGEBACK_KINDS as readonly string[]).includes(value);
}

/** Whether a word is one of the two modes. */
export function isChargebackMode(value: unknown): value is ChargebackMode {
  return typeof value === "string" && (CHARGEBACK_MODES as readonly string[]).includes(value);
}

/** Whether a step may be cleared by a person, which a suspension may not: `0111` owns that return. */
export function isClearableKind(kind: ChargebackKind): boolean {
  return (CHARGEBACK_CLEARABLE_KINDS as readonly string[]).includes(kind);
}

/** The ladder's rank: 1 for the warning, 2 for the reserve, 3 for the suspension. */
export function chargebackRank(kind: ChargebackKind): number {
  switch (kind) {
    case "warning":
      return 1;
    case "reserve":
      return 2;
    case "suspension":
      return 3;
  }
}

/* -------------------------------------------------------------------------------------------------
 * The seven configurable numbers
 * ---------------------------------------------------------------------------------------------- */

/**
 * One threshold the super administrator owns.
 *
 * `maximum` is the top of the range, and `minimum` the bottom: they are bounds rather than suggestions because
 * a policy of zero would warn every merchant every day, and a policy above 100 percent would never warn anybody,
 * and both are silent failures rather than visible ones.
 */
export interface ChargebackThresholdDefinition {
  readonly key: string;
  /** The value when the platform has never been configured, which is the side that acts less. */
  readonly fallback: number;
  readonly minimum: number;
  readonly maximum: number;
  /** The unit the screen prints beside the field. */
  readonly unit: "days" | "count" | "bps" | "percent";
}

/** The settings keys, in the order a screen asks for them. */
export const CHARGEBACK_THRESHOLD_KEYS = deepFreeze({
  windowDays: "chargeback.window_days",
  minimumTransactions: "chargeback.minimum_transactions",
  warningRateBps: "chargeback.warning_rate_bps",
  reserveRateBps: "chargeback.reserve_rate_bps",
  suspensionRateBps: "chargeback.suspension_rate_bps",
  reservePercentBps: "chargeback.reserve_percent_bps",
  reserveDays: "chargeback.reserve_days",
} as const);

/**
 * The seven numbers, their defaults and their bounds.
 *
 * The provider-neutral card network practice is a 1 percent warning bar, a 1.5 percent reserve bar and a 2.5
 * percent suspension bar over thirty days with a hundred transactions behind them; those are the defaults
 * because they are the numbers a merchant's acquirer would quote, and every one of them is a setting rather
 * than a constant because section 18 says so.
 */
export const CHARGEBACK_THRESHOLDS = deepFreeze({
  windowDays: { key: CHARGEBACK_THRESHOLD_KEYS.windowDays, fallback: 30, minimum: 1, maximum: 365, unit: "days" },
  minimumTransactions: {
    key: CHARGEBACK_THRESHOLD_KEYS.minimumTransactions,
    fallback: 100,
    minimum: 0,
    maximum: 100_000,
    unit: "count",
  },
  warningRateBps: { key: CHARGEBACK_THRESHOLD_KEYS.warningRateBps, fallback: 100, minimum: 1, maximum: 10_000, unit: "bps" },
  reserveRateBps: { key: CHARGEBACK_THRESHOLD_KEYS.reserveRateBps, fallback: 150, minimum: 1, maximum: 10_000, unit: "bps" },
  suspensionRateBps: {
    key: CHARGEBACK_THRESHOLD_KEYS.suspensionRateBps,
    fallback: 250,
    minimum: 1,
    maximum: 10_000,
    unit: "percent",
  },
  reservePercentBps: {
    key: CHARGEBACK_THRESHOLD_KEYS.reservePercentBps,
    fallback: 1_000,
    minimum: 0,
    maximum: 10_000,
    unit: "percent",
  },
  reserveDays: { key: CHARGEBACK_THRESHOLD_KEYS.reserveDays, fallback: 30, minimum: 1, maximum: 365, unit: "days" },
} as const satisfies Readonly<Record<string, ChargebackThresholdDefinition>>);

/** The seven numbers, as a caller passes them around. */
export interface ChargebackPolicyValues {
  readonly windowDays: number;
  readonly minimumTransactions: number;
  readonly warningRateBps: number;
  readonly reserveRateBps: number;
  readonly suspensionRateBps: number;
  readonly reservePercentBps: number;
  readonly reserveDays: number;
}

/** The value the platform starts from: nothing configured, and the side that acts less. */
export const CHARGEBACK_POLICY_DEFAULTS: ChargebackPolicyValues = deepFreeze({
  windowDays: CHARGEBACK_THRESHOLDS.windowDays.fallback,
  minimumTransactions: CHARGEBACK_THRESHOLDS.minimumTransactions.fallback,
  warningRateBps: CHARGEBACK_THRESHOLDS.warningRateBps.fallback,
  reserveRateBps: CHARGEBACK_THRESHOLDS.reserveRateBps.fallback,
  suspensionRateBps: CHARGEBACK_THRESHOLDS.suspensionRateBps.fallback,
  reservePercentBps: CHARGEBACK_THRESHOLDS.reservePercentBps.fallback,
  reserveDays: CHARGEBACK_THRESHOLDS.reserveDays.fallback,
} as const);

/* -------------------------------------------------------------------------------------------------
 * Rules, audit names and the sizes of a body
 * ---------------------------------------------------------------------------------------------- */

/**
 * The refusal vocabulary of this STEP.
 *
 * A rule is a machine word a screen maps to a sentence, exactly as the dispute routes do: the rule never
 * carries the numbers, because the screen has the measurement in its own hands and a rule that repeated them
 * would be a second place the rate is formatted.
 */
export const CHARGEBACK_RULES = deepFreeze({
  /** The merchant's rate is under the lowest bar, so nothing is owed. */
  belowThreshold: "chargeback_below_threshold",
  /** The transaction count is under the minimum, so no percentage applies. */
  minimumNotReached: "chargeback_minimum_not_reached",
  /** This step is already live for this merchant. */
  stepTaken: "chargeback_step_taken",
  /** The merchant is suspended: the ladder has nowhere further to go. */
  suspended: "chargeback_suspended",
  /** No merchant with this id, or not one this platform may measure. */
  companyMissing: "chargeback_company_missing",
  /** A window larger than the page limit, so the count is not the whole count. */
  measurementTruncated: "chargeback_measurement_truncated",
  /** The thresholds a screen submitted do not read as a policy. */
  policyInvalid: "chargeback_policy_invalid",
  /** The step is not one a person may clear. */
  notClearable: "chargeback_not_clearable",
  /** The action was already cleared once. */
  alreadyCleared: "chargeback_already_cleared",
  /** A suspension request without the officer's own sentence. */
  suspensionReasonRequired: "chargeback_suspension_reason_required",
} as const);

/** The audit names of this STEP's four acts. */
export const CHARGEBACK_AUDIT = deepFreeze({
  policySaved: "chargeback.policy_saved",
  actionApplied: "chargeback.action_applied",
  actionCleared: "chargeback.action_cleared",
  sweepRun: "chargeback.sweep_run",
} as const);

/**
 * The email a warning queues.
 *
 * `0061` closes the template vocabulary at twenty names and none of them is "chargeback notice", so the
 * closest honest one is the dispute update: the merchant is being told about chargebacks either way. A
 * dedicated template is a later STEP's migration, and this constant is the one line that changes when it lands.
 */
export const CHARGEBACK_TEMPLATE_KEY = "dispute_update";

/** The longest sentence a stored step carries. `0128` checks the same 280 characters. */
export const CHARGEBACK_DETAIL_MAXIMUM_LENGTH = 280;

/** The longest reason a screen may send with a suspension or a clear. */
export const CHARGEBACK_NOTE_MAXIMUM_LENGTH = 280;

/** The body ceiling of the two routes of this STEP. */
export const CHARGEBACK_POLICY_MAXIMUM_BODY_BYTES = 1_024;
export const CHARGEBACK_APPLY_MAXIMUM_BODY_BYTES = 1_024;

/** The field every refusal of this STEP names. */
export const CHARGEBACK_FIELD = "chargeback";

/** How many rows one page of the measurement reads, and how many pages it reads at most. */
export const CHARGEBACK_COUNT_PAGE_SIZE = 500;
export const CHARGEBACK_COUNT_MAXIMUM_PAGES = 40;

/** How many merchants the watchlist prints, and how many steps of one merchant the history prints. */
export const CHARGEBACK_WATCHLIST_LIMIT = 100;
export const CHARGEBACK_HISTORY_LIMIT = 20;

/** How many dispute ids one `in.(...)` filter carries: the same shape the rest of this service uses. */
export const CHARGEBACK_IN_LIST_LIMIT = 200;
