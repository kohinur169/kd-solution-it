// path: app/(dashboard)/clients/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { SessionKeeper } from "@/components/auth/session-keeper";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { formatMessage, getMessage } from "@/lib/i18n/messages";
import {
  CLIENT_LIST_MAXIMUM_OFFSET,
  listClients,
  parseClientListQuery,
  type ClientListPage,
  type ClientListQueryParameters,
} from "@/services/clients/client-list";
import { readOwnerActor } from "../onboarding/owner-actor";
import { ClientListTable } from "./client-list-table";
import { ClientSearchForm } from "./client-search-form";

export const metadata: Metadata = {
  title: getMessage("clients.title"),
  description: getMessage("clients.description"),
};

/** Read per request, so the row a merchant saved in another tab is on the next page view. */
export const dynamic = "force-dynamic";

/**
 * Section 15's paginated client list with search: the hub of the client area.
 *
 * ## Why the state is one value and not four flags
 *
 * Signed out, not an owner, the list unavailable and the list itself are four different facts and
 * each is worded as itself. Printing an empty table for a signed out visitor would invite a form
 * post with no session behind it, and printing "not found" for an outage would tell a merchant their
 * clients are gone. The refusal sentences are the catalog's and the rule behind them is the
 * service's: this page restates neither the roles nor the scope.
 *
 * ## Why the address bar is the state
 *
 * The search phrase and the offset are read from the request the framework already has, so the
 * links the pager prints are the query the next page will run - there is no second copy of them
 * between the page and the service. A refused value is printed beside the rows rather than thrown,
 * because a mistyped search that narrowed wrong is worse than one that narrowed nothing.
 *
 * ## Why the dates are UTC
 *
 * Every instant in `0019` is the platform's clock. The list prints it with its `UTC` suffix rather
 * than converting it to the reader's time zone, so two people looking at one row are looking at one
 * fact.
 */

type ClientListStateKind = "signed-out" | "forbidden" | "unavailable" | "ready";

interface ClientListState {
  readonly kind: ClientListStateKind;
  readonly page: ClientListPage | null;
}

/** The parameters this screen reads; anything else in the address bar is ignored. */
function sourcesOf(parameters: ClientListQueryParameters): ClientListQueryParameters {
  const sources: Record<string, string> = {};

  for (const name of ["search", "offset"] as const) {
    const value = parameters[name];

    if (typeof value === "string") {
      sources[name] = value;
    } else if (Array.isArray(value) && value.length > 0) {
      sources[name] = value[0] ?? "";
    }
  }

  return sources;
}

async function readClientListState(parameters: ClientListQueryParameters): Promise<ClientListState> {
  const actorState = await readOwnerActor();

  if (actorState.kind === "anonymous") {
    return { kind: "signed-out", page: null };
  }

  if (actorState.kind !== "actor") {
    return { kind: "unavailable", page: null };
  }

  const runtime = getAuthRuntime();

  try {
    const page = await listClients(
      { actor: actorState.actor, query: parseClientListQuery(sourcesOf(parameters)) },
      { rest: runtime.rest },
    );

    return { kind: "ready", page };
  } catch (error) {
    if (error instanceof AppError && error.code === "AUTHENTICATION_REQUIRED") {
      return { kind: "signed-out", page: null };
    }

    if (error instanceof AppError && error.code === "PERMISSION_DENIED") {
      return { kind: "forbidden", page: null };
    }

    return { kind: "unavailable", page: null };
  }
}

const pageClasses = "mx-auto flex w-full max-w-5xl flex-col gap-6";

const linkClasses =
  "w-fit rounded-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-primary";

const primaryLinkClasses =
  "w-fit rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background focus-visible:ring-2 focus-visible:ring-primary";

const secondaryLinkClasses =
  "w-fit rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary";

const pagerLinkClasses =
  "rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary";

/** One page of the list: the search phrase and one offset make one address. */
function hrefOf(search: string | null, offset: number): string {
  const parts: string[] = [];

  if (search !== null) {
    parts.push(`search=${encodeURIComponent(search)}`);
  }

  if (offset > 0) {
    parts.push(`offset=${String(offset)}`);
  }

  return parts.length === 0 ? "/clients" : `/clients?${parts.join("&")}`;
}

function emptyMessage(page: ClientListPage): string {
  return page.search === null ? getMessage("clients.listEmpty") : getMessage("clients.listNoMatches");
}

