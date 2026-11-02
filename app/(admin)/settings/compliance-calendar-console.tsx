// path: app/(admin)/settings/compliance-calendar-console.tsx
"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { deviceProofHeaders } from "@/lib/auth/device-proof-store";
import { rateLimitSentence } from "@/lib/auth/refusal-message";
import { REAUTHENTICATION_REQUIRED_RULE } from "@/lib/auth/step-up";
import {
  COMPLIANCE_ALERT_MAXIMUM_DAYS,
  COMPLIANCE_ALERT_MINIMUM_DAYS,
  COMPLIANCE_DEFAULT_ALERT_DAYS,
  COMPLIANCE_ISSUER_MAXIMUM_LENGTH,
  COMPLIANCE_ITEM_KINDS,
  COMPLIANCE_NOTE_MAXIMUM_LENGTH,
  COMPLIANCE_REFERENCE_MAXIMUM_LENGTH,
  COMPLIANCE_TITLE_MAXIMUM_LENGTH,
  complianceKindLabelKey,
} from "@/lib/settings/registry";
import type { ComplianceCalendarSnapshot, ComplianceItemView } from "@/lib/settings/service";
import { formatMessage, getMessage, type MessagePath } from "@/lib/i18n/messages";
import { csrfHeaders } from "@/lib/security/csrf-client";

/**
 * Section 3's compliance calendar: the renewals, their warning windows, and the four things an officer
 * does with them.
 *
 * ## What this component does and does not decide
 *
 * The roles, the two dates, the alert window and every length live in `lib/settings/registry.ts` and
 * `lib/settings/service.ts`. This component renders what the server sent and posts one body per action.
 * `canManage` arrives with the snapshot, so the CEO's read-only view is the same screen minus the
 * forms rather than a second screen that could drift.
 *
 * ## Why the list and the panel are separate
 *
 * The calendar is a year of renewals plus its history, and the actions are per item: renew the one that
 * is about to lapse, archive the one that no longer applies. One panel means one place a date is typed
 * and one button is pressed, and the panel's state is per item, so a renewal typed for one certificate
 * cannot be filed against another.
 *
 * ## The check is a button because the schedule is not built
 *
 * Section 27 lists "compliance calendar expiry alerts" as a background job, and `lib/jobs` still has no
 * database store. The button is what a deployment without a scheduler needs: the same function the job
 * will call, run by the officer who is looking at the calendar, with the run counted and audited.
 */

type CalendarAction = "add" | "renew" | "archive" | "check";

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

/** The sentence for a refused rule, in the calendar's vocabulary. */
function messageForRule(rule: string): string {
  if (rule === "invalid_date") {
    return getMessage("officeSettings.dateInvalid");
  }

  if (rule === "not_after_issue") {
    return getMessage("officeSettings.periodInvalid");
  }

  if (rule === "invalid_range") {
    return getMessage("officeSettings.alertRangeInvalid");
  }

  if (rule === "invalid_format") {
    return getMessage("officeSettings.kindInvalid");
  }

  if (rule === "closed") {
    return getMessage("officeSettings.itemClosed");
  }

  if (rule === "already_archived") {
    return getMessage("officeSettings.alreadyArchived");
  }

  if (rule === "stale") {
    return getMessage("officeSettings.staleItem");
  }

  if (rule === "invalid_length") {
    return getMessage("officeSettings.titleInvalid");
  }

  return getMessage("officeSettings.failed");
}

function messageForStatus(status: number, payload: unknown): string {
  if (status === 429) {
    return rateLimitSentence(payload);
  }

  if (status === 401) {
    return getMessage("officeSettings.signedOut");
  }

  const detail = refusalOf(payload);

  if (status === 403) {
    return getMessage(
      detail?.rule === REAUTHENTICATION_REQUIRED_RULE
        ? "officeSettings.reauthRequired"
        : "officeSettings.forbidden",
    );
  }

  if (status === 404) {
    return getMessage("officeSettings.itemMissing");
  }

  if (status === 422 && typeof detail?.rule === "string") {
    return messageForRule(detail.rule);
  }

  if (status === 409) {
    return getMessage("officeSettings.conflict");
  }

  return getMessage("officeSettings.failed");
}

