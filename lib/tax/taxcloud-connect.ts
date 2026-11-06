// path: lib/tax/taxcloud-connect.ts
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { z as zod } from "zod";
import { AppError } from "../errors/app-error.ts";
import type { AuditEntry, AuditTrail } from "../auth/audit.ts";
import type { RestClient } from "../auth/rest.ts";
import { isSecretBox } from "../auth/secrets.ts";
import type { SecretBox } from "../auth/secrets.ts";
import { hasSatisfiedTwoFactor, requireAnyRole, requireCompanyId } from "../auth/session.ts";
import type { PlatformRole, RequestActor } from "../auth/types.ts";
import { deepFreeze } from "../utils/freeze.ts";
import {
  TAXCLOUD_API_BASE,
  TAXCLOUD_AUTH_HEADER,
  TAXCLOUD_PROVIDER_KEY,
  TAXCLOUD_REFUSED_AUTH_HEADER,
  taxCloudApiKeyProblemOf,
  taxCloudPingMessageOf,
  taxCloudPingOutcomeOf,
  taxCloudProblemOf,
  taxCloudRequestOf,
  requireTaxCloudConnectionId,
} from "./taxcloud.ts";
import type { TaxCloudPingOutcome } from "./taxcloud.ts";

/**
 * The connect flow of FEATURE_LIST section 7: a merchant enters the two values the TaxCloud dashboard
 * shows, the platform seals them, and a ping decides whether the connection is usable.
 *
 * ## What section 7 and section 29 ask for, and where each is kept
 *
 *   - "Every merchant can connect a personal TaxCloud account": one row per merchant, entered by the
 *     merchant's own owner account, held in `public.taxcloud_connections`. The platform builds no tax
 *     engine, and nothing here computes tax: this file only carries the credential to a ping and
 *     records what the ping said.
 *   - "TaxCloud credentials are encrypted and only shown masked" and section 29's "AES-256-GCM
 *     encrypted at rest and shown only masked": both values are sealed before they are written (see
 *     "What is sealed, and how" below) and every read of this module hands a screen four characters
 *     and nothing else. `taxCloudRowProblemOf` refuses a row whose parts are not a box, so a row that
 *     lost its tag cannot be mistaken for a row that is merely wrong.
 *   - "Collection applies to United States transactions" and the on and off switch are STEP 178's;
 *     this STEP only records the verification that switch will depend on.
 *
 * ## The table is STEP 023's, and this STEP does not change it
 *
 * `public.taxcloud_connections` was created by STEP 023 and hardened by STEP 0073's policies: a
 * column for each part of each AES-256-GCM box, the last four characters of each credential, an
 * `encryption_key_version`, a three word status, `verified_at`, `collection_enabled`, `last_error`,
 * `deleted_at` and `version`. STEPs 176 to 180 own `lib/tax/` and the tax settings, and this block was
 * granted no migration exception, so this file is written against the columns that exist rather than
 * the ones a greenfield design would invent.
 *
 * Two consequences are deliberate and are stated here rather than discovered later:
 *
 *   1. **The status vocabulary is the table's**, `pending`, `active` and `disabled`, not a fourth
 *      word for "failed". A ping that is answered "no" leaves the row `pending` with a `last_error`
 *      sentence, because the check constraint is closed and a failure must not invent a status the
 *      database would reject. STEP 176's design record names `failed` as a reading of a row; this
 *      file stores the state the schema allows and explains it in `taxCloudStatusMessageOf`.
 *   2. **There is no mode column, and this file does not pretend there is one.** TaxCloud documents
 *      one host and no separate test environment (STEP 176's finding), and the connection ID decides which TaxCloud
 *      environment answers, so a merchant's row is one connection and the environment is the one
 *      TaxCloud assigned to that identifier. Nothing here infers a mode from a host, because there is
 *      only one host, and nothing here stores a mode, because there is no column and no permission to
 *      add one. STEP 178's switch is `collection_enabled`, which the table already has.
 *
 * ## The split STEP 0073's policies force, and why this module is the server side of it
 *
 * The merchant policies of `0073_office_and_secret_policies.sql` allow a merchant's own session to
 * select their row, to insert one whose `verified_at` is null, and to update a row only while
 * `verified_at` is null. So a merchant can enter credentials and can never mark them verified, and can
 * never disable a connection that was once verified. That is the right split: verification is a fact
 * only the platform can observe, and the row that says "this works" is written by the server after a
 * ping. Every function here therefore takes a `RequestActor` for the *permission* decision and writes
 * through the platform's own store, which is what `getTaxCloudConnectRuntime()` wires.
 *
 * ## What is sealed, and how
 *
 * One `SecretBox` per credential is produced by the injected sealer, whose production implementation
 * is `lib/auth/secrets.ts` - the same AES-256-GCM, the same three base64url parts and the same
 * additional authenticated data that seals provider keys in `lib/gateways/`. The table has a column
 * per part, so a box lands in `*_ciphertext`, `*_iv` and `*_tag` without a second encoding.
 *
 * The scope is the additional authenticated data, and it names the company and the credential:
 * `taxcloud:connection-id:<companyId>` and `taxcloud:api-key:<companyId>`. A box copied into another
 * merchant's row, or the API key box swapped with the connection id box, fails to open rather than
 * returning one merchant's credential in another merchant's screen. The connection ID is sealed too,
 * even though TaxCloud's own page says it is not a secret: the table gives it the same three columns
 * as a credential, and one rule for both values is one rule to get right.
 *
 * ## The ping is the only proof, and its three failures are three different answers
 *
 * `taxCloudPingOutcomeOf` (STEP 176) reads `200` as `verified`, `401` as the documented wrong-key
 * answer and `404` as the documented mistyped-or-someone-else's-connection answer; a `429`, `500` or
 * `503` says nothing about the credentials and is `unreachable`. This file turns those into row
 * writes, and the rule that matters most is that a temporary failure changes nothing: a connection
 * that is `active` stays `active` through an outage, because an outage is not evidence that the
 * merchant's key stopped working. A `401` from a connection that was `active` does have to demote it,
 * because a key TaxCloud refuses must stop collecting: the row drops to `pending`, `verified_at`
 * clears and `collection_enabled` is turned off in the same write, so the switch and the proof can
 * never disagree.
 *
 * ## One usable connection per merchant
 *
 * `taxcloud_connections_company_key` is a partial unique index on `company_id` where the row is not
 * deleted and not `disabled`, so history and the live connection coexist and two live ones cannot.
 * This file refuses a second connect while a usable row exists rather than letting the index raise,
 * so the merchant reads a sentence instead of a conflict.
 */

