-- path: migrations/0055_card_blacklist.sql
-- STEP 030 - the card blacklist of section 18.
--
-- Section 18: "Card blacklist entries use card token or provider card fingerprint", and the same
-- section forbids the platform from reading or storing card data at all. The row therefore keeps
-- `card_fingerprint`, the SHA-256 of whichever of the two the adapter hands back, and
-- `fingerprint_source` records which one it was. No card number, expiry, CVV or clear token is a
-- column here, and the payment page matches a returning card by hashing what the adapter returns.
--
-- The block is the platform's, not a merchant's: `company_id` exists for the tenancy rule and
-- `card_blacklist_platform_check` forces it to null, the same shape the provider catalogue uses. A
-- card used to test cards across ten merchants is one block.
--
-- A block has a life. `status` is `active` or `released`, and `card_blacklist_guard_state` walks
-- it one way: the fingerprint, its source, its provider, its payment, the reason, the person, the
-- instant and the expiry are frozen, a release cannot be undone, and a released row is history
-- with its person, its instant and its note. One active block exists per fingerprint, so two
-- people cannot block the same card twice. A block never ends by a soft delete, because a delete
-- would drop it off the list without the person, the instant and the note a release records.
--
-- `expires_at` is the temporary block; a row without it stays until a person releases it.

begin;

create function public.card_blacklist_guard_state()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.deleted_at is distinct from old.deleted_at then
    raise exception 'a card block ends by a release, not by a delete'
      using errcode = 'check_violation';
  end if;

  if new.company_id is distinct from old.company_id
     or new.card_fingerprint is distinct from old.card_fingerprint
     or new.fingerprint_source is distinct from old.fingerprint_source
     or new.provider_id is distinct from old.provider_id
     or new.reason is distinct from old.reason
     or new.source_payment_id is distinct from old.source_payment_id
     or new.blacklisted_by is distinct from old.blacklisted_by
     or new.blacklisted_at is distinct from old.blacklisted_at
     or new.expires_at is distinct from old.expires_at then
    raise exception 'a card block keeps its fingerprint, its source and its reason'
      using errcode = 'check_violation';
  end if;

  if new.status is distinct from old.status
     and not (old.status = 'active' and new.status = 'released') then
    raise exception 'a card block is released once and never reopened'
      using errcode = 'check_violation';
  end if;

  if old.status = 'released'
     and (to_jsonb(new) - 'updated_at' - 'version')
         is distinct from (to_jsonb(old) - 'updated_at' - 'version') then
    raise exception 'a released card block is history'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.card_blacklist_guard_state() is
  'Freezes a card block, releases it once, locks a released row and refuses a delete.';

