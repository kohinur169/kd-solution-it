// path: lib/settings/service.ts
import { z } from "zod";
import { AppError } from "../errors/app-error.ts";
import type { AuditTrail } from "../auth/audit.ts";
import type { RestClient } from "../auth/rest.ts";
import { requireAnyRole } from "../auth/session.ts";
import { requireFreshReauthentication } from "../auth/step-up.ts";
import type { RequestActor } from "../auth/types.ts";
import { requireRelativePath } from "../security/url.ts";
import {
  COMPLIANCE_ALERT_SENT_AUDIT_ACTION,
  COMPLIANCE_ALERT_MAXIMUM_DAYS,
  COMPLIANCE_ALERT_MINIMUM_DAYS,
  COMPLIANCE_CALENDAR_LIMIT,
  COMPLIANCE_CALENDAR_MANAGE_ROLES,
  COMPLIANCE_CALENDAR_READ_ROLES,
  COMPLIANCE_DEFAULT_ALERT_DAYS,
  COMPLIANCE_ISSUER_MAXIMUM_LENGTH,
  COMPLIANCE_ITEM_ADDED_AUDIT_ACTION,
  COMPLIANCE_ITEM_ARCHIVED_AUDIT_ACTION,
  COMPLIANCE_ITEM_EXPIRED_AUDIT_ACTION,
  COMPLIANCE_ITEM_RENEWED_AUDIT_ACTION,
  COMPLIANCE_NOTE_MAXIMUM_LENGTH,
  COMPLIANCE_REFERENCE_MAXIMUM_LENGTH,
  COMPLIANCE_TITLE_MAXIMUM_LENGTH,
  PLATFORM_INFORMATION_FIELDS,
  PLATFORM_INFORMATION_ROLES,
  PLATFORM_SETTINGS_AUDIT_ACTION,
  alertDaysProblemOf,
  calendarDayOf,
  complianceKindLabelKey,
  complianceStateLabelKey,
  complianceStateOf,
  complianceStatusLabelKey,
  daysUntil,
  isCalendarDay,
  isComplianceItemKind,
  isComplianceItemStatus,
  platformSettingFieldOf,
  settingValueProblemOf,
  type ComplianceItemKind,
  type ComplianceItemStatus,
  type ComplianceState,
  type SettingKind,
} from "./registry.ts";

/**
 * The platform's general settings and the compliance calendar of section 3.
 *
 * ## The settings half
 *
 * Section 24 gives the super administrator "the platform logo and all platform information from
 * settings", and `0080` built the registry that holds it: one dotted key, one JSON value, the key
 * frozen, a unique live row per key. This module is the writer that registry never had. It reads the
 * ten keys of `registry.ts` in one query, defaults what nobody has saved yet, validates each value
 * against the shape its kind demands, and writes back only the keys that actually changed.
 *
 * A missing row is a default and not an error: a fresh deployment has no rows at all, and a form that
 * refused to render until somebody inserted one would make the first save impossible. The write
 * inserts a key that does not exist and updates the one that does, with the version it read.
 *
 * ## The calendar half
 *
 * `0068` created `public.compliance_items` with its own state machine: `active` walks to `expired`,
 * `renewed` or `archived`, an expiry moves forward only, and a renewal is a *new row* for the new
 * period rather than an edit of the old one. This module follows that grammar exactly:
 *
 *   - `addComplianceItem` files a certificate or an attestation;
 *   - `renewComplianceItem` files the replacement period as a new row and closes the old row as
 *     `renewed`, in that order, so a failure between the two leaves an extra row rather than a lost
 *     record;
 *   - `archiveComplianceItem` takes an item off the calendar without deleting it, because the guard
 *     refuses a delete;
 *   - `runComplianceCalendarCheck` is the body of section 27's "compliance calendar expiry alerts for
 *     annual renewals": it moves what has expired to `expired` and stamps `last_alert_at` on what is
 *     inside its own alert window, once.
 *
 * ## Why the check stamps and audits instead of sending
 *
 * The platform has no email transport yet: `email_send_logs` exists, `lib/jobs` has no database store,
 * and inventing a sender here would be a fourth way to send mail. So the check does the two things that
 * are this module's - the state the calendar reaches and the record that a warning was due - and the
 * handoff names the wiring the delivery still needs. A stamped row is never warned twice
 * (`last_alert_at` moves forward only), so a later sender can read the stamp without repeating a
 * warning a person already acted on.
 */

