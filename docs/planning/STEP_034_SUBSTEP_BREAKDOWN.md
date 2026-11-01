// path: docs/planning/STEP_034_SUBSTEP_BREAKDOWN.md
# STEP 034 - Sub-Step Breakdown

This document is sub-step 034.1. It reads the plan, the feature list, the master prompt and the
STEP 033 handoff, measures the money and ledger tables, fixes what "batch two" means, fixes
which command a merchant session may run on each table, and then stops for the owner's
permission before any SQL is written. The proof belongs in
`docs/handoffs/STEP_034_COMPLETED.md`.

## 1. Scope Confirmed From The Source Documents

### STEP 034 as written in docs/final/STEP_PLAN_250.md
- Title: "RLS default-deny policies for payment and ledger tables batch two".
- Category: Database Schema and Row Level Security (STEP 012-036). A database STEP owns only its
  numbered migration files and the migrations index; no `lib/`, `app/` or `services/` file.
- Neighbours: STEP 033 finished the merchant's own business record and left the money to this
  STEP; STEP 035 takes the office, per-person, secret holding and platform tables and the audit
  chain; STEP 037 creates the Supabase Auth client that feeds the two functions of `0069`.
- The plan's own sub-steps 4 to 7 (service, API, UI, security review) do not apply to a policy
  STEP: there is no surface to build, and the security review is the proof itself.

### The rules that fix the shape
- `docs/final/MASTER_PROMPT.md` rule 8: "RLS is enabled with a default-deny policy on every
  table." Rule 12: every payment carries an idempotency key.
- `migrations/README.md` rule 8: the deny is never removed, a STEP adds a permissive policy
  beside it. Rule 49, written in STEP 033: a tenant policy reads
  `public.current_actor_company_id()` in `using` and `with check`, and the column it reads
  starts an index. Rule 50: the actor is identified only by the two functions of `0069`.
