// path: app/(admin)/audit-log/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  auditFieldLabelKey,
  auditProblemMessageKey,
  auditQueryStringOf,
  isUuid,
  parseAuditQuery,
  type AuditFilterProblem,
  type AuditFilters,
  type AuditQueryParameters,
} from "@/lib/audit-log/registry";
import { getAuditLogRuntime } from "@/lib/audit-log/runtime";
import {
  listAuditEntries,
  verifyAuditChain,
  type AuditChainOption,
  type AuditChainVerification,
  type AuditLogPage,
} from "@/lib/audit-log/service";
import { AppError } from "@/lib/errors/app-error";
import { formatMessage, getMessage } from "@/lib/i18n/messages";
import { readOfficeActor } from "../office-actor";
import { AuditFilterForm } from "./audit-filter-form";
import { AuditLogTable } from "./audit-log-table";

export const metadata: Metadata = {
  title: getMessage("officeAudit.title"),
  description: getMessage("officeAudit.description"),
};

/**
 * Section 33's audit log viewer.
 *
 * ## Why the screen is one read and one optional check
 *
 * The page reads one window of `audit_logs` under the filters the address bar carries. The check - the
 * walk down one chain - is offered per chain rather than run on every render, because it is the one
 * expensive question here: it recomputes the hash of every row of a chain, so a viewer that ran it on
 * each load would turn paging through a month of history into a month of hashing. It is a link, which
 * makes the act a read: no token, no request body, and a bookmark that carries the filters it was
 * asked with.
 *
 * ## Why the refusals are the service's answer and not a second rule
 *
 * There is no role list in this file. The service is called, and `PERMISSION_DENIED` becomes the
 * refusal sentence - the same rule `0074` grants the select to, asked in the same place the query is
 * built. A screen that restated the three roles could hide a screen the service would have served.
 *
 * ## Why a refused filter is shown and not corrected
 *
 * `parseAuditQuery` drops a value it cannot read and reports it. The page prints the report beside the
 * rows it did read, so a mistyped day narrows nothing rather than quietly narrowing something else -
 * the failure mode a silent fallback would hide.
 *
 * ## Why the day is the platform's
 *
 * Every instant in this log was written by the platform's own clock. The range filter is therefore a
 * range of UTC days, and the page prints each instant with its `UTC` suffix rather than converting it
 * to the reader's local time, because two officers reading one row must be reading one fact.
 */

type AuditLogStateKind = "signed-out" | "forbidden" | "unavailable" | "ready";

interface VerificationState {
  readonly kind: "none" | "failed" | "ready";
  readonly result: AuditChainVerification | null;
  readonly chainId: string | null;
}

interface AuditLogState {
  readonly kind: AuditLogStateKind;
  readonly snapshot: AuditLogPage | null;
  readonly verification: VerificationState;
}

const noVerification: VerificationState = { kind: "none", result: null, chainId: null };

function stateOf(
  kind: AuditLogStateKind,
  snapshot: AuditLogPage | null,
  verification: VerificationState = noVerification,
): AuditLogState {
  return { kind, snapshot, verification };
}

/** The address one set of filters and one offset make, with the optional check kept beside them. */
function hrefOf(filters: AuditFilters, offset: number, verify: string | null = null): string {
  const query = auditQueryStringOf(filters, offset);
  const parts = query.length === 0 ? [] : [query];

  if (verify !== null) {
    parts.push(`verify=${encodeURIComponent(verify)}`);
  }

  return parts.length === 0 ? "/audit-log" : `/audit-log?${parts.join("&")}`;
}

async function readAuditLogState(
  parameters: AuditQueryParameters,
  verifyChainId: string,
): Promise<AuditLogState> {
  const actorState = await readOfficeActor();

  if (actorState.kind === "anonymous") {
    return stateOf("signed-out", null);
  }

  if (actorState.kind !== "actor") {
    return stateOf("unavailable", null);
  }

  const actor = actorState.actor;
  const runtime = getAuditLogRuntime();
  let snapshot: AuditLogPage;

  try {
    // The filters are read from the request itself, so the query the screen renders is exactly the
    // query the address bar carries - there is no second copy of them between the two.
    snapshot = await listAuditEntries({ actor, query: parseAuditQuery(parameters) }, runtime);
  } catch (error) {
    if (error instanceof AppError && error.code === "AUTHENTICATION_REQUIRED") {
      return stateOf("signed-out", null);
    }

    if (error instanceof AppError && error.code === "PERMISSION_DENIED") {
      return stateOf("forbidden", null);
    }

    return stateOf("unavailable", null);
  }

  if (!isUuid(verifyChainId)) {
    return stateOf("ready", snapshot);
  }

  try {
    const result = await verifyAuditChain({ actor, chainId: verifyChainId }, runtime);

    return stateOf("ready", snapshot, { kind: "ready", result, chainId: verifyChainId });
  } catch (error) {
    if (error instanceof AppError && error.code === "PERMISSION_DENIED") {
      return stateOf("forbidden", null);
    }

    return stateOf("ready", snapshot, { kind: "failed", result: null, chainId: verifyChainId });
  }
}

