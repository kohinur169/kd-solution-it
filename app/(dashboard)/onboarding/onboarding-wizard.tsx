// path: app/(dashboard)/onboarding/onboarding-wizard.tsx
"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { rateLimitSentence } from "@/lib/auth/refusal-message";
import { formatMessage, getMessage } from "@/lib/i18n/messages";
import { csrfHeaders } from "@/lib/security/csrf-client";
import type { OnboardingProgress } from "@/services/kyc/onboarding-progress";
import {
  ONBOARDING_STEPS,
  ONBOARDING_STEP_COUNT,
  onboardingStepIndex,
  type OnboardingStep,
} from "@/services/kyc/onboarding-steps";
import { onboardingStepCopy, onboardingStepStateKey, onboardingStepStateOf } from "./step-copy";

/**
 * The six steps, and the one control the shell offers: where to work.
 *
 * ## What this component decides, and what it does not
 *
 * The position arrives from the server component, which read it through
 * `services/kyc/onboarding-progress.ts` - so the company, the role and the row are already settled
 * here. This component draws the list, marks the current step, and saves a new position through
 * `POST /api/onboarding/progress` with the CSRF token. It never takes an identifier from the
 * address: the only thing it sends is which of the six steps was pressed.
 *
 * ## Why the button does not say "continue"
 *
 * The data each step collects belongs to the STEP that builds it, so this shell cannot claim a step
 * is finished - marking "address" done with no address in it would be a false record for the
 * compliance desk to read. The button therefore moves the wizard's position, which is exactly what
 * the row stores, and says so when it has.
 *
 * ## Why every refusal has its own sentence
 *
 * A `401` is a session that ended in another tab, a `403` is a role that may not be here, a `422` is a
 * step this build does not know, and `429` carries its wait. Folding them into one "it did not work"
 * would leave a merchant pressing a button that cannot succeed.
 */

const PROGRESS_PATH = "/api/onboarding/progress";

interface RefusalDetail {
  readonly field?: unknown;
  readonly rule?: unknown;
}

function firstRule(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }

  const error = (payload as { readonly error?: unknown }).error;

  if (typeof error !== "object" || error === null) {
    return null;
  }

  const details = (error as { readonly details?: unknown }).details;

  if (!Array.isArray(details)) {
    return null;
  }

  const rule = (details[0] as RefusalDetail | undefined)?.rule;

  return typeof rule === "string" ? rule : null;
}

/** The sentence a refusal earns. */
function refusalFor(status: number, payload: unknown): string {
  if (status === 429) {
    return rateLimitSentence(payload);
  }

  if (status === 401) {
    return getMessage("onboarding.signedOut");
  }

  if (status === 403) {
    return getMessage("onboarding.forbidden");
  }

  if (status === 422 && firstRule(payload) === "unknown_step") {
    return getMessage("onboarding.actionUnknownStep");
  }

  return getMessage("onboarding.actionFailed");
}

const listClasses = "flex flex-col gap-3";

const cardClasses =
  "flex flex-col gap-2 rounded-lg border border-border bg-surface p-4 text-foreground shadow-card";

const cardCurrentClasses = "border-primary";

const headingClasses = "text-lg font-semibold tracking-tight";

const positionClasses = "text-xs font-semibold uppercase tracking-wider text-muted-foreground";

const descriptionClasses = "max-w-3xl text-sm text-muted-foreground";

const badgeClasses = "w-fit rounded-full border border-border px-2 py-0.5 text-xs font-semibold";

const buttonClasses =
  "w-fit rounded-md border border-border bg-surface px-3 py-1.5 text-sm font-semibold text-foreground transition hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-60";

const alertClasses = "text-sm text-destructive";

export interface OnboardingWizardProperties {
  readonly progress: OnboardingProgress;
}

export function OnboardingWizard({ progress }: OnboardingWizardProperties): ReactNode {
  const router = useRouter();
  const [busy, setBusy] = useState<OnboardingStep | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  async function savePosition(step: OnboardingStep): Promise<void> {
    setBusy(step);
    setMessage(null);
    setFailed(false);

    try {
      const response = await fetch(PROGRESS_PATH, {
        method: "POST",
        headers: { "content-type": "application/json", ...(await csrfHeaders()) },
        body: JSON.stringify({ step }),
      });

      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);

        setMessage(refusalFor(response.status, payload));
        setFailed(true);

        return;
      }

      setMessage(getMessage("onboarding.actionDone"));
      // The position is the server's answer: the card this merchant just chose is now the current one.
      router.refresh();
    } catch {
      setMessage(getMessage("onboarding.actionFailed"));
      setFailed(true);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {message === null ? null : (
        <p className={failed ? alertClasses : "text-sm text-muted-foreground"} role="status">
          {message}
        </p>
      )}

      <ol className={listClasses}>
        {ONBOARDING_STEPS.map((step) => {
          const copy = onboardingStepCopy(step);
          const state = onboardingStepStateOf(step, progress);
          const position = onboardingStepIndex(step) + 1;

          return (
            <li
              aria-current={state === "current" ? "step" : undefined}
              className={state === "current" ? `${cardClasses} ${cardCurrentClasses}` : cardClasses}
              key={step}
            >
              <p className={positionClasses}>
                {formatMessage("onboarding.positionLine", {
                  position,
                  total: ONBOARDING_STEP_COUNT,
                })}
              </p>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <h3 className={headingClasses}>{getMessage(copy.label)}</h3>
                <span className={badgeClasses}>{getMessage(onboardingStepStateKey(state))}</span>
              </div>
              <p className={descriptionClasses}>{getMessage(copy.description)}</p>
              <button
                className={buttonClasses}
                disabled={busy !== null || state === "current"}
                onClick={() => {
                  void savePosition(step);
                }}
                type="button"
              >
                {busy === step
                  ? getMessage("onboarding.actionBusy")
                  : getMessage("onboarding.actionSubmit")}
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
