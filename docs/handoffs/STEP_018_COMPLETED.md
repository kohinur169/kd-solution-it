// path: docs/handoffs/STEP_018_COMPLETED.md
# STEP 018 Completed - Handoff

## STEP
- Number and title: STEP 018 - Migration for plans, plan entitlements and pricing versions tables
- Category: Database Schema and Row Level Security (STEP 012-036)
- Depends on (earlier STEPs in this category and their handoff files): STEP 012 (`companies`, the
  UUID v7 function, the row metadata trigger and the gate conventions) and STEP 017 (the audit log
  that must record every plan and price change). STEP 019 will reference these plans from
  subscriptions, and the invoice, payment and settlement STEPs will read the price lists. The owner
  asked for this STEP in five sub-STEPS, one approval at a time; the plan is
  `docs/planning/STEP_018_SUBSTEP_BREAKDOWN.md`.

## Files
- Created:
  - migrations/0014_plans.sql and 0014_plans.down.sql - the plan catalogue with its code, price,
    period, status and publication instant, three indexes, trigger, RLS and default-deny policy.
  - migrations/0015_plan_entitlements.sql and 0015_plan_entitlements.down.sql - one row per service
    a plan includes, with its live pair index, its service index, trigger, RLS and policy.
  - migrations/0016_pricing_versions.sql and 0016_pricing_versions.down.sql - the versioned price
    list with the five fees of section 14 and their payers, its generated scope, its thirty day
    announcement check, three indexes, trigger, RLS and policy.
  - docs/planning/STEP_018_SUBSTEP_BREAKDOWN.md, docs/handoffs/STEP_018_COMPLETED.md.
- Modified:
  - migrations/README.md - three inventory rows and two new rules: a plan is a platform catalogue
    entry whose services are rows, and a price list is versioned by revision inside a scope with a
    thirty day announcement rule.
  - README.md - the database section describes the plan catalogue, the entitlements and the price
    list. A missing line break between the STEP 017 bullet and the helper bullet was fixed in the
    same edit.
- Owned paths touched (must match the File Ownership Rules in STEP_PLAN_250.md): numbered migration
  files in `migrations/` and the migrations index. Not touched: migrations `0001` to `0013`, every
  `lib/` module, `config/`, the environment contract, subscriptions and charges (019), the public
  pricing page and every other UI, the service catalogue in code, the permissive RLS policies (035),
  the audit writer and every code STEP. `package.json` is untouched because the migrations gate
  already covers new files.

## Database
- Migrations added (file names): `0014_plans`, `0015_plan_entitlements` and `0016_pricing_versions`,
  each with its `.down.sql`. Together they create three tables, 45 columns, 40 constraints, eleven
  indexes and 30 comments, and the schema now holds sixteen tables, sixteen policies, seventeen
  triggers and four functions in `public`.
- Shape per table: `plans` 14 columns, 13 constraints, four indexes, ten comments;
  `plan_entitlements` 8 columns, 7 constraints, three indexes, five comments;
  `pricing_versions` 23 columns, 20 constraints, four indexes, fifteen comments.
- Money is stored as `bigint` minor units with an explicit three letter currency, never a float and
  never a formatted string.
- Rollback verified on clean database (yes/no, how): **yes**, on PostgreSQL 16.2. All sixteen
  rollbacks ran in reverse dependency order on a populated database; afterwards the catalog reported
  0 public tables, 0 policies, 0 triggers in `public` and 0 functions in `public`, and the sixteen
  forward files applied again to a second empty database, recreating exactly sixteen tables,
  sixteen policies and seventeen triggers. The environment has no Docker and no Supabase CLI, so the
  server was a real PostgreSQL 16.2 started locally from the `pgserver` wheel with `psycopg` as the
  client.

## Environment
- Environment variables added to .env.example: none.
- Secrets handled (names only, never values): none. The proof seeded synthetic plan names, service
  keys and fee amounts in throwaway local databases.

## Packages
- Package requests for the integrator (name, reason), or none: none.

## Behaviour Proof (acceptance checklist)
Three throwaway scripts ran against the local PostgreSQL 16.2 with 25, 22 and 27 checks; all passed
and each ended with `PROOF COMPLETE`.

1. **Forward apply.** `0001` to `0016` applied in order and produced sixteen tables, sixteen
   policies and seventeen triggers.
2. **A plan is a draft until it is published.** A new plan stored as `draft` with
   `published_at` null and version 1, and a published plan stored as `active` with its instant and
   its display order.
3. **The plan shape is checked.** A duplicate code, an upper case code, a code with a trailing
   separator, a padded or empty name, a negative price, a two letter or lower case currency, a
   weekly period, an unknown status, a publication instant before creation and a negative display
   order were each refused by name.
4. **A plan moves through its life, never out of the table.** Publishing a draft moved the version
   to 2, and retiring the second plan left it readable.
5. **Entitlements are rows.** The six services section 9 names were attached to one plan, the same
   service was allowed on a different plan, a duplicate in one plan was refused by
   `plan_entitlements_live_key`, and an entitlement for a plan that does not exist was refused by
   the foreign key.
6. **Service keys are shaped, not enumerated.** `Invoicing`, `payment-links`, `x` and `2fa` were
   each refused by `plan_entitlements_service_check`, so the catalogue can grow without a migration.
