// path: lib/auth/lock-alert.ts
import { z } from "zod";
import { getMessage } from "../i18n/messages.ts";
import type { Logger } from "../logger/logger.ts";
import type { AuditTrail } from "./audit.ts";
import type { LoginAttemptFactor } from "./login-attempts.ts";
import type { RestClient } from "./rest.ts";

/**
 * The owner alert of section 22: "The owner receives an email alert when the lock starts."
 *
 * ## What this module is, and what it is not
 *
 * It is the half of the sentence that belongs to authentication: the instant a lock opens, the
 * platform decides who the owner is, composes the alert and hands it to the email system of section
 * 23. It is not an SMTP client and it never will be. Section 23 is STEP 221 to STEP 230: the
 * sending method is configured by a super_admin and stored encrypted in `email_settings` (`0059`),
 * the wording is a template in `email_templates` (`0060`), and the queue, its retries and its sweep
 * are `email_send_logs` (`0061`) and STEP 227. This module only writes into that queue, in the shape
 * the email system already defined, so a lock that starts while the office has not configured a
 * sender is a lock with no email rather than a made up transport.
 *
 * ## The queue row is the alert
 *
 * One `email_send_logs` row, status `queued`, `template_key = 'login_lock_alert'`,
 * `reference_kind = 'account'` and `reference_id` the locked account. `0086` then points the lock at
 * that row (`account_locks.alert_send_id`) and stamps `owner_alerted_at` in the same update, so the
 * two facts cannot disagree: the pair check refuses a lock that says it alerted its owner without
 * naming the email that did it, and a unique index refuses two locks that claim the same email.
 *
 * Delivery state stays in exactly one place - the log row's status, its attempts and its provider
 * message id - because a second copy on the lock would be a second truth, and `0061`'s guard freezes
 * the parts of a send that must never change.
 *
 * ## Idempotency, and why it needs a compensation
 *
 * "One alert per lock" is the rule: an owner whose account is locked twice in a day should not
 * receive four emails because two requests failed at once. The check is `alert_send_id is null` read
 * before queueing, and the writes are ordered send row first, then lock: the update that claims the
 * lock only matches while the column is still null, and the claim is read back afterwards. If
 * another request won the race, the row this call wrote is marked `dropped` - a state the log
 * already has, with a reason - so the owner receives one email and the log still tells the whole
 * story. The unique index is the database's own vote against two locks sharing one alert.
 *
 * ## Never throws, never blocks a lock
 *
 * A failure here - PostgREST down, no owner recorded, no sending method configured - must not turn
 * "your account is locked" into "the platform is broken", and must not stop the lock from existing.
 * Every outcome is a value, the lock stays open either way, and the reason is logged. Auditing is
 * best effort for the same reason: the audit chain is not allowed to fail a refusal.
 */

/** The section 23 template key this alert uses. `0060` and `0061` both accept it. */
export const LOCK_ALERT_TEMPLATE_KEY = "login_lock_alert";

/** What the email is about, in the vocabulary of `email_send_logs.reference_kind`. */
export const LOCK_ALERT_REFERENCE_KIND = "account";

/**
 * How many times the email system may try.
 *
 * Three is the retry budget the log defaults to; a lock alert is not urgent enough to chase a
 * provider for longer, and section 23 leaves the number to the sender's configuration.
 */
export const LOCK_ALERT_MAX_ATTEMPTS = 3;

/** The reason a losing race writes. `0061` requires a dropped row to carry one. */
const DUPLICATE_ALERT_REASON = "The lock already alerted its owner.";

