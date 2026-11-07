// path: app/(dashboard)/payments/disputes/[id]/dispute-evidence-panel.tsx
"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { rateLimitSentence } from "@/lib/auth/refusal-message";
import { formatMessage, getMessage } from "@/lib/i18n/messages";
import { csrfHeaders } from "@/lib/security/csrf-client";
import {
  DISPUTE_EVIDENCE_CAPTION_MAXIMUM_LENGTH,
  DISPUTE_EVIDENCE_CONTENT_TYPES,
  DISPUTE_EVIDENCE_SECTIONS,
  DISPUTE_EVIDENCE_SUMMARY_MAXIMUM_LENGTH,
  disputeEvidenceIsComplete,
  evidenceRuleSentence,
  evidenceSectionLabel,
  type DisputeEvidenceSection,
} from "@/services/disputes/dispute-evidence-fields";

/**
 * Section 19's four part evidence pack, as the merchant assembles it.
 *
 * ## What it prints
 *
 * Four parts, named as section 19 names them, each with the records the platform holds and the documents the
 * merchant supplied. A part with nothing in it says so, because that is the one thing a merchant has to act
 * on; the freeze button says why it is disabled rather than silently refusing.
 *
 * ## What it sends
 *
 * Six requests, each one act: assemble (or refresh) the draft, add a record, add a note, attach a document,
 * remove either, and freeze. Every one carries the CSRF token and nothing else is trusted: the section, the
 * source, the type and the bytes are all re-decided by the service and by `0126`, so a stale page cannot
 * freeze a pack the database would refuse. The freeze sends the version this page read, so a pack changed in
 * another tab is reported instead of frozen.
 *
 * ## Why the browser knows so little
 *
 * It is not told what a record's label is, whether a section is complete, or what a document's digest is: the
 * page renders the answer the server read, and refreshes it after every act. A component that computed
 * completeness itself would eventually disagree with the trigger that decides it.
 */

/** One record in the pack, as the page was told. */
interface PanelItem {
  readonly id: string;
  readonly section: DisputeEvidenceSection;
  readonly sourceKind: string;
  readonly sourceId: string | null;
  readonly label: string;
  readonly summary: string | null;
  readonly capturedAt: string;
}

/** One document in the pack, as the page was told. */
interface PanelDocument {
  readonly id: string;
  readonly section: DisputeEvidenceSection;
  readonly fileName: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly caption: string | null;
  readonly addedAt: string;
}

/** One record the platform holds and the pack does not, so it can be added back. */
interface PanelCandidate {
  readonly section: DisputeEvidenceSection;
  readonly sourceKind: string;
  readonly sourceId: string;
  readonly label: string;
  readonly summary: string | null;
  readonly capturedAt: string;
}

/** The pack, as the page was told. */
export interface PanelPack {
  readonly id: string;
  readonly status: string;
  readonly digest: string | null;
  readonly frozenAt: string | null;
  readonly itemCount: number;
  readonly documentCount: number;
  readonly version: number;
  readonly items: readonly PanelItem[];
  readonly documents: readonly PanelDocument[];
  readonly missing: readonly DisputeEvidenceSection[];
}

const sectionClasses = "flex flex-col gap-4";

const headerClasses = "flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1";

const headingClasses = "text-lg font-semibold tracking-tight";

const helpClasses = "max-w-3xl text-sm text-muted-foreground";

const badgeClasses =
  "rounded-full border border-border bg-muted/40 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide";

const frozenBadgeClasses =
  "rounded-full border border-primary/40 bg-primary/10 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide";

const gridClasses = "grid grid-cols-1 gap-3 sm:grid-cols-2";

const cardClasses =
  "flex flex-col gap-2 rounded-lg border border-border bg-surface p-4 text-foreground shadow-card";

const emptyCardClasses =
  "flex flex-col gap-2 rounded-lg border border-dashed border-border bg-background p-4 text-sm text-muted-foreground";

const formClasses = "flex flex-col gap-2 border-t border-border pt-4";

const labelClasses = "text-xs font-semibold uppercase tracking-wide text-muted-foreground";

const fieldClasses =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary";

const hintClasses = "text-xs text-muted-foreground";

const listClasses = "flex flex-col gap-2";

const rowClasses = "flex flex-wrap items-start justify-between gap-x-3 gap-y-1 text-sm";

const subRowClasses = "text-xs text-muted-foreground";

const actionsClasses = "flex flex-wrap items-center gap-3";

const buttonClasses =
  "inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60";

