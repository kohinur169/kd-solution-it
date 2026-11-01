// path: docs/handoffs/STEP_034_COMPLETED.md
# STEP 034 Completed - Handoff

## STEP
- Number and title: STEP 034 - RLS default-deny policies for payment and ledger tables batch two
- Category: Database Schema and Row Level Security (STEP 012-036)
- Depends on (earlier STEPs in this category and their handoff files): STEP 019 (the
  subscription and its charges), STEP 023 to STEP 027 (the payment, ledger, settlement, hold,
  reserve, payout and bank tables), STEP 030 (velocity counters, not taken here), STEP 033 (the
  actor functions of `0069` and the policy shape of `0070`) and STEP 003 (`users`, the row the
  requester is read from). The plan for this STEP is
  `docs/planning/STEP_034_SUBSTEP_BREAKDOWN.md`; the owner split it into four sub-steps with an
  approval between each.

## Files
- Created:
  - migrations/0071_payment_ledger_policies.sql and its `.down.sql` - 17 policies and 10
    indexes, in a file that creates no table.
  - docs/planning/STEP_034_SUBSTEP_BREAKDOWN.md and docs/handoffs/STEP_034_COMPLETED.md.
- Modified:
  - migrations/README.md - one inventory row (`0071`), one new rule (a money row is read by its
    merchant and written by the service) and the numbering rule moved from 51 to 52; the
    introduction now counts seventy one files.
  - README.md - one database bullet describing the per-command grants and the ten indexes,
    directly above the STEP 033 bullet.
- Owned paths touched (must match the File Ownership Rules in STEP_PLAN_250.md): numbered
  migration files in `migrations/`, the migrations index, the handoff and planning folders, and
  the database section of the root `README.md`. Not touched: migrations `0001` to `0070`, every
  `lib/`, `app/` and `services/` file, `config/`, `.env.example`, `package.json`,
  `package-lock.json` and `migrations/verify.ts`, which needed no change.

## Database
- Migrations added (file names): `0071_payment_ledger_policies.sql` and its rollback. The file
  creates no table. The schema now holds 71 migrations, 67 tables, 106 policies, 67 functions,
  285 indexes and 126 triggers in `public`.
- The 13 tables of batch two, and what each grants a merchant session: `payments`,
  `ledger_accounts`, `ledger_entries`, `settlements`, `holds`, `reserves`, `payouts`,
  `subscriptions` and `subscription_charges` grant `select` only; `refunds` grants `select` and
  an `insert` pinned to `status = 'requested'` and `requested_by = current_actor_id()`;
  `payout_bank_accounts` grants `select` and an `insert` pinned to `status = 'pending'` with no
  verifier; `bank_change_requests` grants `select` and an `insert` pinned to `status =
  'requested'`, the actor as requester, no verifier and no cooling instant; `disputes` grants
  `select` and one `update` whose `using` accepts only a row that is `open` or `under_review`
  and whose `with check` also refuses a submission or resolution instant.
- No update and no delete is granted on the other twelve tables, so RLS itself answers a
  merchant session that tries to edit a payment or remove a ledger entry, and the append-only
  guard of `ledger_entries` keeps its own message for the service. No policy names a role and
  none is `for all`: every one is `as permissive` and `to public`, beside the
  `<table>_default_deny` policy that every file since `0012` installs and that this STEP does
  not touch.
- The platform's own chart of accounts lives in `ledger_accounts` with a null `company_id`; a
  null never equals a company, so those rows are invisible to every merchant without a second
  predicate, while the owner still reads them.
- Ten indexes were added because the tenant predicate needs them: `refunds_tenant_idx`,
  `ledger_accounts_tenant_idx`, `settlements_tenant_idx`, `holds_tenant_idx`,
  `reserves_tenant_idx`, `payouts_tenant_idx`, `payout_bank_accounts_tenant_idx`,
  `bank_change_requests_tenant_idx`, `subscriptions_tenant_idx` and
  `subscription_charges_tenant_idx`, each plain on `(company_id)`. The existing indexes of these
  tables are partial and keyed on a status or on `deleted_at is null`, which a bare
  `company_id = $1` cannot use. `payments`, `disputes` and `ledger_entries` already had a usable
  index and got none. The names use `_tenant_idx` because `subscription_charges_company_idx`
  already existed.
- Rollback verified on clean database (yes/no, how): **yes**, on PostgreSQL 16.2. The `0071`
  rollback returned the schema to 89 policies and 275 indexes, the merchant then read zero
  payments, and applying the file again returned 106 policies and 285 indexes with the payment
  visible again. The full chain of 71 forward files and 71 rollbacks ran on a fresh database and
  left 0 tables, 0 policies, 0 triggers and 0 functions in `public`.

