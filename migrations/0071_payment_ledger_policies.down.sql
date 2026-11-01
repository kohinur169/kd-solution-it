-- path: migrations/0071_payment_ledger_policies.down.sql
-- STEP 034 - the rollback of batch two: the 17 policies and the 10 indexes this STEP added, in
-- one transaction, before the functions they read are dropped by the rollback of `0069`.

begin;

drop policy if exists subscription_charges_tenant_select
  on public.subscription_charges;

drop policy if exists subscriptions_tenant_select on public.subscriptions;

drop policy if exists bank_change_requests_tenant_insert on public.bank_change_requests;

drop policy if exists bank_change_requests_tenant_select on public.bank_change_requests;

drop policy if exists payout_bank_accounts_tenant_insert on public.payout_bank_accounts;

drop policy if exists payout_bank_accounts_tenant_select on public.payout_bank_accounts;

drop policy if exists payouts_tenant_select on public.payouts;

drop policy if exists reserves_tenant_select on public.reserves;

drop policy if exists holds_tenant_select on public.holds;

drop policy if exists settlements_tenant_select on public.settlements;

drop policy if exists ledger_entries_tenant_select on public.ledger_entries;

drop policy if exists ledger_accounts_tenant_select on public.ledger_accounts;

drop policy if exists disputes_tenant_update on public.disputes;

drop policy if exists disputes_tenant_select on public.disputes;

drop policy if exists refunds_tenant_insert on public.refunds;

drop policy if exists refunds_tenant_select on public.refunds;

drop policy if exists payments_tenant_select on public.payments;

drop index if exists public.refunds_tenant_idx;

drop index if exists public.ledger_accounts_tenant_idx;

drop index if exists public.settlements_tenant_idx;

drop index if exists public.holds_tenant_idx;

drop index if exists public.reserves_tenant_idx;

drop index if exists public.payouts_tenant_idx;

drop index if exists public.payout_bank_accounts_tenant_idx;

drop index if exists public.bank_change_requests_tenant_idx;

drop index if exists public.subscriptions_tenant_idx;

drop index if exists public.subscription_charges_tenant_idx;

commit;