/** The two tables this module needs, and no more. */
export type SettingsStore = Omit<RestClient, "rpc">;

export interface SettingsDependencies {
  readonly store: SettingsStore;
  readonly audit: AuditTrail;
  readonly now?: () => number;
}

/** One field of the platform information form, as the screen renders it. */
export interface PlatformSettingView {
  readonly key: string;
  readonly group: string;
  readonly kind: SettingKind;
  readonly labelKey: string;
  readonly hintKey: string | null;
  readonly required: boolean;
  readonly maxLength: number;
  readonly value: string;
  /** True when a row exists, so the screen can say which values are still the default. */
  readonly isSet: boolean;
}

/** Everything the settings half of the screen renders. */
export interface PlatformInformationSnapshot {
  readonly fields: readonly PlatformSettingView[];
  /** The newest save among the rows that exist, or null when nobody has saved anything yet. */
  readonly savedAtEpochMs: number | null;
  readonly readAtEpochMs: number;
  /** True when this account may save: section 24's one role. */
  readonly canEdit: boolean;
}

/** One row of the compliance calendar, as the screen reads it. */
export interface ComplianceItemView {
  readonly id: string;
  readonly kind: ComplianceItemKind;
  readonly kindLabelKey: string;
  readonly title: string;
  readonly issuer: string;
  readonly reference: string | null;
  readonly issuedOn: string;
  readonly expiresOn: string;
  readonly alertDays: number;
  readonly status: ComplianceItemStatus;
  readonly statusLabelKey: string;
  readonly state: ComplianceState;
  readonly stateLabelKey: string;
  /** Days until the expiry; negative once it has passed. */
  readonly daysRemaining: number | null;
  readonly note: string | null;
  readonly lastAlertAtEpochMs: number | null;
  readonly renewedAtEpochMs: number | null;
  readonly version: number;
}

/** Everything the calendar half of the screen renders. */
export interface ComplianceCalendarSnapshot {
  readonly items: readonly ComplianceItemView[];
  /** Items inside their own alert window and not yet expired. */
  readonly dueCount: number;
  /** Items whose expiry is behind us and which are still `active`. */
  readonly overdueCount: number;
  /** Items the check has never warned about, inside their window. */
  readonly unalertedCount: number;
  readonly activeCount: number;
  readonly today: string;
  readonly readAtEpochMs: number;
  /** True when this account may file, renew, archive or run the check. */
  readonly canManage: boolean;
}

/** What one run of the section 27 check did. */
export interface ComplianceCheckResult {
  readonly examined: number;
  readonly expired: number;
  readonly alerted: number;
  /** Rows that moved under the check, and are therefore somebody else's answer. */
  readonly skipped: number;
  readonly ranAtEpochMs: number;
}

const settingRowSchema = z.object({
  id: z.string().min(1).max(64),
  setting_key: z.string().min(3).max(64),
  value: z.unknown(),
  updated_at: z.string().min(1).max(40),
  version: z.number().int().positive(),
});

const versionRowSchema = z.object({ version: z.number().int().positive() });

const itemRowSchema = z.object({
  id: z.string().min(1).max(64),
  kind: z.string().min(1).max(40),
  title: z.string().min(1).max(COMPLIANCE_TITLE_MAXIMUM_LENGTH),
  issuer: z.string().min(1).max(COMPLIANCE_ISSUER_MAXIMUM_LENGTH),
  reference: z.string().max(COMPLIANCE_REFERENCE_MAXIMUM_LENGTH).nullable(),
  issued_on: z.string().min(10).max(10),
  expires_on: z.string().min(10).max(10),
  alert_days: z.number().int().min(COMPLIANCE_ALERT_MINIMUM_DAYS).max(COMPLIANCE_ALERT_MAXIMUM_DAYS),
  status: z.string().min(1).max(20),
  document_file_id: z.string().min(1).max(64).nullable(),
  owner_id: z.string().min(1).max(64).nullable(),
  last_alert_at: z.string().min(1).max(40).nullable(),
  renewed_at: z.string().min(1).max(40).nullable(),
  note: z.string().max(COMPLIANCE_NOTE_MAXIMUM_LENGTH).nullable(),
  version: z.number().int().positive(),
});

