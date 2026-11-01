// path: docs/handoffs/STEP_035_COMPLETED.md
# STEP 035 Completed - Handoff

## STEP
- Number and title: STEP 035 - RLS policies for office roles and audit log immutability
- Category: Database Schema and Row Level Security (STEP 012-036)
- Depends on (earlier STEPs in this category and their handoff files): STEP 004
  (`role_assignments`, the seven role vocabulary), STEP 005 (`office_permissions`, the delegated
  permissions), STEP 013 (`audit_logs` and its append-only trigger), STEP 010 and 022 (the
  session and device tables), STEP 020 and 021 (the merchant API and store connections), STEP
  023 to 027 (the platform book and its keys), STEP 032 (the last content tables) and STEP 033
  to 034 (the actor helpers and the tenant layers this STEP completes). The plan for this STEP
  is `docs/planning/STEP_035_SUBSTEP_BREAKDOWN.md`; the owner split it into six sub-steps with
  an approval between each.

## Files
- Created:
  - migrations/0072_actor_roles.sql and its `.down.sql` - the two role helpers, in a file that
    creates no table.
  - migrations/0073_office_and_secret_policies.sql and its `.down.sql` - 33 policies and 3
    indexes.
  - migrations/0074_platform_and_audit_policies.sql and its `.down.sql` - 36 policies and 1
    index.
  - docs/planning/STEP_035_SUBSTEP_BREAKDOWN.md and docs/handoffs/STEP_035_COMPLETED.md.
- Modified:
  - migrations/README.md - three inventory rows (`0072` to `0074`), one new rule (an office role
    is read from `role_assignments`, never from a claim) and the numbering rule moved from 52 to
    54; the introduction now counts seventy four files.
  - README.md - one database bullet describing the role reader, the seven roles and the audit
    rule, directly above the STEP 034 bullet.
- Owned paths touched (must match the File Ownership Rules in STEP_PLAN_250.md): numbered
  migration files in `migrations/`, the migrations index, the handoff and planning folders, and
  the database section of the root `README.md`. Not touched: migrations `0001` to `0071`, every
  `lib/`, `app/` and `services/` file, `config/`, `.env.example`, `package.json`,
  `package-lock.json` and `migrations/verify.ts`.

## Database
- Migrations added (file names): `0072_actor_roles.sql`, `0073_office_and_secret_policies.sql`
  and `0074_platform_and_audit_policies.sql`, three forward files and three rollbacks. None
  creates a table. The schema now holds 74 migrations, 67 tables, 175 policies, 69 functions,
  289 indexes and 126 triggers in `public`.
- `0072` creates `public.current_actor_roles()` (`sql`, `stable`, `security definer`,
  `search_path = ''`), which returns the distinct live roles of `public.current_actor_id()`, and
  `public.current_actor_has_role(role_name text)`, which is array membership as a boolean. Live
  means `revoked_at is null`, `deleted_at is null`, `granted_at <= now()` on the assignment and
  an `active`, undeleted person. A revoked, future or suspended assignment reads as no role.
- `0073` covers the office, the person and the merchant's own credentials: 33 policies over
  `role_assignments`, `office_permissions`, `delegations`, `announcements`,
  `announcement_dismissals`, `sessions`, `device_proof_keys`, `login_attempts`, `account_locks`,
  `provider_keys`, `merchant_api_credentials`, `store_connections` and `taxcloud_connections`.
  Each carries `<table>_super_admin_all`; the person reads its own row; `delegations` adds the
  delegator and the delegate; `announcements` adds one audience policy requiring a published,
  unexpired row and filtering `all`, `owners` and `office`; `sessions` adds a self update whose
  `with check` requires `revoked_at`; and the three credential and connection tables add the
  merchant's read, a live insert and a revoke-only update, with the tax connection writable only
  while unverified.
- `0074` covers the platform book, the configuration, the content, the machinery and the audit
  chain: 36 policies over 18 tables. `finance_ops` writes `company_transactions` and
  `processor_bills` and reads `webhook_events`; `compliance_kyc` writes `compliance_items` and
  `card_blacklist` and reads `idempotency_keys` and `velocity_counters`; `ceo` reads those four
  groups; `plans`, `pricing_versions`, `payment_providers` and `routing_rules` are read by `ceo`
  and `finance_ops` and written by `super_admin`; `plan_entitlements` and `email_send_logs` add
  the merchant's own read; `cms_pages` and `blog_posts` belong to `blogger` and a published row
  is readable by `ceo` and `support`; `email_settings` and `email_templates` stay with
  `super_admin`.
- `audit_logs` gains two select policies and no write policy at all: `super_admin`, `ceo` and
  `compliance_kyc` read every row, and a merchant reads the rows of its own company, which is
  what answers "who changed my bank account". The deny policy refuses what these do not grant,
  and `audit_logs_append_only` refuses every update and every removal for every role including
  the owner of the table. After this STEP 66 of the 67 tables answer a caller, and `job_queue`
  is the one table that answers nobody because the service works it.
