-- path: migrations/0086_account_lock_alert.down.sql
-- STEP 046 - rollback for 0086_account_lock_alert.sql.
--
-- Drops the link, both constraints and the unique index, and keeps every row of both tables: the
-- locks stay locks and the send logs stay history. A lock that alerted its owner keeps
-- `owner_alerted_at`, which is the fact section 22 cares about; only the pointer to the send log row
-- is lost, and that row is still findable by its template, its recipient and its reference.
--
-- Re-applying the forward file after this rollback restores the pointer from the send log itself, so
-- a deploy that rolls back and forward again needs no hand-written SQL.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop index if exists public.account_locks_alert_send_key;

alter table public.account_locks
  drop constraint if exists account_locks_alert_pair_check,
  drop constraint if exists account_locks_alert_send_fkey,
  drop column if exists alert_send_id;

commit;
