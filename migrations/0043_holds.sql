-- path: migrations/0043_holds.sql
-- STEP 026 - the hold of sections 10 and 11: money the platform keeps back.
--
-- A hold is the second of the ledger's ten movements and the row the statement of section 17 groups
-- by cause. It names the payment it pins when it pins one, the settlement it was withheld from when
-- it came out of a batch, and a reason from a closed list: risk, dispute, billing, closure or review.
--
-- A hold cannot take more than its payment. `holds_guard_amount` sums the live holds of the same
-- payment and refuses one that would go above what was charged, which is the same shape as the refund
-- cap of STEP 024 and for the same reason: two rows that each look reasonable can together be more
-- than the money that exists.
--
-- A hold belongs to one merchant. A payment is checked by `holds_guard_owner` because the payments
-- table of STEP 024 has no `(id, company_id)` key to point a composite foreign key at, while a
-- settlement is checked by a composite foreign key, so no hold can name another merchant's payment or
-- batch.
--
-- A hold closes one way. It is `released` with the instant and the person who released it, or
-- `collected` with its instant, its person and the note section 10 needs when a shortfall goes to the
-- contract process. Once closed it is history: `holds_guard_state` freezes the identity of the row and
-- refuses every later change except the metadata columns.

begin;

create function public.holds_guard_owner()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.payment_id is not null then
    perform 1 from public.payments
    where id = new.payment_id and company_id = new.company_id;

    if not found then
      raise exception 'a hold names a payment of its own merchant'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.holds_guard_owner() is
  'Refuses a hold whose payment belongs to another merchant.';

create function public.holds_guard_amount()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  payment_amount bigint;
  already_held bigint;
begin
  if new.payment_id is null then
    return new;
  end if;

  select amount_minor into payment_amount from public.payments where id = new.payment_id;

  select coalesce(sum(amount_minor), 0) into already_held
  from public.holds
  where payment_id = new.payment_id and id <> new.id and deleted_at is null;

  if payment_amount is not null and already_held + new.amount_minor > payment_amount then
    raise exception 'a hold cannot take more than its payment'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.holds_guard_amount() is
  'Caps the live holds of one payment at what that payment charged.';

create function public.holds_guard_state()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.company_id is distinct from old.company_id
     or new.payment_id is distinct from old.payment_id
     or new.settlement_id is distinct from old.settlement_id
     or new.amount_minor is distinct from old.amount_minor
     or new.currency is distinct from old.currency
     or new.reason is distinct from old.reason
     or new.placed_at is distinct from old.placed_at then
    raise exception 'a hold keeps its merchant, its payment, its amount and its reason'
      using errcode = 'check_violation';
  end if;

  if old.status in ('released', 'collected')
     and (to_jsonb(new) - 'updated_at' - 'version')
         is distinct from (to_jsonb(old) - 'updated_at' - 'version') then
    raise exception 'a closed hold is history'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.holds_guard_state() is
  'Freezes the identity of a hold and locks it once released or collected.';

