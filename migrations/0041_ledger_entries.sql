-- path: migrations/0041_ledger_entries.sql
-- STEP 025 - the double-entry ledger entries of section 11.
--
-- "Every money movement writes a debit entry and a credit entry and the pair always balances to zero."
-- Two facts make that sentence true here rather than promised. The first is the group: `entry_group_id`
-- names the movement, and a deferred constraint trigger sums the debits and the credits of that group
-- when the transaction ends and refuses to commit unless they are equal, both present and in one
-- currency for one merchant. A writer therefore cannot half post a movement, and a caller that inserts
-- only one side gets an error at commit rather than an unbalanced ledger.
--
-- The second is that a posted row never changes. `ledger_entries_guard_append_only` refuses every
-- update and every removal whatever role asks, which is "ledger entries are never edited or deleted" in
-- the only place that can enforce it. A correction is a reversing entry: `reversal_of_id` names what it
-- undoes, the unique index allows an entry to be reversed once, and the reversal guard refuses a row
-- whose side is not the opposite or whose amount is not the same, because that is a different movement
-- wearing a reversal's name.
--
-- An entry names its source. `source_type` is the closed vocabulary of the ten movements of section 11
-- - payment, platform fee, hold, reserve, settlement, payout, refund, chargeback, chargeback fee and
-- subscription charge - and `payment_id`, `refund_id` and `dispute_id` are foreign keys for the three
-- sources this schema already stores, paired by checks so a payment cannot be filed as a refund.
--
-- `ledger_entries_sync_invoice` closes the link STEP 024 left open. When a payment posting lands, the
-- invoice of that payment receives `amount_paid_minor` and the `partially_paid` or `paid` state it
-- implies, and an overpayment settles the invoice at its total with the difference staying in the
-- ledger. The invoice guard already freezes a paid invoice, so the sync leaves an invoice that is
-- already paid alone.
--
-- The sync refuses two invoices rather than writing a state section 16 cannot hold. A draft has no
-- number and no issue instant, so `invoices_issue_check` would reject the paid state anyway and the
-- payment says the document was issued: the entry fails and the caller learns to issue its invoice
-- first. A total of zero has nothing to settle, so a payment against it is a mistake rather than a
-- payment, and a partial payment under the 20 USD floor of that same section has no legal state
-- either. All three are errors at the write, not a silent ignoring of the money.

begin;

create function public.ledger_entries_guard_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'ledger entries are append only'
    using errcode = 'check_violation';
end;
$$;

comment on function public.ledger_entries_guard_append_only() is
  'Refuses every update and every removal of a posted entry, as section 11 requires.';

create function public.ledger_entries_guard_account()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  account_company uuid;
begin
  select company_id into account_company from public.ledger_accounts where id = new.account_id;

  if account_company is not null and account_company is distinct from new.company_id then
    raise exception 'a ledger entry posts to an account of its own merchant'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.ledger_entries_guard_account() is
  'Keeps an entry inside its own merchant chart while allowing the platform accounts.';

create function public.ledger_entries_guard_reversal()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  original_side text;
  original_amount bigint;
  original_currency text;
  original_company uuid;
  original_group uuid;
begin
  if new.reversal_of_id is null then
    return new;
  end if;

  select entry_side, amount_minor, currency, company_id, entry_group_id
    into original_side, original_amount, original_currency, original_company, original_group
  from public.ledger_entries where id = new.reversal_of_id;

  if original_side is null then
    raise exception 'a reversal names an entry that exists'
      using errcode = 'check_violation';
  end if;

  if new.entry_side = original_side then
    raise exception 'a reversal is the opposite side of the entry it undoes'
      using errcode = 'check_violation';
  end if;

  if new.amount_minor <> original_amount then
    raise exception 'a reversal is the same amount as the entry it undoes'
      using errcode = 'check_violation';
  end if;

  if new.currency <> original_currency or new.company_id <> original_company then
    raise exception 'a reversal stays in the currency and the merchant of the entry it undoes'
      using errcode = 'check_violation';
  end if;

  if new.entry_group_id = original_group then
    raise exception 'a reversal is its own balanced group'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.ledger_entries_guard_reversal() is
  'Makes a reversal a mirror of the entry it undoes, inside its own balanced group.';

create function public.ledger_entries_check_balance()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  debits bigint;
  credits bigint;
  row_count integer;
  currencies integer;
  companies integer;
