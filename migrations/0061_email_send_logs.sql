-- path: migrations/0061_email_send_logs.sql
-- STEP 032 - the send log of section 23: one row per email the platform tried to send.
--
-- Section 23 asks for every send to be logged with its template, its recipient, its status and
-- the provider message id, and for a failed send to be retried with a retry limit. This table is
-- that log. It stores the template key as a closed vocabulary of its own rather than a foreign
-- key, because `email_templates` carries a locale as well and a send log must keep its record
-- after a template is retired.
--
-- The row is history: the template key, the recipient, the subject, the provider and the queued
-- instant are frozen, `attempts` only rises, and the guard refuses a delete, because an email
-- that left the platform is a record of something that happened to a person. `sent_at` and the
-- provider message id are written once; a retry that succeeds after a failure clears the failure
-- pair, so the row always describes the last attempt rather than a mixture of two.
--
-- The status walks `queued` to `sent`, `failed` or `dropped`, and a `failed` row may still reach
-- `sent` on a retry or `dropped` when the limit is reached. A failed row under its limit must say
-- when the next attempt is due, which is what STEP 227's worker reads; a duplicate provider
-- message id is refused by a partial unique index, so a webhook and a retry cannot log the same
-- delivery twice.

begin;

create function public.email_send_logs_guard_state()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.template_key is distinct from old.template_key
       or new.recipient_email is distinct from old.recipient_email
       or new.recipient_user_id is distinct from old.recipient_user_id
       or new.subject is distinct from old.subject
       or new.provider is distinct from old.provider
       or new.queued_at is distinct from old.queued_at
       or new.max_attempts is distinct from old.max_attempts then
      raise exception 'a send log keeps its template, its recipient and its queue instant'
        using errcode = 'check_violation';
    end if;

    if new.attempts < old.attempts then
      raise exception 'a send attempt count only rises'
        using errcode = 'check_violation';
    end if;

    if old.sent_at is not null
       and (new.sent_at is distinct from old.sent_at
            or new.provider_message_id is distinct from old.provider_message_id) then
      raise exception 'a delivered email keeps its instant and its provider message id'
        using errcode = 'check_violation';
    end if;

    if old.status is distinct from new.status and not (
      (old.status = 'queued' and new.status in ('sent', 'failed', 'dropped'))
      or (old.status = 'failed' and new.status in ('sent', 'failed', 'dropped'))
    ) then
      raise exception 'a send log walks from queued to sent, failed or dropped, and no further'
        using errcode = 'check_violation';
    end if;

    if new.deleted_at is not null then
      raise exception 'a send log is history and is never deleted'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.email_send_logs_guard_state() is
  'Freezes the template, the recipient and the queue instant of a send, and walks its status.';

create table public.email_send_logs (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid,
  template_key text not null,
  recipient_email text not null,
  recipient_user_id uuid,
  subject text not null,
  status text not null default 'queued',
  provider text not null,
  provider_message_id text,
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  failure_reason text,
  queued_at timestamptz not null default now(),
  sent_at timestamptz,
  failed_at timestamptz,
  next_retry_at timestamptz,
  reference_kind text,
  reference_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint email_send_logs_pkey primary key (id),
  constraint email_send_logs_company_fkey foreign key (company_id)
    references public.companies (id),
  constraint email_send_logs_recipient_user_fkey foreign key (recipient_user_id)
    references public.users (id),
  constraint email_send_logs_template_check check (
    template_key in ('welcome', 'email_verification', 'password_reset', 'login_lock_alert',
                     'new_device_alert', 'kyc_submitted', 'kyc_approved', 'kyc_rejected',
                     'invoice_sent', 'payment_received', 'payment_failed', 'refund_update',
                     'dispute_update', 'payout_sent', 'settlement_released',
                     'subscription_warning', 'service_stop', 'service_restore',
                     'support_reply', 'account_unlock')
  ),
  constraint email_send_logs_recipient_check check (
    char_length(recipient_email) between 3 and 320
    and recipient_email ~ '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+[.][A-Za-z]{2,}$'
  ),
  constraint email_send_logs_subject_check check (
    char_length(subject) between 1 and 160
    and subject = btrim(subject)
  ),
  constraint email_send_logs_status_check check (
    status in ('queued', 'sent', 'failed', 'dropped')
  ),
  constraint email_send_logs_provider_check check (provider in ('smtp', 'api')),
  constraint email_send_logs_sent_check check (
    (status = 'sent')
    = (sent_at is not null and provider_message_id is not null)
  ),
  constraint email_send_logs_failed_check check (
    (status = 'failed') = (failed_at is not null and failure_reason is not null)
  ),
  constraint email_send_logs_dropped_check check (
    status <> 'dropped' or (failure_reason is not null and sent_at is null)
  ),
  constraint email_send_logs_attempts_check check (
    attempts between 0 and 10 and attempts <= max_attempts
  ),
  constraint email_send_logs_max_attempts_check check (max_attempts between 1 and 10),
  constraint email_send_logs_retry_check check (
    status <> 'failed' or attempts >= max_attempts or next_retry_at is not null
  ),
  constraint email_send_logs_message_id_check check (
    provider_message_id is null
    or (
      char_length(provider_message_id) between 1 and 255
      and provider_message_id = btrim(provider_message_id)
    )
  ),
  constraint email_send_logs_failure_check check (
    failure_reason is null
    or (
      char_length(failure_reason) between 1 and 280
      and failure_reason = btrim(failure_reason)
    )
  ),
  constraint email_send_logs_reference_check check (
    (reference_kind is null) = (reference_id is null)
  ),
  constraint email_send_logs_reference_kind_check check (
    reference_kind is null
    or reference_kind in ('account', 'kyc', 'invoice', 'payment', 'refund', 'dispute', 'payout',
                          'settlement', 'subscription', 'support_ticket')
  ),
  constraint email_send_logs_instant_check check (
    (sent_at is null or sent_at >= created_at)
    and (failed_at is null or failed_at >= created_at)
    and (next_retry_at is null or next_retry_at >= created_at)
  ),
  constraint email_send_logs_updated_check check (updated_at >= created_at),
  constraint email_send_logs_deleted_check check (deleted_at is null or deleted_at >= created_at),
  constraint email_send_logs_row_version_check check (version > 0)
);

