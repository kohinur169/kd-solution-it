// path: services/disputes/chargeback-policy.ts
import { createHash } from "node:crypto";
import { z } from "zod";
import type { AuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import type { RequestActor } from "../../lib/auth/types.ts";
import { hasSatisfiedTwoFactor, requireAnyRole } from "../../lib/auth/session.ts";
import { AppError } from "../../lib/errors/app-error.ts";
import {
  CHARGEBACK_AUDIT,
  CHARGEBACK_FIELD,
  CHARGEBACK_POLICY_ROLES,
  CHARGEBACK_POLICY_DEFAULTS,
  CHARGEBACK_RULES,
  CHARGEBACK_THRESHOLDS,
  type ChargebackPolicyValues,
  type ChargebackThresholdDefinition,
} from "./chargeback-fields.ts";

/**
 * Section 18's seven numbers, and the super administrator who owns them.
 *
 * ## Why `platform_settings` and not a table of its own
 *
 * `0080` built this registry for exactly this shape: a dotted key, one JSON value, a frozen key name, a
 * super-admin-only policy, and a version per row. A threshold is a number the platform reads on every
 * measurement and changes once a quarter, which is what the registry is for. `services/kyc/account-lifecycle.ts`
 * already keeps `chargeback.hold_days` here, so a `chargeback.*` family is the family that file started rather
 * than a second home for the same vocabulary.
 *
 * ## Why a bad policy is a refusal and not a fallback
 *
 * A stored value outside its bounds is a deployment whose screens are lying: the office prints the policy and
 * the measurement applies it, so an out-of-range row would either be shown and ignored or applied and never
 * shown. `readChargebackPolicy` refuses instead (`DEPENDENCY_FAILED`, rule `chargeback_policy_invalid`), which
 * is a loud outage on one screen and never a quiet decision about a merchant's reserve.
 *
 * ## Why the digest
 *
 * The watchlist prints which policy it measured against, and the audit entry carries the same digest. A merchant
 * who asks "which rule put me on a reserve" is answered by a 64 character value that names the seven numbers,
 * rather than by a date and somebody's memory of what the numbers were.
 */

/** The dependencies: the platform client, the chain, and a clock. */
export interface ChargebackPolicyDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now?: () => number;
}

/** One policy as a screen reads it. */
export interface ChargebackPolicyView {
  readonly values: ChargebackPolicyValues;
  /** SHA-256 over the seven numbers, so a decision can name the policy it used. */
  readonly digest: string;
  /** When the newest of the seven rows was written, or null when every one of them is a default. */
  readonly updatedAtEpochMs: number | null;
  /** Whether this actor may change the seven numbers. */
  readonly canEdit: boolean;
}

const settingRowSchema = z.object({
  setting_key: z.string(),
  value: z.unknown(),
  updated_at: z.string(),
  version: z.number().int().positive(),
});

const versionRowSchema = z.object({ version: z.number().int().positive() });

const POLICY_TABLE = "platform_settings";

const THRESHOLD_ENTRIES: readonly (readonly [keyof ChargebackPolicyValues, ChargebackThresholdDefinition])[] = [
  ["windowDays", CHARGEBACK_THRESHOLDS.windowDays],
  ["minimumTransactions", CHARGEBACK_THRESHOLDS.minimumTransactions],
  ["warningRateBps", CHARGEBACK_THRESHOLDS.warningRateBps],
  ["reserveRateBps", CHARGEBACK_THRESHOLDS.reserveRateBps],
  ["suspensionRateBps", CHARGEBACK_THRESHOLDS.suspensionRateBps],
  ["reservePercentBps", CHARGEBACK_THRESHOLDS.reservePercentBps],
  ["reserveDays", CHARGEBACK_THRESHOLDS.reserveDays],
];

function refused(rule: string): AppError {
  return new AppError("VALIDATION_FAILED", { details: [{ field: CHARGEBACK_FIELD, rule }] });
}

function nowOf(dependencies: ChargebackPolicyDependencies): number {
  return dependencies.now?.() ?? Date.now();
}

/**
 * The policy as a name: the seven numbers in a fixed order, joined, and hashed.
 *
 * Fixed order matters: an object whose keys were reordered by a JSON round trip must hash to the same digest,
 * because the digest is compared across a measurement, an audit entry and a screen.
 */
export function policyDigestOf(values: ChargebackPolicyValues): string {
  const canonical = THRESHOLD_ENTRIES.map(([name, definition]) => `${definition.key}=${String(values[name])}`).join(";");

  return createHash("sha256").update(canonical).digest("hex");
}

