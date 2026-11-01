// path: app/(auth)/2fa/settings/backup-codes-form.tsx
"use client";

import Link from "next/link";
import { useState, type FormEvent, type ReactNode } from "react";
import { deviceProofHeaders } from "@/lib/auth/device-proof-store";
import { formatMessage, getMessage } from "@/lib/i18n/messages";

/**
 * The backup code panel: the state of the second factor, and the button that replaces the set.
 *
 * Four states, and the one that matters is `codes`: the ten new codes exist in clear exactly once,
 * in this component's memory, and leaving the panel discards them. That is why the replacement
 * sentence ("every code you saved before now signs nobody in") is shown *beside* the new codes
 * rather than after them: a person has to be able to read both before deciding to close the tab.
 *
 * Nothing here decides whether the request is allowed. The screen asks for the authenticator code
 * because the route requires it, and the route decides; a browser that skipped this form entirely
 * would still be refused.
 */

type Stage = "status" | "codes";

interface StatusBody {
  readonly enrolled: boolean;
  readonly confirmedAt: string | null;
  readonly backupCodesRemaining: number;
}

interface RegeneratedBody {
  readonly backupCodes: readonly string[];
  readonly replaced: number;
}

const fieldClassName =
  "mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-lg tracking-[0.4em] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary";

const primaryButtonClassName =
  "mt-5 inline-flex w-full items-center justify-center rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60 sm:w-auto";

function readRegenerated(payload: unknown): RegeneratedBody | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }

  const candidate = payload as {
    readonly backupCodes?: unknown;
    readonly replaced?: unknown;
  };
  const codes = candidate.backupCodes;

  if (
    !Array.isArray(codes) ||
    codes.length === 0 ||
    !codes.every((code): code is string => typeof code === "string") ||
    typeof candidate.replaced !== "number"
  ) {
    return null;
  }

  return { backupCodes: codes, replaced: candidate.replaced };
}

function readErrorMessage(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }

  const error = (payload as { readonly error?: unknown }).error;

  if (typeof error !== "object" || error === null) {
    return null;
  }

  const message = (error as { readonly message?: unknown }).message;

  return typeof message === "string" && message.length > 0 ? message : null;
}

export interface BackupCodesFormProperties {
  /** The account's state, read on the server so the panel never opens in a loading state. */
  readonly initialStatus: StatusBody;
}

