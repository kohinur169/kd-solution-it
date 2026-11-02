-- path: migrations/0087_account_lock_unlock_record.down.sql
-- STEP 047 - rollback for 0087_account_lock_unlock_record.sql.
--
-- Drops the rule that an unlock carries a note. Every row stays as it is, including the notes the
-- STEP wrote: the rollback removes a constraint, never evidence.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

alter table public.account_locks
  drop constraint if exists account_locks_unlock_record_check;

commit;
