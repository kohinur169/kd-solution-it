-- path: migrations/0032_webhook_events.sql
-- STEP 023 - the provider webhook events of section 6 and the webhook job of section 27.
--
-- A webhook is a delivery the platform did not ask for, and providers deliver the same event more than
-- once. The row is therefore keyed by the provider's own identifier: `(provider_id, mode,
-- external_event_id)` is unique without a partial predicate, so a second delivery is refused rather
-- than processed twice, and the queue that section 27 describes has one row to work with.
--
-- The payload itself is not stored here. `payload_hash` is its SHA-256, which is enough to prove that
-- two deliveries carried the same body and to detect a later edit, and it is what keeps a provider
-- body that happens to carry card data out of the platform database. Section 18 says the platform
-- never holds a card number, so it never stores one by accident either.
--
-- `signature_ok` records the result of verifying the provider signature, and a check ties it to the
-- states that mean the platform acted: an event that failed verification can be stored as `rejected`
-- for the audit trail, and can never be `processing` or `processed`.
--
-- The status only moves forward. `webhook_events_guard_evidence` freezes the identity of the event -
-- the provider, the mode, the external id, the type, the hash, the received instant and the signature
-- result - and refuses a return to `pending` or a change after a terminal outcome, so the row a
-- dispute reads months later says what arrived, not what a later writer wished had arrived.
--
-- `company_id` is null until the event names its merchant, because a provider posts to an endpoint
-- before the platform has resolved which merchant the event concerns; the guard allows that one
-- transition and no other.

begin;

create function public.webhook_events_guard_evidence()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    return new;
  end if;

  if new.provider_id is distinct from old.provider_id
     or new.mode is distinct from old.mode
     or new.external_event_id is distinct from old.external_event_id
     or new.event_type is distinct from old.event_type
     or new.payload_hash is distinct from old.payload_hash
     or new.received_at is distinct from old.received_at
     or new.signature_ok is distinct from old.signature_ok then
    raise exception 'a webhook event keeps its identity'
      using errcode = 'check_violation';
  end if;

  if old.company_id is not null and new.company_id is distinct from old.company_id then
    raise exception 'a webhook event names its merchant once'
      using errcode = 'check_violation';
  end if;

  if old.status in ('processed', 'rejected', 'ignored') and new.status is distinct from old.status then
    raise exception 'a finished webhook event keeps its outcome'
      using errcode = 'check_violation';
  end if;

  if old.status <> 'pending' and new.status = 'pending' then
    raise exception 'a webhook event only moves forward'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.webhook_events_guard_evidence() is
  'Freezes what a provider delivered and lets only the processing status move forward.';

create table public.webhook_events (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid,
  provider_id uuid not null,
  mode text not null default 'test',
  external_event_id text not null,
  event_type text not null,
  payload_hash text not null,
  signature_ok boolean not null default false,
  received_at timestamptz not null default now(),
  status text not null default 'pending',
  processed_at timestamptz,
  failure_detail text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint webhook_events_pkey primary key (id),
  constraint webhook_events_company_fkey foreign key (company_id) references public.companies (id),
  constraint webhook_events_provider_fkey foreign key (provider_id)
    references public.payment_providers (id),
  constraint webhook_events_mode_check check (mode in ('test', 'live')),
  constraint webhook_events_external_id_check check (
    char_length(external_event_id) between 1 and 200
    and external_event_id = btrim(external_event_id)
  ),
  constraint webhook_events_type_check check (
    char_length(event_type) between 1 and 120 and event_type = btrim(event_type)
  ),
  constraint webhook_events_payload_check check (payload_hash ~ '^[0-9a-f]{64}$'),
  constraint webhook_events_status_check check (
    status in ('pending', 'processing', 'processed', 'failed', 'ignored', 'rejected')
  ),
  constraint webhook_events_signature_check check (
    signature_ok or status in ('pending', 'failed', 'ignored', 'rejected')
  ),
  constraint webhook_events_rejected_check check (status <> 'rejected' or signature_ok = false),
  constraint webhook_events_processed_check check (
    (status = 'processed') = (processed_at is not null)
  ),
  constraint webhook_events_failure_check check (
    (failure_detail is null and status <> 'failed')
    or (
      status = 'failed'
      and failure_detail is not null
      and char_length(failure_detail) between 1 and 280
      and failure_detail = btrim(failure_detail)
    )
  ),
  constraint webhook_events_row_version_check check (version > 0),
  constraint webhook_events_updated_check check (updated_at >= created_at),
  constraint webhook_events_deleted_check check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.webhook_events is
  'A provider delivery: its identity, its payload hash, its signature result and its processing state.';

comment on column public.webhook_events.id is
  'UUID v7 primary key. Time ordered, generated by public.uuid_generate_v7().';

comment on column public.webhook_events.company_id is
  'The merchant the event concerns, null until the event names it, and fixed once it does.';

comment on column public.webhook_events.provider_id is
  'The provider that delivered the event.';

comment on column public.webhook_events.mode is
  'test or live, so a sandbox delivery never touches live data.';

comment on column public.webhook_events.external_event_id is
  'The identifier the provider gave this event. Unique per provider and mode.';

comment on column public.webhook_events.event_type is
  'The provider event name, trimmed, 1 to 120 characters.';

comment on column public.webhook_events.payload_hash is
  'SHA-256 of the delivered body. The body itself is never stored, so no card data is.';

comment on column public.webhook_events.signature_ok is
  'True when the provider signature verified. An unverified event is never processed.';

comment on column public.webhook_events.received_at is
  'When the endpoint accepted the delivery. Frozen by the evidence guard.';

comment on column public.webhook_events.status is
  'pending, processing, processed, failed, ignored or rejected; it only moves forward.';

comment on column public.webhook_events.processed_at is
  'Set exactly when the status is processed.';

comment on column public.webhook_events.failure_detail is
  'Why processing failed, at most 280 characters, present exactly on a failed event.';

comment on column public.webhook_events.created_at is
  'When the row was written, which is the delivery instant.';

comment on column public.webhook_events.updated_at is
  'Set by the webhook_events_set_row_metadata trigger on every update.';

comment on column public.webhook_events.deleted_at is
  'Soft delete marker. A removed event keeps its delivery identity for the audit trail.';

comment on column public.webhook_events.version is
  'Optimistic locking counter. Incremented by the webhook_events_set_row_metadata trigger.';

-- The provider's own identifier is the key: a second delivery of the same event is one row, never two.
create unique index webhook_events_delivery_key
  on public.webhook_events (provider_id, mode, external_event_id);

-- The section 27 job: what is waiting, oldest first.
create index webhook_events_queue_idx
  on public.webhook_events (status, received_at)
  where status in ('pending', 'processing');

-- One provider's deliveries, newest first, for the gateway page.
create index webhook_events_provider_idx
  on public.webhook_events (provider_id, received_at desc);

create trigger webhook_events_guard_evidence
  before insert or update on public.webhook_events
  for each row
  execute function public.webhook_events_guard_evidence();

create trigger webhook_events_set_row_metadata
  before update on public.webhook_events
  for each row
  execute function public.set_row_metadata();

alter table public.webhook_events enable row level security;

create policy webhook_events_default_deny
  on public.webhook_events
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
