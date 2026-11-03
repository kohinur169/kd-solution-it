// path: app/(dashboard)/onboarding/address/address-form.tsx
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { rateLimitSentence } from "@/lib/auth/refusal-message";
import { formatMessage, getMessage } from "@/lib/i18n/messages";
import type { MessagePath } from "@/lib/i18n/messages";
import { csrfHeaders } from "@/lib/security/csrf-client";
import type {
  BusinessAddressSnapshot,
  BusinessAddressValues,
  CountryOption,
} from "@/services/kyc/business-address";
import {
  BUSINESS_ADDRESS_FIELDS,
  type BusinessAddressField,
} from "@/services/kyc/business-address-fields";

/**
 * The address and contact form of section 5.
 *
 * ## What it sends, and what it never sends
 *
 * The body is the nine field names and the values typed into them. The company is not in the body:
 * `services/kyc/business-address.ts` takes it from the session, so an edited request cannot write
 * another merchant's row. Every field is sent on every save, because the service reads a missing key
 * as "leave this alone" - sending all nine is how a cleared box becomes a cleared column.
 *
 * ## Why nothing is marked `required` in the markup
 *
 * The address step needs seven of the nine fields; the merchant may not have them all yet. The
 * browser's own `required` would stop the draft from being saved at all, so the badge says "Required"
 * and `aria-required` says the same to a screen reader, while the save that stores the draft stays
 * available.
 *
 * ## Why the country is a filtered select, not a text box
 *
 * The list is the platform's 250 ISO countries from `0076`, and a free text box would accept a code
 * no country uses - which is exactly what the foreign key of `0105` exists to refuse. The select is
 * the native control: keyboard navigation, one option per enabled country, and the filter box only
 * narrows the options rendered.
 *
 * ## Why the refusals are read field by field
 *
 * The service names every field that failed and the rule it broke - including `unknown_country` and
 * `disabled_country` for the country - so the form marks all of them at once and moves the caret to
 * the first.
 */

const SAVE_PATH = "/api/onboarding/business-address";

interface FieldCopy {
  readonly label: MessagePath;
  readonly hint: MessagePath;
  readonly kind: "line" | "country";
  readonly autoComplete: string;
}

const FIELD_COPY: Readonly<Record<BusinessAddressField, FieldCopy>> = Object.freeze({
  address_line1: {
    label: "onboardingAddress.addressLine1",
    hint: "onboardingAddress.addressLine1Hint",
    kind: "line",
    autoComplete: "street-address",
  },
  address_line2: {
    label: "onboardingAddress.addressLine2",
    hint: "onboardingAddress.addressLine2Hint",
    kind: "line",
    autoComplete: "off",
  },
  city: {
    label: "onboardingAddress.city",
    hint: "onboardingAddress.cityHint",
    kind: "line",
    autoComplete: "address-level2",
  },
  state_province: {
    label: "onboardingAddress.stateProvince",
    hint: "onboardingAddress.stateProvinceHint",
    kind: "line",
    autoComplete: "address-level1",
  },
  postal_code: {
    label: "onboardingAddress.postalCode",
    hint: "onboardingAddress.postalCodeHint",
    kind: "line",
    autoComplete: "postal-code",
  },
  country_code: {
    label: "onboardingAddress.countryCode",
    hint: "onboardingAddress.countryCodeHint",
    kind: "country",
    autoComplete: "country",
  },
  contact_name: {
    label: "onboardingAddress.contactName",
    hint: "onboardingAddress.contactNameHint",
    kind: "line",
    autoComplete: "name",
  },
  contact_email: {
    label: "onboardingAddress.contactEmail",
    hint: "onboardingAddress.contactEmailHint",
    kind: "line",
    autoComplete: "email",
  },
  contact_phone: {
    label: "onboardingAddress.contactPhone",
    hint: "onboardingAddress.contactPhoneHint",
    kind: "line",
    autoComplete: "tel",
  },
});

const RULE_KEYS: Readonly<Record<string, MessagePath>> = Object.freeze({
  too_short: "onboardingAddress.ruleTooShort",
  too_long: "onboardingAddress.ruleTooLong",
  invalid_format: "onboardingAddress.ruleInvalidFormat",
  unknown_key: "onboardingAddress.ruleUnknownKey",
  required: "onboardingAddress.ruleRequired",
  unknown_country: "onboardingAddress.ruleUnknownCountry",
  disabled_country: "onboardingAddress.ruleDisabledCountry",
});

