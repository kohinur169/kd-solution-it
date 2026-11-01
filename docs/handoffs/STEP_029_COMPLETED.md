// path: docs/handoffs/STEP_029_COMPLETED.md
# STEP 029 Completed - Handoff

## STEP
- Number and title: STEP 029 - Migration for sub-merchant provisioning records table
- Category: Database Schema and Row Level Security (STEP 012-036)
- Depends on (earlier STEPs in this category and their handoff files): STEP 028 (the approved
  `kyc_submissions` row that triggers provisioning, through its composite tenant key), STEP 023
  (the `payment_providers` catalogue and its `supports_submerchant` flag), STEP 032 (the
  `webhook_events` rows whose signature and status are the sync evidence) and STEP 001 (the
  merchant every row belongs to). STEP 030 is the card blacklist and velocity STEP, STEP 035 the
  permissive policies, and STEP 147 onwards the adapters that will call the five providers. The
  owner split this STEP into three sub-steps with an approval between each, and the plan is
  `docs/planning/STEP_029_SUBSTEP_BREAKDOWN.md`.

## Files
- Created:
  - migrations/0054_submerchant_provisions.sql and 0054_submerchant_provisions.down.sql - the
    provisioning row with its approval and provider keys, its five statuses and instants, its
    two flags, its attempt and queue columns, its webhook evidence and four guards.
  - docs/planning/STEP_029_SUBSTEP_BREAKDOWN.md and docs/handoffs/STEP_029_COMPLETED.md.
- Modified:
  - migrations/verify.ts - the table parser now reads a column only where a name is followed by
    a type, so the wrapped body of a long constraint can no longer be mistaken for a column and
    the required-column check cannot be fooled by a removed `deleted_at`. The gate stayed at
    1677 checks and the rule is described in the migrations index.
  - migrations/README.md - one inventory row for `0054`, one new rule (a sub-merchant is
    provisioned once per merchant and provider, and its row is a life), the numbering rule moved
    from 42 to 43, the introduction now says fifty four files, and the gate paragraph names the
    stricter column parser.
  - README.md - the database section describes the provisioning row, directly above the
    `uuid_generate_v7()` bullet.
- Owned paths touched (must match the File Ownership Rules in STEP_PLAN_250.md): numbered
  migration files in `migrations/`, the migrations gate and the two indexes. Not touched:
  migrations `0001` to `0053`, every `lib/` module, `config/`, the environment contract, the
  provisioning job, the office alert, the provider adapters (147 onwards), the duplicate check
  service, the retention job, the permissive RLS policies (035) and every code STEP.
  `package.json` is untouched because the gate already covers new files.

## Database
- Migrations added (file names): `0054_submerchant_provisions`, with its `.down.sql`. It creates
  one table with 26 columns, 24 constraints, five indexes, 27 comments, four functions and five
  triggers. The schema now holds fifty four tables, fifty four policies, one hundred triggers
  and fifty one functions in `public`.
- Shape of the table: `submerchant_provisions` 26 columns, 24 constraints, five indexes (the
  primary key, two partial unique keys, the queue and the office view), five triggers and 27
  comments; RLS on with `submerchant_provisions_default_deny`.
- Seeded from section 5 rather than invented: the five statuses are exactly `pending`,
  `action_required`, `verified`, `restricted` and `rejected`, the five provider keys copy the
  catalogue vocabulary (`nmi`, `payoneer`, `rainforest`, `stripe_connect`, `airwallex`), the two
  flags are the `charges enabled` and `payouts enabled` of the feature list, and `mode` is the
  same `test` or `live` that `provider_keys` and `webhook_events` already carry.
- Tenancy is structural. `(kyc_submission_id, company_id)` is a composite foreign key into
  `kyc_submissions`, so a row cannot be filed under another merchant's approval, and
  `submerchant_provisions_live_key` is a partial unique index over `(company_id, provider_id)`,
  so one merchant has one live row per provider while a new row can follow a deleted one.
- Queued is a shape, not a status. A `pending` row with `master_account_ref` null is the section
  5 case "provisioning stays queued and the office is alerted"; the reference may be filled
  once, when the platform account is connected, and `submerchant_provisions_guard_identity`
  refuses a second value or a return to null. `submerchant_provisions_attempt_check` refuses an
  attempt without the reference, and `submerchant_provisions_guard_source` refuses an attempt at
  a provider that is not enabled.
- Money is gated. `charges_enabled` and `payouts_enabled` are legal only on `verified`, and
  `submerchant_provisions_guard_state` refuses a row that goes to `restricted` while either flag
  is still on, so "charges and payouts stay disabled until provider verification completes" and
  stops there.
