// path: services/kyc/merchant-category.ts
import { z } from "zod";
import type { AuditTrail } from "../../lib/auth/audit.ts";
import { isConflictError, type RestClient } from "../../lib/auth/rest.ts";
import { requireAnyRole, requireCompanyId } from "../../lib/auth/session.ts";
import type { RequestActor } from "../../lib/auth/types.ts";
import type { ErrorDetail } from "../../lib/errors/app-error.ts";
import { AppError } from "../../lib/errors/app-error.ts";
import { sanitizeSingleLineText } from "../../lib/security/text.ts";
import { BUSINESS_PROFILE_TABLE } from "./business-profile.ts";
import {
  ONBOARDING_OWNER_ROLES,
  ONBOARDING_PROGRESS_TABLE,
  nextOnboardingStep,
  type OnboardingStep,
} from "./onboarding-steps.ts";

/**
 * Section 5's merchant category code: one published four digit code per merchant, stored on the
 * business profile row of `0103` and chosen from the vocabulary `0077` seeded.
 *
 * ## What this module owns
 *
 * `0104` added `business_profiles.mcc_code` with a foreign key to `public.mcc_codes (code)`. This
 * file is the only reader and writer of that column: it lists the active codes for the dropdown,
 * validates the one the merchant chose against the vocabulary, patches the profile row, and marks
 * the wizard's `category` step finished exactly when a code is set - the same mirror STEP 080's
 * service keeps for the `business` step.
 *
 * ## Why one column on the profile and not a table of its own
 *
 * Section 5 asks for the code "in merchant onboarding and profile settings", and the profile row is
 * the one place the platform stores what a merchant fills once. One column means the onboarding
 * category form and any profile settings screen edit the same value, and every section 6 adapter
 * reads the same four digits when it opens a sub-merchant.
 *
 * ## Why the vocabulary is read, never copied
 *
 * The 981 codes and their titles are data in `mcc_codes`, frozen by `0077`'s guard. A copy in this
 * file would drift from the list the card networks publish; instead the dropdown is a read of the
 * active rows and a save refuses a code the list does not carry - `unknown_code` when no row holds
 * the code at all, `retired_code` when the row exists but `is_active` is false. A merchant who
 * already chose a code that is retired later keeps it: the foreign key stays valid, and only new
 * choices are refused.
 *
 * ## Why a save is a patch of one column
 *
 * The body is `{ mcc_code }` and nothing else. STEP 080's form saves its own fields through its own
 * route, so this save writes `mcc_code` alone and never the seven columns beside it; an empty
 * string is a deliberate clear, which is how a merchant changes their category without a second
 * endpoint.
 *
 * ## The validation, and where its sentences come from
 *
 * The value goes through the section 56 sanitiser and must be exactly four digits, the same shape
 * `0104`'s check constraint keeps. A refusal is `VALIDATION_FAILED` naming the field and the rule,
 * so the form marks the one box it has.
 */

/** The vocabulary table of `0077`. */
export const MCC_CODES_TABLE = "mcc_codes";

/** The audit action a save is recorded under. */
export const MERCHANT_CATEGORY_AUDIT_ACTION = "merchant_category.saved";

/** The audit entity a save is recorded against: the merchant company. */
export const MERCHANT_CATEGORY_AUDIT_ENTITY = "merchant_category";

/** The onboarding step this code completes when one is chosen. */
export const MERCHANT_CATEGORY_ONBOARDING_STEP: OnboardingStep = "category";

/** Four digits as text; leading zeros are part of the code, so `0742` is not `742`. */
export const MCC_CODE_PATTERN = /^[0-9]{4}$/u;

/** The one field a save may carry. */
export const MERCHANT_CATEGORY_FIELD = "mcc_code";

/** One published code, as the dropdown offers it. */
export interface MerchantCategoryOption {
  readonly code: string;
  readonly title: string;
}

