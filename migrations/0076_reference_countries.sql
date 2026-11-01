-- path: migrations/0076_reference_countries.sql
-- STEP 036 - the country reference list and the switch of section 3.
--
-- Section 3 gives the platform one country switch: "Country enable and disable switch at platform
-- level, controlled by super_admin and CEO. Sanctioned countries stay permanently disabled." Until
-- this file the only country a table carried was a two letter code on a client, a payment, a
-- payout or a UBO owner, with a shape check and no list behind it; the merchant country control of
-- section 5 and the routing rules of section 6 both need one authoritative row per country. This
-- table is that row.
--
-- Three properties make it a reference list rather than a settings screen:
--
--   1. The list is seeded, complete and frozen. The 250 rows below are the ISO 3166-1 entries with
--      their alpha-2 code, alpha-3 code and numeric code; the guard trigger refuses an update of
--      any of those four columns, so a code cannot be re-pointed at another country later. The one
--      column the office may change is `is_enabled`.
--   2. A sanctioned country cannot be enabled, ever. `is_sanctioned` is set once by this seed for
--      the four comprehensive embargoes the list carries - Cuba, Iran, North Korea and Syria - the
--      guard trigger refuses to change that flag, and the check constraint refuses a row that is
--      both sanctioned and enabled. A future list change is a new migration, which is the review
--      that such a change deserves.
--   3. A row is never removed. The guard refuses a delete and refuses a soft delete, because a
--      company registered in a country last year must still resolve that country this year, and a
--      disabled country is a switch that is off rather than a row that is gone.
--
-- `company_id` exists because every table carries it, is checked null because a country belongs to
-- the platform and not to a merchant, and is the reason this file is a reference table and not a
-- tenant table. The switch itself names nobody: `super_admin` and `ceo` are read from
-- `role_assignments` by the policies below, and every flip is written to `audit_logs` by the
-- service that performs it, which is what section 2 means by "every permission grant, change and
-- use is audit logged".
--
-- The four sanctioned notes are not secrets and are the sentence an operator sees; the reason the
-- switch is off is recorded on the row rather than in a comment, so a support agent answering a
-- merchant does not have to guess.

begin;

-- The guard that keeps the list a reference and the embargo permanent.
create function public.countries_guard_state()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'a country reference row is never removed'
      using errcode = 'restrict_violation';
  end if;

  if new.deleted_at is not null then
    raise exception 'a country reference row is disabled, never deleted'
      using errcode = 'restrict_violation';
  end if;

  if tg_op = 'INSERT' then
    return new;
  end if;

  if new.code is distinct from old.code
     or new.alpha3 is distinct from old.alpha3
     or new.numeric_code is distinct from old.numeric_code
     or new.name is distinct from old.name
     or new.is_sanctioned is distinct from old.is_sanctioned
     or new.sanction_note is distinct from old.sanction_note then
    raise exception 'a country keeps its codes, its name and its sanction flag'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.countries_guard_state() is
  'Freezes the identity and the sanction flag of a country, and refuses every delete.';

