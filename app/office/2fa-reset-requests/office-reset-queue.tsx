// path: app/office/2fa-reset-requests/office-reset-queue.tsx
"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { deviceProofHeaders } from "@/lib/auth/device-proof-store";
import { csrfHeaders } from "@/lib/security/csrf-client";
import { rateLimitSentence } from "@/lib/auth/refusal-message";
import { formatMessage, getMessage } from "@/lib/i18n/messages";
import type { TwoFactorResetRequestView } from "@/lib/auth/two-factor-reset";

/**
 * The office queue, with the three decisions on each row.
 *
 * The queue itself arrives from the server component above, so a person who may not decide never
 * sees the rows at all: the refusal is decided before this component is rendered, not inside it. What
 * this component owns is the draft of one decision, and every action is a single POST to
 * `/api/office/2fa-reset-requests/decision` with the action name the service expects.
 *
 * After a decision it asks the router for a fresh render, because the row it just decided is no
 * longer in the queue the server would read. Nothing is removed from this component's own list: the
 * server is the one that says what is waiting.
 */

type Action = "contacted" | "approve" | "reject";

const fieldClassName =
  "mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary";

const labelClassName = "mt-3 block text-sm font-medium";

const primaryButtonClassName =
  "mt-4 inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60";

const secondaryButtonClassName =
  "mt-3 inline-flex items-center justify-center rounded-lg border border-border bg-background px-4 py-2 text-sm font-semibold text-foreground transition-opacity hover:opacity-80 disabled:opacity-60";

const dangerButtonClassName =
  "mt-3 inline-flex items-center justify-center rounded-lg border border-destructive px-4 py-2 text-sm font-semibold text-destructive transition-opacity hover:opacity-80 disabled:opacity-60";

/** The sentence a caller sees for a status code, in this screen's vocabulary. */
function messageForStatus(status: number, payload: unknown): string {
  if (status === 429) {
    return rateLimitSentence(payload);
  }

  if (status === 401) {
    return getMessage("officeReset.signedOut");
  }

  if (status === 403) {
    return getMessage("officeReset.forbidden");
  }

  if (status === 409) {
    return getMessage("officeReset.conflict");
  }

  if (status === 404) {
    return getMessage("officeReset.conflict");
  }

  return getMessage("officeReset.failed");
}

