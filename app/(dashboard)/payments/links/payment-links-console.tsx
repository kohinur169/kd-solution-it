// path: app/(dashboard)/payments/links/payment-links-console.tsx
"use client";

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { portalPaymentRuleSentences } from "@/components/payments/portal-payment-refusal";
import { portalRefusalOf } from "@/components/payments/portal-form-refusal";
import { getMessage } from "@/lib/i18n/messages";
import { csrfHeaders } from "@/lib/security/csrf-client";

/**
 * Section 16's payment link console: make a link, share it, cancel it, reissue it.
 *
 * ## Why the URL is shown once and never again
 *
 * A link's token is its whole secret, and the platform stores only its digest - so the creation's answer is
 * the one moment the merchant can read the URL. The panel says so, and the list below offers **reissue** rather
 * than a "copy link" button it could not honour: a merchant who lost the URL gets a new credential for the same
 * payment request, and the old URL stops working. That is also why the token never appears in the list.
 *
 * ## Why every control re-reads the list
 *
 * Cancel and reissue both change a row another tab could be looking at, and the service refuses a revoke on a
 * link that has moved on rather than pretending it succeeded. Re-reading after each write means the console
 * shows what the server has rather than what the browser hoped, which is the whole reason the list is not
 * maintained in local state by hand.
 *
 * ## Why the refusals are read, not guessed
 *
 * Every refusal is the platform's error envelope, and the rule inside it is mapped by the same module the
 * payer's page uses - so "this link has moved on" means the same sentence in both places, and a rule a later
 * STEP adds surfaces as a marked panel rather than as "something went wrong".
 */

/** One link as the list route answers it. Nothing here is a token. */
interface ListedLink {
  readonly linkId: string;
  readonly amountMinor: string;
  readonly amountText: string;
  readonly currency: string;
  readonly description: string;
  readonly reference: string | null;
  readonly state: string;
  readonly expiresAt: string;
  readonly paidAt: string | null;
}

/** What one read of the list produced, so the effect and the handlers map one shape to state. */
interface LinkListState {
  readonly links: readonly ListedLink[];
  readonly error: string | null;
}

/** The URL the merchant copies, once. */
interface IssuedLink {
  readonly url: string;
  readonly amountText: string;
  readonly description: string;
}

const pageClasses = "mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10";

const panelClasses =
  "flex flex-col gap-4 rounded-lg border border-border bg-surface p-4 text-foreground shadow-card sm:p-6";

const headingClasses = "text-sm font-semibold tracking-tight text-foreground";

const titleClasses = "text-xl font-semibold tracking-tight text-foreground sm:text-2xl";

const bodyClasses = "text-sm text-muted-foreground";

const noteClasses = "text-xs text-muted-foreground";

const labelClasses = "flex flex-col gap-1 text-sm font-medium text-foreground";

const inputClasses =
  "w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary";

const primaryButtonClasses =
  "inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50";

const quietButtonClasses =
  "inline-flex items-center justify-center rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground disabled:opacity-50";

const rowClasses = "flex flex-col gap-2 border-t border-border pt-3 text-sm first:border-t-0 first:pt-0";

const errorClasses = "rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-sm text-danger";

const successClasses = "flex flex-col gap-2 rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-sm";

/** The instant a merchant reads, in the same spelling every portal page uses. */
function instantOf(iso: string | null): string {
  if (iso === null) {
    return "";
  }

  const parsed = Date.parse(iso);

  return Number.isFinite(parsed) ? new Date(parsed).toISOString().replace("T", " ").slice(0, 16) : iso;
}

/** Read the merchant's own links. A refused or failed read answers with the list it could not build. */
async function readLinks(): Promise<LinkListState> {
  try {
    const response = await fetch("/api/payment-links", {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
    });

    if (response.status === 401 || response.status === 403) {
      return { links: [], error: getMessage("paymentLinks.roleRefusedBody") };
    }

    if (!response.ok) {
      return { links: [], error: getMessage("paymentLinks.errorGeneric") };
    }

    const payload = (await response.json()) as { readonly links?: readonly ListedLink[] };

    return { links: payload.links ?? [], error: null };
  } catch {
    return { links: [], error: getMessage("paymentLinks.errorGeneric") };
  }
}

/** The sentence for one list state. */
function stateTextOf(state: string): string {
  switch (state) {
    case "paid":
      return getMessage("paymentLinks.statePaid");
    case "revoked":
      return getMessage("paymentLinks.stateRevoked");
    case "expired":
      return getMessage("paymentLinks.stateExpired");
    default:
      return getMessage("paymentLinks.stateActive");
  }
}

/** The overrides the shared refusal reader uses: this console's merchant-facing vocabulary. */
function ruleSentences(): Readonly<Record<string, string>> {
  return {
    ...portalPaymentRuleSentences(),
    payment_links_not_in_plan: getMessage("paymentLinks.notEntitledBody"),
    payment_link_store_unavailable: getMessage("paymentLinks.unavailableBody"),
  };
}

