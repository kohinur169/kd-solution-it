// path: app/(dashboard)/onboarding/status/status-form.tsx
"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { rateLimitSentence } from "@/lib/auth/refusal-message";
import { getMessage } from "@/lib/i18n/messages";
import type { MessagePath } from "@/lib/i18n/messages";
import { csrfHeaders } from "@/lib/security/csrf-client";

/**
 * The submit button of the KYC status screen: one POST to `/api/onboarding/kyc-submit` with an
 * empty body. The submission, its documents and its screening runs are already recorded against
 * the company, and the company comes from the session, so the body carries nothing at all.
 *
 * The button only renders when the summary says the submit is allowed; the server checks the same
 * rule again, so a stale page cannot submit an empty draft.
 */

const SUBMIT_PATH = "/api/onboarding/kyc-submit";

type RuleKey = "required" | "already_submitted" | "stale" | "invalid_format" | "duplicate_identity";

const RULE_MESSAGES: Readonly<Record<RuleKey, MessagePath>> = Object.freeze({
  required: "onboardingStatus.ruleRequired",
  already_submitted: "onboardingStatus.ruleAlreadySubmitted",
  stale: "onboardingStatus.ruleStale",
  duplicate_identity: "onboardingStatus.ruleDuplicateIdentity",
  invalid_format: "onboardingStatus.ruleRequired",
});

interface RefusalDetail {
  readonly field?: unknown;
  readonly rule?: unknown;
}

function ruleSentence(rule: string | null): string {
  if (rule !== null && rule in RULE_MESSAGES) {
    return getMessage(RULE_MESSAGES[rule as RuleKey]);
  }

  return getMessage("onboardingStatus.ruleRequired");
}

function refusalDetails(payload: unknown): readonly RefusalDetail[] {
  const details = (payload as { readonly error?: { readonly details?: unknown } }).error?.details;

  return Array.isArray(details) ? (details as RefusalDetail[]) : [];
}

export function StatusForm({ canSubmit }: { readonly canSubmit: boolean }): ReactNode {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ readonly text: string; readonly failed: boolean } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setMessage(null);

    try {
      const response = await fetch(SUBMIT_PATH, {
        method: "POST",
        headers: { "content-type": "application/json", ...(await csrfHeaders()) },
        body: "{}",
      });

      if (!response.ok) {
        if (response.status === 401) {
          setMessage({ text: getMessage("onboardingStatus.signedOut"), failed: true });

          return;
        }

        if (response.status === 403) {
          setMessage({ text: getMessage("onboardingStatus.forbidden"), failed: true });

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
              ? getMessage("onboardingStatus.submitFailed")
              : ruleSentence(typeof first.rule === "string" ? first.rule : null),
          failed: true,
        });

        return;
      }

      setMessage({ text: getMessage("onboardingStatus.submitDone"), failed: false });
      router.refresh();
    } catch {
      setMessage({ text: getMessage("onboardingStatus.submitFailed"), failed: true });
    } finally {
      setBusy(false);
    }
  }

  if (!canSubmit) {
    return null;
  }

  return (
    <form className="flex flex-col gap-3" noValidate onSubmit={(event) => void submit(event)}>
      {message === null ? null : (
        <p
          className={message.failed ? "text-sm text-destructive" : "text-sm text-primary"}
          role={message.failed ? "alert" : "status"}
          aria-live="polite"
        >
          {message.text}
        </p>
      )}
      <button
        className="w-fit rounded-sm bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60"
        type="submit"
        disabled={busy}
      >
        {busy ? getMessage("onboardingStatus.submitBusy") : getMessage("onboardingStatus.submitButton")}
      </button>
    </form>
  );
}
