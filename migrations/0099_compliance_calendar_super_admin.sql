-- path: migrations/0099_compliance_calendar_super_admin.sql
-- STEP 074 - the compliance calendar's own policy for the super administrator.
--
-- `0068` created `public.compliance_items`, the calendar of section 3: the cyber insurance record and
-- the PCI attestation, with their expiry, their alert window and the document that proves them.
-- `0074` gave it its readers - `compliance_kyc` full control and `ceo` a select - and its own header
-- says of the seven platform tables it covers that "`super_admin` keeps full control of all seven".
-- For this table that sentence is not true: no policy on `compliance_items` names the super
-- administrator, so with row level security on, the role section 2 calls "full control of everything"
-- reads zero rows.
--
-- STEP 074 puts the calendar on the platform settings screen, which is the super administrator's
-- screen (section 24: "super_admin sets the platform logo and all platform information from settings"),
-- and the screen cannot show a calendar its reader is refused. Two ways to close the gap:
--
--   1. point the screen at the service role and let the application decide who reads; or
--   2. write the missing policy, so the database answers the same question the screen asks.
--
-- This file takes the second. The application already checks the roles before it reads - that is what
-- `lib/settings/service.ts` does - but a policy is what makes the rule true for every reader, not only
-- for the code that remembered to check. `<table>_default_deny` of `0068` remains the answer for
-- everybody else, and `audit_logs` keeps its three policies: this file widens exactly one table.
--
-- The same gap exists for `card_blacklist`, `company_transactions` and `processor_bills` in the same
-- file, and this STEP does not close it: each of those belongs to the screen that reads it
-- (`compliance_kyc`'s screening work, the accounting area of section 26), and a policy written for a
-- screen that does not exist yet is a grant nobody has reviewed. The STEP 074 handoff records them so
-- the omission is a decision rather than an oversight.

begin;

create policy compliance_items_super_admin_all
  on public.compliance_items
  as permissive
  for all
  to public
  using (public.current_actor_has_role('super_admin'))
  with check (public.current_actor_has_role('super_admin'));

commit;
