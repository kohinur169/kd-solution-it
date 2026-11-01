-- path: migrations/0064_cms_pages.down.sql
-- STEP 032 - the rollback of the CMS pages table: the guard function and the table, in one
-- transaction.

begin;

drop table if exists public.cms_pages;

drop function if exists public.cms_pages_guard_state();

commit;
