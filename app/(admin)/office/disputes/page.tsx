// path: app/(admin)/office/disputes/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { listDisputeWarnings, type DisputeWarningRecord } from "@/services/disputes/dispute-warnings";
import { DisputeDeadlineExtensionForm } from "./deadline-extension-form";
import { DisputeWarningRunPanel } from "./warning-run-panel";
import { AppError } from "@/lib/errors/app-error";
import { formatMessage, getMessage } from "@/lib/i18n/messages";
import { listDisputeQueue, type DisputeView } from "@/services/disputes/dispute";
import { DISPUTE_DEFAULT_WINDOW_HOURS, DISPUTE_WARNING_ROLES } from "@/services/disputes/dispute-fields";
import { hasSatisfiedTwoFactor } from "@/lib/auth/session";
import type { RequestActor } from "@/lib/auth/types";
import { getDisputeRuntime } from "@/services/disputes/dispute-runtime";
import { readOfficeActor } from "../../office-actor";

export const metadata: Metadata = {
  title: getMessage("disputes.queueTitle"),
  description: getMessage("disputes.queueDescription"),
};

/** Read per request: the queue is a deadline somebody has to meet, so it is never cached. */
export const dynamic = "force-dynamic";

/**
 * The platform's dispute queue, at `/office/disputes`.
 *
 * ## What an officer needs, in the order they need it
 *
 * Every dispute still waiting for an answer, nearest deadline first - a queue, not a report - with the
 * merchant, the amount, the processor's reason and the instant the window closes.
 *
 * ## The one act a row carries
 *
 * Section 19 lets a super administrator widen a window to 48 hours "when needed", so a row at 24 hours that is
 * still open carries that button and nothing else. Assembling the evidence pack and sending it is STEP 198's,
 * and the merchant's own response is theirs to write - a queue that offered those would promise acts this
 * build cannot perform. The button is rendered for every officer and *decided* for one: the role, the second
 * factor and the device proof are the route's, so an account that presses it reads a refusal rather than
 * discovering the rule after the window moved.
 *
 * ## What the rows say about the warnings
 *
 * Each row prints the two warnings section 19 owes its merchant - when the window started, when it reached its
 * middle - because "did we tell them" is the first question an officer asks when a dispute is lost on silence.
 * A row that carries no warning prints so, and one that carries a start but no middle is a row whose middle
 * has not arrived yet: the queue is a queue of live windows, and the sweep is what fills the lines in.
 *
 * ## Why the page refuses before it renders
 *
 * `listDisputeQueue` requires one of the four roles that answer for a dispute and throws `PERMISSION_DENIED`
 * for anybody else. The page asks the same function and maps its refusal to a sentence, so an account that
 * reaches this URL without a role reads a refusal rather than an empty queue that looks like "nothing to
 * do" - which, on a screen whose whole point is a deadline, is the expensive mistake.
 *
 * ## What it does not print
 *
 * No role name, no merchant's response text and no evidence: a queue is a list of deadlines. The merchant's
 * words belong to the row they were written on, and the screen that shows them is the one that also guards
 * who may send them.
 */
type QueueState =
  | { readonly kind: "signed-out" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "unavailable" }
  | {
      readonly kind: "ready";
      readonly disputes: readonly DisputeView[];
      readonly warnings: ReadonlyMap<string, readonly DisputeWarningRecord[]>;
      /** Whether this officer may send the two warnings by hand, which the panel needs to know. */
      readonly mayWarn: boolean;
    };