/** The category as a screen sees it. */
export interface MerchantCategorySnapshot {
  readonly companyId: string;
  readonly mccCode: string | null;
  readonly mccTitle: string | null;
  readonly options: readonly MerchantCategoryOption[];
  /** True exactly when a code is stored: that is what finishes the category step. */
  readonly complete: boolean;
  readonly saved: boolean;
  readonly savedAtEpochMs: number | null;
}

export interface MerchantCategoryDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now?: () => number;
}

const codeText = z.string().min(4).max(4);

const profileRowSchema = z.object({
  company_id: z.string().min(1).max(64),
  mcc_code: codeText.nullable().optional(),
  updated_at: z.string().min(1).max(40),
});

const optionRowSchema = z.object({
  code: codeText,
  title: z.string().min(1).max(200),
});

const onboardingRowSchema = z.object({
  current_step: z.string().min(1).max(32),
  completed_steps: z.array(z.string().min(1).max(32)).max(6),
});

function epochMs(instant: string | null | undefined): number | null {
  if (instant === null || instant === undefined) {
    return null;
  }

  const parsed = Date.parse(instant);

  if (!Number.isFinite(parsed)) {
    throw new AppError("INTERNAL_ERROR");
  }

  return parsed;
}

/** The actor's own company: `owner` first, then the company on the session, before any query. */
function requireCompany(actor: RequestActor): string {
  requireAnyRole(actor, ONBOARDING_OWNER_ROLES);

  return requireCompanyId(actor);
}

/**
 * The body a route passes, as the one value it may name.
 *
 * A key besides `mcc_code` is refused rather than ignored - a form from another build must be told
 * it is stale, not stored halfway. An empty or whitespace-only string is a deliberate clear and
 * answers null; a null value clears too. Anything that is not four digits after sanitising is a
 * format problem.
 */
export function parseMerchantCategoryInput(
  input: unknown,
): { readonly value: string | null | undefined; readonly problems: readonly ErrorDetail[] } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return {
      value: undefined,
      problems: [{ field: MERCHANT_CATEGORY_FIELD, rule: "invalid_format" }],
    };
  }

  const record = input as Readonly<Record<string, unknown>>;
  const problems: ErrorDetail[] = [];

  for (const key of Object.keys(record)) {
    if (key !== MERCHANT_CATEGORY_FIELD) {
      problems.push({ field: key.slice(0, 64), rule: "unknown_key" });
    }
  }

  if (!Object.hasOwn(record, MERCHANT_CATEGORY_FIELD)) {
    problems.push({ field: MERCHANT_CATEGORY_FIELD, rule: "required" });

    return { value: undefined, problems };
  }

  const raw = record[MERCHANT_CATEGORY_FIELD];

  if (raw !== null && typeof raw !== "string") {
    problems.push({ field: MERCHANT_CATEGORY_FIELD, rule: "invalid_format" });

    return { value: undefined, problems };
  }

  const trimmed = sanitizeSingleLineText(raw ?? "", 8).trim();

  if (trimmed.length === 0) {
    return { value: null, problems };
  }

  if (!MCC_CODE_PATTERN.test(trimmed)) {
    problems.push({ field: MERCHANT_CATEGORY_FIELD, rule: "invalid_format" });

    return { value: undefined, problems };
  }

  return { value: trimmed, problems };
}

/** The active codes in code order: the dropdown. */
async function readOptions(rest: RestClient): Promise<readonly MerchantCategoryOption[]> {
  return rest.select(
    MCC_CODES_TABLE,
    "select=code,title&is_active=is.true&deleted_at=is.null&order=code.asc",
    optionRowSchema,
  );
}

/** The title of one stored code even when it is retired, so an old choice still names itself. */
async function readTitleOf(
  code: string,
  rest: RestClient,
): Promise<string | null> {
  const rows = await rest.select(
    MCC_CODES_TABLE,
    `select=code,title&code=eq.${encodeURIComponent(code)}&deleted_at=is.null&limit=1`,
    optionRowSchema,
  );

  return rows[0]?.title ?? null;
}