create table public.holds (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid not null,
  payment_id uuid,
  settlement_id uuid,
  amount_minor bigint not null,
  currency text not null default 'USD',
  reason text not null,
  status text not null default 'active',
  placed_at timestamptz not null default now(),
  release_due_at timestamptz not null,
  released_at timestamptz,
  released_by uuid,
  collected_at timestamptz,
  collected_by uuid,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint holds_pkey primary key (id),
  constraint holds_company_fkey foreign key (company_id) references public.companies (id),
  constraint holds_payment_fkey foreign key (payment_id) references public.payments (id),
  constraint holds_settlement_fkey foreign key (settlement_id, company_id)
    references public.settlements (id, company_id),
  constraint holds_released_by_fkey foreign key (released_by) references public.users (id),
  constraint holds_collected_by_fkey foreign key (collected_by) references public.users (id),
  constraint holds_amount_check check (amount_minor > 0),
  constraint holds_currency_check check (currency ~ '^[A-Z]{3}$'),
  constraint holds_reason_check check (reason in ('risk', 'dispute', 'billing', 'closure', 'review')),
  constraint holds_status_check check (status in ('active', 'released', 'collected')),
  constraint holds_released_instant_check check ((status = 'released') = (released_at is not null)),
  constraint holds_released_by_check check ((status = 'released') = (released_by is not null)),
  constraint holds_collected_instant_check check ((status = 'collected') = (collected_at is not null)),
  constraint holds_collected_by_check check ((status = 'collected') = (collected_by is not null)),
  constraint holds_collected_note_check check (status <> 'collected' or note is not null),
  constraint holds_note_check check (
    note is null
    or (
      char_length(note) between 1 and 280
      and note = btrim(note)
    )
  ),
  constraint holds_release_check check (release_due_at > placed_at),
  constraint holds_closed_instant_check check (
    (released_at is null or released_at >= placed_at)
    and (collected_at is null or collected_at >= placed_at)
  ),
  constraint holds_row_version_check check (version > 0),
  constraint holds_updated_check check (updated_at >= created_at),
  constraint holds_deleted_check check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.holds is
  'Money the platform keeps back, with its reason and how it closed.';

comment on column public.holds.id is
  'UUID v7 primary key. Time ordered, generated by public.uuid_generate_v7().';

comment on column public.holds.company_id is
  'The merchant whose money is held. Frozen after the row is written.';

comment on column public.holds.payment_id is
  'The payment the hold pins, when it pins one. Must belong to the same merchant.';

comment on column public.holds.settlement_id is
  'The batch the hold was withheld from, when it came out of one.';

comment on column public.holds.amount_minor is
  'How much is held, in minor units. The live holds of a payment never exceed its amount.';

comment on column public.holds.currency is
  'Three upper case letters.';

comment on column public.holds.reason is
  'risk, dispute, billing, closure or review, the five causes the statement groups by.';

comment on column public.holds.status is
  'active while the money stays back, then released or collected.';

comment on column public.holds.placed_at is
  'When the hold was placed.';

comment on column public.holds.release_due_at is
  'When the hold is due to be released, after the placement instant.';

comment on column public.holds.released_at is
  'Set exactly when the hold was released.';

comment on column public.holds.released_by is
  'The person who released the hold, required with the instant.';

comment on column public.holds.collected_at is
  'Set exactly when the held money was taken to cover a shortfall.';

comment on column public.holds.collected_by is
  'The person who took the held money, required with the instant.';

comment on column public.holds.note is
  'Why the money was collected or what the release recorded, at most 280 characters, trimmed.';

comment on column public.holds.created_at is
  'When the row was written.';

comment on column public.holds.updated_at is
  'Maintained by public.set_row_metadata() on every update.';

comment on column public.holds.deleted_at is
  'Soft delete marker, refused once the hold has closed.';

comment on column public.holds.version is
  'Optimistic concurrency counter, incremented by public.set_row_metadata().';

-- What is still held and due, for the release job.
create index holds_open_idx
  on public.holds (company_id, release_due_at)
  where status = 'active' and deleted_at is null;

-- Every hold of one payment, for the cap and for the payment screen.
create index holds_payment_idx
  on public.holds (payment_id)
  where payment_id is not null;

-- Every hold of one batch.
create index holds_settlement_idx
  on public.holds (settlement_id)
  where settlement_id is not null;

create trigger holds_guard_owner
  before insert or update on public.holds
  for each row
  execute function public.holds_guard_owner();

create trigger holds_guard_amount
  before insert or update on public.holds
  for each row
  execute function public.holds_guard_amount();

create trigger holds_guard_state
  before update on public.holds
  for each row
  execute function public.holds_guard_state();

create trigger holds_set_row_metadata
  before update on public.holds
  for each row
  execute function public.set_row_metadata();

alter table public.holds enable row level security;

create policy holds_default_deny
  on public.holds
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
