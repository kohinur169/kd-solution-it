-- path: migrations/0091_sessions_reauthenticated_at.down.sql
-- STEP 053 - rollback for 0091_sessions_reauthenticated_at.sql.
--
-- Removes the two checks that bound the instant and then the column itself. Every session row
-- stays as it is, and its rotation history stays with it: the rollback drops a rule and a column,
-- never evidence. What is lost is only the record of which sessions had proved themselves again,
-- which loses nothing the audit chain does not already hold - every stamp was written with a
-- `session.reauthenticated` entry.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

alter table public.sessions
  drop constraint if exists sessions_reauthenticated_within_row_check;

alter table public.sessions
  drop constraint if exists sessions_reauthenticated_after_issue_check;

alter table public.sessions
  drop column if exists reauthenticated_at;

commit;
