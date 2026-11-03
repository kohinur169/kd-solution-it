// path: services/submerchant/provision.ts
import { z } from "zod";
import { getAuthRuntime } from "../../lib/auth/runtime.ts";
import type { AuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import { AppError } from "../../lib/errors/app-error.ts";
import type { ErrorDetail } from "../../lib/errors/app-error.ts";
import { enqueueJob, type JobRegistry } from "../../lib/jobs/registry.ts";
import type { JobQueue } from "../../lib/jobs/queue.ts";
import type { EnqueueResult, JobDefinition } from "../../lib/jobs/types.ts";
import { KYC_SUBMISSIONS_TABLE } from "../kyc/kyc-capture.ts";

/**
 * The automatic sub-merchant provisioning of FEATURE_LIST section 5 and section 27: final approval
 * by CEO or super_admin (STEP 093) triggers automatic sub-merchant account creation under the
 * connected master platform account.
 *
 * ## The shape
 *
 * The approval is a `0048` `kyc_submissions` row; `0054`'s `submerchant_provisions` is the account
 * it creates, one live row per merchant and provider (its unique live key), walking the provider's
 * own statuses. This file is the job that creates those rows after an approval:
 *
 *   - the `kyc-decide` route enqueues `submerchant.provision` with
 *     `{ company_id, kyc_submission_id }` when a decision lands `approved`, under an idempotency key
 *     derived from the pair, so a retried request cannot enqueue twice;
 *   - the handler reads the submission (only an `approved` one provisions - `0054`'s source guard
 *     enforces the same at the database), reads the platform level providers that can create
 *     sub-merchants (`company_id is null`, `supports_submerchant`, `enabled`) and the active
 *     platform master keys (`provider_keys` with `company_id is null`, `status = 'active'`);
 *   - for each such provider without a live row it inserts one `pending` row. With a connected
 *     master account the row carries `master_account_ref` and `next_attempt_at`, ready for the
 *     provider attempt; without one it stays queued (`master_account_ref` null), which is the
 *     "no master platform account is connected, provisioning stays queued and the office is
 *     alerted" case - the queue index of `0054` is what the office alert of STEP 096 reads.
 *
 * ## What this STEP deliberately does not do
 *
 * Charges and payouts stay disabled: both flags are written `false`, and `0054`'s flags check
 * refuses either on any status but `verified` - verification completes through the verified webhooks
 * of STEP 095, and the provider call itself belongs to the adapter STEPs, which record
 * `provider_submerchant_id`. A lost insert race converges on the winner's row, exactly as the
 * limit row of STEP 091 does. Every created row is audited `submerchant_provision.queued`; an audit
 * sink that is down never fails the write it records.
 */

/** The `0054` table: one sub-merchant account per merchant and provider. */
export const SUBMERCHANT_PROVISIONS_TABLE = "submerchant_provisions";

/** The `0029` platform catalogue: the master accounts are its platform level rows. */
export const PAYMENT_PROVIDERS_TABLE = "payment_providers";

/** The `0030` keys: a platform level active key is a connected master platform account. */
export const PROVIDER_KEYS_TABLE = "provider_keys";

/** The background job that provisions after a KYC approval. */
export const SUBMERCHANT_PROVISION_JOB = "submerchant.provision";

/** The audit action of a provisioning row being queued. */
export const SUBMERCHANT_PROVISION_QUEUED_AUDIT_ACTION = "submerchant_provision.queued";

/** The audit entity of a provisioning row. */
export const SUBMERCHANT_PROVISION_ENTITY = "submerchant_provision";

/** The job's payload: the merchant and the approved submission. */
export const provisionJobPayloadSchema = z.object({
  company_id: z.string().uuid(),
  kyc_submission_id: z.string().uuid(),
});

export type ProvisionJobPayload = z.infer<typeof provisionJobPayloadSchema>;

/** The idempotency key of one approval's provisioning: one job per merchant and submission. */
export function provisionJobIdempotencyKey(companyId: string, kycSubmissionId: string): string {
  return `${SUBMERCHANT_PROVISION_JOB}:${companyId}:${kycSubmissionId}`;
}

export interface ProvisionDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now?: () => number;
}

export interface ProvisionRunSummary {
  readonly companyId: string;
  readonly kycSubmissionId: string;
  readonly created: number;
  readonly skipped: number;
  readonly queuedWithoutMasterAccount: number;
}

function nowOf(dependencies: ProvisionDependencies): number {
  return dependencies.now === undefined ? Date.now() : dependencies.now();
}

