// path: app/(admin)/account-sessions/office-session-console.tsx
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { deviceProofHeaders } from "@/lib/auth/device-proof-store";
import { rateLimitSentence } from "@/lib/auth/refusal-message";
import type { SessionView } from "@/lib/auth/session-list";
import { REAUTHENTICATION_REQUIRED_RULE } from "@/lib/auth/step-up";
import { formatMessage, getMessage } from "@/lib/i18n/messages";
import { csrfHeaders } from "@/lib/security/csrf-client";
import type { SessionCounts, SessionSubject } from "./session-console";

/**
 * The sessions of one account, and the two ways an officer may end them.
 *
 * ## Where every rule lives
 *
 * The rows arrive from the server component above, which resolved the account and read its sessions
 * through STEP 054's `listAccountSessions` - the role check, the live filter and the audit entry all
 * happened there. The acts are that same STEP's `revokeAccountSession`, reached through the route that
 * carries the CSRF token, the device proof and the fresh-reauthentication guard. Nothing here decides
 * who may revoke, what a session is, or whether a row is still live, because the row says so.
 *
 * ## Why one button per row and one for the rest
 *
 * A merchant who has lost a laptop usually asks for both things in one breath: close this one, and
 * close everything else. The row button ends one session; the panel below ends every session still
 * open, in sequence, one guarded request each. There is no bulk endpoint, and there should not be: each
 * revoke is its own audited act, so ending five sessions leaves five rows naming the officer, and a
 * request that fails halfway leaves the rest live with the count said out loud rather than a batch
 * that half happened and reported success.
 *
 * ## Why the bulk action asks for a word first
 *
 * Ending every session of an account throws its owner out of every device, which is the right answer
 * to a lost laptop and the wrong one to a mistyped search. The panel therefore needs the checkbox that
 * says the request was confirmed with the account holder, and the button stays disabled until it
 * is ticked.
 *
 * ## Refusals are told apart
 *
 * `403` with `reauth_required` is STEP 053's window; `403` without it is a role that may not manage
 * sessions; `404` is a session somebody else already ended; `429` carries a wait. A request that was
 * never sent - no device proof - says so instead of looking like a refusal.
 */

const REVOKE_PATH = "/api/office/sessions/revoke";

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
    return { message: getMessage("officeAccountSessions.signedOut"), reauth: false };
  }

  const rule = firstRule(payload);

  if (status === 403) {
    const reauth = rule === REAUTHENTICATION_REQUIRED_RULE;

    return {
      message: getMessage(
        reauth ? "officeAccountSessions.reauthRequired" : "officeAccountSessions.refusedForbidden",
      ),
      reauth,
    };
  }

  if (status === 404) {
    return { message: getMessage("officeAccountSessions.conflict"), reauth: false };
  }

  return { message: getMessage("officeAccountSessions.failed"), reauth: false };
}

