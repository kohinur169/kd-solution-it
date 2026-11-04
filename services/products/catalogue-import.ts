// path: services/products/catalogue-import.ts
import type { RequestActor } from "../../lib/auth/types.ts";
import type { AuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import { AppError } from "../../lib/errors/app-error.ts";
import { readCsv, normaliseHeader, type CsvSyntaxProblem } from "../clients/csv.ts";
import {
  CATALOGUE_CODE_COLUMN,
  CATALOGUE_CURRENCIES,
  CATALOGUE_DEFAULT_UNIT,
  type CatalogueKind,
} from "./catalogue-fields.ts";
import {
  createCatalogueEntry,
  type CatalogueDependencies,
  type CatalogueSnapshot,
} from "./catalogue.ts";

/**
 * Section 15's CSV import of a catalogue, with one report per row.
 *
 * ## Why every row goes through `createCatalogueEntry`
 *
 * The requirement is that valid rows are imported and invalid ones are reported, so the definition of
 * "valid" has to be the one the form already uses - not a second, looser reading written for the
 * importer. Each row is therefore handed to `createCatalogueEntry` exactly as a form post would be: the
 * same Zod schema, the same section 55 sanitiser, the same price parse, the same `owner` role check, the
 * same `product.created` audit entry. A row this import accepts is a row the merchant could have typed,
 * and the day the form learns a rule the import learns it in the same commit. The client import of STEP
 * 110 made the same choice for the same reason, and its gate proves the two agree by sending one body
 * both ways; this module inherits that property rather than restating it.
 *
 * ## Why the price is never touched here
 *
 * A spreadsheet's price cell is text - `42.50`, `19.999`, `1 200`, `USD 12`. This module passes it to
 * the service exactly as it arrived, and `priceToMinor` decides. Parsing it here with `Number()` or
 * `parseFloat()` would be the one place in the platform where money went through a float, which
 * MASTER_PROMPT rule 2 forbids and which would round `19.999` into a different amount than the form
 * stores. So the import has no arithmetic at all: it is a reader, a header map, and a loop.
 *
 * ## Why the unit and the currency may be left out
 *
 * `0020` and `0021` declare a default for both - `item` and `USD` - and a merchant's export from a
 * spreadsheet commonly has neither column. A row that omits them is filled with the catalogue's default
 * here rather than refused, because "I did not say" and "I said something wrong" are different: a blank
 * cell means the default, a cell holding `stone` means the merchant meant a unit this platform does not
 * price in and is refused as `invalid_format`. That distinction is asserted from both sides.
 *
 * ## Why a duplicate code is a row refusal and not a file failure
 *
 * `products_sku_key` and `services_code_key` are unique per merchant under `lower()` over live rows, so
 * a file containing an entry the merchant already has is a file they can fix by deleting that line.
 * Failing the whole import would throw away the other rows for one clash. It is reported as
 * `{field: "sku"|"code", rule: "already_used"}` on the line that caused it.
 *
 * ## Why the report names fields and never values
 *
 * The answer is rendered in a browser and may be logged. A refusal therefore says "line 12, unit_price:
 * invalid format" and not the price that failed; the merchant has it in front of them in their own
 * file. The two exceptions are the name and id of a row that *succeeded*, which the merchant needs to
 * recognise what was imported.
 *
 * ## Why this is one module for two catalogues
 *
 * The product import and the service import differ in three facts the catalogue vocabulary already
 * states: the table, the code column, and the default unit. Everything else - the reader, the report,
 * the loop, the refusals - is the same, so writing two copies would be two chances for the service
 * catalogue to drift from the product one. The kind arrives as an argument and STEP 111's title names
 * products because that is the catalogue with a price list; the service import is the same function.
 */

/** The most data rows one import accepts, so one file cannot walk a merchant's whole catalogue. */
export const CATALOGUE_IMPORT_MAXIMUM_ROWS = 1_000;

/**
 * The header names this import reads, in the order a file is expected to list them.
 *
 * `code` is a header name and not a column: it stands for `sku` on a product and `code` on a service,
 * and is translated to the kind's own column when a row is built.
 */
export type CatalogueImportField = "name" | "code" | "description" | "unit_price" | "unit" | "currency";

/**
 * The header spellings this import understands, per field.
 *
 * Matching drops case, space and every non-alphanumeric character, so `Unit Price`, `unit_price` and
 * `UNITPRICE` are one column. The code column answers to the merchant's own word (`SKU` for a product,
 * `code` for a service) and to the generic `code`, because an export of one catalogue is often fed back
 * into it and nobody types the table's column name.
 */
export const CATALOGUE_IMPORT_HEADERS: Readonly<Record<CatalogueImportField, readonly string[]>> = Object.freeze({
  // A catalogue's own export often titles its name column with the catalogue itself, so `Product` and
  // `Service` are names too. A file carrying both that and `Name` is refused as `header_duplicate`,
  // which is the honest answer - the import cannot tell which of the two holds the entry's name.
  name: Object.freeze([
    "name",
    "productname",
    "servicename",
    "itemname",
    "title",
    "item",
    "product",
    "service",
  ]),
  code: Object.freeze(["sku", "code", "productcode", "servicecode", "itemcode", "skucode", "reference"]),
  description: Object.freeze(["description", "details", "notes", "note", "summary"]),
  unit_price: Object.freeze([
    "unitprice",
    "price",
    "rate",
    "amount",
    "priceperunit",
    "unitamount",
    "sellingprice",
  ]),
  unit: Object.freeze(["unit", "uom", "unitofmeasure", "measure"]),
  currency: Object.freeze(["currency", "currencycode"]),
});

/** The fields in the order the report lists them, which is the order the form reads them. */
const IMPORT_FIELDS: readonly CatalogueImportField[] = [
  "name",
  "code",
  "description",
  "unit_price",
  "unit",
  "currency",
];

/** Why the file as a whole could not be imported. */
export type CatalogueImportFileProblem =
  | CsvSyntaxProblem
  /** The file has no record at all. */
  | "empty"
  /** The header row names no name column. */
  | "header_missing"
  /** The header row names no price column, which every catalogue row requires. */
  | "header_missing_price"
  /** Two columns map to the same field, so the file does not say which one wins. */
  | "header_duplicate"
  /** The file has more data rows than `CATALOGUE_IMPORT_MAXIMUM_ROWS`. */
  | "too_many_rows"
  /** A row carries more cells than the header, which is a shifted row and cannot be read reliably. */
  | "row_too_wide";

/** What happened to one row. */
export interface CatalogueImportRowReport {
  /** The line the row began on in the uploaded file, counting from one. */
  readonly line: number;
  readonly status: "created" | "refused";
  /** The created entry's id, on a row that succeeded. */
  readonly entryId: string | null;
  /** The created entry's name, on a row that succeeded: the merchant needs to recognise it. */
  readonly name: string | null;
  /** `{field, rule}` pairs, in the order the service reported them. Empty on a created row. */
  readonly problems: readonly { readonly field: string; readonly rule: string }[];
}

/** The whole import, as the screen renders it. */
export interface CatalogueImportReport {
  readonly kind: CatalogueKind;
  readonly created: number;
  readonly refused: number;
  readonly rows: readonly CatalogueImportRowReport[];
  /** The fields the header supplied, in the order the file listed them. */
  readonly columns: readonly CatalogueImportField[];
  /** The header cells this import ignored, so the screen can say what was not read. */
  readonly ignoredColumns: readonly string[];
  readonly importedAtEpochMs: number;
}

/** One import: either a report, or one reason the file was not read. */
export type CatalogueImportOutcome =
  | { readonly ok: true; readonly report: CatalogueImportReport }
  | {
      readonly ok: false;
      readonly problem: CatalogueImportFileProblem;
      /** The line the problem was found on, when the file had lines. */
      readonly line: number | null;
    };

export interface CatalogueImportDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now?: () => number;
}

