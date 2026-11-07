// path: components/payments/invoice-acceptance-form.tsx
"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { getMessage } from "../../lib/i18n/messages.ts";
import { csrfHeaders } from "../../lib/security/csrf-client.ts";
import type { PortalAcceptanceStatement } from "../../app/(client-portal)/portal-invoice-fields.ts";
import { portalFailureTextOf } from "./portal-form-refusal.ts";

/**
 * The buyer's confirmation of a paid invoice.
 *
 * ## What the form does not send
 *
 * It sends a name, an address, the ticked consent and the id of the delivery record it is confirming.
 * That is all. The statement is sent because the server compares it with the record rather than trusting
 * it; the document digest is *not* sent, because the server computes it from the document it just read -
 * a hash from a browser would be a hash of whatever the browser had. The address of the request and its
 * user agent are read by the route from the request itself, for the same reason.
 *
 * ## Why the consent text is read here rather than typed
 *
 * `portal.acceptanceConsent` is the catalog string the server stores beside the confirmation. Both sides
 * read the same key, so the sentence a buyer ticks is the sentence the evidence keeps. If the copy ever
 * changes, a confirmation made yesterday still holds the words it was given.
 *
 * ## What happens after a confirmation
 *
 * The page is refreshed rather than patched in place: the confirmed state lives in the database, and
 * `router.refresh()` re-reads it, so the buyer sees the record the server actually holds rather than the
 * one this component hoped for. A conflict is a refusal to pretend: the invoice changed or was already
 * confirmed, and the sentence says to reload.
 */

const containerClasses = "flex flex-col gap-4";

const fieldClasses = "flex flex-col gap-1";

const labelClasses = "text-sm font-medium";

const hintClasses = "text-xs text-muted-foreground";

const inputClasses =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary";

const consentRowClasses = "flex items-start gap-2 rounded-md border border-border p-3";

const consentLabelClasses = "text-sm text-foreground";

const submitClasses =
  "inline-flex w-full items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60 sm:w-auto";

const errorClasses = "text-sm font-medium text-destructive";

export interface InvoiceAcceptanceFormProps {
  readonly token: string;
  readonly statement: PortalAcceptanceStatement;
  readonly fulfilmentEvidenceId: string;
}

export function InvoiceAcceptanceForm({
  token,
  statement,
  fulfilmentEvidenceId,
}: InvoiceAcceptanceFormProps): ReactNode {
  const router = useRouter();
  const [signerName, setSignerName] = useState("");
  const [signerEmail, setSignerEmail] = useState("");
  const [consented, setConsented] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setMessage(null);

    try {
      const response = await fetch(`/i/${encodeURIComponent(token)}/acceptance`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(await csrfHeaders()) },
        body: JSON.stringify({
          statement,
          fulfilment_evidence_id: fulfilmentEvidenceId,
          signer_name: signerName.trim(),
          signer_email: signerEmail.trim(),
          consent_accepted: consented,
        }),
      });

      if (!response.ok) {
        setMessage(await portalFailureTextOf(response, getMessage("portal.confirmationFailed")));
        return;
      }

      setSignerName("");
      setSignerEmail("");
      setConsented(false);
      router.refresh();
    } catch {
      setMessage(getMessage("portal.confirmationFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(event): void => {
        void submit(event);
      }}
      className={containerClasses}
      noValidate
    >
      <p className={hintClasses}>{getMessage("portal.confirmationBody")}</p>

      <div className={fieldClasses}>
        <label className={labelClasses} htmlFor="portal-signer-name">
          {getMessage("portal.confirmationNameLabel")}
        </label>
        <input
          id="portal-signer-name"
          name="signer_name"
          type="text"
          autoComplete="name"
          maxLength={160}
          required
          value={signerName}
          onChange={(event) => setSignerName(event.target.value)}
          className={inputClasses}
        />
        <span className={hintClasses}>{getMessage("portal.confirmationNameHint")}</span>
      </div>

      <div className={fieldClasses}>
        <label className={labelClasses} htmlFor="portal-signer-email">
          {getMessage("portal.confirmationEmailLabel")}
        </label>
        <input
          id="portal-signer-email"
          name="signer_email"
          type="email"
          autoComplete="email"
          maxLength={254}
          required
          value={signerEmail}
          onChange={(event) => setSignerEmail(event.target.value)}
          className={inputClasses}
        />
        <span className={hintClasses}>{getMessage("portal.confirmationEmailHint")}</span>
      </div>

      <div className={consentRowClasses}>
        <input
          id="portal-consent"
          name="consent_accepted"
          type="checkbox"
          required
          checked={consented}
          onChange={(event) => setConsented(event.target.checked)}
          className="mt-0.5 size-4 shrink-0 accent-primary"
        />
        <label className={consentLabelClasses} htmlFor="portal-consent">
          {getMessage("portal.acceptanceConsent")}
        </label>
      </div>

      {message === null ? null : (
        <p role="alert" className={errorClasses}>
          {message}
        </p>
      )}

      <button type="submit" disabled={busy} className={submitClasses}>
        {busy ? getMessage("portal.confirmationSubmitting") : getMessage("portal.confirmationSubmit")}
      </button>
    </form>
  );
}
