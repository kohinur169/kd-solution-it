-- path: migrations/0085_login_attempt_factor_idx.down.sql
-- STEP 045 - rollback for 0085_login_attempt_factor_idx.sql.
--
-- Drops the streak index and nothing else. An index carries no data of its own, so the rollback
-- loses neither an attempt nor a lock: after it runs, the counter query of `lib/auth/locks.ts` still
-- answers correctly and simply reads `login_attempts_user_idx` the way `0011` intended.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop index if exists public.login_attempts_factor_streak_idx;

commit;
