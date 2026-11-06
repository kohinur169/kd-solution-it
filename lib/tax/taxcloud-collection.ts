// path: lib/tax/taxcloud-collection.ts
import { AppError } from "../errors/app-error.ts";
import type { AuditEntry, AuditTrail } from "../auth/audit.ts";
import { requireCompanyId } from "../auth/session.ts";
import type { RequestActor } from "../auth/types.ts";
import { COUNTRY_CODE_PATTERN } from "../countries/registry.ts";
import { deepFreeze } from "../utils/freeze.ts";
import { TAXCLOUD_PROVIDER_KEY } from "./taxcloud.ts";
import {
  requireTaxCloudConnectActor,
  taxCloudConnectionViewOf,
  taxCloudRowProblemOf,
} from "./taxcloud-connect.ts";
import type {
  TaxCloudConnectAuditPayload,
  TaxCloudConnectionRow,
  TaxCloudConnectionStore,
  TaxCloudConnectionView,
} from "./taxcloud-connect.ts";

/**
 * The on and off switch of FEATURE_LIST section 7: "Sales Tax Collection is an on and off option.
 * When enabled, sales tax is collected automatically on invoices", and "Collection applies to United
 * States transactions".
 *
 * ## The switch is one bit, and it lives beside its proof
 *
 * `public.taxcloud_connections.collection_enabled` is the setting, and the table's own check
 * (`collection_enabled = false or status = 'active'`) is what makes it a setting rather than a wish:
 * the bit cannot be on unless the row it belongs to has answered a verification ping. STEP 177
 * already clears the bit whenever a connection loses its verification, so the switch and the proof
 * cannot disagree, and nothing in this file turns the bit on except the merchant's own deliberate act.
 *
 * That shape has one consequence worth stating, because a settings screen will be asked about it: the
 * switch belongs to the connection row, not to the merchant's account in general. A merchant who
 * disconnects their TaxCloud account and connects another one starts with collection off, and has to
 * turn it on again. That is deliberate. The alternative - remembering "this merchant once wanted tax
 * collected" across a change of account - would mean collecting tax through credentials no merchant
 * had consented to, which is exactly the kind of stored intent that section 7 does not ask for.
 *
 * ## Why a merchant may always turn it off
 *
 * Turning collection off needs no proof, no ping and no active row: a merchant who has lost access to
 * TaxCloud, or whose key stopped working, must be able to stop collecting in one click. If there is
 * no connection, or the connection is already off, the answer is `unchanged` rather than an error,
 * because the state the merchant asked for is the state that already holds.
 *
 * ## The countries, and the one function a later STEP must use
 *
 * Section 7's third bullet is a scope, not a switch: collection applies to United States
 * transactions. `TAXCLOUD_COLLECTION_COUNTRIES` is that scope, `isTaxCloudCollectableCountry` is its
 * one reader, and `taxCloudCollectionGateOf` is the decision STEP 179 must use before it adds a tax
 * amount to an invoice. It answers `collect: false` with a reason for a merchant with no connection,
 * an unverified connection, a switched-off connection and a transaction outside the United States,
 * so the invoice writer never has to combine those four conditions itself, and a later reader never
 * has to guess whether it did.
 *
 * ## Permission
 *
 * The same actor as STEP 177's connect flow: the merchant's owner, with a second factor. That check is
 * not repeated here as a second copy; `requireTaxCloudConnectActor` is called, so a change to who may
 * connect a credential changes who may switch collection on, in one place.
 */

/* -------------------------------------------------------------------------------------------------
 * Constants
 * ---------------------------------------------------------------------------------------------- */

/** The countries collection covers. Section 7 names one. */
export const TAXCLOUD_COLLECTION_COUNTRIES: readonly string[] = deepFreeze(["US"] as const);

/** What the switch can be waiting for, in the order the panel reads it. */
export const TAXCLOUD_COLLECTION_READINESS = deepFreeze([
  "ready",
  "not_connected",
  "unverified",
  "disconnected",
] as const);

export type TaxCloudCollectionReadiness = (typeof TAXCLOUD_COLLECTION_READINESS)[number];

/** The two actions this file records. Each is one mutation, and neither carries a credential. */
export const TAXCLOUD_COLLECTION_AUDIT_ACTIONS = deepFreeze([
  "taxcloud.collection_enabled",
  "taxcloud.collection_disabled",
] as const);

