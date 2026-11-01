// path: lib/gateways/service.ts
import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError } from "../errors/app-error.ts";
import type { AuditTrail } from "../auth/audit.ts";
import type { RestClient } from "../auth/rest.ts";
import type { SecretBox } from "../auth/secrets.ts";
import { requireAnyRole } from "../auth/session.ts";
import { requireFreshReauthentication } from "../auth/step-up.ts";
import type { RequestActor } from "../auth/types.ts";
import { deepFreeze } from "../utils/freeze.ts";
import {
  GATEWAY_LABEL_MAXIMUM_LENGTH,
  GATEWAY_MANAGEMENT_ROLES,
  GATEWAY_SECRET_MAXIMUM_LENGTH,
  GATEWAY_SECRET_MINIMUM_LENGTH,
  GATEWAY_TEST_DETAIL_MAXIMUM_LENGTH,
  NO_ADAPTER_TEST_DETAIL,
  connectionTesterFor,
  hasConnectionTest,
  isGatewayKeyMode,
  isProviderKey,
  providerDefinitionOf,
  type ConnectionTestOutcome,
  type ConnectionTester,
  type GatewayKeyMode,
  type ProviderCapabilities,
} from "./registry.ts";

/**
 * The gateway page of section 6: the five providers, their keys, their connection tests, and the
 * two switches that put a provider on or take it off.
 *
 * ## What section 6 requires, and where each requirement is kept
 *
 *   - "super_admin only, with 2FA and fresh reauthentication": `GATEWAY_MANAGEMENT_ROLES` plus
 *     `requireFreshReauthentication` on every mutation, in this file rather than in the route, so a
 *     second caller cannot reach a weaker path. A 2FA enrolment is already mandatory to hold the
 *     role (section 22 and STEP 041); the step-up window is the "fresh" part (STEP 053).
 *   - "keys can be added, tested, enabled and disabled without code change or redeploy": every one of
 *     those is a row write here, and the screen offers all four. The only thing a redeploy can change
 *     is which providers exist, which is the registry's job and section 6's rule.
 *   - "AES-256-GCM encrypted before storage, the encryption key only in environment variables": the
 *     secret is sealed by the injected `secrets` port, whose production implementation is
 *     `lib/auth/secrets.ts` reading `ENCRYPTION_MASTER_KEY` from the environment. The plaintext
 *     exists for the length of one function call.
 *   - "after saving, a full key is never shown again": the read below never selects the ciphertext,
 *     the vector, the tag or the fingerprint. A screen gets the last four characters and the time
 *     the row changed, and nothing else exists to leak.
 *   - "a provider cannot be enabled when its connection test fails": the enable refuses without a
 *     recorded passing test, and `payment_providers_test_check` refuses the row if this code forgets.
 *   - "a provider without an adapter in code cannot be added from the dashboard": the panel lists
 *     the registry, and a provider the registry does not know cannot be tested, so it can never
 *     record a passing test, so it can never be enabled.
 *
 * ## Why the state machine has the shape it has
 *
 * A key is added **disabled**. `provider_keys_test_check` says an active key must already have
 * passed a test, so a key becomes active exactly once: in the same operation that records its
 * passing test. `provider_keys_active_key` then allows one active key per provider and mode, so
 * activating a key first disables the key it replaces - a rotation, which is the only way a live
 * credential changes.
 *
 * Disabling a provider also disables its active keys, because an active key is the credential
 * routing uses: a provider that is off must not hold one. Enabling therefore requires a key that is
 * active and a test that passed, which makes "off, then on" a deliberate re-test instead of a blind
 * switch.
 *
 * A failed test of a key that is *not* the provider's active key is recorded on the key only. The
 * provider row is left alone, because the credential that was working is still working, and a
 * candidate that did not pass must not take a live gateway down.
 *
 * ## Optimistic locking
 *
 * Every row write filters on the version it read and then reads the row back, so a stale screen
 * cannot overwrite a decision somebody else took in between: a write that matched no row leaves the
 * version where it was and ends as `CONFLICT`. `set_row_metadata` owns the increment, so this module
 * never writes the column itself.
 */

