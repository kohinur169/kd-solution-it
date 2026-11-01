-- path: migrations/0091_sessions_reauthenticated_at.down.sql
-- STEP 053 - rollback for 0091_sessions_reauthenticated_at.sql.
--
-- Drops the one check this file added and nothing else. The column is `0010`'s and stays, every
-- session row stays, and the lower bound `0010` wrote stays with it: the rollback removes a rule of
-- this STEP, never the schema it borrowed.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

alter table public.sessions
  drop constraint if exists sessions_reauthenticated_within_row_check;

commit;
