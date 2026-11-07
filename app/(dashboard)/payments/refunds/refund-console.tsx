// path: app/(dashboard)/payments/refunds/refund-console.tsx
"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { getMessage } from "@/lib/i18n/messages";
import { csrfHeaders } from "@/lib/security/csrf-client";

/**
 * Section 19's refund desk, for the merchant that received the money.
 *
 * ## What this screen is, and what it deliberately is not
 *
 * A refund here is a **request**: the merchant says which payment, how much and why, and the platform's
 * finance desk decides. So the panel asks three questions and the list shows what became of the answers -
 * `requested`, `approved`, `processing`, `succeeded`, `failed` or `cancelled` - and nothing on this screen
 * sends money anywhere. The sentence under the list says so in the merchant's own words, because a merchant
 * who reads "refunded" and expects a bank credit the same afternoon would be right to complain about a
 * screen that let them believe it.
 *
 * ## Why the payments come from the service, not from a number typed by hand
 *
 * `GET /api/payments` answers only the merchant's own payments in a state a refund starts from, with the
 * headroom already worked out by the same function the request will use. The console therefore cannot offer
 * an amount the service would refuse, and a merchant never has to know a UUID to ask for their money back.
 *
 * ## Why every write re-reads
 *
 * A withdrawal and a request both change rows another tab - or the finance desk - may be looking at, and the
 * service refuses a withdrawal on a refund that has moved on rather than pretending it succeeded. Re-reading
 * after each write shows what the server has rather than what this browser hoped.
 *
 * ## Why the wallet is not promised here
 *
 * `processing`, `succeeded` and `providerRefundId` arrive from the module that executes the refund. This
 * screen prints them when they are there and never invents them; an approval is the money authorised, not
 * the money sent.
 */

/** One refund as the list route answers it. The service's own view, mirrored so the browser imports no server code. */
interface ListedRefund {
  readonly id: string;
  readonly paymentId: string;
  readonly amountMinor: string;
  readonly amountText: string;
  readonly currency: string;
  readonly status: string;
  readonly reason: string;
  readonly decidedAt: string | null;
  readonly processedAt: string | null;
  readonly failureDetail: string | null;
  readonly createdAt: string;
}

/** One payment that can still take a refund. */
interface PayablePayment {
  readonly paymentId: string;
  readonly invoiceId: string | null;
  readonly amountText: string;
  readonly remainingText: string;
  readonly remainingMinor: string;
  readonly currency: string;
  readonly status: string;
  readonly capturedAt: string | null;
}

/** What one read of the desk produced. */
interface DeskState {
  readonly payments: readonly PayablePayment[];
  readonly refunds: readonly ListedRefund[];
  readonly error: string | null;
  readonly signedOut: boolean;
}

const pageClasses = "mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10";

const panelClasses =
  "flex flex-col gap-4 rounded-lg border border-border bg-surface p-4 text-foreground shadow-card sm:p-6";

const headingClasses = "text-sm font-semibold tracking-tight text-foreground";

const titleClasses = "text-xl font-semibold tracking-tight text-foreground sm:text-2xl";

const bodyClasses = "text-sm text-muted-foreground";

const noteClasses = "text-xs text-muted-foreground";

const labelClasses = "flex flex-col gap-1 text-sm font-medium text-foreground";

const inputClasses =
  "w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary";

const primaryButtonClasses =
  "inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50";

const quietButtonClasses =
  "inline-flex items-center justify-center rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground disabled:opacity-50";

const rowClasses = "flex flex-col gap-2 border-t border-border pt-3 text-sm first:border-t-0 first:pt-0";

const errorClasses = "rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-sm text-danger";

const successClasses = "flex flex-col gap-1 rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-sm";

const badgeClasses = "rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground";

/** The refusal envelope's first detail, or nulls when the answer carries none. */
function refusalOf(payload: unknown): { readonly field: string | null; readonly rule: string | null } {
  if (typeof payload !== "object" || payload === null) {
    return { field: null, rule: null };
  }

  const error = (payload as { readonly error?: unknown }).error;

  if (typeof error !== "object" || error === null) {
    return { field: null, rule: null };
  }

  const details = (error as { readonly details?: unknown }).details;

  if (!Array.isArray(details) || details.length === 0) {
    return { field: null, rule: null };
  }

  const first = details[0] as { readonly field?: unknown; readonly rule?: unknown };

  return {
    field: typeof first.field === "string" ? first.field : null,
    rule: typeof first.rule === "string" ? first.rule : null,
  };
}

