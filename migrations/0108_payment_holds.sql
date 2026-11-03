-- path: migrations/0108_payment_holds.sql
-- STEP 092 - the hold on an unusually large transaction, and the review that decides it.
-- FEATURE_LIST section 5 line 62 gives the compliance team "holding unusually large transactions for
-- review" as an underwriting criterion; `0106` stores the switch and the threshold on the criteria
-- row (`large_transaction_hold_enabled`, `large_transaction_hold_threshold`). This file stores what
-- the criterion means for ONE transaction: a `payment_holds` row per held transaction, sitting in a
-- review queue until the compliance desk releases or rejects it.
--
-- Four decisions shape this file:
--
--   1. The hold is a row, not a flag on a payment. The payment core of STEPs 127+ does not exist yet,
--      so the row carries the `amount` and an optional `reference` (the payment's id or idempotency
--      key, which the service uses to answer a repeated trigger with the existing hold instead of a
--      second one) plus the `company_id` of the merchant. When the payment core lands, it points its
--      row at this one by `reference`.
--   2. The status vocabulary is closed: `held` while it waits, then exactly one of `released` or
--      `rejected`. The checks make the terminal states honest - a decided row must name its reviewer
--      and instant, a held row must name neither, and a rejection must carry the trimmed 1..280
--      character reason `0049` already demands of document rejections. The service enforces the same
--      transitions, so a double decision conflicts instead of overwriting.
--   3. The guard refuses every delete and soft delete and freezes `company_id`: a hold's history is
--      the audit log plus the row itself. The `held` partial index is the review queue - the office
--      reads exactly the rows still waiting, ordered by `held_at`.
--   4. Roles follow section 2: the merchant reads their own company's holds (section 20 lets a
--      merchant see their own holds), the four office roles read the queue, and only compliance_kyc
--      and super_admin decide - manual payment review is the compliance desk's work.
--
-- No seed: a hold exists only when a transaction actually trips the threshold.

begin;

create function public.payment_holds_guard_state()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'a payment hold is decided, never removed'
      using errcode = 'restrict_violation';
  end if;

  if new.deleted_at is not null then
    raise exception 'a payment hold is never soft deleted'
      using errcode = 'restrict_violation';
  end if;

  if tg_op = 'UPDATE' and new.company_id is distinct from old.company_id then
    raise exception 'a payment hold belongs to one merchant'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.payment_holds_guard_state() is
  'Freezes the merchant a hold belongs to, and refuses every removal.';

create table public.payment_holds (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid not null,
  reference text,
  amount numeric(18,4) not null,
  status text not null default 'held',
  held_at timestamptz not null default now(),
  reviewed_by uuid,
  reviewed_at timestamptz,
  decision_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint payment_holds_pkey primary key (id),
  constraint payment_holds_company_fkey foreign key (company_id)
    references public.companies (id),
  constraint payment_holds_reviewed_by_fkey foreign key (reviewed_by)
    references public.users (id),
  constraint payment_holds_reference_check check (reference is null or (char_length(reference) between 1 and 120 and reference = btrim(reference))),
  constraint payment_holds_amount_check check (amount > 0 and amount <= 100000000000000),
  constraint payment_holds_status_check check (status in ('held', 'released', 'rejected')),
  constraint payment_holds_decision_check check (
    (status = 'held' and reviewed_by is null and reviewed_at is null and decision_reason is null)
    or (status <> 'held' and reviewed_by is not null and reviewed_at is not null)
  ),
  constraint payment_holds_reason_check check (
    status <> 'rejected'
    or (decision_reason is not null and char_length(btrim(decision_reason)) between 1 and 280)
  ),
  constraint payment_holds_version_positive_check check (version > 0),
  constraint payment_holds_updated_after_creation_check check (updated_at >= created_at),
  constraint payment_holds_reviewed_after_held_check check (reviewed_at is null or reviewed_at >= held_at),
  constraint payment_holds_deleted_after_creation_check
    check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.payment_holds is
  'One held transaction waiting for the compliance desk: the amount, the merchant, and the decision when it comes.';

comment on column public.payment_holds.reference is
  'The payment's id or idempotency key, so a repeated trigger finds the existing hold instead of creating a second one.';

comment on column public.payment_holds.amount is
  'The transaction amount that tripped the 0106 hold threshold, in USD numeric(18,4).';

comment on column public.payment_holds.status is
  'held while it waits in the review queue, then released or rejected exactly once.';

comment on column public.payment_holds.decision_reason is
  'Required on a rejection: the trimmed 1..280 character reason, the same rule 0049 sets for documents.';

-- The review queue: the held rows, oldest first.
create index payment_holds_held_idx
  on public.payment_holds (held_at)
  where status = 'held' and deleted_at is null;

create index payment_holds_company_idx
  on public.payment_holds (company_id, held_at desc)
  where deleted_at is null;

create trigger payment_holds_guard_state
  before insert or update or delete on public.payment_holds
  for each row
  execute function public.payment_holds_guard_state();

create trigger payment_holds_set_row_metadata
  before update on public.payment_holds
  for each row
  execute function public.set_row_metadata();

alter table public.payment_holds enable row level security;

create policy payment_holds_default_deny
  on public.payment_holds
  as permissive
  for all
  to public
  using (false)
  with check (false);

-- The merchant sees their own holds, never another company's.
create policy payment_holds_owner_read
  on public.payment_holds
  as permissive
  for select
  to public
  using (company_id = public.current_actor_company_id());

-- The office reads the whole queue; the desk that decides is compliance_kyc with super_admin.
create policy payment_holds_office_read
  on public.payment_holds
  as permissive
  for select
  to public
  using (
    public.current_actor_has_role('ceo')
    or public.current_actor_has_role('compliance_kyc')
    or public.current_actor_has_role('finance_ops')
    or public.current_actor_has_role('super_admin')
  );

create policy payment_holds_manage_all
  on public.payment_holds
  as permissive
  for all
  to public
  using (
    public.current_actor_has_role('compliance_kyc')
    or public.current_actor_has_role('super_admin')
  )
  with check (
    public.current_actor_has_role('compliance_kyc')
    or public.current_actor_has_role('super_admin')
  );

commit;
