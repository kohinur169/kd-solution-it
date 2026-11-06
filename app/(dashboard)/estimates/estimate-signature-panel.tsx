// path: app/(dashboard)/estimates/estimate-signature-panel.tsx
import type { ReactNode } from "react";
import { getMessage } from "@/lib/i18n/messages";
import type { EstimateSignatureSnapshot } from "@/services/estimates/estimate-signature";

/**
 * Section 16's evidence, read only.
 *
 * ## Why there is not one control on this panel
 *
 * `0027` is append only: its trigger refuses an update and a delete, and the row's own version never moves
 * off one. A button here could therefore only fail, and a button that fails is worse than no button - it
 * tells a merchant the record is the kind of thing this platform edits. So the panel is a definition list
 * and nothing else, and it says in one sentence why.
 *
 * ## Why three states and not two
 *
 * "No signature yet" and "the evidence could not be read" are different facts, and collapsing them is the
 * mistake this screen's own refusals are written to avoid: a merchant who sees "nothing recorded" during an
 * outage would believe a client's decision had been lost, and would say so in a dispute. The third state
 * costs one sentence and keeps an outage from reading as an absence.
 *
 * ## Why the digest is printed whole
 *
 * Sixty-four hex characters are the evidence's spine: they are what ties the decision to the offer the
 * client saw. Truncating them to fit a column would make the one value that has to be comparable against
 * a stored row incomparable, so the panel wraps it instead, in a monospace face, and takes the full width
 * from `sm` up. A merchant who has to check it against a chargeback pack can.
 *
 * ## Why no storage key is printed
 *
 * A drawn signature image, when one exists, is named in a sentence rather than shown as its storage path:
 * the path is this deployment's internal layout, it is not one of section 16's eight elements, and there is
 * no viewer for it in this build. Saying that something is stored is the useful fact; the key is not.
 *
 * ## The width
 *
 * The screen's own: one column capped at `max-w-3xl`, and this panel's list becomes two columns only from
 * `sm` up, because at 360px an address and a fingerprint side by side are two columns of clipped text.
 */
export type SignaturePanelState =
  | { readonly kind: "none" }
  | { readonly kind: "recorded"; readonly signature: EstimateSignatureSnapshot }
  | { readonly kind: "unreadable" };

interface EvidenceRowProps {
  readonly label: string;
  readonly value: string;
  readonly valueClass?: string;
  readonly wide?: boolean;
}

/** One fact of the record, as a term and its value. */
function EvidenceRow({ label, value, valueClass, wide }: EvidenceRowProps): ReactNode {
  return (
    <div className={wide === true ? "flex flex-col gap-1 sm:col-span-2" : "flex flex-col gap-1"}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={valueClass === undefined ? "font-medium" : `font-medium ${valueClass}`}>{value}</dd>
    </div>
  );
}

/** The instant as a merchant reads it, to the second, in the zone the column stores. */
function instantOf(signedAt: string): string {
  return signedAt.slice(0, 19).replaceAll("T", " ");
}

/** What the record holds when an element was not captured: named as absent rather than left blank. */
function valueOrAbsent(value: string | null): string {
  return value === null ? getMessage("estimates.signatureAbsent") : value;
}

export function EstimateSignaturePanel({ state }: { readonly state: SignaturePanelState }): ReactNode {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <header className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold">{getMessage("estimates.signatureTitle")}</h2>
        <p className="text-xs text-muted-foreground">{getMessage("estimates.signatureDescription")}</p>
      </header>

      {state.kind === "unreadable" ? (
        <p className="text-sm text-destructive" role="alert">
          {getMessage("estimates.signatureUnreadable")}
        </p>
      ) : null}

      {state.kind === "none" ? (
        <>
          <p className="text-sm">{getMessage("estimates.signatureNone")}</p>
          <p className="text-xs text-muted-foreground">{getMessage("estimates.signatureNoneHint")}</p>
        </>
      ) : null}

      {state.kind === "recorded" ? (
        <>
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <EvidenceRow
              label={getMessage("estimates.signatureDecision")}
              value={
                state.signature.decision === "accepted"
                  ? getMessage("estimates.signatureAccepted")
                  : getMessage("estimates.signatureDeclined")
              }
            />
            <EvidenceRow label={getMessage("estimates.signatureSignedAt")} value={instantOf(state.signature.signedAt)} />
            <EvidenceRow label={getMessage("estimates.signatureSignerName")} value={state.signature.signerName} />
            <EvidenceRow label={getMessage("estimates.signatureSignerEmail")} value={state.signature.signerEmail} />
            <EvidenceRow label={getMessage("estimates.signatureIp")} value={state.signature.ip} />
            <EvidenceRow
              label={getMessage("estimates.signatureGeo")}
              value={valueOrAbsent(state.signature.geoLocation)}
            />
            <EvidenceRow
              label={getMessage("estimates.signatureFingerprint")}
              value={valueOrAbsent(state.signature.deviceFingerprint)}
              valueClass="break-all font-mono text-xs"
            />
            <div className="flex flex-col gap-1 sm:col-span-2">
              <dt className="text-xs text-muted-foreground">{getMessage("estimates.signatureConsent")}</dt>
              <dd className="whitespace-pre-line break-words font-medium">{state.signature.consentText}</dd>
              <dd className="text-xs text-muted-foreground">{getMessage("estimates.signatureConsentHint")}</dd>
            </div>
            <div className="flex flex-col gap-1 sm:col-span-2">
              <dt className="text-xs text-muted-foreground">{getMessage("estimates.signatureHash")}</dt>
              <dd className="break-all font-mono text-xs font-medium">{state.signature.documentHash}</dd>
              <dd className="text-xs text-muted-foreground">{getMessage("estimates.signatureHashHint")}</dd>
            </div>
          </dl>

          {state.signature.signaturePath === null ? null : (
            <p className="text-xs text-muted-foreground">{getMessage("estimates.signatureImageStored")}</p>
          )}

          <p className="border-t border-border pt-3 text-xs text-muted-foreground">
            {getMessage("estimates.signatureImmutable")}
          </p>
        </>
      ) : null}
    </section>
  );
}
