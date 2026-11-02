// path: app/(admin)/ceo/approval-request-form.tsx
"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { approvalActionLabelKey, type ApprovalActionType } from "@/lib/approvals/registry";
import { deviceProofHeaders } from "@/lib/auth/device-proof-store";
import { rateLimitSentence } from "@/lib/auth/refusal-message";
import { getMessage } from "@/lib/i18n/messages";
import { csrfHeaders } from "@/lib/security/csrf-client";

/**
 * The one form on the CEO home: raise a request into the section 2 chain.
 *
 * ## Why the page offers a form the CEO cannot use
 *
 * The form is offered for the actions the reader's roles may raise, and `requestable` arrives from the
 * service that enforces the same matrix, so a `ceo` sees no form at all: the CEO signs, and a signer
 * who could raise their own request would be the chain approving itself. A `finance_ops` account
 * never reaches this page, but a super administrator does, and raises the fee change and the
 * country switch here.
 *
 * ## What the request carries
 *
 * An action, the subject's id, the label the CEO will read, an optional amount with its currency and
 * a note of at least ten characters. The service validates all six again; this component only turns a
 * refusal into a sentence. The amount is asked for in minor units, because that is what every money
 * column in this platform stores and a form that guessed at decimals would be wrong for the currencies
 * that have none.
 */

/** The rule a `409` or `422` names, or null when the envelope carries none. */
function refusalRule(payload: unknown): string | null {
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

  const rule = (details[0] as { readonly rule?: unknown }).rule;

  return typeof rule === "string" ? rule : null;
}

function messageForStatus(status: number, payload: unknown): string {
  if (status === 429) {
    return rateLimitSentence(payload);
  }

  if (status === 401) {
    return getMessage("officeApprovals.signedOut");
  }

  if (status === 403) {
    return getMessage("officeApprovals.reauthRequired");
  }

  const rule = refusalRule(payload);

  if (rule === "duplicate") {
    return getMessage("officeApprovals.duplicateRequest");
  }

  if (rule === "amount_currency_pair") {
    return getMessage("officeApprovals.amountPairProblem");
  }

  if (rule === "amount_invalid" || rule === "amount_too_large" || rule === "currency_invalid") {
    return getMessage("officeApprovals.amountInvalid");
  }

  if (rule === "invalid_format" || rule === "unknown_provider") {
    return getMessage("officeApprovals.unknownAction");
  }

  if (status === 409) {
    return getMessage("officeApprovals.conflict");
  }

  return getMessage("officeApprovals.failed");
}

const formClasses = "flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-card";

const fieldClasses = "mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary";

const labelClasses = "block text-sm font-medium text-foreground";

const hintClasses = "text-sm text-muted-foreground";

const buttonClasses =
  "mt-1 inline-flex w-fit items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60";

const noteFieldClasses = `${fieldClasses} min-h-24`;

export function ApprovalRequestForm({
  requestable,
}: {
  readonly requestable: readonly ApprovalActionType[];
}): ReactNode {
  const router = useRouter();
  const [actionType, setActionType] = useState<string>(requestable[0] ?? "payout_release");
  const [subjectId, setSubjectId] = useState("");
  const [subjectLabel, setSubjectLabel] = useState("");
  const [amountMinor, setAmountMinor] = useState("");
  const [currency, setCurrency] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function raise(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setMessage(null);

    try {
      const amount = amountMinor.trim();
      const code = currency.trim();
      const body = JSON.stringify({
        action: "request",
        actionType,
        subjectId,
        subjectLabel,
        note,
        ...(amount.length === 0 ? {} : { amountMinor: Number.parseInt(amount, 10) }),
        ...(code.length === 0 ? {} : { currency: code }),
      });

      // A request says that money may move, so the browser that raises it signs it (STEP 050).
      const proof = await deviceProofHeaders("POST", "/api/office/approvals", body);

      if (proof === null) {
        setMessage(getMessage("device.proofRequired"));
        setBusy(false);

        return;
      }

      const response = await fetch("/api/office/approvals", {
        method: "POST",
        headers: { "content-type": "application/json", ...proof, ...(await csrfHeaders()) },
        body,
      });

      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);

        setMessage(messageForStatus(response.status, payload));
        setBusy(false);

        return;
      }

      setBusy(false);
      setSubjectId("");
      setSubjectLabel("");
      setAmountMinor("");
      setCurrency("");
      setNote("");
      setMessage(getMessage("officeApprovals.raisedDone"));
      router.refresh();
    } catch {
      setBusy(false);
      setMessage(getMessage("officeApprovals.failed"));
    }
  }

  return (
    <form
      className={formClasses}
      onSubmit={(event): void => {
        void raise(event);
      }}
    >
      <label className={labelClasses}>
        {getMessage("officeApprovals.actionTypeLabel")}
        <select
          className={fieldClasses}
          name="actionType"
          onChange={(event): void => {
            setActionType(event.target.value);
          }}
          value={actionType}
        >
          {requestable.map((action) => (
            <option key={action} value={action}>
              {getMessage(approvalActionLabelKey(action))}
            </option>
          ))}
        </select>
      </label>

      <label className={labelClasses}>
        {getMessage("officeApprovals.subjectIdLabel")}
        <input
          autoComplete="off"
          className={fieldClasses}
          maxLength={64}
          name="subjectId"
          onChange={(event): void => {
            setSubjectId(event.target.value);
          }}
          required
          type="text"
          value={subjectId}
        />
      </label>

      <label className={labelClasses}>
        {getMessage("officeApprovals.subjectLabelLabel")}
        <input
          className={fieldClasses}
          maxLength={160}
          name="subjectLabel"
          onChange={(event): void => {
            setSubjectLabel(event.target.value);
          }}
          required
          type="text"
          value={subjectLabel}
        />
      </label>

      <label className={labelClasses}>
        {getMessage("officeApprovals.amountLabelForm")}
        <input
          className={fieldClasses}
          inputMode="numeric"
          min={1}
          name="amountMinor"
          onChange={(event): void => {
            setAmountMinor(event.target.value);
          }}
          type="number"
          value={amountMinor}
        />
      </label>

      <label className={labelClasses}>
        {getMessage("officeApprovals.currencyLabel")}
        <input
          className={fieldClasses}
          maxLength={3}
          name="currency"
          onChange={(event): void => {
            setCurrency(event.target.value);
          }}
          type="text"
          value={currency}
        />
      </label>

      <label className={labelClasses}>
        {getMessage("officeApprovals.noteFieldLabel")}
        <textarea
          className={noteFieldClasses}
          maxLength={1000}
          name="note"
          onChange={(event): void => {
            setNote(event.target.value);
          }}
          required
          value={note}
        />
      </label>
      <p className={hintClasses}>{getMessage("officeApprovals.noteHint")}</p>

      <button className={buttonClasses} disabled={busy} type="submit">
        {busy ? getMessage("officeApprovals.raiseBusy") : getMessage("officeApprovals.raiseSubmit")}
      </button>

      {message === null ? null : (
        <p className="text-sm" role="status">
          {message}
        </p>
      )}
    </form>
  );
}
