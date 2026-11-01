-- path: migrations/0089_session_rotation.down.sql
-- STEP 051 - rollback for 0089_session_rotation.sql.
--
-- Removes the absolute ceiling and the partial family index. Every session row stays as it is,
-- including its rotation history: the rollback drops a rule and an index, never evidence. A row
-- written with the ceiling keeps its `absolute_expires_at` value in the column this file removes,
-- which is why the column goes first and nothing reads it afterwards.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop index if exists public.sessions_family_live_idx;

alter table public.sessions
  drop constraint if exists sessions_absolute_expiry_check;

alter table public.sessions
  drop column if exists absolute_expires_at;

commit;