function isoOf(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

const submissionRowSchema = z.object({
  id: z.string(),
  company_id: z.string(),
  status: z.string(),
  decided_at: z.string().nullable(),
});

const providerRowSchema = z.object({
  id: z.string(),
  provider_key: z.string(),
  status: z.string(),
  supports_submerchant: z.boolean(),
  display_order: z.coerce.number(),
});

const providerKeyRowSchema = z.object({
  id: z.string(),
  provider_id: z.string(),
  mode: z.string(),
  status: z.string(),
});

const provisionRowSchema = z.object({
  id: z.string(),
  company_id: z.string(),
  provider_id: z.string(),
  status: z.string(),
  master_account_ref: z.string().nullable(),
  version: z.coerce.number(),
});

/**
 * Run one provisioning pass for one approved submission: one `pending` row per connected
 * sub-merchant provider that does not have a live row yet. Idempotent - a second run skips every
 * row that already exists, and a lost insert race converges on the winner's row.
 */
export async function runSubmerchantProvisioning(
  input: { readonly company_id: unknown; readonly kyc_submission_id: unknown },
  dependencies: ProvisionDependencies,
): Promise<ProvisionRunSummary> {
  const parsed = provisionJobPayloadSchema.safeParse(input);

  if (!parsed.success) {
    const details: readonly ErrorDetail[] = parsed.error.issues.map((issue) => ({
      field: issue.path.join("."),
      rule: "invalid_format",
    }));

    throw new AppError("VALIDATION_FAILED", { details });
  }

  const { company_id: companyId, kyc_submission_id: kycSubmissionId } = parsed.data;
  const rest = dependencies.rest;
  const now = nowOf(dependencies);

  const submissions = await rest.select(
    KYC_SUBMISSIONS_TABLE,
    `select=id,company_id,status,decided_at&id=eq.${encodeURIComponent(kycSubmissionId)}&company_id=eq.${encodeURIComponent(companyId)}&deleted_at=is.null&limit=1`,
    submissionRowSchema,
  );
  const submission = submissions[0];

  if (submission === undefined) {
    throw new AppError("RESOURCE_NOT_FOUND");
  }

  if (submission.status !== "approved") {
    // `0054`'s source guard refuses the insert for any other status; the job refuses earlier.
    throw new AppError("CONFLICT", { details: [{ field: "status", rule: "not_approved" }] });
  }

  // The connected master platform accounts: platform level providers that create sub-merchants
  // and are enabled, with their active platform key when one is connected.
  const [providers, keys] = await Promise.all([
    rest.select(
      PAYMENT_PROVIDERS_TABLE,
      "select=id,provider_key,status,supports_submerchant,display_order&company_id=is.null&supports_submerchant=is.true&status=eq.enabled&deleted_at=is.null&order=display_order.asc&limit=50",
      providerRowSchema,
    ),
    rest.select(
      PROVIDER_KEYS_TABLE,
      "select=id,provider_id,mode,status&company_id=is.null&status=eq.active&deleted_at=is.null&limit=200",
      providerKeyRowSchema,
    ),
  ]);

  const masterKeyOf = new Map<string, z.infer<typeof providerKeyRowSchema>>();

  for (const key of keys) {
    if (!masterKeyOf.has(key.provider_id)) {
      masterKeyOf.set(key.provider_id, key);
    }
  }

  let created = 0;
  let skipped = 0;
  let queuedWithoutMasterAccount = 0;

  for (const provider of providers) {
    const existing = await rest.select(
      SUBMERCHANT_PROVISIONS_TABLE,
      `select=id,company_id,provider_id,status,master_account_ref,version&company_id=eq.${encodeURIComponent(companyId)}&provider_id=eq.${encodeURIComponent(provider.id)}&deleted_at=is.null&limit=1`,
      provisionRowSchema,
    );

    if (existing[0] !== undefined) {
      skipped += 1;

      continue;
    }

    const masterKey = masterKeyOf.get(provider.id);
    const masterAccountRef = masterKey === undefined ? null : `${provider.provider_key}:${masterKey.id}`;

    try {
      await rest.insert(SUBMERCHANT_PROVISIONS_TABLE, [
        {
          company_id: companyId,
          kyc_submission_id: kycSubmissionId,
          provider_id: provider.id,
          provider_key: provider.provider_key,
          mode: masterKey?.mode ?? "test",
          master_account_ref: masterAccountRef,
          status: "pending",
          // Charges and payouts stay disabled until provider verification completes (section 5).
          charges_enabled: false,
          payouts_enabled: false,
          requested_at: isoOf(now),
          next_attempt_at: masterKey === undefined ? null : isoOf(now),
          version: 1,
        },
      ]);
    } catch (error) {
      // A lost insert race converges on the winner's row, as the limit row of STEP 091 does.
      if (error instanceof AppError && error.code === "CONFLICT") {
        const winner = await rest.select(
          SUBMERCHANT_PROVISIONS_TABLE,
          `select=id,company_id,provider_id,status,master_account_ref,version&company_id=eq.${encodeURIComponent(companyId)}&provider_id=eq.${encodeURIComponent(provider.id)}&deleted_at=is.null&limit=1`,
          provisionRowSchema,
        );

        if (winner[0] !== undefined) {
          skipped += 1;

          continue;
        }
      }

      throw error;
    }

    // Read the row back so the audit names the row it recorded.
    const after = await rest.select(
      SUBMERCHANT_PROVISIONS_TABLE,
      `select=id,company_id,provider_id,status,master_account_ref,version&company_id=eq.${encodeURIComponent(companyId)}&provider_id=eq.${encodeURIComponent(provider.id)}&deleted_at=is.null&limit=1`,
      provisionRowSchema,
    );
    const row = after[0];

    if (row === undefined) {
      throw new AppError("DEPENDENCY_FAILED");
    }

    created += 1;

    if (masterAccountRef === null) {
      queuedWithoutMasterAccount += 1;
    }

    try {
      await dependencies.audit.append({
        action: SUBMERCHANT_PROVISION_QUEUED_AUDIT_ACTION,
        actorUserId: null,
        entityType: SUBMERCHANT_PROVISION_ENTITY,
        entityId: row.id,
        companyId,
        sessionId: null,
        payload: {
          company_id: companyId,
          kyc_submission_id: kycSubmissionId,
          provider_id: provider.id,
          provider_key: provider.provider_key,
          master_account_ref: masterAccountRef,
          queued_without_master_account: masterAccountRef === null,
          status: "pending",
        },
      });
    } catch {
      // An audit sink that is down never fails the write it records.
    }
  }

  return {
    companyId,
    kycSubmissionId,
    created,
    skipped,
    queuedWithoutMasterAccount,
  };
}

/**
 * The job definition with injectable dependencies, so the gate can drive the handler against its
 * fake store. The default wiring below closes over the auth runtime, like a route does.
 */
export function createProvisionJobHandler(
  dependenciesOf: () => ProvisionDependencies,
): JobDefinition<ProvisionJobPayload> {
  return {
    name: SUBMERCHANT_PROVISION_JOB,
    payloadSchema: provisionJobPayloadSchema,
    handler: async (context) => {
      await runSubmerchantProvisioning(context.payload, dependenciesOf());
    },
  };
}

const defaultProvisionJob = createProvisionJobHandler(() => {
  const runtime = getAuthRuntime();

  return { rest: runtime.rest, audit: runtime.audit };
});

/** Register the job once; a second call is a no-op, so any route may call it safely. */
export function registerSubmerchantProvisionJob(registry: JobRegistry): void {
  if (!registry.has(SUBMERCHANT_PROVISION_JOB)) {
    registry.register(defaultProvisionJob);
  }
}

/**
 * Enqueue the provisioning of one approval. Called by the decide route when a decision lands
 * `approved`; the idempotency key makes a retried request return the first job instead of a second.
 */
export async function enqueueProvisioningAfterApproval(
  dependencies: { readonly registry: JobRegistry; readonly queue: JobQueue },
  input: { readonly companyId: unknown; readonly kycSubmissionId: unknown },
): Promise<EnqueueResult> {
  const parsed = provisionJobPayloadSchema.safeParse({
    company_id: input.companyId,
    kyc_submission_id: input.kycSubmissionId,
  });

  if (!parsed.success) {
    const details: readonly ErrorDetail[] = parsed.error.issues.map((issue) => ({
      field: issue.path.join("."),
      rule: "invalid_format",
    }));

    throw new AppError("VALIDATION_FAILED", { details });
  }

  registerSubmerchantProvisionJob(dependencies.registry);

  return enqueueJob(dependencies, SUBMERCHANT_PROVISION_JOB, parsed.data, {
    idempotencyKey: provisionJobIdempotencyKey(parsed.data.company_id, parsed.data.kyc_submission_id),
  });
}