/**
 * The four tables this module needs, and no more.
 *
 * `RestClient` satisfies it structurally, which is why the production wiring is one assignment in
 * `lib/gateways/runtime.ts`, and why the gate can drive every branch with an in-memory store that
 * speaks the same four methods.
 */
export type GatewayStore = Omit<RestClient, "rpc">;

/** The sealing port: AES-256-GCM in production, an identity box in the gate. */
export interface GatewaySecretSealer {
  seal(plaintext: string, context: string): SecretBox;
  open(box: SecretBox, context: string): string;
}

export interface GatewayDependencies {
  readonly store: GatewayStore;
  readonly audit: AuditTrail;
  readonly secrets: GatewaySecretSealer;
  /** The registry's tester lookup, injectable so the gate can drive a passing test. */
  readonly testerFor?: (providerKey: string) => ConnectionTester | null;
  readonly now?: () => number;
}

/** One stored key as the screen sees it: four characters, a mode, a state and two instants. */
export interface GatewayKeyView {
  readonly id: string;
  readonly label: string;
  readonly mode: GatewayKeyMode;
  readonly status: "active" | "disabled";
  /** The only part of the secret that is ever read back. */
  readonly lastFour: string;
  readonly updatedAtEpochMs: number;
  readonly lastTestedAtEpochMs: number | null;
  readonly lastTestOk: boolean | null;
  readonly lastTestDetail: string | null;
}

/** One provider as the screen sees it: the row, the registry entry, and the keys it holds. */
export interface GatewayView {
  readonly id: string;
  readonly providerKey: string;
  readonly displayName: string;
  readonly displayOrder: number;
  readonly status: "disabled" | "enabled";
  readonly enabledAtEpochMs: number | null;
  readonly lastTestedAtEpochMs: number | null;
  readonly lastTestOk: boolean | null;
  readonly lastTestDetail: string | null;
  readonly version: number;
  /** True when this build has a registry entry for the row's key. */
  readonly registered: boolean;
  /** True when this build can actually run the provider's connection test. */
  readonly adapterInstalled: boolean;
  /** The capability matrix of the registry entry, or nothing at all when there is none. */
  readonly capabilities: ProviderCapabilities;
  readonly keys: readonly GatewayKeyView[];
}

/** The panel: every platform provider in display order, with the counts the office home needs. */
export interface GatewaySnapshot {
  readonly gateways: readonly GatewayView[];
  readonly readAtEpochMs: number;
  readonly enabledCount: number;
  readonly untestedCount: number;
  readonly adapterlessCount: number;
}

/** What one mutation did, in a shape a route can return and a screen can read. */
export interface GatewayMutationOutcome {
  readonly action: "add_key" | "test_key" | "enable" | "disable";
  readonly providerId: string;
  readonly providerKey: string;
  readonly providerStatus: "disabled" | "enabled";
  readonly keyId: string | null;
  readonly keyStatus: "active" | "disabled" | null;
  readonly testOk: boolean | null;
  readonly testDetail: string | null;
  readonly testedAtEpochMs: number | null;
}

/** What one key is sealed under, so a ciphertext moved between rows does not open. */
function secretContext(providerKey: string, mode: GatewayKeyMode, fingerprint: string): string {
  return `provider_keys:${providerKey}:${mode}:${fingerprint}`;
}

/** The encryption key version this build writes. A rotation writes a higher one, in a later STEP. */
const KEY_ENCRYPTION_VERSION = 1;

/** A provider with no registry entry supports nothing, which is how the screen shows it. */
const NO_CAPABILITIES: ProviderCapabilities = deepFreeze({
  acceptance: false,
  payouts: false,
  submerchant: false,
});

const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/u);

const instantSchema = z.string().min(1).max(40);

const providerRowSchema = z.object({
  id: z.string().min(1).max(64),
  provider_key: z.string().min(1).max(40),
  display_name: z.string().min(1).max(GATEWAY_LABEL_MAXIMUM_LENGTH),
  status: z.enum(["disabled", "enabled"]),
  display_order: z.number().int().min(1).max(999),
  enabled_at: instantSchema.nullable(),
  last_tested_at: instantSchema.nullable(),
  last_test_ok: z.boolean().nullable(),
  last_test_detail: z.string().max(GATEWAY_TEST_DETAIL_MAXIMUM_LENGTH).nullable(),
  version: z.number().int().positive(),
});

