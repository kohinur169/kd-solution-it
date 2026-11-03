// path: app/(dashboard)/onboarding/account/account-form.tsx
"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { rateLimitSentence } from "@/lib/auth/refusal-message";
import { getMessage } from "@/lib/i18n/messages";
import type { MessagePath } from "@/lib/i18n/messages";
import { csrfHeaders } from "@/lib/security/csrf-client";
import type { AccountState } from "@/services/kyc/account-lifecycle";

/**
 * The two merchant actions of the account screen of STEP 099: request reactivation while suspended
 * (once a submission is in the review pipeline - the required documents are uploaded and submitted
 * on the documents step first), and request closure while active. Both are one POST each with an
 * empty body: the company comes from the session, and the server re-checks the state machine, so a
 * stale page cannot act on an old state.
 */

const REACTIVATE_REQUEST_PATH = "/api/onboarding/account-reactivate-request";
const CLOSE_REQUEST_PATH = "/api/onboarding/account-close-request";

type RuleKey =
  | "not_suspended"
  | "already_requested"
  | "missing"
  | "not_active"
  | "already_closed";

const RULE_MESSAGES: Readonly<Record<RuleKey, MessagePath>> = Object.freeze({
  not_suspended: "onboardingAccount.ruleNotSuspended",
  already_requested: "onboardingAccount.ruleAlreadyRequested",
  missing: "onboardingAccount.ruleMissingSubmission",
  not_active: "onboardingAccount.ruleNotActive",
  already_closed: "onboardingAccount.ruleAlreadyClosed",
});

interface RefusalDetail {
  readonly field?: unknown;
  readonly rule?: unknown;
}

function ruleSentence(rule: string | null): string {
  if (rule !== null && rule in RULE_MESSAGES) {
    return getMessage(RULE_MESSAGES[rule as RuleKey]);
  }

  return getMessage("onboardingAccount.ruleFailed");
}

function refusalDetails(payload: unknown): readonly RefusalDetail[] {
  const details = (payload as { readonly error?: { readonly details?: unknown } }).error?.details;

  return Array.isArray(details) ? (details as RefusalDetail[]) : [];
}

export function AccountForm({
  state,
  reactivationReady,
}: {
  readonly state: AccountState;
  readonly reactivationReady: boolean;
}): ReactNode {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ readonly text: string; readonly failed: boolean } | null>(null);

  async function post(path: string, doneKey: MessagePath): Promise<void> {
    setBusy(true);
    setMessage(null);

    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json", ...(await csrfHeaders()) },
        body: "{}",
      });

      if (!response.ok) {
        if (response.status === 401) {
          setMessage({ text: getMessage("onboardingAccount.signedOut"), failed: true });

          return;
        }

        if (response.status === 403) {
          setMessage({ text: getMessage("onboardingAccount.forbidden"), failed: true });

          return;
        }

        if (response.status === 429) {
          const payload: unknown = await response.json().catch(() => null);

          setMessage({ text: rateLimitSentence(payload), failed: true });

          return;
        }

        const payload: unknown = await response.json().catch(() => null);
        const details = refusalDetails(payload);
        const first = details.find((detail) => typeof detail.field === "string" && detail.field !== "csrf");

        setMessage({
          text:
            first === undefined
              ? getMessage("onboardingAccount.ruleFailed")
              : ruleSentence(typeof first.rule === "string" ? first.rule : null),
          failed: true,
        });

        return;
      }

      setMessage({ text: getMessage(doneKey), failed: false });
      router.refresh();
    } catch {
      setMessage({ text: getMessage("onboardingAccount.ruleFailed"), failed: true });
    } finally {
      setBusy(false);
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    if (state === "suspended") {
      await post(REACTIVATE_REQUEST_PATH, "onboardingAccount.reactivationDone");
    } else {
      await post(CLOSE_REQUEST_PATH, "onboardingAccount.closureDone");
    }
  }

  const isReactivation = state === "suspended";

  return (
    <form className="flex flex-col gap-3" noValidate onSubmit={(event) => void onSubmit(event)}>
      {message === null ? null : (
        <p
          className={message.failed ? "text-sm text-destructive" : "text-sm text-primary"}
          role={message.failed ? "alert" : "status"}
          aria-live="polite"
        >
          {message.text}
        </p>
      )}
      {isReactivation && !reactivationReady ? (
        <p className="text-xs text-muted-foreground">{getMessage("onboardingAccount.reactivationDisabledNote")}</p>
      ) : null}
      <button
        className="w-fit rounded-sm bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60"
        type="submit"
        disabled={busy || (isReactivation && !reactivationReady)}
      >
        {busy
          ? getMessage(isReactivation ? "onboardingAccount.reactivationBusy" : "onboardingAccount.closureBusy")
          : getMessage(isReactivation ? "onboardingAccount.reactivationButton" : "onboardingAccount.closureButton")}
      </button>
    </form>
  );
}
