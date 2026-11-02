// path: app/(dashboard)/onboarding/business/business-form.tsx
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { rateLimitSentence } from "@/lib/auth/refusal-message";
import { formatMessage, getMessage } from "@/lib/i18n/messages";
import type { MessagePath } from "@/lib/i18n/messages";
import { csrfHeaders } from "@/lib/security/csrf-client";
import type {
  BusinessProfileSnapshot,
  BusinessProfileValues,
  ProcessorCoverage,
} from "@/services/kyc/business-profile";
import {
  BUSINESS_PROFILE_FIELDS,
  type BusinessProfileField,
} from "@/services/kyc/processor-fields";

/**
 * The business information form of section 5.
 *
 * ## What it sends, and what it never sends
 *
 * The body is the seven field names and the values typed into them. The company is not in the body:
 * `services/kyc/business-profile.ts` takes it from the session, so an edited request cannot write
 * another merchant's row. Every field is sent on every save, because the service reads a missing key
 * as "leave this alone" - sending all seven is how a cleared box becomes a cleared column.
 *
 * ## Why nothing is marked `required` in the markup
 *
 * A processor needs a field; the merchant may not have it yet. The browser's own `required` would
 * stop the draft from being saved at all, which is the opposite of what section 5 asks for: fill what
 * you know now, come back for the rest. So the badge says "Required" and `aria-required` says the same
 * to a screen reader, while the save that stores the draft stays available.
 *
 * ## Why the refusals are read field by field
 *
 * The service names every field that failed and the rule it broke, so the form marks all of them at
 * once and moves the caret to the first - a merchant fixing seven values one submission at a time
 * would be told seven times that the same save failed. A rule this build does not know still produces
 * a sentence rather than an empty line under the box.
 */

const SAVE_PATH = "/api/onboarding/business-profile";

interface FieldCopy {
  readonly label: MessagePath;
  readonly hint: MessagePath;
  readonly kind: "line" | "url" | "select" | "multiline";
  readonly autoComplete: string;
}

const FIELD_COPY: Readonly<Record<BusinessProfileField, FieldCopy>> = Object.freeze({
  legal_name: {
    label: "onboardingBusiness.legalName",
    hint: "onboardingBusiness.legalNameHint",
    kind: "line",
    autoComplete: "organization",
  },
  trading_name: {
    label: "onboardingBusiness.tradingName",
    hint: "onboardingBusiness.tradingNameHint",
    kind: "line",
    autoComplete: "off",
  },
  business_type: {
    label: "onboardingBusiness.businessType",
    hint: "onboardingBusiness.businessTypeHint",
    kind: "select",
    autoComplete: "off",
  },
  registration_number: {
    label: "onboardingBusiness.registrationNumber",
    hint: "onboardingBusiness.registrationNumberHint",
    kind: "line",
    autoComplete: "off",
  },
  tax_id: {
    label: "onboardingBusiness.taxId",
    hint: "onboardingBusiness.taxIdHint",
    kind: "line",
    autoComplete: "off",
  },
  website: {
    label: "onboardingBusiness.website",
    hint: "onboardingBusiness.websiteHint",
    kind: "url",
    autoComplete: "url",
  },
  business_description: {
    label: "onboardingBusiness.businessDescription",
    hint: "onboardingBusiness.businessDescriptionHint",
    kind: "multiline",
    autoComplete: "off",
  },
});

/** The business types the service accepts, with their catalog keys. */
const BUSINESS_TYPE_KEYS: Readonly<Record<string, MessagePath>> = Object.freeze({
  individual: "onboardingBusiness.businessTypeIndividual",
  company: "onboardingBusiness.businessTypeCompany",
});

