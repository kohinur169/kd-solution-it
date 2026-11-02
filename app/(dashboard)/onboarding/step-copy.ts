// path: app/(dashboard)/onboarding/step-copy.ts
import type { MessagePath } from "../../../lib/i18n/messages.ts";
import type { OnboardingProgress } from "../../../services/kyc/onboarding-progress.ts";
import type { OnboardingStep } from "../../../services/kyc/onboarding-steps.ts";

/**
 * The words of the six steps, and the state of each one.
 *
 * ## Why the mapping is its own file
 *
 * The server component and the client component both draw the step list - the page to decide the
 * first paint, the client to redraw it after a save - and both have to agree on what a step is called
 * and what it asks for. A copy of the six descriptions in each file would be six sentences that drift
 * the first time one of them is edited.
 *
 * ## Why the state is computed, not stored
 *
 * A step is "finished" when the progress row says so and "current" when it is the saved position;
 * nothing else writes a state. `onboardingStepStateOf` is therefore the only place that decides which
 * of the three a card shows, and it takes the row's own answer rather than a screen's assumption.
 *
 * ## Why these keys are typed as `MessagePath`
 *
 * So a rename in the catalog is a compile error here rather than a blank label at runtime. The six
 * keys live under `onboarding.step.<name>` in `lib/i18n/strings/en.ts`.
 */

export interface OnboardingStepCopy {
  readonly label: MessagePath;
  readonly description: MessagePath;
}

/** The label and the description of each step, in the catalog. */
export const ONBOARDING_STEP_COPY: Readonly<Record<OnboardingStep, OnboardingStepCopy>> = Object.freeze({
  business: {
    label: "onboarding.step.business.label",
    description: "onboarding.step.business.description",
  },
  address: {
    label: "onboarding.step.address.label",
    description: "onboarding.step.address.description",
  },
  category: {
    label: "onboarding.step.category.label",
    description: "onboarding.step.category.description",
  },
  website: {
    label: "onboarding.step.website.label",
    description: "onboarding.step.website.description",
  },
  documents: {
    label: "onboarding.step.documents.label",
    description: "onboarding.step.documents.description",
  },
  review: {
    label: "onboarding.step.review.label",
    description: "onboarding.step.review.description",
  },
});

/**
 * The steps whose own form exists on the platform, and where it lives.
 *
 * ## Why the shell links instead of rendering the form
 *
 * Each step's fields belong to the STEP that owns them - their rules, their table, their audit
 * action - so the wizard cannot draw a form it does not own. A step that has one gets a link to it
 * here; a step that does not yet has none, and the card says where the merchant is without pretending
 * a form exists. The map grows as each STEP lands, and it is the only place a step's address is
 * written, so the shell and the form's own page cannot disagree about it.
 */
export const ONBOARDING_STEP_FORMS: Partial<Readonly<Record<OnboardingStep, string>>> = Object.freeze({
  business: "/onboarding/business",
  address: "/onboarding/address",
  category: "/onboarding/category",
});

/** Where one step's form lives, or `null` for a step that has none yet. */
export function onboardingStepFormHref(step: OnboardingStep): string | null {
  return ONBOARDING_STEP_FORMS[step] ?? null;
}

/** The label and the description of one step. */
export function onboardingStepCopy(step: OnboardingStep): OnboardingStepCopy {
  return ONBOARDING_STEP_COPY[step];
}

/** How one card is marked: where the merchant is, what is done, and what is still ahead. */
export type OnboardingStepState = "current" | "finished" | "todo";

/** The state of one step, from the row rather than from the order of the list. */
export function onboardingStepStateOf(
  step: OnboardingStep,
  progress: OnboardingProgress,
): OnboardingStepState {
  if (step === progress.currentStep) {
    return "current";
  }

  return progress.completedSteps.includes(step) ? "finished" : "todo";
}

/** The catalog key of a state badge. */
export function onboardingStepStateKey(state: OnboardingStepState): MessagePath {
  if (state === "current") {
    return "onboarding.stateCurrent";
  }

  return state === "finished" ? "onboarding.stateFinished" : "onboarding.stateNotStarted";
}
