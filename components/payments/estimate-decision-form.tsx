// path: components/payments/estimate-decision-form.tsx
"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { getMessage } from "../../lib/i18n/messages.ts";
import { csrfHeaders } from "../../lib/security/csrf-client.ts";
import { portalFailureTextOf } from "./portal-form-refusal.ts";

/**
 * The client's decision on a tokenized estimate: accept it or decline it, with a typed signature.
 *
 * ## What the form sends
 *
 * A decision, a name, an email address, the ticked consent and two facts about the device it was filled
 * in on. It does not send the offer, its digest, its company or the address of the connection: the first
 * three are read from the link, and the address is read from the request by the route. A digest from a
 * browser would be a digest of whatever the browser happened to hold.
 *
 * ## Why the consent sentence is read rather than typed
 *
 * `portal.signatureConsent` is the same catalog key the server stores beside the decision, so the words a
 * client ticks are the words the evidence keeps. If the copy ever changes, a decision recorded yesterday
 * still holds the sentence it was given - and the record, not this component, is what a dispute reads.
 *
 * ## Why a typed name is the signature
 *
 * Section 16 asks for a digital signature and names the evidence: name, email, consent, time, address,
 * location and device. A drawn image would be a ninth field with no legal weight this page could add, so
 * the typed name is the signature, and the record says so. The device fingerprint is derived here from
 * what the browser reports about itself and hashed to one short printable token; the location is the
 * browser's own time zone. Neither is a claim about a person, and both are labelled as they are.
 *
 * ## What happens after a decision
 *
 * The page is refreshed rather than patched, so the client sees the record the database holds. A conflict
 * means somebody else decided first, and the sentence says to reload instead of pretending the click
 * landed.
 */

const containerClasses = "flex flex-col gap-4";

const fieldClasses = "flex flex-col gap-1";

const labelClasses = "text-sm font-medium";

const hintClasses = "text-xs text-muted-foreground";

const inputClasses =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary";

const consentRowClasses = "flex items-start gap-2 rounded-md border border-border p-3";

const consentLabelClasses = "text-sm text-foreground";

const buttonsClasses = "flex flex-col gap-2 sm:flex-row-reverse sm:justify-start";

const acceptClasses =
  "inline-flex w-full items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60 sm:w-auto";

const declineClasses =
  "inline-flex w-full items-center justify-center rounded-lg border border-destructive px-4 py-2 text-sm font-medium text-destructive outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60 sm:w-auto";

const errorClasses = "text-sm font-medium text-destructive";

/**
 * The rules only a quote can refuse with, spelled once.
 *
 * The shared helper already words every rule the two portal forms have in common; these six are the ones
 * an estimate adds, and naming them here keeps the shared switch from growing a sentence about invoices
 * that would never be true of a quote.
 */
const estimateRuleSentences: Readonly<Record<string, string>> = {
  expired: getMessage("portal.ruleEstimateExpired"),
  already_accepted: getMessage("portal.ruleEstimateAlreadyAccepted"),
  already_declined: getMessage("portal.ruleEstimateAlreadyDeclined"),
  withdrawn: getMessage("portal.ruleEstimateWithdrawn"),
  self_decision: getMessage("portal.ruleEstimateSelfDecision"),
  evidence_missing: getMessage("portal.ruleEstimateEvidenceMissing"),
};

/** The longest location a `0027` row accepts, and the longest fingerprint, kept in step with the columns. */
const maximumGeoLength = 200;
const maximumFingerprintLength = 128;

/** Printable ASCII only, because `estimate_signatures_fingerprint_check` stores nothing else. */
const printableAsciiPattern = /^[!-~]{8,128}$/u;

/**
 * The browser's own time zone, which is the only location a page can name without asking permission.
 *
 * A named zone is a region, not an address, and the record says "location" rather than "home": an honest
 * small fact is worth more than a precise one this page cannot obtain.
 */
function geoLocationOf(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";

    if (zone.length < 1 || zone.length > maximumGeoLength) {
      return null;
    }

    return /^[\x20-\x7E]+$/u.test(zone) ? zone : null;
  } catch {
    return null;
  }
}

/**
 * One short, stable token for this browser, hashed from what the browser reports about itself.
 *
 * The parts are the ones a device keeps across a reload and a session: the user agent, the preferred
 * languages, the screen, the core count and the time zone. SHA-256 keeps the token printable, short and
 * comparable, and stores no more about the device than the columns already describe. A browser that
 * refuses `crypto.subtle` gets no fingerprint rather than a guess.
 */
