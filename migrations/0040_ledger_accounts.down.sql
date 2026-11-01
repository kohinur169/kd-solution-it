-- path: migrations/0040_ledger_accounts.down.sql
-- STEP 025 - rollback for 0040_ledger_accounts.sql.
--
-- Drops the chart of accounts and everything it owns: twelve constraints, three indexes, the policy
-- and the two triggers, then the chart guard function this file created. It runs after the entry
-- rollback, because every entry points at an account.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.ledger_accounts;

drop function if exists public.ledger_accounts_guard_chart();

commit;