/** The instant one failed sign in happened, as the alert needs it. */
export interface LockAlertFacts {
  readonly userId: string;
  readonly companyId: string | null;
  /** Which factor reached two failures: the alert says password or code. */
  readonly factor: LoginAttemptFactor;
  readonly lockedAt: string;
  readonly expiresAt: string;
  readonly failedAttempts: number;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

/**
 * What happened to the alert.
 *
 * `queued` is the only success: the email is in the queue of section 23 and the lock points at it.
 * The other five are answers, not errors - a caller decides nothing on them, and none of them
 * changes the lock.
 */
export type LockAlertStatus =
  | "queued"
  | "already_alerted"
  | "no_lock"
  | "no_owner"
  | "sender_not_configured"
  | "failed";

export interface LockAlertOutcome {
  readonly status: LockAlertStatus;
  /** The queue row this call wrote, present only when the status is `queued`. */
  readonly sendId: string | null;
}

/** The port the sign in services depend on. Injected so the gate can answer for it. */
export interface LockAlertNotifier {
  alertOnLock(facts: LockAlertFacts): Promise<LockAlertOutcome>;
}

export interface LockAlertDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly logger: Logger;
  readonly now?: () => number;
}

const openLockSchema = z.object({
  id: z.string().min(1).max(64),
  alert_send_id: z.string().min(1).max(64).nullable(),
});

const sendingMethodSchema = z.object({ method: z.enum(["smtp", "api"]) });

const ownerSchema = z.object({ user_id: z.string().min(1).max(64) });

const addressSchema = z.object({ email: z.string().min(3).max(320) });

const sendRowSchema = z.object({ id: z.string().min(1).max(64) });

const alertSentSchema = z.object({ alert_send_id: z.string().min(1).max(64).nullable() });

function outcome(status: LockAlertStatus, sendId: string | null = null): LockAlertOutcome {
  return { status, sendId };
}

/**
 * Build the notifier the sign in services call.
 *
 * The dependencies are the two the platform already has - the service role REST client and the
 * audit chain - plus the structured logger, because every outcome that is not `queued` deserves a
 * line an operator can find.
 */