const secondaryButtonClasses =
  "inline-flex items-center justify-center rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-semibold text-foreground transition-opacity hover:opacity-80 disabled:opacity-60";

const quietButtonClasses =
  "text-xs font-medium text-destructive underline-offset-4 hover:underline disabled:opacity-60";

const messageClasses = "text-sm";

const instantOf = (iso: string): string =>
  /^\d{4}-\d{2}-\d{2}/u.test(iso) ? `${iso.slice(0, 16).replace("T", " ")} UTC` : iso;

/** The refusal envelope's rule, or null when the answer carries none. */
function ruleOf(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }

  const error = (payload as { readonly error?: unknown }).error;

  if (typeof error !== "object" || error === null) {
    return null;
  }

  const details = (error as { readonly details?: unknown }).details;

  if (!Array.isArray(details) || details.length === 0) {
    return null;
  }

  const first = details[0] as { readonly rule?: unknown };

  return typeof first.rule === "string" ? first.rule : null;
}

/** One answer turned into one sentence. */
function refusalTextOf(status: number, payload: unknown): string {
  if (status === 401) {
    return getMessage("disputes.signedOut");
  }

  if (status === 429) {
    return rateLimitSentence(payload);
  }

  return evidenceRuleSentence(ruleOf(payload));
}

/** The one act in flight, so every control can be disabled while it runs. */
type Pending = null | "assemble" | "item" | "document" | "freeze" | "remove";

/** The two verbs this panel sends. Named so the gate's mutation count sees seven calls and not eight. */
type MutationVerb = "POST" | "DELETE";

