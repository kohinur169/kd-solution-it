// path: config/app.ts
import { PLATFORM_RELEASE_STAGE, PLATFORM_SERVICE_SLUG } from "../lib/constants/platform.ts";
import { deepFreeze } from "../lib/utils/freeze.ts";

/**
 * Central application configuration: values that do not come from the environment.
 *
 * This module is safe to import from a client component. It holds no secret, reads no
 * environment variable and touches no Node API. Anything derived from the environment lives
 * in config/server.ts, which is server only, and secrets stay in lib/env/server.ts where
 * they are needed.
 *
 * Every value below either quotes the feature list section that fixes it, or is marked as a
 * platform default that a database setting can override at runtime. A number without that
 * note is a decision taken in this STEP and can be argued with in a later one.
 *
 * Money is a string with the exact numeric(18,4) scale. It is never a JavaScript number,
 * because a configuration value would otherwise seed floating point arithmetic into the
 * ledger.
 */

export type AppEnvironmentName = "development" | "test" | "production";

export interface AppConfig {
  readonly platform: {
    readonly name: string;
    readonly serviceSlug: string;
    readonly releaseStage: string;
    readonly defaultLocale: "en";
  };
  readonly money: {
    readonly currencyCode: "USD";
    readonly precision: 18;
    readonly scale: 4;
    readonly minimumPartialPayment: string;
    readonly minimumPayoutAmount: string;
  };
  readonly lists: {
    readonly defaultPageSize: number;
    readonly maximumPageSize: number;
    readonly importBatchSize: number;
  };
  readonly security: {
    readonly loginLock: {
      readonly consecutiveFailureLimit: number;
      readonly lockDurationMinutes: number;
    };
    /**
     * FEATURE_LIST section 18: card and IP velocity limits, with defaults in config. The hit that reaches a
     * limit is the attempt the payment page refuses, so a card limit of five allows four charged attempts in
     * an hour; `lib/security/velocity.ts` states the same numbers as the platform's baseline and a gate keeps
     * the two equal.
     */
    readonly velocity: {
      readonly card: { readonly limit: number; readonly windowSeconds: number };
      readonly ip: { readonly limit: number; readonly windowSeconds: number };
    };
  };
  readonly payouts: {
    readonly bankChangeCoolingPeriodHours: number;
    readonly defaultSettlementHoldDays: number;
  };
  readonly reconciliation: {
    readonly mismatchResolutionDays: number;
  };
  readonly disputes: {
    readonly responseWindowHours: number;
    readonly extendedResponseWindowHours: number;
  };
  readonly billing: {
    readonly subscriptionWarningDays: number;
  };
  readonly caching: {
    readonly publicPageRevalidateSeconds: number;
    readonly dashboardSummarySeconds: number;
  };
  readonly jobs: {
    readonly defaultMaxAttempts: number;
    readonly retryBaseDelaySeconds: number;
    readonly retryMaxDelaySeconds: number;
    readonly jobTimeoutSeconds: number;
    readonly workerConcurrency: number;
    readonly stalledAfterSeconds: number;
  };
}

