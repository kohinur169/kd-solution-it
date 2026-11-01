// path: app/(auth)/2fa/two-factor-form.tsx
"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { getMessage } from "@/lib/i18n/messages";
import { csrfHeaders } from "@/lib/security/csrf-client";

/**
 * The enrolment form: create the key, confirm one code, keep the backup codes.
 *
 * Three states and no fourth. `idle` is the page as it arrives. `started` holds the secret, the
 * manually typeable key and the symbol, all of which exist only in this component's memory. `done`
 * holds the ten backup codes, which the platform cannot produce again, so leaving the page discards
 * them - which is why the screen says so before the button that leaves it is reachable.
 *
 * The symbol arrives as a `data:` URL and is shown in an `img`, never as markup: a route that
 * returns SVG for `dangerouslySetInnerHTML` is a route that returns a document this page would have
 * to trust.
 */

const primaryButtonClassName =
  "mt-5 inline-flex w-full items-center justify-center rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60 sm:w-auto";

const codeFieldClassName =
  "mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-lg tracking-[0.4em] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary";

interface EnrolmentBody {
  readonly secretForEntry: string;
  readonly accountUri: string;
  readonly symbol: { readonly extent: number; readonly data: string } | null;
}

interface ConfirmationBody {
  readonly backupCodes: readonly string[];
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item): item is string => typeof item === "string");
}

/** Read the enrolment answer, refusing anything that is not the shape the route promises. */
function readEnrolment(payload: unknown): EnrolmentBody | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }

  const candidate = payload as {
    readonly secretForEntry?: unknown;
    readonly accountUri?: unknown;
    readonly symbol?: unknown;
  };

  if (typeof candidate.secretForEntry !== "string" || typeof candidate.accountUri !== "string") {
    return null;
  }

  return {
    secretForEntry: candidate.secretForEntry,
    accountUri: candidate.accountUri,
    symbol: readSymbol(candidate.symbol),
  };
}

/**
 * Read the drawing.
 *
 * A path is only drawn when both numbers are finite and the path itself is nothing but the
 * instructions `qrPath` writes: digits, the letters `Mhvz` and separators. A document built from a
 * value that could be anything is a document that could be an injection.
 */
function readSymbol(
  value: unknown,
): { readonly extent: number; readonly data: string } | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const candidate = value as { readonly extent?: unknown; readonly data?: unknown };
  const extent = candidate.extent;
  const data = candidate.data;

  if (
    typeof extent !== "number" ||
    !Number.isFinite(extent) ||
    extent <= 0 ||
    extent > 4_096 ||
    typeof data !== "string" ||
    data.length > 200_000 ||
    !/^[Mhvz0-9 .-]*$/u.test(data)
  ) {
    return null;
  }

  return { extent, data };
}

function readConfirmation(payload: unknown): ConfirmationBody | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }

  const codes = (payload as { readonly backupCodes?: unknown }).backupCodes;

  return isStringArray(codes) && codes.length > 0 ? { backupCodes: codes } : null;
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

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

/**
 * The four screens this form can show.
 *
 * `done` exists because the three state form had a defect worth fixing before STEP 042 built on
 * it: after "I have saved the codes" the component fell back to `idle`, so a person who had just
 * enrolled was offered the button that starts an enrolment again, and pressing it answered
 * `CONFLICT`. A flow that ends has to end somewhere.
 */
type Stage = "idle" | "started" | "codes" | "done";

