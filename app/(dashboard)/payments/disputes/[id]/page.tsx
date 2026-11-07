// path: app/(dashboard)/payments/disputes/[id]/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { AppError } from "@/lib/errors/app-error";
import { getMessage } from "@/lib/i18n/messages";
import type { DisputeView } from "@/services/disputes/dispute";
import { readCompanyDispute } from "@/services/disputes/dispute-response";
import { getDisputeRuntime } from "@/services/disputes/dispute-runtime";
import { readOwnerActor } from "../../../onboarding/owner-actor";
import { DisputeDeadlineClock } from "./dispute-deadline-clock";
import { DisputeResponseForm } from "./dispute-response-form";

export const metadata: Metadata = {
  title: getMessage("disputes.answerTitle"),
  description: getMessage("disputes.answerDescription"),
};

/** Read per request: a deadline is a live number of minutes, so nothing about this page is cached. */
export const dynamic = "force-dynamic";

/**
 * Section 19's response form, at `/payments/disputes/[id]`.
 *
 * ## Why the page reads the row itself rather than trusting the URL
 *
 * The id arrives from a link, and a link can be edited. `readCompanyDispute` asks the session for the `owner`
 * role, takes the company from the session rather than from the request, and reads the dispute inside it - so a
 * dispute that belongs to somebody else reads as "not on your account", and the form is never rendered around
 * a row this account may not see.
 *
 * ## The three states the form can be in
 *
 * Waiting (`editable`), where the deadline has not passed, the pack has not been sent and the dispute is
 * undecided; sent, where the words are fixed because they are in the pack; and decided, where the whole row is
 * history. The page decides which sentence to print, and the *service* decides which save to accept - the same
 * three conditions, asked twice, because a page rendered at 23:59 can be submitted at 00:01.
 *
 * ## What it prints and what it does not
 *
 * It prints the deadline twice - UTC from the server, the merchant's own zone from the browser - because
 * section 19's window is a fact about the person reading it. It does not print the processor's payload, the
 * evidence the desk assembles or the outcome before it exists: the response is the merchant's, and everything
 * else on this row belongs to the office.
 */
type AnswerState =
  | { readonly kind: "signed-out" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "not-found" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "ready"; readonly dispute: DisputeView };

async function readAnswerState(disputeId: string): Promise<AnswerState> {
  const actorState = await readOwnerActor();

  if (actorState.kind === "anonymous") {
    return { kind: "signed-out" };
  }

  if (actorState.kind !== "actor") {
    return { kind: "unavailable" };
  }

  try {
    const dispute = await readCompanyDispute({ actor: actorState.actor, disputeId }, getDisputeRuntime());

    return { kind: "ready", dispute };
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

const pageClasses = "flex flex-col gap-8";

const headerClasses = "flex flex-col gap-2";

const eyebrowClasses = "text-xs font-semibold uppercase tracking-widest text-muted-foreground";

const titleClasses = "text-2xl font-semibold tracking-tight sm:text-3xl";

const descriptionClasses = "max-w-3xl text-sm text-muted-foreground sm:text-base";

const sectionClasses = "flex flex-col gap-3 border-t border-border pt-6";

const headingClasses = "text-lg font-semibold tracking-tight";

const bodyClasses = "text-sm text-muted-foreground";

const cardClasses =
  "flex flex-col gap-2 rounded-lg border border-border bg-surface p-4 text-foreground shadow-card";

const badgeClasses =
  "rounded-full border border-border bg-muted/40 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide";

const alertClasses = "text-sm text-destructive";

const linkClasses = "w-fit text-sm font-medium text-primary underline-offset-4 hover:underline";

/** One instant, UTC, minute precision. The local reading is the clock component's job. */
function formatInstant(iso: string | null): string {
  if (iso === null) {
    return "-";
  }

  const parsed = Date.parse(iso);

  return Number.isFinite(parsed) ? `${new Date(parsed).toISOString().slice(0, 16).replace("T", " ")} UTC` : iso;
}

/** The status as one phrase, for the badge. */
function statusTextOf(status: DisputeView["status"]): string {
  switch (status) {
    case "under_review":
      return getMessage("disputes.stateUnderReview");
    case "evidence_submitted":
      return getMessage("disputes.stateEvidenceSubmitted");
    case "won":
      return getMessage("disputes.stateWon");
    case "lost":
      return getMessage("disputes.stateLost");
    case "closed":
      return getMessage("disputes.stateClosed");
    default:
      return getMessage("disputes.stateOpen");
  }
}

export default async function DisputeAnswerPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}): Promise<ReactNode> {
  const parameters = await params;
  const state = await readAnswerState(parameters.id);

  return (
    <main className={pageClasses}>
      <header className={headerClasses}>
        <p className={eyebrowClasses}>{getMessage("disputes.answerEyebrow")}</p>
        <h1 className={titleClasses}>{getMessage("disputes.answerTitle")}</h1>
        <p className={descriptionClasses}>{getMessage("disputes.answerDescription")}</p>
        <Link className={linkClasses} href="/payments/disputes">
          {getMessage("disputes.backToList")}
        </Link>
      </header>

      {state.kind === "signed-out" ? (
        <p className={alertClasses}>{getMessage("disputes.signedOut")}</p>
      ) : state.kind === "forbidden" ? (
        <p className={alertClasses}>{getMessage("disputes.roleRefusedBody")}</p>
      ) : state.kind === "not-found" ? (
        <p className={alertClasses}>{getMessage("disputes.responseNotFoundError")}</p>
      ) : state.kind === "unavailable" ? (
        <p className={alertClasses}>{getMessage("disputes.failed")}</p>
      ) : (
        <DisputeAnswer dispute={state.dispute} />
      )}
    </main>
  );
}

