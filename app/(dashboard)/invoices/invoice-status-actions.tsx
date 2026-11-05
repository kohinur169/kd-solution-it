// path: app/(dashboard)/invoices/invoice-status-actions.tsx
"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { formatMessage, getMessage } from "@/lib/i18n/messages";
import { csrfHeaders } from "@/lib/security/csrf-client";
import {
  INVOICE_VOID_REASON_LIMITS,
  isLegalInvoiceTransition,
} from "@/services/invoices/invoice-status";
import { INVOICE_STATUSES, type InvoiceStatus } from "@/services/invoices/invoice-fields";

/**
 * The one control bar of the invoice's workflow: what the document is, and what may happen to it.
 *
 * ## Where every rule lives
 *
 * The rows the bar knows about arrive from the screen above, which has already refused an account that
 * may not read the document. The moves themselves are `sendInvoice` and `voidInvoice`, reached through
 * routes that carry the CSRF token; nothing here decides who may send or void - the service applies the
 * `owner` role, the workflow checks the move, and the database guard freezes a paid row behind both.
 *
 * ## Why the bar offers only what the graph allows
 *
 * `INVOICE_STATUS_TRANSITIONS` is the workflow in one place, and the bar reads the same table the
 * service enforces, so a button the service would refuse never appears. A draft offers send and void;
 * an open document offers void; a paid document offers nothing at all, and says so in the section's
 * own sentence instead of a disabled button that looks like it could work.
 *
 * ## Refusals are told apart, because each is a different next step
 *
 * `401` is a session that ended mid-action; `403` is an account the service will not act for; `409` is
 * a document that moved while the action was in flight - a second send, a payment that arrived, a
 * void that beat this one - and the answer is to reload and look at what the document is now; `422`
 * names the reason field. Every one of them is a different sentence.
 */

const SEND_PATH = (invoiceId: string): string => `/api/invoices/${invoiceId}/send`;

const VOID_PATH = (invoiceId: string): string => `/api/invoices/${invoiceId}/void`;

const panelClasses =
  "flex flex-col gap-3 rounded-lg border border-primary bg-surface p-4 text-foreground shadow-card";

const barClasses = "flex flex-wrap items-center gap-3";

const labelClasses = "text-sm font-medium";

const hintClasses = "text-xs text-muted-foreground";

const textareaClasses =
  "mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary";

const primaryButtonClasses =
  "w-fit inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60";

const secondaryButtonClasses =
  "w-fit inline-flex items-center justify-center rounded-lg border border-border bg-background px-4 py-2 text-sm font-semibold text-foreground transition-opacity hover:opacity-80";

const messageClasses = "text-sm";

/** One instant, printed the way every invoice screen prints one: UTC, seconds cut. */
function instantOf(iso: string): string {
  const parsed = Date.parse(iso);

  return Number.isFinite(parsed) ? new Date(parsed).toISOString().replace("T", " ").slice(0, 19) : iso;
}

interface InvoiceStatusActionsProps {
  readonly invoiceId: string;
  readonly status: string;
  readonly number: string | null;
  readonly issuedAt: string | null;
}

