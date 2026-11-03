// path: services/kyc/business-address.ts
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
  ADDRESS_FIELD_LIMITS,
  BUSINESS_ADDRESS_FIELDS,
  OPTIONAL_ADDRESS_FIELDS,
  REQUIRED_ADDRESS_FIELDS,
  type BusinessAddressField,
} from "./business-address-fields.ts";
import {
  ONBOARDING_OWNER_ROLES,
  ONBOARDING_PROGRESS_TABLE,
  nextOnboardingStep,
  type OnboardingStep,
} from "./onboarding-steps.ts";

/**
 * Section 5's address and contact section: the registered address of the business and the person
 * who owns the account, stored on the one `business_profiles` row of `0103` that `0105` extended.
 *
 * ## What this module owns
 *
 * `0105` added the nine address and contact columns plus `address_completed_at` to the profile row.
 * This file is the only reader and writer of those columns: it validates what the merchant typed
 * (the country against the enabled list of `0076`), saves it as a draft, computes which required
 * fields are still missing, and - only when none is - stamps `address_completed_at` and marks the
 * `address` step of the onboarding wizard finished, the same mirror STEP 080 keeps for `business`
 * and STEP 081 for `category`.
 *
 * ## Why a draft is a draft
 *
 * A merchant does not have the postal code and the contact person's phone in the same sitting, so
 * every field is optional per save and every field can be cleared by sending it empty. Completion
 * is derived, never posted: stamped when the seven required fields are present, cleared again if a
 * later save removes one.
 *
 * ## Why a save patches rather than replaces
 *
 * The body names the fields it sends and touches nothing else. STEP 080's form, STEP 081's category
 * and this section each save their own fields through their own route, so a save from one screen
 * must never blank a field another screen owns - the update carries only the columns the request
 * named plus the derived `address_completed_at`.
 *
 * ## The validation, and where its sentences come from
 *
 * Every value goes through the section 56 sanitiser before it is measured. The email is lower cased
 * and matched to the same pattern the signup of STEP 038 uses; the phone to the pattern the settings
 * registry of STEP 074 uses; the postal code allows the letters, digits, spaces and hyphens real
 * postal codes use; the country must be an enabled row of `public.countries` - `unknown_country`
 * when no row holds the code, `disabled_country` when the row is switched off or sanctioned (the
 * constraint of `0076` keeps every sanctioned country disabled). A refusal is `VALIDATION_FAILED`
 * listing every field that failed with the rule it broke.
 */

/** The country list of `0076`. */
export const COUNTRIES_TABLE = "countries";

/** The audit action a save is recorded under. */
export const BUSINESS_ADDRESS_AUDIT_ACTION = "business_address.saved";

/** The audit entity a save is recorded against: the merchant company. */
export const BUSINESS_ADDRESS_AUDIT_ENTITY = "business_address";

/** The onboarding step this section completes when every required field is present. */
export const BUSINESS_ADDRESS_ONBOARDING_STEP: OnboardingStep = "address";

// The field list lives in its own module so client components can import it without this file's
// server-only imports; it is re-exported here so server code has one import path.
export {
  ADDRESS_FIELD_LIMITS,
  BUSINESS_ADDRESS_FIELDS,
  OPTIONAL_ADDRESS_FIELDS,
  REQUIRED_ADDRESS_FIELDS,
};
export type { BusinessAddressField };

/** The shapes the database checks keep, restated for the parser. */
export const POSTAL_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 -]{2,11}$/u;
export const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/u;
export const EMAIL_PATTERN = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/u;
export const PHONE_PATTERN = /^\+?[0-9][0-9 ()-]{5,31}$/u;

/** One enabled country, as the dropdown offers it. */
export interface CountryOption {
  readonly code: string;
  readonly name: string;
}

/** The values a merchant has stored, by field. A field that was never given is null. */
export type BusinessAddressValues = Readonly<Record<BusinessAddressField, string | null>>;

