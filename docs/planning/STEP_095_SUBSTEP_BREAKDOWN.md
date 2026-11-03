// path: docs/planning/STEP_095_SUBSTEP_BREAKDOWN.md
# STEP 095 - Provider sub-merchant status sync through verified webhooks: sub-steps

The STEP is one commit. The order below is the order it was built and verified in, so a later STEP
that touches this area can read which slice owns what.

## 095.1 - The database part: none - `0032` + `0054` already hold everything

- FEATURE_LIST anchors: line 68 "provisioning stores provider name, provider submerchant id, status
  (pending, action required, verified, restricted, rejected), charges enabled and payouts enabled,
  synced by verified webhooks"; line 70 "Charges and payouts stay disabled until provider
  verification completes"; line 112 "Simulated webhooks let the merchant verify an integration";
  line 295 "webhook processing ... runs as background jobs"; line 312 "webhook endpoints registered
  per provider" (the ingestion endpoint itself is the payments block's work, not this STEP's).
- `0032_webhook_events.sql` already holds the event: unique (provider_id, mode, external_event_id),
  only payload_hash stored, `signature_ok`, the forward-only status walk with `guard_evidence`, the
  `signature_check` (signature_ok or status in pending/failed/ignored/rejected), processed implies
  processed_at, the queue index on (status, received_at) where pending/processing, company_id null
  until resolved, RLS default-deny.
- `0054_submerchant_provisions.sql` already holds the sync target: `guard_sync` (last_webhook_event_id
  must be a same-provider, signature_ok, processed, same-company webhook event), `sync_check`
  (last_synced_at iff last_webhook_event_id), the state walk pending -> action_required/verified/
  rejected, action_required -> verified/rejected, verified -> restricted, restricted/rejected locked,
  and the flags check (flags only on verified).
- So this STEP adds **no migration**: `npm run -s check:migrations` stays at 108 migrations / 82
  tables / 3165 checks. The app reads and writes through the PostgREST service role key.

## 095.2 - The sync service (`services/submerchant/provision-sync.ts`)

- Constants: `WEBHOOK_EVENTS_TABLE = "webhook_events"`, `SUBMERCHANT_SYNC_JOB = "submerchant.sync"`,
  `SUBMERCHANT_PROVISION_SYNCED_AUDIT_ACTION = "submerchant_provision.synced"` (entity
  `submerchant_provision`), `PROVISION_SYNC_EVENT_TYPES` mapping `submerchant.verified` ->
  `verified`, `submerchant.action_required` -> `action_required`, `submerchant.rejected` ->
  `rejected`, `submerchant.restricted` -> `restricted`; `syncJobPayloadSchema = { webhook_event_id:
  uuid }`; `syncJobIdempotencyKey` = `submerchant.sync:<event id>`.
- `syncProvisionFromWebhook(input, deps)`: validates the payload before any query; reads the event
  by id with `deleted_at=is.null` (404 unknown); CONFLICT `not_processed` unless status is
  `processed`; CONFLICT `signature_unverified` unless `signature_ok`; CONFLICT `merchant_unresolved`
  when `company_id` is null; reads the live provision row by company + provider (404 none); returns
  `applied: false` when the row already names this event (re-delivery is a no-op, no writes); maps
  the event type (unmapped types apply nothing but still record the event id); walks the `0054`
  table - `ALLOWED_NEXT` pending: action_required/verified/rejected, action_required:
  verified/rejected, verified: restricted, restricted/rejected: locked (CONFLICT `locked`, and a
  transition not in the walk is CONFLICT `invalid_transition`); then one company-scoped conditional
  update `id=eq..&company_id=eq..&version=eq.N&deleted_at=is.null` setting `last_synced_at`,
  `last_webhook_event_id`, `version = N+1` and the per-target fields: verified -> `verified_at` +
  charges_enabled/payouts_enabled true (line 70: flags stay false until then), restricted ->
  `restricted_at` + flags false, action_required -> `action_required_detail` naming the provider
  event, rejected -> `rejection_reason` + `rejected_at`; re-reads and CONFLICT `stale` when the
  version is not N+1 (lost race, nothing audited); every applied run audits
  `submerchant_provision.synced` with actorUserId null and the from/to payload.
- Job machinery: `createSyncJobHandler(depsOf)` wraps `syncProvisionFromWebhook` for the job
  context; `registerSubmerchantSyncJob` is a no-op when already registered; `registerSubmerchantJobs`
  registers the 094 provision job and this sync job once; `enqueueProvisionSync({registry, queue},
  {webhookEventId})` validates (VALIDATION_FAILED on a bad id), registers if needed, and enqueues
  with the per-event idempotency key so a redelivered webhook returns the first job.

## 095.3 - The gate harness (`services/kyc/verify.ts`)

- The fake store learned a `webhook_events` branch (select requires `deleted_at=is.null`, id,
  limit; rows parse through the event row schema) and a company-scoped, version-conditional
  `submerchant_provisions` update branch (a `provisionRace` flag bumps the version by 5 to simulate a
  lost race); provisions reads default `last_webhook_event_id`/`last_synced_at` to null.
- `checkSubmerchantSync()` (3503 -> 3586 checks): bad uuid -> VALIDATION_FAILED with 0 queries;
  unknown event -> 404; pending / unsigned / unresolved events -> CONFLICT not_processed /
  signature_unverified / merchant_unresolved with 0 updates; missing provision -> 404; a verified
  event applies (status verified, flags true, verified_at + last_* set, the conditional update query
  asserted, version 2, one synced audit); re-delivery returns applied:false with no second write; a
  non-provision event type (payment.succeeded) records the event id without changing status;
  action_required writes its detail; rejected writes reason + rejected_at; restricted-on-verified
  clears the flags and keeps verified_at; restricted-from-pending and verified-on-rejected conflict
  with 0 writes; the lost race conflicts `stale` with no audit; job registration is size 2 and
  idempotent; enqueue dedups to the same job id; a bad enqueue id is VALIDATION_FAILED; the handler
  run applies a verified event end to end.
- No new route, no new page, no new copy: auth baselines stay 16/29/33, i18n stays 1512/176/1.
