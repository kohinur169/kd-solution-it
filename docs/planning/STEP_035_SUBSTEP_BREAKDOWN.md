// path: docs/planning/STEP_035_SUBSTEP_BREAKDOWN.md
# STEP 035 - Sub-Step Breakdown

This document is sub-step 035.1. It reads the plan, the feature list, the master prompt and the
STEP 034 handoff, measures the 32 tables still on the deny alone, fixes what an office role is
allowed to see, fixes what audit log immutability means now that the guard exists, and then
stops for the owner's permission before any SQL is written. The proof belongs in
`docs/handoffs/STEP_035_COMPLETED.md`.

## 1. Scope Confirmed From The Source Documents

### STEP 035 as written in docs/final/STEP_PLAN_250.md
- Title: "RLS policies for office roles and audit log immutability".
- Category: Database Schema and Row Level Security (STEP 012-036). A database STEP owns only its
  numbered migration files and the migrations index; no `lib/`, `app/` or `services/` file.
- Neighbours: STEP 033 gave the merchant its own record, STEP 034 gave it the money, this STEP
  gives the office its rows and closes the layer, and STEP 036 and 037 build on the finished
  policy set. STEP 004 created `role_assignments`, STEP 005 `office_permissions`, STEP 013
  `audit_logs` with its chain trigger.
- The plan's own sub-steps 4 to 7 (service, API, UI, security review) do not apply to a policy
  STEP: there is no surface to build, and the security review is the proof itself.

### The rules that fix the shape
- FEATURE_LIST section 2 names the seven roles and their work: `super_admin` (full control,
  delegates permissions), `ceo` (approvals, KYC final approval, large action confirmation),
  `compliance_kyc` (KYC, underwriting, manual payment review, disputes, SAR, sanctions),
  `finance_ops` (reconciliation, failed payouts, settlement release, processor bills), `support`
  (tickets and merchant help, "no gateway key access and no KYC approval"), `blogger` (blog and
  public content, "no merchant, payment or KYC data"), `owner` (the merchant).
- `migrations/README.md` rule 8: the deny stays and a permissive policy is added beside it. Rule
  49: a tenant policy reads `public.current_actor_company_id()`. Rule 50: the actor is
  identified only by the functions of `0069`. Rule 51: a money row is read by its merchant and
  written by the service. Rule 9: no migration creates an extension, a role or a schema, so an
  office role cannot arrive as a Postgres role and must be read from a table.
- `role_assignments_role_check` closes the seven names; `role_assignments_owner_scope_check`
  requires a `company_id` for `owner` and forbids one for the other six, so the office is
  platform-wide by construction and the merchant is company-wide.
- STEP 013 already refuses every update and every delete on `audit_logs` with
  `audit_logs_append_only` ("public.audit_logs is append-only") for every role including the
  owner of the table, so immutability is a property to prove and to keep, not to invent.

### What exists today (measured before writing this document)
- 71 migrations, 67 tables, 106 policies, 67 functions, 285 indexes, 126 triggers.
- 32 tables still carry the deny alone, and they are the office tables
  (`role_assignments`, `office_permissions`, `delegations`, `announcements`,
  `announcement_dismissals`), the per-person tables (`sessions`, `device_proof_keys`,
  `login_attempts`, `account_locks`), the secret and connection tables (`provider_keys`,
  `merchant_api_credentials`, `store_connections`, `taxcloud_connections`), the platform
  configuration and book (`plans`, `pricing_versions`, `plan_entitlements`, `payment_providers`,
  `routing_rules`, `card_blacklist`, `company_transactions`, `processor_bills`,
  `compliance_items`), the content and email tables (`email_settings`, `email_templates`,
  `email_send_logs`, `cms_pages`, `blog_posts`), the payment machinery (`idempotency_keys`,
  `webhook_events`, `velocity_counters`), `audit_logs` and `job_queue`.
- Nine of the 32 already carry a partial index whose predicate is exactly the row set the policy
  will read: `role_assignments` on `(user_id, role)`, `office_permissions` on `(user_id)`,
  `delegations` on `(delegate_user_id, ends_at)`, `sessions` on `(user_id, revoked_at)`,
  `device_proof_keys` on `(user_id)`, `login_attempts` on `(user_id, created_at)`,
  `account_locks` on `(user_id)`, `announcement_dismissals` on `(user_id, announcement_id)` and
  `audit_logs` on `(actor_user_id, created_at)` and `(company_id, created_at)`, each with
  `revoked_at`/`deleted_at` in its predicate. A policy that repeats those conditions can use
  them; one that does not, cannot.
