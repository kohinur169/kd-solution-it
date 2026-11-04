// path: app/(dashboard)/products/catalogue-import-form.tsx
"use client";

import Link from "next/link";
import { useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import { formatMessage, getMessage } from "@/lib/i18n/messages";
import type { MessagePath } from "@/lib/i18n/messages";
import { csrfHeaders } from "@/lib/security/csrf-client";
import type { CatalogueImportReport } from "@/services/products/catalogue-import";
import { CATALOGUE_PATHS, type CatalogueKind } from "@/services/products/catalogue-fields";

/**
 * The catalogue CSV import.
 *
 * ## Why the file is read in the browser before it is sent
 *
 * The route takes CSV text, so something has to turn the chosen file into text. `file.text()` does it,
 * which means the browser sends exactly the bytes the merchant chose with no multipart envelope and no
 * temporary file, and the server's size bound is the file's own length. It also lets this form refuse a
 * file that is obviously not an import - empty, or larger than the reader will accept - before the
 * merchant waits for an upload that was never going to work.
 *
 * ## Why the report is a table and not a count
 *
 * "Invalid rows are reported row by row" is the requirement, and a merchant told "3 of 40 rows failed"
 * has to find those three themselves. Each refused row is printed with the line number it had in *their*
 * file and the fields that failed, so the fix is a search in their spreadsheet rather than a hunt through
 * the whole file.
 *
 * ## Why the price refusal has its own sentences
 *
 * A catalogue row's price is the one field a spreadsheet gets wrong most: a thousands separator, a
 * currency symbol, a fifth decimal. Those are three different mistakes and the merchant fixes them
 * differently, so the rule words are the service's own (`invalid_format`, `too_large`) rather than one
 * "the price is wrong" - and the sentence says what shape is wanted.
 *
 * ## Why the values that failed are never printed
 *
 * The answer names the field and the rule and never the value. The merchant has the value in front of
 * them in their own file; what they need from this page is which line and which column, and a page that
 * echoes a row back is a page that prints a price list into a screenshot.
 */

const labelClasses = "flex flex-col gap-1";

const fieldNameClasses = "text-xs font-semibold uppercase tracking-widest text-muted-foreground";

const fileInputClasses =
  "w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground file:mr-3 file:rounded-sm file:border-0 file:bg-muted file:px-3 file:py-1 file:text-sm file:font-medium file:text-foreground";

const submitClasses =
  "w-fit rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60";

const tableClasses = "w-full min-w-2xl border-collapse text-left text-sm";

const headCellClasses =
  "border-b border-border px-3 pb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground";

const cellClasses = "border-b border-border px-3 py-2 align-top";

const linkClasses =
  "w-fit rounded-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-primary";

/** The sentence of each way a file as a whole can be refused. */
const PROBLEM_KEYS: Readonly<Record<string, MessagePath>> = Object.freeze({
  empty: "catalogue.importProblemEmpty",
  header_missing: "catalogue.importProblemHeaderMissing",
  header_missing_price: "catalogue.importProblemHeaderMissingPrice",
  header_duplicate: "catalogue.importProblemHeaderDuplicate",
  row_too_wide: "catalogue.importProblemRowTooWide",
  too_many_rows: "catalogue.importProblemTooManyRows",
  too_large: "catalogue.importProblemTooLarge",
  invalid_quote: "catalogue.importProblemInvalidQuote",
  invalid_type: "catalogue.importProblemInvalidType",
});

/** The largest file this form will even read, matching the route's ceiling. */
const MAXIMUM_FILE_BYTES = 3_145_728;

/** The rule words this screen knows, so a refusal reads as a sentence. */
const RULE_KEYS: Readonly<Record<string, MessagePath>> = Object.freeze({
  required: "catalogue.ruleRequired",
  too_short: "catalogue.ruleTooShort",
  too_long: "catalogue.ruleTooLong",
  invalid_format: "catalogue.ruleInvalidFormat",
  too_large: "catalogue.ruleTooLarge",
  already_used: "catalogue.ruleAlreadyUsed",
  already_changed: "catalogue.ruleAlreadyChanged",
  unknown_field: "catalogue.ruleUnknownField",
});

interface ImportAnswer {
  readonly report?: unknown;
  readonly problem?: unknown;
  readonly line?: unknown;
}

function ruleSentence(rule: string): string {
  const key = RULE_KEYS[rule];

  return key === undefined ? getMessage("catalogue.importRuleUnknown") : getMessage(key);
}

export function CatalogueImportForm({ kind }: { readonly kind: CatalogueKind }): ReactNode {
  const [fileName, setFileName] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [localProblem, setLocalProblem] = useState<string | null>(null);
  const [report, setReport] = useState<CatalogueImportReport | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [problemLine, setProblemLine] = useState<number | null>(null);
  const [failed, setFailed] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const listPath = `/${CATALOGUE_PATHS[kind]}`;

  async function choose(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0] ?? null;

    setReport(null);
    setProblem(null);
    setProblemLine(null);
    setFailed(false);
    setLocalProblem(null);
    setText(null);
    setFileName(file?.name ?? null);

    if (file === null) {
      return;
    }

    if (file.size > MAXIMUM_FILE_BYTES) {
      setLocalProblem(getMessage("catalogue.importLocalTooLarge"));

      return;
    }

    const contents = await file.text();

    if (contents.trim().length === 0) {
      setLocalProblem(getMessage("catalogue.importLocalEmpty"));

      return;
    }

    setText(contents);
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    if (text === null) {
      return;
    }

    setBusy(true);
    setFailed(false);
    setReport(null);
    setProblem(null);
    setProblemLine(null);

    try {
      const response = await fetch(`/api/${CATALOGUE_PATHS[kind]}/import`, {
        method: "POST",
        headers: { "content-type": "text/csv", ...(await csrfHeaders()) },
        body: text,
        credentials: "same-origin",
        cache: "no-store",
      });

      const payload = (await response.json().catch(() => null)) as ImportAnswer | null;

      if (!response.ok) {
        setFailed(true);

        return;
      }

      if (typeof payload?.report === "object" && payload.report !== null) {
        setReport(payload.report as CatalogueImportReport);

        return;
      }

      setProblem(typeof payload?.problem === "string" ? payload.problem : "empty");
      setProblemLine(typeof payload?.line === "number" ? payload.line : null);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  const problemKey = problem === null ? undefined : PROBLEM_KEYS[problem];

  return (
    <div className="flex flex-col gap-6">
      <form className="flex flex-col gap-3" onSubmit={(event) => void submit(event)}>
        <label className={labelClasses}>
          <span className={fieldNameClasses}>{getMessage("catalogue.importFileLabel")}</span>
          <input
            accept=".csv,text/csv,text/plain"
            className={fileInputClasses}
            name="file"
            onChange={(event) => void choose(event)}
            type="file"
          />
          <span className="text-xs text-muted-foreground">{getMessage("catalogue.importFileHint")}</span>
        </label>

        {fileName === null ? null : (
          <p className="text-xs text-muted-foreground">
            {formatMessage("catalogue.importChosenFile", { name: fileName })}
          </p>
        )}

        {localProblem === null ? null : (
          <p className="text-sm text-destructive" role="alert">
            {localProblem}
          </p>
        )}

        <button className={submitClasses} disabled={busy || text === null} type="submit">
          {getMessage(busy ? "catalogue.importBusy" : "catalogue.importSubmit")}
        </button>

        {failed ? (
          <p className="text-sm text-destructive" role="alert">
            {getMessage("catalogue.importFailed")}
          </p>
        ) : null}
      </form>

      {problem === null ? null : (
        <section
          aria-labelledby="catalogue-import-problem"
          className="flex flex-col gap-2 rounded-lg border border-destructive p-4"
        >
          <h2 className="text-base font-semibold" id="catalogue-import-problem">
            {getMessage("catalogue.importRefusedHeading")}
          </h2>
          <p className="text-sm text-destructive" role="alert">
            {problemKey === undefined
              ? getMessage("catalogue.importProblemUnknown")
              : getMessage(problemKey)}
          </p>
          {problemLine === null ? null : (
            <p className="text-xs text-muted-foreground">
              {formatMessage("catalogue.importProblemLine", { line: problemLine })}
            </p>
          )}
        </section>
      )}

      {report === null ? null : (
        <section aria-labelledby="catalogue-import-report" className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold tracking-tight" id="catalogue-import-report">
            {getMessage("catalogue.importReportHeading")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {formatMessage("catalogue.importReportSummary", {
              created: report.created,
              refused: report.refused,
            })}
          </p>

          {report.ignoredColumns.length === 0 ? null : (
            <p className="text-xs text-muted-foreground">
              {formatMessage("catalogue.importIgnoredColumns", {
                columns: report.ignoredColumns.join(", "),
              })}
            </p>
          )}

          {report.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{getMessage("catalogue.importNothingToDo")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className={tableClasses}>
                <thead>
                  <tr>
                    <th className={headCellClasses} scope="col">
                      {getMessage("catalogue.importColumnLine")}
                    </th>
                    <th className={headCellClasses} scope="col">
                      {getMessage("catalogue.importColumnOutcome")}
                    </th>
                    <th className={headCellClasses} scope="col">
                      {getMessage("catalogue.importColumnDetail")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {report.rows.map((row) => (
                    <tr key={row.line}>
                      <td className={cellClasses}>{row.line}</td>
                      <td className={cellClasses}>
                        {getMessage(
                          row.status === "created"
                            ? "catalogue.importRowCreated"
                            : "catalogue.importRowRefused",
                        )}
                      </td>
                      <td className={cellClasses}>
                        {row.status === "created"
                          ? (row.name ?? getMessage("catalogue.importRowCreated"))
                          : row.problems
                              .map((detail) => `${detail.field}: ${ruleSentence(detail.rule)}`)
                              .join(" ")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {report.created === 0 ? null : (
            <Link className={linkClasses} href={listPath}>
              {getMessage("catalogue.importGoToList")}
            </Link>
          )}
        </section>
      )}
    </div>
  );
}
