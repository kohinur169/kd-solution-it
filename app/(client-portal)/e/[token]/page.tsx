// path: app/(client-portal)/e/[token]/page.tsx
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { EstimateDecisionCard } from "../../../../components/payments/estimate-decision-card.tsx";
import { isAppError } from "../../../../lib/errors/app-error.ts";
import { formatMessage, getMessage } from "../../../../lib/i18n/messages.ts";
import { portalMoneyTextOf } from "../../portal-invoice-money.ts";
import { applyPortalEstimateExpiry, applyPortalEstimateView } from "../../portal-estimate-decision.ts";
import type { PortalEstimateState } from "../../portal-estimate-fields.ts";
import { openPortalEstimate, type PortalEstimateView } from "../../portal-estimate.ts";
import { getPortalInvoiceRuntime } from "../../portal-invoice-runtime.ts";

/**
 * The tokenized estimate page of section 16.
 *
 * ## The link is the access
 *
 * A client opens a link from an email or a chat window and reads the offer, its lifetime and its state.
 * There is no sign in and no account: `openPortalToken` has already verified the signature, the clock,
 * the kind and the capability before a single row is read, and every read below is scoped by the claim's
 * company as well as its estimate.
 *
 * ## The three writes this page may make, and why a read can write
 *
 *   - **Expiry.** A quote past `expires_at` is voided as the page is opened, with `void_reason =
 *     'expired'`. Section 16 says an estimate expires at its expiry time, and a link that showed an
 *     expired offer as if it were open would invite a decision the database would then refuse.
 *   - **Viewed.** A `sent` quote becomes `viewed`, which is the one signal a quote link gives a merchant
 *     that an invoice link cannot: the client has seen the offer.
 *   - Nothing else. The decision itself is the client's to make, and it arrives through the form on this
 *     page and the route behind it.
 *
 * Both writes are tolerant by design: a page that cannot record a view must still render, because the
 * client came to read an offer rather than to update a status. The decision is never tolerant.
 *
 * ## The states the page renders
 *
 * A link that does not verify is one card saying so, with the same sentence for an expired token, a
 * revoked one and one that never existed. A draft says "not ready yet" and shows no money, because a
 * draft is a working copy. Everything else - open, accepted, declined, expired, withdrawn - shows the
 * document as it stood and the decision card that explains its state.
 *
 * ## Why the page is not statically rendered
 *
 * `force-dynamic` is the feature, not a performance choice: the page's whole job is to say what the offer
 * is *now*. A cached page would show an offer whose lifetime had passed as open, and would offer a
 * signature the database would refuse.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: getMessage("portal.estimateEyebrow"),
  description: getMessage("portal.estimateMetaDescription"),
  robots: { index: false, follow: false, nocache: true },
};

const pageClasses = "mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6 sm:gap-6 sm:px-6 sm:py-10";

const cardClasses =
  "flex flex-col gap-4 rounded-lg border border-border bg-surface p-4 text-foreground shadow-card sm:p-6";

const headingClasses = "text-sm font-semibold tracking-tight text-foreground";

const eyebrowClasses = "text-xs font-medium uppercase tracking-wide text-muted-foreground";

const titleClasses = "text-xl font-semibold tracking-tight text-foreground sm:text-2xl";

const bodyClasses = "text-sm text-muted-foreground";

const noteClasses = "text-xs text-muted-foreground";

const pillBaseClasses =
  "inline-flex w-fit items-center rounded-full border px-3 py-1 text-xs font-medium";

const tableClasses = "hidden w-full border-collapse text-sm sm:table";

const headCellClasses =
  "border-b border-border pb-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground";

const headNumberClasses =
  "border-b border-border pb-2 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground";

const cellClasses = "border-b border-border py-2 text-left align-top";

const numberCellClasses = "border-b border-border py-2 text-right align-top tabular-nums";

const lineCardClasses = "flex flex-col gap-1 rounded-md border border-border p-3 sm:hidden";

const totalsClasses = "flex flex-col gap-1 text-sm";

const totalRowClasses = "flex items-center justify-between gap-3";

const totalLabelClasses = "text-muted-foreground";

const totalValueClasses = "font-medium tabular-nums";

const noticeClasses = "flex flex-col gap-2 rounded-lg border border-border p-4";

const noticeTitleClasses = "text-base font-semibold";

/** One instant, UTC, minutes: the print every record on this page uses. */
function instantOf(iso: string): string {
  const parsed = Date.parse(iso);

  return Number.isFinite(parsed) ? new Date(parsed).toISOString().replace("T", " ").slice(0, 16) : iso;
}

