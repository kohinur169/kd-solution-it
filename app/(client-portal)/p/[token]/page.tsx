// path: app/(client-portal)/p/[token]/page.tsx
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { CardPaymentForm } from "../../../../components/payments/card-payment-form.tsx";
import { portalPaymentRuleTextOf } from "../../../../components/payments/portal-payment-refusal.ts";
import { isAppError } from "../../../../lib/errors/app-error.ts";
import { formatMessage, getMessage } from "../../../../lib/i18n/messages.ts";
import { PORTAL_PAYMENT_LINK_RULES } from "../../portal-payment-link-fields.ts";
import {
  preparePortalPaymentLinkCheckout,
  type PortalPaymentLinkCheckoutView,
} from "../../portal-payment-link-checkout.ts";
import { getPortalPaymentLinkRuntime } from "../../portal-payment-link-runtime.ts";
import { getPortalThreeDsRuntime } from "../../portal-three-ds-runtime.ts";

/**
 * The hosted checkout a general payment link opens.
 *
 * ## What it is
 *
 * Section 16's second half of payment links: a merchant makes a link for an amount and a sentence, shares it
 * anywhere, and the payer who opens it pays without an account, without an invoice and without this platform
 * knowing who they are. Nothing on this page is read from the query: the amount, the description and the
 * reference come from the link's own row as this request found it.
 *
 * ## The five answers it can give
 *
 *   - a link that does not verify is the one sentence every portal surface uses for every cause, because a
 *     visitor who can tell a forged link from a revoked one has a probe for which links exist;
 *   - a link that is paid, cancelled or past its time says which of the three, in the vocabulary the refusal
 *     module already words;
 *   - a business with no connected gateway, or a platform that cannot record a payment, is told plainly, and no
 *     card fields are rendered that would fail at the provider;
 *   - a deployment that cannot ask the card's bank to confirm the payment renders no form either: a general
 *     link has no invoice, so it has no client address to compare a payer against, and `0037` accepts a captured
 *     link payment only when it was authenticated. The charge endpoint refuses by the same fact, so the form
 *     cannot be reached by posting to it directly;
 *   - everything else renders the amount, the note and the provider's own secure fields.
 *
 * ## Why it is not cached
 *
 * `force-dynamic` is the feature. The page exists to say whether this link takes money *now*: a cached page
 * would show a paid or cancelled link as payable, which is the one mistake a checkout page must not make.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: getMessage("portal.linkPageEyebrow"),
  description: getMessage("portal.linkPageMetaDescription"),
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

/** The instant a person reads: the ISO date without its seconds, in UTC, as every portal page prints one. */
function instantOf(epochMs: number): string {
  return new Date(epochMs).toISOString().replace("T", " ").slice(0, 16);
}

/** The panel a page answers with when it will not take money. */
function Notice({
  title,
  body,
  note,
}: {
  readonly title: string;
  readonly body: string;
  readonly note?: string;
}): ReactNode {
  return (
    <main className={pageClasses}>
      <div className={noticeClasses}>
        <p className={noticeTitleClasses}>{title}</p>
        <p className={bodyClasses}>{body}</p>
        {note === undefined ? null : <p className={noteClasses}>{note}</p>}
      </div>
    </main>
  );
}

/** The sentence for a refusal that arrived as a thrown error rather than as a state. */
function refusalOf(error: unknown): { readonly title: string; readonly body: string } {
  if (isAppError(error)) {
    const rule = error.details[0]?.rule;
    const sentence = rule === undefined ? null : portalPaymentRuleTextOf(rule);

    if (rule === PORTAL_PAYMENT_LINK_RULES.linkPaid && sentence !== null) {
      return { title: getMessage("portal.linkPaidTitle"), body: sentence };
    }

    if (rule === PORTAL_PAYMENT_LINK_RULES.linkRevoked && sentence !== null) {
      return { title: getMessage("portal.linkRevokedTitle"), body: sentence };
    }

    if (rule === PORTAL_PAYMENT_LINK_RULES.linkExpired && sentence !== null) {
      return { title: getMessage("portal.linkExpiredTitle"), body: sentence };
    }

    if (sentence !== null) {
      return { title: getMessage("portal.linkInvalidTitle"), body: sentence };
    }
  }

  return {
    title: getMessage("portal.linkInvalidTitle"),
    body: getMessage("portal.ruleLinkNotFound"),
  };
}

