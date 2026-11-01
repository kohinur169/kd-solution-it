// path: app/(auth)/signup/signup-form.tsx
"use client";

import Script from "next/script";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { formatMessage, getMessage } from "@/lib/i18n/messages";

/**
 * The signup form.
 *
 * It is a client component for three reasons and no more: the Turnstile widget needs a browser, the
 * submit needs `fetch`, and the error of a rejected form belongs to the field that caused it. Every
 * sentence it renders comes from the string catalog, and every rule it applies on this side is a
 * copy of a rule the server enforces again - the browser is a convenience, never the check.
 *
 * The Turnstile widget is rendered explicitly rather than through its automatic mode, because the
 * theme has to follow the platform's own theme tokens and the token has to be reset when a submit
 * fails. The site key arrives from the server as a prop; when it is absent the widget is not
 * rendered at all, and the server decides what a deployment without a key may do.
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

export interface PolicyLabel {
  readonly key: string;
  readonly label: string;
}

export interface SignupFormProperties {
  /** The public Turnstile site key, or null when this deployment has none. */
  readonly siteKey: string | null;
  readonly policies: readonly PolicyLabel[];
}

type SubmitState = "idle" | "submitting" | "succeeded";

/** The rule of a password detail, so the form can say which rule was broken. */
function readPasswordRule(payload: unknown): string | null {
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

  for (const detail of details) {
    if (typeof detail !== "object" || detail === null) {
      continue;
    }

    const record = detail as { readonly field?: unknown; readonly rule?: unknown };

    if (record.field === "password" && typeof record.rule === "string") {
      return record.rule;
    }
  }

  return null;
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

export function SignupForm({ siteKey, policies }: SignupFormProperties): ReactNode {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [widgetId, setWidgetId] = useState<string | null>(null);
  const [scriptReady, setScriptReady] = useState(false);
  const [state, setState] = useState<SubmitState>("idle");
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
    setState("submitting");

    try {
      const response = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fullName,
          email,
          password,
          companyName,
          acceptedPolicies: accepted ? policies.map((policy) => policy.key) : [],
          turnstileToken,
        }),
      });
      const payload: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        const rule = readPasswordRule(payload);

        setMessage(
          rule === "breached"
            ? getMessage("signup.passwordBreached")
            : rule !== null
              ? getMessage("signup.passwordTooWeak")
              : readErrorMessage(payload) ?? getMessage("signup.unreadableResponse"),
        );
        setState("idle");
        resetChallenge();

        return;
      }

      setState("succeeded");
    } catch {
      setMessage(getMessage("signup.unreadableResponse"));
      setState("idle");
    }
  }

  if (state === "succeeded") {
    return (
      <div className="mt-6" role="status">
        <h2 className="text-xl font-semibold tracking-tight">{getMessage("signup.successTitle")}</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {formatMessage("signup.successBody", { email })}
        </p>
      </div>
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
        {getMessage("signup.fullNameLabel")}
        <input
          className={fieldClassName}
          name="fullName"
          autoComplete="name"
          maxLength={120}
          required
          value={fullName}
          onChange={(event) => {
            setFullName(event.target.value);
          }}
        />
      </label>

      <label className="block text-sm font-medium">
        {getMessage("signup.companyNameLabel")}
        <input
          className={fieldClassName}
          name="companyName"
          autoComplete="organization"
          maxLength={120}
          required
          value={companyName}
          onChange={(event) => {
            setCompanyName(event.target.value);
          }}
        />
      </label>

      <label className="block text-sm font-medium">
        {getMessage("signup.emailLabel")}
        <input
          className={fieldClassName}
          name="email"
          type="email"
          autoComplete="email"
          maxLength={254}
          required
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
          }}
        />
      </label>

      <label className="block text-sm font-medium">
        {getMessage("signup.passwordLabel")}
        <input
          className={fieldClassName}
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          required
          aria-describedby="signup-password-hint"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
        />
        <span id="signup-password-hint" className="mt-1 block text-xs font-normal text-muted-foreground">
          {getMessage("signup.passwordRulesTitle")}
        </span>
        <ul
          className="mt-1 ml-4 list-disc text-xs font-normal text-muted-foreground"
          aria-describedby="signup-password-hint"
        >
          <li>{getMessage("signup.passwordRuleLength")}</li>
          <li>{getMessage("signup.passwordRuleKinds")}</li>
          <li>{getMessage("signup.passwordRulePersonal")}</li>
          <li>{getMessage("signup.passwordRuleBreach")}</li>
        </ul>
      </label>

      <fieldset className="rounded-lg border border-border p-3">
        <legend className="px-1 text-sm font-medium">{getMessage("signup.policiesTitle")}</legend>
        <p className="text-xs text-muted-foreground">{getMessage("signup.policiesNotice")}</p>
        <ul className="mt-2 grid gap-1 text-sm">
          {policies.map((policy) => (
            <li key={policy.key} className="flex gap-2">
              <span aria-hidden="true" className="text-muted-foreground">
                &middot;
              </span>
              {policy.label}
            </li>
          ))}
        </ul>
        <label className="mt-3 flex items-start gap-2 text-sm">
          <input
            className="mt-0.5 size-4 accent-[var(--kd-primary)]"
            type="checkbox"
            name="acceptedPolicies"
            required
            checked={accepted}
            onChange={(event) => {
              setAccepted(event.target.checked);
            }}
          />
          {getMessage("signup.policiesAccept")}
        </label>
      </fieldset>

      {siteKey === null ? null : (
        <p className="text-xs text-muted-foreground">{getMessage("signup.turnstileNotice")}</p>
      )}

      <p aria-live="polite" className="text-sm text-destructive" role="alert">
        {message ?? ""}
      </p>

      <button
        className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60"
        type="submit"
        disabled={state === "submitting"}
      >
        {state === "submitting" ? getMessage("signup.submitting") : getMessage("signup.submit")}
      </button>
    </form>
  );
}
