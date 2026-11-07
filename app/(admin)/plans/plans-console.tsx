// path: app/(admin)/plans/plans-console.tsx
"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { deviceProofHeaders } from "@/lib/auth/device-proof-store";
import { rateLimitSentence } from "@/lib/auth/refusal-message";
import { formatMessage, getMessage, type MessagePath } from "@/lib/i18n/messages";
import { csrfHeaders } from "@/lib/security/csrf-client";
import {
  BILLING_PLAN_RULES,
  isBillingPlanPeriod,
  planCodeFrom,
  planPeriodLabelKey,
  planServiceLabelKey,
  planStatusLabelKey,
  type BillingPlanPeriod,
  type BillingPlanServiceKey,
} from "../../../services/billing/plans-registry";
import type { PlanCatalogue } from "../../../services/billing/plans";

/**
 * Section 9's creation form and the catalogue beside it.
 *
 * ## What this component decides, and what it does not
 *
 * Every rule lives in `services/billing/plans.ts`: which code shapes exist, what a price is, how many
 * services a plan includes and who may write one. This component renders the fields the server sent,
 * turns the typed price into minor units, and posts one body. Its only decisions are the two a form
 * cannot avoid - what a field holds while it is being typed, and what a refusal says about it.
 *
 * ## Why the price is converted here
 *
 * The banner shows `19.99` and the platform stores `1999`. Somebody has to convert, and converting in
 * the browser keeps the service's contract honest: it accepts an **integer number of minor units**,
 * so it never has to decide what `"19.99"` means. The conversion is done on the digits themselves and
 * never by multiplying a float, and a third decimal place is refused rather than rounded.
 *
 * ## Why the code follows the name until it is touched
 *
 * A code is the plan's identity for ever and the one field an operator should not have to invent
 * twice. Typing the name proposes one; the moment the operator edits the code itself, the proposal
 * stops, so a deliberate `growth-yearly` is never overwritten by a later keystroke in the name.
 */

/** A price typed in major units, as minor units, or null when it is not a two place number. */
function priceMinorOf(text: string): number | null {
  const trimmed = text.trim();
  const match = /^([0-9]{1,8})(?:\.([0-9]{1,2}))?$/u.exec(trimmed);

  if (match === null) {
    return null;
  }

  const whole = Number.parseInt(match[1] ?? "", 10);
  const fraction = (match[2] ?? "").padEnd(2, "0");

  return whole * 100 + Number.parseInt(fraction.length === 0 ? "0" : fraction, 10);
}

/** The sentence for one rule word, in this screen's vocabulary. */
const ruleMessages: Readonly<Record<string, MessagePath>> = {
  [BILLING_PLAN_RULES.codeMalformed]: "officePlans.ruleCodeMalformed",
  [BILLING_PLAN_RULES.codeTaken]: "officePlans.ruleCodeTaken",
  [BILLING_PLAN_RULES.nameEmpty]: "officePlans.ruleNameEmpty",
  [BILLING_PLAN_RULES.nameTooLong]: "officePlans.ruleNameTooLong",
  [BILLING_PLAN_RULES.priceMissing]: "officePlans.rulePriceMissing",
  [BILLING_PLAN_RULES.priceNotWhole]: "officePlans.rulePriceNotWhole",
  [BILLING_PLAN_RULES.priceNegative]: "officePlans.rulePriceNegative",
  [BILLING_PLAN_RULES.priceTooLarge]: "officePlans.rulePriceTooLarge",
  [BILLING_PLAN_RULES.currencyMalformed]: "officePlans.ruleCurrencyMalformed",
  [BILLING_PLAN_RULES.periodUnsupported]: "officePlans.rulePeriodUnsupported",
  [BILLING_PLAN_RULES.servicesEmpty]: "officePlans.ruleServicesEmpty",
  [BILLING_PLAN_RULES.servicesTooMany]: "officePlans.ruleServicesTooMany",
  [BILLING_PLAN_RULES.serviceUnknown]: "officePlans.ruleServiceUnknown",
  [BILLING_PLAN_RULES.serviceDuplicated]: "officePlans.ruleServiceDuplicated",
  [BILLING_PLAN_RULES.sortOrderInvalid]: "officePlans.ruleSortOrderInvalid",
  [BILLING_PLAN_RULES.publishInvalid]: "officePlans.rulePublishInvalid",
  [BILLING_PLAN_RULES.notWritten]: "officePlans.ruleNotWritten",
};

