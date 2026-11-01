// path: app/(auth)/reauth/reauth-form.tsx
"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { deviceProofHeaders } from "@/lib/auth/device-proof-store";
import { csrfHeaders } from "@/lib/security/csrf-client";
import { getMessage, formatMessage } from "@/lib/i18n/messages";

/**
 * The person's side of a step-up: one code, one answer.
 *
 * The request is signed with the device key (STEP 050) as well as carrying the cookie, because this
 * endpoint is the one that buys freshness for the endpoints that need it. A browser with no key
 * cannot use it, and the sentence says so rather than sending the person in a circle.
 *
 * Four answers are told apart, because each asks for something different:
 *
 *   - `422` with `invalid_code` - look at the app again;
 *   - `422` with `two_factor_required` - finish the enrolment first, and the screen says so;
 *   - `423` - the account is locked, and the sentence carries how long;
 *   - `403` - the device is not confirmed (STEP 052), which is the confirmation screen's business.
 *
 * Everything else is one sentence, because the difference is the server's to keep.
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

  const error = (payload as { readonly error?: unknown }).error;

  if (typeof error !== "object" || error === null) {
    return null;
  }

  const details = (error as { readonly details?: unknown }).details;

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

/** The minutes a `423` names, rounded up and never below one. */
function lockedMinutes(payload: unknown): number {
  if (typeof payload !== "object" || payload === null) {
    return 1;
  }

  const error = (payload as { readonly error?: unknown }).error;

  if (typeof error !== "object" || error === null) {
    return 1;
  }

  const seconds = (error as { readonly retryAfterSeconds?: unknown }).retryAfterSeconds;

  return typeof seconds === "number" && Number.isFinite(seconds)
    ? Math.max(1, Math.ceil(seconds / 60))
    : 1;
}

/** What one answer earns, as the sentence the person reads. */
function messageFor(status: number, payload: unknown): string {
  if (status === 423) {
    return formatMessage("reauth.locked", { minutes: String(lockedMinutes(payload)) });
  }

  if (status === 401) {
    return getMessage("reauth.signedOut");
  }

  if (status === 403) {
    return getMessage("device.bindingFailed");
  }

  if (readRule(payload) === "two_factor_required") {
    return getMessage("reauth.twoFactorRequired");
  }

  return status === 422 || status === 400
    ? getMessage("reauth.invalidCode")
    : getMessage("reauth.failed");
}

/** What a `200` answered, as far as this screen needs it. */
function readConfirmed(payload: unknown): { remaining: number | null } | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }

  const candidate = payload as {
    readonly status?: unknown;
    readonly remainingBackupCodes?: unknown;
  };

  if (candidate.status !== "reauthenticated") {
    return null;
  }

  const remaining = candidate.remainingBackupCodes;

  return { remaining: typeof remaining === "number" && Number.isFinite(remaining) ? remaining : null };
}

export function ReauthForm(): ReactNode {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<{ remaining: number | null } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setMessage(null);
    setBusy(true);

    try {
      const body = JSON.stringify({ code });
      const proof = await deviceProofHeaders("POST", "/api/auth/session/reauth", body);

      if (proof === null) {
        setMessage(getMessage("device.proofRequired"));
        setBusy(false);

        return;
      }

      const csrf = await csrfHeaders();
const response = await fetch("/api/auth/session/reauth", {
        method: "POST",
        headers: { "content-type": "application/json", ...proof, ...csrf },
        body,
      });

      if (response.ok) {
        const payload: unknown = await response.json().catch(() => null);

        setCode("");
        setBusy(false);
        setConfirmed(readConfirmed(payload));

        return;
      }

      const payload: unknown = await response.json().catch(() => null);

      setMessage(messageFor(response.status, payload));
      setCode("");
      setBusy(false);
    } catch {
      setMessage(getMessage("reauth.failed"));
      setBusy(false);
    }
  }

  if (confirmed !== null) {
    return (
      <div className="mt-6 rounded-lg border border-border bg-muted/40 p-4" role="status">
        <h2 className="text-base font-semibold tracking-tight">
          {getMessage("reauth.alreadyFreshTitle")}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {confirmed.remaining === null
            ? getMessage("reauth.alreadyFreshBody")
            : formatMessage("reauth.backupCodeUsed", { remaining: String(confirmed.remaining) })}
        </p>
      </div>
    );
  }

  return (
    <form className="mt-6" onSubmit={(event): void => void submit(event)}>
      <label className="block text-sm font-medium" htmlFor="reauth-code">
        {getMessage("reauth.codeLabel")}
      </label>
      <p className="mt-1 text-xs text-muted-foreground">{getMessage("reauth.codeHint")}</p>
      <input
        autoComplete="one-time-code"
        className={fieldClassName}
        id="reauth-code"
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
        {busy ? getMessage("reauth.submitting") : getMessage("reauth.submit")}
      </button>

      {message === null ? null : (
        <p className="mt-3 text-sm text-destructive" role="alert">
          {message}
        </p>
      )}
    </form>
  );
}
