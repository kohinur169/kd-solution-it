// path: services/kyc/onboarding-progress.ts
import { z } from "zod";
import type { AuditTrail } from "../../lib/auth/audit.ts";
import { isConflictError, type RestClient } from "../../lib/auth/rest.ts";
import { requireAnyRole, requireCompanyId } from "../../lib/auth/session.ts";
import type { RequestActor } from "../../lib/auth/types.ts";
import { AppError } from "../../lib/errors/app-error.ts";
import {
  ONBOARDING_AUDIT_ACTION,
  ONBOARDING_AUDIT_ENTITY,
  ONBOARDING_OWNER_ROLES,
  ONBOARDING_PROGRESS_TABLE,
  ONBOARDING_START_STEP,
  ONBOARDING_STEP_COUNT,
  isOnboardingStep,
  type OnboardingStep,
} from "./onboarding-steps.ts";

/**
 * The merchant onboarding wizard's shell: the six steps of section 5, and where one company is in
 * them.
 *
 * ## What this module owns, and what it does not
 *
 * `0102` is the row: a company, the step its wizard opens on, and the steps already finished. This
 * module is the only reader and the only writer of that row, and it never decides what a step
 * *contains* - the business information form of STEP 080, the address section of STEP 082, the
 * category of STEP 081 and the rest each validate their own data and mark their own step complete.
 * The shell's whole job is position: open on the right step, let a merchant move, and remember the
 * move when the browser is closed.
 *
 * ## Why the company comes from the actor and never from the request
 *
 * A wizard that took a company id would be a way to read and move another merchant's progress, and
 * the bug would look like a working screen. So the scope is `requireCompanyId(actor)` - the company
 * on the session - and the role is `owner`, which is the section 2 role of a merchant account. An
 * office account has no company of its own and is refused here rather than filtered to nothing, so
 * the office reads merchant progress through its own screens, not through this one.
 *
 * ## Why a save is a position and not a completion
 *
 * Marking a step complete without the data behind it would be a false record: the compliance desk of
 * section 5 reads what the merchant submitted, and "address complete" with no address is worse than
 * no progress at all. `completedSteps` is therefore read here and written by the steps that own the
 * data, and `saveOnboardingStep` moves the pointer only.
 *
 * ## Why an unchanged save writes nothing
 *
 * A merchant who presses the same step twice, or a browser that repeats a request, must not append
 * an audit entry that says something happened when nothing did. A save whose step is already the
 * saved step answers the current progress without an update and without an entry.
 *
 * ## The two refusals, kept apart
 *
 * An actor with no company, or with a role that is not `owner`, is `PERMISSION_DENIED`: the caller
 * proved who they are and may not be here. A step name outside the six is `VALIDATION_FAILED` naming
 * the field and the rule, because a stale form from an older build must be told it is stale rather
 * than stored and rendered as nothing.
 */

/** What one company's wizard looks like to a screen. */
export interface OnboardingProgress {
  readonly companyId: string;
  readonly currentStep: OnboardingStep;
  readonly completedSteps: readonly OnboardingStep[];
  /** Null until the first save: a merchant who has not been here has no start instant. */
  readonly startedAtEpochMs: number | null;
  readonly updatedAtEpochMs: number | null;
  /** False when nothing has been saved yet, so the screen can word the first visit. */
  readonly saved: boolean;
  readonly completedCount: number;
  readonly remainingCount: number;
}

export interface OnboardingProgressDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now?: () => number;
}

const progressRowSchema = z.object({
  company_id: z.string().min(1).max(64),
  current_step: z.string().min(1).max(32),
  completed_steps: z.array(z.string().min(1).max(32)).max(ONBOARDING_STEP_COUNT),
  started_at: z.string().min(1).max(40),
  updated_at: z.string().min(1).max(40),
});

type ProgressRow = z.infer<typeof progressRowSchema>;

function epochMs(instant: string): number {
  const parsed = Date.parse(instant);

  if (!Number.isFinite(parsed)) {
    throw new AppError("INTERNAL_ERROR");
  }

  return parsed;
}

/**
 * The actor's company, or a refusal.
 *
 * The role is asked first because the answer is "this area is for merchants", and the company second
 * because an actor with the role and no company is a defect in the session rather than a permission
 * question - both answer `PERMISSION_DENIED`, and neither reads a row.
 */
function requireOnboardingCompany(actor: RequestActor): string {
  requireAnyRole(actor, ONBOARDING_OWNER_ROLES);

  return requireCompanyId(actor);
}

/**
 * A row as the screen sees it.
 *
 * A step name the build does not know is a defect rather than an empty state: `0102` constrains the
 * column to the six, so a seventh name means the table and this file disagree, and the screen must
 * say the wizard could not be read instead of silently rendering nothing.
 */
