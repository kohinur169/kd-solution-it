-- path: migrations/0039_disputes.sql
-- STEP 024 - the disputes of section 19.
--
-- "Dispute interface: list, status and document upload." "The merchant writes the dispute response and
-- supplies the required documents." "The response deadline is 24 hours in the merchant own time zone.
-- super_admin can set the deadline to 48 hours when needed." "A structured chargeback evidence pack is
-- assembled: invoice, delivery proof, client communication record and terms acceptance record."
-- "compliance_kyc reviews the evidence pack and sends it to the processor."
--
-- The deadline is a column and not a guess. `opened_at` is when the processor told the platform,
-- `response_window_hours` is 24 or 48 as section 19 allows, and `response_due_at` must sit after the
-- opening instant and no later than the window allows, which the check states with `make_interval`.
--
-- Evidence is a flag with a meaning. `evidence_ready` says the pack of section 19 has been assembled,
-- `submitted_at` can only be set when it is true, and `evidence_submitted` is exactly the state with a
-- submission instant, so a dispute cannot be sent to the processor without its pack.
--
-- A resolved dispute is history: `disputes_guard_deadline` freezes the payment, the opening instant and
-- the window after submission, and refuses any change to a won, lost or closed row. The chargeback fee
-- of section 18 is a column, because the ledger of STEP 025 posts it and the merchant balance carries
-- it.

begin;

create function public.disputes_guard_deadline()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.company_id is distinct from old.company_id
     or new.payment_id is distinct from old.payment_id
     or new.opened_at is distinct from old.opened_at then
    raise exception 'a dispute keeps its payment and its opening instant'
      using errcode = 'check_violation';
  end if;

  if new.response_window_hours is distinct from old.response_window_hours
     and old.submitted_at is not null then
    raise exception 'the response window is fixed once the response is submitted'
      using errcode = 'check_violation';
  end if;

  if old.resolved_at is not null
     and (new.status is distinct from old.status
          or new.resolved_at is distinct from old.resolved_at) then
    raise exception 'a resolved dispute stays resolved'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.disputes_guard_deadline() is
  'Keeps a dispute on its payment and its deadline, and refuses a resolved dispute that reopens.';

