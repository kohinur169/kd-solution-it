// path: docs/handoffs/STEP_033_COMPLETED.md
# STEP 033 Completed - Handoff

## STEP
- Number and title: STEP 033 - RLS default-deny policies for tenant tables batch one
- Category: Database Schema and Row Level Security (STEP 012-036)
- Depends on (earlier STEPs in this category and their handoff files): STEP 001 (the tenant root
  and `uuid_generate_v7()`), STEP 003 (`users`, the row that names a company), STEP 004 (the
  role vocabulary STEP 035 will use), STEP 016 (`payment_providers`, whose tables are left to
  batch two), STEP 031 (`files`) and STEP 032 (the last ten default-deny tables), plus the
  twelve keys of STEP 0052. The plan for this STEP is
  `docs/planning/STEP_033_SUBSTEP_BREAKDOWN.md`; the owner split it into four sub-steps with
  an approval between each.

## Files
- Created:
  - migrations/0069_actor_session.sql and its `.down.sql` - the three actor helpers, in a file
    that creates no table.
  - migrations/0070_tenant_policies_batch_one.sql and its `.down.sql` - the 22 tenant policies
    and the two indexes, in a file that creates no table.
  - docs/planning/STEP_033_SUBSTEP_BREAKDOWN.md and docs/handoffs/STEP_033_COMPLETED.md.
- Modified:
  - migrations/README.md - two inventory rows (`0069`, `0070`), two new rules (the shape of a
    tenant policy, and the one place an actor is identified) and the numbering rule moved from
    48 to 51; the introduction now counts seventy files.
  - README.md - one database bullet describing the actor helpers and the batch one policies,
    directly above the `uuid_generate_v7()` bullet.
- Owned paths touched (must match the File Ownership Rules in STEP_PLAN_250.md): numbered
  migration files in `migrations/`, the migrations index, the handoff and planning folders, and
  the database section of the root `README.md`. Not touched: migrations `0001` to `0068`, every
  `lib/`, `app/` and `services/` file, `config/`, `.env.example`, `package.json`,
  `package-lock.json` and `migrations/verify.ts`, which needed no change.

## Database
- Migrations added (file names): `0069_actor_session.sql` and
  `0070_tenant_policies_batch_one.sql`, two forward files and two rollbacks. Neither creates a
  table. The schema now holds 70 migrations, 67 tables, 89 policies, 67 functions, 275 indexes
  and 126 triggers in `public`.
- `0069` creates three functions and one comment each. `public.uuid_or_null(text)` is `sql`,
  `immutable`, pins `search_path = ''` and returns the uuid a canonical lower case text spells
  or null, so it never raises. `public.current_actor_id()` is `sql`, `stable` and coalesces the
  `app.user_id` setting over the `sub` claim of `request.jwt.claims`, reading the claim only
  when the setting starts with `{`. `public.current_actor_company_id()` is `sql`, `stable` and
  `security definer`, and returns the `company_id` of the row in `public.users` whose person is
  `active` with no `deleted_at`; a suspended, closed, deleted or unknown person resolves to
  null, and because the function is read as the owner the policy on `users` cannot recurse.
- `0070` adds 22 policies named `<table>_tenant_isolation`, each `as permissive`, `for all`,
  `to public`, with `using` and `with check` set to `id = public.current_actor_company_id()` on
  `companies` and to `company_id = public.current_actor_company_id()` on the other 21 tables:
  `users`, `clients`, `products`, `services`, `invoices`, `invoice_items`, `invoice_events`,
  `estimates`, `estimate_items`, `estimate_signatures`, `recurring_schedules`,
  `policy_acceptances`, `kyc_submissions`, `kyc_documents`, `ubo_records`,
  `sanctions_screenings`, `review_decisions`, `submerchant_provisions`, `files`,
  `support_tickets` and `support_ticket_messages`.
- `<table>_default_deny` is untouched in every one of the 67 tables: a permissive policy is
  ORed with the deny, so the deny contributes nothing when the tenant policy matches a row and
  is all that is left when the actor resolves to no company. Exactly 22 tables carry two
  policies after this STEP and the other 45 carry the deny alone.
- Two indexes were added because the predicate needed them: `ubo_records_company_idx` on
  `(company_id)` and `support_ticket_messages_company_idx` on `(company_id, created_at)`, both
  `where deleted_at is null`. The other 20 tables already had an index whose first column is
  `company_id`, and `companies` is filtered by its primary key.
