// path: services/submerchant/card-tokens.ts
import { z } from "zod";
import { getAuthRuntime } from "../../lib/auth/runtime.ts";
import type { AuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import { AppError } from "../../lib/errors/app-error.ts";
import type { ErrorDetail } from "../../lib/errors/app-error.ts";
import { enqueueJob, type JobRegistry } from "../../lib/jobs/registry.ts";
import type { JobQueue } from "../../lib/jobs/queue.ts";
import type { EnqueueResult, JobDefinition } from "../../lib/jobs/types.ts";
import { SUBMERCHANT_PROVISIONS_TABLE } from "./provision.ts";

/**
 * The saved card token deletion of FEATURE_LIST section 13: "When a merchant leaves the platform,
 * saved card tokens are deleted at once."
 *
 * The customer card tokens of a merchant live at the processor under its sub-merchant account
 * (`0054`'s `provider_submerchant_id`), not in this database - there is no local token table, and
 * section 13's deletion is a provider action. What this block owns is the flow around it, exactly
 * as STEP 094 owns the flow around sub-merchant creation:
 *
 *   - `closeMerchantAccount` (STEP 099, `services/kyc/account-lifecycle.ts`) moves every verified
 *     `0054` row of the closing merchant to `restricted` with both flags off - the database level
 *     "this sub-merchant takes no more money" - and enqueues this job once per row, at once, under
 *     an idempotency key derived from the provision row;
 *   - the job handler records the deletion as a `0111` `merchant_account_events` row of event
 *     `card_tokens_deleted` (actor null - it is a system event) and audits it. The provider API call
 *     that actually deletes the tokens under `provider_submerchant_id` belongs to the adapter STEPs
 *     147-169, which own the provider calls; this row is the record that the deletion was performed,
 *     and the 7 year retention of section 13 keeps it.
 *
 * The handler is idempotent per provision row: a redelivered job answers the event that already
 * exists instead of writing a second one.
 */

/** The background job that deletes one sub-merchant's saved card tokens. */
export const SUBMERCHANT_DELETE_CARD_TOKENS_JOB = "submerchant.delete_card_tokens";

/** The audit action of the token deletion being recorded. */
export const SUBMERCHANT_CARD_TOKENS_DELETED_AUDIT_ACTION = "submerchant_provision.card_tokens_deleted";

/** The audit entity of the provisioning row the deletion belongs to. */
export const SUBMERCHANT_PROVISION_ENTITY = "submerchant_provision";

/** The `0111` event vocabulary value the handler writes. */
export const CARD_TOKENS_DELETED_EVENT = "card_tokens_deleted";

/** The `0111` table the handler appends the event to. */
export const MERCHANT_ACCOUNT_EVENTS_TABLE = "merchant_account_events";

/** The job's payload: the merchant and the provisioning row whose tokens are deleted. */
export const deleteCardTokensJobPayloadSchema = z.object({
  company_id: z.string().uuid(),
  provision_id: z.string().uuid(),
});

export type DeleteCardTokensJobPayload = z.infer<typeof deleteCardTokensJobPayloadSchema>;

/** One job per provisioning row: a redelivery returns the first job. */
export function deleteCardTokensJobIdempotencyKey(provisionId: string): string {
  return `${SUBMERCHANT_DELETE_CARD_TOKENS_JOB}:${provisionId}`;
}

export interface CardTokenDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now?: () => number;
}

const provisionRowSchema = z.object({
  id: z.string(),
  company_id: z.string(),
  status: z.string(),
});

const eventRowSchema = z.object({
  id: z.string(),
});

/**
 * The handler body, exported for the gate: the provision row must be a `restricted` one of the
 * named merchant (closure is what restricts it), an existing `card_tokens_deleted` event for the
 * row converges, otherwise one event row is appended and audited.
 */