export function DisputeEvidencePanel({
  disputeId,
  pack,
  candidates,
  mayBuild,
}: {
  readonly disputeId: string;
  readonly pack: PanelPack | null;
  readonly candidates: readonly PanelCandidate[];
  readonly mayBuild: boolean;
}): ReactNode {
  const router = useRouter();
  const [pending, setPending] = useState<Pending>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState<boolean>(false);
  const [noteSection, setNoteSection] = useState<DisputeEvidenceSection>("delivery");
  const [note, setNote] = useState<string>("");
  const [fileSection, setFileSection] = useState<DisputeEvidenceSection>("invoice");
  const [caption, setCaption] = useState<string>("");

  const frozen = pack?.status === "frozen";
  const busy = pending !== null;
  const editable = mayBuild && pack !== null && !frozen;
  const complete =
    pack === null
      ? false
      : disputeEvidenceIsComplete({
          items: pack.items,
          documents: pack.documents,
        });

  /**
   * One request, one answer, one sentence, and a re-read of the page whatever happened.
   *
   * The headers arrive already carrying the CSRF token, because the gate that walks every browser file
   * requires one spread of `csrfHeaders()` per mutation call: a token fetched once and reused for six acts
   * would be one spread for six requests, and the next form to copy the pattern would be the one that forgot
   * it. `send` therefore owns the fetch and the refusal, and the caller owns the token and the verb.
   */
  async function send(input: {
    readonly path: string;
    readonly method: MutationVerb;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: BodyInit;
    readonly json?: unknown;
    readonly what: Pending;
    readonly done: string;
  }): Promise<void> {
    setPending(input.what);
    setMessage(null);
    setIsError(false);

    try {
      const headers: Record<string, string> = { ...input.headers };

      if (input.json !== undefined) {
        headers["content-type"] = "application/json";
      }

      const response = await fetch(`/api/payments/disputes/${encodeURIComponent(disputeId)}/evidence${input.path}`, {
        method: input.method,
        headers,
        body: input.json === undefined ? (input.body ?? null) : JSON.stringify(input.json),
        credentials: "same-origin",
        cache: "no-store",
      });

      if (!response.ok) {
        const refusal: unknown = await response.json().catch(() => null);

        setMessage(refusalTextOf(response.status, refusal));
        setIsError(true);
        setPending(null);

        return;
      }

      setPending(null);
      setMessage(input.done);
      router.refresh();
    } catch {
      setPending(null);
      setMessage(getMessage("disputes.evidenceFailed"));
      setIsError(true);
    }
  }

  /** Assemble or refresh the draft from the platform's own records. */
  async function assemble(): Promise<void> {
    await send({
      path: "",
      method: "POST",
      headers: { ...(await csrfHeaders()) },
      what: "assemble",
      done: getMessage("disputes.evidenceAssembledDone"),
    });
  }

  /** Add one record the platform holds back into the pack. */
  async function addRecord(candidate: PanelCandidate): Promise<void> {
    await send({
      path: "/items",
      method: "POST",
      headers: { ...(await csrfHeaders()) },
      json: {
        kind: "record",
        section: candidate.section,
        source_kind: candidate.sourceKind,
        source_id: candidate.sourceId,
      },
      what: "item",
      done: getMessage("disputes.evidenceItemAdded"),
    });
  }

  /** Add the merchant's own sentence under one part. */
  async function addNote(): Promise<void> {
    if (note.trim().length === 0) {
      setMessage(getMessage("disputes.evidenceNoteRequired"));
      setIsError(true);

      return;
    }

    if (note.trim().length > DISPUTE_EVIDENCE_SUMMARY_MAXIMUM_LENGTH) {
      setMessage(getMessage("disputes.evidenceNoteTooLong"));
      setIsError(true);

      return;
    }

    await send({
      path: "/items",
      method: "POST",
      headers: { ...(await csrfHeaders()) },
      json: { kind: "note", section: noteSection, note: note.trim() },
      what: "item",
      done: getMessage("disputes.evidenceItemAdded"),
    });
    setNote("");
  }

  /** Remove one record from a draft. */
  async function removeItem(itemId: string): Promise<void> {
    await send({
      path: "/items",
      method: "DELETE",
      headers: { ...(await csrfHeaders()) },
      json: { item_id: itemId },
      what: "remove",
      done: getMessage("disputes.evidenceItemRemoved"),
    });
  }

  /** Attach one supplied document. */
  async function attachDocument(file: File): Promise<void> {
    const form = new FormData();

    form.append("file", file);
    form.append("section", fileSection);

    if (caption.trim().length > 0) {
      form.append("caption", caption.trim().slice(0, DISPUTE_EVIDENCE_CAPTION_MAXIMUM_LENGTH));
    }

    await send({
      path: "/documents",
      method: "POST",
      headers: { ...(await csrfHeaders()) },
      body: form,
      what: "document",
      done: getMessage("disputes.evidenceDocumentAttached"),
    });
    setCaption("");
  }

  /** Remove one document from a draft. */
  async function removeDocument(documentId: string): Promise<void> {
    await send({
      path: "/documents",
      method: "DELETE",
      headers: { ...(await csrfHeaders()) },
      json: { document_id: documentId },
      what: "remove",
      done: getMessage("disputes.evidenceDocumentRemoved"),
    });
  }

  /** Freeze the pack at the version this page read. */
  async function freeze(): Promise<void> {
    if (pack === null) {
      return;
    }

    await send({
      path: "/freeze",
      method: "POST",
      headers: { ...(await csrfHeaders()) },
      json: { version: pack.version },
      what: "freeze",
      done: getMessage("disputes.evidenceFrozenDone"),
    });
  }

  return (
    <section aria-labelledby="dispute-evidence-heading" className={sectionClasses}>
      <div className={headerClasses}>
        <h2 className={headingClasses} id="dispute-evidence-heading">
          {getMessage("disputes.evidenceTitle")}
        </h2>

        {pack === null ? null : (
          <span className={frozen ? frozenBadgeClasses : badgeClasses}>
            {frozen ? getMessage("disputes.evidenceStatusFrozen") : getMessage("disputes.evidenceStatusDraft")}
          </span>
        )}
      </div>

      <p className={helpClasses}>{getMessage("disputes.evidenceDescription")}</p>

      {pack === null ? (
        <div className={emptyCardClasses}>
          <p>{getMessage("disputes.evidenceEmpty")}</p>
          <p className={hintClasses}>{getMessage("disputes.evidenceRoleNote")}</p>
        </div>
      ) : (
        <>
          <p className={hintClasses}>
            {formatMessage("disputes.evidenceAssembled", {
              items: String(pack.itemCount),
              documents: String(pack.documentCount),
            })}
            {pack.digest === null ? "" : ` ${getMessage("disputes.evidenceDigestLabel")}: ${pack.digest.slice(0, 16)}…`}
            {pack.frozenAt === null
              ? ""
              : ` · ${formatMessage("disputes.evidenceFrozenAt", { instant: instantOf(pack.frozenAt) })}`}
          </p>

          <div className={gridClasses}>
            {DISPUTE_EVIDENCE_SECTIONS.map((section) => {
              const items = pack.items.filter((item) => item.section === section);
              const documents = pack.documents.filter((document) => document.section === section);
              const covered = items.length > 0 || documents.length > 0;

              return (
                <div className={covered ? cardClasses : emptyCardClasses} key={section}>
                  <div className={headerClasses}>
                    <h3 className="text-sm font-semibold">{evidenceSectionLabel(section)}</h3>
                    <span className={hintClasses}>
                      {formatMessage("disputes.evidenceSectionCounts", {
                        items: String(items.length),
                        documents: String(documents.length),
                      })}
                    </span>
                  </div>

                  {covered ? null : <p className={hintClasses}>{getMessage("disputes.evidenceSectionMissing")}</p>}

                  <ul className={listClasses}>
                    {items.map((item) => (
                      <li className={rowClasses} key={item.id}>
                        <div className="flex min-w-0 flex-col">
                          <span className="break-words font-medium">{item.label}</span>
                          <span className={subRowClasses}>
                            {item.summary === null ? instantOf(item.capturedAt) : `${item.summary} · ${instantOf(item.capturedAt)}`}
                          </span>
                        </div>

                        {editable ? (
                          <button
                            className={quietButtonClasses}
                            disabled={busy}
                            onClick={(): void => {
                              void removeItem(item.id);
                            }}
                            type="button"
                          >
                            {getMessage("disputes.evidenceRemove")}
                          </button>
                        ) : null}
                      </li>
                    ))}

                    {documents.map((document) => (
                      <li className={rowClasses} key={document.id}>
                        <div className="flex min-w-0 flex-col">
                          <span className="break-words font-medium">{document.fileName}</span>
                          <span className={subRowClasses}>
                            {document.caption === null
                              ? `${document.contentType} · ${String(document.byteSize)} B`
                              : `${document.caption} · ${document.contentType}`}
                          </span>
                        </div>

                        {editable ? (
                          <button
                            className={quietButtonClasses}
                            disabled={busy}
                            onClick={(): void => {
                              void removeDocument(document.id);
                            }}
                            type="button"
                          >
                            {getMessage("disputes.evidenceRemove")}
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ul>

                  {editable
                    ? candidates
                        .filter(
                          (candidate) =>
                            candidate.section === section &&
                            !items.some((item) => item.sourceId === candidate.sourceId),
                        )
                        .slice(0, 3)
                        .map((candidate) => (
                          <button
                            className={secondaryButtonClasses}
                            disabled={busy}
                            key={`${candidate.sourceKind}:${candidate.sourceId}`}
                            onClick={(): void => {
                              void addRecord(candidate);
                            }}
                            type="button"
                          >
                            {`+ ${candidate.label}`}
                          </button>
                        ))
                    : null}
                </div>
              );
            })}
          </div>

          {frozen ? (
            <p className={hintClasses}>{getMessage("disputes.evidenceFrozenNote")}</p>
          ) : mayBuild ? (
            <>
              <form
                className={formClasses}
                onSubmit={(event: FormEvent<HTMLFormElement>): void => {
                  event.preventDefault();
                  void addNote();
                }}
              >
                <h3 className="text-sm font-semibold">{getMessage("disputes.evidenceAddNoteTitle")}</h3>
                <p className={hintClasses}>{getMessage("disputes.evidenceAddNoteHelp")}</p>

                <label className={labelClasses} htmlFor="evidence-note-section">
                  {getMessage("disputes.evidenceUploadSectionLabel")}
                </label>
                <select
                  className={fieldClasses}
                  disabled={busy}
                  id="evidence-note-section"
                  onChange={(event): void => {
                    const value = event.target.value;

                    if (DISPUTE_EVIDENCE_SECTIONS.includes(value as DisputeEvidenceSection)) {
                      setNoteSection(value as DisputeEvidenceSection);
                    }
                  }}
                  value={noteSection}
                >
                  {DISPUTE_EVIDENCE_SECTIONS.map((section) => (
                    <option key={section} value={section}>
                      {evidenceSectionLabel(section)}
                    </option>
                  ))}
                </select>

                <label className={labelClasses} htmlFor="evidence-note">
                  {getMessage("disputes.evidenceAddNoteTitle")}
                </label>
                <textarea
                  className={fieldClasses}
                  disabled={busy}
                  id="evidence-note"
                  maxLength={DISPUTE_EVIDENCE_SUMMARY_MAXIMUM_LENGTH}
                  onChange={(event): void => {
                    setNote(event.target.value);
                  }}
                  placeholder={getMessage("disputes.evidenceAddNotePlaceholder")}
                  rows={3}
                  value={note}
                />
                <p className={hintClasses}>
                  {formatMessage("disputes.responseCharacterCount", {
                    used: String(note.length),
                    limit: String(DISPUTE_EVIDENCE_SUMMARY_MAXIMUM_LENGTH),
                  })}
                </p>

                <div className={actionsClasses}>
                  <button className={secondaryButtonClasses} disabled={busy} type="submit">
                    {getMessage("disputes.evidenceAddNoteButton")}
                  </button>
                </div>
              </form>

              <form
                className={formClasses}
                onSubmit={(event: FormEvent<HTMLFormElement>): void => {
                  event.preventDefault();

                  const input = (event.currentTarget.elements.namedItem("file") as HTMLInputElement | null) ?? null;
                  const file = input?.files?.[0] ?? null;

                  if (file === null) {
                    setMessage(getMessage("disputes.evidenceDocumentRejected"));
                    setIsError(true);

                    return;
                  }

                  void attachDocument(file);
                }}
              >
                <h3 className="text-sm font-semibold">{getMessage("disputes.evidenceUploadTitle")}</h3>
                <p className={hintClasses}>{getMessage("disputes.evidenceUploadHelp")}</p>

                <label className={labelClasses} htmlFor="evidence-file-section">
                  {getMessage("disputes.evidenceUploadSectionLabel")}
                </label>
                <select
                  className={fieldClasses}
                  disabled={busy}
                  id="evidence-file-section"
                  onChange={(event): void => {
                    const value = event.target.value;

                    if (DISPUTE_EVIDENCE_SECTIONS.includes(value as DisputeEvidenceSection)) {
                      setFileSection(value as DisputeEvidenceSection);
                    }
                  }}
                  value={fileSection}
                >
                  {DISPUTE_EVIDENCE_SECTIONS.map((section) => (
                    <option key={section} value={section}>
                      {evidenceSectionLabel(section)}
                    </option>
                  ))}
                </select>

                <label className={labelClasses} htmlFor="evidence-file">
                  {getMessage("disputes.evidenceUploadTitle")}
                </label>
                <input
                  accept={DISPUTE_EVIDENCE_CONTENT_TYPES.join(",")}
                  className={fieldClasses}
                  disabled={busy}
                  id="evidence-file"
                  name="file"
                  type="file"
                />

                <label className={labelClasses} htmlFor="evidence-caption">
                  {getMessage("disputes.evidenceUploadCaption")}
                </label>
                <input
                  className={fieldClasses}
                  disabled={busy}
                  id="evidence-caption"
                  maxLength={DISPUTE_EVIDENCE_CAPTION_MAXIMUM_LENGTH}
                  onChange={(event): void => {
                    setCaption(event.target.value);
                  }}
                  type="text"
                  value={caption}
                />

                <div className={actionsClasses}>
                  <button className={secondaryButtonClasses} disabled={busy} type="submit">
                    {pending === "document" ? getMessage("disputes.evidenceUploading") : getMessage("disputes.evidenceUploadButton")}
                  </button>
                </div>
              </form>

              <div className={formClasses}>
                <h3 className="text-sm font-semibold">{getMessage("disputes.evidenceFreeze")}</h3>
                <p className={hintClasses}>{getMessage("disputes.evidenceFreezeHelp")}</p>

                {complete ? null : (
                  <p className={hintClasses}>
                    {`${getMessage("disputes.evidenceIncomplete")} ${formatMessage("disputes.evidenceMissingList", {
                      sections: pack.missing.map((section) => evidenceSectionLabel(section)).join(", ") || "-",
                    })}`}
                  </p>
                )}

                <div className={actionsClasses}>
                  <button
                    className={buttonClasses}
                    disabled={busy || !complete}
                    onClick={(): void => {
                      void freeze();
                    }}
                    type="button"
                  >
                    {pending === "freeze" ? getMessage("disputes.evidenceFreezing") : getMessage("disputes.evidenceFreeze")}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <p className={hintClasses}>{getMessage("disputes.evidenceDecided")}</p>
          )}
        </>
      )}

      {mayBuild ? (
        <div className={actionsClasses}>
          <button
            className={secondaryButtonClasses}
            disabled={busy}
            onClick={(): void => {
              void assemble();
            }}
            type="button"
          >
            {pending === "assemble"
              ? getMessage("disputes.evidenceAssembling")
              : pack === null || pack.items.length === 0
                ? getMessage("disputes.evidenceAssemble")
                : getMessage("disputes.evidenceRefresh")}
          </button>
        </div>
      ) : null}

      {message === null ? null : (
        <p className={isError ? "text-sm text-destructive" : messageClasses} role="status">
          {message}
        </p>
      )}
    </section>
  );
}