/** One instant, printed the way every office screen prints one: UTC, seconds cut. */
function instantOf(epochMs: number): string {
  return `${new Date(epochMs).toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

const tableClasses = "w-full min-w-2xl border-collapse text-left text-sm";

const headCellClasses =
  "border-b border-border pb-2 pr-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground";

const cellClasses = "border-b border-border py-3 pr-4 align-top";

const mutedClasses = "text-muted-foreground";

const buttonClasses =
  "w-fit rounded-md border border-border bg-surface px-3 py-1.5 text-sm font-semibold text-foreground transition hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-60";

const panelClasses =
  "flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 text-foreground shadow-card";

const alertClasses = "text-sm text-destructive";

const linkClasses = "w-fit rounded-sm font-semibold text-primary underline-offset-4 hover:underline";

export interface OfficeSessionConsoleProps {
  readonly subject: SessionSubject;
  readonly sessions: readonly SessionView[];
  readonly counts: SessionCounts;
  readonly readAtEpochMs: number;
}

export function OfficeSessionConsole({
  subject,
  sessions,
  counts,
  readAtEpochMs,
}: OfficeSessionConsoleProps): ReactNode {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [done, setDone] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [reauth, setReauth] = useState(false);

  async function revokeOne(sessionId: string): Promise<void> {
    setBusy(true);
    setMessage(null);
    setReauth(false);
    setDone(0);

    try {
      const body = JSON.stringify({ userId: subject.userId, sessionId });
      // STEP 050: ending a session on somebody else's account needs more than the cookie.
      const proof = await deviceProofHeaders("POST", REVOKE_PATH, body);

      if (proof === null) {
        setMessage(getMessage("device.proofRequired"));
        setBusy(false);

        return;
      }

      const response = await fetch(REVOKE_PATH, {
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

      setMessage(getMessage("officeAccountSessions.revokedDone"));
      // The list is the server's answer: the row this officer just ended is no longer in it.
      router.refresh();
    } catch {
      setMessage(getMessage("officeAccountSessions.failed"));
    } finally {
      setBusy(false);
    }
  }

  async function revokeEvery(): Promise<void> {
    setBusy(true);
    setMessage(null);
    setReauth(false);
    setDone(0);

    let ended = 0;

    try {
      for (const session of sessions) {
        const body = JSON.stringify({ userId: subject.userId, sessionId: session.id });
        const proof = await deviceProofHeaders("POST", REVOKE_PATH, body);

        if (proof === null) {
          setMessage(getMessage("device.proofRequired"));
          setBusy(false);

          return;
        }

        const response = await fetch(REVOKE_PATH, {
          method: "POST",
          headers: { "content-type": "application/json", ...proof, ...(await csrfHeaders()) },
          body,
        });

        if (!response.ok) {
          const payload: unknown = await response.json().catch(() => null);
          const refusal = refusalFor(response.status, payload);

          setMessage(
            formatMessage("officeAccountSessions.revokeAllPartial", {
              done: ended,
              total: sessions.length,
            }),
          );
          setReauth(refusal.reauth);
          setDone(ended);
          setBusy(false);
          router.refresh();

          return;
        }

        ended += 1;
        setDone(ended);
      }

      setMessage(
        ended === sessions.length
          ? getMessage("officeAccountSessions.revokeAllDone")
          : formatMessage("officeAccountSessions.revokeAllPartial", { done: ended, total: sessions.length }),
      );
      router.refresh();
    } catch {
      setMessage(
        formatMessage("officeAccountSessions.revokeAllPartial", { done: ended, total: sessions.length }),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="session-list" className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold tracking-tight" id="session-list">
          {getMessage("officeAccountSessions.sessionHeading")}
        </h2>
        <p className="max-w-3xl text-sm text-muted-foreground">
          {getMessage("officeAccountSessions.sessionDescription")}
        </p>
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <span>{formatMessage("officeAccountSessions.sessionCount", { count: counts.live })}</span>
          <span>{formatMessage("officeAccountSessions.readAt", { at: instantOf(readAtEpochMs) })}</span>
        </p>

        {sessions.length === 0 ? (
          <p className="text-sm text-muted-foreground">{getMessage("officeAccountSessions.sessionEmpty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableClasses}>
              <thead>
                <tr>
                  <th className={headCellClasses} scope="col">
                    {getMessage("officeAccountSessions.columnDevice")}
                  </th>
                  <th className={headCellClasses} scope="col">
                    {getMessage("officeAccountSessions.columnTrust")}
                  </th>
                  <th className={headCellClasses} scope="col">
                    {getMessage("officeAccountSessions.columnIssued")}
                  </th>
                  <th className={headCellClasses} scope="col">
                    {getMessage("officeAccountSessions.columnLastSeen")}
                  </th>
                  <th className={headCellClasses} scope="col">
                    {getMessage("officeAccountSessions.columnExpires")}
                  </th>
                  <th className={headCellClasses} scope="col">
                    {getMessage("officeAccountSessions.columnAction")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((session) => (
                  <tr key={session.id}>
                    <td className={cellClasses}>
                      <span className="font-medium">
                        {session.deviceLabel ?? getMessage("officeAccountSessions.deviceUnknown")}
                      </span>
                      <span className={`block font-mono text-xs ${mutedClasses}`}>
                        {session.id.slice(0, 8)}
                      </span>
                    </td>
                    <td className={cellClasses}>
                      {session.deviceRevoked
                        ? getMessage("officeAccountSessions.trustDropped")
                        : session.deviceTrusted
                          ? getMessage("officeAccountSessions.trustTrusted")
                          : getMessage("officeAccountSessions.trustUnconfirmed")}
                    </td>
                    <td className={cellClasses}>{instantOf(session.issuedAtEpochMs)}</td>
                    <td className={cellClasses}>{instantOf(session.lastSeenAtEpochMs)}</td>
                    <td className={cellClasses}>{instantOf(session.expiresAtEpochMs)}</td>
                    <td className={cellClasses}>
                      <button
                        className={buttonClasses}
                        disabled={busy}
                        onClick={() => {
                          void revokeOne(session.id);
                        }}
                        type="button"
                      >
                        {getMessage(
                          busy ? "officeAccountSessions.revokeBusy" : "officeAccountSessions.revokeSubmit",
                        )}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {sessions.length === 0 ? null : (
        <section aria-labelledby="session-revoke-all" className={panelClasses}>
          <h2 className="text-lg font-semibold tracking-tight" id="session-revoke-all">
            {getMessage("officeAccountSessions.revokeAllHeading")}
          </h2>
          <p className="max-w-3xl text-sm text-muted-foreground">
            {getMessage("officeAccountSessions.revokeAllBody")}
          </p>
          <label className="flex w-fit items-start gap-2 text-sm" htmlFor="session-revoke-all-confirm">
            <input
              checked={confirmed}
              className="mt-1"
              disabled={busy}
              id="session-revoke-all-confirm"
              onChange={(event) => {
                setConfirmed(event.target.checked);
              }}
              type="checkbox"
            />
            <span>{getMessage("officeAccountSessions.revokeAllConfirm")}</span>
          </label>
          <button
            className={buttonClasses}
            disabled={busy || !confirmed}
            onClick={() => {
              void revokeEvery();
            }}
            type="button"
          >
            {busy && done > 0
              ? formatMessage("officeAccountSessions.revokeAllBusy", { done, total: sessions.length })
              : getMessage("officeAccountSessions.revokeAllSubmit")}
          </button>
        </section>
      )}

      {message === null ? null : (
        <p className={alertClasses} role="alert">
          {message}
        </p>
      )}

      {reauth ? (
        <Link className={linkClasses} href="/reauth">
          {getMessage("officeAccountSessions.reauthenticate")}
        </Link>
      ) : null}
    </div>
  );
}
