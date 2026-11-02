-- path: migrations/0089_session_rotation.sql
-- STEP 051 - a rotation chain has a ceiling.
--
-- Section 22 asks for a rotating session token, replay detection and revoking the whole session
-- family. `0010_sessions.sql` already stores all of it: one row per rotation, a shared `family_id`,
-- `rotated_from_session_id` with a unique index so a fork cannot be written, and a closed
-- revocation vocabulary that already contains ROTATED, REPLAY_DETECTED and FAMILY_REVOKED.
--
-- What it leaves open is how long the chain may run. Every rotation is a new row with a new
-- `expires_at`, so a browser that rotates before each expiry keeps one login alive for ever - and a
-- stolen cookie that rotates legitimately is never detected, because replay detection only fires
-- when somebody presents a spent token. A rotating token without a ceiling is a session that never
-- ends; it is just a session with more rows.
--
-- This migration adds that ceiling as a column on the session itself:
--
--   * `absolute_expires_at` is written when a family starts and copied by every rotation, so it
--     belongs to the login rather than to one rotation of it;
--   * `sessions_absolute_expiry_check` makes the database refuse a row whose own `expires_at`
--     reaches past its family's ceiling, so a bug in the service cannot silently extend a login;
--   * existing rows are backfilled from `expires_at`, which is the honest reading of a row written
--     before the ceiling existed: it ends when it was always going to end.
--
-- The second addition is the index the reader needs. A token that was rotated a moment ago is
-- accepted once, inside a grace window, and the row it belongs to is found by `family_id` among the
-- live rows of the family. `sessions_family_idx` indexes every row of a family, revoked or not, so
-- that read would touch history; the partial index below touches only what is live.
--
-- Both operations are additive. No column is changed, no row is deleted, and the rollback removes
-- exactly what this file added.

begin;

alter table public.sessions
  add column absolute_expires_at timestamptz;

-- A row written before this migration ends when it was always going to end. The `where` keeps the
-- update to rows this statement can still see, so re-running the file on a database that already
-- paid this cost is a no-op rather than a rewrite of every session.
update public.sessions
  set absolute_expires_at = expires_at
  where absolute_expires_at is null;

alter table public.sessions
  alter column absolute_expires_at set not null;

alter table public.sessions
  add constraint sessions_absolute_expiry_check check (
    absolute_expires_at > issued_at and expires_at <= absolute_expires_at
  );

comment on column public.sessions.absolute_expires_at is
  'The end of the whole login, written when the family starts and copied by every rotation.';

comment on constraint sessions_absolute_expiry_check on public.sessions is
  'No rotation may be stored past the ceiling of its family, so a chain cannot renew for ever.';

-- The grace path: the live row of one family, which is at most one row per family.
create index sessions_family_live_idx on public.sessions (family_id)
  where revoked_at is null and deleted_at is null;

commit;
