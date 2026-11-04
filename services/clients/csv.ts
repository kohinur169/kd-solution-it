// path: services/clients/csv.ts
/**
 * A CSV reader, written here rather than taken from a package.
 *
 * ## Why this file exists at all
 *
 * Section 15's import reads a file a merchant exports from a spreadsheet, and a spreadsheet's CSV is
 * not a split on commas. A company name containing a comma is quoted; a note containing a quote is
 * quoted with the quote doubled; a note containing a newline is quoted across two lines of the file.
 * Splitting on commas would turn any of those into a shifted row - a phone number in the city column -
 * and the merchant would have to find the damage row by row. So the reader implements RFC 4180's four
 * rules and nothing else: comma separates, a double quote opens and closes a quoted field, a doubled
 * quote inside one is one quote, and a record ends at a line break outside quotes.
 *
 * ## Why it returns a position and not just the rows
 *
 * "Invalid rows are reported row by row" is the requirement, and a row number is only useful if it is
 * the number the merchant sees in their spreadsheet. The reader therefore carries the file's own line
 * of the record's first field, so a record that spanned three lines is reported at the line it began.
 * A malformed quote is reported the same way: it names the line and the column where the file stopped
 * making sense, because "your CSV is broken" sends the merchant looking through the whole file.
 *
 * ## What it refuses, and why each is a refusal rather than a guess
 *
 * `MAXIMUM_CSV_CHARACTERS` and `MAXIMUM_CSV_ROWS` are bounds on work, not on a merchant's book: a
 * ninety megabyte paste is not an import, and a parser that reads it holds it in memory four times
 * over. A record with more fields than the header is a shifted row and is refused as `too_many_fields`
 * instead of being truncated, because truncating it would silently drop the columns the shift pushed
 * off the end. A quote inside an unquoted field (`Smith"s`) is refused as `invalid_quote` rather than
 * read as a literal: RFC 4180 has no meaning for it, and the two things it might mean - a typo, or a
 * field that should have been quoted - produce different rows.
 *
 * The BOM a spreadsheet writes at the start of a UTF-8 file is removed, because otherwise the first
 * header cell is `\ufeffname` and every column is one to the right of where it belongs.
 */

/** The most characters one import may read. */
export const MAXIMUM_CSV_CHARACTERS = 1_048_576;

/** The most records one import may carry, header included. */
export const MAXIMUM_CSV_ROWS = 2_000;

/** One parsed record: its fields, and the line of the file it began on. */
export interface CsvRecord {
  /** The line number the record began on, counting from one. A quoted field may continue past it. */
  readonly line: number;
  readonly fields: readonly string[];
}

/** Why a file could not be read as CSV. */
export type CsvSyntaxProblem =
  /** The file is longer than `MAXIMUM_CSV_CHARACTERS`. */
  | "too_large"
  /** The file has more records than `MAXIMUM_CSV_ROWS`. */
  | "too_many_rows"
  /** A quote closed nothing before the file ended, or a quote appeared inside an unquoted field. */
  | "invalid_quote";

/** A defect in the file itself, as opposed to a defect in one row. */
export interface CsvSyntaxError {
  readonly problem: CsvSyntaxProblem;
  /** The line the reader stopped on, counting from one. */
  readonly line: number;
}

export type CsvReadResult =
  | { readonly ok: true; readonly records: readonly CsvRecord[] }
  | { readonly ok: false; readonly error: CsvSyntaxError };

/** The byte-order mark a spreadsheet writes at the start of a UTF-8 file. */
const BOM = "\ufeff";

/**
 * Read a file into records.
 *
 * The loop holds four facts: the field being built, the record being built, whether a quote is open,
 * and whether the field that just ended was quoted. The last one is what makes `"a""b"` one field
 * reading `a"b` while `a"b` is a refusal, and what makes `""` an empty field rather than no field.
 */
export function readCsv(text: string): CsvReadResult {
  if (text.length > MAXIMUM_CSV_CHARACTERS) {
    return { ok: false, error: { problem: "too_large", line: 1 } };
  }

  const input = text.startsWith(BOM) ? text.slice(BOM.length) : text;
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = "";
  let fieldWasQuoted = false;
  let quoted = false;
  let line = 1;
  let recordLine = 1;

  /** Close the field being built and keep it. */
  const endField = (): void => {
    fields.push(field);
    field = "";
    fieldWasQuoted = false;
  };

  /**
   * Close the record being built; an empty trailing record is a blank line and is dropped.
   *
   * The quoted flag is read before `endField` clears it, and it is what separates a blank line from a
   * cell that happens to be empty: `""` is one field holding nothing, which `0019` must judge (and
   * which for a name means `required`), while a line with nothing at all on it is spacing in the file.
   */
  const endRecord = (): boolean => {
    const soleFieldWasQuoted = fieldWasQuoted;

    endField();

    const blank = fields.length === 1 && fields[0] === "" && !soleFieldWasQuoted;

    if (!blank) {
      records.push({ line: recordLine, fields });

      if (records.length > MAXIMUM_CSV_ROWS) {
        return false;
      }
    }

    fields = [];

    return true;
  };

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index] as string;

    if (quoted) {
      if (character === '"') {
        // A doubled quote inside a quoted field is one literal quote; a single one closes the field.
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        if (character === "\n") {
          line += 1;
        }

        field += character;
      }

      continue;
    }

    if (character === '"') {
      if (field.length > 0) {
        // `Smith"s`: RFC 4180 gives this no meaning, and guessing between a typo and a missing pair of
        // quotes would pick one of two different rows.
        return { ok: false, error: { problem: "invalid_quote", line } };
      }

      quoted = true;
      fieldWasQuoted = true;

      continue;
    }

    if (character === ",") {
      endField();

      continue;
    }

    if (character === "\r") {
      // A CRLF record ends here and the LF is consumed with it; a lone CR is a record end too.
      if (input[index + 1] === "\n") {
        index += 1;
      }

      if (!endRecord()) {
        return { ok: false, error: { problem: "too_many_rows", line: recordLine } };
      }

      line += 1;
      recordLine = line;

      continue;
    }

    if (character === "\n") {
      if (!endRecord()) {
        return { ok: false, error: { problem: "too_many_rows", line: recordLine } };
      }

      line += 1;
      recordLine = line;

      continue;
    }

    // Text after a closing quote (`"a"b`) is refused for the same reason as a quote inside a field.
    if (fieldWasQuoted) {
      return { ok: false, error: { problem: "invalid_quote", line } };
    }

    field += character;
  }

  if (quoted) {
    return { ok: false, error: { problem: "invalid_quote", line } };
  }

  // The last record has no line break after it; `endRecord` drops it when it is empty, which is what
  // makes a file ending in a newline and one that does not read identically.
  if (!endRecord()) {
    return { ok: false, error: { problem: "too_many_rows", line: recordLine } };
  }

  return { ok: true, records };
}

/**
 * The header row, normalised for matching.
 *
 * A header cell arrives with whatever the spreadsheet put around it: spaces, a capital letter, a
 * non-breaking space from a copy and paste. Matching is therefore case-insensitive on the trimmed
 * lower-case name, and every non-alphanumeric character is dropped - so `Company Name`, `company_name`
 * and `COMPANY NAME` are one header rather than three. That leniency is safe because it is applied only
 * to the *names* of columns, never to the values in them.
 */
export function normaliseHeader(cell: string): string {
  return cell
    .normalize("NFC")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}