export function createLockAlertNotifier(dependencies: LockAlertDependencies): LockAlertNotifier {
  const instant = (): number => (dependencies.now ?? ((): number => Date.now()))();
  const { rest, audit, logger } = dependencies;

  async function readOpenLock(userId: string): Promise<z.infer<typeof openLockSchema> | null> {
    const rows = await rest.select(
      "account_locks",
      `select=id,alert_send_id&user_id=eq.${encodeURIComponent(userId)}` +
        "&unlocked_at=is.null&expired_at=is.null&deleted_at=is.null&order=locked_at.desc&limit=1",
      openLockSchema,
    );

    return rows[0] ?? null;
  }

  /** The sending method the office made active, or null when section 23 has none configured yet. */
  async function readSendingMethod(): Promise<"smtp" | "api" | null> {
    const rows = await rest.select(
      "email_settings",
      "select=method&status=eq.active&deleted_at=is.null&limit=1",
      sendingMethodSchema,
    );

    return rows[0]?.method ?? null;
  }

  /**
   * The address the alert goes to: the owner of the company the locked account belongs to.
   *
   * An owner is a live `role_assignments` row with `role = 'owner'`, which `0004` scopes to exactly
   * one company. A locked account with no company - a platform user - has no merchant owner to tell
   * and answers `no_owner`; so does a company whose owner assignment was revoked and never replaced,
   * which is a state the office has to fix rather than a reason to email somebody else.
   */
  async function readOwnerAddress(companyId: string): Promise<string | null> {
    const owners = await rest.select(
      "role_assignments",
      `select=user_id&company_id=eq.${encodeURIComponent(companyId)}&role=eq.owner` +
        "&revoked_at=is.null&deleted_at=is.null&order=granted_at.asc&limit=1",
      ownerSchema,
    );
    const ownerUserId = owners[0]?.user_id;

    if (ownerUserId === undefined) {
      return null;
    }

    const addresses = await rest.select(
      "users",
      `select=email&id=eq.${encodeURIComponent(ownerUserId)}&deleted_at=is.null&limit=1`,
      addressSchema,
    );

    return addresses[0]?.email ?? null;
  }

  /** Mark the row this call wrote as dropped, so a losing race sends one email and no more. */
  async function dropDuplicate(sendId: string): Promise<void> {
    await rest
      .update("email_send_logs", `id=eq.${encodeURIComponent(sendId)}&status=eq.queued`, {
        status: "dropped",
        failure_reason: DUPLICATE_ALERT_REASON,
      })
      .catch(() => undefined);
  }

  async function queue(facts: LockAlertFacts): Promise<LockAlertOutcome> {
    const lock = await readOpenLock(facts.userId);

    if (lock === null) {
      return outcome("no_lock");
    }

    if (lock.alert_send_id !== null) {
      return outcome("already_alerted");
    }

    const method = await readSendingMethod();

    if (method === null) {
      logger.warn("no email sending method is active, so no lock alert was queued", {
        accountId: facts.userId,
        companyId: facts.companyId,
        factor: facts.factor,
      });

      return outcome("sender_not_configured");
    }

    if (facts.companyId === null) {
      logger.warn("a locked account without a company has no owner to alert", {
        accountId: facts.userId,
        factor: facts.factor,
      });

      return outcome("no_owner");
    }

    const recipient = await readOwnerAddress(facts.companyId);

    if (recipient === null) {
      logger.warn("a locked company has no live owner assignment to alert", {
        companyId: facts.companyId,
        accountId: facts.userId,
      });

      return outcome("no_owner");
    }

    // The row goes in first and the lock is claimed second: the claim is the only write that can
    // lose a race, and it loses to a lock that already points at its own alert, which is the answer
    // wanted either way.
    const rows = await rest.insertReturning(
      "email_send_logs",
      [
        {
          company_id: facts.companyId,
          template_key: LOCK_ALERT_TEMPLATE_KEY,
          recipient_email: recipient,
          recipient_user_id: facts.userId,
          subject: getMessage("email.lockAlert.subject"),
          provider: method,
          max_attempts: LOCK_ALERT_MAX_ATTEMPTS,
          reference_kind: LOCK_ALERT_REFERENCE_KIND,
          reference_id: facts.userId,
          queued_at: new Date(instant()).toISOString(),
        },
      ],
      sendRowSchema,
    );
    const sendId = rows[0]?.id;

    if (sendId === undefined) {
      logger.error("the alert queue accepted no row", {
        accountId: facts.userId,
        companyId: facts.companyId,
      });

      return outcome("failed");
    }

    try {
      await rest.update(
        "account_locks",
        `id=eq.${encodeURIComponent(lock.id)}&alert_send_id=is.null`,
        { alert_send_id: sendId, owner_alerted_at: new Date(instant()).toISOString() },
      );
    } catch (error) {
      await dropDuplicate(sendId);
      logger.warn("the lock could not be pointed at its owner alert", {
        accountId: facts.userId,
        companyId: facts.companyId,
        reason: error instanceof Error ? error.message : "unknown",
      });

      return outcome("failed");
    }

    const claimed = await rest.select(
      "account_locks",
      `select=alert_send_id&id=eq.${encodeURIComponent(lock.id)}&limit=1`,
      alertSentSchema,
    );

    if (claimed[0]?.alert_send_id !== sendId) {
      await dropDuplicate(sendId);

      return outcome("already_alerted");
    }

    await audit
      .append({
        action: "user.login_lock_alerted",
        actorUserId: null,
        entityType: "user",
        entityId: facts.userId,
        companyId: facts.companyId,
        payload: {
          send_id: sendId,
          template_key: LOCK_ALERT_TEMPLATE_KEY,
          triggered_by: facts.factor,
          failed_attempts: facts.failedAttempts,
          locked_at: facts.lockedAt,
          locked_until: facts.expiresAt,
          recipient: "owner",
        },
        ipAddress: facts.ipAddress,
        userAgent: facts.userAgent,
      })
      .catch(() => undefined);

    return outcome("queued", sendId);
  }

  return {
    async alertOnLock(facts: LockAlertFacts): Promise<LockAlertOutcome> {
      try {
        return await queue(facts);
      } catch (error) {
        logger.warn("the owner alert of a new login lock failed", {
          accountId: facts.userId,
          companyId: facts.companyId,
          factor: facts.factor,
          reason: error instanceof Error ? error.message : "unknown",
        });

        return outcome("failed");
      }
    },
  };
}
