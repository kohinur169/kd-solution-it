// path: app/(dashboard)/clients/client-search-form.tsx
import Link from "next/link";
import type { ReactNode } from "react";
import {
  CLIENT_SEARCH_MAXIMUM_LENGTH,
  type ClientListFilters,
  type ClientListProblem,
} from "@/services/clients/client-list";
import { formatMessage, getMessage } from "@/lib/i18n/messages";
import type { MessagePath } from "@/lib/i18n/messages";

/**
 * The client list's search form.
 *
 * ## Why it is a plain GET form
 *
 * A search asks the list a different question; it does not change a row. That makes it a read, so
 * it belongs in the address bar: the screen is bookmarkable, a colleague can be sent the exact
 * search, and the server renders the answer without a round trip through a client component, a
 * fetch and a token - none of which a read needs. That is also why there is no hidden `offset`
 * field: pressing the button is a new question, and a new question starts at the newest row rather
 * than at the depth the previous answer had reached.
 *
 * ## Why a refused value is explained here and not silently corrected
 *
 * The service drops a term outside its alphabet and reports it. If this form quietly trimmed the
 * value to fit, a merchant searching for `a,b` would be shown a list they did not ask for with no
 * word about why. The sentence naming the allowed characters is therefore printed under the field,
 * and the field keeps what was typed so it can be fixed.
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

const PROBLEM_KEYS: Readonly<Record<ClientListProblem["rule"], MessagePath>> = Object.freeze({
  too_long: "clients.searchProblemTooLong",
  invalid_format: "clients.searchProblemInvalidFormat",
});

interface ClientSearchFormProps {
  readonly filters: ClientListFilters;
  readonly problems: readonly ClientListProblem[];
}

export function ClientSearchForm({ filters, problems }: ClientSearchFormProps): ReactNode {
  const searchProblem = problems.find((problem) => problem.field === "search");

  return (
    <form action="/clients" className="flex flex-col gap-3 sm:flex-row sm:items-end" method="get" role="search">
      <label className={labelClasses}>
        <span className={fieldNameClasses}>{getMessage("clients.searchLabel")}</span>
        <input
          autoComplete="off"
          className={inputClasses}
          defaultValue={filters.search ?? ""}
          maxLength={CLIENT_SEARCH_MAXIMUM_LENGTH}
          name="search"
          placeholder={getMessage("clients.searchPlaceholder")}
          spellCheck={false}
          type="search"
        />
        <span className="text-xs text-muted-foreground">
          {formatMessage("clients.searchHint", { maximum: CLIENT_SEARCH_MAXIMUM_LENGTH })}
        </span>
        {searchProblem === undefined ? null : (
          <span className={problemClasses} role="alert">
            {getMessage(PROBLEM_KEYS[searchProblem.rule])}
          </span>
        )}
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <button className={submitClasses} type="submit">
          {getMessage("clients.searchSubmit")}
        </button>
        {filters.search === null ? null : (
          <Link className={clearClasses} href="/clients">
            {getMessage("clients.searchClear")}
          </Link>
        )}
      </div>
    </form>
  );
}
