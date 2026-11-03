// path: docs/handoffs/STEP_095_COMPLETED.md
# STEP 095 - Provider sub-merchant status sync through verified webhooks: completed

Branch `arena/bac4f52c-kd-solution-it`. This handoff and the STEP 095 code are in one commit, the
one whose message is "STEP 095: Provider sub-merchant status sync through verified webhooks"
(`git log -1` on the branch shows its hash). Previous handoff: `docs/handoffs/STEP_094_COMPLETED.md`.

## STEP

- **Number and title:** STEP 095 - Provider sub-merchant status sync through verified webhooks
  (`docs/final/STEP_PLAN_250.md`, the STEP 095 block).
- **Category:** Merchant Onboarding, Underwriting, KYC and Sub-Merchant Provisioning, STEPs
  079-099. Seventeenth STEP of the block.
- **Owned paths (File Ownership Rules):** "Onboarding and KYC STEPs 079-099 own
  `app/(dashboard)/onboarding/`, `services/kyc/` and `services/submerchant/`" - plus the block's
  owned `app/api/onboarding/` routes, its migrations, and the shared files the block extends (gate
  harnesses, `app/(dashboard)/README.md`). This STEP used `services/submerchant/` and the gate
  harness; no shared file changed (no new route, no new copy, no new migration).
  `app/(admin)/`, `app/api/office/`, `components/office/`, `lib/settings/`, `lib/jobs/` untouched.
- **Feature list:** section 5 - line 68 provisioning stores provider name, provider submerchant id,
  the five statuses, charges/payouts enabled, "synced by verified webhooks"; line 70 "Charges and
  payouts stay disabled until provider verification completes"; line 112 "Simulated webhooks let
  the merchant verify an integration"; section 27 line 295 "webhook processing and sub-merchant
  provisioning run as background jobs"; line 312 "webhook endpoints registered per provider" (the
  ingestion endpoint belongs to the payments block).
- **Depends on:** STEP 094 (the provision rows this STEP updates), STEP 029 (`0032_webhook_events`
  and `0054_submerchant_provisions`), the jobs foundation (`lib/jobs/`, in-memory store in this
  build).

## Migration added, and the rollback proof

- **None.** `0032_webhook_events.sql` already holds the verified event (unique per provider + mode +
  external id, only payload_hash stored, signature_ok, forward-only status with guard_evidence,
  signature_check, processed implies processed_at, queue index, RLS default-deny) and
  `0054_submerchant_provisions.sql` already holds the sync target (`guard_sync` tying
  last_webhook_event_id to a same-provider, signature-verified, processed, same-company event;
  sync_check pairing last_synced_at; the state walk with locked end states; flags only on verified).
- `npm run -s check:migrations` passed unchanged: 3165 checks, **108 migrations, 82 tables**.

## Files

- **Created:** `services/submerchant/provision-sync.ts`,
  `docs/planning/STEP_095_SUBSTEP_BREAKDOWN.md`, `docs/handoffs/STEP_095_COMPLETED.md`.
- **Modified:** `services/kyc/verify.ts` (3503 -> 3586 checks), `app/(dashboard)/README.md`.

## Behaviour

- **The service** (`syncProvisionFromWebhook`): validates `{ webhook_event_id }` before any query;
  reads the webhook event by id (404 unknown); refuses anything not `processed` (CONFLICT
  `not_processed`), not signature-verified (CONFLICT `signature_unverified`), or not yet resolved to
  a merchant (CONFLICT `merchant_unresolved`); reads the live provision row for that company +
  provider (404 none); returns `applied: false` when the row already names this event, so a webhook
  re-delivery writes nothing; maps `submerchant.verified` / `action_required` / `rejected` /
  `restricted` onto the `0054` state walk - transitions outside the walk (e.g. restricted from
  pending) conflict `invalid_transition`, and the locked end states (restricted, rejected) conflict
  `locked`; then applies one company-scoped conditional update `id + company_id + version + deleted_at
  is null` setting `last_synced_at`, `last_webhook_event_id`, `version + 1`, plus the per-target
  fields: `verified` sets `verified_at` and enables charges and payouts (line 70 - they stay disabled
  until verification completes), `restricted` sets `restricted_at` and clears both flags, keeps
  `verified_at`, `action_required` writes `action_required_detail` naming the provider event,
  `rejected` writes `rejection_reason` + `rejected_at`. The row is re-read and the run conflicts
  `stale` when the version moved (lost race, no audit). Every applied run audits
  `submerchant_provision.synced` (actorUserId null, from/to status + event in the payload).
