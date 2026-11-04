// path: app/(dashboard)/products/catalogue-form.tsx
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { formatMessage, getMessage } from "@/lib/i18n/messages";
import type { MessagePath } from "@/lib/i18n/messages";
import { csrfHeaders } from "@/lib/security/csrf-client";
import type { CatalogueSnapshot } from "@/services/products/catalogue";
import {
  CATALOGUE_CURRENCIES,
  CATALOGUE_PATHS,
  CATALOGUE_UNITS,
  type CatalogueKind,
  type CatalogueUnit,
} from "@/services/products/catalogue-fields";

/**
 * The create and edit form of section 15's two catalogues.
 *
 * ## One form, two catalogues
 *
 * A product and a service ask for the same five things and differ in one: the code column is a SKU for
 * a product and a code for a service, and the default unit is `item` against `hour`. Those three facts
 * arrive as the `kind`, so this component is written once and mounted at both paths - the alternative
 * is two forms that drift, which is the failure the services themselves avoid for the same reason.
 *
 * ## Why the price is a text box
 *
 * Money is stored in minor units and never in a float (rule 2), and a number input in a browser is a
 * float. So the price is a text field with `inputMode="decimal"` for a phone keyboard, the hint says
 * what shape is wanted, and the server converts with decimal string arithmetic. Nothing here rounds,
 * parses or formats an amount; it sends what the merchant typed and prints the refusal if that was not
 * a price.
 *
 * ## Why every refusal is read field by field
 *
 * The service names every field that failed and the rule it broke, so the form marks all of them at
 * once. A rule this build does not know still produces a sentence rather than an empty line under the
 * box, and the rule list is the service's: this component carries no ceiling and no pattern of its own.
 */

interface FieldCopy {
  readonly label: MessagePath;
  readonly hint: MessagePath;
  readonly kind: "line" | "multiline";
  readonly autoComplete: string;
}

/** The copy of one catalogue's fields, keyed by the column names the body carries. */
interface CatalogueCopy {
  readonly name: FieldCopy;
  /** The one code column of this catalogue: `sku` for a product, `code` for a service. */
  readonly code: FieldCopy;
  readonly description: FieldCopy;
}

function copyOf(kind: CatalogueKind): CatalogueCopy {
  return {
    name: {
      label: kind === "product" ? "catalogue.productName" : "catalogue.serviceName",
      hint: "catalogue.nameHint",
      kind: "line",
      autoComplete: "off",
    },
    code:
      kind === "product"
        ? { label: "catalogue.sku", hint: "catalogue.skuHint", kind: "line", autoComplete: "off" }
        : { label: "catalogue.code", hint: "catalogue.codeHint", kind: "line", autoComplete: "off" },
    description: {
      label: "catalogue.description",
      hint: "catalogue.descriptionHint",
      kind: "multiline",
      autoComplete: "off",
    },
  };
}

const RULE_KEYS: Readonly<Record<string, MessagePath>> = Object.freeze({
  required: "catalogue.ruleRequired",
  too_short: "catalogue.ruleTooShort",
  too_long: "catalogue.ruleTooLong",
  invalid_format: "catalogue.ruleInvalidFormat",
  too_large: "catalogue.ruleTooLarge",
  already_used: "catalogue.ruleAlreadyUsed",
  already_changed: "catalogue.ruleAlreadyChanged",
  unknown_field: "catalogue.ruleUnknownField",
});