/** A rate in basis points as the sentence a screen prints: `241` reads `2.41`. */
export function ratePercentText(basisPoints: number): string {
  const whole = Math.floor(basisPoints / 100);
  const fraction = String(basisPoints % 100).padStart(2, "0");

  return `${String(whole)}.${fraction}`;
}

/** The policy body's shape: seven integers and nothing else. */
const policyBodySchema = z
  .object({
    windowDays: z.number().int(),
    minimumTransactions: z.number().int(),
    warningRateBps: z.number().int(),
    reserveRateBps: z.number().int(),
    suspensionRateBps: z.number().int(),
    reservePercentBps: z.number().int(),
    reserveDays: z.number().int(),
  })
  .strict();

/**
 * Parse a policy body, and refuse one that is not a policy.
 *
 * Two refusals are not shape refusals: the bounds, because a threshold of zero warns every merchant every day,
 * and the order, because a reserve bar below the warning bar would make the middle step unreachable and read on
 * a screen as a platform that had stopped measuring.
 */
export function parsePolicyBody(body: unknown): ChargebackPolicyValues {
  const parsed = policyBodySchema.safeParse(body);

  if (!parsed.success) {
    throw refused(CHARGEBACK_RULES.policyInvalid);
  }

  const values: ChargebackPolicyValues = parsed.data;

  for (const [name, definition] of THRESHOLD_ENTRIES) {
    const value = values[name];

    if (value < definition.minimum || value > definition.maximum) {
      throw refused(CHARGEBACK_RULES.policyInvalid);
    }
  }

  if (values.warningRateBps > values.reserveRateBps || values.reserveRateBps > values.suspensionRateBps) {
    throw refused(CHARGEBACK_RULES.policyInvalid);
  }

  return values;
}

/** The query that reads the seven rows at once. */
function policyQuery(): string {
  const keys = THRESHOLD_ENTRIES.map(([, definition]) => encodeURIComponent(definition.key)).join(",");

  return (
    "select=setting_key,value,updated_at,version" +
    `&setting_key=in.(${keys})` +
    "&company_id=is.null&deleted_at=is.null"
  );
}

/** Read the seven numbers, defaulting the ones this platform has never been told. */
export async function readChargebackPolicy(
  dependencies: ChargebackPolicyDependencies,
): Promise<ChargebackPolicyView> {
  const rows = await dependencies.rest.select(POLICY_TABLE, policyQuery(), settingRowSchema);
  const byKey = new Map(rows.map((row) => [row.setting_key, row]));
  const values: Record<string, number> = { ...CHARGEBACK_POLICY_DEFAULTS };
  let updatedAtEpochMs: number | null = null;

  for (const [name, definition] of THRESHOLD_ENTRIES) {
    const row = byKey.get(definition.key);

    if (row === undefined) {
      continue;
    }

    const parsed = z.number().int().safeParse(row.value);
    const stored = parsed.success ? parsed.data : Number.NaN;

    if (!Number.isFinite(stored) || stored < definition.minimum || stored > definition.maximum) {
      // A row the platform cannot honour is a row the platform must not ignore: refusing here means one loud
      // failure instead of a screen printing a policy nobody applied.
      throw new AppError("DEPENDENCY_FAILED", {
        cause: { rule: CHARGEBACK_RULES.policyInvalid, key: definition.key },
      });
    }

    values[name] = stored;
    const written = Date.parse(row.updated_at);

    if (Number.isFinite(written) && (updatedAtEpochMs === null || written > updatedAtEpochMs)) {
      updatedAtEpochMs = written;
    }
  }

  const ordered = values as unknown as ChargebackPolicyValues;

  if (ordered.warningRateBps > ordered.reserveRateBps || ordered.reserveRateBps > ordered.suspensionRateBps) {
    throw new AppError("DEPENDENCY_FAILED", { cause: { rule: CHARGEBACK_RULES.policyInvalid } });
  }

  return { values: ordered, digest: policyDigestOf(ordered), updatedAtEpochMs, canEdit: false };
}

