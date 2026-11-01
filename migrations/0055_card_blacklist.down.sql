-- path: migrations/0055_card_blacklist.down.sql
-- STEP 030 - rollback for 0055_card_blacklist.sql.
--
-- Drops the blacklist table with its constraints, indexes, policy and two triggers, then the guard
-- this file created.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.card_blacklist;

drop function if exists public.card_blacklist_guard_state();

commit;
