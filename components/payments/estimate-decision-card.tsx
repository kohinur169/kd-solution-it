// path: components/payments/estimate-decision-card.tsx
import type { ReactNode } from "react";
import { formatMessage, getMessage } from "../../lib/i18n/messages.ts";
import type { PortalEstimateView } from "../../app/(client-portal)/portal-estimate.ts";
import { EstimateDecisionForm } from "./estimate-decision-form.tsx";

/**
 * The client's decision on a tokenized estimate, and the record of the one that was made.
 *
 * ## The five states this card answers
 *
 *   1. **Open** - the offer is inside its lifetime and nobody has decided. The form is offered, and the
 *      sentence above it says exactly what a decision records.
 *   2. **Accepted** - the decision and the signature record, both read only.
 *   3. **Declined** - the same record, with the sentence that ends the offer: `0025` stores it as `void`
 *      with `void_reason = 'declined'`, so there is nothing left to accept.
 *   4. **Expired** - the lifetime passed, and the page voided it with `void_reason = 'expired'` as it was
 *      opened. A draft that is not issued cannot reach this card at all.
 *   5. **Withdrawn** - the merchant took the offer back before anybody decided.
 *
 * ## Why the record is printed field by field
 *
 * A signature is evidence only if the person who gave it can see what was kept: who signed, when, from
 * which address, with which words in front of them, and over which digest of the offer. The card is
 * therefore the client's own copy of the row, and it prints every field a `0027` row holds except the
 * drawn signature, which this page never stores. A merchant's read-only view of the same row lives in
 * STEP 120's panel; this one exists for the person who signed.
 *
 * ## Why nothing here is a form once decided
 *
 * Evidence is append-only, and the database refuses a second row for the same estimate. A form that
 * rendered after a decision could only ever fail, so it is not rendered at all.
 */

const cardClasses =
  "flex flex-col gap-4 rounded-lg border border-border bg-surface p-4 text-foreground shadow-card sm:p-6";

const headingClasses = "text-sm font-semibold tracking-tight text-foreground";

const bodyClasses = "text-sm text-muted-foreground";

const noteClasses = "text-xs text-muted-foreground";

const noticeClasses = "flex flex-col gap-1 rounded-lg border border-border p-4";

const noticeTitleClasses = "text-base font-semibold";

const acceptedNoticeClasses = "flex flex-col gap-1 rounded-lg border border-success p-4";

const acceptedTitleClasses = "text-base font-semibold text-success";

const declinedNoticeClasses = "flex flex-col gap-1 rounded-lg border border-destructive p-4";

const declinedTitleClasses = "text-base font-semibold text-destructive";

const recordClasses = "flex flex-col gap-2 rounded-md bg-muted px-3 py-2 text-sm";

const recordRowClasses = "flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4";

const recordLabelClasses = "text-xs font-medium uppercase tracking-wide text-muted-foreground";

const recordValueClasses = "break-words text-sm tabular-nums";

const hashClasses = "break-all font-mono text-xs text-muted-foreground";

/** One instant, UTC, seconds cut: the print every record on this page uses. */
function instantOf(iso: string): string {
  const parsed = Date.parse(iso);

  return Number.isFinite(parsed) ? new Date(parsed).toISOString().replace("T", " ").slice(0, 16) : iso;
}

function RecordRow({
  label,
  value,
  mono = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
}): ReactNode {
  return (
    <div className={recordRowClasses}>
      <span className={recordLabelClasses}>{label}</span>
      <span className={mono ? hashClasses : recordValueClasses}>{value}</span>
    </div>
  );
}

