// path: app/(admin)/ceo/approval-decision-form.tsx
"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import type { ApprovalStage } from "@/lib/approvals/registry";
import { deviceProofHeaders } from "@/lib/auth/device-proof-store";
import { rateLimitSentence } from "@/lib/auth/refusal-message";
import { getMessage } from "@/lib/i18n/messages";
import { csrfHeaders } from "@/lib/security/csrf-client";

/**
 * The two signatures of the section 2 chain, on the row they belong to.
 *
 * ## Why the button says what the desk means
 *
 * The same component serves both desks because the act is the same - approve or reject - and only the
 * word changes: at the first desk an approval is "Approve" and hands the request on, at the last desk it
 * is "Confirm" and makes the action allowed. The page decides which rows carry a form, using the same
 * `signatureProblemOf` the service refuses with, so a button is never offered for a signature the
 * platform would not accept.
 *
 * ## What the browser is trusted with
 *
 * The row's id and nothing else. The note travels with it, the device signs the exact bytes, and the
 * service re-checks the desk, the two people rules, the freshness of the second factor, the clock and
 * the note's length. A doctored request therefore meets a refusal, and this component's only job is to
 * turn that refusal into a sentence somebody can act on.
 */

/** The rule and field a refusal named, or nulls when the envelope carries neither. */
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

function messageForStatus(status: number, payload: unknown, decision: "approve" | "reject"): string {
  if (status === 429) {
    return rateLimitSentence(payload);
  }

  if (status === 401) {
    return getMessage("officeApprovals.signedOut");
  }

  if (status === 403) {
    return getMessage("officeApprovals.reauthRequired");
  }

  const { rule } = refusalOf(payload);

  if (rule === "not_pending") {
    return getMessage("officeApprovals.notPending");
  }

  if (rule === "expired") {
    return getMessage("officeApprovals.expiredRequest");
  }

  if (rule === "requester_signature") {
    return getMessage("officeApprovals.requesterSignature");
  }

  if (rule === "signer_signature") {
    return getMessage("officeApprovals.signerSignature");
  }

  if (rule === "invalid_length") {
    return getMessage("officeApprovals.rejectNeedsNote");
  }

  if (rule === "role") {
    return getMessage("officeApprovals.roleCannotSign");
  }

  if (status === 409) {
    return getMessage("officeApprovals.conflict");
  }

  if (status >= 200 && status < 300) {
    return decision === "approve"
      ? getMessage("officeApprovals.approvedDone")
      : getMessage("officeApprovals.rejectedDone");
  }

  return getMessage("officeApprovals.failed");
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

export function ApprovalDecisionForm({
  approvalId,
  stage,
}: {
  readonly approvalId: string;
  readonly stage: ApprovalStage;
}): ReactNode {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function sign(decision: "approve" | "reject"): Promise<void> {
    setBusy(true);
    setMessage(null);

    try {
      const payload = JSON.stringify({
        action: "decide",
        approvalId,
        decision,
        ...(note.trim().length === 0 ? {} : { note }),
      });

      // A signature says that money may move or a country may switch, so the browser signs it (STEP 050).
      const proof = await deviceProofHeaders("POST", "/api/office/approvals", payload);

      if (proof === null) {
        setMessage(getMessage("device.proofRequired"));
        setBusy(false);

        return;
      }

      const response = await fetch("/api/office/approvals", {
        method: "POST",
        headers: { "content-type": "application/json", ...proof, ...(await csrfHeaders()) },
        body: payload,
      });

      if (!response.ok) {
        const refusal: unknown = await response.json().catch(() => null);

        setMessage(messageForStatus(response.status, refusal, decision));
        setBusy(false);

        return;
      }

      setBusy(false);
      setNote("");
      setMessage(
        stage === "ceo"
          ? decision === "approve"
            ? getMessage("officeApprovals.approvedDone")
            : getMessage("officeApprovals.rejectedDone")
          : decision === "approve"
            ? getMessage("officeApprovals.confirmedDone")
            : getMessage("officeApprovals.rejectedDone"),
      );
      router.refresh();
    } catch {
      setBusy(false);
      setMessage(getMessage("officeApprovals.failed"));
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
        {getMessage("officeApprovals.decisionNoteLabel")}
        <textarea
          className={fieldClasses}
          maxLength={1000}
          name="note"
          onChange={(event): void => {
            setNote(event.target.value);
          }}
          rows={2}
          value={note}
        />
      </label>
      <p className={hintClasses}>{getMessage("officeApprovals.decisionNoteHint")}</p>

      <div className={actionsClasses}>
        <button
          className={acceptClasses}
          disabled={busy}
          onClick={(): void => {
            void sign("approve");
          }}
          type="button"
        >
          {busy
            ? getMessage("officeApprovals.decisionBusy")
            : stage === "ceo"
              ? getMessage("officeApprovals.approveLabel")
              : getMessage("officeApprovals.confirmLabel")}
        </button>
        <button
          className={rejectClasses}
          disabled={busy}
          onClick={(): void => {
            void sign("reject");
          }}
          type="button"
        >
          {getMessage("officeApprovals.rejectLabel")}
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
