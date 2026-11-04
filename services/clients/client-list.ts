// path: services/clients/client-list.ts
import { z } from "zod";
import type { RestClient } from "../../lib/auth/rest.ts";
import { requireAnyRole, requireCompanyId } from "../../lib/auth/session.ts";
import type { RequestActor } from "../../lib/auth/types.ts";
import { AppError } from "../../lib/errors/app-error.ts";
import { sanitizeSingleLineText } from "../../lib/security/text.ts";
import { CLIENTS_TABLE, CLIENT_MANAGE_ROLES } from "./clients.ts";

/**
 * Section 15's paginated client list, and the search over it.
 *
 * `clients.ts` owns the write and the read of one row; this module owns the read of many. It is a
 * separate file for the reason the two questions are different: a page of clients is a window with
 * an order, a bound and a filter, and every one of those three is a decision that deserves its own
 * paragraph (`clients.ts` is about a row being valid, not about a page being reasonable).
 *
 * ## Why the page is a window
 *
 * Newest first, `created_at desc` with `id desc` breaking the tie, which is exactly the order
 * `0019`'s `clients_page_idx` stores - so the page is read from the index rather than sorted in
 * memory, and two rows written in the same microsecond still come back in one stable order. The
 * offset is capped at `CLIENT_LIST_MAXIMUM_OFFSET`, because an offset is a way to ask the database
 * to walk rows and a merchant's client book is not a licence to walk the whole platform.
 *
 * ## Why there is no total count
 *
 * The page asks PostgREST for one row more than it shows. That extra row is the only fact this
 * screen needs - "is there another page" - and it costs one row instead of a second scan of every
 * matching row on every page view. `listAuditEntries` made the same trade for the same reason. A
 * merchant who wants the number of clients sees it on the first page, where the page is the whole
 * list.
 *
 * ## Why the search is a phrase and not a pattern
 *
 * The merchant types words, not SQL. The term runs through the section 55 sanitiser first, then
 * through one rule that accepts letters, digits, combining marks, spaces and six ordinary
 * punctuation characters - and nothing else. That rule is not decoration: PostgREST reads `,` and
 * `(` as the structure of a filter and `*` and `.` as part of its operator grammar, so a term
 * carrying them would be a second, unvalidated query language in the address bar. A term outside
 * the alphabet is reported and dropped, never rewritten into something else the merchant did not
 * ask for.
 *
 * The surviving term is matched case insensitively as a substring of the four columns a person
 * searches by: name, company name, email and phone. `0019`'s indexes cover the paging order and the
 * name lookup; a substring match is a scan of the merchant's own live rows, which is the honest cost
 * of "find the client whose name contains these letters" on a book of a few thousand rows.
 *
 * ## Why a read is not audited
 *
 * MASTER_PROMPT rule 9 asks every *mutation* to write an audit entry. A list read changes nothing,
 * so it writes nothing - and the screens that read one row (`getClient`) already made that choice.
 * The audit trail of this table stays a record of what was changed, not of who looked.
 */

/** How many clients one page shows. */
export const CLIENT_LIST_PAGE_SIZE = 25;

/**
 * The furthest offset a request may ask for.
 *
 * An offset is a position in an ordered window, not a cursor: a client added between two page
 * views shifts the rows under the reader by one. That is acceptable for a book that is read from
 * the newest end, and the cap keeps one hand-edited address from turning into a walk of a year of
 * rows.
 */
export const CLIENT_LIST_MAXIMUM_OFFSET = 2_000;

/** The longest search term the screen accepts, in code points. */
export const CLIENT_SEARCH_MAXIMUM_LENGTH = 80;

/**
 * The ceiling the sanitiser runs with before the length rule.
 *
 * `sanitizeSingleLineText` truncates at its ceiling, and a truncated search would quietly answer a
 * question nobody asked. The sanitiser therefore runs at a ceiling above the module's own limit, so
 * an over-long term survives it whole and is then refused as `too_long` by the rule below.
 */
const CLIENT_SEARCH_SANITIZE_MAXIMUM = 200;

/**
 * The only shapes a term may have to reach a PostgREST filter.
 *
 * Letters, digits and combining marks from any script - a client called Jose with an accent must be
 * findable - plus space, dot, apostrophe, hyphen, underscore, at sign and plus, which are what
 * names, companies and email addresses are made of. Everything PostgREST reads as structure is
 * absent: comma, parenthesis, quote, backslash, colon, asterisk and percent.
 */