export default async function ClientsPage({
  searchParams,
}: {
  readonly searchParams: Promise<ClientListQueryParameters>;
}): Promise<ReactNode> {
  const parameters = await searchParams;
  const state = await readClientListState(parameters);
  const page = state.page;

  return (
    <main className="min-h-dvh bg-background px-4 py-8 text-foreground sm:px-6 lg:px-8">
      {/* Section 22's rotating token: the page asks for a rotation, and the server decides. */}
      <SessionKeeper />
      <div className={pageClasses}>
        <header className="flex flex-col gap-2">
          <p className="text-sm font-medium text-muted-foreground">{getMessage("clients.eyebrow")}</p>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{getMessage("clients.title")}</h1>
          <p className="text-sm text-muted-foreground">{getMessage("clients.description")}</p>
        </header>

        {state.kind === "ready" && page !== null ? (
          <>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <ClientSearchForm filters={{ search: page.search }} problems={page.problems} />
              <div className="flex flex-wrap items-center gap-2">
                <Link className={primaryLinkClasses} href="/clients/new">
                  {getMessage("clients.addClient")}
                </Link>
                {/* Section 15's CSV import: a merchant with a spreadsheet goes here rather than adding
                    forty clients by hand. */}
                <Link className={secondaryLinkClasses} href="/clients/import">
                  {getMessage("clients.importLink")}
                </Link>
              </div>
            </div>

            {page.problems.some((problem) => problem.field === "offset") ? (
              <p className="text-xs text-destructive" role="alert">
                {getMessage("clients.offsetProblem")}
              </p>
            ) : null}

            <section aria-labelledby="client-list" className="flex flex-col gap-3">
              <h2 className="text-lg font-semibold tracking-tight" id="client-list">
                {getMessage("clients.listHeading")}
              </h2>
              <p className="text-sm text-muted-foreground">
                {page.search === null
                  ? formatMessage("clients.listSummary", {
                      count: page.clients.length,
                      page: page.pageNumber,
                    })
                  : formatMessage("clients.listSummarySearch", {
                      count: page.clients.length,
                      page: page.pageNumber,
                      search: page.search,
                    })}
              </p>

              {page.clients.length === 0 ? (
                <p className="text-sm text-muted-foreground">{emptyMessage(page)}</p>
              ) : (
                <ClientListTable clients={page.clients} />
              )}

              <nav aria-label={getMessage("clients.paginationLabel")} className="flex flex-wrap items-center gap-3 text-sm">
                {page.previousOffset === null ? null : (
                  <Link className={pagerLinkClasses} href={hrefOf(page.search, page.previousOffset)} rel="prev">
                    {getMessage("clients.paginationNewer")}
                  </Link>
                )}
                {page.nextOffset === null ? null : (
                  <Link className={pagerLinkClasses} href={hrefOf(page.search, page.nextOffset)} rel="next">
                    {getMessage("clients.paginationOlder")}
                  </Link>
                )}
                {page.clients.length === 0 ? null : (
                  <span className="text-muted-foreground">
                    {formatMessage("clients.paginationPosition", {
                      from: page.offset + 1,
                      to: page.offset + page.clients.length,
                    })}
                  </span>
                )}
                {page.nextOffset === null && page.offset >= CLIENT_LIST_MAXIMUM_OFFSET ? (
                  <span className="text-muted-foreground">{getMessage("clients.paginationLimit")}</span>
                ) : null}
              </nav>
            </section>
          </>
        ) : (
          <p className="text-sm text-destructive" role="alert">
            {state.kind === "signed-out"
              ? getMessage("clients.signedOut")
              : state.kind === "forbidden"
                ? getMessage("clients.forbidden")
                : getMessage("clients.unavailable")}
          </p>
        )}

        <nav className="flex flex-col gap-2 border-t border-border pt-4 text-sm">
          {state.kind === "signed-out" ? (
            <Link className={linkClasses} href="/signin">
              {getMessage("clients.signInLink")}
            </Link>
          ) : null}
          <Link className={linkClasses} href="/onboarding">
            {getMessage("onboardingReview.backLink")}
          </Link>
          <Link className={linkClasses} href="/">
            {getMessage("clients.homeLink")}
          </Link>
        </nav>
      </div>
    </main>
  );
}
