-- path: migrations/0046_payout_bank_accounts.sql
-- STEP 027 - the payout bank account of section 10, and the payout that names it.
--
-- A merchant adds a payout bank account in its profile. The account number is a secret and is stored
-- the way STEP 023 stores a processor key: AES-256-GCM ciphertext with its vector, its tag and the
-- encryption key version, plus four visible characters so the merchant can recognise the account and a
-- SHA-256 fingerprint so the same account can be found again without decrypting anything. No column
-- here holds a plain account number.
--
-- An account has a life rather than a flag. It is `pending` when submitted, `verified` when a person
-- passed the manual verification section 10 requires, `active` when payouts may use it, and either
-- `rejected` or `retired` at the end. Each state carries its own instant, the verifier is a person,
-- and a rejection carries its reason. `rejected` and `retired` are terminal.
--
-- One account is active per merchant. The partial unique index on `(company_id)` where the status is
-- `active` makes "the bank we pay to" a single answer, and a second partial unique index on the
-- fingerprint stops the same account being added twice while it is live.
--
-- This file also adds `payouts.bank_account_id`. STEP 026 recorded that the payout destination was a
-- snapshot only because the account table did not exist yet; the column and its composite foreign key
-- arrive here, so a payout can no longer name another merchant's account, and the snapshot columns
-- stay on the payout row because an audit reads the row as it was even after the account is retired.

begin;

create function public.payout_bank_accounts_guard_state()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.company_id is distinct from old.company_id
     or new.bank_name is distinct from old.bank_name
     or new.account_holder is distinct from old.account_holder
     or new.country is distinct from old.country
     or new.currency is distinct from old.currency
     or new.account_last_four is distinct from old.account_last_four
     or new.account_fingerprint is distinct from old.account_fingerprint
     or new.account_number_ciphertext is distinct from old.account_number_ciphertext
     or new.account_number_iv is distinct from old.account_number_iv
     or new.account_number_tag is distinct from old.account_number_tag
     or new.encryption_key_version is distinct from old.encryption_key_version then
    raise exception 'a bank account keeps its merchant, its holder, its bank and its number'
      using errcode = 'check_violation';
  end if;

  if old.status in ('rejected', 'retired')
     and (to_jsonb(new) - 'updated_at' - 'version')
         is distinct from (to_jsonb(old) - 'updated_at' - 'version') then
    raise exception 'a rejected or retired bank account is history'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.payout_bank_accounts_guard_state() is
  'Freezes the identity of a bank account and locks it once rejected or retired.';