const keyRowSchema = z.object({
  id: z.string().min(1).max(64),
  provider_id: z.string().min(1).max(64),
  label: z.string().min(1).max(GATEWAY_LABEL_MAXIMUM_LENGTH),
  mode: z.enum(["test", "live"]),
  status: z.enum(["active", "disabled"]),
  key_last_four: z.string().length(4),
  last_tested_at: instantSchema.nullable(),
  last_test_ok: z.boolean().nullable(),
  last_test_detail: z.string().max(GATEWAY_TEST_DETAIL_MAXIMUM_LENGTH).nullable(),
  disabled_at: instantSchema.nullable(),
  updated_at: instantSchema,
});

/** The key with its sealed parts, read only by the one function that runs a test. */
const sealedKeyRowSchema = keyRowSchema.extend({
  key_fingerprint: z.string().length(64),
  key_ciphertext: z.string().min(1).max(8_192),
  key_iv: z.string().min(1).max(64),
  key_tag: z.string().min(1).max(64),
  version: z.number().int().positive(),
});

const insertedKeySchema = z.object({
  id: z.string().min(1).max(64),
  status: z.enum(["active", "disabled"]),
  key_last_four: z.string().length(4),
  updated_at: instantSchema,
});

const versionRowSchema = z.object({ version: z.number().int().positive() });

const activeKeyCounterSchema = z.object({ id: z.string().min(1).max(64) });

/** The columns the panel reads: never the ciphertext, the vector, the tag or the fingerprint. */
const providerSelect =
  "select=id,provider_key,display_name,status,display_order,enabled_at,last_tested_at," +
  "last_test_ok,last_test_detail,version&company_id=is.null&deleted_at=is.null&order=display_order.asc&limit=50";

const keySelect =
  "select=id,provider_id,label,mode,status,key_last_four,last_tested_at,last_test_ok," +
  "last_test_detail,disabled_at,updated_at&company_id=is.null&deleted_at=is.null" +
  "&order=created_at.desc&limit=200";

function epochOf(value: string): number {
  const parsed = Date.parse(value);

  if (!Number.isFinite(parsed)) {
    throw new AppError("INTERNAL_ERROR");
  }

  return parsed;
}

function epochOrNull(value: string | null): number | null {
  return value === null ? null : epochOf(value);
}

function nowOf(dependencies: GatewayDependencies): number {
  return dependencies.now?.() ?? Date.now();
}

function testerOf(dependencies: GatewayDependencies, providerKey: string): ConnectionTester | null {
  return dependencies.testerFor?.(providerKey) ?? connectionTesterFor(providerKey);
}

function keyViewOf(row: z.infer<typeof keyRowSchema>): GatewayKeyView {
  return {
    id: row.id,
    label: row.label,
    mode: row.mode,
    status: row.status,
    lastFour: row.key_last_four,
    updatedAtEpochMs: epochOf(row.updated_at),
    lastTestedAtEpochMs: epochOrNull(row.last_tested_at),
    lastTestOk: row.last_test_ok,
    lastTestDetail: row.last_test_detail,
  };
}

function gatewayViewOf(
  row: z.infer<typeof providerRowSchema>,
  keys: readonly GatewayKeyView[],
): GatewayView {
  const definition = providerDefinitionOf(row.provider_key);

  return {
    id: row.id,
    providerKey: row.provider_key,
    displayName: row.display_name,
    displayOrder: row.display_order,
    status: row.status,
    enabledAtEpochMs: epochOrNull(row.enabled_at),
    lastTestedAtEpochMs: epochOrNull(row.last_tested_at),
    lastTestOk: row.last_test_ok,
    lastTestDetail: row.last_test_detail,
    version: row.version,
    registered: definition !== null,
    adapterInstalled: hasConnectionTest(row.provider_key),
    capabilities: definition?.capabilities ?? NO_CAPABILITIES,
    keys,
  };
}

/**
 * One text a test may record, reduced to what the column holds.
 *
 * A tester is code, but it reports what a remote server said, so the detail is treated as untrusted
 * input: control characters become spaces, runs of whitespace collapse, the result is trimmed, cut to
 * the column's limit and refused when nothing is left. A failure with no detail is stored as the
 * sentence below rather than as an empty string, because `provider_keys_test_detail_check` forbids
 * an empty one and "it failed" with no reason is not worth a row.
 */