/** The field a header cell names, or null for a column this import does not use. */
function fieldOfHeader(cell: string): CatalogueImportField | null {
  const normalised = normaliseHeader(cell);

  if (normalised.length === 0) {
    return null;
  }

  for (const field of IMPORT_FIELDS) {
    if (CATALOGUE_IMPORT_HEADERS[field].includes(normalised)) {
      return field;
    }
  }

  return null;
}

/**
 * Map the header row to fields.
 *
 * Two columns naming the same field is refused rather than resolved, because there is no honest answer
 * to which of `Price` and `Unit Price` the merchant meant to win. A header with no name column is
 * refused too - `0020` requires a name, so every row would fail and the merchant would be shown a
 * thousand identical refusals instead of the one fact that their file is wrong - and so is a header with
 * no price column, for the same reason and because a catalogue row's price is the one thing an import
 * from a price list cannot guess.
 */
function mapHeader(
  header: readonly string[],
):
  | {
      readonly ok: true;
      readonly index: ReadonlyMap<CatalogueImportField, number>;
      readonly columns: readonly CatalogueImportField[];
      readonly ignored: readonly string[];
    }
  | { readonly ok: false; readonly problem: "header_missing" | "header_missing_price" | "header_duplicate" } {
  const index = new Map<CatalogueImportField, number>();
  const columns: CatalogueImportField[] = [];
  const ignored: string[] = [];
  let duplicate = false;

  header.forEach((cell, position) => {
    const field = fieldOfHeader(cell);

    if (field === null) {
      ignored.push(cell);

      return;
    }

    if (index.has(field)) {
      duplicate = true;

      return;
    }

    index.set(field, position);
    columns.push(field);
  });

  if (duplicate) {
    return { ok: false, problem: "header_duplicate" };
  }

  if (!index.has("name")) {
    return { ok: false, problem: "header_missing" };
  }

  if (!index.has("unit_price")) {
    return { ok: false, problem: "header_missing_price" };
  }

  return { ok: true, index, columns, ignored: ignored.filter((cell) => cell.trim().length > 0) };
}

