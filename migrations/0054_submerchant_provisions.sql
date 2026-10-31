-- path: migrations/0054_submerchant_provisions.sql
-- STEP 029 - the sub-merchant account of section 5.
--
-- Section 5: "Final approval by CEO or super_admin triggers automatic sub-merchant account
-- creation under the connected master platform account." The approval is a `kyc_submissions` row
-- this table points at through the composite tenant key, so a row cannot be provisioned for a
-- draft, an in-review or a rejected cycle, and cannot be filed under another merchant.
--
-- The row then walks the provider's own life, in the five statuses section 5 names: `pending`,
-- `action_required`, `verified`, `restricted` and `rejected`. A pending row with no
-- `master_account_ref` is the queued case of section 5, "if no master platform account is
-- connected, provisioning stays queued and the office is alerted": the queue index is what that
-- alert reads, and a row cannot record an attempt without the reference.
--
-- Section 5 also says "charges and payouts stay disabled until provider verification completes"
-- and "synced by verified webhooks". The first is a check that refuses either flag on any status
-- but `verified`, and the second is `submerchant_provisions_guard_sync`, which refuses a sync
-- whose event belongs to another provider, failed its signature or has not been processed.
--
-- Four guards keep the record honest: the identity of the row is frozen, the provider and the
-- approval behind it are checked before a row exists, the status walks forward only and a closed
-- row is history, and the webhook evidence is verified. A retry updates the row; a correction is a
-- new row, so the audit keeps both.

begin;

create function public.submerchant_provisions_guard_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.company_id is distinct from old.company_id
     or new.kyc_submission_id is distinct from old.kyc_submission_id
     or new.provider_id is distinct from old.provider_id
     or new.provider_key is distinct from old.provider_key
     or new.mode is distinct from old.mode
     or new.requested_at is distinct from old.requested_at then
    raise exception 'a sub-merchant provisioning row keeps its merchant, its provider and its approval'
      using errcode = 'check_violation';
  end if;

  -- A queued row has no master account yet; it may be filled once, when the platform account is
  -- connected, and never changed afterwards.
  if old.master_account_ref is not null
     and new.master_account_ref is distinct from old.master_account_ref then
    raise exception 'a sub-merchant provisioning row keeps the master account it was created under'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.submerchant_provisions_guard_identity() is
  'Freezes the merchant, the approval, the provider and the mode, and fills the master account once.';

create function public.submerchant_provisions_guard_source()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  provider_supports boolean;
  provider_company uuid;
  provider_status text;
  submission_status text;
  submission_decided timestamptz;
begin
  select supports_submerchant, company_id, status
    into provider_supports, provider_company, provider_status
  from public.payment_providers
  where id = new.provider_id;

  if not found then
    raise exception 'the provider % does not exist in the catalogue', new.provider_id
      using errcode = 'check_violation';
  end if;

  if provider_company is not null then
    raise exception 'a sub-merchant is provisioned through a platform level provider'
      using errcode = 'check_violation';
  end if;

  if not provider_supports then
    raise exception 'the provider does not create sub-merchants'
      using errcode = 'check_violation';
  end if;

  if new.attempted_at is not null and provider_status <> 'enabled' then
    raise exception 'an attempt needs an enabled provider'
      using errcode = 'check_violation';
  end if;

  select status, decided_at
    into submission_status, submission_decided
  from public.kyc_submissions
  where id = new.kyc_submission_id and company_id = new.company_id;

  if not found then
    raise exception 'the KYC submission of this merchant does not exist'
      using errcode = 'check_violation';
  end if;

  if submission_status <> 'approved' then
    raise exception 'only an approved KYC submission provisions a sub-merchant'
      using errcode = 'check_violation';
  end if;

  if submission_decided > new.requested_at then
    raise exception 'provisioning cannot precede the KYC decision it follows'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.submerchant_provisions_guard_source() is
  'Checks that the provider can create sub-merchants and that the KYC submission is approved.';

create function public.submerchant_provisions_guard_state()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status is distinct from old.status and not (
       (old.status = 'pending'
        and new.status in ('action_required', 'verified', 'rejected'))
       or (old.status = 'action_required' and new.status in ('verified', 'rejected'))
       or (old.status = 'verified' and new.status = 'restricted')
     ) then
    raise exception 'a sub-merchant moves from pending to action required, verified or rejected, '
                    'and a verified one only to restricted'
      using errcode = 'check_violation';
  end if;

  if new.status = 'restricted' and (new.charges_enabled or new.payouts_enabled) then
    raise exception 'a restricted sub-merchant cannot take money'
      using errcode = 'check_violation';
  end if;

  if old.status in ('restricted', 'rejected')
     and (to_jsonb(new) - 'updated_at' - 'version')
         is distinct from (to_jsonb(old) - 'updated_at' - 'version') then
    raise exception 'a closed sub-merchant provisioning row is history'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.submerchant_provisions_guard_state() is
  'Walks the five statuses forward, keeps a restricted row from taking money and locks a closed row.';

create function public.submerchant_provisions_guard_sync()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  event_provider uuid;
  event_signature boolean;
  event_status text;
  event_company uuid;
