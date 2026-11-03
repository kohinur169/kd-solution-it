// path: app/(dashboard)/onboarding/payment-holds/payment-holds-panel.tsx
"use client";

import { useState, type ReactNode } from "react";
import { rateLimitSentence } from "@/lib/auth/refusal-message";
import { formatMessage, getMessage, type MessagePath } from "@/lib/i18n/messages";
import { csrfHeaders } from "@/lib/security/csrf-client";
import type { PaymentHoldQueue, PaymentHoldSnapshot } from "@/services/kyc/payment-hold";

/**
 * The working half of the payment hold queue (STEP 092): pick a held row, optionally type the
 * reason, and release or reject it through one `postJson` helper - a single POST literal and one
 * awaited CSRF spread, the shape the auth gate counts.
 *
 * ## What it sends, and what it never sends
 *
 * The POST carries only the hold id, the decision and the reason. No company is ever sent: the hold
 * is resolved by id server-side, and the service resolves the merchant from the row itself.
 */

const DECIDE_PATH = "/api/onboarding/payment-hold-decide";
const QUEUE_PATH = "/api/onboarding/payment-holds";

type RuleKey = "required" | "invalid_format" | "already_decided" | "stale";

const RULE_MESSAGES: Readonly<Record<RuleKey, MessagePath>> = Object.freeze({
  required: "onboardingPaymentHolds.ruleRequired",
  invalid_format: "onboardingPaymentHolds.ruleInvalidFormat",
  already_decided: "onboardingPaymentHolds.ruleAlreadyDecided",
  stale: "onboardingPaymentHolds.ruleStale",
});

function ruleSentence(rule: string | null): string {
  if (rule !== null && rule in RULE_MESSAGES) {
    return getMessage(RULE_MESSAGES[rule as RuleKey]);
  }

  return getMessage("onboardingPaymentHolds.ruleInvalidFormat");
}

interface RefusalDetail {
  readonly field?: unknown;
  readonly rule?: unknown;
}

function refusalDetails(payload: unknown): readonly RefusalDetail[] {
  const details = (payload as { readonly error?: { readonly details?: unknown } }).error?.details;

  return Array.isArray(details) ? (details as RefusalDetail[]) : [];
}

function statusLabel(status: string): MessagePath {
  if (status === "released") {
    return "onboardingPaymentHolds.statusReleased";
  }

  return status === "rejected" ? "onboardingPaymentHolds.statusRejected" : "onboardingPaymentHolds.statusHeld";
}

export function PaymentHoldsPanel({ initial }: { readonly initial: PaymentHoldQueue }): ReactNode {
  const [queue, setQueue] = useState<PaymentHoldQueue>(initial);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ readonly text: string; readonly failed: boolean } | null>(null);

  async function postJson(path: string, body: unknown): Promise<Response> {
    return fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await csrfHeaders()) },
      body: JSON.stringify(body),
    });
  }

  /** Shared refusal handling: 401/403/429 get their own sentence, a 422 names the rule. */
  async function readRefusal(response: Response): Promise<string> {
    if (response.status === 401) {
      return getMessage("onboardingPaymentHolds.signedOut");
    }

    if (response.status === 403) {
      return getMessage("onboardingPaymentHolds.forbidden");
    }

    if (response.status === 429) {
      const payload: unknown = await response.json().catch(() => null);

      return rateLimitSentence(payload);
    }

    const payload: unknown = await response.json().catch(() => null);
    const details = refusalDetails(payload);
    const first = details.find((entry) => typeof entry.rule === "string");

    return first === undefined
      ? getMessage("onboardingPaymentHolds.failed")
      : ruleSentence(typeof first.rule === "string" ? first.rule : null);
  }

  async function refresh(): Promise<void> {
    try {
      const response = await fetch(QUEUE_PATH, { headers: { "cache-control": "no-store" } });

      if (response.ok) {
        setQueue((await response.json()) as PaymentHoldQueue);
      }
    } catch {
      // A failed refresh leaves the list as it is; the next decision refreshes it again.
    }
  }

  function applyDecided(hold: PaymentHoldSnapshot): void {
    setQueue((current) => ({
      rows: current.rows.map((row) => (row.id === hold.id ? hold : row)),
    }));
  }

  async function decide(decision: "release" | "reject"): Promise<void> {
    if (selectedId === null) {
      return;
    }

    setBusy(true);
    setMessage(null);

    try {
      const response = await postJson(DECIDE_PATH, {
        hold_id: selectedId,
        decision,
        reason: reason.trim() === "" ? undefined : reason,
      });

      if (!response.ok) {
        setMessage({ text: await readRefusal(response), failed: true });
        await refresh();

        return;
      }

      const hold = (await response.json()) as PaymentHoldSnapshot;

      applyDecided(hold);
      setReason("");
      setMessage({ text: getMessage("onboardingPaymentHolds.decidedDone"), failed: false });
    } catch {
      setMessage({ text: getMessage("onboardingPaymentHolds.failed"), failed: true });
    } finally {
      setBusy(false);
    }
  }

  const selected = queue.rows.find((row) => row.id === selectedId) ?? null;

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-3">
      {message === null ? null : (
        <p className={message.failed ? alertClasses : noteClasses} role="status">
          {message.text}
        </p>
      )}

      <ul className="flex flex-col gap-2">
        {queue.rows.map((row) => (
          <li key={row.id}>
            <button
              type="button"
              className={rowButtonClasses(selectedId === row.id)}
              onClick={() => setSelectedId(row.id)}
              disabled={busy}
            >
              <span className="font-mono text-xs">{row.id}</span>
              <span className="font-semibold">{getMessage(statusLabel(row.status))}</span>
              <span className={noteClasses}>
                {formatMessage("onboardingPaymentHolds.amountLine", { amount: row.amount })}
              </span>
              <span className={noteClasses}>
                {formatMessage("onboardingPaymentHolds.heldAtLine", { at: row.heldAt })}
              </span>
            </button>
            {row.status === "held" ? null : (
              <p className={noteClasses}>
                {row.reviewedAt === null
                  ? null
                  : formatMessage("onboardingPaymentHolds.decidedLine", { at: row.reviewedAt })}
                {row.decisionReason === null
                  ? ""
                  : ` - ${formatMessage("onboardingPaymentHolds.reasonShownLine", { reason: row.decisionReason })}`}
              </p>
            )}
          </li>
        ))}
      </ul>

      {selected === null ? null : (
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-sm font-semibold">{getMessage("onboardingPaymentHolds.reasonLabel")}</span>
            <input
              className="rounded-sm border border-border bg-background px-2 py-1 text-sm"
              type="text"
              maxLength={280}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
            <span className="text-xs text-muted-foreground">{getMessage("onboardingPaymentHolds.reasonHint")}</span>
          </label>
          <div className="flex flex-row gap-2">
            <button type="button" className={buttonClasses} onClick={() => void decide("release")} disabled={busy}>
              {busy ? getMessage("onboardingPaymentHolds.busy") : getMessage("onboardingPaymentHolds.releaseButton")}
            </button>
            <button type="button" className={buttonClasses} onClick={() => void decide("reject")} disabled={busy}>
              {getMessage("onboardingPaymentHolds.rejectButton")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const noteClasses = "max-w-3xl text-xs text-muted-foreground";

const alertClasses = "text-sm text-destructive";

const buttonClasses =
  "w-fit rounded-sm bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60";

function rowButtonClasses(active: boolean): string {
  return `flex w-full flex-col gap-1 rounded-sm border p-3 text-left sm:flex-row sm:items-center sm:gap-4 ${
    active ? "border-primary bg-accent" : "border-border"
  }`;
}
