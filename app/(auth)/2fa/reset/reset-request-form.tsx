// path: app/(auth)/2fa/reset/reset-request-form.tsx
"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { getMessage } from "@/lib/i18n/messages";

/**
 * The merchant's side of the recovery: one address, one account of what happened, one answer.
 *
 * The answer is deliberately flat. Whatever the platform found, the sentence after sending is the
 * one shown here, because a form that says "no account with that address" tells a stranger which
 * addresses hold accounts. The route enforces that; this component must not add a difference of its
 * own, which is why a rejected body and an unknown address both land on the same message.
 *
 * A validation refusal is the one exception, and it is safe: it is about the shape of what was
 * typed, not about whether an account exists.
 */

type Stage = "form" | "accepted";

const fieldClassName =
  "mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary";

const labelClassName = "mt-4 block text-sm font-medium";

const primaryButtonClassName =
  "mt-5 inline-flex w-full items-center justify-center rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60 sm:w-auto";

export function ResetRequestForm(): ReactNode {
  const [stage, setStage] = useState<Stage>("form");
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function send(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setMessage(null);
    setBusy(true);

    try {
      const response = await fetch("/api/auth/2fa/reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, reason }),
      });

      if (response.status === 202) {
        setBusy(false);
        setStage("accepted");

        return;
      }

      setMessage(
        response.status === 422 || response.status === 400
          ? getMessage("resetRequest.invalid")
          : getMessage("resetRequest.failed"),
      );
      setBusy(false);
    } catch {
      setMessage(getMessage("resetRequest.failed"));
      setBusy(false);
    }
  }

  if (stage === "accepted") {
    return (
      <div className="mt-6 rounded-lg border border-border bg-muted/40 p-4" role="status">
        <h2 className="text-base font-semibold tracking-tight">
          {getMessage("resetRequest.acceptedTitle")}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {getMessage("resetRequest.acceptedBody")}
        </p>
      </div>
    );
  }

  return (
    <form className="mt-6" onSubmit={(event): void => void send(event)}>
      <label className={labelClassName} htmlFor="reset-request-email">
        {getMessage("resetRequest.emailLabel")}
      </label>
      <input
        autoComplete="email"
        className={fieldClassName}
        id="reset-request-email"
        maxLength={254}
        name="email"
        onChange={(event): void => {
          setEmail(event.target.value);
        }}
        required
        type="email"
        value={email}
      />

      <label className={labelClassName} htmlFor="reset-request-reason">
        {getMessage("resetRequest.reasonLabel")}
      </label>
      <p className="mt-1 text-xs text-muted-foreground">{getMessage("resetRequest.reasonHint")}</p>
      <textarea
        className={`${fieldClassName} min-h-28`}
        id="reset-request-reason"
        maxLength={1_000}
        name="reason"
        onChange={(event): void => {
          setReason(event.target.value);
        }}
        required
        rows={4}
        value={reason}
      />

      <button className={primaryButtonClassName} disabled={busy} type="submit">
        {busy ? getMessage("resetRequest.submitting") : getMessage("resetRequest.submit")}
      </button>

      {message === null ? null : (
        <p className="mt-3 text-sm text-destructive" role="alert">
          {message}
        </p>
      )}
    </form>
  );
}
