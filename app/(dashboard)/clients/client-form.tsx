// path: app/(dashboard)/clients/client-form.tsx
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { formatMessage, getMessage } from "@/lib/i18n/messages";
import type { MessagePath } from "@/lib/i18n/messages";
import { csrfHeaders } from "@/lib/security/csrf-client";
import type { ClientSnapshot } from "@/services/clients/clients";
import { CLIENT_FIELDS, type ClientField } from "@/services/clients/client-fields";

/**
 * The client create and edit form of section 15.
 *
 * ## What it sends, and what it never sends
 *
 * The body is the twelve field names and the values typed into them. The company is not in the body
 * and the row is not in the body of the create: the service takes the company from the session and
 * the row from the path, so an edited request cannot write another merchant's client. Every field is
 * sent on every save, because the service reads a missing key as "leave this alone" - sending all
 * twelve is how a cleared box becomes a cleared column.
 *
 * ## Why the refusals are read field by field
 *
 * The service names every field that failed and the rule it broke, so the form marks all of them at
 * once and moves the caret to the first. A rule this build does not know still produces a sentence
 * rather than an empty line under the box. The rules are not duplicated here: this component sends
 * values and reads the service's answer, so a field rule has one home.
 */

interface FieldCopy {
  readonly label: MessagePath;
  readonly hint: MessagePath;
  readonly kind: "line" | "multiline";
  readonly autoComplete: string;
}

const FIELD_COPY: Readonly<Record<ClientField, FieldCopy>> = Object.freeze({
  name: { label: "clients.name", hint: "clients.nameHint", kind: "line", autoComplete: "name" },
  company_name: { label: "clients.companyName", hint: "clients.companyNameHint", kind: "line", autoComplete: "organization" },
  email: { label: "clients.email", hint: "clients.emailHint", kind: "line", autoComplete: "email" },
  phone: { label: "clients.phone", hint: "clients.phoneHint", kind: "line", autoComplete: "tel" },
  address_line1: { label: "clients.addressLine1", hint: "clients.addressLine1Hint", kind: "line", autoComplete: "address-line1" },
  address_line2: { label: "clients.addressLine2", hint: "clients.addressLine2Hint", kind: "line", autoComplete: "address-line2" },
  city: { label: "clients.city", hint: "clients.cityHint", kind: "line", autoComplete: "address-level2" },
  region: { label: "clients.region", hint: "clients.regionHint", kind: "line", autoComplete: "address-level1" },
  postal_code: { label: "clients.postalCode", hint: "clients.postalCodeHint", kind: "line", autoComplete: "postal-code" },
  country: { label: "clients.country", hint: "clients.countryHint", kind: "line", autoComplete: "country" },
  tax_id: { label: "clients.taxId", hint: "clients.taxIdHint", kind: "line", autoComplete: "off" },
  notes: { label: "clients.notes", hint: "clients.notesHint", kind: "multiline", autoComplete: "off" },
});

const RULE_KEYS: Readonly<Record<string, MessagePath>> = Object.freeze({
  required: "clients.ruleRequired",
  too_short: "clients.ruleTooShort",
  too_long: "clients.ruleTooLong",
  invalid_format: "clients.ruleInvalidFormat",
  already_used: "clients.ruleAlreadyUsed",
  address_requires_line1: "clients.ruleAddressRequiresLine1",
  unknown_field: "clients.ruleUnknownField",
});

