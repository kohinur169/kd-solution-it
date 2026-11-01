-- path: migrations/0087_account_lock_unlock_record.sql
-- STEP 047 - an office unlock has to say what was verified.
--
-- Section 22: "Unlock is done only by an office role with unlock permission and only after contact
-- with the owner is confirmed by email. Every unlock is audit logged." `0012` already refuses an
-- unlock without `owner_contact_confirmed_at`, and the audit chain records the act. What it still
-- allowed is an unlock that names nobody and nothing: `unlock_note` was optional, so a lock could be
-- closed with `unlocked_at` and `unlocked_by` set and an empty record of what the officer checked.
--
-- This constraint closes that hole at the level the platform can enforce. A row that says a person
-- ended the lock must carry that person's note, so "every unlock is audit logged" has a second
-- witness in the table itself - one that survives a code path nobody has written yet.
--
-- The constraint is added `not valid` and then validated, which is the one way to add a rule to a
-- live table without locking it for the duration of a scan. Nothing writes `unlocked_at` before
-- STEP 047, so a fresh database validates in one pass; a database where somebody closed a lock by
-- hand without a note fails the validation loudly instead of accepting a rule it does not meet.

begin;

alter table public.account_locks
  add constraint account_locks_unlock_record_check check (
    unlocked_at is null or unlock_note is not null
  ) not valid;

alter table public.account_locks validate constraint account_locks_unlock_record_check;

comment on constraint account_locks_unlock_record_check on public.account_locks is
  'An office unlock carries the note of what the officer verified. The clock closes locks instead.';

commit;
