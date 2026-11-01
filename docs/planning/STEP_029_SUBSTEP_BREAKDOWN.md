// path: docs/planning/STEP_029_SUBSTEP_BREAKDOWN.md
# STEP 029 - Sub-Step Breakdown

This document is sub-step 029.1. It reads the plan, the feature list and the STEP 028 handoff,
measures the schema, fixes the design of the one table this STEP owns, and then stops for the
owner's permission before any SQL is written. The proof belongs in
`docs/handoffs/STEP_029_COMPLETED.md`.

## 1. Scope Confirmed From The Source Documents

### STEP 029 as written in docs/final/STEP_PLAN_250.md
- Title: "Migration for sub-merchant provisioning records table".
- Category: Database Schema and Row Level Security (STEP 012-036). A database STEP owns only its
  numbered migration files and the migrations index; no `lib/`, `app/` or `services/` file.
- Neighbours: STEP 028 created `kyc_submissions`, whose approved row is the trigger for
  provisioning; STEP 029 (this one) is the record of the call to a processor; STEP 030 is the
  card blacklist and the velocity counters; STEP 035 is the permissive RLS policy; STEP 147
  onwards are the adapter STEPs that will call the five providers. The job that performs the
  call, the office alert when nothing is connected and the screens are code STEPs.

### Feature list lines that fix the shape
- Section 5: "Final approval by CEO or super_admin triggers automatic sub-merchant account
  creation under the connected master platform account."
- Section 5: "Sub-merchant provisioning stores provider name, provider submerchant id, status
  (pending, action required, verified, restricted, rejected), charges enabled and payouts
  enabled, synced by verified webhooks."
- Section 5: "Charges and payouts stay disabled until provider verification completes."
- Section 5: "If no master platform account is connected, provisioning stays queued and the
  office is alerted."
- Section 5: the five providers are NMI, Payoneer, Rainforest, Stripe Connect and Airwallex;
  "A provider cannot be enabled when its connection test fails", and the adapter reads the
  provider's own documentation in its own session.
- Section 2 (section 13 of the feature list): "Closed and suspended account data and
  sub-merchant records are retained for 7 years for regulatory observation."
- Section 4: "One owner holds exactly one business and one sub-merchant account."
- Section 21 of the plan (role table): `super_admin` and `ceo` approve; `compliance_kyc` owns
  underwriting and the office reads the queue.
- Every table carries `id` UUID v7, `company_id`, `created_at`, `updated_at`, `deleted_at`,
  `version`, RLS and a default-deny policy.

### What exists today (measured before writing this document)
- 53 migrations, 53 tables, 53 policies, 95 triggers and 47 functions in `public`; the gate
  reports 1646 checks. STEP 028 closed with commit `f615110`.
- `payment_providers` (created by STEP 023 as `0029_payment_providers.sql`) is the platform
  catalogue: a `provider_key` from the five, a `supports_submerchant` boolean, a `status` of
  `disabled` or `enabled`, and a check that `company_id` is null, so a provider row is never a
  merchant's.
  `payment_providers_test_check` already refuses an enabled provider whose test did not pass.
- `webhook_events` (STEP 032) carries `provider_id`, `signature_ok`, `status` and
  `processed_at`, with `webhook_events_signature_check` refusing a pending, failed, ignored or
  rejected event with a good signature and `webhook_events_rejected_check` requiring a bad
  signature on a rejected one. That is the "synced by verified webhooks" evidence this table
  points at.
- `kyc_submissions` (STEP 028) carries `status` with `approved` among its values, the
  `kyc_submissions_tenant_key` over `(id, company_id)`, and `decided_at`, so "the approval that
  triggered this row" is a composite foreign key rather than a loose uuid.
- `companies` is the merchant, and `audit_logs` (STEP 013) is the hash chained record the
  service writes when a provisioning attempt happens; this STEP stores the provisioning row
  only.

## 2. Decisions This STEP Makes

1. **One row per merchant and provider, and one live row at a time.** The same merchant is
   provisioned once per processor; `submerchant_provisions_live_key` is a partial unique index
   over `(company_id, provider_id)` for live rows, so a retry updates the row while a rollback
   and a re-provision writes a new one.
2. **The provider is a foreign key, and its key is copied.** `provider_id` points at
   `payment_providers`, and `provider_key` copies the five value vocabulary of the section 5
   providers onto the row, so the audit keeps the provider even if the catalogue row is retired
   and a typo cannot invent a sixth provider.
3. **Queued is a pending row without a master account.** "If no master platform account is
   connected, provisioning stays queued" is `status = 'pending'` with `master_account_ref` null.
   A row cannot be attempted without that reference (`attempted_at` implies it), and the office
   alert is a job over `submerchant_provisions_queue_idx`, not a column.
4. **The five statuses are the whole life.** `pending`, `action_required`, `verified`,
   `restricted` and `rejected` are the closed vocabulary, each with its own instant, and the
   guard walks the row forward only: pending reaches action_required, verified or rejected;
   action_required reaches verified or rejected; verified reaches restricted; restricted and
   rejected are history.
5. **Charges and payouts wait for verification.** A check refuses either flag on any status but
   `verified`, and the guard refuses a flag raised on a row that is leaving `verified` for
   `restricted`, because a restricted sub-merchant cannot take money.
6. **Action required and rejection say why.** `action_required_detail` is required exactly on
   `action_required` and `rejection_reason` exactly on `rejected`, both trimmed and bounded, so
   the merchant reads a reason rather than a code.
7. **The provider must be able to do it.** `submerchant_provisions_guard_source` refuses a row
   whose provider does not `supports_submerchant`, whose provider row is not platform level, and
   an attempt at a provider that is not `enabled`, which together are the section 5 rule that a
   provider without a passing connection test cannot be used.