const insertedRowSchema = z.object({ id: z.string().min(1).max(64) });

const itemColumns =
  "select=id,kind,title,issuer,reference,issued_on,expires_on,alert_days,status," +
  "document_file_id,owner_id,last_alert_at,renewed_at,note,version";

const itemSelect =
  `${itemColumns}&company_id=is.null&deleted_at=is.null&order=expires_on.asc` +
  `&limit=${String(COMPLIANCE_CALENDAR_LIMIT)}`;

const settingsColumns = "select=id,setting_key,value,updated_at,version";

const settingsSelect =
  `${settingsColumns}&setting_key=in.(${PLATFORM_INFORMATION_FIELDS.map((field) => field.key).join(",")})` +
  "&is_secret=eq.false&deleted_at=is.null&limit=64";

function nowOf(dependencies: SettingsDependencies): number {
  return dependencies.now?.() ?? Date.now();
}

function epochOf(value: string): number {
  const parsed = Date.parse(value);

  if (!Number.isFinite(parsed)) {
    throw new AppError("INTERNAL_ERROR");
  }

  return parsed;
}

function encoded(value: string): string {
  return encodeURIComponent(value);
}

/** The two mutations' shared guard: section 24's role, and a second factor proved recently. */
function requireSettingsEditor(actor: RequestActor, instant: number): void {
  requireAnyRole(actor, PLATFORM_INFORMATION_ROLES);
  requireFreshReauthentication(actor, instant);
}

/** The calendar's guard: the two desks that work the book, and a fresh second factor. */
function requireCalendarEditor(actor: RequestActor, instant: number): void {
  requireAnyRole(actor, COMPLIANCE_CALENDAR_MANAGE_ROLES);
  requireFreshReauthentication(actor, instant);
}

async function readSettingRows(
  dependencies: SettingsDependencies,
): Promise<readonly z.infer<typeof settingRowSchema>[]> {
  return dependencies.store.select("platform_settings", settingsSelect, settingRowSchema);
}

/** The stored string of a row, or null when the value is not a string this screen wrote. */
function stringValueOf(row: z.infer<typeof settingRowSchema> | undefined): string | null {
  if (row === undefined) {
    return null;
  }

  return typeof row.value === "string" ? row.value : null;
}

/**
 * The platform information, with the defaults filled in.
 *
 * One query for the ten keys. A row whose value is not a string is treated as unset rather than
 * rendered as JSON: this screen writes strings, so anything else is a row somebody else wrote.
 */
export async function readPlatformInformation(
  input: { readonly actor: RequestActor },
  dependencies: SettingsDependencies,
): Promise<PlatformInformationSnapshot> {
  const instant = nowOf(dependencies);

  requireAnyRole(input.actor, PLATFORM_INFORMATION_ROLES);

  const rows = await readSettingRows(dependencies);
  const byKey = new Map(rows.map((row) => [row.setting_key, row]));
  let savedAtEpochMs: number | null = null;

  for (const row of rows) {
    const updatedAt = epochOf(row.updated_at);

    savedAtEpochMs = savedAtEpochMs === null ? updatedAt : Math.max(savedAtEpochMs, updatedAt);
  }

  return {
    fields: PLATFORM_INFORMATION_FIELDS.map((field) => {
      const stored = stringValueOf(byKey.get(field.key));

      return {
        key: field.key,
        group: field.group,
        kind: field.kind,
        labelKey: field.labelKey,
        hintKey: field.hintKey,
        required: field.required,
        maxLength: field.maxLength,
        value: stored ?? field.default,
        isSet: stored !== null,
      };
    }),
    savedAtEpochMs,
    readAtEpochMs: instant,
    canEdit: PLATFORM_INFORMATION_ROLES.some((role) => input.actor.roles.includes(role)),
  };
}

/** One validated value, ready to be written. */
interface ValidatedSetting {
  readonly key: string;
  readonly value: string;
}