- Four tables carry no index a policy could use for its own predicate:
  `merchant_api_credentials`, `store_connections`, `taxcloud_connections` and
  `plan_entitlements`. They are the four a merchant reads about itself, and each gets a plain
  `(company_id)` index in this STEP.

## 2. Decisions This STEP Makes

1. **A role is read from `role_assignments`, never from a claim.** `current_actor_roles()` is
   added: `stable`, `security definer`, `search_path = ''`, returning the array of live roles of
   `public.current_actor_id()`, where live means `revoked_at is null`, `deleted_at is null` and
   `granted_at <= now()`. `current_actor_has_role(text)` is the boolean form the policies read.
   The definer elevation is required for the same reason as `0069`: `role_assignments` itself is
   deny-only until this file grants it, and a policy that asks itself the question recurses.
2. **A permission is not a role and policies do not read `office_permissions`.** Section 2 says
   super_admin "delegates permissions to office roles", and STEP 005 owns what a permission
   means. A policy that read a permission string would put a naming convention into the
   database; the policies ask "is this person an office role of this name", and the application
   asks whether the person holds the permission for the screen. `office_permissions` is granted
   only to the people who may see their own delegations and to super_admin.
3. **Office tables are for the office, not for the merchant.** `role_assignments`,
   `office_permissions` and `delegations` get a select for the person's own rows and for
   `super_admin`, an insert and an update for `super_admin` alone, and `delegations` also grants
   the delegate and the delegator their own read. A merchant reads nothing of its own role row:
   `users` already carries `company_id`, and the merchant's identity is that column.
4. **Per-person tables are self-only.** `sessions`, `device_proof_keys` and `account_locks`
   grant the person its own rows, `login_attempts` grants the person its own attempts, and
   `super_admin` reads all four for support and security work. Writes stay with the service,
   which creates a session, rotates a token, records an attempt and locks an account; a browser
   session may end its own session (`sessions` update to `revoked_at`) and nothing else.
5. **The secret and connection tables belong to their merchant, and the plaintext does not
   exist.** `merchant_api_credentials`, `store_connections` and `taxcloud_connections` are the
   three rows section 20 has a merchant create, revoke and regenerate, so each gets a tenant
   select, insert and update pinned to the owner's company; `provider_keys` is the platform's
   own key material and grants `super_admin` only. No column of any of them holds a plaintext
   secret, which STEP 023 and STEP 027 already established and this STEP does not change.
6. **The platform book is read by the role that works it.** `company_transactions` and
   `processor_bills` grant `finance_ops`, `ceo` and `super_admin`; `compliance_items` and
   `card_blacklist` grant `compliance_kyc`, `ceo` and `super_admin`; `plans`,
   `pricing_versions`, `payment_providers` and `routing_rules` are configuration and grant
   `super_admin` write with `ceo` and `finance_ops` read. `plan_entitlements` is the merchant's
   own subscription content, so it grants the owner its own rows and `super_admin` everything.
7. **Content is the blogger's row and nobody else's.** `cms_pages` and `blog_posts` grant
   `blogger` and `super_admin` select, insert and update; the marketing roles `ceo` and
   `support` read published rows only. No anonymous policy is created: the public site is
   rendered by the server, which reaches these tables as the owner, so an anonymous `to public`
   grant would widen the surface without a feature behind it.
8. **The email settings stay with super_admin and support gets no credential.**
   `email_settings`, `email_templates` grant `super_admin` select, insert and update;
   `email_send_logs` grants `super_admin` select and the merchant its own merchant rows, because
   a merchant is told when an email failed. Section 2's "no gateway key access" for support is
   the rule that keeps the three tables out of a support policy.
9. **`audit_logs` is append-only and readable only by the office roles that answer for it.** It
   grants select to `super_admin`, `ceo` and `compliance_kyc`, and the merchant its own
   company's rows, because section 2 says every permission grant, change and use is audited and
   a merchant asking "who changed my bank account" is answered from this table. It grants no
   insert: rows arrive from the audit function of STEP 013 and from the service. It grants no
   update and no delete, so `<table>_default_deny` and the existing `audit_logs_append_only`
   trigger both refuse, and the proof shows the trigger's message to the owner of the table.
