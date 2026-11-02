-- path: migrations/0099_compliance_calendar_super_admin.down.sql
-- STEP 074 rollback of 0099: the super administrator loses the calendar policy, and no row moves.
--
-- A policy changes who may read a row, never the row itself, so running this loses nothing: every
-- compliance item, its expiry, its alert instant and its document reference stay exactly where they
-- were. What the deployment gets back is the state `0074` left - `compliance_kyc` full control, `ceo`
-- a select, and `<table>_default_deny` for everybody else - which means the super administrator reads
-- an empty calendar through row level security while the application's own role check still admits
-- them. That is a visible, failing-screen state rather than a silent one, and the screen that depends
-- on the policy is removed in the same commit.

begin;

drop policy if exists compliance_items_super_admin_all on public.compliance_items;

commit;