function ruleSentence(rule: string | null): string {
  if (rule === null) {
    return getMessage("clients.fieldInvalid");
  }

  const key = RULE_KEYS[rule];

  return key === undefined ? getMessage("clients.fieldInvalid") : getMessage(key);
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

function valuesFrom(snapshot: ClientSnapshot | null): Record<ClientField, string> {
  const record = {} as Record<ClientField, string>;

  for (const field of CLIENT_FIELDS) {
    record[field] = snapshot?.values[field] ?? "";
  }

  return record;
}

export interface ClientFormProps {
  /** Null for the create form; the loaded client for the edit form. */
  readonly initial: ClientSnapshot | null;
  /** Where the save posts: `/api/clients` to create, `/api/clients/[id]` to edit. */
  readonly savePath: string;
  /** True when this save creates the row, so success navigates to the edit screen. */
  readonly creating: boolean;
}

export function ClientForm({ initial, savePath, creating }: ClientFormProps): ReactNode {
  const router = useRouter();
  const [values, setValues] = useState<Record<ClientField, string>>(() => valuesFrom(initial));
  const [errors, setErrors] = useState<Partial<Record<ClientField, string>>>({});
  const [savedAt, setSavedAt] = useState<number | null>(initial?.updatedAtEpochMs ?? null);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);

  function update(field: ClientField, value: string): void {
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
      const response = await fetch(savePath, {
        method: "POST",
        headers: { "content-type": "application/json", ...(await csrfHeaders()) },
        body: JSON.stringify(values),
        credentials: "same-origin",
        cache: "no-store",
      });

      const payload: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        const details = refusalDetails(payload);
        const next: Partial<Record<ClientField, string>> = {};

        for (const detail of details) {
          const field = typeof detail.field === "string" ? (detail.field as ClientField) : null;

          if (field !== null && CLIENT_FIELDS.includes(field)) {
            next[field] = ruleSentence(typeof detail.rule === "string" ? detail.rule : null);
          }
        }

        setErrors(next);
        setFailed(true);
        setMessage(getMessage("clients.saveFailed"));

        return;
      }

      const client = (payload as { readonly client?: ClientSnapshot }).client;

      if (client === undefined) {
        setFailed(true);
        setMessage(getMessage("clients.saveFailed"));

        return;
      }

      setSavedAt(client.updatedAtEpochMs);
      setMessage(getMessage(creating ? "clients.createdMessage" : "clients.updatedMessage"));

      if (creating) {
        router.push(`/clients/${client.id}`);
      }
    } catch {
      setFailed(true);
      setMessage(getMessage("clients.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={(event) => {
      void save(event);
    }}>
      {CLIENT_FIELDS.map((field) => {
        const copy = FIELD_COPY[field];
        const error = errors[field];

        return (
          <div key={field} className="flex flex-col gap-1">
            <label className="text-sm font-medium" htmlFor={`client-${field}`}>
              {getMessage(copy.label)}
            </label>
            {copy.kind === "multiline" ? (
              <textarea
                id={`client-${field}`}
                className="min-h-24 rounded-md border border-border bg-background px-3 py-2 text-sm"
                autoComplete={copy.autoComplete}
                value={values[field]}
                aria-invalid={error !== undefined}
                aria-describedby={error === undefined ? `client-${field}-hint` : `client-${field}-error`}
                onChange={(event) => update(field, event.target.value)}
              />
            ) : (
              <input
                id={`client-${field}`}
                className="rounded-md border border-border bg-background px-3 py-2 text-sm"
                type="text"
                autoComplete={copy.autoComplete}
                value={values[field]}
                aria-invalid={error !== undefined}
                aria-describedby={error === undefined ? `client-${field}-hint` : `client-${field}-error`}
                onChange={(event) => update(field, event.target.value)}
              />
            )}
            {error === undefined ? (
              <p id={`client-${field}-hint`} className="text-xs text-muted-foreground">
                {getMessage(copy.hint)}
              </p>
            ) : (
              <p id={`client-${field}-error`} className="text-xs text-destructive" role="alert">
                {error}
              </p>
            )}
          </div>
        );
      })}

      <div className="flex flex-col gap-2">
        <button
          className="w-fit rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-60"
          type="submit"
          disabled={busy}
        >
          {getMessage(busy ? "clients.saving" : "clients.save")}
        </button>
        {message !== null ? (
          <p className={failed ? "text-sm text-destructive" : "text-sm text-muted-foreground"} role="status">
            {message}
          </p>
        ) : null}
        {savedAt !== null ? (
          <p className="text-xs text-muted-foreground">
            {formatMessage("clients.savedLine", {
              at: new Date(savedAt).toISOString().replace("T", " ").slice(0, 19),
            })}
          </p>
        ) : null}
        <Link className="text-sm underline" href="/clients">
          {getMessage("clients.backLink")}
        </Link>
      </div>
    </form>
  );
}
