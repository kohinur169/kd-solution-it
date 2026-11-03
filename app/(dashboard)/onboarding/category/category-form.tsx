// path: app/(dashboard)/onboarding/category/category-form.tsx
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { rateLimitSentence } from "@/lib/auth/refusal-message";
import { formatMessage, getMessage } from "@/lib/i18n/messages";
import type { MessagePath } from "@/lib/i18n/messages";
import { csrfHeaders } from "@/lib/security/csrf-client";
import type {
  MerchantCategorySnapshot,
  MerchantCategoryOption,
} from "@/services/kyc/merchant-category";

/**
 * The merchant category code form of section 5.
 *
 * ## What it sends, and what it never sends
 *
 * The body is `{ mcc_code }`: the code chosen in the dropdown, or an empty string to clear it. The
 * company is not in the body: `services/kyc/merchant-category.ts` takes it from the session, so an
 * edited request cannot set another merchant's category.
 *
 * ## Why the list is filtered, not replaced by a free text box
 *
 * Section 5 says "dropdown or input", and the vocabulary of `0077` is 981 published codes, so a
 * free text box would accept codes no card network knows - which is exactly what the foreign key
 * of `0104` exists to refuse. The select is the native control: keyboard navigation, one option
 * per code, and the filter box only narrows the options rendered, it never widens them.
 *
 * ## Why nothing is marked `required` in the markup
 *
 * Clearing the field is a legitimate save - a merchant changes category by choosing another code or
 * clearing the box - so the browser's own `required` would refuse the clear. The badge says
 * "Required" and `aria-required` says the same to a screen reader, while every save stays available.
 *
 * ## Why the refusal is read field by field
 *
 * The service names the field and the rule - `unknown_code`, `retired_code`, `invalid_format` - and
 * the form maps each rule to its sentence and moves the caret to the one box there is.
 */

const SAVE_PATH = "/api/onboarding/merchant-category";

const RULE_KEYS: Readonly<Record<string, MessagePath>> = Object.freeze({
  invalid_format: "onboardingCategory.ruleInvalidFormat",
  unknown_key: "onboardingCategory.ruleUnknownKey",
  required: "onboardingCategory.ruleRequired",
  unknown_code: "onboardingCategory.ruleUnknownCode",
  retired_code: "onboardingCategory.ruleRetiredCode",
});

function ruleSentence(rule: string | null): string {
  if (rule === null) {
    return getMessage("onboardingCategory.fieldInvalid");
  }

  const key = RULE_KEYS[rule];

  return key === undefined ? getMessage("onboardingCategory.fieldInvalid") : getMessage(key);
}

