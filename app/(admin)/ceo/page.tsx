// path: app/(admin)/ceo/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { AppError } from "@/lib/errors/app-error";
import {
  listApprovalQueue,
  readPlatformDecisions,
  type ApprovalQueueSnapshot,
  type ApprovalRequestView,
  type PlatformDecisionSummary,
} from "@/lib/approvals/service";
import { getApprovalRuntime, type ApprovalRuntime } from "@/lib/approvals/runtime";
import { approvalActionLabelKey, signatureProblemOf, stageLabelKey } from "@/lib/approvals/registry";
import type { RequestActor } from "@/lib/auth/types";
import { formatMessage, getMessage } from "@/lib/i18n/messages";
import { readOfficeActor } from "../office-actor";
import { ApprovalDecisionForm } from "./approval-decision-form";
import { ApprovalRequestForm } from "./approval-request-form";

export const metadata: Metadata = {
  title: getMessage("officeApprovals.title"),
  description: getMessage("officeApprovals.description"),
};

/**
 * The CEO's home: the approval queue of section 2, its two signatures, and the platform decisions the
 * role carries beside them.
 *
 * ## What a signer needs to see, in the order they need it
 *
 * The queue first, because a request that waits is a decision somebody has to take; then the desk the
 * rows have moved to, because a signer who cannot see the next stage queues work nobody can close;
 * then the form that raises a request, for the super administrator, who is the one person the CEO never
 * is; then what has already been decided, because the outcome of a signature is as much a fact as the
 * signature; and last the two platform counts section 2 gives the CEO.
 *
 * ## Where the buttons come from
 *
 * A row carries a decision form only when `signatureProblemOf` - the same function the service refuses
 * with - says this account may sign it. So the CEO cannot confirm at the last desk, the super
 * administrator cannot pre-empt the first signature, an account cannot sign a request it raised, and the
 * account that approved as the CEO cannot also confirm. The page never decides any of that itself; it
 * asks the rule and renders the answer, which is why the screen and the service cannot drift apart.
 *
 * ## What is still not here
 *
 * The action itself. An approved request is the authority for a payout release, a reserve release, a fee
 * change or a country switch, and each of those is moved by the module that owns it, with this row as
 * the permission. Nothing on this page moves money.
 */
type CeoState =
  | { readonly kind: "signed-out" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "unavailable" }
  | {
      readonly kind: "ready";
      readonly actor: RequestActor;
      readonly queue: ApprovalQueueSnapshot;
      readonly decisions: PlatformDecisionSummary;
    };