/** The `{field, rule}` details of a refusal, whatever the service threw. */
function problemsOf(error: unknown, kind: CatalogueKind): readonly { readonly field: string; readonly rule: string }[] {
  if (error instanceof AppError && error.code === "VALIDATION_FAILED") {
    const details = error.details;

    if (details.length > 0) {
      return details.map((detail) => ({ field: detail.field, rule: detail.rule }));
    }
  }

  if (error instanceof AppError && error.code === "CONFLICT") {
    // `products_sku_key` / `services_code_key`: this merchant already holds that code on a live row.
    return [{ field: CATALOGUE_CODE_COLUMN[kind], rule: "already_used" }];
  }

  // Anything else is a defect in this code or an outage, and neither is the fault of the row: the caller
  // turns this into a `DEPENDENCY_FAILED` rather than blaming the merchant's file.
  return [];
}

/**
 * One row of the file as the body `createCatalogueEntry` expects.
 *
 * The kind's own column spelling is applied here (`sku` or `code`), the two defaults are filled only
 * when the cell is blank, and nothing is trimmed or parsed: the service's sanitiser owns both, and a
 * value this function "helpfully" cleaned would be a value the form would have judged differently.
 */
function bodyOfRow(
  kind: CatalogueKind,
  index: ReadonlyMap<CatalogueImportField, number>,
  fields: readonly string[],
): Record<string, string> {
  /** A cell's value, or an empty string when the row was short and the cell is absent. */
  const cell = (field: CatalogueImportField): string => {
    const position = index.get(field);

    return position === undefined ? "" : (fields[position] ?? "");
  };

  const unit = cell("unit").trim();
  const currency = cell("currency").trim();

  return {
    name: cell("name"),
    [CATALOGUE_CODE_COLUMN[kind]]: cell("code"),
    description: cell("description"),
    unit_price: cell("unit_price"),
    // A blank cell means "not stated", which is the migration's own default; anything else is the
    // merchant's word and must survive to the validator so a unit this platform does not price in is
    // refused rather than silently replaced by the default.
    unit: unit.length === 0 ? CATALOGUE_DEFAULT_UNIT[kind] : unit,
    currency: currency.length === 0 ? CATALOGUE_CURRENCIES[0] : currency,
  };
}

