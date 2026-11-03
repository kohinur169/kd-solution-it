// path: services/submerchant/provision-sync.ts
import { z } from "zod";
import { getAuthRuntime } from "../../lib/auth/runtime.ts";
import { AppError } from "../../lib/errors/app-error.ts";
import type { ErrorDetail } from "../../lib/errors/app-error.ts";
import { enqueueJob, type JobRegistry } from "../../lib/jobs/registry.ts";
import { registerDeleteCardTokensJob } from "./card-tokens.ts";
import type { JobQueue } from "../../lib/jobs/queue.ts";
import type { EnqueueResult, JobDefinition } from "../../lib/jobs/types.ts";
import {
  registerSubmerchantProvisionJob,
  SUBMERCHANT_PROVISIONS_TABLE,
  SUBMERCHANT_PROVISION_ENTITY,
  type ProvisionDependencies,
} from "./provision.ts";

/**
 * The verified-webhook sync of FEATURE_LIST section 5: sub-merchant provisioning is "synced by
 * verified webhooks". STEP 094 queued the `0054` provision rows; this file applies a processed,
 * signature-verified `0032` webhook event to the merchant's provision row at that provider.
 *
 * ## The shape
 *
 * The ingestion endpoint (the webhook pipeline of the payment block) stores the delivery as a
 * `webhook_events` row - keyed by the provider's own `(provider_id, mode, external_event_id)`, its
 * payload only as a SHA-256 - verifies the signature, marks the row `processed`, and enqueues the
 * `submerchant.sync` job with `{ webhook_event_id }`, idempotent per event. This module is that job's
 * handler plus the service behind it:
 *
 *   - the event must be `processed` and `signature_ok` (an unverified delivery is never applied -
 *     `0032`'s own check makes `processed` imply `signature_ok`, and `0054`'s sync guard re-checks
 *     both when the row is written), and it must have resolved its merchant;
 *   - the merchant's live provision row at that provider is found by company + provider; the event
 *     type maps to the provision status (`submerchant.verified`, `submerchant.action_required`,
 *     `submerchant.rejected`, `submerchant.restricted`); any other event type only records the sync;
 *   - the write is one conditional update (id + company + current version, over live rows) setting
 *     the walked status with its instants and detail/reason, `last_synced_at` and
 *     `last_webhook_event_id`, and - on `verified` - enabling charges and payouts, which section 5
 *     keeps disabled until provider verification completes; `restricted` disables both again. A
 *     closed row (`restricted`/`rejected`) conflicts, and an impossible walk (say `restricted` from
 *     `pending`) conflicts, exactly as `0054`'s state guard demands at the database;
 *   - a re-read race check conflicts `stale`, and every applied sync is audited
 *     `submerchant_provision.synced`.
 *
 * Re-delivery is idempotent twice over: the event's own unique delivery key means one row per
 * provider event, and the job's idempotency key means one run per event; a row that already names
 * the event is answered as already synced without a write.
 */

/** The `0032` table: the stored provider deliveries. */
export const WEBHOOK_EVENTS_TABLE = "webhook_events";

/** The background job that applies one processed webhook event to a provision row. */
export const SUBMERCHANT_SYNC_JOB = "submerchant.sync";

/** The audit action of a provision row being synced from a verified webhook event. */
export const SUBMERCHANT_PROVISION_SYNCED_AUDIT_ACTION = "submerchant_provision.synced";

/** The provider event types that move a provision row, and the status each maps to. */
export const PROVISION_SYNC_EVENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  "submerchant.verified": "verified",
  "submerchant.action_required": "action_required",
  "submerchant.rejected": "rejected",
  "submerchant.restricted": "restricted",
});

/** The job's payload: the processed webhook event to apply. */
export const syncJobPayloadSchema = z.object({
  webhook_event_id: z.string().uuid(),
});

export type SyncJobPayload = z.infer<typeof syncJobPayloadSchema>;

/** The idempotency key of one event's sync: one run per webhook event. */
export function syncJobIdempotencyKey(webhookEventId: string): string {
  return `${SUBMERCHANT_SYNC_JOB}:${webhookEventId}`;
}

export type ProvisionSyncDependencies = ProvisionDependencies;

export interface ProvisionSyncResult {
  readonly provisionId: string;
  readonly companyId: string;
  readonly providerId: string;
  readonly webhookEventId: string;
  readonly eventType: string;
  readonly fromStatus: string;
  readonly toStatus: string;
  /** False when the row already named this event: nothing was written. */
  readonly applied: boolean;
  readonly version: number;
}

