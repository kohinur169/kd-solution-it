// path: app/(admin)/announcements/announcement-composer.tsx
"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import {
  ANNOUNCEMENT_AUDIENCES,
  ANNOUNCEMENT_BODY_MAXIMUM_LENGTH,
  ANNOUNCEMENT_LEVELS,
  ANNOUNCEMENT_TITLE_MAXIMUM_LENGTH,
  announcementAudienceHintKey,
  announcementAudienceLabelKey,
  announcementLevelHintKey,
  announcementLevelLabelKey,
  calendarDayOf,
} from "@/lib/announcements/registry";
import type {
  AnnouncementAdminSnapshot,
  AnnouncementAdminView,
} from "@/lib/announcements/service";
import { deviceProofHeaders } from "@/lib/auth/device-proof-store";
import { rateLimitSentence } from "@/lib/auth/refusal-message";
import { REAUTHENTICATION_REQUIRED_RULE } from "@/lib/auth/step-up";
import { formatMessage, getMessage, type MessagePath } from "@/lib/i18n/messages";
import { csrfHeaders } from "@/lib/security/csrf-client";

/**
 * The composer: what has been written, and the one form that writes it.
 *
 * ## The three writes are three buttons
 *
 * A draft is saved, published once and stopped once, and each of those is its own press with its own
 * answer. There is no "save and publish" shortcut, because publishing is the moment a sentence becomes
 * what a thousand people read, and a single button that sometimes only saves would be a promise the
 * screen cannot keep.
 *
 * ## Why a published row cannot be edited here
 *
 * The service refuses it, so the form refuses it first: selecting a live or ended announcement shows
 * its words as text and offers the one action that is still true - stopping it. Selecting a draft
 * loads it into the form, and "start a new announcement" empties the form again.
 *
 * ## Why the selection is a value and not a route
 *
 * The list is a hundred rows of text; a per-row URL would be a page per draft and a navigation per
 * keystroke. The selection lives in this component, the server owns the rows, and `router.refresh()`
 * after every successful write re-reads them so the list and the form cannot disagree.
 *
 * ## What a new draft selects
 *
 * After a successful create the answer is the whole snapshot. The row this press created is the one
 * whose id was not in the snapshot before it, so the form switches to editing that draft instead of
 * leaving a filled form that would create a second copy on the next press.
 */

type ComposerAction = "save" | "publish" | "withdraw";

interface RefusalDetail {
  readonly field?: unknown;
  readonly rule?: unknown;
}

function refusalOf(payload: unknown): RefusalDetail | null {
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

  return details[0] as RefusalDetail;
}

/** The sentence for a refused write, in the composer's vocabulary. */
function messageForRefusal(status: number, payload: unknown): string {
  if (status === 429) {
    return rateLimitSentence(payload);
  }

  if (status === 401) {
    return getMessage("announcements.signedOut");
  }

  const detail = refusalOf(payload);
  const rule = typeof detail?.rule === "string" ? detail.rule : "";
  const field = typeof detail?.field === "string" ? detail.field : "";

  if (status === 403) {
    return getMessage(
      rule === REAUTHENTICATION_REQUIRED_RULE
        ? "announcements.reauthRequired"
        : "announcements.forbidden",
    );
  }

  if (status === 404) {
    return getMessage("announcements.missing");
  }

  if (status === 409) {
    if (rule === "published") {
      return getMessage("announcements.publishedLocked");
    }

    if (rule === "not_published") {
      return getMessage("announcements.notPublished");
    }

    if (rule === "ended") {
      return getMessage("announcements.ended");
    }

    return rule === "stale"
      ? getMessage("announcements.stale")
      : getMessage("announcements.conflict");
  }

  if (status === 422) {
    if (field === "title") {
      return getMessage("announcements.titleInvalid");
    }

    if (field === "body") {
      return getMessage("announcements.bodyInvalid");
    }

    if (field === "level") {
      return getMessage("announcements.levelInvalid");
    }

    if (field === "audience") {
      return getMessage("announcements.audienceInvalid");
    }

    if (field === "expiresOn") {
      return getMessage("announcements.expiryInvalid");
    }
  }

  return getMessage("announcements.failed");
}

interface WriteAnswer {
  readonly ok: boolean;
  readonly message: string;
  readonly snapshot: AnnouncementAdminSnapshot | null;
}

