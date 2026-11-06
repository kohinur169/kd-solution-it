// path: docs/handoffs/STEP_167_COMPLETED.md
# STEP 167 — Airwallex connected account creation and verification sync

**Status: COMPLETED**

## STEP

- Number and title: STEP 167 — Airwallex connected account creation and verification sync.
- Category: Five Payment Provider Adapters (NMI, Payoneer, Rainforest, Stripe Connect, Airwallex), STEP 147-169. Airwallex's third STEP: 165 read the pages and recorded the sandbox notes, 166 sealed the credentials and proved them, this STEP creates the connected account behind an approved company, submits it and reads what Airwallex says about it, 168 takes payments, and 169 closes the payouts, the webhooks and the capability matrix.
- Depends on (earlier STEPs in this category and their handoff files): STEP 165 (`airwallex.ts` — `AIRWALLEX_ENDPOINTS`, `AIRWALLEX_ACCOUNT_STATUSES`, `airwallexOnboardingStateOf`, `isAirwallexAccountId`, `airwallexAccountIdCollidesWithStripe`, `validateAirwallexAccountRequest`, `buildAirwallexConnectedAccountBody`, `sanitizeAirwallexText`), STEP 166 (`airwallex-client.ts` — the active configuration, `airwallexAccessTokenFor` and its in-memory token cache, `airwallexClientMessageOf`/`airwallexClientCodeOf`, `airwallexClientEndpoint`), STEP 163 (`stripe-accounts.ts` — the provisioning shape this STEP mirrors: a KYC gate, a pending row written before the call, forward-only outcomes, an outcome table, a readiness mapping), and STEP 096 (`services/submerchant/provision.ts` — the rule that an approval authorizes provisioning and only the adapter executes it).

## Files

- Created:
  - `lib/payments/adapters/airwallex-accounts.ts` — connected-account provisioning, submission and verification sync. Holds the documented surface (`AIRWALLEX_ACCOUNTS_CREATE_PATH`, `AIRWALLEX_ACCOUNT_READ_PATH_PATTERN`, `AIRWALLEX_ACCOUNT_SUBMIT_PATH_PATTERN`, `AIRWALLEX_ACCOUNT_ALLOWED_PATH_PATTERNS`, `isAirwallexAccountPath`, `airwallexAccountPath`, `airwallexAccountSubmitPath`, `AIRWALLEX_ACCOUNT_TIMEOUT_MS`, `AIRWALLEX_ACCOUNT_TEXT_MAXIMUM_LENGTH`), the KYC rule (`AIRWALLEX_KYC_APPROVED_STATUS`, `AirwallexKycApproval`), the submittable statuses (`AIRWALLEX_SUBMITTABLE_STATUSES`), the allowlisted transport (`AirwallexAccountCall`, `airwallexAccountFetchTransport`), the answer readers (`airwallexAccountMessageOf`, `airwallexAccountStatusOf`, `airwallexAccountIdOf`, `parseAirwallexAccountCreateAnswer`, `parseAirwallexAccountStatusAnswer`), the record (`AirwallexAccountProvision`, `AIRWALLEX_ACCOUNT_ATTEMPT_OUTCOMES`, `AirwallexAccountProvisionStore`, `InMemoryAirwallexAccountProvisionStore`), the audit vocabulary, `provisionAirwallexAccount`, `submitAirwallexAccount`, `syncAirwallexAccountVerification`, `airwallexAccountReadinessOf`, `AirwallexAccountReadiness` and `AIRWALLEX_VERIFICATION_STALE_AFTER_SECONDS`.
  - `lib/payments/adapters/airwallex-accounts-verify.ts` — the gate (266 checks, nine sections).
  - `docs/handoffs/STEP_167_COMPLETED.md` — this handoff.
- Modified:
  - `package.json` — added `check:payments-adapters-airwallex-accounts` and spliced it into the `verify` chain after `check:payments-adapters-airwallex-client`, before `typecheck`.
  - `docs/final/PROVIDER_DOCS.md` — one new bullet in the `## Airwallex (STEP 165)` section (the create, submit and read cycle with its approval gate, single-attempt rule and reconciliation flags), the create and submit sandbox rows extended, and one new `Not run` row for the verification read.