function storedAtSentence(epochMs: number | null): string {
  if (epochMs === null) {
    return getMessage("onboardingCategory.unsavedLine");
  }

  return formatMessage("onboardingCategory.savedLine", {
    at: new Date(epochMs).toISOString().replace("T", " ").slice(0, 19),
  });
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

function optionLabel(option: MerchantCategoryOption): string {
  return `${option.code} - ${option.title}`;
}

interface CategoryFormProps {
  readonly initial: MerchantCategorySnapshot;
}

export function CategoryForm({ initial }: CategoryFormProps): ReactNode {
  const router = useRouter();
  const [selected, setSelected] = useState<string>(initial.mccCode ?? "");
  const [filter, setFilter] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(initial.mccTitle);
  const [complete, setComplete] = useState<boolean>(initial.complete);
  const [savedAt, setSavedAt] = useState<number | null>(initial.savedAtEpochMs);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);

  const options = useMemo(() => {
    const needle = filter.trim().toLowerCase();

    if (needle.length === 0) {
      return initial.options;
    }

    return initial.options.filter((option) =>
      `${option.code} ${option.title}`.toLowerCase().includes(needle),
    );
  }, [filter, initial.options]);

  function update(value: string): void {
    setSelected(value);
    setError(null);
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
        body: JSON.stringify({ mcc_code: selected }),
        credentials: "same-origin",
        cache: "no-store",
      });

      const payload: unknown = await response.json().catch(() => null);

      if (response.ok && typeof payload === "object" && payload !== null) {
        const saved = payload as {
          readonly mccCode?: string | null;
          readonly mccTitle?: string | null;
          readonly complete?: boolean;
          readonly savedAtEpochMs?: number | null;
        };

        const code = saved.mccCode === undefined ? selected : (saved.mccCode ?? "");
        const isComplete = saved.complete === true;

        setSelected(code);
        setTitle(saved.mccTitle ?? null);
        setComplete(isComplete);
        setSavedAt(saved.savedAtEpochMs ?? null);
        setError(null);
        setMessage(
          getMessage(
            isComplete
              ? "onboardingCategory.saveDoneComplete"
              : "onboardingCategory.saveDone",
          ),
        );
        router.refresh();

        return;
      }

      if (response.status === 401) {
        setFailed(true);
        setMessage(getMessage("onboardingCategory.signedOut"));

        return;
      }

      if (response.status === 403) {
        setFailed(true);
        setMessage(getMessage("onboardingCategory.forbidden"));

        return;
      }

      if (response.status === 429) {
        setFailed(true);
        setMessage(rateLimitSentence(payload));

        return;
      }

      const details = refusalDetails(payload);
      const first = details.find(
        (detail) => typeof detail.field === "string" && detail.field === "mcc_code",
      );

      setError(ruleSentence(typeof first?.rule === "string" ? first.rule : null));
      setFailed(true);
      setMessage(getMessage("onboardingCategory.saveFailed"));
      document.getElementById("category-mcc_code")?.focus();
    } catch {
      setFailed(true);
      setMessage(getMessage("onboardingCategory.saveFailed"));
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
          {getMessage("onboardingCategory.completeLine")}
        </p>
      ) : (
        <p className={pendingClasses} role="status">
          {getMessage("onboardingCategory.unsavedLine")}
        </p>
      )}

      {selected.length === 0 || title === null ? null : (
        <p className={metaClasses} role="status">
          {formatMessage("onboardingCategory.selectedLine", { code: selected, title })}
        </p>
      )}

      <p className={metaClasses}>{storedAtSentence(savedAt)}</p>

      <fieldset className={fieldsetClasses}>
        <legend className={legendClasses}>{getMessage("onboardingCategory.formHeading")}</legend>
        <p className={descriptionClasses}>{getMessage("onboardingCategory.formDescription")}</p>

        <div className={fieldClasses}>
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <label className={labelClasses} htmlFor="category-filter">
              {getMessage("onboardingCategory.filterLabel")}
            </label>
          </div>
          <p className={hintClasses} id="category-filter-hint">
            {getMessage("onboardingCategory.filterHint")}
          </p>
          <input
            aria-describedby="category-filter-hint"
            autoComplete="off"
            className={inputClasses}
            id="category-filter"
            onChange={(event) => setFilter(event.target.value)}
            spellCheck={false}
            type="text"
            value={filter}
          />
        </div>

        <div className={fieldClasses}>
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <label className={labelClasses} htmlFor="category-mcc_code">
              {getMessage("onboardingCategory.codeLabel")}
            </label>
            <span className={badgeClasses}>{getMessage("onboardingCategory.requiredMark")}</span>
          </div>
          <p className={hintClasses} id="category-mcc_code-hint">
            {getMessage("onboardingCategory.codeHint")}
          </p>
          <select
            aria-describedby={error === null ? "category-mcc_code-hint" : "category-mcc_code-error"}
            aria-invalid={error === null ? undefined : true}
            aria-required={true}
            className={error === null ? inputClasses : invalidClasses}
            id="category-mcc_code"
            name="mcc_code"
            onChange={(event) => update(event.target.value)}
            value={selected}
          >
            <option value="">{getMessage("onboardingCategory.placeholderOption")}</option>
            {options.map((option) => (
              <option key={option.code} value={option.code}>
                {optionLabel(option)}
              </option>
            ))}
          </select>
          {error === null ? null : (
            <p className={errorClasses} id="category-mcc_code-error">
              {error}
            </p>
          )}
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <button className={buttonClasses} disabled={busy} type="submit">
          {busy
            ? getMessage("onboardingCategory.saveBusy")
            : getMessage("onboardingCategory.saveSubmit")}
        </button>
        <Link className={linkClasses} href="/onboarding">
          {getMessage("onboardingCategory.backLink")}
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