10. **`job_queue` and the payment machinery stay denied.** `job_queue` is worked by the service
    and has no reader among the seven roles. `idempotency_keys`, `webhook_events` and
    `velocity_counters` are the platform's own bookkeeping; `finance_ops` gets a read of
    `webhook_events` for reconciliation work and `compliance_kyc` a read of `velocity_counters`,
    and neither grants a merchant anything.
11. **No role object, no `force row level security`, no new setting.** Every policy is
    `as permissive` and `to public` with the role test inside `using`, because rule 9 forbids
    creating a role and the owner of the table must still migrate and run the jobs.
12. **Four indexes are added** for the tables a merchant reads about itself and which carry no
   usable index: `merchant_api_credentials`, `store_connections`, `taxcloud_connections` and
   `plan_entitlements`, each `<table>_tenant_idx` on `(company_id)`. The nine tables that
   already carry a partial index for the row set their policy reads get none.

## 3. The Policies This STEP Produces

| Table | Who reads | Who writes |
| --- | --- | --- |
| role_assignments | self, super_admin | super_admin insert, update |
| office_permissions | self, super_admin | super_admin insert, update |
| delegations | delegate, delegator, super_admin | super_admin insert, update |
| announcements | all seven roles, published rows for the office | super_admin insert, update |
| announcement_dismissals | self | self insert |
| sessions | self, super_admin | self update (revoke), service insert |
| device_proof_keys | self, super_admin | service only |
| login_attempts | self, super_admin | service only |
| account_locks | self, super_admin | service only |
| provider_keys | super_admin | super_admin |
| merchant_api_credentials | owner company, super_admin | owner insert and update |
| store_connections | owner company, super_admin | owner insert and update |
| taxcloud_connections | owner company, super_admin | owner insert and update |
| plans, pricing_versions | ceo, finance_ops, super_admin | super_admin |
| plan_entitlements | owner company, super_admin | super_admin |
| payment_providers, routing_rules | ceo, finance_ops, super_admin | super_admin |
| company_transactions, processor_bills | finance_ops, ceo, super_admin | finance_ops, super_admin |
| compliance_items, card_blacklist | compliance_kyc, ceo, super_admin | compliance_kyc, super_admin |
| cms_pages, blog_posts | blogger, super_admin, published for ceo and support | blogger, super_admin |
| email_settings, email_templates | super_admin | super_admin |
| email_send_logs | super_admin, merchant own rows | service only |
| idempotency_keys, velocity_counters | compliance_kyc, super_admin | service only |
| webhook_events | finance_ops, super_admin | service only |
| audit_logs | super_admin, ceo, compliance_kyc, merchant own company | none (append-only) |
| job_queue | none | service only |

Every number in the handoff is measured; the file is expected to hold in the order of 45
  policies and to move the schema from 106 policies and 285 indexes to roughly 150 policies and
  289 indexes, which 035.4 records exactly.

## 4. The Sub-Steps

1. **035.1 The breakdown.** This document: the scope, the eight groups of the 32 tables, the
   role model, the audit rule, the four indexes and the risks. Stops for permission.
2. **035.2 The role helpers.** `0072_actor_roles.sql` and its rollback: `current_actor_roles()`
   and `current_actor_has_role(text)`, with a comment each, and the gate after the file.
3. **035.3 The office, per-person and secret policies.** `0073_office_and_secret_policies.sql`
   and its rollback: the first thirteen tables of section 3, plus the four indexes.
4. **035.4 The platform, content and audit policies.** `0074_platform_and_audit_policies.sql`
   and its rollback: the remaining nineteen tables, `audit_logs` among them.
5. **035.5 The proof.** Seven roles, a merchant, a suspended person and an anonymous caller; who
   reads what on every table; the audit log refusing every write; the merchant reading its own
   audit rows and nothing else; the rollback and the second apply.
6. **035.6 The documents and the commit.** Two rows and one rule in `migrations/README.md`, the
   root `README.md` bullet, the whole 74 file forward and reverse chain, `npm run verify`, one
   commit and one handoff.

## 5. Files This STEP Owns

- `migrations/0072_actor_roles.sql`, `0073_office_and_secret_policies.sql`,
  `0074_platform_and_audit_policies.sql`, each with its `.down.sql`.
