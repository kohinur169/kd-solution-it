// path: lib/settings/registry.ts
import type { PlatformRole } from "../auth/types.ts";
import type { MessagePath } from "../i18n/messages.ts";
import { deepFreeze } from "../utils/freeze.ts";

/**
 * The platform's general settings and the compliance calendar of section 3, as data.
 *
 * ## Why the settings are keys rather than columns
 *
 * `0080` created `public.platform_settings` as a registry: one dotted key and one JSON value per row,
 * with the key frozen and a partial unique index that makes a second live row for the same key
 * impossible. That shape is what lets this STEP add the platform's name, its logo, its contact details
 * and its appointed compliance officer without a migration per field - and what keeps a later field a
 * row rather than a schema change. This file is the other half of the registry: the keys the screen
 * owns, the shape each of them must have, and the label the catalogue words it with.
 *
 * A key is not free text. `platform_settings_key_check` allows `^[a-z][a-z0-9_]*([.][a-z0-9_]+)*$`
 * between three and sixty-four characters, and the gate compares this list with that pattern, so a key
 * this module offers is a key the column accepts.
 *
 * ## Why the roles are three lists and not one
 *
 * Section 24 gives the platform information to the super administrator alone, and `0080` agrees: the
 * table's only policy beyond default deny is `platform_settings_super_admin_all`. Section 3's
 * compliance calendar is a compliance desk's work - `0074` gives `compliance_kyc` full control and the
 * CEO a read - and `0099` closes the gap that left the super administrator out of it, because section
 * 2 gives that role full control of everything and the settings screen is where the calendar appears.
 *
 * The screen is therefore the union of the three, and what each role may do inside it is decided
 * per section: only the super administrator writes the platform information, the compliance desk and
 * the super administrator work the calendar, and the CEO reads it. The gate asserts that the screen's
 * role list is exactly the union, so a section cannot be offered to a role that would be refused.
 *
 * ## What is deliberately absent
 *
 * No secret lives here. A secret setting is a row of the same table with `is_secret` true and an
 * AES-256-GCM box (`lib/auth/settings.ts` reads those), and nothing in this screen writes one: the
 * Turnstile secret of section 34 is an operator's job, not a field on a page that renders its values
 * into HTML.
 */

/** The roles that may read and write the platform information of section 24. */
export const PLATFORM_INFORMATION_ROLES: readonly PlatformRole[] = deepFreeze([
  "super_admin",
] as const satisfies readonly PlatformRole[]);

/**
 * The roles that may work the compliance calendar.
 *
 * `compliance_kyc` is the desk that files the renewals; `super_admin` is full control of section 2 and
 * the policy of `0099`. The CEO reads and does not write, because section 2 makes the CEO a confirmer
 * rather than an operator of the compliance book.
 */
export const COMPLIANCE_CALENDAR_MANAGE_ROLES: readonly PlatformRole[] = deepFreeze([
  "super_admin",
  "compliance_kyc",
] as const satisfies readonly PlatformRole[]);

/** The roles that may read the calendar: the two desks above and the CEO's oversight read. */
export const COMPLIANCE_CALENDAR_READ_ROLES: readonly PlatformRole[] = deepFreeze([
  "ceo",
  "compliance_kyc",
  "super_admin",
] as const satisfies readonly PlatformRole[]);

/** The roles that may open the settings screen at all: the union of the two sections. */
export const PLATFORM_SETTINGS_SCREEN_ROLES: readonly PlatformRole[] = deepFreeze([
  "ceo",
  "compliance_kyc",
  "super_admin",
] as const satisfies readonly PlatformRole[]);

/** The audit name of a platform information save. */
export const PLATFORM_SETTINGS_AUDIT_ACTION = "platform.settings_updated";

/** The audit name of a calendar item being filed. */
export const COMPLIANCE_ITEM_ADDED_AUDIT_ACTION = "compliance.item_added";

/** The audit name of a renewal: the old row is closed and a new period is filed. */
export const COMPLIANCE_ITEM_RENEWED_AUDIT_ACTION = "compliance.item_renewed";

/** The audit name of an item being taken off the calendar. */
export const COMPLIANCE_ITEM_ARCHIVED_AUDIT_ACTION = "compliance.item_archived";

/** The audit name of an item whose expiry the calendar check found behind us. */
export const COMPLIANCE_ITEM_EXPIRED_AUDIT_ACTION = "compliance.item_expired";

/** The audit name of one expiry warning. */
export const COMPLIANCE_ALERT_SENT_AUDIT_ACTION = "compliance.alert_sent";

