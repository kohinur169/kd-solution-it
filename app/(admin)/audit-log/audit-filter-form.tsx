// path: app/(admin)/audit-log/audit-filter-form.tsx
import Link from "next/link";
import type { ReactNode } from "react";
import {
  AUDIT_PLATFORM_COMPANY_PARAMETER,
  hasAuditFilters,
  type AuditFilters,
} from "@/lib/audit-log/registry";
import { getMessage } from "@/lib/i18n/messages";

/**
 * The viewer's filter form.
 *
 * ## Why it is a plain GET form
 *
 * A filter changes what is read and nothing else, so it belongs in the address bar: the page is
 * bookmarkable, a colleague can be sent the exact query, and the server renders the answer without a
 * round trip through a client component, a fetch and a CSRF token - none of which a read needs. That
 * is also why there is no hidden `offset` field: pressing the button is asking a new question, and a
 * new question starts at the newest end rather than at the depth the previous answer had reached.
 *
 * ## Why every field carries its own sentence
 *
 * The shape each field wants is not guessable - a uuid, a dotted prefix, a day - and a form that
 * refuses a value without saying what it wanted is a form that teaches nothing. The hints are the
 * catalog's, so the refusal below the form and the hint above the field cannot drift apart.
 *
 * ## Why the fields are not `required`
 *
 * Every field is optional by design: an empty form is the newest rows of every chain, which is where
 * a viewer starts. Marking them required would make the honest empty search the one search the form
 * refuses.
 */

const labelClasses = "flex flex-col gap-1";

const fieldNameClasses = "text-sm font-medium";

const hintClasses = "text-xs text-muted-foreground";

const inputClasses =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary";

const submitClasses =
  "inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-primary";

const clearClasses =
  "inline-flex items-center justify-center rounded-lg border border-border px-4 py-2.5 text-sm font-semibold text-foreground transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary";

interface AuditFilterFormProps {
  readonly filters: AuditFilters;
}

export function AuditFilterForm({ filters }: AuditFilterFormProps): ReactNode {
  return (
    <form action="/audit-log" className="flex flex-col gap-4" method="get">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <label className={labelClasses}>
          <span className={fieldNameClasses}>{getMessage("officeAudit.fieldAction")}</span>
          <input
            autoComplete="off"
            className={inputClasses}
            defaultValue={filters.action ?? ""}
            name="action"
            spellCheck={false}
            type="text"
          />
          <span className={hintClasses}>{getMessage("officeAudit.hintAction")}</span>
        </label>

        <label className={labelClasses}>
          <span className={fieldNameClasses}>{getMessage("officeAudit.fieldActor")}</span>
          <input
            autoComplete="off"
            className={inputClasses}
            defaultValue={filters.actorUserId ?? ""}
            name="actor"
            spellCheck={false}
            type="text"
          />
          <span className={hintClasses}>{getMessage("officeAudit.hintActor")}</span>
        </label>

        <label className={labelClasses}>
          <span className={fieldNameClasses}>{getMessage("officeAudit.fieldEntityType")}</span>
          <input
            autoComplete="off"
            className={inputClasses}
            defaultValue={filters.entityType ?? ""}
            name="entityType"
            spellCheck={false}
            type="text"
          />
          <span className={hintClasses}>{getMessage("officeAudit.hintEntityType")}</span>
        </label>

        <label className={labelClasses}>
          <span className={fieldNameClasses}>{getMessage("officeAudit.fieldEntityId")}</span>
          <input
            autoComplete="off"
            className={inputClasses}
            defaultValue={filters.entityId ?? ""}
            name="entityId"
            spellCheck={false}
            type="text"
          />
          <span className={hintClasses}>{getMessage("officeAudit.hintEntityId")}</span>
        </label>

        <label className={labelClasses}>
          <span className={fieldNameClasses}>{getMessage("officeAudit.fieldCompany")}</span>
          <input
            autoComplete="off"
            className={inputClasses}
            defaultValue={
              filters.platformOnly
                ? AUDIT_PLATFORM_COMPANY_PARAMETER
                : (filters.companyId ?? "")
            }
            name="company"
            spellCheck={false}
            type="text"
          />
          <span className={hintClasses}>{getMessage("officeAudit.hintCompany")}</span>
        </label>

        <label className={labelClasses}>
          <span className={fieldNameClasses}>{getMessage("officeAudit.fieldFrom")}</span>
          <input
            className={inputClasses}
            defaultValue={filters.fromDay ?? ""}
            inputMode="numeric"
            name="from"
            type="text"
          />
          <span className={hintClasses}>{getMessage("officeAudit.hintFrom")}</span>
        </label>

        <label className={labelClasses}>
          <span className={fieldNameClasses}>{getMessage("officeAudit.fieldTo")}</span>
          <input
            className={inputClasses}
            defaultValue={filters.toDay ?? ""}
            inputMode="numeric"
            name="to"
            type="text"
          />
          <span className={hintClasses}>{getMessage("officeAudit.hintTo")}</span>
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button className={submitClasses} type="submit">
          {getMessage("officeAudit.filterSubmit")}
        </button>
        {hasAuditFilters(filters) ? (
          <Link className={clearClasses} href="/audit-log">
            {getMessage("officeAudit.filterClear")}
          </Link>
        ) : null}
        {hasAuditFilters(filters) ? (
          <p className="text-xs text-muted-foreground">{getMessage("officeAudit.filtersActive")}</p>
        ) : null}
      </div>
    </form>
  );
}