/* -------------------------------------------------------------------------------------------------
 * Constants
 * ---------------------------------------------------------------------------------------------- */

/** The table STEP 023 created for exactly this. */
export const TAXCLOUD_CONNECTION_TABLE = "taxcloud_connections";

/** The one key version this build seals under; `taxcloud_connections_version_check` allows 1 to 999. */
export const TAXCLOUD_ENCRYPTION_KEY_VERSION = 1;

/**
 * The roles that may connect a merchant's own TaxCloud account.
 *
 * Section 7 says the merchant connects a personal account, so the merchant's owner is the actor.
 * Office roles are refused: reading a merchant's tax settings for support is a read, and entering a
 * merchant's credential is not something an office account should be able to do on their behalf.
 */
export const TAXCLOUD_CONNECT_ROLES: readonly PlatformRole[] = deepFreeze(["owner"] as const);

/** The statuses `taxcloud_connections_status_check` allows, in the order the flow walks them. */
export const TAXCLOUD_STORED_STATUSES = deepFreeze(["pending", "active", "disabled"] as const);

export type TaxCloudStoredStatus = (typeof TAXCLOUD_STORED_STATUSES)[number];

/** True when a value is a status the table allows. */
export function isTaxCloudStoredStatus(value: string): value is TaxCloudStoredStatus {
  return (TAXCLOUD_STORED_STATUSES as readonly string[]).includes(value);
}

/** The outcome words a verify call answers with. Nothing here writes a status the table lacks. */
export const TAXCLOUD_VERIFY_STATUSES = deepFreeze(["verified", "rejected", "unanswered", "refused", "failed"] as const);

export type TaxCloudVerifyStatus = (typeof TAXCLOUD_VERIFY_STATUSES)[number];

/** The four characters the settings table allows a screen to show, and the pattern it checks. */
export const TAXCLOUD_LAST_FOUR_PATTERN = /^[A-Za-z0-9]{4}$/u;

/** `taxcloud_connections_error_check`: one to 280 characters, already trimmed. */
export const TAXCLOUD_LAST_ERROR_MAXIMUM_LENGTH = 280;

/** `taxcloud_connections_api_id_ciphertext_check` and its key twin: 16 to 8192 characters. */
export const TAXCLOUD_SEALED_MINIMUM_LENGTH = 16;
export const TAXCLOUD_SEALED_MAXIMUM_LENGTH = 8_192;

/** The two scopes, which are the additional authenticated data of the two boxes. */
export function taxCloudConnectionIdScope(companyId: string): string {
  return `taxcloud:connection-id:${companyId}`;
}

export function taxCloudApiKeyScope(companyId: string): string {
  return `taxcloud:api-key:${companyId}`;
}

/** How long the transport waits, and how large an answer it will read. */
export const TAXCLOUD_CLIENT_TIMEOUT_MS = 15_000;
export const TAXCLOUD_ANSWER_MAXIMUM_BYTES = 65_536;

/** The headers a call may carry. `Authorization` is not one of them, by STEP 176's decision. */
export const TAXCLOUD_CLIENT_ALLOWED_HEADERS: readonly string[] = deepFreeze([
  TAXCLOUD_AUTH_HEADER,
  "Accept",
  "Content-Type",
]);

/** The methods a call may use. */
export const TAXCLOUD_CLIENT_ALLOWED_METHODS: readonly string[] = deepFreeze(["GET", "POST", "PATCH", "DELETE"]);

/* -------------------------------------------------------------------------------------------------
 * The permission
 * ---------------------------------------------------------------------------------------------- */

/**
 * The merchant's owner, with a second factor.
 *
 * Entering a credential that will be used to collect tax from real buyers is a sensitive write, so a
 * role alone is not enough: `hasSatisfiedTwoFactor` is the platform's own answer to "did this session
 * present a second factor, and may it act" (section 22 makes TOTP mandatory for a role holding
 * account), and it is used here rather than re-derived.
 */
export function requireTaxCloudConnectActor(actor: RequestActor): RequestActor {
  requireAnyRole(actor, TAXCLOUD_CONNECT_ROLES);

  if (!hasSatisfiedTwoFactor(actor)) {
    throw new AppError("PERMISSION_DENIED", {
      details: [
        {
          field: "actor.twoFactorSatisfied",
          rule: "connecting a TaxCloud account requires a session that presented its second factor",
        },
      ],
    });
  }

  return actor;
}

/** The same answer without throwing, for a settings screen that renders the form disabled. */
export function canManageTaxCloudConnection(actor: RequestActor): boolean {
  const holdsRole = TAXCLOUD_CONNECT_ROLES.some((role) => actor.roles.includes(role));

  return holdsRole && hasSatisfiedTwoFactor(actor);
}

/* -------------------------------------------------------------------------------------------------
 * Sealing
 * ---------------------------------------------------------------------------------------------- */

/**
 * The sealing port.
 *
 * Production is `lib/auth/secrets.ts` reading `ENCRYPTION_MASTER_KEY` from the environment; the gate
 * uses the same cipher with a fixture key, so the code path is the real one. The context is the scope
 * above and is authenticated with the ciphertext, which is what makes a box a value of one row.
 */
export interface TaxCloudSecretSealer {
  seal(plaintext: string, context: string): SecretBox;
  open(box: SecretBox, context: string): string;
}

/* -------------------------------------------------------------------------------------------------
 * The row
 * ---------------------------------------------------------------------------------------------- */

/**
 * One stored connection, in this module's vocabulary.
 *
 * The field names are the domain's; `taxCloudInsertValuesOf` is the one place they become the
 * snake_case columns of `public.taxcloud_connections`. `connectionIdBox` and `apiKeyBox` hold the
 * sealed values and are never part of a view.
 */
export interface TaxCloudConnectionRow {
  readonly id: string;
  readonly companyId: string;
  /** `api_id_last_four`: the connection ID's last four characters, the only part a screen may show. */
  readonly connectionIdLastFour: string;
  readonly connectionIdBox: SecretBox;
  /** `api_key_last_four`: the API key's last four characters. */
  readonly apiKeyLastFour: string;
  readonly apiKeyBox: SecretBox;
  readonly encryptionKeyVersion: number;
  readonly status: TaxCloudStoredStatus;
  /** `collection_enabled`. STEP 178 owns the switch; this file only clears it when a connection dies. */
  readonly collectionEnabled: boolean;
  readonly verifiedAtEpochMs: number | null;
  readonly lastError: string | null;
  readonly version: number;
  readonly createdAtEpochMs: number;
  readonly updatedAtEpochMs: number;
  readonly deletedAtEpochMs: number | null;
}

