// path: services/kyc/business-profile.ts
import { z } from "zod";
import type { AuditTrail } from "../../lib/auth/audit.ts";
import { isConflictError, type RestClient } from "../../lib/auth/rest.ts";
import { requireAnyRole, requireCompanyId } from "../../lib/auth/session.ts";
import type { RequestActor } from "../../lib/auth/types.ts";
import type { ErrorDetail } from "../../lib/errors/app-error.ts";
import { AppError } from "../../lib/errors/app-error.ts";
import { sanitizeMultilineText, sanitizeSingleLineText } from "../../lib/security/text.ts";
import { sanitizeHttpUrl } from "../../lib/security/url.ts";
import {
  ONBOARDING_OWNER_ROLES,
  ONBOARDING_PROGRESS_TABLE,
  nextOnboardingStep,
  type OnboardingStep,
} from "./onboarding-steps.ts";
import {
  BUSINESS_PROFILE_FIELDS,
  PROCESSOR_REQUIREMENT_LIST,
  REQUIRED_BUSINESS_FIELDS,
  type BusinessProfileField,
  type ProcessorRequirement,
} from "./processor-fields.ts";

/**
 * Section 5's business information: the facts one merchant fills once, and the rule that decides when
 * they are enough.
 *
 * ## What this module owns
 *
 * `0103` is the row and `services/kyc/processor-fields.ts` is the per-processor matrix. This file is
 * the write and the read over both: it validates what a merchant typed, stores it as a draft,
 * computes which processor requirements are still unmet, and - only when none is - stamps the row
 * complete and marks the `business` step of the onboarding wizard (STEP 079's position row) finished.
 * That last part is the whole reason the two tables exist: the wizard says where a merchant is, and
 * this file is one of the steps that decides whether they can move on.
 *
 * ## Why a draft is a draft
 *
 * Every field is optional per save and every field can be cleared by sending it empty. A merchant
 * who does not have their registration number yet must be able to store the legal name, close the
 * browser and come back - and the form must not tell them they are finished. `completed_at` is
 * therefore derived, never posted: it is stamped when the merged values satisfy the union of every
 * processor's required fields, and cleared again if a later save removes one of them, because a
 * profile that says "complete" while a processor would refuse it is worse than a draft.
 *
 * ## Why a save patches rather than replaces
 *
 * The body names the fields it sends and touches nothing else. A later step of this section (081's
 * category code, 082's address and contact) saves its own fields through its own route, and a save
 * from one screen must never blank a field another screen owns.
 *
 * ## The validation, and where its sentences come from
 *
 * Every value goes through the section 55 sanitiser before it is measured: single line text for the
 * names and numbers, multiline for the description, and `sanitizeHttpUrl` for the website, which
 * refuses anything that is not `https:` and any host the platform may not fetch. A refusal is
 * `VALIDATION_FAILED` listing every field that failed with the rule it broke, so a form can mark all
 * of them at once instead of one per round trip.
 */

/** The table of `0103`. */
export const BUSINESS_PROFILE_TABLE = "business_profiles";

/** The audit action a save is recorded under. */
export const BUSINESS_PROFILE_AUDIT_ACTION = "business_profile.saved";

/** The audit entity a save is recorded against: the merchant company. */
export const BUSINESS_PROFILE_AUDIT_ENTITY = "business_profile";

/** The onboarding step this profile completes when every processor requirement is met. */
export const BUSINESS_PROFILE_ONBOARDING_STEP: OnboardingStep = "business";

/** The ceilings the form and the sanitiser share. */
export const BUSINESS_FIELD_LIMITS = Object.freeze({
  legal_name: 120,
  trading_name: 120,
  registration_number: 40,
  tax_id: 40,
  website: 300,
  business_description: 1_000,
} as const);

/** The two answers to "what kind of entity is this". */
export const BUSINESS_TYPES = Object.freeze(["individual", "company"] as const);

/** One of the two business types. */
export type BusinessType = (typeof BUSINESS_TYPES)[number];

/** The values a merchant has stored, by field. A field that was never given is null. */
export type BusinessProfileValues = Readonly<Record<BusinessProfileField, string | null>>;