/**
 * The sentence for one refusal.
 *
 * The rules are the service's own words - `services/payments/refund-fields.ts` - and each one has a sentence
 * a merchant can act on. A rule this screen has never seen falls through to the generic sentence rather than
 * being swallowed, so a later STEP that adds a refusal is visible here instead of silently reading "worked".
 */
function refusalTextOf(status: number, payload: unknown): string {
  if (status === 401) {
    return getMessage("refunds.signedOut");
  }

  const { rule } = refusalOf(payload);

  switch (rule) {
    case "amount_invalid":
      return getMessage("refunds.amountInvalid");
    case "amount_too_small":
      return getMessage("refunds.amountInvalid");
    case "reason_invalid":
      return getMessage("refunds.reasonInvalid");
    case "exceeds_refundable":
      return getMessage("refunds.exceedsRefundable");
    case "nothing_to_refund":
      return getMessage("refunds.nothingToRefund");
    case "payment_not_refundable":
      return getMessage("refunds.paymentNotRefundable");
    case "payment_not_found":
      return getMessage("refunds.paymentNotFound");
    case "refund_not_found":
      return getMessage("refunds.refundNotFound");
    case "refund_not_pending":
      return getMessage("refunds.refundNotPending");
    case "refund_self_decision":
      return getMessage("refunds.selfDecision");
    case "refund_moved":
      return getMessage("refunds.refundMoved");
    case "refund_guard":
      return getMessage("refunds.refundGuard");
    default:
      break;
  }

  if (status === 403) {
    return getMessage("refunds.roleRefusedBody");
  }

  return getMessage("refunds.errorGeneric");
}

/** The status as one phrase, for the badge on a row. */
function statusTextOf(status: string): string {
  switch (status) {
    case "approved":
      return getMessage("refunds.stateApproved");
    case "processing":
      return getMessage("refunds.stateProcessing");
    case "succeeded":
      return getMessage("refunds.stateSucceeded");
    case "failed":
      return getMessage("refunds.stateFailed");
    case "cancelled":
      return getMessage("refunds.stateCancelled");
    default:
      return getMessage("refunds.stateRequested");
  }
}

/** The instant a merchant reads, in the spelling every portal page uses. */
function instantOf(iso: string | null): string {
  if (iso === null) {
    return "";
  }

  const parsed = Date.parse(iso);

  return Number.isFinite(parsed) ? new Date(parsed).toISOString().replace("T", " ").slice(0, 16) : iso;
}

/** Read the desk. A refused read answers with what it could not build rather than throwing into a render. */
async function readDesk(): Promise<DeskState> {
  try {
    const [paymentsResponse, refundsResponse] = await Promise.all([
      fetch("/api/payments", { method: "GET", credentials: "same-origin", cache: "no-store" }),
      fetch("/api/payments/refunds", { method: "GET", credentials: "same-origin", cache: "no-store" }),
    ]);

    if (paymentsResponse.status === 401 || refundsResponse.status === 401) {
      return { payments: [], refunds: [], error: null, signedOut: true };
    }

    if (paymentsResponse.status === 403 || refundsResponse.status === 403) {
      return { payments: [], refunds: [], error: getMessage("refunds.roleRefusedBody"), signedOut: false };
    }

    if (!paymentsResponse.ok || !refundsResponse.ok) {
      return { payments: [], refunds: [], error: getMessage("refunds.errorGeneric"), signedOut: false };
    }

    const payments = (await paymentsResponse.json()) as { readonly payments?: readonly PayablePayment[] };
    const refunds = (await refundsResponse.json()) as { readonly refunds?: readonly ListedRefund[] };

    return {
      payments: payments.payments ?? [],
      refunds: refunds.refunds ?? [],
      error: null,
      signedOut: false,
    };
  } catch {
    return { payments: [], refunds: [], error: getMessage("refunds.errorGeneric"), signedOut: false };
  }
}

