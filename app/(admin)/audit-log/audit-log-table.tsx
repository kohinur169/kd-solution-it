// path: app/(admin)/audit-log/audit-log-table.tsx
import type { ReactNode } from "react";
import type { AuditEntryView } from "@/lib/audit-log/service";
import { formatMessage, getMessage } from "@/lib/i18n/messages";

/**
 * One page of the log, as a table.
 *
 * ## Why the payload is folded away
 *
 * A row's payload is at most eight kilobytes of jsonb, and fifty of them printed open is a page
 * nobody can read. It is folded into a `details` element - native, keyboard operable, and printable -
 * and printed as text inside `pre`, never as markup, because the payload is data that came back from
 * the database and not something this screen composed.
 *
 * ## Why the hashes are cut to twelve characters
 *
 * Nobody compares sixty four hex characters by eye. Twelve is enough to see that two rows differ, and
 * the full value stays in the row the verifier reads, so the cut takes nothing away from the check
 * itself - it only stops a table from being unreadable.
 *
 * ## Why a short identifier
 *
 * An actor and an entity are uuids, and a column of sixteen of them is a wall. The first eight
 * characters are what a person types into the filter above anyway, and the whole value stays in the
 * row for the copy that matters.
 */

const tableClasses = "w-full min-w-3xl border-collapse text-left text-sm";

const headCellClasses =
  "border-b border-border pb-2 pr-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground";

const cellClasses = "border-b border-border py-3 pr-4 align-top";

const codeClasses = "font-mono text-xs";

const summaryClasses = "cursor-pointer font-semibold text-primary underline-offset-4 hover:underline";

const payloadClasses = "mt-2 max-h-64 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs";

const shortIdentifierLength = 8;

function shortIdentifier(value: string): string {
  return value.slice(0, shortIdentifierLength);
}

function instantOf(iso: string): string {
  return iso.replace("T", " ").slice(0, 19);
}

function headings(): readonly string[] {
  return [
    getMessage("officeAudit.columnTime"),
    getMessage("officeAudit.columnAction"),
    getMessage("officeAudit.columnActor"),
    getMessage("officeAudit.columnEntity"),
    getMessage("officeAudit.columnChain"),
    getMessage("officeAudit.columnSequence"),
    getMessage("officeAudit.columnHash"),
    getMessage("officeAudit.columnPayload"),
  ];
}

interface AuditLogTableProps {
  readonly entries: readonly AuditEntryView[];
}

export function AuditLogTable({ entries }: AuditLogTableProps): ReactNode {
  return (
    <div className="overflow-x-auto">
      <table className={tableClasses}>
        <thead>
          <tr>
            {headings().map((heading) => (
              <th className={headCellClasses} key={heading} scope="col">
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id}>
              <td className={cellClasses}>
                {formatMessage("officeAudit.timeLine", { at: instantOf(entry.createdAtIso) })}
              </td>
              <td className={cellClasses}>
                <span className={codeClasses}>{entry.action}</span>
              </td>
              <td className={cellClasses}>
                {entry.actorUserId === null ? (
                  <span className="text-muted-foreground">{getMessage("officeAudit.notRecorded")}</span>
                ) : (
                  <span className={codeClasses}>{shortIdentifier(entry.actorUserId)}</span>
                )}
              </td>
              <td className={cellClasses}>
                {entry.entityType === null ? (
                  <span className="text-muted-foreground">{getMessage("officeAudit.notRecorded")}</span>
                ) : (
                  <span className={codeClasses}>
                    {entry.entityType}
                    {entry.entityId === null ? "" : ` ${shortIdentifier(entry.entityId)}`}
                  </span>
                )}
              </td>
              <td className={cellClasses}>
                {entry.companyId === null
                  ? getMessage("officeAudit.platformChain")
                  : formatMessage("officeAudit.merchantChain", {
                      company: shortIdentifier(entry.companyId),
                    })}
              </td>
              <td className={cellClasses}>
                {formatMessage("officeAudit.sequenceLine", { sequence: entry.sequence })}
              </td>
              <td className={cellClasses}>
                <span className={codeClasses} title={entry.hashPreview}>
                  {formatMessage("officeAudit.hashLine", {
                    hash: entry.hashPreview,
                    previous: entry.prevHashPreview,
                  })}
                </span>
              </td>
              <td className={cellClasses}>
                {entry.payloadPreview === "{}" ? (
                  <span className="text-muted-foreground">{getMessage("officeAudit.payloadEmpty")}</span>
                ) : (
                  <details>
                    <summary className={summaryClasses}>{getMessage("officeAudit.payloadOpen")}</summary>
                    <pre className={payloadClasses}>{entry.payloadPreview}</pre>
                    {entry.payloadTruncated ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {getMessage("officeAudit.payloadTruncated")}
                      </p>
                    ) : null}
                  </details>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
