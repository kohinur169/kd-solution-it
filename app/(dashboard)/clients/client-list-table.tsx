// path: app/(dashboard)/clients/client-list-table.tsx
import Link from "next/link";
import type { ReactNode } from "react";
import { formatMessage, getMessage } from "@/lib/i18n/messages";
import type { ClientListRow } from "@/services/clients/client-list";

/**
 * One page of the client list, as a table.
 *
 * ## Why the table scrolls instead of wrapping
 *
 * Six columns of names, companies and addresses do not fit a phone, and a row whose cells wrap onto
 * four lines is a row nobody can compare with the one above it. The table therefore keeps its
 * minimum width and the wrapper scrolls sideways, which keeps every column on one line at any width
 * and lets a keyboard user reach the overflow with the arrow keys.
 *
 * ## Why a missing value prints a word instead of nothing
 *
 * An empty cell reads as "the screen failed to load this" rather than "this client has no phone".
 * The catalog carries the word, and it is printed in the same muted colour as the rest of the
 * secondary text, so a book full of clients with no company still looks like a table.
 *
 * ## Why each row links to the edit screen
 *
 * The list is a way into the record, not a report: the name is the one link, so the row answers
 * "which client is this" and "where do I change it" in one gesture, and the whole row is not a link
 * because a table of full-row links cannot be copied from or selected with the mouse.
 */

const tableClasses = "w-full min-w-3xl border-collapse text-left text-sm";

const headCellClasses =
  "border-b border-border px-3 pb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground";

const cellClasses = "border-b border-border px-3 py-3 align-top";

const nameLinkClasses =
  "rounded-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-primary";

interface ClientListTableProps {
  readonly clients: readonly ClientListRow[];
}

function instantOf(epochMs: number): string {
  return new Date(epochMs).toISOString().replace("T", " ").slice(0, 19);
}

function headings(): readonly string[] {
  return [
    getMessage("clients.columnName"),
    getMessage("clients.columnCompany"),
    getMessage("clients.columnEmail"),
    getMessage("clients.columnPhone"),
    getMessage("clients.columnCity"),
    getMessage("clients.columnCreated"),
  ];
}

export function ClientListTable({ clients }: ClientListTableProps): ReactNode {
  const empty = getMessage("clients.valueEmpty");

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
          {clients.map((client) => (
            <tr key={client.id}>
              <td className={cellClasses}>
                <Link className={nameLinkClasses} href={`/clients/${client.id}`}>
                  {client.name}
                </Link>
              </td>
              <td className={cellClasses}>{client.companyName ?? empty}</td>
              <td className={cellClasses}>{client.email ?? empty}</td>
              <td className={cellClasses}>{client.phone ?? empty}</td>
              <td className={cellClasses}>{client.city ?? empty}</td>
              <td className={cellClasses}>
                {formatMessage("clients.createdLine", { at: instantOf(client.createdAtEpochMs) })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
