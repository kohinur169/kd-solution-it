// path: lib/announcements/registry.ts
import { PLATFORM_ROLES, type PlatformRole } from "../auth/types.ts";
import type { MessagePath } from "../i18n/messages.ts";
import { deepFreeze } from "../utils/freeze.ts";

/**
 * The announcement vocabulary of section 24, as data.
 *
 * ## What already exists and what this file adds
 *
 * `0007` created `public.announcements` - draft until `published_at` is set, `expires_at` to stop a
 * stale banner without a job, a closed three value `level`, and a closed three value `audience` that
 * is not a role list because the popup is shown by the shell rather than by a permission check.
 * `0008` created `public.announcement_dismissals` with a unique index on `(announcement_id, user_id)`,
 * which is exactly the sentence "a dismissed announcement does not appear again for that user".
 * `0073` wrote the five policies: the super administrator's all, the audience read, and the two that
 * let a person read and insert their own dismissal.
 *
 * So this STEP adds no table and no policy. What it adds is the part the database cannot decide:
 * which roles compose (one) and which may read the composer (three), what a state means at a given
 * instant, which audience a particular person belongs to, and the bounds the composer checks before
 * it writes.
 *
 * ## Why the audience rule lives here and not in SQL
 *
 * `0073`'s `announcements_audience_select` decides visibility for a caller reaching PostgREST
 * directly. The application does not: every query goes through the service role, so the same rule has
 * to exist in the service or a merchant would read an office banner. It is written once, as
 * `isAnnouncementVisibleTo`, and the gate checks it against the audience names `0007` allows and
 * against `0073`'s array of the six office roles, so the two cannot drift silently.
 */

/** The roles that may write, publish and withdraw an announcement. Section 24 names one. */
export const ANNOUNCEMENT_MANAGE_ROLES: readonly PlatformRole[] = deepFreeze([
  "super_admin",
] as const satisfies readonly PlatformRole[]);

/**
 * The roles that may read the composer: the one that writes it, the chief executive who owns the page
 * the banner points at, and support, who answer the merchant asking what the banner means.
 */
export const ANNOUNCEMENT_READ_ROLES: readonly PlatformRole[] = deepFreeze([
  "ceo",
  "support",
  "super_admin",
] as const satisfies readonly PlatformRole[]);

/** The roles that may open the announcements screen: the union of the two lists above. */
export const ANNOUNCEMENT_SCREEN_ROLES: readonly PlatformRole[] = deepFreeze([
  "ceo",
  "support",
  "super_admin",
] as const satisfies readonly PlatformRole[]);

/**
 * The roles an `office` audience means: the six platform roles of section 2 minus the merchant.
 *
 * Derived rather than written out, for the same reason `components/office/navigation.ts` derives its
 * six: a seventh office role would otherwise silently not receive the office banners.
 */
export const ANNOUNCEMENT_OFFICE_AUDIENCE_ROLES: readonly PlatformRole[] = deepFreeze(
  PLATFORM_ROLES.filter((role): role is PlatformRole => role !== "owner"),
);

/** The audit name of a draft being written or changed. */
export const ANNOUNCEMENT_SAVED_AUDIT_ACTION = "announcement.saved";

/** The audit name of a draft becoming visible. */
export const ANNOUNCEMENT_PUBLISHED_AUDIT_ACTION = "announcement.published";

/** The audit name of a live announcement being stopped. */
export const ANNOUNCEMENT_WITHDRAWN_AUDIT_ACTION = "announcement.withdrawn";

/** The audit name of one person closing one announcement. */
export const ANNOUNCEMENT_DISMISSED_AUDIT_ACTION = "announcement.dismissed";

/** Every audit name this STEP writes, so the gate can walk them. */
export const ANNOUNCEMENT_AUDIT_ACTIONS: readonly string[] = deepFreeze([
  ANNOUNCEMENT_SAVED_AUDIT_ACTION,
  ANNOUNCEMENT_PUBLISHED_AUDIT_ACTION,
  ANNOUNCEMENT_WITHDRAWN_AUDIT_ACTION,
  ANNOUNCEMENT_DISMISSED_AUDIT_ACTION,
]);