/** Write one row, guarded by the version this read saw, and prove the write landed. */
async function writeSetting(
  dependencies: ChargebackPolicyDependencies,
  input: { readonly key: string; readonly value: number; readonly actorUserId: string; readonly row: { readonly id: string; readonly version: number } | null },
): Promise<void> {
  if (input.row === null) {
    await dependencies.rest.insert(POLICY_TABLE, [
      {
        setting_key: input.key,
        value: input.value,
        is_secret: false,
        updated_by: input.actorUserId,
        created_at: new Date(nowOf(dependencies)).toISOString(),
        updated_at: new Date(nowOf(dependencies)).toISOString(),
      },
    ]);

    const written = await dependencies.rest.select(
      POLICY_TABLE,
      `select=version&setting_key=eq.${encodeURIComponent(input.key)}&company_id=is.null&deleted_at=is.null&limit=1`,
      versionRowSchema,
    );

    if (written[0] === undefined) {
      throw new AppError("CONFLICT", { details: [{ field: CHARGEBACK_FIELD, rule: "stale" }] });
    }

    return;
  }

  await dependencies.rest.update(
    POLICY_TABLE,
    `id=eq.${encodeURIComponent(input.row.id)}&version=eq.${String(input.row.version)}`,
    { value: input.value, updated_by: input.actorUserId },
  );

  const after = await dependencies.rest.select(
    POLICY_TABLE,
    `select=version&id=eq.${encodeURIComponent(input.row.id)}&limit=1`,
    versionRowSchema,
  );

  if (after[0]?.version !== input.row.version + 1) {
    throw new AppError("CONFLICT", { details: [{ field: CHARGEBACK_FIELD, rule: "stale" }] });
  }
}

/**
 * Save the seven numbers.
 *
 * The role and the second factor are asked here as well as on the route, because a service that only a route
 * protects is a service a job will one day call. A value that did not change writes nothing, so an officer who
 * opens the panel and saves it unchanged leaves no audit entry and moves no version.
 */
export async function saveChargebackPolicy(
  input: { readonly actor: RequestActor; readonly body: unknown },
  dependencies: ChargebackPolicyDependencies,
): Promise<ChargebackPolicyView> {
  requireAnyRole(input.actor, CHARGEBACK_POLICY_ROLES);

  if (!hasSatisfiedTwoFactor(input.actor)) {
    throw new AppError("PERMISSION_DENIED");
  }

  const values = parsePolicyBody(input.body);
  const rows = await dependencies.rest.select(
    POLICY_TABLE,
    `${policyQuery()}&select=id,setting_key,value,updated_at,version`,
    settingRowSchema.extend({ id: z.string() }),
  );
  const byKey = new Map(rows.map((row) => [row.setting_key, row]));
  const changed: string[] = [];

  for (const [name, definition] of THRESHOLD_ENTRIES) {
    const row = byKey.get(definition.key) ?? null;
    const next = values[name];

    if (row !== null && row.value === next) {
      continue;
    }

    await writeSetting(dependencies, {
      key: definition.key,
      value: next,
      actorUserId: input.actor.userId,
      row: row === null ? null : { id: row.id, version: row.version },
    });
    changed.push(definition.key);
  }

  const saved = await readChargebackPolicy(dependencies);

  if (changed.length > 0) {
    await dependencies.audit.append({
      action: CHARGEBACK_AUDIT.policySaved,
      actorUserId: input.actor.userId,
      entityType: POLICY_TABLE,
      entityId: null,
      companyId: null,
      sessionId: input.actor.sessionId,
      payload: {
        changed_keys: changed,
        policy_digest: saved.digest,
        window_days: values.windowDays,
        minimum_transactions: values.minimumTransactions,
        warning_rate_bps: values.warningRateBps,
        reserve_rate_bps: values.reserveRateBps,
        suspension_rate_bps: values.suspensionRateBps,
        reserve_percent_bps: values.reservePercentBps,
        reserve_days: values.reserveDays,
      },
    });
  }

  return { ...saved, canEdit: true };
}

/** Read the policy and answer whether this actor may change it, which is what the screen asks. */
export async function readChargebackPolicyFor(
  actor: RequestActor,
  dependencies: ChargebackPolicyDependencies,
): Promise<ChargebackPolicyView> {
  const view = await readChargebackPolicy(dependencies);
  const editor =
    hasSatisfiedTwoFactor(actor) && actor.roles.some((role) => CHARGEBACK_POLICY_ROLES.includes(role));

  return { ...view, canEdit: editor };
}

/** The refusal a caller reads when a stored policy is out of range, exported for the gate's own assertions. */
export function isPolicyRefusal(error: unknown): boolean {
  return error instanceof AppError && error.code === "DEPENDENCY_FAILED";
}