- FEATURE_LIST section 10 (fee, settlement, reserve, payout), 11 (double-entry ledger: "Ledger
  entries are never edited or deleted"), 12 (subscription billing), 17 (statements), 18 (card
  security) and 19 (refunds and disputes: "Refund interface: request", "The merchant writes the
  dispute response and supplies the required documents").
- Section 11 also says "Merchants see their balance and every entry detail", so the ledger is
  read by the merchant, not only by the office.

### What exists today (measured before writing this document)
- 70 migrations, 67 tables, 89 policies, 67 functions, 275 indexes, 126 triggers in `public`;
  `npm run check:migrations` passes 2140 checks.
- 45 tables still carry the deny alone. 13 of them are the money and ledger tables this STEP
  takes; the other 32 are listed in section 6.
- Every one of the 13 has a `company_id`; 12 are `NOT NULL` and `ledger_accounts` allows null,
  because the platform's own chart of accounts has no merchant, and
  `ledger_accounts_platform_code_key` is the partial unique index over exactly those rows.
- The 13 tables already carry between three and seven indexes, but only three of them carry one
  a bare `company_id = $1` predicate can use: `payments_page_idx`, `disputes_payment_idx` and
  `ledger_entries_statement_idx`. The rest are partial and keyed on a status or on
  `deleted_at is null`, and a partial index whose predicate the query does not imply cannot be
  used by the tenant predicate.

## 2. Decisions This STEP Makes

1. **Batch two is the 13 tables that hold a merchant's money.** `payments`, `refunds`,
   `disputes`, `ledger_accounts`, `ledger_entries`, `settlements`, `holds`, `reserves`,
   `payouts`, `payout_bank_accounts`, `bank_change_requests`, `subscriptions` and
   `subscription_charges`. Each row is money the merchant received, owes, has held, has
   reserved, was paid or is billed for, or the ledger that records it, or a document the
   merchant authors about its own money. A table that decides how a payment is routed, or that
   only the office reads, stays out and is named in section 6.
2. **A read is tenant-scoped and nothing more.** Every one of the 13 gets
   `<table>_tenant_select`, `as permissive`, `for select`, `to public`, `using (company_id =
   public.current_actor_company_id())`. `ledger_accounts` needs no special case: the platform's
   own accounts carry a null `company_id`, a null never equals a company, so they stay invisible
   to every merchant without a second predicate.
3. **A write is granted only where a feature list sentence gives it to the merchant, and the
   granted write is pinned to the state a merchant may create.** Three tables get an insert -
   `refunds` (section 19, "Refund interface: request"), `payout_bank_accounts` (section 10,
   "Merchants add a payout bank account") and `bank_change_requests` (section 10, a change needs
   manual verification first) - and each `with check` pins the opening state (`requested`,
   `pending`, `requested`), pins the requester to the actor, and refuses a row that already
   carries a decision instant.
   One table gets an update - `disputes` (section 19, "The merchant writes the dispute
   response") - and its `using` accepts only an open row while its `with check` accepts only a
   row that is still open and carries no submission or resolution instant. A merchant session
   can therefore not approve a refund, verify a bank account, activate a bank change or resolve
   a dispute, which are the four escalations this shape exists to stop.
4. **The other nine tables are read-only for a merchant session.** A payment, a settlement, a
   hold, a reserve, a payout, a ledger account, a ledger entry, a subscription and a
   subscription charge are written by the service - the processor webhook, the settlement job,
   the billing job, the office decision - and the service reaches them with the table owner or
   the service role, which bypasses RLS. Writing money from a browser session is not a feature
   any list asks for, and granting it would let a guard designed to validate a transition be
   driven by the party that benefits from it.
5. **No delete is granted anywhere.** Section 11 says ledger entries are never edited or
   deleted, and the other money tables carry a soft delete that only the service performs. The
   13 select policies leave update and delete to `<table>_default_deny`, so a merchant session
   is refused by RLS itself rather than by a guard message.
6. **The policy names follow the command.** `<table>_tenant_select`, `<table>_tenant_insert`,
   `<table>_tenant_update`. STEP 033 used one `_tenant_isolation` policy per table because a
   merchant owns its clients outright; a money row is read by one party and written by another,
   and a name that says which command it grants keeps the next reader from assuming `for all`.
7. **Ten plain indexes are added.** `refunds`, `ledger_accounts`, `settlements`, `holds`,
   `reserves`, `payouts`, `payout_bank_accounts`, `bank_change_requests`, `subscriptions` and
   `subscription_charges` get `<table>_company_idx` on `(company_id)`. The existing partial
   indexes stay: they serve the queues and the pages, and the new one serves the predicate every
   policy now applies. The three tables that already have a usable index get none.
8. **No new helper function and no new setting.** `0069` already answers "who is asking" and
   "which company". `public.current_actor_id()` is read a second time, by the three insert
   policies, to pin `requested_by` to the caller.
9. **No role is named and nothing is forced.** Every policy is `to public`, so `support`,
   `blogger`, `finance_ops` and the rest are decided by STEP 035 on top of this layer, and
   `force row level security` stays off, so the owner and the service role can still migrate,
   post a ledger entry and settle a batch.
10. **The deny is untouched.** No file in this STEP drops, alters or replaces
    `<table>_default_deny`; the rollback drops only the 17 policies and the 10 indexes this
    STEP adds.

## 3. The Policies This STEP Produces

| Table | Policies | Command | Predicate |
| --- | --- | --- | --- |
| payments | `_tenant_select` | select | `company_id` is the actor's company |
| refunds | `_tenant_select`, `_tenant_insert` | select, insert | company, and on insert `status = 'requested'` and `requested_by` is the actor |
| disputes | `_tenant_select`, `_tenant_update` | select, update | company, and the row is `open` or `under_review` with no submission |
| ledger_accounts | `_tenant_select` | select | company; platform rows carry null and stay hidden |
| ledger_entries | `_tenant_select` | select | company |
| settlements | `_tenant_select` | select | company |
| holds | `_tenant_select` | select | company |
| reserves | `_tenant_select` | select | company |
| payouts | `_tenant_select` | select | company |
| payout_bank_accounts | `_tenant_select`, `_tenant_insert` | select, insert | company, and on insert `status = 'pending'` with no verifier |
| bank_change_requests | `_tenant_select`, `_tenant_insert` | select, insert | company, and on insert `status = 'requested'` by the actor |
| subscriptions | `_tenant_select` | select | company |
| subscription_charges | `_tenant_select` | select | company |

Seventeen policies in all: thirteen selects, three inserts and one update, beside the thirteen
denies that stay in place. Ten indexes are added, so the measured schema after this STEP should
read 71 migrations, 67 tables, 106 policies, 67 functions, 285 indexes and 126 triggers - the
numbers are targets, and the handoff records what the catalog actually says.

## 4. The Sub-Steps

1. **034.1 The breakdown.** This document: scope from the sources, the 13 tables, the command
   each one grants, the ten indexes, the exclusions, and the risks. Stops for permission.
2. **034.2 The migration.** `0071_payment_ledger_policies.sql` with its `.down.sql`: the 17
   policies and the 10 indexes, the gate after the file.
3. **034.3 The proof.** Two merchants, a suspended person and an anonymous caller, the read
   isolation per table, the pinning of each granted insert, the dispute update envelope, the
   refusal of update and delete on the nine read-only tables, the platform ledger accounts
   staying hidden, the service write still working, and the rollback and second apply.
4. **034.4 The documents and the commit.** The two rows and the new rule in
   `migrations/README.md`, the root `README.md` bullet, the whole 71 file forward and reverse
   chain, `npm run verify`, one commit and one handoff.

## 5. Files This STEP Owns

- `migrations/0071_payment_ledger_policies.sql` and `migrations/0071_...down.sql`.
- `migrations/README.md` (two inventory rows, one new rule, the numbering rule moved).
- `docs/planning/STEP_034_SUBSTEP_BREAKDOWN.md`, `docs/handoffs/STEP_034_COMPLETED.md`.
- The database section of the root `README.md`, one bullet.
- Not touched: `0001` to `0070`, `lib/`, `app/`, `services/`, `config/`, `package.json`,
  `.env.example` and `migrations/verify.ts`.

## 6. What This STEP Deliberately Leaves Out

1. **The 32 tables of STEP 035.** Every table still on the deny alone after this STEP is one of:
   `account_locks`, `announcement_dismissals`, `announcements`, `audit_logs`, `blog_posts`,
   `card_blacklist`, `cms_pages`, `company_transactions`, `compliance_items`, `delegations`,
   `device_proof_keys`, `email_send_logs`, `email_settings`, `email_templates`,
   `idempotency_keys`, `job_queue`, `login_attempts`, `merchant_api_credentials`,
   `office_permissions`, `payment_providers`, `plan_entitlements`, `plans`, `pricing_versions`,
   `processor_bills`, `provider_keys`, `role_assignments`, `routing_rules`, `sessions`,
   `store_connections`, `taxcloud_connections`, `velocity_counters` and `webhook_events`.
2. **The payment machinery a merchant never reads.** `idempotency_keys`, `webhook_events` and
   `velocity_counters` are about a payment, but the row is the platform's own bookkeeping: the
   API route, the webhook worker and the fraud screen read them, and no merchant screen does.
   Giving a merchant session a policy on them would be a grant with no feature behind it, so
   they keep the deny and STEP 035 decides whether an office role needs one.
3. **The office roles.** `finance_ops` reading a payout, `compliance_kyc` reading a dispute,
   `support` reading a payment: every one of those is a role rule with a permission behind it,
   and STEP 035 owns the role policies and the audit chain.
4. **Who inside a company may read money.** This STEP says "this money is my company's"; the
   office permissions of STEP 005 say whether a viewer, an accountant or only the owner sees it.
5. **Column level rules.** `payout_bank_accounts` carries the account number as ciphertext and
   four visible digits; a merchant that owns the row may read its own ciphertext, which is
   useless without the key, and hiding the column from one role is a view or a grant, not RLS.
6. **`CONCURRENTLY` and the production ordering.** The ten indexes are plain, because the
   schema is still built forward from `0001`; a live table would need
   `create index concurrently` outside the migration transaction, and section 7 records that.
7. **The code that sets the setting.** STEP 037 builds the Supabase client and the typed
   session access this layer waits for.

## 7. Risks To Prove In 034.2 And 034.3

1. **A granted write is an escalation if the state is not pinned.** The proof inserts a refund
   as the merchant, then tries a refund that is already `approved`, a bank account that is
   already `active`, a bank change that is already `cooling` and a refund naming another person
   as `requested_by`; each must be refused by the policy, not by a check.
2. **`with check` sees only the new row.** The dispute update is bounded on both sides: an
   update of a `won` row must not match `using`, and an update that sets `submitted_at` or the
   status to `evidence_submitted` must fail `with check`. Both are proven separately.
3. **A partial index cannot serve a bare predicate.** The proof reads `pg_index` and asserts
   that each of the 13 now has an index whose predicate is null or mentions only `company_id`,
   which is the property the tenant predicate needs, and that the ten new definitions are on
   `(company_id)`.
4. **The service must still write.** After the policies are in place the proof writes a payment,
   a ledger entry pair, a settlement and a hold as the table owner, and the ledger balance check
   still commits, which proves nothing in this STEP narrowed the service.
5. **A delete must be refused by RLS, not by a guard.** The proof deletes a refund and a ledger
   entry as the merchant and expects the row level security message, and deletes the same ledger
   entry as the owner and expects the append-only guard's message, so the two gates are shown
   to be the ones that speak.
6. **The counts.** Every number in the handoff is measured from the catalog in 034.4, never
   predicted from this document.

## 8. The File Of 034.2

1. **`0071_payment_ledger_policies.sql`** creates the 17 policies of section 3 and the ten
   indexes of decision 7, and nothing else: thirteen selects, three inserts and one update, each
   `as permissive` and `to public`, beside the thirteen denies it does not touch. The inserts
   pin `status` and the requester; the update pins the open envelope on both sides. The indexes
   are named `<table>_tenant_idx` because `subscription_charges_company_idx` already existed as
   a partial index over `(company_id, created_at)`.
2. **The rollback** drops the 17 policies and the 10 indexes in one transaction, before the
   rollback of `0069` can drop the functions they read.
3. **The measurement after the file**, on a clean database with `0001` to `0071` applied: the
   gate passes with 2160 checks over 71 migrations and 67 tables, and the catalog holds 67
   tables, 106 policies, 67 functions, 285 indexes and 126 triggers. By command the tenant
   policies are 22 `for all` from `0070`, 13 `select`, 3 `insert` and 1 `update`; ten of the
   thirteen tables carry two policies and the three with a granted write carry three.

## 9. The 034.3 Proof

1. **The method.** A fresh database takes `0001` to `0071`, the fixture writes two companies,
   three people (one suspended), one processor, one plan, two payments, four ledger accounts
   (two per merchant) plus one platform account, two balanced ledger pairs, two settlements, two
   holds, two reserves, two payouts, two bank accounts, two bank change requests, two
   subscriptions, two subscription charges, three disputes and two refunds, all as the owner.
   Every request afterwards is spoken by `proof_app`, a `nologin` role with no `bypassrls`. The
   script asserts 47 checks and every one passed.
2. **Reads.** Each of the 13 tables answers for its own company and for the other merchant
   exactly its own count, a foreign payment is invisible by its id, and the platform ledger
   account with a null `company_id` is invisible to both merchants although the owner still sees
   it. A suspended person and an anonymous caller read zero rows of every table.
3. **The granted writes.** A merchant inserts a `requested` refund and a `pending` bank account
   and is refused an `approved` refund, a refund naming another person, a bank account that is
   already `active` and a change that is already `cooling`, each with "new row violates
   row-level security policy". It writes the response of its own open dispute, is refused when
   the same update carries `submitted_at` and the `evidence_submitted` status, touches zero rows
   of a resolved dispute, and another merchant touches zero rows of the first one's.
4. **Nothing else is granted.** An update of a payment, a settlement, a payout or a bank account
   and a delete of a payment, a ledger entry, a refund or a hold each affect zero rows, because
   no update or delete policy exists and the deny is what is left; an insert of a payment is
   refused outright. The rows are still there afterwards, which is what the count proves.
5. **The service still writes.** The owner posts a balanced ledger pair after the policies exist
   and it commits, and the same role is refused a delete of that group by the append-only guard
   ("ledger entries are append only"), so the two gates are shown to be the ones that speak: RLS
   for the merchant, the guard for the service. The service also settles a batch.
6. **The catalog.** 17 policies over the 13 tables, 13 selects, 3 inserts, 1 update, no delete
   policy anywhere, all 67 deny policies still `using (false)` and `with check (false)`, an
   index a bare `company_id = $1` can use for every one of the 13 (the query accepts only a null
   predicate or `company_id is not null`), and the ten new definitions on `(company_id)`.
7. **The rollback and the second apply.** The `0071` rollback returns the schema to 89 policies
   and 275 indexes and the merchant then sees zero payments; applying the file again returns 106
   policies and 285 indexes and the payment is visible again.
8. **Two observations recorded, not changed.** A refund that names another company's payment is
   refused by the guard of `0038` with "a refund names a payment that exists" rather than by the
   policy, because the payment is invisible to the caller and the lookup fails closed; that is
   the same shape STEP 032 proved for the ticket opener. And a second open bank change request
   is refused by `bank_change_requests_open_key`, the table's own rule, before the policy is
   asked.