export type TaxCloudCollectionAuditAction = (typeof TAXCLOUD_COLLECTION_AUDIT_ACTIONS)[number];

/** The four answers a switch request can have, plus the refusal. */
export const TAXCLOUD_COLLECTION_STATUSES = deepFreeze(["enabled", "disabled", "unchanged", "refused"] as const);

export type TaxCloudCollectionStatus = (typeof TAXCLOUD_COLLECTION_STATUSES)[number];

/**
 * True when a transaction's country is one collection covers.
 *
 * A value that is not an ISO 3166-1 alpha-2 code is not a country, and this answers false for it
 * rather than throwing: the invoice path of STEP 179 meets addresses from a client's own records, and
 * an unusable code there must mean "no tax line", not a failed invoice.
 */
export function isTaxCloudCollectableCountry(value: string): boolean {
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";

  if (COUNTRY_CODE_PATTERN.test(code) === false) return false;

  return TAXCLOUD_COLLECTION_COUNTRIES.includes(code);
}

/* -------------------------------------------------------------------------------------------------
 * The state of one merchant's switch
 * ---------------------------------------------------------------------------------------------- */

/** One merchant's switch as a screen reads it. Nothing here can carry a credential. */
export interface TaxCloudCollectionState {
  /** The bit, and it is only ever true on a verified connection. */
  readonly enabled: boolean;
  readonly readiness: TaxCloudCollectionReadiness;
  /** The usable connection, masked by STEP 177's view. Null when there is none. */
  readonly connection: TaxCloudConnectionView | null;
  /** The row id the bit belongs to, for a screen that has to name the connection. */
  readonly connectionRowId: string | null;
  readonly canEnable: boolean;
  readonly canDisable: boolean;
  readonly message: string;
  /** The last failure sentence of a connection that is still collecting, or null. */
  readonly warning: string | null;
  readonly countries: readonly string[];
}

/** The usable row: not deleted and not disabled, which is the test the table's partial index uses. */
export function taxCloudUsableRowOf(rows: readonly TaxCloudConnectionRow[]): TaxCloudConnectionRow | null {
  return rows.find((row) => row.deletedAtEpochMs === null && row.status !== "disabled") ?? null;
}

/**
 * Why collection is not ready, or null when it is.
 *
 * The order matters: a merchant who has never connected anything reads "no account", which is a
 * different thing to do than a merchant whose connection is waiting for its first ping.
 */
export function taxCloudCollectionReadinessOf(rows: readonly TaxCloudConnectionRow[]): TaxCloudCollectionReadiness {
  const usable = taxCloudUsableRowOf(rows);

  if (usable !== null) return usable.status === "active" ? "ready" : "unverified";

  const history = rows.some((row) => row.deletedAtEpochMs === null && row.status === "disabled");

  return history ? "disconnected" : "not_connected";
}

/** The sentence a readiness state gets, in the same words the panel shows. */
export function taxCloudCollectionMessageOf(readiness: TaxCloudCollectionReadiness, enabled: boolean): string {
  switch (readiness) {
    case "ready":
      return enabled
        ? "Sales tax is collected on United States invoices through this connection."
        : "The connection is verified. Turn collection on to add sales tax to United States invoices.";
    case "unverified":
      return "The connection has not answered a verification ping yet, so collection cannot be turned on.";
    case "disconnected":
      return "The last connection was disconnected, so nothing is collected until a new account is verified and switched on.";
    case "not_connected":
      return "No TaxCloud account is connected for this merchant, so no invoice can carry sales tax.";
  }
}

/**
 * Read the switch from a merchant's rows.
 *
 * `enabled` is the usable row's own column, never a remembered intent: a merchant with only history has
 * no bit to read and reads `false`. A connection that is still `active` but whose last ping failed
 * keeps collecting - STEP 177's rule, because an outage is not evidence about a credential - and its
 * `last_error` is surfaced as a warning beside the switch rather than turning it off.
 */
export function taxCloudCollectionStateOf(rows: readonly TaxCloudConnectionRow[]): TaxCloudCollectionState {
  const usable = taxCloudUsableRowOf(rows);
  const readiness = taxCloudCollectionReadinessOf(rows);
  const enabled = usable !== null && usable.collectionEnabled;
  const connection = usable === null ? null : taxCloudConnectionViewOf(usable);

  return {
    enabled,
    readiness,
    connection,
    connectionRowId: usable === null ? null : usable.id,
    canEnable: readiness === "ready" && enabled === false,
    canDisable: enabled,
    message: taxCloudCollectionMessageOf(readiness, enabled),
    warning: enabled && usable !== null ? usable.lastError : null,
    countries: TAXCLOUD_COLLECTION_COUNTRIES,
  };
}

