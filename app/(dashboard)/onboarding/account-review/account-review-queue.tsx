// path: app/(dashboard)/onboarding/account-review/account-review-queue.tsx
"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { rateLimitSentence } from "@/lib/auth/refusal-message";
import { formatMessage, getMessage } from "@/lib/i18n/messages";
import type { MessagePath } from "@/lib/i18n/messages";
import { csrfHeaders } from "@/lib/security/csrf-client";
import type { AccountQueueRow } from "@/services/kyc/account-lifecycle";

/**
 * The office account review panel of STEP 099: the queue of merchant accounts in an open state,
 * with the two decisions an office role makes from a row (accept a reactivation, close the
 * account) and the suspend form that opens a suspension for any merchant.
 *
 * Every action is one POST with the company id in the body; the company of a suspend comes from the
 * form, because the office acts across merchants, and the service validates it as a UUID before any
 * query runs. The server re-checks the state machine, so a stale page cannot act on an old state.
 */

const SUSPEND_PATH = "/api/onboarding/account-suspend";
const REACTIVATE_DECIDE_PATH = "/api/onboarding/account-reactivate-decide";
const CLOSE_PATH = "/api/onboarding/account-close";

const REASONS = ["risk", "chargeback_program", "billing", "manual"] as const;

type RuleKey =
  | "not_active"
  | "already_closed"
  | "no_reactivation_requested"
  | "already_active"
  | "not_approved"
  | "documents_rejected"
  | "no_closure_requested"
  | "not_verified";

const RULE_MESSAGES: Readonly<Record<RuleKey, MessagePath>> = Object.freeze({
  not_active: "onboardingAccountReview.ruleNotActive",
  already_closed: "onboardingAccountReview.ruleAlreadyClosed",
  no_reactivation_requested: "onboardingAccountReview.ruleNoReactivationRequested",
  already_active: "onboardingAccountReview.ruleAlreadyActive",
  not_approved: "onboardingAccountReview.ruleNotApproved",
  documents_rejected: "onboardingAccountReview.ruleDocumentsRejected",
  no_closure_requested: "onboardingAccountReview.ruleNoClosureRequested",
  not_verified: "onboardingAccountReview.ruleNotVerified",
});

interface RefusalDetail {
  readonly field?: unknown;
  readonly rule?: unknown;
}

function ruleSentence(rule: string | null): string {
  if (rule !== null && rule in RULE_MESSAGES) {
    return getMessage(RULE_MESSAGES[rule as RuleKey]);
  }

  return getMessage("onboardingAccountReview.ruleFailed");
}

function refusalDetails(payload: unknown): readonly RefusalDetail[] {
  const details = (payload as { readonly error?: { readonly details?: unknown } }).error?.details;

  return Array.isArray(details) ? (details as RefusalDetail[]) : [];
}

function stateKey(state: string): MessagePath {
  if (state === "suspended") {
    return "onboardingAccountReview.stateSuspended";
  }

  if (state === "reactivation_requested") {
    return "onboardingAccountReview.stateReactivationRequested";
  }

  return "onboardingAccountReview.stateClosureRequested";
}

function reasonKey(reason: string | null): MessagePath {
  if (reason === "risk") {
    return "onboardingAccountReview.reasonRisk";
  }

  if (reason === "chargeback_program") {
    return "onboardingAccountReview.reasonChargebackProgram";
  }

  if (reason === "billing") {
    return "onboardingAccountReview.reasonBilling";
  }

  return "onboardingAccountReview.reasonManual";
}