/** One processor's coverage of this profile: what it asks for, and what is still missing. */
export interface ProcessorCoverage {
  readonly provider: ProcessorRequirement["provider"];
  readonly displayName: string;
  readonly required: readonly BusinessProfileField[];
  readonly optional: readonly BusinessProfileField[];
  readonly missing: readonly BusinessProfileField[];
}

/** The profile as a screen sees it. */
export interface BusinessProfileSnapshot {
  readonly companyId: string;
  readonly values: BusinessProfileValues;
  readonly coverage: readonly ProcessorCoverage[];
  readonly required: readonly BusinessProfileField[];
  readonly missing: readonly BusinessProfileField[];
  readonly complete: boolean;
  readonly saved: boolean;
  readonly savedAtEpochMs: number | null;
  readonly completedAtEpochMs: number | null;
}

export interface BusinessProfileDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now?: () => number;
}

const nullishText = z.string().max(2_000).nullable().optional();

const profileRowSchema = z.object({
  company_id: z.string().min(1).max(64),
  legal_name: nullishText,
  trading_name: nullishText,
  business_type: nullishText,
  registration_number: nullishText,
  tax_id: nullishText,
  website: nullishText,
  business_description: nullishText,
  completed_at: nullishText,
  updated_at: z.string().min(1).max(40),
});

const onboardingRowSchema = z.object({
  current_step: z.string().min(1).max(32),
  completed_steps: z.array(z.string().min(1).max(32)).max(6),
});

/** The identifier shape the columns accept, for the two numbers a processor checks. */
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9 ./-]{1,39}$/u;

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

function requireCompany(actor: RequestActor): string {
  requireAnyRole(actor, ONBOARDING_OWNER_ROLES);

  return requireCompanyId(actor);
}

function emptyValues(): Record<BusinessProfileField, string | null> {
  const values = {} as Record<BusinessProfileField, string | null>;

  for (const field of BUSINESS_PROFILE_FIELDS) {
    values[field] = null;
  }

  return values;
}

/** The fields of the union no value satisfies, in the form's order. */
export function missingBusinessFields(
  values: BusinessProfileValues,
): readonly BusinessProfileField[] {
  return REQUIRED_BUSINESS_FIELDS.filter((field) => values[field] === null);
}

/** One processor's coverage of one profile. */
function coverageOf(values: BusinessProfileValues): readonly ProcessorCoverage[] {
  return PROCESSOR_REQUIREMENT_LIST.map((requirement) => ({
    provider: requirement.provider,
    displayName: requirement.displayName,
    required: requirement.required,
    optional: requirement.optional,
    missing: requirement.required.filter((field) => values[field] === null),
  }));
}

function snapshotOf(
  companyId: string,
  values: BusinessProfileValues,
  savedAtEpochMs: number | null,
  completedAtEpochMs: number | null,
): BusinessProfileSnapshot {
  const missing = missingBusinessFields(values);

  return {
    companyId,
    values,
    coverage: coverageOf(values),
    required: REQUIRED_BUSINESS_FIELDS,
    missing,
    complete: missing.length === 0,
    saved: savedAtEpochMs !== null,
    savedAtEpochMs,
    completedAtEpochMs,
  };
}

/** One live row of one company, or null when the merchant has not saved anything yet. */
async function readProfileRow(
  companyId: string,
  rest: RestClient,
): Promise<z.infer<typeof profileRowSchema> | null> {
  const rows = await rest.select(
    BUSINESS_PROFILE_TABLE,
    `select=company_id,legal_name,trading_name,business_type,registration_number,tax_id,website,business_description,completed_at,updated_at&company_id=eq.${encodeURIComponent(companyId)}&deleted_at=is.null&limit=1`,
    profileRowSchema,
  );

  return rows[0] ?? null;
}

function valuesOf(row: z.infer<typeof profileRowSchema>): Record<BusinessProfileField, string | null> {
  return {
    legal_name: row.legal_name ?? null,
    trading_name: row.trading_name ?? null,
    business_type: row.business_type ?? null,
    registration_number: row.registration_number ?? null,
    tax_id: row.tax_id ?? null,
    website: row.website ?? null,
    business_description: row.business_description ?? null,
  };
}

