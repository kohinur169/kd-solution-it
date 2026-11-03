// path: app/(dashboard)/onboarding/underwriting/underwriting-panel.tsx
"use client";

import { useState, type ReactNode } from "react";
import { rateLimitSentence } from "@/lib/auth/refusal-message";
import { formatMessage, getMessage, type MessagePath } from "@/lib/i18n/messages";
import { csrfHeaders } from "@/lib/security/csrf-client";
import type {
  UnderwritingMccOverview,
  UnderwritingSettings,
} from "@/services/kyc/underwriting";

/**
 * The working half of the underwriting criteria screen (STEP 090): edit the four criteria, the
 * cost of each risk tier, and the tier of each category code. All three saves share one `postJson`
 * helper - a single POST literal and one awaited CSRF spread, the shape the auth gate counts.
 *
 * ## What it sends, and what it never sends
 *
 * The saves carry only the fields they change: the criteria body, one tier body, one code tier
 * body. No company is ever sent - the criteria, the tiers and the code list are all platform
 * scoped, and the service resolves everything from the session and the rows themselves.
 */

const CRITERIA_PATH = "/api/onboarding/underwriting-criteria";
const TIER_PATH = "/api/onboarding/underwriting-risk-tier";
const MCC_TIER_PATH = "/api/onboarding/underwriting-mcc-tier";

/** The codes the list is capped at, so nine hundred rows never all render at once. */
const RENDER_CAP = 300;

type RuleKey = "required" | "invalid_format" | "out_of_range" | "stale" | "retired_code";

const RULE_MESSAGES: Readonly<Record<RuleKey, MessagePath>> = Object.freeze({
  required: "onboardingUnderwriting.ruleRequired",
  invalid_format: "onboardingUnderwriting.ruleInvalidFormat",
  out_of_range: "onboardingUnderwriting.ruleOutOfRange",
  stale: "onboardingUnderwriting.ruleStale",
  retired_code: "onboardingUnderwriting.ruleRetiredCode",
});

const TIER_LABELS: Readonly<Record<string, MessagePath>> = Object.freeze({
  unassigned: "onboardingUnderwriting.tierUnassigned",
  low: "onboardingUnderwriting.tierLow",
  medium: "onboardingUnderwriting.tierMedium",
  high: "onboardingUnderwriting.tierHigh",
});

function ruleSentence(rule: string | null): string {
  if (rule !== null && rule in RULE_MESSAGES) {
    return getMessage(RULE_MESSAGES[rule as RuleKey]);
  }

  return getMessage("onboardingUnderwriting.ruleInvalidFormat");
}

function tierLabel(tier: string): MessagePath {
  return TIER_LABELS[tier] ?? "onboardingUnderwriting.tierUnassigned";
}

interface RefusalDetail {
  readonly field?: unknown;
  readonly rule?: unknown;
}

function refusalDetails(payload: unknown): readonly RefusalDetail[] {
  const details = (payload as { readonly error?: { readonly details?: unknown } }).error?.details;

  return Array.isArray(details) ? (details as RefusalDetail[]) : [];
}

interface TierDraft {
  readonly reserve: string;
  readonly days: string;
}