function progressOf(row: ProgressRow): OnboardingProgress {
  if (!isOnboardingStep(row.current_step)) {
    throw new AppError("INTERNAL_ERROR");
  }

  const completedSteps: OnboardingStep[] = [];

  for (const step of row.completed_steps) {
    if (!isOnboardingStep(step)) {
      throw new AppError("INTERNAL_ERROR");
    }

    completedSteps.push(step);
  }

  return {
    companyId: row.company_id,
    currentStep: row.current_step,
    completedSteps,
    startedAtEpochMs: epochMs(row.started_at),
    updatedAtEpochMs: epochMs(row.updated_at),
    saved: true,
    completedCount: completedSteps.length,
    remainingCount: ONBOARDING_STEP_COUNT - completedSteps.length,
  };
}

/** What a company that has never saved sees: the first step, nothing finished, nothing written. */
function unsavedProgress(companyId: string): OnboardingProgress {
  return {
    companyId,
    currentStep: ONBOARDING_START_STEP,
    completedSteps: [],
    startedAtEpochMs: null,
    updatedAtEpochMs: null,
    saved: false,
    completedCount: 0,
    remainingCount: ONBOARDING_STEP_COUNT,
  };
}

/** One live row of one company: the read every path of this module starts from. */
async function readProgressRow(
  companyId: string,
  rest: RestClient,
): Promise<ProgressRow | null> {
  const rows = await rest.select(
    ONBOARDING_PROGRESS_TABLE,
    `select=company_id,current_step,completed_steps,started_at,updated_at&company_id=eq.${encodeURIComponent(companyId)}&deleted_at=is.null&limit=1`,
    progressRowSchema,
  );

  return rows[0] ?? null;
}

/**
 * The caller's own company's progress.
 *
 * One read, filtered by `company_id=eq.<the actor's company>` and `deleted_at=is.null`, which is the
 * partial unique index `onboarding_progress_company_key` - so a company without a row is an ordinary
 * answer rather than an error, worded by the screen as "nothing saved yet".
 */
export async function readOnboardingProgress(
  input: { readonly actor: RequestActor },
  dependencies: OnboardingProgressDependencies,
): Promise<OnboardingProgress> {
  const companyId = requireOnboardingCompany(input.actor);
  const row = await readProgressRow(companyId, dependencies.rest);

  return row === null ? unsavedProgress(companyId) : progressOf(row);
}

/** The save: move the wizard's position, write the audit entry, and answer the new position. */
export async function saveOnboardingStep(
  input: {
    readonly actor: RequestActor;
    readonly step: string;
    readonly ipAddress: string | null;
    readonly userAgent: string | null;
  },
  dependencies: OnboardingProgressDependencies,
): Promise<OnboardingProgress> {
  const companyId = requireOnboardingCompany(input.actor);

  if (!isOnboardingStep(input.step)) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "step", rule: "unknown_step" }],
    });
  }

  const step = input.step;
  const existing = await readProgressRow(companyId, dependencies.rest);
  const now = dependencies.now ?? ((): number => Date.now());

  // Nothing moved, so nothing happened: no update, no entry.
  if (existing !== null && existing.current_step === step) {
    return progressOf(existing);
  }

  const audit = async (previous: OnboardingStep | null, created: boolean): Promise<void> => {
    await dependencies.audit
      .append({
        action: ONBOARDING_AUDIT_ACTION,
        actorUserId: input.actor.userId,
        entityType: ONBOARDING_AUDIT_ENTITY,
        entityId: companyId,
        companyId,
        sessionId: input.actor.sessionId,
        payload: {
          step,
          previous_step: previous,
          created,
          saved_at: new Date(now()).toISOString(),
        },
        ...(input.ipAddress === null ? {} : { ipAddress: input.ipAddress }),
        ...(input.userAgent === null ? {} : { userAgent: input.userAgent }),
      })
      .catch(() => undefined);
  };

  if (existing === null) {
    const savedAt = now();
    const created: OnboardingProgress = {
      ...unsavedProgress(companyId),
      currentStep: step,
      saved: true,
      startedAtEpochMs: savedAt,
      updatedAtEpochMs: savedAt,
    };

    try {
      await dependencies.rest.insert(ONBOARDING_PROGRESS_TABLE, [
        {
          company_id: companyId,
          updated_by: input.actor.userId,
          current_step: step,
        },
      ]);
    } catch (error) {
      // Two tabs saving their first step at once: the unique index keeps one row, and the second
      // save becomes the update it would have been a moment later.
      if (!isConflictError(error)) {
        throw error;
      }

      await dependencies.rest.update(
        ONBOARDING_PROGRESS_TABLE,
        `company_id=eq.${encodeURIComponent(companyId)}&deleted_at=is.null`,
        { current_step: step, updated_by: input.actor.userId },
      );
      await audit(null, false);

      return created;
    }

    await audit(null, true);

    return created;
  }

  // A row this build cannot read is a defect, and it is raised before anything is written.
  const current = progressOf(existing);
  const savedAt = now();

  await dependencies.rest.update(
    ONBOARDING_PROGRESS_TABLE,
    `company_id=eq.${encodeURIComponent(companyId)}&deleted_at=is.null`,
    { current_step: step, updated_by: input.actor.userId },
  );
  await audit(current.currentStep, false);

  return { ...current, currentStep: step, updatedAtEpochMs: savedAt };
}
