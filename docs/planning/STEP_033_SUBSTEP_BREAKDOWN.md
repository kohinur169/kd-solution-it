// path: docs/planning/STEP_033_SUBSTEP_BREAKDOWN.md
# STEP 033 - Sub-Step Breakdown

This document is sub-step 033.1. It reads the plan, the feature list, the master prompt and the
STEP 032 handoff, measures the schema, fixes the meaning of "tenant tables batch one" and the
way a policy learns who is asking, and then stops for the owner's permission before any SQL is
written. The proof belongs in `docs/handoffs/STEP_033_COMPLETED.md`.

## 1. Scope Confirmed From The Source Documents

### STEP 033 as written in docs/final/STEP_PLAN_250.md
- Title: "RLS default-deny policies for tenant tables batch one".
- Category: Database Schema and Row Level Security (STEP 012-036). A database STEP owns only its
  numbered migration files and the migrations index; no `lib/`, `app/` or `services/` file.
- Neighbours: STEP 034 is "RLS default-deny policies for payment and ledger tables batch two"
  and STEP 035 is "RLS policies for office roles and audit log immutability". STEP 037 creates
  the Supabase Auth client and the typed session access, so the contract this STEP defines in
  the database is what that STEP feeds. STEP 005 created `office_permissions`, STEP 004
  `role_assignments` and STEP 003 `users`, which the helper reads.
- The plan's own sub-steps 4 to 7 (service, API, UI, security review) do not apply to a policy
  STEP the way STEP 031 and STEP 032 read them: there is no surface to build, and the security
  review is the proof itself.

### The rules that fix the shape
- `docs/final/MASTER_PROMPT.md` rule 7: "Every table has id UUID v7, company_id, created_at,
  updated_at, deleted_at and version."
- `docs/final/MASTER_PROMPT.md` rule 8: "RLS is enabled with a default-deny policy on every
  table."
- `migrations/README.md` rule 8: "Row level security is enabled and explicitly denied. A STEP
  that grants access adds a permissive policy beside `<table>_default_deny`; it does not remove
  the deny." That sentence is the whole method of this STEP: nothing is dropped, a second
  permissive policy is OR-ed beside the first, and a caller the policy cannot identify still
  sees nothing.
- `migrations/README.md` rule 9: no migration creates extensions, roles or schemas, so the actor
  cannot arrive as a Postgres role per person.
- FEATURE_LIST section 2: seven roles, `owner` is the sub-merchant, a client never signs in, and
  every permission grant, change and use is audit logged.

### What exists today (measured before writing this document)
- 68 migrations, 67 tables, 67 policies, 126 triggers, 64 functions and 273 indexes in `public`;
  `npm run check:migrations` passes 2100 checks.
- Every one of the 67 tables carries exactly one policy, `<table>_default_deny`, with `using
  (false)` and `with check (false)`. Nothing in the schema grants a row to anybody yet.
- 37 tables have a `company_id` that is `NOT NULL`; the other 30 allow null, because they are
  platform rows, office rows or per-person rows.
- `users` (0003) carries `company_id` nullable, `status` in `active`, `suspended`, `closed` and
  `deleted_at`, which is everything the helper needs to place a caller.
