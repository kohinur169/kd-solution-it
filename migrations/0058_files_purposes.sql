-- path: migrations/0058_files_purposes.sql
-- STEP 032 - two more file purposes, for the CMS image of section 25 and the compliance
-- document of section 3.
--
-- STEP 031 closed the purpose vocabulary of `files` at the five uploads section 21 names. The CMS
-- needs a cover image for a post and a picture for a public page, and the compliance calendar
-- needs the certificate or the attestation the renewal is tracked against; neither fits the
-- five, and a row with a borrowed purpose would be a lie the storage adapter cannot see through.
-- Migrations are append only, so this file does not edit `0057`; it replaces the check in place
-- with the same five names and the two new ones, and its rollback puts the five name check back.
--
-- The table itself is untouched: no column, no index and no guard changes, so a database that
-- ran the rollback chain through `0058` is exactly the schema STEP 031 left behind.

begin;

alter table public.files drop constraint files_purpose_check;

alter table public.files add constraint files_purpose_check check (
  purpose in ('kyc_document', 'company_logo', 'invoice_pdf', 'dispute_document',
              'support_attachment', 'cms_image', 'compliance_document')
);

comment on column public.files.purpose is
  'The upload kind: five of section 21 and the cms_image and compliance_document of section 32.';

commit;
