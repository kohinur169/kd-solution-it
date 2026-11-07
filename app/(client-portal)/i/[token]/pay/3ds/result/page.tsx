// path: app/(client-portal)/i/[token]/pay/3ds/result/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { isAppError } from "../../../../../../../lib/errors/app-error.ts";
import { formatMessage, getMessage } from "../../../../../../../lib/i18n/messages.ts";
import { openPortalInvoice, type PortalInvoiceView } from "../../../../../portal-invoice.ts";
import { portalMoneyTextOf } from "../../../../../portal-invoice-money.ts";
import { getPortalInvoiceRuntime } from "../../../../../portal-invoice-runtime.ts";
import {
  isPortalThreeDsResultState,
  type PortalThreeDsResultState,
} from "../../../../../portal-three-ds-fields.ts";

/**
 * Where the payer lands after their bank, and what they are told.
 *
 * ## Why this is a page and not the route's body
 *
 * The issuer posts to the completion route, and that route has already done its work by the time the browser
 * renders anything. A JSON envelope there would be a blank screen with braces on it at the end of a bank's
 * flow, so the route redirects here and this page says what happened, in the portal's own words.
 *
 * ## What in this page can be trusted
 *
 * The state in the query chooses the sentence. Nothing else in the page comes from the query: the client, the
 * invoice number and the amount are read from the invoice by this request, under the link's own token, so a
 * payer who edits `?state=` changes what they read and never what they owe. An invented state gets the
 * generic answer.
 *
 * ## Why the page is not cached
 *
 * `force-dynamic` for the same reason the payment page has it: what a link owes now is the only thing that
 * makes an answer true. A cached "payment received" on an invoice that has since been voided would be the
 * page lying to the person who needs it most.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: getMessage("portal.paymentThreeDsEyebrow"),
  description: getMessage("portal.paymentThreeDsResultMetaDescription"),
  robots: { index: false, follow: false, nocache: true },
};

const pageClasses = "mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-6 sm:gap-6 sm:px-6 sm:py-10";

const cardClasses =
  "flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 text-foreground shadow-card sm:p-6";

const eyebrowClasses = "text-xs font-medium uppercase tracking-wide text-muted-foreground";

const titleClasses = "text-xl font-semibold tracking-tight text-foreground sm:text-2xl";

const headingClasses = "text-base font-semibold tracking-tight text-foreground";

const bodyClasses = "text-sm text-muted-foreground";

const noteClasses = "text-xs text-muted-foreground";

const amountClasses = "text-2xl font-semibold tabular-nums text-foreground";

const linkClasses = "text-sm font-medium text-primary underline underline-offset-2";

/** The words of one state, all from the message catalogue so a second locale is a translation and not a fork. */
function copyOf(state: PortalThreeDsResultState): { readonly title: string; readonly body: string } {
  switch (state) {
    case "captured":
      return {
        title: getMessage("portal.paymentCapturedTitle"),
        body: getMessage("portal.paymentThreeDsCapturedBody"),
      };
    case "review":
      return {
        title: getMessage("portal.paymentThreeDsReviewTitle"),
        body: getMessage("portal.paymentThreeDsReviewBody"),
      };
    case "declined":
      return {
        title: getMessage("portal.paymentThreeDsDeclinedTitle"),
        body: getMessage("portal.paymentThreeDsDeclinedBody"),
      };
    case "unknown":
      return {
        title: getMessage("portal.paymentThreeDsUnknownTitle"),
        body: getMessage("portal.paymentThreeDsUnknownBody"),
      };
    default:
      return {
        title: getMessage("portal.paymentThreeDsExpiredTitle"),
        body: getMessage("portal.paymentThreeDsExpiredBody"),
      };
  }
}

export default async function PortalThreeDsResultPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly token: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const { token } = await params;
  const query = await searchParams;

  let decoded: string;

  try {
    decoded = decodeURIComponent(token);
  } catch {
    return (
      <main className={pageClasses}>
        <div className={cardClasses}>
          <h1 className={headingClasses}>{getMessage("portal.linkInvalidTitle")}</h1>
          <p className={bodyClasses}>{getMessage("portal.linkInvalidBody")}</p>
        </div>
      </main>
    );
  }

  const requested = query["state"];
  const state: PortalThreeDsResultState = isPortalThreeDsResultState(requested) ? requested : "expired";
  const copy = copyOf(state);

  let view: PortalInvoiceView | null = null;

  try {
    view = await openPortalInvoice({ token: decoded }, getPortalInvoiceRuntime());
  } catch (error) {
    if (!isAppError(error) || error.code !== "RESOURCE_NOT_FOUND") {
      view = null;
    }
  }

  const amount =
    view === null ? null : portalMoneyTextOf(view.currency, view.totals.remainingMinor);

  return (
    <main className={pageClasses}>
      <header className="flex flex-col gap-2">
        <span className={eyebrowClasses}>{getMessage("portal.paymentThreeDsEyebrow")}</span>
        <h1 className={titleClasses}>{copy.title}</h1>
        {view === null ? null : <span className={noteClasses}>{view.number ?? view.clientName}</span>}
      </header>

      <section className={cardClasses}>
        <p className={bodyClasses}>{copy.body}</p>
        {amount === null ? null : (
          <>
            <p className={noteClasses}>{getMessage("portal.paymentThreeDsAmountTitle")}</p>
            <p className={amountClasses}>{amount}</p>
            <p className={hintOf(state)}>
              {formatMessage("portal.paymentThreeDsAmountNote", { amount })}
            </p>
          </>
        )}
      </section>

      <p className={noteClasses}>
        <Link href={`/i/${encodeURIComponent(decoded)}`} className={linkClasses}>
          {getMessage("portal.paymentBackToInvoice")}
        </Link>
      </p>
    </main>
  );
}

/** One line under the amount, so the figure is read as what the invoice still owes rather than a receipt. */
function hintOf(state: PortalThreeDsResultState): string {
  return state === "captured"
    ? getMessage("portal.paymentThreeDsCapturedAmountNote")
    : getMessage("portal.paymentThreeDsRemainingAmountNote");
}
