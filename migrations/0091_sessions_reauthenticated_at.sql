-- path: migrations/0091_sessions_reauthenticated_at.sql
-- STEP 053 - a session can prove itself again, and the platform remembers when.
--
-- Section 22 requires step-up reauthentication for gateway keys, payouts, KYC decisions and account
-- unlocks, and `0010_sessions.sql` already stores the one fact that makes the requirement mean
-- something: `mfa_verified_at`, the instant the second factor was satisfied when the session was
-- created. STEP 051 copies it into every rotation, so a family remembers how old its own proof is.
--
-- What a session cannot say today is that the person proved themselves *again*, later, without
-- signing in: a merchant who signed in this morning and is unlocking an account this afternoon has a
-- proof that is hours old, and no column records that they were asked to refresh it. This migration
-- adds that column.
--
--   * `reauthenticated_at` is null until a fresh proof is written; null reads as "this session has
--     never reauthenticated", which is the honest state of every row written before this file;
--   * two checks keep the instant inside the row's own life - it cannot predate `issued_at` and
--     cannot reach past the row's `expires_at` - so a bug in the service cannot store a proof from
--     before the session existed or one that outlives its row. The family's ceiling needs no third
--     check: `0089` already refuses a row whose `expires_at` is past `absolute_expires_at`, so a
--     proof inside the row is inside the ceiling by construction;
--   * the column is additive and nullable, so every existing row stays valid and no session is
--     invalidated by deploying this file.
--
-- Nothing is indexed: the guard reads the column of the session it already resolved, one row at a
-- time, and a list of who reauthenticated when is not a question this platform asks.

begin;

alter table public.sessions
  add column reauthenticated_at timestamptz;

alter table public.sessions
  add constraint sessions_reauthenticated_after_issue_check check (
    reauthenticated_at is null or reauthenticated_at >= issued_at
  );

alter table public.sessions
  add constraint sessions_reauthenticated_within_row_check check (
    reauthenticated_at is null or reauthenticated_at <= expires_at
  );

comment on column public.sessions.reauthenticated_at is
  'When this session last proved the second factor again, inside the session. Null until it has.';

comment on constraint sessions_reauthenticated_after_issue_check on public.sessions is
  'A proof cannot be older than the session that holds it.';

comment on constraint sessions_reauthenticated_within_row_check on public.sessions is
  'A proof inside a session that has ended is not a proof, and the family ceiling of 0089 follows.';

commit;
