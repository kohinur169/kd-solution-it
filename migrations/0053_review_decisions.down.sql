-- path: migrations/0053_review_decisions.down.sql
-- STEP 028 - rollback for 0053_review_decisions.sql.
--
-- Drops the decision table with its constraints, indexes, policy and two triggers, then the guard
-- this file created. It runs first among the rollbacks of this sub-step, because the table points
-- at itself.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.review_decisions;

drop function if exists public.review_decisions_guard_state();

commit;
