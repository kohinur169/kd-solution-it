// path: app/(admin)/office/disputes/deadline-extension-form.tsx
"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { deviceProofHeaders } from "@/lib/auth/device-proof-store";
import { rateLimitSentence } from "@/lib/auth/refusal-message";
import { getMessage } from "@/lib/i18n/messages";
import { csrfHeaders } from "@/lib/security/csrf-client";
import { DISPUTE_DEFAULT_WINDOW_HOURS, DISPUTE_EXTENDED_WINDOW_HOURS } from "@/services/disputes/dispute-fields";

/**
 * Section 19's extension, on the dispute it belongs to.
 *
 * ## Why the device signs this one
 *
 * The act changes the time *another person* has to answer in. The browser therefore signs the exact bytes of
 * the body with the account's enrolled device key, and the route refuses a proof that is missing, stale or
 * signed over something else before it parses anything - the same guard the refund desk's decision carries,
 * applied to the one act here that moves a deadline.
 *
 * ## What the button promises
 *
 * Only that it asked. The role (`super_admin`), the satisfied second factor, the direction (24 to 48), the
 * undecided state and the still-open window are all decided by `extendDisputeDeadline` against the row, so a
 * button rendered for the wrong account is a refusal and not a widening. That is why the panel is offered only
 * on a row at 24 hours, and why the sentence after a refusal is the service's rule rather than this file's
 * guess.
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

/** The sentence for one refusal. */
function refusalTextOf(status: number, payload: unknown): string {
  if (status === 401) {
    return getMessage("disputes.signedOut");
  }

  if (status === 429) {
    return rateLimitSentence(payload);
  }

  if (status === 403) {
    // The device proof, the role and a missing second factor all answer 403, and all three mean the same thing
    // to the officer reading it: this account may not move this deadline from this browser.
    return getMessage("disputes.deadlineExtensionRoleNote");
  }

  const { rule } = refusalOf(payload);

  switch (rule) {
    case "dispute_deadline_passed":
      return getMessage("disputes.deadlinePassedRefusal");
    case "dispute_submitted":
      return getMessage("disputes.submittedRefusal");
    case "dispute_deadline_not_extendable":
      return getMessage("disputes.deadlineNotExtendableRefusal");
    case "dispute_window_invalid":
      return getMessage("disputes.windowInvalidRefusal");
    case "dispute_moved":
      return getMessage("disputes.responseMovedError");
    case "dispute_not_found":
      return getMessage("disputes.responseNotFoundError");
    case "csrf_token_invalid":
      return getMessage("disputes.deviceRequiredRefusal");
    default:
      break;
  }

  return getMessage("disputes.failed");
}

const panelClasses = "flex flex-col gap-2 border-t border-border pt-3";

const headingClasses = "text-sm font-semibold text-foreground";

const helpClasses = "text-xs text-muted-foreground";

const actionsClasses = "flex flex-wrap items-center gap-2";

const buttonClasses =
  "inline-flex items-center justify-center rounded-lg border border-border bg-background px-3 py-1.5 text-sm font-semibold text-foreground transition-colors hover:bg-muted/60 disabled:opacity-60";

const messageClasses = "text-sm";

export function DisputeDeadlineExtensionForm({
  disputeId,
  currentWindowHours,
}: {
  readonly disputeId: string;
  readonly currentWindowHours: number;
}): ReactNode {
  const router = useRouter();
  const [busy, setBusy] = useState<boolean>(false);
  const [message, setMessage] = useState<string | null>(null);

  async function extend(): Promise<void> {
    setBusy(true);
    setMessage(null);

    try {
      const payload = JSON.stringify({ response_window_hours: DISPUTE_EXTENDED_WINDOW_HOURS });
      const path = `/api/office/disputes/${encodeURIComponent(disputeId)}/deadline`;
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

      setBusy(false);

      if (!response.ok) {
        const refusal: unknown = await response.json().catch(() => null);

        setMessage(refusalTextOf(response.status, refusal));

        return;
      }

      setMessage(getMessage("disputes.deadlineExtensionDone"));
      router.refresh();
    } catch {
      setBusy(false);
      setMessage(getMessage("disputes.failed"));
    }
  }

  return (
    <div className={panelClasses}>
      <h3 className={headingClasses}>{getMessage("disputes.deadlineExtensionTitle")}</h3>
      <p className={helpClasses}>{getMessage("disputes.deadlineExtensionHelp")}</p>
      <p className={helpClasses}>{getMessage("disputes.deadlineExtensionDeviceNote")}</p>

      <div className={actionsClasses}>
        <button
          className={buttonClasses}
          disabled={busy || currentWindowHours !== DISPUTE_DEFAULT_WINDOW_HOURS}
          onClick={(): void => {
            void extend();
          }}
          type="button"
        >
          {busy ? `${getMessage("disputes.deadlineExtensionBusy")}…` : getMessage("disputes.deadlineExtensionButton")}
        </button>
      </div>

      {message === null ? null : (
        <p className={messageClasses} role="status">
          {message}
        </p>
      )}
    </div>
  );
}
