// path: docs/handoffs/STEP_014_COMPLETED.md
# STEP 014 Completed - Handoff

## STEP
- Number and title: STEP 014 - Migration for office permissions, delegation, announcements and
  announcement dismissals tables
- Category: Database Schema and Row Level Security (STEP 012-036)
- Depends on (earlier STEPs in this category and their handoff files): STEP 012 (`companies`, the
  UUID v7 function, the row metadata trigger, the migrations gate and its conventions) and STEP 013
  (`users` and `role_assignments`, whose grant history and live-row uniqueness this STEP mirrors
  for delegated permissions). The owner asked for this STEP to be written in one pass, so the five
  planned parts were executed in a single turn; the reasoning is in
  `docs/planning/STEP_014_SUBSTEP_BREAKDOWN.md`.

## Files
- Created:
  - migrations/0005_office_permissions.sql and 0005_office_permissions.down.sql - the delegated
    permission table with its three live indexes, trigger, RLS and default-deny policy.
  - migrations/0006_delegations.sql and 0006_delegations.down.sql - the bounded approval handover
    between two office users, with its two live indexes, trigger, RLS and policy.
  - migrations/0007_announcements.sql and 0007_announcements.down.sql - the announcement table with
    its draft and publish instants, the published index, trigger, RLS and policy.
  - migrations/0008_announcement_dismissals.sql and 0008_announcement_dismissals.down.sql - one
    dismissal per person per announcement, with its unique pair index, trigger, RLS and policy.
  - docs/planning/STEP_014_SUBSTEP_BREAKDOWN.md, docs/handoffs/STEP_014_COMPLETED.md.
- Modified:
  - migrations/README.md - four inventory rows, and two new rules: permission and delegation scopes
    are dotted keys, and an announcement is a draft until published while a dismissal is unique.
  - README.md - the database section describes the office control surfaces and the announcement
    pair.
- Owned paths touched (must match the File Ownership Rules in STEP_PLAN_250.md): numbered
  migration files in `migrations/` and the migrations index. Not touched: migrations `0001` to
  `0004`, every `lib/` module, `config/`, the environment contract, the catalog, the logger, the
  error catalog, the lint matrix, the shell, the permissive RLS policies (035), the sessions and
  audit tables (015, 017), the support and status tables (032, 230) and every code STEP.
  `package.json` is untouched because the migrations gate already covers new files.

## Database
- Migrations added (file names): `0005_office_permissions`, `0006_delegations`,
  `0007_announcements` and `0008_announcement_dismissals`, each with its `.down.sql`. Together they
  create four tables, four triggers, twelve indexes, four policies and 29 comments, and the schema
  now holds eight tables in total.
- Rollback verified on clean database (yes/no, how): **yes**, on PostgreSQL 16.2. All eight
  rollbacks ran in reverse dependency order on a populated database; afterwards the catalog
  reported 0 public tables, 0 policies, 0 functions in `public` and 0 custom triggers, and the
  eight forward files applied again to a second empty database, recreating exactly the eight
  tables. The environment has no Docker and no Supabase CLI, so the server was a real PostgreSQL
  16.2 started locally from the `pgserver` wheel with `psycopg` as the client.

## Environment
- Environment variables added to .env.example: none.
- Secrets handled (names only, never values): none. The proof seeded synthetic hashes and
  announcement text in a throwaway local database.

## Packages
- Package requests for the integrator (name, reason), or none: none.