- Rollback verified on clean database (yes/no, how): **yes**, on PostgreSQL 16.2. The `0070`
  rollback returns the schema to 67 policies and 273 indexes and the actor then sees zero rows,
  which proves row level security stayed on and only the deny is left; the `0069` rollback takes
  the functions to 64 with no policy referring to them; applying both again returns 89 policies,
  67 functions and 275 indexes and the JWT path answers again. The full chain of 70 forward
  files and 70 rollbacks ran on a fresh database and left 0 tables, 0 policies, 0 triggers and
  0 functions in `public`.

## Environment
- Environment variables added to .env.example: none. The helpers read two request settings and
  no variable; `DATABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, the two access paths they serve,
  were declared by STEP 002 and 003.
- Secrets handled (names only, never values): none. The proof wrote synthetic companies, people,
  clients and products in a throwaway local database and used no real credential.

## Packages
- Package requests for the integrator (name, reason), or none: none.

## Behaviour Proof (acceptance checklist)
One proof script ran against the local PostgreSQL 16.2 and asserted 51 checks; all 51 passed.
Every request after the fixture was spoken by `proof_app`, a role that is `nologin`, has no
`bypassrls` and holds only schema usage and table grants, so row level security was really
applied.

1. **The setting path.** A person of the first company saw its two clients, its one product, its
   one company row and the three people of the company, and the second company's client asked
   for by its own id returned zero rows.
2. **The JWT path.** The same person named only in `request.jwt.claims` saw the same rows, and
   the second merchant saw its own company row rather than the first one's.
3. **Precedence.** With both a setting naming the second merchant and a claim naming the first,
   the answer was the second merchant's, which is the documented order.
4. **Malformed input.** Nothing at all, a claim that is not JSON, a claim without `sub`, a `sub`
   that is not a uuid, a `sub` in upper case and a setting that is not a uuid each returned zero
   rows and raised nothing.
5. **Who resolves to no company.** A suspended person, a deleted person and an anonymous caller
   all saw zero rows, and a caller who set `app.company_id` to the other company still saw its
   own, because the company is read from the person's row and not from a setting.
6. **Writes.** A cross-company insert and a move of an own row to the other company were both
   refused with "new row violates row-level security policy"; an own insert, update and delete
   passed, and an update or a delete aimed at the other company's row touched zero rows.
7. **The deny is intact.** A table outside batch one (`plans`) returned zero rows to the actor
   while its row was there for the owner, and all 67 `<table>_default_deny` policies still carry
   `using (false)` and `with check (false)`.
8. **The catalog agrees.** `pg_policies` shows 22 tenant policies, all permissive, `for all` and
   addressed to `public`, every predicate reading `current_actor_company_id()`, with the exact
   `companies` predicate; `pg_indexes` shows the two new partial indexes; a query proves all 21
   `company_id` predicates are backed by an index whose first column is `company_id`;
   `pg_proc` shows one immutable guard and two stable readers, only the company reader
   `security definer`, each pinning `search_path=""`; the guard returns null for null, an empty
   string, "abc" and an upper case uuid, and the counts are 67 tables, 89 policies, 67
   functions, 275 indexes and 126 triggers.
9. **Rollback and re-apply.** The two rollbacks and the two second applies produced the counts
   recorded under Database, and the policy worked again at the end.

## Verification
- `npm run check:migrations`: `migrations gate passed: 2140 checks, 70 migrations, 67 tables,
  every forward file transactional and default-deny`, exit 0.
- `npm run verify`: exit 0. Structure gate 16 directories, 13 root files and 68 source files;
  config gate 10 sections and 28 values; i18n gate 36 messages; logger gate 117 checks; error
  gate 196 checks; lint gate 77 checks; shell gate 98 checks; jobs gate 110 checks; the
  migrations gate above; then the TypeScript typecheck, the linter and the production build,
  which compiled successfully.
- The full forward and reverse chain of all 70 migrations was run on a clean database before
  the commit, and the gate was run after each of the four files was written.

## Next
- Next STEP number: STEP 034 - RLS default-deny policies for payment and ledger tables batch
  two.
- Anything the next chat must know: the two helpers of `0069` are the only place a request is
  identified, so `034` writes its policies in the same one line shape and adds no second helper;
  a batch two table whose predicate reads `company_id` must also carry an index that starts with
  that column, which is the check `033` measured. Money and ledger rows are not one merchant's
  business record alone, so their policies need the role rules of STEP 035 before a merchant is
  granted one; `0070` deliberately grants no role, including `support` and `blogger`. The 45
  tables left on the deny alone include every money table, every office table, every per-person
  table and every secret holding table, and STEP 035 owns them.
