// path: app/(admin)/office/disputes/chargeback-panel.tsx
"use client";
// path: app/(admin)/office/disputes/chargeback-panel.tsx
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { deviceProofHeaders } from "@/lib/auth/device-proof-store";
import { rateLimitSentence } from "@/lib/auth/refusal-message";
import { formatMessage, getMessage } from "@/lib/i18n/messages";
import { csrfHeaders } from "@/lib/security/csrf-client";
import { CHARGEBACK_NOTE_MAXIMUM_LENGTH } from "@/services/disputes/chargeback-fields";
import type {
  ChargebackScreenView,
  ChargebackStepView,
  ChargebackWatchRow,
} from "@/services/disputes/chargeback-rate";

/**
 * Section 18's chargeback programme, as the office works it.
 *
 * ## What the panel is for, in the officer's order
 *
 * The thresholds first, because a bar nobody can read is a bar nobody can defend: the seven numbers the super
 * administrator owns are the first thing on the panel, and every row below them names the bar it was measured
 * against. Then the merchants, each with its transactions, its chargebacks, the rate they give and the step that
 * rate earns. Then the steps already taken, because "what did we do about this merchant" is the question a
 * chargeback programme is reviewed on.
 *
 * ## Why every button is a proof and not a click
 *
 * All three acts - saving the thresholds, taking a step, clearing one - are signed the same way the rest of this
 * office's mutations are: a CSRF token from `csrfHeaders()` and a device proof over the exact bytes the route will
 * read. A device proof that is not available is `device.proofRequired`, printed rather than swallowed, because
 * the alternative is a button that appears to work and changes nothing.
 *
 * ## Why the panel decides only what to offer
 *
 * `canApply` and `canSuspend` come from the server's own reading of the actor, and the routes ask again. A browser
 * that shows a button to the wrong account earns a refusal with a rule, which is the sentence this panel prints -
 * never a silent no-op, and never an optimistic redraw.
 *
 * ## What it does not choose
 *
 * The step is not a parameter. Pressing "take the step" asks the service to measure again and decide again, so a
 * merchant who was at 1.6 percent when the page was rendered and is at 0.4 percent when somebody presses reads the
 * bar's answer rather than the browser's memory of it.
 */

/** The three acts, as one union: what is pending, so only one button at a time says "working". */
type Pending =
  | null
  | "policy"
  | `apply:${string}`
  | `clear:${string}`;

/** The one verb this panel sends. Named here so the auth gate counts one call per act, not one per function. */
type MutationVerb = "POST";

interface PanelProps {
  readonly view: ChargebackScreenView;
}

/** One refusal's sentence, from the status and the rule the route put in the envelope. */
function sentenceForRule(rule: string | null, status?: number): string {
  if (status === 401) {
    return getMessage("disputes.signedOut");
  }

  if (status === 403) {
    return getMessage("device.proofRequired");
  }

  switch (rule) {
    case "chargeback_below_threshold":
      return getMessage("disputes.chargebackRuleBelowThreshold");
    case "chargeback_minimum_not_reached":
      return getMessage("disputes.chargebackRuleMinimum");
    case "chargeback_step_taken":
      return getMessage("disputes.chargebackRuleTaken");
    case "chargeback_suspended":
      return getMessage("disputes.chargebackRuleSuspended");
    case "chargeback_company_missing":
      return getMessage("disputes.chargebackRuleMissing");
    case "chargeback_measurement_truncated":
      return getMessage("disputes.chargebackRuleTruncated");
    case "chargeback_policy_invalid":
      return getMessage("disputes.chargebackRuleInvalidPolicy");
    case "chargeback_not_clearable":
      return getMessage("disputes.chargebackRuleNotClearable");
    case "chargeback_already_cleared":
      return getMessage("disputes.chargebackRuleAlreadyCleared");
    case "chargeback_suspension_reason_required":
      return getMessage("disputes.chargebackRuleReasonRequired");
    case "invalid_format":
      return getMessage("disputes.chargebackRuleInvalidFormat");
    default:
      return getMessage("disputes.chargebackFailed");
  }
}