const pageClasses = "flex flex-col gap-8";

const headerClasses = "flex flex-col gap-2";

const sectionClasses = "flex flex-col gap-3";

const eyebrowClasses = "text-xs font-semibold uppercase tracking-widest text-muted-foreground";

const titleClasses = "text-2xl font-semibold tracking-tight sm:text-3xl";

const headingClasses = "text-xl font-semibold tracking-tight";

const descriptionClasses = "max-w-3xl text-sm text-muted-foreground sm:text-base";

const noteClasses = "max-w-3xl text-xs text-muted-foreground";

const alertClasses = "text-sm text-destructive";

const problemListClasses = "flex list-disc flex-col gap-1 pl-5 text-sm text-destructive";

const chainListClasses = "flex flex-col gap-2 text-sm";

const chainItemClasses = "flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border pb-2";

const linkClasses =
  "w-fit rounded-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-primary";

const pagerClasses = "flex flex-wrap items-center gap-x-6 gap-y-2 text-sm";

function problemLine(problem: AuditFilterProblem): string {
  return formatMessage("officeAudit.problemLine", {
    field: getMessage(auditFieldLabelKey(problem.field)),
    problem: getMessage(auditProblemMessageKey(problem)),
  });
}

function chainLabel(chain: AuditChainOption): string {
  return chain.companyId === null
    ? getMessage("officeAudit.platformChain")
    : formatMessage("officeAudit.merchantChain", { company: chain.companyId.slice(0, 8) });
}

function instantOf(epochMs: number): string {
  return new Date(epochMs).toISOString().replace("T", " ").slice(0, 19);
}

function verificationLine(verification: VerificationState): string {
  const result = verification.result;

  if (verification.kind !== "ready" || result === null) {
    return getMessage("officeAudit.verifyUnavailable");
  }

  if (!result.isValid) {
    return formatMessage("officeAudit.verifiedBroken", {
      sequence: result.firstBrokenSequence ?? 0,
      reason: result.brokenReason ?? getMessage("officeAudit.brokenReasonUnknown"),
    });
  }

  if (result.checkedRows === 0) {
    return getMessage("officeAudit.verifiedEmpty");
  }

  return formatMessage("officeAudit.verifiedOk", {
    count: result.checkedRows,
    sequence: result.headSequence ?? 0,
    hash: (result.headHash ?? "").slice(0, 12),
  });
}

/**
 * The office audit log screen.
 *
 * Two parameters matter: the filters, which are spelled the way `auditQueryStringOf` spells them, and
 * `verify`, which names one chain to check. Everything else in the address bar is ignored rather than
 * rejected, so a link that once carried a parameter this screen no longer reads still opens the page.
 */
