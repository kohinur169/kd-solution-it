// path: app/(admin)/entitlements/entitlements-console.tsx
"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { rateLimitSentence } from "@/lib/auth/refusal-message";
import { formatMessage, getMessage, type MessagePath } from "@/lib/i18n/messages";
import type { MerchantEntitlementAnswer } from "../../../services/billing/entitlements";
import type { BillingPlanServiceKey } from "../../../services/billing/plans-registry";

/**
 * One merchant's entitlements, asked for by id.
 *
 * ## What this component decides
 *
 * Two things, and both are the form's rather than the platform's: what a field holds while it is being typed,
 * and which sentence a verdict gets. The verdicts themselves come from the route, which reads them through
 * `services/billing/entitlements.ts` - the same authority a merchant feature will consult - so the screen can
 * never disagree with the check it is describing.
 *
 * ## Why it posts nothing
 *
 * A `GET` with the merchant's id, because this STEP reads and does not grant. That also means no device proof
 * and no CSRF token: there is nothing to forge into a write. The one value the caller controls is validated as
 * a uuid by the service before it reaches a query, and a malformed one comes back as a `422` this console
 * answers with a sentence rather than a stack.
 *
 * ## Why the six features are rendered even when four of them are refused
 *
 * A super administrator is usually here to answer "why can this merchant not use payment links?", and the
 * answer is only legible beside the verdicts that *are* granted. The list is drawn in the catalogue's order,
 * so two merchants on different plans can be compared line by line.
 */

/** What one row of the answer is, as far as a screen needs it. */
interface CheckRow {
  readonly feature: BillingPlanServiceKey;
  readonly labelKey: MessagePath;
  readonly verdict: string;
}

function checksOf(payload: unknown): readonly CheckRow[] {
  if (typeof payload !== "object" || payload === null) {
    return [];
  }

  const checks = (payload as { readonly checks?: unknown }).checks;

  if (!Array.isArray(checks)) {
    return [];
  }

  const rows: CheckRow[] = [];

  for (const entry of checks) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }

    const row = entry as { readonly feature?: unknown; readonly labelKey?: unknown; readonly verdict?: unknown };

    if (typeof row.feature === "string" && typeof row.labelKey === "string" && typeof row.verdict === "string") {
      rows.push({
        feature: row.feature as BillingPlanServiceKey,
        labelKey: row.labelKey as MessagePath,
        verdict: row.verdict,
      });
    }
  }

  return rows;
}

/** The plan, subscription and state this answer describes. */
function summaryOf(payload: unknown): MerchantEntitlementAnswer | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }

  const answer = payload as { readonly entitlements?: unknown; readonly checks?: unknown };

  return typeof answer.entitlements === "object" && answer.entitlements !== null && Array.isArray(answer.checks)
    ? (payload as MerchantEntitlementAnswer)
    : null;
}

/** The sentence for one verdict, which is the whole point of distinguishing five of them. */
const verdictMessages: Readonly<Record<string, MessagePath>> = {
  granted: "officeEntitlements.verdictGranted",
  plan_unassigned: "officeEntitlements.verdictPlanUnassigned",
  plan_not_live: "officeEntitlements.verdictPlanNotLive",
  plan_missing_service: "officeEntitlements.verdictPlanMissingService",
  plan_unreadable: "officeEntitlements.verdictPlanUnreadable",
};

const kindMessages: Readonly<Record<string, MessagePath>> = {
  granted: "officeEntitlements.kindGranted",
  unassigned: "officeEntitlements.kindUnassigned",
  not_live: "officeEntitlements.kindNotLive",
  unreadable: "officeEntitlements.kindUnreadable",
};

