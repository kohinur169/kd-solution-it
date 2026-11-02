-- path: migrations/0086_account_lock_alert.sql
-- STEP 046 - the owner alert of section 22, joined to the send log row it produced.
--
-- "The owner receives an email alert when the lock starts." The alert is not a new kind of record:
-- section 23 already says every email is logged with its template, recipient and status, and `0061`
-- is that log, with `login_lock_alert` among its twenty templates. What was missing is the link from
-- the lock to the email it raised:
--
--   - `alert_send_id` names the one `email_send_logs` row this lock alerted the owner with, so an
--     office screen can show whether the owner was told and whether the provider accepted it,
--     without guessing by recipient and template;
--   - `account_locks_alert_send_key` makes that link one to one. The foreign key alone would let two
--     locks point at the same send, and a lock that alerted twice would be a bug this STEP cannot
--     see from code alone;
--   - `account_locks_alert_pair_check` makes the link inseparable from `owner_alerted_at`: a lock
--     that says it alerted the owner must name the email that did it.
--
-- `owner_alerted_at` is written together with `alert_send_id`, when the email is queued. That is the
-- instant the platform took responsibility for telling the owner: delivery itself, its retries and
-- its provider message id live in `email_send_logs.status`, one row per email, and are the subject
-- of STEP 227's sweep. Keeping delivery state in one place is why this column is not a second copy
-- of it.

begin;

alter table public.account_locks
  add column alert_send_id uuid,
  add constraint account_locks_alert_send_fkey foreign key (alert_send_id)
    references public.email_send_logs (id);

-- A lock that is already marked alerted has a send log row behind it, and the log is the source of
-- truth: the latest `login_lock_alert` queued or sent for that account is the one that did it. The
-- backfill matters for a table that has been through the rollback of this file and back, because the
-- rollback necessarily loses the pointer while keeping `owner_alerted_at`; without it, re-applying
-- would either fail the pair check below or need hand-written SQL during a deploy.
update public.account_locks as l
   set alert_send_id = latest.id
  from (
    select distinct on (reference_id) reference_id, id
      from public.email_send_logs
     where template_key = 'login_lock_alert'
       and reference_kind = 'account'
       and status in ('queued', 'sent')
     order by reference_id, created_at desc
  ) as latest
 where latest.reference_id = l.user_id
   and l.owner_alerted_at is not null
   and l.alert_send_id is null
   and l.deleted_at is null;

alter table public.account_locks
  add constraint account_locks_alert_pair_check check (
    owner_alerted_at is null or alert_send_id is not null
  );

create unique index account_locks_alert_send_key
  on public.account_locks (alert_send_id)
  where alert_send_id is not null and deleted_at is null;

comment on column public.account_locks.alert_send_id is
  'The send log row of this lock''s owner alert, set together with owner_alerted_at when it is queued.';

comment on index public.account_locks_alert_send_key is
  'One owner alert per lock and one lock per alert, so a lock cannot tell the owner twice.';

commit;
