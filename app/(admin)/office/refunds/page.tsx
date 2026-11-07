// path: app/(admin)/office/refunds/page.tsx
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppError } from "@/lib/errors/app-error";
import { getMessage } from "@/lib/i18n/messages";
import { listRefundQueue } from "@/services/payments/refund";
import { getRefundRuntime } from "@/services/payments/refund-runtime";
import { readOfficeActor } from "../../office-actor";
import { RefundDecisionForm } from "./refund-decision-form";
import { RefundExecutionForm } from "./refund-execution-form";

export const metadata: Metadata = {
  title: getMessage("refunds.queueTitle"),
  description: getMessage("refunds.queueDescription"),
};

/** Read per request: the queue is money waiting on a person, so it is never cached. */
export const dynamic = "force-dynamic";

/**
 * The finance desk's refund queue, at `/office/refunds`, and the two acts the desk performs on it.
 *
 * ## What an officer needs, in the order they need it
 *
 * Every refund still waiting for a person, oldest first - a queue, not a report - with the amount, the
 * merchant's reason and the two instants that make the row auditable. A row carries the decision form only
 * while it is still `requested`; an `approved` or `processing` row is shown without one, because the act now
 * belongs to the module that executes it (STEP 192), and offering a button the service would refuse is how a
 * screen teaches people to distrust it.
 *
 * ## Why the page refuses before it renders
 *
 * An `approved` row carries the button that sends it back through the provider that took the payment (STEP
 * 192, `refund-execution-form.tsx`); a `requested` one carries the decision. The two forms are separate because
 * the two acts are: approving promises the money, executing moves it, and only the second can be declined by a
 * provider seconds later.
 *
 * `listRefundQueue` requires `finance_ops` or `super_admin` and throws `PERMISSION_DENIED` for anybody else.
 * The page asks the same function and maps its refusal to a sentence, so an account that reaches this URL
 * without the role reads "only the finance desk decides refunds" rather than an empty queue that looks like
 * "nothing to do".
 *
 * ## What is not here
 *
 * The platform fee on a refund, which is STEP 193's setting and leaves `platform_fee_returned` false and
 * `platform_fee_returned_minor` zero. Nor a retry of a call the provider never answered: that row stays
 * `processing` and belongs to the reconciliation the desk does by hand until a later STEP automates it.
 */
type QueueState =
  | { readonly kind: "signed-out" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "ready"; readonly refunds: Awaited<ReturnType<typeof listRefundQueue>> };

async function readQueueState(): Promise<QueueState> {
  const actorState = await readOfficeActor();

  if (actorState.kind === "anonymous") {
    return { kind: "signed-out" };
  }

  if (actorState.kind !== "actor") {
    return { kind: "unavailable" };
  }

  try {
    const refunds = await listRefundQueue({ actor: actorState.actor }, getRefundRuntime());

    return { kind: "ready", refunds };
  } catch (error) {
    if (error instanceof AppError) {
      if (error.code === "AUTHENTICATION_REQUIRED") {
        return { kind: "signed-out" };
      }

      if (error.code === "PERMISSION_DENIED") {
        return { kind: "forbidden" };
      }
    }

    return { kind: "unavailable" };
  }
}

const pageClasses = "flex flex-col gap-8";

const headerClasses = "flex flex-col gap-2";

const eyebrowClasses = "text-xs font-semibold uppercase tracking-widest text-muted-foreground";

const titleClasses = "text-2xl font-semibold tracking-tight sm:text-3xl";

const descriptionClasses = "max-w-3xl text-sm text-muted-foreground sm:text-base";

const sectionClasses = "flex flex-col gap-3 border-t border-border pt-6";

const headingClasses = "text-lg font-semibold tracking-tight";

const bodyClasses = "text-sm text-muted-foreground";

const listClasses = "flex flex-col gap-3";

const cardClasses =
  "flex flex-col gap-2 rounded-lg border border-border bg-surface p-4 text-foreground shadow-card";

const rowHeaderClasses = "flex flex-wrap items-center gap-x-3 gap-y-1";

const badgeClasses =
  "rounded-full border border-border bg-muted/40 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide";

const noteClasses =
  "mt-1 whitespace-nowrap rounded-lg border border-border bg-background px-2 py-1 text-xs tabular-nums";

const reasonClasses =
  "whitespace-pre-wrap break-words rounded-lg border border-border bg-background p-3 text-sm";