export function InvoiceStatusActions({ invoiceId, status, number, issuedAt }: InvoiceStatusActionsProps): ReactNode {
  const router = useRouter();
  const [voidOpen, setVoidOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const isStatus = (candidate: InvoiceStatus): boolean => status === candidate;

  // The bar reads the same table the service enforces: a move appears as a button only when the
  // workflow allows it from the status the server just reported.
  const knownStatus = INVOICE_STATUSES.find((candidate) => status === candidate);
  const canSend = knownStatus === "draft" && isLegalInvoiceTransition("draft", "sent");
  const canVoid = knownStatus !== undefined && isLegalInvoiceTransition(knownStatus, "void");

  /** The sentence a refusal earns. */
  function refusalFor(response: Response): string {
    if (response.status === 401) {
      return getMessage("invoices.actionSignedOut");
    }

    if (response.status === 403) {
      return getMessage("invoices.forbidden");
    }

    if (response.status === 422) {
      return getMessage("invoices.fieldInvalid");
    }

    return getMessage("invoices.actionConflict");
  }

  async function send(): Promise<void> {
    setBusy(true);
    setMessage(null);

    try {
      const response = await fetch(SEND_PATH(invoiceId), {
        method: "POST",
        headers: { ...(await csrfHeaders()) },
      });

      if (!response.ok) {
        setMessage(refusalFor(response));
        setBusy(false);

        return;
      }

      const answer = (await response.json().catch(() => null)) as {
        readonly number?: unknown;
      } | null;
      setBusy(false);

      if (answer !== null && typeof answer.number === "string" && answer.number.length > 0) {
        setMessage(formatMessage("invoices.sendDone", { number: answer.number }));
      }

      // The screen is the server's answer: the status, the number and the issue instant it now holds.
      router.refresh();
    } catch {
      setMessage(getMessage("invoices.sendFailed"));
      setBusy(false);
    }
  }

  async function voidIt(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    const trimmed = reason.trim();

    if (
      trimmed.length > 0 &&
      (trimmed.length < INVOICE_VOID_REASON_LIMITS.min || trimmed.length > INVOICE_VOID_REASON_LIMITS.max)
    ) {
      setMessage(getMessage("invoices.fieldInvalid"));

      return;
    }

    setBusy(true);
    setMessage(null);

    try {
      const body = trimmed.length === 0 ? "{}" : JSON.stringify({ reason: trimmed });

      const response = await fetch(VOID_PATH(invoiceId), {
        method: "POST",
        headers: { "content-type": "application/json", ...(await csrfHeaders()) },
        body,
      });

      if (!response.ok) {
        setMessage(refusalFor(response));
        setBusy(false);

        return;
      }

      setBusy(false);
      setVoidOpen(false);
      setReason("");
      setMessage(getMessage("invoices.voidedDone"));
      // The screen is the server's answer: the document is void, and the bar that offered it is gone.
      router.refresh();
    } catch {
      setMessage(getMessage("invoices.voidFailed"));
      setBusy(false);
    }
  }

  // A paid document offers nothing and says why in the section's own sentence.
  if (isStatus("paid")) {
    return <p className="text-sm text-muted-foreground">{getMessage("invoices.paidLocked")}</p>;
  }

  // A voided document is terminal for the same reason a paid one is: the work is done, the record stands.
  if (isStatus("void")) {
    return <p className="text-sm text-muted-foreground">{getMessage("invoices.voidClosed")}</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className={barClasses}>
        {canSend ? (
          <button className={primaryButtonClasses} disabled={busy} onClick={(): void => void send()} type="button">
            {busy ? getMessage("invoices.sendPending") : getMessage("invoices.sendAction")}
          </button>
        ) : null}

        {canVoid ? (
          <button className={secondaryButtonClasses} disabled={busy} onClick={(): void => setVoidOpen(!voidOpen)} type="button">
            {getMessage("invoices.voidAction")}
          </button>
        ) : null}

        {number !== null ? <span className="text-sm text-muted-foreground">{number}</span> : null}
        {issuedAt !== null ? (
          <span className="text-sm text-muted-foreground">
            {formatMessage("invoices.issuedLine", { at: instantOf(issuedAt) })}
          </span>
        ) : null}
      </div>

      {voidOpen && canVoid ? (
        <form
          className={panelClasses}
          onSubmit={(event): void => {
            void voidIt(event);
          }}
        >
          <label className={labelClasses}>
            {getMessage("invoices.voidReasonLabel")}
            <textarea
              className={textareaClasses}
              maxLength={INVOICE_VOID_REASON_LIMITS.max}
              onChange={(event) => setReason(event.target.value)}
              placeholder={getMessage("invoices.voidReasonPlaceholder")}
              rows={2}
              value={reason}
            />
            <span className={`${hintClasses} block`}>{getMessage("invoices.voidNote")}</span>
          </label>

          <div className="flex flex-wrap items-center gap-3">
            <button className={primaryButtonClasses} disabled={busy} type="submit">
              {busy ? getMessage("invoices.voidPending") : getMessage("invoices.voidAction")}
            </button>
            <button
              className={secondaryButtonClasses}
              disabled={busy}
              onClick={(): void => {
                setVoidOpen(false);
                setReason("");
                setMessage(null);
              }}
              type="button"
            >
              {getMessage("invoices.cancel")}
            </button>
          </div>
        </form>
      ) : null}

      {message === null ? null : (
        <div className={messageClasses} role="alert">
          <p className="text-destructive">{message}</p>
        </div>
      )}
    </div>
  );
}