comment on table public.email_send_logs is
  'One email the platform tried to send, with its template, its recipient and the provider answer.';

comment on column public.email_send_logs.id is
  'UUID v7 primary key. Time ordered, generated by public.uuid_generate_v7().';

comment on column public.email_send_logs.company_id is
  'The merchant the email is about, null for a platform email such as a staff alert.';

comment on column public.email_send_logs.template_key is
  'The activity email of section 23 this send rendered, from the same twenty keys as the template.';

comment on column public.email_send_logs.recipient_email is
  'The address the email went to, kept as it was sent rather than read from the user later.';

comment on column public.email_send_logs.recipient_user_id is
  'The person the email is for, null for a recipient who has no account, such as a client.';

comment on column public.email_send_logs.subject is
  'The subject that left the platform, stored as sent.';

comment on column public.email_send_logs.status is
  'queued, sent, failed or dropped; the guard walks it and never back from sent or dropped.';

comment on column public.email_send_logs.provider is
  'smtp or api, the sending method of section 23 that handled this email.';

comment on column public.email_send_logs.provider_message_id is
  'The message id the provider returned, unique per provider when present, so a retry logs once.';

comment on column public.email_send_logs.attempts is
  'How many times the send was tried; only rises and never passes max_attempts.';

comment on column public.email_send_logs.max_attempts is
  'The retry limit of section 23 that applied to this email, frozen at queue time.';

comment on column public.email_send_logs.failure_reason is
  'Why the last attempt failed, required by the failed state and by a dropped row.';

comment on column public.email_send_logs.queued_at is
  'When the email was queued, which the worker of STEP 227 orders by.';

comment on column public.email_send_logs.sent_at is
  'When the provider accepted the email. Written once.';

comment on column public.email_send_logs.failed_at is
  'When the last attempt failed, cleared when a retry succeeds.';

comment on column public.email_send_logs.next_retry_at is
  'When the next attempt is due, which a failed row under its limit must carry.';

comment on column public.email_send_logs.reference_kind is
  'What the email is about, paired with reference_id, so a screen can open the record.';

comment on column public.email_send_logs.reference_id is
  'The id of that record. Present exactly when reference_kind is.';

comment on column public.email_send_logs.created_at is
  'When the row was written.';

comment on column public.email_send_logs.updated_at is
  'Set by the email_send_logs_set_row_metadata trigger on every update.';

comment on column public.email_send_logs.deleted_at is
  'Present for the schema rule; the guard refuses a value, because a send log is history.';

comment on column public.email_send_logs.version is
  'Optimistic locking counter, incremented by the email_send_logs_set_row_metadata trigger.';

-- One delivery is one row: a webhook and a retry cannot log the same provider message twice.
create unique index email_send_logs_message_key
  on public.email_send_logs (provider, provider_message_id)
  where provider_message_id is not null;

-- The retry sweep of STEP 227: failed emails whose next attempt is due.
create index email_send_logs_retry_idx
  on public.email_send_logs (status, next_retry_at)
  where status = 'failed' and deleted_at is null;

-- The merchant history screen: the emails of one account, newest first.
create index email_send_logs_company_idx
  on public.email_send_logs (company_id, created_at desc)
  where deleted_at is null;

create trigger email_send_logs_guard_state
  before insert or update on public.email_send_logs
  for each row
  execute function public.email_send_logs_guard_state();

create trigger email_send_logs_set_row_metadata
  before update on public.email_send_logs
  for each row
  execute function public.set_row_metadata();

alter table public.email_send_logs enable row level security;

create policy email_send_logs_default_deny
  on public.email_send_logs
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
