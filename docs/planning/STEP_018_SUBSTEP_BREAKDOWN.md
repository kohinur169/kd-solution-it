// path: docs/planning/STEP_018_SUBSTEP_BREAKDOWN.md
# STEP 018 - Sub-Step Breakdown

Working notes taken before any SQL was written. The proof belongs in
`docs/handoffs/STEP_018_COMPLETED.md`.

## 1. Scope Confirmed From The Source Documents

### STEP 018 as written in docs/final/STEP_PLAN_250.md
- Title: "Migration for plans, plan entitlements and pricing versions tables".
- Category: Database Schema and Row Level Security (STEP 012-036). A database STEP owns only its
  numbered migration files and the migrations index.
- Neighbours: STEP 019 owns subscriptions and subscription charges, which will reference a plan;
  STEP 023 owns provider keys and routing; the invoice and payment STEPs read `pricing_versions`.
  None of them creates these three tables.

### Feature list lines that fix the shape
- Section 9, Plans and Entitlements: "super_admin creates plans: name, price, period and which
  services each plan includes"; "Sub-merchants use the services included in their plan, such as
  invoicing, payment links, recurring invoices, public API and store connections, and test mode";
  "Services outside the plan are not usable by that merchant."
- Section 12, Platform Subscription Billing: a subscription is charged from the merchant balance and
  then from a saved card, which is why a plan needs a price and a billing period that never change
  underneath a running subscription.
- Section 14, Public Pricing: "The public Pricing page shows the full detailed price list: platform
  fee, processor fees, payout fees, chargeback fees and refund fees, and who pays each"; "A new
  price is announced 30 days before it becomes effective. Every pricing version is kept with its
  effective date."
- Section 10 of the same list names a platform fee percent that is set globally and per
  sub-merchant when needed, which is why a pricing version carries a company scope.
- Every table carries id UUID v7, company_id, created_at, updated_at, deleted_at, version, with RLS
  enabled and a default-deny policy; money is stored in minor units with an explicit currency, never
  as a floating point number.

### What exists today (measured before coding)
- Thirteen proven migrations (`0001`-`0013`) and 393 gate checks over thirteen tables.
- Nothing prices anything yet: there is no plan, no entitlement and no fee schedule. `companies` is
  the tenant root, `role_assignments` gives the office a `super_admin`, and STEP 016/017 give the
  audit trail that a price change must produce.

## 2. Design Decisions Taken Before Coding

1. **Three tables, three migrations.** `0014_plans.sql`, `0015_plan_entitlements.sql`,
   `0016_pricing_versions.sql`, the second referencing the first. Rollback runs in reverse order and
   each table has its own proof.
2. **A plan is a platform object.** `company_id` is null on every plan row, because section 9 says
   super_admin creates plans for the platform; the column exists because every table carries it and
   because a future tenant-specific plan would need it. The plan's stable identity is `code`, a
   lower case slug that code can branch on, and `code` is unique.
3. **A plan is priced in minor units.** `price_minor bigint` with a `currency` of three upper case
   letters, never a float. The billing period is one of `monthly` or `yearly`, a closed vocabulary,
   and the price and the period are immutable in practice: a new price is a new plan or a new
   pricing version, not an edit of a running subscription's plan.
4. **A plan is a draft until it is published.** `status` moves through `draft`, `active` and
   `retired`, and `published_at` records when it became visible. A retired plan is not deleted: the
   subscriptions that reference it must stay explainable.
5. **An entitlement is a row, not a boolean column per service.** `plan_entitlements` holds one row
   for each service a plan includes, unique per plan and service, so adding a service to a plan is a
   row, removing it is a revocation, and "which plans include invoicing" is a query rather than a
   schema change.
6. **The service catalog lives in code.** `service` is a lower snake key such as `invoicing`,
   `payment_links`, `recurring_invoices`, `public_api`, `store_connections` or `test_mode`, checked
   for shape only, exactly like the permission keys of STEP 014. The six names in section 9 are the
   first entries of that catalog, not a check constraint that a seventh service would need a
   migration to extend.
