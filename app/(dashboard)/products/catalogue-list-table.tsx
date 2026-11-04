// path: app/(dashboard)/products/catalogue-list-table.tsx
import Link from "next/link";
import type { ReactNode } from "react";
import { formatMessage, getMessage } from "@/lib/i18n/messages";
import type { MessagePath } from "@/lib/i18n/messages";
import type { CatalogueListRow } from "@/services/products/catalogue-list";
import { CATALOGUE_PATHS, type CatalogueKind } from "@/services/products/catalogue-fields";

/**
 * One page of a catalogue, as a table.
 *
 * ## Why the table scrolls instead of wrapping
 *
 * Six columns of names, codes, prices and descriptions do not fit a phone, and a row whose cells wrap
 * onto four lines is a row nobody can compare with the one above it. The table keeps a minimum width
 * and the wrapper scrolls sideways, so every column stays on one line at any width and a keyboard user
 * can reach the overflow with the arrow keys.
 *
 * ## Why the code column is named per catalogue
 *
 * A product's code is a SKU and a service's code is a service code. Printing "SKU" above a service
 * would tell a merchant to look for a field that catalogue does not have, so the heading comes from
 * the kind - which is the same reason the form names its box that way.
 *
 * ## Why the price is printed by the service and not here
 *
 * `unitPrice` arrives already formatted by `priceFromMinor`, the one function allowed to touch an
 * amount. This component concatenates it with the currency and never divides by ten thousand itself,
 * so the list and the edit form cannot disagree about what a stored price says.
 *
 * ## Why a missing value prints a word instead of nothing
 *
 * An empty cell reads as "the screen failed to load this" rather than "this entry has no code". The
 * catalog carries the word, in the same muted colour as the rest of the secondary text.
 *
 * ## Why the name is the only link
 *
 * The list is a way into the record, not a report: the name answers "which entry is this" and "where
 * do I change it" in one gesture. The whole row is not a link because a table of full-row links cannot
 * be selected with the mouse or copied from.
 */

const tableClasses = "w-full min-w-3xl border-collapse text-left text-sm";

const headCellClasses =
  "border-b border-border px-3 pb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground";

const cellClasses = "border-b border-border px-3 py-3 align-top";

const nameLinkClasses =
  "rounded-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-primary";

const descriptionClasses = "max-w-xs text-muted-foreground";

interface CatalogueListTableProps {
  readonly kind: CatalogueKind;
  readonly entries: readonly CatalogueListRow[];
}

function instantOf(epochMs: number): string {
  return new Date(epochMs).toISOString().replace("T", " ").slice(0, 19);
}

function headingsOf(kind: CatalogueKind): readonly string[] {
  return [
    getMessage("catalogue.columnName"),
    getMessage(kind === "product" ? "catalogue.skuColumn" : "catalogue.columnCode"),
    getMessage("catalogue.columnPrice"),
    getMessage("catalogue.columnUnit"),
    getMessage("catalogue.columnDescription"),
    getMessage("catalogue.columnCreated"),
  ];
}

export function CatalogueListTable({ kind, entries }: CatalogueListTableProps): ReactNode {
  const empty = getMessage("catalogue.valueEmpty");
  const path = `/${CATALOGUE_PATHS[kind]}`;

  return (
    <div className="overflow-x-auto">
      <table className={tableClasses}>
        <thead>
          <tr>
            {headingsOf(kind).map((heading) => (
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
                <Link className={nameLinkClasses} href={`${path}/${entry.id}`}>
                  {entry.name}
                </Link>
              </td>
              <td className={cellClasses}>{entry.code ?? empty}</td>
              <td className={cellClasses}>
                {formatMessage("catalogue.priceLine", {
                  amount: entry.unitPrice,
                  currency: entry.currency,
                })}
              </td>
              <td className={cellClasses}>
                {getMessage(`catalogue.unit_${entry.unit}` as MessagePath)}
              </td>
              <td className={`${cellClasses} ${descriptionClasses}`}>{entry.description ?? empty}</td>
              <td className={cellClasses}>
                {formatMessage("catalogue.createdLine", { at: instantOf(entry.createdAtEpochMs) })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
