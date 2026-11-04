// path: services/products/catalogue-list.ts
import { z } from "zod";
import type { RestClient } from "../../lib/auth/rest.ts";
import { requireAnyRole, requireCompanyId } from "../../lib/auth/session.ts";
import type { RequestActor } from "../../lib/auth/types.ts";
import { AppError } from "../../lib/errors/app-error.ts";
import { sanitizeSingleLineText } from "../../lib/security/text.ts";
import {
  CATALOGUE_CODE_COLUMN,
  CATALOGUE_TABLES,
  CATALOGUE_UNITS,
  isCatalogueUnit,
  type CatalogueKind,
  type CatalogueUnit,
} from "./catalogue-fields.ts";
import { CATALOGUE_MANAGE_ROLES } from "./catalogue.ts";
import { priceColumnSchema, priceFromMinor } from "./price.ts";

/**
 * Section 15's paginated product and service list, and the search over it.
 *
 * `catalogue.ts` owns the write and the read of one row; this module owns the read of many. It is a
 * separate file for the reason the two questions are different: a page of a catalogue is a window
 * with an order, a bound and a filter, and each of those three is a decision of its own.
 *
 * ## Why the page is a window on the index
 *
 * Newest first, `created_at desc` with `id desc` breaking the tie, which is exactly what `0020`'s
 * `products_page_idx` and `0021`'s `services_page_idx` store - `(company_id, created_at desc,
 * id desc) where deleted_at is null`. The page is therefore read from the index rather than sorted in
 * memory, and two rows written in the same microsecond still come back in one stable order. The
 * offset is capped at `CATALOGUE_LIST_MAXIMUM_OFFSET`, because an offset asks the database to walk
 * rows and one hand-edited address is not a licence to walk a year of a merchant's catalogue.
 *
 * ## Why there is no total count
 *
 * The page asks for one row more than it shows. That row is the only fact the screen needs - "is
 * there another page" - and it costs one row rather than a second scan of every matching row on every
 * view. `listClients` and `listAuditEntries` made the same trade for the same reason.
 *
 * ## Why the search is a phrase and not a pattern
 *
 * The merchant types words, not SQL. The term runs through the section 55 sanitiser, then through one
 * rule that accepts letters, digits, combining marks, spaces and the punctuation a name or a code is
 * made of - and nothing else. That rule is not decoration: PostgREST reads `,` and `(` as the
 * structure of a filter and `*` and `.` as part of its operator grammar, so a term carrying them
 * would be a second, unvalidated query language in the address bar. A refused term is **reported and
 * dropped**, never rewritten into something the merchant did not ask for.
 *
 * The alphabet is the client list's plus the characters a SKU carries beyond it: it already allows
 * dot, hyphen and underscore, and this list keeps them because `CATALOGUE_CODE_PATTERN` does. The
 * surviving term is matched case insensitively as a substring of the name, the code and the
 * description - the three things a merchant looks an entry up by.
 *
 * ## Why the price is read, not computed
 *
 * A price is stored as whole minor units and printed by `priceFromMinor`, the one function allowed to
 * format one. This module reuses it rather than dividing by ten thousand somewhere else, so the list
 * and the edit form can never disagree about what a stored amount says.
 *
 * ## Why a read is not audited
 *
 * MASTER_PROMPT rule 9 asks every *mutation* to write an audit entry. A list read changes nothing, so
 * it writes nothing, exactly as the client list chose.
 */

/** How many entries one page shows. */
export const CATALOGUE_LIST_PAGE_SIZE = 25;

/**
 * The furthest offset a request may ask for.
 *
 * An offset is a position in an ordered window, not a cursor: an entry added between two page views
 * shifts the rows under the reader by one. That is acceptable for a catalogue read from the newest
 * end, and the cap keeps one hand-edited address from turning into a walk of a year of rows.
 */
export const CATALOGUE_LIST_MAXIMUM_OFFSET = 2_000;

/** The longest search term the screen accepts, in code points. */
export const CATALOGUE_SEARCH_MAXIMUM_LENGTH = 80;

