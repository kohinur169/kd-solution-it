-- path: migrations/0085_login_attempt_factor_idx.sql
-- STEP 045 - the index behind the lock counter of section 22.
--
-- "Login lock: 2 consecutive failed password or failed 2FA attempts lock the account for 2 hours."
-- The counter is not a column anywhere: it is a query over `login_attempts`, and `0011` says so in
-- its own table comment. STEP 045 makes that query on every failed password and every failed code,
-- which is exactly the moment the platform can least afford a table scan, so the query gets an index
-- of its own shape: one account, one factor, newest first.
--
-- `login_attempts_user_idx` of `0011` is `(user_id, created_at desc)` - right for "the last attempts
-- of this account" and wrong for the streak, which is per factor. Postgres can walk that index and
-- filter `factor` row by row, but the filter then decides how much of the index the query reads, and
-- the seventh row of a password streak is not a place to spend an undecided amount of work. The
-- three column index answers the streak in one bounded range on the leading two columns.
--
-- A partial index, like the four in `0011`: an attempt with no account (an address the platform has
-- no row for) can never lock anything, so it has no business in the index.
--
-- No table and no column is added. `0012` already models the lock itself - one row per lock, a two
-- hour ceiling in a check, a live key, the owner alert instant and the two ways a lock closes - so
-- STEP 045 stores state in the table STEP 016 built rather than inventing a second one.

begin;

create index login_attempts_factor_streak_idx
  on public.login_attempts (user_id, factor, created_at desc)
  where user_id is not null and deleted_at is null;

comment on index public.login_attempts_factor_streak_idx is
  'The consecutive failure streak of one account and one factor, newest first. Read by the login lock of STEP 045.';

commit;
