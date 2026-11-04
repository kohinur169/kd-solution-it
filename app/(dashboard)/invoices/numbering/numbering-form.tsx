// path: app/(dashboard)/invoices/numbering/numbering-form.tsx
"use client";

import Link from "next/link";
import { useState, type FormEvent, type ReactNode } from "react";
import { formatMessage, getMessage, type MessagePath } from "@/lib/i18n/messages";
import { csrfHeaders } from "@/lib/security/csrf-client";
import type { InvoiceNumberSettings } from "@/services/invoices/invoice-numbering";

/**
 * The numbering settings form.
 *
 * ## Why the preview sits above the boxes
 *
 * A prefix and a padding are abstract until they produce something. `INV` and `5` mean nothing to a merchant
 * who has not seen `INV-00001`; the preview is computed on the server from exactly the values that were saved,
 * and it is also recomputed here from the boxes as they are typed, so the effect of a change is visible before
 * it is committed. The two agree because both call `printInvoiceNumber`.
 *
 * ## Why the floor is shown, not enforced here
 *
 * The next number may not go below the highest number the merchant has already printed, and that value is
 * shown beside the box. The rule is enforced by the service and by the database, because a merchant who edits
 * two screens in two tabs must not be able to talk their way past it in the browser; showing it here is what
 * makes the refusal expected rather than surprising.
 *
 * ## Why every field's error is its own
 *
 * The service answers with a list of `{field, rule}` pairs and marks each one. A form that showed one message
 * at the top would leave the merchant hunting for which of five boxes was wrong.
 */

const RULE_KEYS: Readonly<Record<string, MessagePath>> = Object.freeze({
  required: "invoices.ruleRequired",
  invalid_format: "invoices.ruleInvalidFormat",
  too_small: "invoices.numberingTooSmall",
  too_large: "invoices.ruleTooLarge",
  too_long: "invoices.numberingTooLong",
});

function ruleSentence(rule: string | null, field: string): string {
  if (rule === null) {
    return getMessage("invoices.fieldInvalid");
  }

  if (rule === "too_small" && field === "next_number") {
    return getMessage("invoices.numberingTooSmall");
  }

  const key = RULE_KEYS[rule];

  return key === undefined ? getMessage("invoices.fieldInvalid") : getMessage(key);
}

function refusalDetails(payload: unknown): readonly { readonly field?: unknown; readonly rule?: unknown }[] {
  if (typeof payload !== "object" || payload === null) {
    return [];
  }

  const error = (payload as { readonly error?: unknown }).error;

  if (typeof error !== "object" || error === null) {
    return [];
  }

  const details = (error as { readonly details?: unknown }).details;

  return Array.isArray(details) ? details.filter((detail) => typeof detail === "object") : [];
}

const inputClasses =
  "w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-primary";
const labelClasses = "text-sm font-medium";
const hintClasses = "text-xs text-muted-foreground";
const errorClasses = "text-xs text-destructive";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/**
 * The preview, computed the way the server computes it.
 *
 * Deliberately a local re-statement rather than an import of the service's `printInvoiceNumber`: this is a
 * client component, and importing the service would pull the REST client and the role checks into the browser
 * bundle for the sake of padding a string. The two are two lines each and the gate asserts the server's
 * version; what a merchant sees a keystroke early is not a security boundary.
 */
function previewOf(prefix: string, next: string, padding: number): string {
  const sequence = /^\d{1,18}$/u.test(next.trim()) ? next.trim().replace(/^0+(?=\d)/u, "") : "";

  if (prefix.trim().length === 0 || sequence.length === 0) {
    return "\u2014";
  }

  return `${prefix.trim().toUpperCase()}-${sequence.padStart(Math.max(1, padding), "0")}`;
}

export interface NumberingFormProps {
  readonly settings: InvoiceNumberSettings;
}