/** The rule a refusal names, or null when the envelope carries none. */
function refusalRuleOf(payload: unknown): string | null {
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

interface Answer {
  readonly ok: boolean;
  readonly message: string;
  readonly catalogue: PlanCatalogue | null;
}

async function postPlan(body: string): Promise<Answer> {
  const path = "/api/office/plans";
  const proof = await deviceProofHeaders("POST", path, body);

  if (proof === null) {
    return { ok: false, message: getMessage("officePlans.deviceProof"), catalogue: null };
  }

  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...proof, ...(await csrfHeaders()) },
    body,
  });
  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    if (response.status === 429) {
      return { ok: false, message: rateLimitSentence(payload), catalogue: null };
    }

    if (response.status === 409) {
      return { ok: false, message: getMessage("officePlans.conflict"), catalogue: null };
    }

    const rule = refusalRuleOf(payload);
    const message =
      rule === null
        ? getMessage("officePlans.failed")
        : getMessage(ruleMessages[rule] ?? "officePlans.failed");

    return { ok: false, message, catalogue: null };
  }

  return {
    ok: true,
    message: getMessage("officePlans.created"),
    catalogue: typeof payload === "object" && payload !== null ? (payload as PlanCatalogue) : null,
  };
}

const panelClasses = "flex flex-col gap-4 rounded-lg border border-border bg-surface p-4 shadow-card sm:p-5";

const headingClasses = "text-lg font-semibold tracking-tight";

const bodyClasses = "text-sm text-muted-foreground";

const labelClasses = "text-sm font-medium text-foreground";

const hintClasses = "text-xs text-muted-foreground";

const inputClasses =
  "mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary";

const fieldClasses = "flex flex-col gap-1";

const gridClasses = "grid gap-4 sm:grid-cols-2";

const primaryButtonClasses =
  "inline-flex w-fit items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60";

const messageClasses = "text-sm";

const listClasses = "flex flex-col gap-3";

const planClasses = "flex flex-col gap-2 rounded-lg border border-border bg-background p-3";

const planHeaderClasses = "flex flex-wrap items-center justify-between gap-x-3 gap-y-1";

const badgeClasses =
  "rounded-full border border-border bg-muted/40 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide";

/** What a plan shows as its price: the stored amount, its currency and the period it is charged for. */
function priceLineOf(plan: PlanCatalogue["plans"][number]): string {
  return `${String(Math.trunc(plan.priceMinor / 100))}.${String(plan.priceMinor % 100).padStart(2, "0")} ${plan.currency} / ${getMessage(planPeriodLabelKey(plan.period))}`;
}