export function normalizeTestDetail(detail: string): string {
  const cleaned = detail
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, GATEWAY_TEST_DETAIL_MAXIMUM_LENGTH)
    .trim();

  return cleaned.length === 0 ? "The connection test failed without a reason." : cleaned;
}

/** The AES-256-GCM box a secret is stored in, sealed under the row's own identity. */
function sealKeyMaterial(
  dependencies: GatewayDependencies,
  providerKey: string,
  mode: GatewayKeyMode,
  secret: string,
): { readonly box: SecretBox; readonly fingerprint: string } {
  const fingerprint = createHash("sha256").update(secret, "utf8").digest("hex");
  const box = dependencies.secrets.seal(secret, secretContext(providerKey, mode, fingerprint));

  return { box, fingerprint };
}

/**
 * Read the whole panel: the catalogue, and every key the five providers hold.
 *
 * Two queries and no loop: the providers by `display_order`, the keys by creation instant, grouped in
 * memory. Reading is not audited - a super administrator opening their own configuration page is not
 * a security event, and every mutation below is - but the read is still a permission: the role check
 * is the first statement, so a second caller of this function cannot reach a weaker list.
 */
export async function listGateways(
  input: { readonly actor: RequestActor },
  dependencies: GatewayDependencies,
): Promise<GatewaySnapshot> {
  requireAnyRole(input.actor, GATEWAY_MANAGEMENT_ROLES);

  const providerRows = await dependencies.store.select("payment_providers", providerSelect, providerRowSchema);
  const keyRows = await dependencies.store.select("provider_keys", keySelect, keyRowSchema);

  const keysByProvider = new Map<string, GatewayKeyView[]>();

  for (const keyRow of keyRows) {
    const bucket = keysByProvider.get(keyRow.provider_id) ?? [];

    bucket.push(keyViewOf(keyRow));
    keysByProvider.set(keyRow.provider_id, bucket);
  }

  const gateways = providerRows.map((row) => gatewayViewOf(row, keysByProvider.get(row.id) ?? []));

  return {
    gateways,
    readAtEpochMs: nowOf(dependencies),
    enabledCount: gateways.filter((gateway) => gateway.status === "enabled").length,
    untestedCount: gateways.filter((gateway) => gateway.lastTestedAtEpochMs === null).length,
    adapterlessCount: gateways.filter((gateway) => !gateway.adapterInstalled).length,
  };
}

/**
 * A compare-and-set write, using the version the caller has already read.
 *
 * The filter means a row somebody else changed does not match, and the read-back distinguishes that
 * from a write that landed: `set_row_metadata` sets `version` to the old value plus one, so the row
 * this call wrote is the row that answers `expectedVersion + 1`. Anything else is `CONFLICT`, which
 * the screen shows as "this changed while you were looking at it", not as a failure to save.
 */
async function writeWithVersion(
  dependencies: GatewayDependencies,
  table: "payment_providers" | "provider_keys",
  id: string,
  expectedVersion: number,
  values: Readonly<Record<string, unknown>>,
): Promise<void> {
  await dependencies.store.update(
    table,
    `id=eq.${encodeURIComponent(id)}&version=eq.${expectedVersion}`,
    values,
  );

  const rows = await dependencies.store.select(
    table,
    `select=version&id=eq.${encodeURIComponent(id)}&limit=1`,
    versionRowSchema,
  );

  if (rows[0]?.version !== expectedVersion + 1) {
    throw new AppError("CONFLICT", { details: [{ field: "version", rule: "stale" }] });
  }
}

/**
 * The role and the freshness every mutation in this file needs.
 *
 * `403` without a rule is "this account may not manage gateways"; `403` with `reauth_required` is
 * STEP 053's window and means "prove the second factor again". Both come from these two calls and
 * from nowhere else.
 */
function requireGatewayOperator(actor: RequestActor, instant: number): void {
  requireAnyRole(actor, GATEWAY_MANAGEMENT_ROLES);
  requireFreshReauthentication(actor, instant);
}

