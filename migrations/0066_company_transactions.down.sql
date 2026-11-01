-- path: migrations/0066_company_transactions.down.sql
-- STEP 032 - the rollback of the company transactions table: the guard function and the table,
-- in one transaction.

begin;

drop table if exists public.company_transactions;

drop function if exists public.company_transactions_guard_state();

commit;
