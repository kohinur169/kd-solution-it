// path: app/(admin)/office/disputes/[id]/review-panel.tsx
"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { deviceProofHeaders } from "@/lib/auth/device-proof-store";
import { rateLimitSentence } from "@/lib/auth/refusal-message";
import { formatMessage, getMessage } from "@/lib/i18n/messages";
import { csrfHeaders } from "@/lib/security/csrf-client";
import {
  DISPUTE_REVIEW_NOTE_MAXIMUM_LENGTH,
  DISPUTE_SUBMISSION_REFERENCE_MAXIMUM_LENGTH,
  type DisputeReviewDecision,
  type DisputeSubmissionChannel,
} from "@/services/disputes/dispute-submission-fields";

/**
 * Section 19's last two acts, on the pack they are about.
 *
 * ## What it sends, and why the browser decides nothing
 *
 * Two requests: a decision, and a submission. The browser picks which of the two words it is sending and, for a
 * recorded submission, types the processor's case number; everything else - whether the pack is frozen, whether
 * the latest decision is an approval, whether the provider has a documented API, whether the dispute has already
 * been sent - is decided by the service and by `0127` against the rows. The page passes down what the server
 * read (`mayReview`, `maySubmit`, `providerChannel`), so a button is only *offered* where an act could succeed;
 * a stale page that presses anyway reads the refusal instead of a silent nothing.
 *
 * ## Why the device signs both
 *
 * A review decides whether a merchant's money is defended, and a submission is the act that spends the
 * merchant's one chance to answer. Both are signed over the exact bytes with the account's enrolled device key,
 * the same guard the deadline extension and the refund desk's decision carry, and the route refuses a proof that
 * is missing, stale or signed over something else before it parses a field.
 *
 * ## What it prints
 *
 * The sentence the answer earned: the processor's reference after a send, the rule after a refusal, and - for
 * the provider channel of a provider whose API this build has not documented - the honest sentence that says to
 * record the submission instead. A failure is announced (`role="alert"`), a confirmation is a status line.
 */

/** The refusal envelope's first detail, or nulls when the answer carries none. */
function refusalOf(payload: unknown): { readonly field: string | null; readonly rule: string | null } {
  if (typeof payload !== "object" || payload === null) {
    return { field: null, rule: null };
  }

  const error = (payload as { readonly error?: unknown }).error;

  if (typeof error !== "object" || error === null) {
    return { field: null, rule: null };
  }

  const details = (error as { readonly details?: unknown }).details;

  if (!Array.isArray(details) || details.length === 0) {
    return { field: null, rule: null };
  }

  const first = details[0] as { readonly field?: unknown; readonly rule?: unknown };

  return {
    field: typeof first.field === "string" ? first.field : null,
    rule: typeof first.rule === "string" ? first.rule : null,
  };
}

/** The sentence for one refusal, in the desk's words. */
function refusalTextOf(status: number, payload: unknown): string {
  if (status === 401) {
    return getMessage("disputes.signedOut");
  }

  if (status === 429) {
    return rateLimitSentence(payload);
  }

  if (status === 403) {
    return getMessage("device.proofRequired");
  }

  switch (refusalOf(payload).rule) {
    case "dispute_pack_missing":
      return getMessage("disputes.submissionRulePackMissing");
    case "dispute_review_required":
      return getMessage("disputes.submissionRuleReviewRequired");
    case "dispute_submission_exists":
      return getMessage("disputes.submissionRuleExists");
    case "dispute_submission_unsupported":
      return getMessage("disputes.submissionRuleUnsupported");
    case "dispute_submission_declined":
      return getMessage("disputes.submissionRuleDeclined");
    case "dispute_submission_unanswered":
      return getMessage("disputes.submissionRuleUnanswered");
    case "dispute_provider_missing":
      return getMessage("disputes.submissionRuleProviderMissing");
    case "dispute_already_submitted":
      return getMessage("disputes.submissionRuleAlready");
    case "dispute_resolved":
      return getMessage("disputes.submissionRuleDecided");
    case "dispute_not_found":
      return getMessage("disputes.submissionRuleNotFound");
    case "dispute_moved":
      return getMessage("disputes.reviewMoved");
    case "csrf_token_invalid":
      return getMessage("disputes.deviceRequiredRefusal");
    default:
      return getMessage("disputes.submissionFailed");
  }
}

/** The one act in flight, so every control can be disabled while it runs. */
type Pending = null | "review" | "submit";

/** The one verb this panel sends. Named so the gate's mutation count sees two calls and not three. */
type MutationVerb = "POST";

const panelClasses = "flex flex-col gap-4 border-t border-border pt-4";

const formClasses = "flex flex-col gap-2";

const headingClasses = "text-sm font-semibold text-foreground";