create table public.payout_bank_accounts (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid not null,
  bank_name text not null,
  account_holder text not null,
  country text not null,
  currency text not null default 'USD',
  account_last_four text not null,
  account_fingerprint text not null,
  account_number_ciphertext text not null,
  account_number_iv text not null,
  account_number_tag text not null,
  encryption_key_version integer not null default 1,
  status text not null default 'pending',
  submitted_at timestamptz not null default now(),
  verified_at timestamptz,
  verified_by uuid,
  rejected_at timestamptz,
  rejection_note text,
  activated_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint payout_bank_accounts_pkey primary key (id),
  constraint payout_bank_accounts_tenant_key unique (id, company_id),
  constraint payout_bank_accounts_company_fkey foreign key (company_id)
    references public.companies (id),
  constraint payout_bank_accounts_verified_by_fkey foreign key (verified_by)
    references public.users (id),
  constraint payout_bank_accounts_bank_check check (
    char_length(bank_name) between 2 and 120 and bank_name = btrim(bank_name)
  ),
  constraint payout_bank_accounts_holder_check check (
    char_length(account_holder) between 2 and 120 and account_holder = btrim(account_holder)
  ),
  constraint payout_bank_accounts_country_check check (country ~ '^[A-Z]{2}$'),
  constraint payout_bank_accounts_currency_check check (currency ~ '^[A-Z]{3}$'),
  constraint payout_bank_accounts_tail_check check (account_last_four ~ '^[A-Za-z0-9]{4}$'),
  constraint payout_bank_accounts_fingerprint_check check (account_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint payout_bank_accounts_ciphertext_check check (
    char_length(account_number_ciphertext) between 16 and 8192
  ),
  constraint payout_bank_accounts_iv_check check (char_length(account_number_iv) between 12 and 64),
  constraint payout_bank_accounts_tag_check check (char_length(account_number_tag) between 16 and 64),
  constraint payout_bank_accounts_key_version_check check (encryption_key_version between 1 and 999),
  constraint payout_bank_accounts_status_check check (
    status in ('pending', 'verified', 'active', 'rejected', 'retired')
  ),
  constraint payout_bank_accounts_verified_instant_check check (
    (status in ('verified', 'active', 'retired')) = (verified_at is not null)
  ),
  constraint payout_bank_accounts_verified_by_check check (
    (status in ('verified', 'active', 'retired')) = (verified_by is not null)
  ),
  constraint payout_bank_accounts_rejected_instant_check check (
    (status = 'rejected') = (rejected_at is not null)
  ),
  constraint payout_bank_accounts_rejection_note_check check (
    (status = 'rejected') = (rejection_note is not null)
    and (
      rejection_note is null
      or (
        char_length(rejection_note) between 1 and 280
        and rejection_note = btrim(rejection_note)
      )
    )
  ),
  constraint payout_bank_accounts_active_instant_check check (
    (status = 'active') = (activated_at is not null)
  ),
  constraint payout_bank_accounts_retired_instant_check check (
    (status = 'retired') = (retired_at is not null)
  ),
  constraint payout_bank_accounts_instants_check check (
    (verified_at is null or verified_at >= submitted_at)
    and (rejected_at is null or rejected_at >= submitted_at)
    and (activated_at is null or activated_at >= submitted_at)
    and (retired_at is null or retired_at >= submitted_at)
  ),
  constraint payout_bank_accounts_row_version_check check (version > 0),
  constraint payout_bank_accounts_updated_check check (updated_at >= created_at),
  constraint payout_bank_accounts_deleted_check check (
    deleted_at is null or deleted_at >= created_at
  )
);

comment on table public.payout_bank_accounts is
  'The bank account a merchant is paid to, with its number as ciphertext and its verification history.';

comment on column public.payout_bank_accounts.id is
  'UUID v7 primary key. Time ordered, generated by public.uuid_generate_v7().';

comment on column public.payout_bank_accounts.company_id is
  'The merchant that owns the account. Frozen after the row is written.';

comment on column public.payout_bank_accounts.bank_name is
  'The bank as the merchant named it, 2 to 120 trimmed characters.';

comment on column public.payout_bank_accounts.account_holder is
  'The holder name on the account, 2 to 120 trimmed characters.';

comment on column public.payout_bank_accounts.country is
  'The two letter country of the bank.';

comment on column public.payout_bank_accounts.currency is
  'The three letter currency the account is paid in.';

comment on column public.payout_bank_accounts.account_last_four is
  'The four visible characters of the account number, so the merchant recognises it.';

comment on column public.payout_bank_accounts.account_fingerprint is
  'SHA-256 of the account number, 64 lower case hex, so a duplicate is found without decrypting.';

comment on column public.payout_bank_accounts.account_number_ciphertext is
  'The AES-256-GCM ciphertext of the account number. The plain number is never a column here.';

comment on column public.payout_bank_accounts.account_number_iv is
  'The initialisation vector of that ciphertext.';

comment on column public.payout_bank_accounts.account_number_tag is
  'The authentication tag of that ciphertext.';

comment on column public.payout_bank_accounts.encryption_key_version is
  'Which encryption key version the ciphertext was written with, from 1 to 999.';

comment on column public.payout_bank_accounts.status is
  'pending, verified, active, rejected or retired. The last two lock the row.';

comment on column public.payout_bank_accounts.submitted_at is
  'When the merchant submitted the account.';

comment on column public.payout_bank_accounts.verified_at is
  'Set exactly when a person verified the account.';

comment on column public.payout_bank_accounts.verified_by is
  'The person who verified the account, required with the instant.';

comment on column public.payout_bank_accounts.rejected_at is
  'Set exactly when the account was rejected.';

comment on column public.payout_bank_accounts.rejection_note is
  'Why the account was rejected, at most 280 characters and trimmed.';

comment on column public.payout_bank_accounts.activated_at is
  'Set exactly when the account became the merchant payout account.';

comment on column public.payout_bank_accounts.retired_at is
  'Set exactly when the account stopped being used.';

comment on column public.payout_bank_accounts.created_at is
  'When the row was written.';

comment on column public.payout_bank_accounts.updated_at is
  'Maintained by public.set_row_metadata() on every update.';

comment on column public.payout_bank_accounts.deleted_at is
  'Soft delete marker, refused once the account is rejected or retired.';

comment on column public.payout_bank_accounts.version is
  'Optimistic concurrency counter, incremented by public.set_row_metadata().';

-- The bank we pay to is one row per merchant.
create unique index payout_bank_accounts_active_key
  on public.payout_bank_accounts (company_id)
  where status = 'active' and deleted_at is null;

-- The same account is not added twice while it is live.
create unique index payout_bank_accounts_fingerprint_key
  on public.payout_bank_accounts (company_id, account_fingerprint)
  where deleted_at is null and status <> 'retired';

-- The merchant's account list, newest first.
create index payout_bank_accounts_page_idx
  on public.payout_bank_accounts (company_id, submitted_at desc)
  where deleted_at is null;

create trigger payout_bank_accounts_guard_state
  before update on public.payout_bank_accounts
  for each row
  execute function public.payout_bank_accounts_guard_state();

create trigger payout_bank_accounts_set_row_metadata
  before update on public.payout_bank_accounts
  for each row
  execute function public.set_row_metadata();

alter table public.payout_bank_accounts enable row level security;

create policy payout_bank_accounts_default_deny
  on public.payout_bank_accounts
  as permissive
  for all
  to public
  using (false)
  with check (false);

-- The payout names its account now that the account exists. The composite key keeps a payout inside
-- its own merchant, and the three snapshot columns of STEP 026 stay as the record of where the money
-- actually went.
alter table public.payouts
  add column bank_account_id uuid,
  add constraint payouts_bank_account_fkey foreign key (bank_account_id, company_id)
    references public.payout_bank_accounts (id, company_id);

comment on column public.payouts.bank_account_id is
  'The verified bank account the payout was sent to, when it names one from STEP 027.';

create index payouts_bank_account_idx
  on public.payouts (bank_account_id)
  where bank_account_id is not null;

commit;
