-- path: migrations/0071_payment_ledger_policies.sql
-- STEP 034 - the tenant policy of batch two: the money tables, where one party reads and the
-- service writes.
--
-- `0070` gave the merchant's own business record a `for all` policy, because a merchant owns its
-- clients and its invoices outright. A money row is not that. A payment arrives from a processor
-- webhook, a settlement and a hold are posted by a job, a ledger entry is written by the service
-- inside the transaction that balances it, and an office decision approves a refund, verifies a
-- bank account or resolves a dispute. Granting `for all` here would let a browser session drive a
-- guard written to validate a transition, not to answer who is calling.
--
-- So this file grants per command, and only where FEATURE_LIST says the merchant acts:
--
--   * every one of the 13 tables gets `<table>_tenant_select`, so section 11's "merchants see
--     their balance and every entry detail" and the statements of section 17 are readable;
--   * `refunds`, `payout_bank_accounts` and `bank_change_requests` get `<table>_tenant_insert`,
--     because section 19 says a refund is requested and section 10 says a merchant adds a payout
--     bank account and requests a change. Each one is pinned to its opening state and to the
--     actor as requester, so a merchant session cannot insert a refund that is already approved,
--     a bank account that is already verified or a change that is already cooling;
--   * `disputes` gets `<table>_tenant_update`, because section 19 says the merchant writes the
--     response and supplies the documents. `using` accepts only a row that is open, and
--     `with check` accepts only a row that is still open with no submission or resolution, so the
--     party that benefits from the dispute cannot resolve it.
--
-- Nothing else is granted. No update and no delete is granted on the other twelve tables, so RLS
-- itself refuses a merchant session that tries to edit a payment or remove a ledger entry, and
-- the append-only guard of `ledger_entries` keeps its own message for the service.
--
-- The platform's own chart of accounts lives in `ledger_accounts` with a null `company_id`, and a
-- null never equals a company, so those rows stay invisible to every merchant without a second
-- predicate. No role is named: `to public` leaves the office roles of STEP 035 on top of this.
--
-- Ten plain indexes are added at the end. The existing indexes of these tables are partial and
-- keyed on a status or on `deleted_at is null`, and a partial index whose predicate the query
-- does not imply cannot serve `company_id = $1`; `0070` measured the same gap on two tables. The
-- three tables that already carry a usable index - `payments`, `disputes` and `ledger_entries` -
-- get none.

begin;

create policy payments_tenant_select
  on public.payments
  as permissive
  for select
  to public
  using (company_id = public.current_actor_company_id());

create policy refunds_tenant_select
  on public.refunds
  as permissive
  for select
  to public
  using (company_id = public.current_actor_company_id());

create policy refunds_tenant_insert
  on public.refunds
  as permissive
  for insert
  to public
  with check (
    company_id = public.current_actor_company_id()
    and status = 'requested'
    and requested_by = public.current_actor_id()
  );

create policy disputes_tenant_select
  on public.disputes
  as permissive
  for select
  to public
  using (company_id = public.current_actor_company_id());

create policy disputes_tenant_update
  on public.disputes
  as permissive
  for update
  to public
  using (
    company_id = public.current_actor_company_id()
    and status in ('open', 'under_review')
  )
  with check (
    company_id = public.current_actor_company_id()
    and status in ('open', 'under_review')
    and submitted_at is null
    and resolved_at is null
  );

create policy ledger_accounts_tenant_select
  on public.ledger_accounts
  as permissive
  for select
  to public
  using (company_id = public.current_actor_company_id());

create policy ledger_entries_tenant_select
  on public.ledger_entries
  as permissive
  for select
  to public
  using (company_id = public.current_actor_company_id());

create policy settlements_tenant_select
  on public.settlements
  as permissive
  for select
  to public
  using (company_id = public.current_actor_company_id());

create policy holds_tenant_select
  on public.holds
  as permissive
  for select
  to public
  using (company_id = public.current_actor_company_id());

create policy reserves_tenant_select
  on public.reserves
  as permissive
  for select
  to public
  using (company_id = public.current_actor_company_id());

create policy payouts_tenant_select
  on public.payouts
  as permissive
  for select
  to public
  using (company_id = public.current_actor_company_id());

create policy payout_bank_accounts_tenant_select
  on public.payout_bank_accounts
  as permissive
  for select
  to public
  using (company_id = public.current_actor_company_id());

create policy payout_bank_accounts_tenant_insert
  on public.payout_bank_accounts
  as permissive
  for insert
  to public
  with check (
    company_id = public.current_actor_company_id()
    and status = 'pending'
    and verified_by is null
    and activated_at is null
    and retired_at is null
  );

create policy bank_change_requests_tenant_select
  on public.bank_change_requests
  as permissive
  for select
  to public
  using (company_id = public.current_actor_company_id());

create policy bank_change_requests_tenant_insert
  on public.bank_change_requests
  as permissive
  for insert
  to public
  with check (
    company_id = public.current_actor_company_id()
    and status = 'requested'
    and requested_by = public.current_actor_id()
    and verified_by is null
    and cooling_ends_at is null
  );

create policy subscriptions_tenant_select
  on public.subscriptions
  as permissive
  for select
  to public
  using (company_id = public.current_actor_company_id());

create policy subscription_charges_tenant_select
  on public.subscription_charges
  as permissive
  for select
  to public
  using (company_id = public.current_actor_company_id());

-- The ten tables whose company index was partial or absent. `subscription_charges` already has
-- a partial `_company_idx`, so these are named `_tenant_idx` after the policies they serve.
create index refunds_tenant_idx on public.refunds (company_id);

create index ledger_accounts_tenant_idx on public.ledger_accounts (company_id);

create index settlements_tenant_idx on public.settlements (company_id);

create index holds_tenant_idx on public.holds (company_id);

create index reserves_tenant_idx on public.reserves (company_id);

create index payouts_tenant_idx on public.payouts (company_id);

create index payout_bank_accounts_tenant_idx on public.payout_bank_accounts (company_id);

create index bank_change_requests_tenant_idx on public.bank_change_requests (company_id);

create index subscriptions_tenant_idx on public.subscriptions (company_id);

create index subscription_charges_tenant_idx on public.subscription_charges (company_id);

commit;
