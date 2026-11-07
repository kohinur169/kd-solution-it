// path: app/(dashboard)/payments/disputes/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { AppError } from "@/lib/errors/app-error";
import { getMessage } from "@/lib/i18n/messages";
import { listCompanyDisputes, type DisputeView } from "@/services/disputes/dispute";
import { getDisputeRuntime } from "@/services/disputes/dispute-runtime";
import { readOwnerActor } from "../../onboarding/owner-actor";

export const metadata: Metadata = {
  title: getMessage("disputes.title"),
  description: getMessage("disputes.description"),
};

/** Read per request: a dispute's deadline is money moving in minutes, so it is never cached. */
export const dynamic = "force-dynamic";

/**
 * Section 19's dispute list for a merchant, at `/payments/disputes`.
 *
 * ## Why this screen renders on the server
 *
 * It has nothing to *do*. STEP 194 lists a dispute and tracks the status a processor gives it; writing the
 * merchant's side of the answer is STEP 195's form, and the evidence pack is STEP 198's. A screen with no
 * form needs no client component, no fetch, no token and no loading state, so the service is called once
 * inside the request and the answer is the page. `listCompanyDisputes` is the same function the JSON route
 * calls, so a merchant reading this page and a client reading `/api/payments/disputes` cannot disagree.
 *
 * ## Why a refusal is a sentence and not an empty list
 *
 * Three different things can go wrong before there is a list: no session, a role the service refuses, and a
 * database that did not answer. An empty table would tell a merchant with a valid session that nobody has
 * disputed their money, which is the one wrong answer that hides a real dispute. So each state prints what
 * it is, and the service's refusal is mapped rather than swallowed.
 *
 * ## What the screen does not claim
 *
 * The statuses are the processor's. This platform does not decide a dispute, so the page never prints a
 * verdict of its own; it prints the state the row has and the instant the window closes, and it says that
 * the answer itself is written elsewhere.
 */
type ListState =
  | { readonly kind: "signed-out" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "ready"; readonly disputes: readonly DisputeView[] };

async function readListState(): Promise<ListState> {
  const actorState = await readOwnerActor();

  if (actorState.kind === "anonymous") {
    return { kind: "signed-out" };
  }

  if (actorState.kind !== "actor") {
    return { kind: "unavailable" };
  }

  try {
    const disputes = await listCompanyDisputes({ actor: actorState.actor }, getDisputeRuntime());

    return { kind: "ready", disputes };
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

/** One instant, printed the way every screen prints one: UTC, minute precision. */
function formatInstant(iso: string | null): string {
  if (iso === null) {
    return "-";
  }

  const parsed = Date.parse(iso);

  return Number.isFinite(parsed) ? `${new Date(parsed).toISOString().slice(0, 16).replace("T", " ")} UTC` : iso;
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

/** How close the row is to its deadline, in the same words the office queue uses. */
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

export default async function DisputesPage(): Promise<ReactNode> {
  const state = await readListState();

  return (
    <main className={pageClasses}>
      <header className={headerClasses}>
        <p className={eyebrowClasses}>{getMessage("disputes.title")}</p>
        <h1 className={titleClasses}>{getMessage("disputes.listTitle")}</h1>
        <p className={descriptionClasses}>{getMessage("disputes.description")}</p>
        <p className={bodyClasses}>{getMessage("disputes.statusHelp")}</p>
        <Link className={linkClasses} href="/payments/refunds">
          {getMessage("disputes.refundDeskLink")}
        </Link>
      </header>

      {state.kind === "signed-out" ? (
        <p className={alertClasses}>{getMessage("disputes.signedOut")}</p>
      ) : state.kind === "forbidden" ? (
        <p className={alertClasses}>{getMessage("disputes.roleRefusedBody")}</p>
      ) : state.kind === "unavailable" ? (
        <p className={alertClasses}>{getMessage("disputes.failed")}</p>
      ) : (
        <section aria-labelledby="dispute-list-heading" className={sectionClasses}>
          <h2 id="dispute-list-heading" className={headingClasses}>
            {getMessage("disputes.listTitle")}
          </h2>
          <p className={bodyClasses}>{getMessage("disputes.deadlineHelp")}</p>

          {state.disputes.length === 0 ? (
            <p className={bodyClasses}>{getMessage("disputes.listEmpty")}</p>
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
                  </dl>

                  {dispute.resolvedAt === null ? null : (
                    <div className="flex flex-col gap-1">
                      <p className={bodyClasses}>
                        {`${getMessage("disputes.resolvedRowLabel")} ${formatInstant(dispute.resolvedAt)}`}
                      </p>
                      <p className="text-sm font-medium text-foreground">
                        {getMessage("disputes.outcomeRowLabel")}
                      </p>
                      <p className="whitespace-pre-wrap break-words rounded-lg border border-border bg-background p-3 text-sm">
                        {dispute.outcomeNote ?? "-"}
                      </p>
                    </div>
                  )}

                  {dispute.dueState === "overdue" ? (
                    <p className={bodyClasses}>{getMessage("disputes.overdueNote")}</p>
                  ) : (
                    <p className={bodyClasses}>{getMessage("disputes.nextStepNote")}</p>
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