/**
 * One field, sanitised and measured.
 *
 * Returns the value the database stores, or a problem naming the field and the rule. An empty string
 * is a deliberate "clear this field" and answers null, which is how a merchant removes a mistake
 * without a second endpoint.
 */
function fieldValue(
  field: BusinessProfileField,
  raw: string,
): { readonly value: string | null; readonly problem: ErrorDetail | null } {
  if (raw.trim().length === 0) {
    return { value: null, problem: null };
  }

  if (field === "website") {
    const decision = sanitizeHttpUrl(raw, { maximumLength: BUSINESS_FIELD_LIMITS.website });

    return decision.ok && decision.value !== undefined
      ? { value: decision.value, problem: null }
      : { value: null, problem: { field, rule: decision.reason ?? "invalid_format" } };
  }

  if (field === "business_type") {
    const trimmed = raw.trim().toLowerCase();

    return (BUSINESS_TYPES as readonly string[]).includes(trimmed)
      ? { value: trimmed, problem: null }
      : { value: null, problem: { field, rule: "unknown_value" } };
  }

  if (field === "business_description") {
    if ([...raw.trim()].length > BUSINESS_FIELD_LIMITS.business_description) {
      return { value: null, problem: { field, rule: "too_long" } };
    }

    const value = sanitizeMultilineText(raw, BUSINESS_FIELD_LIMITS.business_description).trim();

    return value.length >= 10
      ? { value, problem: null }
      : { value: null, problem: { field, rule: "too_short" } };
  }

  if ([...raw.trim()].length > BUSINESS_FIELD_LIMITS[field]) {
    return { value: null, problem: { field, rule: "too_long" } };
  }

  const value = sanitizeSingleLineText(raw, BUSINESS_FIELD_LIMITS[field]).trim();

  if (field === "legal_name") {
    return value.length >= 2
      ? { value, problem: null }
      : { value: null, problem: { field, rule: "too_short" } };
  }

  if (field === "trading_name") {
    return { value, problem: null };
  }

  return identifierPattern.test(value)
    ? { value, problem: null }
    : { value: null, problem: { field, rule: "invalid_format" } };
}

/**
 * The body a route passes, as the values it names.
 *
 * A key outside the seven is refused rather than ignored: a form from an older or newer build is a
 * client this build does not understand, and storing half of it would leave the merchant believing
 * the other half was saved.
 */
export function parseBusinessProfileInput(
  input: unknown,
): { readonly values: Readonly<Partial<Record<BusinessProfileField, string | null>>>; readonly problems: readonly ErrorDetail[] } {
  const problems: ErrorDetail[] = [];
  const values: Partial<Record<BusinessProfileField, string | null>> = {};

  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return {
      values,
      problems: [{ field: "profile", rule: "invalid_format" }],
    };
  }

  for (const [key, raw] of Object.entries(input as Readonly<Record<string, unknown>>)) {
    if (!(BUSINESS_PROFILE_FIELDS as readonly string[]).includes(key)) {
      problems.push({ field: key.slice(0, 64), rule: "unknown_key" });
      continue;
    }

    if (raw !== null && typeof raw !== "string") {
      problems.push({ field: key, rule: "invalid_format" });
      continue;
    }

    const parsed = fieldValue(key as BusinessProfileField, raw ?? "");

    if (parsed.problem !== null) {
      problems.push(parsed.problem);
      continue;
    }

    values[key as BusinessProfileField] = parsed.value;
  }

  return { values, problems };
}