async function readQueueState(): Promise<QueueState> {
  const actorState = await readOfficeActor();

  if (actorState.kind === "anonymous") {
    return { kind: "signed-out" };
  }

  if (actorState.kind !== "actor") {
    return { kind: "unavailable" };
  }

  try {
    const dependencies = getDisputeRuntime();
    const disputes = await listDisputeQueue({ actor: actorState.actor }, dependencies);
    // One read for the whole page: the queue prints who has been warned, and a query per row would turn a
    // screen into a hundred round trips.
    const warnings = await listDisputeWarnings(
      { disputeIds: disputes.map((dispute) => dispute.id) },
      dependencies,
    ).catch(() => new Map<string, readonly DisputeWarningRecord[]>());

    return { kind: "ready", disputes, warnings, mayWarn: maySendWarnings(actorState.actor) };
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

/**
 * Whether this officer may press the button that sends section 19's warnings.
 *
 * The page only decides what to *offer*: `runDisputeWarningsNow` asks the same two questions of the same
 * actor before it sweeps, so a browser that shows the button to the wrong account earns a refusal rather than
 * a sweep. The second factor is asked here for the same reason it is asked there - a session that has not
 * proved itself must not be able to mail the platform's merchants.
 */
function maySendWarnings(actor: RequestActor): boolean {
  return (
    hasSatisfiedTwoFactor(actor) &&
    actor.roles.some((role) => (DISPUTE_WARNING_ROLES as readonly string[]).includes(role))
  );
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

const dueBadgeClasses =
  "rounded-full border border-border bg-background px-2.5 py-0.5 text-xs font-medium tabular-nums";

const noteClasses =
  "whitespace-nowrap rounded-lg border border-border bg-background px-2 py-1 text-xs tabular-nums";

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

/**
 * The warnings a dispute has already had, as one line: the start, the middle, or neither.
 *
 * The instant printed is when the warning was *due*, which is the instant the merchant was told about, and not
 * when the sweep happened to run: a warning that went out a minute late is still a warning about a deadline.
 */
function warningTextOf(records: readonly DisputeWarningRecord[] | undefined): string {
  if (records === undefined || records.length === 0) {
    return getMessage("disputes.warningNone");
  }

  return records
    .map((record) =>
      formatMessage(record.stage === "start" ? "disputes.warningStartSent" : "disputes.warningMidpointSent", {
        instant: formatInstant(record.warnedAt),
      }),
    )
    .join(" - ");
}

/** The status as one phrase, for the badge on a row. */
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

/** How close the row is to its deadline: the one thing this queue is sorted by. */
function dueTextOf(dueState: DisputeView["dueState"]): string {
  switch (dueState) {
    case "due_soon":
      return getMessage("disputes.dueSoon");
    case "overdue":
      return getMessage("disputes.dueOverdue");
    case "resolved":
      return getMessage("disputes.dueResolved");
    default:
      return getMessage("disputes.dueOpen");
  }
}

export default async function DisputeQueuePage(): Promise<ReactNode> {
  const state = await readQueueState();

  return (
    <main className={pageClasses}>
      <header className={headerClasses}>
        <p className={eyebrowClasses}>{getMessage("disputes.title")}</p>
        <h1 className={titleClasses}>{getMessage("disputes.queueTitle")}</h1>
        <p className={descriptionClasses}>{getMessage("disputes.queueDescription")}</p>
        <Link className={linkClasses} href="/office/refunds">
          {getMessage("disputes.refundQueueLink")}
        </Link>
      </header>

      {state.kind === "signed-out" ? (
        <p className={alertClasses}>{getMessage("disputes.signedOut")}</p>
      ) : state.kind === "forbidden" ? (
        <p className={alertClasses}>{getMessage("disputes.officeRoleRefusedBody")}</p>
      ) : state.kind === "unavailable" ? (
        <p className={alertClasses}>{getMessage("disputes.failed")}</p>
      ) : (
        <section aria-labelledby="dispute-queue-heading" className={sectionClasses}>
          <h2 id="dispute-queue-heading" className={headingClasses}>
            {getMessage("disputes.queueTitle")}
          </h2>
          <p className={bodyClasses}>{getMessage("disputes.deadlineHelp")}</p>

          {state.mayWarn ? (
            <DisputeWarningRunPanel />
          ) : (
            <p className={bodyClasses}>{getMessage("disputes.warningRunRoleNote")}</p>
          )}

          {state.disputes.length === 0 ? (
            <p className={bodyClasses}>{getMessage("disputes.queueEmpty")}</p>
          ) : (
            <ul className={listClasses}>
              {state.disputes.map((dispute) => (
                <li key={dispute.id} className={cardClasses}>
                  <div className={rowHeaderClasses}>
                    <span className={badgeClasses}>{statusTextOf(dispute.status)}</span>
                    <span className="text-sm font-semibold tabular-nums text-foreground">
                      {dispute.amountText}
                    </span>
                    <span className={dueBadgeClasses}>{dueTextOf(dispute.dueState)}</span>
                    <span className={noteClasses}>{dispute.reasonCode}</span>
                  </div>

                  <dl className="grid grid-cols-1 gap-1 text-sm sm:grid-cols-[12rem_1fr]">
                    <dt className={bodyClasses}>{getMessage("disputes.companyRowLabel")}</dt>
                    <dd className="break-words text-xs tabular-nums sm:text-sm">{dispute.companyId}</dd>
                    <dt className={bodyClasses}>{getMessage("disputes.reasonRowLabel")}</dt>
                    <dd className="text-xs sm:text-sm">{dispute.reasonCode}</dd>
                    <dt className={bodyClasses}>{getMessage("disputes.amountRowLabel")}</dt>
                    <dd className="text-xs tabular-nums sm:text-sm">{dispute.amountText}</dd>
                    <dt className={bodyClasses}>{getMessage("disputes.openedRowLabel")}</dt>
                    <dd className="text-xs sm:text-sm">{formatInstant(dispute.openedAt)}</dd>
                    <dt className={bodyClasses}>{getMessage("disputes.dueRowLabel")}</dt>
                    <dd className="text-xs sm:text-sm">
                      {`${formatInstant(dispute.responseDueAt)} (${String(dispute.responseWindowHours)}h)`}
                    </dd>
                    <dt className={bodyClasses}>{getMessage("disputes.referenceRowLabel")}</dt>
                    <dd className="break-words text-xs tabular-nums sm:text-sm">
                      {dispute.processorDisputeId ?? "-"}
                    </dd>
                    <dt className={bodyClasses}>{getMessage("disputes.warningRowLabel")}</dt>
                    <dd className="text-xs sm:text-sm">{warningTextOf(state.warnings.get(dispute.id))}</dd>
                  </dl>

                  {dispute.dueState === "overdue" ? (
                    <p className={bodyClasses}>{getMessage("disputes.overdueNote")}</p>
                  ) : dispute.responseWindowHours === DISPUTE_DEFAULT_WINDOW_HOURS ? (
                    <DisputeDeadlineExtensionForm
                      currentWindowHours={dispute.responseWindowHours}
                      disputeId={dispute.id}
                    />
                  ) : (
                    <p className={bodyClasses}>{getMessage("disputes.deadlineExtensionRoleNote")}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </main>
  );
}
