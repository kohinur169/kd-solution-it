// path: app/(admin)/countries/country-switch-console.tsx
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { deviceProofHeaders } from "@/lib/auth/device-proof-store";
import { rateLimitSentence } from "@/lib/auth/refusal-message";
import { REAUTHENTICATION_REQUIRED_RULE } from "@/lib/auth/step-up";
import { stageLabelKey } from "@/lib/approvals/registry";
import {
  COUNTRY_DISABLE_REASON_MAXIMUM_LENGTH,
  countryStateLabelKey,
} from "@/lib/countries/registry";
import type { CountrySwitchSnapshot, CountrySwitchView } from "@/lib/countries/service";
import { formatMessage, getMessage, type MessagePath } from "@/lib/i18n/messages";
import { csrfHeaders } from "@/lib/security/csrf-client";

/**
 * The country switch's controls: filter the list, choose a country, and take the one turn it allows.
 *
 * ## What this component does and does not decide
 *
 * Every rule lives in `lib/countries/service.ts`: the two roles, the freshness of the second factor,
 * the sanctioned row, the decision an opening must spend. This component posts one action and renders
 * the answer. The rows arrive from the server component above, which has already refused an account
 * that does not control the switch, so nothing here decides who may look.
 *
 * ## Why one panel instead of a form per row
 *
 * The list is the 250 rows of ISO 3166-1. A form on every row would be 250 inputs in one document and
 * a keyboard user's day. The list is a list of choices, the panel is the one place a sentence is
 * written and one button is pressed, and both the reason and the note live in that panel's state - so
 * the words an operator typed for one country cannot be sent with another.
 *
 * ## Refusals are told apart
 *
 * `403` with `reauth_required` is STEP 053's window; `409` names the rule that refused - a sanctioned
 * country, a country already open or closed, an opening with no decision behind it, a decision
 * somebody spent a moment ago, or a row that changed under the reader - and each of those is a
 * different sentence because each is a different thing for the operator to do next.
 */

type CountryAction = "request" | "enable" | "disable";

type CountryFilter = "all" | "enabled" | "disabled" | "sanctioned";

interface RefusalDetail {
  readonly field?: unknown;
  readonly rule?: unknown;
}

/** The rule a `409` or `422` names, or null when the envelope carries none. */
function refusalRule(payload: unknown): string | null {
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

  const first = details[0] as RefusalDetail;

  return typeof first.rule === "string" ? first.rule : null;
}

/** The sentence for a refused action, in this screen's vocabulary. */
function messageForStatus(status: number, payload: unknown): string {
  if (status === 429) {
    return rateLimitSentence(payload);
  }

  if (status === 401) {
    return getMessage("officeCountries.signedOut");
  }

  const rule = refusalRule(payload);

  if (status === 403) {
    return getMessage(
      rule === REAUTHENTICATION_REQUIRED_RULE
        ? "officeCountries.reauthRequired"
        : "officeCountries.forbidden",
    );
  }

  if (rule === "sanctioned") {
    return getMessage("officeCountries.sanctionedRefusal");
  }

  if (rule === "already_on") {
    return getMessage("officeCountries.alreadyOn");
  }

  if (rule === "already_off") {
    return getMessage("officeCountries.alreadyOff");
  }

  if (rule === "duplicate" || rule === "already_pending") {
    return getMessage("officeCountries.alreadyPending");
  }

  if (rule === "approval_required") {
    return getMessage("officeCountries.approvalRequiredRefusal");
  }

  if (rule === "already_used") {
    return getMessage("officeCountries.approvalUsed");
  }

  if (rule === "stale") {
    return getMessage("officeCountries.conflict");
  }

  if (rule === "invalid_length") {
    return getMessage("officeCountries.reasonInvalid");
  }

  if (rule === "invalid_format") {
    return getMessage("officeCountries.noteInvalid");
  }

  if (status === 409 || status === 404) {
    return getMessage("officeCountries.conflict");
  }

  return getMessage("officeCountries.failed");
}

