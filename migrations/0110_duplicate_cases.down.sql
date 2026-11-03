-- path: migrations/0110_duplicate_cases.down.sql
-- STEP 098 rollback of 0110: removes the duplicate case table with its indexes, its triggers, its
-- guard function and its policies.
--
-- `drop table` removes every case row, which is the point of the pair: the forward file creates the
-- compliance queue, the rollback returns the database to one with no case table. No other table
-- points at it by foreign key, so dropping it cannot break a row that exists.

begin;

drop table if exists public.duplicate_cases;

drop function if exists public.duplicate_cases_guard_state();

commit;
