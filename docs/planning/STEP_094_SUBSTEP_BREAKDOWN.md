// path: docs/planning/STEP_094_SUBSTEP_BREAKDOWN.md
# STEP 094 - Automatic sub-merchant provisioning job after final approval: sub-steps

The STEP is one commit. The order below is the order it was built and verified in, so a later STEP
that touches this area can read which slice owns what.

## 094.1 - The database part: none - `0054` already holds the provision rows

- FEATURE_LIST section 5: final approval by CEO or super_admin triggers automatic sub-merchant account
  creation under the connected master platform account; provisioning stores provider, provider
  sub-merchant id, status (pending / action_required / verified / restricted / rejected), charges and
  payouts enabled, synced by verified webhooks; charges and payouts stay disabled until verification
  completes; with no master account connected, provisioning stays queued and the office is alerted.
  STEP 029's `0054_submerchant_provisions.sql` was built with all of that: the unique live key per
  (company, provider), the source guard (only an `approved` `0048` submission provisions, only a
  platform-level `supports_submerchant` provider, an attempt needs an enabled provider and a master
  account ref), the status walk, the flags check (flags only on `verified`), the queue index the
  office alert reads, RLS default-deny (the app reads through the service role key).
- So this STEP adds **no migration**: `npm run -s check:migrations` stays at 108 migrations / 82
  tables / 3165 checks.

## 094.2 - The service and job (`services/submerchant/provision.ts`)

- Constants: `SUBMERCHANT_PROVISIONS_TABLE`, `PAYMENT_PROVIDERS_TABLE`, `PROVIDER_KEYS_TABLE`,
  `SUBMERCHANT_PROVISION_JOB = "submerchant.provision"`,
  `SUBMERCHANT_PROVISION_QUEUED_AUDIT_ACTION = "submerchant_provision.queued"`, entity
  `submerchant_provision`; `provisionJobPayloadSchema = { company_id: uuid, kyc_submission_id: uuid }`;
  `provisionJobIdempotencyKey` = `submerchant.provision:<company>:<submission>`.
- `runSubmerchantProvisioning(input, {rest, audit, now?})`: payload validated before any query;
  the submission read by id + company (404 when unknown, CONFLICT `not_approved` otherwise - `0054`'s
  source guard enforces the same); the platform providers read with `company_id=is.null` +
  `supports_submerchant=is.true` + `status=eq.enabled`; the active platform keys with
  `company_id=is.null` + `status=eq.active`; for each provider without a live provision row, one
  insert of a `pending` row (`charges_enabled`/`payouts_enabled` false, `mode` from the master key,
  `master_account_ref = <provider_key>:<key id>` and `next_attempt_at` when a master account is
  connected, else queued with both null), then a re-read so the audit names the row, and one tolerated
  `submerchant_provision.queued` audit per created row. A lost insert race (CONFLICT) re-reads and
  converges on the winner's row. Second run: all skipped, nothing written.
- `createProvisionJobHandler(dependenciesOf)` builds the `JobDefinition` with injectable deps (the
  gate drives it against the fake store); the default definition closes over `getAuthRuntime()` like
  a route does. `registerSubmerchantProvisionJob(registry)` registers once (no-op on the second
  call). `enqueueProvisioningAfterApproval({registry, queue}, {companyId, kycSubmissionId})`
  validates, registers, and enqueues with the idempotency key.

## 094.3 - The hook in the decide route

- `app/api/onboarding/kyc-decide/route.ts`: after `decideKycSubmission` answers, when
  `detail.status === "approved"` the route enqueues the provision job through `getJobRuntime()`,
  inside a try/catch that logs `logger.error` - a queue outage must not undo the decision it
  follows. Still one POST-only route; no CSRF or i18n change.

## 094.4 - UI

- None this STEP: the provisioning queue and the office alert when no master account is connected are
  STEP 096's screen, which reads the queue index of `0054`. The merchant surface stays the status
  screen of STEP 087. Auth-gate baselines therefore stay 16/29/33.

## 094.5 - Verification

- `services/kyc/verify.ts`: 3439 -> 3503 checks. The fake store grew `providerRows` /
  `providerKeyRows` / `provisionRows` (last positional args of `createBusinessDatabase`, with
  `defaultProviderRows()` - nmi and stripe_connect enabled sub-merchant capable, payoneer without the
  capability, airwallex disabled - and `defaultProviderKeyRows()` - one active test-mode master key
  for nmi), select branches for the three tables (platform tables filtered by their own flags, the
  provision table company-scoped with eq filters on id/provider_id), and an insert branch with the
  shared unique-race flag. New `checkSubmerchantProvision` covers: malformed payload and unknown
  submission, `not_approved` with zero writes, the full run (created 2, queued-without-master 1, both
  rows pending with flags false, nmi carrying `master_account_ref` + `next_attempt_at` in test mode,
  stripe queued with both null, the platform-level provider/key query shapes, company scoping of
  every provision query, two `submerchant_provision.queued` audits with the
  `queued_without_master_account` flag), idempotent rerun, convergence over pre-seeded winner rows,
  and the job machinery itself (register once, enqueue, dedup on the idempotency key, boundary
  payload re-validation, and the handler run against the fake store creating both rows + audits).
  `checkSubmerchantProvisionSources` covers the service/route probes, ASCII, path comments, folder.
- `node lib/auth/verify.ts`: 2523 checks, baselines unchanged 16/29/33. `npm run -s check:i18n`
  1512/176 (no new copy); `npm run -s check:migrations` 108/82 (no new migration); `npm run -s
  typecheck`, `npm run -s lint` clean; `npm run -s verify` exit 0 (all gates + production build).
- Dev smoke on port 3107: `/` 200 signed-out; `/api/jobs/health` 200 with the memory queue ok;
  `POST /api/onboarding/kyc-decide` without a token -> 422 `csrf_token_invalid`;
  `/onboarding/kyc-review` 200 signed-out.