begin
  select coalesce(sum(amount_minor) filter (where entry_side = 'debit'), 0),
         coalesce(sum(amount_minor) filter (where entry_side = 'credit'), 0),
         count(*),
         count(distinct currency),
         count(distinct company_id)
    into debits, credits, row_count, currencies, companies
  from public.ledger_entries
  where entry_group_id = new.entry_group_id;

  if row_count < 2 then
    raise exception 'a ledger group needs a debit and a credit'
      using errcode = 'check_violation';
  end if;

  if currencies <> 1 then
    raise exception 'a ledger group is in one currency'
      using errcode = 'check_violation';
  end if;

  if companies <> 1 then
    raise exception 'a ledger group belongs to one merchant'
      using errcode = 'check_violation';
  end if;

  if debits <> credits then
    raise exception 'a ledger group must balance to zero'
      using errcode = 'check_violation';
  end if;

  return null;
end;
$$;

comment on function public.ledger_entries_check_balance() is
  'Runs at commit and refuses a group whose debits and credits are not the same number.';

create function public.ledger_entries_sync_invoice()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  invoice_id_value uuid;
  invoice_total bigint;
  invoice_status text;
  invoice_currency text;
  invoice_number text;
  invoice_issued timestamptz;
  paid bigint;
begin
  if new.source_type <> 'payment' or new.payment_id is null then
    return null;
  end if;

  select invoice_id into invoice_id_value from public.payments where id = new.payment_id;

  if invoice_id_value is null then
    return null;
  end if;

  select total_minor, status, currency, number, issued_at
    into invoice_total, invoice_status, invoice_currency, invoice_number, invoice_issued
  from public.invoices where id = invoice_id_value;

  if invoice_total is null or invoice_status = 'paid' then
    return null;
  end if;

  if invoice_number is null or invoice_issued is null then
    raise exception 'a payment cannot settle an invoice that was never issued'
      using errcode = 'check_violation';
  end if;

  if invoice_total = 0 then
    raise exception 'a payment cannot settle an invoice whose total is zero'
      using errcode = 'check_violation';
  end if;

  select coalesce(sum(p.amount_minor), 0) into paid
  from public.payments p
  where p.invoice_id = invoice_id_value
    and p.status in ('captured', 'settled', 'partially_refunded', 'refunded')
    and exists (
      select 1 from public.ledger_entries e
      where e.payment_id = p.id and e.source_type = 'payment'
    );

  if paid = 0 then
    return null;
  end if;

  if paid >= invoice_total then
    update public.invoices
    set amount_paid_minor = invoice_total, status = 'paid', paid_at = coalesce(paid_at, now())
    where id = invoice_id_value;
  elsif paid >= 2000 or invoice_currency <> 'USD' then
    update public.invoices
    set amount_paid_minor = paid, status = 'partially_paid', paid_at = null
    where id = invoice_id_value;
  else
    raise exception 'a partial payment below the 2000 minor unit floor cannot settle an invoice'
      using errcode = 'check_violation';
  end if;

  return null;
end;
$$;

comment on function public.ledger_entries_sync_invoice() is
  'Writes the invoice paid total and state from the posted payment entries.';