/** Every audit name this STEP writes, so the gate can walk them. */
export const SETTINGS_AUDIT_ACTIONS: readonly string[] = deepFreeze([
  PLATFORM_SETTINGS_AUDIT_ACTION,
  COMPLIANCE_ITEM_ADDED_AUDIT_ACTION,
  COMPLIANCE_ITEM_RENEWED_AUDIT_ACTION,
  COMPLIANCE_ITEM_ARCHIVED_AUDIT_ACTION,
  COMPLIANCE_ITEM_EXPIRED_AUDIT_ACTION,
  COMPLIANCE_ALERT_SENT_AUDIT_ACTION,
]);

/** The shape a setting's value must have, which decides the input and the check. */
export type SettingKind = "name" | "text" | "email" | "phone" | "path" | "url" | "date";

/**
 * Which block of section 24 a field belongs to.
 *
 * The screen shows one form and two blocks: what the platform says about itself, and the appointed
 * compliance officer of section 3. Both are saved by one button because both are one setting - a
 * platform that knows its own name knows who answers for it - and splitting the save would let a page
 * write half of an identity.
 */
export type PlatformSettingGroup = "platform" | "officer";

/** One row of the platform information form. */
export interface PlatformSettingField {
  /** The `platform_settings.setting_key` this field writes. */
  readonly key: string;
  readonly group: PlatformSettingGroup;
  readonly kind: SettingKind;
  readonly labelKey: MessagePath;
  readonly hintKey: MessagePath | null;
  /** True when an empty value is a refusal rather than a cleared field. */
  readonly required: boolean;
  /** The longest value the field accepts, and the column's effective ceiling. */
  readonly maxLength: number;
  /** What the field holds before anybody saves, so a fresh deployment reads sensibly. */
  readonly default: string;
}

/**
 * The platform information of sections 3 and 24, in the order the form renders it.
 *
 * The first block is what the platform says about itself - the name a merchant sees, the logo the
 * public site draws, the address and the two ways to reach support. The second is section 3's
 * "appointed responsible compliance officer recorded in platform settings": a named person, an address
 * to reach them and the day the appointment took effect, all three of which a regulator asks for.
 *
 * `platform.logo_path` is a rooted path on this origin rather than a URL. The platform's own response
 * headers allow images from `'self'`, `data:` and `blob:` (`lib/security/csp.ts`), so a logo hosted
 * somewhere else would be a broken image in every browser; an operator who uploads a file to
 * `public/brand/` records `/brand/logo.svg` here, and section 32's file storage can replace the path
 * with a `files` reference when that screen exists.
 */
export const PLATFORM_INFORMATION_FIELDS: readonly PlatformSettingField[] = deepFreeze([
  {
    key: "platform.name",
    group: "platform",
    kind: "name",
    labelKey: "officeSettings.fieldName",
    hintKey: "officeSettings.hintName",
    required: true,
    maxLength: 80,
    default: "KD Solution IT",
  },
  {
    key: "platform.legal_name",
    group: "platform",
    kind: "name",
    labelKey: "officeSettings.fieldLegalName",
    hintKey: "officeSettings.hintLegalName",
    required: true,
    maxLength: 120,
    default: "KD Solution IT",
  },
  {
    key: "platform.logo_path",
    group: "platform",
    kind: "path",
    labelKey: "officeSettings.fieldLogoPath",
    hintKey: "officeSettings.hintLogoPath",
    required: false,
    maxLength: 200,
    default: "/brand/logo.svg",
  },
  {
    key: "platform.support_email",
    group: "platform",
    kind: "email",
    labelKey: "officeSettings.fieldSupportEmail",
    hintKey: "officeSettings.hintSupportEmail",
    required: true,
    maxLength: 254,
    default: "support@kd-solution.example",
  },
  {
    key: "platform.support_phone",
    group: "platform",
    kind: "phone",
    labelKey: "officeSettings.fieldSupportPhone",
    hintKey: "officeSettings.hintSupportPhone",
    required: false,
    maxLength: 32,
    default: "+880 1700 000000",
  },
  {
    key: "platform.website",
    group: "platform",
    kind: "url",
    labelKey: "officeSettings.fieldWebsite",
    hintKey: "officeSettings.hintWebsite",
    required: false,
    maxLength: 300,
    default: "",
  },
  {
    key: "platform.address",
    group: "platform",
    kind: "text",
    labelKey: "officeSettings.fieldAddress",
    hintKey: "officeSettings.hintAddress",
    required: false,
    maxLength: 280,
    default: "",
  },
  {
    key: "compliance.officer_name",
    group: "officer",
    kind: "name",
    labelKey: "officeSettings.fieldOfficerName",
    hintKey: "officeSettings.hintOfficerName",
    required: true,
    maxLength: 120,
    default: "",
  },
  {
    key: "compliance.officer_email",
    group: "officer",
    kind: "email",
    labelKey: "officeSettings.fieldOfficerEmail",
    hintKey: "officeSettings.hintOfficerEmail",
    required: true,
    maxLength: 254,
    default: "",
  },
  {
    key: "compliance.officer_appointed_on",
    group: "officer",
    kind: "date",
    labelKey: "officeSettings.fieldOfficerAppointedOn",
    hintKey: "officeSettings.hintOfficerAppointedOn",
    required: false,
    maxLength: 10,
    default: "",
  },
]);