const configuredAppConfig = {
  platform: {
    name: "KD Solution IT",
    serviceSlug: PLATFORM_SERVICE_SLUG,
    releaseStage: PLATFORM_RELEASE_STAGE,
    defaultLocale: "en",
  },
  money: {
    // FEATURE_LIST section 1: USD only, stored as numeric(18,4), decimal library only.
    currencyCode: "USD",
    precision: 18,
    scale: 4,
    // FEATURE_LIST section 16: partial payments are accepted with a minimum of 20 USD.
    minimumPartialPayment: "20.0000",
    // FEATURE_LIST section 10: minimum payout amount is 100 USD.
    minimumPayoutAmount: "100.0000",
  },
  lists: {
    // FEATURE_LIST section 28: pagination on every list and a maximum page size in config.
    defaultPageSize: 25,
    maximumPageSize: 100,
    // Platform default for CSV import batches (FEATURE_LIST section 15 needs row level
    // reporting, which a bounded batch keeps practical).
    importBatchSize: 500,
  },
  security: {
    // FEATURE_LIST section 22: two consecutive failures lock the account for two hours.
    loginLock: {
      consecutiveFailureLimit: 2,
      lockDurationMinutes: 120,
    },
    // FEATURE_LIST section 18: one card, five attempts an hour; one address, twenty. The window is aligned to
    // the epoch by the counter itself, so these are a length and not an instant.
    velocity: {
      card: { limit: 5, windowSeconds: 3_600 },
      ip: { limit: 20, windowSeconds: 3_600 },
    },
  },
  payouts: {
    // FEATURE_LIST section 10: the 96 hour cooling period starts after manual verification.
    bankChangeCoolingPeriodHours: 96,
    // Platform default until super_admin sets settlement hold days globally or per merchant.
    defaultSettlementHoldDays: 2,
  },
  reconciliation: {
    // FEATURE_LIST section 11: a mismatch must be resolved within 3 days.
    mismatchResolutionDays: 3,
  },
  disputes: {
    // FEATURE_LIST section 19: 24 hours in the merchant time zone, 48 hours by decision.
    responseWindowHours: 24,
    extendedResponseWindowHours: 48,
  },
  billing: {
    // FEATURE_LIST section 12: warnings start 7 days before the due date.
    subscriptionWarningDays: 7,
  },
  caching: {
    // FEATURE_LIST section 28: cache public pages, and use a short lived cache for dashboard
    // summaries. Lifetimes are platform defaults.
    publicPageRevalidateSeconds: 300,
    dashboardSummarySeconds: 30,
  },
  jobs: {
    // FEATURE_LIST section 27 and 32: background work is retried with a limit, and a stalled job
    // must be visible to monitoring. These are platform defaults; the queue table that stores the
    // work arrives in STEP 012.
    defaultMaxAttempts: 5,
    retryBaseDelaySeconds: 15,
    retryMaxDelaySeconds: 900,
    jobTimeoutSeconds: 120,
    workerConcurrency: 4,
    stalledAfterSeconds: 300,
  },
} as const satisfies AppConfig;

const usdAmountPattern = /^(0|[1-9]\d{0,13})\.\d{4}$/u;