create table public.ledger_entries (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid not null,
  account_id uuid not null,
  entry_group_id uuid not null,
  entry_side text not null,
  amount_minor bigint not null,
  currency text not null default 'USD',
  occurred_at timestamptz not null default now(),
  source_type text not null,
  source_id uuid not null,
  payment_id uuid,
  refund_id uuid,
  dispute_id uuid,
  description text,
  reversal_of_id uuid,
  posted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint ledger_entries_pkey primary key (id),
  constraint ledger_entries_company_fkey foreign key (company_id) references public.companies (id),
  constraint ledger_entries_account_fkey foreign key (account_id)
    references public.ledger_accounts (id),
  constraint ledger_entries_payment_fkey foreign key (payment_id) references public.payments (id),
  constraint ledger_entries_refund_fkey foreign key (refund_id) references public.refunds (id),
  constraint ledger_entries_dispute_fkey foreign key (dispute_id) references public.disputes (id),
  constraint ledger_entries_reversal_fkey foreign key (reversal_of_id)
    references public.ledger_entries (id),
  constraint ledger_entries_side_check check (entry_side in ('debit', 'credit')),
  constraint ledger_entries_amount_check check (amount_minor > 0),
  constraint ledger_entries_currency_check check (currency ~ '^[A-Z]{3}$'),
  constraint ledger_entries_source_check check (
    source_type in ('payment', 'platform_fee', 'hold', 'reserve', 'settlement', 'payout', 'refund',
                    'chargeback', 'chargeback_fee', 'subscription_charge')
  ),
  constraint ledger_entries_payment_pair_check check (
    (source_type = 'payment') = (payment_id is not null)
  ),
  constraint ledger_entries_refund_pair_check check (
    (source_type = 'refund') = (refund_id is not null)
  ),
  constraint ledger_entries_dispute_pair_check check (
    (source_type in ('chargeback', 'chargeback_fee')) = (dispute_id is not null)
  ),
  constraint ledger_entries_description_check check (
    description is null
    or (
      char_length(description) between 1 and 280
      and description = btrim(description)
    )
  ),
  constraint ledger_entries_self_reversal_check check (reversal_of_id is null or reversal_of_id <> id),
  constraint ledger_entries_row_version_check check (version > 0),
  constraint ledger_entries_updated_check check (updated_at >= created_at),
  constraint ledger_entries_deleted_check check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.ledger_entries is
  'One side of one money movement. Balanced in its group, append only, corrected by reversal.';

comment on column public.ledger_entries.id is
  'UUID v7 primary key. Time ordered, generated by public.uuid_generate_v7().';

comment on column public.ledger_entries.company_id is
  'The merchant whose money moved. One group belongs to one merchant.';

comment on column public.ledger_entries.account_id is
  'The chart row this side posts to, either the merchant account or a platform one.';

comment on column public.ledger_entries.entry_group_id is
  'The movement this line belongs to. The deferred trigger balances the group at commit.';

comment on column public.ledger_entries.entry_side is
  'debit or credit. Every group has at least one of each.';

comment on column public.ledger_entries.amount_minor is
  'How much this side moves, in minor units of the currency, always positive.';

comment on column public.ledger_entries.currency is
  'Three upper case letters. One group is in one currency.';

comment on column public.ledger_entries.occurred_at is
  'When the money moved, which is what the statement orders by.';

comment on column public.ledger_entries.source_type is
  'The ten section 11 movements: payment, platform_fee, hold, reserve, settlement, payout, refund,
  chargeback, chargeback_fee or subscription_charge.';

comment on column public.ledger_entries.source_id is
  'The row that caused the movement, in the table its source type names.';

comment on column public.ledger_entries.payment_id is
  'The payment this side posts for, present exactly when the source type is payment.';

comment on column public.ledger_entries.refund_id is
  'The refund this side posts for, present exactly when the source type is refund.';

comment on column public.ledger_entries.dispute_id is
  'The dispute this side posts for, present exactly on a chargeback or chargeback fee.';

comment on column public.ledger_entries.description is
  'What the merchant reads on the statement, at most 280 characters, trimmed.';

comment on column public.ledger_entries.reversal_of_id is
  'The entry this one undoes. An entry is reversed at most once.';

comment on column public.ledger_entries.posted_at is
  'When the entry was written. It never changes.';

comment on column public.ledger_entries.created_at is
  'When the row was written.';

comment on column public.ledger_entries.updated_at is
  'Never moves: the append only guard refuses every update.';

comment on column public.ledger_entries.deleted_at is
  'Never set: the append only guard refuses every removal.';

comment on column public.ledger_entries.version is
  'Always one: the append only guard refuses every update.';

-- An entry is reversed at most once, so a correction cannot fork.
create unique index ledger_entries_reversal_key
  on public.ledger_entries (reversal_of_id)
  where reversal_of_id is not null;

-- The merchant statement, newest first.
create index ledger_entries_statement_idx
  on public.ledger_entries (company_id, occurred_at desc, id desc);

-- One account's running detail.
create index ledger_entries_account_idx
  on public.ledger_entries (account_id, occurred_at);

-- The balance check and the group read.
create index ledger_entries_group_idx
  on public.ledger_entries (entry_group_id);

-- Reconciliation: every entry of one payment, refund or dispute.
create index ledger_entries_source_idx
  on public.ledger_entries (source_type, source_id);

create trigger ledger_entries_guard_append_only
  before update or delete on public.ledger_entries
  for each row
  execute function public.ledger_entries_guard_append_only();

create trigger ledger_entries_guard_account
  before insert or update on public.ledger_entries
  for each row
  execute function public.ledger_entries_guard_account();

create trigger ledger_entries_guard_reversal
  before insert or update on public.ledger_entries
  for each row
  execute function public.ledger_entries_guard_reversal();

create trigger ledger_entries_sync_invoice
  after insert on public.ledger_entries
  for each row
  execute function public.ledger_entries_sync_invoice();

create constraint trigger ledger_entries_balanced
  after insert on public.ledger_entries
  deferrable initially deferred
  for each row
  execute function public.ledger_entries_check_balance();

alter table public.ledger_entries enable row level security;

create policy ledger_entries_default_deny
  on public.ledger_entries
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