/** The caller's own company's business profile, whether or not it has been saved. */
export async function readBusinessProfile(
  input: { readonly actor: RequestActor },
  dependencies: BusinessProfileDependencies,
): Promise<BusinessProfileSnapshot> {
  const companyId = requireCompany(input.actor);
  const row = await readProfileRow(companyId, dependencies.rest);

  if (row === null) {
    return snapshotOf(companyId, emptyValues(), null, null);
  }

  return snapshotOf(
    companyId,
    valuesOf(row),
    epochMs(row.updated_at),
    epochMs(row.completed_at),
  );
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
 * Keep STEP 079's position row in step with this profile.
 *
 * The `business` step is finished exactly when the profile satisfies every processor, so the two
 * tables answer "is this step done" the same way. A merchant who opened the wizard has a row to
 * update; one who went straight to the form does not, and gets a row that opens on the next step
 * because this one is done.
 */
async function syncOnboardingStep(
  companyId: string,
  actorUserId: string,
  complete: boolean,
  rest: RestClient,
): Promise<void> {
  const existing = await readOnboardingRow(companyId, rest);
  const step = BUSINESS_PROFILE_ONBOARDING_STEP;

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
 * Save the fields the body names, and answer the profile as it now stands.
 *
 * The save is a patch: a field the body does not mention keeps its stored value, and a field the body
 * sends empty is cleared. Completion is recomputed from the merged whole, stamped on the row and
 * mirrored into the onboarding position, so a merchant who fills the last required field finds the
 * wizard one step further on when they go back to it.
 */
export async function saveBusinessProfile(
  input: {
    readonly actor: RequestActor;
    readonly input: unknown;
    readonly ipAddress: string | null;
    readonly userAgent: string | null;
  },
  dependencies: BusinessProfileDependencies,
): Promise<BusinessProfileSnapshot> {
  const companyId = requireCompany(input.actor);
  const parsed = parseBusinessProfileInput(input.input);

  if (parsed.problems.length > 0) {
    throw new AppError("VALIDATION_FAILED", { details: parsed.problems });
  }

  if (Object.keys(parsed.values).length === 0) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "profile", rule: "required" }],
    });
  }

  const existing = await readProfileRow(companyId, dependencies.rest);
  const merged: Record<BusinessProfileField, string | null> =
    existing === null ? emptyValues() : valuesOf(existing);

  for (const [field, value] of Object.entries(parsed.values)) {
    merged[field as BusinessProfileField] = value ?? null;
  }

  const missing = missingBusinessFields(merged);
  const complete = missing.length === 0;
  const now = (dependencies.now ?? ((): number => Date.now()))();
  const instant = new Date(now).toISOString();
  const wasComplete = existing?.completed_at !== null && existing?.completed_at !== undefined;
  const completedAt = complete ? existing?.completed_at ?? instant : null;

  // The row is created whole; an existing row is only ever touched in the columns this save
  // named. Writing the merged object would send six columns the merchant did not change, and a
  // second tab saving while this one was reading would have its field put back by this one.
  const created = {
    ...merged,
    completed_at: completedAt,
  };
  const changed = {
    ...parsed.values,
    completed_at: completedAt,
  };

  if (existing === null) {
    try {
      await dependencies.rest.insert(BUSINESS_PROFILE_TABLE, [{ company_id: companyId, ...created }]);
    } catch (error) {
      // Two tabs saving their first draft at once: the unique index keeps one row, and the second
      // save becomes the update it would have been a moment later.
      if (!isConflictError(error)) {
        throw error;
      }

      await dependencies.rest.update(
        BUSINESS_PROFILE_TABLE,
        `company_id=eq.${encodeURIComponent(companyId)}&deleted_at=is.null`,
        changed,
      );
    }
  } else {
    await dependencies.rest.update(
      BUSINESS_PROFILE_TABLE,
      `company_id=eq.${encodeURIComponent(companyId)}&deleted_at=is.null`,
      changed,
    );
  }

  await syncOnboardingStep(companyId, input.actor.userId, complete, dependencies.rest);

  await dependencies.audit
    .append({
      action: BUSINESS_PROFILE_AUDIT_ACTION,
      actorUserId: input.actor.userId,
      entityType: BUSINESS_PROFILE_AUDIT_ENTITY,
      entityId: companyId,
      companyId,
      sessionId: input.actor.sessionId,
      payload: {
        fields: Object.keys(parsed.values).sort(),
        complete,
        completed_now: complete && !wasComplete,
        missing: [...missing],
        saved_at: instant,
      },
      ...(input.ipAddress === null ? {} : { ipAddress: input.ipAddress }),
      ...(input.userAgent === null ? {} : { userAgent: input.userAgent }),
    })
    .catch(() => undefined);

  return snapshotOf(companyId, merged, now, epochMs(completedAt));
}
