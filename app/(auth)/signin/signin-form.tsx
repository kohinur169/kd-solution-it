// path: app/(auth)/signin/signin-form.tsx
"use client";

import Script from "next/script";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  bindSession,
  enrolDeviceProofKey,
  readStoredDeviceProofKey,
} from "@/lib/auth/device-proof-store";
import { formatMessage, getMessage } from "@/lib/i18n/messages";
import { rateLimitSentence } from "@/lib/auth/refusal-message";

/**
 * The sign in form.
 *
 * It renders the same Turnstile widget as signup, for the reason section 22 gives: the challenge
 * runs on sign in too, and a password endpoint without one is an oracle a script can query. The
 * widget is explicit so the theme follows the platform tokens and the token is reset after a
 * refusal.
 *
 * The failure it shows is one sentence, whatever happened: a wrong password, an address with no
 * account, an unconfirmed address and a closed account all look the same in this component because
 * they look the same on the wire. The single exception is the lock of section 22, which answers 423
 * only once the password is known to be right, and therefore tells a stranger nothing about whether
 * the account exists.
 *
 * ## The device proof key
 *
 * Both success paths - the single factor one and the one that follows a correct code - carry
 * `deviceProofRequired`, which the server answers from the live `device_proof_keys` rows. When it is
 * true this browser generates a pair, keeps the private half in IndexedDB and registers the public
 * half before the navigation. The enrolment is awaited but never awaited *for its result*: a browser
 * without WebCrypto, a storage that refuses, or an endpoint that is down leaves the merchant signed
 * in with the server asking again next time, because refusing the sign in would be punishing the
 * merchant for a feature that protects the platform.
 */

const turnstileScriptUrl =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileApi {
  render(
    container: HTMLElement,
    options: Readonly<Record<string, unknown>> & {
      readonly sitekey: string;
      readonly callback: (token: string) => void;
      readonly "error-callback": () => void;
      readonly "expired-callback": () => void;
    },
  ): string | undefined;
  reset(widgetId?: string): void;
}

function readTurnstileApi(): TurnstileApi | undefined {
  const candidate = (window as unknown as { turnstile?: TurnstileApi }).turnstile;

  return candidate === undefined ? undefined : candidate;
}

export interface SigninFormProperties {
  readonly siteKey: string | null;
  /** Where the browser goes once the cookie exists. */
  readonly afterSigninPath: string;
}

/**
 * The minutes a locked account has left, from `retryAfterSeconds`.
 *
 * Rounded up and floored at one, because "0 minutes" reads as "try again now" on the one screen where
 * trying again cannot work. A payload without the field still says the account is locked; the number
 * is a convenience, not the message.
 */
function lockedMinutes(payload: unknown): number {
  if (typeof payload !== "object" || payload === null) {
    return 1;
  }

  const seconds = (payload as { readonly retryAfterSeconds?: unknown }).retryAfterSeconds;

  return typeof seconds === "number" && Number.isFinite(seconds)
    ? Math.max(1, Math.ceil(seconds / 60))
    : 1;
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

const fieldClassName =
  "mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary";

const codeFieldClassName =
  "mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-lg tracking-[0.3em] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary";

/**
 * Whether the platform asked this browser to enrol a proof key.
 *
 * Absent is false. The field is a hint from the server, and a component that treated a missing field
 * as "enrol" would generate keys for every browser talking to an older server.
 */
function readDeviceProofRequired(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }

  return (payload as { readonly deviceProofRequired?: unknown }).deviceProofRequired === true;
}

/**
 * Give this browser a proof key and bind the session the sign in just created to it.
 *
 * Two halves, in this order, and the order is the point. The enrolment of STEP 049 registers the
 * public half of a key this browser generates; the binding of STEP 051 then asks the server to write
 * the first row of `public.sessions` naming that device and to hand back a rotating token in the
 * cookie. A session that is never bound is refused by every page that matters, so a browser that
 * cannot do both is told, rather than sent to a page that would answer the same way.
 *
 * The enrolment is skipped when the server said the account already has a key on this browser: a
 * second key would be a second device. It is never skipped for the *binding*, because a sign in
 * always creates a fresh session.
 */
type SessionEstablishment = "trusted" | "untrusted" | "failed";