## Behaviour Proof (acceptance checklist)
- Behaviours named in the STEP title, exercised on PostgreSQL 16.2.

  **1. The four tables exist with their required shape.** Applying `0001` to `0008` to a clean
  database produced eight public tables and, for the four new ones:
  - `office_permissions`: 13 columns, 11 constraints, 3 created indexes plus the primary key,
    `relrowsecurity = true`, policy `office_permissions_default_deny`;
  - `delegations`: 13 columns, 12 constraints, 2 created indexes plus the primary key,
    `relrowsecurity = true`, policy `delegations_default_deny`;
  - `announcements`: 13 columns, 11 constraints, 1 created index plus the primary key,
    `relrowsecurity = true`, policy `announcements_default_deny`;
  - `announcement_dismissals`: 9 columns, 8 constraints, 2 created indexes plus the primary key,
    `relrowsecurity = true`, policy `announcement_dismissals_default_deny`.

  **2. A delegated permission can be temporary or permanent.** A grant of `payout.release` to the
  support agent with `expires_at = now() + 2 days` and a reason stored both values; a tenant scoped
  grant of `kyc.decide` stored the company. Five bad writes were refused by the named constraint:
  `payoutrelease` by `office_permissions_permission_check` (the key needs a dot), `Payout.Release`
  by the same check (lowercase only), a duplicate live grant by `office_permissions_live_key`, an
  expiry before the grant by `office_permissions_expiry_check`, and a grant for an unknown account
  by `office_permissions_user_fkey`.

  **3. A delegation is bounded and never to oneself.** A `payout.release` delegation from the CEO
  to the support agent for three days stored a positive window and two different users, and the
  "what may this person approve now" query found exactly that one live row. Four bad writes were
  refused: delegating to self by `delegations_distinct_users_check`, an `ends_at` before `starts_at`
  by `delegations_window_check`, a second live delegation of the same scope by
  `delegations_live_key`, and an unknown delegate by `delegations_delegate_fkey`.

  **4. An announcement is a draft until published.** A row without `published_at` came back as a
  draft with `level = 'info'` and `audience = 'all'`; a published row stored `warning`, `owners`
  and an expiry after the publication; a tenant announcement kept its `company_id`. Five bad writes
  were refused: an empty title and a padded title by `announcements_title_check`, `urgent` by
  `announcements_level_check`, `everyone` by `announcements_audience_check`, and an expiry before
  publication by `announcements_expiry_check`.

  **5. A dismissal is unique and changes what a person sees.** The owner dismissed the published
  announcement, after which the live popup query returned exactly 1 announcement for that owner
  instead of 2. A second dismissal was refused by `announcement_dismissals_key`, and a dismissal of
  an announcement that does not exist by `announcement_dismissals_announcement_fkey`.

  **6. Row level security denies all four new tables.** A role `gate_reader` without `bypassrls`,
  granted `select`, `insert` and `update`, saw **0** rows in each of the four tables; its insert
  into `announcements` was refused with `new row violates row-level security policy for table
  "announcements"`. The owner still saw its three announcements.

  **7. Every refusal names a constraint, not a syntax error.** The first pass of the proof built
  sixteen statements by formatting UUIDs into SQL text, and the server answered `trailing junk
  after numeric literal` - a syntax error that looks like a refusal and proves nothing. The script
  was rewritten to parameterised statements before any result was recorded, and all sixteen
  refusals listed above now name the constraint or the index that refused the write.

  **8. The gate covers the new files without a change.** `npm run check:migrations` reports
  `migrations gate passed: 243 checks, 8 migrations, 8 tables, every forward file transactional and
  default-deny`. Four deliberate regressions were applied, run and reverted:
  - `alter table public.delegations enable row level security;` removed ->
    `0006_delegations.sql: table delegations must enable row level security in this file`;
  - `company_id` removed from `announcements` ->
    `0007_announcements.sql: table announcements is missing the required column company_id`;
  - `truncate table public.announcement_dismissals;` added to a forward file ->
    `0008_announcement_dismissals.sql: a forward migration never drops or deletes rows`;
  - `0008_announcement_dismissals.down.sql` moved away ->
    `0008_announcement_dismissals.sql: has no rollback file`.
  Restoring each mutation returns the green line above.

- UI checks (desktop, mobile, keyboard, light and dark) where applicable: not applicable, no
  surface changed. The popup that renders an announcement arrives with the shell work of a later
  STEP.
- API checks (success, validation failure, unauthorized, cross-tenant) where applicable: not
  applicable, no route changed. The cross-tenant boundary this STEP adds is the nullable
  `company_id` on a tenant scoped permission, delegation or announcement; STEP 035 adds the
  permissive policies that let an office user read across tenants.
- Money flow ledger proof (balanced debit and credit) where applicable: not applicable, no money
  column exists yet.