- `DATABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are both in `lib/env/manifest.ts`, so the
  platform reaches the database two ways: a server connection from `DATABASE_URL`, which is how
  migrations and background jobs run, and a Supabase request carrying a signed JWT, which is how
  a browser reaches it. A policy that only understood one of the two would lock out the other.

## 2. Decisions This STEP Makes

1. **A tenant table gets one permissive policy beside its deny, and the deny stays.** The policy
   is `for all`, so one statement covers select, insert, update and delete, with `using` and
   `with check` carrying the same predicate. The deny is not dropped, which keeps rule 8 and
   keeps the "nothing matches" behaviour if someone removes the new policy in a later STEP.
2. **The policy names are `<table>_tenant_isolation`.** The name says what the policy is for;
   the STEP 035 office policies will be named for their role, and a reader can tell the two
   layers apart by name alone.
3. **The actor is a database helper, not a predicate written per policy.** Two functions carry
   the whole contract, `public.current_actor_id()` and `public.current_actor_company_id()`, so a
   change to how a session identifies itself is one function body and not 22 predicates.
4. **`current_actor_id()` reads the session setting first and the Supabase claim second.** The
   server connection sets `app.user_id` inside its transaction with `set_config(..., true)`, and
   a Supabase request carries `request.jwt.claims`. One function understands both, so the same
   policy serves the web request, the background job and the proof.
5. **A malformed actor is no actor.** `public.uuid_or_null(text)` returns null unless the text
   is a canonical uuid, so a JWT with a strange `sub` or a half written setting yields null
   rather than a cast error, and the policy then matches nothing.
6. **The company comes from `users`, never from a claim.** `current_actor_company_id()` is
   `security definer` (the pattern `audit_logs_guard_chain` already uses), is `stable`, and
   selects `company_id` from `public.users` where the row is the actor, `status = 'active'` and
   `deleted_at is null`. A caller who sets the session setting can name a person but cannot name
   a company; a suspended person resolves to no company and therefore to no rows.
7. **No actor, no rows.** If neither the setting nor the claim is present the helper returns
   null, `company_id = null` is never true in a policy, and the table stays closed. This is the
   property the proof exercises first, because it is the one that matters if a request loses its
   session.
8. **The helper reads `users` as the owner, so the policy does not recurse.** `users` itself
   carries a tenant policy in this STEP, and a `security definer` function is evaluated as the
   table owner, which skips row level security instead of asking the `users` policy from inside
   a `users` policy.
9. **Batch one is the merchant's own business record: 22 tables.** `companies`, `users`,
   `clients`, `products`, `services`, `invoices`, `invoice_items`, `invoice_events`,
   `estimates`, `estimate_items`, `estimate_signatures`, `recurring_schedules`,
   `policy_acceptances`, `kyc_submissions`, `kyc_documents`, `ubo_records`,
   `sanctions_screenings`, `review_decisions`, `submerchant_provisions`, `files`,
   `support_tickets` and `support_ticket_messages`. Each has a required `company_id`, is not
   money movement, and carries no secret and no per-person rule.
10. **`companies` matches on `id`, because the row is the tenant.** Its policy reads `id =
    public.current_actor_company_id()`, which is the same rule in the one table where the tenant
    is the row rather than a column.
11. **Everything money is STEP 034's and everything office is STEP 035's.** `payments`,
    `refunds`, `disputes`, `ledger_entries`, `settlements`, `holds`, `reserves`, `payouts`,
    `payout_bank_accounts`, `bank_change_requests`, `idempotency_keys`, `subscriptions` and
    `subscription_charges` are batch two. `audit_logs`, `sessions`, `device_proof_keys`,
    `login_attempts`, `account_locks`, `role_assignments`, `office_permissions`, `delegations`,
    `announcements`, `announcement_dismissals`, the connection tables with secrets
    (`merchant_api_credentials`, `store_connections`, `taxcloud_connections`) and every platform
    table are STEP 035's, because their rule is a role rule or a per-person rule and not a
    tenant rule. A policy that guessed one of them here would have to be narrowed later, and
    narrowing a policy is a second migration for a rule that was never true.
12. **No column is added and no table is created.** The two forward files add three functions
    and 22 policies and nothing else, so the counts of tables, triggers and indexes do not move
    and a reader of `\d` sees the same shape as STEP 032 left.
13. **The session setting is a server-side trust and the claim is a signed trust.** The setting
    path exists for `DATABASE_URL` connections and for the proof, and a database role that can
    run `set_config` could name another person; that role is the service credential, the same
    one that can read every table anyway. A browser never holds it: it holds a JWT, which the
    claim path reads and which cannot be written by the client. The handoff states this limit
    rather than hiding it.
14. **Two of the 22 tables need an index for their own predicate.** The measurement that
    produced this document also read `pg_indexes` for the first column of every index: 20 of the
    22 tables already start an index with `company_id`, but `ubo_records` and
    `support_ticket_messages` do not, and a policy that filters on a column with no index is a
    scan on every read. `0070` adds `ubo_records_company_idx` over `(company_id)` and
    `support_ticket_messages_company_idx` over `(company_id, created_at)`, both partial on
    `deleted_at is null`, so the predicate is answered by an index from the first day.
15. **The policy is one statement per table, spelled out.** No loop, no `do` block, no dynamic
    SQL: a migration that generated its policies from a catalog query cannot be reviewed, and a
    reviewer of a security migration must be able to read every predicate.

## 3. The Schema This Produces

### `0069_actor_session.sql` (three functions, no table)
- `public.uuid_or_null(value text) returns uuid`: `immutable`, empty `search_path`, returns the
  cast only when the text matches the canonical uuid shape, and null otherwise.
- `public.current_actor_id() returns uuid`: `stable`, empty `search_path`, `coalesce` of
  `uuid_or_null(current_setting('app.user_id', true))` and the `sub` of
  `current_setting('request.jwt.claims', true)` when that setting is a JSON object.
- `public.current_actor_company_id() returns uuid`: `stable`, `security definer`, empty
  `search_path`, the `company_id` of the active, not deleted `users` row of
  `current_actor_id()`, or null.
- Each carries a comment; the rollback drops the three, and it drops them after the policies of
  `0070`, because a policy that references a function cannot outlive it.

### `0070_tenant_policies_batch_one.sql` (22 policies, no table)
One `create policy <table>_tenant_isolation` per table, `as permissive`, `for all`, `to public`,
`using` and `with check` the same predicate:

| Table | Predicate |
| --- | --- |
| companies | `id = public.current_actor_company_id()` |
| users, clients, products, services, invoices, invoice_items, invoice_events, estimates, estimate_items, estimate_signatures, recurring_schedules, policy_acceptances, kyc_submissions, kyc_documents, ubo_records, sanctions_screenings, review_decisions, submerchant_provisions, files, support_tickets, support_ticket_messages | `company_id = public.current_actor_company_id()` |

The file also adds the two indexes decision 14 names, because a predicate without an index
behind it is a scan of the table on every request.

Counts after this STEP, to be measured rather than assumed: 70 migrations, 67 tables, 89
policies, 126 triggers, 67 functions and 275 indexes.

## 4. The Sub-Steps

### 033.1 - Inventory, decisions and ownership (this document)
Read the plan, the feature list, the master prompt, the migrations rules and the STEP 032
handoff; measured the tables and their policies; fixed the actor contract and the batch one
list. No file outside this document is touched. It stops for permission.

### 033.2 - `0069_actor_session.sql` and `0070_tenant_policies_batch_one.sql`
The three functions, the 22 policies and both rollbacks, with the gate run after each file and a
forward apply of `0001` to `0070` on a clean database.

### 033.3 - The proof
The behaviour of a policy cannot be read from a catalog, so the proof acts as two merchants and
an anonymous caller: no setting and no claim sees nothing; the setting sees its own company
only; the claim sees the same; a suspended or deleted person sees nothing; an insert naming
another company is refused; an update cannot move a row to another company; `companies` resolves
through `id`; the deny still fires for a table outside the batch; the policy list is read from
`pg_policies`; the rollback returns the schema to 67 policies and 64 functions and the re-apply
restores 89 and 67.

### 033.4 - The docs, the verification and the commit
One new rule in `migrations/README.md` for the tenant policy layer (the numbering rule moves
from 48 to 49), a sentence in the database section of `README.md`, the handoff with every number
measured, `npm run verify`, the single commit "STEP 033: RLS default-deny policies for tenant
tables batch one", the push and `docs/handoffs/STEP_033_COMPLETED.md`.

## 5. Files This STEP Owns
- `migrations/0069_actor_session.sql` and its `.down.sql`.
- `migrations/0070_tenant_policies_batch_one.sql` and its `.down.sql`.
- `migrations/README.md` (the new rule and the numbering rule).
- `README.md` (the database section only).
- `docs/planning/STEP_033_SUBSTEP_BREAKDOWN.md` and `docs/handoffs/STEP_033_COMPLETED.md`.

Nothing else. No `lib/`, `app/`, `services/`, `config/`, `package.json`, `migrations/verify.ts`
or earlier migration is touched.

## 6. What This STEP Deliberately Leaves Out
1. **Who inside a company may do what.** The batch one policy says "this row is my company's";
   the office permissions of STEP 005 and the role policies of STEP 035 say which of the
   company's people may read or write it. A tenant policy that also guessed the role would be
   two rules in one predicate.
2. **The money and the ledger.** STEP 034 owns them, with the same method and its own proof.
3. **The platform tables.** `plans`, `pricing_versions`, `provider_keys`, `email_settings`,
   `cms_pages`, `blog_posts`, `company_transactions`, `processor_bills`, `compliance_items` and
   the rest have no tenant to be isolated to, so their policy is a role rule and belongs to STEP
   035.
4. **The per-person tables.** `sessions`, `device_proof_keys`, `login_attempts` and
   `account_locks` are about one person, not one company.
5. **The audit chain immutability.** STEP 035 owns the policy that makes `audit_logs` append
   only for every role but the service.
6. **The code that sets the setting.** STEP 037 creates the Supabase Auth client and the typed
   session access; this STEP defines the two database functions that STEP will feed, and does
   not write the TypeScript.
7. **A policy for `job_queue`.** The queue is worked by the service role and has no tenant
   policy in either batch; a worker that could see one merchant's jobs would still be the
   service.
8. **Column level rules.** RLS filters rows; hiding one column from one role is a view or a
   grant, and no STEP so far asks for one.

## 7. Risks To Prove In 033.2
1. **A file that creates no table.** `0058` proved the gate accepts it; this STEP writes two
   such files and runs the gate after each, and the gate's default-deny pattern is per creating
   file, so the new files must not accidentally satisfy it for another table or break it.
2. **A `security definer` helper and the `users` policy.** The helper must be read as the owner
   and must not recurse; the proof calls it as a plain role that has no row of its own in
   `users` and expects null rather than an error.
3. **A malformed claim.** `uuid_or_null` must return null for a claim that is not a uuid and for
   a `request.jwt.claims` that is not an object, without a cast error reaching the caller.
4. **An index the policy needs.** The predicate is `company_id = ...`; 20 of the 22 tables
   already carry an index that starts with `company_id`, and the measurement of 033.1 found the
   two that do not (`ubo_records` and `support_ticket_messages`), so `0070` adds one for each.
   The proof reads `pg_indexes` and asserts that all 22 predicates are backed by an index whose
   first column is the one the predicate reads, which is the check that keeps a later table from
   arriving without one.
5. **The counts.** Every number in the handoff is measured from the catalog at the end of 033.4,
   never predicted from this document.

## 8. The Two Files Of 033.2
1. **`0069_actor_session.sql`** creates the three functions of section 3 and a comment for
   each. `uuid_or_null` is `immutable`, pins `search_path = ''` and accepts only the canonical
   lower case form, so the cast it guards can never raise. `current_actor_id` is `stable` and
   coalesces the `app.user_id` setting over the `sub` claim, and it reads the claim only when
   `request.jwt.claims` starts with `{`, which is what keeps a non JSON setting from reaching
   the cast. `current_actor_company_id` is `stable` and `security definer`, returns the company
   of a person whose `status` is `active` and whose `deleted_at` is null, and therefore returns
   null for a suspended, closed, deleted or unknown person. The rollback drops the three in the
   reverse order of their creation.
2. **`0070_tenant_policies_batch_one.sql`** adds the 22 policies of section 1 and the two
   indexes of decision 15, and nothing else. Each policy is `as permissive`, `for all`,
   `to public`, and reads `public.current_actor_company_id()` in both `using` and
   `with check`, which is the pair that makes a foreign row invisible and a foreign write
   refused. `companies` compares `id`, because the tenant is the row; the other 21 compare
   `company_id`. `<table>_default_deny` is untouched in both files, and the rollback drops only
   the 22 new policies and the two indexes.
3. **The measurement after the two files**, on a clean database with `0001` to `0070` applied:
   the gate passes with 2140 checks over 70 migrations and 67 tables, and the catalog holds 67
   tables, 89 policies, 67 functions, 275 indexes and 126 triggers. Exactly 22 tables carry two
   policies and the remaining 45 carry the one deny policy they arrived with, which is the
   check that no table was missed and no table was touched twice.

## 9. The 033.3 Proof
1. **The method.** A fresh database takes `0001` to `0070`, the fixture writes two companies,
   four people (one active, one suspended, one deleted, one of the other company), three
   clients, two products and one plan as the owner, and every request afterwards is spoken by
   `proof_app`, a role that is `nologin`, has no `bypassrls` and holds only schema usage and
   table grants. The script asserts 51 checks and each one passed.
2. **What the 51 checks cover.** The setting path answers for one company only, including a
   foreign row asked for by its own id; the JWT path gives the same answer, and the second
   merchant gets its own row, not the first one's; the setting wins when both are present. Six
   malformed requests - nothing, a claim that is not JSON, a claim without `sub`, a `sub` that
   is not a uuid, an upper case uuid, and a setting that is not a uuid - return no row and
   raise nothing. A suspended person, a deleted person and an anonymous caller all see zero
   rows, and a caller who sets `app.company_id` to the other company still sees its own, which
   is the proof that the company comes from the person's row and not from a setting.
3. **Writes, the deny and the catalog.** A cross-company insert and an attempt to move an own
   row to the other company are both refused with "new row violates row-level security"; an own
   insert, update and delete pass; an update or delete aimed at the other company's row touches
   zero rows. A table outside batch one (`plans`) is still refused to the actor while its row
   is there for the owner, and all 67 `<table>_default_deny` policies still carry
   `using (false)` and `with check (false)`. The catalog read confirms 22 policies, all
   permissive and `for all` and addressed to `public`, every predicate reading the helper, the
   exact `companies` predicate, the two new partial indexes, an index leading with
   `company_id` for every one of the 21 predicates, the volatility and definer flags of the
   three functions, and an empty pinned `search_path` on each.
4. **The rollback and the second apply.** The `0070` rollback returns the schema to 67 policies
   and 273 indexes, and the actor then sees zero rows, which proves the deny alone is left and
   row level security is still enabled. The `0069` rollback takes the functions to 64. Applying
   both files again returns 89 policies, 67 functions and 275 indexes, and the JWT path answers
   for the first merchant again.
5. **Two observations recorded, not changed.** The guard accepts the canonical lower case uuid
   only, so an upper case `sub` resolves to no actor; that is deliberate, and both writers of
   the claims - Supabase and our own `uuid` text - emit the lower case form. The pinned search
   path reads `search_path=""` in `pg_proc.proconfig`, which is the literal a later check
   should compare against rather than the `search_path=` prefix.