/** A row before the database gives it an id and its two defaults. */
export type TaxCloudConnectionNew = Omit<
  TaxCloudConnectionRow,
  "id" | "version" | "createdAtEpochMs" | "updatedAtEpochMs" | "deletedAtEpochMs"
>;

/** The columns an insert writes, in the order the migration lists them. */
export const TAXCLOUD_INSERT_COLUMNS: readonly string[] = deepFreeze([
  "company_id",
  "api_id_last_four",
  "api_id_ciphertext",
  "api_id_iv",
  "api_id_tag",
  "api_key_last_four",
  "api_key_ciphertext",
  "api_key_iv",
  "api_key_tag",
  "encryption_key_version",
  "status",
  "collection_enabled",
  "verified_at",
  "last_error",
]);

function isTaxCloudEpochMs(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/** True when a box is the shape a column of the table can hold. */
export function isTaxCloudSealedValue(box: SecretBox): boolean {
  return (
    isSecretBox(box) &&
    box.ciphertext.length >= TAXCLOUD_SEALED_MINIMUM_LENGTH &&
    box.ciphertext.length <= TAXCLOUD_SEALED_MAXIMUM_LENGTH
  );
}

/**
 * Why a row breaks its own invariants, or null when it does not.
 *
 * These are the table's constraints in one function, so the in-memory store, the REST mapping and a
 * future reader agree on what a well-formed row is: a company, two four-character masks, two boxes,
 * a key version inside the recorded range, one of the three statuses, `verified_at` set exactly when
 * the row is `active` (`taxcloud_connections_verified_check`), the switch on only when the row is
 * `active` (`taxcloud_connections_collection_check`), an error inside the column's bounds, a positive
 * version and timestamps that run forwards.
 */
export function taxCloudRowProblemOf(row: TaxCloudConnectionRow): string | null {
  if (row.id.trim().length === 0) return "a connection needs a row id";
  if (row.companyId.trim().length === 0) return "a connection belongs to a company";
  if (TAXCLOUD_LAST_FOUR_PATTERN.test(row.connectionIdLastFour) === false) {
    return "the connection ID mask is the four characters the table checks";
  }
  if (TAXCLOUD_LAST_FOUR_PATTERN.test(row.apiKeyLastFour) === false) {
    return "the API key mask is the four characters the table checks";
  }
  if (isTaxCloudSealedValue(row.connectionIdBox) === false) return "the connection ID is sealed in a box";
  if (isTaxCloudSealedValue(row.apiKeyBox) === false) return "the API key is sealed in a box";
  if (Number.isInteger(row.encryptionKeyVersion) === false || row.encryptionKeyVersion < 1 || row.encryptionKeyVersion > 999) {
    return "the key version is a whole number between one and 999";
  }
  if (isTaxCloudStoredStatus(row.status) === false) return "a status is pending, active or disabled";
  if ((row.status === "active") !== (row.verifiedAtEpochMs !== null)) {
    return "verified_at is set exactly when the status is active";
  }
  if (row.collectionEnabled && row.status !== "active") return "collection is only on for an active connection";
  if (row.lastError !== null) {
    if (row.lastError.length < 1 || row.lastError.length > TAXCLOUD_LAST_ERROR_MAXIMUM_LENGTH) {
      return "the last error is one to 280 characters";
    }
    if (row.lastError !== row.lastError.trim()) return "the last error is stored trimmed";
  }
  if (Number.isInteger(row.version) === false || row.version < 1) return "a connection has a whole version of at least one";
  if (isTaxCloudEpochMs(row.createdAtEpochMs) === false) return "a connection records when it was created";
  if (isTaxCloudEpochMs(row.updatedAtEpochMs) === false) return "a connection records when it was last written";
  if (row.updatedAtEpochMs < row.createdAtEpochMs) return "a connection cannot be updated before it was created";
  if (row.deletedAtEpochMs !== null && row.deletedAtEpochMs < row.createdAtEpochMs) {
    return "a connection cannot be deleted before it was created";
  }
  if (row.verifiedAtEpochMs !== null && isTaxCloudEpochMs(row.verifiedAtEpochMs) === false) {
    return "a verification instant is a positive whole number of milliseconds";
  }

  return null;
}

/** The row as the snake_case columns of one insert. The id and both timestamps are the table's defaults. */
export function taxCloudInsertValuesOf(row: TaxCloudConnectionNew): Readonly<Record<string, unknown>> {
  const values: Record<string, unknown> = {
    company_id: row.companyId,
    api_id_last_four: row.connectionIdLastFour,
    api_id_ciphertext: row.connectionIdBox.ciphertext,
    api_id_iv: row.connectionIdBox.iv,
    api_id_tag: row.connectionIdBox.tag,
    api_key_last_four: row.apiKeyLastFour,
    api_key_ciphertext: row.apiKeyBox.ciphertext,
    api_key_iv: row.apiKeyBox.iv,
    api_key_tag: row.apiKeyBox.tag,
    encryption_key_version: row.encryptionKeyVersion,
    status: row.status,
    collection_enabled: row.collectionEnabled,
    verified_at: row.verifiedAtEpochMs === null ? null : new Date(row.verifiedAtEpochMs).toISOString(),
    last_error: row.lastError,
  };

  return deepFreeze(values);
}

/** Four characters behind a mask, the only thing a screen may show of a credential or a connection ID. */
export function taxCloudHintOf(lastFour: string): string {
  if (lastFour.length === 0) return "";
  return `${"*".repeat(12)}${lastFour}`;
}

/**
 * Why a value cannot be masked by the table's own check, or null when it can.
 *
 * `taxcloud_connections_api_id_last_four_check` and its key twin accept exactly four letters and
 * digits, so a value whose last four characters include a symbol has no mask this schema can store.
 * Refusing is the honest answer: the alternative is a write the database rejects with a sentence no
 * merchant could act on, and a mask that shows a character that is not really there is worse than one
 * that says it cannot be shown.
 */
export function taxCloudMaskProblemOf(value: string): string | null {
  if (TAXCLOUD_LAST_FOUR_PATTERN.test(value.slice(-4)) === false) {
    return "the last four characters of this value include a symbol, so the settings table cannot show it masked";
  }

  return null;
}

/* -------------------------------------------------------------------------------------------------
 * The store
 * ---------------------------------------------------------------------------------------------- */

/**
 * The four operations the flow needs.
 *
 * A domain port rather than PostgREST queries inside the flow: the connect rules stay readable, the
 * gate drives them with `InMemoryTaxCloudConnectionStore`, and `createTaxCloudRestStore` is the one
 * place that knows the table's column names. `insert` answers the stored row because the id and the
 * two timestamps are the table's defaults; `save` is a version guarded write that answers whether it
 * matched the version the caller read.
 */
export interface TaxCloudConnectionStore {
  listByCompany(companyId: string): Promise<readonly TaxCloudConnectionRow[]>;
  findById(id: string): Promise<TaxCloudConnectionRow | null>;
  insert(row: TaxCloudConnectionNew): Promise<TaxCloudConnectionRow>;
  save(next: TaxCloudConnectionRow, expectedVersion: number): Promise<boolean>;
}

const TAXCLOUD_COMPANY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;
const TAXCLOUD_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** The company shapes this file accepts: an id this platform issues or one a route has already checked. */
export function isTaxCloudCompanyId(value: string): boolean {
  return TAXCLOUD_COMPANY_ID_PATTERN.test(value) || TAXCLOUD_UUID_PATTERN.test(value);
}

/**
 * The in-memory store: the table's invariants as code.
 *
 * It is a reference implementation, not a convenience: one usable row per merchant, `verified_at`
 * exactly when active, the switch only on an active row, credentials that are never swapped in place,
 * a version that moves by one, and a deleted row that cannot be written again. The gate drives every
 * branch of the flow through it, which is what makes those rules tested rather than described.
 */
export class InMemoryTaxCloudConnectionStore implements TaxCloudConnectionStore {
  private readonly rows = new Map<string, TaxCloudConnectionRow>();
  /** Insertion order, so two rows written in the same millisecond still list newest first. */
  private readonly order = new Map<string, number>();
  private readonly clock: () => number;

  constructor(options: { readonly now?: () => number } = {}) {
    this.clock = options.now ?? ((): number => Date.now());
  }

  private usableOf(companyId: string): TaxCloudConnectionRow | null {
    for (const row of this.rows.values()) {
      if (row.companyId !== companyId) continue;
      if (row.deletedAtEpochMs !== null) continue;
      if (row.status === "disabled") continue;
      return row;
    }

    return null;
  }

  async listByCompany(companyId: string): Promise<readonly TaxCloudConnectionRow[]> {
    return [...this.rows.values()]
      .filter((row) => row.companyId === companyId)
      .sort((left, right) => {
        const byInstant = right.createdAtEpochMs - left.createdAtEpochMs;

        if (byInstant !== 0) return byInstant;

        return (this.order.get(right.id) ?? 0) - (this.order.get(left.id) ?? 0);
      });
  }

  async findById(id: string): Promise<TaxCloudConnectionRow | null> {
    return this.rows.get(id) ?? null;
  }

  async insert(row: TaxCloudConnectionNew): Promise<TaxCloudConnectionRow> {
    const instant = this.clock();
    const stored: TaxCloudConnectionRow = {
      ...row,
      id: randomUUID(),
      version: 1,
      createdAtEpochMs: instant,
      updatedAtEpochMs: instant,
      deletedAtEpochMs: null,
    };
    const problem = taxCloudRowProblemOf(stored);

    if (problem !== null) throw new Error(problem);
    if (this.usableOf(row.companyId) !== null) {
      throw new AppError("CONFLICT", { details: [{ field: "companyId", rule: "one usable connection per merchant" }] });
    }

    this.rows.set(stored.id, stored);
    this.order.set(stored.id, this.order.size + 1);

    return stored;
  }

  async save(next: TaxCloudConnectionRow, expectedVersion: number): Promise<boolean> {
    const current = this.rows.get(next.id);

    if (current === undefined) return false;
    if (current.version !== expectedVersion) return false;
    if (next.version !== expectedVersion + 1) return false;
    if (current.companyId !== next.companyId) return false;
    if (current.deletedAtEpochMs !== null) return false;
    if (
      current.connectionIdBox.ciphertext !== next.connectionIdBox.ciphertext ||
      current.connectionIdBox.iv !== next.connectionIdBox.iv ||
      current.connectionIdBox.tag !== next.connectionIdBox.tag ||
      current.apiKeyBox.ciphertext !== next.apiKeyBox.ciphertext ||
      current.apiKeyBox.iv !== next.apiKeyBox.iv ||
      current.apiKeyBox.tag !== next.apiKeyBox.tag
    ) {
      return false;
    }
    if (current.connectionIdLastFour !== next.connectionIdLastFour) return false;
    if (current.apiKeyLastFour !== next.apiKeyLastFour) return false;
    if (current.createdAtEpochMs !== next.createdAtEpochMs) return false;
    if (taxCloudRowProblemOf(next) !== null) return false;
    if (next.status === "active" && current.status === "disabled") return false;

    const usable = this.usableOf(next.companyId);

    if (next.status !== "disabled" && usable !== null && usable.id !== next.id) return false;

    this.rows.set(next.id, next);

    return true;
  }
}

/* -------------------------------------------------------------------------------------------------
 * The REST store
 * ---------------------------------------------------------------------------------------------- */

const taxCloudRowSchema = zod.object({
  id: zod.string().trim().min(1),
  company_id: zod.string().trim().min(1),
  api_id_last_four: zod.string(),
  api_id_ciphertext: zod.string(),
  api_id_iv: zod.string(),
  api_id_tag: zod.string(),
  api_key_last_four: zod.string(),
  api_key_ciphertext: zod.string(),
  api_key_iv: zod.string(),
  api_key_tag: zod.string(),
  encryption_key_version: zod.number().int(),
  status: zod.string(),
  collection_enabled: zod.boolean(),
  verified_at: zod.string().nullable(),
  last_error: zod.string().nullable(),
  created_at: zod.string(),
  updated_at: zod.string(),
  deleted_at: zod.string().nullable(),
  version: zod.number().int(),
});

type TaxCloudRestRow = z.infer<typeof taxCloudRowSchema>;

/** The selected columns, in one string so a read never asks for a column it does not use. */
const TAXCLOUD_SELECT =
  "select=id,company_id,api_id_last_four,api_id_ciphertext,api_id_iv,api_id_tag,api_key_last_four," +
  "api_key_ciphertext,api_key_iv,api_key_tag,encryption_key_version,status,collection_enabled," +
  "verified_at,last_error,created_at,updated_at,deleted_at,version";

/** An ISO instant to milliseconds, refused when it is not one. */
export function taxCloudEpochOf(value: string): number {
  const epochMs = Date.parse(value);

  if (Number.isFinite(epochMs) === false || epochMs <= 0) {
    throw new AppError("INTERNAL_ERROR", { details: [{ field: "timestamp", rule: "a stored instant is not a timestamp" }] });
  }

  return epochMs;
}

function taxCloudEpochOrNull(value: string | null): number | null {
  return value === null ? null : taxCloudEpochOf(value);
}

/** One row of the table, mapped into this module's vocabulary. Throws when the row cannot be believed. */
export function taxCloudRowOfRecord(record: TaxCloudRestRow): TaxCloudConnectionRow {
  const status = record.status;

  if (isTaxCloudStoredStatus(status) === false) {
    throw new AppError("INTERNAL_ERROR", { details: [{ field: "status", rule: "a stored status is unknown" }] });
  }

  const row: TaxCloudConnectionRow = {
    id: record.id,
    companyId: record.company_id,
    connectionIdLastFour: record.api_id_last_four,
    connectionIdBox: { iv: record.api_id_iv, tag: record.api_id_tag, ciphertext: record.api_id_ciphertext },
    apiKeyLastFour: record.api_key_last_four,
    apiKeyBox: { iv: record.api_key_iv, tag: record.api_key_tag, ciphertext: record.api_key_ciphertext },
    encryptionKeyVersion: record.encryption_key_version,
    status,
    collectionEnabled: record.collection_enabled,
    verifiedAtEpochMs: taxCloudEpochOrNull(record.verified_at),
    lastError: record.last_error,
    version: record.version,
    createdAtEpochMs: taxCloudEpochOf(record.created_at),
    updatedAtEpochMs: taxCloudEpochOf(record.updated_at),
    deletedAtEpochMs: taxCloudEpochOrNull(record.deleted_at),
  };
  const problem = taxCloudRowProblemOf(row);

  if (problem !== null) {
    throw new AppError("INTERNAL_ERROR", { details: [{ field: "row", rule: problem }] });
  }

  return row;
}

/**
 * The platform's own store: `lib/auth/rest.ts` and the service role key.
 *
 * Reads select the columns this module uses and nothing else; a write filters on the version it read
 * and then reads the version back, so a stale screen cannot overwrite a decision somebody else took
 * in between, and `set_row_metadata` owns the increment (the migration's trigger), which is why the
 * values written here never name `version`, `created_at` or `updated_at`.
 */
export function createTaxCloudRestStore(rest: RestClient): TaxCloudConnectionStore {
  const selectRows = async (query: string): Promise<readonly TaxCloudRestRow[]> => {
    const rows = await rest.select(TAXCLOUD_CONNECTION_TABLE, query, taxCloudRowSchema);

    return rows;
  };

  return {
    async listByCompany(companyId: string): Promise<readonly TaxCloudConnectionRow[]> {
      if (isTaxCloudCompanyId(companyId) === false) {
        throw new AppError("VALIDATION_FAILED", { details: [{ field: "companyId", rule: "a connection belongs to a company" }] });
      }

      const rows = await selectRows(
        `${TAXCLOUD_SELECT}&company_id=eq.${encodeURIComponent(companyId)}&order=created_at.desc`,
      );

      return rows.map(taxCloudRowOfRecord);
    },

    async findById(id: string): Promise<TaxCloudConnectionRow | null> {
      if (id.trim().length === 0) return null;

      const rows = await selectRows(`${TAXCLOUD_SELECT}&id=eq.${encodeURIComponent(id)}&limit=1`);

      return rows.length === 0 ? null : taxCloudRowOfRecord(rows[0] as TaxCloudRestRow);
    },

    async insert(row: TaxCloudConnectionNew): Promise<TaxCloudConnectionRow> {
      const inserted = await rest.insertReturning(
        TAXCLOUD_CONNECTION_TABLE,
        [taxCloudInsertValuesOf(row)],
        taxCloudRowSchema,
      );
      const stored = inserted[0];

      if (stored === undefined) throw new AppError("DEPENDENCY_FAILED");

      return taxCloudRowOfRecord(stored);
    },

    async save(next: TaxCloudConnectionRow, expectedVersion: number): Promise<boolean> {
      const values: Record<string, unknown> = {
        status: next.status,
        collection_enabled: next.collectionEnabled,
        verified_at: next.verifiedAtEpochMs === null ? null : new Date(next.verifiedAtEpochMs).toISOString(),
        last_error: next.lastError,
      };

      await rest.update(
        TAXCLOUD_CONNECTION_TABLE,
        `id=eq.${encodeURIComponent(next.id)}&version=eq.${expectedVersion}&deleted_at=is.null`,
        values,
      );

      const rows = await selectRows(`${TAXCLOUD_SELECT}&id=eq.${encodeURIComponent(next.id)}&limit=1`);
      const stored = rows[0];

      if (stored === undefined) return false;

      return stored.version === expectedVersion + 1;
    },
  };
}

/* -------------------------------------------------------------------------------------------------
 * The transport
 * ---------------------------------------------------------------------------------------------- */

/** One call: the request STEP 176 built, unchanged. */
export interface TaxCloudTransportCall {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
}

/** One answer: the status and the text, unparsed. */
export interface TaxCloudTransportAnswer {
  readonly status: number;
  readonly body: string;
}

/** The transport port. Production is `taxCloudFetchTransport`; the gate supplies a function. */
export type TaxCloudTransport = (call: TaxCloudTransportCall) => Promise<TaxCloudTransportAnswer>;

/**
 * Perform one documented call.
 *
 * The URL must be the documented base and a `/tax/` path, the method must be one the API documents, and
 * no header outside the three the request builder writes may appear, so a caller cannot smuggle the
 * refused `Authorization` header or a second host past this function. Redirects are errors rather than
 * followed, the timeout is bounded, and an oversized answer is refused before it is parsed.
 */
export const taxCloudFetchTransport: TaxCloudTransport = async (call) => {
  let url: URL;

  try {
    url = new URL(call.url);
  } catch {
    throw new Error("the tax transport was given a URL it cannot read");
  }

  if (url.origin !== TAXCLOUD_API_BASE || url.pathname.startsWith("/tax/") === false) {
    throw new Error("the tax transport only calls the documented base and a documented path");
  }

  if (TAXCLOUD_CLIENT_ALLOWED_METHODS.includes(call.method) === false) {
    throw new Error("the tax transport was given a method the API does not document");
  }

  for (const name of Object.keys(call.headers)) {
    // Named before the allowlist so the reason a `Authorization` header is refused is the decision STEP 176 recorded,
    // not an accident of a list.
    if (name === TAXCLOUD_REFUSED_AUTH_HEADER) {
      throw new Error("a TaxCloud call never carries an Authorization header");
    }

    if (TAXCLOUD_CLIENT_ALLOWED_HEADERS.includes(name) === false) {
      throw new Error("the tax transport refuses a header the request builder does not write");
    }
  }

  const headers: Record<string, string> = {};

  for (const name of Object.keys(call.headers)) {
    headers[name] = call.headers[name] ?? "";
  }

  if (headers[TAXCLOUD_AUTH_HEADER] === undefined) {
    throw new Error("a TaxCloud call carries no API key");
  }

  const response = await fetch(url.toString(), {
    method: call.method,
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(TAXCLOUD_CLIENT_TIMEOUT_MS),
    ...(call.body === null ? {} : { body: call.body }),
  });
  const text = await response.text();

  if (text.length > TAXCLOUD_ANSWER_MAXIMUM_BYTES) throw new Error("the TaxCloud answer is larger than this platform reads");

  return { status: response.status, body: text };
};

/* -------------------------------------------------------------------------------------------------
 * Audit
 * ---------------------------------------------------------------------------------------------- */

/** The five actions this file records. Each is one mutation, and none of them carries a credential. */
export const TAXCLOUD_CONNECT_AUDIT_ACTIONS = deepFreeze([
  "taxcloud.connection_connected",
  "taxcloud.connection_verified",
  "taxcloud.connection_rejected",
  "taxcloud.connection_unanswered",
  "taxcloud.connection_disconnected",
] as const);

export type TaxCloudConnectAuditAction = (typeof TAXCLOUD_CONNECT_AUDIT_ACTIONS)[number];

/**
 * The payload of one entry.
 *
 * The two masks, the status before and after, the outcome word and the key version: enough for an
 * office to follow what happened, and nothing that would let a reader of the audit trail use the
 * account. The connection ID is not in it either, only its four characters.
 */
export interface TaxCloudConnectAuditPayload {
  readonly provider_key: typeof TAXCLOUD_PROVIDER_KEY;
  readonly connection_id_last_four: string;
  readonly api_key_last_four: string;
  readonly status_before: TaxCloudStoredStatus | null;
  readonly status_after: TaxCloudStoredStatus;
  readonly outcome: string;
  readonly encryption_key_version: number;
  readonly collection_enabled: boolean;
}

function taxCloudAuditEntryOf(input: {
  readonly action: TaxCloudConnectAuditAction;
  readonly actor: RequestActor;
  readonly companyId: string;
  readonly row: TaxCloudConnectionRow;
  readonly statusBefore: TaxCloudStoredStatus | null;
  readonly outcome: string;
}): AuditEntry {
  const payload: TaxCloudConnectAuditPayload = {
    provider_key: TAXCLOUD_PROVIDER_KEY,
    connection_id_last_four: input.row.connectionIdLastFour,
    api_key_last_four: input.row.apiKeyLastFour,
    status_before: input.statusBefore,
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

/* -------------------------------------------------------------------------------------------------
 * Views
 * ---------------------------------------------------------------------------------------------- */

/**
 * One connection as a settings screen reads it.
 *
 * The two masks are the four characters the columns hold; there is no field here that could carry a
 * sealed value, a whole credential or a whole connection ID, so a serialised view cannot leak one.
 */
export interface TaxCloudConnectionView {
  readonly id: string;
  readonly status: TaxCloudStoredStatus;
  readonly statusMessage: string;
  readonly connectionIdHint: string;
  readonly apiKeyHint: string;
  readonly verifiedAtEpochMs: number | null;
  readonly collectionEnabled: boolean;
  readonly lastError: string | null;
  readonly updatedAtEpochMs: number;
  readonly version: number;
}

/** What a merchant is told about a status, in one sentence. */
export function taxCloudStatusMessageOf(status: TaxCloudStoredStatus): string {
  switch (status) {
    case "pending":
      return "These credentials have not answered a verification ping yet, so no invoice uses them.";
    case "active":
      return "TaxCloud answered a ping for this connection, so it may be used once collection is switched on.";
    case "disabled":
      return "This connection was disconnected. Its history stays readable and no invoice uses it.";
  }
}

/** The masked view. Nothing here opens a box: the masks are the columns' own four characters. */
export function taxCloudConnectionViewOf(row: TaxCloudConnectionRow): TaxCloudConnectionView {
  return {
    id: row.id,
    status: row.status,
    statusMessage: taxCloudStatusMessageOf(row.status),
    connectionIdHint: taxCloudHintOf(row.connectionIdLastFour),
    apiKeyHint: taxCloudHintOf(row.apiKeyLastFour),
    verifiedAtEpochMs: row.verifiedAtEpochMs,
    collectionEnabled: row.collectionEnabled,
    lastError: row.lastError,
    updatedAtEpochMs: row.updatedAtEpochMs,
    version: row.version,
  };
}

/** The whole settings panel: the usable connection, its history, and whether tax could be collected. */
export interface TaxCloudSettingsView {
  readonly connection: TaxCloudConnectionView | null;
  readonly history: readonly TaxCloudConnectionView[];
  readonly canCollect: boolean;
  readonly collectionMessage: string;
}

/**
 * Read the panel from the rows.
 *
 * "Usable" is the same test the store and the partial unique index use: not deleted and not
 * `disabled`. Only one row can be usable, so the panel has one connection and the rest is history,
 * which is what a merchant sees after moving from a test account to a live one.
 */
export function taxCloudSettingsViewOf(rows: readonly TaxCloudConnectionRow[]): TaxCloudSettingsView {
  const usable = rows.find((row) => row.deletedAtEpochMs === null && row.status !== "disabled") ?? null;
  const connection = usable === null ? null : taxCloudConnectionViewOf(usable);
  const history = rows
    .filter((row) => row.deletedAtEpochMs === null && row.status === "disabled")
    .map((row) => taxCloudConnectionViewOf(row));
  const canCollect = connection !== null && connection.status === "active";

  return {
    connection,
    history,
    canCollect,
    collectionMessage: canCollect
      ? "A verification ping answered for this connection; the collection switch of the tax settings belongs to the next STEP."
      : "Tax is not collected through this merchant until a connection answers a verification ping.",
  };
}

/* -------------------------------------------------------------------------------------------------
 * Input
 * ---------------------------------------------------------------------------------------------- */

/** What a merchant submits: the two values the TaxCloud dashboard shows. */
export interface TaxCloudConnectInput {
  readonly actor: RequestActor;
  readonly connectionId: string;
  readonly apiKey: string;
}

export interface TaxCloudConnectOptions {
  readonly store: TaxCloudConnectionStore;
  readonly sealer: TaxCloudSecretSealer;
  readonly audit: AuditTrail;
  readonly transport: TaxCloudTransport;
  readonly now?: () => number;
}

/** Why a submitted pair cannot be stored, or null when it can. */
export function taxCloudConnectProblemOf(input: {
  readonly connectionId: string;
  readonly apiKey: string;
}): string | null {
  if (requireConnectionIdOrNull(input.connectionId) === null) {
    return "the connection ID is the UUID-shaped value the TaxCloud dashboard shows under Integrations";
  }

  return taxCloudApiKeyProblemOf(input.apiKey);
}

function requireConnectionIdOrNull(value: string): string | null {
  try {
    return requireTaxCloudConnectionId(value);
  } catch {
    return null;
  }
}

/** The last error column's sentence for one outcome: the documented words, plus TaxCloud's own detail. */
export function taxCloudErrorSentenceOf(status: number, body: string): string {
  let parsed: unknown = null;

  if (body.trim().length > 0) {
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      parsed = null;
    }
  }

  const detail = taxCloudProblemOf(parsed).detail;
  const sentence = taxCloudPingMessageOf(taxCloudPingOutcomeOf(status));
  const combined = detail === null ? sentence : `${sentence} TaxCloud said: ${detail}`;
  const cleaned = combined
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

  return cleaned.length <= TAXCLOUD_LAST_ERROR_MAXIMUM_LENGTH
    ? cleaned
    : `${cleaned.slice(0, TAXCLOUD_LAST_ERROR_MAXIMUM_LENGTH - 3).trim()}...`;
}

/* -------------------------------------------------------------------------------------------------
 * Connecting
 * ---------------------------------------------------------------------------------------------- */

export type TaxCloudConnectResult =
  | { readonly status: "connected"; readonly connection: TaxCloudConnectionView }
  | { readonly status: "refused"; readonly reason: string };

/**
 * Seal the two values and write the row a ping will later verify.
 *
 * The order is the security property: the actor and the two factors first, so a refused caller learns
 * nothing about the merchant's rows; then the two values, before any encryption work; then the one
 * usable row check, so a second account cannot be half written while the first is in use; then the
 * sealing, which is the only step that touches the key; then the insert, which the partial unique
 * index protects a second time if two requests race.
 *
 * The row is written `pending` with `verified_at` null. A connect never claims a verification it has
 * not made, which is exactly what STEP 0073's merchant insert policy allows the merchant's own session
 * to do and no more.
 */
export async function connectTaxCloudAccount(
  input: TaxCloudConnectInput,
  options: TaxCloudConnectOptions,
): Promise<TaxCloudConnectResult> {
  const actor = requireTaxCloudConnectActor(input.actor);
  const companyId = requireCompanyId(actor);
  const problem = taxCloudConnectProblemOf(input);

  if (problem !== null) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "connection", rule: problem }] });
  }

  const connectionId = requireTaxCloudConnectionId(input.connectionId);
  const apiKey = input.apiKey.trim();
  const maskProblem = taxCloudMaskProblemOf(connectionId) ?? taxCloudMaskProblemOf(apiKey);

  if (maskProblem !== null) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "connection", rule: maskProblem }] });
  }

  const existing = await options.store.listByCompany(companyId);
  const usable = existing.find((row) => row.deletedAtEpochMs === null && row.status !== "disabled") ?? null;

  if (usable !== null) {
    return {
      status: "refused",
      reason: "this merchant already has a TaxCloud connection; disconnect it before connecting another",
    };
  }

  let connectionIdBox: SecretBox;
  let apiKeyBox: SecretBox;

  try {
    connectionIdBox = options.sealer.seal(connectionId, taxCloudConnectionIdScope(companyId));
    apiKeyBox = options.sealer.seal(apiKey, taxCloudApiKeyScope(companyId));
  } catch {
    return { status: "refused", reason: "the encryption keyring cannot seal a credential, so nothing was stored" };
  }

  const stored = await options.store.insert({
    companyId,
    connectionIdLastFour: connectionId.slice(-4),
    connectionIdBox,
    apiKeyLastFour: apiKey.slice(-4),
    apiKeyBox,
    encryptionKeyVersion: TAXCLOUD_ENCRYPTION_KEY_VERSION,
    status: "pending",
    collectionEnabled: false,
    verifiedAtEpochMs: null,
    lastError: null,
  });

  await options.audit.append(
    taxCloudAuditEntryOf({
      action: "taxcloud.connection_connected",
      actor,
      companyId,
      row: stored,
      statusBefore: null,
      outcome: "pending",
    }),
  );

  return { status: "connected", connection: taxCloudConnectionViewOf(stored) };
}

