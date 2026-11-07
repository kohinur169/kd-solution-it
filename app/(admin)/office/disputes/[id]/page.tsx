// path: app/(admin)/office/disputes/[id]/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { hasSatisfiedTwoFactor } from "@/lib/auth/session";
import type { RequestActor } from "@/lib/auth/types";
import { AppError } from "@/lib/errors/app-error";
import { formatMessage, getMessage } from "@/lib/i18n/messages";
import { getDisputeSubmissionRuntime } from "@/services/disputes/dispute-runtime";
import { DISPUTE_REVIEW_ROLES } from "@/services/disputes/dispute-submission-fields";
import {
  readDisputeReview,
  type DisputeReviewPageView,
  type DisputeReviewView,
  type ReviewPackView,
} from "@/services/disputes/dispute-submission";
import { readOfficeActor } from "../../../office-actor";
import { DisputeReviewPanel } from "./review-panel";

export const metadata: Metadata = {
  title: getMessage("disputes.reviewTitle"),
  description: getMessage("disputes.reviewDescription"),
};

/** Read per request: a review is a decision about today's evidence, so it is never cached. */
export const dynamic = "force-dynamic";

/**
 * One frozen evidence pack, as the compliance desk reviews it, at `/office/disputes/[id]`.
 *
 * ## What a reviewer needs in front of them
 *
 * The dispute they are answering for - amount, reason, deadline, the processor's case id - and then the pack
 * itself: the four parts of section 19, every record with its label and the instant it was captured, and every
 * document the merchant supplied with its type, size and digest. Nothing else. A review screen that printed the
 * merchant's private correspondence in full would be a screen that leaks it to every officer; the pack already
 * carries bounded summaries, and a summary is what was frozen.
 *
 * ## What the officer does here
 *
 * Two acts, both in the panel at the bottom: decide, and send. The page decides only what to *offer* - the role,
 * the second factor and whether the pack is still reviewable - and the service and `0127` decide what is
 * allowed, so a button that appears for the wrong account earns a refusal rather than a moment of nothing.
 *
 * ## Why the page refuses before it renders
 *
 * `readDisputeReview` asks for `compliance_kyc` or `super_admin` and throws `PERMISSION_DENIED` otherwise, so an
 * account that wanders onto this URL reads a sentence instead of an empty pack that looks like "nothing to
 * review". A dispute that does not exist and a dispute of another platform are the same refusal, because there
 * is no merchant scope here: this desk reads the platform's disputes.
 */
type ReviewState =
  | { readonly kind: "signed-out" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "not-found" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "ready"; readonly view: DisputeReviewPageView; readonly mayAct: boolean };

async function readReviewState(disputeId: string): Promise<ReviewState> {
  const actorState = await readOfficeActor();

  if (actorState.kind === "anonymous") {
    return { kind: "signed-out" };
  }

  if (actorState.kind !== "actor") {
    return { kind: "unavailable" };
  }

  try {
    const view = await readDisputeReview({ actor: actorState.actor, disputeId }, getDisputeSubmissionRuntime());

    return { kind: "ready", view, mayAct: mayActOf(actorState.actor) };
  } catch (error) {
    if (error instanceof AppError) {
      if (error.code === "AUTHENTICATION_REQUIRED") {
        return { kind: "signed-out" };
      }

      if (error.code === "PERMISSION_DENIED") {
        return { kind: "forbidden" };
      }

      if (error.code === "RESOURCE_NOT_FOUND") {
        return { kind: "not-found" };
      }
    }

    return { kind: "unavailable" };
  }
}

/**
 * Whether this officer's browser may press either button.
 *
 * The role and the second factor, which are the two the service asks of the actor itself before it writes
 * anything. The device proof is the panel's to carry and the route's to check, because it is a property of the
 * request rather than of the account.
 */
function mayActOf(actor: RequestActor): boolean {
  return (
    hasSatisfiedTwoFactor(actor) &&
    actor.roles.some((role) => (DISPUTE_REVIEW_ROLES as readonly string[]).includes(role))
  );
}

const pageClasses = "flex flex-col gap-8";

const headerClasses = "flex flex-col gap-2";

const eyebrowClasses = "text-xs font-semibold uppercase tracking-widest text-muted-foreground";

const titleClasses = "text-2xl font-semibold tracking-tight sm:text-3xl";

const descriptionClasses = "max-w-3xl text-sm text-muted-foreground sm:text-base";

const sectionClasses = "flex flex-col gap-3 border-t border-border pt-6";

const headingClasses = "text-lg font-semibold tracking-tight";

const subHeadingClasses = "text-sm font-semibold text-foreground";

const bodyClasses = "text-sm text-muted-foreground";

const listClasses = "flex flex-col gap-3";

const gridClasses = "grid grid-cols-1 gap-3 sm:grid-cols-2";

const cardClasses =
  "flex flex-col gap-2 rounded-lg border border-border bg-surface p-4 text-foreground shadow-card";

const rowClasses = "flex flex-wrap items-start justify-between gap-x-3 gap-y-1 text-sm";

