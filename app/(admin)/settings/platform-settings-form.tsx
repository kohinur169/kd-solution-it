// path: app/(admin)/settings/platform-settings-form.tsx
"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { deviceProofHeaders } from "@/lib/auth/device-proof-store";
import { rateLimitSentence } from "@/lib/auth/refusal-message";
import { REAUTHENTICATION_REQUIRED_RULE } from "@/lib/auth/step-up";
import type { PlatformInformationSnapshot } from "@/lib/settings/service";
import { formatMessage, getMessage, type MessagePath } from "@/lib/i18n/messages";
import { csrfHeaders } from "@/lib/security/csrf-client";

/**
 * Section 24's platform information: ten fields, one save button.
 *
 * ## What this component does and does not decide
 *
 * Every rule lives in `lib/settings/registry.ts` and `lib/settings/service.ts`: which keys exist, what
 * shape each value has, who may write them and how fresh the second factor must be. This component
 * renders the fields the server sent and posts one body. It also sends back the instant the page was
 * rendered at, because a settings form is the one form where a silent overwrite of somebody else's save
 * is worth refusing: two open tabs are enough to lose a change.
 *
 * ## Why the values live in state and not in the DOM
 *
 * A field's value is what the operator typed, so it belongs to React and not to the browser's form
 * data: the submit handler builds the map from state, and a refused save leaves every value exactly
 * where it was so the operator can fix one field instead of retyping ten.
 */

/** One refusal from the route, as the field and rule it names. */
interface RefusalDetail {
  readonly field?: unknown;
  readonly rule?: unknown;
}

function refusalOf(payload: unknown): RefusalDetail | null {
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

  return details[0] as RefusalDetail;
}

/** The sentence for a refused rule, in the vocabulary of the field that raised it. */
function messageForRule(rule: string, kind: string): string {
  if (rule === "required") {
    return getMessage("officeSettings.invalidRequired");
  }

  if (rule === "too_long") {
    return getMessage("officeSettings.invalidLength");
  }

  if (rule === "invalid_date") {
    return getMessage("officeSettings.invalidDate");
  }

  if (rule === "unknown_key") {
    return getMessage("officeSettings.unknownKey");
  }

  if (kind === "email") {
    return getMessage("officeSettings.invalidEmail");
  }

  if (kind === "phone") {
    return getMessage("officeSettings.invalidPhone");
  }

  if (kind === "path") {
    return getMessage("officeSettings.invalidPath");
  }

  if (kind === "url") {
    return getMessage("officeSettings.invalidUrl");
  }

  return getMessage("officeSettings.invalidValue");
}

/** The sentence for a whole answer, when the refusal is not about one field. */
function messageForStatus(status: number, payload: unknown): string {
  if (status === 429) {
    return rateLimitSentence(payload);
  }

  if (status === 401) {
    return getMessage("officeSettings.signedOut");
  }

  const detail = refusalOf(payload);

  if (status === 403) {
    return getMessage(
      detail?.rule === REAUTHENTICATION_REQUIRED_RULE
        ? "officeSettings.reauthRequired"
        : "officeSettings.forbiddenSettings",
    );
  }

  if (status === 409) {
    return getMessage("officeSettings.staleSave");
  }

  return getMessage("officeSettings.failed");
}

/** Whether the save worked, and what to say either way. */
interface SaveAnswer {
  readonly ok: boolean;
  readonly message: string;
  /** The field a validation failure named, when it named one. */
  readonly field: string | null;
  /** The rule a validation failure named, so the sentence can match the field's kind. */
  readonly rule: string | null;
  /** The HTTP status, so a `422` can be worded by its rule rather than by its envelope. */
  readonly status: number;
}

async function postSave(
  values: Readonly<Record<string, string>>,
  savedAtEpochMs: number | null,
): Promise<SaveAnswer> {
  const path = "/api/office/settings";
  const body = JSON.stringify({ action: "save", values, savedAtEpochMs });
  const proof = await deviceProofHeaders("POST", path, body);

  if (proof === null) {
    return {
      ok: false,
      message: getMessage("device.proofRequired"),
      field: null,
      rule: null,
      status: 0,
    };
  }

  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...proof, ...(await csrfHeaders()) },
    body,
  });

  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    const detail = refusalOf(payload);

    return {
      ok: false,
      message: messageForStatus(response.status, payload),
      field: typeof detail?.field === "string" ? detail.field : null,
      rule: typeof detail?.rule === "string" ? detail.rule : null,
      status: response.status,
    };
  }

  return { ok: true, message: "", field: null, rule: null, status: response.status };
}

const formClasses = "flex flex-col gap-5";