async function deviceFingerprintOf(): Promise<string | null> {
  try {
    const parts = [
      navigator.userAgent,
      navigator.language,
      navigator.languages.join(","),
      `${screen.width}x${screen.height}x${screen.colorDepth}`,
      String(navigator.hardwareConcurrency ?? 0),
      geoLocationOf() ?? "",
    ];
    const bytes = new TextEncoder().encode(parts.join("\n"));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
    const token = `web/${hex}`;

    return printableAsciiPattern.test(token) && token.length <= maximumFingerprintLength ? token : null;
  } catch {
    return null;
  }
}

export interface EstimateDecisionFormProps {
  readonly token: string;
}

export function EstimateDecisionForm({ token }: EstimateDecisionFormProps): ReactNode {
  const router = useRouter();
  const [signerName, setSignerName] = useState("");
  const [signerEmail, setSignerEmail] = useState("");
  const [consented, setConsented] = useState(false);
  const [busy, setBusy] = useState<"accepted" | "declined" | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function send(decision: "accepted" | "declined"): Promise<void> {
    setBusy(decision);
    setMessage(null);

    try {
      const fingerprint = await deviceFingerprintOf();
      const response = await fetch(`/e/${encodeURIComponent(token)}/signature`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(await csrfHeaders()) },
        body: JSON.stringify({
          decision,
          signer_name: signerName.trim(),
          signer_email: signerEmail.trim(),
          consent_accepted: consented,
          device_fingerprint: fingerprint,
          geo_location: geoLocationOf(),
        }),
      });

      if (!response.ok) {
        setMessage(
          await portalFailureTextOf(
            response,
            getMessage("portal.estimateDecisionFailed"),
            estimateRuleSentences,
          ),
        );
        return;
      }

      setSignerName("");
      setSignerEmail("");
      setConsented(false);
      router.refresh();
    } catch {
      setMessage(getMessage("portal.estimateDecisionFailed"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <form
      onSubmit={(event: FormEvent<HTMLFormElement>): void => {
        // Nothing is submitted by pressing Enter: the two decisions are buttons, because accepting an
        // offer is not the kind of thing a stray keystroke should do.
        event.preventDefault();
      }}
      className={containerClasses}
      noValidate
    >
      <p className={hintClasses}>{getMessage("portal.estimateDecisionBody")}</p>

      <div className={fieldClasses}>
        <label className={labelClasses} htmlFor="portal-estimate-name">
          {getMessage("portal.estimateSignerNameLabel")}
        </label>
        <input
          id="portal-estimate-name"
          name="signer_name"
          type="text"
          autoComplete="name"
          maxLength={160}
          required
          value={signerName}
          onChange={(event) => setSignerName(event.target.value)}
          className={inputClasses}
        />
        <span className={hintClasses}>{getMessage("portal.estimateSignerNameHint")}</span>
      </div>

      <div className={fieldClasses}>
        <label className={labelClasses} htmlFor="portal-estimate-email">
          {getMessage("portal.estimateSignerEmailLabel")}
        </label>
        <input
          id="portal-estimate-email"
          name="signer_email"
          type="email"
          autoComplete="email"
          maxLength={254}
          required
          value={signerEmail}
          onChange={(event) => setSignerEmail(event.target.value)}
          className={inputClasses}
        />
        <span className={hintClasses}>{getMessage("portal.estimateSignerEmailHint")}</span>
      </div>

      <div className={consentRowClasses}>
        <input
          id="portal-estimate-consent"
          name="consent_accepted"
          type="checkbox"
          required
          checked={consented}
          onChange={(event) => setConsented(event.target.checked)}
          className="mt-0.5 size-4 shrink-0 accent-primary"
        />
        <label className={consentLabelClasses} htmlFor="portal-estimate-consent">
          {getMessage("portal.signatureConsent")}
        </label>
      </div>

      {message === null ? null : (
        <p role="alert" className={errorClasses}>
          {message}
        </p>
      )}

      <div className={buttonsClasses}>
        <button
          type="button"
          disabled={busy !== null}
          onClick={(): void => {
            void send("accepted");
          }}
          className={acceptClasses}
        >
          {busy === "accepted"
            ? getMessage("portal.estimateAcceptSubmitting")
            : getMessage("portal.estimateAcceptSubmit")}
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={(): void => {
            void send("declined");
          }}
          className={declineClasses}
        >
          {busy === "declined"
            ? getMessage("portal.estimateDeclineSubmitting")
            : getMessage("portal.estimateDeclineSubmit")}
        </button>
      </div>
    </form>
  );
}
