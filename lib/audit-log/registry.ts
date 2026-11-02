// path: lib/audit-log/registry.ts
import type { PlatformRole } from "../auth/types.ts";
import { endOfDayEpochMs } from "../announcements/registry.ts";
import type { MessagePath } from "../i18n/messages.ts";
import { calendarDayOf, isCalendarDay } from "../settings/registry.ts";
import { deepFreeze } from "../utils/freeze.ts";

/**
 * The audit log viewer's vocabulary: who may read the log, what a filter is, and the bounds a filter
 * has to respect before a query is built from it.
 *
 * ## What already exists
 *
 * `0013_audit_logs.sql` is the log itself - append-only, hash-chained, Ed25519 signed, one chain per
 * tenant, `audit_logs_action_check` fixing the shape of an action name - and `0075` turned the
 * canonical hash of `0013`'s comment into SQL: `audit_next_link`, `audit_hash_v1`,
 * `audit_log_row_hash`, `audit_verify_chain` and `audit_merkle_root`. `0074` gives the read to three
 * office roles and to a merchant for its own company's rows.
 *
 * This STEP adds no table, no column and no policy. It adds the part the database cannot decide:
 * which filters the viewer offers, what shape each one has, how a day becomes an instant, and how
 * much of a row is safe to put on a screen.
 *
 * ## Why the day helpers are imported rather than written again
 *
 * A calendar day is a rule this platform has already stated twice - `lib/settings/registry.ts` fixes
 * what a day that exists is, and `lib/announcements/registry.ts` fixes what the end of a day is -
 * and both are covered by their own gates. A third copy for the audit viewer would be a third place
 * for "2026-02-30 is not a day" to drift. So the viewer borrows the two functions instead.
 *
 * ## Why the filter set is closed
 *
 * Every filter the viewer offers is a column that `0013` indexes, or a range over `created_at` that
 * `0100` indexes. There is deliberately no free text search: `payload` is a jsonb document and a
 * substring scan over it would be a sequential scan of the whole platform's history on every
 * keystroke. What the viewer offers instead is the key the event was recorded under - an action
 * family, an actor, an entity or a company - which is how a person actually looks for a row.
 */

/** The roles that may read the audit log: the three `0074` grants its select to. */
export const AUDIT_LOG_READ_ROLES: readonly PlatformRole[] = deepFreeze([
  "ceo",
  "compliance_kyc",
  "super_admin",
] as const satisfies readonly PlatformRole[]);

/** The roles that may open the viewer: the same three, because reading is all it does. */
export const AUDIT_LOG_SCREEN_ROLES: readonly PlatformRole[] = deepFreeze([
  "ceo",
  "compliance_kyc",
  "super_admin",
] as const satisfies readonly PlatformRole[]);

/** How many rows one page of the viewer carries. */
export const AUDIT_LOG_PAGE_SIZE = 50;

/**
 * The furthest a person may page back.
 *
 * An append-only log only grows at the head, so an offset is a window and not a position: new rows
 * shift the page under a reader. That is acceptable for a viewer that is read from the newest end,
 * and a cap keeps one page from turning into a scan of a year of history.
 */
export const AUDIT_LOG_MAXIMUM_OFFSET = 2_000;

/** The longest range a filter may ask for: a year of history at a time. */
export const AUDIT_LOG_MAXIMUM_RANGE_DAYS = 366;

/** How much of a row's payload the viewer prints before it stops. */
export const AUDIT_LOG_PAYLOAD_PREVIEW_MAXIMUM = 2_000;

/** How much of a client's user agent the viewer prints. */
export const AUDIT_LOG_USER_AGENT_PREVIEW_MAXIMUM = 160;

/** How much of a hash the viewer prints: enough to compare two rows by eye. */
export const AUDIT_LOG_HASH_PREVIEW_LENGTH = 12;

/** `audit_logs_action_check`'s shape, as a prefix: the family filter types the start of an action. */
export const AUDIT_LOG_ACTION_PREFIX_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*\.?$/u;

/** `audit_logs_entity_type_check`'s shape. */
export const AUDIT_LOG_ENTITY_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,47}$/u;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** True when a value is a lower case hyphenated uuid, which every identifier column holds. */
export function isUuid(value: string): boolean {
  return uuidPattern.test(value);
}

/** The one company value that is not an identifier: the platform's own chain. */
export const AUDIT_PLATFORM_COMPANY_PARAMETER = "platform";