/** One live profile row of one company, or null when nothing was ever saved. */
async function readProfileRow(
  companyId: string,
  rest: RestClient,
): Promise<z.infer<typeof profileRowSchema> | null> {
  const rows = await rest.select(
    BUSINESS_PROFILE_TABLE,
    `select=company_id,mcc_code,updated_at&company_id=eq.${encodeURIComponent(companyId)}&deleted_at=is.null&limit=1`,
    profileRowSchema,
  );

  return rows[0] ?? null;
}

function snapshotOf(
  companyId: string,
  row: z.infer<typeof profileRowSchema> | null,
  options: readonly MerchantCategoryOption[],
  titleOverride: string | null,
): MerchantCategorySnapshot {
  const mccCode = row?.mcc_code ?? null;

  return {
    companyId,
    mccCode,
    mccTitle:
      mccCode === null
        ? null
        : (options.find((option) => option.code === mccCode)?.title ?? titleOverride),
    options,
    complete: mccCode !== null,
    saved: row !== null,
    savedAtEpochMs: row === null ? null : epochMs(row.updated_at),
  };
}

/** The caller's own company's category: the stored code, its title, and the dropdown. */
export async function readMerchantCategory(
  input: { readonly actor: RequestActor },
  dependencies: MerchantCategoryDependencies,
): Promise<MerchantCategorySnapshot> {
  const companyId = requireCompany(input.actor);
  const rest = dependencies.rest;
  const [row, options] = await Promise.all([
    readProfileRow(companyId, rest),
    readOptions(rest),
  ]);

  const mccCode = row?.mcc_code ?? null;
  const titleOverride =
    mccCode !== null && options.every((option) => option.code !== mccCode)
      ? await readTitleOf(mccCode, rest)
      : null;

  return snapshotOf(companyId, row, options, titleOverride);
}

/** The onboarding row of one company, or null when the wizard has never been opened. */
async function readOnboardingRow(
  companyId: string,
  rest: RestClient,
): Promise<{ currentStep: string; completedSteps: readonly string[] } | null> {
  const rows = await rest.select(
    ONBOARDING_PROGRESS_TABLE,
    `select=current_step,completed_steps&company_id=eq.${encodeURIComponent(companyId)}&deleted_at=is.null&limit=1`,
    onboardingRowSchema,
  );
  const row = rows[0];

  return row === undefined
    ? null
    : { currentStep: row.current_step, completedSteps: row.completed_steps };
}

/**
 * Keep STEP 079's position row in step with this code.
 *
 * The `category` step is finished exactly when a code is stored, so the wizard and the profile
 * answer "is this step done" the same way. A merchant who opened the wizard has a row to update;
 * one who went straight to the form does not, and gets a row that opens on the next step because
 * this one is done.
 */
async function syncOnboardingStep(
  companyId: string,
  actorUserId: string,
  complete: boolean,
  rest: RestClient,
): Promise<void> {
  const existing = await readOnboardingRow(companyId, rest);
  const step = MERCHANT_CATEGORY_ONBOARDING_STEP;

  if (existing === null) {
    if (!complete) {
      return;
    }

    await rest.insert(ONBOARDING_PROGRESS_TABLE, [
      {
        company_id: companyId,
        updated_by: actorUserId,
        current_step: nextOnboardingStep(step) ?? step,
        completed_steps: [step],
      },
    ]);

    return;
  }

  const has = existing.completedSteps.includes(step);

  if (has === complete) {
    return;
  }

  const completedSteps = complete
    ? [...existing.completedSteps, step]
    : existing.completedSteps.filter((name) => name !== step);

  await rest.update(
    ONBOARDING_PROGRESS_TABLE,
    `company_id=eq.${encodeURIComponent(companyId)}&deleted_at=is.null`,
    {
      completed_steps: completedSteps,
      ...(complete && existing.currentStep === step
        ? { current_step: nextOnboardingStep(step) ?? step }
        : {}),
    },
  );
}