async function readCeoState(runtime: ApprovalRuntime): Promise<CeoState> {
  const actorState = await readOfficeActor();

  if (actorState.kind === "anonymous") {
    return { kind: "signed-out" };
  }

  if (actorState.kind !== "actor") {
    return { kind: "unavailable" };
  }

  try {
    const queue = await listApprovalQueue({ actor: actorState.actor }, runtime);
    const decisions = await readPlatformDecisions({ actor: actorState.actor }, runtime);

    return { kind: "ready", actor: actorState.actor, queue, decisions };
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

const termClasses = "text-sm font-medium text-foreground";

const listClasses = "flex flex-col gap-3";

const cardClasses =
  "flex flex-col gap-2 rounded-lg border border-border bg-surface p-4 text-foreground shadow-card";

const rowHeaderClasses = "flex flex-wrap items-center gap-x-3 gap-y-1";

const badgeClasses =
  "rounded-full border border-border bg-muted/40 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide";

const noteClasses =
  "mt-1 whitespace-pre-wrap break-words rounded-lg border border-border bg-background p-3 text-sm";

const linkClasses =
  "w-fit rounded-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-primary";

const alertClasses = "text-sm text-destructive";

/** One instant, printed the way every office screen prints one: UTC, minute precision. */
function formatInstant(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** Thousands grouped without depending on the runtime's locale data. */
function groupDigits(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
}

/** The amount a row moves, or the sentence that says it moves none. */
function amountText(row: ApprovalRequestView): string {
  if (row.amountMinor === null || row.currency === null) {
    return getMessage("officeApprovals.amountLabel");
  }

  return `${groupDigits(row.amountMinor)} ${row.currency}`;
}

/** The closed status as one word, for the badge on a decided row. */
function statusLabel(row: ApprovalRequestView): string {
  switch (row.status) {
    case "approved":
      return getMessage("officeApprovals.statusApproved");
    case "rejected":
      return getMessage("officeApprovals.statusRejected");
    case "expired":
      return getMessage("officeApprovals.statusExpired");
    default:
      return getMessage("officeApprovals.statusCancelled");
  }
}

function DecisionRow({
  row,
  form,
}: {
  readonly row: ApprovalRequestView;
  readonly form?: ReactNode;
}): ReactNode {
  return (
    <li className={cardClasses}>
      <div className={rowHeaderClasses}>
        <span className={badgeClasses}>{getMessage(approvalActionLabelKey(row.actionType))}</span>
        <span className={badgeClasses}>
          {row.stage === "closed" ? statusLabel(row) : getMessage(stageLabelKey(row.stage))}
        </span>
        {row.expired && row.stage !== "closed" ? (
          <span className={badgeClasses}>{getMessage("officeApprovals.expiredBadge")}</span>
        ) : null}
        <span className="text-sm font-semibold text-foreground">{row.subjectLabel}</span>
      </div>

      <dl className="grid grid-cols-1 gap-1 text-sm sm:grid-cols-[14rem_1fr]">
        <dt className={bodyClasses}>{getMessage("officeApprovals.amountLabel")}</dt>
        <dd className="text-xs sm:text-sm">{amountText(row)}</dd>
        <dt className={bodyClasses}>{getMessage("officeApprovals.requesterLabel")}</dt>
        <dd className="text-xs sm:text-sm">
          {row.requesterName ?? getMessage("officeApprovals.requesterUnknown")}
        </dd>
        <dt className={bodyClasses}>{getMessage("officeApprovals.requestedAtLabel")}</dt>
        <dd className="text-xs sm:text-sm">{formatInstant(row.requestedAtEpochMs)}</dd>
        <dt className={bodyClasses}>{getMessage("officeApprovals.expiresAtLabel")}</dt>
        <dd className="text-xs sm:text-sm">{formatInstant(row.expiresAtEpochMs)}</dd>
        {row.ceoDecidedAtEpochMs === null ? null : (
          <>
            <dt className={bodyClasses}>{getMessage("officeApprovals.ceoDecisionLabel")}</dt>
            <dd className="text-xs sm:text-sm">
              {`${row.ceoDecidedByName ?? getMessage("officeApprovals.requesterUnknown")} ` +
                `- ${formatInstant(row.ceoDecidedAtEpochMs)}`}
            </dd>
          </>
        )}
        {row.superAdminConfirmedAtEpochMs === null ? null : (
          <>
            <dt className={bodyClasses}>{getMessage("officeApprovals.finalSignatureLabel")}</dt>
            <dd className="text-xs sm:text-sm">
              {`${row.superAdminConfirmedByName ?? getMessage("officeApprovals.requesterUnknown")} ` +
                `- ${formatInstant(row.superAdminConfirmedAtEpochMs)}`}
            </dd>
          </>
        )}
      </dl>

      <div>
        <p className={termClasses}>{getMessage("officeApprovals.noteLabel")}</p>
        <p className={noteClasses}>{row.note}</p>
      </div>

      {row.ceoNote === null ? null : (
        <div>
          <p className={termClasses}>{getMessage("officeApprovals.ceoNoteLabel")}</p>
          <p className={noteClasses}>{row.ceoNote}</p>
        </div>
      )}

      {row.superAdminNote === null ? null : (
        <div>
          <p className={termClasses}>{getMessage("officeApprovals.finalNoteLabel")}</p>
          <p className={noteClasses}>{row.superAdminNote}</p>
        </div>
      )}

      {form ?? null}
    </li>
  );
}

function QueueList({
  rows,
  emptySentence,
  actor,
}: {
  readonly rows: readonly ApprovalRequestView[];
  readonly emptySentence: string;
  readonly actor: RequestActor;
}): ReactNode {
  if (rows.length === 0) {
    return <p className={bodyClasses}>{emptySentence}</p>;
  }

  return (
    <ul className={listClasses}>
      {rows.map((row) => {
        const openStage = row.stage === "closed" ? null : row.stage;
        const problem =
          openStage === null
            ? "closed"
            : signatureProblemOf({
                roles: actor.roles,
                stage: openStage,
                actorId: actor.userId,
                requesterId: row.requesterId,
                ceoDeciderId: row.ceoDecidedById,
              });

        return (
          <DecisionRow
            key={row.id}
            row={row}
            form={
              problem === null && openStage !== null ? (
                <ApprovalDecisionForm approvalId={row.id} stage={openStage} />
              ) : null
            }
          />
        );
      })}
    </ul>
  );
}

export default async function CeoDashboardPage(): Promise<ReactNode> {
  const state = await readCeoState(getApprovalRuntime());

  return (
    <div className={pageClasses}>
      <header className={headerClasses}>
        <p className={eyebrowClasses}>{getMessage("officeApprovals.eyebrow")}</p>
        <h1 className={titleClasses}>{getMessage("officeApprovals.title")}</h1>
        <p className={descriptionClasses}>{getMessage("officeApprovals.description")}</p>
      </header>

      {state.kind === "ready" ? (
        <>
          <section aria-labelledby="ceo-queue" className={sectionClasses}>
            <h2 className={headingClasses} id="ceo-queue">
              {getMessage("officeApprovals.queueHeading")}
            </h2>
            <p className={bodyClasses}>{getMessage("officeApprovals.queueDescription")}</p>
            <QueueList
              actor={state.actor}
              emptySentence={getMessage("officeApprovals.queueEmpty")}
              rows={state.queue.awaitingCeo}
            />
          </section>

          <section aria-labelledby="ceo-next" className={sectionClasses}>
            <h2 className={headingClasses} id="ceo-next">
              {getMessage("officeApprovals.nextHeading")}
            </h2>
            <p className={bodyClasses}>{getMessage("officeApprovals.nextDescription")}</p>
            <QueueList
              actor={state.actor}
              emptySentence={getMessage("officeApprovals.nextEmpty")}
              rows={state.queue.awaitingSuperAdmin}
            />
          </section>

          <section aria-labelledby="ceo-raise" className={sectionClasses}>
            <h2 className={headingClasses} id="ceo-raise">
              {getMessage("officeApprovals.raiseHeading")}
            </h2>
            <p className={bodyClasses}>{getMessage("officeApprovals.raiseDescription")}</p>
            {state.queue.requestable.length === 0 ? (
              <p className={bodyClasses}>{getMessage("officeApprovals.cannotRaise")}</p>
            ) : (
              <ApprovalRequestForm requestable={state.queue.requestable} />
            )}
          </section>

          <section aria-labelledby="ceo-recent" className={sectionClasses}>
            <h2 className={headingClasses} id="ceo-recent">
              {getMessage("officeApprovals.recentHeading")}
            </h2>
            <p className={bodyClasses}>{getMessage("officeApprovals.recentDescription")}</p>
            {state.queue.recent.length === 0 ? (
              <p className={bodyClasses}>{getMessage("officeApprovals.recentEmpty")}</p>
            ) : (
              <ul className={listClasses}>
                {state.queue.recent.map((row) => (
                  <DecisionRow key={row.id} row={row} />
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="ceo-countries" className={sectionClasses}>
            <h2 className={headingClasses} id="ceo-countries">
              {getMessage("officeApprovals.countriesHeading")}
            </h2>
            <p className={bodyClasses}>
              {formatMessage("officeApprovals.countriesSummary", {
                enabled: state.decisions.countriesEnabled,
                disabled: state.decisions.countriesDisabled,
                sanctioned: state.decisions.countriesSanctioned,
              })}
            </p>
            <p className={bodyClasses}>{getMessage("officeApprovals.countriesNote")}</p>
          </section>

          <section aria-labelledby="ceo-kyc" className={sectionClasses}>
            <h2 className={headingClasses} id="ceo-kyc">
              {getMessage("officeApprovals.kycHeading")}
            </h2>
            <p className={bodyClasses}>
              {formatMessage("officeApprovals.kycCount", {
                count: state.decisions.kycAwaitingFinalDecision,
              })}
            </p>
            <p className={bodyClasses}>{getMessage("officeApprovals.kycNote")}</p>
          </section>
        </>
      ) : (
        <p className={alertClasses} role="alert">
          {state.kind === "signed-out"
            ? getMessage("officeApprovals.signedOut")
            : state.kind === "forbidden"
              ? getMessage("officeApprovals.forbidden")
              : getMessage("officeApprovals.unavailable")}
        </p>
      )}

      <nav className="border-t border-border pt-4 text-sm">
        <Link className={linkClasses} href="/admin">
          {getMessage("officeApprovals.home")}
        </Link>
      </nav>
    </div>
  );
}
