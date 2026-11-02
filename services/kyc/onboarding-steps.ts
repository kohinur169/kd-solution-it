// path: services/kyc/onboarding-steps.ts
import type { PlatformRole } from "../../lib/auth/types.ts";

/**
 * The onboarding wizard's vocabulary: the six steps of section 5, and the names around them.
 *
 * ## Why this is a file of its own
 *
 * The vocabulary is read by three places that must not each keep a copy: the database migration's
 * rule (`0102`'s check and its step-list function), the service that reads and moves the position,
 * and the browser component that draws the six cards. The browser is the reason this file has no
 * imports beyond a type: the component is a client component, and a client component that imported
 * the *service* would pull the PostgREST client and the audit signer into a merchant's browser
 * bundle. So the words of the wizard live here, alone, and the service imports them from here.
 *
 * ## Why the order is part of the constant
 *
 * Section 5 asks for the business profile, then the address, then the category, then the website,
 * then the documents, and then a review of all of it. The order is what a wizard *is*, so it is the
 * array's order and not a number stored on each step: a reordering is an edit to this array and a
 * migration, never a client-side sort.
 *
 * ## Why a step is a string union and not a number
 *
 * A number would have made every stored step a position in a list, and the first reordering would
 * have moved every merchant's saved position without touching a row. A name is what `0102` stores, so
 * an added step is an addition and an existing merchant keeps the step they were on.
 */

/** The six steps of the wizard, in the order section 5 describes them. */
export const ONBOARDING_STEPS = [
  "business",
  "address",
  "category",
  "website",
  "documents",
  "review",
] as const;

/** One step of the wizard. */
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/** How many steps the wizard has, so a screen can say "step 2 of 6" without counting. */
export const ONBOARDING_STEP_COUNT = ONBOARDING_STEPS.length;

/** The step a merchant sees first: the business information form of STEP 080. */
export const ONBOARDING_START_STEP: OnboardingStep = "business";

/** The only role that has an onboarding of its own. */
export const ONBOARDING_OWNER_ROLES: readonly PlatformRole[] = Object.freeze([
  "owner",
] as const satisfies readonly PlatformRole[]);

/** The table of `0102`. */
export const ONBOARDING_PROGRESS_TABLE = "onboarding_progress";

/** The audit action a save is recorded under. */
export const ONBOARDING_AUDIT_ACTION = "onboarding.step_saved";

/** The audit entity a save is recorded against: the merchant company, not the row. */
export const ONBOARDING_AUDIT_ENTITY = "onboarding";

/** True when a value is one of the six steps. */
export function isOnboardingStep(value: unknown): value is OnboardingStep {
  return typeof value === "string" && (ONBOARDING_STEPS as readonly string[]).includes(value);
}

/** Where a step sits in the order, or -1 for a name outside it. */
export function onboardingStepIndex(step: OnboardingStep): number {
  return ONBOARDING_STEPS.indexOf(step);
}

/** The step after this one, or null when it is the last. */
export function nextOnboardingStep(step: OnboardingStep): OnboardingStep | null {
  return ONBOARDING_STEPS[onboardingStepIndex(step) + 1] ?? null;
}
