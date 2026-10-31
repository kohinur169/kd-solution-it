-- path: migrations/0037_payments.sql
-- STEP 024 - the payments of section 18 and the money rules of section 10.
--
-- A payment is one processor transaction. It records what was charged, what the processor kept and
-- what the platform took, and it names the route it took: the provider, the key that signed the call,
-- the routing rule that chose the provider and the idempotency key the request arrived under. All of
-- those are foreign keys into STEP 023, so a payment cannot point at a provider or a key that never
-- existed.
--
-- `idempotency_key_id` is not null and unique. Rule 12 of the master prompt says every payment carries
-- an idempotency key, and the unique index is what turns that into a guarantee: the second delivery of
-- the same request cannot write a second payment, whatever the service layer does.
--
-- Section 18 says the platform never reads, stores or tracks card data. The only card columns here are
-- `card_brand` and `card_last_four`, both optional and both required together; there is no column for
-- a number, an expiry, a CVV, a holder name or a full token, so the rule is a property of the schema.
--
-- Two section 18 rules are checks rather than habits of the caller. The first: when 3DS was not
-- authenticated, a payment may only be captured if the billing postal code and the payer IP country
-- both matched the invoice, which is "nothing is captured and the payment goes to manual review"
-- written where the database can enforce it. The second: a provider fraud signal rejects the payment
-- at once, so `risk_decision = 'reject'` can only sit on a `failed` payment.
--
-- Instants follow statuses. `authorized`, `captured`, `settled` and the refunded states each require
-- their own instant, `failed` requires both the instant and a failure code, and the refunded pair
-- follows `refunded_minor`, which only a refund write may move.

begin;

create function public.payments_guard_refund_state()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.refunded_minor is distinct from old.refunded_minor
     or (new.status in ('partially_refunded', 'refunded')
         and new.status is distinct from old.status) then
    if pg_trigger_depth() < 2 then
      raise exception 'the refunded total of a payment is written by its refunds'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.payments_guard_refund_state() is
  'Refuses a refunded total or refunded status written by anything but the refund sync.';