/** What a person asked the viewer for, after every value has been checked. */
export interface AuditFilters {
  /** The start of an action name, such as `session.` or `compliance.item_`. */
  readonly action: string | null;
  readonly actorUserId: string | null;
  readonly entityType: string | null;
  readonly entityId: string | null;
  /** One company's rows, or null for every company. */
  readonly companyId: string | null;
  /** True when only the platform's own chain is asked for (`company_id is null`). */
  readonly platformOnly: boolean;
  readonly fromDay: string | null;
  readonly toDay: string | null;
}

/** Which input a problem belongs to. */
export type AuditFilterField =
  | "action"
  | "actor"
  | "entityType"
  | "entityId"
  | "company"
  | "from"
  | "to"
  | "offset";

/** Why a filter value was refused. */
export interface AuditFilterProblem {
  readonly field: AuditFilterField;
  readonly rule: "invalid_format" | "invalid_date" | "invalid_range";
}

/** Everything one request asked for, checked. */
export interface ParsedAuditQuery {
  readonly filters: AuditFilters;
  readonly offset: number;
  /** The refused values, in the order the form lists them. A refused filter is not applied. */
  readonly problems: readonly AuditFilterProblem[];
}

/** The empty filter set: the newest rows of every chain. */
export const EMPTY_AUDIT_FILTERS: AuditFilters = deepFreeze({
  action: null,
  actorUserId: null,
  entityType: null,
  entityId: null,
  companyId: null,
  platformOnly: false,
  fromDay: null,
  toDay: null,
});

/** How many fields a filter form may carry, when it is read from a query string. */
export type AuditQueryParameters = Readonly<Record<string, string | readonly string[] | undefined>>;

function firstValue(parameters: AuditQueryParameters, key: string): string {
  const value = parameters[key];

  if (value === undefined) {
    return "";
  }

  return (typeof value === "string" ? value : (value[0] ?? "")).trim();
}

/**
 * Read one request's filters.
 *
 * A refused value is reported and then dropped rather than applied: a viewer that silently searched
 * for something else than what was typed would be worse than one that says the value is not a day.
 * `offset` is clamped into the window the module allows, because a hand-edited `offset` is not a way
 * to read the whole log in one response.
 */
export function parseAuditQuery(parameters: AuditQueryParameters): ParsedAuditQuery {
  const problems: AuditFilterProblem[] = [];
  const actionRaw = firstValue(parameters, "action").toLowerCase();
  const actorRaw = firstValue(parameters, "actor").toLowerCase();
  const entityTypeRaw = firstValue(parameters, "entityType").toLowerCase();
  const entityIdRaw = firstValue(parameters, "entityId").toLowerCase();
  const companyRaw = firstValue(parameters, "company").toLowerCase();
  const fromRaw = firstValue(parameters, "from");
  const toRaw = firstValue(parameters, "to");
  const offsetRaw = firstValue(parameters, "offset");
  let action: string | null = null;
  let actorUserId: string | null = null;
  let entityType: string | null = null;
  let entityId: string | null = null;
  let companyId: string | null = null;
  let platformOnly = false;
  let fromDay: string | null = null;
  let toDay: string | null = null;

  if (actionRaw.length > 0) {
    if (actionRaw.length > 64 || !AUDIT_LOG_ACTION_PREFIX_PATTERN.test(actionRaw)) {
      problems.push({ field: "action", rule: "invalid_format" });
    } else {
      action = actionRaw;
    }
  }

  if (actorRaw.length > 0) {
    if (!isUuid(actorRaw)) {
      problems.push({ field: "actor", rule: "invalid_format" });
    } else {
      actorUserId = actorRaw;
    }
  }

  if (entityTypeRaw.length > 0) {
    if (!AUDIT_LOG_ENTITY_TYPE_PATTERN.test(entityTypeRaw)) {
      problems.push({ field: "entityType", rule: "invalid_format" });
    } else {
      entityType = entityTypeRaw;
    }
  }

  if (entityIdRaw.length > 0) {
    if (!isUuid(entityIdRaw)) {
      problems.push({ field: "entityId", rule: "invalid_format" });
    } else {
      entityId = entityIdRaw;
    }
  }

  if (companyRaw.length > 0) {
    if (companyRaw === AUDIT_PLATFORM_COMPANY_PARAMETER) {
      platformOnly = true;
    } else if (isUuid(companyRaw)) {
      companyId = companyRaw;
    } else {
      problems.push({ field: "company", rule: "invalid_format" });
    }
  }

  if (fromRaw.length > 0) {
    if (isCalendarDay(fromRaw)) {
      fromDay = fromRaw;
    } else {
      problems.push({ field: "from", rule: "invalid_date" });
    }
  }

  if (toRaw.length > 0) {
    if (isCalendarDay(toRaw)) {
      toDay = toRaw;
    } else {
      problems.push({ field: "to", rule: "invalid_date" });
    }
  }

  if (fromDay !== null && toDay !== null) {
    const fromEpoch = startOfDayEpochMs(fromDay);
    const toEpoch = endOfDayEpochMs(toDay);

    if (fromEpoch !== null && toEpoch !== null) {
      if (toEpoch < fromEpoch) {
        problems.push({ field: "to", rule: "invalid_range" });
        toDay = null;
      } else if (toEpoch - fromEpoch > AUDIT_LOG_MAXIMUM_RANGE_DAYS * 86_400_000) {
        problems.push({ field: "from", rule: "invalid_range" });
        fromDay = null;
      }
    }
  }

  let offset = 0;

  if (offsetRaw.length > 0) {
    const parsed = Number.parseInt(offsetRaw, 10);

    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      problems.push({ field: "offset", rule: "invalid_format" });
    } else {
      offset = Math.min(parsed, AUDIT_LOG_MAXIMUM_OFFSET);
    }
  }

  return {
    filters: {
      action,
      actorUserId,
      entityType,
      entityId,
      companyId,
      platformOnly,
      fromDay,
      toDay,
    },
    offset,
    problems,
  };
}