const subRowClasses = "text-xs text-muted-foreground";

const digestClasses = "break-all text-xs tabular-nums text-muted-foreground";

const badgeClasses =
  "rounded-full border border-border bg-muted/40 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide";

const approvedBadgeClasses =
  "rounded-full border border-primary/40 bg-primary/10 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide";

const alertClasses = "text-sm text-destructive";

const linkClasses = "w-fit text-sm font-medium text-primary underline-offset-4 hover:underline";

/** One instant, printed the way every office screen prints one: UTC, minute precision. */
function formatInstant(iso: string | null): string {
  if (iso === null) {
    return "-";
  }

  const parsed = Date.parse(iso);

  return Number.isFinite(parsed) ? `${new Date(parsed).toISOString().slice(0, 16).replace("T", " ")} UTC` : iso;
}

/** One part of the pack, named as section 19 names it. */
function sectionNameOf(section: string): string {
  switch (section) {
    case "invoice":
      return getMessage("disputes.evidenceSectionInvoice");
    case "delivery":
      return getMessage("disputes.evidenceSectionDelivery");
    case "communication":
      return getMessage("disputes.evidenceSectionCommunication");
    case "terms":
      return getMessage("disputes.evidenceSectionTerms");
    default:
      return section;
  }
}

/** A decision, as a badge. */
function DecisionBadge({ decision }: { readonly decision: DisputeReviewView["decision"] }): ReactNode {
  return (
    <span className={decision === "approved" ? approvedBadgeClasses : badgeClasses}>
      {decision === "approved" ? getMessage("disputes.reviewDecisionApproved") : getMessage("disputes.reviewDecisionDeclined")}
    </span>
  );
}

