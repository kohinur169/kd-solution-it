// path: app/(admin)/provisioning-alerts/provisioning-console.tsx
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
  PROVISIONING_ACKNOWLEDGEMENT_NOTE_LIMITS,
  provisioningReasonLabelKey,
} from "@/services/submerchant/provisioning-queue-fields";
import type {
  ProvisioningQueue,
  ProvisioningQueueItem,
} from "@/services/submerchant/provisioning-queue";

/**
 * The queued provisions, and the one control an officer may take on the ones that are blocked.
 *
 * ## Where every rule lives
 *
 * The rows arrive from the server component above, which has already refused an account that may not read
 * the queue. The act itself is `acknowledgeProvisioningAlert`, reached through the route that carries the
 * CSRF token, the device proof and the fresh-reauthentication guard; nothing here decides who may
 * acknowledge, whether the row still exists, or whether it is still queued - the service answers all three
 * and the route refuses everything else.
 *
 * ## Why one panel instead of a form on every row
 *
 * A queue can hold a hundred rows, and a hundred text areas are a hundred places a sentence could be typed
 * into the wrong row. The list is a list of choices; the panel is the one place a note is written and one
 * button pressed, so the words an officer typed for one merchant cannot be sent with another.
 *
 * ## Why an in-flight row has no button
 *
 * A row with a master account is waiting on the provider, and there is nothing for the office to do that
 * the next retry would not do. The row is shown so a stuck one can be told apart from a busy one - the
 * reason and the attempt count say which it is - but an alert that offered a button where there was no
 * action would teach the office to click without reading.
 *
 * ## Refusals are told apart, because each is a different next step
 *
 * `403` with `reauth_required` is the step-up window and links to the reauthentication; `403` without it
 * is a role that may not acknowledge; `409` and `404` mean the row moved on or does not exist any more;
 * `422` names the note; `429` carries a wait. Every one of them is a different sentence.
 */

const ACKNOWLEDGE_PATH = "/api/office/provisioning/acknowledge";

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
    return { message: getMessage("officeProvisioning.signedOut"), reauth: false };
  }

  const rule = firstRule(payload);

  if (status === 403) {
    const reauth = rule === REAUTHENTICATION_REQUIRED_RULE;

    return {
      message: getMessage(reauth ? "officeProvisioning.reauthRequired" : "officeProvisioning.forbidden"),
      reauth,
    };
  }

  if (status === 422) {
    return { message: getMessage("officeProvisioning.noteMissing"), reauth: false };
  }

  if (status === 409 || status === 404) {
    return {
      message: getMessage("officeProvisioning.acknowledgeFailed"),
      reauth: false,
    };
  }

  return { message: getMessage("officeProvisioning.acknowledgeFailed"), reauth: false };
}

const cardClasses =
  "flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 text-foreground shadow-card";

const cardHeaderClasses = "flex flex-wrap items-center justify-between gap-x-3 gap-y-1";

const nameClasses = "text-base font-semibold tracking-tight";

const codeClasses = "font-mono text-xs text-muted-foreground";

const badgeClasses =
  "rounded-full border border-border bg-muted/40 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide";

const overdueBadgeClasses =
  "rounded-full border border-destructive/40 bg-destructive/10 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-destructive";

const factsClasses = "grid gap-x-6 gap-y-1 text-sm sm:grid-cols-3";

const factTermClasses = "text-muted-foreground";

const panelClasses =
  "flex flex-col gap-3 rounded-lg border border-primary bg-surface p-4 text-foreground shadow-card";

const labelClasses = "text-sm font-medium";

const hintClasses = "text-xs text-muted-foreground";

const textareaClasses =
  "mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary";

const primaryButtonClasses =
  "w-fit inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60";

const secondaryButtonClasses =
  "w-fit inline-flex items-center justify-center rounded-lg border border-border bg-background px-4 py-2 text-sm font-semibold text-foreground transition-opacity hover:opacity-80";

const messageClasses = "text-sm";

const linkClasses =
  "w-fit rounded-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-primary";

const tableClasses = "w-full min-w-xl border-collapse text-left text-sm";

const headCellClasses =
  "border-b border-border pb-2 pr-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground";

const cellClasses = "border-b border-border py-3 pr-4 align-top";

/** One instant, printed the way every office screen prints one: UTC, seconds cut. */
function instantOf(iso: string): string {
  const parsed = Date.parse(iso);

  return Number.isFinite(parsed) ? new Date(parsed).toISOString().replace("T", " ").slice(0, 19) : iso;
}