export default async function PortalPaymentLinkPage({
  params,
}: {
  readonly params: Promise<{ readonly token: string }>;
}): Promise<ReactNode> {
  const { token } = await params;

  let decoded: string;

  try {
    decoded = decodeURIComponent(token);
  } catch {
    return <Notice title={getMessage("portal.linkInvalidTitle")} body={getMessage("portal.ruleLinkNotFound")} />;
  }

  let view: PortalPaymentLinkCheckoutView;

  try {
    view = await preparePortalPaymentLinkCheckout({ token: decoded }, getPortalPaymentLinkRuntime());
  } catch (error) {
    const refusal = refusalOf(error);

    return <Notice title={refusal.title} body={refusal.body} />;
  }

  // The bank's step, which this deployment cannot yet ask for, and which a link cannot skip: see the file's
  // header. The endpoint refuses by the same fact, so the form is only rendered where a charge can be taken.
  const threeDs = getPortalThreeDsRuntime();
  const authenticationReady =
    threeDs.port !== null && threeDs.port.available && threeDs.recorder !== null && threeDs.recorder.durable;

  if (view.unavailable !== null || view.secureFields === null) {
    return (
      <Notice
        title={getMessage("portal.linkUnavailableTitle")}
        body={
          view.unavailable === "recorder"
            ? getMessage("portal.linkUnavailableRecorderBody")
            : getMessage("portal.linkUnavailableProviderBody")
        }
      />
    );
  }

  if (!authenticationReady) {
    return (
      <Notice
        title={getMessage("portal.paymentThreeDsUnavailableTitle")}
        body={getMessage("portal.paymentThreeDsUnavailableBody")}
      />
    );
  }

  return (
    <main className={pageClasses}>
      <header className="flex flex-col gap-2">
        <span className={eyebrowClasses}>{getMessage("portal.linkPageEyebrow")}</span>
        <h1 className={titleClasses}>{view.link.description}</h1>
        {view.link.reference === null ? null : (
          <span className={noteClasses}>
            {getMessage("portal.linkReferenceLabel")}: {view.link.reference}
          </span>
        )}
      </header>

      <section aria-labelledby="portal-link-amount-heading" className={cardClasses}>
        <h2 id="portal-link-amount-heading" className={headingClasses}>
          {getMessage("portal.linkAmountTitle")}
        </h2>
        <p className={amountClasses}>{view.link.amountText}</p>
        <p className={bodyClasses}>{formatMessage("portal.linkAmountBody", { amount: view.link.amountText })}</p>
        <p className={noteClasses}>{formatMessage("portal.linkExpiresOn", { date: instantOf(view.link.expiresAtEpochMs) })}</p>
      </section>

      <section aria-labelledby="portal-link-card-heading" className={cardClasses}>
        <h2 id="portal-link-card-heading" className={headingClasses}>
          {getMessage("portal.linkCardSection")}
        </h2>
        <CardPaymentForm
          endpoint={`/p/${encodeURIComponent(decoded)}/charge`}
          // The link's own charge takes a token and a key; the postal code belongs to the invoice path's
          // fallback, and a link has no address to compare it against.
          askForPostalCode={false}
          amountText={view.link.amountText}
          partPayment={view.partPayment}
          idempotencyKey={view.idempotencyKey}
          secureFields={view.secureFields}
        />
      </section>

      <p className={noteClasses}>{getMessage("portal.linkPrivacyNote")}</p>
    </main>
  );
}