async function establishSession(payload: unknown): Promise<SessionEstablishment> {
  const stored = await readStoredDeviceProofKey().catch(() => null);

  // Enrol when the server asked for a key, and also when this browser has none: an account whose
  // other browser holds the only key is never told to enrol here, and a session cannot bind without
  // a key of its own.
  if (readDeviceProofRequired(payload) || stored === null) {
    const enrolled = await enrolDeviceProofKey().catch(() => null);

    if (enrolled === null || !enrolled.ok) {
      return "failed";
    }
  }

  const bound = await bindSession().catch(() => null);

  if (bound === null || !bound.ok) {
    return "failed";
  }

  // STEP 052: a session bound to a device nobody has confirmed goes to the confirmation, not to the
  // page the merchant asked for. The alert is already on its way, and the confirm screen is the only
  // thing that turns the state over.
  return bound.deviceTrust === "untrusted" ? "untrusted" : "trusted";
}

/** Where this browser goes once the cookie and the device are in place. */
const deviceConfirmPath = "/devices/confirm";

/**
 * Read the challenge out of a sign in answer.
 *
 * A `two_factor_required` answer is the only shape this function accepts, and it accepts nothing
 * from it that it cannot check: a handle that is not a bounded string, or an expiry that is not a
 * number, is treated as an unreadable answer rather than shown. The expiry only decides when the
 * screen stops pretending a challenge is still live, so the server remains the authority.
 */
function readSecondFactor(payload: unknown): { token: string; expiresAtEpochMs: number } | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }

  const candidate = payload as {
    readonly status?: unknown;
    readonly challengeToken?: unknown;
    readonly expiresAtEpochMs?: unknown;
  };

  if (
    candidate.status !== "two_factor_required" ||
    typeof candidate.challengeToken !== "string" ||
    candidate.challengeToken.length === 0 ||
    candidate.challengeToken.length > 128 ||
    typeof candidate.expiresAtEpochMs !== "number" ||
    !Number.isFinite(candidate.expiresAtEpochMs)
  ) {
    return null;
  }

  return { token: candidate.challengeToken, expiresAtEpochMs: candidate.expiresAtEpochMs };
}