/* -------------------------------------------------------------------------------------------------
 * The decision a later STEP must use
 * ---------------------------------------------------------------------------------------------- */

/** Why an invoice does or does not carry a tax line. */
export const TAXCLOUD_COLLECTION_DECISIONS = deepFreeze([
  "collect",
  "not_connected",
  "unverified",
  "disconnected",
  "switched_off",
  "outside_united_states",
] as const);

export type TaxCloudCollectionDecisionReason = (typeof TAXCLOUD_COLLECTION_DECISIONS)[number];

/** One answer: whether to collect, why, and the sentence a merchant or an office reads. */
export interface TaxCloudCollectionDecision {
  readonly collect: boolean;
  readonly reason: TaxCloudCollectionDecisionReason;
  readonly message: string;
}

/** The sentence for one decision, so the invoice path and the settings panel agree. */
export function taxCloudCollectionDecisionMessageOf(reason: TaxCloudCollectionDecisionReason): string {
  switch (reason) {
    case "collect":
      return "Sales tax is calculated for this United States transaction through the merchant's TaxCloud connection.";
    case "not_connected":
      return "No TaxCloud account is connected for this merchant.";
    case "unverified":
      return "The merchant's TaxCloud connection has not answered a verification ping.";
    case "disconnected":
      return "The merchant's TaxCloud connection was disconnected.";
    case "switched_off":
      return "The merchant has switched sales tax collection off.";
    case "outside_united_states":
      return "Collection applies to United States transactions only.";
  }
}

/**
 * The one function STEP 179 may use to decide whether an invoice carries sales tax.
 *
 * Three conditions, and all three have to hold: the merchant switched collection on, the connection
 * that switch belongs to is `active` (which the table ties to a verification instant), and the
 * transaction's country is one collection covers. The country is checked last so that a merchant with
 * no connection is told about that rather than about the transaction, which is the sentence that leads
 * somewhere.
 */
export function taxCloudCollectionGateOf(
  rows: readonly TaxCloudConnectionRow[],
  countryCode: string,
): TaxCloudCollectionDecision {
  const usable = taxCloudUsableRowOf(rows);
  const decide = (reason: TaxCloudCollectionDecisionReason): TaxCloudCollectionDecision => ({
    collect: reason === "collect",
    reason,
    message: taxCloudCollectionDecisionMessageOf(reason),
  });

  if (usable === null) {
    const history = rows.some((row) => row.deletedAtEpochMs === null && row.status === "disabled");

    return decide(history ? "disconnected" : "not_connected");
  }

  if (usable.status !== "active") return decide("unverified");
  if (usable.collectionEnabled === false) return decide("switched_off");
  if (isTaxCloudCollectableCountry(countryCode) === false) return decide("outside_united_states");

  return decide("collect");
}

/* -------------------------------------------------------------------------------------------------
 * Flipping it
 * ---------------------------------------------------------------------------------------------- */

export interface TaxCloudCollectionOptions {
  readonly store: TaxCloudConnectionStore;
  readonly audit: AuditTrail;
  readonly now?: () => number;
}

export interface SetSalesTaxCollectionInput {
  readonly actor: RequestActor;
  /** True turns collection on, false turns it off. There is no third value. */
  readonly enabled: boolean;
}

export type SetSalesTaxCollectionResult =
  | { readonly status: "enabled"; readonly state: TaxCloudCollectionState }
  | { readonly status: "disabled"; readonly state: TaxCloudCollectionState }
  | { readonly status: "unchanged"; readonly state: TaxCloudCollectionState }
  | { readonly status: "refused"; readonly reason: string; readonly state: TaxCloudCollectionState };