/** The keys the form writes, in form order. */
export const PLATFORM_SETTING_KEYS: readonly string[] = deepFreeze(
  PLATFORM_INFORMATION_FIELDS.map((field) => field.key),
);

/** One field by its key, or null. */
export function platformSettingFieldOf(key: string): PlatformSettingField | null {
  return PLATFORM_INFORMATION_FIELDS.find((field) => field.key === key) ?? null;
}

/** `platform_settings_key_check`'s pattern, so a key this module offers is one the column accepts. */
export const SETTING_KEY_PATTERN = /^[a-z][a-z0-9_]*([.][a-z0-9_]+)+$/u;

const controlCharacterPattern = /[\u0000-\u001F\u007F]/u;
const emailPattern = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/u;
const phonePattern = /^\+?[0-9][0-9 ()-]{5,31}$/u;
const datePattern = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/u;
const relativePathPattern = /^\/(?!\/)[A-Za-z0-9._~\-/]*$/u;
const httpsUrlPattern = /^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?(\/[A-Za-z0-9._~\-/%]*)?(\?[A-Za-z0-9._~%&=+-]*)?$/u;

/** True when a value is a calendar day that exists: 2026-02-30 is not one. */
export function isCalendarDay(value: string): boolean {
  const match = datePattern.exec(value);

  if (match === null) {
    return false;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const instant = new Date(Date.UTC(year, month - 1, day));

  return (
    instant.getUTCFullYear() === year &&
    instant.getUTCMonth() === month - 1 &&
    instant.getUTCDate() === day
  );
}

/** The day number of a calendar day, or null when the value is not one. */
export function dayNumberOf(value: string): number | null {
  if (!isCalendarDay(value)) {
    return null;
  }

  const match = datePattern.exec(value);

  if (match === null) {
    return null;
  }

  return Math.trunc(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86_400_000,
  );
}

/** The calendar day an instant falls on, in UTC. The platform's clock everywhere. */
export function calendarDayOf(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/** How many days are left until an expiry; negative once it has passed, null when unreadable. */
export function daysUntil(expiresOn: string, today: string): number | null {
  const expiry = dayNumberOf(expiresOn);
  const start = dayNumberOf(today);

  if (expiry === null || start === null) {
    return null;
  }

  return expiry - start;
}

/**
 * What is wrong with a setting's value, or null when nothing is.
 *
 * The rules are the wire's, not the column's: an email has an at sign and a dot after it, a phone has
 * digits and the punctuation people type, a logo is a rooted path on this origin, a website is https,
 * and a date is a day that exists. Each refusal is a rule name the form words, and the same names
 * reach the caller as a `VALIDATION_FAILED` detail.
 */
export function settingValueProblemOf(input: {
  readonly kind: SettingKind;
  readonly value: string;
  readonly required: boolean;
  readonly maxLength: number;
}): "required" | "too_long" | "invalid_format" | "invalid_date" | null {
  const value = input.value.trim();

  if (value.length === 0) {
    return input.required ? "required" : null;
  }

  if ([...value].length > input.maxLength) {
    return "too_long";
  }

  if (controlCharacterPattern.test(value)) {
    return "invalid_format";
  }

  switch (input.kind) {
    case "email":
      return emailPattern.test(value) ? null : "invalid_format";
    case "phone":
      return phonePattern.test(value) ? null : "invalid_format";
    case "path":
      return value.includes("..") || value.includes("%2e") || !relativePathPattern.test(value)
        ? "invalid_format"
        : null;
    case "url":
      return httpsUrlPattern.test(value) ? null : "invalid_format";
    case "date":
      return isCalendarDay(value) ? null : "invalid_date";
    default:
      return null;
  }
}

/** The closed list of `compliance_items_kind_check`. */
export type ComplianceItemKind =
  | "cyber_insurance"
  | "pci_attestation"
  | "business_license"
  | "tax_registration"
  | "annual_filing"
  | "other";

export const COMPLIANCE_ITEM_KINDS: readonly ComplianceItemKind[] = deepFreeze([
  "cyber_insurance",
  "pci_attestation",
  "business_license",
  "tax_registration",
  "annual_filing",
  "other",
]);

const kindSet: ReadonlySet<string> = new Set<string>(COMPLIANCE_ITEM_KINDS);

/** True when a value is one of the six tracked kinds. */
export function isComplianceItemKind(value: unknown): value is ComplianceItemKind {
  return typeof value === "string" && kindSet.has(value);
}

const kindLabelKeys: Readonly<Record<ComplianceItemKind, MessagePath>> = deepFreeze({
  cyber_insurance: "officeSettings.kindCyberInsurance",
  pci_attestation: "officeSettings.kindPciAttestation",
  business_license: "officeSettings.kindBusinessLicense",
  tax_registration: "officeSettings.kindTaxRegistration",
  annual_filing: "officeSettings.kindAnnualFiling",
  other: "officeSettings.kindOther",
});

/** The catalogue key of a kind's name. */
export function complianceKindLabelKey(kind: ComplianceItemKind): MessagePath {
  return kindLabelKeys[kind];
}

/** The closed list of `compliance_items_status_check`. */
export type ComplianceItemStatus = "active" | "expired" | "renewed" | "archived";

export const COMPLIANCE_ITEM_STATUSES: readonly ComplianceItemStatus[] = deepFreeze([
  "active",
  "expired",
  "renewed",
  "archived",
]);

const statusSet: ReadonlySet<string> = new Set<string>(COMPLIANCE_ITEM_STATUSES);

/** True when a value is one of the four statuses. */
export function isComplianceItemStatus(value: unknown): value is ComplianceItemStatus {
  return typeof value === "string" && statusSet.has(value);
}

const statusLabelKeys: Readonly<Record<ComplianceItemStatus, MessagePath>> = deepFreeze({
  active: "officeSettings.statusActive",
  expired: "officeSettings.statusExpired",
  renewed: "officeSettings.statusRenewed",
  archived: "officeSettings.statusArchived",
});

/** The catalogue key of a status's badge. */
export function complianceStatusLabelKey(status: ComplianceItemStatus): MessagePath {
  return statusLabelKeys[status];
}

/**
 * How close an active item is to its expiry, which is what the calendar colours and counts.
 *
 * `due` is "inside the item's own alert window", not a fixed number of days: `0068` gives every item
 * an `alert_days` between 7 and 365, and the point of the column is that a PCI attestation and a
 * business licence do not warn at the same distance from their dates.
 */
export type ComplianceState = "ok" | "due" | "overdue";

/** The state of one row today. */
export function complianceStateOf(input: {
  readonly expiresOn: string;
  readonly today: string;
  readonly alertDays: number;
  readonly status: ComplianceItemStatus;
}): ComplianceState {
  if (input.status === "expired") {
    return "overdue";
  }

  const days = daysUntil(input.expiresOn, input.today);

  if (days === null) {
    return "ok";
  }

  if (days < 0) {
    return "overdue";
  }

  return days <= input.alertDays ? "due" : "ok";
}

const stateLabelKeys: Readonly<Record<ComplianceState, MessagePath>> = deepFreeze({
  ok: "officeSettings.stateOk",
  due: "officeSettings.stateDue",
  overdue: "officeSettings.stateOverdue",
});

/** The catalogue key of a state's badge. */
export function complianceStateLabelKey(state: ComplianceState): MessagePath {
  return stateLabelKeys[state];
}

/** `compliance_items_alert_check`'s bounds: a warning is between one week and one year ahead. */
export const COMPLIANCE_ALERT_MINIMUM_DAYS = 7;

/** The longest window an item may warn inside. */
export const COMPLIANCE_ALERT_MAXIMUM_DAYS = 365;

/** What the calendar warns with before anybody changes it. */
export const COMPLIANCE_DEFAULT_ALERT_DAYS = 30;

/** `compliance_items_title_check`'s ceiling. */
export const COMPLIANCE_TITLE_MAXIMUM_LENGTH = 120;

/** The issuer's ceiling, the same as the title's. */
export const COMPLIANCE_ISSUER_MAXIMUM_LENGTH = 120;

/** The certificate or filing number's ceiling. */
export const COMPLIANCE_REFERENCE_MAXIMUM_LENGTH = 120;

/** The note's ceiling. */
export const COMPLIANCE_NOTE_MAXIMUM_LENGTH = 500;

/** How many rows one calendar read returns: a year of renewals with room to spare. */
export const COMPLIANCE_CALENDAR_LIMIT = 200;

/** Why an alert window is not one the column accepts, or null when it is. */
export function alertDaysProblemOf(value: number): string | null {
  if (!Number.isSafeInteger(value)) {
    return "invalid_format";
  }

  return value < COMPLIANCE_ALERT_MINIMUM_DAYS || value > COMPLIANCE_ALERT_MAXIMUM_DAYS
    ? "invalid_range"
    : null;
}
