-- path: migrations/0116_invoice_branding.sql
-- STEP 118 - merchant logo and invoice branding settings, the row the invoice PDF is drawn from.
--
-- Section 16 line 184 says "Merchants can set their own logo and invoice branding." STEP 105 built the
-- storage half of that sentence: a `company_logo` purpose, keys under `<companyId>/logo/`, one current
-- verified logo per merchant, and a signed URL for it. Its own handoff records what it deliberately did not
-- build - "No migration, no routes, no UI" - so nothing could say *which* logo an invoice prints, or what
-- else about the merchant belongs on the document. STEP 117 then built the PDF and printed no merchant
-- identity at all: its header is the word INVOICE and the number. This file is the row that closes both
-- gaps.
--
-- ## Why this table stores choices and not facts
--
-- The merchant's name, address, tax id and website already exist, once, on the `business_profiles` row of
-- `0103` as extended by `0105`. Copying them here would create a second truth that goes stale the day a
-- merchant moves office, and an invoice that prints an old address is a document a client acts on. So this
-- table stores only what is *invoice* branding and exists nowhere else: which stored logo prints, which of
-- the profile's facts are shown on a document that leaves the building, the tagline under the name, the note
-- above the footer, and the accent colour of the rule under the letterhead. The identity itself is read at
-- render time, which also means a merchant who fixes their profile does not have to re-save their brand.
--
-- ## Why the logo is a reference and not bytes
--
-- `logo_file_id` points at a `files` row of `0057`. The bytes stay in object storage sealed with
-- AES-256-GCM, the record keeps the provider, the size and the sha256, and the render reads them through
-- the storage layer with an access audit - the same door STEP 105 built and STEP 117 used for the PDF
-- itself. Storing bytes in a settings column would put a two megabyte image in a row a screen reads on
-- every open, and would bypass the file record's whole audit trail.
--
-- The foreign key is plain `files (id)`: `0057` has no `unique (id, company_id)` tenant key to point a
-- composite key at, so the tenant is enforced where the row is read - a scoped select, then
-- `assertBrandingKeyForCompany` on the key itself, which is the check STEP 105 wrote for exactly this.
--
-- ## Why one row per merchant, and a guard on its identity
--
-- A merchant has one invoice brand, so `company_id` carries a unique constraint and a save is an
-- insert-or-update of that one row. The guard trigger makes `id` and `company_id` immutable: no code path
-- in this repository updates them, and a branding row that moved to another company would print one
-- merchant's logo on another merchant's invoice, which is the failure this table must never have.

begin;

create table public.invoice_branding (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid not null,
  -- The stored logo that prints on the PDF, or null when the merchant has not chosen one. A `files` row of
  -- purpose `company_logo`; the purpose and the tenant are both checked on the read path, because a
  -- reference alone does not say what it points at.
  logo_file_id uuid,
  -- Chosen but hidden is a legitimate state: a merchant turning the logo off for one quarter keeps the
  -- choice, so turning it back on is a checkbox and not a new upload.
  show_logo boolean not null default true,
  -- Which of the profile's two names prints. A sole trader invoices as themselves; a company invoices as
  -- the legal entity. Both exist on `0103` and only the merchant knows which one a client should read.
  name_style text not null default 'trading',
  show_address boolean not null default true,
  show_contact boolean not null default true,
  -- Off by default on purpose: a tax id and a website are facts a merchant may not want on a document that
  -- leaves the building, and a setting that publishes something should start unpublished.
  show_tax_id boolean not null default false,
  show_website boolean not null default false,
  tagline text,
  footer_note text,
  -- The colour of the header and total rules, lowercase `#rrggbb`. Rules only, never text: a merchant
  -- choosing a pale colour can make a line faint, and cannot make a sentence unreadable.
  accent_colour char(7),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint invoice_branding_pkey primary key (id),
  constraint invoice_branding_company_fkey foreign key (company_id)
    references public.companies (id),
  constraint invoice_branding_logo_fkey foreign key (logo_file_id)
    references public.files (id),
  -- One invoice brand per merchant, which is also what `insert ... on conflict (company_id)` infers.
  constraint invoice_branding_company_key unique (company_id),
  constraint invoice_branding_tenant_key unique (id, company_id),
  constraint invoice_branding_name_style_check check (name_style in ('trading', 'legal')),
  -- A tagline is one printed line under the name, so it is one line of text with a ceiling the layout can
  -- hold, and it is never stored padded: `btrim` equality is the database saying what the service checked.
  constraint invoice_branding_tagline_check check (
    tagline is null
    or (char_length(tagline) between 1 and 120 and tagline = btrim(tagline))
  ),
  constraint invoice_branding_footer_note_check check (
    footer_note is null
    or (char_length(footer_note) between 1 and 300 and footer_note = btrim(footer_note))
  ),
  constraint invoice_branding_accent_check check (
    accent_colour is null or accent_colour ~ '^#[0-9a-f]{6}$'
  ),
  constraint invoice_branding_version_positive_check check (version > 0),
  constraint invoice_branding_updated_after_creation_check check (updated_at >= created_at),
  constraint invoice_branding_deleted_after_creation_check
    check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.invoice_branding is
  'One merchant invoice brand: which stored logo prints, which profile facts show, and the words and colour around them. The identity itself stays on business_profiles and is read at render time.';

comment on column public.invoice_branding.logo_file_id is
  'A files row of purpose company_logo whose bytes are drawn on the PDF, or null for no logo. Tenant and purpose are re-checked on every read.';

comment on column public.invoice_branding.accent_colour is
  'Lowercase #rrggbb for the header and total rules. Applied to lines only, never to text.';

-- The row is read by the settings screen and by every render, and both go through `company_id`, which the
-- unique constraint already indexes. No further index is added.

create trigger invoice_branding_set_row_metadata
  before update on public.invoice_branding
  for each row
  execute function public.set_row_metadata();

-- Identity is immutable. A branding row that changed company would print one merchant's logo and words on
-- another merchant's invoice, so the database refuses the update rather than trusting every caller.
create function public.invoice_branding_guard_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id then
    raise exception 'invoice_branding identity is immutable: id';
  end if;

  if new.company_id is distinct from old.company_id then
    raise exception 'invoice_branding identity is immutable: company_id';
  end if;

  return new;
end;
$$;

comment on function public.invoice_branding_guard_identity() is
  'Refuses an update that moves a branding row: id and company_id never change.';

create trigger invoice_branding_guard_identity
  before update on public.invoice_branding
  for each row
  execute function public.invoice_branding_guard_identity();

alter table public.invoice_branding enable row level security;

create policy invoice_branding_default_deny
  on public.invoice_branding
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