/** One answer from the route: whether it worked, and what to say either way. */
interface ActionAnswer {
  readonly ok: boolean;
  readonly message: string;
}

async function postAction(
  action: CountryAction,
  fields: Readonly<Record<string, string>>,
): Promise<ActionAnswer> {
  const path = "/api/office/countries";
  const body = JSON.stringify({ action, ...fields });
  const proof = await deviceProofHeaders("POST", path, body);

  if (proof === null) {
    return { ok: false, message: getMessage("device.proofRequired") };
  }

  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...proof, ...(await csrfHeaders()) },
    body,
  });

  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);

    return { ok: false, message: messageForStatus(response.status, payload) };
  }

  return { ok: true, message: "" };
}

const pageGridClasses =
  "flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] lg:items-start";

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

const searchClasses =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary";

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

const linkClasses =
  "w-fit rounded-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-primary";

/** One instant, printed the same way on every office screen: UTC, minute precision. */
function formatInstant(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

const filterOptions: readonly CountryFilter[] = ["all", "enabled", "disabled", "sanctioned"];

function filterLabelKey(filter: CountryFilter): MessagePath {
  if (filter === "enabled") {
    return "officeCountries.filterEnabled";
  }

  if (filter === "disabled") {
    return "officeCountries.filterDisabled";
  }

  return filter === "sanctioned" ? "officeCountries.filterSanctioned" : "officeCountries.filterAll";
}

/** True when a row survives the search box and the state filter. */
function matchesFilter(
  country: CountrySwitchView,
  filter: CountryFilter,
  query: string,
): boolean {
  if (filter !== "all" && country.state !== filter) {
    return false;
  }

  const needle = query.trim().toUpperCase();

  if (needle.length === 0) {
    return true;
  }

  return (
    country.code.toUpperCase().includes(needle) ||
    country.alpha3.toUpperCase().includes(needle) ||
    country.name.toUpperCase().includes(needle)
  );
}

/** The one country the panel acts on, with the single turn its state allows. */
function CountryPanel({ country, canRaise }: { readonly country: CountrySwitchView; readonly canRaise: boolean }): ReactNode {
  const router = useRouter();
  const [busy, setBusy] = useState<CountryAction | null>(null);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  async function run(
    action: CountryAction,
    fields: Readonly<Record<string, string>>,
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

      setReason("");
      setNote("");
      setMessage(done);
      router.refresh();
    } catch {
      setBusy(null);
      setMessage(getMessage("officeCountries.failed"));
    }
  }

  const pending = country.pending;

  return (
    <section aria-labelledby="country-panel" className={cardClasses}>
      <header className={headerClasses}>
        <h2 className={nameClasses} id="country-panel">
          {country.name}
        </h2>
        <span className={badgeClasses}>{getMessage(countryStateLabelKey(country.state))}</span>
        <span className={bodyClasses}>{`${country.code} / ${country.alpha3}`}</span>
      </header>

      {country.state === "sanctioned" ? (
        <div className={bodyClasses}>
          <p className={termClasses}>{getMessage("officeCountries.sanctionLabel")}</p>
          <p className="mt-1">{country.sanctionNote ?? getMessage("officeCountries.noReason")}</p>
          <p className="mt-1">{getMessage("officeCountries.sanctionedExplanation")}</p>
        </div>
      ) : null}

      {country.state === "disabled" ? (
        <div className={bodyClasses}>
          <p className={termClasses}>{getMessage("officeCountries.disabledReasonLabel")}</p>
          <p className="mt-1">{country.disabledReason ?? getMessage("officeCountries.noReason")}</p>
        </div>
      ) : null}

      {pending === null ? null : (
        <p className={bodyClasses}>
          {formatMessage("officeCountries.pendingSince", {
            stage: getMessage(stageLabelKey(pending.stage)),
            at: formatInstant(pending.requestedAtEpochMs),
          })}
        </p>
      )}

      {country.opening === null ? null : (
        <p className={bodyClasses}>
          {formatMessage("officeCountries.openingReady", {
            at: formatInstant(country.opening.confirmedAtEpochMs),
          })}
        </p>
      )}

      {country.state === "enabled" ? (
        <div className="flex flex-col gap-2 border-t border-border pt-4">
          <p className={termClasses}>{getMessage("officeCountries.disableHeading")}</p>
          <p className={bodyClasses}>{getMessage("officeCountries.disableDescription")}</p>
          <label className="mt-2 block">
            <span className={bodyClasses}>{getMessage("officeCountries.disableReasonLabel")}</span>
            <textarea
              className={inputClasses}
              maxLength={COUNTRY_DISABLE_REASON_MAXIMUM_LENGTH}
              name="reason"
              onChange={(event): void => {
                setReason(event.target.value);
              }}
              required
              rows={3}
              value={reason}
            />
          </label>
          <p className={hintClasses}>{getMessage("officeCountries.disableReasonHint")}</p>
          <button
            className={dangerButtonClasses}
            disabled={busy !== null}
            onClick={(): void => {
              void run("disable", { countryId: country.id, reason }, getMessage("officeCountries.disabledDone"));
            }}
            type="button"
          >
            {busy === "disable"
              ? getMessage("officeCountries.disableBusy")
              : getMessage("officeCountries.disableSubmit")}
          </button>
        </div>
      ) : null}

      {country.state === "disabled" && country.opening !== null ? (
        <div className="flex flex-col gap-2 border-t border-border pt-4">
          <p className={termClasses}>{getMessage("officeCountries.enableHeading")}</p>
          <p className={bodyClasses}>{getMessage("officeCountries.enableDescription")}</p>
          <button
            className={primaryButtonClasses}
            disabled={busy !== null}
            onClick={(): void => {
              void run("enable", { countryId: country.id }, getMessage("officeCountries.enabledDone"));
            }}
            type="button"
          >
            {busy === "enable"
              ? getMessage("officeCountries.enableBusy")
              : getMessage("officeCountries.enableSubmit")}
          </button>
        </div>
      ) : null}

      {country.state === "disabled" && country.opening === null ? (
        canRaise ? (
          <div className="flex flex-col gap-2 border-t border-border pt-4">
            <p className={termClasses}>{getMessage("officeCountries.requestHeading")}</p>
            <p className={bodyClasses}>{getMessage("officeCountries.requestDescription")}</p>
            <label className="mt-2 block">
              <span className={bodyClasses}>{getMessage("officeCountries.requestNoteLabel")}</span>
              <textarea
                className={inputClasses}
                maxLength={1_000}
                name="note"
                onChange={(event): void => {
                  setNote(event.target.value);
                }}
                required
                rows={3}
                value={note}
              />
            </label>
            <p className={hintClasses}>{getMessage("officeCountries.requestNoteHint")}</p>
            <button
              className={secondaryButtonClasses}
              disabled={busy !== null}
              onClick={(): void => {
                void run("request", { countryId: country.id, note }, getMessage("officeCountries.requestedDone"));
              }}
              type="button"
            >
              {busy === "request"
                ? getMessage("officeCountries.requestBusy")
                : getMessage("officeCountries.requestSubmit")}
            </button>
          </div>
        ) : (
          <p className={bodyClasses}>{getMessage("officeCountries.cannotRaise")}</p>
        )
      ) : null}

      {country.state === "disabled" && pending === null && country.opening === null ? (
        <p className={bodyClasses}>{getMessage("officeCountries.approvalRequired")}</p>
      ) : null}

      {pending === null ? null : (
        <Link className={linkClasses} href="/ceo">
          {getMessage("officeCountries.queueLink")}
        </Link>
      )}

      {message === null ? null : (
        <p className={messageClasses} role="status">
          {message}
        </p>
      )}
    </section>
  );
}

