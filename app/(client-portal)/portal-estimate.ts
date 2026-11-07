// path: app/(client-portal)/portal-estimate.ts
import type { RestClient } from "../../lib/auth/rest.ts";
import { AppError } from "../../lib/errors/app-error.ts";
import { openPortalToken, type PortalTokenClaim, type PortalTokenKeys } from "../../lib/security/portal-token.ts";
import {
  estimateRowSchema,
  estimateSnapshotOf,
  readEstimateLines,
  type EstimateSnapshot,
} from "../../services/estimates/estimates.ts";
import { ESTIMATE_COLUMNS, ESTIMATE_TABLE } from "../../services/estimates/estimate-fields.ts";
import {
  ESTIMATE_SIGNATURE_COLUMNS,
  estimateSignatureRowSchema,
  estimateSignatureSnapshotOf,
  hashEstimateDocument,
  type EstimateSignatureSnapshot,
} from "../../services/estimates/estimate-signature.ts";
import {
  PORTAL_ESTIMATE_OPEN_STATUSES,
  PORTAL_ESTIMATE_SIGNATURE_TABLE,
  PORTAL_ESTIMATE_TOKEN_CAPABILITY,
  PORTAL_ESTIMATE_TOKEN_KIND,
  type PortalEstimateState,
} from "./portal-estimate-fields.ts";

/**
 * The read model of the tokenized estimate page.
 *
 * ## What a client has to be able to answer from the link alone
 *
 * Section 16 gives a quote four questions: what am I being offered, how long is the offer open, what did I
 * already decide, and what happens when the lifetime runs out. A quote's client has no account on this
 * platform, so all four are answered from the token: `openPortalToken` verifies the signature, the clock,
 * the kind and the capability, and every read below is scoped by *both* the company and the quote the claim
 * names, never by the quote id alone.
 *
 * ## Why it reuses STEP 022's snapshot and digest
 *
 * The document a client signs is `EstimateSnapshot`, the same object the merchant's screen prints, and the
 * digest is `hashEstimateDocument` over that snapshot. Both are imported rather than re-derived: a second
 * mapper would be a second idea of what the offer contains, and a second encoder would be a second answer to
 * "what did the client sign" - the one question `0027`'s evidence row exists to answer later.
 *
 * ## Why expiry is a computed state and not only a stored one
 *
 * `expires_at` is a column, and a quote that is past it is expired whether or not a job has run. So the read
 * answers both facts: the stored status (which a sweep will eventually move) and `expired`, which is true the
 * moment the clock passes the column. The page refuses a signature on the computed fact, and
 * `portal-estimate-decision.ts` writes the void as the page is opened, so the stored status catches up rather
 * than being trusted.
 */

/** The signature, as the page prints it. */
export interface PortalEstimateSignatureView {
  readonly decision: EstimateSignatureSnapshot["decision"];
  readonly signerName: string;
  readonly signedAt: string;
  readonly signedAtEpochMs: number;
  readonly documentHash: string;
  /** True when the record carries a drawn signature in storage, which the page mentions and never loads. */
  readonly hasDrawnSignature: boolean;
}

/** Everything the page prints, in one object. */
export interface PortalEstimateView {
  /** The document exactly as the merchant's screen and the signature digest see it. */
  readonly estimate: EstimateSnapshot;
  readonly state: PortalEstimateState;
  readonly tokenId: string;
  /** The digest of the offer above, which is the digest a signature will store. */
  readonly documentHash: string;
  /** The recorded decision, or null while nobody has made one. */
  readonly signature: PortalEstimateSignatureView | null;
  /** True when the clock is past `expires_at`, whatever the stored status still says. */
  readonly expired: boolean;
  /** True when this link may still be decided: issued, not expired, not decided. */
  readonly open: boolean;
}

/** What a read needs: a client, a key ring and a clock. */
export interface PortalEstimateDependencies {
  readonly rest: RestClient;
  readonly tokenKeys: PortalTokenKeys;
  readonly now?: () => number;
}

