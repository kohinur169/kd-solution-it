// path: app/(admin)/office/refunds/fees/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { AppError } from "@/lib/errors/app-error";
import { getMessage } from "@/lib/i18n/messages";
import {
  readRefundFeeBacklog,
  readRefundFeeRule,
  type RefundFeeRuleView,
} from "@/services/payments/refund-fee";
import { getRefundFeeRuntime } from "@/services/payments/refund-fee-runtime";
import { readOfficeActor } from "../../../office-actor";
import { RefundFeeRuleForm, RefundFeeSweepForm } from "./refund-fee-form";

export const metadata: Metadata = {
  title: getMessage("refundFees.screenTitle"),
  description: getMessage("refundFees.screenDescription"),
};

/** Read per request: a switch that changes what money does is never cached. */
export const dynamic = "force-dynamic";

/**
 * Section 18's one sentence, at `/office/refunds/fees`: whether the platform fee is returned on a refund.
 *
 * ## What the screen is for
 *
 * A refund sends the payer's money back. The platform's own fee on that money is a separate question, and one
 * person answers it for the whole platform: the super administrator. This page is where the answer is written,
 * and where the desk reads what it means - not a settings form among dozens, but one decision with its
 * consequence written beside it, because the consequence is money on every refund the platform processes.
 *
 * ## Why the desk sees what only the super administrator may change
 *
 * The refund desk works the queue and needs to know which answer is in force; the switch itself is section 18's
 * and belongs to one role. So the state is printed for both, the form only for the role that may save it
 * (`canEdit` from the service), and a pass can be run by either: applying an answer that already exists is the
 * desk's work, giving the answer is not.
 *
 * ## Why the screen says what it cannot do
 *
 * `ledger: "absent"` is this build's truth: the return is recorded on the refund and in the signed chain, and
 * the balanced ledger pair is posted when a deployment supplies a store. The page says so rather than printing a
 * reassurance the code cannot keep, because an officer who believes a pair exists will not look for it.
 */
type FeeState =
  | { readonly kind: "signed-out" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "unavailable" }
  | {
      readonly kind: "ready";
      readonly rule: RefundFeeRuleView;
      readonly pending: number;
      readonly capped: boolean;
    };

async function readFeeState(): Promise<FeeState> {
  const actorState = await readOfficeActor();

  if (actorState.kind === "anonymous") {
    return { kind: "signed-out" };
  }

  if (actorState.kind !== "actor") {
    return { kind: "unavailable" };
  }

  try {
    const dependencies = getRefundFeeRuntime();
    // The service applies the screen's role list and throws `PERMISSION_DENIED` for anybody else, so the page
    // names no role of its own: one list, in one place, and the refusal mapped below.
    const rule = await readRefundFeeRule({ actor: actorState.actor }, dependencies);
    const backlog = await readRefundFeeBacklog(dependencies);

    return { kind: "ready", rule, pending: backlog.pending, capped: backlog.capped };
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

const cardClasses =
  "flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 text-foreground shadow-card";

const badgeClasses =
  "inline-flex w-fit rounded-full border border-border bg-muted/40 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide";

const alertClasses = "text-sm text-destructive";

const linkClasses = "w-fit text-sm font-medium text-primary underline-offset-4 hover:underline";

/** One instant, printed the way every office screen prints one: UTC, minute precision. */
function formatInstant(iso: string | null): string {
  if (iso === null) {
    return getMessage("refundFees.updatedNever");
  }

  const parsed = Date.parse(iso);

  return Number.isFinite(parsed)
    ? `${new Date(parsed).toISOString().slice(0, 16).replace("T", " ")} UTC`
    : iso;
}

export default async function RefundFeeRulePage(): Promise<ReactNode> {
  const state = await readFeeState();

  return (
    <main className={pageClasses}>
      <header className={headerClasses}>
        <p className={eyebrowClasses}>{getMessage("refunds.title")}</p>
        <h1 className={titleClasses}>{getMessage("refundFees.screenTitle")}</h1>
        <p className={descriptionClasses}>{getMessage("refundFees.screenDescription")}</p>
        <Link className={linkClasses} href="/office/refunds">
          {getMessage("refundFees.backToQueue")}
        </Link>
      </header>

      {state.kind === "signed-out" ? (
        <p className={alertClasses}>{getMessage("refunds.signedOut")}</p>
      ) : state.kind === "forbidden" ? (
        <p className={alertClasses}>{getMessage("refunds.officeRoleRefusedBody")}</p>
      ) : state.kind === "unavailable" ? (
        <p className={alertClasses}>{getMessage("refunds.failed")}</p>
      ) : (
        <>
          <section aria-labelledby="refund-fee-rule-heading" className={sectionClasses}>
            <h2 id="refund-fee-rule-heading" className={headingClasses}>
              {getMessage("refundFees.ruleHeading")}
            </h2>

            <div className={cardClasses}>
              <span className={badgeClasses}>
                {state.rule.returned
                  ? getMessage("refundFees.stateReturned")
                  : getMessage("refundFees.stateRetained")}
              </span>
              <p className={bodyClasses}>{getMessage("refundFees.stateHelp")}</p>
              <p className={bodyClasses}>
                {`${getMessage("refundFees.updatedLabel")} ${formatInstant(state.rule.updatedAt)}`}
              </p>
              {state.rule.isSet ? null : (
                <p className={bodyClasses}>{getMessage("refundFees.defaultNote")}</p>
              )}

              {state.rule.canEdit ? (
                <RefundFeeRuleForm
                  returned={state.rule.returned}
                  savedAt={state.rule.updatedAt}
                />
              ) : (
                <p className={bodyClasses}>{getMessage("refundFees.readOnlyNote")}</p>
              )}
            </div>

            <p className={bodyClasses}>{getMessage("refundFees.prorationHelp")}</p>
          </section>

          <section aria-labelledby="refund-fee-pass-heading" className={sectionClasses}>
            <h2 id="refund-fee-pass-heading" className={headingClasses}>
              {getMessage("refundFees.passHeading")}
            </h2>

            <div className={cardClasses}>
              <p className="text-sm font-medium text-foreground">
                {state.pending === 0
                  ? getMessage("refundFees.backlogNone")
                  : `${getMessage("refundFees.backlogLabel")} ${String(state.pending)}`}
              </p>
              {state.capped ? <p className={bodyClasses}>{getMessage("refundFees.backlogCapped")}</p> : null}
              <p className={bodyClasses}>{getMessage("refundFees.passHelp")}</p>
              <p className={bodyClasses}>{getMessage("refundFees.ledgerAbsentNote")}</p>
              <RefundFeeSweepForm />
            </div>
          </section>
        </>
      )}
    </main>
  );
}
