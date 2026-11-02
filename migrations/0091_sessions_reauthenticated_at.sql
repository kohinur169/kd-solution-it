-- path: migrations/0091_sessions_reauthenticated_at.sql
-- STEP 053 - the reauthentication instant gets its upper bound.
--
-- `0010_sessions.sql` already stores the fact this STEP needs: `sessions.reauthenticated_at`, "when
-- the user last reauthenticated for a sensitive action. The auth layer ages this value", bounded by
-- `sessions_reauthenticated_check` so it can never predate the session that holds it. STEP 053 read
-- that column, wrote it from `lib/auth/step-up.ts`, and needed no other storage.
--
-- What `0010` does not bound is the other end. The value can be written after the row's own
-- `expires_at`, and after the family's `absolute_expires_at` - a proof recorded inside a session that
-- has already ended, which the guard would then treat as fresh for a session that cannot act. This
-- migration is that bound and nothing else:
--
--   * `sessions_reauthenticated_within_row_check` refuses an instant past the row's `expires_at`;
--   * the family ceiling needs no separate check, because `0089` already refuses a row whose
--     `expires_at` reaches past `absolute_expires_at`, so a proof inside the row is inside the
--     ceiling by construction;
--   * the lower bound stays where `0010` put it (`sessions_reauthenticated_check`, `>= issued_at`),
--     and this file neither repeats it nor replaces it.
--
-- Additive: no column, no row and no existing constraint is touched, so deploying this file
-- invalidates no session and rewrites nothing.

begin;

alter table public.sessions
  add constraint sessions_reauthenticated_within_row_check check (
    reauthenticated_at is null or reauthenticated_at <= expires_at
  );

comment on constraint sessions_reauthenticated_within_row_check on public.sessions is
  'A proof recorded after the session ended is not a proof: the row and the family ceiling of 0089 bound it.';

commit;