function ruleSentence(rule: string | null): string {
  if (rule === null) {
    return getMessage("onboardingAddress.fieldInvalid");
  }

  const key = RULE_KEYS[rule];

  return key === undefined ? getMessage("onboardingAddress.fieldInvalid") : getMessage(key);
}

function valuesFrom(snapshot: BusinessAddressSnapshot): Record<BusinessAddressField, string> {
  const record = {} as Record<BusinessAddressField, string>;

  for (const field of BUSINESS_ADDRESS_FIELDS) {
    record[field] = snapshot.values[field] ?? "";
  }

  return record;
}

function storedAtSentence(epochMs: number | null): string {
  if (epochMs === null) {
    return getMessage("onboardingAddress.unsavedLine");
  }

  return formatMessage("onboardingAddress.savedLine", {
    at: new Date(epochMs).toISOString().replace("T", " ").slice(0, 19),
  });
}

function fieldLabels(fields: readonly BusinessAddressField[]): string {
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

function countryLabel(option: CountryOption): string {
  return `${option.code} - ${option.name}`;
}

interface AddressFormProps {
  readonly initial: BusinessAddressSnapshot;
}

export function AddressForm({ initial }: AddressFormProps): ReactNode {
  const router = useRouter();
  const [values, setValues] = useState<Record<BusinessAddressField, string>>(() =>
    valuesFrom(initial),
  );
  const [errors, setErrors] = useState<Partial<Record<BusinessAddressField, string>>>({});
  const [countryFilter, setCountryFilter] = useState<string>("");
  const [complete, setComplete] = useState<boolean>(initial.complete);
  const [missing, setMissing] = useState<readonly BusinessAddressField[]>(initial.missing);
  const [savedAt, setSavedAt] = useState<number | null>(initial.savedAtEpochMs);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);

  const required = new Set(initial.required);

  const countries = useMemo(() => {
    const needle = countryFilter.trim().toLowerCase();

    if (needle.length === 0) {
      return initial.countries;
    }

    return initial.countries.filter((country) =>
      `${country.code} ${country.name}`.toLowerCase().includes(needle),
    );
  }, [countryFilter, initial.countries]);

  function update(field: BusinessAddressField, value: string): void {
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
          readonly values?: BusinessAddressValues;
          readonly complete?: boolean;
          readonly missing?: readonly BusinessAddressField[];
          readonly savedAtEpochMs?: number | null;
        };

        if (saved.values !== undefined) {
          setValues(valuesFrom({ ...initial, values: saved.values }));
        }

        const isComplete = saved.complete === true;
        setComplete(isComplete);
        setMissing(saved.missing ?? []);
        setSavedAt(saved.savedAtEpochMs ?? null);
        setErrors({});
        setMessage(
          getMessage(
            isComplete ? "onboardingAddress.saveDoneComplete" : "onboardingAddress.saveDone",
          ),
        );
        router.refresh();

        return;
      }

      if (response.status === 401) {
        setFailed(true);
        setMessage(getMessage("onboardingAddress.signedOut"));

        return;
      }

      if (response.status === 403) {
        setFailed(true);
        setMessage(getMessage("onboardingAddress.forbidden"));

        return;
      }

      if (response.status === 429) {
        setFailed(true);
        setMessage(rateLimitSentence(payload));

        return;
      }

      const details = refusalDetails(payload);
      const next: Partial<Record<BusinessAddressField, string>> = {};
      let first: BusinessAddressField | null = null;

      for (const detail of details) {
        const field = detail.field;
        const rule = detail.rule;

        if (typeof field === "string" && (BUSINESS_ADDRESS_FIELDS as readonly string[]).includes(field)) {
          const known = field as BusinessAddressField;
          next[known] = ruleSentence(typeof rule === "string" ? rule : null);
          first ??= known;
        }
      }

      setErrors(next);
      setFailed(true);
      setMessage(getMessage("onboardingAddress.saveFailed"));

      if (first !== null) {
        document.getElementById(`address-${first}`)?.focus();
      }
    } catch {
      setFailed(true);
      setMessage(getMessage("onboardingAddress.saveFailed"));
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
          {getMessage("onboardingAddress.completeLine")}
        </p>
      ) : (
        <p className={pendingClasses} role="status">
          {missing.length === 0
            ? getMessage("onboardingAddress.unsavedLine")
            : formatMessage("onboardingAddress.missingLine", {
                count: missing.length,
                fields: fieldLabels(missing),
              })}
        </p>
      )}

      <p className={metaClasses}>{storedAtSentence(savedAt)}</p>

      <fieldset className={fieldsetClasses}>
        <legend className={legendClasses}>{getMessage("onboardingAddress.formHeading")}</legend>
        <p className={descriptionClasses}>{getMessage("onboardingAddress.formDescription")}</p>

        {BUSINESS_ADDRESS_FIELDS.map((field) => {
          const copy = FIELD_COPY[field];
          const error = errors[field];
          const isRequired = required.has(field);
          const describedBy = error === undefined ? `address-${field}-hint` : `address-${field}-error`;

          if (copy.kind === "country") {
            return (
              <div className={fieldClasses} key={field}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <label className={labelClasses} htmlFor={`address-${field}`}>
                    {getMessage(copy.label)}
                  </label>
                  <span className={badgeClasses}>
                    {getMessage(
                      isRequired
                        ? "onboardingAddress.requiredMark"
                        : "onboardingAddress.optionalMark",
                    )}
                  </span>
                </div>
                <p className={hintClasses} id={`address-${field}-hint`}>
                  {getMessage(copy.hint)}
                </p>
                <label className={labelClasses} htmlFor="address-country-filter">
                  {getMessage("onboardingAddress.countryFilterLabel")}
                </label>
                <p className={hintClasses} id="address-country-filter-hint">
                  {getMessage("onboardingAddress.countryFilterHint")}
                </p>
                <input
                  aria-describedby="address-country-filter-hint"
                  autoComplete="off"
                  className={inputClasses}
                  id="address-country-filter"
                  onChange={(event) => setCountryFilter(event.target.value)}
                  spellCheck={false}
                  type="text"
                  value={countryFilter}
                />
                <select
                  aria-describedby={describedBy}
                  aria-invalid={error === undefined ? undefined : true}
                  aria-required={isRequired}
                  autoComplete={copy.autoComplete}
                  className={error === undefined ? inputClasses : invalidClasses}
                  id={`address-${field}`}
                  name={field}
                  onChange={(event) => update(field, event.target.value)}
                  value={values[field]}
                >
                  <option value="">{getMessage("onboardingAddress.countryPlaceholder")}</option>
                  {countries.map((country) => (
                    <option key={country.code} value={country.code}>
                      {countryLabel(country)}
                    </option>
                  ))}
                </select>
                {error === undefined ? null : (
                  <p className={errorClasses} id={`address-${field}-error`}>
                    {error}
                  </p>
                )}
              </div>
            );
          }

          return (
            <div className={fieldClasses} key={field}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <label className={labelClasses} htmlFor={`address-${field}`}>
                  {getMessage(copy.label)}
                </label>
                <span className={badgeClasses}>
                  {getMessage(
                    isRequired
                      ? "onboardingAddress.requiredMark"
                      : "onboardingAddress.optionalMark",
                  )}
                </span>
              </div>
              <p className={hintClasses} id={`address-${field}-hint`}>
                {getMessage(copy.hint)}
              </p>
              <input
                aria-describedby={describedBy}
                aria-invalid={error === undefined ? undefined : true}
                aria-required={isRequired}
                autoComplete={copy.autoComplete}
                className={error === undefined ? inputClasses : invalidClasses}
                id={`address-${field}`}
                inputMode={field === "contact_email" ? "email" : field === "contact_phone" ? "tel" : "text"}
                name={field}
                onChange={(event) => update(field, event.target.value)}
                spellCheck={false}
                type="text"
                value={values[field]}
              />
              {error === undefined ? null : (
                <p className={errorClasses} id={`address-${field}-error`}>
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
            ? getMessage("onboardingAddress.saveBusy")
            : getMessage("onboardingAddress.saveSubmit")}
        </button>
        <Link className={linkClasses} href="/onboarding">
          {getMessage("onboardingAddress.backLink")}
        </Link>
      </div>
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

const metaClasses = "text-sm text-muted-foreground";

const alertClasses =
  "rounded-md border border-danger bg-surface px-3 py-2 text-sm text-danger";

const savedClasses =
  "rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground";

const pendingClasses = "text-sm text-muted-foreground";