export function SigninForm({ siteKey, afterSigninPath }: SigninFormProperties): ReactNode {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [widgetId, setWidgetId] = useState<string | null>(null);
  const [scriptReady, setScriptReady] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  /**
   * The handle of a challenge whose password was accepted, or null.
   *
   * When it is set this component shows the code step and no longer shows the password form: the
   * password has already been used, and offering it again would invite a second challenge while the
   * first is still waiting.
   */
  const [challenge, setChallenge] = useState<{ token: string; expiresAtEpochMs: number } | null>(
    null,
  );
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [expired, setExpired] = useState(false);
  const container = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (siteKey === null || !scriptReady || widgetId !== null) {
      return;
    }

    const api = readTurnstileApi();
    const element = container.current;

    if (api === undefined || element === null) {
      return;
    }

    const rendered = api.render(element, {
      sitekey: siteKey,
      theme: "auto",
      callback: (token: string): void => {
        setTurnstileToken(token);
      },
      "error-callback": (): void => {
        setTurnstileToken(null);
      },
      "expired-callback": (): void => {
        setTurnstileToken(null);
      },
    });

    if (typeof rendered === "string") {
      setWidgetId(rendered);
    }
  }, [scriptReady, siteKey, widgetId]);

  // The expiry is a timer, not a comparison during render: a component that reads the clock while
  // rendering is not pure, and a challenge that lapses while the tab sits open has to be able to say
  // so without a reload. The server is still the authority - this only changes the sentence.
  useEffect(() => {
    if (challenge === null) {
      return undefined;
    }

    const remaining = Math.max(0, challenge.expiresAtEpochMs - Date.now());

    const timer = window.setTimeout(() => {
      setExpired(true);
    }, Math.min(remaining, 2_147_483_647));

    return () => {
      window.clearTimeout(timer);
    };
  }, [challenge]);

  function resetChallenge(): void {
    setTurnstileToken(null);

    if (widgetId !== null) {
      readTurnstileApi()?.reset(widgetId);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setMessage(null);
    setSubmitting(true);

    try {
      const response = await fetch("/api/auth/signin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password, turnstileToken }),
      });

      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);

        // 423 is the lock of section 22: the password was right and the account is closed to sign in
        // for a while, so the sentence names the lock and how long it lasts rather than asking for
        // the password again.
        setMessage(
          response.status === 429
            ? rateLimitSentence(payload)
            : response.status === 423
              ? formatMessage("signin.locked", { minutes: String(lockedMinutes(payload)) })
              : (readErrorMessage(payload) ?? getMessage("signin.unreadableResponse")),
        );
        setSubmitting(false);
        resetChallenge();

        return;
      }

      const payload: unknown = await response.json().catch(() => null);
      const secondFactor = readSecondFactor(payload);

      if (secondFactor !== null) {
        // No cookie was written: this answer names a challenge, and the code step is next.
        setChallenge(secondFactor);
        setExpired(false);
        setSubmitting(false);
        resetChallenge();

        return;
      }

      const establishment = await establishSession(payload);

      if (establishment === "failed") {
        // The cookie exists but names no device, and every page that reads one would refuse it.
        // Saying so here is the only honest option: navigating would bounce the merchant back to
        // this form with nothing to read.
        setMessage(getMessage("device.bindingFailed"));
        setSubmitting(false);

        return;
      }

      // A full navigation, so the cookie written by this response is the one the next request
      // carries; a client side transition could render a page from the previous identity.
      window.location.assign(
        establishment === "untrusted" ? deviceConfirmPath : afterSigninPath,
      );
    } catch {
      setMessage(getMessage("signin.unreadableResponse"));
      setSubmitting(false);
    }
  }

  async function verify(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    if (challenge === null) {
      return;
    }

    setMessage(null);
    setVerifying(true);

    try {
      const response = await fetch("/api/auth/2fa/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ challengeToken: challenge.token, code }),
      });

      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);

        setMessage(
          response.status === 429
            ? rateLimitSentence(payload)
            : response.status === 423
              ? formatMessage("signin.secondFactorLocked", { minutes: String(lockedMinutes(payload)) })
              : response.status === 401
                ? getMessage("signin.secondFactorRejected")
                : (readErrorMessage(payload) ?? getMessage("signin.unreadableResponse")),
        );
        setCode("");
        setVerifying(false);

        return;
      }

      const payload: unknown = await response.json().catch(() => null);

      const establishment = await establishSession(payload);

      if (establishment === "failed") {
        setMessage(getMessage("device.bindingFailed"));
        setVerifying(false);

        return;
      }

      window.location.assign(
        establishment === "untrusted" ? deviceConfirmPath : afterSigninPath,
      );
    } catch {
      setMessage(getMessage("signin.unreadableResponse"));
      setVerifying(false);
    }
  }

  if (challenge !== null) {
    return (
      <form
        className="mt-6 grid gap-4"
        noValidate
        onSubmit={(event) => {
          void verify(event);
        }}
      >
        <h2 className="text-lg font-semibold tracking-tight">{getMessage("signin.secondFactorTitle")}</h2>
        <p className="text-sm text-muted-foreground">{getMessage("signin.secondFactorBody")}</p>

        <label className="block text-sm font-medium">
          {getMessage("signin.secondFactorCodeLabel")}
          <input
            className={codeFieldClassName}
            name="code"
            type="text"
            autoComplete="one-time-code"
            inputMode="text"
            maxLength={11}
            required
            value={code}
            onChange={(event) => {
              setCode(event.target.value.trim().slice(0, 11));
            }}
          />
        </label>

        <p aria-live="polite" className="text-sm text-destructive" role="alert">
          {message ?? ""}
        </p>

        <button
          className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60"
          type="submit"
          disabled={verifying || code.length < 6}
        >
          {verifying ? getMessage("signin.secondFactorSubmitting") : getMessage("signin.secondFactorSubmit")}
        </button>

        {expired ? (
          <p className="text-sm text-muted-foreground" role="status">
            {getMessage("signin.secondFactorExpired")}
          </p>
        ) : null}

        <button
          className="justify-self-start text-sm font-semibold text-primary underline-offset-4 hover:underline"
          type="button"
          onClick={(): void => {
            setChallenge(null);
            setCode("");
            setMessage(null);
            setPassword("");
          }}
        >
          {getMessage("signin.secondFactorRestart")}
        </button>
      </form>
    );
  }

  return (
    <form
      className="mt-6 grid gap-4"
      noValidate
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      {siteKey === null ? null : (
        <>
          <Script
            src={turnstileScriptUrl}
            strategy="afterInteractive"
            onLoad={() => {
              setScriptReady(true);
            }}
          />
          <div ref={container} className="min-h-16" />
        </>
      )}

      <label className="block text-sm font-medium">
        {getMessage("signin.emailLabel")}
        <input
          className={fieldClassName}
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          maxLength={254}
          required
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
          }}
        />
      </label>

      <label className="block text-sm font-medium">
        {getMessage("signin.passwordLabel")}
        <input
          className={fieldClassName}
          name="password"
          type="password"
          autoComplete="current-password"
          maxLength={128}
          required
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
        />
      </label>

      {siteKey === null ? null : (
        <p className="text-xs text-muted-foreground">{getMessage("signin.turnstileNotice")}</p>
      )}

      <p aria-live="polite" className="text-sm text-destructive" role="alert">
        {message ?? ""}
      </p>

      <button
        className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60"
        type="submit"
        disabled={submitting}
      >
        {submitting ? getMessage("signin.submitting") : getMessage("signin.submit")}
      </button>
    </form>
  );
}