export function PlansConsole({ catalogue }: Readonly<{ catalogue: PlanCatalogue }>): ReactNode {
  const [current, setCurrent] = useState<PlanCatalogue>(catalogue);
  const [code, setCode] = useState("");
  const [codeTouched, setCodeTouched] = useState(false);
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [currency, setCurrency] = useState(current.defaultCurrency);
  const [period, setPeriod] = useState<BillingPlanPeriod>(current.periods[0] ?? "monthly");
  const [services, setServices] = useState<readonly BillingPlanServiceKey[]>([]);
  const [sortOrder, setSortOrder] = useState("0");
  const [publish, setPublish] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);

  function toggleService(service: BillingPlanServiceKey): void {
    setServices((chosen) =>
      chosen.includes(service) ? chosen.filter((entry) => entry !== service) : [...chosen, service],
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    const priceMinor = priceMinorOf(price);

    if (priceMinor === null) {
      setMessage(getMessage("officePlans.invalidFormat"));
      setFailed(true);

      return;
    }

    const proposed = codeTouched ? code.trim() : (planCodeFrom(name) ?? code.trim());
    const body = JSON.stringify({
      code: proposed,
      name,
      priceMinor,
      currency,
      period,
      services,
      sortOrder: Number.parseInt(sortOrder, 10),
      publish,
    });

    setBusy(true);

    const answer = await postPlan(body);

    setBusy(false);
    setMessage(answer.message);
    setFailed(!answer.ok);

    if (answer.ok) {
      setCurrent(answer.catalogue ?? current);
      setCode("");
      setCodeTouched(false);
      setName("");
      setPrice("");
      setServices([]);
      setSortOrder("0");
      setPublish(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <form
        className={panelClasses}
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <h2 className={headingClasses}>{getMessage("officePlans.formHeading")}</h2>
        <p className={bodyClasses}>{getMessage("officePlans.formDescription")}</p>

        <div className={gridClasses}>
          <div className={fieldClasses}>
            <label className={labelClasses} htmlFor="plan-name">
              {getMessage("officePlans.nameLabel")}
            </label>
            <input
              className={inputClasses}
              id="plan-name"
              maxLength={80}
              onChange={(event) => {
                setName(event.target.value);
              }}
              required
              value={name}
            />
          </div>

          <div className={fieldClasses}>
            <label className={labelClasses} htmlFor="plan-code">
              {getMessage("officePlans.codeLabel")}
            </label>
            <input
              className={inputClasses}
              id="plan-code"
              maxLength={39}
              onChange={(event) => {
                setCode(event.target.value);
                setCodeTouched(true);
              }}
              placeholder={planCodeFrom(name) ?? ""}
              value={code}
            />
            <p className={hintClasses}>{getMessage("officePlans.codeHint")}</p>
          </div>

          <div className={fieldClasses}>
            <label className={labelClasses} htmlFor="plan-price">
              {getMessage("officePlans.priceLabel")}
            </label>
            <input
              className={inputClasses}
              id="plan-price"
              inputMode="decimal"
              onChange={(event) => {
                setPrice(event.target.value);
              }}
              placeholder="19.99"
              required
              value={price}
            />
            <p className={hintClasses}>{getMessage("officePlans.priceHint")}</p>
          </div>

          <div className={fieldClasses}>
            <label className={labelClasses} htmlFor="plan-currency">
              {getMessage("officePlans.currencyLabel")}
            </label>
            <input
              className={inputClasses}
              id="plan-currency"
              maxLength={3}
              onChange={(event) => {
                setCurrency(event.target.value.toUpperCase());
              }}
              value={currency}
            />
          </div>

          <div className={fieldClasses}>
            <label className={labelClasses} htmlFor="plan-period">
              {getMessage("officePlans.periodLabel")}
            </label>
            <select
              className={inputClasses}
              id="plan-period"
              onChange={(event) => {
                const chosen = event.target.value;

                if (isBillingPlanPeriod(chosen)) {
                  setPeriod(chosen);
                }
              }}
              value={period}
            >
              {current.periods.map((entry) => (
                <option key={entry} value={entry}>
                  {getMessage(planPeriodLabelKey(entry))}
                </option>
              ))}
            </select>
          </div>

          <div className={fieldClasses}>
            <label className={labelClasses} htmlFor="plan-sort-order">
              {getMessage("officePlans.sortOrderLabel")}
            </label>
            <input
              className={inputClasses}
              id="plan-sort-order"
              inputMode="numeric"
              max={current.maximumSortOrder}
              min={0}
              onChange={(event) => {
                setSortOrder(event.target.value);
              }}
              type="number"
              value={sortOrder}
            />
          </div>
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className={labelClasses}>{getMessage("officePlans.servicesLabel")}</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {current.services.map((service) => (
              <label className="flex items-center gap-2 text-sm" htmlFor={`plan-service-${service}`} key={service}>
                <input
                  checked={services.includes(service)}
                  id={`plan-service-${service}`}
                  onChange={() => {
                    toggleService(service);
                  }}
                  type="checkbox"
                />
                {getMessage(planServiceLabelKey(service))}
              </label>
            ))}
          </div>
        </fieldset>

        <div className={fieldClasses}>
          <label className="flex items-center gap-2 text-sm" htmlFor="plan-publish">
            <input
              checked={publish}
              id="plan-publish"
              onChange={(event) => {
                setPublish(event.target.checked);
              }}
              type="checkbox"
            />
            {getMessage("officePlans.publishLabel")}
          </label>
          <p className={hintClasses}>{getMessage("officePlans.publishHint")}</p>
        </div>

        <button className={primaryButtonClasses} disabled={busy} type="submit">
          {busy ? getMessage("officePlans.submitting") : getMessage("officePlans.submit")}
        </button>

        {message.length === 0 ? null : (
          <p className={failed ? "text-sm text-destructive" : messageClasses} role={failed ? "alert" : "status"}>
            {message}
          </p>
        )}
      </form>

      <section aria-labelledby="plans-catalogue" className={panelClasses}>
        <h2 className={headingClasses} id="plans-catalogue">
          {getMessage("officePlans.listHeading")}
        </h2>
        <p className={bodyClasses}>{formatMessage("officePlans.listSummary", { count: current.plans.length })}</p>

        {current.plans.length === 0 ? (
          <p className={bodyClasses}>{getMessage("officePlans.listEmpty")}</p>
        ) : (
          <ul className={listClasses}>
            {current.plans.map((plan) => (
              <li className={planClasses} key={plan.id}>
                <div className={planHeaderClasses}>
                  <span className="text-sm font-semibold">
                    {plan.name} <span className="text-muted-foreground">({plan.code})</span>
                  </span>
                  <span className={badgeClasses}>{getMessage(planStatusLabelKey(plan.status))}</span>
                </div>
                <p className={bodyClasses}>{priceLineOf(plan)}</p>
                <p className={hintClasses}>
                  {formatMessage("officePlans.monthlyEquivalent", {
                    amount: `${String(Math.trunc(plan.monthlyEquivalentMinor / 100))}.${String(
                      plan.monthlyEquivalentMinor % 100,
                    ).padStart(2, "0")}`,
                    currency: plan.currency,
                  })}
                </p>
                <p className={bodyClasses}>
                  <span className="font-medium">{getMessage("officePlans.servicesHeading")}: </span>
                  {plan.services.length === 0
                    ? getMessage("officePlans.noServices")
                    : plan.services.map((service) => getMessage(planServiceLabelKey(service))).join(", ")}
                </p>
                <p className={hintClasses}>
                  {plan.publishedAt === null
                    ? getMessage("officePlans.notPublished")
                    : formatMessage("officePlans.publishedOn", { instant: plan.publishedAt })}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