const RULE_KEYS: Readonly<Record<string, MessagePath>> = Object.freeze({
  too_short: "onboardingBusiness.ruleTooShort",
  too_long: "onboardingBusiness.ruleTooLong",
  invalid_format: "onboardingBusiness.ruleInvalidFormat",
  unknown_value: "onboardingBusiness.ruleUnknownValue",
  unsupported_scheme: "onboardingBusiness.ruleUnsupportedScheme",
  invalid_host: "onboardingBusiness.ruleInvalidHost",
  private_host: "onboardingBusiness.ruleInvalidHost",
});

function ruleSentence(rule: string | null): string {
  if (rule === null) {
    return getMessage("onboardingBusiness.fieldInvalid");
  }

  const key = RULE_KEYS[rule];

  return key === undefined ? getMessage("onboardingBusiness.fieldInvalid") : getMessage(key);
}

function valuesFrom(snapshot: BusinessProfileSnapshot): Record<BusinessProfileField, string> {
  const record = {} as Record<BusinessProfileField, string>;

  for (const field of BUSINESS_PROFILE_FIELDS) {
    record[field] = snapshot.values[field] ?? "";
  }

  return record;
}

function storedAtSentence(epochMs: number | null): string {
  if (epochMs === null) {
    return getMessage("onboardingBusiness.unsavedLine");
  }

  return formatMessage("onboardingBusiness.savedLine", {
    at: new Date(epochMs).toISOString().replace("T", " ").slice(0, 19),
  });
}

function fieldLabels(fields: readonly BusinessProfileField[]): string {
  return fields.map((field) => getMessage(FIELD_COPY[field].label)).join(", ");
}

interface RefusalDetail {
  readonly field?: unknown;
  readonly rule?: unknown;
}