export function RefundConsole(): ReactNode {
  const [payments, setPayments] = useState<readonly PayablePayment[]>([]);
  const [refunds, setRefunds] = useState<readonly ListedRefund[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [signedOut, setSignedOut] = useState<boolean>(false);
  const [paymentId, setPaymentId] = useState<string>("");
  const [amount, setAmount] = useState<string>("");
  const [reason, setReason] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** The refund whose withdraw button has been pressed once, so the second press is the confirmation. */
  const [confirming, setConfirming] = useState<string | null>(null);

  function applyDesk(state: DeskState): void {
    setPayments(state.payments);
    setRefunds(state.refunds);
    setError(state.error);
    setSignedOut(state.signedOut);
    setLoading(false);

    if (state.payments.length > 0 && !state.payments.some((payment) => payment.paymentId === paymentId)) {
      setPaymentId(state.payments[0]?.paymentId ?? "");
    }
  }

  // The first read is the effect's own, declared inside it: the desk is an external system this page
  // subscribes to, and a cancelled effect must not write a stale answer over a newer one.
  useEffect(() => {
    let cancelled = false;

    async function start(): Promise<void> {
      const state = await readDesk();

      if (cancelled) {
        return;
      }

      setPayments(state.payments);
      setRefunds(state.refunds);
      setError(state.error);
      setSignedOut(state.signedOut);
      setLoading(false);

      if (state.payments.length > 0) {
        setPaymentId(state.payments[0]?.paymentId ?? "");
      }
    }

    void start();

    return () => {
      cancelled = true;
    };
  }, []);

  async function reload(): Promise<void> {
    const state = await readDesk();

    applyDesk(state);
  }

  /** Ask for a refund: the merchant's whole act on this screen. */
  async function request(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch("/api/payments/refunds", {
        method: "POST",
        headers: { "content-type": "application/json", ...(await csrfHeaders()) },
        body: JSON.stringify({ payment_id: paymentId, amount, reason }),
        credentials: "same-origin",
        cache: "no-store",
      });

      if (!response.ok) {
        const refusal: unknown = await response.json().catch(() => null);

        setError(refusalTextOf(response.status, refusal));

        return;
      }

      setAmount("");
      setReason("");
      setNotice(getMessage("refunds.requestedBody"));
      await reload();
    } catch {
      setError(getMessage("refunds.errorGeneric"));
    } finally {
      setBusy(false);
    }
  }

  /** Withdraw a request nobody has decided yet, after the merchant has pressed the confirmation. */
  async function withdraw(refundId: string): Promise<void> {
    setConfirming(null);
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch(`/api/payments/refunds/${encodeURIComponent(refundId)}/cancel`, {
        method: "POST",
        headers: { ...(await csrfHeaders()) },
        credentials: "same-origin",
        cache: "no-store",
      });

      if (!response.ok) {
        const refusal: unknown = await response.json().catch(() => null);

        setError(refusalTextOf(response.status, refusal));

        return;
      }

      setNotice(getMessage("refunds.cancelledDone"));
      await reload();
    } catch {
      setError(getMessage("refunds.errorGeneric"));
    } finally {
      setBusy(false);
    }
  }

  const selected = payments.find((payment) => payment.paymentId === paymentId) ?? null;

  return (
    <main className={pageClasses}>
      <header className="flex flex-col gap-2">
        <h1 className={titleClasses}>{getMessage("refunds.title")}</h1>
        <p className={bodyClasses}>{getMessage("refunds.description")}</p>
      </header>

      {signedOut ? (
        <p role="alert" className={errorClasses}>
          {getMessage("refunds.signedOut")}
        </p>
      ) : null}

      {error === null ? null : (
        <p role="alert" className={errorClasses}>
          {error}
        </p>
      )}

      {notice === null ? null : (
        <p role="status" className={successClasses}>
          {notice}
        </p>
      )}

      <section aria-labelledby="refund-request-heading" className={panelClasses}>
        <h2 id="refund-request-heading" className={headingClasses}>
          {getMessage("refunds.requestTitle")}
        </h2>

        {loading ? (
          <p className={bodyClasses}>{getMessage("refunds.loading")}</p>
        ) : payments.length === 0 ? (
          <p className={bodyClasses}>{getMessage("refunds.paymentEmpty")}</p>
        ) : (
          <form className="flex flex-col gap-3" onSubmit={(event) => void request(event)}>
            <label className={labelClasses}>
              {getMessage("refunds.paymentLabel")}
              <select
                className={inputClasses}
                name="payment"
                value={paymentId}
                onChange={(event) => {
                  setPaymentId(event.target.value);
                }}
                required
              >
                <option value="" disabled>
                  {getMessage("refunds.paymentPlaceholder")}
                </option>
                {payments.map((payment) => (
                  <option key={payment.paymentId} value={payment.paymentId}>
                    {`${payment.amountText} - ${instantOf(payment.capturedAt)}`}
                  </option>
                ))}
              </select>
            </label>

            <p className={noteClasses}>
              {selected === null
                ? getMessage("refunds.amountHelp")
                : `${selected.remainingText} / ${selected.amountText}`}
            </p>

            <label className={labelClasses}>
              {getMessage("refunds.amountLabel")}
              <input
                className={inputClasses}
                name="amount"
                inputMode="decimal"
                autoComplete="off"
                placeholder="25.00"
                value={amount}
                onChange={(event) => {
                  setAmount(event.target.value);
                }}
                required
              />
            </label>
            <p className={noteClasses}>{getMessage("refunds.amountHelp")}</p>

            <label className={labelClasses}>
              {getMessage("refunds.reasonLabel")}
              <textarea
                className={inputClasses}
                name="reason"
                maxLength={500}
                rows={2}
                placeholder={getMessage("refunds.reasonPlaceholder")}
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value);
                }}
                required
              />
            </label>
            <p className={noteClasses}>{getMessage("refunds.reasonHelp")}</p>

            <button type="submit" className={primaryButtonClasses} disabled={busy}>
              {busy ? getMessage("refunds.submitting") : getMessage("refunds.submit")}
            </button>
          </form>
        )}
      </section>

      <section aria-labelledby="refund-list-heading" className={panelClasses}>
        <h2 id="refund-list-heading" className={headingClasses}>
          {getMessage("refunds.listTitle")}
        </h2>

        {loading ? (
          <p className={bodyClasses}>{getMessage("refunds.loading")}</p>
        ) : refunds.length === 0 ? (
          <p className={bodyClasses}>{getMessage("refunds.listEmpty")}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {refunds.map((refund) => (
              <li key={refund.id} className={rowClasses}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium tabular-nums text-foreground">{refund.amountText}</span>
                  <span className={badgeClasses}>{statusTextOf(refund.status)}</span>
                </div>
                <p className="break-words text-foreground">{refund.reason}</p>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className={noteClasses}>
                    {getMessage("refunds.requestedAtRowLabel")} {instantOf(refund.createdAt)}
                  </span>
                  {refund.decidedAt === null ? null : (
                    <span className={noteClasses}>
                      {getMessage("refunds.decidedAtRowLabel")} {instantOf(refund.decidedAt)}
                    </span>
                  )}
                  {refund.failureDetail === null ? null : (
                    <span className={noteClasses}>{refund.failureDetail}</span>
                  )}
                </div>

                {refund.status === "requested" && confirming !== refund.id ? (
                  <button
                    type="button"
                    className={quietButtonClasses}
                    disabled={busy}
                    onClick={() => {
                      setConfirming(refund.id);
                    }}
                  >
                    {getMessage("refunds.cancel")}
                  </button>
                ) : null}

                {refund.status === "requested" && confirming === refund.id ? (
                  <span className="flex flex-wrap items-center gap-2">
                    <span className={noteClasses}>{getMessage("refunds.cancelConfirm")}</span>
                    <button
                      type="button"
                      className={quietButtonClasses}
                      disabled={busy}
                      onClick={() => void withdraw(refund.id)}
                    >
                      {getMessage("refunds.cancel")}
                    </button>
                    <button
                      type="button"
                      className={quietButtonClasses}
                      disabled={busy}
                      onClick={() => {
                        setConfirming(null);
                      }}
                    >
                      {getMessage("refunds.cancelKeep")}
                    </button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        <p className={noteClasses}>{getMessage("refunds.statusHelp")}</p>
      </section>
    </main>
  );
}
