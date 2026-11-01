-- path: migrations/0092_rate_limit_windows.down.sql
-- STEP 055 rollback of 0092: removes the counter function and then the table it moves.
--
-- The function goes first because it names the table; dropping the table under it would leave the
-- function broken for as long as both exist. No row anywhere else is touched, and the limits
-- themselves are code, so a rollback of this file means "authentication endpoints are no longer
-- counted", not "the platform lost a record of an attempt" - that record is `0011`'s and stays.

begin;

drop function if exists public.consume_rate_limit(text, text, integer, integer, timestamptz);

drop table if exists public.rate_limit_windows;

commit;
