// path: app/(dashboard)/clients/import/client-import-form.tsx
"use client";

import Link from "next/link";
import { useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import { formatMessage, getMessage } from "@/lib/i18n/messages";
import type { MessagePath } from "@/lib/i18n/messages";
import { csrfHeaders } from "@/lib/security/csrf-client";
import type { ClientImportReport } from "@/services/clients/client-import";

/**
 * The client CSV import.
 *
 * ## Why the file is read in the browser before it is sent
 *
 * The route takes CSV text, so something has to turn the chosen file into text. `file.text()` does it,
 * which means the browser sends exactly the bytes the merchant chose with no multipart envelope and no
 * temporary file, and the server's size bound is the file's own length. It also lets this form refuse a
 * file that is obviously not an import - empty, or larger than the parser will read - before the
 * merchant waits for an upload that was never going to work.
 *
 * ## Why the report is a table and not a count
 *
 * "Invalid rows are reported row by row" is the requirement, and a merchant who is told "3 of 40 rows
 * failed" has to find those three themselves. Each refused row is printed with the line number it had
 * in *their* file and the fields that failed, so the fix is a search in their spreadsheet rather than a
 * hunt through the whole file.
 *
 * ## Why a refusal does not clear the file
 *
 * A file refused for a bad header is a file the merchant is about to fix and re-choose. Keeping what
 * they picked and saying exactly what was wrong with it means one round trip instead of two.
 *
 * ## Why the values that failed are never printed
 *
 * The answer names the field and the rule and never the value - an uploaded client file is personal
 * data, and a screen that echoes a bad email address back prints it on a page that may be shared,
 * screenshotted or logged. The merchant has the value in front of them in their own file; what they
 * need from this page is which line and which column.
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

/** The sentence of each way a file as a whole can be refused. */
const PROBLEM_KEYS: Readonly<Record<string, MessagePath>> = Object.freeze({
  empty: "clients.importProblemEmpty",
  header_missing: "clients.importProblemHeaderMissing",
  header_duplicate: "clients.importProblemHeaderDuplicate",
  row_too_wide: "clients.importProblemRowTooWide",
  too_many_rows: "clients.importProblemTooManyRows",
  too_large: "clients.importProblemTooLarge",
  invalid_quote: "clients.importProblemInvalidQuote",
  invalid_type: "clients.importProblemInvalidType",
});

/** The largest file this form will even read, matching the route's ceiling. */
const MAXIMUM_FILE_BYTES = 3_145_728;

/** The rule words this screen knows, so a refusal reads as a sentence. */
const RULE_KEYS: Readonly<Record<string, MessagePath>> = Object.freeze({
  required: "catalogue.ruleRequired",
  too_short: "catalogue.ruleTooShort",
  too_long: "catalogue.ruleTooLong",
  invalid_format: "catalogue.ruleInvalidFormat",
  already_used: "catalogue.ruleAlreadyUsed",
  address_requires_line1: "clients.importRuleAddressLine1",
  unknown_field: "catalogue.ruleUnknownField",
});

interface ImportAnswer {
  readonly status?: unknown;
  readonly report?: unknown;
  readonly problem?: unknown;
  readonly line?: unknown;
}

function ruleSentence(rule: string): string {
  const key = RULE_KEYS[rule];

  return key === undefined ? getMessage("clients.importRuleUnknown") : getMessage(key);
}

export function ClientImportForm(): ReactNode {
  const [fileName, setFileName] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [localProblem, setLocalProblem] = useState<string | null>(null);
  const [report, setReport] = useState<ClientImportReport | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [problemLine, setProblemLine] = useState<number | null>(null);
  const [failed, setFailed] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);

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
      setLocalProblem(getMessage("clients.importLocalTooLarge"));

      return;
    }

    const contents = await file.text();

    if (contents.trim().length === 0) {
      setLocalProblem(getMessage("clients.importLocalEmpty"));

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
      const response = await fetch("/api/clients/import", {
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
        setReport(payload.report as ClientImportReport);

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
          <span className={fieldNameClasses}>{getMessage("clients.importFileLabel")}</span>
          <input
            accept=".csv,text/csv,text/plain"
            className={fileInputClasses}
            name="file"
            onChange={(event) => void choose(event)}
            type="file"
          />
          <span className="text-xs text-muted-foreground">{getMessage("clients.importFileHint")}</span>
        </label>

        {fileName === null ? null : (
          <p className="text-xs text-muted-foreground">
            {formatMessage("clients.importChosenFile", { name: fileName })}
          </p>
        )}

        {localProblem === null ? null : (
          <p className="text-sm text-destructive" role="alert">
            {localProblem}
          </p>
        )}

        <button className={submitClasses} disabled={busy || text === null} type="submit">
          {getMessage(busy ? "clients.importBusy" : "clients.importSubmit")}
        </button>

        {failed ? (
          <p className="text-sm text-destructive" role="alert">
            {getMessage("clients.importFailed")}
          </p>
        ) : null}
      </form>

      {problem === null ? null : (
        <section aria-labelledby="import-problem" className="flex flex-col gap-2 rounded-lg border border-destructive p-4">
          <h2 className="text-base font-semibold" id="import-problem">
            {getMessage("clients.importRefusedHeading")}
          </h2>
          <p className="text-sm text-destructive" role="alert">
            {problemKey === undefined ? getMessage("clients.importProblemUnknown") : getMessage(problemKey)}
          </p>
          {problemLine === null ? null : (
            <p className="text-xs text-muted-foreground">
              {formatMessage("clients.importProblemLine", { line: problemLine })}
            </p>
          )}
        </section>
      )}

      {report === null ? null : (
        <section aria-labelledby="import-report" className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold tracking-tight" id="import-report">
            {getMessage("clients.importReportHeading")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {formatMessage("clients.importReportSummary", {
              created: report.created,
              refused: report.refused,
            })}
          </p>

          {report.ignoredColumns.length === 0 ? null : (
            <p className="text-xs text-muted-foreground">
              {formatMessage("clients.importIgnoredColumns", {
                columns: report.ignoredColumns.join(", "),
              })}
            </p>
          )}

          {report.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{getMessage("clients.importNothingToDo")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className={tableClasses}>
                <thead>
                  <tr>
                    <th className={headCellClasses} scope="col">
                      {getMessage("clients.importColumnLine")}
                    </th>
                    <th className={headCellClasses} scope="col">
                      {getMessage("clients.importColumnOutcome")}
                    </th>
                    <th className={headCellClasses} scope="col">
                      {getMessage("clients.importColumnDetail")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {report.rows.map((row) => (
                    <tr key={row.line}>
                      <td className={cellClasses}>{row.line}</td>
                      <td className={cellClasses}>
                        {getMessage(row.status === "created" ? "clients.importRowCreated" : "clients.importRowRefused")}
                      </td>
                      <td className={cellClasses}>
                        {row.status === "created"
                          ? (row.name ?? getMessage("clients.importRowCreated"))
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
            <Link className="w-fit text-sm font-medium text-primary underline-offset-4 hover:underline" href="/clients">
              {getMessage("clients.importGoToList")}
            </Link>
          )}
        </section>
      )}
    </div>
  );
}