begin
  if new.last_webhook_event_id is null then
    return new;
  end if;

  select provider_id, signature_ok, status, company_id
    into event_provider, event_signature, event_status, event_company
  from public.webhook_events
  where id = new.last_webhook_event_id;

  if not found then
    raise exception 'the webhook event % does not exist', new.last_webhook_event_id
      using errcode = 'check_violation';
  end if;

  if event_provider <> new.provider_id then
    raise exception 'a sync names an event of its own provider'
      using errcode = 'check_violation';
  end if;

  if not event_signature then
    raise exception 'a sync needs a webhook whose signature was verified'
      using errcode = 'check_violation';
  end if;

  if event_status <> 'processed' then
    raise exception 'a sync needs a processed webhook event'
      using errcode = 'check_violation';
  end if;

  if event_company is not null and event_company <> new.company_id then
    raise exception 'a sync event belongs to another merchant'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.submerchant_provisions_guard_sync() is
  'Refuses a sync whose webhook event is another provider, unverified or unprocessed.';

create table public.submerchant_provisions (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid not null,
  kyc_submission_id uuid not null,
  provider_id uuid not null,
  provider_key text not null,
  mode text not null default 'test',
  master_account_ref text,
  provider_submerchant_id text,
  status text not null default 'pending',
  charges_enabled boolean not null default false,
  payouts_enabled boolean not null default false,
  requested_at timestamptz not null default now(),
  attempted_at timestamptz,
  verified_at timestamptz,
  restricted_at timestamptz,
  rejected_at timestamptz,
  action_required_detail text,
  rejection_reason text,
  attempt_count integer not null default 0,
  next_attempt_at timestamptz,
  last_synced_at timestamptz,
  last_webhook_event_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint submerchant_provisions_pkey primary key (id),
  constraint submerchant_provisions_company_fkey foreign key (company_id)
    references public.companies (id),
  constraint submerchant_provisions_submission_fkey foreign key (kyc_submission_id, company_id)
    references public.kyc_submissions (id, company_id),
  constraint submerchant_provisions_provider_fkey foreign key (provider_id)
    references public.payment_providers (id),
  constraint submerchant_provisions_webhook_fkey foreign key (last_webhook_event_id)
    references public.webhook_events (id),
  constraint submerchant_provisions_key_check check (
    provider_key in ('nmi', 'payoneer', 'rainforest', 'stripe_connect', 'airwallex')
  ),
  constraint submerchant_provisions_mode_check check (mode in ('test', 'live')),
  constraint submerchant_provisions_status_check check (
    status in ('pending', 'action_required', 'verified', 'restricted', 'rejected')
  ),
  constraint submerchant_provisions_account_check check (
    master_account_ref is null
    or (
      char_length(master_account_ref) between 1 and 120
      and master_account_ref = btrim(master_account_ref)
      and master_account_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$'
    )
  ),
  constraint submerchant_provisions_submerchant_check check (
    provider_submerchant_id is null
    or provider_submerchant_id ~ '^[A-Za-z0-9_-]{1,64}$'
  ),
  constraint submerchant_provisions_submerchant_required_check check (
    status = 'pending' or provider_submerchant_id is not null
  ),
  constraint submerchant_provisions_detail_check check (
    (status = 'action_required') = (action_required_detail is not null)
    and (
      action_required_detail is null
      or (
        char_length(action_required_detail) between 1 and 280
        and action_required_detail = btrim(action_required_detail)
      )
    )
  ),
  constraint submerchant_provisions_reason_check check (
    (status = 'rejected') = (rejection_reason is not null)
    and (
      rejection_reason is null
      or (
        char_length(rejection_reason) between 1 and 280
        and rejection_reason = btrim(rejection_reason)
      )
    )
  ),
  constraint submerchant_provisions_verified_instant_check check (
    (status in ('verified', 'restricted')) = (verified_at is not null)
  ),
  constraint submerchant_provisions_restricted_instant_check check (
    (status = 'restricted') = (restricted_at is not null)
  ),
  constraint submerchant_provisions_rejected_instant_check check (
    (status = 'rejected') = (rejected_at is not null)
  ),
  constraint submerchant_provisions_flags_check check (
    (not (charges_enabled or payouts_enabled)) or status = 'verified'
  ),
  constraint submerchant_provisions_attempt_check check (
    (attempt_count > 0) = (attempted_at is not null)
    and (attempted_at is null or master_account_ref is not null)
  ),
  constraint submerchant_provisions_queue_check check (
    next_attempt_at is null or status = 'pending'
  ),
  constraint submerchant_provisions_sync_check check (
    (last_synced_at is null) = (last_webhook_event_id is null)
  ),
  constraint submerchant_provisions_order_check check (
    requested_at <= created_at
    and (attempted_at is null or attempted_at >= requested_at)
    and (next_attempt_at is null or next_attempt_at >= requested_at)
    and (verified_at is null or verified_at >= requested_at)
    and (restricted_at is null or restricted_at >= verified_at)
    and (rejected_at is null or rejected_at >= requested_at)
    and (last_synced_at is null or last_synced_at >= requested_at)
  ),
  constraint submerchant_provisions_row_version_check check (version > 0),
  constraint submerchant_provisions_updated_check check (updated_at >= created_at),
  constraint submerchant_provisions_deleted_check check (
    deleted_at is null or deleted_at >= created_at
  )
);

