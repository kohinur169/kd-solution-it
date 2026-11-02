-- path: migrations/0098_country_switch_authority.sql
-- STEP 073 - the country switch of section 3, its reason, and the approval it spends.
--
-- Section 3 gives the platform one switch: "Country enable and disable switch at platform level,
-- controlled by super_admin and CEO. Sanctioned countries stay permanently disabled."
--
-- `0076_reference_countries.sql` already holds the list, the switch and the guard: the codes, the name
-- and the sanction flag are frozen, a sanctioned row can never be enabled, and no row is ever deleted.
-- Three things the switch needs are missing there, and each is a fact an operator has to be able to
-- check afterwards:
--
--   1. **Why a country is off.** A disabled market with no sentence beside it makes the next person
--      guess, and makes "we closed this because of a chargeback wave in March" indistinguishable from
--      "somebody clicked the wrong row". `disabled_reason` records the operator's words, required
--      whenever a country is off, cleared when it is opened again.
--
--   2. **Which decision opened the market.** Section 2 puts country enable and disable in the CEO's and
--      the super administrator's hands together, and STEP 072 built the chain that carries it: a
--      `country_enable` request that the CEO approves and the super administrator confirms. An approval
--      that can be spent twice is not an authority, so `0095`'s rows gain `consumed_at` and
--      `consumed_by`, written when the switch spends one.
--
--   3. **The one query the switch makes.** "Is there an approved, unspent decision for this country" is
--      a partial index over exactly those rows.
--
-- ## Why consumption lives on the request and not on the country
--
-- A column on `countries` naming its approval would have to be cleared when the country is closed -
-- otherwise the reference blocks the next opening - and clearing it is what makes an approval spendable
-- again. The spend is a fact about the decision, so it is recorded on the decision, once, and the audit
-- entry of the switch names the approval it used.
--
-- ## What this file deliberately does not do
--
-- It does not add `country_disable` to the four action types of `0095`. Closing a market is the
-- protective direction of section 3: a sanctions listing or a processor outage cannot wait for two
-- signatures, so a disable is a direct, reasoned, audited act by either controller, and an enable is the
-- one that goes through the chain. The asymmetry is the design, and the handoff records it.

begin;

-- 1. The sentence beside a closed country.
alter table public.countries
  add column disabled_reason text;

alter table public.countries
  add constraint countries_disabled_reason_check check (
    disabled_reason is null
    or (
      not is_enabled
      and char_length(disabled_reason) between 10 and 280
      and disabled_reason = btrim(disabled_reason)
    )
  );

comment on column public.countries.disabled_reason is
  'Why the switch is off, in the operator words, required while the country is disabled and cleared when it opens again.';

-- 2. The spend, on the decision.
alter table public.approval_requests
  add column consumed_at timestamptz;

alter table public.approval_requests
  add column consumed_by uuid;

alter table public.approval_requests
  add constraint approval_requests_consumed_by_fkey foreign key (consumed_by)
    references public.users (id);

alter table public.approval_requests
  add constraint approval_requests_consumed_check check (
    (consumed_at is null) = (consumed_by is null)
    and (consumed_at is null or status = 'approved')
  );

comment on column public.approval_requests.consumed_at is
  'When the action this request authorised was performed, or null while the authority is unspent.';

comment on column public.approval_requests.consumed_by is
  'The account that spent the authority, required exactly when the request was consumed.';

-- 3. The switch reads an approved request that has not been spent, for one subject.
create index approval_requests_consumable_idx
  on public.approval_requests (action_type, subject_id)
  where status = 'approved' and consumed_at is null and deleted_at is null;

commit;
