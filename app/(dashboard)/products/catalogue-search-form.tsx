// path: app/(dashboard)/products/catalogue-search-form.tsx
import Link from "next/link";
import type { ReactNode } from "react";
import { formatMessage, getMessage } from "@/lib/i18n/messages";
import type { MessagePath } from "@/lib/i18n/messages";
import {
  CATALOGUE_SEARCH_MAXIMUM_LENGTH,
  type CatalogueListFilters,
  type CatalogueListProblem,
} from "@/services/products/catalogue-list";
import { CATALOGUE_PATHS, type CatalogueKind } from "@/services/products/catalogue-fields";

/**
 * The catalogue list's search form.
 *
 * ## Why it is a plain GET form
 *
 * A search asks the list a different question; it does not change a row. That makes it a read, so it
 * belongs in the address bar: the screen is bookmarkable, a colleague can be sent the exact search,
 * and the server renders the answer without a round trip through a client component, a fetch and a
 * token - none of which a read needs. That is also why there is no hidden `offset` field: pressing the
 * button is a new question, and a new question starts at the newest entry rather than at the depth the
 * previous answer had reached.
 *
 * ## Why a refused value is explained here and not silently corrected
 *
 * The service drops a term outside its alphabet and reports it. If this form quietly trimmed the value
 * to fit, a merchant searching for `a,b` would be shown a list they did not ask for with no word about
 * why. The sentence naming the allowed characters is therefore printed under the field, and the field
 * keeps what was typed so it can be fixed.
 */

const labelClasses = "flex flex-col gap-1";

const fieldNameClasses = "text-xs font-semibold uppercase tracking-widest text-muted-foreground";

const inputClasses =
  "w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary";

const submitClasses =
  "w-fit rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-primary";

const clearClasses =
  "w-fit rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary";

const problemClasses = "text-xs text-destructive";

const PROBLEM_KEYS: Readonly<Record<CatalogueListProblem["rule"], MessagePath>> = Object.freeze({
  too_long: "catalogue.searchProblemTooLong",
  invalid_format: "catalogue.searchProblemInvalidFormat",
});

interface CatalogueSearchFormProps {
  readonly kind: CatalogueKind;
  readonly filters: CatalogueListFilters;
  readonly problems: readonly CatalogueListProblem[];
}

export function CatalogueSearchForm({ kind, filters, problems }: CatalogueSearchFormProps): ReactNode {
  const searchProblem = problems.find((problem) => problem.field === "search");
  const path = `/${CATALOGUE_PATHS[kind]}`;

  return (
    <form action={path} className="flex flex-col gap-3 sm:flex-row sm:items-end" method="get" role="search">
      <label className={labelClasses}>
        <span className={fieldNameClasses}>{getMessage("catalogue.searchLabel")}</span>
        <input
          autoComplete="off"
          className={inputClasses}
          defaultValue={filters.search ?? ""}
          maxLength={CATALOGUE_SEARCH_MAXIMUM_LENGTH}
          name="search"
          placeholder={getMessage("catalogue.searchPlaceholder")}
          spellCheck={false}
          type="search"
        />
        <span className="text-xs text-muted-foreground">
          {formatMessage("catalogue.searchHint", { maximum: CATALOGUE_SEARCH_MAXIMUM_LENGTH })}
        </span>
        {searchProblem === undefined ? null : (
          <span className={problemClasses} role="alert">
            {getMessage(PROBLEM_KEYS[searchProblem.rule])}
          </span>
        )}
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <button className={submitClasses} type="submit">
          {getMessage("catalogue.searchSubmit")}
        </button>
        {filters.search === null ? null : (
          <Link className={clearClasses} href={path}>
            {getMessage("catalogue.searchClear")}
          </Link>
        )}
      </div>
    </form>
  );
}
