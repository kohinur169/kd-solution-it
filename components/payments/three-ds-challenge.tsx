// path: components/payments/three-ds-challenge.tsx
"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { getMessage } from "../../lib/i18n/messages.ts";

/**
 * The form that hands the payer to their bank.
 *
 * ## What it posts, and what it does not
 *
 * Three hidden fields - the issuer's request (`PaReq`), this platform's sealed handle (`MD`) and the address
 * to come back to (`TermUrl`) - and nothing else. There is no card input here, no keystroke handler and no
 * state: the card was tokenized by the provider's own hosted fields, and this form carries the issuer's
 * question, not the card.
 *
 * ## Why it submits itself
 *
 * A redirect 3D Secure challenge is a form post to the issuer, so the flow is: the payment form gets a
 * challenge back from this platform, this component mounts, and it posts. The visible button is what a payer
 * sees if the automatic post does not happen - a browser that blocked the script, a page restored from a
 * session - and pressing it does exactly what the automatic submission did.
 *
 * ## Why it is a client component at all
 *
 * Only for the automatic submission. The markup is a plain form, and the rules it keeps are the ones a form
 * keeps: the action is an `https` address the server checked, the fields are named exactly as the protocol
 * names them, and no value in the form came from anywhere but this platform and the issuer.
 */

export interface ThreeDsChallengeProps {
  /** The issuer's page, already checked by the server for scheme, credentials and shape. */
  readonly acsUrl: string;
  /** The issuer's request, opaque to this platform. */
  readonly paReq: string;
  /** This platform's sealed handle, which the issuer returns untouched. */
  readonly md: string;
  /** Where the issuer sends the payer back to. */
  readonly termUrl: string;
}

const containerClasses = "flex flex-col gap-3";

const titleClasses = "text-sm font-semibold tracking-tight text-foreground";

const bodyClasses = "text-sm text-muted-foreground";

const noteClasses = "text-xs text-muted-foreground";

const submitClasses =
  "inline-flex w-fit items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary";

export function ThreeDsChallenge({ acsUrl, paReq, md, termUrl }: ThreeDsChallengeProps): ReactNode {
  const form = useRef<HTMLFormElement | null>(null);

  useEffect(() => {
    // Deferred to the next frame: submitting inside the effect that mounted the form is a navigation the
    // browser has not laid out yet, and the button is the fallback if the frame never runs.
    const frame = requestAnimationFrame(() => {
      form.current?.submit();
    });

    return () => {
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <form ref={form} method="post" action={acsUrl} className={containerClasses}>
      <p className={titleClasses}>{getMessage("portal.paymentThreeDsChallengeTitle")}</p>
      <p className={bodyClasses}>{getMessage("portal.paymentThreeDsChallengeBody")}</p>
      <input type="hidden" name="PaReq" value={paReq} />
      <input type="hidden" name="MD" value={md} />
      <input type="hidden" name="TermUrl" value={termUrl} />
      <button type="submit" className={submitClasses}>
        {getMessage("portal.paymentThreeDsContinue")}
      </button>
      <p className={noteClasses}>{getMessage("portal.paymentThreeDsChallengeNote")}</p>
    </form>
  );
}