- The webhook evidence is verified. `last_synced_at` and `last_webhook_event_id` are a pair, and
  `submerchant_provisions_guard_sync` refuses an event of another provider, an event whose
  signature failed, a pending event, and an event that belongs to another merchant.
- Rollback verified on clean database (yes/no, how): **yes**, on PostgreSQL 16.2. The rollback
  of `0054` alone returned the schema to fifty three tables, fifty three policies, ninety five
  triggers and forty seven functions, and the file applied again to the same shape; all fifty
  four rollbacks ran in reverse dependency order on populated databases and left 0 public
  tables, 0 policies, 0 triggers and 0 functions in `public`.

## Environment
- Environment variables added to .env.example: none.
- Secrets handled (names only, never values): none. The proofs wrote synthetic provider keys, a
  synthetic master account reference, synthetic sub-merchant identifiers and synthetic webhook
  payload hashes in throwaway local databases, and no real provider credential or master account
  was written anywhere.

## Packages
- Package requests for the integrator (name, reason), or none: none.

## Behaviour Proof (acceptance checklist)
Four scripts ran against the local PostgreSQL 16.2 with 55, 6 and 3 checks, and five gate
  probes;
all of them passed and the proof scripts ended with `PROOF COMPLETE`.

1. **Forward apply.** `0001` to `0054` applied in order and produced fifty four tables, fifty
   four policies, one hundred triggers and fifty one functions, and the new table matched its
   measured shape exactly (26 columns, 24 constraints, five indexes, five triggers, 27
  comments).
2. **Queued is pending without a master account.** A merchant with no master account waited as
   `pending` with no reference, no attempt and version 1, which is the section 5 queued case.
3. **One live row per merchant and provider.** A second live row for the same pair was refused
   by `submerchant_provisions_live_key` while another merchant queued its own row at the same
   provider, and a second provider gave the first merchant a second, separate row.
4. **The provider must be able to do it.** A provider that does not create sub-merchants was
   refused with "does not create sub-merchants", a provider that is not in the catalogue with
   "does not exist in the catalogue", and an attempt at a disabled provider with "an attempt
   needs an enabled provider".
5. **The approval must be real.** Provisioning from a draft submission was refused with "only an
   approved KYC submission provisions a sub-merchant", and provisioning from another merchant's
   approval with "the KYC submission of this merchant does not exist".
6. **The row is checked field by field.** An attempt without a master account, a request instant
   after the row, a status outside the five, a mode outside `test` and `live`, a provider key
   outside the five, a sub-merchant identifier with a space, a master account reference with a
   space, a verified row without a provider identifier, an action required row with no detail, a
   flag before verification and a verified instant before the request were each refused by name.
7. **Verification enables and restriction disables.** The queued row took its master account,
   verified, and enabled both flags at version 2; a second row holding the same provider
   identifier was refused by `submerchant_provisions_provider_key`; going to `restricted` with a
   flag still on was refused with "a restricted sub-merchant cannot take money", and the same
   transition with both flags cleared was version 3.
8. **A closed row is history.** Rewriting a restricted row was refused with "a closed
   sub-merchant provisioning row is history", and reopening it with "a sub-merchant moves from
   pending to action required, verified or rejected, and a verified one only to restricted".
9. **Action required and rejection say why.** A pending row jumping to `restricted` was refused,
   a move to `action_required` stored its detail at version 2, and the move to `rejected`
   cleared the detail, stored its reason at version 3; a reason on a pending row was refused.
10. **A sync names a verified event.** A processed event of the same provider and merchant
    synced the row at version 2; an unverified event, another provider's event, another
    merchant's event, an event that does not exist and an instant with no event were each
  refused by name.
11. **The identity is frozen.** Changing the merchant, the approval, the provider, the mode or
    the request instant was refused with "keeps its merchant, its provider and its approval",
    and swapping or clearing the master account with "keeps the master account it was created
  under".
12. **Every index answers its screen.** The two partial unique keys, the queue index over
    `next_attempt_at` for `pending` rows and the office view over provider, status and request
    order were read from `pg_indexes.indexdef`.
13. **Row level security.** A plain role with grants saw no provisioning row, and its insert was
    refused (the shipped policy denies it; in practice the source guard also reads the provider
    catalogue, which the plain role may not read).
14. **Every guard is load bearing.** With `guard_source` dropped a draft submission was
    provisioned, with `guard_identity` dropped the request instant moved, with `guard_state`
    dropped a restricted row reopened with charges on, and with `guard_sync` dropped an
    unverified event synced the row; restoring the identity and state guards refused the same
  writes again.
15. **Rollback and re-apply.** The rollback of this STEP alone returned the schema to fifty
    three tables, fifty three policies, ninety five triggers and forty seven functions, the file
    applied again to fifty four and one hundred, and all fifty four rollbacks emptied the
  `public` schema.