export const CLIENT_SEARCH_PATTERN = /^[\p{L}\p{N}\p{M} .'\-_@+]+$/u;

/** The columns a search runs against: the four a person looks a client up by. */
export const CLIENT_SEARCH_FIELDS = ["name", "company_name", "email", "phone"] as const;

/**
 * The columns one page reads.
 *
 * Selected one by one rather than with `*`: the list prints six facts, and the address lines, the
 * tax identifier and the notes never leave the database for a screen that does not show them.
 */
export const CLIENT_LIST_COLUMNS = [
  "id",
  "name",
  "company_name",
  "email",
  "phone",
  "city",
  "created_at",
  "updated_at",
] as const;

/** The row shape of one page: the selected columns of `0019`, validated on every read. */
export const clientListRowSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(120),
  company_name: z.string().max(160).nullable(),
  email: z.string().max(254).nullable(),
  phone: z.string().max(32).nullable(),
  city: z.string().max(80).nullable(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});

/** One client as the list prints it. */
export interface ClientListRow {
  readonly id: string;
  readonly name: string;
  readonly companyName: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly city: string | null;
  readonly createdAtEpochMs: number;
  readonly updatedAtEpochMs: number;
}

/** What one request asked the list for. */
export interface ClientListFilters {
  /** The phrase to match, or null for the whole book. */
  readonly search: string | null;
}

/** Which input a problem belongs to, and why it was refused. */
export type ClientListProblem =
  | { readonly field: "search"; readonly rule: "too_long" | "invalid_format" }
  | { readonly field: "offset"; readonly rule: "invalid_format" };

/** Everything one request asked for, checked. */
export interface ParsedClientListQuery {
  readonly filters: ClientListFilters;
  /** The offset, landed on the page grid and inside the cap. */
  readonly offset: number;
  /** The refused values, in the order the screen lists them. A refused filter is not applied. */
  readonly problems: readonly ClientListProblem[];
}

/** The parameters a screen hands over: what the address bar carried. */
export type ClientListQueryParameters = Readonly<
  Record<string, string | readonly string[] | undefined>
>;

/** One page of the list, as the screen renders it. */
export interface ClientListPage {
  readonly clients: readonly ClientListRow[];
  readonly search: string | null;
  readonly offset: number;
  readonly pageSize: number;
  /** The page number the offset falls on, counting from one. */
  readonly pageNumber: number;
  readonly previousOffset: number | null;
  readonly nextOffset: number | null;
  readonly problems: readonly ClientListProblem[];
  readonly readAtEpochMs: number;
}

export interface ClientListDependencies {
  readonly rest: RestClient;
  readonly now?: () => number;
}

function firstValue(parameters: ClientListQueryParameters, key: string): string {
  const value = parameters[key];

  if (value === undefined) {
    return "";
  }

  return (typeof value === "string" ? value : (value[0] ?? "")).trim();
}

/**
 * Read one search term.
 *
 * An empty value is no search at all, which is where every visit to the screen starts. Anything
 * else is sanitised, then measured, then matched against the alphabet: a term that fails is
 * reported and dropped, so a mistyped search widens the list to the whole book instead of quietly
 * searching for something else.
 */
function parseSearch(
  raw: string,
  problems: ClientListProblem[],
): string | null {
  if (raw.length === 0) {
    return null;
  }

  const cleaned = sanitizeSingleLineText(raw, CLIENT_SEARCH_SANITIZE_MAXIMUM);

  if (cleaned.length === 0) {
    // a value made only of characters the sanitiser removes asked for nothing
    return null;
  }

  if ([...cleaned].length > CLIENT_SEARCH_MAXIMUM_LENGTH) {
    problems.push({ field: "search", rule: "too_long" });

    return null;
  }

  if (!CLIENT_SEARCH_PATTERN.test(cleaned)) {
    problems.push({ field: "search", rule: "invalid_format" });

    return null;
  }

  return cleaned;
}

/**
 * Read one offset.
 *
 * Only digits are a position. Anything else is reported and the list starts at the newest row,
 * because a hand-edited address is not a way to read from an unknown place. A position inside the
 * cap but off the page grid - `offset=30` with pages of twenty five - lands on the page that holds
 * it, so the position line the screen prints is the window that was actually read.
 */