comment on table public.submerchant_provisions is
  'The sub-merchant account of one merchant at one processor, from the KYC approval to its end.';

comment on column public.submerchant_provisions.id is
  'UUID v7 primary key. Time ordered, generated by public.uuid_generate_v7().';

comment on column public.submerchant_provisions.company_id is
  'The merchant being provisioned. Frozen after the row is written.';

comment on column public.submerchant_provisions.kyc_submission_id is
  'The approved KYC submission that triggered this row, through the composite tenant key.';

comment on column public.submerchant_provisions.provider_id is
  'The platform level provider that creates the sub-merchant.';

comment on column public.submerchant_provisions.provider_key is
  'A copy of the provider key: nmi, payoneer, rainforest, stripe_connect or airwallex.';

comment on column public.submerchant_provisions.mode is
  'test or live, so a staging sub-account is never mistaken for the production one.';

comment on column public.submerchant_provisions.master_account_ref is
  'The master platform account the sub-merchant is created under, null while the row is queued.';

comment on column public.submerchant_provisions.provider_submerchant_id is
  'The identifier the provider returned, unique per provider, null until the call succeeds.';

comment on column public.submerchant_provisions.status is
  'pending, action_required, verified, restricted or rejected.';

comment on column public.submerchant_provisions.charges_enabled is
  'The provider accepts charges for this sub-merchant. Only legal on a verified row.';

comment on column public.submerchant_provisions.payouts_enabled is
  'The provider pays out for this sub-merchant. Only legal on a verified row.';

comment on column public.submerchant_provisions.requested_at is
  'When provisioning was requested, never after the row that records it.';

comment on column public.submerchant_provisions.attempted_at is
  'When the creation call ran, present exactly when attempt_count is above zero.';

comment on column public.submerchant_provisions.verified_at is
  'When the provider verified the sub-merchant, present on verified and restricted rows.';

comment on column public.submerchant_provisions.restricted_at is
  'When the provider restricted the sub-merchant.';

comment on column public.submerchant_provisions.rejected_at is
  'When the provider rejected the sub-merchant.';

comment on column public.submerchant_provisions.action_required_detail is
  'What the provider still needs, required exactly on an action required row.';

comment on column public.submerchant_provisions.rejection_reason is
  'Why the provider rejected the sub-merchant, required exactly on a rejected row.';

comment on column public.submerchant_provisions.attempt_count is
  'How many creation calls ran, above zero exactly when attempted_at is set.';

comment on column public.submerchant_provisions.next_attempt_at is
  'When the queue may retry a pending row.';

comment on column public.submerchant_provisions.last_synced_at is
  'When a verified webhook event last moved this row.';

comment on column public.submerchant_provisions.last_webhook_event_id is
  'The processed, signed webhook event behind the last sync of this row.';

comment on column public.submerchant_provisions.created_at is
  'When the row was written.';

comment on column public.submerchant_provisions.updated_at is
  'Maintained by public.set_row_metadata() on every update.';

comment on column public.submerchant_provisions.deleted_at is
  'Soft delete marker, refused once the row is closed.';

comment on column public.submerchant_provisions.version is
  'Optimistic concurrency counter, incremented by public.set_row_metadata().';

-- One live provisioning row per merchant and provider.
create unique index submerchant_provisions_live_key
  on public.submerchant_provisions (company_id, provider_id)
  where deleted_at is null;

-- The provider identifier is unique inside its own provider.
create unique index submerchant_provisions_provider_key
  on public.submerchant_provisions (provider_id, provider_submerchant_id)
  where provider_submerchant_id is not null and deleted_at is null;

-- The queue the office alert reads: queued and retrying rows, oldest attempt first.
create index submerchant_provisions_queue_idx
  on public.submerchant_provisions (next_attempt_at)
  where status = 'pending' and deleted_at is null;

-- One provider seen from the office, by status and request order.
create index submerchant_provisions_provider_idx
  on public.submerchant_provisions (provider_id, status, requested_at)
  where deleted_at is null;

create trigger submerchant_provisions_guard_identity
  before update on public.submerchant_provisions
  for each row
  execute function public.submerchant_provisions_guard_identity();

create trigger submerchant_provisions_guard_source
  before insert or update on public.submerchant_provisions
  for each row
  execute function public.submerchant_provisions_guard_source();

create trigger submerchant_provisions_guard_state
  before update on public.submerchant_provisions
  for each row
  execute function public.submerchant_provisions_guard_state();

create trigger submerchant_provisions_guard_sync
  before insert or update on public.submerchant_provisions
  for each row
  execute function public.submerchant_provisions_guard_sync();

create trigger submerchant_provisions_set_row_metadata
  before update on public.submerchant_provisions
  for each row
  execute function public.set_row_metadata();

alter table public.submerchant_provisions enable row level security;

create policy submerchant_provisions_default_deny
  on public.submerchant_provisions
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