const termClasses = "text-sm font-medium text-foreground";

const gridClasses = "grid grid-cols-1 gap-4 md:grid-cols-2";

const bodyClasses = "text-sm text-muted-foreground";

const hintClasses = "text-xs text-muted-foreground";

const inputClasses =
  "mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary";

const primaryButtonClasses =
  "w-fit inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60";

const messageClasses = "text-sm";

/** One instant, printed the same way on every office screen: UTC, minute precision. */
function formatInstant(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** The input type a field's kind asks for. */
function inputTypeOf(kind: string): "date" | "email" | "tel" | "text" | "url" {
  if (kind === "date") {
    return "date";
  }

  if (kind === "email") {
    return "email";
  }

  if (kind === "phone") {
    return "tel";
  }

  return kind === "url" ? "url" : "text";
}

export function PlatformSettingsForm({
  snapshot,
}: {
  readonly snapshot: PlatformInformationSnapshot;
}): ReactNode {
  const router = useRouter();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(snapshot.fields.map((field) => [field.key, field.value])),
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failedField, setFailedField] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    setFailedField(null);

    try {
      const answer = await postSave(values, snapshot.savedAtEpochMs);

      setBusy(false);

      if (!answer.ok) {
        const field = snapshot.fields.find((candidate) => candidate.key === answer.field);
        const rule = answer.rule;

        setMessage(
          answer.status === 422 && rule !== null
            ? messageForRule(rule, field?.kind ?? "text")
            : answer.message,
        );
        setFailedField(answer.field);

        return;
      }

      setMessage(getMessage("officeSettings.savedDone"));
      router.refresh();
    } catch {
      setBusy(false);
      setMessage(getMessage("officeSettings.failed"));
    }
  }

  const savedLabel =
    snapshot.savedAtEpochMs === null
      ? getMessage("officeSettings.neverSaved")
      : formatMessage("officeSettings.savedAt", { at: formatInstant(snapshot.savedAtEpochMs) });

  return (
    <form
      className={formClasses}
      onSubmit={(event): void => {
        void submit(event);
      }}
    >
      <p className={bodyClasses}>{savedLabel}</p>
      <p className={hintClasses}>{getMessage("officeSettings.defaultsNote")}</p>

      <fieldset className="flex flex-col gap-3 border-0 p-0">
        <legend className={termClasses}>{getMessage("officeSettings.identityLegend")}</legend>
        <div className={gridClasses}>
          {snapshot.fields
            .filter((field) => field.group === "platform")
            .map((field) => (
            <label className="block" key={field.key}>
              <span className={bodyClasses}>{getMessage(field.labelKey as MessagePath)}</span>
              <input
                aria-invalid={failedField === field.key}
                autoComplete="off"
                className={inputClasses}
                maxLength={field.maxLength}
                name={field.key}
                onChange={(event): void => {
                  const next = event.target.value;

                  setValues((previous) => ({ ...previous, [field.key]: next }));
                }}
                required={field.required}
                type={inputTypeOf(field.kind)}
                value={values[field.key] ?? ""}
              />
              {field.hintKey === null ? null : (
                <span className={hintClasses}>{getMessage(field.hintKey as MessagePath)}</span>
              )}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-3 border-0 p-0">
        <legend className={termClasses}>{getMessage("officeSettings.officerHeading")}</legend>
        <p className={hintClasses}>{getMessage("officeSettings.officerDescription")}</p>
        <div className={gridClasses}>
          {snapshot.fields
            .filter((field) => field.group === "officer")
            .map((field) => (
              <label className="block" key={field.key}>
                <span className={bodyClasses}>{getMessage(field.labelKey as MessagePath)}</span>
                <input
                  aria-invalid={failedField === field.key}
                  autoComplete="off"
                  className={inputClasses}
                  maxLength={field.maxLength}
                  name={field.key}
                  onChange={(event): void => {
                    const next = event.target.value;

                    setValues((previous) => ({ ...previous, [field.key]: next }));
                  }}
                  required={field.required}
                  type={inputTypeOf(field.kind)}
                  value={values[field.key] ?? ""}
                />
                {field.hintKey === null ? null : (
                  <span className={hintClasses}>{getMessage(field.hintKey as MessagePath)}</span>
                )}
              </label>
            ))}
        </div>
      </fieldset>

      <button className={primaryButtonClasses} disabled={busy} type="submit">
        {busy ? getMessage("officeSettings.saveBusy") : getMessage("officeSettings.saveSubmit")}
      </button>

      {message === null ? null : (
        <p className={messageClasses} role="status">
          {message}
        </p>
      )}
    </form>
  );
}

