// path: app/(client-portal)/portal-blacklist-processor.ts
import type { AuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import {
  PORTAL_BLACKLIST_AUDIT_ENTITY,
  PORTAL_BLACKLIST_REQUESTED_AUDIT_ACTION,
  PORTAL_BLACKLIST_RULES,
} from "./portal-blacklist-fields.ts";
import {
  blockPortalCard,
  checkPortalCardBlacklist,
  portalCardFingerprintOf,
  type PortalBlacklistCheck,
  type PortalBlacklistDependencies,
} from "./portal-blacklist.ts";
import type { PortalCardReferral, PortalCardReferralQueue, PortalCardReferred } from "./portal-fraud.ts";

/**
 * The two adapters this STEP puts between the payment page and the list.
 *
 * ## The check the page runs
 *
 * `createPortalCardBlockCheck` is the port STEP 183's payment operation asks before it calls the gateway. It is
 * a port rather than a direct import because the operation is a seam: its caller decides where the list lives,
 * and a gate can hand it a list that says "yes", "no" or "the database is down" without a database.
 *
 * ## The referral STEP 186 makes, made durable
 *
 * STEP 186 refers a flagged card to a `PortalCardReferralQueue`. This is the durable one, and it is honest
 * about the one thing it cannot decide: `card_blacklist.blacklisted_by` references `public.users` and the
 * table's trigger freezes it, so an entry is a person's decision. Two behaviours, one constructor:
 *
 *   - **with an officer** (`actor`) - the referral writes the block, through `blockPortalCard`, with that
 *     person as its author, and answers `referred`. This is what the deployment runs once a compliance desk is
 *     configured for the page.
 *   - **without one** - the referral writes no block at all. It writes a chain entry naming the fingerprint,
 *     the payment and the gateway's code, and answers `refused` / `actor_required`, so the card is proposed for
 *     the list and nobody's name is attached to a decision they did not make. The refusal of the payment itself
 *     does not depend on this: STEP 186 already refused it.
 *
 * A referral that pretends to block is worse than no referral: the list would hold a row accusing a card of
 * fraud under the name of a person who never saw it.
 */

/** Who may author a block. A person's id, because the table references `public.users`. */
export interface PortalBlacklistOfficer {
  readonly userId: string;
}

/** The uuid shape a payment id must have to become `source_payment_id`. */
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** The check the payment operation runs before the gateway: one query, or a refusal to guess. */
export function createPortalCardBlockCheck(dependencies: PortalBlacklistDependencies): PortalBlacklistCheck {
  return {
    async check(input: { readonly token: string }) {
      const { reading } = await checkPortalCardBlacklist(
        { token: input.token, nowMs: dependencies.now?.() ?? Date.now() },
        dependencies,
      );

      return reading;
    },
  };
}

/**
 * The durable referral queue.
 *
 * `durable` is true only when an officer is named, because it is the officer's existence that makes the write
 * possible: with one, the referral survives the request; without one, the chain entry does, and the block does
 * not. STEP 186 reports the difference as `card_referred: false` and `card_referral_unavailable`.
 */
export function createPortalCardBlacklistQueue(options: {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly actor: PortalBlacklistOfficer | null;
  readonly now?: () => number;
}): PortalCardReferralQueue {
  const dependencies: PortalBlacklistDependencies = {
    rest: options.rest,
    audit: options.audit,
    ...(options.now === undefined ? {} : { now: options.now }),
  };
  const now = options.now ?? ((): number => Date.now());

  return {
    durable: options.actor !== null,
    async refer(card: PortalCardReferral): Promise<PortalCardReferred> {
      const fingerprint = portalCardFingerprintOf(card.token.trim());
      const actor = options.actor;

      if (actor === null) {
        await appendTolerated(options.audit, {
          action: PORTAL_BLACKLIST_REQUESTED_AUDIT_ACTION,
          actorUserId: null,
          entityType: PORTAL_BLACKLIST_AUDIT_ENTITY,
          entityId: card.paymentId,
          payload: {
            card_fingerprint: fingerprint,
            fingerprint_source: "card_token",
            source_payment_id: card.paymentId,
            invoice_id: card.invoiceId,
            provider_signal: card.providerSignal,
            provider_response_code: card.responseCode,
            occurred_at: new Date(card.occurredAtEpochMs).toISOString(),
            outcome: "proposed",
            rule: PORTAL_BLACKLIST_RULES.blocked,
          },
          companyId: card.companyId,
          sessionId: null,
          ipAddress: null,
          userAgent: null,
        });

        return { status: "refused", reason: "actor_required" };
      }

      try {
        const written = await blockPortalCard(
          {
            fingerprint,
            source: "card_token",
            reason: card.providerSignal === "fraud" ? "fraud" : "card_testing",
            note:
              card.responseCode === null
                ? null
                : `Referred by the payment page after gateway response code ${card.responseCode}.`,
            blacklistedBy: actor.userId,
            blacklistedAtEpochMs: card.occurredAtEpochMs,
            expiresAtEpochMs: null,
            providerId: null,
            sourcePaymentId:
              card.paymentId !== null && uuidPattern.test(card.paymentId) ? card.paymentId : null,
          },
          dependencies,
        );

        return { status: "referred", referralId: written.blockId };
      } catch {
        await appendTolerated(options.audit, {
          action: PORTAL_BLACKLIST_REQUESTED_AUDIT_ACTION,
          actorUserId: actor.userId,
          entityType: PORTAL_BLACKLIST_AUDIT_ENTITY,
          entityId: card.paymentId,
          payload: {
            card_fingerprint: fingerprint,
            fingerprint_source: "card_token",
            source_payment_id: card.paymentId,
            invoice_id: card.invoiceId,
            provider_signal: card.providerSignal,
            provider_response_code: card.responseCode,
            occurred_at: new Date(now()).toISOString(),
            outcome: "write_failed",
            rule: PORTAL_BLACKLIST_RULES.blocked,
          },
          companyId: card.companyId,
          sessionId: null,
          ipAddress: null,
          userAgent: null,
        });

        return { status: "refused", reason: "write_failed" };
      }
    },
  };
}

/** A chain link that is written if it can be, and never fails the referral it records. */
async function appendTolerated(audit: AuditTrail, entry: Parameters<AuditTrail["append"]>[0]): Promise<void> {
  try {
    await audit.append(entry);
  } catch {
    // Deliberate. The referral's answer is the fact; a chain that cannot be reached must not change it.
  }
}