async function readEntitlements(companyId: string): Promise<{ ok: boolean; message: string; payload: unknown }> {
  const response = await fetch(`/api/office/entitlements?companyId=${encodeURIComponent(companyId)}`, {
    method: "GET",
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  const payload: unknown = await response.json().catch(() => null);

  if (response.ok) {
    return { ok: true, message: "", payload };
  }

  if (response.status === 429) {
    return { ok: false, message: rateLimitSentence(payload), payload: null };
  }

  if (response.status === 403) {
    return { ok: false, message: getMessage("officeEntitlements.forbidden"), payload: null };
  }

  if (response.status === 422) {
    return { ok: false, message: getMessage("officeEntitlements.invalidCompanyId"), payload: null };
  }

  return { ok: false, message: getMessage("officeEntitlements.failed"), payload: null };
}

const panelClasses = "flex flex-col gap-4 rounded-lg border border-border bg-surface p-4 shadow-card sm:p-5";

const headingClasses = "text-lg font-semibold tracking-tight";

const bodyClasses = "text-sm text-muted-foreground";

const labelClasses = "text-sm font-medium text-foreground";

const hintClasses = "text-xs text-muted-foreground";

const inputClasses =
  "mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary";

const fieldClasses = "flex flex-col gap-1";

const primaryButtonClasses =
  "inline-flex w-fit items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60";

const rowClasses =
  "flex flex-col gap-1 rounded-lg border border-border bg-background p-3 sm:flex-row sm:items-center sm:justify-between";

const badgeGrantedClasses =
  "w-fit rounded-full border border-primary/40 bg-primary/10 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide";

const badgeRefusedClasses =
  "w-fit rounded-full border border-border bg-muted/40 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide";

export function EntitlementsConsole({
  features,
}: Readonly<{ features: readonly { readonly key: BillingPlanServiceKey; readonly labelKey: MessagePath }[] }>): ReactNode {
  const [companyId, setCompanyId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [answer, setAnswer] = useState<MerchantEntitlementAnswer | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);

    const result = await readEntitlements(companyId.trim());

    setBusy(false);
    setMessage(result.message);
    setAnswer(result.ok ? summaryOf(result.payload) : null);
  }

  const rows: readonly CheckRow[] =
    answer === null
      ? features.map((feature) => ({ feature: feature.key, labelKey: feature.labelKey, verdict: "" }))
      : checksOf(answer);
  const entitlements = answer?.entitlements ?? null;

  return (
    <div className="flex flex-col gap-6">
      <form
        className={panelClasses}
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <h2 className={headingClasses}>{getMessage("officeEntitlements.formHeading")}</h2>
        <p className={bodyClasses}>{getMessage("officeEntitlements.formDescription")}</p>

        <div className={fieldClasses}>
          <label className={labelClasses} htmlFor="entitlement-company">
            {getMessage("officeEntitlements.companyIdLabel")}
          </label>
          <input
            className={inputClasses}
            id="entitlement-company"
            onChange={(event) => {
              setCompanyId(event.target.value);
            }}
            placeholder="0192f0a1-7c3d-7000-8000-000000000001"
            required
            spellCheck={false}
            value={companyId}
          />
          <p className={hintClasses}>{getMessage("officeEntitlements.companyIdHint")}</p>
        </div>

        <button className={primaryButtonClasses} disabled={busy} type="submit">
          {busy ? getMessage("officeEntitlements.submitting") : getMessage("officeEntitlements.submit")}
        </button>

        {message.length === 0 ? null : (
          <p className="text-sm text-destructive" role="alert">
            {message}
          </p>
        )}
      </form>

      {entitlements === null ? null : (
        <section aria-labelledby="entitlement-state" className={panelClasses}>
          <h2 className={headingClasses} id="entitlement-state">
            {getMessage("officeEntitlements.stateHeading")}
          </h2>
          <p className={bodyClasses}>{getMessage(kindMessages[entitlements.kind] ?? "officeEntitlements.kindUnreadable")}</p>

          <div className={fieldClasses}>
            <span className={labelClasses}>{getMessage("officeEntitlements.planHeading")}</span>
            <p className={bodyClasses}>
              {entitlements.plan === null
                ? getMessage("officeEntitlements.noPlan")
                : formatMessage("officeEntitlements.planLine", {
                    name: entitlements.plan.name,
                    code: entitlements.plan.code,
                  })}
            </p>
            {entitlements.plan === null ? null : (
              <p className={hintClasses}>
                {formatMessage("officeEntitlements.planStatusLine", { status: entitlements.plan.status })}
              </p>
            )}
          </div>

          <div className={fieldClasses}>
            <span className={labelClasses}>{getMessage("officeEntitlements.subscriptionHeading")}</span>
            <p className={bodyClasses}>
              {entitlements.subscription === null
                ? getMessage("officeEntitlements.noSubscription")
                : formatMessage("officeEntitlements.subscriptionLine", {
                    status: entitlements.subscription.status,
                    instant: entitlements.subscription.currentPeriodEnd,
                  })}
            </p>
          </div>
        </section>
      )}

      <section aria-labelledby="entitlement-features" className={panelClasses}>
        <h2 className={headingClasses} id="entitlement-features">
          {getMessage("officeEntitlements.servicesHeading")}
        </h2>
        <p className={bodyClasses}>
          {formatMessage("officeEntitlements.summaryLine", {
            count: rows.filter((row) => row.verdict === "granted").length,
          })}
        </p>

        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <li className={rowClasses} key={row.feature}>
              <span className="text-sm font-medium text-foreground">{getMessage(row.labelKey)}</span>
              <span className="flex flex-col gap-1 sm:items-end">
                <span className={row.verdict === "granted" ? badgeGrantedClasses : badgeRefusedClasses}>
                  {row.verdict === "granted"
                    ? getMessage("officeEntitlements.badgeGranted")
                    : getMessage("officeEntitlements.badgeRefused")}
                </span>
                {row.verdict.length === 0 ? null : (
                  <span className={hintClasses}>
                    {getMessage(verdictMessages[row.verdict] ?? "officeEntitlements.verdictUnknown")}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