function taxCloudCollectionAuditEntryOf(input: {
  readonly action: TaxCloudCollectionAuditAction;
  readonly actor: RequestActor;
  readonly companyId: string;
  readonly row: TaxCloudConnectionRow;
  readonly outcome: string;
}): AuditEntry {
  const payload: TaxCloudConnectAuditPayload = {
    provider_key: TAXCLOUD_PROVIDER_KEY,
    connection_id_last_four: input.row.connectionIdLastFour,
    api_key_last_four: input.row.apiKeyLastFour,
    status_before: input.row.status,
    status_after: input.row.status,
    outcome: input.outcome,
    encryption_key_version: input.row.encryptionKeyVersion,
    collection_enabled: input.row.collectionEnabled,
  };

  return {
    action: input.action,
    actorUserId: input.actor.userId,
    entityType: "tax_connection",
    entityId: input.row.id,
    payload: { ...payload },
    companyId: input.companyId,
    sessionId: input.actor.sessionId,
  };
}

/**
 * Turn collection on or off for the merchant the actor belongs to.
 *
 * The order is the security property, and it is STEP 177's order:
 *
 *   1. the actor and the second factor first, so a refused caller learns nothing about the rows;
 *   2. the company from the session, never from the body;
 *   3. the merchant's rows read once, and the usable row resolved from them;
 *   4. turning it on needs a usable row that is `active`: the table's check would refuse the write
 *      otherwise, and refusing before the write is what lets the merchant read a sentence instead of
 *      a conflict. Turning it off needs nothing but a row that is on;
 *   5. a write that would change nothing writes nothing and audits nothing, because a repeated click
 *      is not a decision;
 *   6. the write is version guarded, and a lost race is `CONFLICT` rather than a silent overwrite;
 *   7. the audit entry is written after the row it describes, and it carries two masks and two status
 *      words, never a credential.
 */
export async function setSalesTaxCollection(
  input: SetSalesTaxCollectionInput,
  options: TaxCloudCollectionOptions,
): Promise<SetSalesTaxCollectionResult> {
  const actor = requireTaxCloudConnectActor(input.actor);
  const companyId = requireCompanyId(actor);
  const rows = await options.store.listByCompany(companyId);
  const usable = taxCloudUsableRowOf(rows);
  // The panel after a write is the merchant's own rows with the row just written in place of the one read.
  const stateWith = (written: TaxCloudConnectionRow): TaxCloudCollectionState =>
    taxCloudCollectionStateOf(rows.map((row) => (row.id === written.id ? written : row)));

  if (input.enabled) {
    if (usable === null) {
      return {
        status: "refused",
        reason: "no TaxCloud account is connected for this merchant, so there is nothing to collect through",
        state: taxCloudCollectionStateOf(rows),
      };
    }

    if (usable.status !== "active") {
      return {
        status: "refused",
        reason: "the connection has not answered a verification ping, so collection cannot be turned on",
        state: taxCloudCollectionStateOf(rows),
      };
    }

    if (usable.collectionEnabled) return { status: "unchanged", state: taxCloudCollectionStateOf(rows) };

    const next = await flip(options, usable, true);
    await options.audit.append(
      taxCloudCollectionAuditEntryOf({
        action: "taxcloud.collection_enabled",
        actor,
        companyId,
        row: next,
        outcome: "enabled",
      }),
    );

    return { status: "enabled", state: stateWith(next) };
  }

  if (usable === null || usable.collectionEnabled === false) {
    return { status: "unchanged", state: taxCloudCollectionStateOf(rows) };
  }

  const next = await flip(options, usable, false);
  await options.audit.append(
    taxCloudCollectionAuditEntryOf({
      action: "taxcloud.collection_disabled",
      actor,
      companyId,
      row: next,
      outcome: "disabled",
    }),
  );

  return { status: "disabled", state: stateWith(next) };
}

/** One version guarded write of the bit, or `CONFLICT` when somebody else wrote the row first. */
async function flip(
  options: TaxCloudCollectionOptions,
  row: TaxCloudConnectionRow,
  enabled: boolean,
): Promise<TaxCloudConnectionRow> {
  const instant = options.now?.() ?? Date.now();
  const next: TaxCloudConnectionRow = {
    ...row,
    collectionEnabled: enabled,
    updatedAtEpochMs: instant,
    version: row.version + 1,
  };
  const problem = taxCloudRowProblemOf(next);

  if (problem !== null) {
    throw new AppError("INTERNAL_ERROR", { details: [{ field: "connection", rule: problem }] });
  }

  const saved = await options.store.save(next, row.version);

  if (saved === false) {
    throw new AppError("CONFLICT", {
      details: [{ field: "connection", rule: "this connection changed while the switch was being set" }],
    });
  }

  return next;
}
