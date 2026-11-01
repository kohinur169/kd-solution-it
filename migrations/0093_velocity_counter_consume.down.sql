-- path: migrations/0093_velocity_counter_consume.down.sql
-- STEP 067 rollback of 0093: removes the counting function and leaves the table it moves in place.
--
-- The table is `0056`'s, not this file's, so the rollback of this file means "velocity is no longer
-- counted" and not "the record of a window is gone" - those rows are the evidence a decision was
-- made on, and `0056` retires them by a physical sweep, never by a rollback. Nothing else is
-- touched: no row, no index, no policy.

begin;

drop function if exists public.consume_velocity(text, text, inet, integer, integer, timestamptz);

commit;