/** `announcements_level_check`: three emphases, and nothing free text. */
export type AnnouncementLevel = "info" | "warning" | "critical";

export const ANNOUNCEMENT_LEVELS: readonly AnnouncementLevel[] = deepFreeze([
  "info",
  "warning",
  "critical",
]);

const levelSet: ReadonlySet<string> = new Set<string>(ANNOUNCEMENT_LEVELS);

/** True when a value is one of the three levels. */
export function isAnnouncementLevel(value: unknown): value is AnnouncementLevel {
  return typeof value === "string" && levelSet.has(value);
}

const levelLabelKeys: Readonly<Record<AnnouncementLevel, MessagePath>> = deepFreeze({
  info: "announcements.levelInfo",
  warning: "announcements.levelWarning",
  critical: "announcements.levelCritical",
});

/** The catalog key of a level's name. */
export function announcementLevelLabelKey(level: AnnouncementLevel): MessagePath {
  return levelLabelKeys[level];
}

const levelHintKeys: Readonly<Record<AnnouncementLevel, MessagePath>> = deepFreeze({
  info: "announcements.levelInfoHint",
  warning: "announcements.levelWarningHint",
  critical: "announcements.levelCriticalHint",
});

/** The catalog key of the sentence that says what a level looks like. */
export function announcementLevelHintKey(level: AnnouncementLevel): MessagePath {
  return levelHintKeys[level];
}

/** `announcements_audience_check`: who the popup is for. */
export type AnnouncementAudience = "all" | "owners" | "office";

export const ANNOUNCEMENT_AUDIENCES: readonly AnnouncementAudience[] = deepFreeze([
  "all",
  "owners",
  "office",
]);

const audienceSet: ReadonlySet<string> = new Set<string>(ANNOUNCEMENT_AUDIENCES);

/** True when a value is one of the three audiences. */
export function isAnnouncementAudience(value: unknown): value is AnnouncementAudience {
  return typeof value === "string" && audienceSet.has(value);
}

const audienceLabelKeys: Readonly<Record<AnnouncementAudience, MessagePath>> = deepFreeze({
  all: "announcements.audienceAll",
  owners: "announcements.audienceOwners",
  office: "announcements.audienceOffice",
});

/** The catalog key of an audience's name. */
export function announcementAudienceLabelKey(audience: AnnouncementAudience): MessagePath {
  return audienceLabelKeys[audience];
}

const audienceHintKeys: Readonly<Record<AnnouncementAudience, MessagePath>> = deepFreeze({
  all: "announcements.audienceAllHint",
  owners: "announcements.audienceOwnersHint",
  office: "announcements.audienceOfficeHint",
});

/** The catalog key of the sentence that says who an audience reaches. */
export function announcementAudienceHintKey(audience: AnnouncementAudience): MessagePath {
  return audienceHintKeys[audience];
}

/**
 * Where an announcement stands at one instant.
 *
 * `published_at` is the only switch `0007` has, so the three states are read from it and from the
 * expiry: no publish instant is a draft, an expiry behind us is ended, and everything else is live.
 * A withdrawal writes the expiry, which is why "ended" covers both "the day it lapsed" and "somebody
 * stopped it" - the row keeps saying when it stopped showing.
 */
export type AnnouncementState = "draft" | "live" | "ended";

const stateLabelKeys: Readonly<Record<AnnouncementState, MessagePath>> = deepFreeze({
  draft: "announcements.stateDraft",
  live: "announcements.stateLive",
  ended: "announcements.stateEnded",
});

/** The catalog key of a state's badge. */
export function announcementStateLabelKey(state: AnnouncementState): MessagePath {
  return stateLabelKeys[state];
}

/** The state of one row at one instant, or a refusal when the row could not be read. */
export function announcementStateOf(input: {
  readonly publishedAtEpochMs: number | null;
  readonly expiresAtEpochMs: number | null;
  readonly nowEpochMs: number;
}): AnnouncementState {
  if (input.publishedAtEpochMs === null) {
    return "draft";
  }

  if (input.expiresAtEpochMs !== null && input.expiresAtEpochMs <= input.nowEpochMs) {
    return "ended";
  }

  return "live";
}

