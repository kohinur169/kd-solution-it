// path: lib/announcements/service.ts
import { z } from "zod";
import { AppError } from "../errors/app-error.ts";
import type { AuditTrail } from "../auth/audit.ts";
import { isConflictError, type RestClient } from "../auth/rest.ts";
import { requireAnyRole } from "../auth/session.ts";
import { requireFreshReauthentication } from "../auth/step-up.ts";
import { PLATFORM_ROLES, type PlatformRole, type RequestActor } from "../auth/types.ts";
import {
  ANNOUNCEMENT_AUDIT_ACTIONS,
  ANNOUNCEMENT_BODY_MAXIMUM_LENGTH,
  ANNOUNCEMENT_DISMISSED_AUDIT_ACTION,
  ANNOUNCEMENT_LIST_LIMIT,
  ANNOUNCEMENT_MANAGE_ROLES,
  ANNOUNCEMENT_POPUP_LIMIT,
  ANNOUNCEMENT_PUBLISHED_AUDIT_ACTION,
  ANNOUNCEMENT_READ_ROLES,
  ANNOUNCEMENT_SAVED_AUDIT_ACTION,
  ANNOUNCEMENT_TITLE_MAXIMUM_LENGTH,
  ANNOUNCEMENT_WITHDRAWN_AUDIT_ACTION,
  announcementAudienceLabelKey,
  announcementBodyProblemOf,
  announcementExpiryProblemOf,
  announcementLevelLabelKey,
  announcementStateLabelKey,
  announcementStateOf,
  announcementTitleProblemOf,
  endOfDayEpochMs,
  isAnnouncementAudience,
  isAnnouncementLevel,
  isAnnouncementVisibleTo,
  type AnnouncementAudience,
  type AnnouncementLevel,
  type AnnouncementState,
} from "./registry.ts";

/**
 * The announcement composer, the publish flow and the per person dismiss record of section 24.
 *
 * ## The shape of the book
 *
 * `0007` says an announcement is a draft until `published_at` is set and stops showing at
 * `expires_at`; `0008` says one person closing one announcement is one row, enforced by a unique
 * index. This module follows that grammar rather than inventing a status column:
 *
 *   - `saveAnnouncement` writes a draft - creating it, or changing one that has never been published;
 *   - `publishAnnouncement` sets the instant it becomes visible, once;
 *   - `withdrawAnnouncement` writes the expiry, which is the column `0007` created for exactly this;
 *   - `listActiveAnnouncements` answers what one person should see now, which is the popup query;
 *   - `dismissAnnouncement` writes the row that makes it never appear again for that person.
 *
 * ## Why a published announcement cannot be edited
 *
 * A banner is read by people who then act on it. Editing the text under a live banner changes what
 * somebody already read, and the audit trail would then record one announcement where two sentences
 * were shown. So editing is refused once `published_at` is set: withdraw it and publish the new text,
 * which leaves two rows and two entries - and is the truth.
 *
 * ## Why a dismissal is idempotent
 *
 * The unique index is the rule, so a second dismissal is not an error the person should see: the
 * insert answers a unique violation, this module treats it as "already dismissed", records nothing
 * and answers success. That keeps a double click, a retried request and two open tabs from showing a
 * person a failure for something that is already true.
 */

/** The two tables this module needs, and no more. */
export type AnnouncementStore = Omit<RestClient, "rpc">;

export interface AnnouncementDependencies {
  readonly store: AnnouncementStore;
  readonly audit: AuditTrail;
  readonly now?: () => number;
}

/** One row of the composer, as the screen renders it. */
export interface AnnouncementAdminView {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly level: AnnouncementLevel;
  readonly levelLabelKey: string;
  readonly audience: AnnouncementAudience;
  readonly audienceLabelKey: string;
  readonly state: AnnouncementState;
  readonly stateLabelKey: string;
  readonly publishedAtEpochMs: number | null;
  readonly expiresAtEpochMs: number | null;
  readonly updatedAtEpochMs: number;
  readonly version: number;
}

