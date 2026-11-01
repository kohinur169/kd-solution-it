// path: app/office/sessions/office-session-list.tsx
"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import type { SessionView } from "@/lib/auth/session-list";
import { deviceProofHeaders } from "@/lib/auth/device-proof-store";
import { rateLimitSentence } from "@/lib/auth/refusal-message";
import { getMessage } from "@/lib/i18n/messages";

/**
 * One account's sessions, with a revoke on each, for an office role.
 *
 * The rows arrive from the server, where the role check and the audit entry happen; this component
 * only presses. Both the account and the session travel in the body, so the request says which row
 * of which account it ends, and the service refuses a pair that does not match - an officer holding
 * one account's id cannot use it to end another account's session.
 *
 * A refusal is told apart by status: `403` without a rule is "this account may not manage sessions",
 * `403` with `reauth_required` is STEP 053's window, and `404` is a row that is already gone.
 */

const buttonClassName =
  "inline-flex items-center justify-center rounded-lg border border-border bg-surface px-3.5 py-2 text-sm font-semibold text-foreground transition-colors hover:bg-muted/40 disabled:opacity-60";

const badgeClassName =
  "rounded-full border border-border bg-muted/40 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide";

/** One instant, printed the same way on both session screens: UTC, minute precision. */
function formatInstant(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** True when the body of a `403` names the step-up rule. */
function namesReauthentication(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }

  const details = (payload as { readonly details?: unknown }).details;

  if (!Array.isArray(details)) {
    return false;
  }

  return details.some(
    (detail: unknown) =>
      typeof detail === "object" &&
      detail !== null &&
      (detail as { readonly rule?: unknown }).rule === "reauth_required",
  );
}

function messageForStatus(status: number, payload: unknown): string {
  if (status === 429) {
    return rateLimitSentence(payload);
  }

  if (status === 403) {
    return namesReauthentication(payload)
      ? getMessage("officeSessions.reauthRequired")
      : getMessage("officeSessions.forbidden");
  }

  if (status === 401) {
    return getMessage("officeSessions.signedOut");
  }

  return getMessage("officeSessions.failed");
}

export interface OfficeSessionListProperties {
  readonly userId: string;
  readonly sessions: readonly SessionView[];
}

export function OfficeSessionList({ userId, sessions }: OfficeSessionListProperties): ReactNode {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function revoke(sessionId: string): Promise<void> {
    setMessage(null);
    setBusyId(sessionId);

    try {
      const path = "/api/office/sessions/revoke";
      const body = JSON.stringify({ userId, sessionId });
      const proof = await deviceProofHeaders("POST", path, body);

      if (proof === null) {
        setMessage(getMessage("device.proofRequired"));
        setBusyId(null);

        return;
      }

      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json", ...proof },
        body,
      });

      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);

        setMessage(messageForStatus(response.status, payload));
        setBusyId(null);

        return;
      }

      setMessage(getMessage("officeSessions.revokedDone"));
      setBusyId(null);
      router.refresh();
    } catch {
      setMessage(getMessage("officeSessions.failed"));
      setBusyId(null);
    }
  }

  return (
    <div className="mt-3">
      {message === null ? null : (
        <p className="mb-4 rounded-lg border border-border bg-muted/40 p-3 text-sm" role="status">
          {message}
        </p>
      )}

      <ul className="space-y-3">
        {sessions.map((session) => (
          <li className="rounded-lg border border-border bg-surface p-4 sm:p-5" key={session.id}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-sm font-semibold">
                {session.deviceLabel ?? getMessage("sessions.deviceUnknown")}
              </span>
              {session.deviceRevoked ? (
                <span className={badgeClassName}>{getMessage("sessions.deviceDropped")}</span>
              ) : session.deviceTrusted ? (
                <span className={badgeClassName}>{getMessage("sessions.deviceConfirmed")}</span>
              ) : (
                <span className={badgeClassName}>{getMessage("sessions.deviceUnconfirmed")}</span>
              )}
            </div>

            <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-xs text-muted-foreground sm:grid-cols-3">
              <div>
                <dt className="inline">{getMessage("sessions.startedLabel")}: </dt>
                <dd className="inline">{formatInstant(session.issuedAtEpochMs)}</dd>
              </div>
              <div>
                <dt className="inline">{getMessage("sessions.lastSeenLabel")}: </dt>
                <dd className="inline">{formatInstant(session.lastSeenAtEpochMs)}</dd>
              </div>
              <div>
                <dt className="inline">{getMessage("sessions.expiresLabel")}: </dt>
                <dd className="inline">{formatInstant(session.expiresAtEpochMs)}</dd>
              </div>
            </dl>

            <button
              className={`mt-4 ${buttonClassName}`}
              disabled={busyId !== null}
              onClick={() => {
                void revoke(session.id);
              }}
              type="button"
            >
              {busyId === session.id
                ? getMessage("officeSessions.submitting")
                : getMessage("officeSessions.revokeSubmit")}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
