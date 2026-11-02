// path: app/(admin)/account-unlocks/office-unlock-queue.tsx
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { deviceProofHeaders } from "@/lib/auth/device-proof-store";
import { rateLimitSentence } from "@/lib/auth/refusal-message";
import { REAUTHENTICATION_REQUIRED_RULE } from "@/lib/auth/step-up";
import { formatMessage, getMessage } from "@/lib/i18n/messages";
import { csrfHeaders } from "@/lib/security/csrf-client";
import {
  ACCOUNT_LOCK_NOTE_MAXIMUM_LENGTH,
  lockFactorLabelKey,
  lockStandingLabelKey,
  type AccountLockAccount,
  type OpenLockView,
} from "./account-locks";

/**
 * The waiting locks, and the one control an officer may take on them.
 *
 * ## Where every rule lives
 *
 * The rows arrive from the server component above, which has already refused an account that may not
 * read the queue. The act itself is `unlockAccountLock` of STEP 047, reached through the route that
 * carries the CSRF token, the device proof and the fresh-reauthentication guard; nothing here decides
 * who may unlock, whether the contact happened - the checkbox sends the officer's word and the
 * service refuses without it - or whether a lock is still open, because the row says so.
 *
 * ## Why one panel instead of a form on every row
 *
 * A queue can hold fifty locks, and fifty text areas are fifty places a sentence could be typed into
 * the wrong row. The list is a list of choices; the panel is the one place a note is written and one
 * button pressed, so the words an officer typed for one account cannot be sent with another.
 *
 * ## Why a lapsed row has no button
 *
 * `unlockAccountLock` refuses a lock whose two hours are over with `CONFLICT`: the clock ended it, and
 * closing it would change no sign-in. The row says the time is up instead of offering an action the
 * service would refuse - an officer should learn that from the row, not from an error.
 *
 * ## Refusals are told apart, because each is a different next step
 *
 * `403` with `reauth_required` is STEP 053's window and links to the reauthentication;
 * `403` without it is a role that may not unlock; `409` and `404` mean somebody else closed the row or
 * the clock did; `422` names the note or the missing confirmation; `429` carries a wait. Every one of
 * them is a different sentence and none of them is "it did not work".
 */

const UNLOCK_PATH = "/api/office/account-locks/unlock";

interface RefusalDetail {
  readonly field?: unknown;
  readonly rule?: unknown;
}

function refusalDetails(payload: unknown): readonly RefusalDetail[] {
  if (typeof payload !== "object" || payload === null) {
    return [];
  }

  const error = (payload as { readonly error?: unknown }).error;

  if (typeof error !== "object" || error === null) {
    return [];
  }

  const details = (error as { readonly details?: unknown }).details;

  return Array.isArray(details) ? (details as readonly RefusalDetail[]) : [];
}

function firstRule(payload: unknown): string | null {
  const detail = refusalDetails(payload)[0];

  return typeof detail?.rule === "string" ? detail.rule : null;
}

/** The sentence a refusal earns, and whether it is the reauthentication window. */
function refusalFor(status: number, payload: unknown): { readonly message: string; readonly reauth: boolean } {
  if (status === 429) {
    return { message: rateLimitSentence(payload), reauth: false };
  }

  if (status === 401) {
    return { message: getMessage("officeUnlock.signedOut"), reauth: false };
  }

  const rule = firstRule(payload);

  if (status === 403) {
    const reauth = rule === REAUTHENTICATION_REQUIRED_RULE;

    return {
      message: getMessage(reauth ? "officeUnlock.reauthRequired" : "officeUnlock.forbidden"),
      reauth,
    };
  }

  if (rule === "not_confirmed") {
    return { message: getMessage("officeUnlock.confirmRequired"), reauth: false };
  }

  if (status === 422) {
    return { message: getMessage("officeUnlock.noteInvalid"), reauth: false };
  }

  if (status === 409 || status === 404) {
    return { message: getMessage("officeUnlock.conflict"), reauth: false };
  }

  return { message: getMessage("officeUnlock.failed"), reauth: false };
}

const listClasses = "flex flex-col gap-3";

const cardClasses =
  "flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 text-foreground shadow-card";