/**
 * Check and normalise the submitted values, in form order.
 *
 * Unknown keys are refused rather than ignored: a form that sends a key this module does not own is a
 * form written against another version of the registry, and writing half of it would leave the reader
 * with two truths. A logo path goes through the platform's own relative-path sanitiser after the
 * field's cheaper check, so a `..` that survived one rule meets the other.
 */
function validateSettings(values: Readonly<Record<string, string>>): readonly ValidatedSetting[] {
  const validated: ValidatedSetting[] = [];

  for (const [key, raw] of Object.entries(values)) {
    const field = platformSettingFieldOf(key);

    if (field === null) {
      throw new AppError("VALIDATION_FAILED", {
        details: [{ field: key, rule: "unknown_key" }],
      });
    }

    if (typeof raw !== "string") {
      throw new AppError("VALIDATION_FAILED", {
        details: [{ field: key, rule: "invalid_format" }],
      });
    }

    const problem = settingValueProblemOf({
      kind: field.kind,
      value: raw,
      required: field.required,
      maxLength: field.maxLength,
    });

    if (problem !== null) {
      throw new AppError("VALIDATION_FAILED", { details: [{ field: key, rule: problem }] });
    }

    const trimmed = raw.trim();

    validated.push({
      key,
      value:
        field.kind === "path" && trimmed.length > 0
          ? requireRelativePath(trimmed, key, field.maxLength)
          : trimmed,
    });
  }

  return validated;
}

/**
 * Save the platform information of section 24.
 *
 * Only the keys whose value actually changed are written, so an untouched field keeps its row, its
 * version and its `updated_by`. Each write is a compare-and-set on the version it just read, and the
 * read-back distinguishes a landed write from one that lost the race - the same shape the gateway and
 * country modules use, because `set_row_metadata` owns the counter.
 *
 * ## The staleness check
 *
 * A form is rendered from a snapshot and saved later. When the caller sends the instant that snapshot
 * was read and any row has moved since, the answer is `CONFLICT stale` rather than a silent overwrite
 * of a save somebody else made in between. A caller that sends nothing opts out, which is what a first
 * save from a freshly rendered page does.
 */
export async function savePlatformInformation(
  input: {
    readonly actor: RequestActor;
    readonly values: Readonly<Record<string, string>>;
    readonly expectedSavedAtEpochMs: number | null;
  },
  dependencies: SettingsDependencies,
): Promise<PlatformInformationSnapshot> {
  const instant = nowOf(dependencies);

  requireSettingsEditor(input.actor, instant);

  const validated = validateSettings(input.values);
  const rows = await readSettingRows(dependencies);
  const byKey = new Map(rows.map((row) => [row.setting_key, row]));

  if (input.expectedSavedAtEpochMs !== null) {
    const moved = rows.some((row) => epochOf(row.updated_at) > (input.expectedSavedAtEpochMs ?? 0));

    if (moved) {
      throw new AppError("CONFLICT", { details: [{ field: "savedAt", rule: "stale" }] });
    }
  }

  const changed: string[] = [];

  for (const setting of validated) {
    const row = byKey.get(setting.key);
    const current = stringValueOf(row);

    if (current !== null && current === setting.value) {
      continue;
    }

    if (row === undefined) {
      await dependencies.store.insert("platform_settings", [
        {
          setting_key: setting.key,
          value: setting.value,
          is_secret: false,
          updated_by: input.actor.userId,
        },
      ]);
      changed.push(setting.key);

      continue;
    }

    await dependencies.store.update(
      "platform_settings",
      `id=eq.${encoded(row.id)}&version=eq.${String(row.version)}`,
      { value: setting.value, updated_by: input.actor.userId },
    );

    const after = await dependencies.store.select(
      "platform_settings",
      `select=version&id=eq.${encoded(row.id)}&limit=1`,
      versionRowSchema,
    );

    if (after[0]?.version !== row.version + 1) {
      throw new AppError("CONFLICT", { details: [{ field: "savedAt", rule: "stale" }] });
    }

    changed.push(setting.key);
  }

  if (changed.length > 0) {
    await dependencies.audit.append({
      action: PLATFORM_SETTINGS_AUDIT_ACTION,
      actorUserId: input.actor.userId,
      entityType: "platform_settings",
      entityId: null,
      companyId: null,
      sessionId: input.actor.sessionId,
      payload: {
        changed_keys: changed,
        officer_changed: changed.some((key) => key.startsWith("compliance.officer")),
      },
    });
  }

  return readPlatformInformation({ actor: input.actor }, dependencies);
}