/** Everything the composer screen renders. */
export interface AnnouncementAdminSnapshot {
  readonly items: readonly AnnouncementAdminView[];
  readonly draftCount: number;
  readonly liveCount: number;
  readonly endedCount: number;
  readonly readAtEpochMs: number;
  /** True when this account may write: section 24's one role. */
  readonly canManage: boolean;
}

/** One announcement as the popup renders it. */
export interface AnnouncementPopupView {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly level: AnnouncementLevel;
  readonly levelLabelKey: string;
  readonly publishedAtEpochMs: number;
  readonly expiresAtEpochMs: number | null;
}

/** What one dismissal did. */
export interface DismissalResult {
  readonly announcementId: string;
  /** True when this call wrote the row, false when it was already there. */
  readonly recorded: boolean;
}

const rowSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(ANNOUNCEMENT_TITLE_MAXIMUM_LENGTH),
  body: z.string().min(1).max(ANNOUNCEMENT_BODY_MAXIMUM_LENGTH),
  level: z.string().min(1).max(20),
  audience: z.string().min(1).max(20),
  company_id: z.string().min(1).max(64).nullable(),
  published_at: z.string().min(1).max(40).nullable(),
  expires_at: z.string().min(1).max(40).nullable(),
  updated_at: z.string().min(1).max(40),
  version: z.number().int().positive(),
});

const versionRowSchema = z.object({ version: z.number().int().positive() });

const dismissalRowSchema = z.object({ announcement_id: z.string().min(1).max(64) });

const columns = "select=id,title,body,level,audience,company_id,published_at,expires_at,updated_at,version";

const composerSelect =
  `${columns}&company_id=is.null&deleted_at=is.null&order=updated_at.desc` +
  `&limit=${String(ANNOUNCEMENT_LIST_LIMIT)}`;

const popupSelect =
  `${columns}&company_id=is.null&deleted_at=is.null&published_at=not.is.null` +
  `&order=published_at.desc&limit=${String(ANNOUNCEMENT_POPUP_LIMIT * 4)}`;

const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9-]+$/u);

function nowOf(dependencies: AnnouncementDependencies): number {
  return dependencies.now?.() ?? Date.now();
}

function encoded(value: string): string {
  return encodeURIComponent(value);
}

function epochOf(value: string): number {
  const parsed = Date.parse(value);

  if (!Number.isFinite(parsed)) {
    throw new AppError("INTERNAL_ERROR");
  }

  return parsed;
}

/** The composer's guard: section 24's one role, and a second factor proved recently. */
function requireComposer(actor: RequestActor, instant: number): void {
  requireAnyRole(actor, ANNOUNCEMENT_MANAGE_ROLES);
  requireFreshReauthentication(actor, instant);
}

/** The reader's guard: the three roles that may open the composer. */
function requireReader(actor: RequestActor): readonly PlatformRole[] {
  requireAnyRole(actor, ANNOUNCEMENT_READ_ROLES);

  return actor.roles;
}

/** One person's guard: whatever role they hold. A client token link holds none. */
function requirePerson(actor: RequestActor): void {
  requireAnyRole(actor, PLATFORM_ROLES);
}

/** One announcement by identifier, or `RESOURCE_NOT_FOUND`. */
async function readRow(
  dependencies: AnnouncementDependencies,
  announcementId: string,
): Promise<z.infer<typeof rowSchema>> {
  const parsed = identifierSchema.safeParse(announcementId);

  if (!parsed.success) {
    throw new AppError("RESOURCE_NOT_FOUND");
  }

  const rows = await dependencies.store.select(
    "announcements",
    `${columns}&id=eq.${encoded(parsed.data)}&company_id=is.null&deleted_at=is.null&limit=1`,
    rowSchema,
  );

  const row = rows[0];

  if (row === undefined) {
    throw new AppError("RESOURCE_NOT_FOUND");
  }

  return row;
}