export function TwoFactorForm(): ReactNode {
  const [stage, setStage] = useState<Stage>("idle");
  const [enrolment, setEnrolment] = useState<EnrolmentBody | null>(null);
  const [backupCodes, setBackupCodes] = useState<readonly string[]>([]);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function start(): Promise<void> {
    setMessage(null);
    setBusy(true);

    try {
      const csrf = await csrfHeaders();
      const response = await fetch("/api/auth/2fa/enroll", {
        method: "POST",
        headers: { "content-type": "application/json", ...csrf },
        body: "{}",
      });
      const payload = await readJson(response);

      if (response.status === 401) {
        setMessage(getMessage("twoFactor.signInRequired"));
        setBusy(false);

        return;
      }

      if (response.status === 409) {
        setMessage(getMessage("twoFactor.alreadyEnrolled"));
        setBusy(false);

        return;
      }

      const parsed = response.ok ? readEnrolment(payload) : null;

      if (parsed === null) {
        setMessage(readErrorMessage(payload) ?? getMessage("twoFactor.unreadableResponse"));
        setBusy(false);

        return;
      }

      setEnrolment(parsed);
      setStage("started");
      setBusy(false);
    } catch {
      setMessage(getMessage("twoFactor.unreadableResponse"));
      setBusy(false);
    }
  }

  async function confirm(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setMessage(null);
    setBusy(true);

    try {
      const csrf = await csrfHeaders();
      const response = await fetch("/api/auth/2fa/confirm", {
        method: "POST",
        headers: { "content-type": "application/json", ...csrf },
        body: JSON.stringify({ code }),
      });
      const payload = await readJson(response);

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

      const parsed = response.ok ? readConfirmation(payload) : null;

      if (parsed === null) {
        setMessage(readErrorMessage(payload) ?? getMessage("twoFactor.unreadableResponse"));
        setBusy(false);

        return;
      }

      setBackupCodes(parsed.backupCodes);
      setStage("codes");
      setBusy(false);
    } catch {
      setMessage(getMessage("twoFactor.unreadableResponse"));
      setBusy(false);
    }
  }

  if (stage === "codes") {
    return (
      <div className="mt-6">
        <h2 className="text-lg font-semibold tracking-tight">{getMessage("twoFactor.backupTitle")}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{getMessage("twoFactor.backupBody")}</p>
        <ul
          aria-label={getMessage("twoFactor.backupCodesLabel")}
          className="mt-4 grid grid-cols-1 gap-2 rounded-lg border border-border bg-background p-4 font-mono text-sm sm:grid-cols-2"
        >
          {backupCodes.map((backupCode) => (
            <li key={backupCode} className="tracking-wider">
              {backupCode}
            </li>
          ))}
        </ul>
        <p className="mt-4 rounded-lg border border-border bg-muted/40 p-3 text-sm" role="status">
          {getMessage("twoFactor.backupWarning")}
        </p>
        <button
          className={primaryButtonClassName}
          type="button"
          onClick={(): void => {
            setBackupCodes([]);
            setStage("done");
          }}
        >
          {getMessage("twoFactor.done")}
        </button>
      </div>
    );
  }

  if (stage === "done") {
    return (
      <div className="mt-6">
        <h2 className="text-lg font-semibold tracking-tight">{getMessage("twoFactor.enrolledTitle")}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{getMessage("twoFactor.enrolledBody")}</p>
        <p className="mt-4 rounded-lg border border-border bg-muted/40 p-3 text-sm" role="status">
          {getMessage("twoFactor.backupWarning")}
        </p>
      </div>
    );
  }

  if (stage === "idle" || enrolment === null) {
    return (
      <div className="mt-6">
        <h2 className="text-lg font-semibold tracking-tight">{getMessage("twoFactor.startTitle")}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{getMessage("twoFactor.startBody")}</p>
        <button
          className={primaryButtonClassName}
          type="button"
          disabled={busy}
          onClick={(): void => {
            void start();
          }}
        >
          {busy ? getMessage("twoFactor.starting") : getMessage("twoFactor.startSubmit")}
        </button>
        {message === null ? null : (
          <p className="mt-3 text-sm text-destructive" role="alert">
            {message}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="mt-6">
      <h2 className="text-lg font-semibold tracking-tight">{getMessage("twoFactor.startTitle")}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{getMessage("twoFactor.startBody")}</p>

      <div className="mt-4 flex flex-col items-center gap-4 sm:flex-row sm:items-start">
        {enrolment.symbol === null ? null : (
          <svg
            aria-label={getMessage("twoFactor.qrAlt")}
            className="h-48 w-48 shrink-0 rounded-lg border border-border bg-symbol-background p-2"
            role="img"
            viewBox={`0 0 ${enrolment.symbol.extent} ${enrolment.symbol.extent}`}
          >
            <rect
              className="fill-symbol-background"
              height={enrolment.symbol.extent}
              width={enrolment.symbol.extent}
            />
            <path
              className="fill-symbol"
              d={enrolment.symbol.data}
              shapeRendering="crispEdges"
            />
          </svg>
        )}
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            {getMessage("twoFactor.manualKeyLabel")}
          </p>
          <p className="mt-1 break-all font-mono text-sm tracking-wider">
            {enrolment.secretForEntry}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">{getMessage("twoFactor.copyHint")}</p>
        </div>
      </div>

      <form className="mt-6" onSubmit={(event): void => void confirm(event)}>
        <h2 className="text-lg font-semibold tracking-tight">{getMessage("twoFactor.confirmTitle")}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{getMessage("twoFactor.confirmBody")}</p>
        <label className="mt-4 block text-sm font-medium" htmlFor="totp-code">
          {getMessage("twoFactor.codeLabel")}
        </label>
        <input
          autoComplete="one-time-code"
          className={codeFieldClassName}
          id="totp-code"
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
        <button className={primaryButtonClassName} disabled={busy || code.length !== 6} type="submit">
          {busy ? getMessage("twoFactor.confirming") : getMessage("twoFactor.confirmSubmit")}
        </button>
        {message === null ? null : (
          <p className="mt-3 text-sm text-destructive" role="alert">
            {message}
          </p>
        )}
      </form>
    </div>
  );
}
