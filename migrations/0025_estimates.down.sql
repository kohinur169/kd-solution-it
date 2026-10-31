-- path: migrations/0025_estimates.down.sql
-- STEP 022 - rollback for 0025_estimates.sql.
--
-- Drops the quote table and everything it owns: twenty six constraints, seven indexes, the policy
-- and the three triggers, then the terminal guard function this file created. The total trigger it
-- borrows belongs to STEP 021 and is left alone.
--
-- It must run after the signature, line and schedule rollbacks, because those point at this table,
-- and before the invoice rollback, because a quote references the invoice it became.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.estimates;

drop function if exists public.estimates_guard_terminal();

commit;