/** The ready page: the row, the deadline on both clocks, and the form in whichever state it is in. */
function DisputeAnswer({ dispute }: { readonly dispute: DisputeView }): ReactNode {
  const decided = dispute.resolvedAt !== null;
  const sent = dispute.responseSubmittedAt !== null;
  const closed = dispute.dueState === "overdue";
  const editable = !decided && !sent && !closed;

  return (
    <>
      <section aria-labelledby="dispute-summary-heading" className={sectionClasses}>
        <h2 className={headingClasses} id="dispute-summary-heading">
          {getMessage("disputes.summaryTitle")}
        </h2>

        <div className={cardClasses}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className={badgeClasses}>{statusTextOf(dispute.status)}</span>
            <span className="text-sm font-semibold tabular-nums text-foreground">{dispute.amountText}</span>
            <span className="rounded-full border border-border bg-background px-2.5 py-0.5 text-xs font-medium tabular-nums">
              {dispute.reasonCode}
            </span>
            {dispute.responseSavedAt === null ? null : (
              <span className={badgeClasses}>{getMessage("disputes.responseSavedBadge")}</span>
            )}
          </div>

          <dl className="grid grid-cols-1 gap-1 text-sm sm:grid-cols-[11rem_1fr]">
            <dt className={bodyClasses}>{getMessage("disputes.reasonRowLabel")}</dt>
            <dd className="text-xs sm:text-sm">{dispute.reasonCode}</dd>
            <dt className={bodyClasses}>{getMessage("disputes.amountRowLabel")}</dt>
            <dd className="text-xs tabular-nums sm:text-sm">{dispute.amountText}</dd>
            <dt className={bodyClasses}>{getMessage("disputes.openedRowLabel")}</dt>
            <dd className="text-xs sm:text-sm">{formatInstant(dispute.openedAt)}</dd>
            <dt className={bodyClasses}>{getMessage("disputes.dueRowLabel")}</dt>
            <dd className="text-xs tabular-nums sm:text-sm">
              {`${formatInstant(dispute.responseDueAt)} (${String(dispute.responseWindowHours)}h)`}
            </dd>
            <dt className={bodyClasses}>{getMessage("disputes.referenceRowLabel")}</dt>
            <dd className="break-words text-xs tabular-nums sm:text-sm">{dispute.processorDisputeId ?? "-"}</dd>
          </dl>
        </div>
      </section>

      <DisputeDeadlineClock
        dueAt={dispute.responseDueAt}
        openedAt={dispute.openedAt}
        windowHours={dispute.responseWindowHours}
      />

      <section aria-labelledby="dispute-response-heading" className={sectionClasses}>
        <h2 className={headingClasses} id="dispute-response-heading">
          {getMessage("disputes.responseLabel")}
        </h2>

        {decided ? <p className={bodyClasses}>{getMessage("disputes.responseResolvedNote")}</p> : null}
        {!decided && sent ? <p className={bodyClasses}>{getMessage("disputes.responseSubmittedNote")}</p> : null}
        {!decided && !sent && closed ? (
          <p className={alertClasses}>{getMessage("disputes.deadlineClosedNote")}</p>
        ) : null}

        <DisputeResponseForm
          disputeId={dispute.id}
          editable={editable}
          initialText={dispute.responseText ?? ""}
          savedAt={dispute.responseSavedAt}
        />

        <p className={bodyClasses}>{getMessage("disputes.documentsNote")}</p>
      </section>

      {decided ? (
        <section aria-labelledby="dispute-outcome-heading" className={sectionClasses}>
          <h2 className={headingClasses} id="dispute-outcome-heading">
            {getMessage("disputes.outcomeRowLabel")}
          </h2>
          <p className={bodyClasses}>
            {`${getMessage("disputes.resolvedRowLabel")} ${formatInstant(dispute.resolvedAt)}`}
          </p>
          <p className="whitespace-pre-wrap break-words rounded-lg border border-border bg-background p-3 text-sm">
            {dispute.outcomeNote ?? "-"}
          </p>
        </section>
      ) : null}
    </>
  );
}
