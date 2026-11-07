// path: app/(client-portal)/i/[token]/page.tsx
import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import type { ReactNode } from "react";
import { InvoiceAcceptanceCard } from "../../../../components/payments/invoice-acceptance-card.tsx";
import { InvoiceFulfilmentCard } from "../../../../components/payments/invoice-fulfilment-card.tsx";
import { InvoicePaidState } from "../../../../components/payments/invoice-paid-state.tsx";
import { getMessage, formatMessage } from "../../../../lib/i18n/messages.ts";
import { isAppError } from "../../../../lib/errors/app-error.ts";
import { hasRole } from "../../../../lib/auth/session.ts";
import { openPortalInvoice, type PortalInvoiceView } from "../../portal-invoice.ts";
import { portalMoneyTextOf } from "../../portal-invoice-money.ts";
import {
  getPortalInvoiceRuntime,
  readRequestActorOptionally,
} from "../../portal-invoice-runtime.ts";

/**
 * The tokenized invoice page of section 16.
 *
 * ## What a visitor gets, and what they do not need
 *
 * A buyer opens a link from an email or a chat window and reads the document, its paid state and its
 * receipt. There is no sign in, no account and no form to fill before the document is visible: the link is
 * the access, which is what "tokenized" means here, and `openPortalToken` has already checked the
 * signature, the expiry and the claim before a single row is read.
 *
 * ## The five states the page renders
 *
 *   - a link that does not verify is one card saying the link cannot be opened, with the same sentence
 *     for an expired token, a revoked one and one that never existed;
 *   - a draft is "not ready yet" and shows no money at all, because a draft is a working copy;
 *   - a cancelled invoice says so, and shows what it was, because a buyer holding the link deserves the
 *     record rather than an error;
 *   - an open or partly paid invoice shows what is still due and the floor a partial payment is held to;
 *   - a paid invoice shows the paid state and the receipt, and says the link no longer takes payment.
 *
 * ## Why the page is not statically rendered
 *
 * `force-dynamic` is not a performance choice, it is the feature: the whole point of the page is that it
 * shows the state of the money *now*. A cached page would show yesterday's balance, and a link that
 * claimed to accept a payment it had already taken is the one mistake this page must not make.
 *
 * ## The merchant panel
 *
 * The invoice's own account sees one extra card, and a buyer sees nothing of it: the panel renders only
 * when a session resolves to the invoice's company and the `owner` role. The route behind it checks both
 * again, so the panel is a convenience rather than a permission.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: getMessage("portal.eyebrow"),
  description: getMessage("portal.metaDescription"),
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

const dueCardClasses = "flex flex-col gap-2 rounded-lg border border-primary p-4";

const dueTitleClasses = "text-sm font-medium text-muted-foreground";

const dueAmountClasses = "text-2xl font-semibold tabular-nums text-foreground";

const noticeClasses = "flex flex-col gap-2 rounded-lg border border-border p-4";

const noticeTitleClasses = "text-base font-semibold";

/** One instant, UTC, minutes: the print every record on this page uses. */
function instantOf(iso: string | null): string {
  if (iso === null) {
    return "";
  }

  const parsed = Date.parse(iso);

  return Number.isFinite(parsed) ? new Date(parsed).toISOString().replace("T", " ").slice(0, 16) : iso;
}

/** True when an open invoice is past its due date, which is the one thing a buyer should not miss. */
function isOverdue(view: PortalInvoiceView): boolean {
  if (view.state !== "open") {
    return false;
  }

  const due = Date.parse(view.dueAt);

  return Number.isFinite(due) && due < Date.now();
}