/**
 * The ceiling the sanitiser runs with before the length rule.
 *
 * `sanitizeSingleLineText` truncates at its ceiling, and a truncated search would quietly answer a
 * question nobody asked. The sanitiser therefore runs above this module's own limit, so an over-long
 * term survives it whole and is then refused as `too_long` by the rule below.
 */
const CATALOGUE_SEARCH_SANITIZE_MAXIMUM = 200;

/**
 * The only shapes a term may have to reach a PostgREST filter.
 *
 * Letters, digits and combining marks from any script - a product called Cafe with an accent must be
 * findable - plus space, dot, apostrophe, hyphen, underscore, at sign and plus. That is the client
 * list's alphabet, and it already covers every character `CATALOGUE_CODE_PATTERN` allows a code to
 * carry, so a search can name a SKU without opening a hole in the filter. Everything PostgREST reads
 * as structure is absent: comma, parenthesis, quote, backslash, colon, asterisk and percent.
 */
export const CATALOGUE_SEARCH_PATTERN = /^[\p{L}\p{N}\p{M} .'\-_@+]+$/u;

/** The columns a search runs against, per kind: the name, the entry's own code, and its description. */
export function catalogueSearchFieldsOf(kind: CatalogueKind): readonly string[] {
  return ["name", CATALOGUE_CODE_COLUMN[kind], "description"];
}

/**
 * The columns one page reads.
 *
 * Selected one by one rather than with `*`: the list prints six facts, and nothing else of the row
 * needs to leave the database for a screen that does not show it.
 *
 * The code column is **aliased** to `code`: it is `sku` on a product and `code` on a service, and
 * PostgREST's `code:sku` reads one under the other's name. That is what lets one row schema cover
 * both tables instead of two near-identical ones that could drift.
 */
export function catalogueListColumnsOf(kind: CatalogueKind): readonly string[] {
  return [
    "id",
    "name",
    `code:${CATALOGUE_CODE_COLUMN[kind]}`,
    "description",
    "unit_price_minor",
    "currency",
    "unit",
    "created_at",
    "updated_at",
  ];
}

/** The order the page is read in: the order the page index stores, newest first. */
export const CATALOGUE_LIST_ORDER = "created_at.desc,id.desc";

/**
 * The row shape of one page, the same for both tables because the code column is aliased to `code`
 * in the select. Validated on every read.
 */
export const catalogueListRowSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(160),
  code: z.string().max(48).nullable(),
  description: z.string().max(2_000).nullable(),
  unit_price_minor: priceColumnSchema,
  currency: z.string().length(3),
  unit: z.string().min(1),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});

/** One row of a page as the schema validated it. */
type CatalogueListStoredRow = z.infer<typeof catalogueListRowSchema>;

/** One entry as the list prints it. */
export interface CatalogueListRow {
  readonly id: string;
  readonly kind: CatalogueKind;
  readonly name: string;
  /** The `sku` of a product or the `code` of a service, already normalised to one name. */
  readonly code: string | null;
  readonly description: string | null;
  /** Minor units, which is what the column stores and what a caller should compare. */
  readonly unitPriceMinor: bigint;
  /** The same price printed with four decimals: the one function allowed to format an amount. */
  readonly unitPrice: string;
  readonly currency: string;
  readonly unit: CatalogueUnit;
  readonly createdAtEpochMs: number;
  readonly updatedAtEpochMs: number;
}

/** What one request asked the list for. */
export interface CatalogueListFilters {
  /** The phrase to match, or null for the whole catalogue. */
  readonly search: string | null;
}

/** Which input a problem belongs to, and why it was refused. */
export type CatalogueListProblem =
  | { readonly field: "search"; readonly rule: "too_long" | "invalid_format" }
  | { readonly field: "offset"; readonly rule: "invalid_format" };

/** Everything one request asked for, checked. */
export interface ParsedCatalogueListQuery {
  readonly filters: CatalogueListFilters;
  /** The offset, landed on the page grid and inside the cap. */
  readonly offset: number;
  /** The refused values, in the order the screen lists them. A refused filter is not applied. */
  readonly problems: readonly CatalogueListProblem[];
}