/** A compare-and-set write, with the read-back that tells a landed write from a lost race. */
async function writeRow(
  dependencies: AnnouncementDependencies,
  row: z.infer<typeof rowSchema>,
  values: Readonly<Record<string, unknown>>,
): Promise<void> {
  await dependencies.store.update(
    "announcements",
    `id=eq.${encoded(row.id)}&version=eq.${String(row.version)}&deleted_at=is.null`,
    values,
  );

  const after = await dependencies.store.select(
    "announcements",
    `select=version&id=eq.${encoded(row.id)}&limit=1`,
    versionRowSchema,
  );

  if (after[0]?.version !== row.version + 1) {
    throw new AppError("CONFLICT", { details: [{ field: "announcementId", rule: "stale" }] });
  }
}

function adminViewOf(row: z.infer<typeof rowSchema>, instant: number): AnnouncementAdminView {
  if (!isAnnouncementLevel(row.level) || !isAnnouncementAudience(row.audience)) {
    throw new AppError("INTERNAL_ERROR");
  }

  const publishedAtEpochMs = row.published_at === null ? null : epochOf(row.published_at);
  const expiresAtEpochMs = row.expires_at === null ? null : epochOf(row.expires_at);
  const state = announcementStateOf({ publishedAtEpochMs, expiresAtEpochMs, nowEpochMs: instant });

  return {
    id: row.id,
    title: row.title,
    body: row.body,
    level: row.level,
    levelLabelKey: announcementLevelLabelKey(row.level),
    audience: row.audience,
    audienceLabelKey: announcementAudienceLabelKey(row.audience),
    state,
    stateLabelKey: announcementStateLabelKey(state),
    publishedAtEpochMs,
    expiresAtEpochMs,
    updatedAtEpochMs: epochOf(row.updated_at),
    version: row.version,
  };
}

async function composerSnapshotOf(
  actor: RequestActor,
  dependencies: AnnouncementDependencies,
): Promise<AnnouncementAdminSnapshot> {
  const instant = nowOf(dependencies);
  const rows = await dependencies.store.select("announcements", composerSelect, rowSchema);
  const items = rows.map((row) => adminViewOf(row, instant));

  return {
    items,
    draftCount: items.filter((item) => item.state === "draft").length,
    liveCount: items.filter((item) => item.state === "live").length,
    endedCount: items.filter((item) => item.state === "ended").length,
    readAtEpochMs: instant,
    canManage: ANNOUNCEMENT_MANAGE_ROLES.some((role) => actor.roles.includes(role)),
  };
}

/**
 * The composer as the screen reads it: every announcement, drafts included.
 *
 * Read by the three roles of `ANNOUNCEMENT_READ_ROLES`; `canManage` travels with the snapshot so the
 * screen cannot offer a button the service would refuse.
 */
export async function listAnnouncements(
  input: { readonly actor: RequestActor },
  dependencies: AnnouncementDependencies,
): Promise<AnnouncementAdminSnapshot> {
  requireReader(input.actor);

  return composerSnapshotOf(input.actor, dependencies);
}

/** The fields of a draft, already parsed by the caller's shape. */
interface DraftInput {
  readonly title: string;
  readonly body: string;
  readonly level: string;
  readonly audience: string;
  /** The last day the banner shows, as `YYYY-MM-DD`, or null for "until somebody stops it". */
  readonly expiresOn: string | null;
}

/** The expiry instant a draft stores, from the day the form sent. */
type ExpiryDecision = { readonly expiresAtEpochMs: number | null; readonly expiresAt: string | null };

function expiryOf(expiresOn: string | null): ExpiryDecision {
  if (expiresOn === null || expiresOn.trim().length === 0) {
    return { expiresAtEpochMs: null, expiresAt: null };
  }

  const expiresAtEpochMs = endOfDayEpochMs(expiresOn.trim());

  if (expiresAtEpochMs === null) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "expiresOn", rule: "invalid_date" }],
    });
  }

  return { expiresAtEpochMs, expiresAt: new Date(expiresAtEpochMs).toISOString() };
}

