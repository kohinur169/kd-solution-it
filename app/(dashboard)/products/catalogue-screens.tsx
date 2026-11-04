// path: app/(dashboard)/products/catalogue-screens.tsx
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { SessionKeeper } from "@/components/auth/session-keeper";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { formatMessage, getMessage } from "@/lib/i18n/messages";
import {
  getCatalogueEntry,
  type CatalogueSnapshot,
} from "@/services/products/catalogue";
import {
  CATALOGUE_LIST_MAXIMUM_OFFSET,
  listCatalogueEntries,
  parseCatalogueListQuery,
  type CatalogueListPage,
  type CatalogueListQueryParameters,
} from "@/services/products/catalogue-list";
import { CATALOGUE_PATHS, type CatalogueKind } from "@/services/products/catalogue-fields";
import { readOwnerActor } from "../onboarding/owner-actor";
import { CatalogueForm } from "./catalogue-form";
import { DeleteCatalogueForm } from "./delete-catalogue-form";
import { CatalogueListTable } from "./catalogue-list-table";
import { CatalogueSearchForm } from "./catalogue-search-form";

/**
 * The three screens of section 15's two catalogues.
 *
 * ## Why one module renders both
 *
 * A product screen and a service screen print the same six facts and differ in the two sentences that
 * name the catalogue. Two files would be two copies of the actor reader, the four refusals, the layout
 * and the `SessionKeeper`, and the second copy is where a page quietly stops asking the service for
 * permission. The kind therefore arrives as an argument, the paths are derived from it, and both route
 * segments are three lines of wiring.
 *
 * ## Why the refusals are kept apart
 *
 * Signed out, not an owner, the store unavailable, and the row simply not there are four different
 * facts. A page that printed "not found" for an outage would tell a merchant their product was deleted,
 * and a page that printed a form to a visitor with no session would invite a post with nothing behind
 * it. Each state is worded as itself, and none of them restates a role: the service decides who may
 * read, the page only words the answer.
 */

/** The four facts a catalogue screen can be in. */
interface CatalogueListState {
  readonly kind: "signed-out" | "forbidden" | "unavailable" | "ready";
  readonly page: CatalogueListPage | null;
}

type ScreenState =
  | { readonly kind: "signed-out" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "not-found" }
  | { readonly kind: "ready"; readonly entry: CatalogueSnapshot };

/** The catalog title, per kind. */
function catalogueTitle(kind: CatalogueKind): string {
  return getMessage(kind === "product" ? "catalogue.productsTitle" : "catalogue.servicesTitle");
}

/** The catalog description, per kind. */
function catalogueDescription(kind: CatalogueKind): string {
  return getMessage(
    kind === "product" ? "catalogue.productsDescription" : "catalogue.servicesDescription",
  );
}

const linkClasses =
  "w-fit rounded-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-primary";

const primaryLinkClasses =
  "w-fit rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background focus-visible:ring-2 focus-visible:ring-primary";

const pagerLinkClasses =
  "rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary";

/**
 * The page frame: phone first, one column, and a column width that follows what is in it.
 *
 * A form is five stacked boxes and reads best narrow; a table of six columns needs the room, so the
 * list asks for a wider column and the forms keep the narrow one. Both grow from `px-4` on a phone to
 * `px-6` and `px-8`, so the frame is a thumb's width at 360 and a readable column on a desktop.
 */
function shell(children: ReactNode, width: "form" | "table" = "form"): ReactNode {
  return (
    <main className="min-h-dvh bg-background px-4 py-8 text-foreground sm:px-6 lg:px-8">
      {/* Section 22's rotating token: the page asks for a rotation, and the server decides. */}
      <SessionKeeper />
      <div
        className={`mx-auto flex w-full ${width === "table" ? "max-w-5xl" : "max-w-3xl"} flex-col gap-6`}
      >
        {children}
      </div>
    </main>
  );
}

