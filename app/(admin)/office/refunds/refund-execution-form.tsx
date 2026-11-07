// path: app/(admin)/office/refunds/refund-execution-form.tsx
"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { deviceProofHeaders } from "@/lib/auth/device-proof-store";
import { rateLimitSentence } from "@/lib/auth/refusal-message";
import { getMessage } from "@/lib/i18n/messages";
import { csrfHeaders } from "@/lib/security/csrf-client";

/**
 * The one button an approved refund carries: send it back through the provider.
 *
 * ## Why it is a second act, and a second signature
 *
 * Approving a refund promises the money; sending it moves the money. The route behind this button therefore
 * asks for the same device proof an approval does, over these exact bytes, and applies the desk role, the
 * `approved` status and the originating provider itself. This component sends an empty body - there is nothing
 * for a browser to choose - and turns the answer, or the refusal, into a sentence.
 *
 * ## Why the four outcomes read differently
 *
 * The provider can accept, refuse, accept and settle later, or not answer at all. This component has one button
 * and four sentences because a desk that reads "failed" for a call that timed out would retry and could pay
 * twice: `unanswered` says the money may or may not have moved, and offers no retry.
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

/** The sentence for one refusal: the execution's own rules, each with something an officer can do about it. */
function messageForStatus(status: number, payload: unknown): string {
  if (status === 429) {
    return rateLimitSentence(payload);
  }

  if (status === 401) {
    return getMessage("refunds.signedOut");
  }

  if (status === 403) {
    return getMessage("refunds.deviceRequired");
  }

  const { rule } = refusalOf(payload);

  switch (rule) {
    case "refund_not_executable":
      return getMessage("refunds.notExecutable");
    case "refund_provider_unsupported":
      return getMessage("refunds.providerUnsupported");
    case "refund_provider_not_found":
      return getMessage("refunds.providerUnsupported");
    case "refund_provider_reference_missing":
      return getMessage("refunds.referenceMissing");
    case "refund_amount_unrepresentable":
      return getMessage("refunds.amountUnrepresentable");
    case "refund_provider_key_missing":
      return getMessage("refunds.providerKeyMissing");
    case "refund_provider_refused":
      return getMessage("refunds.providerRefused");
    case "refund_not_found":
      return getMessage("refunds.refundNotFound");
    case "refund_moved":
      return getMessage("refunds.refundMoved");
    default:
      break;
  }

  if (status === 409) {
    return getMessage("refunds.notExecutable");
  }

  return getMessage("refunds.failed");
}

/** The sentence for a `200`, which is four different facts. */
function outcomeMessageOf(payload: unknown): string {
  const outcome =
    typeof payload === "object" && payload !== null && "outcome" in payload
      ? (payload as { readonly outcome?: unknown }).outcome
      : null;

  switch (outcome) {
    case "succeeded":
      return getMessage("refunds.executedDone");
    case "pending":
      return getMessage("refunds.executionPending");
    case "unanswered":
      return getMessage("refunds.executionUnanswered");
    case "declined":
      return getMessage("refunds.executionDeclined");
    case "not_sent":
      return getMessage("refunds.executionNotSent");
    default:
      return getMessage("refunds.failed");
  }
}

const formClasses = "flex flex-col gap-2 border-t border-border pt-3";

const actionsClasses = "flex flex-wrap items-center gap-2";

const sendClasses =
  "inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60";

const hintClasses = "text-xs text-muted-foreground";

export function RefundExecutionForm({ refundId }: { readonly refundId: string }): ReactNode {
  const router = useRouter();
  const [busy, setBusy] = useState<boolean>(false);
  const [message, setMessage] = useState<string | null>(null);

  async function execute(): Promise<void> {
    setBusy(true);
    setMessage(null);

    try {
      const payload = "{}";
      const path = `/api/office/refunds/${encodeURIComponent(refundId)}/execute`;
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

        setMessage(messageForStatus(response.status, refusal));
        setBusy(false);

        return;
      }

      const body: unknown = await response.json().catch(() => null);

      setBusy(false);
      setMessage(outcomeMessageOf(body));
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
      <div className={actionsClasses}>
        <button
          className={sendClasses}
          disabled={busy}
          onClick={(): void => {
            void execute();
          }}
          type="button"
        >
          {busy ? getMessage("refunds.executing") : getMessage("refunds.execute")}
        </button>
        <span className={hintClasses}>{getMessage("refunds.executeHelp")}</span>
      </div>

      {message === null ? null : (
        <p className="text-sm" role="status">
          {message}
        </p>
      )}
    </form>
  );
}