## Environment
- Environment variables added to .env.example: none. The policies read the request settings of
  `0069` and no variable.
- Secrets handled (names only, never values): none. The fixture wrote synthetic companies,
  people, payments, a synthetic bank account ciphertext and synthetic ledger rows in a throwaway
  local database, and no real credential or account number was written anywhere.

## Packages
- Package requests for the integrator (name, reason), or none: none.

## Behaviour Proof (acceptance checklist)
One proof script ran against the local PostgreSQL 16.2 and asserted 47 checks; all 47 passed.
Every request after the fixture was spoken by `proof_app`, a role that is `nologin`, has no
`bypassrls` and holds only schema usage and table grants.

1. **The fixture.** Two companies, three people (one suspended), one processor, one plan, two
   payments, four merchant ledger accounts plus one platform account, two balanced ledger pairs,
   two settlements, two holds, two reserves, two payouts, two bank accounts, two bank change
   requests, two subscriptions, two subscription charges, three disputes and two refunds, all
   written by the owner before the policies were exercised.
2. **Read isolation per table.** Each of the 13 tables answered for its own company and for the
   other merchant exactly its own count; a foreign payment asked for by its id returned zero
   rows; the platform ledger account was invisible to both merchants and visible to the owner; a
   suspended person and an anonymous caller read zero rows.
3. **The granted inserts.** A merchant inserted a `requested` refund and a `pending` bank
   account. It was refused an `approved` refund, a refund naming another person as requester, a
   bank account that is already `active` and a change that is already `cooling`, each with "new
   row violates row-level security policy".
4. **The dispute update.** A merchant wrote the response of its own open dispute; the same
   update carrying `submitted_at` and the `evidence_submitted` status was refused by `with
   check`; an update of a resolved dispute touched zero rows, and another merchant touched zero
   rows of the first one's dispute.
5. **Nothing else is granted.** An update of a payment, a settlement, a payout or a bank account
   and a delete of a payment, a ledger entry, a refund or a hold each affected zero rows, and
   the rows were still there afterwards; an insert of a payment was refused outright.
6. **The service still writes.** The owner posted a balanced ledger pair after the policies
   existed and it committed, the same role was refused a delete of that group by the append-only
   guard ("ledger entries are append only"), and the service settled a batch.
7. **The catalog.** 17 policies over the 13 tables, being 13 selects, 3 inserts and 1 update, no
   delete policy anywhere, all 67 deny policies still `using (false)` and `with check (false)`,
   an index a bare `company_id = $1` can use for every one of the 13, and the ten new
   definitions on `(company_id)`.
8. **Rollback and second apply.** The counts recorded under Database, and the merchant saw its
   payment again at the end.
9. **Two observations recorded, not changed.** A refund that names another company's payment is
   refused by the guard of `0038` with "a refund names a payment that exists" rather than by the
   policy, because the payment is invisible to the caller and the lookup fails closed, which is
   the shape STEP 032 proved for the ticket opener. A second open bank change request is refused
   by `bank_change_requests_open_key`, the table's own rule, before the policy is asked.

## Verification
- `npm run check:migrations`: `migrations gate passed: 2160 checks, 71 migrations, 67 tables,
  every forward file transactional and default-deny`, exit 0.
- `npm run verify`: exit 0, with the structure, config, i18n, logger, error, lint, shell, jobs
  and migrations gates passing, followed by the TypeScript typecheck, the linter and the
  production build.
- The full forward and reverse chain of all 71 migrations was run on a clean database before the
  commit, and the gate was run after each of the two files was written.

## Next
- Next STEP number: STEP 035 - RLS policies for office roles and audit log immutability.
- Anything the next chat must know: 32 tables still carry the deny alone and they are the ones
  STEP 035 takes: the office tables (`office_permissions`, `role_assignments`, `delegations`,
  `announcements`, `announcement_dismissals`), the per-person tables (`sessions`,
  `device_proof_keys`, `login_attempts`, `account_locks`), the secret holding tables
  (`provider_keys`, `merchant_api_credentials`, `store_connections`, `taxcloud_connections`),
  the platform configuration and book (`plans`, `pricing_versions`, `plan_entitlements`,
  `payment_providers`, `routing_rules`, `card_blacklist`, `company_transactions`,
  `processor_bills`, `compliance_items`), the content tables (`email_settings`,
  `email_templates`, `email_send_logs`, `cms_pages`, `blog_posts`), the payment machinery a
  merchant never reads (`idempotency_keys`, `webhook_events`, `velocity_counters`), `audit_logs`
  and `job_queue`. The two helpers of `0069` are still the only place a request is identified,
  and the `_tenant_idx` naming convention is available if a role policy needs an index a bare
  predicate can use.