/** The sentence of one refusal, worded apart so an outage never reads as a deletion. */
function refusalSentence(state: { readonly kind: string }): string {
  if (state.kind === "signed-out") {
    return getMessage("catalogue.signedOut");
  }

  if (state.kind === "forbidden") {
    return getMessage("catalogue.forbidden");
  }

  if (state.kind === "not-found") {
    return getMessage("catalogue.notFound");
  }

  return getMessage("catalogue.unavailable");
}

async function readEntry(kind: CatalogueKind, entryId: string): Promise<ScreenState> {
  const actorState = await readOwnerActor();

  if (actorState.kind === "anonymous") {
    return { kind: "signed-out" };
  }

  if (actorState.kind !== "actor") {
    return { kind: "unavailable" };
  }

  const runtime = getAuthRuntime();

  try {
    const entry = await getCatalogueEntry(
      { actor: actorState.actor, kind, entryId },
      { rest: runtime.rest, audit: runtime.audit },
    );

    return { kind: "ready", entry };
  } catch (error) {
    if (error instanceof AppError && error.code === "AUTHENTICATION_REQUIRED") {
      return { kind: "signed-out" };
    }

    if (error instanceof AppError && error.code === "PERMISSION_DENIED") {
      return { kind: "forbidden" };
    }

    if (error instanceof AppError && error.code === "RESOURCE_NOT_FOUND") {
      return { kind: "not-found" };
    }

    return { kind: "unavailable" };
  }
}

/** The parameters this screen reads; anything else in the address bar is ignored. */
function sourcesOf(parameters: CatalogueListQueryParameters): CatalogueListQueryParameters {
  const sources: Record<string, string> = {};

  for (const name of ["search", "offset"] as const) {
    const value = parameters[name];

    if (typeof value === "string") {
      sources[name] = value;
    }
  }

  return sources;
}