function checkedDraft(input: DraftInput, instant: number): {
  readonly title: string;
  readonly body: string;
  readonly level: AnnouncementLevel;
  readonly audience: AnnouncementAudience;
  readonly expiresAt: string | null;
} {
  const titleProblem = announcementTitleProblemOf(input.title);

  if (titleProblem !== null) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "title", rule: titleProblem }] });
  }

  const bodyProblem = announcementBodyProblemOf(input.body);

  if (bodyProblem !== null) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "body", rule: bodyProblem }] });
  }

  if (!isAnnouncementLevel(input.level)) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "level", rule: "invalid_format" }] });
  }

  if (!isAnnouncementAudience(input.audience)) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "audience", rule: "invalid_format" }],
    });
  }

  const expiry = expiryOf(input.expiresOn);
  const expiryProblem = announcementExpiryProblemOf({
    expiresAtEpochMs: expiry.expiresAtEpochMs,
    nowEpochMs: instant,
  });

  if (expiryProblem !== null) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "expiresOn", rule: expiryProblem }],
    });
  }

  return {
    title: input.title.trim(),
    body: input.body.trim(),
    level: input.level,
    audience: input.audience,
    expiresAt: expiry.expiresAt,
  };
}

/**
 * Write a draft: create one, or change one that has never been published.
 *
 * A row that is already published is refused with `CONFLICT published` rather than edited, because
 * the people who read it acted on the text that was there. The new text is a new announcement, and
 * the trail then holds both.
 */
export async function saveAnnouncement(
  input: DraftInput & { readonly actor: RequestActor; readonly announcementId: string | null },
  dependencies: AnnouncementDependencies,
): Promise<AnnouncementAdminSnapshot> {
  const instant = nowOf(dependencies);

  requireComposer(input.actor, instant);

  const draft = checkedDraft(input, instant);

  if (input.announcementId === null) {
    await dependencies.store.insert("announcements", [
      {
        title: draft.title,
        body: draft.body,
        level: draft.level,
        audience: draft.audience,
        company_id: null,
        published_at: null,
        expires_at: draft.expiresAt,
        created_by: input.actor.userId,
      },
    ]);

    await dependencies.audit.append({
      action: ANNOUNCEMENT_SAVED_AUDIT_ACTION,
      actorUserId: input.actor.userId,
      entityType: "announcement",
      entityId: null,
      companyId: null,
      sessionId: input.actor.sessionId,
      payload: { created: true, level: draft.level, audience: draft.audience },
    });

    return composerSnapshotOf(input.actor, dependencies);
  }

  const row = await readRow(dependencies, input.announcementId);

  if (row.published_at !== null) {
    throw new AppError("CONFLICT", { details: [{ field: "announcementId", rule: "published" }] });
  }

  await writeRow(dependencies, row, {
    title: draft.title,
    body: draft.body,
    level: draft.level,
    audience: draft.audience,
    expires_at: draft.expiresAt,
  });

  await dependencies.audit.append({
    action: ANNOUNCEMENT_SAVED_AUDIT_ACTION,
    actorUserId: input.actor.userId,
    entityType: "announcement",
    entityId: row.id,
    companyId: null,
    sessionId: input.actor.sessionId,
    payload: {
      created: false,
      level: draft.level,
      audience: draft.audience,
      title_changed: row.title !== draft.title,
    },
  });

  return composerSnapshotOf(input.actor, dependencies);
}

/**
 * Publish a draft: the one write that makes a banner visible.
 *
 * `published_at` is set once. A second publish is a conflict rather than a re-stamp, because the
 * instant is what the popup query orders by and what the trail records.
 */