- Provider sandbox cycle and documentation URLs where applicable: not applicable, no provider is
  called.

## Verification
- Typecheck result: pass, `npm run typecheck` exits 0 under `strict`,
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `verbatimModuleSyntax`.
- Lint result: pass, `npm run lint` exits 0 with the STEP 009 matrix. No `.ts` file changed in this
  STEP.
- Build result for the touched area: pass on Node.js 26.13.0. The route table is unchanged
  (`○ /`, `○ /_not-found`, `ƒ /api/health`, `ƒ /api/jobs/health`) because this STEP adds no route.
- `npm run verify` runs eleven gates plus typecheck, lint and build, and exits 0 in about 13
  seconds:
  `structure gate passed: 16 directories, 13 root files, 68 source files checked`,
  `check:env passed: .env.example matches 16 manifest variables`,
  `config gate passed: 10 sections, 28 values (5 money entries, all strings), no credential shaped
  key`,
  `i18n gate passed: 36 messages, 2 placeholders, 1 locale (en, ltr)`,
  `logger gate passed: 117 checks, 15 records parsed, 4 levels, 9 secret fragments absent`,
  `error gate passed: 196 checks, 14 codes, all statuses in 4xx or 5xx, no secret or stack in any
  envelope`,
  `lint gate passed: 77 checks, 26 rules enforced as errors, 11 failure probes fired, 1 clean
  probe stayed clean`,
  `shell gate passed: 98 checks, 12 files scanned, no colour literal, no palette step, theme
  script and provider agree`,
  `jobs gate passed: 110 checks, 4 worker slots, 5 default attempts, store "memory"`,
  `migrations gate passed: 243 checks, 8 migrations, 8 tables, every forward file transactional and
  default-deny`, then build.
- Runtime: Node.js 26.13.0, npm 10.9.8, engine-strict. No dependency change. The proof server was
  PostgreSQL 16.2.

## Next
- Next STEP number: STEP 015 - Migration for sessions and device proof keys table. Not started.
  This chat ends here as the owner asked, and STEP 015 needs the owner's consent.
- Anything the next chat must know:
  1. A permission is a live row in `office_permissions`, never a boolean on a user, and its
     `permission` value is a dotted key such as `payout.release`. The catalog of keys belongs to the
     STEP that performs the action; the database only checks the shape (`^[a-z][a-z0-9]*(\.[a-z0-9_]+)+$`,
     at most 64 characters).
  2. `expires_at` is how a temporary grant ends by itself; `revoked_at` is how a super_admin ends
     one early. A permission check must filter `revoked_at is null and (expires_at is null or
     expires_at > now())`; an expired row stays as history and still satisfies the live index.
  3. A delegation never grants a permission by itself. An approval reads `delegations` for the
     handover and `office_permissions` (or the role) for the underlying authority, and must also
     exclude `ends_at <= now()` and a set `revoked_at`.
  4. `delegations` requires `ends_at` and refuses a delegation to oneself; do not "fix" a missing
     end instant in code by writing a far future timestamp. A permanent authority is a role, not a
     delegation.
  5. An announcement is published by setting `published_at`; there is no status column and adding
     one would let the two disagree. The popup query is: `published_at is not null`,
     `expires_at is null or expires_at > now()`, `audience` matches the viewer, `deleted_at is
     null`, and "no dismissal row for this user".
  6. A dismissal is unique per person and announcement and is never deleted. A support tool that
     deletes a dismissal is a feature decision that must be argued, not a cleanup.
  7. Announcement bodies are plain text rendered as text. If rich copy is ever needed, the
     sanitizer belongs to the STEP that renders it; the column does not change.
  8. All eight tables are default-deny for everyone except the owner and the service role. STEP 035
     adds the permissive policies; until then an authenticated client reads nothing, which is the
     intended safe default.
  9. Still open for their owners: sessions and device keys (015), login attempts and locks (016),
     the audit log (017), plans and subscriptions (018-019), clients and invoices (020-022), the
     provider tables (023), KYC (028), the permissive RLS policies (033-035) and the super_admin
     bootstrap (036).