async function readProviderByKey(
  dependencies: GatewayDependencies,
  providerKey: string,
): Promise<z.infer<typeof providerRowSchema>> {
  const rows = await dependencies.store.select(
    "payment_providers",
    `select=id,provider_key,display_name,status,display_order,enabled_at,last_tested_at,` +
      `last_test_ok,last_test_detail,version&company_id=is.null&deleted_at=is.null` +
      `&provider_key=eq.${encodeURIComponent(providerKey)}&limit=1`,
    providerRowSchema,
  );

  const row = rows[0];

  if (row === undefined) {
    throw new AppError("RESOURCE_NOT_FOUND");
  }

  return row;
}

async function readProviderById(
  dependencies: GatewayDependencies,
  providerId: string,
): Promise<z.infer<typeof providerRowSchema>> {
  const rows = await dependencies.store.select(
    "payment_providers",
    `select=id,provider_key,display_name,status,display_order,enabled_at,last_tested_at,` +
      `last_test_ok,last_test_detail,version&company_id=is.null&deleted_at=is.null` +
      `&id=eq.${encodeURIComponent(providerId)}&limit=1`,
    providerRowSchema,
  );

  const row = rows[0];

  if (row === undefined) {
    throw new AppError("RESOURCE_NOT_FOUND");
  }

  return row;
}

function validationFailure(field: string, rule: string): never {
  throw new AppError("VALIDATION_FAILED", { details: [{ field, rule }] });
}

/** Every rule a key has to satisfy before it is sealed. */
export function keyProblemOf(input: {
  readonly providerKey: string;
  readonly mode: string;
  readonly label: string;
  readonly secret: string;
}): { readonly field: string; readonly rule: string } | null {
  if (!isProviderKey(input.providerKey)) {
    return { field: "providerKey", rule: "unknown_provider" };
  }

  if (!isGatewayKeyMode(input.mode)) {
    return { field: "mode", rule: "invalid_format" };
  }

  const label = input.label.trim();

  if (label.length < 1 || label.length > GATEWAY_LABEL_MAXIMUM_LENGTH) {
    return { field: "label", rule: "invalid_format" };
  }

  if (
    input.secret.length < GATEWAY_SECRET_MINIMUM_LENGTH ||
    input.secret.length > GATEWAY_SECRET_MAXIMUM_LENGTH
  ) {
    return { field: "secret", rule: "invalid_length" };
  }

  // A key is a token, not a passphrase: printable ASCII with no space covers every provider's key
  // format and refuses a pasted newline or a stray space before it reaches the cipher.
  if (!/^[\x21-\x7e]+$/u.test(input.secret)) {
    return { field: "secret", rule: "invalid_format" };
  }

  // `provider_keys_last_four_check` allows four letters or digits, so a key that ends otherwise is
  // refused here with a sentence rather than by a constraint nobody can read.
  if (!/^[A-Za-z0-9]{4}$/u.test(input.secret.slice(-4))) {
    return { field: "secret", rule: "invalid_tail" };
  }

  return null;
}

/**
 * Store one key for one provider, disabled, sealed, and without the plaintext leaving this function.
 *
 * The duplicate check is on the fingerprint, which `provider_keys_fingerprint_key` also enforces per
 * provider: the same credential stored twice would make "which key is live" ambiguous, so it is a
 * conflict with a sentence instead of a second row.
 */