export function PaymentLinksConsole(): ReactNode {
  const [links, setLinks] = useState<readonly ListedLink[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [amount, setAmount] = useState<string>("");
  const [description, setDescription] = useState<string>("");
  const [reference, setReference] = useState<string>("");
  const [days, setDays] = useState<string>("7");
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [issued, setIssued] = useState<IssuedLink | null>(null);
  const [copied, setCopied] = useState<boolean>(false);
  /** The link whose cancel button has been pressed once, so the second press is the confirmation. */
  const [confirming, setConfirming] = useState<string | null>(null);

  /** Re-read the merchant's links, which is how every control refreshes the page's facts. */
  const load = useCallback(async (): Promise<void> => {
    const state = await readLinks();
    setLinks(state.links);
    setError(state.error);
    setLoading(false);
  }, []);

  // The first read is the effect's own, declared inside it: the list is an external system this page
  // subscribes to, and a cancelled effect must not write a stale answer over a newer one.
  useEffect(() => {
    let cancelled = false;

    async function start(): Promise<void> {
      const state = await readLinks();

      if (cancelled) {
        return;
      }

      setLinks(state.links);
      setError(state.error);
      setLoading(false);
    }

    void start();

    return () => {
      cancelled = true;
    };
  }, []);

  /** Make one link, and show its URL while it exists to be shown. */
  async function create(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    setCopied(false);

    const parsedDays = Number.parseInt(days, 10);
    const lifetimeSeconds = Number.isFinite(parsedDays) ? parsedDays * 86_400 : undefined;

    try {
      const response = await fetch("/api/payment-links", {
        method: "POST",
        headers: { "content-type": "application/json", ...(await csrfHeaders()) },
        body: JSON.stringify({
          amount,
          description,
          reference: reference.trim().length === 0 ? null : reference,
          ...(lifetimeSeconds === undefined ? {} : { expires_in_seconds: lifetimeSeconds }),
        }),
        credentials: "same-origin",
        cache: "no-store",
      });

      if (!response.ok) {
        const refusal = await portalRefusalOf(response, getMessage("paymentLinks.errorGeneric"), ruleSentences());
        setError(refusal.text);

        return;
      }

      const payload = (await response.json()) as {
        readonly url?: string;
        readonly amountText?: string;
        readonly description?: string;
      };

      if (payload.url === undefined) {
        setError(getMessage("paymentLinks.errorGeneric"));

        return;
      }

      setIssued({
        url: payload.url,
        amountText: payload.amountText ?? amount,
        description: payload.description ?? description,
      });
      setAmount("");
      setDescription("");
      setReference("");
      await load();
    } catch {
      setError(getMessage("paymentLinks.errorGeneric"));
    } finally {
      setBusy(false);
    }
  }

  /** Cancel a link, after the merchant has pressed the confirmation the row shows. */
  async function revoke(linkId: string): Promise<void> {
    setConfirming(null);
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch(`/api/payment-links/${encodeURIComponent(linkId)}/revoke`, {
        method: "POST",
        headers: { ...(await csrfHeaders()) },
        credentials: "same-origin",
        cache: "no-store",
      });

      if (!response.ok) {
        const refusal = await portalRefusalOf(response, getMessage("paymentLinks.errorGeneric"), ruleSentences());
        setError(refusal.text);

        return;
      }

      setIssued(null);
      await load();
    } catch {
      setError(getMessage("paymentLinks.errorGeneric"));
    } finally {
      setBusy(false);
    }
  }

  /** Give a dead link a fresh credential, and show the new URL while it exists to be shown. */
  async function reissue(linkId: string): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    setCopied(false);

    try {
      const response = await fetch(`/api/payment-links/${encodeURIComponent(linkId)}/reissue`, {
        method: "POST",
        headers: { ...(await csrfHeaders()) },
        credentials: "same-origin",
        cache: "no-store",
      });

      if (!response.ok) {
        const refusal = await portalRefusalOf(response, getMessage("paymentLinks.errorGeneric"), ruleSentences());
        setError(refusal.text);

        return;
      }

      const payload = (await response.json()) as { readonly url?: string };
      const row = links.find((link) => link.linkId === linkId);

      if (payload.url === undefined) {
        setError(getMessage("paymentLinks.errorGeneric"));

        return;
      }

      setIssued({
        url: payload.url,
        amountText: row?.amountText ?? "",
        description: row?.description ?? "",
      });
      setNotice(getMessage("paymentLinks.reissuedBody"));
      await load();
    } catch {
      setError(getMessage("paymentLinks.errorGeneric"));
    } finally {
      setBusy(false);
    }
  }

  async function copy(url: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // A browser that refuses the clipboard still shows the URL, which the merchant can select by hand.
      setCopied(false);
    }
  }

  return (
    <main className={pageClasses}>
      <header className="flex flex-col gap-2">
        <h1 className={titleClasses}>{getMessage("paymentLinks.title")}</h1>
        <p className={bodyClasses}>{getMessage("paymentLinks.description")}</p>
      </header>

      {error === null ? null : (
        <p role="alert" className={errorClasses}>
          {error}
        </p>
      )}

      {issued === null ? null : (
        <section aria-labelledby="payment-link-issued-heading" className={successClasses}>
          <h2 id="payment-link-issued-heading" className="text-sm font-semibold">
            {notice === null ? getMessage("paymentLinks.createdTitle") : getMessage("paymentLinks.reissuedTitle")}
          </h2>
          <p className={noteClasses}>
            {notice ?? getMessage("paymentLinks.createdBody")}
          </p>
          <code className="break-all rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground">
            {issued.url}
          </code>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={quietButtonClasses} onClick={() => void copy(issued.url)}>
              {copied ? getMessage("paymentLinks.copied") : getMessage("paymentLinks.copy")}
            </button>
            <span className={noteClasses}>
              {issued.description} · {issued.amountText}
            </span>
          </div>
        </section>
      )}

      <section aria-labelledby="payment-link-create-heading" className={panelClasses}>
        <h2 id="payment-link-create-heading" className={headingClasses}>
          {getMessage("paymentLinks.createTitle")}
        </h2>
        <form className="flex flex-col gap-3" onSubmit={(event) => void create(event)}>
          <label className={labelClasses}>
            {getMessage("paymentLinks.amountLabel")}
            <input
              className={inputClasses}
              name="amount"
              inputMode="decimal"
              autoComplete="off"
              placeholder={getMessage("paymentLinks.amountPlaceholder")}
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              required
            />
          </label>
          <label className={labelClasses}>
            {getMessage("paymentLinks.descriptionLabel")}
            <input
              className={inputClasses}
              name="description"
              autoComplete="off"
              maxLength={200}
              placeholder={getMessage("paymentLinks.descriptionPlaceholder")}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              required
            />
          </label>
          <label className={labelClasses}>
            {getMessage("paymentLinks.referenceLabel")}
            <input
              className={inputClasses}
              name="reference"
              autoComplete="off"
              maxLength={64}
              value={reference}
              onChange={(event) => setReference(event.target.value)}
            />
          </label>
          <p className={noteClasses}>{getMessage("paymentLinks.referenceHelp")}</p>
          <label className={labelClasses}>
            {getMessage("paymentLinks.lifetimeLabel")}
            <select
              className={inputClasses}
              name="lifetime"
              value={days}
              onChange={(event) => setDays(event.target.value)}
            >
              <option value="1">1</option>
              <option value="7">7</option>
              <option value="14">14</option>
              <option value="30">30</option>
            </select>
          </label>
          <p className={noteClasses}>{getMessage("paymentLinks.lifetimeHelp")}</p>
          <button type="submit" className={primaryButtonClasses} disabled={busy}>
            {busy ? getMessage("paymentLinks.submitting") : getMessage("paymentLinks.submit")}
          </button>
        </form>
      </section>

      <section aria-labelledby="payment-link-list-heading" className={panelClasses}>
        <h2 id="payment-link-list-heading" className={headingClasses}>
          {getMessage("paymentLinks.listTitle")}
        </h2>
        {loading ? (
          <p className={bodyClasses}>{getMessage("paymentLinks.loading")}</p>
        ) : links.length === 0 ? (
          <p className={bodyClasses}>{getMessage("paymentLinks.listEmpty")}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {links.map((link) => (
              <li key={link.linkId} className={rowClasses}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium text-foreground">{link.description}</span>
                  <span className="tabular-nums text-foreground">{link.amountText}</span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                    {stateTextOf(link.state)}
                  </span>
                  <span className={noteClasses}>
                    {getMessage("paymentLinks.expiresLabel")} {instantOf(link.expiresAt)}
                  </span>
                  {link.paidAt === null ? null : (
                    <span className={noteClasses}>
                      {getMessage("paymentLinks.paidLabel")} {instantOf(link.paidAt)}
                    </span>
                  )}
                  {link.reference === null ? null : <span className={noteClasses}>{link.reference}</span>}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {link.state === "active" && confirming !== link.linkId ? (
                    <button
                      type="button"
                      className={quietButtonClasses}
                      disabled={busy}
                      onClick={() => setConfirming(link.linkId)}
                    >
                      {getMessage("paymentLinks.revoke")}
                    </button>
                  ) : null}
                  {link.state === "active" && confirming === link.linkId ? (
                    <span className="flex flex-wrap items-center gap-2">
                      <span className={noteClasses}>{getMessage("paymentLinks.revokeConfirm")}</span>
                      <button
                        type="button"
                        className={quietButtonClasses}
                        disabled={busy}
                        onClick={() => void revoke(link.linkId)}
                      >
                        {getMessage("paymentLinks.revoke")}
                      </button>
                      <button
                        type="button"
                        className={quietButtonClasses}
                        disabled={busy}
                        onClick={() => setConfirming(null)}
                      >
                        {getMessage("paymentLinks.dismiss")}
                      </button>
                    </span>
                  ) : null}
                  {link.state === "revoked" || link.state === "expired" ? (
                    <button
                      type="button"
                      className={quietButtonClasses}
                      disabled={busy}
                      onClick={() => void reissue(link.linkId)}
                    >
                      {getMessage("paymentLinks.reissue")}
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className={noteClasses}>{getMessage("paymentLinks.reissueHelp")}</p>
      </section>
    </main>
  );
}