interface ActionAnswer {
  readonly ok: boolean;
  readonly message: string;
  readonly expired: number | null;
  readonly alerted: number | null;
}

async function postAction(
  action: CalendarAction,
  fields: Readonly<Record<string, string | number>>,
): Promise<ActionAnswer> {
  const path = "/api/office/compliance-calendar";
  const body = JSON.stringify({ action, ...fields });
  const proof = await deviceProofHeaders("POST", path, body);

  if (proof === null) {
    return { ok: false, message: getMessage("device.proofRequired"), expired: null, alerted: null };
  }

  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...proof, ...(await csrfHeaders()) },
    body,
  });

  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);

    return { ok: false, message: messageForStatus(response.status, payload), expired: null, alerted: null };
  }

  const payload: unknown = await response.json().catch(() => null);

  if (typeof payload !== "object" || payload === null) {
    return { ok: true, message: "", expired: null, alerted: null };
  }

  const answer = payload as { readonly expired?: unknown; readonly alerted?: unknown };

  return {
    ok: true,
    message: "",
    expired: typeof answer.expired === "number" ? answer.expired : null,
    alerted: typeof answer.alerted === "number" ? answer.alerted : null,
  };
}

const cardClasses =
  "flex flex-col gap-4 rounded-lg border border-border bg-surface p-4 text-foreground shadow-card sm:p-5";

const headerClasses = "flex flex-wrap items-center gap-x-3 gap-y-1";

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

const gridClasses =
  "flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] lg:items-start";

const messageClasses = "text-sm";

