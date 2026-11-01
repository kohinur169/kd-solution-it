// path: app/(auth)/sessions/session-list.tsx
"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import type { SessionView } from "@/lib/auth/session-list";
import { deviceProofHeaders } from "@/lib/auth/device-proof-store";
import { rateLimitSentence } from "@/lib/auth/refusal-message";
import { formatMessage, getMessage } from "@/lib/i18n/messages";

/**
 * The rows of section 22's session list, and the two acts that change them.
 *
 * The component receives rows and never reads them itself: the filter lives on the server, so a
 * client that edited its state could change what is displayed but not what is ended. Both requests
 * are signed with this browser's device key (STEP 050), which is what makes "end this session" an act
 * by the browser holding the key rather than by whoever copied the cookie.
 *
 * The current session is marked and still offers a button: ending it is a legitimate choice, and the
 * answer says `currentSessionEnded`, so the screen can tell the person to sign in again instead of
 * pretending the browser is still signed in.
 */

const primaryButtonClassName =
  "inline-flex items-center justify-center rounded-lg bg-primary px-3.5 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60";

const secondaryButtonClassName =
  "inline-flex items-center justify-center rounded-lg border border-border bg-surface px-3.5 py-2 text-sm font-semibold text-foreground transition-colors hover:bg-muted/40 disabled:opacity-60";

const badgeClassName =
  "rounded-full border border-border bg-muted/40 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide";

/** One instant, in the one format this screen prints: UTC, minute precision, no locale of its own. */
function formatInstant(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** The refusal one status earns on this screen. */
function messageForStatus(status: number, payload: unknown): string {
  if (status === 429) {
    return rateLimitSentence(payload);
  }

  if (status === 403) {
    return getMessage("sessions.reauthRequired");
  }

  if (status === 401) {
    return getMessage("sessions.signedOut");
  }

  return getMessage("sessions.failed");
}

function readCount(payload: unknown): number | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }

  const count = (payload as { readonly revoked?: unknown }).revoked;

  return typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : null;
}

function readCurrentEnded(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }

  return (payload as { readonly currentSessionEnded?: unknown }).currentSessionEnded === true;
}

/**
 * One signed request, and one answer.
 *
 * A body of `{ sessionId }` ends one session; a body of `{ allOthers: true }` ends every session
 * except the one asking. The proof signs the exact bytes that are sent, which is why the body is
 * serialised once and reused.
 */
async function send(body: Readonly<Record<string, unknown>>): Promise<Response | null> {
  const path = "/api/auth/sessions/revoke";
  const text = JSON.stringify(body);
  const proof = await deviceProofHeaders("POST", path, text);

  if (proof === null) {
    return null;
  }

  return fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...proof },
    body: text,
  });
}

export interface SessionListProperties {
  readonly sessions: readonly SessionView[];
}

export function SessionList({ sessions }: SessionListProperties): ReactNode {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [busyAll, setBusyAll] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function revokeOne(sessionId: string): Promise<void> {
    setMessage(null);
    setBusyId(sessionId);

    try {
      const response = await send({ sessionId });

      if (response === null) {
        setMessage(getMessage("device.proofRequired"));
        setBusyId(null);

        return;
      }

      if (!response.ok) {
        const refusal: unknown = await response.json().catch(() => null);

        setMessage(messageForStatus(response.status, refusal));
        setBusyId(null);

        return;
      }

      const payload: unknown = await response.json().catch(() => null);

      setMessage(
        readCurrentEnded(payload)
          ? getMessage("sessions.revokedCurrentDone")
          : getMessage("sessions.revokedDone"),
      );
      setBusyId(null);
      router.refresh();
    } catch {
      setMessage(getMessage("sessions.failed"));
      setBusyId(null);
    }
  }

  async function revokeOthers(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setMessage(null);
    setBusyAll(true);

    try {
      const response = await send({ allOthers: true });

      if (response === null) {
        setMessage(getMessage("device.proofRequired"));
        setBusyAll(false);

        return;
      }

      if (!response.ok) {
        const refusal: unknown = await response.json().catch(() => null);

        setMessage(messageForStatus(response.status, refusal));
        setBusyAll(false);

        return;
      }

      const payload: unknown = await response.json().catch(() => null);
      const revoked = readCount(payload);

      setMessage(
        revoked === null
          ? getMessage("sessions.revokedDone")
          : revoked === 0
            ? getMessage("sessions.othersNone")
            : formatMessage("sessions.othersRevoked", { count: revoked }),
      );
      setBusyAll(false);
      router.refresh();
    } catch {
      setMessage(getMessage("sessions.failed"));
      setBusyAll(false);
    }
  }

  return (
    <div className="mt-4">
      {message === null ? null : (
        <p className="mb-4 rounded-lg border border-border bg-muted/40 p-3 text-sm" role="status">
          {message}
        </p>
      )}

      {sessions.length === 0 ? (
        <p className="text-sm text-muted-foreground">{getMessage("sessions.empty")}</p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {formatMessage("sessions.countLabel", { count: sessions.length })}
          </p>
          <ul className="mt-3 space-y-3">
            {sessions.map((session) => (
              <li
                className="rounded-lg border border-border bg-surface p-4 sm:p-5"
                key={session.id}
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="text-sm font-semibold">
                    {session.deviceLabel ?? getMessage("sessions.deviceUnknown")}
                  </span>
                  {session.current ? (
                    <span className={badgeClassName}>{getMessage("sessions.current")}</span>
                  ) : null}
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
                  className={`mt-4 ${secondaryButtonClassName}`}
                  disabled={busyId !== null || busyAll}
                  onClick={() => {
                    void revokeOne(session.id);
                  }}
                  type="button"
                >
                  {busyId === session.id
                    ? getMessage("sessions.submitting")
                    : session.current
                      ? getMessage("sessions.revokeCurrentSubmit")
                      : getMessage("sessions.revokeSubmit")}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <form
        className="mt-8 rounded-lg border border-border bg-muted/20 p-4 sm:p-5"
        onSubmit={(event) => {
          void revokeOthers(event);
        }}
      >
        <h3 className="text-base font-semibold tracking-tight">
          {getMessage("sessions.revokeOthersTitle")}
        </h3>
        <p className="mt-2 text-sm text-muted-foreground">{getMessage("sessions.revokeOthersBody")}</p>
        <button
          className={`mt-4 ${primaryButtonClassName}`}
          disabled={busyId !== null || busyAll}
          type="submit"
        >
          {busyAll
            ? getMessage("sessions.submitting")
            : getMessage("sessions.revokeOthersSubmit")}
        </button>
      </form>
    </div>
  );
}