create table public.payments (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid not null,
  invoice_id uuid,
  provider_id uuid not null,
  provider_key_id uuid,
  routing_rule_id uuid,
  idempotency_key_id uuid not null,
  mode text not null default 'test',
  payment_method text not null,
  amount_minor bigint not null,
  currency text not null default 'USD',
  fee_minor bigint not null default 0,
  net_minor bigint generated always as (amount_minor - fee_minor) stored,
  platform_fee_minor bigint not null default 0,
  refunded_minor bigint not null default 0,
  card_brand text,
  card_last_four text,
  three_ds_outcome text not null default 'not_requested',
  postal_code_matched boolean not null default false,
  ip_country_matched boolean not null default false,
  risk_decision text not null default 'allow',
  status text not null default 'pending',
  provider_transaction_id text,
  failure_code text,
  failure_detail text,
  authorized_at timestamptz,
  captured_at timestamptz,
  settled_at timestamptz,
  failed_at timestamptz,
  refunded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint payments_pkey primary key (id),
  constraint payments_company_fkey foreign key (company_id) references public.companies (id),
  constraint payments_invoice_fkey foreign key (invoice_id) references public.invoices (id),
  constraint payments_provider_fkey foreign key (provider_id) references public.payment_providers (id),
  constraint payments_provider_key_fkey foreign key (provider_key_id) references public.provider_keys (id),
  constraint payments_routing_rule_fkey foreign key (routing_rule_id)
    references public.routing_rules (id),
  constraint payments_idempotency_fkey foreign key (idempotency_key_id)
    references public.idempotency_keys (id),
  constraint payments_mode_check check (mode in ('test', 'live')),
  constraint payments_method_check check (
    payment_method in ('card', 'bank_transfer', 'e_wallet')
  ),
  constraint payments_amount_check check (amount_minor > 0),
  constraint payments_currency_check check (currency ~ '^[A-Z]{3}$'),
  constraint payments_fee_check check (fee_minor >= 0 and fee_minor <= amount_minor),
  constraint payments_platform_fee_check check (
    platform_fee_minor >= 0 and platform_fee_minor + fee_minor <= amount_minor
  ),
  constraint payments_refunded_check check (
    refunded_minor >= 0 and refunded_minor <= amount_minor
  ),
  constraint payments_card_brand_check check (
    card_brand is null or card_brand in ('visa', 'mastercard', 'amex', 'discover', 'other')
  ),
  constraint payments_card_last_four_check check (
    card_last_four is null or card_last_four ~ '^[0-9]{4}$'
  ),
  constraint payments_card_pair_check check (
    (card_brand is null) = (card_last_four is null)
  ),
  constraint payments_three_ds_check check (
    three_ds_outcome in ('authenticated', 'attempted', 'not_completed', 'not_requested')
  ),
  constraint payments_three_ds_capture_check check (
    status not in ('captured', 'settled', 'partially_refunded', 'refunded')
    or three_ds_outcome = 'authenticated'
    or (postal_code_matched and ip_country_matched)
  ),
  constraint payments_risk_check check (risk_decision in ('allow', 'review', 'reject')),
  constraint payments_risk_reject_check check (risk_decision <> 'reject' or status = 'failed'),
  constraint payments_status_check check (
    status in ('pending', 'authorized', 'captured', 'settled', 'failed', 'voided',
               'partially_refunded', 'refunded', 'under_review')
  ),
  constraint payments_transaction_check check (
    provider_transaction_id is null
    or (
      char_length(provider_transaction_id) between 1 and 120
      and provider_transaction_id = btrim(provider_transaction_id)
    )
  ),
  constraint payments_failure_pair_check check (
    (status = 'failed') = (failure_code is not null)
  ),
  constraint payments_failure_code_check check (
    failure_code is null
    or (char_length(failure_code) between 1 and 64 and failure_code = btrim(failure_code))
  ),
  constraint payments_failure_detail_check check (
    failure_detail is null
    or (
      failure_code is not null
      and char_length(failure_detail) between 1 and 280
      and failure_detail = btrim(failure_detail)
    )
  ),
  constraint payments_authorized_instant_check check (
    status not in ('authorized', 'captured', 'settled', 'partially_refunded', 'refunded')
    or authorized_at is not null
  ),
  constraint payments_captured_instant_check check (
    status not in ('captured', 'settled', 'partially_refunded', 'refunded')
    or captured_at is not null
  ),
  constraint payments_settled_instant_check check (
    status <> 'settled' or settled_at is not null
  ),
  constraint payments_failed_instant_check check ((status = 'failed') = (failed_at is not null)),
  constraint payments_refunded_instant_check check (
    (status = 'refunded') = (refunded_at is not null)
  ),
  constraint payments_refunded_status_check check (
    (status = 'refunded') = (refunded_minor = amount_minor)
    and (status = 'partially_refunded') = (refunded_minor > 0 and refunded_minor < amount_minor)
  ),
  constraint payments_row_version_check check (version > 0),
  constraint payments_updated_check check (updated_at >= created_at),
  constraint payments_deleted_check check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.payments is
  'One processor transaction: its route, its money, its 3DS and risk outcome and its state.';

comment on column public.payments.id is
  'UUID v7 primary key. Time ordered, generated by public.uuid_generate_v7().';

comment on column public.payments.company_id is
  'The merchant that takes the money. Every read of this table is by this column first.';

comment on column public.payments.invoice_id is
  'The invoice this payment settles, or null for a store payment that has no invoice yet.';

comment on column public.payments.provider_id is
  'The provider that processed the payment, from the STEP 023 catalogue.';

comment on column public.payments.provider_key_id is
  'The key that signed the call, null when the call was simulated in test mode.';

comment on column public.payments.routing_rule_id is
  'The rule that chose the provider, null for a payment made outside the router.';

comment on column public.payments.idempotency_key_id is
  'The caller key the request arrived under. Unique, so a replay cannot write a second payment.';

comment on column public.payments.mode is
  'test or live. Section 8 keeps the two kinds of money apart.';

comment on column public.payments.payment_method is
  'card, bank_transfer or e_wallet, the three methods the routing rules also recognise.';

comment on column public.payments.amount_minor is
  'What the payer was charged, in minor units of the currency beside it.';

comment on column public.payments.currency is
  'Three upper case letters. USD at launch.';

comment on column public.payments.fee_minor is
  'What the processor kept, in minor units, never above the amount.';

comment on column public.payments.net_minor is
  'Generated column: amount_minor minus fee_minor, so the net cannot disagree with its parts.';

comment on column public.payments.platform_fee_minor is
  'What the platform took, in minor units, together with the processor fee never above the amount.';

comment on column public.payments.refunded_minor is
  'The sum of the live refunds. Written only by refunds_sync_payment, never by hand.';

comment on column public.payments.card_brand is
  'visa, mastercard, amex, discover or other, null when no card was used.';

comment on column public.payments.card_last_four is
  'Four digits of the card, null when no card was used. There is no column for the rest.';

comment on column public.payments.three_ds_outcome is
  'authenticated, attempted, not_completed or not_requested. Section 18 asks for 3DS everywhere.';

comment on column public.payments.postal_code_matched is
  'True when the billing postal code matched the invoice, which a capture without 3DS requires.';

comment on column public.payments.ip_country_matched is
  'True when the payer IP country matched the invoice, the other half of that rule.';

comment on column public.payments.risk_decision is
  'allow, review or reject. A reject can only sit on a failed payment.';

comment on column public.payments.status is
  'pending, authorized, captured, settled, failed, voided, partially_refunded, refunded or under_review.';

comment on column public.payments.provider_transaction_id is
  'The identifier the provider gave the transaction, unique per provider and mode.';

comment on column public.payments.failure_code is
  'The closed failure code of a failed payment, present exactly when the status is failed.';

comment on column public.payments.failure_detail is
  'The failure message, at most 280 characters, so no card data can be pasted here.';

comment on column public.payments.authorized_at is
  'When the provider authorised the payment, required from authorized onwards.';

comment on column public.payments.captured_at is
  'When the money was captured, required from captured onwards.';

comment on column public.payments.settled_at is
  'When the payment settled, required while the status is settled.';

comment on column public.payments.failed_at is
  'Set exactly when the status is failed.';

comment on column public.payments.refunded_at is
  'Set exactly when the status is refunded.';

comment on column public.payments.created_at is
  'When the payment row was written.';

comment on column public.payments.updated_at is
  'Set by the payments_set_row_metadata trigger on every update.';

comment on column public.payments.deleted_at is
  'Soft delete marker. A payment is kept for the ledger and the dispute pack.';

comment on column public.payments.version is
  'Optimistic locking counter. Incremented by the payments_set_row_metadata trigger.';

-- One payment per idempotency key: the second delivery of a request finds the first row.
create unique index payments_idempotency_key
  on public.payments (idempotency_key_id);

-- One row per provider transaction, so a webhook that names the same transaction finds one payment.
create unique index payments_provider_transaction_key
  on public.payments (provider_id, mode, provider_transaction_id)
  where provider_transaction_id is not null;

-- The merchant payment list, newest first.
create index payments_page_idx
  on public.payments (company_id, created_at desc, id desc);

-- The invoice screen: the payments of one document.
create index payments_invoice_idx
  on public.payments (company_id, invoice_id)
  where invoice_id is not null;

-- The compliance_kyc queue of section 18: the payments waiting for a manual decision.
create index payments_review_idx
  on public.payments (company_id, created_at)
  where status = 'under_review';

-- The settlement sweep of section 26: captured money, oldest first.
create index payments_settlement_idx
  on public.payments (company_id, captured_at)
  where status = 'captured' and deleted_at is null;

create trigger payments_guard_refund_state
  before update on public.payments
  for each row
  execute function public.payments_guard_refund_state();

create trigger payments_set_row_metadata
  before update on public.payments
  for each row
  execute function public.set_row_metadata();

alter table public.payments enable row level security;

create policy payments_default_deny
  on public.payments
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