/** The recorded decision, printed from the row rather than summarized. */
function SignatureRecord({ view }: { readonly view: PortalEstimateView }): ReactNode {
  const signature = view.signature;

  if (signature === null) {
    return null;
  }

  return (
    <section aria-labelledby="portal-estimate-record-heading" className="flex flex-col gap-2">
      <h3 id="portal-estimate-record-heading" className={headingClasses}>
        {getMessage("portal.estimateSignatureSection")}
      </h3>
      <p className={bodyClasses}>{getMessage("portal.estimateSignatureBody")}</p>

      <div className={recordClasses}>
        <RecordRow
          label={getMessage("portal.estimateSignatureDecisionLabel")}
          value={
            signature.decision === "accepted"
              ? getMessage("portal.estimateStateAccepted")
              : getMessage("portal.estimateStateDeclined")
          }
        />
        <RecordRow label={getMessage("portal.estimateSignatureSignedBy")} value={signature.signerName} />
        <RecordRow
          label={getMessage("portal.estimateSignatureSignedAt")}
          value={instantOf(signature.signedAt)}
        />
        <RecordRow
          label={getMessage("portal.estimateSignatureDocumentHash")}
          value={signature.documentHash}
          mono
        />
      </div>

      <p className={noteClasses}>{getMessage("portal.estimateSignatureDocumentHashHint")}</p>
      <p className={noteClasses}>{getMessage("portal.estimateSignatureTyped")}</p>
    </section>
  );
}

export interface EstimateDecisionCardProps {
  readonly view: PortalEstimateView;
  readonly token: string;
}

export function EstimateDecisionCard({ view, token }: EstimateDecisionCardProps): ReactNode {
  return (
    <section aria-labelledby="portal-estimate-decision-heading" className={cardClasses}>
      <h2 id="portal-estimate-decision-heading" className={headingClasses}>
        {getMessage("portal.estimateDecisionSection")}
      </h2>

      {view.state === "open" ? (
        <div className={recordClasses}>
          <p className={bodyClasses}>
            {formatMessage("portal.estimateExpiresOpen", { date: instantOf(view.estimate.expiresAt) })}
          </p>
        </div>
      ) : null}

      {view.state === "accepted" ? (
        <div className={acceptedNoticeClasses}>
          <p className={acceptedTitleClasses}>{getMessage("portal.estimateAcceptedTitle")}</p>
          <p className={bodyClasses}>
            {view.signature === null
              ? getMessage("portal.estimateAcceptedBodyUndated")
              : formatMessage("portal.estimateAcceptedBody", {
                  name: view.signature.signerName,
                  date: instantOf(view.signature.signedAt),
                })}
          </p>
        </div>
      ) : null}

      {view.state === "declined" ? (
        <div className={declinedNoticeClasses}>
          <p className={declinedTitleClasses}>{getMessage("portal.estimateDeclinedTitle")}</p>
          <p className={bodyClasses}>
            {view.signature === null
              ? getMessage("portal.estimateDeclinedBodyUndated")
              : formatMessage("portal.estimateDeclinedBody", {
                  name: view.signature.signerName,
                  date: instantOf(view.signature.signedAt),
                })}
          </p>
        </div>
      ) : null}

      {view.state === "expired" ? (
        <div className={noticeClasses}>
          <p className={noticeTitleClasses}>{getMessage("portal.estimateExpiredTitle")}</p>
          <p className={bodyClasses}>
            {Number.isFinite(Date.parse(view.estimate.expiresAt))
              ? formatMessage("portal.estimateExpiredBody", {
                  date: instantOf(view.estimate.expiresAt),
                })
              : getMessage("portal.estimateExpiredBodyUndated")}
          </p>
        </div>
      ) : null}

      {view.state === "withdrawn" ? (
        <div className={noticeClasses}>
          <p className={noticeTitleClasses}>{getMessage("portal.estimateWithdrawnTitle")}</p>
          <p className={bodyClasses}>{getMessage("portal.estimateWithdrawnBody")}</p>
        </div>
      ) : null}

      {view.state === "open" ? <EstimateDecisionForm token={token} /> : null}

      <SignatureRecord view={view} />
    </section>
  );
}