export async function publishAnnouncement(
  input: { readonly actor: RequestActor; readonly announcementId: string },
  dependencies: AnnouncementDependencies,
): Promise<AnnouncementAdminSnapshot> {
  const instant = nowOf(dependencies);

  requireComposer(input.actor, instant);

  const row = await readRow(dependencies, input.announcementId);

  if (row.published_at !== null) {
    throw new AppError("CONFLICT", { details: [{ field: "announcementId", rule: "published" }] });
  }

  const expiresAtEpochMs = row.expires_at === null ? null : epochOf(row.expires_at);
  const expiryProblem = announcementExpiryProblemOf({ expiresAtEpochMs, nowEpochMs: instant });

  if (expiryProblem !== null) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "expiresOn", rule: expiryProblem }],
    });
  }

  await writeRow(dependencies, row, { published_at: new Date(instant).toISOString() });

  await dependencies.audit.append({
    action: ANNOUNCEMENT_PUBLISHED_AUDIT_ACTION,
    actorUserId: input.actor.userId,
    entityType: "announcement",
    entityId: row.id,
    companyId: null,
    sessionId: input.actor.sessionId,
    payload: {
      level: row.level,
      audience: row.audience,
      expires_at: row.expires_at,
    },
  });

  return composerSnapshotOf(input.actor, dependencies);
}

/**
 * Stop a live announcement without deleting it.
 *
 * The expiry is the stop, so a withdrawal writes the instant into that column: the row keeps saying
 * when it was live, when it stopped and who stopped it, and the popup query needs no extra branch.
 */
export async function withdrawAnnouncement(
  input: { readonly actor: RequestActor; readonly announcementId: string },
  dependencies: AnnouncementDependencies,
): Promise<AnnouncementAdminSnapshot> {
  const instant = nowOf(dependencies);

  requireComposer(input.actor, instant);

  const row = await readRow(dependencies, input.announcementId);

  if (row.published_at === null) {
    throw new AppError("CONFLICT", {
      details: [{ field: "announcementId", rule: "not_published" }],
    });
  }

  const expiresAtEpochMs = row.expires_at === null ? null : epochOf(row.expires_at);

  if (expiresAtEpochMs !== null && expiresAtEpochMs <= instant) {
    throw new AppError("CONFLICT", { details: [{ field: "announcementId", rule: "ended" }] });
  }

  await writeRow(dependencies, row, { expires_at: new Date(instant).toISOString() });

  const publishedAtEpochMs = row.published_at === null ? instant : epochOf(row.published_at);

  await dependencies.audit.append({
    action: ANNOUNCEMENT_WITHDRAWN_AUDIT_ACTION,
    actorUserId: input.actor.userId,
    entityType: "announcement",
    entityId: row.id,
    companyId: null,
    sessionId: input.actor.sessionId,
    payload: {
      level: row.level,
      audience: row.audience,
      days_live: Math.max(0, Math.floor((instant - publishedAtEpochMs) / 86_400_000)),
    },
  });

  return composerSnapshotOf(input.actor, dependencies);
}

function popupViewOf(row: z.infer<typeof rowSchema>): AnnouncementPopupView {
  if (!isAnnouncementLevel(row.level) || row.published_at === null) {
    throw new AppError("INTERNAL_ERROR");
  }

  return {
    id: row.id,
    title: row.title,
    body: row.body,
    level: row.level,
    levelLabelKey: announcementLevelLabelKey(row.level),
    publishedAtEpochMs: epochOf(row.published_at),
    expiresAtEpochMs: row.expires_at === null ? null : epochOf(row.expires_at),
  };
}

