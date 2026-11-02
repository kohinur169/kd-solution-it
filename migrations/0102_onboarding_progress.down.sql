-- path: migrations/0102_onboarding_progress.down.sql
-- STEP 079 rollback of 0102: removes the saved onboarding position and the rule that shaped it.
--
-- Everything this file drops was created by `0102` and by nothing else: the table, its one live row
-- per company index, its metadata trigger, its default-deny policy, and the step-list function the
-- table's check calls. `0001` (companies), `0003` (users), `0013` (audit logs) and the KYC tables of
-- `0048` are other files' rows and are untouched.
--
-- A rollback here means "the platform no longer remembers where a merchant was in the wizard". It
-- does not mean the merchant was never onboarded: every save was an audited act, and the audit chain
-- is append-only and outside every rollback. A database holding positions loses them, which is why
-- this file is run last and never while a merchant is halfway through the wizard.

begin;

drop policy if exists onboarding_progress_default_deny on public.onboarding_progress;

drop trigger if exists onboarding_progress_set_row_metadata on public.onboarding_progress;

drop index if exists public.onboarding_progress_company_key;

drop table if exists public.onboarding_progress;

drop function if exists public.onboarding_completed_steps_valid(jsonb);

commit;