const cardHeaderClasses = "flex flex-wrap items-center justify-between gap-x-3 gap-y-1";

const nameClasses = "text-base font-semibold tracking-tight";

const codeClasses = "font-mono text-xs text-muted-foreground";

const badgeClasses =
  "rounded-full border border-border bg-muted/40 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide";

const factsClasses = "grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2";

const factTermClasses = "text-muted-foreground";

const panelClasses =
  "flex flex-col gap-3 rounded-lg border border-primary bg-surface p-4 text-foreground shadow-card";

const labelClasses = "text-sm font-medium";

const hintClasses = "text-xs text-muted-foreground";

const textareaClasses =
  "mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary";

const checkboxRowClasses = "flex items-start gap-2 text-sm";

const primaryButtonClasses =
  "w-fit inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60";

const secondaryButtonClasses =
  "w-fit inline-flex items-center justify-center rounded-lg border border-border bg-background px-4 py-2 text-sm font-semibold text-foreground transition-opacity hover:opacity-80";

const messageClasses = "text-sm";

const linkClasses =
  "w-fit rounded-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-primary";

/** One instant, printed the way every office screen prints one: UTC, seconds cut. */
function instantOf(iso: string): string {
  const parsed = Date.parse(iso);

  return Number.isFinite(parsed) ? new Date(parsed).toISOString().replace("T", " ").slice(0, 19) : iso;
}

function accountLine(account: AccountLockAccount | null, userId: string): string {
  if (account === null) {
    return formatMessage("officeUnlock.accountUnknown", { account: userId.slice(0, 8) });
  }

  return account.email.length > 0 ? account.email : account.fullName;
}

/** How long is left, in whole minutes above a minute and in words below one. */
function remainingLine(lock: OpenLockView): string {
  return lock.remainingSeconds < 60
    ? getMessage("officeUnlock.remainingUnderMinute")
    : formatMessage("officeUnlock.remainingLine", { minutes: Math.ceil(lock.remainingSeconds / 60) });
}

interface OfficeUnlockQueueProps {
  readonly open: readonly OpenLockView[];
}