/** One calendar row as the screen reads it. */
function itemViewOf(row: z.infer<typeof itemRowSchema>, today: string): ComplianceItemView {
  if (!isComplianceItemKind(row.kind) || !isComplianceItemStatus(row.status)) {
    throw new AppError("INTERNAL_ERROR");
  }

  const state = complianceStateOf({
    expiresOn: row.expires_on,
    today,
    alertDays: row.alert_days,
    status: row.status,
  });

  return {
    id: row.id,
    kind: row.kind,
    kindLabelKey: complianceKindLabelKey(row.kind),
    title: row.title,
    issuer: row.issuer,
    reference: row.reference,
    issuedOn: row.issued_on,
    expiresOn: row.expires_on,
    alertDays: row.alert_days,
    status: row.status,
    statusLabelKey: complianceStatusLabelKey(row.status),
    state,
    stateLabelKey: complianceStateLabelKey(state),
    daysRemaining: daysUntil(row.expires_on, today),
    note: row.note,
    lastAlertAtEpochMs: row.last_alert_at === null ? null : epochOf(row.last_alert_at),
    renewedAtEpochMs: row.renewed_at === null ? null : epochOf(row.renewed_at),
    version: row.version,
  };
}

async function calendarSnapshotOf(
  actor: RequestActor,
  dependencies: SettingsDependencies,
): Promise<ComplianceCalendarSnapshot> {
  const instant = nowOf(dependencies);
  const today = calendarDayOf(instant);
  const rows = await dependencies.store.select("compliance_items", itemSelect, itemRowSchema);
  const items = rows.map((row) => itemViewOf(row, today));
  const manageable = COMPLIANCE_CALENDAR_MANAGE_ROLES.some((role) => actor.roles.includes(role));

  return {
    items,
    dueCount: items.filter((item) => item.state === "due").length,
    overdueCount: items.filter((item) => item.state === "overdue").length,
    unalertedCount: items.filter(
      (item) => item.state === "due" && item.lastAlertAtEpochMs === null,
    ).length,
    activeCount: items.filter((item) => item.status === "active").length,
    today,
    readAtEpochMs: instant,
    canManage: manageable,
  };
}

/**
 * The calendar as the screen reads it.
 *
 * Read by the compliance desk, the super administrator and the CEO's oversight read; written by the
 * first two. `canManage` travels with the snapshot so the screen cannot offer a form the service would
 * refuse.
 */
export async function readComplianceCalendar(
  input: { readonly actor: RequestActor },
  dependencies: SettingsDependencies,
): Promise<ComplianceCalendarSnapshot> {
  requireAnyRole(input.actor, COMPLIANCE_CALENDAR_READ_ROLES);

  return calendarSnapshotOf(input.actor, dependencies);
}

/** The fields of a new item, already parsed by the caller's shape. */
interface NewItemInput {
  readonly kind: string;
  readonly title: string;
  readonly issuer: string;
  readonly reference: string | null;
  readonly note: string | null;
  readonly issuedOn: string;
  readonly expiresOn: string;
  readonly alertDays: number;
}

const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9-]+$/u);

/** Bounded, trimmed text, or `VALIDATION_FAILED` naming the field. */
function requiredTextOf(value: string, field: string, maximum: number): string {
  const trimmed = value.trim();

  if (trimmed.length < 1 || trimmed.length > maximum) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field, rule: "invalid_length" }] });
  }

  return trimmed;
}

/** Bounded, trimmed text that may be absent, or `VALIDATION_FAILED` naming the field. */
function optionalTextOf(value: string, field: string, maximum: number): string | null {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed.length > maximum) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field, rule: "invalid_length" }] });
  }

  return trimmed;
}