- `migrations/README.md` (three inventory rows, one new rule, the numbering rule moved).
- `docs/planning/STEP_035_SUBSTEP_BREAKDOWN.md`, `docs/handoffs/STEP_035_COMPLETED.md`.
- The database section of the root `README.md`, one bullet.
- Not touched: `0001` to `0071`, `lib/`, `app/`, `services/`, `config/`, `package.json`,
  `.env.example` and `migrations/verify.ts`.

## 6. What This STEP Deliberately Leaves Out

1. **What a permission string means.** `office_permissions` stores a delegated permission; which
   screen and which button it opens is STEP 005's model and the application's job.
2. **Column level secrecy.** `provider_keys` and the three connection tables store ciphertext;
   hiding the ciphertext column from `support` is done by never granting support a policy, not
   by a column rule.
3. **A policy for `job_queue`.** It is worked by the service and read by nobody.
4. **Anonymous access to the public pages.** The site is server-rendered and reaches the tables
   as the owner; an anonymous policy would be a surface with no feature behind it.
5. **The audit chain itself.** STEP 013 computes `prev_hash`, `hash` and `signature`; this STEP
   only proves that the chain stays append-only for every role.
6. **The code that sets the setting and the roles.** STEP 037 builds the Supabase client and the
   typed session access; the roles are granted by the office screens, not here.
7. **`CONCURRENTLY` for the four indexes.** The schema is still built forward from `0001`; a
   live table would need `create index concurrently` outside the migration transaction.

## 7. Risks To Prove In 035.2 To 035.5

1. **A definer helper over a deny-only table.** `current_actor_roles()` must read
   `role_assignments` as the owner and must not recurse when the `role_assignments` policy is
   the one asking; the proof calls it as a role with no assignment and expects an empty array,
   not an error.
2. **A revoked or future assignment.** A revoked assignment, a soft deleted one and one granted
   with a future `granted_at` must all read as no role, which is the three conditions the helper
   states.
3. **A merchant must not borrow an office role.** An owner with a company must read nothing of
   the office tables, and the `support` and `blogger` roles must read nothing of the merchant
   data, which is the sentence section 2 states twice.
4. **The audit log refuses everybody.** An update and a delete of an `audit_logs` row are
   refused for the table owner by the existing trigger, and no policy in this STEP grants
   either, so the proof shows both gates.
5. **A policy that cannot use its index.** The nine tables whose policy repeats the predicate of
   an existing partial index are checked against `pg_index`, and the four new indexes are
   asserted to be plain `(company_id)`.
6. **The counts.** Every number in the handoff is measured from the catalog in 035.6, never
   predicted from this document.

## 8. The Role Helpers Of 035.2

1. **`0072_actor_roles.sql`** creates `public.current_actor_roles()` (`sql`, `stable`, `security
   definer`, `search_path = ''`) and `public.current_actor_has_role(role_name text)`, with a
   comment on each. The array is the distinct live roles of `public.current_actor_id()`, where
   live means `revoked_at is null`, `deleted_at is null`, `granted_at <= now()` and a person who
   is still `active` and not soft deleted. The boolean is array membership, so a policy reads
   one line.
2. **The measurement and the smoke test.** The gate passed with 2180 checks over 72 migrations.
   A person holding `finance_ops`, `owner` and `support` read all three roles and
   `has_role('finance_ops')` was true while `has_role('ceo')` was false; a revoked assignment, a
   future `granted_at`, a suspended person and an anonymous caller each read an empty array and
   false, with no error.

## 9. The Two Policy Files Of 035.3 And 035.4

1. **`0073_office_and_secret_policies.sql`** adds 33 policies over 13 tables: the five office
   tables, the four per-person tables and the four credential and connection tables. Each table
   carries `<table>_super_admin_all`; `role_assignments`, `office_permissions`,
   `announcement_dismissals`, `sessions`, `device_proof_keys`, `login_attempts` and
   `account_locks` add the person's own read; `delegations` adds the delegator and the delegate;
   `announcements` adds one audience policy that requires a published, unexpired row and filters
   `all`, `owners` and `office`; `sessions` adds a self update whose `with check` requires
   `revoked_at`, so a session cannot be kept alive by its own owner; and the three connection
   tables add the merchant's read, an insert pinned to the state only a merchant may claim, and
   a revoke-only update (a tax connection may only change while it is unverified).