8. **The approval must be real.** The same guard refuses a row whose `kyc_submissions` row is
   not `approved` and whose `decided_at` is in the future of the request, so provisioning cannot
   start from a draft, an in-review or a rejected cycle.
9. **A sync names its webhook.** `last_synced_at` and `last_webhook_event_id` are a pair, and
   `submerchant_provisions_guard_sync` refuses an event of another provider, an event whose
   signature failed, and an event that has not been processed, which is the section 5 phrase
   "synced by verified webhooks" made a shape rather than a habit.
10. **Mode is on the row.** `mode` is `test` or `live`, as on `provider_keys` and
    `webhook_events`, so a staging sub-account is never mistaken for the production one.
11. **Nothing is deleted, and nothing is anonymised here.** The 7 year retention of section 13
    is a job over the same row, the soft delete marker is frozen once the row is verified, and
    this STEP adds no retention column.
12. **A mismatch of tenancy is impossible.** `kyc_submission_id` is a composite foreign key on
    `(id, company_id)` of the submission, the webhook event must agree on the provider, and the
    merchant is frozen by the identity guard.

## 3. The Schema This Produces

### `0054_submerchant_provisions.sql`
`company_id`, `kyc_submission_id`, `provider_id`, `provider_key`, `mode`, `master_account_ref`,
`provider_submerchant_id`, `status`, `charges_enabled`, `payouts_enabled`, `requested_at`,
`attempted_at`, `verified_at`, `restricted_at`, `rejected_at`, `action_required_detail`,
`rejection_reason`, `attempt_count`, `next_attempt_at`, `last_synced_at`,
`last_webhook_event_id` and the five audit columns `id`, `created_at`, `updated_at`,
`deleted_at` and `version`: 26 columns.

Constraints, in the shape the earlier STEPs use:
- the primary key, four foreign keys (`companies`, the composite `kyc_submissions`,
  `payment_providers`, `webhook_events`), and the vocabulary checks for `provider_key`, `mode`
  and `status`;
- the provider id shape (`^[A-Za-z0-9_-]{1,64}$`), the master account reference shape and the
  trimmed, bounded detail and reason pairs;
- the instant pairs: `verified_at` exactly on verified and restricted, `restricted_at` exactly
  on restricted, `rejected_at` exactly on rejected, attempted count with its instant, the sync
  pair, and the order `requested_at <= attempted_at <= verified_at` and the sync after the
  request;
- the flags only on `verified`, the attempt only with a master account, and the queue instant
  only on a pending row;
- the row metadata checks `version > 0`, `updated_at >= created_at` and the soft delete bound.

Guards (four functions, five triggers with `set_row_metadata`):
`guard_identity` freezes merchant, submission, provider, provider key, mode, master account
reference and request instant; `guard_source` checks the provider and the approval;
`guard_state` walks the five statuses forward, freezes a closed row and keeps the flags legal;
`guard_sync` checks the webhook evidence.

Indexes: `submerchant_provisions_live_key` (partial unique on merchant and provider),
`submerchant_provisions_provider_key` (partial unique on provider and provider sub-merchant id),
`submerchant_provisions_queue_idx` (pending rows by their next attempt), and
`submerchant_provisions_provider_idx` (the office view of one provider by status): four plus the
primary key.

Comments: the table and every column, the four functions. RLS enabled with
`submerchant_provisions_default_deny`.

Measured after `0054` applied: 26 columns, 24 constraints, five indexes, five triggers, 27
comments and four functions, and the schema went from fifty three to fifty four tables, policies
and migrations. The handoff will carry the same numbers read from the catalog.

## 4. The Sub-Steps

### 029.1 - Inventory, decisions and ownership (this document)
Read the plan, the feature list and the STEP 028 handoff; measured the schema; fixed the design
above. No file outside this document is touched. It stops for permission.

### 029.2 - `0054_submerchant_provisions.sql` and its rollback
The table, the four foreign keys, the checks, the four guards, the four indexes, the comments,
RLS and the policy, then a forward apply of `0001` to `0054` and a rollback that leaves the
schema exactly where STEP 028 left it.

### 029.3 - The proof, the docs, the verification and the commit
The behaviour proof of every rule (queued, attempted, action required, verified with both flags,
restricted, rejected, tenancy, webhook evidence, frozen identity, one-way life), the gate and
behaviour probes, the two README patches, `npm run verify`, the handoff file and the single
commit "STEP 029: Migration for sub-merchant provisioning records table" with its push.

## 5. Files This STEP Owns
- `migrations/0054_submerchant_provisions.sql` and `0054_submerchant_provisions.down.sql`
- `migrations/README.md` (one inventory row and one rule)
- `README.md` (one STEP bullet)
- `docs/planning/STEP_029_SUBSTEP_BREAKDOWN.md` and `docs/handoffs/STEP_029_COMPLETED.md`
- Not owned and not touched: `0001` to `0053`, every `lib/` module, `config/`, the environment
  contract, the provisioning job, the office alert, the provider adapters (147 onwards), the
  duplicate check service, the 7 year retention job, the permissive RLS policies (035) and every
  code STEP.

## 6. What This STEP Deliberately Leaves Out
- The call itself. `master_account_ref`, `attempted_at`, `attempt_count` and `next_attempt_at`
  are the row the job reads; no HTTP call, adapter or retry policy lives in a migration.
- The office alert when nothing is connected: a job over the queue index and the notification
  code of a later STEP.
- The webhook handler that writes `last_synced_at` and the event id: this STEP only refuses a
  sync that is not a verified, processed event of the same provider.
- The merchant and office screens, the RLS policies of STEP 035, and the 7 year retention job.