/** The two days of a period, checked against each other and against the calendar. */
function periodOf(
  issuedOn: string,
  expiresOn: string,
): { readonly issuedOn: string; readonly expiresOn: string } {
  const issued = issuedOn.trim();
  const expires = expiresOn.trim();

  if (!isCalendarDay(issued)) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "issuedOn", rule: "invalid_date" }] });
  }

  if (!isCalendarDay(expires)) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "expiresOn", rule: "invalid_date" }] });
  }

  if (expires <= issued) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "expiresOn", rule: "not_after_issue" }],
    });
  }

  return { issuedOn: issued, expiresOn: expires };
}

/** The alert window, checked against `compliance_items_alert_check`. */
function alertDaysOf(value: number): number {
  const problem = alertDaysProblemOf(value);

  if (problem !== null) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "alertDays", rule: problem }] });
  }

  return value;
}

/** One item by identifier, or `RESOURCE_NOT_FOUND`. */
async function readItem(
  dependencies: SettingsDependencies,
  itemId: string,
): Promise<z.infer<typeof itemRowSchema>> {
  const parsed = identifierSchema.safeParse(itemId);

  if (!parsed.success) {
    throw new AppError("RESOURCE_NOT_FOUND");
  }

  const rows = await dependencies.store.select(
    "compliance_items",
    `${itemColumns}&id=eq.${encoded(parsed.data)}&company_id=is.null&deleted_at=is.null&limit=1`,
    itemRowSchema,
  );

  const row = rows[0];

  if (row === undefined) {
    throw new AppError("RESOURCE_NOT_FOUND");
  }

  return row;
}

/** A compare-and-set write on one item, with the read-back that tells a landed write from a lost one. */
async function writeItem(
  dependencies: SettingsDependencies,
  itemId: string,
  expectedVersion: number,
  values: Readonly<Record<string, unknown>>,
): Promise<void> {
  await dependencies.store.update(
    "compliance_items",
    `id=eq.${encoded(itemId)}&version=eq.${String(expectedVersion)}`,
    values,
  );

  const rows = await dependencies.store.select(
    "compliance_items",
    `select=version&id=eq.${encoded(itemId)}&limit=1`,
    versionRowSchema,
  );

  if (rows[0]?.version !== expectedVersion + 1) {
    throw new AppError("CONFLICT", { details: [{ field: "itemId", rule: "stale" }] });
  }
}

/**
 * File one certificate, attestation or filing.
 *
 * `owner_id` is the account that filed it: `0068` calls the column "the person responsible for the
 * renewal", and the officer who entered the row is the one who knows which day it falls due. The
 * document field stays null until the file storage of section 32 has a screen that can upload one.
 */
export async function addComplianceItem(
  input: NewItemInput & { readonly actor: RequestActor },
  dependencies: SettingsDependencies,
): Promise<ComplianceCalendarSnapshot> {
  const instant = nowOf(dependencies);

  requireCalendarEditor(input.actor, instant);

  if (!isComplianceItemKind(input.kind)) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "kind", rule: "invalid_format" }] });
  }

  const title = requiredTextOf(input.title, "title", COMPLIANCE_TITLE_MAXIMUM_LENGTH);
  const issuer = requiredTextOf(input.issuer, "issuer", COMPLIANCE_ISSUER_MAXIMUM_LENGTH);
  const reference = optionalTextOf(input.reference ?? "", "reference", COMPLIANCE_REFERENCE_MAXIMUM_LENGTH);
  const note = optionalTextOf(input.note ?? "", "note", COMPLIANCE_NOTE_MAXIMUM_LENGTH);
  const period = periodOf(input.issuedOn, input.expiresOn);
  const alertDays = alertDaysOf(input.alertDays);

  const inserted = await dependencies.store.insertReturning(
    "compliance_items",
    [
      {
        kind: input.kind,
        title,
        issuer,
        reference,
        note,
        issued_on: period.issuedOn,
        expires_on: period.expiresOn,
        alert_days: alertDays,
        status: "active",
        owner_id: input.actor.userId,
      },
    ],
    insertedRowSchema,
  );

  const row = inserted[0];

  if (row === undefined) {
    throw new AppError("DEPENDENCY_FAILED");
  }

  await dependencies.audit.append({
    action: COMPLIANCE_ITEM_ADDED_AUDIT_ACTION,
    actorUserId: input.actor.userId,
    entityType: "compliance_item",
    entityId: row.id,
    companyId: null,
    sessionId: input.actor.sessionId,
    payload: {
      kind: input.kind,
      expires_on: period.expiresOn,
      alert_days: alertDays,
    },
  });

  return calendarSnapshotOf(input.actor, dependencies);
}