export function AccountReviewQueuePanel({ rows }: { readonly rows: readonly AccountQueueRow[] }): ReactNode {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ readonly text: string; readonly failed: boolean } | null>(null);
  const [companyId, setCompanyId] = useState("");
  const [reason, setReason] = useState<(typeof REASONS)[number]>("risk");
  const [documents, setDocuments] = useState("");

  async function post(path: string, body: Record<string, unknown>, doneKey: MessagePath): Promise<void> {
    setBusy(true);
    setMessage(null);

    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json", ...(await csrfHeaders()) },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        if (response.status === 401) {
          setMessage({ text: getMessage("onboardingAccountReview.signedOut"), failed: true });

          return;
        }

        if (response.status === 403) {
          setMessage({ text: getMessage("onboardingAccountReview.forbidden"), failed: true });

          return;
        }

        if (response.status === 429) {
          const payload: unknown = await response.json().catch(() => null);

          setMessage({ text: rateLimitSentence(payload), failed: true });

          return;
        }

        const payload: unknown = await response.json().catch(() => null);
        const details = refusalDetails(payload);
        const first = details.find((detail) => typeof detail.field === "string" && detail.field !== "csrf");

        setMessage({
          text:
            first === undefined
              ? getMessage("onboardingAccountReview.ruleFailed")
              : ruleSentence(typeof first.rule === "string" ? first.rule : null),
          failed: true,
        });

        return;
      }

      setMessage({ text: getMessage(doneKey), failed: false });
      router.refresh();
    } catch {
      setMessage({ text: getMessage("onboardingAccountReview.ruleFailed"), failed: true });
    } finally {
      setBusy(false);
    }
  }

  async function onRowAction(event: FormEvent<HTMLFormElement>, path: string, body: Record<string, unknown>, doneKey: MessagePath): Promise<void> {
    event.preventDefault();
    await post(path, body, doneKey);
  }

  async function onSuspend(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    const required = documents
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    await post(
      SUSPEND_PATH,
      { company_id: companyId.trim(), reason, required_documents: required },
      "onboardingAccountReview.suspendDone",
    );
  }

  return (
    <>
      <section className={sectionClasses}>
        <h2 className={sectionHeadingClasses}>{getMessage("onboardingAccountReview.queueHeading")}</h2>
        {message === null ? null : (
          <p
            className={message.failed ? "text-sm text-destructive" : "text-sm text-primary"}
            role={message.failed ? "alert" : "status"}
            aria-live="polite"
          >
            {message.text}
          </p>
        )}
        {rows.length === 0 ? (
          <p className={noteClasses}>{getMessage("onboardingAccountReview.queueEmpty")}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {rows.map((row) => (
              <li key={row.companyId} className="flex flex-col gap-2 rounded-md border border-border p-3">
                <p className="text-sm font-semibold">{formatMessage("onboardingAccountReview.companyLine", { company: row.companyId })}</p>
                <p className={noteClasses}>
                  {getMessage(stateKey(row.state))} - {formatMessage("onboardingAccountReview.atLine", { at: row.at })}
                </p>
                {row.reason === null ? null : (
                  <p className={noteClasses}>{getMessage(reasonKey(row.reason))}</p>
                )}
                {row.requiredDocuments.length === 0 ? null : (
                  <p className={noteClasses}>
                    {formatMessage("onboardingAccountReview.requiredDocsLine", {
                      documents: row.requiredDocuments.join(", "),
                    })}
                  </p>
                )}
                {row.closureNote === null ? null : <p className={noteClasses}>{row.closureNote}</p>}
                <div className="flex flex-wrap gap-2">
                  {row.state === "reactivation_requested" ? (
                    <form noValidate onSubmit={(event) => void onRowAction(event, REACTIVATE_DECIDE_PATH, { company_id: row.companyId }, "onboardingAccountReview.reactivateDone")}>
                      <button
                        className="w-fit rounded-sm bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90 focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60"
                        type="submit"
                        disabled={busy}
                      >
                        {getMessage("onboardingAccountReview.reactivateButton")}
                      </button>
                    </form>
                  ) : null}
                  {row.state === "suspended" || row.state === "closure_requested" || row.state === "reactivation_requested" ? (
                    <form noValidate onSubmit={(event) => void onRowAction(event, CLOSE_PATH, { company_id: row.companyId }, "onboardingAccountReview.closeDone")}>
                      <button
                        className="w-fit rounded-sm border border-destructive px-3 py-1.5 text-xs font-semibold text-destructive hover:opacity-90 focus-visible:ring-2 focus-visible:ring-destructive disabled:opacity-60"
                        type="submit"
                        disabled={busy}
                      >
                        {getMessage("onboardingAccountReview.closeButton")}
                      </button>
                    </form>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={sectionClasses}>
        <h2 className={sectionHeadingClasses}>{getMessage("onboardingAccountReview.suspendHeading")}</h2>
        <p className={noteClasses}>{getMessage("onboardingAccountReview.suspendNote")}</p>
        <form className="flex flex-col gap-3" noValidate onSubmit={(event) => void onSuspend(event)}>
          <label className="flex flex-col gap-1 text-sm">
            {getMessage("onboardingAccountReview.companyIdLabel")}
            <input
              className="rounded-sm border border-border bg-background px-2 py-1.5 text-sm"
              type="text"
              value={companyId}
              onChange={(event) => setCompanyId(event.target.value)}
              required
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {getMessage("onboardingAccountReview.reasonLabel")}
            <select
              className="rounded-sm border border-border bg-background px-2 py-1.5 text-sm"
              value={reason}
              onChange={(event) => setReason(event.target.value as (typeof REASONS)[number])}
            >
              {REASONS.map((option) => (
                <option key={option} value={option}>
                  {getMessage(reasonKey(option))}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {getMessage("onboardingAccountReview.documentsLabel")}
            <input
              className="rounded-sm border border-border bg-background px-2 py-1.5 text-sm"
              type="text"
              value={documents}
              onChange={(event) => setDocuments(event.target.value)}
            />
          </label>
          <button
            className="w-fit rounded-sm bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60"
            type="submit"
            disabled={busy}
          >
            {busy ? getMessage("onboardingAccountReview.suspendBusy") : getMessage("onboardingAccountReview.suspendButton")}
          </button>
        </form>
      </section>
    </>
  );
}

const sectionClasses = "flex flex-col gap-3 rounded-md border border-border p-4";

const sectionHeadingClasses = "text-base font-semibold";

const noteClasses = "max-w-3xl text-xs text-muted-foreground";