create table public.card_blacklist (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid,
  card_fingerprint text not null,
  fingerprint_source text not null,
  provider_id uuid,
  reason text not null,
  note text,
  status text not null default 'active',
  source_payment_id uuid,
  blacklisted_by uuid not null,
  blacklisted_at timestamptz not null default now(),
  released_by uuid,
  released_at timestamptz,
  release_note text,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint card_blacklist_pkey primary key (id),
  constraint card_blacklist_company_fkey foreign key (company_id) references public.companies (id),
  constraint card_blacklist_platform_check check (company_id is null),
  constraint card_blacklist_provider_fkey foreign key (provider_id)
    references public.payment_providers (id),
  constraint card_blacklist_payment_fkey foreign key (source_payment_id)
    references public.payments (id),
  constraint card_blacklist_blacklisted_by_fkey foreign key (blacklisted_by)
    references public.users (id),
  constraint card_blacklist_released_by_fkey foreign key (released_by) references public.users (id),
  constraint card_blacklist_fingerprint_check check (
    card_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  constraint card_blacklist_source_check check (
    fingerprint_source in ('card_token', 'provider_fingerprint')
  ),
  constraint card_blacklist_reason_check check (
    reason in ('fraud', 'card_testing', 'chargeback', 'stolen_card', 'compliance', 'other')
  ),
  constraint card_blacklist_note_check check (
    (reason <> 'other' or note is not null)
    and (
      note is null
      or (
        char_length(note) between 1 and 500
        and note = btrim(note)
      )
    )
  ),
  constraint card_blacklist_status_check check (status in ('active', 'released')),
  constraint card_blacklist_release_check check (
    (status = 'released') = (released_at is not null)
    and (status = 'released') = (released_by is not null)
  ),
  constraint card_blacklist_release_note_check check (
    (status = 'released') = (release_note is not null)
    and (
      release_note is null
      or (
        char_length(release_note) between 1 and 500
        and release_note = btrim(release_note)
      )
    )
  ),
  constraint card_blacklist_expiry_check check (
    expires_at is null or expires_at > blacklisted_at
  ),
  constraint card_blacklist_order_check check (
    blacklisted_at <= created_at
    and (released_at is null or released_at >= blacklisted_at)
  ),
  constraint card_blacklist_row_version_check check (version > 0),
  constraint card_blacklist_updated_check check (updated_at >= created_at),
  constraint card_blacklist_deleted_check check (
    deleted_at is null or deleted_at >= created_at
  )
);

comment on table public.card_blacklist is
  'One blocked card, by the hash of its token or provider fingerprint, with its reason and its life.';

comment on column public.card_blacklist.id is
  'UUID v7 primary key. Time ordered, generated by public.uuid_generate_v7().';

comment on column public.card_blacklist.company_id is
  'Always null: the blacklist is the platform''s, and the column exists for the tenancy rule.';

comment on column public.card_blacklist.card_fingerprint is
  'SHA-256 of the card token or of the provider card fingerprint, never a card number.';

comment on column public.card_blacklist.fingerprint_source is
  'card_token or provider_fingerprint, which of the two the adapter returned.';

comment on column public.card_blacklist.provider_id is
  'The processor that produced the token or the fingerprint, when one is known.';

comment on column public.card_blacklist.reason is
  'fraud, card_testing, chargeback, stolen_card, compliance or other.';

comment on column public.card_blacklist.note is
  'The case note, required when the reason is other, at most 500 characters and trimmed.';

comment on column public.card_blacklist.status is
  'active or released. A released block is history.';

comment on column public.card_blacklist.source_payment_id is
  'The payment whose card was blocked, when the block came from one.';

comment on column public.card_blacklist.blacklisted_by is
  'The person who blocked the card.';

comment on column public.card_blacklist.blacklisted_at is
  'When the card was blocked, never after the row that records it.';

comment on column public.card_blacklist.released_by is
  'The person who lifted the block, required with the release instant.';

comment on column public.card_blacklist.released_at is
  'When the block was lifted.';

comment on column public.card_blacklist.release_note is
  'Why the block was lifted, required when the row is released.';

comment on column public.card_blacklist.expires_at is
  'When a temporary block ends by itself, after the block instant.';

comment on column public.card_blacklist.created_at is
  'When the row was written.';

comment on column public.card_blacklist.updated_at is
  'Maintained by public.set_row_metadata() on every update.';

comment on column public.card_blacklist.deleted_at is
  'Soft delete marker, frozen by the guard because a block ends by a release.';

comment on column public.card_blacklist.version is
  'Optimistic concurrency counter, incremented by public.set_row_metadata().';

-- One active block per fingerprint, so two people cannot block the same card twice.
create unique index card_blacklist_active_key
  on public.card_blacklist (card_fingerprint)
  where status = 'active' and deleted_at is null;

-- The block history, newest first.
create index card_blacklist_history_idx
  on public.card_blacklist (blacklisted_at desc)
  where deleted_at is null;

-- The blocks that came from one payment.
create index card_blacklist_payment_idx
  on public.card_blacklist (source_payment_id)
  where source_payment_id is not null;

create trigger card_blacklist_guard_state
  before update on public.card_blacklist
  for each row
  execute function public.card_blacklist_guard_state();

create trigger card_blacklist_set_row_metadata
  before update on public.card_blacklist
  for each row
  execute function public.set_row_metadata();

alter table public.card_blacklist enable row level security;

create policy card_blacklist_default_deny
  on public.card_blacklist
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
