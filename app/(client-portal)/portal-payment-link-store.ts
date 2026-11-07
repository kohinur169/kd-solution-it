// path: app/(client-portal)/portal-payment-link-store.ts
import type { PortalPaymentLinkStatus } from "./portal-payment-link-fields.ts";

/**
 * The store a general payment link lives in, as a port.
 *
 * ## Why a port and not a table
 *
 * The schema this STEP would need - one row per link with its amount, its description, its token id and its
 * state - is not in the migration inventory, and STEP 190's block grants no migration exception: the portal
 * STEPs own `app/(client-portal)/` and the payment components, and the tables belong to the database and
 * business STEPs. So the link's row is a **port**, exactly as the payment recorder of STEP 183 and the card
 * blacklist queue of STEP 186 are ports. The table, when a STEP owns it, is:

 * ```
 * portal_payment_links (
 *   id uuid primary key,
 *   company_id uuid not null,
 *   amount_minor bigint not null,
 *   currency text not null,
 *   description text not null,
 *   reference text,
 *   status text not null,            -- active | paid | revoked
 *   token_id text not null,          -- the id of the token in circulation
 *   token_digest text not null,      -- STEP 058's digest, never the token
 *   reissue_count integer not null default 0,
 *   expires_at timestamptz not null,
 *   revoked_at timestamptz, revoked_by_user_id uuid,
 *   paid_at timestamptz, payment_id uuid,
 *   created_by_user_id uuid not null,
 *   created_at timestamptz not null, updated_at timestamptz not null,
 *   deleted_at timestamptz, version integer not null default 1
 * )
 * ```
 *
 * and the two indexes the controls need: `(token_id)` unique while live, and `(company_id, created_at)` for a
 * merchant's own list. The gate asserts this comment stays the description of the contract, so the STEP that
 * writes the table has the column list it must satisfy.
 *
 * ## What durability means here
 *
 * `durable` is the same bargain STEP 183's recorder makes. A link minted into process memory stops existing at
 * the next deploy, and a revocation held in memory is lifted by a restart - which is the one thing a revocation
 * must never be. So the services refuse to create, revoke or reissue on a store that is not durable, and a
 * payment on a link that the store cannot vouch for is refused too. The in-memory store exists for the gate and
 * for a development process, and it says `durable: false` about itself.
 *
 * ## Why the token is not stored
 *
 * `token_digest` is STEP 058's `portalTokenDigest()`. A database that holds the token is a database that can be
 * used to open the link it names, and a link is a credential: the merchant holds the only copy, and the store
 * keeps what it needs to *refuse* one (the id it would be revoked by) without keeping what would *use* it.
 */

/** One link, as the store holds it. */
export interface PortalPaymentLinkRecord {
  readonly id: string;
  readonly companyId: string;
  /** The amount in the platform's minor units, as decimal text. */
  readonly amountMinor: string;
  readonly currency: string;
  readonly description: string;
  readonly reference: string | null;
  readonly status: PortalPaymentLinkStatus;
  /** The id of the token in circulation. A reissue replaces it; a revoke retires it. */
  readonly tokenId: string;
  /** The digest of the token in circulation, or null when no token is live (a revoked link). */
  readonly tokenDigest: string | null;
  readonly reissueCount: number;
  readonly expiresAtEpochMs: number;
  readonly revokedAtEpochMs: number | null;
  readonly revokedByUserId: string | null;
  readonly paidAtEpochMs: number | null;
  readonly paymentId: string | null;
  readonly createdByUserId: string;
  readonly createdAtEpochMs: number;
  readonly updatedAtEpochMs: number;
}

/** What a store answers when it is asked to change a row. */
export type PortalPaymentLinkChange = "changed" | "missing" | "conflict";

/** The store, as the services use it. */
export interface PortalPaymentLinkStore {
  /** False when the store cannot survive a deploy, and the services refuse on it. */
  readonly durable: boolean;
  insert(record: PortalPaymentLinkRecord): Promise<PortalPaymentLinkChange>;
  /** By the id the token carries, which is how a checkout finds its link. */
  findByTokenId(tokenId: string): Promise<PortalPaymentLinkRecord | null>;
  findById(id: string, companyId: string): Promise<PortalPaymentLinkRecord | null>;
  /** The merchant's own list, newest first, bounded. */
  listByCompany(companyId: string, limit: number): Promise<readonly PortalPaymentLinkRecord[]>;
  /** Retire the token in circulation. The expected version is the row the caller read. */
  revoke(input: {
    readonly id: string;
    readonly companyId: string;
    readonly tokenId: string;
    readonly revokedAtEpochMs: number;
    readonly revokedByUserId: string;
  }): Promise<PortalPaymentLinkChange>;
  /** Put a new token in circulation for the same link, and make it live again. */
  reissue(input: {
    readonly id: string;
    readonly companyId: string;
    readonly tokenId: string;
    readonly tokenDigest: string;
    readonly expiresAtEpochMs: number;
    readonly expectedTokenId: string;
    readonly updatedAtEpochMs: number;
  }): Promise<PortalPaymentLinkChange>;
  /**
   * Take the payment a link took, once.
   *
   * The status is the guard: a link is `active` until its one payment lands, and a second charge against a link
   * that is already `paid` must lose here rather than at the gateway. `conflict` is that loss.
   */
  markPaid(input: {
    readonly id: string;
    readonly companyId: string;
    readonly paymentId: string;
    readonly paidAtEpochMs: number;
  }): Promise<PortalPaymentLinkChange>;
}