7. **A pricing version is a whole price list, versioned by revision.** `revision` counts up per
   scope, and the row carries the five fees section 14 names, each with its own amount and its own
   payer: `platform`, `processor`, `payout`, `chargeback` and `refund`. Percentages are basis points
   (`0` to `10000`), fixed amounts are minor units, so nothing is ever a float.
8. **Pricing has a scope, enforced by a generated column.** `scope_id` is
   `coalesce(company_id, '00000000-0000-0000-0000-000000000000')`, so the platform price list
   (company_id null) and a merchant specific override are separate version lines, and the same
   `audited` pattern as the audit chain is reused. Uniqueness is `(scope_id, revision)` and
   `(scope_id, effective_from)`.
9. **The thirty day rule is a constraint.** `announced_at` is when a price is published to
   merchants and `effective_from` is when it applies; a check requires
   `effective_from >= announced_at + interval '30 days'` whenever `announced_at` is set. A draft
   version has no announcement yet, so the check stands aside until the announcement exists.
10. **A version can be retired, never rewritten.** `retired_at` marks the end of a version's life
    and is checked to be at or after `effective_from`. Overlapping windows are not expressible as a
    constraint without an exclusion constraint and the `btree_gist` extension, and this folder
    forbids creating extensions, so the rule "one active window per scope" is stated here and
    enforced by the STEP that writes versions, with `(scope_id, effective_from)` uniqueness as the
    schema's contribution.
11. **RLS on, default deny, nothing forced**, as on the previous thirteen tables. STEP 035 grants
    merchants read access to their own plan and office roles write access to plans and prices.
12. **No new function and no extension.** The helpers from `0001` are reused; the pricing scope uses
    a generated column, not a trigger.

## 3. The Schema This Produces

`public.plans`

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | primary key, default `uuid_generate_v7()` |
| company_id | uuid | null on every plan today; the platform owns plans |
| code | text | unique lower case slug, 2 to 39 characters |
| name | text | 1 to 80 characters, trimmed |
| price_minor | bigint | not null, never negative, minor units |
| currency | text | three upper case letters |
| period | text | `monthly` or `yearly` |
| status | text | `draft`, `active` or `retired` |
| published_at | timestamptz | null while the plan is a draft |
| sort_order | integer | display order, never negative |
| created_at, updated_at, deleted_at, version | audit set | as everywhere else |

`public.plan_entitlements`

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | primary key, default `uuid_generate_v7()` |
| company_id | uuid | null, following the plan |
| plan_id | uuid | not null, references `plans(id)` |
| service | text | lower snake key, at most 48 characters |
| created_at, updated_at, deleted_at, version | audit set | as everywhere else |

Unique live pair `(plan_id, service)`, so a plan cannot include one service twice.

`public.pricing_versions`

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | primary key, default `uuid_generate_v7()` |
| company_id | uuid | null for the platform price list, otherwise a merchant override |
| scope_id | uuid | generated, `coalesce(company_id, 00000000-0000-0000-0000-000000000000)` |
| revision | bigint | not null, greater than zero, unique per scope |
| currency | text | three upper case letters |
| platform_fee_bps | integer | 0 to 10000 |
| platform_fee_payer | text | `merchant`, `platform` or `customer` |
| processor_fee_bps | integer | 0 to 10000 |
| processor_fee_fixed_minor | bigint | never negative |
| processor_fee_payer | text | same vocabulary |
| payout_fee_fixed_minor | bigint | never negative |
| payout_fee_payer | text | same vocabulary |
| chargeback_fee_fixed_minor | bigint | never negative |
| chargeback_fee_payer | text | same vocabulary |
| refund_fee_fixed_minor | bigint | never negative |
| refund_fee_payer | text | same vocabulary |
| announced_at | timestamptz | null while the version is a draft |
| effective_from | timestamptz | not null, at least thirty days after `announced_at` |
| retired_at | timestamptz | null while the version is current, never before `effective_from` |
| created_at, updated_at, deleted_at, version | audit set | as everywhere else |

