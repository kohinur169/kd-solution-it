// path: components/payments/card-payment-form.tsx
"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { getMessage } from "../../lib/i18n/messages.ts";
import { csrfHeaders } from "../../lib/security/csrf-client.ts";
import { portalFailureTextOf } from "./portal-form-refusal.ts";
import { portalPaymentRuleSentences } from "./portal-payment-refusal.ts";

/**
 * The card form: three iframes the provider owns, and nothing else.
 *
 * ## Where the card goes
 *
 * Section 18: "card number, expiry and CVV are entered only inside the provider hosted secure fields.
 * Platform code and servers never read, store or track card data or keystrokes." This component renders three
 * empty containers - `#ccnumber`, `#ccexp` and `#cvv`, the ids NMI's own quick start documents - and NMI's
 * Collect.js script fills each one with an iframe served from `secure.nmi.com`. Every keystroke of a card
 * number happens inside that frame, in a document this origin cannot read. There is no `<input>` for a card
 * number in this file, no `onChange` over one, and no state that could hold one: the only value this
 * component ever learns is the token the provider hands back.
 *
 * ## Why the script is injected rather than a script tag in the markup
 *
 * The tokenization key is per business, so the tag cannot be static, and the containers must exist before the
 * script draws into them. Mounting the script from an effect gives both: the fields are on the page, then the
 * provider is asked to fill them. One injection per mount, so a re-render cannot fetch the script twice.
 *
 * ## Why the button starts disabled
 *
 * NMI's own guidance is to "disable form submission until you have confirmed that the payment fields are
 * successfully stored". Until Collect.js has loaded and drawn its frames there is nothing to submit, and a
 * button that could fire before then would post an empty token.
 *
 * ## What a refusal does to the token
 *
 * A Collect.js token is single use and dies the first time it is sent to the provider. So a refused attempt
 * clears the fields (`CollectJS.clearInputs`) and asks for the card again, rather than retrying a token that
 * is already spent. An unknown outcome is not retried at all: the sentence says the payment is being
 * reconciled, because a lost answer may still have taken the money.
 */

/** The one function of NMI's script this page calls, described as the provider documents it. */
interface CollectJsApi {
  configure(options: {
    readonly paymentSelector?: string;
    readonly callback?: (response: unknown) => void;
  }): void;
  clearInputs?(): void;
}

declare global {
  interface Window {
    CollectJS?: CollectJsApi;
  }
}

/** The ids NMI's quick start documents as the defaults its script looks for. */
const CARD_NUMBER_FIELD_ID = "ccnumber";
const EXPIRY_FIELD_ID = "ccexp";
const SECURITY_CODE_FIELD_ID = "cvv";
const SUBMIT_BUTTON_ID = "portal-pay-submit";

const containerClasses = "flex flex-col gap-4";

const fieldClasses = "flex flex-col gap-1";

const labelClasses = "text-sm font-medium";

const hostClasses =
  "h-10 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground";

const hintClasses = "text-xs text-muted-foreground";

const submitClasses =
  "inline-flex w-full items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60 sm:w-auto";

const errorClasses = "text-sm font-medium text-destructive";

const successClasses = "text-sm font-medium text-success";

/** The instant a captured payment reports, printed the way every record on this portal prints. */
function instantOf(iso: string): string {
  const parsed = Date.parse(iso);

  return Number.isFinite(parsed) ? new Date(parsed).toISOString().replace("T", " ").slice(0, 16) : iso;
}

export interface CardPaymentFormProps {
  readonly token: string;
  readonly amountText: string;
  readonly idempotencyKey: string;
  readonly secureFields: {
    readonly scriptUrl: string;
    readonly tokenizationKey: string;
    readonly environment: "sandbox" | "production";
  };
}