const alertClasses = "text-sm text-destructive";

/** One instant, printed the way every office screen prints one: UTC, minute precision. */
function formatInstant(iso: string | null): string {
  if (iso === null) {
    return "-";
  }

  const parsed = Date.parse(iso);

  return Number.isFinite(parsed)
    ? `${new Date(parsed).toISOString().slice(0, 16).replace("T", " ")} UTC`
    : iso;
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

export default async function RefundQueuePage(): Promise<ReactNode> {
  const state = await readQueueState();

  return (
    <main className={pageClasses}>
      <header className={headerClasses}>
        <p className={eyebrowClasses}>{getMessage("refunds.title")}</p>
        <h1 className={titleClasses}>{getMessage("refunds.queueTitle")}</h1>
        <p className={descriptionClasses}>{getMessage("refunds.queueDescription")}</p>
      </header>

      {state.kind === "signed-out" ? (
        <p className={alertClasses}>{getMessage("refunds.signedOut")}</p>
      ) : state.kind === "forbidden" ? (
        <p className={alertClasses}>{getMessage("refunds.officeRoleRefusedBody")}</p>
      ) : state.kind === "unavailable" ? (
        <p className={alertClasses}>{getMessage("refunds.failed")}</p>
      ) : (
        <section aria-labelledby="refund-queue-heading" className={sectionClasses}>
          <h2 id="refund-queue-heading" className={headingClasses}>
            {getMessage("refunds.queueTitle")}
          </h2>

          {state.refunds.length === 0 ? (
            <p className={bodyClasses}>{getMessage("refunds.queueEmpty")}</p>
          ) : (
            <ul className={listClasses}>
              {state.refunds.map((refund) => (
                <li key={refund.id} className={cardClasses}>
                  <div className={rowHeaderClasses}>
                    <span className={badgeClasses}>{statusTextOf(refund.status)}</span>
                    <span className="text-sm font-semibold tabular-nums text-foreground">
                      {refund.amountText}
                    </span>
                    <span className={noteClasses}>{refund.id}</span>
                  </div>

                  <dl className="grid grid-cols-1 gap-1 text-sm sm:grid-cols-[12rem_1fr]">
                    <dt className={bodyClasses}>{getMessage("refunds.requesterLabel")}</dt>
                    <dd className="text-xs sm:text-sm">{refund.requestedBy}</dd>
                    <dt className={bodyClasses}>{getMessage("refunds.requestedAtRowLabel")}</dt>
                    <dd className="text-xs sm:text-sm">{formatInstant(refund.createdAt)}</dd>
                    <dt className={bodyClasses}>{getMessage("refunds.decidedAtRowLabel")}</dt>
                    <dd className="text-xs sm:text-sm">{formatInstant(refund.decidedAt)}</dd>
                    <dt className={bodyClasses}>{getMessage("refunds.amountRowLabel")}</dt>
                    <dd className="text-xs sm:text-sm">{refund.amountText}</dd>
                  </dl>

                  <div>
                    <p className="text-sm font-medium text-foreground">{getMessage("refunds.reasonRowLabel")}</p>
                    <p className={reasonClasses}>{refund.reason}</p>
                  </div>

                  {refund.processedAt === null ? null : (
                    <p className={bodyClasses}>
                      {`${getMessage("refunds.processedRowLabel")} ${formatInstant(refund.processedAt)}`}
                    </p>
                  )}

                  {refund.providerRefundId === null ? null : (
                    <p className={bodyClasses}>
                      {`${getMessage("refunds.providerReferenceLabel")} `}
                      <span className="tabular-nums text-foreground">{refund.providerRefundId}</span>
                    </p>
                  )}

                  {refund.failureDetail === null ? null : (
                    <div>
                      <p className="text-sm font-medium text-foreground">
                        {getMessage("refunds.failureRowLabel")}
                      </p>
                      <p className={reasonClasses}>{refund.failureDetail}</p>
                    </div>
                  )}

                  {refund.status === "requested" ? <RefundDecisionForm refundId={refund.id} /> : null}

                  {refund.status === "approved" ? <RefundExecutionForm refundId={refund.id} /> : null}
                </li>
              ))}
            </ul>
          )}

          <p className={bodyClasses}>{getMessage("refunds.statusHelp")}</p>
        </section>
      )}
    </main>
  );
}