/** The status walk `0054`'s state guard enforces: forward only, closed rows are history. */
const ALLOWED_NEXT: Readonly<Record<string, readonly string[]>> = Object.freeze({
  pending: ["action_required", "verified", "rejected"],
  action_required: ["verified", "rejected"],
  verified: ["restricted"],
  restricted: [],
  rejected: [],
});

function nowOf(dependencies: ProvisionSyncDependencies): number {
  return dependencies.now === undefined ? Date.now() : dependencies.now();
}

function isoOf(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

const eventRowSchema = z.object({
  id: z.string(),
  company_id: z.string().nullable(),
  provider_id: z.string(),
  mode: z.string(),
  external_event_id: z.string(),
  event_type: z.string(),
  status: z.string(),
  signature_ok: z.boolean(),
  payload_hash: z.string(),
  processed_at: z.string().nullable(),
});

const provisionRowSchema = z.object({
  id: z.string(),
  company_id: z.string(),
  provider_id: z.string(),
  status: z.string(),
  charges_enabled: z.boolean(),
  payouts_enabled: z.boolean(),
  last_webhook_event_id: z.string().nullable(),
  version: z.coerce.number(),
});

/**
 * Apply one processed, signature-verified webhook event to the merchant's provision row at the
 * event's provider. This is the `submerchant.sync` job's handler body, exported for the gate.
 */
export async function syncProvisionFromWebhook(
  input: { readonly webhook_event_id: unknown },
  dependencies: ProvisionSyncDependencies,
): Promise<ProvisionSyncResult> {
  const parsed = syncJobPayloadSchema.safeParse(input);

  if (!parsed.success) {
    const details: readonly ErrorDetail[] = parsed.error.issues.map((issue) => ({
      field: issue.path.join("."),
      rule: "invalid_format",
    }));

    throw new AppError("VALIDATION_FAILED", { details });
  }

  const webhookEventId = parsed.data.webhook_event_id;
  const rest = dependencies.rest;
  const now = nowOf(dependencies);

  const events = await rest.select(
    WEBHOOK_EVENTS_TABLE,
    `select=id,company_id,provider_id,mode,external_event_id,event_type,status,signature_ok,payload_hash,processed_at&id=eq.${encodeURIComponent(webhookEventId)}&deleted_at=is.null&limit=1`,
    eventRowSchema,
  );
  const event = events[0];

  if (event === undefined) {
    throw new AppError("RESOURCE_NOT_FOUND");
  }

  if (event.status !== "processed") {
    throw new AppError("CONFLICT", { details: [{ field: "status", rule: "not_processed" }] });
  }

  if (!event.signature_ok) {
    // Unreachable through `0032`'s own check - processed implies signature_ok - but the sync
    // guard of `0054` re-checks it, so the service refuses it here too, before any write.
    throw new AppError("CONFLICT", { details: [{ field: "signature", rule: "signature_unverified" }] });
  }

  if (event.company_id === null) {
    throw new AppError("CONFLICT", { details: [{ field: "company_id", rule: "merchant_unresolved" }] });
  }

  const companyId = event.company_id;
  const provisions = await rest.select(
    SUBMERCHANT_PROVISIONS_TABLE,
    `select=id,company_id,provider_id,status,charges_enabled,payouts_enabled,last_webhook_event_id,version&company_id=eq.${encodeURIComponent(companyId)}&provider_id=eq.${encodeURIComponent(event.provider_id)}&deleted_at=is.null&limit=1`,
    provisionRowSchema,
  );
  const provision = provisions[0];

  if (provision === undefined) {
    throw new AppError("RESOURCE_NOT_FOUND");
  }

  const base = {
    provisionId: provision.id,
    companyId,
    providerId: event.provider_id,
    webhookEventId: event.id,
    eventType: event.event_type,
    fromStatus: provision.status,
    toStatus: provision.status,
    applied: false,
    version: provision.version,
  };

  // Already synced: the row names this event, so a re-delivery changes nothing.
  if (provision.last_webhook_event_id === event.id) {
    return base;
  }

  const nextStatus = PROVISION_SYNC_EVENT_TYPES[event.event_type];

  const values: Record<string, unknown> = {
    last_synced_at: isoOf(now),
    last_webhook_event_id: event.id,
    updated_at: isoOf(now),
    version: provision.version + 1,
  };

  if (nextStatus !== undefined) {
    const allowed = ALLOWED_NEXT[provision.status] ?? [];

    if (allowed.length === 0) {
      throw new AppError("CONFLICT", { details: [{ field: "status", rule: "locked" }] });
    }

    if (!allowed.includes(nextStatus)) {
      throw new AppError("CONFLICT", { details: [{ field: "status", rule: "invalid_transition" }] });
    }

    values["status"] = nextStatus;

    if (nextStatus === "verified") {
      // Section 5: charges and payouts stay disabled until provider verification completes.
      values["verified_at"] = isoOf(now);
      values["charges_enabled"] = true;
      values["payouts_enabled"] = true;
    }

    if (nextStatus === "restricted") {
      values["restricted_at"] = isoOf(now);
      values["charges_enabled"] = false;
      values["payouts_enabled"] = false;
    }

    if (nextStatus === "action_required") {
      values["action_required_detail"] = `provider event ${event.event_type} ${event.external_event_id}`;
    }

    if (nextStatus === "rejected") {
      values["rejection_reason"] = `provider event ${event.event_type} ${event.external_event_id}`;
      values["rejected_at"] = isoOf(now);
    }
  }

  await rest.update(
    SUBMERCHANT_PROVISIONS_TABLE,
    `id=eq.${encodeURIComponent(provision.id)}&company_id=eq.${encodeURIComponent(companyId)}&version=eq.${provision.version}&deleted_at=is.null`,
    values,
  );

  const afterRows = await rest.select(
    SUBMERCHANT_PROVISIONS_TABLE,
    `select=id,company_id,provider_id,status,charges_enabled,payouts_enabled,last_webhook_event_id,version&company_id=eq.${encodeURIComponent(companyId)}&provider_id=eq.${encodeURIComponent(event.provider_id)}&deleted_at=is.null&limit=1`,
    provisionRowSchema,
  );
  const after = afterRows[0];

  if (after === undefined || after.version !== provision.version + 1) {
    throw new AppError("CONFLICT", { details: [{ field: "version", rule: "stale" }] });
  }

  try {
    await dependencies.audit.append({
      action: SUBMERCHANT_PROVISION_SYNCED_AUDIT_ACTION,
      actorUserId: null,
      entityType: SUBMERCHANT_PROVISION_ENTITY,
      entityId: after.id,
      companyId,
      sessionId: null,
      payload: {
        webhook_event_id: event.id,
        external_event_id: event.external_event_id,
        event_type: event.event_type,
        provider_id: event.provider_id,
        from_status: provision.status,
        to_status: after.status,
      },
    });
  } catch {
    // An audit sink that is down never fails the write it records.
  }

  return {
    ...base,
    toStatus: after.status,
    applied: true,
    version: after.version,
  };
}

/**
 * The sync job definition with injectable dependencies, so the gate can drive the handler against
 * its fake store. The default wiring closes over the auth runtime, like a route does.
 */
export function createSyncJobHandler(
  dependenciesOf: () => ProvisionSyncDependencies,
): JobDefinition<SyncJobPayload> {
  return {
    name: SUBMERCHANT_SYNC_JOB,
    payloadSchema: syncJobPayloadSchema,
    handler: async (context) => {
      await syncProvisionFromWebhook(context.payload, dependenciesOf());
    },
  };
}

const defaultSyncJob = createSyncJobHandler(() => {
  const runtime = getAuthRuntime();

  return { rest: runtime.rest, audit: runtime.audit };
});

/** Register the sync job once; a second call is a no-op. */
export function registerSubmerchantSyncJob(registry: JobRegistry): void {
  if (!registry.has(SUBMERCHANT_SYNC_JOB)) {
    registry.register(defaultSyncJob);
  }
}

/** Register the sub-merchant jobs (provision of STEP 094, sync of STEP 095, token deletion of STEP 099) once. */
export function registerSubmerchantJobs(registry: JobRegistry): void {
  registerSubmerchantProvisionJob(registry);
  registerSubmerchantSyncJob(registry);
  registerDeleteCardTokensJob(registry);
}

/**
 * Enqueue the sync of one processed webhook event. The webhook pipeline calls this after marking
 * the event `processed`; the idempotency key makes a re-delivery return the first job.
 */
export async function enqueueProvisionSync(
  dependencies: { readonly registry: JobRegistry; readonly queue: JobQueue },
  input: { readonly webhookEventId: unknown },
): Promise<EnqueueResult> {
  const parsed = syncJobPayloadSchema.safeParse({ webhook_event_id: input.webhookEventId });

  if (!parsed.success) {
    const details: readonly ErrorDetail[] = parsed.error.issues.map((issue) => ({
      field: issue.path.join("."),
      rule: "invalid_format",
    }));

    throw new AppError("VALIDATION_FAILED", { details });
  }

  registerSubmerchantSyncJob(dependencies.registry);

  return enqueueJob(dependencies, SUBMERCHANT_SYNC_JOB, parsed.data, {
    idempotencyKey: syncJobIdempotencyKey(parsed.data.webhook_event_id),
  });
}