/** The step's own sentence, from its word. */
function stepLabel(kind: ChargebackStepView["kind"]): string {
  switch (kind) {
    case "warning":
      return getMessage("disputes.chargebackStepWarning");
    case "reserve":
      return getMessage("disputes.chargebackStepReserve");
    case "suspension":
      return getMessage("disputes.chargebackStepSuspension");
  }
}

function modeLabel(mode: ChargebackStepView["mode"]): string {
  return mode === "manual" ? getMessage("disputes.chargebackModeManual") : getMessage("disputes.chargebackModeAutomatic");
}

/** One instant, printed the way every office screen prints one: UTC, minute precision. */
function formatInstant(iso: string | null): string {
  if (iso === null) {
    return "-";
  }

  const parsed = Date.parse(iso);

  return Number.isFinite(parsed) ? `${new Date(parsed).toISOString().slice(0, 16).replace("T", " ")} UTC` : iso;
}

/** The rule of the first detail a route refused with, or null when the envelope carried none. */
function ruleOf(body: unknown): string | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }

  const error = (body as Record<string, unknown>)["error"];

  if (typeof error !== "object" || error === null) {
    return null;
  }

  const details = (error as Record<string, unknown>)["details"];

  if (!Array.isArray(details) || details.length === 0) {
    return null;
  }

  const first = details[0];

  return typeof first === "object" && first !== null && typeof (first as Record<string, unknown>)["rule"] === "string"
    ? ((first as Record<string, unknown>)["rule"] as string)
    : null;
}