/** The state line: one pill, one word, in the catalog's own words. */
function StatePill({ view }: { readonly view: PortalInvoiceView }): ReactNode {
  if (view.state === "paid") {
    return (
      <span className={`${pillBaseClasses} border-success text-success`}>
        {getMessage("portal.paidTitle")}
      </span>
    );
  }

  if (view.state === "void") {
    return (
      <span className={`${pillBaseClasses} border-destructive text-destructive`}>
        {getMessage("portal.voidTitle")}
      </span>
    );
  }

  if (view.state === "partially_paid") {
    return (
      <span className={`${pillBaseClasses} border-warning text-warning`}>
        {getMessage("portal.remainingLabel")}{" "}
        {portalMoneyTextOf(view.currency, view.totals.remainingMinor)}
      </span>
    );
  }

  if (view.state === "not_issued") {
    return (
      <span className={`${pillBaseClasses} border-border text-muted-foreground`}>
        {getMessage("portal.notIssuedTitle")}
      </span>
    );
  }

  return (
    <span
      className={`${pillBaseClasses} ${
        isOverdue(view) ? "border-destructive text-destructive" : "border-border text-muted-foreground"
      }`}
    >
      {isOverdue(view)
        ? getMessage("portal.overdue")
        : formatMessage("portal.dueOn", { date: instantOf(view.dueAt) })}
    </span>
  );
}