async function readCatalogueListState(
  kind: CatalogueKind,
  parameters: CatalogueListQueryParameters,
): Promise<CatalogueListState> {
  const actorState = await readOwnerActor();

  if (actorState.kind === "anonymous") {
    return { kind: "signed-out", page: null };
  }

  if (actorState.kind !== "actor") {
    return { kind: "unavailable", page: null };
  }

  const runtime = getAuthRuntime();

  try {
    const page = await listCatalogueEntries(
      { actor: actorState.actor, kind, query: parseCatalogueListQuery(sourcesOf(parameters)) },
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

/** One page of the list: the search phrase and one offset make one address. */
function hrefOf(kind: CatalogueKind, search: string | null, offset: number): string {
  const path = `/${CATALOGUE_PATHS[kind]}`;
  const parts: string[] = [];

  if (search !== null) {
    parts.push(`search=${encodeURIComponent(search)}`);
  }

  if (offset > 0) {
    parts.push(`offset=${String(offset)}`);
  }

  return parts.length === 0 ? path : `${path}?${parts.join("&")}`;
}

function emptyMessageOf(kind: CatalogueKind, page: CatalogueListPage): string {
  if (page.search !== null) {
    return getMessage("catalogue.listNoMatches");
  }

  return getMessage(kind === "product" ? "catalogue.listEmptyProducts" : "catalogue.listEmptyServices");
}

/**
 * Section 15's paginated catalogue list with search: the hub of one catalogue.
 *
 * ## Why this replaced STEP 108's hub
 *
 * STEP 108 shipped a hub with two links because it delivered the create and edit screens and the list
 * belonged to this STEP. The list is now the hub: the same address, the same heading, and the rows a
 * merchant came to see instead of a menu of the things they could do to rows that were not shown.
 * `/new` is still one button away and the other catalogue is still one link away.
 *
 * ## Why the state is one value and not four flags
 *
 * Signed out, not an owner, the list unavailable and the list itself are four different facts and each
 * is worded as itself. Printing an empty table for a visitor with no session would invite a post with
 * nothing behind it, and printing "no products yet" for an outage would tell a merchant their
 * catalogue was erased. The refusal sentences are the catalog's and the rule behind them is the
 * service's: this page restates neither the roles nor the scope.
 *
 * ## Why the address bar is the state
 *
 * The search phrase and the offset are read from the request the framework already has, so the links
 * the pager prints are the query the next page will run - there is no second copy of them between the
 * page and the service. A refused value is printed beside the rows rather than thrown, because a
 * mistyped search that narrowed wrong is worse than one that narrowed nothing.
 */
export async function CatalogueHub({
  kind,
  searchParams,
}: {
  readonly kind: CatalogueKind;
  readonly searchParams: CatalogueListQueryParameters;
}): Promise<ReactNode> {
  const state = await readCatalogueListState(kind, searchParams);
  const page = state.page;
  const path = `/${CATALOGUE_PATHS[kind]}`;

  return shell(
    <>
      <header className="flex flex-col gap-2">
        <p className="text-sm font-medium text-muted-foreground">{getMessage("catalogue.eyebrow")}</p>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{catalogueTitle(kind)}</h1>
        <p className="text-sm text-muted-foreground">{catalogueDescription(kind)}</p>
      </header>

      {state.kind === "ready" && page !== null ? (
        <>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <CatalogueSearchForm filters={{ search: page.search }} kind={kind} problems={page.problems} />
            <div className="flex flex-wrap items-center gap-2">
              <Link className={primaryLinkClasses} href={`${path}/new`}>
                {getMessage(kind === "product" ? "catalogue.addProduct" : "catalogue.addService")}
              </Link>
              {/* Section 15's CSV import: a merchant with a price list goes here rather than adding
                  forty rows by hand. */}
              <Link className={pagerLinkClasses} href={`${path}/import`}>
                {getMessage(
                  kind === "product" ? "catalogue.importLinkProducts" : "catalogue.importLinkServices",
                )}
              </Link>
            </div>
          </div>

          {page.problems.some((problem) => problem.field === "offset") ? (
            <p className="text-xs text-destructive" role="alert">
              {getMessage("catalogue.offsetProblem")}
            </p>
          ) : null}

          <section aria-labelledby="catalogue-list" className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold tracking-tight" id="catalogue-list">
              {getMessage(kind === "product" ? "catalogue.listHeadingProducts" : "catalogue.listHeadingServices")}
            </h2>
            <p className="text-sm text-muted-foreground">
              {page.search === null
                ? formatMessage("catalogue.listSummary", {
                    count: page.entries.length,
                    page: page.pageNumber,
                  })
                : formatMessage("catalogue.listSummarySearch", {
                    count: page.entries.length,
                    page: page.pageNumber,
                    search: page.search,
                  })}
            </p>

            {page.entries.length === 0 ? (
              <p className="text-sm text-muted-foreground">{emptyMessageOf(kind, page)}</p>
            ) : (
              <CatalogueListTable entries={page.entries} kind={kind} />
            )}

            <nav aria-label={getMessage("catalogue.paginationLabel")} className="flex flex-wrap items-center gap-3 text-sm">
              {page.previousOffset === null ? null : (
                <Link className={pagerLinkClasses} href={hrefOf(kind, page.search, page.previousOffset)} rel="prev">
                  {getMessage("catalogue.paginationNewer")}
                </Link>
              )}
              {page.nextOffset === null ? null : (
                <Link className={pagerLinkClasses} href={hrefOf(kind, page.search, page.nextOffset)} rel="next">
                  {getMessage("catalogue.paginationOlder")}
                </Link>
              )}
              {page.entries.length === 0 ? null : (
                <span className="text-muted-foreground">
                  {formatMessage("catalogue.paginationPosition", {
                    from: page.offset + 1,
                    to: page.offset + page.entries.length,
                  })}
                </span>
              )}
              {page.nextOffset === null && page.offset >= CATALOGUE_LIST_MAXIMUM_OFFSET ? (
                <span className="text-muted-foreground">{getMessage("catalogue.paginationLimit")}</span>
              ) : null}
            </nav>
          </section>
        </>
      ) : (
        <p className="text-sm text-destructive" role="alert">
          {refusalSentence(state)}
        </p>
      )}

      <nav className="flex flex-col gap-2 border-t border-border pt-4 text-sm">
        {state.kind === "signed-out" ? (
          <Link className={linkClasses} href="/signin">
            {getMessage("catalogue.signInLink")}
          </Link>
        ) : null}
        <Link className={linkClasses} href={`/${CATALOGUE_PATHS[kind === "product" ? "service" : "product"]}`}>
          {kind === "product" ? getMessage("catalogue.backToServices") : getMessage("catalogue.backToProducts")}
        </Link>
        <Link className={linkClasses} href="/">
          {getMessage("catalogue.homeLink")}
        </Link>
      </nav>
    </>,
    "table",
  );
}

/** The create screen of one catalogue. */
export function CatalogueCreateScreen({ kind }: { readonly kind: CatalogueKind }): ReactNode {
  return shell(
    <>
      <header className="flex flex-col gap-2">
        <p className="text-sm font-medium text-muted-foreground">{getMessage("catalogue.eyebrow")}</p>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          {getMessage(kind === "product" ? "catalogue.productNewTitle" : "catalogue.serviceNewTitle")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {getMessage(
            kind === "product" ? "catalogue.productNewDescription" : "catalogue.serviceNewDescription",
          )}
        </p>
      </header>

      {/* The form carries its own way back, so this screen adds none: two identical links on one page
          read as two different destinations. */}
      <CatalogueForm
        creating
        initial={null}
        kind={kind}
        savePath={`/api/${CATALOGUE_PATHS[kind]}`}
      />
    </>,
  );
}

/** The edit screen of one catalogue, with the four refusals worded apart. */
export async function CatalogueEditScreen({
  kind,
  entryId,
}: {
  readonly kind: CatalogueKind;
  readonly entryId: string;
}): Promise<ReactNode> {
  const state = await readEntry(kind, entryId);
  const path = `/${CATALOGUE_PATHS[kind]}`;

  return shell(
    <>
      <header className="flex flex-col gap-2">
        <p className="text-sm font-medium text-muted-foreground">{getMessage("catalogue.eyebrow")}</p>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          {getMessage(kind === "product" ? "catalogue.productEditTitle" : "catalogue.serviceEditTitle")}
        </h1>
        <p className="text-sm text-muted-foreground">{getMessage("catalogue.editDescription")}</p>
      </header>

      {state.kind === "ready" ? (
        <>
          <CatalogueForm
            creating={false}
            initial={state.entry}
            kind={kind}
            savePath={`/api/${CATALOGUE_PATHS[kind]}/${state.entry.id}`}
          />
          {/* Only a row that was read may be removed: a refusal above prints no button, because a
              removal the reader cannot see the target of is a removal they cannot confirm. */}
          <DeleteCatalogueForm
            entryId={state.entry.id}
            entryName={state.entry.values.name}
            kind={kind}
          />
        </>
      ) : (
        <p className="text-sm text-destructive" role="alert">
          {refusalSentence(state)}
        </p>
      )}

      <nav className="flex flex-col gap-2 border-t border-border pt-4 text-sm">
        {state.kind === "signed-out" ? (
          <Link className={linkClasses} href="/signin">
            {getMessage("catalogue.signInLink")}
          </Link>
        ) : null}
        <Link className={linkClasses} href={path}>
          {getMessage(kind === "product" ? "catalogue.backToProducts" : "catalogue.backToServices")}
        </Link>
        <Link className={linkClasses} href="/">
          {getMessage("catalogue.homeLink")}
        </Link>
      </nav>
    </>,
  );
}

/** The page metadata of one catalogue screen. */
export function catalogueMetadata(kind: CatalogueKind, screen: "hub" | "new" | "edit"): Metadata {
  if (screen === "hub") {
    return { title: catalogueTitle(kind), description: catalogueDescription(kind) };
  }

  const title =
    screen === "new"
      ? kind === "product"
        ? getMessage("catalogue.productNewTitle")
        : getMessage("catalogue.serviceNewTitle")
      : kind === "product"
        ? getMessage("catalogue.productEditTitle")
        : getMessage("catalogue.serviceEditTitle");

  return { title, description: getMessage("catalogue.editDescription") };
}