export function UnderwritingPanel({
  initialSettings,
  initialMcc,
}: {
  readonly initialSettings: UnderwritingSettings;
  readonly initialMcc: UnderwritingMccOverview;
}): ReactNode {
  const [settings, setSettings] = useState<UnderwritingSettings>(initialSettings);
  const [mcc, setMcc] = useState<UnderwritingMccOverview>(initialMcc);
  const [limit, setLimit] = useState(initialSettings.criteria.startingMonthlyLimit);
  const [months, setMonths] = useState(String(initialSettings.criteria.bankStatementMonths));
  const [holdEnabled, setHoldEnabled] = useState(initialSettings.criteria.largeHoldEnabled);
  const [threshold, setThreshold] = useState(initialSettings.criteria.largeHoldThreshold);
  const [tierDrafts, setTierDrafts] = useState<Readonly<Record<string, TierDraft>>>({});
  const [filter, setFilter] = useState("");
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
      return getMessage("onboardingUnderwriting.signedOut");
    }

    if (response.status === 403) {
      return getMessage("onboardingUnderwriting.forbidden");
    }

    if (response.status === 429) {
      const payload: unknown = await response.json().catch(() => null);

      return rateLimitSentence(payload);
    }

    const payload: unknown = await response.json().catch(() => null);
    const details = refusalDetails(payload);
    const first = details.find((entry) => typeof entry.rule === "string");

    return first === undefined
      ? getMessage("onboardingUnderwriting.failed")
      : ruleSentence(typeof first.rule === "string" ? first.rule : null);
  }

  function syncCriteriaDrafts(next: UnderwritingSettings): void {
    setLimit(next.criteria.startingMonthlyLimit);
    setMonths(String(next.criteria.bankStatementMonths));
    setHoldEnabled(next.criteria.largeHoldEnabled);
    setThreshold(next.criteria.largeHoldThreshold);
  }

  async function saveCriteria(): Promise<void> {
    setBusy(true);
    setMessage(null);

    try {
      const response = await postJson(CRITERIA_PATH, {
        starting_monthly_limit: limit,
        bank_statement_months: Number(months),
        large_transaction_hold_enabled: holdEnabled,
        large_transaction_hold_threshold: threshold,
      });

      if (!response.ok) {
        setMessage({ text: await readRefusal(response), failed: true });

        return;
      }

      const next = (await response.json()) as UnderwritingSettings;

      setSettings(next);
      syncCriteriaDrafts(next);
      setMessage({ text: getMessage("onboardingUnderwriting.criteriaSaved"), failed: false });
    } catch {
      setMessage({ text: getMessage("onboardingUnderwriting.failed"), failed: true });
    } finally {
      setBusy(false);
    }
  }

  async function saveTier(tier: string): Promise<void> {
    const draft = tierDrafts[tier] ?? {
      reserve: settings.tiers.find((row) => row.tier === tier)?.extraReservePercent ?? "0",
      days: String(settings.tiers.find((row) => row.tier === tier)?.holdDays ?? 0),
    };

    setBusy(true);
    setMessage(null);

    try {
      const response = await postJson(TIER_PATH, {
        tier,
        extra_reserve_percent: draft.reserve,
        hold_days: Number(draft.days),
      });

      if (!response.ok) {
        setMessage({ text: await readRefusal(response), failed: true });

        return;
      }

      const next = (await response.json()) as UnderwritingSettings;

      setSettings(next);
      setMessage({ text: getMessage("onboardingUnderwriting.tierSaved"), failed: false });
    } catch {
      setMessage({ text: getMessage("onboardingUnderwriting.failed"), failed: true });
    } finally {
      setBusy(false);
    }
  }

  async function setCodeTier(code: string, tier: string): Promise<void> {
    setBusy(true);
    setMessage(null);

    try {
      const response = await postJson(MCC_TIER_PATH, { code, tier });

      if (!response.ok) {
        setMessage({ text: await readRefusal(response), failed: true });

        return;
      }

      const next = (await response.json()) as UnderwritingMccOverview;

      setMcc(next);
      setMessage({ text: getMessage("onboardingUnderwriting.tierSaved"), failed: false });
    } catch {
      setMessage({ text: getMessage("onboardingUnderwriting.failed"), failed: true });
    } finally {
      setBusy(false);
    }
  }

  const normalizedFilter = filter.trim().toLowerCase();
  const filtered = mcc.rows.filter(
    (row) =>
      normalizedFilter === "" ||
      row.code.includes(normalizedFilter) ||
      row.title.toLowerCase().includes(normalizedFilter),
  );
  const shown = filtered.slice(0, RENDER_CAP);

  return (
    <div className="flex flex-col gap-6">
      {message === null ? null : (
        <p className={message.failed ? alertClasses : noteClasses} role="status">
          {message.text}
        </p>
      )}

      <section className={sectionClasses}>
        <h2 className={sectionHeadingClasses}>{getMessage("onboardingUnderwriting.criteriaHeading")}</h2>
        <p className={noteClasses}>{getMessage("onboardingUnderwriting.criteriaDescription")}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={labelClasses}>
            <span className="text-sm font-semibold">{getMessage("onboardingUnderwriting.startingLimitLabel")}</span>
            <input
              className={inputClasses}
              type="text"
              inputMode="decimal"
              value={limit}
              onChange={(event) => setLimit(event.target.value)}
            />
            <span className={hintClasses}>{getMessage("onboardingUnderwriting.startingLimitHint")}</span>
          </label>
          <label className={labelClasses}>
            <span className="text-sm font-semibold">{getMessage("onboardingUnderwriting.bankStatementMonthsLabel")}</span>
            <input
              className={inputClasses}
              type="number"
              min={1}
              max={36}
              value={months}
              onChange={(event) => setMonths(event.target.value)}
            />
            <span className={hintClasses}>{getMessage("onboardingUnderwriting.bankStatementMonthsHint")}</span>
          </label>
          <label className={labelClasses}>
            <span className="text-sm font-semibold">{getMessage("onboardingUnderwriting.holdEnabledLabel")}</span>
            <input
              className="h-4 w-4"
              type="checkbox"
              checked={holdEnabled}
              onChange={(event) => setHoldEnabled(event.target.checked)}
            />
          </label>
          <label className={labelClasses}>
            <span className="text-sm font-semibold">{getMessage("onboardingUnderwriting.holdThresholdLabel")}</span>
            <input
              className={inputClasses}
              type="text"
              inputMode="decimal"
              value={threshold}
              onChange={(event) => setThreshold(event.target.value)}
            />
            <span className={hintClasses}>{getMessage("onboardingUnderwriting.holdThresholdHint")}</span>
          </label>
        </div>
        <div className="flex flex-row items-center gap-3">
          <button type="button" className={buttonClasses} onClick={() => void saveCriteria()} disabled={busy}>
            {getMessage("onboardingUnderwriting.saveCriteria")}
          </button>
          <span className={hintClasses}>
            {formatMessage("onboardingUnderwriting.versionLine", { at: settings.criteria.updatedAt })}
          </span>
        </div>
      </section>

      <section className={sectionClasses}>
        <h2 className={sectionHeadingClasses}>{getMessage("onboardingUnderwriting.tiersHeading")}</h2>
        <p className={noteClasses}>{getMessage("onboardingUnderwriting.tiersDescription")}</p>
        <ul className="flex flex-col gap-3">
          {settings.tiers.map((tier) => {
            const draft = tierDrafts[tier.tier] ?? {
              reserve: tier.extraReservePercent,
              days: String(tier.holdDays),
            };

            return (
              <li key={tier.tier} className="flex flex-col gap-2 rounded-sm border border-border p-3 sm:flex-row sm:items-end sm:gap-4">
                <span className="text-sm font-semibold">{getMessage(tierLabel(tier.tier))}</span>
                <label className={labelClasses}>
                  <span className="text-xs text-muted-foreground">{getMessage("onboardingUnderwriting.reserveLabel")}</span>
                  <input
                    className={inputClasses}
                    type="text"
                    inputMode="decimal"
                    value={draft.reserve}
                    onChange={(event) =>
                      setTierDrafts((current) => ({
                        ...current,
                        [tier.tier]: { reserve: event.target.value, days: draft.days },
                      }))
                    }
                  />
                </label>
                <label className={labelClasses}>
                  <span className="text-xs text-muted-foreground">{getMessage("onboardingUnderwriting.holdDaysLabel")}</span>
                  <input
                    className={inputClasses}
                    type="number"
                    min={0}
                    max={90}
                    value={draft.days}
                    onChange={(event) =>
                      setTierDrafts((current) => ({
                        ...current,
                        [tier.tier]: { reserve: draft.reserve, days: event.target.value },
                      }))
                    }
                  />
                </label>
                <button
                  type="button"
                  className={buttonClasses}
                  onClick={() => void saveTier(tier.tier)}
                  disabled={busy}
                >
                  {getMessage("onboardingUnderwriting.saveTier")}
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <section className={sectionClasses}>
        <h2 className={sectionHeadingClasses}>{getMessage("onboardingUnderwriting.mccHeading")}</h2>
        <p className={noteClasses}>{getMessage("onboardingUnderwriting.mccDescription")}</p>
        <label className={labelClasses}>
          <span className="text-sm font-semibold">{getMessage("onboardingUnderwriting.mccFilterLabel")}</span>
          <input
            className={inputClasses}
            type="text"
            placeholder={getMessage("onboardingUnderwriting.mccFilterPlaceholder")}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </label>
        <p className={noteClasses}>
          {formatMessage("onboardingUnderwriting.showingLine", {
            shown: String(shown.length),
            total: String(filtered.length),
          })}
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground">
                <th className="py-1 pr-3">{getMessage("onboardingUnderwriting.mccCodeLabel")}</th>
                <th className="py-1 pr-3">{getMessage("onboardingUnderwriting.mccTitleLabel")}</th>
                <th className="py-1 pr-3">{getMessage("onboardingUnderwriting.mccProfilesLabel")}</th>
                <th className="py-1 pr-3">{getMessage("onboardingUnderwriting.mccTierLabel")}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <tr key={row.code} className="border-b border-border">
                  <td className="py-1 pr-3 font-mono text-xs">{row.code}</td>
                  <td className="py-1 pr-3">{row.title}</td>
                  <td className="py-1 pr-3">{String(row.profileCount)}</td>
                  <td className="py-1 pr-3">
                    <select
                      className={inputClasses}
                      value={row.tier}
                      disabled={busy}
                      onChange={(event) => void setCodeTier(row.code, event.target.value)}
                    >
                      {(["unassigned", "low", "medium", "high"] as const).map((tier) => (
                        <option key={tier} value={tier}>
                          {getMessage(tierLabel(tier))}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

const sectionClasses = "flex flex-col gap-3 rounded-md border border-border p-4";

const sectionHeadingClasses = "text-base font-semibold";

const labelClasses = "flex min-w-0 flex-1 flex-col gap-1";

const inputClasses = "rounded-sm border border-border bg-background px-2 py-1 text-sm";

const hintClasses = "text-xs text-muted-foreground";

const noteClasses = "max-w-3xl text-xs text-muted-foreground";

const alertClasses = "text-sm text-destructive";

const buttonClasses =
  "w-fit rounded-sm bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60";
