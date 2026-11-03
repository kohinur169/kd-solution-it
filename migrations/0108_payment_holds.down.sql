-- path: migrations/0108_payment_holds.down.sql
-- STEP 092 rollback of 0108: removes the payment holds table with its indexes, its triggers, its
-- guard function and its policies.
--
-- `drop table` removes every hold row, which is the point of the pair: the forward file creates the
-- review queue, the rollback returns the database to one with no hold table. No other table points
-- at it by foreign key, so dropping it cannot break a row that exists.

begin;

drop table if exists public.payment_holds;

drop function if exists public.payment_holds_guard_state();

commit;