export async function addGatewayKey(
  input: {
    readonly actor: RequestActor;
    readonly providerKey: string;
    readonly mode: string;
    readonly label: string;
    readonly secret: string;
  },
  dependencies: GatewayDependencies,
): Promise<GatewayMutationOutcome> {
  const instant = nowOf(dependencies);
  requireGatewayOperator(input.actor, instant);

  const problem = keyProblemOf(input);

  if (problem !== null) {
    validationFailure(problem.field, problem.rule);
  }

  if (!isProviderKey(input.providerKey) || !isGatewayKeyMode(input.mode)) {
    validationFailure("providerKey", "unknown_provider");
  }

  const provider = await readProviderByKey(dependencies, input.providerKey);
  const label = input.label.trim();
  const { box, fingerprint } = sealKeyMaterial(
    dependencies,
    input.providerKey,
    input.mode,
    input.secret,
  );

  const duplicate = await dependencies.store.select(
    "provider_keys",
    `select=id&provider_id=eq.${encodeURIComponent(provider.id)}` +
      `&key_fingerprint=eq.${fingerprint}&deleted_at=is.null&limit=1`,
    activeKeyCounterSchema,
  );

  if (duplicate.length > 0) {
    throw new AppError("CONFLICT", { details: [{ field: "secret", rule: "duplicate" }] });
  }

  const inserted = await dependencies.store.insertReturning(
    "provider_keys",
    [
      {
        provider_id: provider.id,
        label,
        mode: input.mode,
        key_last_four: input.secret.slice(-4),
        key_fingerprint: fingerprint,
        key_ciphertext: box.ciphertext,
        key_iv: box.iv,
        key_tag: box.tag,
        encryption_key_version: KEY_ENCRYPTION_VERSION,
        status: "disabled",
        disabled_at: new Date(instant).toISOString(),
      },
    ],
    insertedKeySchema,
  );

  const row = inserted[0];

  if (row === undefined) {
    throw new AppError("DEPENDENCY_FAILED");
  }

  await dependencies.audit.append({
    action: "gateway.key_added",
    actorUserId: input.actor.userId,
    entityType: "provider_key",
    entityId: row.id,
    companyId: null,
    sessionId: input.actor.sessionId,
    payload: {
      provider_key: provider.provider_key,
      mode: input.mode,
      label,
      key_last_four: row.key_last_four,
      encryption_key_version: KEY_ENCRYPTION_VERSION,
    },
  });

  return {
    action: "add_key",
    providerId: provider.id,
    providerKey: provider.provider_key,
    providerStatus: provider.status,
    keyId: row.id,
    keyStatus: row.status,
    testOk: null,
    testDetail: null,
    testedAtEpochMs: null,
  };
}

/** The provider row after a test, and the two facts the audit entry needs. */
interface TestWriteOutcome {
  readonly providerDisabled: boolean;
  readonly activated: boolean;
}

/**
 * Run one stored key's connection test, and write what it found.
 *
 * The plaintext exists between the `open` and the tester's promise and nowhere else: it is not
 * returned, not logged, and not put in the audit payload. What is stored is the verdict, the reason
 * when it failed, and the instant.
 */
export async function testGatewayKey(
  input: { readonly actor: RequestActor; readonly keyId: string },
  dependencies: GatewayDependencies,
): Promise<GatewayMutationOutcome> {
  const instant = nowOf(dependencies);
  requireGatewayOperator(input.actor, instant);

  const parsedKeyId = identifierSchema.safeParse(input.keyId);

  if (!parsedKeyId.success) {
    throw new AppError("RESOURCE_NOT_FOUND");
  }

  const keyRows = await dependencies.store.select(
    "provider_keys",
    `select=id,provider_id,label,mode,status,key_last_four,last_tested_at,last_test_ok,` +
      `last_test_detail,disabled_at,updated_at,key_fingerprint,key_ciphertext,key_iv,key_tag,version` +
      `&company_id=is.null&deleted_at=is.null&id=eq.${encodeURIComponent(parsedKeyId.data)}&limit=1`,
    sealedKeyRowSchema,
  );

  const key = keyRows[0];

  if (key === undefined) {
    throw new AppError("RESOURCE_NOT_FOUND");
  }

  const provider = await readProviderById(dependencies, key.provider_id);
  const providerKey = provider.provider_key;

  // A key whose provider has no registry entry cannot be driven by this build: there is no adapter to
  // ask, so there is no test to run, and the screen says so through the provider row instead.
  if (!isProviderKey(providerKey)) {
    throw new AppError("INTERNAL_ERROR");
  }

  const tester = testerOf(dependencies, providerKey);

  let outcome: ConnectionTestOutcome;

  if (tester === null) {
    outcome = { ok: false, detail: NO_ADAPTER_TEST_DETAIL };
  } else {
    const secret = dependencies.secrets.open(
      { iv: key.key_iv, tag: key.key_tag, ciphertext: key.key_ciphertext },
      secretContext(providerKey, key.mode, key.key_fingerprint),
    );

    outcome = await tester({ providerKey, mode: key.mode, secret, now: instant });
  }

  const testedAt = new Date(instant).toISOString();
  const detail = outcome.ok ? null : normalizeTestDetail(outcome.detail);
  const write = await applyTestResult(key, provider, outcome.ok, detail, testedAt, dependencies);

  await dependencies.audit.append({
    action: "gateway.key_tested",
    actorUserId: input.actor.userId,
    entityType: "provider_key",
    entityId: key.id,
    companyId: null,
    sessionId: input.actor.sessionId,
    payload: {
      provider_key: provider.provider_key,
      mode: key.mode,
      ok: outcome.ok,
      ...(detail === null ? {} : { detail }),
      activated: write.activated,
      provider_disabled: write.providerDisabled,
    },
  });

  const keyStatus = outcome.ok ? "active" : "disabled";

  return {
    action: "test_key",
    providerId: provider.id,
    providerKey: provider.provider_key,
    providerStatus: write.providerDisabled ? "disabled" : provider.status,
    keyId: key.id,
    keyStatus,
    testOk: outcome.ok,
    testDetail: detail,
    testedAtEpochMs: instant,
  };
}