/** Every `{field, rule}` pair the service refused, in the order it listed them. */
function refusalDetails(payload: unknown): readonly RefusalDetail[] {
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

interface BusinessFormProps {
  readonly initial: BusinessProfileSnapshot;
}

export function BusinessForm({ initial }: BusinessFormProps): ReactNode {
  const router = useRouter();
  const [values, setValues] = useState<Record<BusinessProfileField, string>>(() =>
    valuesFrom(initial),
  );
  const [errors, setErrors] = useState<Partial<Record<BusinessProfileField, string>>>({});
  const [coverage, setCoverage] = useState<readonly ProcessorCoverage[]>(initial.coverage);
  const [complete, setComplete] = useState<boolean>(initial.complete);
  const [missing, setMissing] = useState<readonly BusinessProfileField[]>(initial.missing);
  const [savedAt, setSavedAt] = useState<number | null>(initial.savedAtEpochMs);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);

  const required = new Set(initial.required);

  function update(field: BusinessProfileField, value: string): void {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => {
      if (current[field] === undefined) {
        return current;
      }

      const next = { ...current };
      delete next[field];

      return next;
    });
  }

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    setFailed(false);

    try {
      const response = await fetch(SAVE_PATH, {
        method: "POST",
        headers: { "content-type": "application/json", ...(await csrfHeaders()) },
        body: JSON.stringify(values),
        credentials: "same-origin",
        cache: "no-store",
      });

      const payload: unknown = await response.json().catch(() => null);

      if (response.ok && typeof payload === "object" && payload !== null) {
        const saved = payload as {
          readonly values?: BusinessProfileValues;
          readonly coverage?: readonly ProcessorCoverage[];
          readonly complete?: boolean;
          readonly missing?: readonly BusinessProfileField[];
          readonly savedAtEpochMs?: number | null;
        };

        if (saved.values !== undefined) {
          setValues(valuesFrom({ ...initial, values: saved.values }));
        }

        if (saved.coverage !== undefined) {
          setCoverage(saved.coverage);
        }

        const isComplete = saved.complete === true;
        setComplete(isComplete);
        setMissing(saved.missing ?? []);
        setSavedAt(saved.savedAtEpochMs ?? null);
        setErrors({});
        setMessage(
          getMessage(
            isComplete ? "onboardingBusiness.saveDoneComplete" : "onboardingBusiness.saveDone",
          ),
        );
        router.refresh();

        return;
      }

      if (response.status === 401) {
        setFailed(true);
        setMessage(getMessage("onboardingBusiness.signedOut"));

        return;
      }

      if (response.status === 403) {
        setFailed(true);
        setMessage(getMessage("onboardingBusiness.forbidden"));

        return;
      }

      if (response.status === 429) {
        setFailed(true);
        setMessage(rateLimitSentence(payload));

        return;
      }

      const details = refusalDetails(payload);
      const next: Partial<Record<BusinessProfileField, string>> = {};
      let first: BusinessProfileField | null = null;

      for (const detail of details) {
        const field = detail.field;
        const rule = detail.rule;

        if (typeof field === "string" && (BUSINESS_PROFILE_FIELDS as readonly string[]).includes(field)) {
          const known = field as BusinessProfileField;
          next[known] = ruleSentence(typeof rule === "string" ? rule : null);
          first ??= known;
        }
      }

      setErrors(next);
      setFailed(true);
      setMessage(getMessage("onboardingBusiness.saveFailed"));

      if (first !== null) {
        document.getElementById(`business-${first}`)?.focus();
      }
    } catch {
      setFailed(true);
      setMessage(getMessage("onboardingBusiness.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="flex flex-col gap-6" noValidate onSubmit={(event) => void save(event)}>
      {message === null ? null : (
        <p
          className={failed ? alertClasses : savedClasses}
          role={failed ? "alert" : "status"}
          aria-live="polite"
        >
          {message}
        </p>
      )}

      {complete ? (
        <p className={savedClasses} role="status">
          {getMessage("onboardingBusiness.completeLine")}
        </p>
      ) : (
        <p className={pendingClasses} role="status">
          {missing.length === 0
            ? getMessage("onboardingBusiness.unsavedLine")
            : formatMessage("onboardingBusiness.missingLine", {
                count: missing.length,
                fields: fieldLabels(missing),
              })}
        </p>
      )}

      <p className={metaClasses}>{storedAtSentence(savedAt)}</p>

      <fieldset className={fieldsetClasses}>
        <legend className={legendClasses}>{getMessage("onboardingBusiness.formHeading")}</legend>
        <p className={descriptionClasses}>{getMessage("onboardingBusiness.formDescription")}</p>

        {BUSINESS_PROFILE_FIELDS.map((field) => {
          const copy = FIELD_COPY[field];
          const error = errors[field];
          const isRequired = required.has(field);
          const describedBy = error === undefined ? `business-${field}-hint` : `business-${field}-error`;

          return (
            <div className={fieldClasses} key={field}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <label className={labelClasses} htmlFor={`business-${field}`}>
                  {getMessage(copy.label)}
                </label>
                <span className={badgeClasses}>
                  {getMessage(
                    isRequired
                      ? "onboardingBusiness.requiredMark"
                      : "onboardingBusiness.optionalMark",
                  )}
                </span>
              </div>
              <p className={hintClasses} id={`business-${field}-hint`}>
                {getMessage(copy.hint)}
              </p>
              {copy.kind === "multiline" ? (
                <textarea
                  aria-describedby={describedBy}
                  aria-invalid={error === undefined ? undefined : true}
                  aria-required={isRequired}
                  autoComplete={copy.autoComplete}
                  className={error === undefined ? inputClasses : invalidClasses}
                  id={`business-${field}`}
                  name={field}
                  onChange={(event) => update(field, event.target.value)}
                  rows={4}
                  value={values[field]}
                />
              ) : copy.kind === "select" ? (
                <select
                  aria-describedby={describedBy}
                  aria-invalid={error === undefined ? undefined : true}
                  aria-required={isRequired}
                  className={error === undefined ? inputClasses : invalidClasses}
                  id={`business-${field}`}
                  name={field}
                  onChange={(event) => update(field, event.target.value)}
                  value={values[field]}
                >
                  <option value="">{getMessage("onboardingBusiness.businessTypeHint")}</option>
                  {Object.entries(BUSINESS_TYPE_KEYS).map(([value, key]) => (
                    <option key={value} value={value}>
                      {getMessage(key)}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  aria-describedby={describedBy}
                  aria-invalid={error === undefined ? undefined : true}
                  aria-required={isRequired}
                  autoComplete={copy.autoComplete}
                  className={error === undefined ? inputClasses : invalidClasses}
                  id={`business-${field}`}
                  inputMode={copy.kind === "url" ? "url" : "text"}
                  name={field}
                  onChange={(event) => update(field, event.target.value)}
                  spellCheck={false}
                  type="text"
                  value={values[field]}
                />
              )}
              {error === undefined ? null : (
                <p className={errorClasses} id={`business-${field}-error`}>
                  {error}
                </p>
              )}
            </div>
          );
        })}
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <button className={buttonClasses} disabled={busy} type="submit">
          {busy
            ? getMessage("onboardingBusiness.saveBusy")
            : getMessage("onboardingBusiness.saveSubmit")}
        </button>
        <Link className={linkClasses} href="/onboarding">
          {getMessage("onboardingBusiness.backLink")}
        </Link>
      </div>

      <section className={coverageClasses} aria-labelledby="business-coverage-heading">
        <h2 className={headingClasses} id="business-coverage-heading">
          {getMessage("onboardingBusiness.coverageHeading")}
        </h2>
        <p className={descriptionClasses}>
          {getMessage("onboardingBusiness.coverageDescription")}
        </p>
        <ul className="flex flex-col gap-3">
          {coverage.map((row) => (
            <li className={coverageRowClasses} key={row.provider}>
              <p className="font-medium">{row.displayName}</p>
              <p className="text-sm text-muted-foreground">{fieldLabels(row.required)}</p>
              <p className={row.missing.length === 0 ? coveredClasses : pendingClasses}>
                {row.missing.length === 0
                  ? getMessage("onboardingBusiness.coverageComplete")
                  : formatMessage("onboardingBusiness.coverageMissing", {
                      fields: fieldLabels(row.missing),
                    })}
              </p>
              {row.optional.length === 0 ? null : (
                <p className="text-sm text-muted-foreground">
                  {formatMessage("onboardingBusiness.coverageOptional", {
                    fields: fieldLabels(row.optional),
                  })}
                </p>
              )}
            </li>
          ))}
        </ul>
      </section>
    </form>
  );
}

const fieldsetClasses = "flex flex-col gap-4 rounded-lg border border-border bg-surface p-4";

const legendClasses = "px-1 text-lg font-semibold tracking-tight";

const fieldClasses = "flex flex-col gap-1";

const labelClasses = "text-sm font-medium text-foreground";

const hintClasses = "text-sm text-muted-foreground";

const inputClasses =
  "rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground shadow-sm";

const invalidClasses =
  "rounded-md border border-danger bg-background px-3 py-2 text-sm text-foreground shadow-sm";

const errorClasses = "text-sm text-danger";

const badgeClasses =
  "rounded-full border border-border px-2 py-0.5 text-xs font-medium text-muted-foreground";

const buttonClasses =
  "inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60";

const linkClasses =
  "inline-flex items-center rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2";

const descriptionClasses = "text-sm text-muted-foreground";

const headingClasses = "text-lg font-semibold tracking-tight";

const metaClasses = "text-sm text-muted-foreground";

const alertClasses =
  "rounded-md border border-danger bg-surface px-3 py-2 text-sm text-danger";

const savedClasses =
  "rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground";

const pendingClasses = "text-sm text-muted-foreground";

const coveredClasses = "text-sm text-foreground";

const coverageClasses = "flex flex-col gap-3 rounded-lg border border-border bg-surface p-4";

const coverageRowClasses = "flex flex-col gap-1 border-t border-border pt-3 first:border-t-0 first:pt-0";