/** Who is looking at the popup: the company they act for, and the roles they hold. */
export interface AnnouncementViewer {
  readonly companyId: string | null;
  readonly roles: readonly PlatformRole[];
}

/**
 * True when this person is in this announcement's audience.
 *
 * The three audiences are `0007`'s: `all` is every signed in person, `owners` is a person acting for
 * a company, and `office` is one of the six platform roles. The company column is honoured too, so a
 * row written for one company is never shown to another even though this composer writes platform
 * wide rows only.
 *
 * A draft and an ended announcement are not visible to anybody: the publish instant is the switch and
 * the expiry is the stop.
 */
export function isAnnouncementVisibleTo(input: {
  readonly audience: AnnouncementAudience;
  readonly companyId: string | null;
  readonly publishedAtEpochMs: number | null;
  readonly expiresAtEpochMs: number | null;
  readonly nowEpochMs: number;
  readonly viewer: AnnouncementViewer;
}): boolean {
  if (announcementStateOf(input) !== "live") {
    return false;
  }

  if (input.companyId !== null && input.companyId !== input.viewer.companyId) {
    return false;
  }

  if (input.audience === "all") {
    return true;
  }

  if (input.audience === "owners") {
    return input.viewer.companyId !== null;
  }

  return input.viewer.roles.some((role) => ANNOUNCEMENT_OFFICE_AUDIENCE_ROLES.includes(role));
}

/** `announcements_title_check`'s bounds. */
export const ANNOUNCEMENT_TITLE_MAXIMUM_LENGTH = 140;

/** `announcements_body_check`'s ceiling: the column accepts five thousand characters. */
export const ANNOUNCEMENT_BODY_MAXIMUM_LENGTH = 5_000;

/** How many rows the composer lists: a year of announcements with room to spare. */
export const ANNOUNCEMENT_LIST_LIMIT = 100;

/**
 * How many popups one page load may queue.
 *
 * A person who has ignored six banners should not be shown six dialogs; the newest three are enough
 * to be noticed, and the rest arrive as they are dismissed or on the next page.
 */
export const ANNOUNCEMENT_POPUP_LIMIT = 3;

/** How far ahead an expiry may be set: a banner that outlives a year is a banner nobody reads. */
export const ANNOUNCEMENT_EXPIRY_MAXIMUM_DAYS = 365;

/** Why a title is not one the column accepts, or null when it is. */
export function announcementTitleProblemOf(value: string): string | null {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return "required";
  }

  return trimmed.length > ANNOUNCEMENT_TITLE_MAXIMUM_LENGTH ? "too_long" : null;
}

/** Why a body is not one the column accepts, or null when it is. */
export function announcementBodyProblemOf(value: string): string | null {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return "required";
  }

  return trimmed.length > ANNOUNCEMENT_BODY_MAXIMUM_LENGTH ? "too_long" : null;
}

/**
 * Why an expiry is not one this platform will publish with, or null when it is.
 *
 * An expiry is optional, and when it is given it has to be in the future and inside a year. A past
 * expiry would publish a banner that is ended the moment it appears, which is never what somebody
 * meant to do.
 */
export function announcementExpiryProblemOf(input: {
  readonly expiresAtEpochMs: number | null;
  readonly nowEpochMs: number;
}): string | null {
  if (input.expiresAtEpochMs === null) {
    return null;
  }

  if (!Number.isSafeInteger(input.expiresAtEpochMs)) {
    return "invalid_format";
  }

  if (input.expiresAtEpochMs <= input.nowEpochMs) {
    return "invalid_range";
  }

  return input.expiresAtEpochMs - input.nowEpochMs > ANNOUNCEMENT_EXPIRY_MAXIMUM_DAYS * 86_400_000
    ? "invalid_range"
    : null;
}

/** The last instant of a calendar day, in UTC: the day an announcement stops showing through. */
export function endOfDayEpochMs(day: string): number | null {
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/u.exec(day);

  if (match === null) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  const start = Date.UTC(year, month - 1, date);

  if (new Date(start).getUTCDate() !== date) {
    return null;
  }

  return start + 86_399_999;
}

/** The calendar day an instant falls on, in UTC. The platform's clock everywhere. */
export function calendarDayOf(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}
