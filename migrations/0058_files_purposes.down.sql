-- path: migrations/0058_files_purposes.down.sql
-- STEP 032 - the rollback of the purpose extension: the five names of STEP 031 again.
--
-- A row that already carries cms_image or compliance_document would make the five name check
-- fail, which is the honest outcome: a rollback cannot keep a value the older schema refuses,
-- and the operator removes those rows before rolling back, exactly as with any narrowing change.
-- This file creates no table, so the chain's descending run still empties the schema.

begin;

alter table public.files drop constraint files_purpose_check;

alter table public.files add constraint files_purpose_check check (
  purpose in ('kyc_document', 'company_logo', 'invoice_pdf', 'dispute_document',
              'support_attachment')
);

comment on column public.files.purpose is
  'The upload kind of section 21, from the five names the purpose check enforces.';

commit;
