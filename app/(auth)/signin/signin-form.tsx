// path: app/(auth)/signin/signin-form.tsx
"use client";

import Script from "next/script";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { getMessage } from "@/lib/i18n/messages";

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
 * they look the same on the wire.
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

export function SigninForm({ siteKey, afterSigninPath }: SigninFormProperties): ReactNode {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [widgetId, setWidgetId] = useState<string | null>(null);
  const [scriptReady, setScriptReady] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
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

        setMessage(readErrorMessage(payload) ?? getMessage("signin.unreadableResponse"));
        setSubmitting(false);
        resetChallenge();

        return;
      }

      // A full navigation, so the cookie written by this response is the one the next request
      // carries; a client side transition could render a page from the previous identity.
      window.location.assign(afterSigninPath);
    } catch {
      setMessage(getMessage("signin.unreadableResponse"));
      setSubmitting(false);
    }
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