/**
 * Save the one code the body names, and answer the category as it now stands.
 *
 * The save is a patch of `mcc_code` alone: the seven columns STEP 080's form owns are never in the
 * write, so the two screens cannot overwrite each other. The code is checked against the active
 * vocabulary before anything is written - `unknown_code` for a code the list does not carry,
 * `retired_code` for one that is no longer offered. The wizard's `category` step is mirrored, and
 * one audit entry names the code (or the clear), the completion and the instant.
 */
export async function saveMerchantCategory(
  input: {
    readonly actor: RequestActor;
    readonly input: unknown;
    readonly ipAddress: string | null;
    readonly userAgent: string | null;
  },
  dependencies: MerchantCategoryDependencies,
): Promise<MerchantCategorySnapshot> {
  const companyId = requireCompany(input.actor);
  const parsed = parseMerchantCategoryInput(input.input);

  if (parsed.problems.length > 0) {
    throw new AppError("VALIDATION_FAILED", { details: parsed.problems });
  }

  if (parsed.value === undefined) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: MERCHANT_CATEGORY_FIELD, rule: "required" }],
    });
  }

  const value = parsed.value;
  const rest = dependencies.rest;

  if (value !== null) {
    const matches = await rest.select(
      MCC_CODES_TABLE,
      `select=code,is_active&code=eq.${encodeURIComponent(value)}&deleted_at=is.null&limit=1`,
      z.object({ code: codeText, is_active: z.boolean() }),
    );
    const found = matches[0];

    if (found === undefined) {
      throw new AppError("VALIDATION_FAILED", {
        details: [{ field: MERCHANT_CATEGORY_FIELD, rule: "unknown_code" }],
      });
    }

    if (!found.is_active) {
      throw new AppError("VALIDATION_FAILED", {
        details: [{ field: MERCHANT_CATEGORY_FIELD, rule: "retired_code" }],
      });
    }
  }

  const existing = await readProfileRow(companyId, rest);
  const now = (dependencies.now ?? ((): number => Date.now()))();
  const instant = new Date(now).toISOString();
  const complete = value !== null;

  if (existing === null) {
    try {
      await rest.insert(BUSINESS_PROFILE_TABLE, [
        { company_id: companyId, mcc_code: value },
      ]);
    } catch (error) {
      // Two tabs saving their first category at once: the unique index keeps one row, and the
      // second save becomes the update it would have been a moment later.
      if (!isConflictError(error)) {
        throw error;
      }

      await rest.update(
        BUSINESS_PROFILE_TABLE,
        `company_id=eq.${encodeURIComponent(companyId)}&deleted_at=is.null`,
        { mcc_code: value },
      );
    }
  } else {
    await rest.update(
      BUSINESS_PROFILE_TABLE,
      `company_id=eq.${encodeURIComponent(companyId)}&deleted_at=is.null`,
      { mcc_code: value },
    );
  }

  await syncOnboardingStep(companyId, input.actor.userId, complete, rest);

  await dependencies.audit
    .append({
      action: MERCHANT_CATEGORY_AUDIT_ACTION,
      actorUserId: input.actor.userId,
      entityType: MERCHANT_CATEGORY_AUDIT_ENTITY,
      entityId: companyId,
      companyId,
      sessionId: input.actor.sessionId,
      payload: {
        code: value,
        cleared: value === null,
        complete,
        saved_at: instant,
      },
      ...(input.ipAddress === null ? {} : { ipAddress: input.ipAddress }),
      ...(input.userAgent === null ? {} : { userAgent: input.userAgent }),
    })
    .catch(() => undefined);

  const options = await readOptions(rest);
  const title = value === null ? null : options.find((option) => option.code === value)?.title ?? null;

  return {
    companyId,
    mccCode: value,
    mccTitle: title,
    options,
    complete,
    saved: true,
    savedAtEpochMs: now,
  };
}