function RequestCard({ request }: { readonly request: TwoFactorResetRequestView }): ReactNode {
  const router = useRouter();
  const [action, setAction] = useState<Action | null>(null);
  const [documentReference, setDocumentReference] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function decide(event: FormEvent<HTMLFormElement>, chosen: Action): Promise<void> {
    event.preventDefault();
    setMessage(null);
    setBusy(true);

    try {
      const body = JSON.stringify({
        requestId: request.id,
        action: chosen,
        ...(chosen === "contacted" ? { documentReference } : {}),
        ...(chosen === "contacted" || note.trim().length === 0 ? {} : { note }),
      });

      // STEP 050: a decision removes a second factor, so the cookie is not enough. The proof signs
      // this exact body for this exact path; without a key on this browser there is nothing to sign
      // with, and saying so is better than a request that is refused after the office member waits.
      const proof = await deviceProofHeaders(
        "POST",
        "/api/office/2fa-reset-requests/decision",
        body,
      );

      if (proof === null) {
        setMessage(getMessage("device.proofRequired"));
        setBusy(false);

        return;
      }

      const csrf = await csrfHeaders();
      const response = await fetch("/api/office/2fa-reset-requests/decision", {
        method: "POST",
        headers: { "content-type": "application/json", ...proof, ...csrf },
        body,
      });
      if (!response.ok) {
        const refusal: unknown = await response.json().catch(() => null);

        setMessage(messageForStatus(response.status, refusal));
        setBusy(false);

        return;
      }

      setBusy(false);
      setAction(null);
      setDocumentReference("");
      setNote("");

      if (chosen === "contacted") {
        setMessage(getMessage("officeReset.contactedDone"));
      } else {
        setMessage(
          chosen === "approve"
            ? getMessage("officeReset.approvedDone")
            : getMessage("officeReset.rejectedDone"),
        );
      }

      router.refresh();
    } catch {
      setMessage(getMessage("officeReset.failed"));
      setBusy(false);
    }
  }

  const contacted = request.status === "contacted";

  return (
    <li className="rounded-lg border border-border bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="rounded-full border border-border bg-muted/40 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide">
          {contacted ? getMessage("officeReset.statusContacted") : getMessage("officeReset.statusPending")}
        </span>
        <span className="text-xs text-muted-foreground">
          {getMessage("officeReset.requestedAtLabel")}: {request.requestedAt}
        </span>
        {request.contactedAt === null ? null : (
          <span className="text-xs text-muted-foreground">
            {getMessage("officeReset.contactedAtLabel")}: {request.contactedAt}
          </span>
        )}
      </div>

      <dl className="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-[10rem_1fr]">
        <dt className="text-muted-foreground">{getMessage("officeReset.accountLabel")}</dt>
        <dd className="break-all font-mono text-xs sm:text-sm">{request.userId}</dd>
        <dt className="text-muted-foreground">{getMessage("officeReset.companyLabel")}</dt>
        <dd className="break-all font-mono text-xs sm:text-sm">
          {request.companyId ?? getMessage("officeReset.noCompany")}
        </dd>
        <dt className="text-muted-foreground">{getMessage("officeReset.documentLabel")}</dt>
        <dd className="break-words">{request.documentReference ?? getMessage("officeReset.documentMissing")}</dd>
      </dl>

      <div className="mt-3">
        <p className="text-sm font-medium">{getMessage("officeReset.reasonLabel")}</p>
        <p className="mt-1 whitespace-pre-wrap break-words rounded-lg border border-border bg-background p-3 text-sm">
          {request.reason}
        </p>
      </div>

      {action === null ? (
        <div className="flex flex-wrap gap-x-3">
          {contacted ? null : (
            <button
              className={primaryButtonClassName}
              type="button"
              onClick={(): void => {
                setMessage(null);
                setAction("contacted");
              }}
            >
              {getMessage("officeReset.contactSubmit")}
            </button>
          )}
          {contacted ? (
            <button
              className={primaryButtonClassName}
              type="button"
              onClick={(): void => {
                setMessage(null);
                setAction("approve");
              }}
            >
              {getMessage("officeReset.approveSubmit")}
            </button>
          ) : null}
          <button
            className={dangerButtonClassName}
            type="button"
            onClick={(): void => {
              setMessage(null);
              setAction("reject");
            }}
          >
            {getMessage("officeReset.rejectSubmit")}
          </button>
        </div>
      ) : (
        <form onSubmit={(event): void => void decide(event, action)}>
          <h3 className="mt-4 text-base font-semibold tracking-tight">
            {action === "contacted"
              ? getMessage("officeReset.contactTitle")
              : action === "approve"
                ? getMessage("officeReset.approveTitle")
                : getMessage("officeReset.rejectTitle")}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {action === "contacted"
              ? getMessage("officeReset.contactBody")
              : action === "approve"
                ? getMessage("officeReset.approveBody")
                : getMessage("officeReset.rejectBody")}
          </p>

          {action === "contacted" ? (
            <>
              <label className={labelClassName} htmlFor={`document-${request.id}`}>
                {getMessage("officeReset.contactFieldLabel")}
              </label>
              <textarea
                className={`${fieldClassName} min-h-20`}
                id={`document-${request.id}`}
                maxLength={200}
                onChange={(event): void => {
                  setDocumentReference(event.target.value);
                }}
                required
                rows={3}
                value={documentReference}
              />
            </>
          ) : null}

          {action === "reject" ? (
            <>
              <label className={labelClassName} htmlFor={`note-${request.id}`}>
                {getMessage("officeReset.noteFieldLabel")}
              </label>
              <textarea
                className={`${fieldClassName} min-h-20`}
                id={`note-${request.id}`}
                maxLength={1_000}
                onChange={(event): void => {
                  setNote(event.target.value);
                }}
                required
                rows={3}
                value={note}
              />
            </>
          ) : null}

          <div className="flex flex-wrap gap-x-3">
            <button
              className={primaryButtonClassName}
              disabled={
                busy ||
                (action === "contacted" && documentReference.trim().length === 0) ||
                (action === "reject" && note.trim().length === 0)
              }
              type="submit"
            >
              {busy
                ? getMessage("officeReset.submitting")
                : action === "contacted"
                  ? getMessage("officeReset.contactSubmit")
                  : action === "approve"
                    ? getMessage("officeReset.approveSubmit")
                    : getMessage("officeReset.rejectSubmit")}
            </button>
            <button
              className={secondaryButtonClassName}
              disabled={busy}
              type="button"
              onClick={(): void => {
                setAction(null);
                setMessage(null);
              }}
            >
              {getMessage("officeReset.cancel")}
            </button>
          </div>
        </form>
      )}

      {message === null ? null : (
        <p className="mt-3 text-sm" role="status">
          {message}
        </p>
      )}
    </li>
  );
}

export function OfficeResetQueue({
  requests,
}: {
  readonly requests: readonly TwoFactorResetRequestView[];
}): ReactNode {
  if (requests.length === 0) {
    return (
      <p className="mt-6 rounded-lg border border-border bg-muted/40 p-4 text-sm" role="status">
        {getMessage("officeReset.empty")}
      </p>
    );
  }

  return (
    <>
      <p className="mt-4 text-sm text-muted-foreground">
        {formatMessage("officeReset.countLabel", { count: String(requests.length) })}
      </p>
      <ul className="mt-3 space-y-4">
        {requests.map((request) => (
          <RequestCard key={request.id} request={request} />
        ))}
      </ul>
    </>
  );
}