/**
 * Write one test result across the key and, when it belongs there, the provider.
 *
 * Three cases, and the order matters because of two partial unique indexes and two check
 * constraints:
 *
 *   1. the test passed: the key becomes active, which first disables whatever key held the same
 *      provider and mode (`provider_keys_active_key` allows one), and the provider records the
 *      passing result;
 *   2. the test failed and the key was the provider's active credential: the key is disabled and the
 *      provider is taken off, because `payment_providers_test_check` refuses an enabled provider with
 *      a failed test and because a gateway whose live key does not answer must not keep routing;
 *   3. the test failed and the key was not active: only the key records it. The provider's own
 *      credential still works, and one candidate that did not pass does not take a live gateway down.
 */
async function applyTestResult(
  key: z.infer<typeof sealedKeyRowSchema>,
  provider: z.infer<typeof providerRowSchema>,
  ok: boolean,
  detail: string | null,
  testedAt: string,
  dependencies: GatewayDependencies,
): Promise<TestWriteOutcome> {
  const wasActive = key.status === "active";

  if (ok) {
    await dependencies.store.update(
      "provider_keys",
      `provider_id=eq.${encodeURIComponent(key.provider_id)}&mode=eq.${key.mode}` +
        `&status=eq.active&id=neq.${encodeURIComponent(key.id)}&deleted_at=is.null`,
      { status: "disabled", activated_at: null, disabled_at: testedAt },
    );

    await writeWithVersion(dependencies, "provider_keys", key.id, key.version, {
      status: "active",
      activated_at: testedAt,
      disabled_at: null,
      last_tested_at: testedAt,
      last_test_ok: true,
      last_test_detail: null,
    });

    await writeWithVersion(dependencies, "payment_providers", provider.id, provider.version, {
      last_tested_at: testedAt,
      last_test_ok: true,
      last_test_detail: null,
    });

    return { providerDisabled: false, activated: true };
  }

  await writeWithVersion(dependencies, "provider_keys", key.id, key.version, {
    status: "disabled",
    activated_at: null,
    disabled_at: key.disabled_at ?? testedAt,
    last_tested_at: testedAt,
    last_test_ok: false,
    last_test_detail: detail,
  });

  if (!wasActive) {
    return { providerDisabled: false, activated: false };
  }

  await writeWithVersion(dependencies, "payment_providers", provider.id, provider.version, {
    status: "disabled",
    enabled_at: null,
    last_tested_at: testedAt,
    last_test_ok: false,
    last_test_detail: detail,
  });

  return { providerDisabled: true, activated: false };
}

/**
 * Put a provider on, or take it off.
 *
 * Enabling asks three questions and refuses with a different rule for each, because they are three
 * different answers for the operator: this build has no adapter, this provider has no passing test,
 * this provider holds no active key. Disabling is unconditional - taking a gateway off is never the
 * dangerous direction - and it disables the provider's active keys in the same call, so an off
 * provider holds no credential routing could reach for.
 */
