// path: app/(admin)/office/refunds/refund-decision-form.tsx
"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { deviceProofHeaders } from "@/lib/auth/device-proof-store";
import { rateLimitSentence } from "@/lib/auth/refusal-message";
import { getMessage } from "@/lib/i18n/messages";
import { csrfHeaders } from "@/lib/security/csrf-client";

/**
 * The finance desk's two buttons, on the refund they belong to.
 *
 * ## Why a device has to sign this
 *
 * An approval authorises money. The browser therefore signs the exact bytes of the decision with the
 * account's enrolled device key, and the route refuses a request whose proof is missing, stale or signed
 * over something else - before the parse, so an altered body is refused as a proof failure rather than as a
 * schema problem the officer would have to read. That is the same guard the section 2 approval chain puts on
 * its signatures, applied to the one act here that moves money.
 *
 * ## What the browser is trusted with
 *
 * The refund's id and the word the officer pressed. The note travels with them, and the service re-checks the
 * role, the four eyes, the pending status and the payment's headroom. A doctored request meets a refusal, and
 * this component's only job is to turn that refusal into a sentence somebody can act on.
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

/** The sentence for one refusal: the service's rules, each with a sentence an officer can act on. */
function messageForStatus(status: number, payload: unknown, decision: "approve" | "reject"): string {
  if (status === 429) {
    return rateLimitSentence(payload);
  }

  if (status === 401) {
    return getMessage("refunds.signedOut");
  }

  if (status === 403) {
    // The device proof and the role are both refusals without a field, and both answer 403: the proof is the
    // narrow one, and a session that holds no desk role would not have been offered these buttons at all.
    return getMessage("refunds.deviceRequired");
  }

  const { rule } = refusalOf(payload);

  switch (rule) {
    case "refund_not_pending":
      return getMessage("refunds.refundNotPending");
    case "refund_self_decision":
      return getMessage("refunds.selfDecision");
    case "refund_moved":
      return getMessage("refunds.refundMoved");
    case "exceeds_refundable":
      return getMessage("refunds.exceedsRefundable");
    case "nothing_to_refund":
      return getMessage("refunds.nothingToRefund");
    case "refund_not_found":
      return getMessage("refunds.refundNotFound");
    case "note_invalid":
      return getMessage("refunds.reasonInvalid");
    case "refund_guard":
      return getMessage("refunds.refundGuard");
    default:
      break;
  }

  if (status === 409) {
    return getMessage("refunds.refundMoved");
  }

  if (status >= 200 && status < 300) {
    return decision === "approve" ? getMessage("refunds.approvedDone") : getMessage("refunds.rejectedDone");
  }

  return getMessage("refunds.failed");
}

const formClasses = "flex flex-col gap-2 border-t border-border pt-3";

const fieldClasses =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary";

const labelClasses = "block text-sm font-medium text-foreground";

const hintClasses = "text-xs text-muted-foreground";

const actionsClasses = "flex flex-wrap items-center gap-2";

const acceptClasses =
  "inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60";

const rejectClasses =
  "inline-flex items-center justify-center rounded-lg border border-border bg-background px-4 py-2 text-sm font-semibold text-foreground transition-colors hover:bg-muted/60 disabled:opacity-60";

export function RefundDecisionForm({ refundId }: { readonly refundId: string }): ReactNode {
  const router = useRouter();
  const [note, setNote] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);
  const [message, setMessage] = useState<string | null>(null);

  async function decide(decision: "approve" | "reject"): Promise<void> {
    setBusy(true);
    setMessage(null);

    try {
      const payload = JSON.stringify({
        decision,
        ...(note.trim().length === 0 ? {} : { note }),
      });
      const path = `/api/office/refunds/${encodeURIComponent(refundId)}/decision`;
      const proof = await deviceProofHeaders("POST", path, payload);

      if (proof === null) {
        setMessage(getMessage("device.proofRequired"));
        setBusy(false);

        return;
      }

      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json", ...proof, ...(await csrfHeaders()) },
        body: payload,
        credentials: "same-origin",
        cache: "no-store",
      });

      if (!response.ok) {
        const refusal: unknown = await response.json().catch(() => null);

        setMessage(messageForStatus(response.status, refusal, decision));
        setBusy(false);

        return;
      }

      setBusy(false);
      setNote("");
      setMessage(decision === "approve" ? getMessage("refunds.approvedDone") : getMessage("refunds.rejectedDone"));
      router.refresh();
    } catch {
      setBusy(false);
      setMessage(getMessage("refunds.failed"));
    }
  }

  return (
    <form
      className={formClasses}
      onSubmit={(event: FormEvent<HTMLFormElement>): void => {
        event.preventDefault();
      }}
    >
      <label className={labelClasses}>
        {getMessage("refunds.decisionNoteLabel")}
        <textarea
          className={fieldClasses}
          maxLength={500}
          name="note"
          onChange={(event): void => {
            setNote(event.target.value);
          }}
          rows={2}
          value={note}
        />
      </label>
      <p className={hintClasses}>{getMessage("refunds.decisionNoteHelp")}</p>

      <div className={actionsClasses}>
        <button
          className={acceptClasses}
          disabled={busy}
          onClick={(): void => {
            void decide("approve");
          }}
          type="button"
        >
          {busy ? getMessage("refunds.approving") : getMessage("refunds.approve")}
        </button>
        <button
          className={rejectClasses}
          disabled={busy}
          onClick={(): void => {
            void decide("reject");
          }}
          type="button"
        >
          {getMessage("refunds.reject")}
        </button>
      </div>

      {message === null ? null : (
        <p className="text-sm" role="status">
          {message}
        </p>
      )}
    </form>
  );
}
