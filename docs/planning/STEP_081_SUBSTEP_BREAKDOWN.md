// path: docs/planning/STEP_081_SUBSTEP_BREAKDOWN.md
# STEP 081 - Merchant Category Code field in onboarding and profile settings: sub-steps

The STEP is one commit. The order below is the order it was built and verified in, so a later STEP
that touches this area can read which slice owns what.

## 081.1 - The migration (`0104_merchant_category_code.sql` + rollback)

- Read section 5's MCC line and 0077's header ("the profile will point at a row of it").
- `business_profiles.mcc_code text`, nullable: one column on the profile row of 0103, so the
  onboarding category form and any profile settings screen share the one stored value.
- `mcc_codes_code_unique unique (code)` on the 0077 table, because a foreign key can only reference
  a unique constraint and 0077's unique index is partial (safe: 0077's guard refuses every delete).
- `business_profiles_mcc_code_check` (`^[0-9]{4}$`, leading zeros kept) and
  `business_profiles_mcc_fkey` to `mcc_codes (code)`: the database refuses a code no network publishes.
- `business_profiles_mcc_idx` for the STEP 090 underwriting screen. Rollback removes exactly what
  0104 added and creates nothing.
- **Proof:** `npm run -s check:migrations`, then the PGlite run in `/tmp/proof/proof104.mjs` over the
  real 0001 + 0077 + 0103: FK and format refusals, leading-zero code, retired code keeps its
  reference, duplicate code refused, a negative control that drops the constraints and writes what
  they refused, and the rollback.

## 081.2 - The service (`services/kyc/merchant-category.ts`)

- `parseMerchantCategoryInput`: one field `mcc_code`; unknown keys, wrong types and non-four-digit
  values refused with `{field, rule}`; empty string or null clears.
- `readMerchantCategory`: the caller's own company (owner role + session company before any query),
  the profile row, and the active codes of `mcc_codes` in code order as the dropdown; a stored code
  that was retired still resolves its title through one extra bounded read.
- `saveMerchantCategory`: vocabulary checked before the write (`unknown_code`, `retired_code`), then
  a patch of the single `mcc_code` column (insert with the lost-race fallback), the `category` step
  mirrored into 0102 exactly the way 080 mirrors `business`, one `merchant_category.saved` audit
  entry, audit-sink failure tolerated.
- **Proof:** the category sections of `services/kyc/verify.ts`, over the in-memory PostgREST the
  store grew for `mcc_codes` and `mcc_code`.

## 081.3 - The route (`app/api/onboarding/merchant-category/route.ts`)

- POST only: CSRF token, 1 KiB declared ceiling, session, JSON parse, service. No company from the
  body; `{field, rule}` details on 422; `no-store` on the answer. Registered on
  `CSRF_PROTECTED_PATHS`.
- **Proof:** the source section of the gate plus the dev smoke (422 without/with a wrong token,
  405 on GET).

## 081.4 - The screen (`app/(dashboard)/onboarding/category/`)

- Page: `readOwnerActor`, `readMerchantCategory`, four separate refusals, `SessionKeeper`.
- Form: a filter input plus a native `select` over the service's option list (keyboard navigable,
  one option per published code), the chosen line, the saved line, per-rule refusal sentences,
  focus to the select on refusal, no HTML `required` so a clear stays saveable. One fetch, one CSRF
  spread. `ONBOARDING_STEP_FORMS` gains `category: "/onboarding/category"`.
- **Proof:** the catalog section of the gate (every string used, every key present) plus the dev
  smoke on desktop-width markup.

## 081.5 - Gates, baselines and the record

- `services/kyc/verify.ts` grew from 663 to 944 checks; the migration set now ends at 0104.
- `lib/auth/verify.ts` baselines: 9 session keepers, 23 browser mutation files, 26 call sites.
- `lib/i18n/strings/en.ts` gained the `onboardingCategory` block (31 strings, 3 placeholders).
- `npm run -s verify` exit 0; README migration table and `app/(dashboard)/README.md` updated;
  commit, push, handoff, this file.

## What the next STEP inherits

- `business_profiles` now carries `mcc_code` beside the seven facts; STEP 082's address columns go
  on the same row through its own migration, and the patch semantics of 080 and 081 keep the saves
  from overwriting each other.
- `ONBOARDING_STEP_FORMS` in `app/(dashboard)/onboarding/step-copy.ts` - add
  `address: "/onboarding/address"` there when STEP 082 lands.
- The refusal pattern of this STEP (four page states, `{field, rule}` details, one audit entry per
  save, the lost-insert-race fallback) is the one STEPs 082-099 copy.