export async function setGatewayEnabled(
  input: { readonly actor: RequestActor; readonly providerKey: string; readonly enabled: boolean },
  dependencies: GatewayDependencies,
): Promise<GatewayMutationOutcome> {
  const instant = nowOf(dependencies);
  requireGatewayOperator(input.actor, instant);

  if (!isProviderKey(input.providerKey)) {
    validationFailure("providerKey", "unknown_provider");
  }

  const provider = await readProviderByKey(dependencies, input.providerKey);
  const instantIso = new Date(instant).toISOString();

  if (!input.enabled) {
    if (provider.status === "disabled") {
      return {
        action: "disable",
        providerId: provider.id,
        providerKey: provider.provider_key,
        providerStatus: "disabled",
        keyId: null,
        keyStatus: null,
        testOk: provider.last_test_ok,
        testDetail: provider.last_test_detail,
        testedAtEpochMs: epochOrNull(provider.last_tested_at),
      };
    }

    const activeKeys = await dependencies.store.select(
      "provider_keys",
      `select=id&provider_id=eq.${encodeURIComponent(provider.id)}&status=eq.active` +
        `&deleted_at=is.null&limit=10`,
      activeKeyCounterSchema,
    );

    await writeWithVersion(dependencies, "payment_providers", provider.id, provider.version, {
      status: "disabled",
      enabled_at: null,
    });

    await dependencies.store.update(
      "provider_keys",
      `provider_id=eq.${encodeURIComponent(provider.id)}&status=eq.active&deleted_at=is.null`,
      { status: "disabled", activated_at: null, disabled_at: instantIso },
    );

    await dependencies.audit.append({
      action: "gateway.provider_disabled",
      actorUserId: input.actor.userId,
      entityType: "payment_provider",
      entityId: provider.id,
      companyId: null,
      sessionId: input.actor.sessionId,
      payload: {
        provider_key: provider.provider_key,
        disabled_keys: activeKeys.length,
        disabled_at: instantIso,
      },
    });

    return {
      action: "disable",
      providerId: provider.id,
      providerKey: provider.provider_key,
      providerStatus: "disabled",
      keyId: null,
      keyStatus: null,
      testOk: provider.last_test_ok,
      testDetail: provider.last_test_detail,
      testedAtEpochMs: epochOrNull(provider.last_tested_at),
    };
  }

  // The registry answers this in production (`testerFor` is `connectionTesterFor`), and the seam is
  // the one place a later adapter changes: no tester means no test can pass, so nothing can be on.
  if (testerOf(dependencies, provider.provider_key) === null) {
    throw new AppError("CONFLICT", { details: [{ field: "status", rule: "adapter_missing" }] });
  }

  if (provider.last_test_ok !== true || provider.last_tested_at === null) {
    throw new AppError("CONFLICT", { details: [{ field: "status", rule: "test_required" }] });
  }

  const activeKeys = await dependencies.store.select(
    "provider_keys",
    `select=id&provider_id=eq.${encodeURIComponent(provider.id)}&status=eq.active` +
      `&deleted_at=is.null&limit=10`,
    activeKeyCounterSchema,
  );

  if (activeKeys.length === 0) {
    throw new AppError("CONFLICT", { details: [{ field: "status", rule: "key_required" }] });
  }

  if (provider.status === "enabled") {
    return {
      action: "enable",
      providerId: provider.id,
      providerKey: provider.provider_key,
      providerStatus: "enabled",
      keyId: null,
      keyStatus: null,
      testOk: provider.last_test_ok,
      testDetail: provider.last_test_detail,
      testedAtEpochMs: epochOrNull(provider.last_tested_at),
    };
  }

  await writeWithVersion(dependencies, "payment_providers", provider.id, provider.version, {
    status: "enabled",
    enabled_at: instantIso,
  });

  await dependencies.audit.append({
    action: "gateway.provider_enabled",
    actorUserId: input.actor.userId,
    entityType: "payment_provider",
    entityId: provider.id,
    companyId: null,
    sessionId: input.actor.sessionId,
    payload: {
      provider_key: provider.provider_key,
      active_keys: activeKeys.length,
      enabled_at: instantIso,
    },
  });

  return {
    action: "enable",
    providerId: provider.id,
    providerKey: provider.provider_key,
    providerStatus: "enabled",
    keyId: null,
    keyStatus: null,
    testOk: provider.last_test_ok,
    testDetail: provider.last_test_detail,
    testedAtEpochMs: epochOrNull(provider.last_tested_at),
  };
}