/* -------------------------------------------------------------------------------------------------
 * Verifying
 * ---------------------------------------------------------------------------------------------- */

export interface TaxCloudVerifyInput {
  readonly actor: RequestActor;
  readonly connectionRowId: string;
}

export type TaxCloudVerifyResult =
  | {
      readonly status: "verified";
      readonly outcome: TaxCloudPingOutcome;
      readonly message: string;
      readonly connection: TaxCloudConnectionView;
    }
  | {
      readonly status: "rejected";
      readonly outcome: TaxCloudPingOutcome;
      readonly message: string;
      readonly connection: TaxCloudConnectionView;
    }
  | {
      readonly status: "unanswered";
      readonly outcome: TaxCloudPingOutcome;
      readonly message: string;
      readonly connection: TaxCloudConnectionView;
    }
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string };

/**
 * Ping the connection and write what it found.
 *
 * The plaintext key exists between the `open` and the transport's answer and nowhere else: it is not
 * returned, not logged and not put in an audit payload. What is stored is the verdict, one sentence
 * when it failed, and the instant.
 *
 * The three outcomes write three different rows, and the difference is the point:
 *
 *   - `verified`: the row becomes `active`, `verified_at` is the instant of the ping and `last_error`
 *     clears. Re-pinging an active row refreshes it, which is how a merchant confirms a working key.
 *   - `unauthorized` or `connection_not_found`: the row keeps `pending` (or drops back to `pending`
 *     if it was active) with the documented sentence in `last_error`. A connection that was active is
 *     demoted and its switch is turned off in the same write, because a key TaxCloud refuses must stop
 *     collecting: `taxcloud_connections_collection_check` would refuse the write otherwise.
 *   - `unreachable` or `unexpected`: nothing is decided. An active row stays active, a pending row
 *     stays pending, and only `last_error` records that the server could not be reached. An outage is
 *     not evidence about a credential, and turning collection off because TaxCloud was briefly down
 *     would be worse than the outage.
 */