/** How long somebody has been waiting, in whole hours above an hour and in minutes below one. */
function waitingLine(seconds: number): string {
  const hours = Math.floor(seconds / 3_600);

  return hours > 0
    ? formatMessage("officeProvisioning.waitingHours", { hours })
    : formatMessage("officeProvisioning.waitingMinutes", { minutes: Math.max(1, Math.round(seconds / 60)) });
}

/** What a person sees for the merchant behind a row, falling back to its identifier. */
function merchantLine(item: ProvisioningQueueItem): string {
  return item.companyName !== null && item.companyName.length > 0
    ? item.companyName
    : item.companyId.slice(0, 8);
}

interface ProvisioningConsoleProps {
  readonly queue: ProvisioningQueue;
}

export function ProvisioningConsole({ queue }: ProvisioningConsoleProps): ReactNode {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [reauth, setReauth] = useState(false);

  const selected = queue.blocked.find((item) => item.provisionId === selectedId) ?? null;

  function choose(item: ProvisioningQueueItem): void {
    setSelectedId(item.provisionId);
    setNote("");
    setMessage(null);
    setReauth(false);
  }

  function close(): void {
    setSelectedId(null);
    setNote("");
    setMessage(null);
    setReauth(false);
  }

  async function acknowledge(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    if (selected === null) {
      return;
    }

    setMessage(null);
    setReauth(false);

    const trimmed = note.trim();

    if (
      trimmed.length < PROVISIONING_ACKNOWLEDGEMENT_NOTE_LIMITS.min ||
      trimmed.length > PROVISIONING_ACKNOWLEDGEMENT_NOTE_LIMITS.max
    ) {
      setMessage(getMessage("officeProvisioning.noteMissing"));

      return;
    }

    setBusy(true);

    try {
      const body = JSON.stringify({ provisionId: selected.provisionId, note: trimmed });

      // Acknowledging an alert is an office decision about a merchant, so the cookie is not enough.
      const proof = await deviceProofHeaders("POST", ACKNOWLEDGE_PATH, body);

      if (proof === null) {
        setMessage(getMessage("device.proofRequired"));
        setBusy(false);

        return;
      }

      const response = await fetch(ACKNOWLEDGE_PATH, {
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
      setMessage(getMessage("officeProvisioning.acknowledgeDone"));
      // The queue is the server's answer: the acknowledgement mark is read from the trail it just wrote.
      router.refresh();
    } catch {
      setMessage(getMessage("officeProvisioning.acknowledgeFailed"));
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="provisioning-blocked" className="flex flex-col gap-3">
        <h3 className="text-base font-semibold tracking-tight" id="provisioning-blocked">
          {getMessage("officeProvisioning.blockedHeading")}
        </h3>
        <p className="max-w-3xl text-sm text-muted-foreground">
          {getMessage("officeProvisioning.blockedDescription")}
        </p>

        {queue.blocked.length === 0 ? (
          <p className="text-sm text-muted-foreground">{getMessage("officeProvisioning.blockedEmpty")}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {queue.blocked.map((item) => (
              <li className={cardClasses} key={item.provisionId}>
                <div className={cardHeaderClasses}>
                  <span className={nameClasses}>{merchantLine(item)}</span>
                  <span className="flex flex-wrap gap-2">
                    {item.overdue ? (
                      <span className={overdueBadgeClasses}>
                        {getMessage("officeProvisioning.overdueBadge")}
                      </span>
                    ) : null}
                    <span className={badgeClasses}>{item.providerKey}</span>
                  </span>
                </div>
                <p className={codeClasses}>{item.companyId.slice(0, 8)}</p>

                <dl className={factsClasses}>
                  <div>
                    <dt className={factTermClasses}>{getMessage("officeProvisioning.columnReason")}</dt>
                    <dd>{getMessage(provisioningReasonLabelKey(item.reason))}</dd>
                  </div>
                  <div>
                    <dt className={factTermClasses}>{getMessage("officeProvisioning.columnMode")}</dt>
                    <dd>{item.mode}</dd>
                  </div>
                  <div>
                    <dt className={factTermClasses}>{getMessage("officeProvisioning.columnAttempts")}</dt>
                    <dd>{String(item.attemptCount)}</dd>
                  </div>
                  <div>
                    <dt className={factTermClasses}>{getMessage("officeProvisioning.columnRequested")}</dt>
                    <dd>{instantOf(item.requestedAt)}</dd>
                  </div>
                  <div>
                    <dt className={factTermClasses}>{getMessage("officeProvisioning.columnWaiting")}</dt>
                    <dd>{waitingLine(item.waitingSeconds)}</dd>
                  </div>
                  <div>
                    <dt className={factTermClasses}>{getMessage("officeProvisioning.columnAcknowledged")}</dt>
                    <dd>
                      {item.acknowledgedAt === null
                        ? getMessage("officeProvisioning.acknowledgedNo")
                        : formatMessage("officeProvisioning.seenAt", {
                            at: instantOf(item.acknowledgedAt),
                          })}
                    </dd>
                  </div>
                </dl>

                <button
                  className={secondaryButtonClasses}
                  disabled={busy}
                  onClick={() => choose(item)}
                  type="button"
                >
                  {getMessage("officeProvisioning.acknowledgeAction")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="provisioning-inflight" className="flex flex-col gap-3">
        <h3 className="text-base font-semibold tracking-tight" id="provisioning-inflight">
          {getMessage("officeProvisioning.inFlightHeading")}
        </h3>
        <p className="max-w-3xl text-sm text-muted-foreground">
          {getMessage("officeProvisioning.inFlightDescription")}
        </p>

        {queue.inFlight.length === 0 ? (
          <p className="text-sm text-muted-foreground">{getMessage("officeProvisioning.inFlightEmpty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableClasses}>
              <thead>
                <tr>
                  <th className={headCellClasses} scope="col">
                    {getMessage("officeProvisioning.columnCompany")}
                  </th>
                  <th className={headCellClasses} scope="col">
                    {getMessage("officeProvisioning.columnProvider")}
                  </th>
                  <th className={headCellClasses} scope="col">
                    {getMessage("officeProvisioning.columnReason")}
                  </th>
                  <th className={headCellClasses} scope="col">
                    {getMessage("officeProvisioning.columnAttempts")}
                  </th>
                  <th className={headCellClasses} scope="col">
                    {getMessage("officeProvisioning.columnRequested")}
                  </th>
                  <th className={headCellClasses} scope="col">
                    {getMessage("officeProvisioning.columnWaiting")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {queue.inFlight.map((item) => (
                  <tr key={item.provisionId}>
                    <td className={cellClasses}>
                      <span className="font-medium">{merchantLine(item)}</span>
                      <span className={`${codeClasses} block`}>{item.companyId.slice(0, 8)}</span>
                    </td>
                    <td className={cellClasses}>{item.providerKey}</td>
                    <td className={cellClasses}>{getMessage(provisioningReasonLabelKey(item.reason))}</td>
                    <td className={cellClasses}>{String(item.attemptCount)}</td>
                    <td className={cellClasses}>{instantOf(item.requestedAt)}</td>
                    <td className={cellClasses}>{waitingLine(item.waitingSeconds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selected === null ? null : (
        <form
          className={panelClasses}
          onSubmit={(event): void => {
            void acknowledge(event);
          }}
        >
          <h3 className={nameClasses}>
            {formatMessage("officeProvisioning.acknowledgeHeadingFor", { merchant: merchantLine(selected) })}
          </h3>

          <label className={labelClasses}>
            {getMessage("officeProvisioning.acknowledgeLabel")}
            <textarea
              className={textareaClasses}
              maxLength={PROVISIONING_ACKNOWLEDGEMENT_NOTE_LIMITS.max}
              onChange={(event) => setNote(event.target.value)}
              placeholder={getMessage("officeProvisioning.acknowledgePlaceholder")}
              rows={3}
              value={note}
            />
            <span className={`${hintClasses} block`}>{getMessage("officeProvisioning.hintNote")}</span>
          </label>

          <div className="flex flex-wrap items-center gap-3">
            <button className={primaryButtonClasses} disabled={busy} type="submit">
              {busy
                ? getMessage("officeProvisioning.acknowledgePending")
                : getMessage("officeProvisioning.acknowledgeAction")}
            </button>
            <button className={secondaryButtonClasses} disabled={busy} onClick={close} type="button">
              {getMessage("officeProvisioning.cancel")}
            </button>
          </div>
        </form>
      )}

      {message === null ? null : (
        <div className={messageClasses} role="alert">
          <p className="text-destructive">{message}</p>
          {reauth ? (
            <Link className={linkClasses} href="/reauth">
              {getMessage("officeProvisioning.reauthLink")}
            </Link>
          ) : null}
        </div>
      )}
    </div>
  );
}