export default async function AuditLogScreen({
  searchParams,
}: {
  readonly searchParams: Promise<AuditQueryParameters>;
}): Promise<ReactNode> {
  const parameters = await searchParams;
  const verifyParameter = parameters["verify"];
  const verifyChainId = (typeof verifyParameter === "string" ? verifyParameter : "").trim().toLowerCase();
  const state = await readAuditLogState(parameters, verifyChainId);
  const snapshot = state.snapshot;

  if (snapshot === null) {
    return (
      <div className={pageClasses}>
        <header className={headerClasses}>
          <p className={eyebrowClasses}>{getMessage("officeAudit.eyebrow")}</p>
          <h1 className={titleClasses}>{getMessage("officeAudit.title")}</h1>
          <p className={descriptionClasses}>{getMessage("officeAudit.description")}</p>
        </header>

        <p className={alertClasses} role="alert">
          {state.kind === "signed-out"
            ? getMessage("officeAudit.signedOut")
            : state.kind === "forbidden"
              ? getMessage("officeAudit.forbidden")
              : getMessage("officeAudit.unavailable")}
        </p>

        <nav className="border-t border-border pt-4 text-sm">
          <Link className={linkClasses} href="/admin">
            {getMessage("officeAudit.home")}
          </Link>
        </nav>
      </div>
    );
  }

  const newerOffset = snapshot.previousOffset;
  const olderOffset = snapshot.nextOffset;

  return (
    <div className={pageClasses}>
      <header className={headerClasses}>
        <p className={eyebrowClasses}>{getMessage("officeAudit.eyebrow")}</p>
        <h1 className={titleClasses}>{getMessage("officeAudit.title")}</h1>
        <p className={descriptionClasses}>{getMessage("officeAudit.description")}</p>
        <p className={noteClasses}>{getMessage("officeAudit.readOnlyNote")}</p>
        <p className={noteClasses}>{getMessage("officeAudit.hashNote")}</p>
      </header>

      <section aria-labelledby="audit-filters" className={sectionClasses}>
        <h2 className={headingClasses} id="audit-filters">
          {getMessage("officeAudit.filtersHeading")}
        </h2>
        <p className={descriptionClasses}>{getMessage("officeAudit.filtersDescription")}</p>
        <AuditFilterForm filters={snapshot.filters} />
      </section>

      {snapshot.problems.length === 0 ? null : (
        <section aria-labelledby="audit-problems" className={sectionClasses}>
          <h2 className={headingClasses} id="audit-problems">
            {getMessage("officeAudit.problemsHeading")}
          </h2>
          <ul className={problemListClasses}>
            {snapshot.problems.map((problem) => (
              <li key={`${problem.field}-${problem.rule}`}>{problemLine(problem)}</li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="audit-events" className={sectionClasses}>
        <h2 className={headingClasses} id="audit-events">
          {getMessage("officeAudit.pageHeading")}
        </h2>
        <p className={descriptionClasses}>
          {formatMessage("officeAudit.pageSummary", {
            count: snapshot.entries.length,
            offset: snapshot.offset,
          })}
        </p>
        <p className={noteClasses}>
          {formatMessage("officeAudit.pageReadAt", { at: instantOf(snapshot.readAtEpochMs) })}
        </p>

        {snapshot.entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">{getMessage("officeAudit.pageEmpty")}</p>
        ) : (
          <AuditLogTable entries={snapshot.entries} />
        )}

        <nav className={pagerClasses}>
          {newerOffset === null ? null : (
            <Link className={linkClasses} href={hrefOf(snapshot.filters, newerOffset)}>
              {getMessage("officeAudit.paginationNewer")}
            </Link>
          )}
          {olderOffset === null ? null : (
            <Link className={linkClasses} href={hrefOf(snapshot.filters, olderOffset)}>
              {getMessage("officeAudit.paginationOlder")}
            </Link>
          )}
          {snapshot.entries.length === 0 ? null : (
            <span className="text-muted-foreground">
              {formatMessage("officeAudit.paginationPosition", {
                from: snapshot.offset + 1,
                to: snapshot.offset + snapshot.entries.length,
              })}
            </span>
          )}
        </nav>
      </section>

      {snapshot.chains.length === 0 && state.verification.kind === "none" ? null : (
        <section aria-labelledby="audit-chains" className={sectionClasses}>
          <h2 className={headingClasses} id="audit-chains">
            {getMessage("officeAudit.chainHeading")}
          </h2>
          <p className={descriptionClasses}>{getMessage("officeAudit.chainDescription")}</p>

          {state.verification.kind === "none" ? null : (
            <div className="flex flex-col gap-1 rounded-lg border border-border p-4">
              <p className="text-sm font-semibold">{verificationLine(state.verification)}</p>
              {state.verification.result === null ? null : (
                <p className={noteClasses}>
                  {formatMessage("officeAudit.verifiedAt", {
                    at: instantOf(state.verification.result.checkedAtEpochMs),
                  })}
                </p>
              )}
            </div>
          )}

          {snapshot.chains.length === 0 ? null : (
            <>
              <p className="text-sm font-medium">{getMessage("officeAudit.chainList")}</p>
              <ul className={chainListClasses}>
                {snapshot.chains.map((chain) => (
                  <li className={chainItemClasses} key={chain.chainId}>
                    <span className="font-medium">{chainLabel(chain)}</span>
                    <Link className={linkClasses} href={hrefOf(snapshot.filters, snapshot.offset, chain.chainId)}>
                      {getMessage("officeAudit.verifySubmit")}
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      <nav className="border-t border-border pt-4 text-sm">
        <Link className={linkClasses} href="/admin">
          {getMessage("officeAudit.home")}
        </Link>
      </nav>
    </div>
  );
}