create table public.disputes (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid not null,
  payment_id uuid not null,
  processor_dispute_id text,
  status text not null default 'open',
  reason_code text not null,
  amount_minor bigint not null,
  currency text not null default 'USD',
  fee_minor bigint not null default 0,
  opened_at timestamptz not null default now(),
  response_window_hours integer not null default 24,
  response_due_at timestamptz not null,
  evidence_ready boolean not null default false,
  response_text text,
  submitted_at timestamptz,
  resolved_at timestamptz,
  outcome_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint disputes_pkey primary key (id),
  constraint disputes_company_fkey foreign key (company_id) references public.companies (id),
  constraint disputes_payment_fkey foreign key (payment_id) references public.payments (id),
  constraint disputes_status_check check (
    status in ('open', 'under_review', 'evidence_submitted', 'won', 'lost', 'closed')
  ),
  constraint disputes_reason_check check (
    char_length(reason_code) between 1 and 64 and reason_code = btrim(reason_code)
  ),
  constraint disputes_amount_check check (amount_minor > 0),
  constraint disputes_currency_check check (currency ~ '^[A-Z]{3}$'),
  constraint disputes_fee_check check (fee_minor >= 0),
  constraint disputes_window_check check (response_window_hours in (24, 48)),
  constraint disputes_due_check check (
    response_due_at > opened_at
    and response_due_at <= opened_at + make_interval(hours => response_window_hours)
  ),
  constraint disputes_evidence_check check (submitted_at is null or evidence_ready),
  constraint disputes_response_check check (
    response_text is null or char_length(response_text) between 1 and 20000
  ),
  constraint disputes_submitted_check check (
    status <> 'evidence_submitted' or submitted_at is not null
  ),
  constraint disputes_submitted_after_open_check check (
    submitted_at is null or submitted_at >= opened_at
  ),
  constraint disputes_resolved_check check (
    (status in ('won', 'lost', 'closed')) = (resolved_at is not null)
  ),
  constraint disputes_outcome_check check (
    outcome_note is null
    or (char_length(outcome_note) between 1 and 500 and outcome_note = btrim(outcome_note))
  ),
  constraint disputes_resolved_note_check check (resolved_at is null or outcome_note is not null),
  constraint disputes_row_version_check check (version > 0),
  constraint disputes_updated_check check (updated_at >= created_at),
  constraint disputes_deleted_check check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.disputes is
  'A chargeback against a payment: its deadline, its evidence, its response and its outcome.';

comment on column public.disputes.id is
  'UUID v7 primary key. Time ordered, generated by public.uuid_generate_v7().';

comment on column public.disputes.company_id is
  'The merchant of the payment the chargeback names.';

comment on column public.disputes.payment_id is
  'The payment under dispute. Fixed for the life of the row.';

comment on column public.disputes.processor_dispute_id is
  'The identifier the processor gave the dispute, unique per merchant when set.';

comment on column public.disputes.status is
  'open, under_review, evidence_submitted, won, lost or closed.';

comment on column public.disputes.reason_code is
  'The processor reason code, 1 to 64 characters, trimmed.';

comment on column public.disputes.amount_minor is
  'How much is disputed, in minor units of the currency.';

comment on column public.disputes.currency is
  'Three upper case letters, always the currency of the payment.';

comment on column public.disputes.fee_minor is
  'The chargeback fee of section 18, set by super_admin and posted by the ledger.';

comment on column public.disputes.opened_at is
  'When the processor reported the chargeback. Frozen after insert.';

comment on column public.disputes.response_window_hours is
  '24 by default, 48 when super_admin extends the section 19 deadline.';

comment on column public.disputes.response_due_at is
  'The deadline, after the opening instant and within the window. The warning job reads it.';

comment on column public.disputes.evidence_ready is
  'True once the section 19 evidence pack is assembled, which a submission requires.';

comment on column public.disputes.response_text is
  'What the merchant wrote, up to 20000 characters.';

comment on column public.disputes.submitted_at is
  'When compliance_kyc sent the pack. Required in evidence_submitted and kept after the outcome.';

comment on column public.disputes.resolved_at is
  'When the dispute was decided, present exactly on won, lost or closed.';

comment on column public.disputes.outcome_note is
  'What the processor decided, 1 to 500 characters, required once resolved.';

comment on column public.disputes.created_at is
  'When the dispute row was written.';

comment on column public.disputes.updated_at is
  'Set by the disputes_set_row_metadata trigger on every update.';

comment on column public.disputes.deleted_at is
  'Soft delete marker. A dispute stays readable for the balance it moved.';

comment on column public.disputes.version is
  'Optimistic locking counter. Incremented by the disputes_set_row_metadata trigger.';

-- One row per processor dispute inside a merchant, so a repeated webhook finds the row it already wrote.
create unique index disputes_processor_key
  on public.disputes (company_id, processor_dispute_id)
  where processor_dispute_id is not null;

-- The deadline queue of section 19: what is still open, nearest deadline first.
create index disputes_deadline_idx
  on public.disputes (company_id, response_due_at)
  where resolved_at is null and deleted_at is null;

-- The payment screen: the disputes of one payment.
create index disputes_payment_idx
  on public.disputes (company_id, payment_id);

create trigger disputes_guard_deadline
  before update on public.disputes
  for each row
  execute function public.disputes_guard_deadline();

create trigger disputes_set_row_metadata
  before update on public.disputes
  for each row
  execute function public.set_row_metadata();

alter table public.disputes enable row level security;

create policy disputes_default_deny
  on public.disputes
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