/**
 * A store that keeps links in this process.
 *
 * Its rows are immutable: every change replaces the record, so a caller holding a record from before a change
 * never sees a half-updated one. The maps are keyed by link id and by token id, which is the same pair the
 * table's two indexes provide, and the two keys are updated together so a reissue cannot leave the old token id
 * pointing at a row whose token id it no longer matches.
 */
export function createInMemoryPortalPaymentLinkStore(): PortalPaymentLinkStore {
  const byId = new Map<string, PortalPaymentLinkRecord>();

  const findByIdOnly = (id: string): PortalPaymentLinkRecord | null => byId.get(id) ?? null;

  const replace = (record: PortalPaymentLinkRecord): void => {
    byId.set(record.id, record);
  };

  return {
    durable: false,

    async insert(record: PortalPaymentLinkRecord): Promise<PortalPaymentLinkChange> {
      if (byId.has(record.id)) {
        return "conflict";
      }

      for (const existing of byId.values()) {
        if (existing.tokenId === record.tokenId && existing.status === "active") {
          return "conflict";
        }
      }

      replace(record);

      return "changed";
    },

    async findByTokenId(tokenId: string): Promise<PortalPaymentLinkRecord | null> {
      for (const record of byId.values()) {
        if (record.tokenId === tokenId) {
          return record;
        }
      }

      return null;
    },

    async findById(id: string, companyId: string): Promise<PortalPaymentLinkRecord | null> {
      const record = findByIdOnly(id);

      return record !== null && record.companyId === companyId ? record : null;
    },

    async listByCompany(companyId: string, limit: number): Promise<readonly PortalPaymentLinkRecord[]> {
      return [...byId.values()]
        .filter((record) => record.companyId === companyId)
        .sort((left, right) => right.createdAtEpochMs - left.createdAtEpochMs)
        .slice(0, limit);
    },

    async revoke(input): Promise<PortalPaymentLinkChange> {
      const record = findByIdOnly(input.id);

      if (record === null || record.companyId !== input.companyId) {
        return "missing";
      }

      if (record.tokenId !== input.tokenId) {
        // The token the caller read is no longer in circulation: someone reissued in between, and revoking the
        // id this request holds would leave the new one alive while reporting a revocation.
        return "conflict";
      }

      replace({
        ...record,
        status: "revoked",
        tokenDigest: null,
        revokedAtEpochMs: input.revokedAtEpochMs,
        revokedByUserId: input.revokedByUserId,
        updatedAtEpochMs: input.revokedAtEpochMs,
      });

      return "changed";
    },

    async reissue(input): Promise<PortalPaymentLinkChange> {
      const record = findByIdOnly(input.id);

      if (record === null || record.companyId !== input.companyId) {
        return "missing";
      }

      if (record.tokenId !== input.expectedTokenId) {
        return "conflict";
      }

      replace({
        ...record,
        status: "active",
        tokenId: input.tokenId,
        tokenDigest: input.tokenDigest,
        reissueCount: record.reissueCount + 1,
        expiresAtEpochMs: input.expiresAtEpochMs,
        revokedAtEpochMs: null,
        revokedByUserId: null,
        updatedAtEpochMs: input.updatedAtEpochMs,
      });

      return "changed";
    },

    async markPaid(input): Promise<PortalPaymentLinkChange> {
      const record = findByIdOnly(input.id);

      if (record === null || record.companyId !== input.companyId) {
        return "missing";
      }

      if (record.status !== "active") {
        return "conflict";
      }

      // The token is spent with the payment: a code that was already used to pay must not be offered back to a
      // second payer, even though the page will say "already paid" rather than take a card.
      replace({
        ...record,
        status: "paid",
        tokenDigest: null,
        paidAtEpochMs: input.paidAtEpochMs,
        paymentId: input.paymentId,
        updatedAtEpochMs: input.paidAtEpochMs,
      });

      return "changed";
    },
  };
}