/**
 * `0025`'s five statuses and `void`'s three reasons folded into the six a client meets.
 *
 * Total over every value the database can hold, and `null` for anything else: a void row without a reason is
 * a row `estimates_void_pair_check` forbids, and a status outside the five is a row this page will not
 * describe rather than one it guesses at.
 */
export function portalEstimateStateOf(
  status: string,
  voidReason: string | null,
): PortalEstimateState | null {
  switch (status) {
    case "draft":
      return "not_issued";
    case "sent":
    case "viewed":
      return "open";
    case "accepted":
      return "accepted";
    case "void":
      switch (voidReason) {
        case "declined":
          return "declined";
        case "expired":
          return "expired";
        case "withdrawn":
          return "withdrawn";
        default:
          return null;
      }
    default:
      return null;
  }
}

/** True when a status is one a client may still decide. */
export function isPortalEstimateOpenStatus(status: string): boolean {
  return (PORTAL_ESTIMATE_OPEN_STATUSES as readonly string[]).includes(status);
}

function signatureViewOf(snapshot: EstimateSignatureSnapshot): PortalEstimateSignatureView {
  return {
    decision: snapshot.decision,
    signerName: snapshot.signerName,
    signedAt: snapshot.signedAt,
    signedAtEpochMs: snapshot.signedAtEpochMs,
    documentHash: snapshot.documentHash,
    hasDrawnSignature: snapshot.signaturePath !== null,
  };
}

/**
 * Open a tokenized estimate link and read everything the page prints.
 *
 * Three reads - the quote, its lines and the decision if there is one - each scoped by the token's company
 * as well as its quote. A quote that does not exist, belongs to another merchant, is soft deleted or carries
 * a status this module will not describe is `RESOURCE_NOT_FOUND`, which is also what a bad signature answers:
 * a visitor must not be able to tell those apart.
 *
 * A draft is answered rather than refused, with `state: not_issued`, so the page can say "not ready yet"
 * instead of "this link is broken".
 */
export async function openPortalEstimate(
  input: { readonly token: string },
  dependencies: PortalEstimateDependencies,
): Promise<PortalEstimateView> {
  const nowMs = dependencies.now?.() ?? Date.now();
  const claim: PortalTokenClaim = openPortalToken(input.token, {
    keys: dependencies.tokenKeys,
    now: Math.floor(nowMs / 1_000),
    expect: {
      kind: PORTAL_ESTIMATE_TOKEN_KIND,
      capability: PORTAL_ESTIMATE_TOKEN_CAPABILITY,
    },
  });

  const rows = await dependencies.rest.select(
    ESTIMATE_TABLE,
    `${ESTIMATE_COLUMNS}&id=eq.${claim.resourceId}&company_id=eq.${claim.companyId}` +
      "&deleted_at=is.null&limit=1",
    estimateRowSchema,
  );
  const row = rows[0];

  if (row === undefined) {
    throw new AppError("RESOURCE_NOT_FOUND");
  }

  const state = portalEstimateStateOf(row.status, row.void_reason);

  if (state === null) {
    throw new AppError("RESOURCE_NOT_FOUND");
  }

  const [lines, decisions] = await Promise.all([
    readEstimateLines(dependencies.rest, row.company_id, row.id),
    dependencies.rest.select(
      PORTAL_ESTIMATE_SIGNATURE_TABLE,
      `${ESTIMATE_SIGNATURE_COLUMNS}&estimate_id=eq.${row.id}&company_id=eq.${row.company_id}` +
        "&deleted_at=is.null&limit=1",
      estimateSignatureRowSchema,
    ),
  ]);

  const estimate = estimateSnapshotOf(row, lines);
  const decision = decisions[0] === undefined ? null : estimateSignatureSnapshotOf(decisions[0]);
  const expiresAtMs = Date.parse(estimate.expiresAt);
  const expired =
    isPortalEstimateOpenStatus(row.status) && Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs;

  return {
    estimate,
    state,
    tokenId: claim.tokenId,
    documentHash: hashEstimateDocument(estimate),
    signature: decision === null ? null : signatureViewOf(decision),
    expired,
    open: isPortalEstimateOpenStatus(row.status) && !expired && decision === null,
  };
}
