// path: services/clients/client-import.ts
import type { RequestActor } from "../../lib/auth/types.ts";
import type { AuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import { AppError } from "../../lib/errors/app-error.ts";
import { CLIENT_FIELDS, type ClientField } from "./client-fields.ts";
import { createClient, type ClientDependencies } from "./clients.ts";
import { normaliseHeader, readCsv, type CsvSyntaxProblem } from "./csv.ts";

/**
 * Section 15's CSV import of clients, with one report per row.
 *
 * ## Why every row goes through `createClient`
 *
 * The requirement is that valid rows are imported and invalid ones are reported, so the definition of
 * "valid" has to be the one the form already uses - not a second, looser reading written for the
 * importer. Each row is therefore handed to `createClient` exactly as a form post would be: the same
 * Zod schema, the same section 55 sanitiser, the same `0019` address rule, the same role check, the
 * same audit entry. A row this import accepts is a row the merchant could have typed, and the day the
 * form learns a new rule the import learns it in the same commit. The cost is one insert per row
 * instead of one multi-row insert; the benefit is that the two writers cannot disagree.
 *
 * ## Why a refused row is reported and the rest still run
 *
 * A fifty-row file with one bad email is a file the merchant wants forty-nine clients from. So the
 * loop catches the `VALIDATION_FAILED` of a single row, records its `{field, rule}` details under the
 * line the row began on, and carries on. Only a defect that is about the *file* - an unreadable quote,
 * a row wider than the header, a header with no name column - stops the run, and each of those is
 * reported as its own kind so the screen can say which it was.
 *
 * ## Why the report names fields and never values
 *
 * The answer is rendered in a browser and may be logged, and the values in an uploaded client file are
 * personal data. A refusal therefore says "line 12, email: invalid format" and not the address that
 * failed. The two exceptions are the client's own name and its id on a row that *succeeded*, because a
 * merchant needs to recognise what was imported - and those are the values they uploaded a moment ago.
 *
 * ## Why a duplicate is a row refusal and not a file failure
 *
 * `clients_email_key` is unique per merchant over live rows, so a file that contains an existing
 * client is a file the merchant can fix - by removing that line. Treating it as `CONFLICT` on the
 * whole import would throw away the other forty-nine rows for the same reason. It is reported as
 * `{field: "email", rule: "already_used"}` on the line that caused it.
 *
 * ## What the import does not do
 *
 * It does not update. A file with an address that already exists is refused on that row rather than
 * used to overwrite the stored client, because a spreadsheet is not a statement of intent about an
 * existing record: the merchant who wanted to change one client has the edit screen, and a silent
 * overwrite from a re-uploaded file would be the most expensive kind of surprise.
 */

/** The most rows one import accepts beyond the header, so one file cannot walk a merchant's book. */
export const CLIENT_IMPORT_MAXIMUM_ROWS = 1_000;

/**
 * The header spellings this import understands, per field.
 *
 * A spreadsheet's header is whatever the merchant or their exporter typed, so each field answers to
 * the names people actually use - and matching drops case, space, and every non-alphanumeric
 * character, so `Company Name`, `company_name` and `COMPANY NAME` are one column. An unknown column is
 * ignored rather than refused: an export carrying an `id` or a `created at` says nothing this import
 * needs, and refusing it would make every re-import of the platform's own export fail.
 */
export const CLIENT_IMPORT_HEADERS: Readonly<Record<ClientField, readonly string[]>> = Object.freeze({
  name: Object.freeze(["name", "clientname", "fullname", "customername", "contactname", "contact"]),
  company_name: Object.freeze(["companyname", "company", "businessname", "organisation", "organization"]),
  email: Object.freeze(["email", "emailaddress", "mail"]),
  phone: Object.freeze(["phone", "phonenumber", "mobile", "telephone", "tel"]),
  address_line1: Object.freeze(["addressline1", "address1", "address", "street", "streetaddress"]),
  address_line2: Object.freeze(["addressline2", "address2"]),
  city: Object.freeze(["city", "town"]),
  region: Object.freeze(["region", "state", "province", "county"]),
  postal_code: Object.freeze(["postalcode", "postcode", "zip", "zipcode"]),
  country: Object.freeze(["country", "countrycode"]),
  tax_id: Object.freeze(["taxid", "vat", "vatnumber", "taxnumber", "gstin"]),
  notes: Object.freeze(["notes", "note", "comment", "comments", "remarks"]),
});

/** Why the file as a whole could not be imported. */
export type ClientImportFileProblem =
  | CsvSyntaxProblem
  /** The file has no record at all. */
  | "empty"
  /** The header row names no column this import understands. */
  | "header_missing"
  /** Two columns map to the same field, so the file does not say which one wins. */
  | "header_duplicate"
  /** The file has more data rows than `CLIENT_IMPORT_MAXIMUM_ROWS`. */
  | "too_many_rows"
  /** A row carries more cells than the header, which is a shifted row and cannot be read reliably. */
  | "row_too_wide";

/** What happened to one row. */
export interface ClientImportRowReport {
  /** The line the row began on in the uploaded file, counting from one. */
  readonly line: number;
  readonly status: "created" | "refused";
  /** The created client's id, on a row that succeeded. */
  readonly clientId: string | null;
  /** The created client's name, on a row that succeeded: the merchant needs to recognise it. */
  readonly name: string | null;
  /** `{field, rule}` pairs, in the order the service reported them. Empty on a created row. */
  readonly problems: readonly { readonly field: string; readonly rule: string }[];
}

/** The whole import, as the screen renders it. */
export interface ClientImportReport {
  readonly created: number;
  readonly refused: number;
  readonly rows: readonly ClientImportRowReport[];
  /** The fields the header supplied, in the order the file listed them. */
  readonly columns: readonly ClientField[];
  /** The header cells this import ignored, so the screen can say what was not read. */
  readonly ignoredColumns: readonly string[];
  readonly importedAtEpochMs: number;
}

/** One import: either a report, or one reason the file was not read. */
export type ClientImportOutcome =
  | { readonly ok: true; readonly report: ClientImportReport }
  | {
      readonly ok: false;
      readonly problem: ClientImportFileProblem;
      /** The line the problem was found on, when the file had lines. */
      readonly line: number | null;
    };

export interface ClientImportDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now?: () => number;
}