/**
 * Renew one item: a new row for the new period, and the old row closed as `renewed`.
 *
 * The order matters. The replacement is filed first, so a failure leaves an extra live row rather than
 * a calendar with neither the old period nor the new one; only then is the old row marked `renewed`
 * with its instant, which is the history `0068` describes. The new period starts on the day the old
 * one ends unless the caller says otherwise, because that is what "renewal" means for a certificate,
 * and `compliance_items_dates_check` still refuses a period that ends before it begins.
 */
export async function renewComplianceItem(
  input: {
    readonly actor: RequestActor;
    readonly itemId: string;
    readonly issuedOn: string | null;
    readonly expiresOn: string;
    readonly reference: string | null;
    readonly note: string | null;
  },
  dependencies: SettingsDependencies,
): Promise<ComplianceCalendarSnapshot> {
  const instant = nowOf(dependencies);

  requireCalendarEditor(input.actor, instant);

  const row = await readItem(dependencies, input.itemId);

  if (!isComplianceItemKind(row.kind)) {
    throw new AppError("INTERNAL_ERROR");
  }

  if (row.status === "renewed" || row.status === "archived") {
    throw new AppError("CONFLICT", { details: [{ field: "itemId", rule: "closed" }] });
  }

  const period = periodOf(input.issuedOn ?? row.expires_on, input.expiresOn);
  const reference = optionalTextOf(
    input.reference ?? row.reference ?? "",
    "reference",
    COMPLIANCE_REFERENCE_MAXIMUM_LENGTH,
  );
  const note = optionalTextOf(input.note ?? "", "note", COMPLIANCE_NOTE_MAXIMUM_LENGTH);

  const inserted = await dependencies.store.insertReturning(
    "compliance_items",
    [
      {
        kind: row.kind,
        title: row.title,
        issuer: row.issuer,
        reference,
        note,
        issued_on: period.issuedOn,
        expires_on: period.expiresOn,
        alert_days: row.alert_days,
        status: "active",
        owner_id: input.actor.userId,
      },
    ],
    insertedRowSchema,
  );

  const replacement = inserted[0];

  if (replacement === undefined) {
    throw new AppError("DEPENDENCY_FAILED");
  }

  await writeItem(dependencies, row.id, row.version, {
    status: "renewed",
    renewed_at: new Date(instant).toISOString(),
  });

  await dependencies.audit.append({
    action: COMPLIANCE_ITEM_RENEWED_AUDIT_ACTION,
    actorUserId: input.actor.userId,
    entityType: "compliance_item",
    entityId: row.id,
    companyId: null,
    sessionId: input.actor.sessionId,
    payload: {
      kind: row.kind,
      replacement_item_id: replacement.id,
      previous_expires_on: row.expires_on,
      expires_on: period.expiresOn,
    },
  });

  return calendarSnapshotOf(input.actor, dependencies);
}

/**
 * Take one item off the calendar.
 *
 * Archived rather than deleted, because `compliance_items_guard_state` refuses a delete and because an
 * archived certificate is the answer to "what covered us in 2025". A closed row is refused: renewing
 * or archiving what is already renewed or archived is a stale screen, not an action.
 */
export async function archiveComplianceItem(
  input: { readonly actor: RequestActor; readonly itemId: string },
  dependencies: SettingsDependencies,
): Promise<ComplianceCalendarSnapshot> {
  const instant = nowOf(dependencies);

  requireCalendarEditor(input.actor, instant);

  const row = await readItem(dependencies, input.itemId);

  if (row.status === "archived") {
    throw new AppError("CONFLICT", { details: [{ field: "itemId", rule: "already_archived" }] });
  }

  await writeItem(dependencies, row.id, row.version, { status: "archived" });

  await dependencies.audit.append({
    action: COMPLIANCE_ITEM_ARCHIVED_AUDIT_ACTION,
    actorUserId: input.actor.userId,
    entityType: "compliance_item",
    entityId: row.id,
    companyId: null,
    sessionId: input.actor.sessionId,
    payload: {
      kind: row.kind,
      expires_on: row.expires_on,
      status_before: row.status,
    },
  });

  return calendarSnapshotOf(input.actor, dependencies);
}

