// path: app/(admin)/office/refunds/fees/refund-fee-form.tsx
"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { deviceProofHeaders } from "@/lib/auth/device-proof-store";
import { rateLimitSentence } from "@/lib/auth/refusal-message";
import { getMessage } from "@/lib/i18n/messages";
import { csrfHeaders } from "@/lib/security/csrf-client";

/**
 * The two acts of the fee screen: answer the question, and apply the answer to the backlog.
 *
 * ## Why one file and two components
 *
 * Both press a route that writes money records, both need the device proof and the CSRF token, and both read the
 * same refusal envelope - so the proof and the sentences live here once. They are separate components because
 * they are different acts with different guards: the first is the super administrator's answer and carries the
 * instant the form was rendered at, the second is the desk's pass and carries nothing at all.
 *
 * ## Why the save sends the instant it rendered
 *
 * Two officers who both flip the switch should not silently overwrite each other. The `savedAt` below is the
 * `updated_at` the page read, so a save built on a stale screen is a `409` with `rule: "stale"` and the officer
 * re-reads the screen instead of learning later that somebody else had answered first.
 *
 * ## Why the pass is a button and not a spinner that runs itself
 *
 * It writes money records for many merchants at once. A person presses it, reads the counts it answers with, and
 * presses again if there is more: fifty refunds a press, which is the service's bound and not the browser's.
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

/** One sentence for a refusal both forms can meet. */
function messageForStatus(status: number, payload: unknown): string {
  if (status === 429) {
    return rateLimitSentence(payload);
  }

  if (status === 401) {
    return getMessage("refunds.signedOut");
  }

  if (status === 403) {
    const { rule } = refusalOf(payload);

    return rule === "reauthentication_required"
      ? getMessage("refundFees.reauthRequired")
      : getMessage("refunds.deviceRequired");
  }

  const { rule } = refusalOf(payload);

  if (rule === "stale") {
    return getMessage("refundFees.staleSave");
  }

  if (status === 413) {
    return getMessage("refundFees.failed");
  }

  return getMessage("refundFees.failed");
}

const formClasses = "flex flex-col gap-3";

const actionsClasses = "flex flex-wrap items-center gap-2";

const primaryClasses =
  "inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60";

const secondaryClasses =
  "inline-flex items-center justify-center rounded-lg border border-border bg-background px-4 py-2 text-sm font-semibold text-foreground transition-opacity hover:opacity-90 disabled:opacity-60";

const choiceClasses = "flex flex-wrap items-center gap-4 text-sm";

const hintClasses = "text-xs text-muted-foreground";

const statusClasses = "text-sm";

/** The switch: two choices, one save, and the instant the page was read. */
export function RefundFeeRuleForm({
  returned,
  savedAt,
}: {
  readonly returned: boolean;
  readonly savedAt: string | null;
}): ReactNode {
  const router = useRouter();
  const [choice, setChoice] = useState<boolean>(returned);
  const [busy, setBusy] = useState<boolean>(false);
  const [message, setMessage] = useState<string | null>(null);

  async function save(): Promise<void> {
    setBusy(true);
    setMessage(null);

    try {
      const payload = JSON.stringify({ action: "save", returned: choice, savedAt });
      const path = "/api/office/refunds/fees";
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

      setBusy(false);
      setMessage(getMessage("refundFees.saved"));
      router.refresh();
    } catch {
      setBusy(false);
      setMessage(getMessage("refundFees.failed"));
    }
  }

  return (
    <form
      className={formClasses}
      onSubmit={(event: FormEvent<HTMLFormElement>): void => {
        event.preventDefault();
      }}
    >
      <fieldset className={choiceClasses}>
        <legend className={hintClasses}>{getMessage("refundFees.switchLabel")}</legend>
        <label className="flex items-center gap-2">
          <input
            checked={choice}
            name="returned"
            onChange={(): void => {
              setChoice(true);
            }}
            type="radio"
          />
          {getMessage("refundFees.switchReturned")}
        </label>
        <label className="flex items-center gap-2">
          <input
            checked={!choice}
            name="returned"
            onChange={(): void => {
              setChoice(false);
            }}
            type="radio"
          />
          {getMessage("refundFees.switchRetained")}
        </label>
      </fieldset>

      <div className={actionsClasses}>
        <button
          className={primaryClasses}
          disabled={busy || choice === returned}
          onClick={(): void => {
            void save();
          }}
          type="button"
        >
          {busy ? getMessage("refundFees.saving") : getMessage("refundFees.save")}
        </button>
        <span className={hintClasses}>{getMessage("refundFees.saveHelp")}</span>
      </div>

      {message === null ? null : (
        <p className={statusClasses} role="status">
          {message}
        </p>
      )}
    </form>
  );
}

/** The pass: one press, and the counts it answers with. */
export function RefundFeeSweepForm(): ReactNode {
  const router = useRouter();
  const [busy, setBusy] = useState<boolean>(false);
  const [message, setMessage] = useState<string | null>(null);

  async function sweep(): Promise<void> {
    setBusy(true);
    setMessage(null);

    try {
      const payload = "{}";
      const path = "/api/office/refunds/fees/settle";
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
      const examined =
        typeof body === "object" && body !== null && "examined" in body
          ? (body as { readonly examined?: unknown }).examined
          : null;

      setBusy(false);
      setMessage(
        examined === 0 || examined === null
          ? getMessage("refundFees.passNothing")
          : getMessage("refundFees.passDone"),
      );
      router.refresh();
    } catch {
      setBusy(false);
      setMessage(getMessage("refundFees.failed"));
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
          className={secondaryClasses}
          disabled={busy}
          onClick={(): void => {
            void sweep();
          }}
          type="button"
        >
          {busy ? getMessage("refundFees.runningPass") : getMessage("refundFees.runPass")}
        </button>
        <span className={hintClasses}>{getMessage("refundFees.runPassHelp")}</span>
      </div>

      {message === null ? null : (
        <p className={statusClasses} role="status">
          {message}
        </p>
      )}
    </form>
  );
}