- Owned paths touched (must match the File Ownership Rules in STEP_PLAN_250.md): `lib/payments/adapters/` (one adapter file with its gate — the STEP 154/157/161/162/163 shape), plus the two shared files an adapter STEP may change — `package.json` (one gate entry) and `docs/final/PROVIDER_DOCS.md` (the Airwallex section only). No migration, no `app/` route, no component, no `lib/env` change, no `services/` change, and no other STEP's file edited.

## Database

None. The store is the `AirwallexAccountProvisionStore` port with an in-memory reference implementation that enforces the invariants the real table must carry: one row per company, an immutable company, mode, provider, id, authorizing KYC submission and account kind, a version guard, forward-only attempt outcomes, a `created` row that must carry an `acct_` id, an id that never changes once written, a status that must be one of the documented five, an onboarding state that must match that status, a submit time that never moves and a check counter that only climbs. The table, its unique key and its RLS belong to the STEP that persists provisioning; no migration number was consumed and no rollback proof is owed.

## Environment

None read, none added. The client id and API key arrive through STEP 166's sealed configuration, the token through STEP 166's in-memory cache, and the encryption key through the environment-backed keyring; adapter STEPs do not own `lib/env` or `.env.example`.

## Packages

None. `node:crypto` for the record id, `lib/security/encryption.ts` to open the sealed credentials, `lib/utils/freeze.ts`, and `fetch` for the three documented calls — no Airwallex SDK, no new dependency.

## Behaviour Proof (acceptance checklist)

- **Nothing is created without an approval, and nothing is created twice.** A KYC decision that is not `approved`, an approval belonging to another company, an approval naming no submission, a request the page's own rules reject, no active key configuration and a login that yields no token are each refused before any call and write no row. A `pending` row is written **before** Airwallex is asked, so a crash cannot silently create a second account; a replay answers `already_created` with no call; an `unknown` row answers `in_flight` and asks for reconciliation; a `rejected` row may be reopened, because Airwallex created nothing; a `pending` row already in the store refuses a second attempt.
- **The token is fetched before the row, and that ordering is deliberate.** STEP 166's token comes from a login call of its own, so a failed login leaves no half-attempt behind, while a create call that fails after the row exists leaves exactly the `unknown` row that prevents a second account.
- **The body is the page's and carries no identity secret.** `account_details` with `legal_entity_type: INDIVIDUAL` and `individual_details` for an individual, `business_details` with `business_name` and `registration_address.country_code` for a business, `customer_agreements` with both flags `true`, and `primary_contact.email`; the gate asserts a business body invents no legal entity type (the enum was never observed), and that the body carries no card field, no SSN or tax identifier, no date of birth, no IBAN and no credential.
- **The three paths are the only ones callable.** The create endpoint plus the id-shaped read and submit paths, each matched by pattern; the update endpoint, the login endpoint, a trailing slash, another version prefix, a too-short id, another provider's id and any path beyond the id are all refused, and the transport refuses an unallowlisted path, a missing token, a missing version, a POST without a body and a GET with one — all before any network call.
- **Every answer class is mapped and none is upgraded.** Create: `2XX` with an `acct_` id is `created` (with the documented status when the answer names one and `null` when it does not), `400`/`409`/`422` are `rejected` with the page's `field_required`/`invalid_argument` code kept, `401`/`403`/other refusals and redirects are `failed` so nothing was created, and a timeout class, `429`, a `5XX`, a thrown transport and a `2XX` naming no id are `unknown`. Read and submit: `2XX` with one of the five documented statuses is `answered`, `404` is `not_found`, `400`/`401`/`403` are `refused`, and everything unsettled is `unknown`.
- **Only a sent-able account is submitted.** An account that was never read (`accountStatus: null`), and one already `SUBMITTED`, `ACTIVE` or `SUSPENDED`, is refused without a call; a `CREATED` or `ACTION_REQUIRED` account is submitted on the documented path with the pin and records the status Airwallex answers — the file does not assume `SUBMITTED` because the page says so.
- **A read never invents a state.** An unrecorded status is `unknown` and is not stored; a `404` records `requiresReconciliation` and keeps the last known status instead of inventing one; a `401` writes nothing at all — the gate asserts the version and check counter are untouched — and a thrown read is `unknown` with the reason saying the API could not be reached.
- **Readiness follows `ACTIVE` alone.** `airwallexAccountReadinessOf` reports `ready` only for `ACTIVE`, `waiting` for `CREATED`/`SUBMITTED` and for an account whose status has never been read, and `blocked` for `ACTION_REQUIRED`, `SUSPENDED`, a rejected attempt and an unknown one, each with the mapping's own sentence as the blocking reason. Staleness (no read, or a read older than 24 hours) is reported as its own flag and never used to block, because a late sync is not evidence that an active account stopped working.
- **`acct_` is not proof of ownership.** STEP 165 recorded that Airwallex and Stripe share the prefix. The record carries `providerKey`, the store's `findByAccountId` answers only an Airwallex row, and the gate asserts a Stripe-shaped id finds nothing.
- **UI** — not applicable: this STEP adds no screen, so no desktop or mobile width was checked. The onboarding screen that will show `ready`/`waiting`/`blocked` consumes `airwallexAccountReadinessOf`; it is not part of an adapter STEP.
- **Security** — every refusal is a reason, never a value; the token is sent as a bearer header and never appears in the record, the audit entry or the answer types; the provider's message is sanitised and bounded; the audit vocabulary names six actions (`connected_account.created`, `.rejected`, `.unknown`, `.submitted`, `.verification_synced`, `.verification_failed`) carrying the provider key, the company, the attempt, the account id, the mode, the outcome and the time; the store enforces the section 6 style rules a later table must repeat (one row per company, immutable identity, forward-only outcomes, a status the documentation names). No route, no job and no table, so the pre-existing RLS and permission middleware are untouched.

