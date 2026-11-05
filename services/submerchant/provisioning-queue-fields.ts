// path: services/submerchant/provisioning-queue-fields.ts
/**
 * The vocabulary of the provisioning queue and its office alert.
 *
 * `0054` wrote the sentence this STEP implements: *"The queue the office alert reads: queued and retrying
 * rows, oldest attempt first"*, above an index nobody had read. FEATURE_LIST line 70 turns that sentence
 * into a promise - *"If no master platform account is connected, provisioning stays queued and the office
 * is alerted"* - and a promise with no reader is the defect this module exists to close.
 *
 * This file holds names, numbers and one classification function, and it imports nothing at runtime - the
 * one import it has is a type, erased before anything ships. The alert service, the office screen and the
 * gate all import it, so it must stay weightless.
 */

import type { PlatformRole } from "../../lib/auth/types.ts";

/** The table of `0054`, and the account table the alert names. */
export const PROVISIONING_QUEUE_TABLE = "submerchant_provisions";
export const PROVISIONING_COMPANIES_TABLE = "companies";

/**
 * The queue is exactly the index's predicate: `status = 'pending' and deleted_at is null`.
 *
 * `0054` also leaves `master_account_ref` nullable, and **that** nullability is the distinction this STEP
 * turns on. A pending row with a `master_account_ref` is **waiting for the provider** - a master platform
 * account is connected, an attempt has been made or is scheduled, and its silence is normal. A pending
 * row with no `master_account_ref` is **waiting for a human**: `runSubmerchantProvisioning` writes it
 * that way when no master platform account is connected for that provider, and nothing in the platform
 * will ever move it.
 *
 * Collapsing the two would alert the office about every provisioning in flight, which is noise, and the
 * office would stop reading the screen. The null is the signal.
 */
export const PROVISIONING_QUEUE_STATUS = "pending";

/** How many queued rows one read returns, so a merchant with a long backlog cannot make the page slow. */
export const PROVISIONING_QUEUE_LIMIT = 100;

/** How many companies one read resolves for display, bounded for the same reason. */
export const PROVISIONING_COMPANY_LIMIT = 100;

/**
 * How long a blocked row may sit before it counts as a problem rather than a moment.
 *
 * A row is written and the alert is read minutes later in a healthy system. One day is long enough that
 * an ordinary deployment, a weekend or a provider outage does not page anybody, and short enough that a
 * genuinely stuck merchant is visible the next morning. The screen shows both counts and labels them, so
 * "one hour" is not silently presented as "stuck".
 */
export const PROVISIONING_BLOCKED_AFTER_HOURS = 24;

/** The two provider accounts the alert is about, named in the order a reader looks for them. */
export const PROVISIONING_PROVIDER_KEYS = Object.freeze([
  "nmi",
  "payoneer",
  "rainforest",
  "stripe_connect",
  "airwallex",
] as const);

export type ProvisioningProviderKey = (typeof PROVISIONING_PROVIDER_KEYS)[number];

/** True when a string is one of the five provider keys `0054` allows. */
export function isProvisioningProviderKey(value: unknown): value is ProvisioningProviderKey {
  return typeof value === "string" && (PROVISIONING_PROVIDER_KEYS as readonly string[]).includes(value);
}

/**
 * Why a queued row is waiting, in the three terms the screen uses.
 *
 * The vocabulary is closed rather than free text because the page groups by it: a support officer opens
 * the screen to answer "is this merchant blocked on us, on the provider, or on nothing at all", and an
 * answer that is a sentence cannot be counted.
 *
 *   - `no_master_account`: no master platform account is connected for this provider. This is the case
 *     FEATURE_LIST line 70 is about, and the only one that is the platform's fault.
 *   - `awaiting_provider`: there is a master account and an attempt is scheduled. Normal.
 *   - `attempts_exhausted`: the provider kept failing. A different conversation with the merchant.
 */
export type ProvisioningWaitReason = "no_master_account" | "awaiting_provider" | "attempts_exhausted";

/**
 * Classify one queued row.
 *
 * The order matters. A row with no master account is blocked whatever its attempt count says, because no
 * number of retries will conjure an account; that check therefore comes first, and `0054`'s
 * `submerchant_provisions_attempt_check` (`attempted_at is null or master_account_ref is not null`) makes
 * the two facts coherent in the database as well.
 */
export function provisioningWaitReasonOf(row: {
  readonly master_account_ref: string | null;
  readonly attempt_count: number;
}): ProvisioningWaitReason {
  if (row.master_account_ref === null) {
    return "no_master_account";
  }

  // `0054`'s `submerchant_provisions_attempt_check` ties `attempt_count` to `attempted_at`, so a count at
  // or above the ceiling is a row the provider has refused that many times - and since `0054` leaves
  // `next_attempt_at` nullable while a status of `pending`, both "still retrying" and "gave up" appear
  // as a queued row. Only the count separates them.
  return row.attempt_count >= PROVISIONING_MAX_ATTEMPTS ? "attempts_exhausted" : "awaiting_provider";
}

/** The screen's wording for each reason, so the page holds no second copy of the vocabulary. */
export function provisioningReasonLabelKey(reason: ProvisioningWaitReason):
  | "officeProvisioning.reasonNoMasterAccount"
  | "officeProvisioning.reasonAttemptsExhausted"
  | "officeProvisioning.reasonAwaitingProvider" {
  switch (reason) {
    case "no_master_account":
      return "officeProvisioning.reasonNoMasterAccount";
    case "attempts_exhausted":
      return "officeProvisioning.reasonAttemptsExhausted";
    case "awaiting_provider":
      return "officeProvisioning.reasonAwaitingProvider";
  }
}

/**
 * How many attempts the platform makes before a queued row is a failure to report.
 *
 * Five, matching `config/app.ts`'s `jobs.defaultMaxAttempts`, and restated here rather than imported so
 * the classification has no configuration dependency: a queue screen that could not render because the
 * environment was misread would be useless in exactly the situation it is needed.
 */
export const PROVISIONING_MAX_ATTEMPTS = 5;

/** The threshold above which a blocked row is shown as overdue, in milliseconds. */
export const PROVISIONING_BLOCKED_AFTER_MS = PROVISIONING_BLOCKED_AFTER_HOURS * 60 * 60 * 1000;

/** The office roles that may see the alert. It is the KYC office, not the whole office. */
export const PROVISIONING_ALERT_OFFICE_ROLES: readonly PlatformRole[] = Object.freeze([
  "super_admin",
  "ceo",
  "compliance_kyc",
  "support",
]);

/** The audit action written when the office acknowledges a blocked row. */
export const PROVISIONING_ALERT_ACKNOWLEDGED_AUDIT_ACTION = "submerchant_provision.alert_acknowledged";

/** The audit entity name, the same one `0054`'s queue writes under. */
export const PROVISIONING_ALERT_AUDIT_ENTITY = "submerchant_provision";

/** A note on an acknowledgement, bounded so a queue row cannot become a mailbox. */
export const PROVISIONING_ACKNOWLEDGEMENT_NOTE_LIMITS = Object.freeze({ min: 1, max: 280 });
