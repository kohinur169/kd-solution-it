// path: docs/handoffs/STEP_163_COMPLETED.md
# STEP 163 — Stripe Connect connected account creation after KYC approval

**Status: COMPLETED**

## STEP

- Number and title: STEP 163 — Stripe Connect connected account creation after KYC approval.
- Category: Five Payment Provider Adapters (NMI, Payoneer, Rainforest, Stripe Connect, Airwallex), STEP 147-169. Stripe's third STEP: 161 read the documentation, 162 sealed the key and proved it, this STEP creates the `acct_` behind an approved company and issues the onboarding link, 164 adds charges, payouts and the signature-verified webhook receiver, and 167-169 close the sandbox cycle and capability matrix.
- Depends on (earlier STEPs in this category and their handoff files): STEP 161 (`stripe.ts` — the account id pattern and `stripeOnboardingStateOf`, which this STEP reuses to summarise requirements), STEP 162 (`stripe-client.ts` — `STRIPE_ACCOUNT_SURFACE`, `STRIPE_ACCOUNT_SURFACE_PATH`, the active configuration and its sealed key), STEP 160 (`rainforest-merchant.ts` — the idempotent-provisioning shape this STEP mirrors), STEP 096 (`services/submerchant/provision.ts` — the rule that an approval creates a provisioning intent and only the adapter may execute it; its KYC status vocabulary is the one this STEP gates on), and STEPs 133/139-140, whose platform-fee and reserve model decided the v2 responsibilities.

## Files

- Created:
  - `lib/payments/adapters/stripe-accounts.ts` — connected-account provisioning. Holds the documented surface (`STRIPE_ACCOUNTS_PATH = "/v2/core/accounts"`, `STRIPE_ONBOARDING_LINK_PATH = "/v1/account_links"` and the two-path allowlist), the configuration this platform fixes and why (`STRIPE_PLATFORM_RESPONSIBILITIES`, `STRIPE_PLATFORM_DASHBOARD = "none"`, `STRIPE_PLATFORM_DASHBOARD_REASON`, `STRIPE_KYC_APPROVED_STATUS`, `STRIPE_REQUESTED_CAPABILITIES`, `STRIPE_ACCOUNT_INCLUDE_VALUES`), `validateStripeResponsibilities` and `stripeRequirementsCollectorOf`/`stripePlatformCollectsRequirements`, `validateStripeCompanyProfile` and `buildStripeAccountBody`, the allowlisted `stripeAccountFetchTransport`, `parseStripeAccountAnswer` with `stripeAccountMessageOf`, the `StripeAccountProvision` record with its version-guarded store and forward-only outcome table, `provisionStripeAccount`, `validateOnboardingUrl`, `buildStripeAccountLinkBody`, `parseStripeAccountLinkAnswer`, `createStripeOnboardingLink`, `stripeAccountReadinessOf`, and the audit vocabulary.
  - `lib/payments/adapters/stripe-accounts-verify.ts` — the gate (237 checks, nine sections).
  - `docs/handoffs/STEP_163_COMPLETED.md` — this handoff.
- Modified:
  - `package.json` — added `check:payments-adapters-stripe-accounts` and spliced it into the `verify` chain after `check:payments-adapters-stripe-client`, before `typecheck`.
  - `docs/final/PROVIDER_DOCS.md` — the Stripe section gained the two pages read for this STEP (the connected-account configuration page and the account-link page), a "Verified for STEP 163" block, and four `Not run` sandbox rows.
- Owned paths touched (must match the File Ownership Rules in STEP_PLAN_250.md): `lib/payments/adapters/` (one adapter file with its gate), plus the two shared files an adapter STEP may change — `package.json` (one gate entry) and `docs/final/PROVIDER_DOCS.md` (the Stripe section only). No migration, no `app/` route, no component, no `lib/env` change, no `services/` change, and no other STEP's file edited.

## Database

None. The store is the `StripeAccountProvisionStore` port with an in-memory reference implementation that enforces the invariants the real table must carry: one row per company, an immutable company, mode, id and authorizing KYC submission, a version guard, forward-only outcomes, a `created` row that must carry an `acct_` id, and a row carrying an id that is final. The table, its unique key and its RLS belong to the STEP that persists provisioning; no migration number was consumed and no rollback proof is owed.

## Environment

None read, none added. The Stripe key arrives through STEP 162's sealed configuration, never through a variable read by this file, and adapter STEPs do not own `lib/env`.

## Packages

None. `node:crypto` for the record id, `lib/security/encryption.ts` to open the sealed key, and `fetch` for the two documented calls — no Stripe SDK, no new dependency.

