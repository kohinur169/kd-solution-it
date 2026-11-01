// path: app/(auth)/devices/confirm/device-confirm-form.tsx
"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { getMessage } from "@/lib/i18n/messages";
import { readStoredDeviceProofKey } from "@/lib/auth/device-proof-store";

/**
 * The merchant's side of a confirmation: one code from the authenticator app.
 *
 * The device is not a field. It is read from the key this browser stored at enrolment (STEP 049),
 * which is the only value the server would accept anyway: the route refuses a device the session is
 * not bound to, and a form that let somebody type one would only produce a refusal.
 *
 * Four refusals are worth telling apart, because each asks for something different:
 *
 *   - a wrong code is `rule: "invalid_code"`, and the answer is to look at the app again;
 *   - a challenge that expired or ran out of attempts needs a fresh sign in, so the sentence says so
 *     rather than inviting another guess at a code that can no longer be accepted;
 *   - an account that has not finished enrolling its second factor is sent to the enrolment first,
 *     which is the only thing that would make a code exist.
 *
 * Everything else - a network that failed, an account with no key in this browser, a signed out tab -
 * is one sentence, because the difference is the server's to keep and not this component's to guess.
 */

const fieldClassName =
  "mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary";

const primaryButtonClassName =
  "mt-5 inline-flex w-full items-center justify-center rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60 sm:w-auto";

/** The rule of a `422` answer, when the answer carries one this screen knows. */
function readRule(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }

  const details = (payload as { readonly details?: unknown }).details;

  if (!Array.isArray(details) || details.length === 0) {
    return null;
  }

  const first: unknown = details[0];

  if (typeof first !== "object" || first === null) {
    return null;
  }

  const rule = (first as { readonly rule?: unknown }).rule;

  return typeof rule === "string" ? rule : null;
}

/** The sentence one refusal earns, or the general one. */
function messageForStatus(status: number, rule: string | null): string {
  if (status === 403) {
    return getMessage("deviceConfirm.unknownDevice");
  }

  if (status === 401) {
    return getMessage("deviceConfirm.signInRequired");
  }

  if (rule === "challenge_expired") {
    return getMessage("deviceConfirm.expiredChallenge");
  }

  if (rule === "attempts_exhausted") {
    return getMessage("deviceConfirm.attemptsExhausted");
  }

  if (rule === "two_factor_required") {
    return getMessage("deviceConfirm.twoFactorRequired");
  }

  return status === 422 || status === 400
    ? getMessage("deviceConfirm.invalidCode")
    : getMessage("deviceConfirm.failed");
}

export interface DeviceConfirmFormProperties {
  /** The label this account gave the device when it was enrolled, when it has one. */
  readonly label: string | null;
}

export function DeviceConfirmForm({ label }: DeviceConfirmFormProperties): ReactNode {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setMessage(null);
    setBusy(true);

    try {
      const key = await readStoredDeviceProofKey().catch(() => null);

      if (key === null) {
        setMessage(getMessage("device.proofRequired"));
        setBusy(false);

        return;
      }

      const response = await fetch("/api/auth/devices/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId: key.deviceId, code }),
      });

      if (response.ok) {
        setCode("");
        setBusy(false);
        setConfirmed(true);

        return;
      }

      const payload: unknown = await response.json().catch(() => null);

      setMessage(messageForStatus(response.status, readRule(payload)));
      setCode("");
      setBusy(false);
    } catch {
      setMessage(getMessage("deviceConfirm.failed"));
      setBusy(false);
    }
  }

  if (confirmed) {
    return (
      <div className="mt-6 rounded-lg border border-border bg-muted/40 p-4" role="status">
        <h2 className="text-base font-semibold tracking-tight">
          {getMessage("deviceConfirm.confirmedTitle")}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">{getMessage("deviceConfirm.confirmedBody")}</p>
      </div>
    );
  }

  return (
    <form className="mt-6" onSubmit={(event): void => void submit(event)}>
      {label === null ? null : (
        <p className="text-sm font-medium">{label}</p>
      )}

      <label className="mt-4 block text-sm font-medium" htmlFor="device-confirm-code">
        {getMessage("deviceConfirm.codeLabel")}
      </label>
      <p className="mt-1 text-xs text-muted-foreground">{getMessage("deviceConfirm.codeHint")}</p>
      <input
        autoComplete="one-time-code"
        className={fieldClassName}
        id="device-confirm-code"
        inputMode="text"
        maxLength={11}
        name="code"
        onChange={(event): void => {
          setCode(event.target.value);
        }}
        required
        type="text"
        value={code}
      />

      <button className={primaryButtonClassName} disabled={busy} type="submit">
        {busy ? getMessage("deviceConfirm.submitting") : getMessage("deviceConfirm.submit")}
      </button>

      {message === null ? null : (
        <p className="mt-3 text-sm text-destructive" role="alert">
          {message}
        </p>
      )}
    </form>
  );
}
