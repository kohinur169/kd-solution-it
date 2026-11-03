// path: docs/handoffs/STEP_094_COMPLETED.md
# STEP 094 - Automatic sub-merchant provisioning job after final approval: completed

Branch `arena/bac4f52c-kd-solution-it`. This handoff and the STEP 094 code are in one commit, the
one whose message is "STEP 094: Automatic sub-merchant provisioning job after final approval"
(`git log -1` on the branch shows its hash). Previous handoff: `docs/handoffs/STEP_093_COMPLETED.md`.

## STEP

- **Number and title:** STEP 094 - Automatic sub-merchant provisioning job after final approval
  (`docs/final/STEP_PLAN_250.md`, the STEP 094 block).
- **Category:** Merchant Onboarding, Underwriting, KYC and Sub-Merchant Provisioning, STEPs
  079-099. Sixteenth STEP of the block.
- **Owned paths (File Ownership Rules):** "Onboarding and KYC STEPs 079-099 own
  `app/(dashboard)/onboarding/`, `services/kyc/` and `services/submerchant/`" - plus the block's
  owned `app/api/onboarding/` routes, its migrations, and the shared files the block extends (gate
  harnesses, `app/(dashboard)/README.md`). This STEP used `services/submerchant/`, one owned route,
  and the gate harness; no shared file changed (no new route, no new copy, no new migration).
  `app/(admin)/`, `app/api/office/`, `components/office/`, `lib/settings/`, `lib/jobs/` untouched.
- **Feature list:** section 5 - line 67 "Final approval by CEO or super_admin triggers automatic
  sub-merchant account creation under the connected master platform account"; line 69 provisioning
  stores provider name, provider submerchant id, status, charges/payouts enabled, synced by verified
  webhooks; line 70 "Charges and payouts stay disabled until provider verification completes"; line
  71 "If no master platform account is connected, provisioning stays queued and the office is
  alerted". Section 27 lists "Sub-merchant provisioning after KYC approval" as background work.
- **Depends on:** STEP 093 (the `approved` status its decision flow writes), STEP 029 (`0054`'s
  `submerchant_provisions` and the `0029`/`0030` provider and key tables), the jobs foundation
  (`lib/jobs/`, in-memory store in this build).

## Migration added, and the rollback proof

- **None.** `0054_submerchant_provisions.sql` already holds the provision rows with the unique live
  key per (company, provider), the source guard (only an approved `0048` submission provisions, only
  a platform-level `supports_submerchant` enabled provider, an attempt needs a master account ref),
  the five-status walk, the flags check (flags only on `verified`), the queue index the office alert
  reads, and RLS default-deny. The app reads and writes through the PostgREST service role key.
- `npm run -s check:migrations` passed unchanged: 3165 checks, **108 migrations, 82 tables**.

## Files

- **Created:** `services/submerchant/provision.ts`, `docs/planning/STEP_094_SUBSTEP_BREAKDOWN.md`,
  `docs/handoffs/STEP_094_COMPLETED.md`.
- **Modified:** `app/api/onboarding/kyc-decide/route.ts` (enqueues the job on approval),
  `services/kyc/verify.ts` (3439 -> 3503 checks), `app/(dashboard)/README.md`.

## Behaviour

- **The hook:** when `POST /api/onboarding/kyc-decide` lands a decision `approved`, the route
  enqueues the `submerchant.provision` job through `getJobRuntime()` with payload
  `{ company_id, kyc_submission_id }` and idempotency key `submerchant.provision:<company>:<submission>`
  - a retried request returns the first job instead of enqueueing twice. The enqueue is wrapped in
  try/catch with `logger.error`: a queue outage never undoes the decision it follows.
- **The job** (`runSubmerchantProvisioning`): validates the payload before any query; reads the
  submission by id + company (404 unknown, CONFLICT `not_approved` otherwise - `0054`'s source guard
  enforces the same in the database); reads the platform-level enabled sub-merchant-capable providers
  (`company_id=is.null`, `supports_submerchant=is.true`, `status=eq.enabled`) and the active
  platform master keys (`company_id=is.null`, `status=eq.active`); for each provider without a live
  row, inserts one `pending` provision row naming the approval, with `mode` and `master_account_ref`
  (`<provider_key>:<key id>`) from the master key and `next_attempt_at` set when a master account is
  connected - otherwise `master_account_ref` and `next_attempt_at` stay null, the queued case the
  office alert of STEP 096 reads from `0054`'s queue index. `charges_enabled` and `payouts_enabled`
  are always written `false` (line 70; `0054`'s flags check refuses them before `verified`). Each
  created row is re-read and audited `submerchant_provision.queued` with
  `queued_without_master_account` flagged; a lost insert race converges on the winner's row. A
  second run skips every existing row and writes nothing.
- **Deliberately out of scope here:** the provider API call that records `provider_submerchant_id`
  and `attempted_at` belongs to the adapter STEPs (147+), the verified-webhook status sync is STEP
  095, and the office queue/alert screen is STEP 096. The profile-completeness assertion
  (`assertProvisionable`) is likewise for the attempt/approval UI; `0054`'s guards already make an
  unapproved or incapable request impossible at the database.

## Verification (all exit 0)

- `node services/kyc/verify.ts` - 3503 checks (see
  `docs/planning/STEP_094_SUBSTEP_BREAKDOWN.md` 094.5: the full run over the seeded catalogue - nmi
  provisioned with its master account, stripe_connect queued without one, payoneer/airwallex
  excluded - plus idempotency, race convergence, `not_approved`, and the job machinery: register
  once, idempotent enqueue, boundary payload re-validation, handler run against the fake store).
- `node lib/auth/verify.ts` - 2523 checks, baselines unchanged at 16 keepers / 29 mutation files /
  33 call sites (no new page, no new POST site).
- `npm run -s check:i18n` - 1512/176 (no new copy); `npm run -s check:migrations` - 3165 checks,
  108/82 (no new migration); `npm run -s typecheck`, `npm run -s lint` clean; `npm run -s verify`
  exit 0 (all 9 gates + production build).
- Dev smoke (port 3107, `.env.local` from `.env.example`, removed afterwards): `/` 200 signed-out;
  `/api/jobs/health` 200 with the memory queue `ok`; `POST /api/onboarding/kyc-decide` without a
  token -> 422 `csrf_token_invalid`; `/onboarding/kyc-review` 200 signed-out.

## Acceptance checklist

- The behaviour of the title was exercised through the gate harness: an approval enqueues one
  idempotent job per merchant + submission; the job creates one pending row per connected
  sub-merchant provider, queued-without-master rows included, charges/payouts disabled, every row
  audited, races converging, reruns writing nothing; non-approved submissions provision nothing.
- No UI this STEP by design (STEP 096 owns the queue/alert screen); no new strings, so the i18n gate
  is unchanged; no new route, so the CSRF list and auth baselines are unchanged.

## Notes for the next STEP

- STEP 095 (verified webhook sync) updates these rows through `last_webhook_event_id` /
  `last_synced_at` - `0054`'s sync guard already checks the event belongs to the same provider, is
  signature-verified, processed and the right merchant; the webhook pipeline itself is another
  block's work.
- STEP 096 reads `0054`'s queue index (`status='pending'`, by `next_attempt_at`) for the office alert
  when no master account is connected - the `queued_without_master_account` audit flag marks the same
  case.
- When the adapter STEPs land, the attempt should call `assertProvisionable` first (its error names
  every missing profile fact) and then set `attempted_at` / `attempt_count` / `provider_submerchant_id`
  on the pending row - `0054`'s attempt check ties them together.
