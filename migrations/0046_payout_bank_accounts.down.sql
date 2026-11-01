-- path: migrations/0046_payout_bank_accounts.down.sql
-- STEP 027 - rollback for 0046_payout_bank_accounts.sql.
--
-- Removes the payout column and its index first, because the foreign key points at the account table,
-- then drops the account table with its constraints, indexes, policy and two triggers, and finally the
-- guard this file created. It runs after the change request rollback, which points at an account.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

alter table public.payouts drop column if exists bank_account_id;

drop table if exists public.payout_bank_accounts;

drop function if exists public.payout_bank_accounts_guard_state();

commit;