## Behaviour Proof (acceptance checklist)

- **Nothing is created without approval, and nothing is created twice.** A submission that is not `approved`, an approval belonging to another company, an approval naming no submission, an invalid profile, a company with no active key, a key proven on another surface and a keyring that cannot open the key are each refused before any call and write no provision. A `pending` row is written **before** the call, so a crash cannot silently create a second account; a replay answers `already_created` with no call made; an `unknown` row answers `in_flight` with no call made; a `rejected` row may be reopened, because Stripe created nothing.
- **The recorded configuration matches the pages.** `fees_collector: application`, `losses_collector: application`, `dashboard: none`; the page's restriction on the pair is enforced; the derived requirements collector is `application`, which is asserted for this configuration and for the three other combinations.
- **The body carries business identity and no onboarding secret.** The create body was asserted field by field in the documented nesting (including `stripe_balance.stripe_transfers.requested`), asserted to carry no legacy `type` and no v1 `controller` properties, and asserted to contain no tax identifier, SSN, date of birth, bank account number, routing number or IBAN, and no SSN- or nine-digit-shaped value anywhere.
- **Every answer class is mapped.** `2XX` + `acct_` ⇒ `created` with the capabilities that are `active` and the requirements summarised to `ready`/`waiting`/`blocked`; `400`/`409`/`422` ⇒ `rejected` with the provider's message; `401`/`403`/`404`/`405`/`415`/`3xx` ⇒ `failed`; `408`/`425`/`429`/`5XX`, a thrown transport and a `2XX` naming no account id ⇒ `unknown` with `requiresReconciliation`.
- **The onboarding link is the documented call.** A form-encoded `account`/`type`/`refresh_url`/`return_url` body to `/v1/account_links`, refused for an invented type, a non-HTTPS URL, a provision that is not `created` or an unknown provision; the answer must be an `account_link` carrying an absolute HTTPS URL, its documented `expires_at` is kept, and the documented lifetime is used only when the answer omits it.
- **Readiness is derived from evidence.** An account accepts payments only when it exists and both capabilities are `active`; it is onboarded only when nothing is due; each blocker names what is missing (`card_payments`, `stripe_transfers`, the disabled reason, or reconciliation).
- **UI** — not applicable: this STEP adds no screen, so no desktop or mobile width was checked. The onboarding screen that consumes `createStripeOnboardingLink` is STEP 183's.
- **Security** — the KYC approval is checked by value and by company rather than trusted as a boolean; the transport allowlists two paths, refuses redirects and bounds both time and answer size; the key is opened per call and never returned; provider text is sanitised and capped before it is stored or shown; no credential appears in a result or an audit entry; the pre-existing shared guards, RLS and permission middleware were not touched.

## Verification

- `npx tsc --noEmit` — clean.
- `npx eslint lib/payments/adapters/stripe-accounts.ts lib/payments/adapters/stripe-accounts-verify.ts` — clean.
- `node lib/payments/adapters/stripe-accounts-verify.ts` and `node --experimental-strip-types lib/payments/adapters/stripe-accounts-verify.ts` — both pass. The verdict line:

  `payments Stripe Connect accounts gate passed: 237 checks (the fixed v2 responsibilities and dashboard with their derived requirements collector, a create body with no onboarding secret in it, one account per company created after KYC approval and never twice, an honest unknown outcome that asks for reconciliation, the documented onboarding link with its expiry, and a readiness answer that only lets a proven account take payments)`

- `npm run verify` — green end to end (every earlier gate, then `check:payments-adapters-stripe-accounts`, `typecheck`, `lint`, `build`, ending `✓ Compiled successfully`).
- No network call was made to Stripe and no real credential was used.

## Next

- STEP 164 — charges with the platform fee split, payouts and signature-verified idempotent webhooks: it consumes `stripeAccountReadinessOf` before it charges anything, `STRIPE_PLATFORM_RESPONSIBILITIES` when it decides direct versus destination charges (the configuration page recommends the platform-paid pair for destination charges), and STEP 162's `stripeWebhookSecretsFor` plus STEP 161's `verifyStripeWebhookSignature` for deliveries.
- The open questions this STEP leaves are recorded in `PROVIDER_DOCS.md`: whether the pinned version in a live configuration is accepted by the Accounts v2 surface (every documented v2 example carried a preview version), and whether Stripe's own `Idempotency-Key` header should be sent alongside this platform's store-based guard — both are for STEP 164, which is the first STEP that can spend money.