/** The field a header cell names, or null for a column this import does not use. */
function fieldOfHeader(cell: string): ClientField | null {
  const normalised = normaliseHeader(cell);

  if (normalised.length === 0) {
    return null;
  }

  for (const field of CLIENT_FIELDS) {
    if (CLIENT_IMPORT_HEADERS[field].includes(normalised)) {
      return field;
    }
  }

  return null;
}

/**
 * Map the header row to fields.
 *
 * Two columns naming the same field is refused rather than resolved, because there is no honest answer
 * to which of `email` and `Email Address` the merchant meant to win. A header with no `name` column is
 * refused too: `0019` requires a name, so every row would fail and the merchant would be shown a
 * thousand identical refusals instead of the one fact that their file is wrong.
 */
function mapHeader(
  header: readonly string[],
): { readonly ok: true; readonly index: ReadonlyMap<ClientField, number>; readonly columns: readonly ClientField[]; readonly ignored: readonly string[] } | { readonly ok: false; readonly problem: "header_missing" | "header_duplicate" } {
  const index = new Map<ClientField, number>();
  const columns: ClientField[] = [];
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

  return { ok: true, index, columns, ignored: ignored.filter((cell) => cell.trim().length > 0) };
}

/** The `{field, rule}` details of a refusal, whatever the service threw. */
function problemsOf(error: unknown): readonly { readonly field: string; readonly rule: string }[] {
  if (error instanceof AppError && error.code === "VALIDATION_FAILED") {
    const details = error.details;

    if (details.length > 0) {
      return details.map((detail) => ({ field: detail.field, rule: detail.rule }));
    }
  }

  if (error instanceof AppError && error.code === "CONFLICT") {
    // `clients_email_key`: a client of this merchant already holds that address.
    return [{ field: "email", rule: "already_used" }];
  }

  // Anything else is a defect in this code or an outage, and neither is the fault of the row: the
  // caller turns this into a `DEPENDENCY_FAILED` rather than blaming the merchant's file.
  return [];
}

/**
 * Import one CSV file of clients for the actor's company.
 *
 * The role check, the company and the audit trail all come from `createClient`, so this function adds
 * only the three things a file needs: reading it, naming the row, and carrying on after a bad one.
 */
export async function importClients(
  input: {
    readonly actor: RequestActor;
    readonly text: string;
    readonly now?: () => number;
  },
  dependencies: ClientImportDependencies,
): Promise<ClientImportOutcome> {
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

  // A row wider than the header is a shifted row: the columns the shift pushed off the end are lost,
  // and a row imported from a shifted file is worse than a row refused.
  const wide = read.records.find((record, position) => position > 0 && record.fields.length > header.fields.length);

  if (wide !== undefined) {
    return { ok: false, problem: "row_too_wide", line: wide.line };
  }

  const dataRows = read.records.slice(1);

  if (dataRows.length > CLIENT_IMPORT_MAXIMUM_ROWS) {
    return { ok: false, problem: "too_many_rows", line: dataRows[CLIENT_IMPORT_MAXIMUM_ROWS]?.line ?? null };
  }

  const rows: ClientImportRowReport[] = [];
  const clientDependencies: ClientDependencies = {
    rest: dependencies.rest,
    audit: dependencies.audit,
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  };

  for (const record of dataRows) {
    const body: Record<string, string> = {};

    for (const [field, position] of mapped.index) {
      const value = record.fields[position];

      // A short row means the trailing empty cells were omitted, which a spreadsheet does for a row
      // whose last columns are blank; the missing cells are simply empty.
      body[field] = value ?? "";
    }

    try {
      const created = await createClient({ actor: input.actor, body }, clientDependencies);

      rows.push({
        line: record.line,
        status: "created",
        clientId: created.id,
        name: created.values["name"] ?? null,
        problems: [],
      });
    } catch (error) {
      const problems = problemsOf(error);

      if (problems.length === 0) {
        // Not the row's fault and not the merchant's: an outage or a defect. The run stops rather than
        // reporting a file full of refusals that were really one broken connection.
        throw error;
      }

      rows.push({
        line: record.line,
        status: "refused",
        clientId: null,
        name: null,
        problems,
      });
    }
  }

  const created = rows.filter((row) => row.status === "created").length;

  // One summary entry for the run. Each created client already wrote its own `client.created`, so this
  // records the shape of the import - how many lines, how many taken - and never a value from the file.
  const instant = dependencies.now?.() ?? Date.now();

  try {
    await dependencies.audit.append({
      action: "client.imported",
      actorUserId: input.actor.userId,
      entityType: "client",
      entityId: null,
      companyId: input.actor.companyId ?? null,
      sessionId: input.actor.sessionId ?? null,
      payload: {
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
      created,
      refused: rows.length - created,
      rows,
      columns: mapped.columns,
      ignoredColumns: mapped.ignored,
      importedAtEpochMs: instant,
    },
  };
}