## 4. The Five Sub-Steps

Each sub-step ends with its own proof and a request for the owner's approval.

### 018.1 - Inventory, decisions and ownership (this document)
Read sections 9, 10, 12 and 14, the gate's own rules, the STEP 017 handoff and the thirteen existing
migrations; measure what exists; fix the schema above. No code.

### 018.2 - `0014_plans.sql` and its rollback
Create the plan table with its five indexes, trigger, RLS and default-deny policy, plus comments.
Proof on PostgreSQL 16.2: forward apply on a database that has `0001`-`0013`; a draft plan and a
published plan; a duplicate code refused by the unique index; an upper case code, a padded name, a
negative price, a two letter currency, an unknown billing period and an unknown status each refused
by name; the trigger moving the version; the rollback removing only its table.

### 018.3 - `0015_plan_entitlements.sql` and its rollback
Create the entitlement table, its unique live pair index and its service index, trigger, RLS and
policy. Proof: the six services of section 9 attached to one plan; the same service twice refused;
an unknown plan refused by the foreign key; a malformed service key refused; "which plans include
invoicing" answered by the index; a service removed by revocation and re-added later; rollback
leaving `plans` intact.

### 018.4 - `0016_pricing_versions.sql`, its rollback and the cross-table proof
Create the pricing table with its checks, both uniqueness indexes, trigger, RLS and policy. Proof:
revision one for the platform scope and revision one for a merchant scope coexist; a duplicate
revision and a duplicate effective instant refused; a price announced and effective in fourteen days
refused; a price effective exactly thirty days later accepted; a retired instant before the
effective instant refused; a basis point above 10000 refused; a negative fixed fee refused; an
unknown payer refused; a plan with its entitlements and a pricing version used together in one
reading query; RLS on all three tables; all sixteen migrations rolled back in reverse and re-applied
on a fresh database; the gate and its mutation probes.

### 018.5 - Documentation, full verification, commit and handoff
Update `migrations/README.md` and the root README database section, run `npm run verify`, write
`docs/handoffs/STEP_018_COMPLETED.md`, commit as "STEP 018: Migration for plans, plan entitlements
and pricing versions tables", push, and stop.

## 5. Files This STEP Owns

| Path | Action |
| --- | --- |
| migrations/0014_plans.sql, .down.sql | created in 018.2 |
| migrations/0015_plan_entitlements.sql, .down.sql | created in 018.3 |
| migrations/0016_pricing_versions.sql, .down.sql | created in 018.4 |
| migrations/README.md (the migrations index) | modified in 018.5 |
| README.md (the database section) | modified in 018.5 |
| docs/planning/STEP_018_SUBSTEP_BREAKDOWN.md | this document |
| docs/handoffs/STEP_018_COMPLETED.md | created in 018.5 |

No `package.json` change: the migrations gate already covers new files.

Not owned here, therefore untouched: every `lib/` module, `config/`, the environment contract,
migrations `0001`-`0013`, subscriptions and their charges (019), the public pricing page and its UI,
the service catalog in code, the permissive RLS policies (035), the audit writer, and every code
STEP.

## 6. Open Points The Owner May Want To Change

1. **The fee schedule is typed columns, not rows.** Five fees, each with an amount and a payer, fit
   section 14 exactly and keep the table queryable and checkable. A `pricing_version_fees` child
   table would be more extensible but is a fourth table this STEP's title does not name.
2. **Plans are platform wide** (`company_id` null), because section 9 gives plan creation to
   super_admin only. A merchant specific plan would need a new decision, not just a row.
3. **The thirty day announcement is a check on `announced_at`**, so a draft version can exist
   without one. The alternative is to require the announcement at insert, which would forbid
   preparing a price list privately.
