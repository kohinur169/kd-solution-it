-- path: migrations/0041_ledger_entries.down.sql
-- STEP 025 - rollback for 0041_ledger_entries.sql.
--
-- Drops the entry table and everything it owns: twenty constraints, six indexes, the policy, the
-- four row triggers and the deferred balance constraint trigger, then the five functions this file
-- created. It runs before the chart rollback, because every entry points at an account.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.ledger_entries;

drop function if exists public.ledger_entries_check_balance();

drop function if exists public.ledger_entries_sync_invoice();

drop function if exists public.ledger_entries_guard_reversal();

drop function if exists public.ledger_entries_guard_account();

drop function if exists public.ledger_entries_guard_append_only();

commit;
