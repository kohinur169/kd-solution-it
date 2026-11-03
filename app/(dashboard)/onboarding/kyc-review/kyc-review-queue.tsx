// path: app/(dashboard)/onboarding/kyc-review/kyc-review-queue.tsx
"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { rateLimitSentence } from "@/lib/auth/refusal-message";
import { formatMessage, getMessage } from "@/lib/i18n/messages";
import type { MessagePath } from "@/lib/i18n/messages";
import { csrfHeaders } from "@/lib/security/csrf-client";
import type { KycReviewDetail, KycReviewQueue } from "@/services/kyc/kyc-review";

/**
 * The working half of the compliance KYC review queue (STEP 088): pick a submission, read its
 * detail through one GET, then open it for review or decide each document through two actions that
 * share one `postJson` helper - a single POST literal and one awaited CSRF spread, the shape the
 * auth gate counts.
 *
 * ## What it sends, and what it never sends
 *
 * The detail GET carries only the submission id in the query string - never a company, which the
 * service resolves from the row itself. The POSTs carry the submission id or the document id plus
 * the decision and, for a rejection, the reason `0049` demands. The company is never in any body.
 */

const DETAIL_PATH = "/api/onboarding/kyc-review-submission";
const OPEN_PATH = "/api/onboarding/kyc-review-open";
const DECIDE_PATH = "/api/onboarding/kyc-document-review";
const RISK_PATH = "/api/onboarding/kyc-risk-mark";

/** The catalog label of one document type, reused from the documents step's own block. */
const DOC_TYPE_LABELS: Readonly<Record<string, MessagePath>> = Object.freeze({
  identity_document: "onboardingDocuments.docTypeIdentityDocument",
  business_registration: "onboardingDocuments.docTypeBusinessRegistration",
  utility_bill: "onboardingDocuments.docTypeUtilityBill",
  bank_statement: "onboardingDocuments.docTypeBankStatement",
  source_of_funds: "onboardingDocuments.docTypeSourceOfFunds",
  processor_request: "onboardingDocuments.docTypeProcessorRequest",
});

type RuleKey =
  | "required"
  | "invalid_format"
  | "not_submitted"
  | "already_reviewed"
  | "stale"
  | "already_decided"
  | "same_reviewer";

const RULE_MESSAGES: Readonly<Record<RuleKey, MessagePath>> = Object.freeze({
  required: "onboardingKycReview.ruleRequired",
  invalid_format: "onboardingKycReview.ruleInvalidFormat",
  not_submitted: "onboardingKycReview.ruleNotSubmitted",
  already_reviewed: "onboardingKycReview.ruleAlreadyReviewed",
  stale: "onboardingKycReview.ruleStale",
  already_decided: "onboardingKycReview.ruleAlreadyDecided",
  same_reviewer: "onboardingKycReview.ruleSameReviewer",
});

function ruleSentence(rule: string | null): string {
  if (rule !== null && rule in RULE_MESSAGES) {
    return getMessage(RULE_MESSAGES[rule as RuleKey]);
  }

  return getMessage("onboardingKycReview.ruleInvalidFormat");
}

interface RefusalDetail {
  readonly field?: unknown;
  readonly rule?: unknown;
}

function refusalDetails(payload: unknown): readonly RefusalDetail[] {
  const details = (payload as { readonly error?: { readonly details?: unknown } }).error?.details;

  return Array.isArray(details) ? (details as RefusalDetail[]) : [];
}

/** The catalog label of one review status of a document or submission. */
function docStatusLabel(status: string): MessagePath {
  if (status === "accepted") {
    return "onboardingKycReview.docStatusAccepted";
  }

  return status === "rejected" ? "onboardingKycReview.docStatusRejected" : "onboardingKycReview.docStatusUploaded";
}

