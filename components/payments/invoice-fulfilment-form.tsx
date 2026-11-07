// path: components/payments/invoice-fulfilment-form.tsx
"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { getMessage } from "../../lib/i18n/messages.ts";
import { csrfHeaders } from "../../lib/security/csrf-client.ts";
import {
  PORTAL_FULFILMENT_METHOD_KIND,
  PORTAL_FULFILMENT_METHODS,
  type PortalFulfilmentKind,
  type PortalFulfilmentMethod,
} from "../../app/(client-portal)/portal-invoice-fields.ts";
import { portalFailureTextOf } from "./portal-form-refusal.ts";

/**
 * The merchant's delivery record, on the merchant's own view of the client link.
 *
 * ## Why the merchant's form lives on a buyer's page
 *
 * STEP 181 owns `app/(client-portal)/` and the payment components, and nothing else. The evidence the
 * buyer confirms has to be recorded by the merchant, and the only surface this STEP may build is this
 * one, so the tokenized page shows a second panel to the account that owns the invoice: the same link,
 * the same document, and one extra form for the person who sent it. A buyer never sees this panel - it
 * renders only when a session resolves to the invoice's own company and an `owner` role - and the route
 * behind it refuses an account that does not own the link.
 *
 * ## The methods a merchant may choose
 *
 * `PORTAL_FULFILMENT_METHOD_KIND` decides which methods belong to the chosen kind, so the select cannot
 * offer "by carrier" for work performed over a call. The kind is the merchant's decision; the method
 * follows from it, and the service refuses a pair that disagrees even though the form cannot produce one.
 */

const containerClasses = "flex flex-col gap-4";

const fieldClasses = "flex flex-col gap-1";

const labelClasses = "text-sm font-medium";

const hintClasses = "text-xs text-muted-foreground";

const inputClasses =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary";

const textareaClasses = `${inputClasses} min-h-20 resize-y`;

const gridClasses = "grid grid-cols-1 gap-4 sm:grid-cols-2";

const submitClasses =
  "inline-flex w-full items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60 sm:w-auto";

const errorClasses = "text-sm font-medium text-destructive";

/** The word for one method, so the select and the saved record read alike. */
function methodLabelOf(method: PortalFulfilmentMethod): string {
  switch (method) {
    case "carrier":
      return getMessage("portal.merchantMethodCarrier");
    case "hand_delivery":
      return getMessage("portal.merchantMethodHandDelivery");
    case "pickup":
      return getMessage("portal.merchantMethodPickup");
    case "digital":
      return getMessage("portal.merchantMethodDigital");
    case "in_person":
      return getMessage("portal.merchantMethodInPerson");
    case "remote":
      return getMessage("portal.merchantMethodRemote");
  }
}

/** The methods that belong to a kind, in the catalog's own order. */
function methodsOf(kind: PortalFulfilmentKind): readonly PortalFulfilmentMethod[] {
  return PORTAL_FULFILMENT_METHODS.filter((method) => PORTAL_FULFILMENT_METHOD_KIND[method] === kind);
}

export interface InvoiceFulfilmentFormProps {
  readonly token: string;
  /** The record already saved, so the form starts from what the page is showing. */
  readonly existing: {
    readonly kind: PortalFulfilmentKind;
    readonly method: PortalFulfilmentMethod;
    readonly occurredAt: string;
    readonly reference: string | null;
    readonly description: string | null;
  } | null;
}