export async function verifyTaxCloudConnection(
  input: TaxCloudVerifyInput,
  options: TaxCloudConnectOptions,
): Promise<TaxCloudVerifyResult> {
  const actor = requireTaxCloudConnectActor(input.actor);
  const companyId = requireCompanyId(actor);
  const row = await options.store.findById(input.connectionRowId);

  if (row === null || row.companyId !== companyId || row.deletedAtEpochMs !== null) {
    throw new AppError("RESOURCE_NOT_FOUND", { details: [{ field: "connectionRowId", rule: "no connection of this merchant holds that id" }] });
  }

  if (row.status === "disabled") {
    return { status: "refused", reason: "this connection was disconnected; connect the account again before verifying it" };
  }

  let apiKey: string;
  let connectionId: string;

  try {
    apiKey = options.sealer.open(row.apiKeyBox, taxCloudApiKeyScope(companyId));
    connectionId = options.sealer.open(row.connectionIdBox, taxCloudConnectionIdScope(companyId));
  } catch {
    return { status: "failed", reason: "the stored credentials cannot be opened with the current encryption key" };
  }

  const request = taxCloudRequestOf({ endpoint: "ping", params: { connectionId }, apiKey });
  let status: number;
  let body: string;

  try {
    const answer = await options.transport({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: request.body,
    });

    status = answer.status;
    body = answer.body;
  } catch {
    return settleUnanswered(row, {
      actor,
      companyId,
      options,
      outcome: "unreachable",
      sentence: taxCloudPingMessageOf("unreachable"),
    });
  }

  const outcome = taxCloudPingOutcomeOf(status);
  const sentence = taxCloudErrorSentenceOf(status, body);
  const instant = options.now?.() ?? Date.now();

  if (outcome === "verified") {
    const next: TaxCloudConnectionRow = {
      ...row,
      status: "active",
      verifiedAtEpochMs: instant,
      lastError: null,
      updatedAtEpochMs: instant,
      version: row.version + 1,
    };

    await writeOrConflict(options, next, row.version);
    await options.audit.append(
      taxCloudAuditEntryOf({
        action: "taxcloud.connection_verified",
        actor,
        companyId,
        row: next,
        statusBefore: row.status,
        outcome,
      }),
    );

    return { status: "verified", outcome, message: taxCloudPingMessageOf(outcome), connection: taxCloudConnectionViewOf(next) };
  }

  if (outcome === "unauthorized" || outcome === "connection_not_found") {
    const next: TaxCloudConnectionRow = {
      ...row,
      status: "pending",
      verifiedAtEpochMs: null,
      collectionEnabled: false,
      lastError: sentence,
      updatedAtEpochMs: instant,
      version: row.version + 1,
    };

    await writeOrConflict(options, next, row.version);
    await options.audit.append(
      taxCloudAuditEntryOf({
        action: "taxcloud.connection_rejected",
        actor,
        companyId,
        row: next,
        statusBefore: row.status,
        outcome,
      }),
    );

    return { status: "rejected", outcome, message: taxCloudPingMessageOf(outcome), connection: taxCloudConnectionViewOf(next) };
  }

  return settleUnanswered(row, { actor, companyId, options, outcome, sentence });
}