export function OfficeUnlockQueue({ open }: OfficeUnlockQueueProps): ReactNode {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [reauth, setReauth] = useState(false);

  const selected = open.find((lock) => lock.id === selectedId) ?? null;

  function choose(lockId: string): void {
    setSelectedId(lockId);
    setNote("");
    setConfirmed(false);
    setMessage(null);
    setReauth(false);
  }

  function close(): void {
    setSelectedId(null);
    setNote("");
    setConfirmed(false);
    setMessage(null);
    setReauth(false);
  }

  async function unlock(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    if (selected === null) {
      return;
    }

    setMessage(null);
    setReauth(false);

    if (note.trim().length === 0 || note.trim().length > ACCOUNT_LOCK_NOTE_MAXIMUM_LENGTH) {
      setMessage(getMessage("officeUnlock.noteInvalid"));

      return;
    }

    if (!confirmed) {
      setMessage(getMessage("officeUnlock.confirmRequired"));

      return;
    }

    setBusy(true);

    try {
      const body = JSON.stringify({
        lockId: selected.id,
        note: note.trim(),
        ownerContactConfirmed: true,
      });

      // STEP 050: an unlock ends a lock on somebody else's account, so the cookie is not enough.
      const proof = await deviceProofHeaders("POST", UNLOCK_PATH, body);

      if (proof === null) {
        setMessage(getMessage("device.proofRequired"));
        setBusy(false);

        return;
      }

      const response = await fetch(UNLOCK_PATH, {
        method: "POST",
        headers: { "content-type": "application/json", ...proof, ...(await csrfHeaders()) },
        body,
      });

      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        const refusal = refusalFor(response.status, payload);

        setMessage(refusal.message);
        setReauth(refusal.reauth);
        setBusy(false);

        return;
      }

      setBusy(false);
      setSelectedId(null);
      setNote("");
      setConfirmed(false);
      setMessage(getMessage("officeUnlock.unlockedDone"));
      // The queue is the server's answer: the row this officer just closed is no longer in it.
      router.refresh();
    } catch {
      setMessage(getMessage("officeUnlock.failed"));
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <ul className={listClasses}>
        {open.map((lock) => (
          <li className={cardClasses} key={lock.id}>
            <div className={cardHeaderClasses}>
              <span className={nameClasses}>{accountLine(lock.account, lock.userId)}</span>
              <span className={badgeClasses}>{getMessage(lockStandingLabelKey(lock.standing))}</span>
            </div>
            <p className={codeClasses}>{lock.userId.slice(0, 8)}</p>

            <dl className={factsClasses}>
              <div>
                <dt className={factTermClasses}>{getMessage("officeUnlock.columnFactor")}</dt>
                <dd>{getMessage(lockFactorLabelKey(lock.triggeredBy))}</dd>
              </div>
              <div>
                <dt className={factTermClasses}>{getMessage("officeUnlock.columnLocked")}</dt>
                <dd>{formatMessage("officeUnlock.timeLine", { at: instantOf(lock.lockedAt) })}</dd>
              </div>
              <div>
                <dt className={factTermClasses}>{getMessage("officeUnlock.columnExpires")}</dt>
                <dd>{formatMessage("officeUnlock.timeLine", { at: instantOf(lock.expiresAt) })}</dd>
              </div>
              <div>
                <dt className={factTermClasses}>{getMessage("officeUnlock.columnStanding")}</dt>
                <dd>{remainingLine(lock)}</dd>
              </div>
              <div>
                <dt className={factTermClasses}>{getMessage("officeUnlock.columnAlert")}</dt>
                <dd>
                  {getMessage(lock.ownerAlerted ? "officeUnlock.alertedYes" : "officeUnlock.alertedNo")}
                </dd>
              </div>
              <div>
                <dt className={factTermClasses}>{getMessage("officeUnlock.columnContact")}</dt>
                <dd>
                  {lock.ownerContactConfirmedAt === null
                    ? getMessage("officeUnlock.contactMissing")
                    : formatMessage("officeUnlock.contactRecorded", {
                        at: instantOf(lock.ownerContactConfirmedAt),
                      })}
                </dd>
              </div>
            </dl>

            {lock.unlockable ? (
              <button
                className={secondaryButtonClasses}
                disabled={busy}
                onClick={() => choose(lock.id)}
                type="button"
              >
                {getMessage("officeUnlock.unlockHeading")}
              </button>
            ) : (
              <p className="text-sm text-muted-foreground">{getMessage("officeUnlock.lapsedLine")}</p>
            )}
          </li>
        ))}
      </ul>

      {selected === null ? null : (
        <form
          className={panelClasses}
          onSubmit={(event): void => {
            void unlock(event);
          }}
        >
          <h3 className={nameClasses}>
            {formatMessage("officeUnlock.unlockHeadingFor", {
              account: accountLine(selected.account, selected.userId),
            })}
          </h3>

          <label className={labelClasses}>
            {getMessage("officeUnlock.fieldNote")}
            <textarea
              className={textareaClasses}
              maxLength={ACCOUNT_LOCK_NOTE_MAXIMUM_LENGTH}
              onChange={(event) => setNote(event.target.value)}
              rows={3}
              value={note}
            />
            <span className={`${hintClasses} block`}>{getMessage("officeUnlock.hintNote")}</span>
          </label>

          <label className={checkboxRowClasses}>
            <input
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
              type="checkbox"
            />
            <span>{getMessage("officeUnlock.fieldConfirmed")}</span>
          </label>

          <div className="flex flex-wrap items-center gap-3">
            <button className={primaryButtonClasses} disabled={busy} type="submit">
              {busy ? getMessage("officeUnlock.unlockBusy") : getMessage("officeUnlock.unlockSubmit")}
            </button>
            <button className={secondaryButtonClasses} disabled={busy} onClick={close} type="button">
              {getMessage("officeUnlock.cancel")}
            </button>
          </div>
        </form>
      )}

      {message === null ? null : (
        <div className={messageClasses} role="alert">
          <p className="text-destructive">{message}</p>
          {reauth ? (
            <Link className={linkClasses} href="/reauth">
              {getMessage("officeUnlock.reauthLink")}
            </Link>
          ) : null}
        </div>
      )}
    </div>
  );
}
