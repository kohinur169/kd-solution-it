-- path: migrations/0047_bank_change_requests.sql
-- STEP 027 - the bank change request of section 10 and the 96 hour cooling period it starts.
--
-- Section 10 says a bank change needs manual verification first, that the 96 hour cooling period starts
-- only after that verification passes, that every payout is paused during the cooling, and that a
-- failed verification never starts a cooling at all and leaves the previous bank active. All four
-- sentences are this table.
--
-- The row names the account in use (`current_account_id`, empty for a merchant's first account), the
-- account the merchant wants (`requested_account_id`), who asked, who verified, when it was rejected,
-- when the cooling ends and when it was activated. Both accounts are foreign keys through the
-- composite key of STEP 027's account table, so a request cannot point at another merchant's account.
--
-- `cooling_ends_at` is a check rather than a column a caller may fill in: when it is present it must
-- equal the verification instant plus `interval '96 hours'`, so the cooling period cannot be shortened,
-- lengthened or skipped. A rejected request carries no cooling instant at all, which is "the cooling
-- period never starts" written where the database enforces it, and an activated request cannot activate
-- before its cooling has ended.
--
-- One change runs at a time. A partial unique index on `(company_id)` for the open statuses
-- (`requested`, `verified`, `cooling`) stops two parallel requests from racing for the same merchant,
-- while closed rows stay as history.

begin;

create function public.bank_change_requests_guard_state()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.company_id is distinct from old.company_id
     or new.current_account_id is distinct from old.current_account_id
     or new.requested_account_id is distinct from old.requested_account_id
     or new.requested_at is distinct from old.requested_at
     or new.requested_by is distinct from old.requested_by then
    raise exception 'a bank change request keeps its merchant, its accounts and its requester'
      using errcode = 'check_violation';
  end if;

  if old.status in ('activated', 'rejected', 'cancelled')
     and (to_jsonb(new) - 'updated_at' - 'version')
         is distinct from (to_jsonb(old) - 'updated_at' - 'version') then
    raise exception 'a closed bank change request is history'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.bank_change_requests_guard_state() is
  'Freezes the identity of a change request and locks it once activated, rejected or cancelled.';

create table public.bank_change_requests (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid not null,
  current_account_id uuid,
  requested_account_id uuid not null,
  status text not null default 'requested',
  requested_at timestamptz not null default now(),
  requested_by uuid not null,
  verified_at timestamptz,
  verified_by uuid,
  rejected_at timestamptz,
  rejection_note text,
  cooling_ends_at timestamptz,
  activated_at timestamptz,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint bank_change_requests_pkey primary key (id),
  constraint bank_change_requests_company_fkey foreign key (company_id)
    references public.companies (id),
  constraint bank_change_requests_current_fkey foreign key (current_account_id, company_id)
    references public.payout_bank_accounts (id, company_id),
  constraint bank_change_requests_requested_fkey foreign key (requested_account_id, company_id)
    references public.payout_bank_accounts (id, company_id),
  constraint bank_change_requests_requested_by_fkey foreign key (requested_by)
    references public.users (id),
  constraint bank_change_requests_verified_by_fkey foreign key (verified_by)
    references public.users (id),
  constraint bank_change_requests_accounts_check check (
    current_account_id is null or current_account_id <> requested_account_id
  ),
  constraint bank_change_requests_status_check check (
    status in ('requested', 'verified', 'cooling', 'activated', 'rejected', 'cancelled')
  ),
  constraint bank_change_requests_verified_instant_check check (
    (status in ('verified', 'cooling', 'activated')) = (verified_at is not null)
  ),
  constraint bank_change_requests_verified_by_check check (
    (status in ('verified', 'cooling', 'activated')) = (verified_by is not null)
  ),
  constraint bank_change_requests_cooling_instant_check check (
    (status in ('cooling', 'activated')) = (cooling_ends_at is not null)
  ),
  constraint bank_change_requests_cooling_length_check check (
    cooling_ends_at is null
    or (verified_at is not null and cooling_ends_at = verified_at + interval '96 hours')
  ),
  constraint bank_change_requests_rejected_instant_check check (
    (status = 'rejected') = (rejected_at is not null)
  ),
  constraint bank_change_requests_rejection_note_check check (
    (status = 'rejected') = (rejection_note is not null)
    and (
      rejection_note is null
      or (
        char_length(rejection_note) between 1 and 280
        and rejection_note = btrim(rejection_note)
      )
    )
  ),
  constraint bank_change_requests_activated_instant_check check (
    (status = 'activated') = (activated_at is not null)
  ),
  constraint bank_change_requests_activated_after_cooling_check check (
    activated_at is null or (cooling_ends_at is not null and activated_at >= cooling_ends_at)
  ),
  constraint bank_change_requests_order_check check (
    (verified_at is null or verified_at >= requested_at)
    and (rejected_at is null or rejected_at >= requested_at)
  ),
  constraint bank_change_requests_note_check check (
    note is null
    or (
      char_length(note) between 1 and 280
      and note = btrim(note)
    )
  ),
  constraint bank_change_requests_row_version_check check (version > 0),
  constraint bank_change_requests_updated_check check (updated_at >= created_at),
  constraint bank_change_requests_deleted_check check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.bank_change_requests is
  'A merchant request to change its payout bank, with the manual verification and the 96 hour cooling.';

comment on column public.bank_change_requests.id is
  'UUID v7 primary key. Time ordered, generated by public.uuid_generate_v7().';

comment on column public.bank_change_requests.company_id is
  'The merchant that asked. Frozen after the row is written.';

comment on column public.bank_change_requests.current_account_id is
  'The account in use when the request was made, empty when the merchant has none yet.';

comment on column public.bank_change_requests.requested_account_id is
  'The account the merchant wants to be paid to. Must differ from the current one.';

comment on column public.bank_change_requests.status is
  'requested, verified, cooling, activated, rejected or cancelled. The last three lock the row.';

comment on column public.bank_change_requests.requested_at is
  'When the merchant asked.';

comment on column public.bank_change_requests.requested_by is
  'The person who asked. Frozen after the row is written.';

comment on column public.bank_change_requests.verified_at is
  'Set exactly when a person verified the change by hand.';

comment on column public.bank_change_requests.verified_by is
  'The person who verified the change, required with the instant.';

comment on column public.bank_change_requests.rejected_at is
  'Set exactly when the manual verification failed.';

comment on column public.bank_change_requests.rejection_note is
  'Why the verification failed, at most 280 characters and trimmed.';

comment on column public.bank_change_requests.cooling_ends_at is
  'The verification instant plus the 96 hours of section 10, checked at every write.';

comment on column public.bank_change_requests.activated_at is
  'Set exactly when the new account took over, never before the cooling ended.';

comment on column public.bank_change_requests.note is
  'What the merchant or the office recorded, at most 280 characters and trimmed.';

comment on column public.bank_change_requests.created_at is
  'When the row was written.';

comment on column public.bank_change_requests.updated_at is
  'Maintained by public.set_row_metadata() on every update.';

comment on column public.bank_change_requests.deleted_at is
  'Soft delete marker, refused once the request has closed.';

comment on column public.bank_change_requests.version is
  'Optimistic concurrency counter, incremented by public.set_row_metadata().';

-- One change at a time per merchant: a second request waits until this one closes.
create unique index bank_change_requests_open_key
  on public.bank_change_requests (company_id)
  where status in ('requested', 'verified', 'cooling') and deleted_at is null;

-- What still needs a person: asked and not yet verified, oldest first.
create index bank_change_requests_queue_idx
  on public.bank_change_requests (company_id, requested_at)
  where status in ('requested', 'verified') and deleted_at is null;

-- Every request that names one account.
create index bank_change_requests_account_idx
  on public.bank_change_requests (requested_account_id);

create trigger bank_change_requests_guard_state
  before update on public.bank_change_requests
  for each row
  execute function public.bank_change_requests_guard_state();

create trigger bank_change_requests_set_row_metadata
  before update on public.bank_change_requests
  for each row
  execute function public.set_row_metadata();

alter table public.bank_change_requests enable row level security;

create policy bank_change_requests_default_deny
  on public.bank_change_requests
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