async function postWrite(
  action: ComposerAction,
  fields: Readonly<Record<string, string | null>>,
): Promise<WriteAnswer> {
  const path = "/api/office/announcements";
  const body = JSON.stringify({ action, ...fields });
  const proof = await deviceProofHeaders("POST", path, body);

  if (proof === null) {
    return { ok: false, message: getMessage("device.proofRequired"), snapshot: null };
  }

  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...proof, ...(await csrfHeaders()) },
    body,
  });

  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);

    return { ok: false, message: messageForRefusal(response.status, payload), snapshot: null };
  }

  const payload: unknown = await response.json().catch(() => null);

  return {
    ok: true,
    message: "",
    snapshot:
      typeof payload === "object" && payload !== null && "items" in payload
        ? (payload as AnnouncementAdminSnapshot)
        : null,
  };
}

const stackClasses = "flex flex-col gap-6";

const gridClasses =
  "flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] lg:items-start";

const cardClasses =
  "flex flex-col gap-4 rounded-lg border border-border bg-surface p-4 text-foreground shadow-card sm:p-5";

const nameClasses = "text-lg font-semibold tracking-tight";

const badgeClasses =
  "rounded-full border border-border bg-muted/40 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide";

const bodyClasses = "text-sm text-muted-foreground";

const termClasses = "text-sm font-medium text-foreground";

const hintClasses = "text-xs text-muted-foreground";

const inputClasses =
  "mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary";

const primaryButtonClasses =
  "inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60";

const secondaryButtonClasses =
  "inline-flex items-center justify-center rounded-lg border border-border bg-background px-4 py-2 text-sm font-semibold text-foreground transition-opacity hover:opacity-80 disabled:opacity-60";

const dangerButtonClasses =
  "inline-flex items-center justify-center rounded-lg border border-destructive px-4 py-2 text-sm font-semibold text-destructive transition-opacity hover:opacity-80 disabled:opacity-60";

const rowClasses =
  "flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg border border-border bg-background p-3 text-left transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-primary";

const selectedRowClasses =
  "flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg border border-primary bg-background p-3 text-left focus-visible:ring-2 focus-visible:ring-primary";

const listClasses = "flex max-h-96 flex-col gap-2 overflow-y-auto pr-1";

const messageClasses = "text-sm";