## Verification

- `npm run typecheck` — clean.
- `npx eslint lib/payments/adapters/airwallex-accounts.ts lib/payments/adapters/airwallex-accounts-verify.ts` — clean.
- `node lib/payments/adapters/airwallex-accounts-verify.ts` and `node --experimental-strip-types lib/payments/adapters/airwallex-accounts-verify.ts` — both pass. The verdict line:

  `payments Airwallex connected-account gate passed: 266 checks (an approved company creates exactly one account with both agreement flags and no identity secret in the body, a replay and an unknown outcome never create a second one, only a CREATED or ACTION_REQUIRED account is submitted, every documented status is read and mapped while an unrecorded one is refused, a refused read writes nothing and a missing or unsettled one asks for reconciliation, and readiness follows ACTIVE alone with staleness reported rather than used to block)`

- The gate was proved to bite: with the KYC approval check and the readiness rule temporarily broken, it failed 8 of 266 checks (the approval refusals, the "no call, no row" assertions, and both payment-acceptance checks) and exited 1; both mutations were reverted before the run above.
- `npm run verify` — the full chain, including this new gate and the build, exits 0.
- `npm run check:structure` — `structure gate passed: 17 directories, 14 root files, 565 source files checked`.
- `npm run check:audit` — `audit gate passed: 3211 checks, …`.

## Not Run / Open

- **Nothing reached Airwallex.** No sandbox client id, API key, connected account or Sales-granted access exists in this environment, so the create, submit and read calls were exercised only against recorded answers. The three sandbox rows in `docs/final/PROVIDER_DOCS.md` stay `Not run`, and STEP 165's record stays `partial`.
- **The connected-account sandbox gap stands.** STEP 165 recorded that the sandbox covers every product except the Connected Account APIs; until Airwallex Sales grants access or a Simulation API run is recorded, STEP 169's account steps remain `partial` by definition.
- **The account-status webhook names are still unread.** This STEP syncs by polling the documented read; the subscription that could replace the poll belongs to STEP 169, and no account event name is invented here.
- **Persistence, the route and the screen are later work.** The store is a port with an in-memory reference implementation; the table, its RLS policy, the onboarding route and the screen arrive with the STEP that needs them, and none is claimed here.