/** The parameters a screen hands over: what the address bar carried. */
export type CatalogueListQueryParameters = Readonly<
  Record<string, string | readonly string[] | undefined>
>;

/** One page of the list, as the screen renders it. */
export interface CatalogueListPage {
  readonly kind: CatalogueKind;
  readonly entries: readonly CatalogueListRow[];
  readonly search: string | null;
  readonly offset: number;
  readonly pageSize: number;
  /** The page number the offset falls on, counting from one. */
  readonly pageNumber: number;
  readonly previousOffset: number | null;
  readonly nextOffset: number | null;
  readonly problems: readonly CatalogueListProblem[];
  readonly readAtEpochMs: number;
}

export interface CatalogueListDependencies {
  readonly rest: RestClient;
  readonly now?: () => number;
}

function firstValue(parameters: CatalogueListQueryParameters, key: string): string {
  const value = parameters[key];

  if (value === undefined) {
    return "";
  }

  return (typeof value === "string" ? value : (value[0] ?? "")).trim();
}

/**
 * Read one search term.
 *
 * An empty value is no search at all, which is where every visit to the screen starts. Anything else
 * is sanitised, then measured, then matched against the alphabet: a term that fails is reported and
 * dropped, so a mistyped search widens the list to the whole catalogue instead of quietly searching
 * for something else.
 */
function parseSearch(raw: string, problems: CatalogueListProblem[]): string | null {
  if (raw.length === 0) {
    return null;
  }

  const cleaned = sanitizeSingleLineText(raw, CATALOGUE_SEARCH_SANITIZE_MAXIMUM);

  if (cleaned.length === 0) {
    // a value made only of characters the sanitiser removes asked for nothing
    return null;
  }

  if ([...cleaned].length > CATALOGUE_SEARCH_MAXIMUM_LENGTH) {
    problems.push({ field: "search", rule: "too_long" });

    return null;
  }

  if (!CATALOGUE_SEARCH_PATTERN.test(cleaned)) {
    problems.push({ field: "search", rule: "invalid_format" });

    return null;
  }

  return cleaned;
}

/**
 * Read one offset.
 *
 * Only digits are a position. Anything else is reported and the list starts at the newest row,
 * because a hand-edited address is not a way to read from an unknown place. A position inside the cap
 * but off the page grid - `offset=30` with pages of twenty five - lands on the page that holds it, so
 * the position line the screen prints is the window that was actually read.
 */
function parseOffset(raw: string, problems: CatalogueListProblem[]): number {
  if (raw.length === 0) {
    return 0;
  }

  if (!/^\d{1,9}$/u.test(raw)) {
    problems.push({ field: "offset", rule: "invalid_format" });

    return 0;
  }

  const capped = Math.min(Number.parseInt(raw, 10), CATALOGUE_LIST_MAXIMUM_OFFSET);

  return Math.floor(capped / CATALOGUE_LIST_PAGE_SIZE) * CATALOGUE_LIST_PAGE_SIZE;
}

/** Read one request's search and position. */
export function parseCatalogueListQuery(
  parameters: CatalogueListQueryParameters,
): ParsedCatalogueListQuery {
  const problems: CatalogueListProblem[] = [];
  const search = parseSearch(firstValue(parameters, "search"), problems);
  const offset = parseOffset(firstValue(parameters, "offset"), problems);

  return { filters: { search }, offset, problems };
}

/** The PostgREST filter one term becomes: the same phrase against each searchable column. */
export function catalogueSearchFilterOf(kind: CatalogueKind, term: string): string {
  // The pattern is `*term*` - PostgREST's spelling of a SQL `%term%` - and it is escaped before it
  // joins the query, so no character of the term can become the query's own structure.
  const pattern = encodeURIComponent(`*${term}*`);
  const clauses = catalogueSearchFieldsOf(kind).map((field) => `${field}.ilike.${pattern}`);

  return `or=(${clauses.join(",")})`;
}