function parseOffset(raw: string, problems: ClientListProblem[]): number {
  if (raw.length === 0) {
    return 0;
  }

  if (!/^\d{1,9}$/u.test(raw)) {
    problems.push({ field: "offset", rule: "invalid_format" });

    return 0;
  }

  const capped = Math.min(Number.parseInt(raw, 10), CLIENT_LIST_MAXIMUM_OFFSET);

  return Math.floor(capped / CLIENT_LIST_PAGE_SIZE) * CLIENT_LIST_PAGE_SIZE;
}

/** Read one request's search and position. */
export function parseClientListQuery(parameters: ClientListQueryParameters): ParsedClientListQuery {
  const problems: ClientListProblem[] = [];
  const search = parseSearch(firstValue(parameters, "search"), problems);
  const offset = parseOffset(firstValue(parameters, "offset"), problems);

  return { filters: { search }, offset, problems };
}

/** The PostgREST filter one term becomes: the same phrase against each of the four columns. */
function searchFilterOf(term: string): string {
  // The pattern is `*term*` - PostgREST's spelling of a SQL `%term%` - and it is escaped before it
  // joins the query, so no character of the term can become the query's own structure.
  const pattern = encodeURIComponent(`*${term}*`);
  const clauses = CLIENT_SEARCH_FIELDS.map((field) => `${field}.ilike.${pattern}`);

  return `or=(${clauses.join(",")})`;
}

/**
 * The PostgREST query one page makes.
 *
 * Selected columns, the tenant, the live rows, the search when there is one, the order the index
 * stores, and the window. Exported so the gate can read it and because a query is data: the route
 * and the gate must be able to say what the page asks for without running it.
 */
export function clientListQueryOf(
  companyId: string,
  query: ParsedClientListQuery,
  limit: number,
): string {
  const parts: string[] = [
    `select=${CLIENT_LIST_COLUMNS.join(",")}`,
    `company_id=eq.${encodeURIComponent(companyId)}`,
    "deleted_at=is.null",
  ];

  if (query.filters.search !== null) {
    parts.push(searchFilterOf(query.filters.search));
  }

  parts.push("order=created_at.desc,id.desc", `limit=${String(limit)}`, `offset=${String(query.offset)}`);

  return parts.join("&");
}

function epochMs(instant: string): number {
  const parsed = Date.parse(instant);

  if (!Number.isFinite(parsed)) {
    throw new AppError("INTERNAL_ERROR");
  }

  return parsed;
}

function rowOf(row: z.infer<typeof clientListRowSchema>): ClientListRow {
  return {
    id: row.id,
    name: row.name,
    companyName: row.company_name,
    email: row.email,
    phone: row.phone,
    city: row.city,
    createdAtEpochMs: epochMs(row.created_at),
    updatedAtEpochMs: epochMs(row.updated_at),
  };
}

/**
 * One page of the actor's own clients, newest first, optionally narrowed by a search phrase.
 *
 * The role rule is the one `clients.ts` applies to every write and to the read of one row - the
 * owner of a business, and only the owner (section 25) - and the company comes from the session, so
 * no query can name another merchant's rows.
 */
export async function listClients(
  input: { readonly actor: RequestActor; readonly query: ParsedClientListQuery },
  dependencies: ClientListDependencies,
): Promise<ClientListPage> {
  requireAnyRole(input.actor, CLIENT_MANAGE_ROLES);
  const companyId = requireCompanyId(input.actor);

  // One row more than the page shows: that row is how the screen knows a next page exists.
  const rows = await dependencies.rest.select(
    CLIENTS_TABLE,
    clientListQueryOf(companyId, input.query, CLIENT_LIST_PAGE_SIZE + 1),
    clientListRowSchema,
  );
  const pageRows = rows.slice(0, CLIENT_LIST_PAGE_SIZE);
  const hasMore = rows.length > CLIENT_LIST_PAGE_SIZE;
  const followingOffset = input.query.offset + CLIENT_LIST_PAGE_SIZE;
  const nextOffset =
    hasMore && followingOffset <= CLIENT_LIST_MAXIMUM_OFFSET ? followingOffset : null;

  return {
    clients: pageRows.map((row) => rowOf(row)),
    search: input.query.filters.search,
    offset: input.query.offset,
    pageSize: CLIENT_LIST_PAGE_SIZE,
    pageNumber: Math.floor(input.query.offset / CLIENT_LIST_PAGE_SIZE) + 1,
    previousOffset:
      input.query.offset === 0 ? null : Math.max(0, input.query.offset - CLIENT_LIST_PAGE_SIZE),
    nextOffset,
    problems: input.query.problems,
    readAtEpochMs: dependencies.now?.() ?? Date.now(),
  };
}
