// path: app/(admin)/office/disputes/warning-run-panel.tsx
"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { deviceProofHeaders } from "@/lib/auth/device-proof-store";
import { rateLimitSentence } from "@/lib/auth/refusal-message";
import { formatMessage, getMessage } from "@/lib/i18n/messages";
import { csrfHeaders } from "@/lib/security/csrf-client";

/**
 * Section 19's two warnings, run by hand.
 *
 * ## Why the button exists
 *
 * `dispute.deadline_warnings` is the clock: a deployment with a scheduler sends the warning at the start of a
 * window and the one at its middle without anybody asking. A deployment without one still owes the merchant
 * those two emails, and this is the act that pays them - the same shape the compliance calendar's "run the
 * check" has, for the same reason.
 *
 * ## What the browser is trusted with
 *
 * Nothing it sends decides anything. The body is empty, the sweep decides which stages are due from the rows,
 * and `0125`'s unique keys refuse a second warning for a stage already sent - so pressing the button twice
 * sends nothing twice. The device proof exists because this act mails every merchant at once: it is
 * correspondence at platform scale, and it is signed over the exact bytes for the same reason a refund
 * decision is.
 *
 * ## What it prints
 *
 * Three numbers an officer can act on: how many were handed over, how many were already sent (a duplicate is
 * a healthy answer, not an error), and how many were due and could not be queued because no sending method or
 * no owner address exists - which is a configuration problem the office has to fix, so it is said rather than
 * swallowed.
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
    // to the officer: this account may not mail the platform's merchants from this browser.
    return getMessage("disputes.warningRunRoleNote");
  }

  const { rule } = refusalOf(payload);

  switch (rule) {
    case "csrf_token_invalid":
      return getMessage("disputes.deviceRequiredRefusal");
    case "invalid_format":
      return getMessage("disputes.responseInvalidError");
    default:
      break;
  }

  return getMessage("disputes.failed");
}

/** The sweep's answer, as far as this panel prints it. */
interface SweepAnswer {
  readonly due?: unknown;
  readonly sent?: unknown;
  readonly skipped?: { readonly [key: string]: unknown };
}

function countOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

const panelClasses =
  "flex flex-col gap-2 rounded-lg border border-border bg-surface p-4 text-foreground shadow-card sm:p-5";

const headingClasses = "text-sm font-semibold text-foreground";

const helpClasses = "text-xs text-muted-foreground";

const buttonClasses =
  "inline-flex w-fit items-center justify-center rounded-lg border border-border bg-background px-3 py-1.5 text-sm font-semibold text-foreground transition-colors hover:bg-muted/60 disabled:opacity-60";

const messageClasses = "text-sm";

export function DisputeWarningRunPanel(): ReactNode {
  const router = useRouter();
  const [busy, setBusy] = useState<boolean>(false);
  const [message, setMessage] = useState<string | null>(null);

  async function run(): Promise<void> {
    setBusy(true);
    setMessage(null);

    try {
      const payload = "{}";
      const path = "/api/office/disputes/warnings";
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

        setBusy(false);
        setMessage(refusalTextOf(response.status, refusal));

        return;
      }

      const answer = (await response.json().catch(() => null)) as SweepAnswer | null;
      const sent = countOf(answer?.sent);
      const due = countOf(answer?.due);
      const skipped = answer?.skipped ?? {};
      const blocked =
        countOf(skipped["sender_not_configured"]) +
        countOf(skipped["no_owner"]) +
        countOf(skipped["failed"]) +
        countOf(skipped["superseded"]);

      setBusy(false);

      if (due === 0) {
        setMessage(getMessage("disputes.warningRunNothing"));
      } else if (sent === 0 && blocked > 0) {
        setMessage(formatMessage("disputes.warningRunBlocked", { count: String(blocked) }));
      } else {
        setMessage(formatMessage("disputes.warningRunDone", { sent: String(sent), blocked: String(blocked) }));
      }

      router.refresh();
    } catch {
      setBusy(false);
      setMessage(getMessage("disputes.failed"));
    }
  }

  return (
    <div className={panelClasses}>
      <h3 className={headingClasses}>{getMessage("disputes.warningRunTitle")}</h3>
      <p className={helpClasses}>{getMessage("disputes.warningRunHelp")}</p>
      <p className={helpClasses}>{getMessage("disputes.warningRunDeviceNote")}</p>

      <button
        className={buttonClasses}
        disabled={busy}
        onClick={(): void => {
          void run();
        }}
        type="button"
      >
        {busy ? `${getMessage("disputes.warningRunBusy")}…` : getMessage("disputes.warningRunButton")}
      </button>

      {message === null ? null : (
        <p className={messageClasses} role="status">
          {message}
        </p>
      )}
    </div>
  );
}