- Four plain indexes were added where the only index was the primary key:
  `merchant_api_credentials_tenant_idx`, `store_connections_tenant_idx`,
  `taxcloud_connections_tenant_idx` and `plan_entitlements_tenant_idx`, each on `(company_id)`.
  The nine tables whose policy repeats the predicate of an existing partial index were given
  none.
- Rollback verified on clean database (yes/no, how): **yes**, on PostgreSQL 16.2. The three
  rollbacks in descending order returned the schema to 106 policies, 285 indexes, 67 functions
  and 67 tables, and applying `0072`, `0073` and `0074` again returned 175 policies, 289 indexes
  and 69 functions, with the roles answering again. The full chain of 74 forward files and 74
  rollbacks ran on a fresh database and left 0 tables, 0 policies, 0 triggers and 0 functions in
  `public`.

## Environment
- Environment variables added to .env.example: none. The policies read the request setting and
  the tables of STEP 004 and 005, and no variable.
- Secrets handled (names only, never values): none. The fixture wrote synthetic ciphertext for
  one API credential and synthetic audit rows signed with a placeholder, and no real key,
  signature or credential was written anywhere.

## Packages
- Package requests for the integrator (name, reason), or none: none.

## Behaviour Proof (acceptance checklist)
One proof script ran against the local PostgreSQL 16.2 and asserted 57 checks; all 57 passed.
Every request after the fixture was spoken by `proof_app`, a role that is `nologin`, has no
`bypassrls` and holds only schema usage and table grants.

1. **The role reader.** An office person read its one role, the merchant read `owner`, and a
   suspended person and an anonymous caller read an empty array.
2. **The office rows.** A person read its own assignment and its own delegated permission and no
   other person's, `super_admin` read all nine assignments, and the merchant read no office row.
3. **The announcement audience.** A merchant read the `all` and `owners` announcements, `ceo`
   read the `all` and `office` ones, a draft was invisible to both, `super_admin` read all four,
   and a person dismissed an announcement for itself while being refused when it named another
   person.
4. **The platform and content.** `ceo`, `finance_ops` and `super_admin` read a plan while
   `support`, `blogger` and the merchant read none, and the merchant could not insert one; the
   merchant read its own entitlement and the other merchant read none; `blogger` created a page,
   `ceo` and `support` read the published one, `blogger` alone read the draft, and `finance_ops`
   and the merchant read neither.
5. **The audit chain, read scope.** `super_admin`, `ceo` and `compliance_kyc` read all three
   rows, `finance_ops`, `support`, `blogger` and the anonymous caller read none, the merchant
   read its own company's two rows and the other merchant read none.
6. **The audit chain, immutability.** The owner of the table was refused an update and a delete
   with "public.audit_logs is append-only", an office session was refused the same two
   operations by row level security with zero rows affected, and the catalog showed that the
   only write policy on the table is the deny itself.
7. **The merchant credential.** The merchant read its own credential and the other merchant
   none; it inserted a live one and was refused an already revoked one; it revoked its own with
   a reason, was refused a revoke without one by the table check, was refused an update that
   would have left the row live, and the other merchant's revoke touched zero rows.
8. **The catalogs.** 108 policies beside the deny, every one permissive and addressed to
   `public`, `job_queue` still deny only, all 67 deny policies unchanged, the four tenant
   indexes present, and the counts 67 tables, 175 policies, 69 functions, 289 indexes and 126
   triggers.
9. **The rollback and the second apply.** The counts recorded under Database, and the role
   reader answering again at the end.

## Verification
- `npm run check:migrations`: `migrations gate passed: 2220 checks, 74 migrations, 67 tables,
  every forward file transactional and default-deny`, exit 0.
- `npm run verify`: exit 0, with the structure, config, i18n, logger, error, lint, shell, jobs
  and migrations gates passing, followed by the TypeScript typecheck, the linter and the
  production build.
- The full forward and reverse chain of all 74 migrations was run on a clean database before the
  commit, and the gate was run after each of the three files was written.

## Next
- Next STEP number: STEP 036 - the next database STEP in this category.
- Anything the next chat must know: the policy layer is complete. 66 tables answer a caller,
  `job_queue` answers nobody by design, and `audit_logs` answers reads only. Four helpers now
  exist and are the only place a request is identified: `current_actor_id()`,
  `current_actor_company_id()`, `current_actor_roles()` and `current_actor_has_role(text)`.
  Every policy is `to public`, so STEP 036 and 037 add no role object and no `force row level
  security`; the owner of a table still migrates, runs the queue and posts the ledger. A future
  STEP that widens a policy must keep the two rules of `migrations/README.md` 53: the role comes
  from `role_assignments`, and `audit_logs` never gains a write policy.