/**
 * Import one CSV file of a catalogue for the actor's company.
 *
 * The role check, the company and the audit trail all come from `createCatalogueEntry`, so this function
 * adds only the three things a file needs: reading it, naming the row, and carrying on after a bad one.
 */
export async function importCatalogueEntries(
  input: {
    readonly actor: RequestActor;
    readonly kind: CatalogueKind;
    readonly text: string;
  },
  dependencies: CatalogueImportDependencies,
): Promise<CatalogueImportOutcome> {
  const read = readCsv(input.text);

  if (!read.ok) {
    return { ok: false, problem: read.error.problem, line: read.error.line };
  }

  const header = read.records[0];

  if (header === undefined) {
    return { ok: false, problem: "empty", line: null };
  }

  const mapped = mapHeader(header.fields);

  if (!mapped.ok) {
    return { ok: false, problem: mapped.problem, line: header.line };
  }

  // A row wider than the header is a shifted row: the columns the shift pushed off the end are lost, and
  // a row imported from a shifted file is worse than a row refused.
  const wide = read.records.find(
    (record, position) => position > 0 && record.fields.length > header.fields.length,
  );

  if (wide !== undefined) {
    return { ok: false, problem: "row_too_wide", line: wide.line };
  }

  const dataRows = read.records.slice(1);

  if (dataRows.length > CATALOGUE_IMPORT_MAXIMUM_ROWS) {
    const beyond = dataRows.at(CATALOGUE_IMPORT_MAXIMUM_ROWS);

    return { ok: false, problem: "too_many_rows", line: beyond?.line ?? null };
  }

  const rows: CatalogueImportRowReport[] = [];
  const catalogueDependencies: CatalogueDependencies = {
    rest: dependencies.rest,
    audit: dependencies.audit,
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  };

  for (const record of dataRows) {
    try {
      const created: CatalogueSnapshot = await createCatalogueEntry(
        { actor: input.actor, kind: input.kind, body: bodyOfRow(input.kind, mapped.index, record.fields) },
        catalogueDependencies,
      );

      rows.push({
        line: record.line,
        status: "created",
        entryId: created.id,
        name: created.values.name,
        problems: [],
      });
    } catch (error) {
      const problems = problemsOf(error, input.kind);

      if (problems.length === 0) {
        // Not the row's fault and not the merchant's: an outage or a defect. The run stops rather than
        // reporting a file full of refusals that were really one broken connection.
        throw error;
      }

      rows.push({
        line: record.line,
        status: "refused",
        entryId: null,
        name: null,
        problems,
      });
    }
  }

  const created = rows.filter((row) => row.status === "created").length;

  // One summary entry for the run. Each created entry already wrote its own `product.created` /
  // `service.created`, so this records the shape of the import - how many lines, how many taken - and
  // never a value from the file.
  const instant = dependencies.now?.() ?? Date.now();

  try {
    await dependencies.audit.append({
      action: `catalogue.imported`,
      actorUserId: input.actor.userId,
      entityType: input.kind,
      entityId: null,
      companyId: input.actor.companyId ?? null,
      sessionId: input.actor.sessionId ?? null,
      payload: {
        kind: input.kind,
        rows: rows.length,
        created,
        refused: rows.length - created,
        columns: mapped.columns,
      },
    });
  } catch {
    // An audit sink that is down never fails the write it records.
  }

  return {
    ok: true,
    report: {
      kind: input.kind,
      created,
      refused: rows.length - created,
      rows,
      columns: mapped.columns,
      ignoredColumns: mapped.ignored,
      importedAtEpochMs: instant,
    },
  };
}