7. **The catalogue questions are cheap.** "Which plans include invoicing" answered 2 rows, and the
   planner can answer the lookup from `plan_entitlements_service_idx`.
8. **A service can be removed and granted again.** Revoking `test_mode` removed it from the plan and
   re-inserting it restored it while both rows stayed as history.
9. **A price list is a whole document.** The platform list opened at revision 1 in the zero uuid
   scope and a merchant override opened at revision 1 in its own scope; two merchants and the
   platform could share one effective instant.
10. **The versioning rules hold.** A repeated revision and a repeated effective instant inside one
    scope were refused; the same revision in another scope was accepted.
11. **The thirty day rule is a constraint.** A price announced on 20 November and effective on
    4 December was refused by `pricing_versions_announcement_check`, the same price effective on
    20 December (exactly thirty days) was accepted, and shortening the rule mutated the proof as
    expected.
12. **Fees are bounded and payers are named.** A platform fee of 10001 basis points, a negative
    processor percentage, a negative fixed fee, a payer outside the vocabulary, a lower case
    currency and revision zero were each refused by their own constraint.
13. **Retirement is ordered.** Retiring a list before its own effective instant was refused, and a
    valid retirement moved the version to 2.
14. **One query answers a merchant's world.** A single reading returned the plan code, its three
    services, whether `public_api` was included, the 100 basis point platform fee from that
    merchant's override and the 150 basis point fee from the platform list, while a merchant without
    an override fell back to the platform list.
15. **Row level security.** A plain role saw zero rows on all three tables and could not insert into
    the price list, while the owner saw the plan, its three entitlements and all four price lists.
16. **Rollback and re-apply.** The sixteen rollbacks emptied the `public` schema completely and the
    sixteen forward files rebuilt it on a second database.

## Verification
- `npm run check:migrations`: `migrations gate passed: 483 checks, 16 migrations, 16 tables, every
  forward file transactional and default-deny` (423 after the plan table, 453 after entitlements;
  393 before this STEP).
- Gate mutation probes, each caught and reverted on all three files: removing `enable row level
  security`, removing `company_id`, inserting a `truncate`, and removing the rollback file.
- Behaviour mutation probe: replacing `interval '30 days'` with `interval '0 days'` in the
  announcement check made the cross-table proof fail with "a price effective fourteen days after it
  was announced :: the write succeeded"; the file was restored and the proof was green again.
- `npm run verify`: exit 0. Structure 16 directories, 13 root files, 68 source files; config 10
  sections and 28 values; i18n 36 messages; logger 117 checks; errors 196 checks and 14 codes; lint
  77 checks and 26 rules with 11 probes; shell 98 checks over 12 files; jobs 110 checks and 4 slots;
  migrations 483 checks; `Compiled successfully`. The route table is unchanged.
- No placeholder marker was added; every SQL and doc file is ASCII.

## Errors Found And Corrected In This STEP
1. **A comparison that was always false.** The platform scope assertion compared a Python `UUID`
   against a string and failed even though the value was right; the proof now compares against
   `uuid.UUID("00000000-...")`.
2. **A check that could not fail.** One probe asserted `... or True` while checking that an index
   exists; it was replaced by a planner probe with `enable_seqscan = off`, so the claim is now
   measured rather than assumed.
3. **A count written before it was measured.** The entitlement proof expected nine rows and asserted
   ten; the run reported nine and the expectation was corrected.
4. **A missing line break in the root README.** The STEP 017 bullet and the helper bullet were
   joined by an earlier edit; the same edit that added the STEP 018 bullet restored the break.

## Decisions And Limits Left For Later STEPs
- Plans are platform objects (`company_id` null). A merchant specific plan would be a decision and a
  new migration, not merely a row.
- The service catalogue lives in code. `plan_entitlements.service` checks shape only, so adding a
  seventh service needs no migration and the STEP that implements that service owns its name.
- One active price window per scope is a writing rule. An exclusion constraint would require
  `btree_gist`, and rule 9 forbids creating extensions, so the STEP that writes versions must
  retire the previous list and the schema contributes uniqueness on `(scope_id, effective_from)`.
- Reading prices from an override and falling back to the platform list is a query shape, not a
  constraint; the cross-table proof shows the intended query, and the STEP that bills owns it.
- Every write to these tables must produce an audit entry through the writer of STEP 017; this STEP
  supplies the state, not the log.
- RLS stays default-deny until STEP 035 grants merchants their own plan and the office its catalogue.

## Next Chat Notes
- Next in this category is STEP 019 (subscriptions and subscription charges), which references
  `plans(id)`. It must not copy the price onto the subscription row when a price list can change;
  it should reference the plan and read the price list that is in force.
- `price_minor` and every fixed fee are minor units. Do not introduce a decimal or a float anywhere;
  the currency is a property of the row, not of the amount.
- `pricing_versions.scope_id` is generated, so a query that filters `company_id` alone will not use
  either uniqueness index. Filter by `scope_id` when asking for the price in force.
- The announcement check compares against `announced_at` only. A version prepared privately has no
  announcement and no restriction, which is deliberate; the STEP that publishes prices must set the
  announcement at publication time.