const helpClasses = "text-xs text-muted-foreground";

const labelClasses = "text-xs font-semibold uppercase tracking-wide text-muted-foreground";

const fieldClasses =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary";

const actionsClasses = "flex flex-wrap items-center gap-2";

const primaryButtonClasses =
  "inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60";

const buttonClasses =
  "inline-flex items-center justify-center rounded-lg border border-border bg-background px-3 py-1.5 text-sm font-semibold text-foreground transition-colors hover:bg-muted/60 disabled:opacity-60";

const messageClasses = "text-sm";

export function DisputeReviewPanel({
  disputeId,
  version,
  mayReview,
  maySubmit,
  providerChannel,
  providerKey,
  submissionSent,
}: {
  readonly disputeId: string;
  readonly version: number;
  readonly mayReview: boolean;
  readonly maySubmit: boolean;
  readonly providerChannel: boolean;
  readonly providerKey: string | null;
  readonly submissionSent: boolean;
}): ReactNode {
  const router = useRouter();
  const [pending, setPending] = useState<Pending>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState<boolean>(false);
  const [note, setNote] = useState<string>("");
  const [channel, setChannel] = useState<DisputeSubmissionChannel>("recorded");
  const [reference, setReference] = useState<string>("");
  const [submissionNote, setSubmissionNote] = useState<string>("");

  const busy = pending !== null;

  /** One request, one answer, one sentence, and a re-read of the page whatever happened. */
  async function send(input: {
    readonly path: string;
    readonly method: MutationVerb;
    readonly headers: Readonly<Record<string, string>>;
    readonly payload: string;
    readonly what: Pending;
    readonly done: string;
    readonly doneOf?: (body: unknown) => string;
  }): Promise<void> {
    setPending(input.what);
    setMessage(null);
    setIsError(false);

    try {
      const proof = await deviceProofHeaders("POST", input.path, input.payload);

      if (proof === null) {
        setPending(null);
        setMessage(getMessage("device.proofRequired"));
        setIsError(true);

        return;
      }

      const response = await fetch(input.path, {
        method: input.method,
        headers: { "content-type": "application/json", ...proof, ...input.headers },
        body: input.payload,
        credentials: "same-origin",
        cache: "no-store",
      });

      setPending(null);

      if (!response.ok) {
        const refusal: unknown = await response.json().catch(() => null);

        setMessage(refusalTextOf(response.status, refusal));
        setIsError(true);

        return;
      }

      const body: unknown = await response.json().catch(() => null);

      setMessage(input.doneOf === undefined ? input.done : input.doneOf(body));
      setIsError(false);
      router.refresh();
    } catch {
      setPending(null);
      setMessage(getMessage("disputes.submissionFailed"));
      setIsError(true);
    }
  }

  /** Record one decision on this pack. */
  async function decide(decision: DisputeReviewDecision): Promise<void> {
    if (note.trim().length === 0) {
      setMessage(getMessage("disputes.reviewFailed"));
      setIsError(true);

      return;
    }

    await send({
      path: `/api/office/disputes/${encodeURIComponent(disputeId)}/review`,
      method: "POST",
      headers: { ...(await csrfHeaders()) },
      payload: JSON.stringify({ decision, note: note.trim() }),
      what: "review",
      done: decision === "approved" ? getMessage("disputes.reviewApproved") : getMessage("disputes.reviewDeclined"),
    });
  }

  /** Send the approved pack, or record a submission the desk made by hand. */
  async function submit(): Promise<void> {
    const payload =
      channel === "provider"
        ? { channel, version }
        : {
            channel,
            processor_reference: reference.trim(),
            ...(submissionNote.trim().length === 0 ? {} : { note: submissionNote.trim() }),
            version,
          };

    await send({
      path: `/api/office/disputes/${encodeURIComponent(disputeId)}/submit`,
      method: "POST",
      headers: { ...(await csrfHeaders()) },
      payload: JSON.stringify(payload),
      what: "submit",
      done: getMessage("disputes.submissionSentGeneric"),
      doneOf: (body: unknown): string => {
        const reference_ =
          typeof body === "object" && body !== null
            ? (body as { readonly processorReference?: unknown }).processorReference
            : null;
        const outcome =
          typeof body === "object" && body !== null
            ? (body as { readonly outcome?: unknown }).outcome
            : null;

        if (typeof reference_ !== "string") {
          return getMessage("disputes.submissionSentGeneric");
        }

        return formatMessage(
          outcome === "already_sent" ? "disputes.submissionAlreadyDone" : "disputes.submissionDone",
          { reference: reference_ },
        );
      },
    });
  }

  return (
    <section aria-labelledby="dispute-review-panel-heading" className={panelClasses}>
      <h2 className={headingClasses} id="dispute-review-panel-heading">
        {getMessage("disputes.reviewDecideTitle")}
      </h2>

      {mayReview ? (
        <form
          className={formClasses}
          onSubmit={(event: FormEvent<HTMLFormElement>): void => {
            event.preventDefault();
          }}
        >
          <label className={labelClasses} htmlFor="review-note">
            {getMessage("disputes.reviewNoteLabel")}
          </label>
          <textarea
            className={fieldClasses}
            disabled={busy}
            id="review-note"
            maxLength={DISPUTE_REVIEW_NOTE_MAXIMUM_LENGTH}
            onChange={(event): void => {
              setNote(event.target.value);
            }}
            placeholder={getMessage("disputes.reviewNotePlaceholder")}
            rows={3}
            value={note}
          />
          <p className={helpClasses}>{getMessage("disputes.reviewNoteHelp")}</p>

          <div className={actionsClasses}>
            <button
              className={primaryButtonClasses}
              disabled={busy}
              onClick={(): void => {
                void decide("approved");
              }}
              type="button"
            >
              {pending === "review" ? getMessage("disputes.reviewSaving") : getMessage("disputes.reviewApprove")}
            </button>
            <button
              className={buttonClasses}
              disabled={busy}
              onClick={(): void => {
                void decide("declined");
              }}
              type="button"
            >
              {getMessage("disputes.reviewDecline")}
            </button>
          </div>
        </form>
      ) : (
        <p className={helpClasses}>{getMessage("disputes.reviewRoleNote")}</p>
      )}

      <form
        className={formClasses}
        onSubmit={(event: FormEvent<HTMLFormElement>): void => {
          event.preventDefault();
          void submit();
        }}
      >
        <h3 className={headingClasses}>{getMessage("disputes.submissionTitle")}</h3>
        <p className={helpClasses}>{getMessage("disputes.submissionHelp")}</p>

        <label className={labelClasses} htmlFor="submission-channel">
          {getMessage("disputes.submissionChannelLabel")}
        </label>
        <select
          className={fieldClasses}
          disabled={busy || !maySubmit}
          id="submission-channel"
          onChange={(event): void => {
            const value = event.target.value;

            if (value === "provider" || value === "recorded") {
              setChannel(value);
            }
          }}
          value={channel}
        >
          <option disabled={!providerChannel} value="provider">
            {getMessage("disputes.submissionChannelProvider")}
          </option>
          <option value="recorded">{getMessage("disputes.submissionChannelRecorded")}</option>
        </select>

        {providerChannel || channel === "recorded" ? null : (
          <p className={helpClasses}>
            {`${getMessage("disputes.submissionProviderUnsupported")}${
              providerKey === null ? "" : ` (${providerKey})`
            }`}
          </p>
        )}

        {channel === "recorded" ? (
          <>
            <label className={labelClasses} htmlFor="submission-reference">
              {getMessage("disputes.submissionReferenceLabel")}
            </label>
            <input
              className={fieldClasses}
              disabled={busy || !maySubmit}
              id="submission-reference"
              maxLength={DISPUTE_SUBMISSION_REFERENCE_MAXIMUM_LENGTH}
              onChange={(event): void => {
                setReference(event.target.value);
              }}
              placeholder={getMessage("disputes.submissionReferencePlaceholder")}
              type="text"
              value={reference}
            />
            <p className={helpClasses}>{getMessage("disputes.submissionReferenceHelp")}</p>

            <label className={labelClasses} htmlFor="submission-note">
              {getMessage("disputes.submissionNoteLabel")}
            </label>
            <input
              className={fieldClasses}
              disabled={busy || !maySubmit}
              id="submission-note"
              maxLength={DISPUTE_REVIEW_NOTE_MAXIMUM_LENGTH}
              onChange={(event): void => {
                setSubmissionNote(event.target.value);
              }}
              placeholder={getMessage("disputes.submissionNotePlaceholder")}
              type="text"
              value={submissionNote}
            />
          </>
        ) : null}

        <p className={helpClasses}>
          {maySubmit ? getMessage("disputes.reviewLatestApproved") : getMessage("disputes.reviewAwaitingDecision")}
        </p>

        <div className={actionsClasses}>
          <button
            className={primaryButtonClasses}
            disabled={busy || !maySubmit || submissionSent || (channel === "recorded" && reference.trim().length === 0)}
            type="submit"
          >
            {pending === "submit"
              ? getMessage("disputes.submissionSending")
              : channel === "provider"
                ? getMessage("disputes.submissionButton")
                : getMessage("disputes.submissionRecordingButton")}
          </button>
        </div>
      </form>

      {message === null ? null : (
        <p className={isError ? "text-sm text-destructive" : messageClasses} role={isError ? "alert" : "status"}>
          {message}
        </p>
      )}
    </section>
  );
}