/** The document: its number, its lines and its totals. Shown for every state but a draft. */
function InvoiceDocument({ view }: { readonly view: PortalInvoiceView }): ReactNode {
  return (
    <section aria-labelledby="portal-document-heading" className={cardClasses}>
      <h2 id="portal-document-heading" className={headingClasses}>
        {getMessage("portal.invoiceSection")}
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
          {view.lines.map((line) => (
            <tr key={line.id}>
              <td className={cellClasses}>{line.description}</td>
              <td className={numberCellClasses}>
                {line.quantityText} {line.unit}
              </td>
              <td className={numberCellClasses}>
                {portalMoneyTextOf(view.currency, line.unitPriceMinor)}
              </td>
              <td className={numberCellClasses}>
                {portalMoneyTextOf(view.currency, line.lineTotalMinor)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <ul className="flex flex-col gap-2 sm:hidden">
        {view.lines.map((line) => (
          <li key={line.id} className={lineCardClasses}>
            <span className="text-sm font-medium">{line.description}</span>
            <span className={noteClasses}>
              {line.quantityText} {line.unit}
            </span>
            <span className="text-sm tabular-nums">
              {portalMoneyTextOf(view.currency, line.lineTotalMinor)}
            </span>
          </li>
        ))}
      </ul>

      <div className={totalsClasses}>
        <div className={totalRowClasses}>
          <span className={totalLabelClasses}>{getMessage("portal.subtotalLabel")}</span>
          <span className={totalValueClasses}>
            {portalMoneyTextOf(view.currency, view.totals.subtotalMinor)}
          </span>
        </div>
        {view.totals.discountMinor === "0" ? null : (
          <div className={totalRowClasses}>
            <span className={totalLabelClasses}>{getMessage("portal.discountLabel")}</span>
            <span className={totalValueClasses}>
              {portalMoneyTextOf(view.currency, view.totals.discountMinor)}
            </span>
          </div>
        )}
        {view.totals.taxMinor === "0" ? null : (
          <div className={totalRowClasses}>
            <span className={totalLabelClasses}>{getMessage("portal.taxLabel")}</span>
            <span className={totalValueClasses}>
              {portalMoneyTextOf(view.currency, view.totals.taxMinor)}
            </span>
          </div>
        )}
        <div className={totalRowClasses}>
          <span className="font-medium">{getMessage("portal.totalLabel")}</span>
          <span className={`${totalValueClasses} text-base`}>
            {portalMoneyTextOf(view.currency, view.totals.totalMinor)}
          </span>
        </div>
        {view.totals.paidMinor === "0" ? null : (
          <div className={totalRowClasses}>
            <span className={totalLabelClasses}>{getMessage("portal.paidLabel")}</span>
            <span className={totalValueClasses}>
              {portalMoneyTextOf(view.currency, view.totals.paidMinor)}
            </span>
          </div>
        )}
        {view.totals.remainingMinor === "0" ? null : (
          <div className={totalRowClasses}>
            <span className="font-medium">{getMessage("portal.remainingLabel")}</span>
            <span className={`${totalValueClasses} text-base`}>
              {portalMoneyTextOf(view.currency, view.totals.remainingMinor)}
            </span>
          </div>
        )}
      </div>

      {view.memo === null ? null : <p className={bodyClasses}>{view.memo}</p>}
    </section>
  );
}

/**
 * What the link would take, when it takes anything at all, and the way to take it.
 *
 * The amount is the invoice's own remaining due, and the link beside it is STEP 183's payment page - a page
 * of its own because a card number must never be typed into the page that shows the document. A settled or
 * cancelled invoice renders neither: there is nothing to pay and no form to offer.
 */
function PaymentBlock({
  view,
  token,
}: {
  readonly view: PortalInvoiceView;
  readonly token: string;
}): ReactNode {
  if (!view.payment.open || view.payment.amountMinor === null) {
    return <p className={bodyClasses}>{getMessage("portal.settledSentence")}</p>;
  }

  return (
    <div className={dueCardClasses}>
      <span className={dueTitleClasses}>{getMessage("portal.amountDueTitle")}</span>
      <span className={dueAmountClasses}>
        {portalMoneyTextOf(view.currency, view.payment.amountMinor)}
      </span>
      <p className={bodyClasses}>
        {formatMessage("portal.amountDueBody", {
          amount: portalMoneyTextOf(view.currency, view.payment.amountMinor),
        })}
      </p>
      {view.payment.minimumMinor === null ? null : (
        <p className={noteClasses}>
          {formatMessage("portal.minimumBody", {
            minimum: portalMoneyTextOf(view.currency, view.payment.minimumMinor),
          })}
        </p>
      )}
      {view.state === "partially_paid" ? (
        <p className={noteClasses}>
          {formatMessage("portal.partiallyPaidSentence", {
            paid: portalMoneyTextOf(view.currency, view.totals.paidMinor),
            total: portalMoneyTextOf(view.currency, view.totals.totalMinor),
          })}
        </p>
      ) : null}
      <Link
        href={`/i/${encodeURIComponent(token)}/pay`}
        className="inline-flex w-fit items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        {getMessage("portal.paymentStart")}
      </Link>
    </div>
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

export default async function PortalInvoicePage({
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

  let view: PortalInvoiceView;

  try {
    view = await openPortalInvoice({ token: decoded }, runtime);
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
          <p className={noticeTitleClasses}>{getMessage("portal.notIssuedTitle")}</p>
          <p className={bodyClasses}>{getMessage("portal.notIssuedBody")}</p>
        </div>
      </main>
    );
  }

  const cookieHeader = (await cookies()).toString();
  const actor = await readRequestActorOptionally(cookieHeader.length === 0 ? null : cookieHeader);
  const isMerchant =
    actor !== null && actor.companyId === view.companyId && hasRole(actor, "owner");

  return (
    <main className={pageClasses}>
      <header className="flex flex-col gap-2">
        <span className={eyebrowClasses}>{getMessage("portal.eyebrow")}</span>
        <h1 className={titleClasses}>
          {view.number === null ? getMessage("portal.invoiceSection") : view.number}
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          <StatePill view={view} />
          {view.issuedAt === null ? null : (
            <span className={noteClasses}>
              {formatMessage("portal.issuedOn", { date: instantOf(view.issuedAt) })}
            </span>
          )}
          <span className={noteClasses}>
            {formatMessage("portal.dueOn", { date: instantOf(view.dueAt) })}
          </span>
        </div>
      </header>

      {view.state === "void" ? (
        <div className={noticeClasses}>
          <p className={noticeTitleClasses}>{getMessage("portal.voidTitle")}</p>
          <p className={bodyClasses}>{getMessage("portal.voidBody")}</p>
        </div>
      ) : null}

      <section aria-labelledby="portal-buyer-heading" className={cardClasses}>
        <h2 id="portal-buyer-heading" className={headingClasses}>
          {getMessage("portal.buyerSection")}
        </h2>
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium">{view.clientName}</span>
          {view.clientEmail === null ? null : <span className={bodyClasses}>{view.clientEmail}</span>}
          {view.clientAddress === null ? null : (
            <span className={`${bodyClasses} whitespace-pre-line`}>{view.clientAddress}</span>
          )}
        </div>
      </section>

      <InvoiceDocument view={view} />

      {view.state === "void" ? null : <PaymentBlock view={view} token={decoded} />}

      <InvoicePaidState view={view} />

      {view.state === "void" ? null : <InvoiceAcceptanceCard view={view} token={decoded} />}

      {isMerchant ? <InvoiceFulfilmentCard view={view} token={decoded} /> : null}

      <p className={noteClasses}>{getMessage("portal.privacyNote")}</p>
    </main>
  );
}