/** One instant, printed the same way on every office screen: UTC, minute precision. */
function formatInstant(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** The form's own values, as the operator has them. */
interface DraftFields {
  readonly title: string;
  readonly body: string;
  readonly level: string;
  readonly audience: string;
  readonly expiresOn: string;
}

const emptyDraft: DraftFields = { title: "", body: "", level: "info", audience: "all", expiresOn: "" };

function fieldsOf(row: AnnouncementAdminView): DraftFields {
  return {
    title: row.title,
    body: row.body,
    level: row.level,
    audience: row.audience,
    expiresOn: row.expiresAtEpochMs === null ? "" : calendarDayOf(row.expiresAtEpochMs),
  };
}

export function AnnouncementComposerConsole({
  snapshot,
}: {
  readonly snapshot: AnnouncementAdminSnapshot;
}): ReactNode {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftFields>(emptyDraft);
  const [busy, setBusy] = useState<ComposerAction | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const rows = snapshot.items;
  const selected = rows.find((row) => row.id === selectedId) ?? null;
  const editing = selected !== null && selected.state === "draft";

  function update(patch: Partial<DraftFields>): void {
    setDraft((previous) => ({ ...previous, ...patch }));
  }

  async function run(
    action: ComposerAction,
    fields: Readonly<Record<string, string | null>>,
    done: string,
    selectCreated: boolean,
  ): Promise<void> {
    setBusy(action);
    setMessage(null);

    try {
      const known = new Set(rows.map((row) => row.id));
      const answer = await postWrite(action, fields);

      setBusy(null);

      if (!answer.ok) {
        setMessage(answer.message);

        return;
      }

      setMessage(done);

      if (selectCreated && answer.snapshot !== null) {
        const created = answer.snapshot.items.find(
          (row) => row.state === "draft" && !known.has(row.id),
        );

        if (created !== undefined) {
          setSelectedId(created.id);
          setDraft(fieldsOf(created));
        }
      }

      router.refresh();
    } catch {
      setBusy(null);
      setMessage(getMessage("announcements.failed"));
    }
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();

    void run(
      "save",
      {
        announcementId: editing && selected !== null ? selected.id : null,
        title: draft.title,
        body: draft.body,
        level: draft.level,
        audience: draft.audience,
        expiresOn: draft.expiresOn.length === 0 ? null : draft.expiresOn,
      },
      getMessage("announcements.savedDone"),
      true,
    );
  }

  return (
    <div className={stackClasses}>
      <p className={bodyClasses}>
        {formatMessage("announcements.counts", {
          drafts: snapshot.draftCount,
          live: snapshot.liveCount,
          ended: snapshot.endedCount,
        })}
      </p>

      {snapshot.canManage ? null : (
        <p className={bodyClasses} role="status">
          {getMessage("announcements.readOnly")}
        </p>
      )}

      <div className={gridClasses}>
        <section aria-labelledby="announcements-panel" className="lg:order-2">
          <div className={cardClasses}>
            <h2 className={nameClasses} id="announcements-panel">
              {selected === null
                ? getMessage("announcements.composerHeading")
                : selected.title}
            </h2>

            {editing ? (
              <p className={hintClasses}>
                {formatMessage("announcements.editingDraft", { title: selected?.title ?? "" })}
              </p>
            ) : null}

            {selected !== null && !editing ? (
              <p className={bodyClasses}>{getMessage("announcements.draftLocked")}</p>
            ) : null}

            {snapshot.canManage && (selected === null || editing) ? (
              <form
                className="flex flex-col gap-3"
                onSubmit={(event): void => {
                  submit(event);
                }}
              >
                <p className={hintClasses}>{getMessage("announcements.composerDescription")}</p>

                <label className="block">
                  <span className={bodyClasses}>{getMessage("announcements.fieldTitle")}</span>
                  <input
                    className={inputClasses}
                    maxLength={ANNOUNCEMENT_TITLE_MAXIMUM_LENGTH}
                    name="title"
                    onChange={(event): void => {
                      update({ title: event.target.value });
                    }}
                    required
                    type="text"
                    value={draft.title}
                  />
                  <span className={hintClasses}>{getMessage("announcements.hintTitle")}</span>
                </label>

                <label className="block">
                  <span className={bodyClasses}>{getMessage("announcements.fieldBody")}</span>
                  <textarea
                    className={inputClasses}
                    maxLength={ANNOUNCEMENT_BODY_MAXIMUM_LENGTH}
                    name="body"
                    onChange={(event): void => {
                      update({ body: event.target.value });
                    }}
                    required
                    rows={5}
                    value={draft.body}
                  />
                  <span className={hintClasses}>{getMessage("announcements.hintBody")}</span>
                </label>

                <label className="block">
                  <span className={bodyClasses}>{getMessage("announcements.fieldLevel")}</span>
                  <select
                    className={inputClasses}
                    name="level"
                    onChange={(event): void => {
                      update({ level: event.target.value });
                    }}
                    value={draft.level}
                  >
                    {ANNOUNCEMENT_LEVELS.map((level) => (
                      <option key={level} value={level}>
                        {getMessage(announcementLevelLabelKey(level))}
                      </option>
                    ))}
                  </select>
                  <span className={hintClasses}>
                    {getMessage(
                      announcementLevelHintKey(
                        ANNOUNCEMENT_LEVELS.find((level) => level === draft.level) ?? "info",
                      ),
                    )}
                  </span>
                </label>

                <label className="block">
                  <span className={bodyClasses}>{getMessage("announcements.fieldAudience")}</span>
                  <select
                    className={inputClasses}
                    name="audience"
                    onChange={(event): void => {
                      update({ audience: event.target.value });
                    }}
                    value={draft.audience}
                  >
                    {ANNOUNCEMENT_AUDIENCES.map((audience) => (
                      <option key={audience} value={audience}>
                        {getMessage(announcementAudienceLabelKey(audience))}
                      </option>
                    ))}
                  </select>
                  <span className={hintClasses}>
                    {getMessage(
                      announcementAudienceHintKey(
                        ANNOUNCEMENT_AUDIENCES.find((audience) => audience === draft.audience) ?? "all",
                      ),
                    )}
                  </span>
                </label>

                <label className="block">
                  <span className={bodyClasses}>{getMessage("announcements.fieldExpiresOn")}</span>
                  <input
                    className={inputClasses}
                    name="expiresOn"
                    onChange={(event): void => {
                      update({ expiresOn: event.target.value });
                    }}
                    type="date"
                    value={draft.expiresOn}
                  />
                  <span className={hintClasses}>{getMessage("announcements.hintExpiresOn")}</span>
                </label>

                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <button className={primaryButtonClasses} disabled={busy !== null} type="submit">
                    {busy === "save"
                      ? getMessage("announcements.saveBusy")
                      : getMessage("announcements.saveSubmit")}
                  </button>
                  <button
                    className={secondaryButtonClasses}
                    disabled={busy !== null}
                    onClick={(): void => {
                      setSelectedId(null);
                      setDraft(emptyDraft);
                      setMessage(null);
                    }}
                    type="button"
                  >
                    {getMessage("announcements.newDraft")}
                  </button>
                </div>
              </form>
            ) : null}

            {snapshot.canManage && selected !== null && selected.state === "draft" ? (
              <button
                className={primaryButtonClasses}
                disabled={busy !== null}
                onClick={(): void => {
                  void run(
                    "publish",
                    { announcementId: selected.id },
                    getMessage("announcements.publishedDone"),
                    false,
                  );
                }}
                type="button"
              >
                {busy === "publish"
                  ? getMessage("announcements.publishBusy")
                  : getMessage("announcements.publishSubmit")}
              </button>
            ) : null}

            {snapshot.canManage && selected !== null && selected.state === "live" ? (
              <button
                className={dangerButtonClasses}
                disabled={busy !== null}
                onClick={(): void => {
                  void run(
                    "withdraw",
                    { announcementId: selected.id },
                    getMessage("announcements.withdrawnDone"),
                    false,
                  );
                }}
                type="button"
              >
                {busy === "withdraw"
                  ? getMessage("announcements.withdrawBusy")
                  : getMessage("announcements.withdrawSubmit")}
              </button>
            ) : null}

            {selected === null ? null : (
              <dl className="grid grid-cols-1 gap-1 text-sm sm:grid-cols-[9rem_1fr]">
                <dt className={bodyClasses}>{getMessage("announcements.columnState")}</dt>
                <dd>{getMessage(selected.stateLabelKey as MessagePath)}</dd>
                <dt className={bodyClasses}>{getMessage("announcements.columnAudience")}</dt>
                <dd>{getMessage(selected.audienceLabelKey as MessagePath)}</dd>
                <dt className={bodyClasses}>{getMessage("announcements.columnPublished")}</dt>
                <dd>
                  {selected.publishedAtEpochMs === null
                    ? getMessage("announcements.neverPublished")
                    : formatMessage("announcements.publishedAt", {
                        at: formatInstant(selected.publishedAtEpochMs),
                      })}
                </dd>
                <dt className={bodyClasses}>{getMessage("announcements.columnExpires")}</dt>
                <dd>
                  {selected.expiresAtEpochMs === null
                    ? getMessage("announcements.noExpiry")
                    : formatMessage("announcements.publishedAt", {
                        at: formatInstant(selected.expiresAtEpochMs),
                      })}
                </dd>
              </dl>
            )}

            {message === null ? null : (
              <p className={messageClasses} role="status">
                {message}
              </p>
            )}
          </div>
        </section>

        <section aria-labelledby="announcements-list-heading" className={`${cardClasses} lg:order-1`}>
          <div className="flex flex-col gap-2">
            <h2 className={nameClasses} id="announcements-list-heading">
              {getMessage("announcements.listHeading")}
            </h2>
            <p className={bodyClasses}>{getMessage("announcements.listDescription")}</p>
          </div>

          {rows.length === 0 ? (
            <p className={bodyClasses}>{getMessage("announcements.listEmpty")}</p>
          ) : (
            <ul className={listClasses}>
              {rows.map((row) => (
                <li key={row.id}>
                  <button
                    aria-pressed={row.id === selectedId}
                    className={row.id === selectedId ? selectedRowClasses : rowClasses}
                    onClick={(): void => {
                      setSelectedId(row.id);
                      setMessage(null);

                      if (row.state === "draft") {
                        setDraft(fieldsOf(row));
                      }
                    }}
                    type="button"
                  >
                    <span className="flex flex-col gap-1">
                      <span className={termClasses}>{row.title}</span>
                      <span className={hintClasses}>
                        {`${getMessage(row.levelLabelKey as MessagePath)} - ${getMessage(
                          row.audienceLabelKey as MessagePath,
                        )}`}
                      </span>
                    </span>
                    <span className={badgeClasses}>{getMessage(row.stateLabelKey as MessagePath)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