create table public.countries (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid,
  code text not null,
  alpha3 text not null,
  numeric_code text not null,
  name text not null,
  is_sanctioned boolean not null default false,
  sanction_note text,
  is_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint countries_pkey primary key (id),
  constraint countries_company_fkey foreign key (company_id) references public.companies (id),
  constraint countries_platform_check check (company_id is null),
  constraint countries_code_check check (code ~ '^[A-Z]{2}$'),
  constraint countries_alpha3_check check (alpha3 ~ '^[A-Z]{3}$'),
  constraint countries_numeric_code_check check (numeric_code ~ '^[0-9]{3}$'),
  constraint countries_name_check check (
    char_length(name) between 1 and 120
    and name = btrim(name)
  ),
  constraint countries_sanction_note_check check (not is_sanctioned or sanction_note is not null),
  constraint countries_sanctioned_disabled_check check (not (is_sanctioned and is_enabled)),
  constraint countries_version_positive_check check (version > 0),
  constraint countries_updated_after_creation_check check (updated_at >= created_at),
  constraint countries_deleted_after_creation_check
    check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.countries is
  'The ISO 3166-1 country reference list of section 3, with the platform enable switch per country.';

comment on column public.countries.company_id is
  'Always null: the country list belongs to the platform, not to a merchant.';

comment on column public.countries.code is
  'ISO 3166-1 alpha-2 code in upper case. Frozen after the seed; a change is a new migration.';

comment on column public.countries.alpha3 is
  'ISO 3166-1 alpha-3 code in upper case, the form a provider payload usually asks for.';

comment on column public.countries.numeric_code is
  'ISO 3166-1 numeric code as three characters, leading zeros kept, so 004 is Afghanistan.';

comment on column public.countries.name is
  'English short name of the country, ASCII, trimmed. Frozen after the seed.';

comment on column public.countries.is_sanctioned is
  'True for a country under a comprehensive embargo. Frozen, and such a row can never be enabled.';

comment on column public.countries.sanction_note is
  'Why the country is sanctioned, required by the flag and never a secret.';

comment on column public.countries.is_enabled is
  'The section 3 switch. super_admin and ceo set it; the guard refuses it on a sanctioned row.';

comment on column public.countries.deleted_at is
  'Unreachable: the guard refuses every soft delete. A disabled country keeps its row.';

comment on column public.countries.version is
  'Optimistic locking counter, incremented by the countries_set_row_metadata trigger.';

-- One row per alpha-2 code, so a country cannot appear twice in a dropdown.
create unique index countries_code_key
  on public.countries (code)
  where deleted_at is null;

-- One row per alpha-3 code, so a provider payload cannot resolve to two countries.
create unique index countries_alpha3_key
  on public.countries (alpha3)
  where deleted_at is null;

-- The dropdown: the enabled countries in code order.
create index countries_enabled_idx
  on public.countries (code)
  where is_enabled and deleted_at is null;

create trigger countries_guard_state
  before insert or update or delete on public.countries
  for each row
  execute function public.countries_guard_state();

create trigger countries_set_row_metadata
  before update on public.countries
  for each row
  execute function public.set_row_metadata();

alter table public.countries enable row level security;

create policy countries_default_deny
  on public.countries
  as permissive
  for all
  to public
  using (false)
  with check (false);

-- super_admin owns the list: it reads every row in any state and may correct a flag.
create policy countries_super_admin_all
  on public.countries
  as permissive
  for all
  to public
  using (public.current_actor_has_role('super_admin'))
  with check (public.current_actor_has_role('super_admin'));

-- Section 3 gives the switch to super_admin and CEO together. Only an enabled flag changes,
-- because the guard freezes every other column.
create policy countries_ceo_switch
  on public.countries
  as permissive
  for update
  to public
  using (public.current_actor_has_role('ceo'))
  with check (public.current_actor_has_role('ceo'));

-- The office reads the whole list: compliance screens the country of a merchant, finance and
-- support answer questions about a payout destination.
create policy countries_office_read
  on public.countries
  as permissive
  for select
  to public
  using (
    public.current_actor_has_role('ceo')
    or public.current_actor_has_role('compliance_kyc')
    or public.current_actor_has_role('finance_ops')
    or public.current_actor_has_role('support')
  );

-- A signed in person reads the enabled list, which is what the onboarding country picker asks for.
create policy countries_actor_read
  on public.countries
  as permissive
  for select
  to public
  using (
    public.current_actor_id() is not null
    and is_enabled
    and deleted_at is null
  );

insert into public.countries (code, alpha3, numeric_code, name, is_sanctioned, sanction_note, is_enabled) values
  ($$AD$$, $$AND$$, $$020$$, $$Andorra$$, false, null, true),
  ($$AE$$, $$ARE$$, $$784$$, $$United Arab Emirates$$, false, null, true),
  ($$AF$$, $$AFG$$, $$004$$, $$Afghanistan$$, false, null, true),
  ($$AG$$, $$ATG$$, $$028$$, $$Antigua and Barbuda$$, false, null, true),
  ($$AI$$, $$AIA$$, $$660$$, $$Anguilla$$, false, null, true),
  ($$AL$$, $$ALB$$, $$008$$, $$Albania$$, false, null, true),
  ($$AM$$, $$ARM$$, $$051$$, $$Armenia$$, false, null, true),
  ($$AO$$, $$AGO$$, $$024$$, $$Angola$$, false, null, true),
  ($$AQ$$, $$ATA$$, $$010$$, $$Antarctica$$, false, null, true),
  ($$AR$$, $$ARG$$, $$032$$, $$Argentina$$, false, null, true),
  ($$AS$$, $$ASM$$, $$016$$, $$American Samoa$$, false, null, true),
  ($$AT$$, $$AUT$$, $$040$$, $$Austria$$, false, null, true),
  ($$AU$$, $$AUS$$, $$036$$, $$Australia$$, false, null, true),
  ($$AW$$, $$ABW$$, $$533$$, $$Aruba$$, false, null, true),
  ($$AX$$, $$ALA$$, $$248$$, $$Aland Islands$$, false, null, true),
  ($$AZ$$, $$AZE$$, $$031$$, $$Azerbaijan$$, false, null, true),
  ($$BA$$, $$BIH$$, $$070$$, $$Bosnia and Herzegovina$$, false, null, true),
  ($$BB$$, $$BRB$$, $$052$$, $$Barbados$$, false, null, true),
  ($$BD$$, $$BGD$$, $$050$$, $$Bangladesh$$, false, null, true),
  ($$BE$$, $$BEL$$, $$056$$, $$Belgium$$, false, null, true),
  ($$BF$$, $$BFA$$, $$854$$, $$Burkina Faso$$, false, null, true),
  ($$BG$$, $$BGR$$, $$100$$, $$Bulgaria$$, false, null, true),
  ($$BH$$, $$BHR$$, $$048$$, $$Bahrain$$, false, null, true),
  ($$BI$$, $$BDI$$, $$108$$, $$Burundi$$, false, null, true),
  ($$BJ$$, $$BEN$$, $$204$$, $$Benin$$, false, null, true),
  ($$BL$$, $$BLM$$, $$652$$, $$Saint Barthelemy$$, false, null, true),
  ($$BM$$, $$BMU$$, $$060$$, $$Bermuda$$, false, null, true),
  ($$BN$$, $$BRN$$, $$096$$, $$Brunei Darussalam$$, false, null, true),
  ($$BO$$, $$BOL$$, $$068$$, $$Bolivia$$, false, null, true),
  ($$BQ$$, $$BES$$, $$535$$, $$Bonaire, Sint Eustatius and Saba$$, false, null, true),
  ($$BR$$, $$BRA$$, $$076$$, $$Brazil$$, false, null, true),
  ($$BS$$, $$BHS$$, $$044$$, $$Bahamas$$, false, null, true),
  ($$BT$$, $$BTN$$, $$064$$, $$Bhutan$$, false, null, true),
  ($$BV$$, $$BVT$$, $$074$$, $$Bouvet Island$$, false, null, true),
  ($$BW$$, $$BWA$$, $$072$$, $$Botswana$$, false, null, true),
  ($$BY$$, $$BLR$$, $$112$$, $$Belarus$$, false, null, true),
  ($$BZ$$, $$BLZ$$, $$084$$, $$Belize$$, false, null, true),
  ($$CA$$, $$CAN$$, $$124$$, $$Canada$$, false, null, true),
  ($$CC$$, $$CCK$$, $$166$$, $$Cocos (Keeling) Islands$$, false, null, true),
  ($$CD$$, $$COD$$, $$180$$, $$Democratic Republic of the Congo$$, false, null, true),
  ($$CF$$, $$CAF$$, $$140$$, $$Central African Republic$$, false, null, true),
  ($$CG$$, $$COG$$, $$178$$, $$Republic of the Congo$$, false, null, true),
  ($$CH$$, $$CHE$$, $$756$$, $$Switzerland$$, false, null, true),
  ($$CI$$, $$CIV$$, $$384$$, $$Cote d'Ivoire$$, false, null, true),
  ($$CK$$, $$COK$$, $$184$$, $$Cook Islands$$, false, null, true),
  ($$CL$$, $$CHL$$, $$152$$, $$Chile$$, false, null, true),
  ($$CM$$, $$CMR$$, $$120$$, $$Cameroon$$, false, null, true),
  ($$CN$$, $$CHN$$, $$156$$, $$People's Republic of China$$, false, null, true),
  ($$CO$$, $$COL$$, $$170$$, $$Colombia$$, false, null, true),
  ($$CR$$, $$CRI$$, $$188$$, $$Costa Rica$$, false, null, true),
  ($$CU$$, $$CUB$$, $$192$$, $$Cuba$$, true, $$Comprehensive United States embargo administered by OFAC. The switch is off and cannot be turned on.$$, false),
  ($$CV$$, $$CPV$$, $$132$$, $$Cape Verde$$, false, null, true),
  ($$CW$$, $$CUW$$, $$531$$, $$Curacao$$, false, null, true),
  ($$CX$$, $$CXR$$, $$162$$, $$Christmas Island$$, false, null, true),
  ($$CY$$, $$CYP$$, $$196$$, $$Cyprus$$, false, null, true),
  ($$CZ$$, $$CZE$$, $$203$$, $$Czech Republic$$, false, null, true),
  ($$DE$$, $$DEU$$, $$276$$, $$Germany$$, false, null, true),
  ($$DJ$$, $$DJI$$, $$262$$, $$Djibouti$$, false, null, true),
  ($$DK$$, $$DNK$$, $$208$$, $$Denmark$$, false, null, true),
  ($$DM$$, $$DMA$$, $$212$$, $$Dominica$$, false, null, true),
  ($$DO$$, $$DOM$$, $$214$$, $$Dominican Republic$$, false, null, true),
  ($$DZ$$, $$DZA$$, $$012$$, $$Algeria$$, false, null, true),
  ($$EC$$, $$ECU$$, $$218$$, $$Ecuador$$, false, null, true),
  ($$EE$$, $$EST$$, $$233$$, $$Estonia$$, false, null, true),
  ($$EG$$, $$EGY$$, $$818$$, $$Egypt$$, false, null, true),
  ($$EH$$, $$ESH$$, $$732$$, $$Western Sahara$$, false, null, true),
  ($$ER$$, $$ERI$$, $$232$$, $$Eritrea$$, false, null, true),
  ($$ES$$, $$ESP$$, $$724$$, $$Spain$$, false, null, true),
  ($$ET$$, $$ETH$$, $$231$$, $$Ethiopia$$, false, null, true),
  ($$FI$$, $$FIN$$, $$246$$, $$Finland$$, false, null, true),
  ($$FJ$$, $$FJI$$, $$242$$, $$Fiji$$, false, null, true),
  ($$FK$$, $$FLK$$, $$238$$, $$Falkland Islands (Malvinas)$$, false, null, true),
  ($$FM$$, $$FSM$$, $$583$$, $$Micronesia, Federated States of$$, false, null, true),
  ($$FO$$, $$FRO$$, $$234$$, $$Faroe Islands$$, false, null, true),
  ($$FR$$, $$FRA$$, $$250$$, $$France$$, false, null, true),
  ($$GA$$, $$GAB$$, $$266$$, $$Gabon$$, false, null, true),
  ($$GB$$, $$GBR$$, $$826$$, $$United Kingdom$$, false, null, true),
  ($$GD$$, $$GRD$$, $$308$$, $$Grenada$$, false, null, true),
  ($$GE$$, $$GEO$$, $$268$$, $$Georgia$$, false, null, true),
  ($$GF$$, $$GUF$$, $$254$$, $$French Guiana$$, false, null, true),
  ($$GG$$, $$GGY$$, $$831$$, $$Guernsey$$, false, null, true),
  ($$GH$$, $$GHA$$, $$288$$, $$Ghana$$, false, null, true),
  ($$GI$$, $$GIB$$, $$292$$, $$Gibraltar$$, false, null, true),
  ($$GL$$, $$GRL$$, $$304$$, $$Greenland$$, false, null, true),
  ($$GM$$, $$GMB$$, $$270$$, $$Republic of The Gambia$$, false, null, true),
  ($$GN$$, $$GIN$$, $$324$$, $$Guinea$$, false, null, true),
  ($$GP$$, $$GLP$$, $$312$$, $$Guadeloupe$$, false, null, true),
  ($$GQ$$, $$GNQ$$, $$226$$, $$Equatorial Guinea$$, false, null, true),
  ($$GR$$, $$GRC$$, $$300$$, $$Greece$$, false, null, true),
  ($$GS$$, $$SGS$$, $$239$$, $$South Georgia and the South Sandwich Islands$$, false, null, true),
  ($$GT$$, $$GTM$$, $$320$$, $$Guatemala$$, false, null, true),
  ($$GU$$, $$GUM$$, $$316$$, $$Guam$$, false, null, true),
  ($$GW$$, $$GNB$$, $$624$$, $$Guinea-Bissau$$, false, null, true),
  ($$GY$$, $$GUY$$, $$328$$, $$Guyana$$, false, null, true),
  ($$HK$$, $$HKG$$, $$344$$, $$Hong Kong$$, false, null, true),
  ($$HM$$, $$HMD$$, $$334$$, $$Heard Island and McDonald Islands$$, false, null, true),
  ($$HN$$, $$HND$$, $$340$$, $$Honduras$$, false, null, true),
  ($$HR$$, $$HRV$$, $$191$$, $$Croatia$$, false, null, true),
  ($$HT$$, $$HTI$$, $$332$$, $$Haiti$$, false, null, true),
  ($$HU$$, $$HUN$$, $$348$$, $$Hungary$$, false, null, true),
  ($$ID$$, $$IDN$$, $$360$$, $$Indonesia$$, false, null, true),
  ($$IE$$, $$IRL$$, $$372$$, $$Ireland$$, false, null, true),
  ($$IL$$, $$ISR$$, $$376$$, $$Israel$$, false, null, true),
  ($$IM$$, $$IMN$$, $$833$$, $$Isle of Man$$, false, null, true),
  ($$IN$$, $$IND$$, $$356$$, $$India$$, false, null, true),
  ($$IO$$, $$IOT$$, $$086$$, $$British Indian Ocean Territory$$, false, null, true),
  ($$IQ$$, $$IRQ$$, $$368$$, $$Iraq$$, false, null, true),
  ($$IR$$, $$IRN$$, $$364$$, $$Islamic Republic of Iran$$, true, $$Comprehensive United States embargo administered by OFAC. The switch is off and cannot be turned on.$$, false),
  ($$IS$$, $$ISL$$, $$352$$, $$Iceland$$, false, null, true),
  ($$IT$$, $$ITA$$, $$380$$, $$Italy$$, false, null, true),
  ($$JE$$, $$JEY$$, $$832$$, $$Jersey$$, false, null, true),
  ($$JM$$, $$JAM$$, $$388$$, $$Jamaica$$, false, null, true),
  ($$JO$$, $$JOR$$, $$400$$, $$Jordan$$, false, null, true),
  ($$JP$$, $$JPN$$, $$392$$, $$Japan$$, false, null, true),
  ($$KE$$, $$KEN$$, $$404$$, $$Kenya$$, false, null, true),
  ($$KG$$, $$KGZ$$, $$417$$, $$Kyrgyzstan$$, false, null, true),
  ($$KH$$, $$KHM$$, $$116$$, $$Cambodia$$, false, null, true),
  ($$KI$$, $$KIR$$, $$296$$, $$Kiribati$$, false, null, true),
  ($$KM$$, $$COM$$, $$174$$, $$Comoros$$, false, null, true),
  ($$KN$$, $$KNA$$, $$659$$, $$Saint Kitts and Nevis$$, false, null, true),
  ($$KP$$, $$PRK$$, $$408$$, $$North Korea$$, true, $$Comprehensive United States embargo administered by OFAC. The switch is off and cannot be turned on.$$, false),
  ($$KR$$, $$KOR$$, $$410$$, $$South Korea$$, false, null, true),
  ($$KW$$, $$KWT$$, $$414$$, $$Kuwait$$, false, null, true),
  ($$KY$$, $$CYM$$, $$136$$, $$Cayman Islands$$, false, null, true),
  ($$KZ$$, $$KAZ$$, $$398$$, $$Kazakhstan$$, false, null, true),
  ($$LA$$, $$LAO$$, $$418$$, $$Lao People's Democratic Republic$$, false, null, true),
  ($$LB$$, $$LBN$$, $$422$$, $$Lebanon$$, false, null, true),
  ($$LC$$, $$LCA$$, $$662$$, $$Saint Lucia$$, false, null, true),
  ($$LI$$, $$LIE$$, $$438$$, $$Liechtenstein$$, false, null, true),
  ($$LK$$, $$LKA$$, $$144$$, $$Sri Lanka$$, false, null, true),
  ($$LR$$, $$LBR$$, $$430$$, $$Liberia$$, false, null, true),
  ($$LS$$, $$LSO$$, $$426$$, $$Lesotho$$, false, null, true),
  ($$LT$$, $$LTU$$, $$440$$, $$Lithuania$$, false, null, true),
  ($$LU$$, $$LUX$$, $$442$$, $$Luxembourg$$, false, null, true),
  ($$LV$$, $$LVA$$, $$428$$, $$Latvia$$, false, null, true),
  ($$LY$$, $$LBY$$, $$434$$, $$Libya$$, false, null, true),
  ($$MA$$, $$MAR$$, $$504$$, $$Morocco$$, false, null, true),
  ($$MC$$, $$MCO$$, $$492$$, $$Monaco$$, false, null, true),
  ($$MD$$, $$MDA$$, $$498$$, $$Moldova, Republic of$$, false, null, true),
  ($$ME$$, $$MNE$$, $$499$$, $$Montenegro$$, false, null, true),
  ($$MF$$, $$MAF$$, $$663$$, $$Saint Martin (French part)$$, false, null, true),
  ($$MG$$, $$MDG$$, $$450$$, $$Madagascar$$, false, null, true),
  ($$MH$$, $$MHL$$, $$584$$, $$Marshall Islands$$, false, null, true),
  ($$MK$$, $$MKD$$, $$807$$, $$The Republic of North Macedonia$$, false, null, true),
  ($$ML$$, $$MLI$$, $$466$$, $$Mali$$, false, null, true),
  ($$MM$$, $$MMR$$, $$104$$, $$Myanmar$$, false, null, true),
  ($$MN$$, $$MNG$$, $$496$$, $$Mongolia$$, false, null, true),
  ($$MO$$, $$MAC$$, $$446$$, $$Macao$$, false, null, true),
  ($$MP$$, $$MNP$$, $$580$$, $$Northern Mariana Islands$$, false, null, true),
  ($$MQ$$, $$MTQ$$, $$474$$, $$Martinique$$, false, null, true),
  ($$MR$$, $$MRT$$, $$478$$, $$Mauritania$$, false, null, true),
  ($$MS$$, $$MSR$$, $$500$$, $$Montserrat$$, false, null, true),
  ($$MT$$, $$MLT$$, $$470$$, $$Malta$$, false, null, true),
  ($$MU$$, $$MUS$$, $$480$$, $$Mauritius$$, false, null, true),
  ($$MV$$, $$MDV$$, $$462$$, $$Maldives$$, false, null, true),
  ($$MW$$, $$MWI$$, $$454$$, $$Malawi$$, false, null, true),
  ($$MX$$, $$MEX$$, $$484$$, $$Mexico$$, false, null, true),
  ($$MY$$, $$MYS$$, $$458$$, $$Malaysia$$, false, null, true),
  ($$MZ$$, $$MOZ$$, $$508$$, $$Mozambique$$, false, null, true),
  ($$NA$$, $$NAM$$, $$516$$, $$Namibia$$, false, null, true),
  ($$NC$$, $$NCL$$, $$540$$, $$New Caledonia$$, false, null, true),
  ($$NE$$, $$NER$$, $$562$$, $$Niger$$, false, null, true),
  ($$NF$$, $$NFK$$, $$574$$, $$Norfolk Island$$, false, null, true),
  ($$NG$$, $$NGA$$, $$566$$, $$Nigeria$$, false, null, true),
  ($$NI$$, $$NIC$$, $$558$$, $$Nicaragua$$, false, null, true),
  ($$NL$$, $$NLD$$, $$528$$, $$Netherlands$$, false, null, true),
  ($$NO$$, $$NOR$$, $$578$$, $$Norway$$, false, null, true),
  ($$NP$$, $$NPL$$, $$524$$, $$Nepal$$, false, null, true),
  ($$NR$$, $$NRU$$, $$520$$, $$Nauru$$, false, null, true),
  ($$NU$$, $$NIU$$, $$570$$, $$Niue$$, false, null, true),
  ($$NZ$$, $$NZL$$, $$554$$, $$New Zealand$$, false, null, true),
  ($$OM$$, $$OMN$$, $$512$$, $$Oman$$, false, null, true),
  ($$PA$$, $$PAN$$, $$591$$, $$Panama$$, false, null, true),
  ($$PE$$, $$PER$$, $$604$$, $$Peru$$, false, null, true),
  ($$PF$$, $$PYF$$, $$258$$, $$French Polynesia$$, false, null, true),
  ($$PG$$, $$PNG$$, $$598$$, $$Papua New Guinea$$, false, null, true),
  ($$PH$$, $$PHL$$, $$608$$, $$Philippines$$, false, null, true),
  ($$PK$$, $$PAK$$, $$586$$, $$Pakistan$$, false, null, true),
  ($$PL$$, $$POL$$, $$616$$, $$Poland$$, false, null, true),
  ($$PM$$, $$SPM$$, $$666$$, $$Saint Pierre and Miquelon$$, false, null, true),
  ($$PN$$, $$PCN$$, $$612$$, $$Pitcairn$$, false, null, true),
  ($$PR$$, $$PRI$$, $$630$$, $$Puerto Rico$$, false, null, true),
  ($$PS$$, $$PSE$$, $$275$$, $$State of Palestine$$, false, null, true),
  ($$PT$$, $$PRT$$, $$620$$, $$Portugal$$, false, null, true),
  ($$PW$$, $$PLW$$, $$585$$, $$Palau$$, false, null, true),
  ($$PY$$, $$PRY$$, $$600$$, $$Paraguay$$, false, null, true),
  ($$QA$$, $$QAT$$, $$634$$, $$Qatar$$, false, null, true),
  ($$RE$$, $$REU$$, $$638$$, $$Reunion$$, false, null, true),
  ($$RO$$, $$ROU$$, $$642$$, $$Romania$$, false, null, true),
  ($$RS$$, $$SRB$$, $$688$$, $$Serbia$$, false, null, true),
  ($$RU$$, $$RUS$$, $$643$$, $$Russian Federation$$, false, null, true),
  ($$RW$$, $$RWA$$, $$646$$, $$Rwanda$$, false, null, true),
  ($$SA$$, $$SAU$$, $$682$$, $$Saudi Arabia$$, false, null, true),
  ($$SB$$, $$SLB$$, $$090$$, $$Solomon Islands$$, false, null, true),
  ($$SC$$, $$SYC$$, $$690$$, $$Seychelles$$, false, null, true),
  ($$SD$$, $$SDN$$, $$729$$, $$Sudan$$, false, null, true),
  ($$SE$$, $$SWE$$, $$752$$, $$Sweden$$, false, null, true),
  ($$SG$$, $$SGP$$, $$702$$, $$Singapore$$, false, null, true),
  ($$SH$$, $$SHN$$, $$654$$, $$Saint Helena$$, false, null, true),
  ($$SI$$, $$SVN$$, $$705$$, $$Slovenia$$, false, null, true),
  ($$SJ$$, $$SJM$$, $$744$$, $$Svalbard and Jan Mayen$$, false, null, true),
  ($$SK$$, $$SVK$$, $$703$$, $$Slovakia$$, false, null, true),
  ($$SL$$, $$SLE$$, $$694$$, $$Sierra Leone$$, false, null, true),
  ($$SM$$, $$SMR$$, $$674$$, $$San Marino$$, false, null, true),
  ($$SN$$, $$SEN$$, $$686$$, $$Senegal$$, false, null, true),
  ($$SO$$, $$SOM$$, $$706$$, $$Somalia$$, false, null, true),
  ($$SR$$, $$SUR$$, $$740$$, $$Suriname$$, false, null, true),
  ($$SS$$, $$SSD$$, $$728$$, $$South Sudan$$, false, null, true),
  ($$ST$$, $$STP$$, $$678$$, $$Sao Tome and Principe$$, false, null, true),
  ($$SV$$, $$SLV$$, $$222$$, $$El Salvador$$, false, null, true),
  ($$SX$$, $$SXM$$, $$534$$, $$Sint Maarten (Dutch part)$$, false, null, true),
  ($$SY$$, $$SYR$$, $$760$$, $$Syrian Arab Republic$$, true, $$Comprehensive United States embargo administered by OFAC. The switch is off and cannot be turned on.$$, false),
  ($$SZ$$, $$SWZ$$, $$748$$, $$Eswatini$$, false, null, true),
  ($$TC$$, $$TCA$$, $$796$$, $$Turks and Caicos Islands$$, false, null, true),
  ($$TD$$, $$TCD$$, $$148$$, $$Chad$$, false, null, true),
  ($$TF$$, $$ATF$$, $$260$$, $$French Southern Territories$$, false, null, true),
  ($$TG$$, $$TGO$$, $$768$$, $$Togo$$, false, null, true),
  ($$TH$$, $$THA$$, $$764$$, $$Thailand$$, false, null, true),
  ($$TJ$$, $$TJK$$, $$762$$, $$Tajikistan$$, false, null, true),
  ($$TK$$, $$TKL$$, $$772$$, $$Tokelau$$, false, null, true),
  ($$TL$$, $$TLS$$, $$626$$, $$Timor-Leste$$, false, null, true),
  ($$TM$$, $$TKM$$, $$795$$, $$Turkmenistan$$, false, null, true),
  ($$TN$$, $$TUN$$, $$788$$, $$Tunisia$$, false, null, true),
  ($$TO$$, $$TON$$, $$776$$, $$Tonga$$, false, null, true),
  ($$TR$$, $$TUR$$, $$792$$, $$Turkiye$$, false, null, true),
  ($$TT$$, $$TTO$$, $$780$$, $$Trinidad and Tobago$$, false, null, true),
  ($$TV$$, $$TUV$$, $$798$$, $$Tuvalu$$, false, null, true),
  ($$TW$$, $$TWN$$, $$158$$, $$Taiwan, Province of China$$, false, null, true),
  ($$TZ$$, $$TZA$$, $$834$$, $$United Republic of Tanzania$$, false, null, true),
  ($$UA$$, $$UKR$$, $$804$$, $$Ukraine$$, false, null, true),
  ($$UG$$, $$UGA$$, $$800$$, $$Uganda$$, false, null, true),
  ($$UM$$, $$UMI$$, $$581$$, $$United States Minor Outlying Islands$$, false, null, true),
  ($$US$$, $$USA$$, $$840$$, $$United States of America$$, false, null, true),
  ($$UY$$, $$URY$$, $$858$$, $$Uruguay$$, false, null, true),
  ($$UZ$$, $$UZB$$, $$860$$, $$Uzbekistan$$, false, null, true),
  ($$VA$$, $$VAT$$, $$336$$, $$Holy See (Vatican City State)$$, false, null, true),
  ($$VC$$, $$VCT$$, $$670$$, $$Saint Vincent and the Grenadines$$, false, null, true),
  ($$VE$$, $$VEN$$, $$862$$, $$Venezuela$$, false, null, true),
  ($$VG$$, $$VGB$$, $$092$$, $$Virgin Islands, British$$, false, null, true),
  ($$VI$$, $$VIR$$, $$850$$, $$Virgin Islands, U.S.$$, false, null, true),
  ($$VN$$, $$VNM$$, $$704$$, $$Vietnam$$, false, null, true),
  ($$VU$$, $$VUT$$, $$548$$, $$Vanuatu$$, false, null, true),
  ($$WF$$, $$WLF$$, $$876$$, $$Wallis and Futuna$$, false, null, true),
  ($$WS$$, $$WSM$$, $$882$$, $$Samoa$$, false, null, true),
  ($$XK$$, $$XKK$$, $$983$$, $$Kosovo$$, false, null, true),
  ($$YE$$, $$YEM$$, $$887$$, $$Yemen$$, false, null, true),
  ($$YT$$, $$MYT$$, $$175$$, $$Mayotte$$, false, null, true),
  ($$ZA$$, $$ZAF$$, $$710$$, $$South Africa$$, false, null, true),
  ($$ZM$$, $$ZMB$$, $$894$$, $$Zambia$$, false, null, true),
  ($$ZW$$, $$ZWE$$, $$716$$, $$Zimbabwe$$, false, null, true);

commit;