/**
 * The PostgREST query one page makes.
 *
 * Selected columns, the tenant, the live rows, the search when there is one, the order the index
 * stores, and the window. Exported so the gate can read it and because a query is data: the route and
 * the gate must be able to say what the page asks for without running it.
 */
export function catalogueListQueryOf(
  kind: CatalogueKind,
  companyId: string,
  query: ParsedCatalogueListQuery,
  limit: number,
): string {
  const parts: string[] = [
    `select=${catalogueListColumnsOf(kind).join(",")}`,
    `company_id=eq.${encodeURIComponent(companyId)}`,
    "deleted_at=is.null",
  ];

  if (query.filters.search !== null) {
    parts.push(catalogueSearchFilterOf(kind, query.filters.search));
  }

  parts.push(
    `order=${CATALOGUE_LIST_ORDER}`,
    `limit=${String(limit)}`,
    `offset=${String(query.offset)}`,
  );

  return parts.join("&");
}

function epochMs(instant: string): number {
  const parsed = Date.parse(instant);

  if (!Number.isFinite(parsed)) {
    throw new AppError("INTERNAL_ERROR");
  }

  return parsed;
}

/** The stored unit, narrowed to the closed list; the migration's check is what makes this total. */
function unitOf(unit: string): CatalogueUnit {
  return isCatalogueUnit(unit) ? unit : (CATALOGUE_UNITS[0] as CatalogueUnit);
}

function rowOf(kind: CatalogueKind, row: CatalogueListStoredRow): CatalogueListRow {
  const code = row.code !== null && row.code.length > 0 ? row.code : null;

  return {
    id: row.id,
    kind,
    name: row.name,
    code,
    description: row.description,
    unitPriceMinor: row.unit_price_minor,
    unitPrice: priceFromMinor(row.unit_price_minor),
    currency: row.currency,
    unit: unitOf(row.unit),
    createdAtEpochMs: epochMs(row.created_at),
    updatedAtEpochMs: epochMs(row.updated_at),
  };
}

/**
 * One page of the actor's own catalogue, newest first, optionally narrowed by a search phrase.
 *
 * The role rule is the one `catalogue.ts` applies to every write and to the read of one row - the
 * owner of a business, and only the owner (section 25) - and the company comes from the session, so
 * no query can name another merchant's rows.
 */
export async function listCatalogueEntries(
  input: {
    readonly actor: RequestActor;
    readonly kind: CatalogueKind;
    readonly query: ParsedCatalogueListQuery;
  },
  dependencies: CatalogueListDependencies,
): Promise<CatalogueListPage> {
  requireAnyRole(input.actor, CATALOGUE_MANAGE_ROLES);
  const companyId = requireCompanyId(input.actor);

  // One row more than the page shows: that row is how the screen knows a next page exists.
  const rows = await dependencies.rest.select(
    CATALOGUE_TABLES[input.kind],
    catalogueListQueryOf(input.kind, companyId, input.query, CATALOGUE_LIST_PAGE_SIZE + 1),
    catalogueListRowSchema,
  );
  const pageRows = rows.slice(0, CATALOGUE_LIST_PAGE_SIZE);
  const hasMore = rows.length > CATALOGUE_LIST_PAGE_SIZE;
  const followingOffset = input.query.offset + CATALOGUE_LIST_PAGE_SIZE;
  const nextOffset =
    hasMore && followingOffset <= CATALOGUE_LIST_MAXIMUM_OFFSET ? followingOffset : null;

  return {
    kind: input.kind,
    entries: pageRows.map((row) => rowOf(input.kind, row)),
    search: input.query.filters.search,
    offset: input.query.offset,
    pageSize: CATALOGUE_LIST_PAGE_SIZE,
    pageNumber: Math.floor(input.query.offset / CATALOGUE_LIST_PAGE_SIZE) + 1,
    previousOffset:
      input.query.offset === 0 ? null : Math.max(0, input.query.offset - CATALOGUE_LIST_PAGE_SIZE),
    nextOffset,
    problems: input.query.problems,
    readAtEpochMs: dependencies.now?.() ?? Date.now(),
  };
}