2. **The indexes moved with their tables.** The plan gave 035.3 four indexes; three of them
   belong to the credential tables of this file and the fourth, `plan_entitlements`, belongs to
   the platform file, so each file carries its own. The gate passed with 2200 checks over 73
   migrations, and the catalog read 67 tables, 139 policies, 69 functions, 288 indexes and 126
   triggers, with 46 policies over those 13 tables, being 33 new and 13 deny.
3. **`0074_platform_and_audit_policies.sql`** adds 36 policies over 18 tables and closes the
   layer. `super_admin` keeps full control of the platform book; `finance_ops` writes
   `company_transactions` and `processor_bills` and reads `webhook_events`; `compliance_kyc`
   writes `compliance_items` and `card_blacklist` and reads `idempotency_keys` and
   `velocity_counters`; `ceo` reads those four groups; `plans`, `pricing_versions`,
   `payment_providers` and `routing_rules` are read by `ceo` and `finance_ops` and written by
   `super_admin`; `plan_entitlements` and `email_send_logs` add the merchant's own read;
   `cms_pages` and `blog_posts` belong to `blogger` and a published row is readable by `ceo` and
   `support`; and `audit_logs` grants two selects and no write at all.
4. **The measurement after the two files.** The gate passed with 2220 checks over 74 migrations,
   and the catalog read 67 tables, 175 policies, 69 functions, 289 indexes and 126 triggers.
   `audit_logs` held three policies, the deny and two selects, and `job_queue` was the one table
   still on the deny alone, which is the shape section 2 and section 6 chose.

## 10. The 035.5 Proof

1. **The method.** A fresh database takes `0001` to `0074`, the fixture writes two companies,
   two merchants, six office people (one holding each non-owner role), one suspended person
   carrying a `finance_ops` assignment and the rows the policies are asked about, all as the
   owner. Every request afterwards is spoken by `proof_app`, a `nologin` role with no
   `bypassrls`. The script asserts 57 checks and every one passed.
2. **The role reader.** An office person read its one role, the merchant read `owner`, and the
   suspended person and the anonymous caller read an empty array. The person read its own
   assignment and no other, `super_admin` read all nine, `finance_ops` read its own delegated
   permission while `ceo` read none, and the merchant read no office permission.
3. **The audience rule.** A merchant read the `all` and `owners` announcements and not the
   `office` one; `ceo` read the opposite two; a draft was invisible to both; `super_admin` read
   all four. A person dismissed an announcement for itself and was refused when it named another
   person.
4. **The platform and the content.** `ceo`, `finance_ops` and `super_admin` read a plan while
   `support`, `blogger` and the merchant read none, and the merchant could not insert one. The
   merchant read its own entitlement and the other merchant read none. `blogger` created a page,
   `ceo` and `support` read the published one, `blogger` was the only one to read the draft, and
   `finance_ops` and the merchant read neither.
5. **The audit chain.** `super_admin`, `ceo` and `compliance_kyc` read all three rows,
   `finance_ops`, `support`, `blogger` and the anonymous caller read none, and the merchant read
   its own company's two rows while the other merchant read none.
6. **The audit immutability, both gates.** The owner of the table was refused an update and a
   delete with "public.audit_logs is append-only", and an office session was refused the same
   two operations by row level security, which affected zero rows. The catalog confirmed that
   the only write policy on `audit_logs` is the deny itself, so no policy this STEP added can be
   widened into one.
7. **The merchant credential.** The merchant read its own credential and the other merchant read
   none; it inserted a live one and was refused an already revoked one; it revoked its own with
   a reason and was refused a revoke without one by the table check and an update that would
   have left the row live by the policy; the other merchant's revoke touched zero rows.
8. **The catalogs.** 108 policies beside the deny, every one permissive and addressed to
   `public`, `job_queue` still deny only, all 67 deny policies unchanged, the four tenant
   indexes present, and the counts 67 tables, 175 policies, 69 functions, 289 indexes and 126
   triggers.
9. **The rollback and the second apply.** The three rollbacks in descending order returned the
   schema to 106 policies, 285 indexes and 67 functions, and applying `0072`, `0073` and `0074`
   again returned 175 policies, 289 indexes and 69 functions, with the roles answering again.
