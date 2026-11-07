// path: app/(client-portal)/i/[token]/pay/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { CardPaymentForm } from "../../../../../components/payments/card-payment-form.tsx";
import { portalPaymentRuleTextOf } from "../../../../../components/payments/portal-payment-refusal.ts";
import { isAppError } from "../../../../../lib/errors/app-error.ts";
import { formatMessage, getMessage } from "../../../../../lib/i18n/messages.ts";
import { preparePortalPayment, type PortalPaymentView } from "../../../portal-payment.ts";
import { getPortalPaymentRuntime } from "../../../portal-payment-runtime.ts";

/**
 * The payment page of section 18, opened from a tokenized invoice link.
 *
 * ## What the page is for, and what it deliberately is not
 *
 * It exists so that a card number is typed in exactly one place on this platform: inside the provider's own
 * hosted fields. There is no card input in this file, no handler over one and no state that could hold one -
 * the page's server half answers the amount and the public tokenization key, and its browser half hands the
 * three empty containers to NMI's script.
 *
 * ## The four answers this page can give
 *
 *   - a link that does not verify is one card, the same sentence every portal surface uses for every cause;
 *   - a link whose invoice cannot be paid - a draft, a cancelled invoice, one already settled, an amount that
 *     cannot be written in the provider's cents - says which, in the refusal vocabulary's words;
 *   - a business with no card gateway connected, or a platform that cannot yet record a payment durably, is
 *     told so plainly: the page does not render fields that would fail at the gateway;
 *   - everything else renders the amount, the secure fields and the button.
 *
 * ## Why the amount is server rendered
 *
 * The amount comes from the invoice as this request read it, never from a query parameter. A page that let a
 * payer name an amount could take one cent for a thousand dollar invoice, and STEP 189 - part payment - is
 * where a choice of amount becomes legitimate, with its own floor and its own service.
 *
 * ## Why the page is not cached
 *
 * `force-dynamic` is the feature: the page exists to say what this invoice owes now. A cached page would show
 * a settled invoice as payable, which is the one mistake a payment page must not make.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: getMessage("portal.paymentEyebrow"),
  description: getMessage("portal.paymentMetaDescription"),
  robots: { index: false, follow: false, nocache: true },
};

const pageClasses = "mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-6 sm:gap-6 sm:px-6 sm:py-10";

const cardClasses =
  "flex flex-col gap-4 rounded-lg border border-border bg-surface p-4 text-foreground shadow-card sm:p-6";

const headingClasses = "text-sm font-semibold tracking-tight text-foreground";

const eyebrowClasses = "text-xs font-medium uppercase tracking-wide text-muted-foreground";

const titleClasses = "text-xl font-semibold tracking-tight text-foreground sm:text-2xl";

const bodyClasses = "text-sm text-muted-foreground";

const noteClasses = "text-xs text-muted-foreground";

const amountClasses = "text-2xl font-semibold tabular-nums text-foreground";

const noticeClasses = "flex flex-col gap-2 rounded-lg border border-border p-4";

const noticeTitleClasses = "text-base font-semibold";

const linkClasses = "text-sm font-medium text-primary underline underline-offset-2";

/** The panel a page answers with when it has nothing to charge. */
function NoticeBody({
  title,
  body,
}: {
  readonly title: string;
  readonly body: string;
}): ReactNode {
  return (
    <div className={noticeClasses}>
      <p className={noticeTitleClasses}>{title}</p>
      <p className={bodyClasses}>{body}</p>
    </div>
  );
}

/** The same panel, as a page of its own. */
function Notice({
  title,
  body,
}: {
  readonly title: string;
  readonly body: string;
}): ReactNode {
  return (
    <main className={pageClasses}>
      <NoticeBody title={title} body={body} />
    </main>
  );
}

/** The page's own words for a refusal that arrived as an error rather than as a state. */
function refusalNotice(error: unknown): ReactNode {
  if (isAppError(error)) {
    const rule = error.details[0]?.rule;
    const sentence = rule === undefined ? null : portalPaymentRuleTextOf(rule);

    if (sentence !== null) {
      return <Notice title={getMessage("portal.paymentNotPayableTitle")} body={sentence} />;
    }
  }

  return (
    <Notice
      title={getMessage("portal.paymentNotPayableTitle")}
      body={getMessage("portal.paymentRuleNotPayable")}
    />
  );
}

/** The panel a business without a connected gateway gets, which says why and who will fix it. */
function Unavailable({ view }: { readonly view: PortalPaymentView }): ReactNode {
  return (
    <NoticeBody
      title={getMessage("portal.paymentUnavailableTitle")}
      body={
        view.unavailable === "recorder"
          ? getMessage("portal.paymentUnavailableRecorderBody")
          : getMessage("portal.paymentUnavailableProviderBody")
      }
    />
  );
}

export default async function PortalPaymentPage({
  params,
}: {
  readonly params: Promise<{ readonly token: string }>;
}): Promise<ReactNode> {
  const { token } = await params;

  let decoded: string;

  try {
    decoded = decodeURIComponent(token);
  } catch {
    return (
      <Notice
        title={getMessage("portal.linkInvalidTitle")}
        body={getMessage("portal.linkInvalidBody")}
      />
    );
  }

  let view: PortalPaymentView;

  try {
    view = await preparePortalPayment({ token: decoded }, getPortalPaymentRuntime());
  } catch (error) {
    if (isAppError(error) && error.code === "RESOURCE_NOT_FOUND") {
      return (
        <Notice
          title={getMessage("portal.linkInvalidTitle")}
          body={getMessage("portal.linkInvalidBody")}
        />
      );
    }

    return refusalNotice(error);
  }

  if (view.unavailable !== null || view.secureFields === null) {
    return (
      <main className={pageClasses}>
        <Unavailable view={view} />
        <p className={noteClasses}>
          <Link href={`/i/${encodeURIComponent(decoded)}`} className={linkClasses}>
            {getMessage("portal.paymentBackToInvoice")}
          </Link>
        </p>
      </main>
    );
  }

  return (
    <main className={pageClasses}>
      <header className="flex flex-col gap-2">
        <span className={eyebrowClasses}>{getMessage("portal.paymentEyebrow")}</span>
        <h1 className={titleClasses}>
          {view.number === null ? getMessage("portal.paymentSection") : view.number}
        </h1>
        <span className={noteClasses}>{view.clientName}</span>
      </header>

      <section aria-labelledby="portal-payment-amount-heading" className={cardClasses}>
        <h2 id="portal-payment-amount-heading" className={headingClasses}>
          {getMessage("portal.paymentAmountTitle")}
        </h2>
        <p className={amountClasses}>{view.amountText}</p>
        <p className={bodyClasses}>
          {formatMessage("portal.paymentAmountBody", { amount: view.amountText })}
        </p>
      </section>

      <section aria-labelledby="portal-payment-card-heading" className={cardClasses}>
        <h2 id="portal-payment-card-heading" className={headingClasses}>
          {getMessage("portal.paymentSection")}
        </h2>
        <CardPaymentForm
          token={decoded}
          amountText={view.amountText}
          idempotencyKey={view.idempotencyKey}
          secureFields={view.secureFields}
        />
      </section>

      <p className={noteClasses}>{getMessage("portal.paymentPrivacyNote")}</p>

      <p className={noteClasses}>
        <Link href={`/i/${encodeURIComponent(decoded)}`} className={linkClasses}>
          {getMessage("portal.paymentBackToInvoice")}
        </Link>
      </p>
    </main>
  );
}
