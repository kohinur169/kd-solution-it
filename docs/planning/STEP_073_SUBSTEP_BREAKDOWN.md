// path: docs/planning/STEP_073_SUBSTEP_BREAKDOWN.md
# STEP 073 - Sub-step breakdown

STEP 073: **Country enable and disable management screen** (`docs/final/STEP_PLAN_250.md`, the STEP 073
block), from `docs/final/FEATURE_LIST.md` section 3 - "Country enable and disable switch at platform
level, controlled by super_admin and CEO. Sanctioned countries stay permanently disabled." - and
section 2, which lists country enable as one of the four actions the approval chain carries.

## What already exists, and what is missing

- `migrations/0076_reference_countries.sql` (STEP 036) - the whole reference list: 250 ISO 3166-1 rows
  with alpha-2, alpha-3 and numeric codes, the frozen identity, the sanction flag with its note, the
  `countries_sanctioned_disabled_check` that refuses a sanctioned row that is on, the guard trigger that
  refuses every delete and every change to the four identity columns, the switch column `is_enabled`,
  and the five policies that give `super_admin` the list and `ceo` the update.
- `migrations/0095_approval_requests.sql` (STEP 070) - the `country_enable` action as one of the four,
  `subject_type = 'country'`, the three day expiry and the partial unique key that stops a subject being
  queued twice.
- `lib/approvals/` (STEPs 070 and 072) - `requestApproval`, the two signatures, `expireLapsedApprovals`
  and the registry that owns the requester matrix: only the super administrator may raise
  `country_enable`, because the CEO signs it.
- `app/(admin)/ceo/page.tsx` - the country counts (enabled, disabled, sanctioned) and the queue where the
  decision is taken.
- `lib/auth/step-up.ts` (STEP 053), `lib/auth/request-proof.ts` (STEP 050), `lib/security/csrf.ts`
  (STEP 057), `set_row_metadata()` (STEP 012) - the fresh second factor, the device proof, the token and
  the version trigger.

What was missing: the screen and the act. The list could be read by a query nobody had written, the
switch was flipped by nothing, and a country could not be opened through the chain that exists for it.

## The decisions this STEP makes

1. **The switch has three states, not two.** Enabled, disabled and sanctioned. A sanctioned row is off
   because of an embargo; the database refuses to enable it, the guard freezes the flag, and the service
   refuses it before it writes. Folding it into "disabled" would let the screen offer a switch that can
   only fail.
2. **An opening spends a decision; a closing does not.** Opening a market is exactly the act the chain
   exists for: a `country_enable` request, the CEO's approval, the super administrator's confirmation,
   and then the flip that spends that approval. Closing is the protective direction - a sanctions
   listing or a processor outage cannot wait for two signatures - so it is a direct, reasoned, audited
   act by either controller. The asymmetry is recorded in the migration and the handoff rather than left
   to be discovered.
3. **One decision opens one market once.** `consumed_at` and `consumed_by` are written on the approval in
   the same call that flips the switch, so a decision cannot be spent twice and a country cannot be
   reopened later on an old signature. This is the column pair `0095` deliberately did not have.
4. **The spend is conditional, and a lost flip gives it back.** The spend is `update ... where consumed_at
   is null``: a second operator spends nothing. The flip is `where version = ...`: a switch somebody else
   turned is a conflict rather than a silent overwrite, and the decision is released again so a market is
   never closed with a decision burned behind it.
5. **A closed market carries its reason.** `countries.disabled_reason` is required by a check whenever the
   country is off, cleared when it opens, bounded at 10 to 280 characters, and never copied into the
   audit payload - the trail gets the length and the operator gets the sentence.
6. **The screen is one list and one panel.** The list is 250 rows; a form on every row would be 250
   inputs. The list is the choice, the panel is the one place a sentence is written and one button is
   pressed, and the panel's state is per country so the words typed for one country cannot be sent with
   another.
7. **Reads are open to the two controllers only.** Section 3's pair is the pair the sidebar offers, and
   the service refuses every other role before its first query - including the office roles that read the
   list elsewhere in the product.

## The sub-steps

1. **Read the sources.** FEATURE_LIST section 3, the STEP plan's STEP 073 block, the STEP 072 handoff,
   `0076`, `0095`, `lib/approvals/registry.ts` and `components/office/navigation.ts`.
2. **Owned paths.** `migrations/` (append only, `0098`), `lib/countries/` (a new module),
   `app/api/office/countries/`, `app/(admin)/countries/`, the string catalog, the office navigation and
   its gate, the two path lists that make a route protected, and the docs.
3. **Database.** `0098_country_switch_authority.sql`: `countries.disabled_reason` with its check,
   `approval_requests.consumed_at` and `consumed_by` with the pair check and the approved-only check, and
   the partial index the switch reads. Rollback drops exactly those, in the order PostgreSQL requires.
4. **Registry.** `lib/countries/registry.ts`: the two controller roles, the three states, the three
   refusals, the two audit names, the reason's bounds and the list's ceiling.
5. **Service.** `lib/countries/service.ts`: `listCountrySwitches`, `enableCountry`, `disableCountry`,
   `requestCountryEnable`, the compare-and-set write, the spend and its release, and one audit entry per
   turn.
6. **Route.** `app/api/office/countries/route.ts`: three actions behind CSRF, the body ceiling, the
   session, the device proof, then the service.
7. **Screen.** `app/(admin)/countries/page.tsx` and `country-switch-console.tsx`: the counts, the search
   and the state filter, the list, and the one panel that turns the selected country. Both widths, no
   fixed width, no landmark of its own.
8. **Security.** The two path lists, the office navigation entry, and the gates.
9. **Gate.** `lib/countries/verify.ts`: 467 checks over the registry, the read, the three turns, their
   refusals, the SQL, the route, the screen and the copy.
10. **Proof and docs.** Typecheck, lint, every gate, the build, the runtime smoke, this file and the
    handoff.

## Acceptance, in one line each

- The list renders every row with its state, its sanction note and its reason.
- Only `super_admin` and `ceo` may read it or turn it.
- A sanctioned country is never offered an opening and is refused by name if asked.
- An opening without an approved decision is refused; with one, it flips the row and spends the decision.
- A closing needs a sentence of ten characters and writes it to the row, not to the audit payload.
- Every turn is audited, and every refusal names a field and a rule.
