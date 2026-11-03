// path: app/(dashboard)/onboarding/documents/documents-form.tsx
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { rateLimitSentence } from "@/lib/auth/refusal-message";
import { formatMessage, getMessage } from "@/lib/i18n/messages";
import type { MessagePath } from "@/lib/i18n/messages";
import { csrfHeaders } from "@/lib/security/csrf-client";
import {
  BANK_STATEMENT_MAX_AGE_MONTHS,
  dateStringMinusMonths,
  KYC_DOCUMENT_TYPES,
  monthsBetweenDates,
  UTILITY_BILL_MAX_AGE_MONTHS,
  type KycDocumentType,
  type UtilityBillIssueWindow,
} from "@/services/kyc/kyc-document-types";
import type { KycPackSnapshot } from "@/services/kyc/kyc-capture";

/**
 * The documents step of section 5: upload a document, capture a beneficial owner, run the screening.
 *
 * ## What it sends, and what it never sends
 *
 * The upload is multipart: the file plus the document type and the two dates. The UBO save is
 * JSON with the six fields the service names. The screening run is an empty body. The company is
 * never in any body: `services/kyc/kyc-capture.ts` takes it from the session. Screening results are
 * never rendered here - the pack the service answers carries only how many subjects were screened,
 * because section 5 lets the merchant see the status and nothing else.
 *
 * ## Why the document types come from their own module
 *
 * `services/kyc/kyc-document-types.ts` holds the list with no server imports, so this client
 * component can draw the select without pulling the capture service's `node:crypto` into the
 * browser bundle.
 */

/** The catalog label of one review status of a document. */
const DOC_STATUS_LABELS: Readonly<Record<string, MessagePath>> = Object.freeze({
  uploaded: "onboardingDocuments.docStatusUploaded",
  accepted: "onboardingDocuments.docStatusAccepted",
  rejected: "onboardingDocuments.docStatusRejected",
});

const UPLOAD_PATH = "/api/onboarding/kyc-document";
const UBO_PATH = "/api/onboarding/kyc-ubo";
const SCREENING_PATH = "/api/onboarding/kyc-screening";

/** The catalog label of one document type. */
const DOC_TYPE_LABELS: Readonly<Record<KycDocumentType, MessagePath>> = Object.freeze({
  identity_document: "onboardingDocuments.docTypeIdentityDocument",
  business_registration: "onboardingDocuments.docTypeBusinessRegistration",
  utility_bill: "onboardingDocuments.docTypeUtilityBill",
  bank_statement: "onboardingDocuments.docTypeBankStatement",
  source_of_funds: "onboardingDocuments.docTypeSourceOfFunds",
  processor_request: "onboardingDocuments.docTypeProcessorRequest",
});

type RuleKey =
  | "file_not_acceptable"
  | "invalid_format"
  | "invalid_date"
  | "invalid_range"
  | "required"
  | "too_short"
  | "too_long"
  | "ownership_total_exceeded"
  | "not_found"
  | "not_open"
  | "submission_mismatch"
  | "request_document_type"
  | "stale";

const RULE_MESSAGES: Readonly<Record<RuleKey, MessagePath>> = Object.freeze({
  file_not_acceptable: "onboardingDocuments.ruleFileNotAcceptable",
  invalid_format: "onboardingDocuments.ruleInvalidFormat",
  invalid_date: "onboardingDocuments.ruleInvalidDate",
  invalid_range: "onboardingDocuments.ruleInvalidRange",
  required: "onboardingDocuments.ruleRequired",
  too_short: "onboardingDocuments.ruleTooShort",
  too_long: "onboardingDocuments.ruleTooLong",
  ownership_total_exceeded: "onboardingDocuments.ruleOwnershipTotalExceeded",
  not_found: "onboardingDocuments.ruleNotFound",
  not_open: "onboardingDocuments.ruleRequestNotOpen",
  submission_mismatch: "onboardingDocuments.ruleSubmissionMismatch",
  request_document_type: "onboardingDocuments.ruleRequestDocumentType",
  stale: "onboardingDocuments.ruleStale",
});

function ruleSentence(rule: string | null): string {
  if (rule !== null && rule in RULE_MESSAGES) {
    return getMessage(RULE_MESSAGES[rule as RuleKey]);
  }

  return getMessage("onboardingDocuments.ruleInvalidFormat");
}