/** The announcements this person has already closed among the ones the query returned. */
async function dismissedIdsOf(
  actor: RequestActor,
  candidates: readonly string[],
  dependencies: AnnouncementDependencies,
): Promise<ReadonlySet<string>> {
  if (candidates.length === 0) {
    return new Set<string>();
  }

  const rows = await dependencies.store.select(
    "announcement_dismissals",
    "select=announcement_id&user_id=" +
      `eq.${encoded(actor.userId)}&announcement_id=in.(${candidates.map(encoded).join(",")})` +
      "&deleted_at=is.null&limit=50",
    dismissalRowSchema,
  );

  return new Set<string>(rows.map((row) => row.announcement_id));
}

/** True when this person is inside this row's audience today. */
function visibleTo(
  row: z.infer<typeof rowSchema>,
  actor: RequestActor,
  instant: number,
): boolean {
  if (!isAnnouncementAudience(row.audience)) {
    return false;
  }

  return isAnnouncementVisibleTo({
    audience: row.audience,
    companyId: row.company_id,
    publishedAtEpochMs: row.published_at === null ? null : epochOf(row.published_at),
    expiresAtEpochMs: row.expires_at === null ? null : epochOf(row.expires_at),
    nowEpochMs: instant,
    viewer: { companyId: actor.companyId, roles: actor.roles },
  });
}

/**
 * What one person should see as popups right now.
 *
 * Published, not ended, inside this person's audience and not already dismissed - in that order,
 * newest first, capped at `ANNOUNCEMENT_POPUP_LIMIT`. A person whose dismissal row is missing sees it
 * again, which is the sentence section 24 asks for in both directions.
 */
export async function listActiveAnnouncements(
  input: { readonly actor: RequestActor },
  dependencies: AnnouncementDependencies,
): Promise<readonly AnnouncementPopupView[]> {
  requirePerson(input.actor);

  const instant = nowOf(dependencies);
  const rows = await dependencies.store.select("announcements", popupSelect, rowSchema);
  const shown = rows.filter((row) => visibleTo(row, input.actor, instant));
  const dismissed = await dismissedIdsOf(
    input.actor,
    shown.map((row) => row.id),
    dependencies,
  );

  return shown
    .filter((row) => !dismissed.has(row.id))
    .slice(0, ANNOUNCEMENT_POPUP_LIMIT)
    .map((row) => popupViewOf(row));
}

/**
 * Record that one person closed one announcement.
 *
 * The row is written once. A second attempt answers the unique index's conflict, which this module
 * reads as "already dismissed" rather than as a failure: the sentence "it does not appear again for
 * that user" is already true, so nothing is recorded and nothing is reported.
 */
export async function dismissAnnouncement(
  input: { readonly actor: RequestActor; readonly announcementId: string },
  dependencies: AnnouncementDependencies,
): Promise<DismissalResult> {
  requirePerson(input.actor);

  const instant = nowOf(dependencies);
  const row = await readRow(dependencies, input.announcementId);

  if (!visibleTo(row, input.actor, instant)) {
    // A draft, an ended banner and somebody else's company are all "there is nothing here for you":
    // answering differently would tell a person what the platform has written but not shown.
    throw new AppError("RESOURCE_NOT_FOUND");
  }

  try {
    await dependencies.store.insert("announcement_dismissals", [
      {
        announcement_id: row.id,
        user_id: input.actor.userId,
        company_id: input.actor.companyId,
        dismissed_at: new Date(instant).toISOString(),
      },
    ]);
  } catch (error) {
    if (!isConflictError(error)) {
      throw error;
    }

    return { announcementId: row.id, recorded: false };
  }

  await dependencies.audit.append({
    action: ANNOUNCEMENT_DISMISSED_AUDIT_ACTION,
    actorUserId: input.actor.userId,
    entityType: "announcement",
    entityId: row.id,
    companyId: input.actor.companyId,
    sessionId: input.actor.sessionId,
    payload: { level: row.level, audience: row.audience },
  });

  return { announcementId: row.id, recorded: true };
}

/** The audit names this module writes, exported so the gate can walk the same list. */
export const ANNOUNCEMENT_AUDIT_NAMES: readonly string[] = ANNOUNCEMENT_AUDIT_ACTIONS;