/**
 * The body of section 27's "compliance calendar expiry alerts for annual renewals".
 *
 * Two things happen to the rows that are still `active`:
 *
 *   - an expiry that is behind us becomes `expired`, which is the only transition the guard allows
 *     from `active` and the only way the calendar tells the truth about a lapsed certificate;
 *   - a row inside its own alert window whose `last_alert_at` is null is stamped with this instant,
 *     which is the record that a warning was due. `0068` refuses a stamp that moves backwards, so a
 *     second run finds nothing to warn about until a renewal files a new period.
 *
 * Both writes name the version and the status they read, so a row a person moved under the check is
 * counted as a skip rather than overwritten.
 */
export async function runComplianceCalendarCheck(
  input: { readonly actor: RequestActor },
  dependencies: SettingsDependencies,
): Promise<ComplianceCheckResult> {
  const instant = nowOf(dependencies);

  requireCalendarEditor(input.actor, instant);

  const today = calendarDayOf(instant);
  const stampedAt = new Date(instant).toISOString();
  const rows = await dependencies.store.select(
    "compliance_items",
    `${itemColumns}&status=eq.active&company_id=is.null&deleted_at=is.null` +
      `&order=expires_on.asc&limit=${String(COMPLIANCE_CALENDAR_LIMIT)}`,
    itemRowSchema,
  );
  let expired = 0;
  let alerted = 0;
  let skipped = 0;

  for (const row of rows) {
    const days = daysUntil(row.expires_on, today);

    if (days === null) {
      skipped += 1;

      continue;
    }

    if (days < 0) {
      await dependencies.store.update(
        "compliance_items",
        `id=eq.${encoded(row.id)}&version=eq.${String(row.version)}` +
          "&status=eq.active&deleted_at=is.null",
        { status: "expired" },
      );

      const after = await dependencies.store.select(
        "compliance_items",
        `select=id,status&id=eq.${encoded(row.id)}&limit=1`,
        z.object({ id: z.string().min(1).max(64), status: z.string().min(1).max(20) }),
      );

      if (after[0]?.status !== "expired") {
        skipped += 1;

        continue;
      }

      expired += 1;

      await dependencies.audit.append({
        action: COMPLIANCE_ITEM_EXPIRED_AUDIT_ACTION,
        actorUserId: input.actor.userId,
        entityType: "compliance_item",
        entityId: row.id,
        companyId: null,
        sessionId: input.actor.sessionId,
        payload: {
          kind: row.kind,
          expires_on: row.expires_on,
          days_overdue: Math.abs(days),
        },
      });

      continue;
    }

    if (days > row.alert_days || row.last_alert_at !== null) {
      continue;
    }

    await dependencies.store.update(
      "compliance_items",
      `id=eq.${encoded(row.id)}&version=eq.${String(row.version)}` +
        "&status=eq.active&last_alert_at=is.null",
      { last_alert_at: stampedAt },
    );

    const after = await dependencies.store.select(
      "compliance_items",
      `select=id,last_alert_at&id=eq.${encoded(row.id)}&limit=1`,
      z.object({
        id: z.string().min(1).max(64),
        last_alert_at: z.string().min(1).max(40).nullable(),
      }),
    );

    if (after[0]?.last_alert_at !== stampedAt) {
      skipped += 1;

      continue;
    }

    alerted += 1;

    await dependencies.audit.append({
      action: COMPLIANCE_ALERT_SENT_AUDIT_ACTION,
      actorUserId: input.actor.userId,
      entityType: "compliance_item",
      entityId: row.id,
      companyId: null,
      sessionId: input.actor.sessionId,
      payload: {
        kind: row.kind,
        expires_on: row.expires_on,
        days_remaining: days,
        alert_days: row.alert_days,
      },
    });
  }

  return { examined: rows.length, expired, alerted, skipped, ranAtEpochMs: instant };
}

/** The default alert window, exported so the form and the gate read the same number. */
export const COMPLIANCE_FORM_DEFAULT_ALERT_DAYS = COMPLIANCE_DEFAULT_ALERT_DAYS;