/** A temporary failure: record it, decide nothing about the credentials, and say so. */
async function settleUnanswered(
  row: TaxCloudConnectionRow,
  input: {
    readonly actor: RequestActor;
    readonly companyId: string;
    readonly options: TaxCloudConnectOptions;
    readonly outcome: TaxCloudPingOutcome;
    readonly sentence: string;
  },
): Promise<TaxCloudVerifyResult> {
  const instant = input.options.now?.() ?? Date.now();
  const next: TaxCloudConnectionRow = {
    ...row,
    lastError: input.sentence,
    updatedAtEpochMs: instant,
    version: row.version + 1,
  };

  await writeOrConflict(input.options, next, row.version);
  await input.options.audit.append(
    taxCloudAuditEntryOf({
      action: "taxcloud.connection_unanswered",
      actor: input.actor,
      companyId: input.companyId,
      row: next,
      statusBefore: row.status,
      outcome: input.outcome,
    }),
  );

  return {
    status: "unanswered",
    outcome: input.outcome,
    message: input.sentence,
    connection: taxCloudConnectionViewOf(next),
  };
}

/** One version guarded write, or `CONFLICT` when somebody else wrote the row first. */
async function writeOrConflict(
  options: TaxCloudConnectOptions,
  next: TaxCloudConnectionRow,
  expectedVersion: number,
): Promise<void> {
  const problem = taxCloudRowProblemOf(next);

  if (problem !== null) {
    throw new AppError("INTERNAL_ERROR", { details: [{ field: "connection", rule: problem }] });
  }

  const saved = await options.store.save(next, expectedVersion);

  if (saved === false) {
    throw new AppError("CONFLICT", {
      details: [{ field: "connection", rule: "this connection changed while it was being verified" }],
    });
  }
}

