-- path: migrations/0068_compliance_items.sql
-- STEP 032 - the compliance calendar of section 3: one row per certificate, attestation or
-- filing whose expiry the platform must not miss.
--
-- Section 3 asks for a cyber insurance record and PCI attestation renewal tracking with expiry
-- alerts, and section 27 lists the alert job. A row is what the tracker promises: what the item
-- is, who issued it, when it was issued, when it expires, how many days before the expiry the
-- alert should fire, and the document that proves it.
--
-- The expiries only move forward. `compliance_items_guard_state` refuses an `expires_on` that
-- moves backwards or stays, because a renewal that shortens a coverage would be a typo hiding as
-- a renewal, and it refuses a `last_alert_at` that goes backwards, so the alert job cannot send
-- the same warning twice by writing an older instant over a newer one.
--
-- The status walks `active` to `expired` when the day passes, `active` or `expired` to `renewed`
-- when a replacement certificate is filed, and any of them to `archived` when the item is no
-- longer tracked. A renewal is a new row for the new period rather than an edit of the old one,
-- which is why the old row keeps `renewed` and its instant as the history section 3 asks for.
-- `renewed_at` is therefore required by the renewed state and legal on an archived row as well,
-- the way a quarantine reason survives an archive in `files`.
--
-- The document is a `files` row of the `compliance_document` purpose, the vocabulary `0058` added.

begin;

create function public.compliance_items_guard_state()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.kind is distinct from old.kind
       or new.issuer is distinct from old.issuer
       or new.issued_on is distinct from old.issued_on then
      raise exception 'a compliance item keeps its kind, its issuer and its issue date'
        using errcode = 'check_violation';
    end if;

    if new.expires_on < old.expires_on then
      raise exception 'a compliance expiry moves forward only'
        using errcode = 'check_violation';
    end if;

    if old.last_alert_at is not null
       and (new.last_alert_at is null or new.last_alert_at < old.last_alert_at) then
      raise exception 'a compliance alert instant moves forward only'
        using errcode = 'check_violation';
    end if;

    if old.status is distinct from new.status and not (
      (old.status = 'active' and new.status in ('expired', 'renewed', 'archived'))
      or (old.status = 'expired' and new.status in ('renewed', 'archived'))
      or (old.status = 'renewed' and new.status = 'archived')
    ) then
      raise exception 'a compliance item walks from active to expired, renewed or archived'
        using errcode = 'check_violation';
    end if;

    if new.deleted_at is not null then
      raise exception 'a compliance record is archived, never deleted'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.compliance_items_guard_state() is
  'Keeps a compliance item on its kind and issue date, and moves its expiry and its alert forward.';

create table public.compliance_items (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid,
  kind text not null,
  title text not null,
  issuer text not null,
  reference text,
  issued_on date not null,
  expires_on date not null,
  alert_days integer not null default 30,
  status text not null default 'active',
  document_file_id uuid,
  owner_id uuid,
  last_alert_at timestamptz,
  renewed_at timestamptz,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint compliance_items_pkey primary key (id),
  constraint compliance_items_company_fkey foreign key (company_id)
    references public.companies (id),
  constraint compliance_items_document_fkey foreign key (document_file_id)
    references public.files (id),
  constraint compliance_items_owner_fkey foreign key (owner_id) references public.users (id),
  constraint compliance_items_platform_check check (company_id is null),
  constraint compliance_items_kind_check check (
    kind in ('cyber_insurance', 'pci_attestation', 'business_license', 'tax_registration',
             'annual_filing', 'other')
  ),
  constraint compliance_items_title_check check (
    char_length(title) between 1 and 120
    and title = btrim(title)
  ),
  constraint compliance_items_issuer_check check (
    char_length(issuer) between 1 and 120
    and issuer = btrim(issuer)
  ),
  constraint compliance_items_reference_check check (
    reference is null
    or (
      char_length(reference) between 1 and 120
      and reference = btrim(reference)
    )
  ),
  constraint compliance_items_dates_check check (expires_on > issued_on),
  constraint compliance_items_alert_check check (alert_days between 7 and 365),
  constraint compliance_items_status_check check (
    status in ('active', 'expired', 'renewed', 'archived')
  ),
  constraint compliance_items_renewed_required_check check (
    status <> 'renewed' or renewed_at is not null
  ),
  constraint compliance_items_renewed_scope_check check (
    renewed_at is null or status in ('renewed', 'archived')
  ),
  constraint compliance_items_alert_order_check check (
    last_alert_at is null or last_alert_at >= created_at
  ),
  constraint compliance_items_note_check check (
    note is null
    or (
      char_length(note) between 1 and 500
      and note = btrim(note)
    )
  ),
  constraint compliance_items_updated_check check (updated_at >= created_at),
  constraint compliance_items_deleted_check check (deleted_at is null or deleted_at >= created_at),
  constraint compliance_items_row_version_check check (version > 0)
);

comment on table public.compliance_items is
  'One tracked certificate, attestation or filing of section 3, with its expiry and its alert.';

comment on column public.compliance_items.id is
  'UUID v7 primary key. Time ordered, generated by public.uuid_generate_v7().';

comment on column public.compliance_items.company_id is
  'Always null: the compliance calendar belongs to the platform company.';

comment on column public.compliance_items.kind is
  'What is tracked, from the closed list of section 3 renewals.';

comment on column public.compliance_items.title is
  'The human name of the item, up to 120 characters.';

comment on column public.compliance_items.issuer is
  'Who issued the certificate or received the filing.';

comment on column public.compliance_items.reference is
  'The certificate or filing number, when the issuer gave one.';

comment on column public.compliance_items.issued_on is
  'The day the item was issued. The expiry is measured from it.';

comment on column public.compliance_items.expires_on is
  'The day the item stops being valid; only moves forward on a renewal.';

comment on column public.compliance_items.alert_days is
  'How many days before the expiry the job of section 27 warns, from 7 to 365.';

comment on column public.compliance_items.status is
  'active, expired, renewed or archived. The guard walks it forward only.';

comment on column public.compliance_items.document_file_id is
  'The certificate or attestation itself, a files row of the compliance_document purpose.';

comment on column public.compliance_items.owner_id is
  'The person responsible for the renewal.';

comment on column public.compliance_items.last_alert_at is
  'When the alert job last warned. Moves forward only, so one warning is not sent twice.';

comment on column public.compliance_items.renewed_at is
  'When the item was renewed. Required by the renewed state.';

comment on column public.compliance_items.note is
  'The compliance note on the item, up to 500 characters.';

comment on column public.compliance_items.created_at is
  'When the row was written.';

comment on column public.compliance_items.updated_at is
  'Set by the compliance_items_set_row_metadata trigger on every update.';

comment on column public.compliance_items.deleted_at is
  'Present for the schema rule; the guard refuses a value, because an item is archived instead.';

comment on column public.compliance_items.version is
  'Optimistic locking counter, incremented by the compliance_items_set_row_metadata trigger.';

-- The alert job: what is still live or expired, the nearest expiry first.
create index compliance_items_expiry_idx
  on public.compliance_items (status, expires_on)
  where deleted_at is null;

-- The calendar by kind, which is how the settings screen of STEP 074 groups it.
create index compliance_items_kind_idx
  on public.compliance_items (kind, expires_on);

create trigger compliance_items_guard_state
  before insert or update on public.compliance_items
  for each row
  execute function public.compliance_items_guard_state();

create trigger compliance_items_set_row_metadata
  before update on public.compliance_items
  for each row
  execute function public.set_row_metadata();

alter table public.compliance_items enable row level security;

create policy compliance_items_default_deny
  on public.compliance_items
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