/** The section as a screen sees it. */
export interface BusinessAddressSnapshot {
  readonly companyId: string;
  readonly values: BusinessAddressValues;
  readonly countries: readonly CountryOption[];
  readonly required: readonly BusinessAddressField[];
  readonly missing: readonly BusinessAddressField[];
  readonly complete: boolean;
  readonly saved: boolean;
  readonly savedAtEpochMs: number | null;
  readonly completedAtEpochMs: number | null;
}

export interface BusinessAddressDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now?: () => number;
}

const nullishText = z.string().max(300).nullable().optional();

const profileRowSchema = z.object({
  company_id: z.string().min(1).max(64),
  address_line1: nullishText,
  address_line2: nullishText,
  city: nullishText,
  state_province: nullishText,
  postal_code: nullishText,
  country_code: nullishText,
  contact_name: nullishText,
  contact_email: nullishText,
  contact_phone: nullishText,
  address_completed_at: nullishText,
  updated_at: z.string().min(1).max(40),
});

const countryRowSchema = z.object({
  code: z.string().min(2).max(2),
  name: z.string().min(1).max(120),
});

const countryCheckSchema = z.object({
  code: z.string().min(2).max(2),
  is_enabled: z.boolean(),
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

function requireCompany(actor: RequestActor): string {
  requireAnyRole(actor, ONBOARDING_OWNER_ROLES);

  return requireCompanyId(actor);
}

function emptyValues(): Record<BusinessAddressField, string | null> {
  const values = {} as Record<BusinessAddressField, string | null>;

  for (const field of BUSINESS_ADDRESS_FIELDS) {
    values[field] = null;
  }

  return values;
}

/** The required fields the values do not satisfy, in the form's order. */
export function missingAddressFields(
  values: BusinessAddressValues,
): readonly BusinessAddressField[] {
  return REQUIRED_ADDRESS_FIELDS.filter((field) => values[field] === null);
}

/**
 * One field, sanitised and measured.
 *
 * Returns the value the database stores, or a problem naming the field and the rule. An empty
 * string is a deliberate "clear this field" and answers null.
 */
function fieldValue(
  field: BusinessAddressField,
  raw: string,
): { readonly value: string | null; readonly problem: ErrorDetail | null } {
  if (raw.trim().length === 0) {
    return { value: null, problem: null };
  }

  const limit = ADDRESS_FIELD_LIMITS[field];

  if ([...raw.trim()].length > limit) {
    return { value: null, problem: { field, rule: "too_long" } };
  }

  const value = sanitizeSingleLineText(raw, limit).trim();

  if (field === "country_code") {
    const upper = value.toUpperCase();

    return COUNTRY_CODE_PATTERN.test(upper)
      ? { value: upper, problem: null }
      : { value: null, problem: { field, rule: "invalid_format" } };
  }

  if (field === "postal_code") {
    return POSTAL_CODE_PATTERN.test(value)
      ? { value, problem: null }
      : { value: null, problem: { field, rule: "invalid_format" } };
  }

  if (field === "contact_email") {
    const lower = value.toLowerCase();

    return lower.length >= 5 && EMAIL_PATTERN.test(lower)
      ? { value: lower, problem: null }
      : { value: null, problem: { field, rule: "invalid_format" } };
  }

  if (field === "contact_phone") {
    return PHONE_PATTERN.test(value)
      ? { value, problem: null }
      : { value: null, problem: { field, rule: "invalid_format" } };
  }

  if (field === "address_line2" || field === "state_province") {
    return { value, problem: null };
  }

  return value.length >= 2
    ? { value, problem: null }
    : { value: null, problem: { field, rule: "too_short" } };
}

/**
 * The body a route passes, as the values it names.
 *
 * A key outside the nine is refused rather than ignored, and a wrong type is a format problem; both
 * are collected so a form can mark every bad box at once.
 */
export function parseBusinessAddressInput(
  input: unknown,
): { readonly values: Readonly<Partial<Record<BusinessAddressField, string | null>>>; readonly problems: readonly ErrorDetail[] } {
  const problems: ErrorDetail[] = [];
  const values: Partial<Record<BusinessAddressField, string | null>> = {};

  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return {
      values,
      problems: [{ field: "address", rule: "invalid_format" }],
    };
  }

  for (const [key, raw] of Object.entries(input as Readonly<Record<string, unknown>>)) {
    if (!(BUSINESS_ADDRESS_FIELDS as readonly string[]).includes(key)) {
      problems.push({ field: key.slice(0, 64), rule: "unknown_key" });
      continue;
    }

    if (raw !== null && typeof raw !== "string") {
      problems.push({ field: key, rule: "invalid_format" });
      continue;
    }

    const parsed = fieldValue(key as BusinessAddressField, raw ?? "");

    if (parsed.problem !== null) {
      problems.push(parsed.problem);
      continue;
    }

    values[key as BusinessAddressField] = parsed.value;
  }

  return { values, problems };
}

/** One live profile row of one company, or null when nothing was ever saved. */
async function readProfileRow(
  companyId: string,
  rest: RestClient,
): Promise<z.infer<typeof profileRowSchema> | null> {
  const rows = await rest.select(
    BUSINESS_PROFILE_TABLE,
    `select=company_id,address_line1,address_line2,city,state_province,postal_code,country_code,contact_name,contact_email,contact_phone,address_completed_at,updated_at&company_id=eq.${encodeURIComponent(companyId)}&deleted_at=is.null&limit=1`,
    profileRowSchema,
  );

  return rows[0] ?? null;
}

function valuesOf(row: z.infer<typeof profileRowSchema>): Record<BusinessAddressField, string | null> {
  return {
    address_line1: row.address_line1 ?? null,
    address_line2: row.address_line2 ?? null,
    city: row.city ?? null,
    state_province: row.state_province ?? null,
    postal_code: row.postal_code ?? null,
    country_code: row.country_code ?? null,
    contact_name: row.contact_name ?? null,
    contact_email: row.contact_email ?? null,
    contact_phone: row.contact_phone ?? null,
  };
}

/** The enabled countries in code order: the dropdown. Sanctioned countries are disabled by 0076's check. */
async function readCountries(rest: RestClient): Promise<readonly CountryOption[]> {
  return rest.select(
    COUNTRIES_TABLE,
    "select=code,name&is_enabled=is.true&deleted_at=is.null&order=code.asc",
    countryRowSchema,
  );
}

function snapshotOf(
  companyId: string,
  values: BusinessAddressValues,
  countries: readonly CountryOption[],
  savedAtEpochMs: number | null,
  completedAtEpochMs: number | null,
): BusinessAddressSnapshot {
  const missing = missingAddressFields(values);

  return {
    companyId,
    values,
    countries,
    required: REQUIRED_ADDRESS_FIELDS,
    missing,
    complete: missing.length === 0,
    saved: savedAtEpochMs !== null,
    savedAtEpochMs,
    completedAtEpochMs,
  };
}

/** The caller's own company's address section, whether or not it has been saved. */
export async function readBusinessAddress(
  input: { readonly actor: RequestActor },
  dependencies: BusinessAddressDependencies,
): Promise<BusinessAddressSnapshot> {
  const companyId = requireCompany(input.actor);
  const rest = dependencies.rest;
  const [row, countries] = await Promise.all([
    readProfileRow(companyId, rest),
    readCountries(rest),
  ]);

  if (row === null) {
    return snapshotOf(companyId, emptyValues(), countries, null, null);
  }

  return snapshotOf(
    companyId,
    valuesOf(row),
    countries,
    epochMs(row.updated_at),
    epochMs(row.address_completed_at),
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
 * Keep STEP 079's position row in step with this section: the `address` step is finished exactly
 * when the completion instant is set.
 */
async function syncOnboardingStep(
  companyId: string,
  actorUserId: string,
  complete: boolean,
  rest: RestClient,
): Promise<void> {
  const existing = await readOnboardingRow(companyId, rest);
  const step = BUSINESS_ADDRESS_ONBOARDING_STEP;

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
 * Save the fields the body names, and answer the section as it now stands.
 *
 * The country is checked against the enabled list of `0076` before anything is written. The save
 * is a patch: a field the body does not mention keeps its stored value, a field sent empty is
 * cleared, and completion is recomputed from the merged whole, stamped on the row and mirrored
 * into the onboarding position.
 */
export async function saveBusinessAddress(
  input: {
    readonly actor: RequestActor;
    readonly input: unknown;
    readonly ipAddress: string | null;
    readonly userAgent: string | null;
  },
  dependencies: BusinessAddressDependencies,
): Promise<BusinessAddressSnapshot> {
  const companyId = requireCompany(input.actor);
  const parsed = parseBusinessAddressInput(input.input);

  if (parsed.problems.length > 0) {
    throw new AppError("VALIDATION_FAILED", { details: parsed.problems });
  }

  if (Object.keys(parsed.values).length === 0) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "address", rule: "required" }],
    });
  }

  const rest = dependencies.rest;
  const country = parsed.values.country_code;

  if (country !== undefined && country !== null) {
    const matches = await rest.select(
      COUNTRIES_TABLE,
      `select=code,is_enabled&code=eq.${encodeURIComponent(country)}&deleted_at=is.null&limit=1`,
      countryCheckSchema,
    );
    const found = matches[0];

    if (found === undefined) {
      throw new AppError("VALIDATION_FAILED", {
        details: [{ field: "country_code", rule: "unknown_country" }],
      });
    }

    if (!found.is_enabled) {
      throw new AppError("VALIDATION_FAILED", {
        details: [{ field: "country_code", rule: "disabled_country" }],
      });
    }
  }

  const existing = await readProfileRow(companyId, rest);
  const merged: Record<BusinessAddressField, string | null> =
    existing === null ? emptyValues() : valuesOf(existing);

  for (const [field, value] of Object.entries(parsed.values)) {
    merged[field as BusinessAddressField] = value ?? null;
  }

  const missing = missingAddressFields(merged);
  const complete = missing.length === 0;
  const now = (dependencies.now ?? ((): number => Date.now()))();
  const instant = new Date(now).toISOString();
  const wasComplete =
    existing?.address_completed_at !== null && existing?.address_completed_at !== undefined;
  const completedAt = complete ? existing?.address_completed_at ?? instant : null;

  // The row is created whole; an existing row is only ever touched in the columns this save
  // named plus the derived instant, so a second tab cannot put back a field it did not send.
  const created = {
    ...merged,
    address_completed_at: completedAt,
  };
  const changed = {
    ...parsed.values,
    address_completed_at: completedAt,
  };

  if (existing === null) {
    try {
      await rest.insert(BUSINESS_PROFILE_TABLE, [{ company_id: companyId, ...created }]);
    } catch (error) {
      // Two tabs saving their first draft at once: the unique index keeps one row, and the second
      // save becomes the update it would have been a moment later.
      if (!isConflictError(error)) {
        throw error;
      }

      await rest.update(
        BUSINESS_PROFILE_TABLE,
        `company_id=eq.${encodeURIComponent(companyId)}&deleted_at=is.null`,
        changed,
      );
    }
  } else {
    await rest.update(
      BUSINESS_PROFILE_TABLE,
      `company_id=eq.${encodeURIComponent(companyId)}&deleted_at=is.null`,
      changed,
    );
  }

  await syncOnboardingStep(companyId, input.actor.userId, complete, rest);

  await dependencies.audit
    .append({
      action: BUSINESS_ADDRESS_AUDIT_ACTION,
      actorUserId: input.actor.userId,
      entityType: BUSINESS_ADDRESS_AUDIT_ENTITY,
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

  const countries = await readCountries(rest);

  return snapshotOf(companyId, merged, countries, now, epochMs(completedAt));
}