function ruleSentence(rule: string | null): string {
  if (rule === null) {
    return getMessage("catalogue.fieldInvalid");
  }

  const key = RULE_KEYS[rule];

  return key === undefined ? getMessage("catalogue.fieldInvalid") : getMessage(key);
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

export interface CatalogueFormProps {
  readonly kind: CatalogueKind;
  /** Null for the create form; the loaded row for the edit form. */
  readonly initial: CatalogueSnapshot | null;
  /** Where the save posts: `/api/products` to create, `/api/products/[id]` to edit. */
  readonly savePath: string;
  /** True when this save creates the row, so success navigates to the edit screen. */
  readonly creating: boolean;
}

export function CatalogueForm({ kind, initial, savePath, creating }: CatalogueFormProps): ReactNode {
  const router = useRouter();
  const copy = copyOf(kind);
  const codeKey: string = kind === "product" ? "sku" : "code";
  const [name, setName] = useState<string>(initial?.values.name ?? "");
  const [code, setCode] = useState<string>(initial?.values.code ?? "");
  const [description, setDescription] = useState<string>(initial?.values.description ?? "");
  const [unitPrice, setUnitPrice] = useState<string>(initial?.values.unitPrice ?? "");
  const [unit, setUnit] = useState<CatalogueUnit>(initial?.values.unit ?? (kind === "product" ? "item" : "hour"));
  const [currency] = useState<string>(initial?.values.currency ?? CATALOGUE_CURRENCIES[0]);
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});
  const [savedAt, setSavedAt] = useState<number | null>(initial?.updatedAtEpochMs ?? null);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const listPath = `/${CATALOGUE_PATHS[kind]}`;

  function clearError(field: string): void {
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

    const body: Record<string, string> = {
      name,
      [codeKey]: code,
      description,
      unit_price: unitPrice,
      unit,
      currency,
    };

    try {
      const response = await fetch(savePath, {
        method: "POST",
        headers: { "content-type": "application/json", ...(await csrfHeaders()) },
        body: JSON.stringify(body),
        credentials: "same-origin",
        cache: "no-store",
      });

      const payload: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        const details = refusalDetails(payload);
        const next: Partial<Record<string, string>> = {};

        for (const detail of details) {
          const field = typeof detail.field === "string" ? detail.field : null;

          if (field !== null) {
            next[field] = ruleSentence(typeof detail.rule === "string" ? detail.rule : null);
          }
        }

        setErrors(next);
        setFailed(true);
        setMessage(getMessage("catalogue.saveFailed"));

        return;
      }

      const entry = (payload as { readonly entry?: CatalogueSnapshot }).entry;

      if (entry === undefined) {
        setFailed(true);
        setMessage(getMessage("catalogue.saveFailed"));

        return;
      }

      setErrors({});
      setSavedAt(entry.updatedAtEpochMs);
      setMessage(getMessage(creating ? "catalogue.createdMessage" : "catalogue.updatedMessage"));

      if (creating) {
        router.push(`${listPath}/${entry.id}`);
      }
    } catch {
      setFailed(true);
      setMessage(getMessage("catalogue.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  function errorLine(field: string): ReactNode {
    const error = errors[field];

    return error === undefined ? null : (
      <p className="text-xs text-destructive" id={`catalogue-${field}-error`} role="alert">
        {error}
      </p>
    );
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        void save(event);
      }}
    >
      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium" htmlFor="catalogue-name">
          {getMessage(copy.name.label)}
        </label>
        <input
          aria-describedby={errors["name"] === undefined ? "catalogue-name-hint" : "catalogue-name-error"}
          aria-invalid={errors["name"] !== undefined}
          autoComplete={copy.name.autoComplete}
          className="rounded-md border border-border bg-background px-3 py-2 text-sm"
          id="catalogue-name"
          onChange={(event) => {
            setName(event.target.value);
            clearError("name");
          }}
          type="text"
          value={name}
        />
        {errors["name"] === undefined ? (
          <p className="text-xs text-muted-foreground" id="catalogue-name-hint">
            {getMessage(copy.name.hint)}
          </p>
        ) : (
          errorLine("name")
        )}
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium" htmlFor={`catalogue-${codeKey}`}>
          {getMessage(copy.code.label)}
        </label>
        <input
          aria-describedby={
            errors[codeKey] === undefined ? `catalogue-${codeKey}-hint` : `catalogue-${codeKey}-error`
          }
          aria-invalid={errors[codeKey] !== undefined}
          autoComplete="off"
          className="rounded-md border border-border bg-background px-3 py-2 text-sm"
          id={`catalogue-${codeKey}`}
          onChange={(event) => {
            setCode(event.target.value);
            clearError(codeKey);
          }}
          spellCheck={false}
          type="text"
          value={code}
        />
        {errors[codeKey] === undefined ? (
          <p className="text-xs text-muted-foreground" id={`catalogue-${codeKey}-hint`}>
            {getMessage(copy.code.hint)}
          </p>
        ) : (
          errorLine(codeKey)
        )}
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium" htmlFor="catalogue-unit_price">
          {getMessage("catalogue.unitPrice")}
        </label>
        <input
          aria-describedby={
            errors["unit_price"] === undefined ? "catalogue-unit_price-hint" : "catalogue-unit_price-error"
          }
          aria-invalid={errors["unit_price"] !== undefined}
          autoComplete="off"
          className="rounded-md border border-border bg-background px-3 py-2 text-sm"
          id="catalogue-unit_price"
          inputMode="decimal"
          onChange={(event) => {
            setUnitPrice(event.target.value);
            clearError("unit_price");
          }}
          spellCheck={false}
          type="text"
          value={unitPrice}
        />
        <p className="text-xs text-muted-foreground" id="catalogue-unit_price-hint">
          {formatMessage("catalogue.unitPriceHint", { currency })}
        </p>
        {errorLine("unit_price")}
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium" htmlFor="catalogue-unit">
          {getMessage("catalogue.unit")}
        </label>
        <select
          className="rounded-md border border-border bg-background px-3 py-2 text-sm"
          id="catalogue-unit"
          onChange={(event) => {
            const chosen = event.target.value;

            if ((CATALOGUE_UNITS as readonly string[]).includes(chosen)) {
              setUnit(chosen as CatalogueUnit);
            }
          }}
          value={unit}
        >
          {CATALOGUE_UNITS.map((option) => (
            <option key={option} value={option}>
              {getMessage(`catalogue.unit_${option}` as MessagePath)}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">{getMessage("catalogue.unitHint")}</p>
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium" htmlFor="catalogue-description">
          {getMessage(copy.description.label)}
        </label>
        <textarea
          aria-describedby={
            errors["description"] === undefined
              ? "catalogue-description-hint"
              : "catalogue-description-error"
          }
          aria-invalid={errors["description"] !== undefined}
          className="min-h-24 rounded-md border border-border bg-background px-3 py-2 text-sm"
          id="catalogue-description"
          onChange={(event) => {
            setDescription(event.target.value);
            clearError("description");
          }}
          value={description}
        />
        {errors["description"] === undefined ? (
          <p className="text-xs text-muted-foreground" id="catalogue-description-hint">
            {getMessage(copy.description.hint)}
          </p>
        ) : (
          errorLine("description")
        )}
      </div>

      <div className="flex flex-col gap-2">
        <button
          className="w-fit rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-60"
          disabled={busy}
          type="submit"
        >
          {getMessage(busy ? "catalogue.saving" : "catalogue.save")}
        </button>
        {message === null ? null : (
          <p className={failed ? "text-sm text-destructive" : "text-sm text-muted-foreground"} role="status">
            {message}
          </p>
        )}
        {savedAt === null ? null : (
          <p className="text-xs text-muted-foreground">
            {formatMessage("catalogue.savedLine", {
              at: new Date(savedAt).toISOString().replace("T", " ").slice(0, 19),
            })}
          </p>
        )}
        <Link className="text-sm underline" href={listPath}>
          {kind === "product" ? getMessage("catalogue.backToProducts") : getMessage("catalogue.backToServices")}
        </Link>
      </div>
    </form>
  );
}