function collectInvariantViolations(config: AppConfig): readonly string[] {
  const violations: string[] = [];

  const requirePositive = (path: string, value: number, minimum: number): void => {
    if (!Number.isInteger(value) || value < minimum) {
      violations.push(`${path} must be an integer of at least ${minimum}, received ${value}`);
    }
  };

  const requireUsdAmount = (path: string, value: string): void => {
    if (!usdAmountPattern.test(value)) {
      violations.push(`${path} must be a USD amount string with 4 decimals, received "${value}"`);
      return;
    }
    if (/^0+\.0+$/u.test(value)) {
      violations.push(`${path} must be greater than zero, received "${value}"`);
    }
  };

  if (config.platform.defaultLocale !== "en") {
    violations.push('platform.defaultLocale must be "en": the platform is English only');
  }
  if (config.platform.serviceSlug.trim().length === 0) {
    violations.push("platform.serviceSlug must not be empty");
  }

  if (config.money.currencyCode !== "USD") {
    violations.push('money.currencyCode must be "USD": the platform is USD only');
  }
  if (config.money.scale !== 4) {
    violations.push("money.scale must be 4 to match numeric(18,4)");
  }
  if (config.money.precision !== 18) {
    violations.push("money.precision must be 18 to match numeric(18,4)");
  }
  requireUsdAmount("money.minimumPartialPayment", config.money.minimumPartialPayment);
  requireUsdAmount("money.minimumPayoutAmount", config.money.minimumPayoutAmount);

  requirePositive("lists.defaultPageSize", config.lists.defaultPageSize, 1);
  requirePositive("lists.maximumPageSize", config.lists.maximumPageSize, 1);
  requirePositive("lists.importBatchSize", config.lists.importBatchSize, 1);
  if (config.lists.defaultPageSize > config.lists.maximumPageSize) {
    violations.push(
      `lists.defaultPageSize (${config.lists.defaultPageSize}) must not exceed lists.maximumPageSize (${config.lists.maximumPageSize})`,
    );
  }

  requirePositive(
    "security.loginLock.consecutiveFailureLimit",
    config.security.loginLock.consecutiveFailureLimit,
    1,
  );
  requirePositive(
    "security.loginLock.lockDurationMinutes",
    config.security.loginLock.lockDurationMinutes,
    1,
  );
  // The bounds the counter table enforces: `0056` refuses a limit below one and a window outside one second
  // to thirty days, so a configuration that would fail there fails here first.
  for (const subject of ["card", "ip"] as const) {
    requirePositive(`security.velocity.${subject}.limit`, config.security.velocity[subject].limit, 1);
    if (
      !Number.isInteger(config.security.velocity[subject].windowSeconds) ||
      config.security.velocity[subject].windowSeconds < 1 ||
      config.security.velocity[subject].windowSeconds > 2_592_000
    ) {
      violations.push(`security.velocity.${subject}.windowSeconds must be 1 to 2592000 seconds`);
    }
  }

  requirePositive(
    "payouts.bankChangeCoolingPeriodHours",
    config.payouts.bankChangeCoolingPeriodHours,
    1,
  );
  if (!Number.isInteger(config.payouts.defaultSettlementHoldDays) || config.payouts.defaultSettlementHoldDays < 0) {
    violations.push("payouts.defaultSettlementHoldDays must be an integer of at least 0");
  }

  requirePositive(
    "reconciliation.mismatchResolutionDays",
    config.reconciliation.mismatchResolutionDays,
    1,
  );

  requirePositive("disputes.responseWindowHours", config.disputes.responseWindowHours, 1);
  requirePositive(
    "disputes.extendedResponseWindowHours",
    config.disputes.extendedResponseWindowHours,
    1,
  );
  if (config.disputes.extendedResponseWindowHours < config.disputes.responseWindowHours) {
    violations.push(
      "disputes.extendedResponseWindowHours must not be shorter than disputes.responseWindowHours",
    );
  }

  requirePositive("billing.subscriptionWarningDays", config.billing.subscriptionWarningDays, 1);

  if (
    !Number.isInteger(config.caching.publicPageRevalidateSeconds) ||
    config.caching.publicPageRevalidateSeconds < 0
  ) {
    violations.push("caching.publicPageRevalidateSeconds must be an integer of at least 0");
  }
  if (
    !Number.isInteger(config.caching.dashboardSummarySeconds) ||
    config.caching.dashboardSummarySeconds < 0
  ) {
    violations.push("caching.dashboardSummarySeconds must be an integer of at least 0");
  }

  requirePositive("jobs.defaultMaxAttempts", config.jobs.defaultMaxAttempts, 1);
  if (config.jobs.defaultMaxAttempts > 20) {
    violations.push("jobs.defaultMaxAttempts must not exceed 20, so a bad job cannot loop for a day");
  }
  requirePositive("jobs.retryBaseDelaySeconds", config.jobs.retryBaseDelaySeconds, 1);
  requirePositive("jobs.retryMaxDelaySeconds", config.jobs.retryMaxDelaySeconds, 1);
  if (config.jobs.retryMaxDelaySeconds < config.jobs.retryBaseDelaySeconds) {
    violations.push(
      "jobs.retryMaxDelaySeconds must not be shorter than jobs.retryBaseDelaySeconds",
    );
  }
  requirePositive("jobs.jobTimeoutSeconds", config.jobs.jobTimeoutSeconds, 1);
  requirePositive("jobs.workerConcurrency", config.jobs.workerConcurrency, 1);
  if (config.jobs.workerConcurrency > 64) {
    violations.push("jobs.workerConcurrency must not exceed 64");
  }
  requirePositive("jobs.stalledAfterSeconds", config.jobs.stalledAfterSeconds, 1);

  return violations;
}

/**
 * Throws when the configuration contradicts itself. Called at module load below, so an
 * impossible combination fails on the first import instead of surfacing as a wrong number
 * inside a money flow weeks later.
 */
export function assertAppConfigInvariants(config: AppConfig): void {
  const violations = collectInvariantViolations(config);

  if (violations.length > 0) {
    throw new Error(
      `Invalid application configuration (${violations.length} problem(s)): ${violations.join("; ")}`,
    );
  }
}

export const appConfig: AppConfig = deepFreeze(configuredAppConfig);

assertAppConfigInvariants(appConfig);