export function CountrySwitchConsole({
  snapshot,
}: {
  readonly snapshot: CountrySwitchSnapshot;
}): ReactNode {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<CountryFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const listed = snapshot.countries.filter((country) => matchesFilter(country, filter, query));
  const selected = snapshot.countries.find((country) => country.id === selectedId) ?? null;

  return (
    <div className={pageGridClasses}>
      <section aria-labelledby="country-panel-heading" className="lg:order-2">
        {selected === null ? (
          <div className={cardClasses}>
            <h2 className={nameClasses} id="country-panel-heading">
              {getMessage("officeCountries.panelHeading")}
            </h2>
            <p className={bodyClasses}>{getMessage("officeCountries.panelEmpty")}</p>
          </div>
        ) : (
          <CountryPanel canRaise={snapshot.canRaise} country={selected} key={selected.id} />
        )}
      </section>

      <section aria-labelledby="country-list-heading" className={`${cardClasses} lg:order-1`}>
        <header className="flex flex-col gap-2">
          <h2 className={nameClasses} id="country-list-heading">
            {getMessage("officeCountries.listHeading")}
          </h2>
          <p className={bodyClasses}>
            {formatMessage("officeCountries.summary", {
              total: snapshot.countries.length,
              enabled: snapshot.enabledCount,
              disabled: snapshot.disabledCount,
              sanctioned: snapshot.sanctionedCount,
            })}
          </p>
          <p className={bodyClasses}>
            {formatMessage("officeCountries.deskSummary", {
              awaiting: snapshot.awaitingDecisionCount,
              ready: snapshot.readyToOpenCount,
            })}
          </p>
          <p className={bodyClasses}>{getMessage("officeCountries.listDescription")}</p>
        </header>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="block w-full">
            <span className={bodyClasses}>{getMessage("officeCountries.searchLabel")}</span>
            <input
              className={searchClasses}
              maxLength={80}
              name="query"
              onChange={(event): void => {
                setQuery(event.target.value);
              }}
              placeholder={getMessage("officeCountries.searchPlaceholder")}
              type="search"
              value={query}
            />
          </label>
          <label className="block w-full sm:w-56">
            <span className={bodyClasses}>{getMessage("officeCountries.filterLabel")}</span>
            <select
              className={searchClasses}
              name="filter"
              onChange={(event): void => {
                const next = event.target.value;

                setFilter(
                  next === "enabled" || next === "disabled" || next === "sanctioned"
                    ? next
                    : "all",
                );
              }}
              value={filter}
            >
              {filterOptions.map((option) => (
                <option key={option} value={option}>
                  {getMessage(filterLabelKey(option))}
                </option>
              ))}
            </select>
          </label>
        </div>

        <p className={bodyClasses}>
          {formatMessage("officeCountries.listCount", { count: listed.length })}
        </p>

        {listed.length === 0 ? (
          <p className={bodyClasses}>{getMessage("officeCountries.listEmpty")}</p>
        ) : (
          <ul className={listClasses}>
            {listed.map((country) => (
              <li key={country.id}>
                <button
                  aria-pressed={country.id === selectedId}
                  className={country.id === selectedId ? selectedRowClasses : rowClasses}
                  onClick={(): void => {
                    setSelectedId(country.id);
                  }}
                  type="button"
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <span className={termClasses}>{country.name}</span>
                    <span className={hintClasses}>{country.code}</span>
                  </span>
                  <span className="flex flex-wrap items-center gap-2">
                    <span className={badgeClasses}>
                      {getMessage(countryStateLabelKey(country.state))}
                    </span>
                    {country.pending === null ? null : (
                      <span className={badgeClasses}>
                        {getMessage("officeCountries.pendingBadge")}
                      </span>
                    )}
                    {country.opening === null ? null : (
                      <span className={badgeClasses}>
                        {getMessage("officeCountries.readyBadge")}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