## Verification
- `npm run check:migrations`: `migrations gate passed: 1677 checks, 54 migrations, 54 tables,
  every forward file transactional and default-deny`, exit 0.
- `npm run verify`: exit 0. Structure gate 16 directories, 13 root files and 68 source files;
  config gate 10 sections and 28 values; i18n gate 36 messages; logger gate 117 checks; error
  gate 196 checks; lint gate 77 checks; shell gate 98 checks; jobs gate 110 checks; the
  migrations gate above; then the TypeScript typecheck, the linter and the production build,
  which compiled successfully and prerendered the three routes.
- Gate probes: seven temporary edits were offered to the gate and all seven were caught - a
  missing `enable row level security`, a missing `commit;`, a default-deny policy reading
  `using (true)`, one writing `with check (true)`, an `id` without the shared UUID v7 default,
  and two removed required columns (`deleted_at` and `version`). The last two were caught only
  after the column parser was tightened in this STEP.
- Proof scripts: `/tmp/proof_029.py` (55 checks), `/tmp/detach_029.py` (6 checks) and
  `/tmp/rls_029.py` (3 checks), each ending with `PROOF COMPLETE: 0 FAIL`; the shape was read
  with `/tmp/measure_0292.py` rather than counted by hand.

## Errors Found And Corrected In This STEP
1. **The identity guard froze the one column a queued row has to gain.** `master_account_ref`
   was frozen with the rest of the identity, so a queued row could never take the platform
   account and could never be attempted, because the attempt check requires that reference. The
   guard now allows null to a value once and refuses every later change, and the proof carries
  both refusals.
2. **A submission cannot be submitted after it was written.** The KYC probe seeds first used a
   submit instant in the past, which `kyc_submissions_instant_order_check` refuses, because the
   row is written when the merchant submits. The seeds now write an explicit `created_at` before
   the submission, and the provisioning request sits between the decision and the row.
3. **A neighbouring guard pre-empted a check.** The attempt-without-a-master-account probe first
   named a disabled provider, so `guard_source` refused before the check could fire. That probe
   now runs on a merchant with no live row at an enabled provider, and the disabled-provider
   probe has its own reference.
4. **The sync fixtures did not match the row they synced.** The first event belonged to another
   merchant and the second to the wrong provider, so the guard refused the good case and the
   wrong refusal fired on the bad one. The events now carry the provider and the merchant of the
   row under test, and each refusal has its own fixture.
5. **The planned column count was one too high.** The design document promised 27 columns and
   the catalog measured 26; the breakdown now records the measured numbers and the handoff
   repeats them, which is why the shape is measured rather than trusted.
6. **The gate read a constraint body as columns.** A removed `deleted_at` passed the gate
   because the wrapped body of `submerchant_provisions_deleted_check` starts a line with the
   word `deleted_at`. The parser now accepts a column only where a name is followed by a type,
   and both removed-column probes are caught.

## Decisions And Limits Left For Later STEPs
1. **The call itself is not in the database.** `master_account_ref`, `attempted_at`,
   `attempt_count` and `next_attempt_at` are the row a job reads; the HTTP call, the retry
   policy and the provider adapters belong to STEP 147 onwards, and no adapter exists yet.
2. **The office alert is a job over the queue index.** Section 5's alert when nothing is
   connected reads `submerchant_provisions_queue_idx`; this STEP records the queued row and the
   reason it is queued, and the notification is a code STEP.
3. **The webhook handler writes the sync.** This STEP refuses a sync that is not a processed,
   signed event of the same provider; the handler that finds it, writes it and moves the status
   is a code STEP.
4. **The permissive policies are STEP 035's job.** The table is default-deny, so nobody reads it
   yet, and the merchant-facing view of its own provisioning is a policy of that STEP.
5. **Seven year retention is later.** Section 13 keeps sub-merchant records for seven years;
   this STEP adds no retention column and no job, and the soft delete marker is what such a job
  reads.
6. **No audit-log write in this STEP.** A provisioning attempt is written to `audit_logs` by the
   service that performs it, not by a trigger here.

## Next Chat Notes
1. Next is STEP 030 - Migration for card blacklist and velocity counters tables. The card
   blacklist and the velocity counters have nothing to link to this table; keep them free of
   invented columns and read section 4 and section 6 of the feature list first.
2. Keep the sub-steps and the approval between them, and ask the owner before starting.
3. Measure the shape with a script before writing the handoff numbers; this STEP was one column
   off in its own planning document.
4. `npm run check:migrations` is stricter than it was for `0001` to `0053`: a policy body
   written as `using (true)` or a table missing a required column now fails the gate, so run it
   after any edit to an older migration.