export function ChargebackPanel({ view }: PanelProps): ReactNode {
  const router = useRouter();
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [policy, setPolicy] = useState({
    windowDays: String(view.policy.values.windowDays),
    minimumTransactions: String(view.policy.values.minimumTransactions),
    warningRateBps: String(view.policy.values.warningRateBps),
    reserveRateBps: String(view.policy.values.reserveRateBps),
    suspensionRateBps: String(view.policy.values.suspensionRateBps),
    reservePercentBps: String(view.policy.values.reservePercentBps),
    reserveDays: String(view.policy.values.reserveDays),
  });

  const busy = pending !== null;

  /**
   * One POST, one token, one device proof, one outcome.
   *
   * `path` is one of this STEP's three routes; the proof is computed over the exact payload string, so the bytes the
   * route verifies are the bytes this function sent rather than a re-serialisation of them.
   */
  async function send(input: {
    readonly path: string;
    readonly method: MutationVerb;
    readonly headers: Readonly<Record<string, string>>;
    readonly payload: string;
    readonly what: Pending;
    readonly doneMessage: string;
  }): Promise<boolean> {
    const proof = await deviceProofHeaders("POST", input.path, input.payload);

    if (proof === null) {
      setError(getMessage("device.proofRequired"));

      return false;
    }

    setPending(input.what);
    setError(null);
    setDone(null);

    try {
      const response = await fetch(input.path, {
        method: input.method,
        headers: { "content-type": "application/json", ...proof, ...input.headers },
        body: input.payload,
        credentials: "same-origin",
      });

      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);

        setError(response.status === 429 ? rateLimitSentence(body) : sentenceForRule(ruleOf(body), response.status));

        return false;
      }

      setDone(input.doneMessage);
      router.refresh();

      return true;
    } catch {
      setError(getMessage("disputes.chargebackFailed"));

      return false;
    } finally {
      setPending(null);
    }
  }

  /** Save the seven numbers: the act section 18 gives the super administrator alone. */
  async function savePolicy(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    const payload = JSON.stringify({
      windowDays: Number(policy.windowDays),
      minimumTransactions: Number(policy.minimumTransactions),
      warningRateBps: Number(policy.warningRateBps),
      reserveRateBps: Number(policy.reserveRateBps),
      suspensionRateBps: Number(policy.suspensionRateBps),
      reservePercentBps: Number(policy.reservePercentBps),
      reserveDays: Number(policy.reserveDays),
    });

    await send({
      path: "/api/office/disputes/chargeback/policy",
      method: "POST",
      headers: { ...(await csrfHeaders()) },
      payload,
      what: "policy",
      doneMessage: getMessage("disputes.chargebackPolicySaved"),
    });
  }

  /** Take the step the numbers earn: the platform's own acts, and the officer's signature on a suspension. */
  async function takeStep(row: ChargebackWatchRow): Promise<void> {
    const reason = (reasons[row.companyId] ?? "").trim();
    const payload = JSON.stringify(
      reason.length === 0 ? { companyId: row.companyId } : { companyId: row.companyId, reason },
    );
    const step = row.dueKind;

    await send({
      path: "/api/office/disputes/chargeback/apply",
      method: "POST",
      headers: { ...(await csrfHeaders()) },
      payload,
      what: `apply:${row.companyId}`,
      doneMessage:
        step === null
          ? getMessage("disputes.chargebackFailed")
          : formatMessage("disputes.chargebackApplied", { kind: stepLabel(step) }),
    });
  }

  /** Lift a warning or an extra reserve, once, with a sentence. */
  async function clearStep(step: ChargebackStepView): Promise<void> {
    const note = (reasons[step.id] ?? "").trim();
    const payload = JSON.stringify({ companyId: step.companyId, kind: step.kind, note });

    await send({
      path: "/api/office/disputes/chargeback/clear",
      method: "POST",
      headers: { ...(await csrfHeaders()) },
      payload,
      what: `clear:${step.id}`,
      doneMessage: formatMessage("disputes.chargebackCleared", { kind: stepLabel(step.kind) }),
    });
  }

  const live = view.history.filter((step) => step.clearedAt === null);

  return (
    <div className={panelClasses}>
      {error === null ? null : (
        <p className={alertClasses} role="alert">
          {error}
        </p>
      )}
      {done === null ? null : (
        <p className={noteLineClasses} role="status">
          {done}
        </p>
      )}

      <form
        className={formClasses}
        onSubmit={(event) => {
          void savePolicy(event);
        }}
      >
        <h3 className={subHeadingClasses}>{getMessage("disputes.chargebackPolicyTitle")}</h3>
        <p className={helpClasses}>{getMessage("disputes.chargebackPolicyHelp")}</p>

        <div className={gridClasses}>
          <label className={labelClasses} htmlFor="chargeback-window">
            {getMessage("disputes.chargebackPolicyWindowLabel")}
            <input
              className={fieldClasses}
              id="chargeback-window"
              min={1}
              max={365}
              onChange={(event) => setPolicy({ ...policy, windowDays: event.target.value })}
              readOnly={!view.policy.canEdit}
              type="number"
              value={policy.windowDays}
            />
          </label>
          <label className={labelClasses} htmlFor="chargeback-minimum">
            {getMessage("disputes.chargebackPolicyMinimumLabel")}
            <input
              className={fieldClasses}
              id="chargeback-minimum"
              min={0}
              max={100000}
              onChange={(event) => setPolicy({ ...policy, minimumTransactions: event.target.value })}
              readOnly={!view.policy.canEdit}
              type="number"
              value={policy.minimumTransactions}
            />
          </label>
          <label className={labelClasses} htmlFor="chargeback-warning">
            {getMessage("disputes.chargebackPolicyWarningLabel")}
            <input
              className={fieldClasses}
              id="chargeback-warning"
              max={10000}
              min={1}
              onChange={(event) => setPolicy({ ...policy, warningRateBps: event.target.value })}
              readOnly={!view.policy.canEdit}
              type="number"
              value={policy.warningRateBps}
            />
          </label>
          <label className={labelClasses} htmlFor="chargeback-reserve">
            {getMessage("disputes.chargebackPolicyReserveLabel")}
            <input
              className={fieldClasses}
              id="chargeback-reserve"
              max={10000}
              min={1}
              onChange={(event) => setPolicy({ ...policy, reserveRateBps: event.target.value })}
              readOnly={!view.policy.canEdit}
              type="number"
              value={policy.reserveRateBps}
            />
          </label>
          <label className={labelClasses} htmlFor="chargeback-suspension">
            {getMessage("disputes.chargebackPolicySuspensionLabel")}
            <input
              className={fieldClasses}
              id="chargeback-suspension"
              max={10000}
              min={1}
              onChange={(event) => setPolicy({ ...policy, suspensionRateBps: event.target.value })}
              readOnly={!view.policy.canEdit}
              type="number"
              value={policy.suspensionRateBps}
            />
          </label>
          <label className={labelClasses} htmlFor="chargeback-reserve-percent">
            {getMessage("disputes.chargebackPolicyReservePercentLabel")}
            <input
              className={fieldClasses}
              id="chargeback-reserve-percent"
              max={10000}
              min={0}
              onChange={(event) => setPolicy({ ...policy, reservePercentBps: event.target.value })}
              readOnly={!view.policy.canEdit}
              type="number"
              value={policy.reservePercentBps}
            />
          </label>
          <label className={labelClasses} htmlFor="chargeback-reserve-days">
            {getMessage("disputes.chargebackPolicyReserveDaysLabel")}
            <input
              className={fieldClasses}
              id="chargeback-reserve-days"
              max={365}
              min={1}
              onChange={(event) => setPolicy({ ...policy, reserveDays: event.target.value })}
              readOnly={!view.policy.canEdit}
              type="number"
              value={policy.reserveDays}
            />
          </label>
        </div>

        <p className={helpClasses}>
          {formatMessage("disputes.chargebackPolicyDigest", { digest: view.policy.digest.slice(0, 16) })}
        </p>

        {view.policy.canEdit ? (
          <div className={actionsClasses}>
            <button className={primaryButtonClasses} disabled={busy} type="submit">
              {getMessage("disputes.chargebackPolicySave")}
            </button>
          </div>
        ) : (
          <p className={helpClasses}>{getMessage("disputes.chargebackPolicyRoleNote")}</p>
        )}
      </form>

      <section aria-labelledby="chargeback-watch-heading" className={sectionClasses}>
        <h3 className={subHeadingClasses} id="chargeback-watch-heading">
          {getMessage("disputes.chargebackWatchTitle")}
        </h3>
        <p className={helpClasses}>{getMessage("disputes.chargebackWatchDescription")}</p>

        {view.rows.length === 0 ? (
          <p className={helpClasses}>{getMessage("disputes.chargebackWatchEmpty")}</p>
        ) : (
          <ul className={listClasses}>
            {view.rows.map((row) => (
              <li className={cardClasses} key={row.companyId}>
                <div className={rowHeaderClasses}>
                  <span className={nameClasses}>{row.companyName}</span>
                  <span className={badgeClasses}>
                    {formatMessage("disputes.chargebackWatchRate", { rate: row.rateText })}
                  </span>
                  <span className={badgeClasses}>
                    {formatMessage("disputes.chargebackWatchCounts", {
                      chargebacks: String(row.chargebacksCount),
                      payments: String(row.paymentsCount),
                    })}
                  </span>
                  <span className={badgeClasses}>
                    {getMessage("disputes.chargebackWatchDue")}:{" "}
                    {row.dueKind === null ? getMessage("disputes.chargebackWatchNoStep") : stepLabel(row.dueKind)}
                  </span>
                  <span className={badgeClasses}>
                    {getMessage("disputes.chargebackWatchStanding")}:{" "}
                    {row.liveKind === null
                      ? row.clearedKind === null
                        ? getMessage("disputes.chargebackWatchNoStep")
                        : `${stepLabel(row.clearedKind)} (${getMessage("disputes.chargebackWatchCleared")})`
                      : stepLabel(row.liveKind)}
                  </span>
                </div>

                {row.truncated ? <p className={helpClasses}>{getMessage("disputes.chargebackWatchTruncated")}</p> : null}

                {view.canApply && row.blockedRule === null ? (
                  <div className={actionsClasses}>
                    <button
                      className={row.dueKind === "suspension" ? dangerButtonClasses : buttonClasses}
                      disabled={busy}
                      onClick={() => void takeStep(row)}
                      type="button"
                    >
                      {row.dueKind === "suspension"
                        ? getMessage("disputes.chargebackSuspendLabel")
                        : getMessage("disputes.chargebackRunLabel")}
                    </button>
                    {row.dueKind === "suspension" ? (
                      <label className={labelClasses} htmlFor={`chargeback-reason-${row.companyId}`}>
                        {getMessage("disputes.chargebackSuspendReasonLabel")}
                        <input
                          className={fieldClasses}
                          id={`chargeback-reason-${row.companyId}`}
                          maxLength={CHARGEBACK_NOTE_MAXIMUM_LENGTH}
                          onChange={(event) =>
                            setReasons({ ...reasons, [row.companyId]: event.target.value })
                          }
                          type="text"
                          value={reasons[row.companyId] ?? ""}
                        />
                      </label>
                    ) : null}
                  </div>
                ) : (
                  <p className={helpClasses}>
                    {row.blockedRule === null
                      ? getMessage("disputes.chargebackWatchActionNote")
                      : sentenceForRule(row.blockedRule)}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="chargeback-history-heading" className={sectionClasses}>
        <h3 className={subHeadingClasses} id="chargeback-history-heading">
          {getMessage("disputes.chargebackHistoryTitle")}
        </h3>
        <p className={helpClasses}>{getMessage("disputes.chargebackHistoryDescription")}</p>

        {view.history.length === 0 ? (
          <p className={helpClasses}>{getMessage("disputes.chargebackHistoryEmpty")}</p>
        ) : (
          <ul className={listClasses}>
            {live.map((step) => (
              <li className={cardClasses} key={step.id}>
                <div className={rowHeaderClasses}>
                  <span className={badgeClasses}>{stepLabel(step.kind)}</span>
                  <span className={badgeClasses}>{modeLabel(step.mode)}</span>
                  <span className={noteLineClasses}>{formatInstant(step.appliedAt)}</span>
                  <span className={badgeClasses}>{formatMessage("disputes.chargebackWatchRate", { rate: step.rateText })}</span>
                  {step.reservePercentText === null ? null : (
                    <span className={noteLineClasses}>
                      {formatMessage("disputes.chargebackReserveGiven", { percent: step.reservePercentText })}
                    </span>
                  )}
                </div>
                <p className={helpClasses}>{step.detail}</p>

                {view.canSuspend && step.kind !== "suspension" ? (
                  <div className={actionsClasses}>
                    <label className={labelClasses} htmlFor={`chargeback-clear-${step.id}`}>
                      {getMessage("disputes.chargebackClearNoteLabel")}
                      <input
                        className={fieldClasses}
                        id={`chargeback-clear-${step.id}`}
                        maxLength={CHARGEBACK_NOTE_MAXIMUM_LENGTH}
                        onChange={(event) => setReasons({ ...reasons, [step.id]: event.target.value })}
                        type="text"
                        value={reasons[step.id] ?? ""}
                      />
                    </label>
                    <button className={buttonClasses} disabled={busy} onClick={() => void clearStep(step)} type="button">
                      {getMessage("disputes.chargebackClearLabel")}
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
            {live.length === 0 ? <li className={helpClasses}>{getMessage("disputes.chargebackHistoryEmpty")}</li> : null}
          </ul>
        )}
      </section>
    </div>
  );
}

const panelClasses = "flex flex-col gap-4";
const sectionClasses = "flex flex-col gap-3 border-t border-border pt-4";
const formClasses = "flex flex-col gap-2";
const gridClasses = "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3";
const subHeadingClasses = "text-sm font-semibold text-foreground";
const helpClasses = "text-sm text-muted-foreground";
const labelClasses = "flex flex-col gap-1 text-xs font-medium text-muted-foreground";
const fieldClasses =
  "rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const actionsClasses = "flex flex-wrap items-center gap-2";
const listClasses = "flex flex-col gap-3";
const cardClasses = "flex flex-col gap-2 rounded-lg border border-border bg-surface p-4 shadow-card";
const rowHeaderClasses = "flex flex-wrap items-center gap-x-3 gap-y-1";
const nameClasses = "text-sm font-semibold text-foreground";
const badgeClasses =
  "rounded-full border border-border bg-muted/40 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide";
const noteLineClasses =
  "whitespace-nowrap rounded-lg border border-border bg-background px-2 py-1 text-xs tabular-nums";
const alertClasses = "text-sm text-destructive";
const primaryButtonClasses =
  "w-fit rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60";
const buttonClasses =
  "w-fit rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium text-foreground disabled:opacity-60";
const dangerButtonClasses =
  "w-fit rounded-lg border border-destructive bg-background px-3 py-2 text-sm font-semibold text-destructive disabled:opacity-60";
