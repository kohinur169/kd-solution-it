// path: app/(dashboard)/developers/api-credentials/credential-panel.tsx
"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { getMessage } from "@/lib/i18n/messages";
import {
  CREDENTIAL_LABEL_MAXIMUM_LENGTH,
  CREDENTIAL_MODES,
  CREDENTIAL_RULES,
  type CredentialMode,
  type CredentialPanelView,
  type CredentialView,
} from "@/lib/api/credential-fields";
import { csrfHeaders } from "@/lib/security/csrf-client";

/**
 * Section 20's credential desk on the merchant's side: one form that makes a credential, and the list of the
 * ones already made.
 *
 * There is no "show" button anywhere in this file, and that is the feature. A full key is displayed nowhere -
 * not at creation, not later, not behind a reveal - because the section says it is never displayed. What this
 * panel can do is print a mask, the handle and the last four characters, which is enough for a merchant to
 * tell two credentials apart and not enough to copy one.
 */

/** The one verb this panel sends. */
type MutationVerb = "POST";

const panelClasses = "flex flex-col gap-6";

const formClasses = "flex flex-col gap-3 rounded-lg border border-border p-4";

const headingClasses = "text-sm font-semibold text-foreground";

const helpClasses = "text-xs text-muted-foreground";

const labelClasses = "text-xs font-semibold uppercase tracking-wide text-muted-foreground";

const fieldClasses =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary";

const gridClasses = "grid grid-cols-1 gap-3 sm:grid-cols-2";

const primaryButtonClasses =
  "inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60";

const messageClasses = "text-sm";

const listClasses = "flex flex-col gap-3";

const itemClasses = "flex flex-col gap-2 rounded-lg border border-border p-4";

const itemHeaderClasses = "flex flex-wrap items-center justify-between gap-2";

const badgeClasses = "rounded-full border border-border px-2 py-0.5 text-xs font-semibold text-muted-foreground";

const codeClasses =
  "overflow-x-auto rounded-lg bg-muted/60 px-3 py-2 font-mono text-xs text-foreground sm:text-sm";

const metaClasses = "flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground";

/** The sentence for one refusal rule, so a form answers in the merchant's words rather than a code. */
function sentenceForRule(rule: string | null, status: number): string {
  if (status === 401) {
    return getMessage("api.signedOut");
  }

  if (status === 403) {
    return getMessage("api.forbidden");
  }

  if (status === 429) {
    return getMessage("api.rateLimited");
  }

  switch (rule) {
    case CREDENTIAL_RULES.labelInvalid:
    case CREDENTIAL_RULES.invalidFormat:
      return getMessage("api.ruleLabelInvalid");
    case CREDENTIAL_RULES.modeInvalid:
      return getMessage("api.ruleModeInvalid");
    case CREDENTIAL_RULES.labelTaken:
      return getMessage("api.ruleLabelTaken");
    case CREDENTIAL_RULES.limitReached:
      return getMessage("api.ruleLimitReached");
    case "csrf_token_invalid":
      return getMessage("api.ruleCsrf");
    default:
      return getMessage("api.createFailed");
  }
}

/** The rule a refusal named, if it named one. */
function ruleOf(body: unknown): string | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }

  const error = (body as { readonly error?: unknown }).error;

  if (typeof error !== "object" || error === null) {
    return null;
  }

  const details = (error as { readonly details?: unknown }).details;

  if (!Array.isArray(details) || details.length === 0) {
    return null;
  }

  const first = details[0] as { readonly rule?: unknown };

  return typeof first.rule === "string" ? first.rule : null;
}

/** One credential, as a card: the mask, the mode, the state and when it was made. */
function CredentialCard({ credential }: { readonly credential: CredentialView }): ReactNode {
  const status =
    credential.status === "active" ? getMessage("api.statusActive") : getMessage("api.statusRevoked");

  return (
    <li className={itemClasses}>
      <div className={itemHeaderClasses}>
        <p className="text-sm font-semibold text-foreground">{credential.label}</p>
        <span className={badgeClasses}>
          {credential.mode === "test" ? getMessage("api.modeTest") : getMessage("api.modeLive")} · {status}
        </span>
      </div>

      <p className={labelClasses}>{getMessage("api.maskedKeyLabel")}</p>
      <code className={codeClasses}>{credential.maskedKey}</code>

      <p className={labelClasses}>{getMessage("api.signingSecretLabel")}</p>
      <code className={codeClasses}>{credential.maskedSigningSecret}</code>

      <div className={metaClasses}>
        <span>
          {getMessage("api.createdLabel")} {credential.createdAt.slice(0, 10)}
        </span>
        <span>
          {getMessage("api.lastUsedLabel")}{" "}
          {credential.lastUsedAt === null
            ? getMessage("api.lastUsedNever")
            : credential.lastUsedAt.slice(0, 10)}
        </span>
      </div>
    </li>
  );
}