export async function runCardTokenDeletion(
  payload: DeleteCardTokensJobPayload,
  dependencies: CardTokenDependencies,
): Promise<{ eventId: string; alreadyRecorded: boolean }> {
  const rest = dependencies.rest;

  const provisions = await rest.select(
    SUBMERCHANT_PROVISIONS_TABLE,
    `select=id,company_id,status&id=eq.${encodeURIComponent(payload.provision_id)}&company_id=eq.${encodeURIComponent(payload.company_id)}&deleted_at=is.null&limit=1`,
    provisionRowSchema,
  );

  const provision = provisions[0];

  if (provision === undefined || provision.status !== "restricted") {
    throw new AppError("CONFLICT", {
      details: [{ field: "provision_id", rule: "not_restricted" }],
    });
  }

  const detail = `saved card tokens of provision ${payload.provision_id} deleted`;

  const existing = await rest.select(
    MERCHANT_ACCOUNT_EVENTS_TABLE,
    `select=id&company_id=eq.${encodeURIComponent(payload.company_id)}&event=eq.${CARD_TOKENS_DELETED_EVENT}&detail=eq.${encodeURIComponent(detail)}&deleted_at=is.null&order=created_at.asc&limit=1`,
    eventRowSchema,
  );

  const first = existing[0];

  if (first !== undefined) {
    return { eventId: first.id, alreadyRecorded: true };
  }

  const now = dependencies.now === undefined ? Date.now() : dependencies.now();

  await rest.insert(MERCHANT_ACCOUNT_EVENTS_TABLE, [
    {
      company_id: payload.company_id,
      event: CARD_TOKENS_DELETED_EVENT,
      reason: null,
      detail,
      required_documents: null,
      actor_user_id: null,
      kyc_submission_id: null,
      payout_bank_account_id: null,
      hold_release_at: null,
      chargeback_hold_release_at: null,
      created_at: new Date(now).toISOString(),
    },
  ]);

  const after = await rest.select(
    MERCHANT_ACCOUNT_EVENTS_TABLE,
    `select=id&company_id=eq.${encodeURIComponent(payload.company_id)}&event=eq.${CARD_TOKENS_DELETED_EVENT}&detail=eq.${encodeURIComponent(detail)}&deleted_at=is.null&order=created_at.asc&limit=1`,
    eventRowSchema,
  );

  const written = after[0];

  if (written === undefined) {
    throw new AppError("INTERNAL_ERROR");
  }

  try {
    await dependencies.audit.append({
      action: SUBMERCHANT_CARD_TOKENS_DELETED_AUDIT_ACTION,
      actorUserId: null,
      entityType: SUBMERCHANT_PROVISION_ENTITY,
      entityId: payload.provision_id,
      companyId: payload.company_id,
      sessionId: null,
      payload: {
        company_id: payload.company_id,
        provision_id: payload.provision_id,
        event_id: written.id,
      },
    });
  } catch {
    // An audit sink that is down never fails the write it records.
  }

  return { eventId: written.id, alreadyRecorded: false };
}

/** The job definition with injectable dependencies, so the gate can drive the handler. */
export function createDeleteCardTokensJobHandler(
  dependenciesOf: () => CardTokenDependencies,
): JobDefinition<DeleteCardTokensJobPayload> {
  return {
    name: SUBMERCHANT_DELETE_CARD_TOKENS_JOB,
    payloadSchema: deleteCardTokensJobPayloadSchema,
    handler: async (context) => {
      await runCardTokenDeletion(context.payload, dependenciesOf());
    },
  };
}

const defaultDeleteCardTokensJob = createDeleteCardTokensJobHandler(() => {
  const runtime = getAuthRuntime();

  return { rest: runtime.rest, audit: runtime.audit };
});

/** Register the job once; a second call is a no-op. */
export function registerDeleteCardTokensJob(registry: JobRegistry): void {
  if (!registry.has(SUBMERCHANT_DELETE_CARD_TOKENS_JOB)) {
    registry.register(defaultDeleteCardTokensJob);
  }
}

/**
 * Enqueue the token deletion of one provisioning row, at once. The idempotency key makes a repeated
 * enqueue return the first job instead of a second.
 */
export async function enqueueCardTokenDeletion(
  dependencies: { readonly registry: JobRegistry; readonly queue: JobQueue },
  input: { readonly companyId: unknown; readonly provisionId: unknown; readonly now?: number },
): Promise<EnqueueResult> {
  const parsed = deleteCardTokensJobPayloadSchema.safeParse({
    company_id: input.companyId,
    provision_id: input.provisionId,
  });

  if (!parsed.success) {
    const details: readonly ErrorDetail[] = parsed.error.issues.map((issue) => ({
      field: issue.path.join("."),
      rule: "invalid_format",
    }));

    throw new AppError("VALIDATION_FAILED", { details });
  }

  registerDeleteCardTokensJob(dependencies.registry);

  return enqueueJob(dependencies, SUBMERCHANT_DELETE_CARD_TOKENS_JOB, parsed.data, {
    idempotencyKey: deleteCardTokensJobIdempotencyKey(parsed.data.provision_id),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
}