export function BackupCodesForm({ initialStatus }: BackupCodesFormProperties): ReactNode {
  const [stage, setStage] = useState<Stage>("status");
  const [status, setStatus] = useState<StatusBody>(initialStatus);
  const [regenerated, setRegenerated] = useState<RegeneratedBody | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function regenerate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setMessage(null);
    setBusy(true);

    try {
      const body = JSON.stringify({ code });

      // STEP 050: ten new codes are ten new ways in, so the request is signed with the device key
      // as well as carrying the cookie and the current code.
      const proof = await deviceProofHeaders("POST", "/api/auth/2fa/backup-codes", body);

      if (proof === null) {
        setMessage(getMessage("device.proofRequired"));
        setBusy(false);

        return;
      }

      const response = await fetch("/api/auth/2fa/backup-codes", {
        method: "POST",
        headers: { "content-type": "application/json", ...proof },
        body,
      });
      const payload: unknown = await response.json().catch(() => null);

      if (response.status === 422) {
        setMessage(getMessage("twoFactor.codeRejected"));
        setCode("");
        setBusy(false);

        return;
      }

      if (response.status === 401) {
        setMessage(getMessage("twoFactor.signInRequired"));
        setBusy(false);

        return;
      }

      const parsed = response.ok ? readRegenerated(payload) : null;

      if (parsed === null) {
        setMessage(readErrorMessage(payload) ?? getMessage("twoFactor.unreadableResponse"));
        setBusy(false);

        return;
      }

      setRegenerated(parsed);
      setCode("");
      setBusy(false);
      setStage("codes");
    } catch {
      setMessage(getMessage("twoFactor.unreadableResponse"));
      setBusy(false);
    }
  }

  if (stage === "codes" && regenerated !== null) {
    return (
      <div className="mt-6">
        <h2 className="text-lg font-semibold tracking-tight">{getMessage("twoFactor.backupTitle")}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{getMessage("twoFactor.backupBody")}</p>
        <ul
          aria-label={getMessage("twoFactor.backupCodesLabel")}
          className="mt-4 grid grid-cols-1 gap-2 rounded-lg border border-border bg-background p-4 font-mono text-sm sm:grid-cols-2"
        >
          {regenerated.backupCodes.map((backupCode) => (
            <li key={backupCode} className="tracking-wider">
              {backupCode}
            </li>
          ))}
        </ul>
        <h3 className="mt-4 text-base font-semibold tracking-tight">
          {getMessage("twoFactor.settingsReplacedTitle")}
        </h3>
        <p className="mt-1 rounded-lg border border-border bg-muted/40 p-3 text-sm" role="status">
          {formatMessage("twoFactor.settingsReplacedBody", { count: String(regenerated.replaced) })}{" "}
          {getMessage("twoFactor.backupWarning")}
        </p>
        <button
          className={primaryButtonClassName}
          type="button"
          onClick={(): void => {
            setStatus({
              enrolled: true,
              confirmedAt: status.confirmedAt,
              backupCodesRemaining: regenerated.backupCodes.length,
            });
            setRegenerated(null);
            setStage("status");
          }}
        >
          {getMessage("twoFactor.done")}
        </button>
      </div>
    );
  }

  return (
    <div className="mt-6">
      <h2 className="text-lg font-semibold tracking-tight">
        {getMessage("twoFactor.settingsStatusTitle")}
      </h2>

      {status.enrolled ? (
        <>
          <p className="mt-2 text-sm text-muted-foreground">{getMessage("twoFactor.settingsEnrolled")}</p>
          <p className="mt-2 text-sm font-medium">
            {formatMessage("twoFactor.settingsCodesRemaining", {
              count: String(status.backupCodesRemaining),
            })}
          </p>
          {status.backupCodesRemaining === 0 ? (
            <p className="mt-2 rounded-lg border border-border bg-muted/40 p-3 text-sm" role="status">
              {getMessage("twoFactor.settingsCodesNone")}
            </p>
          ) : null}

          <form className="mt-6" onSubmit={(event): void => void regenerate(event)}>
            <h3 className="text-base font-semibold tracking-tight">
              {getMessage("twoFactor.settingsStepUpTitle")}
            </h3>
            <p className="mt-2 text-sm text-muted-foreground">
              {getMessage("twoFactor.settingsStepUpBody")}
            </p>
            <label className="mt-3 block text-sm font-medium" htmlFor="backup-code-step-up">
              {getMessage("twoFactor.codeLabel")}
            </label>
            <input
              autoComplete="one-time-code"
              className={fieldClassName}
              id="backup-code-step-up"
              inputMode="numeric"
              maxLength={6}
              name="code"
              onChange={(event): void => {
                setCode(event.target.value.replace(/[^0-9]/gu, "").slice(0, 6));
              }}
              pattern="[0-9]{6}"
              required
              value={code}
            />
            <button
              className={primaryButtonClassName}
              disabled={busy || code.length !== 6}
              type="submit"
            >
              {busy ? getMessage("twoFactor.settingsSubmitting") : getMessage("twoFactor.settingsSubmit")}
            </button>
            {message === null ? null : (
              <p className="mt-3 text-sm text-destructive" role="alert">
                {message}
              </p>
            )}
          </form>
        </>
      ) : (
        <>
          <p className="mt-2 text-sm text-muted-foreground">
            {getMessage("twoFactor.settingsNotEnrolled")}
          </p>
          <p className="mt-3 text-sm">
            <Link
              className="font-semibold text-primary underline-offset-4 hover:underline"
              href="/2fa"
            >
              {getMessage("twoFactor.settingsEnrolLink")}
            </Link>
          </p>
        </>
      )}
    </div>
  );
}
