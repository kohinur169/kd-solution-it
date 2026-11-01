-- path: migrations/0012_account_locks.down.sql
-- STEP 016 - rollback for 0012_account_locks.sql.
--
-- Drops the lock table and everything it owns: seventeen constraints, two indexes, the policy and
-- the row metadata trigger. The attempt record is created by 0011 and is dropped by its own
-- rollback; this table references `users` and `companies`, which stay untouched.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.account_locks;

commit;