interface RefusalDetail {
  readonly field?: unknown;
  readonly rule?: unknown;
}

function refusalDetails(payload: unknown): readonly RefusalDetail[] {
  const details = (payload as { readonly error?: { readonly details?: unknown } }).error?.details;

  return Array.isArray(details) ? (details as RefusalDetail[]) : [];
}

async function readPack(response: Response): Promise<KycPackSnapshot> {
  const payload: unknown = await response.json();

  return payload as KycPackSnapshot;
}

/** One section's message line. */
interface SectionMessage {
  readonly text: string;
  readonly failed: boolean;
}

export function DocumentsForm({
  initial,
  issueWindow,
  statementPeriodMonths,
}: {
  readonly initial: KycPackSnapshot;
  readonly issueWindow: UtilityBillIssueWindow;
  /** The required bank statement period in months, set by the compliance team (STEP 090). */
  readonly statementPeriodMonths: number;
}): ReactNode {
  const router = useRouter();
  const [pack, setPack] = useState<KycPackSnapshot>(initial);

  const [uploadMessage, setUploadMessage] = useState<SectionMessage | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [documentType, setDocumentType] = useState<KycDocumentType | "">("");
  const [requestId, setRequestId] = useState("");
  const [issuedAt, setIssuedAt] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [uploadFieldErrors, setUploadFieldErrors] = useState<Readonly<Record<string, string>>>({});
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [uboMessage, setUboMessage] = useState<SectionMessage | null>(null);
  const [uboBusy, setUboBusy] = useState(false);
  const [uboName, setUboName] = useState("");
  const [uboDob, setUboDob] = useState("");
  const [uboCountry, setUboCountry] = useState("");
  const [uboCountryFilter, setUboCountryFilter] = useState("");
  const [uboShare, setUboShare] = useState("");
  const [uboHash, setUboHash] = useState("");
  const [uboErrors, setUboErrors] = useState<Readonly<Record<string, string>>>({});

  const [screeningMessage, setScreeningMessage] = useState<SectionMessage | null>(null);
  const [screeningBusy, setScreeningBusy] = useState(false);



  const visibleCountries = useMemo(() => {
    const needle = uboCountryFilter.trim().toLowerCase();

    if (needle === "") {
      return pack.countries;
    }

    return pack.countries.filter((country) =>
      `${country.code} ${country.name}`.toLowerCase().includes(needle),
    );
  }, [pack.countries, uboCountryFilter]);

  async function postJson(path: string, body: unknown): Promise<Response> {
    return fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await csrfHeaders()) },
      body: JSON.stringify(body),
    });
  }

  /** Shared refusal handling: 401/403/429 get their own sentence, a 422 marks the named fields. */
  async function handleRefusal(
    response: Response,
    fallback: MessagePath,
    onDetails: (details: readonly RefusalDetail[]) => void,
  ): Promise<SectionMessage> {
    if (response.status === 401) {
      return { text: getMessage("onboardingDocuments.signedOut"), failed: true };
    }

    if (response.status === 403) {
      return { text: getMessage("onboardingDocuments.forbidden"), failed: true };
    }

    if (response.status === 429) {
      const payload: unknown = await response.json().catch(() => null);

      return { text: rateLimitSentence(payload), failed: true };
    }

    const payload: unknown = await response.json().catch(() => null);
    const details = refusalDetails(payload);

    onDetails(details);

    return { text: getMessage(fallback), failed: true };
  }

  async function upload(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setUploadBusy(true);
    setUploadMessage(null);
    setUploadFieldErrors({});

    try {
      const file = fileRef.current?.files?.[0];

      if (file === undefined) {
        setUploadMessage({ text: getMessage("onboardingDocuments.ruleFileNotAcceptable"), failed: true });

        return;
      }

      // The three month rule, checked on the client before anything is sent: the server checks
      // it again against its own clock, so this is only the picker's early answer.
      const preflight: Record<string, string> = {};

      if (documentType === "") {
        preflight["document_type"] = ruleSentence("required");
      } else if (documentType === "utility_bill" && issuedAt !== "") {
        if (issuedAt > issueWindow.latest) {
          preflight["issued_at"] = ruleSentence("invalid_date");
        } else if (issuedAt < issueWindow.earliest) {
          preflight["issued_at"] = ruleSentence("invalid_range");
        }
      } else if (documentType === "bank_statement") {
        // STEP 086: the two dates are the statement's covered period; the server checks the
        // same rules against its own clock, this is only the picker's early answer.
        if (issuedAt === "") {
          preflight["issued_at"] = ruleSentence("required");
        }

        if (expiresAt === "") {
          preflight["expires_at"] = ruleSentence("required");
        }

        if (issuedAt !== "" && expiresAt !== "" && expiresAt > issuedAt) {
          const recencyCutoff = dateStringMinusMonths(issueWindow.latest, BANK_STATEMENT_MAX_AGE_MONTHS);

          if (expiresAt < recencyCutoff) {
            preflight["expires_at"] = ruleSentence("invalid_range");
          } else if (monthsBetweenDates(issuedAt, expiresAt) < statementPeriodMonths) {
            preflight["expires_at"] = ruleSentence("invalid_range");
          }
        }
      }

      if (Object.keys(preflight).length > 0) {
        setUploadFieldErrors(preflight);
        setUploadMessage({ text: getMessage("onboardingDocuments.uploadFailed"), failed: true });

        return;
      }

      const form = new FormData();

      form.append("file", file);
      form.append("document_type", documentType);
      form.append("issued_at", issuedAt);
      form.append("expires_at", expiresAt);

      // STEP 097: the upload can answer one of the processor's open asks.
      if (requestId !== "") {
        form.append("request_id", requestId);
      }

      const response = await fetch(UPLOAD_PATH, {
        method: "POST",
        // No content-type here: the browser sets the multipart boundary itself.
        headers: { ...(await csrfHeaders()) },
        body: form,
      });

      if (!response.ok) {
        const message = await handleRefusal(response, "onboardingDocuments.uploadFailed", (details) => {
          const next: Record<string, string> = {};

          for (const detail of details) {
            if (typeof detail.field === "string") {
              next[detail.field] = ruleSentence(typeof detail.rule === "string" ? detail.rule : null);
            }
          }

          setUploadFieldErrors(next);
        });

        setUploadMessage(message);

        return;
      }

      setPack(await readPack(response));
      setDocumentType("");
      setRequestId("");
      setIssuedAt("");
      setExpiresAt("");

      if (fileRef.current !== null) {
        fileRef.current.value = "";
      }

      setUploadMessage({ text: getMessage("onboardingDocuments.uploadDone"), failed: false });
      router.refresh();
    } catch {
      setUploadMessage({ text: getMessage("onboardingDocuments.uploadFailed"), failed: true });
    } finally {
      setUploadBusy(false);
    }
  }

  async function addOwner(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setUboBusy(true);
    setUboMessage(null);
    setUboErrors({});

    try {
      const share = uboShare.trim() === "" ? null : Number.parseFloat(uboShare);
      const response = await postJson(UBO_PATH, {
        full_name: uboName,
        date_of_birth: uboDob,
        country: uboCountry,
        ownership_bps:
          share === null || Number.isNaN(share) ? null : Math.round(share * 100),
        id_document_sha256: uboHash,
      });

      if (!response.ok) {
        const message = await handleRefusal(response, "onboardingDocuments.uboFailed", (details) => {
          const next: Record<string, string> = {};

          for (const detail of details) {
            if (typeof detail.field === "string") {
              next[detail.field] = ruleSentence(typeof detail.rule === "string" ? detail.rule : null);
            }
          }

          setUboErrors(next);
        });

        setUboMessage(message);

        return;
      }

      setPack(await readPack(response));
      setUboName("");
      setUboDob("");
      setUboCountry("");
      setUboShare("");
      setUboHash("");
      setUboMessage({ text: getMessage("onboardingDocuments.uboDone"), failed: false });
      router.refresh();
    } catch {
      setUboMessage({ text: getMessage("onboardingDocuments.uboFailed"), failed: true });
    } finally {
      setUboBusy(false);
    }
  }

  async function runScreening(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setScreeningBusy(true);
    setScreeningMessage(null);

    try {
      const response = await postJson(SCREENING_PATH, {});

      if (!response.ok) {
        setScreeningMessage(
          await handleRefusal(response, "onboardingDocuments.screeningFailed", () => {}),
        );

        return;
      }

      const next = await readPack(response);

      setPack(next);
      setScreeningMessage({
        text: formatMessage("onboardingDocuments.screeningDone", { count: next.screenedCount }),
        failed: false,
      });
      router.refresh();
    } catch {
      setScreeningMessage({ text: getMessage("onboardingDocuments.screeningFailed"), failed: true });
    } finally {
      setScreeningBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <section className={sectionClasses}>
        <h2 className={sectionHeadingClasses}>{getMessage("onboardingDocuments.uploadHeading")}</h2>
        <p className={descriptionClasses}>{getMessage("onboardingDocuments.uploadDescription")}</p>
        <form className="flex flex-col gap-3" noValidate onSubmit={(event) => void upload(event)}>
          {uploadMessage === null ? null : (
            <p
              className={uploadMessage.failed ? alertClasses : savedClasses}
              role={uploadMessage.failed ? "alert" : "status"}
              aria-live="polite"
            >
              {uploadMessage.text}
            </p>
          )}
          <label className={labelClasses}>
            <span>{getMessage("onboardingDocuments.docTypeLabel")}</span>
            <select
              className={inputClasses}
              value={documentType}
              onChange={(event) => setDocumentType(event.target.value as KycDocumentType | "")}
            >
              <option value="">{getMessage("onboardingDocuments.docTypePlaceholder")}</option>
              {KYC_DOCUMENT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {getMessage(DOC_TYPE_LABELS[type])}
                </option>
              ))}
            </select>
            <span className={hintClasses}>
              {uploadFieldErrors["document_type"] ?? getMessage("onboardingDocuments.docTypeHint")}
            </span>
          </label>
          {documentType === "processor_request" && pack.openRequests.length > 0 ? (
            <label className={labelClasses}>
              <span>{getMessage("onboardingDocuments.requestSelectLabel")}</span>
              <select
                className={inputClasses}
                value={requestId}
                onChange={(event) => setRequestId(event.target.value)}
              >
                <option value="">{getMessage("onboardingDocuments.requestSelectPlaceholder")}</option>
                {pack.openRequests.map((request) => (
                  <option key={request.id} value={request.id}>
                    {request.documentLabel}
                  </option>
                ))}
              </select>
              <span className={hintClasses}>
                {uploadFieldErrors["request_id"] ?? getMessage("onboardingDocuments.requestSelectHint")}
              </span>
            </label>
          ) : null}
          <label className={labelClasses}>
            <span>{getMessage("onboardingDocuments.fileLabel")}</span>
            <input
              ref={fileRef}
              className={inputClasses}
              type="file"
              accept="application/pdf,image/jpeg,image/png"
              aria-describedby="documents-file-hint"
            />
            <span id="documents-file-hint" className={hintClasses}>
              {uploadFieldErrors["file"] ?? getMessage("onboardingDocuments.fileHint")}
            </span>
          </label>
          <div className="flex flex-col gap-3 sm:flex-row">
            <label className={labelClasses}>
              <span>
                {getMessage(
                  documentType === "bank_statement"
                    ? "onboardingDocuments.statementFromLabel"
                    : "onboardingDocuments.issuedAtLabel",
                )}
              </span>
              <input
                className={inputClasses}
                type="date"
                value={issuedAt}
                max={issueWindow.latest}
                onChange={(event) => setIssuedAt(event.target.value)}
              />
              <span className={hintClasses}>
                {uploadFieldErrors["issued_at"] ??
                  (documentType === "utility_bill"
                    ? formatMessage("onboardingDocuments.utilityBillRuleLine", {
                        months: String(UTILITY_BILL_MAX_AGE_MONTHS),
                      })
                    : documentType === "bank_statement"
                      ? formatMessage("onboardingDocuments.bankStatementRuleLine", {
                          months: String(statementPeriodMonths),
                        })
                      : getMessage("onboardingDocuments.issuedAtHint"))}
              </span>
            </label>
            <label className={labelClasses}>
              <span>
                {getMessage(
                  documentType === "bank_statement"
                    ? "onboardingDocuments.statementToLabel"
                    : "onboardingDocuments.expiresAtLabel",
                )}
              </span>
              <input
                className={inputClasses}
                type="date"
                value={expiresAt}
                max={issueWindow.latest}
                onChange={(event) => setExpiresAt(event.target.value)}
              />
              <span className={hintClasses}>
                {uploadFieldErrors["expires_at"] ?? getMessage("onboardingDocuments.expiresAtHint")}
              </span>
            </label>
          </div>
          <button className={buttonClasses} type="submit" disabled={uploadBusy}>
            {uploadBusy
              ? getMessage("onboardingDocuments.uploadBusy")
              : getMessage("onboardingDocuments.uploadSubmit")}
          </button>
        </form>
      </section>

      <section className={sectionClasses}>
        <h2 className={sectionHeadingClasses}>{getMessage("onboardingDocuments.requestsHeading")}</h2>
        {pack.openRequests.length === 0 ? (
          <p className={descriptionClasses}>{getMessage("onboardingDocuments.requestsEmpty")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {pack.openRequests.map((request) => (
              <li key={request.id} className={rowClasses}>
                <span className="font-semibold">{request.documentLabel}</span>
                <span className={noteClasses}>
                  {formatMessage("onboardingDocuments.requestAskedByLine", {
                    provider: request.providerId,
                  })}
                </span>
                {request.note === null ? null : (
                  <span className={noteClasses}>{request.note}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={sectionClasses}>
        <h2 className={sectionHeadingClasses}>{getMessage("onboardingDocuments.documentsHeading")}</h2>
        {pack.documents.length === 0 ? (
          <p className={descriptionClasses}>{getMessage("onboardingDocuments.documentsEmpty")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {pack.documents.map((document) => (
              <li key={document.id} className={rowClasses}>
                <span className="font-semibold">{getMessage(DOC_TYPE_LABELS[document.documentType])}</span>
                <span className={noteClasses}>
                  {formatMessage("onboardingDocuments.docSizeLine", { bytes: document.byteSize })}
                </span>
                {document.issuedAt === null ? null : (
                  <span className={noteClasses}>
                    {document.documentType === "bank_statement" && document.expiresAt !== null
                      ? formatMessage("onboardingDocuments.docPeriodLine", {
                          from: document.issuedAt,
                          to: document.expiresAt,
                        })
                      : formatMessage("onboardingDocuments.docIssuedLine", { date: document.issuedAt })}
                  </span>
                )}
                <span className={noteClasses}>
                  {getMessage(DOC_STATUS_LABELS[document.status] ?? "onboardingDocuments.docStatusUploaded")}
                </span>
                {document.rejectionReason === null ? null : (
                  <span className={noteClasses}>
                    {formatMessage("onboardingDocuments.docRejectedLine", { reason: document.rejectionReason })}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={sectionClasses}>
        <h2 className={sectionHeadingClasses}>{getMessage("onboardingDocuments.uboHeading")}</h2>
        <p className={descriptionClasses}>{getMessage("onboardingDocuments.uboDescription")}</p>
        <form className="flex flex-col gap-3" noValidate onSubmit={(event) => void addOwner(event)}>
          {uboMessage === null ? null : (
            <p
              className={uboMessage.failed ? alertClasses : savedClasses}
              role={uboMessage.failed ? "alert" : "status"}
              aria-live="polite"
            >
              {uboMessage.text}
            </p>
          )}
          <label className={labelClasses}>
            <span>{getMessage("onboardingDocuments.uboNameLabel")}</span>
            <input
              className={inputClasses}
              type="text"
              value={uboName}
              onChange={(event) => setUboName(event.target.value)}
            />
            <span className={hintClasses}>
              {uboErrors["full_name"] ?? getMessage("onboardingDocuments.uboNameHint")}
            </span>
          </label>
          <label className={labelClasses}>
            <span>{getMessage("onboardingDocuments.uboDobLabel")}</span>
            <input
              className={inputClasses}
              type="date"
              value={uboDob}
              onChange={(event) => setUboDob(event.target.value)}
            />
            <span className={hintClasses}>
              {uboErrors["date_of_birth"] ?? getMessage("onboardingDocuments.uboDobHint")}
            </span>
          </label>
          <label className={labelClasses}>
            <span>{getMessage("onboardingDocuments.uboCountryLabel")}</span>
            <input
              className={inputClasses}
              type="text"
              value={uboCountryFilter}
              placeholder={getMessage("onboardingDocuments.uboCountryFilterLabel")}
              onChange={(event) => setUboCountryFilter(event.target.value)}
            />
            <select
              className={inputClasses}
              value={uboCountry}
              onChange={(event) => setUboCountry(event.target.value)}
            >
              <option value="">{getMessage("onboardingDocuments.uboCountryPlaceholder")}</option>
              {visibleCountries.map((country) => (
                <option key={country.code} value={country.code}>
                  {country.code} - {country.name}
                </option>
              ))}
            </select>
            <span className={hintClasses}>
              {uboErrors["country"] ?? getMessage("onboardingDocuments.uboCountryHint")}
            </span>
          </label>
          <label className={labelClasses}>
            <span>{getMessage("onboardingDocuments.uboShareLabel")}</span>
            <input
              className={inputClasses}
              type="number"
              min={0}
              max={100}
              step="0.01"
              value={uboShare}
              onChange={(event) => setUboShare(event.target.value)}
            />
            <span className={hintClasses}>
              {uboErrors["ownership_bps"] ?? getMessage("onboardingDocuments.uboShareHint")}
            </span>
          </label>
          <label className={labelClasses}>
            <span>{getMessage("onboardingDocuments.uboHashLabel")}</span>
            <input
              className={inputClasses}
              type="text"
              value={uboHash}
              onChange={(event) => setUboHash(event.target.value)}
            />
            <span className={hintClasses}>
              {uboErrors["id_document_sha256"] ?? getMessage("onboardingDocuments.uboHashHint")}
            </span>
          </label>
          <button className={buttonClasses} type="submit" disabled={uboBusy}>
            {uboBusy
              ? getMessage("onboardingDocuments.uboBusy")
              : getMessage("onboardingDocuments.uboSubmit")}
          </button>
        </form>
      </section>

      <section className={sectionClasses}>
        <h2 className={sectionHeadingClasses}>{getMessage("onboardingDocuments.ubosHeading")}</h2>
        {pack.ubos.length === 0 ? (
          <p className={descriptionClasses}>{getMessage("onboardingDocuments.ubosEmpty")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {pack.ubos.map((ubo) => (
              <li key={ubo.id} className={rowClasses}>
                <span className="font-semibold">{ubo.fullName}</span>
                <span className={noteClasses}>
                  {formatMessage("onboardingDocuments.uboShareLine", {
                    percent: Math.round(ubo.ownershipBps) / 100,
                  })}
                </span>
                <span className={noteClasses}>
                  {getMessage(
                    ubo.isSignificant
                      ? "onboardingDocuments.uboSignificant"
                      : "onboardingDocuments.uboNotSignificant",
                  )}
                </span>
                <span className={noteClasses}>
                  {ubo.screenedAt === null
                    ? getMessage("onboardingDocuments.uboNotScreenedLine")
                    : formatMessage("onboardingDocuments.uboScreenedLine", {
                        at: ubo.screenedAt.replace("T", " ").slice(0, 19),
                      })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={sectionClasses}>
        <h2 className={sectionHeadingClasses}>{getMessage("onboardingDocuments.screeningHeading")}</h2>
        <p className={descriptionClasses}>{getMessage("onboardingDocuments.screeningDescription")}</p>
        <form className="flex flex-col gap-3" noValidate onSubmit={(event) => void runScreening(event)}>
          {screeningMessage === null ? null : (
            <p
              className={screeningMessage.failed ? alertClasses : savedClasses}
              role={screeningMessage.failed ? "alert" : "status"}
              aria-live="polite"
            >
              {screeningMessage.text}
            </p>
          )}
          <button className={buttonClasses} type="submit" disabled={screeningBusy}>
            {screeningBusy
              ? getMessage("onboardingDocuments.screeningBusy")
              : getMessage("onboardingDocuments.screeningSubmit")}
          </button>
        </form>
      </section>

      <nav className="flex flex-col gap-2 border-t border-border pt-4 text-sm">
        <Link className={linkClasses} href="/onboarding/review">
          {getMessage("onboarding.step.review.label")}
        </Link>
      </nav>
    </div>
  );
}

const sectionClasses = "flex flex-col gap-3 rounded-sm border border-border p-4";

const sectionHeadingClasses = "text-base font-semibold";

const descriptionClasses = "max-w-3xl text-sm text-muted-foreground";

const noteClasses = "text-xs text-muted-foreground";

const labelClasses = "flex flex-col gap-1 text-sm";

const inputClasses =
  "rounded-sm border border-border bg-background px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-primary";

const hintClasses = "text-xs text-muted-foreground";

const buttonClasses =
  "w-fit rounded-sm bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60";

const alertClasses = "text-sm text-destructive";

const savedClasses = "text-sm text-foreground";

const rowClasses = "flex flex-col gap-1 rounded-sm border border-border p-3 text-sm";

const linkClasses =
  "w-fit rounded-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-primary";