export function NumberingForm({ settings }: NumberingFormProps): ReactNode {
  const [prefix, setPrefix] = useState<string>(settings.prefix);
  const [next, setNext] = useState<string>(settings.nextNumber);
  const [padding, setPadding] = useState<string>(String(settings.padding));
  const [yearly, setYearly] = useState<boolean>(settings.yearly);
  const [resetMonth, setResetMonth] = useState<string>(
    settings.resetMonth === null ? "1" : String(settings.resetMonth),
  );
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = useState<boolean>(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState<boolean>(false);
  const [preview, setPreview] = useState<string>(settings.previewNumber);

  const paddingValue = Number.parseInt(padding, 10);
  const lastUsed = BigInt(settings.lastUsedNumber);

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setErrors({});
    setMessage(null);
    setFailed(false);

    try {
      const response = await fetch("/api/invoices/numbering", {
        method: "POST",
        headers: { "content-type": "application/json", ...(await csrfHeaders()) },
        body: JSON.stringify({
          prefix,
          next_number: next,
          padding: Number.isInteger(paddingValue) ? paddingValue : 0,
          yearly,
          reset_month: yearly ? Number.parseInt(resetMonth, 10) : null,
        }),
        credentials: "same-origin",
        cache: "no-store",
      });
      const payload: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        const nextErrors: Record<string, string> = {};

        for (const detail of refusalDetails(payload)) {
          const field = typeof detail.field === "string" ? detail.field : null;

          if (field !== null && nextErrors[field] === undefined) {
            nextErrors[field] = ruleSentence(typeof detail.rule === "string" ? detail.rule : null, field);
          }
        }

        setErrors(nextErrors);
        setFailed(true);
        setMessage(getMessage("invoices.numberingFailed"));

        return;
      }

      const saved = (payload as { readonly settings?: InvoiceNumberSettings }).settings;

      if (saved === undefined) {
        setFailed(true);
        setMessage(getMessage("invoices.numberingFailed"));

        return;
      }

      // The preview is the server's, not this form's: it is the number an invoice will actually carry.
      setPreview(saved.previewNumber);
      setMessage(getMessage("invoices.numberingSaved"));
    } catch {
      setFailed(true);
      setMessage(getMessage("invoices.numberingFailed"));
    } finally {
      setBusy(false);
    }
  }

  function errorLine(field: string): ReactNode {
    const error = errors[field];

    return error === undefined ? null : (
      <p className={errorClasses} role="alert">
        {error}
      </p>
    );
  }

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        void save(event);
      }}
    >
      <section className="flex flex-col gap-2 rounded-lg border border-border p-4">
        <h2 className="text-xs font-medium text-muted-foreground">{getMessage("invoices.numberingPreview")}</h2>
        {/* The preview is the headline: it is the only part of this screen a merchant can check without
            knowing what a basis point or a padding is. */}
        <p className="font-mono text-2xl font-semibold tracking-tight sm:text-3xl">{preview}</p>
        <p className={hintClasses}>
          {lastUsed === 0n
            ? getMessage("invoices.numberingNoneUsed")
            : formatMessage("invoices.numberingLastUsed", { number: settings.lastUsedNumber })}
        </p>
      </section>

      <section className="flex flex-col gap-4 rounded-lg border border-border p-4">
        <div className="flex flex-col gap-1">
          <label className={labelClasses} htmlFor="numbering-prefix">
            {getMessage("invoices.numberingPrefix")}
          </label>
          <input
            aria-invalid={errors["prefix"] !== undefined}
            className={inputClasses}
            id="numbering-prefix"
            maxLength={12}
            onChange={(event) => {
              setPrefix(event.target.value);
              setErrors({});
              setPreview(previewOf(event.target.value, next, Number.isInteger(paddingValue) ? paddingValue : 5));
            }}
            type="text"
            value={prefix}
          />
          {errors["prefix"] === undefined ? (
            <p className={hintClasses}>{getMessage("invoices.numberingPrefixHint")}</p>
          ) : (
            errorLine("prefix")
          )}
        </div>

        {/* Two columns from `sm` up; one on a phone, where two boxes of digits would clip. */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <label className={labelClasses} htmlFor="numbering-next">
              {getMessage("invoices.numberingNext")}
            </label>
            <input
              aria-invalid={errors["next_number"] !== undefined}
              className={inputClasses}
              id="numbering-next"
              inputMode="numeric"
              onChange={(event) => {
                setNext(event.target.value);
                setErrors({});
                setPreview(previewOf(prefix, event.target.value, Number.isInteger(paddingValue) ? paddingValue : 5));
              }}
              type="text"
              value={next}
            />
            {errors["next_number"] === undefined ? (
              <p className={hintClasses}>{getMessage("invoices.numberingNextHint")}</p>
            ) : (
              errorLine("next_number")
            )}
          </div>

          <div className="flex flex-col gap-1">
            <label className={labelClasses} htmlFor="numbering-padding">
              {getMessage("invoices.numberingPadding")}
            </label>
            <input
              aria-invalid={errors["padding"] !== undefined}
              className={inputClasses}
              id="numbering-padding"
              inputMode="numeric"
              max={11}
              min={1}
              onChange={(event) => {
                setPadding(event.target.value);
                setErrors({});

                const parsed = Number.parseInt(event.target.value, 10);

                setPreview(previewOf(prefix, next, Number.isInteger(parsed) ? parsed : 5));
              }}
              type="number"
              value={padding}
            />
            {errors["padding"] === undefined ? (
              <p className={hintClasses}>{getMessage("invoices.numberingPaddingHint")}</p>
            ) : (
              errorLine("padding")
            )}
          </div>
        </div>

        <div className="flex flex-col gap-2 border-t border-border pt-4">
          <label className="flex items-center gap-2 text-sm font-medium" htmlFor="numbering-yearly">
            <input
              checked={yearly}
              id="numbering-yearly"
              onChange={(event) => {
                setYearly(event.target.checked);
                setErrors({});
              }}
              type="checkbox"
            />
            {getMessage("invoices.numberingYearly")}
          </label>
          <p className={hintClasses}>{getMessage("invoices.numberingYearlyHint")}</p>

          {yearly ? (
            <div className="flex flex-col gap-1">
              <label className={labelClasses} htmlFor="numbering-reset-month">
                {getMessage("invoices.numberingResetMonth")}
              </label>
              <select
                aria-invalid={errors["reset_month"] !== undefined}
                className={inputClasses}
                id="numbering-reset-month"
                onChange={(event) => {
                  setResetMonth(event.target.value);
                  setErrors({});
                }}
                value={resetMonth}
              >
                {MONTHS.map((month, index) => (
                  <option key={month} value={String(index + 1)}>
                    {month}
                  </option>
                ))}
              </select>
              {errorLine("reset_month")}
            </div>
          ) : null}
        </div>

        <button
          className="w-fit rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
          disabled={busy}
          type="submit"
        >
          {getMessage(busy ? "invoices.numberingSaving" : "invoices.numberingSave")}
        </button>
      </section>

      {message === null ? null : (
        <p className={failed ? errorClasses : hintClasses} role={failed ? "alert" : "status"}>
          {message}
        </p>
      )}

      <nav className="border-t border-border pt-4 text-sm">
        <Link
          className="w-fit rounded-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-primary"
          href="/invoices"
        >
          {getMessage("invoices.numberingBack")}
        </Link>
      </nav>
    </form>
  );
}
