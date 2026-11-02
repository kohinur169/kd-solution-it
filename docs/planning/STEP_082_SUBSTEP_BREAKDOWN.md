// path: docs/planning/STEP_082_SUBSTEP_BREAKDOWN.md
# STEP 082 - Business address and contact information section: sub-steps

The STEP is one commit. The order below is the order it was built and verified in, so a later STEP
that touches this area can read which slice owns what.

## 082.1 - The migration (`0105_business_address.sql` + rollback)

- Read section 5's field list ("business address, person name, contact information"), 0102's
  `address` step description ("the registered address and the contact details of the person who
  owns the account") and 0103's header (the one profile row is the shared storage).
- Nine columns on `public.business_profiles`: `address_line1`, `address_line2`, `city`,
  `state_province`, `postal_code`, `country_code`, `contact_name`, `contact_email`,
  `contact_phone`, plus the derived `address_completed_at timestamptz`.
- `countries_code_unique unique (code)` on the 0076 table, because a foreign key can only reference
  a unique constraint and 0076's unique index is partial (safe: 0076's guard refuses every delete
  and every soft delete).
- Per-column check constraints matching the service's parser: trimmed and length-bounded text
  lines, postal 3-12 of letters/digits/space/hyphen, country `^[A-Z]{2}$`, email lower case and
  5-254, phone `^\+?[0-9][0-9 ()-]{5,31}$`; `business_profiles_country_fkey` to
  `public.countries (code)`; `business_profiles_address_completed_check` (the instant requires all
  seven required fields) and `..._instant_check` (instant >= created_at); the office index
  `business_profiles_country_idx`. Rollback removes exactly what 0105 added and creates nothing.
- **Proof:** `npm run -s check:migrations`, then the PGlite run in `/tmp/proof/proof105.mjs` over the
  real 0001 + 0076 + 0077 + 0103 + 0104: FK and format refusals, the completion stamp rules, the
  country list's own guard, a negative control that drops the constraints and writes what they
  refused, and the rollback (250 countries and the profile row survive).

## 082.2 - The field list (`services/kyc/business-address-fields.ts`)

- The nine field names, their required/optional split (all but `address_line2` and
  `state_province`) and the length ceilings live in their own module with no server imports, so the
  client form can import the list without pulling the service's database client into the browser
  bundle (the first build failed on exactly that: `node:net` in the client chunks of the page).
- `services/kyc/business-address.ts` re-exports the list, so server code keeps one import path.

## 082.3 - The service (`services/kyc/business-address.ts`)

- `parseBusinessAddressInput`: exactly the nine keys; unknown keys, wrong types, over-length and
  pattern violations collected as `{field, rule}`; empty string is a deliberate clear (null);
  country upper cased, email lower cased.
- `readBusinessAddress`: owner role + session company before any query; the caller's own profile
  row; the enabled, live countries of 0076 in code order as the dropdown; the missing-required
  list; completion is derived from the seven fields, never posted.
- `saveBusinessAddress`: shape first (zero queries on refusal), then the country checked against
  the enabled list (`unknown_country` / `disabled_country`), then a patch carrying only the named
  fields plus `address_completed_at` (insert whole on create with the lost-race fallback to
  update), the `address` step mirrored into 0102 exactly the way 080 and 081 mirror theirs
  (create-on-complete opens on `category`), one `business_address.saved` audit entry with
  `{fields, complete, completed_now, missing, saved_at}`, audit-sink failure tolerated.
- **Proof:** the address sections of `services/kyc/verify.ts` (vocabulary, parse, read, save,
  refusals, sources, catalog) over the in-memory PostgREST the store grew for `countries` and the
  ten new profile columns.

## 082.4 - The route (`app/api/onboarding/business-address/route.ts`)

- POST only: CSRF token, 8 KiB declared ceiling, session, JSON parse, service. No company from the
  body; `{field, rule}` details on 422; `no-store` on the answer. Registered on
  `CSRF_PROTECTED_PATHS`.
- **Proof:** the source section of the gate plus the dev smoke (422 without/with a wrong token,
  405 on GET).

## 082.5 - The screen (`app/(dashboard)/onboarding/address/`)

- Page: `readOwnerActor`, `readBusinessAddress`, four separate refusals (signed out, forbidden,
  unreadable, ready), `SessionKeeper`.
- Form: nine fields in the shared list's order, the country as a filter input plus a native
  `select` over the enabled countries, per-field errors, the missing-fields line and the
  saved/complete lines via `formatMessage`, no HTML `required` so a cleared box stays saveable. One
  fetch to one path with one CSRF spread, sending only the nine values. `ONBOARDING_STEP_FORMS`
  gains `address: "/onboarding/address"`.
- **Proof:** the catalog section of the gate (every string used, every key present, templated lines
  rendered through `formatMessage`) plus the dev smoke on desktop-width markup.

## 082.6 - Gates, baselines and the record

- `services/kyc/verify.ts` grew from 944 to 1277 checks; the migration set now ends at 0105.
- `lib/auth/verify.ts` baselines: 10 session keepers, 24 browser mutation files, 27 call sites
  (2471 checks).
- `lib/i18n/strings/en.ts` gained the `onboardingAddress` block (50 strings, 3 placeholders;
  the gate totals went 1169 -> 1219 messages, 110 -> 113 placeholders).
- `npm run -s verify` exit 0; README migration table and `app/(dashboard)/README.md` updated;
  this breakdown and the handoff are in the same commit.

## What the next STEP inherits

- `business_profiles` now carries the address and contact columns plus `address_completed_at`;
  STEP 083 (one-time profile feeding processors) reads them from this one row when it opens a
  sub-merchant, the same way it reads `legal_name` and `mcc_code`.
- The patch-save discipline is now three services deep: 080, 081 and 082 each write only their own
  columns through their own route, so no onboarding screen can blank another screen's fields.
- `services/kyc/business-address-fields.ts` is the pattern for any future field list a client form
  and a server service must share: constants without server imports, re-exported by the service.