export function CardPaymentForm({
  token,
  amountText,
  idempotencyKey,
  secureFields,
}: CardPaymentFormProps): ReactNode {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [captured, setCaptured] = useState<{ readonly amount: string; readonly at: string } | null>(null);
  const submitted = useRef(false);

  const send = useCallback(
    async (paymentToken: string): Promise<void> => {
      if (submitted.current) {
        return;
      }

      submitted.current = true;
      setBusy(true);
      setMessage(null);

      try {
        const response = await fetch(`/i/${encodeURIComponent(token)}/pay/charge`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(await csrfHeaders()) },
          body: JSON.stringify({
            collectjs_token: paymentToken,
            idempotency_key: idempotencyKey,
          }),
        });

        if (!response.ok) {
          setMessage(
            await portalFailureTextOf(
              response,
              getMessage("portal.paymentFailed"),
              portalPaymentRuleSentences(),
            ),
          );
          // The token was spent by the attempt, so the fields are cleared and the card is asked for again.
          window.CollectJS?.clearInputs?.();
          return;
        }

        const body: unknown = await response.json();
        const parsed = body as { readonly amountText?: unknown; readonly capturedAt?: unknown };

        setCaptured({
          amount: typeof parsed.amountText === "string" ? parsed.amountText : amountText,
          at: typeof parsed.capturedAt === "string" ? parsed.capturedAt : new Date().toISOString(),
        });
        router.refresh();
      } catch {
        setMessage(getMessage("portal.paymentFailed"));
        window.CollectJS?.clearInputs?.();
      } finally {
        submitted.current = false;
        setBusy(false);
      }
    },
    [amountText, idempotencyKey, router, token],
  );

  const configure = useCallback((): void => {
    const api = window.CollectJS;

    if (api === undefined) {
      setMessage(getMessage("portal.paymentFieldsUnavailable"));
      return;
    }

    api.configure({
      paymentSelector: `#${SUBMIT_BUTTON_ID}`,
      // The provider calls this once the fields hold a valid, stored card; from here the token is ours.
      callback: (response: unknown): void => {
        const candidate = response as { readonly token?: unknown } | null;
        const paymentToken = typeof candidate?.token === "string" ? candidate.token : "";

        if (paymentToken.length === 0) {
          setMessage(getMessage("portal.paymentFieldsInvalid"));
          return;
        }

        void send(paymentToken);
      },
    });

    setReady(true);
  }, [send]);

  useEffect(() => {
    if (window.CollectJS !== undefined) {
      // Already on the page - a second render, or a reload that kept the script - so the fields are drawn on
      // the next frame rather than synchronously inside this effect.
      const frame = requestAnimationFrame(configure);

      return () => {
        cancelAnimationFrame(frame);
      };
    }

    const script = document.createElement("script");
    script.src = secureFields.scriptUrl;
    script.async = true;
    // The public tokenization key, and the variant the provider's quick start documents. The private key
    // never leaves the server, and this attribute is the only credential the page holds.
    script.setAttribute("data-tokenization-key", secureFields.tokenizationKey);
    script.setAttribute("data-variant", "inline");
    script.addEventListener("load", configure);
    script.addEventListener("error", () => {
      setMessage(getMessage("portal.paymentFieldsUnavailable"));
    });

    document.head.append(script);

    return () => {
      script.removeEventListener("load", configure);
      script.remove();
    };
    // The script is mounted once per render of this page: the key it carries does not change under it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (captured !== null) {
    return (
      <div className={containerClasses}>
        <p className={successClasses}>{getMessage("portal.paymentCapturedTitle")}</p>
        <p className={hintClasses}>
          {getMessage("portal.paymentCapturedBody")
            .replace("{amount}", captured.amount)
            .replace("{date}", instantOf(captured.at))}
        </p>
      </div>
    );
  }

  return (
    <form
      onSubmit={(event): void => {
        // Collect.js owns the button: it validates the fields and answers through the callback above, so the
        // browser must never post the form itself.
        event.preventDefault();
      }}
      className={containerClasses}
      noValidate
    >
      <div className={fieldClasses}>
        <label className={labelClasses} htmlFor={CARD_NUMBER_FIELD_ID}>
          {getMessage("portal.paymentCardNumberLabel")}
        </label>
        <div id={CARD_NUMBER_FIELD_ID} className={hostClasses} />
      </div>

      <div className="flex flex-col gap-4 sm:flex-row">
        <div className={`${fieldClasses} sm:w-40`}>
          <label className={labelClasses} htmlFor={EXPIRY_FIELD_ID}>
            {getMessage("portal.paymentExpiryLabel")}
          </label>
          <div id={EXPIRY_FIELD_ID} className={hostClasses} />
        </div>

        <div className={`${fieldClasses} sm:w-32`}>
          <label className={labelClasses} htmlFor={SECURITY_CODE_FIELD_ID}>
            {getMessage("portal.paymentSecurityCodeLabel")}
          </label>
          <div id={SECURITY_CODE_FIELD_ID} className={hostClasses} />
        </div>
      </div>

      <p className={hintClasses}>{getMessage("portal.paymentSecureFieldsNote")}</p>

      {message === null ? null : (
        <p role="alert" className={errorClasses}>
          {message}
        </p>
      )}

      <button
        id={SUBMIT_BUTTON_ID}
        type="submit"
        disabled={!ready || busy}
        className={submitClasses}
      >
        {busy
          ? getMessage("portal.paymentSubmitting")
          : getMessage("portal.paymentSubmit").replace("{amount}", amountText)}
      </button>
    </form>
  );
}