export function KycReviewQueuePanel({ initial }: { readonly initial: KycReviewQueue }): ReactNode {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<KycReviewDetail | null>(null);
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
      return getMessage("onboardingKycReview.signedOut");
    }

    if (response.status === 403) {
      return getMessage("onboardingKycReview.forbidden");
    }

    if (response.status === 429) {
      const payload: unknown = await response.json().catch(() => null);

      return rateLimitSentence(payload);
    }

    const payload: unknown = await response.json().catch(() => null);
    const details = refusalDetails(payload);
    const first = details.find((entry) => typeof entry.rule === "string");

    return first === undefined
      ? getMessage("onboardingKycReview.failed")
      : ruleSentence(typeof first.rule === "string" ? first.rule : null);
  }

  async function loadDetail(submissionId: string): Promise<void> {
    setBusy(true);
    setMessage(null);
    setSelectedId(submissionId);
    setDetail(null);

    try {
      const response = await fetch(`${DETAIL_PATH}?id=${encodeURIComponent(submissionId)}`, {
        headers: { "cache-control": "no-store" },
      });

      if (!response.ok) {
        setMessage({ text: getMessage("onboardingKycReview.loadDetailFailed"), failed: true });

        return;
      }

      setDetail((await response.json()) as KycReviewDetail);
    } catch {
      setMessage({ text: getMessage("onboardingKycReview.loadDetailFailed"), failed: true });
    } finally {
      setBusy(false);
    }
  }

  async function openReview(): Promise<void> {
    if (selectedId === null) {
      return;
    }

    setBusy(true);
    setMessage(null);

    try {
      const response = await postJson(OPEN_PATH, { submission_id: selectedId });

      if (!response.ok) {
        setMessage({ text: await readRefusal(response), failed: true });

        return;
      }

      setDetail((await response.json()) as KycReviewDetail);
      setMessage({ text: getMessage("onboardingKycReview.openDone"), failed: false });
      router.refresh();
    } catch {
      setMessage({ text: getMessage("onboardingKycReview.failed"), failed: true });
    } finally {
      setBusy(false);
    }
  }

  async function decide(documentId: string, decision: "accept" | "reject"): Promise<void> {
    if (decision === "reject" && reason.trim() === "") {
      setMessage({ text: getMessage("onboardingKycReview.ruleRequired"), failed: true });

      return;
    }

    setBusy(true);
    setMessage(null);

    try {
      const response = await postJson(DECIDE_PATH, {
        document_id: documentId,
        decision,
        reason: decision === "reject" ? reason.trim() : undefined,
      });

      if (!response.ok) {
        setMessage({ text: await readRefusal(response), failed: true });

        return;
      }

      const updated = (await response.json()) as KycReviewDetail["documents"][number];

      setDetail((current) =>
        current === null
          ? current
          : { ...current, documents: current.documents.map((doc) => (doc.id === updated.id ? updated : doc)) },
      );
      setMessage({
        text: formatMessage("onboardingKycReview.reviewDone", { status: getMessage(docStatusLabel(updated.status)) }),
        failed: false,
      });
      router.refresh();
    } catch {
      setMessage({ text: getMessage("onboardingKycReview.failed"), failed: true });
    } finally {
      setBusy(false);
    }
  }

  async function markRisk(highRisk: boolean): Promise<void> {
    if (selectedId === null) {
      return;
    }

    setBusy(true);
    setMessage(null);

    try {
      const response = await postJson(RISK_PATH, {
        submission_id: selectedId,
        high_risk: highRisk,
        four_eye_required: highRisk,
      });

      if (!response.ok) {
        setMessage({ text: await readRefusal(response), failed: true });

        return;
      }

      setDetail((await response.json()) as KycReviewDetail);
      setMessage({ text: getMessage("onboardingKycReview.riskDone"), failed: false });
      router.refresh();
    } catch {
      setMessage({ text: getMessage("onboardingKycReview.failed"), failed: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        {initial.rows.map((row) => (
          <button
            key={row.submissionId}
            type="button"
            className={buttonClasses}
            onClick={() => void loadDetail(row.submissionId)}
            disabled={busy}
          >
            {row.submissionId}
          </button>
        ))}
      </div>

      {message === null ? null : (
        <p
          className={message.failed ? "text-sm text-destructive" : "text-sm text-primary"}
          role={message.failed ? "alert" : "status"}
          aria-live="polite"
        >
          {message.text}
        </p>
      )}

      {detail === null ? (
        <p className="text-sm text-muted-foreground">{getMessage("onboardingKycReview.detailEmpty")}</p>
      ) : (
        <section className="flex flex-col gap-3 rounded-md border border-border p-4">
          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-semibold">{getMessage("onboardingKycReview.documentsHeading")}</h3>
            <p className="text-xs text-muted-foreground">
              {formatMessage("onboardingKycReview.companyLine", { company: detail.companyId })}
            </p>
            <p className="text-xs text-muted-foreground">
              {formatMessage("onboardingKycReview.methodLine", { method: detail.method })}
            </p>
            <p className="text-xs text-muted-foreground">
              {detail.providerReference === null
                ? getMessage("onboardingKycReview.providerNone")
                : formatMessage("onboardingKycReview.providerLine", { reference: detail.providerReference })}
            </p>
            {detail.highRisk ? (
              <p className="text-xs font-semibold text-destructive">{getMessage("onboardingKycReview.highRiskLine")}</p>
            ) : null}
            {detail.fourEyeRequired ? (
              <>
                <p className="text-xs font-semibold text-destructive">{getMessage("onboardingKycReview.fourEyeLine")}</p>
                <p className="text-xs text-muted-foreground">{getMessage("onboardingKycReview.secondReviewerHint")}</p>
              </>
            ) : null}
            {detail.status === "approved" || detail.status === "rejected" ? null : (
              <div className="flex flex-col gap-1">
                <h3 className="text-sm font-semibold">{getMessage("onboardingKycReview.riskHeading")}</h3>
                <div className="flex flex-row gap-2">
                  <button
                    type="button"
                    className={buttonClasses}
                    onClick={() => void markRisk(true)}
                    disabled={busy}
                  >
                    {busy
                      ? getMessage("onboardingKycReview.riskBusy")
                      : getMessage("onboardingKycReview.riskMarkButton")}
                  </button>
                  <button
                    type="button"
                    className={buttonClasses}
                    onClick={() => void markRisk(false)}
                    disabled={busy}
                  >
                    {getMessage("onboardingKycReview.riskClearButton")}
                  </button>
                </div>
              </div>
            )}
            {detail.decidedAt === null ? null : (
              <p className="text-xs text-muted-foreground">
                {formatMessage("onboardingKycReview.decidedAtLine", { at: detail.decidedAt })}
              </p>
            )}
            {detail.decisionReason === null ? null : (
              <p className="text-xs text-muted-foreground">
                {getMessage("onboardingKycReview.decisionReasonHeading")}: {detail.decisionReason}
              </p>
            )}
          </div>

          {detail.status === "submitted" ? (
            <button type="button" className={buttonClasses} onClick={() => void openReview()} disabled={busy}>
              {busy ? getMessage("onboardingKycReview.openBusy") : getMessage("onboardingKycReview.openButton")}
            </button>
          ) : null}

          <ul className="flex flex-col gap-2">
            {detail.documents.map((doc) => (
              <li key={doc.id} className="flex flex-col gap-1 rounded-sm border border-border p-3">
                <span className="text-sm font-semibold">
                  {getMessage(DOC_TYPE_LABELS[doc.documentType] ?? "onboardingKycReview.docTypeLine")}
                </span>
                <span className="text-xs text-muted-foreground">{getMessage(docStatusLabel(doc.status))}</span>
                <span className="text-xs text-muted-foreground">
                  {formatMessage("onboardingKycReview.docMetaLine", {
                    size: String(doc.byteSize),
                    contentType: doc.contentType,
                  })}
                </span>
                <span className="break-all font-mono text-xs text-muted-foreground">
                  {formatMessage("onboardingKycReview.docKeyLine", { key: doc.storageKey })}
                </span>
                <span className="break-all font-mono text-xs text-muted-foreground">
                  {formatMessage("onboardingKycReview.docHashLine", { hash: doc.contentSha256 })}
                </span>
                {doc.issuedAt === null ? null : (
                  <span className="text-xs text-muted-foreground">
                    {doc.documentType === "bank_statement" && doc.expiresAt !== null
                      ? formatMessage("onboardingKycReview.docPeriodLine", { from: doc.issuedAt, to: doc.expiresAt })
                      : formatMessage("onboardingKycReview.docIssuedLine", { date: doc.issuedAt })}
                  </span>
                )}
                {doc.rejectionReason === null ? null : (
                  <span className="text-xs text-destructive">
                    {formatMessage("onboardingKycReview.docRejectedLine", { reason: doc.rejectionReason })}
                  </span>
                )}
                {doc.status === "uploaded" ? (
                  <div className="flex flex-row gap-2">
                    <button
                      type="button"
                      className={buttonClasses}
                      onClick={() => void decide(doc.id, "accept")}
                      disabled={busy}
                    >
                      {busy ? getMessage("onboardingKycReview.reviewBusy") : getMessage("onboardingKycReview.acceptButton")}
                    </button>
                    <button
                      type="button"
                      className={buttonClasses}
                      onClick={() => void decide(doc.id, "reject")}
                      disabled={busy}
                    >
                      {getMessage("onboardingKycReview.rejectButton")}
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>

          <label className="flex flex-col gap-1">
            <span className="text-sm font-semibold">{getMessage("onboardingKycReview.reasonLabel")}</span>
            <input
              className="rounded-sm border border-border bg-background px-2 py-1 text-sm"
              type="text"
              maxLength={280}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
            <span className="text-xs text-muted-foreground">{getMessage("onboardingKycReview.reasonHint")}</span>
          </label>

          <h3 className="text-sm font-semibold">{getMessage("onboardingKycReview.ubosHeading")}</h3>
          <ul className="flex flex-col gap-1">
            {detail.ubos.map((ubo) => (
              <li key={ubo.id} className="text-xs text-muted-foreground">
                {formatMessage("onboardingKycReview.uboLine", {
                  name: ubo.fullName,
                  country: ubo.country,
                  percent: String(Math.round(ubo.ownershipBps / 100)),
                })}
                {ubo.isSignificant ? `, ${getMessage("onboardingKycReview.uboSignificant")}` : ""}
                {ubo.isPep ? `, ${getMessage("onboardingKycReview.uboPep")}` : ""}
                {ubo.screenedAt === null
                  ? ` - ${getMessage("onboardingKycReview.uboNotScreened")}`
                  : ` - ${formatMessage("onboardingKycReview.uboScreenedLine", { at: ubo.screenedAt })}`}
              </li>
            ))}
          </ul>

          <h3 className="text-sm font-semibold">{getMessage("onboardingKycReview.screeningsHeading")}</h3>
          <ul className="flex flex-col gap-1">
            {detail.screenings.map((screening) => (
              <li key={screening.id} className="text-xs text-muted-foreground">
                {formatMessage("onboardingKycReview.screeningLine", {
                  kind: screening.subjectKind,
                  result: screening.result,
                  lists: screening.listsCovered.join(", "),
                  provider: screening.provider,
                  at: screening.screenedAt,
                })}
                {screening.note === null
                  ? null
                  : ` - ${formatMessage("onboardingKycReview.screeningNoteLine", { note: screening.note })}`}
                {screening.sarCase ? ` - ${getMessage("onboardingKycReview.sarLine")}` : ""}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

const buttonClasses =
  "w-fit rounded-sm bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60";
