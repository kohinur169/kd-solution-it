-- path: migrations/0006_delegations.down.sql
-- STEP 014 - rollback for 0006_delegations.sql.
--
-- Drops the delegation table and everything it owns: its constraints, the two live indexes, the
-- policy and the row metadata trigger. The permission table from 0005 stays, because a separate
-- migration created it and this rollback must not touch another migration's objects.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.delegations;

commit;