export function InvoiceFulfilmentForm({ token, existing }: InvoiceFulfilmentFormProps): ReactNode {
  const router = useRouter();
  const [kind, setKind] = useState<PortalFulfilmentKind>(existing?.kind ?? "delivery");
  const [method, setMethod] = useState<PortalFulfilmentMethod>(existing?.method ?? "carrier");
  const [occurredAt, setOccurredAt] = useState(
    existing?.occurredAt.slice(0, 16) ?? new Date().toISOString().slice(0, 16),
  );
  const [reference, setReference] = useState(existing?.reference ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  function chooseKind(next: PortalFulfilmentKind): void {
    setKind(next);

    // The method follows the kind: a select that kept "by carrier" after switching to a service would
    // offer a pair the service refuses, so the first method of the new kind is chosen instead.
    const allowed = methodsOf(next);

    if (!allowed.includes(method) && allowed[0] !== undefined) {
      setMethod(allowed[0]);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    setSaved(null);

    try {
      const response = await fetch(`/i/${encodeURIComponent(token)}/fulfilment`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(await csrfHeaders()) },
        body: JSON.stringify({
          kind,
          method,
          occurred_at: new Date(occurredAt).toISOString(),
          reference: reference.trim().length === 0 ? null : reference.trim(),
          description: description.trim().length === 0 ? null : description.trim(),
        }),
      });

      if (!response.ok) {
        setMessage(await portalFailureTextOf(response, getMessage("portal.merchantFailed")));
        return;
      }

      setSaved(getMessage("portal.merchantSaved"));
      router.refresh();
    } catch {
      setMessage(getMessage("portal.merchantFailed"));
    } finally {
      setBusy(false);
    }
  }

  const methods = methodsOf(kind);

  return (
    <form
      onSubmit={(event): void => {
        void submit(event);
      }}
      className={containerClasses}
      noValidate
    >
      <p className={hintClasses}>{getMessage("portal.merchantBody")}</p>

      {existing === null ? null : (
        <p className={hintClasses}>{getMessage("portal.merchantReplaceNotice")}</p>
      )}

      <div className={gridClasses}>
        <div className={fieldClasses}>
          <label className={labelClasses} htmlFor="portal-fulfilment-kind">
            {getMessage("portal.merchantKindLabel")}
          </label>
          <select
            id="portal-fulfilment-kind"
            name="kind"
            value={kind}
            onChange={(event) => chooseKind(event.target.value === "service" ? "service" : "delivery")}
            className={inputClasses}
          >
            <option value="delivery">{getMessage("portal.merchantKindDelivery")}</option>
            <option value="service">{getMessage("portal.merchantKindService")}</option>
          </select>
        </div>

        <div className={fieldClasses}>
          <label className={labelClasses} htmlFor="portal-fulfilment-method">
            {getMessage("portal.merchantMethodLabel")}
          </label>
          <select
            id="portal-fulfilment-method"
            name="method"
            value={method}
            onChange={(event) => {
              const chosen = methods.find((candidate) => candidate === event.target.value);

              if (chosen !== undefined) {
                setMethod(chosen);
              }
            }}
            className={inputClasses}
          >
            {methods.map((candidate) => (
              <option key={candidate} value={candidate}>
                {methodLabelOf(candidate)}
              </option>
            ))}
          </select>
        </div>

        <div className={fieldClasses}>
          <label className={labelClasses} htmlFor="portal-fulfilment-occurred">
            {getMessage("portal.merchantOccurredLabel")}
          </label>
          <input
            id="portal-fulfilment-occurred"
            name="occurred_at"
            type="datetime-local"
            required
            value={occurredAt}
            onChange={(event) => setOccurredAt(event.target.value)}
            className={inputClasses}
          />
        </div>

        <div className={fieldClasses}>
          <label className={labelClasses} htmlFor="portal-fulfilment-reference">
            {getMessage("portal.merchantReferenceLabel")}
          </label>
          <input
            id="portal-fulfilment-reference"
            name="reference"
            type="text"
            maxLength={120}
            value={reference}
            onChange={(event) => setReference(event.target.value)}
            className={inputClasses}
          />
          <span className={hintClasses}>{getMessage("portal.merchantReferenceHint")}</span>
        </div>
      </div>

      <div className={fieldClasses}>
        <label className={labelClasses} htmlFor="portal-fulfilment-description">
          {getMessage("portal.merchantDescriptionLabel")}
        </label>
        <textarea
          id="portal-fulfilment-description"
          name="description"
          maxLength={500}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          className={textareaClasses}
        />
        <span className={hintClasses}>{getMessage("portal.merchantDescriptionHint")}</span>
      </div>

      {message === null ? null : (
        <p role="alert" className={errorClasses}>
          {message}
        </p>
      )}

      {saved === null ? null : <p className="text-sm font-medium text-success">{saved}</p>}

      <button type="submit" disabled={busy} className={submitClasses}>
        {busy ? getMessage("portal.merchantSubmitting") : getMessage("portal.merchantSubmit")}
      </button>
    </form>
  );
}