/** The pack: its four parts, its documents, its fingerprint. */
function PackSection({ pack }: { readonly pack: ReviewPackView }): ReactNode {
  const sections = ["invoice", "delivery", "communication", "terms"];

  return (
    <section aria-labelledby="dispute-review-pack-heading" className={sectionClasses}>
      <h2 className={headingClasses} id="dispute-review-pack-heading">
        {getMessage("disputes.reviewPackTitle")}
      </h2>
      <p className={bodyClasses}>
        {formatMessage("disputes.reviewCounts", {
          items: String(pack.itemCount),
          documents: String(pack.documentCount),
        })}
        {" - "}
        {formatMessage("disputes.reviewFrozenAt", { instant: formatInstant(pack.frozenAt) })}
      </p>
      <p className={digestClasses}>{formatMessage("disputes.reviewDigest", { digest: pack.digest })}</p>

      <div className={gridClasses}>
        {sections.map((section) => {
          const items = pack.items.filter((item) => item.section === section);
          const documents = pack.documents.filter((document) => document.section === section);

          return (
            <div className={cardClasses} key={section}>
              <h3 className={subHeadingClasses}>{sectionNameOf(section)}</h3>

              {items.length === 0 && documents.length === 0 ? (
                <p className={bodyClasses}>{getMessage("disputes.reviewPackEmpty")}</p>
              ) : null}

              <ul className={listClasses}>
                {items.map((item) => (
                  <li className={rowClasses} key={item.id}>
                    <div className="flex min-w-0 flex-col">
                      <span className="break-words font-medium">{item.label}</span>
                      <span className={subRowClasses}>
                        {item.summary === null
                          ? formatInstant(item.capturedAt)
                          : `${item.summary} - ${formatInstant(item.capturedAt)}`}
                      </span>
                    </div>
                  </li>
                ))}

                {documents.map((document) => (
                  <li className={rowClasses} key={document.id}>
                    <div className="flex min-w-0 flex-col">
                      <span className="break-words font-medium">{document.fileName}</span>
                      <span className={subRowClasses}>
                        {document.caption === null
                          ? `${document.contentType} - ${String(document.byteSize)} B`
                          : `${document.caption} - ${document.contentType} - ${String(document.byteSize)} B`}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** Every decision on this pack, latest first, with the reason each one gave. */
function ReviewHistory({ reviews }: { readonly reviews: readonly DisputeReviewView[] }): ReactNode {
  return (
    <section aria-labelledby="dispute-review-history-heading" className={sectionClasses}>
      <h2 className={headingClasses} id="dispute-review-history-heading">
        {getMessage("disputes.reviewHistoryTitle")}
      </h2>

      {reviews.length === 0 ? (
        <p className={bodyClasses}>{getMessage("disputes.reviewHistoryEmpty")}</p>
      ) : (
        <ul className={listClasses}>
          {reviews.map((review) => (
            <li className={cardClasses} key={review.id}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <DecisionBadge decision={review.decision} />
                <span className={subRowClasses}>{formatInstant(review.decidedAt)}</span>
              </div>
              <p className="break-words text-sm">{review.note}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The submission that went, or the sentence that says there is none. */
function SubmissionSection({ view }: { readonly view: DisputeReviewPageView }): ReactNode {
  const submission = view.submission;

  if (submission === null || submission.status !== "sent") {
    return null;
  }

  return (
    <section aria-labelledby="dispute-submission-heading" className={sectionClasses}>
      <h2 className={headingClasses} id="dispute-submission-heading">
        {getMessage("disputes.submissionSentTitle")}
      </h2>

      <div className={cardClasses}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className={approvedBadgeClasses}>
            {submission.channel === "provider"
              ? getMessage("disputes.submissionChannelProviderText")
              : getMessage("disputes.submissionChannelRecordedText")}
          </span>
          <span className={subRowClasses}>{formatInstant(submission.sentAt)}</span>
        </div>

        <p className="break-words text-sm tabular-nums">
          {formatMessage("disputes.submissionReferenceText", {
            reference: submission.processorReference ?? "-",
          })}
        </p>
        <p className={bodyClasses}>{getMessage("disputes.submissionSentBy")}</p>
        <p className={digestClasses}>{formatMessage("disputes.reviewDigest", { digest: submission.packDigest })}</p>
      </div>
    </section>
  );
}

export default async function DisputeReviewPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}): Promise<ReactNode> {
  const parameters = await params;
  const disputeId = decodeURIComponent(parameters.id);
  const state = await readReviewState(disputeId);

  return (
    <main className={pageClasses}>
      <header className={headerClasses}>
        <p className={eyebrowClasses}>{getMessage("disputes.title")}</p>
        <h1 className={titleClasses}>{getMessage("disputes.reviewTitle")}</h1>
        <p className={descriptionClasses}>{getMessage("disputes.reviewDescription")}</p>
        <Link className={linkClasses} href="/office/disputes">
          {getMessage("disputes.queueTitle")}
        </Link>
      </header>

      {state.kind === "signed-out" ? (
        <p className={alertClasses}>{getMessage("disputes.signedOut")}</p>
      ) : state.kind === "forbidden" ? (
        <p className={alertClasses}>{getMessage("disputes.reviewRoleNote")}</p>
      ) : state.kind === "not-found" ? (
        <p className={alertClasses}>{getMessage("disputes.submissionRuleNotFound")}</p>
      ) : state.kind === "unavailable" ? (
        <p className={alertClasses}>{getMessage("disputes.failed")}</p>
      ) : (
        <>
          <section aria-labelledby="dispute-review-row-heading" className={sectionClasses}>
            <h2 className={headingClasses} id="dispute-review-row-heading">
              {getMessage("disputes.listTitle")}
            </h2>

            <div className={cardClasses}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-sm font-semibold tabular-nums text-foreground">
                  {state.view.dispute.amountText}
                </span>
                <span className={badgeClasses}>{state.view.dispute.reasonCode}</span>
                {state.view.providerKey === null ? null : (
                  <span className={badgeClasses}>{state.view.providerKey}</span>
                )}
              </div>

              <dl className="grid grid-cols-1 gap-1 text-sm sm:grid-cols-[12rem_1fr]">
                <dt className={bodyClasses}>{getMessage("disputes.companyRowLabel")}</dt>
                <dd className="break-words text-xs tabular-nums sm:text-sm">{state.view.dispute.companyId}</dd>
                <dt className={bodyClasses}>{getMessage("disputes.amountRowLabel")}</dt>
                <dd className="text-xs tabular-nums sm:text-sm">{state.view.dispute.amountText}</dd>
                <dt className={bodyClasses}>{getMessage("disputes.dueRowLabel")}</dt>
                <dd className="text-xs sm:text-sm">
                  {`${formatInstant(state.view.dispute.responseDueAt)} (${String(
                    state.view.dispute.responseWindowHours,
                  )}h)`}
                </dd>
                <dt className={bodyClasses}>{getMessage("disputes.referenceRowLabel")}</dt>
                <dd className="break-words text-xs tabular-nums sm:text-sm">
                  {state.view.dispute.processorDisputeId ?? "-"}
                </dd>
              </dl>
            </div>
          </section>

          {state.view.pack === null ? (
            <section aria-labelledby="dispute-review-empty-heading" className={sectionClasses}>
              <h2 className={headingClasses} id="dispute-review-empty-heading">
                {getMessage("disputes.reviewPackTitle")}
              </h2>
              <p className={bodyClasses}>{getMessage("disputes.reviewNoPack")}</p>
              <p className={bodyClasses}>{getMessage("disputes.reviewNoPackHelp")}</p>
            </section>
          ) : (
            <PackSection pack={state.view.pack} />
          )}

          <ReviewHistory reviews={state.view.reviews} />
          <SubmissionSection view={state.view} />

          {state.view.pack === null ? null : (
            <DisputeReviewPanel
              disputeId={state.view.dispute.id}
              mayReview={state.view.mayReview && state.mayAct}
              maySubmit={state.view.maySubmit && state.mayAct}
              providerChannel={state.view.providerChannel}
              providerKey={state.view.providerKey}
              submissionSent={state.view.submission?.status === "sent"}
              version={state.view.dispute.version}
            />
          )}
        </>
      )}
    </main>
  );
}