export function CredentialPanel({ view }: { readonly view: CredentialPanelView }): ReactNode {
  const router = useRouter();
  const [label, setLabel] = useState<string>("");
  const [mode, setMode] = useState<CredentialMode>("test");
  const [busy, setBusy] = useState<boolean>(false);
  const [message, setMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState<boolean>(false);
  const [created, setCreated] = useState<CredentialView | null>(null);

  const trimmed = label.trim();
  const ready = trimmed.length > 0 && trimmed.length <= CREDENTIAL_LABEL_MAXIMUM_LENGTH;

  /** The one act: make a credential, then re-read the page so the list is the server's answer. */
  async function save(): Promise<void> {
    setBusy(true);
    setMessage(null);
    setIsError(false);
    setCreated(null);

    const path = "/api/developers/api-credentials";

    try {
      const response = await fetch(path, {
        method: "POST" satisfies MutationVerb,
        headers: { "content-type": "application/json", ...(await csrfHeaders()) },
        body: JSON.stringify({ label: trimmed, mode }),
        credentials: "same-origin",
        cache: "no-store",
      });

      if (!response.ok) {
        const refusal: unknown = await response.json().catch(() => null);

        setBusy(false);
        setMessage(sentenceForRule(ruleOf(refusal), response.status));
        setIsError(true);

        return;
      }

      const body = (await response.json().catch(() => null)) as
        | { readonly credential?: CredentialView }
        | null;

      setBusy(false);
      setLabel("");
      setMessage(getMessage("api.created"));
      setIsError(false);

      if (body !== null && body.credential !== undefined) {
        setCreated(body.credential);
      }

      router.refresh();
    } catch {
      setBusy(false);
      setMessage(getMessage("api.createFailed"));
      setIsError(true);
    }
  }

  return (
    <div className={panelClasses}>
      <form
        className={formClasses}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <h2 className={headingClasses}>{getMessage("api.createTitle")}</h2>
        <p className={helpClasses}>{getMessage("api.createHelp")}</p>

        <div className={gridClasses}>
          <label className="flex flex-col gap-1">
            <span className={labelClasses}>{getMessage("api.labelLabel")}</span>
            <input
              className={fieldClasses}
              maxLength={CREDENTIAL_LABEL_MAXIMUM_LENGTH}
              onChange={(event) => setLabel(event.target.value)}
              placeholder={getMessage("api.labelPlaceholder")}
              type="text"
              value={label}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className={labelClasses}>{getMessage("api.modeLabel")}</span>
            <select
              className={fieldClasses}
              onChange={(event) => {
                const next = event.target.value;
                setMode(next === "live" ? "live" : "test");
              }}
              value={mode}
            >
              {CREDENTIAL_MODES.map((option) => (
                <option key={option} value={option}>
                  {option === "test" ? getMessage("api.modeTest") : getMessage("api.modeLive")}
                </option>
              ))}
            </select>
          </label>
        </div>

        <p className={helpClasses}>
          {getMessage("api.limitLabel")
            .replace("%used%", String(view.counts[mode]))
            .replace("%limit%", String(view.limit))}
        </p>

        <div>
          <button className={primaryButtonClasses} disabled={busy || !ready || view.counts[mode] >= view.limit} type="submit">
            {busy ? getMessage("api.creating") : getMessage("api.createButton")}
          </button>
        </div>
      </form>

      {message === null ? null : (
        <p className={isError ? `${messageClasses} text-destructive` : messageClasses} role={isError ? "alert" : "status"}>
          {message}
        </p>
      )}

      {created === null ? null : (
        <div className={itemClasses}>
          <p className={headingClasses}>{getMessage("api.createdTitle")}</p>
          <code className={codeClasses}>{created.maskedKey}</code>
          <p className={helpClasses}>{getMessage("api.createdHelp")}</p>
        </div>
      )}

      <section className={listClasses}>
        <h2 className={headingClasses}>{getMessage("api.listTitle")}</h2>

        {view.credentials.length === 0 ? (
          <p className={helpClasses}>{getMessage("api.listEmpty")}</p>
        ) : (
          <ul className={listClasses}>
            {view.credentials.map((credential) => (
              <CredentialCard credential={credential} key={credential.id} />
            ))}
          </ul>
        )}

        {view.truncated ? <p className={helpClasses}>{getMessage("api.listTruncated")}</p> : null}
      </section>
    </div>
  );
}