/** The first instant of a calendar day, in UTC, or null when the value is not a day. */
export function startOfDayEpochMs(day: string): number | null {
  if (!isCalendarDay(day)) {
    return null;
  }

  const parsed = Date.parse(`${day}T00:00:00.000Z`);

  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The first instant after this day ends: the exclusive end of an inclusive day range.
 *
 * Written from the validated start of the day and one day's milliseconds rather than from
 * `endOfDayEpochMs`, because that helper normalises a day it cannot read (the thirty first of
 * February becomes the third of March) and a filter must refuse a day that does not exist rather than
 * silently read a different one.
 */
export function endOfDayExclusiveEpochMs(day: string): number | null {
  const start = startOfDayEpochMs(day);

  return start === null ? null : start + 86_400_000;
}

/** The calendar day an instant falls on, in UTC. The platform's clock everywhere. */
export function auditDayOf(epochMs: number): string {
  return calendarDayOf(epochMs);
}

/** True when any filter is set, so the screen can offer "clear" only when there is something. */
export function hasAuditFilters(filters: AuditFilters): boolean {
  return (
    filters.action !== null ||
    filters.actorUserId !== null ||
    filters.entityType !== null ||
    filters.entityId !== null ||
    filters.companyId !== null ||
    filters.platformOnly ||
    filters.fromDay !== null ||
    filters.toDay !== null
  );
}

/**
 * The query string one set of filters and one offset make.
 *
 * Written once, so the form, the pagination links and the service cannot disagree about how a filter
 * is spelled. Empty values are left out entirely rather than sent as empty strings: a URL that says
 * `action=` is a person who cleared the field, and the same URL without it means the same thing to
 * this module - but only one of them can be compared by eye.
 */
export function auditQueryStringOf(filters: AuditFilters, offset: number): string {
  const parts: string[] = [];
  const push = (key: string, value: string | null): void => {
    if (value !== null && value.length > 0) {
      parts.push(`${key}=${encodeURIComponent(value)}`);
    }
  };

  push("action", filters.action);
  push("actor", filters.actorUserId);
  push("entityType", filters.entityType);
  push("entityId", filters.entityId);

  if (filters.platformOnly) {
    push("company", AUDIT_PLATFORM_COMPANY_PARAMETER);
  } else {
    push("company", filters.companyId);
  }

  push("from", filters.fromDay);
  push("to", filters.toDay);

  if (offset > 0) {
    push("offset", String(offset));
  }

  return parts.join("&");
}

/** The catalog key of a refused filter's sentence. */
export function auditProblemMessageKey(problem: AuditFilterProblem): MessagePath {
  return problem.rule === "invalid_date"
    ? "officeAudit.problemDate"
    : problem.rule === "invalid_range"
      ? "officeAudit.problemRange"
      : "officeAudit.problemFormat";
}

/** The catalog key of a field's name, for the sentence a refused value produces. */
export function auditFieldLabelKey(field: AuditFilterField): MessagePath {
  switch (field) {
    case "action":
      return "officeAudit.fieldAction";
    case "actor":
      return "officeAudit.fieldActor";
    case "entityType":
      return "officeAudit.fieldEntityType";
    case "entityId":
      return "officeAudit.fieldEntityId";
    case "company":
      return "officeAudit.fieldCompany";
    case "from":
      return "officeAudit.fieldFrom";
    case "to":
      return "officeAudit.fieldTo";
    default:
      return "officeAudit.fieldOffset";
  }
}