/* -------------------------------------------------------------------------------------------------
 * Disconnecting
 * ---------------------------------------------------------------------------------------------- */

export interface TaxCloudDisconnectInput {
  readonly actor: RequestActor;
  readonly connectionRowId: string;
}

export type TaxCloudDisconnectResult =
  | { readonly status: "disconnected"; readonly connection: TaxCloudConnectionView }
  | { readonly status: "unchanged"; readonly connection: TaxCloudConnectionView }
  | { readonly status: "refused"; readonly reason: string };

/**
 * Disable a connection, keeping the row as history.
 *
 * `taxcloud_connections_verified_check` says `verified_at` is set exactly when the row is `active`, so
 * disabling clears it in the same write, and the switch is turned off because
 * `taxcloud_connections_collection_check` forbids collecting through a row that is not active. The
 * verification instant is not lost: it is in the audit trail of the verified call and in the entries of
 * the invoices the connection taxed, which is where a filing question looks.
 */
export async function disconnectTaxCloudConnection(
  input: TaxCloudDisconnectInput,
  options: TaxCloudConnectOptions,
): Promise<TaxCloudDisconnectResult> {
  const actor = requireTaxCloudConnectActor(input.actor);
  const companyId = requireCompanyId(actor);
  const row = await options.store.findById(input.connectionRowId);

  if (row === null || row.companyId !== companyId || row.deletedAtEpochMs !== null) {
    throw new AppError("RESOURCE_NOT_FOUND", { details: [{ field: "connectionRowId", rule: "no connection of this merchant holds that id" }] });
  }

  if (row.status === "disabled") {
    return { status: "unchanged", connection: taxCloudConnectionViewOf(row) };
  }

  const instant = options.now?.() ?? Date.now();
  const next: TaxCloudConnectionRow = {
    ...row,
    status: "disabled",
    verifiedAtEpochMs: null,
    collectionEnabled: false,
    lastError: null,
    updatedAtEpochMs: instant,
    version: row.version + 1,
  };

  await writeOrConflict(options, next, row.version);
  await options.audit.append(
    taxCloudAuditEntryOf({
      action: "taxcloud.connection_disconnected",
      actor,
      companyId,
      row: next,
      statusBefore: row.status,
      outcome: "disabled",
    }),
  );

  return { status: "disconnected", connection: taxCloudConnectionViewOf(next) };
}