/** One instant, printed the same way on every office screen: UTC, minute precision. */
function formatInstant(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** What is left of an item's window, as the row prints it. */
function remainingLabel(item: ComplianceItemView): string {
  if (item.daysRemaining === null) {
    return item.expiresOn;
  }

  return item.daysRemaining < 0
    ? formatMessage("officeSettings.daysOverdue", { days: Math.abs(item.daysRemaining) })
    : formatMessage("officeSettings.daysLeft", { days: item.daysRemaining });
}

/** The one item the panel acts on. */
function ItemPanel({
  item,
  canManage,
  onResult,
}: {
  readonly item: ComplianceItemView;
  readonly canManage: boolean;
  readonly onResult: (text: string) => void;
}): ReactNode {
  const router = useRouter();
  const [busy, setBusy] = useState<CalendarAction | null>(null);
  const [expiresOn, setExpiresOn] = useState("");
  const [reference, setReference] = useState(item.reference ?? "");
  const [message, setMessage] = useState<string | null>(null);

  async function run(
    action: CalendarAction,
    fields: Readonly<Record<string, string | number>>,
    done: string,
  ): Promise<void> {
    setBusy(action);
    setMessage(null);

    try {
      const answer = await postAction(action, fields);

      setBusy(null);

      if (!answer.ok) {
        setMessage(answer.message);

        return;
      }

      setExpiresOn("");
      setMessage(done);
      onResult(done);
      router.refresh();
    } catch {
      setBusy(null);
      setMessage(getMessage("officeSettings.failed"));
    }
  }

  const closed = item.status === "renewed" || item.status === "archived";

  return (
    <section aria-labelledby="compliance-panel" className={cardClasses}>
      <header className={headerClasses}>
        <h3 className={nameClasses} id="compliance-panel">
          {item.title}
        </h3>
        <span className={badgeClasses}>{getMessage(item.kindLabelKey as MessagePath)}</span>
        <span className={badgeClasses}>{getMessage(item.stateLabelKey as MessagePath)}</span>
        <span className={badgeClasses}>{getMessage(item.statusLabelKey as MessagePath)}</span>
      </header>

      <dl className="grid grid-cols-1 gap-1 text-sm sm:grid-cols-[10rem_1fr]">
        <dt className={bodyClasses}>{getMessage("officeSettings.fieldIssuer")}</dt>
        <dd>{item.issuer}</dd>
        <dt className={bodyClasses}>{getMessage("officeSettings.columnExpires")}</dt>
        <dd>{formatMessage("officeSettings.expiresOn", { date: item.expiresOn })}</dd>
        <dt className={bodyClasses}>{getMessage("officeSettings.columnDays")}</dt>
        <dd>{remainingLabel(item)}</dd>
        <dt className={bodyClasses}>{getMessage("officeSettings.columnAlert")}</dt>
        <dd>{formatMessage("officeSettings.alertWindow", { days: item.alertDays })}</dd>
        <dt className={bodyClasses}>{getMessage("officeSettings.columnStatus")}</dt>
        <dd>
          {item.lastAlertAtEpochMs === null
            ? getMessage("officeSettings.neverWarned")
            : formatMessage("officeSettings.lastAlert", { at: formatInstant(item.lastAlertAtEpochMs) })}
        </dd>
        {item.renewedAtEpochMs === null ? null : (
          <>
            <dt className={bodyClasses}>{getMessage("officeSettings.statusRenewed")}</dt>
            <dd>{formatMessage("officeSettings.renewedAt", { at: formatInstant(item.renewedAtEpochMs) })}</dd>
          </>
        )}
      </dl>

      {item.note === null ? null : (
        <p className={bodyClasses}>{`${getMessage("officeSettings.noteLabel")}: ${item.note}`}</p>
      )}

      {canManage && !closed ? (
        <form
          className="flex flex-col gap-2 border-t border-border pt-4"
          onSubmit={(event: FormEvent<HTMLFormElement>): void => {
            event.preventDefault();
            void run("renew", { itemId: item.id, expiresOn, reference }, getMessage("officeSettings.renewedDone"));
          }}
        >
          <p className={termClasses}>{getMessage("officeSettings.renewHeading")}</p>
          <p className={bodyClasses}>{getMessage("officeSettings.renewDescription")}</p>
          <label className="block">
            <span className={bodyClasses}>{getMessage("officeSettings.fieldRenewExpiresOn")}</span>
            <input
              className={inputClasses}
              name="expiresOn"
              onChange={(event): void => {
                setExpiresOn(event.target.value);
              }}
              required
              type="date"
              value={expiresOn}
            />
          </label>
          <label className="block">
            <span className={bodyClasses}>{getMessage("officeSettings.fieldReference")}</span>
            <input
              className={inputClasses}
              maxLength={COMPLIANCE_REFERENCE_MAXIMUM_LENGTH}
              name="reference"
              onChange={(event): void => {
                setReference(event.target.value);
              }}
              type="text"
              value={reference}
            />
          </label>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <button className={primaryButtonClasses} disabled={busy !== null} type="submit">
              {busy === "renew"
                ? getMessage("officeSettings.renewBusy")
                : getMessage("officeSettings.renewSubmit")}
            </button>
            <button
              className={dangerButtonClasses}
              disabled={busy !== null}
              onClick={(): void => {
                void run("archive", { itemId: item.id }, getMessage("officeSettings.archivedDone"));
              }}
              type="button"
            >
              {busy === "archive"
                ? getMessage("officeSettings.archiveBusy")
                : getMessage("officeSettings.archiveSubmit")}
            </button>
          </div>
          <p className={hintClasses}>{getMessage("officeSettings.archiveDescription")}</p>
        </form>
      ) : null}

      {message === null ? null : (
        <p className={messageClasses} role="status">
          {message}
        </p>
      )}
    </section>
  );
}

/** The form that files a new certificate or attestation. */
function AddItemForm({ onFiled }: { readonly onFiled: (text: string) => void }): ReactNode {
  const router = useRouter();
  const [kind, setKind] = useState<string>(COMPLIANCE_ITEM_KINDS[0] ?? "other");
  const [title, setTitle] = useState("");
  const [issuer, setIssuer] = useState("");
  const [reference, setReference] = useState("");
  const [issuedOn, setIssuedOn] = useState("");
  const [expiresOn, setExpiresOn] = useState("");
  const [alertDays, setAlertDays] = useState(String(COMPLIANCE_DEFAULT_ALERT_DAYS));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setMessage(null);

    try {
      const answer = await postAction("add", {
        kind,
        title,
        issuer,
        reference,
        issuedOn,
        expiresOn,
        alertDays: Number.parseInt(alertDays, 10),
        note,
      });

      setBusy(false);

      if (!answer.ok) {
        setMessage(answer.message);

        return;
      }

      setTitle("");
      setIssuer("");
      setReference("");
      setIssuedOn("");
      setExpiresOn("");
      setNote("");
      setMessage(getMessage("officeSettings.addedDone"));
      onFiled(getMessage("officeSettings.addedDone"));
      router.refresh();
    } catch {
      setBusy(false);
      setMessage(getMessage("officeSettings.failed"));
    }
  }

  return (
    <form
      className={cardClasses}
      onSubmit={(event): void => {
        void submit(event);
      }}
    >
      <p className={termClasses}>{getMessage("officeSettings.addHeading")}</p>
      <p className={bodyClasses}>{getMessage("officeSettings.addDescription")}</p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block">
          <span className={bodyClasses}>{getMessage("officeSettings.fieldKind")}</span>
          <select
            className={inputClasses}
            name="kind"
            onChange={(event): void => {
              setKind(event.target.value);
            }}
            value={kind}
          >
            {COMPLIANCE_ITEM_KINDS.map((candidate) => (
              <option key={candidate} value={candidate}>
                {getMessage(complianceKindLabelKey(candidate))}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={bodyClasses}>{getMessage("officeSettings.fieldTitle")}</span>
          <input
            className={inputClasses}
            maxLength={COMPLIANCE_TITLE_MAXIMUM_LENGTH}
            name="title"
            onChange={(event): void => {
              setTitle(event.target.value);
            }}
            required
            type="text"
            value={title}
          />
        </label>
        <label className="block">
          <span className={bodyClasses}>{getMessage("officeSettings.fieldIssuer")}</span>
          <input
            className={inputClasses}
            maxLength={COMPLIANCE_ISSUER_MAXIMUM_LENGTH}
            name="issuer"
            onChange={(event): void => {
              setIssuer(event.target.value);
            }}
            required
            type="text"
            value={issuer}
          />
        </label>
        <label className="block">
          <span className={bodyClasses}>{getMessage("officeSettings.fieldReference")}</span>
          <input
            className={inputClasses}
            maxLength={COMPLIANCE_REFERENCE_MAXIMUM_LENGTH}
            name="reference"
            onChange={(event): void => {
              setReference(event.target.value);
            }}
            type="text"
            value={reference}
          />
        </label>
        <label className="block">
          <span className={bodyClasses}>{getMessage("officeSettings.fieldIssuedOn")}</span>
          <input
            className={inputClasses}
            name="issuedOn"
            onChange={(event): void => {
              setIssuedOn(event.target.value);
            }}
            required
            type="date"
            value={issuedOn}
          />
        </label>
        <label className="block">
          <span className={bodyClasses}>{getMessage("officeSettings.fieldExpiresOn")}</span>
          <input
            className={inputClasses}
            name="expiresOn"
            onChange={(event): void => {
              setExpiresOn(event.target.value);
            }}
            required
            type="date"
            value={expiresOn}
          />
        </label>
        <label className="block">
          <span className={bodyClasses}>{getMessage("officeSettings.fieldAlertDays")}</span>
          <input
            className={inputClasses}
            max={COMPLIANCE_ALERT_MAXIMUM_DAYS}
            min={COMPLIANCE_ALERT_MINIMUM_DAYS}
            name="alertDays"
            onChange={(event): void => {
              setAlertDays(event.target.value);
            }}
            required
            type="number"
            value={alertDays}
          />
        </label>
        <label className="block">
          <span className={bodyClasses}>{getMessage("officeSettings.fieldNote")}</span>
          <input
            className={inputClasses}
            maxLength={COMPLIANCE_NOTE_MAXIMUM_LENGTH}
            name="note"
            onChange={(event): void => {
              setNote(event.target.value);
            }}
            type="text"
            value={note}
          />
        </label>
      </div>

      <button className={primaryButtonClasses} disabled={busy} type="submit">
        {busy ? getMessage("officeSettings.addBusy") : getMessage("officeSettings.addSubmit")}
      </button>

      {message === null ? null : (
        <p className={messageClasses} role="status">
          {message}
        </p>
      )}
    </form>
  );
}

/**
 * The calendar: the counts, the list, the one panel, the filing form and the check.
 *
 * The check's answer is a summary rather than the calendar, so it is rendered beside the button: how
 * many rows expired and how many warnings were recorded is the only thing a person can act on, and the
 * list behind it is refreshed from the server afterwards.
 */
export function ComplianceCalendarConsole({
  snapshot,
}: {
  readonly snapshot: ComplianceCalendarSnapshot;
}): ReactNode {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const selected = snapshot.items.find((item) => item.id === selectedId) ?? null;

  async function check(): Promise<void> {
    setBusy(true);
    setMessage(null);

    try {
      const answer = await postAction("check", {});
      setBusy(false);

      if (!answer.ok) {
        setMessage(answer.message);

        return;
      }

      const expired = answer.expired ?? 0;
      const alerted = answer.alerted ?? 0;

      setMessage(
        expired === 0 && alerted === 0
          ? getMessage("officeSettings.checkNothingDue")
          : formatMessage("officeSettings.checkDone", { expired, alerted }),
      );
      router.refresh();
    } catch {
      setBusy(false);
      setMessage(getMessage("officeSettings.failed"));
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <p className={bodyClasses}>
        {formatMessage("officeSettings.todayLine", { today: snapshot.today })}
      </p>
      <p className={bodyClasses}>
        {formatMessage("officeSettings.summaryDue", {
          due: snapshot.dueCount,
          overdue: snapshot.overdueCount,
          unalerted: snapshot.unalertedCount,
        })}
      </p>

      {snapshot.canManage ? (
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-card sm:p-5">
          <p className={termClasses}>{getMessage("officeSettings.checkHeading")}</p>
          <p className={bodyClasses}>{getMessage("officeSettings.checkDescription")}</p>
          <button
            className={secondaryButtonClasses}
            disabled={busy}
            onClick={(): void => {
              void check();
            }}
            type="button"
          >
            {busy ? getMessage("officeSettings.checkBusy") : getMessage("officeSettings.checkSubmit")}
          </button>
          {message === null ? null : (
            <p className={messageClasses} role="status">
              {message}
            </p>
          )}
        </div>
      ) : (
        <p className={bodyClasses}>{getMessage("officeSettings.notManageable")}</p>
      )}

      <div className={gridClasses}>
        <section aria-labelledby="compliance-panel-heading" className="lg:order-2">
          {selected === null ? (
            <div className={cardClasses}>
              <h3 className={nameClasses} id="compliance-panel-heading">
                {getMessage("officeSettings.panelHeading")}
              </h3>
              <p className={bodyClasses}>{getMessage("officeSettings.panelEmpty")}</p>
            </div>
          ) : (
            <ItemPanel
              canManage={snapshot.canManage}
              item={selected}
              key={selected.id}
              onResult={(text): void => {
                setMessage(text);
              }}
            />
          )}
        </section>

        <section aria-labelledby="compliance-list-heading" className={`${cardClasses} lg:order-1`}>
          <header className="flex flex-col gap-2">
            <h3 className={nameClasses} id="compliance-list-heading">
              {getMessage("officeSettings.listHeading")}
            </h3>
            <p className={bodyClasses}>{getMessage("officeSettings.listDescription")}</p>
            <p className={bodyClasses}>
              {formatMessage("officeSettings.listCount", { count: snapshot.items.length })}
            </p>
          </header>

          {snapshot.items.length === 0 ? (
            <p className={bodyClasses}>{getMessage("officeSettings.listEmpty")}</p>
          ) : (
            <ul className={listClasses}>
              {snapshot.items.map((item) => (
                <li key={item.id}>
                  <button
                    aria-pressed={item.id === selectedId}
                    className={item.id === selectedId ? selectedRowClasses : rowClasses}
                    onClick={(): void => {
                      setSelectedId(item.id);
                    }}
                    type="button"
                  >
                    <span className="flex flex-col gap-1">
                      <span className={termClasses}>{item.title}</span>
                      <span className={hintClasses}>
                        {`${getMessage(item.kindLabelKey as MessagePath)} - ${item.expiresOn}`}
                      </span>
                    </span>
                    <span className="flex flex-wrap items-center gap-2">
                      <span className={badgeClasses}>
                        {getMessage(item.stateLabelKey as MessagePath)}
                      </span>
                      <span className={hintClasses}>{remainingLabel(item)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {snapshot.canManage ? (
        <AddItemForm
          onFiled={(text): void => {
            setMessage(text);
          }}
        />
      ) : null}
    </div>
  );
}