- **The job:** `submerchant.sync`, idempotency key `submerchant.sync:<webhook event id>`, so one run
  per webhook event no matter how often the provider redelivers. `registerSubmerchantJobs(registry)`
  registers the 094 `submerchant.provision` job and this sync job exactly once;
  `enqueueProvisionSync({registry, queue}, {webhookEventId})` validates, registers if needed, and
  enqueues - a redelivery returns the first job (`deduplicated: true`). `createSyncJobHandler(depsOf)`
  adapts the service to the job context for the worker.
- **Deliberately out of scope here:** the webhook ingestion endpoint that receives, signature-checks
  and resolves provider deliveries into `0032` rows is the payments block's work (FEATURE_LIST line
  312); this STEP ships the service + job + enqueue helper the ingestion pipeline calls. The office
  queue/alert screen is STEP 096. No UI, no new strings.

## Verification (all exit 0)

- `node services/kyc/verify.ts` - 3586 checks (see
  `docs/planning/STEP_095_SUBSTEP_BREAKDOWN.md` 095.3: bad uuid 0 queries; unknown 404;
  pending/unsigned/unresolved conflicts with 0 updates; missing provision 404; verified applies with
  flags on, verified_at, last_* set, conditional update asserted, version 2, one synced audit;
  re-delivery applied:false no second write; non-provision event type records the event only;
  action_required/rejected/restricted field writes; invalid_transition and locked conflicts with 0
  writes; lost race `stale` no audit; job registration size 2 idempotent; enqueue dedup; bad enqueue
  VALIDATION_FAILED; handler run applies a verified event).
- `node lib/auth/verify.ts` - 2523 checks, baselines unchanged at 16 keepers / 29 mutation files /
  33 call sites (no new page, no new POST site).
- `npm run -s check:i18n` - 1512/176/1 (no new copy); `npm run -s check:migrations` - 3165 checks,
  108/82 (no new migration); `npm run -s typecheck`, `npm run -s lint` clean; `npm run -s verify`
  exit 0 (all gates + production build).
- Dev smoke (port 3107, `.env.local` from `.env.example`, removed afterwards): `/` 200 signed-out;
  `/api/jobs/health` 200 with the memory queue `ok`; `POST /api/onboarding/kyc-decide` without a
  token -> 422 `csrf_token_invalid`; `/onboarding/kyc-review` 200 signed-out.

## Acceptance checklist

- The behaviour of the title was exercised through the gate harness: a processed, signature-verified
  webhook event for a resolved merchant syncs the provision row through the allowed state walk with
  one conditional version-guarded update, enables charges/payouts only on verified, records
  last_webhook_event_id + last_synced_at, audits every applied run, is idempotent on re-delivery, and
  runs as the idempotent `submerchant.sync` background job; unprocessed, unsigned, unresolved,
  mis-walked and raced events conflict without writes.
- No new route, no UI, no new strings: the CSRF list, auth baselines and i18n gate are unchanged.

## Notes for the next STEP

- The payments block's ingestion endpoint should call `enqueueProvisionSync` (or the sync handler
  directly) once a `0032` row reaches `processed` with `signature_ok` and a resolved `company_id` -
  the idempotency key makes duplicate deliveries safe.
- STEP 096 reads `0054`'s queue index (`status='pending'` by `next_attempt_at`) for the office alert
  when no master account is connected; the sync of this STEP moves rows out of pending into the
  later states, and `last_synced_at` tells the office when the row last heard from the provider.
- `guard_sync` in `0054` is the database-level twin of the service's checks: even a direct write of
  `last_webhook_event_id` must reference a same-provider, signature-verified, processed, same-company
  event, so the service's CONFLICTs and the constraint agree.