/** The pill class and sentence for one state: one state, one word, in the catalog's own words. */
function statePillOf(state: PortalEstimateState): { readonly classes: string; readonly text: string } {
  switch (state) {
    case "accepted":
      return { classes: "border-success text-success", text: getMessage("portal.estimateStateAccepted") };
    case "declined":
      return {
        classes: "border-destructive text-destructive",
        text: getMessage("portal.estimateStateDeclined"),
      };
    case "expired":
      return { classes: "border-warning text-warning", text: getMessage("portal.estimateStateExpired") };
    case "withdrawn":
      return {
        classes: "border-destructive text-destructive",
        text: getMessage("portal.estimateStateWithdrawn"),
      };
    case "not_issued":
      return {
        classes: "border-border text-muted-foreground",
        text: getMessage("portal.estimateStateNotIssued"),
      };
    case "open":
      return { classes: "border-border text-muted-foreground", text: getMessage("portal.estimateStateOpen") };
  }
}

/** The document: what is offered, line by line, and what it comes to. */
function EstimateDocument({ view }: { readonly view: PortalEstimateView }): ReactNode {
  const estimate = view.estimate;

  return (
    <section aria-labelledby="portal-estimate-document-heading" className={cardClasses}>
      <h2 id="portal-estimate-document-heading" className={headingClasses}>
        {getMessage("portal.estimateOfferSection")}
      </h2>

      <table className={tableClasses}>
        <thead>
          <tr>
            <th scope="col" className={headCellClasses}>
              {getMessage("portal.descriptionLabel")}
            </th>
            <th scope="col" className={headNumberClasses}>
              {getMessage("portal.quantityLabel")}
            </th>
            <th scope="col" className={headNumberClasses}>
              {getMessage("portal.unitPriceLabel")}
            </th>
            <th scope="col" className={headNumberClasses}>
              {getMessage("portal.amountLabel")}
            </th>
          </tr>
        </thead>
        <tbody>
          {estimate.lines.map((line) => (
            <tr key={line.id}>
              <td className={cellClasses}>{line.description}</td>
              <td className={numberCellClasses}>
                {line.quantity} {line.unit}
              </td>
              <td className={numberCellClasses}>
                {portalMoneyTextOf(estimate.currency, line.unitPriceMinor)}
              </td>
              <td className={numberCellClasses}>
                {portalMoneyTextOf(estimate.currency, line.lineTotalMinor)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <ul className="flex flex-col gap-2 sm:hidden">
        {estimate.lines.map((line) => (
          <li key={line.id} className={lineCardClasses}>
            <span className="text-sm font-medium">{line.description}</span>
            <span className={noteClasses}>
              {line.quantity} {line.unit}
            </span>
            <span className="text-sm tabular-nums">
              {portalMoneyTextOf(estimate.currency, line.lineTotalMinor)}
            </span>
          </li>
        ))}
      </ul>

      <div className={totalsClasses}>
        <div className={totalRowClasses}>
          <span className={totalLabelClasses}>{getMessage("portal.subtotalLabel")}</span>
          <span className={totalValueClasses}>
            {portalMoneyTextOf(estimate.currency, estimate.totals.subtotalMinor)}
          </span>
        </div>
        {estimate.totals.discountMinor === "0" ? null : (
          <div className={totalRowClasses}>
            <span className={totalLabelClasses}>{getMessage("portal.discountLabel")}</span>
            <span className={totalValueClasses}>
              {portalMoneyTextOf(estimate.currency, estimate.totals.discountMinor)}
            </span>
          </div>
        )}
        {estimate.totals.taxMinor === "0" ? null : (
          <div className={totalRowClasses}>
            <span className={totalLabelClasses}>{getMessage("portal.taxLabel")}</span>
            <span className={totalValueClasses}>
              {portalMoneyTextOf(estimate.currency, estimate.totals.taxMinor)}
            </span>
          </div>
        )}
        <div className={totalRowClasses}>
          <span className="font-medium">{getMessage("portal.totalLabel")}</span>
          <span className={`${totalValueClasses} text-base`}>
            {portalMoneyTextOf(estimate.currency, estimate.totals.totalMinor)}
          </span>
        </div>
      </div>

      {estimate.memo === null ? null : <p className={bodyClasses}>{estimate.memo}</p>}
    </section>
  );
}

/** The card a link that does not verify is answered with, which is one sentence for every cause. */
function UnopenableLink(): ReactNode {
  return (
    <main className={pageClasses}>
      <div className={noticeClasses}>
        <p className={noticeTitleClasses}>{getMessage("portal.linkInvalidTitle")}</p>
        <p className={bodyClasses}>{getMessage("portal.linkInvalidBody")}</p>
      </div>
    </main>
  );
}

export default async function PortalEstimatePage({
  params,
}: {
  readonly params: Promise<{ readonly token: string }>;
}): Promise<ReactNode> {
  const { token } = await params;

  let decoded: string;

  try {
    decoded = decodeURIComponent(token);
  } catch {
    return <UnopenableLink />;
  }

  const runtime = getPortalInvoiceRuntime();

  let view: PortalEstimateView;

  try {
    view = await openPortalEstimate({ token: decoded }, runtime);
  } catch (error) {
    if (isAppError(error) && error.code === "RESOURCE_NOT_FOUND") {
      return <UnopenableLink />;
    }

    throw error;
  }

  if (view.state === "not_issued") {
    return (
      <main className={pageClasses}>
        <div className={noticeClasses}>
          <p className={noticeTitleClasses}>{getMessage("portal.estimateNotIssuedTitle")}</p>
          <p className={bodyClasses}>{getMessage("portal.estimateNotIssuedBody")}</p>
        </div>
      </main>
    );
  }

  // Expiry first, then the view: a quote whose lifetime passed is voided rather than marked as viewed, and
  // a quote that is still open records that somebody looked at it.
  try {
    view = await applyPortalEstimateExpiry({ token: decoded, view }, runtime);

    if (view.state === "open") {
      await applyPortalEstimateView(view, runtime);
    }
  } catch (error) {
    // A page that cannot record its own bookkeeping still renders: the client came for the offer, and the
    // decision itself is the only write that must not be tolerated. A link that stopped verifying between
    // the two reads is the one exception, because there is nothing left to show.
    if (isAppError(error) && error.code === "RESOURCE_NOT_FOUND") {
      return <UnopenableLink />;
    }
  }

  const pill = statePillOf(view.state);

  return (
    <main className={pageClasses}>
      <header className="flex flex-col gap-2">
        <span className={eyebrowClasses}>{getMessage("portal.estimateEyebrow")}</span>
        <h1 className={titleClasses}>
          {view.estimate.number === null ? getMessage("portal.estimateSection") : view.estimate.number}
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`${pillBaseClasses} ${pill.classes}`}>{pill.text}</span>
          {view.estimate.issuedAt === null ? null : (
            <span className={noteClasses}>
              {formatMessage("portal.estimateIssuedOn", { date: instantOf(view.estimate.issuedAt) })}
            </span>
          )}
          <span className={noteClasses}>
            {formatMessage("portal.estimateExpiresOn", { date: instantOf(view.estimate.expiresAt) })}
          </span>
        </div>
      </header>

      <section aria-labelledby="portal-estimate-client-heading" className={cardClasses}>
        <h2 id="portal-estimate-client-heading" className={headingClasses}>
          {getMessage("portal.estimateClientSection")}
        </h2>
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium">{view.estimate.client.name}</span>
          {view.estimate.client.email === null ? null : (
            <span className={bodyClasses}>{view.estimate.client.email}</span>
          )}
          {view.estimate.client.address === null ? null : (
            <span className={`${bodyClasses} whitespace-pre-line`}>{view.estimate.client.address}</span>
          )}
        </div>
      </section>

      <EstimateDocument view={view} />

      <EstimateDecisionCard view={view} token={decoded} />

      <p className={noteClasses}>{getMessage("portal.estimatePrivacyNote")}</p>
    </main>
  );
}
