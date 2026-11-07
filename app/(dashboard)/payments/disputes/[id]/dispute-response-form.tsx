// path: app/(dashboard)/payments/disputes/[id]/dispute-response-form.tsx
"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { rateLimitSentence } from "@/lib/auth/refusal-message";
import { formatMessage, getMessage } from "@/lib/i18n/messages";
import { csrfHeaders } from "@/lib/security/csrf-client";
import { DISPUTE_RESPONSE_MAXIMUM_LENGTH } from "@/services/disputes/dispute-fields";

/**
 * The merchant's side of a dispute, as a form.
 *
 * ## What the browser is trusted with, and what it is not
 *
 * It is trusted with the words and the dispute's id, and with nothing else. The window, the state and the
 * tenant are re-read by `saveDisputeResponse` on the row, so a page left open past the deadline, a tab from a
 * signed-out session or an id pasted from another merchant's URL all meet the same three refusals the service
 * owns. This component's job is to send the text once, with a token, and to turn the refusal that comes back
 * into a sentence a merchant can act on.
 *
 **The character count is the browser's copy of `disputes_response_check`, and the server re-checks it:** a
 * `maxLength` on a textarea is a courtesy, not a bound. What the count does give the merchant is the number
 * before they lose an answer, which is why it is printed rather than a hard stop.
 *
 * ## Why saving is not submitting
 *
 * Saving here writes `response_text` and `response_saved_at`; it does not send anything to the processor. The
 * pack and its submission are STEP 198's, and until then the merchant may edit, which is exactly what
 * `0124`'s `disputes_guard_response` guarantees stops on the day `submitted_at` is set.
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

/** The sentence for one refusal: one rule, one sentence, and a generic line for anything unforeseen. */
function refusalTextOf(status: number, payload: unknown): string {
  if (status === 401) {
    return getMessage("disputes.signedOut");
  }

  if (status === 429) {
    return rateLimitSentence(payload);
  }

  const { rule } = refusalOf(payload);

  switch (rule) {
    case "dispute_response_invalid":
    case "invalid_format":
      return getMessage("disputes.responseInvalidError");
    case "dispute_deadline_passed":
      return getMessage("disputes.responseDeadlineError");
    case "dispute_submitted":
      return getMessage("disputes.submittedRefusal");
    case "dispute_resolved":
      return getMessage("disputes.resolvedRefusal");
    case "dispute_moved":
      return getMessage("disputes.responseMovedError");
    case "dispute_not_found":
      return getMessage("disputes.responseNotFoundError");
    default:
      break;
  }

  if (status === 403) {
    return getMessage("disputes.roleRefusedBody");
  }

  return getMessage("disputes.failed");
}

const formClasses = "flex flex-col gap-3";

const labelClasses = "block text-sm font-medium text-foreground";

const fieldClasses =
  "min-h-40 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary";

const hintClasses = "text-xs text-muted-foreground";

const counterClasses = "text-xs tabular-nums text-muted-foreground";

const actionsClasses = "flex flex-wrap items-center gap-3";

const buttonClasses =
  "inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60";

const messageClasses = "text-sm";

export function DisputeResponseForm({
  disputeId,
  initialText,
  editable,
  savedAt,
}: {
  readonly disputeId: string;
  readonly initialText: string;
  readonly editable: boolean;
  readonly savedAt: string | null;
}): ReactNode {
  const router = useRouter();
  const [text, setText] = useState<string>(initialText);
  const [busy, setBusy] = useState<boolean>(false);
  const [message, setMessage] = useState<string | null>(null);
  const [savedInstant, setSavedInstant] = useState<string | null>(savedAt);

  async function save(): Promise<void> {
    if (text.trim().length === 0) {
      setMessage(getMessage("disputes.responseEmptyError"));

      return;
    }

    if (text.length > DISPUTE_RESPONSE_MAXIMUM_LENGTH) {
      setMessage(getMessage("disputes.responseTooLongError"));

      return;
    }

    setBusy(true);
    setMessage(null);

    try {
      const response = await fetch(`/api/payments/disputes/${encodeURIComponent(disputeId)}/response`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(await csrfHeaders()) },
        body: JSON.stringify({ response_text: text }),
        credentials: "same-origin",
        cache: "no-store",
      });

      if (!response.ok) {
        const refusal: unknown = await response.json().catch(() => null);

        setMessage(refusalTextOf(response.status, refusal));
        setBusy(false);

        return;
      }

      const saved = (await response.json().catch(() => null)) as { readonly responseSavedAt?: unknown } | null;

      setBusy(false);
      setSavedInstant(typeof saved?.responseSavedAt === "string" ? saved.responseSavedAt : null);
      setMessage(getMessage("disputes.responseSavedDone"));
      // The row is the truth, so the page is re-read rather than patched: the deadline may have moved under
      // this tab, and the merchant should see the state the database now holds.
      router.refresh();
    } catch {
      setBusy(false);
      setMessage(getMessage("disputes.failed"));
    }
  }

  return (
    <form
      className={formClasses}
      onSubmit={(event: FormEvent<HTMLFormElement>): void => {
        event.preventDefault();
        void save();
      }}
    >
      <label className={labelClasses} htmlFor="dispute-response-text">
        {getMessage("disputes.responseLabel")}
      </label>
      <textarea
        className={fieldClasses}
        disabled={!editable}
        id="dispute-response-text"
        maxLength={DISPUTE_RESPONSE_MAXIMUM_LENGTH}
        name="response_text"
        onChange={(event): void => {
          setText(event.target.value);
        }}
        placeholder={getMessage("disputes.responsePlaceholder")}
        rows={8}
        value={text}
      />
      <p className={hintClasses}>{getMessage("disputes.responseHelp")}</p>
      <p className={counterClasses}>
        {formatMessage("disputes.responseCharacterCount", {
          used: String(text.length),
          limit: String(DISPUTE_RESPONSE_MAXIMUM_LENGTH),
        })}
      </p>

      {savedInstant === null ? null : (
        <p className={hintClasses}>
          {formatMessage("disputes.responseSavedAt", {
            instant: `${new Date(savedInstant).toISOString().slice(0, 16).replace("T", " ")} UTC`,
          })}
        </p>
      )}

      <div className={actionsClasses}>
        <button className={buttonClasses} disabled={busy || !editable} type="submit">
          {busy ? `${getMessage("disputes.responseSaving")}…` : getMessage("disputes.responseSave")}
        </button>
      </div>

      {message === null ? null : (
        <p className={messageClasses} role="status">
          {message}
        </p>
      )}
    </form>
  );
}
