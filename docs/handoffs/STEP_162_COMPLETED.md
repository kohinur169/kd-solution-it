// path: docs/handoffs/STEP_162_COMPLETED.md
# STEP 162 — Stripe Connect encrypted key configuration and connection test

**Status: COMPLETED**

## STEP

- Number and title: STEP 162 — Stripe Connect encrypted key configuration and connection test.
- Category: Five Payment Provider Adapters (NMI, Payoneer, Rainforest, Stripe Connect, Airwallex), STEP 147-169. Stripe's second STEP: 161 recorded the documentation, this STEP seals the credentials and proves them, 163 creates connected accounts, 164 takes charges and receives signature-verified webhooks, and 167-169 finish the provider's sandbox cycle and capability matrix.
- Depends on (earlier STEPs in this category and their handoff files): STEP 161 (`lib/payments/adapters/stripe.ts` — the key prefixes and mode vocabulary, `STRIPE_OBSERVED_API_VERSION`, `sanitizeStripeText`, and the open questions this STEP settles), STEP 158 (`rainforest-client.ts` — the sealed-configuration, connection-test, activation and retirement shape), STEP 155 (`payoneer-client.ts` — the same shape for a payout provider), and `lib/security/encryption.ts` for `sealSecret`/`openSecret` and the keyring.

## Files

- Created:
  - `lib/payments/adapters/stripe-client.ts` — the credential service. Holds the two settled decisions (`STRIPE_ACCOUNT_SURFACE = "accounts_v2"` with its reason and `/v2/core/accounts`, and the API version as a stored, validated configuration field with `STRIPE_DEFAULT_API_VERSION`, `STRIPE_API_VERSION_PATTERN` and the live-preview refusal), the scopes `gateway:<companyId>:stripe:secret_key` and `:webhook_secret`, `validateStripeCredentials`, `configureStripeKeys`, `maskStripeCredential`, `stripeKeyViewOf`, `stripeFetchApiTransport` (allowlisted to `GET https://api.stripe.com/v1/accounts?limit=1`, `Bearer`, `Stripe-Version`, no redirects, 15 s, 64 KiB), `parseStripeAccountListAnswer` and `stripeProviderMessageOf`, `testStripeConnection`, `activateStripeConfig`, `retireStripeConfig`, `rollStripeWebhookSecret` with `STRIPE_WEBHOOK_SECRET_OVERLAP_SECONDS`, `stripeWebhookSecretsFor`, `stripeConfigIsSealed` and `stripeConfigIsPublishable`, the `StripeKeyConfig` record with its version-guarded store, and the audit entry vocabulary.
  - `lib/payments/adapters/stripe-client-verify.ts` — the gate (269 checks, fourteen sections).
  - `docs/handoffs/STEP_162_COMPLETED.md` — this handoff.
- Modified:
  - `package.json` — added `check:payments-adapters-stripe-client` and spliced it into the `verify` chain after `check:payments-adapters-stripe`, before `typecheck`.
  - `docs/final/PROVIDER_DOCS.md` — the Stripe section gained a "Verified for STEP 162" block, the two open questions 161 left to this STEP were rewritten as settled (surface, version) with the `whsec_`-has-no-mode limit added, and five `Not run` sandbox rows.
- Owned paths touched (must match the File Ownership Rules in STEP_PLAN_250.md): `lib/payments/adapters/` (one adapter file with its gate — the STEP 158 shape), plus the two shared files an adapter STEP may change — `package.json` (one gate entry) and `docs/final/PROVIDER_DOCS.md` (the Stripe section only). No migration, no `app/` route, no component, no `lib/env` change, no `services/` change, and no other STEP's file edited.

## Database

None, and deliberately so: the store is the `StripeConfigStore` port with an in-memory reference implementation that enforces the invariants (one pending configuration per company, one active one, immutable identity and sealed credential, strictly increasing version). The table and its RLS belong to the STEP that persists the configuration, which is not this adapter STEP; no migration number was consumed and no rollback proof is owed.

## Environment

None read, none added. The keyring comes from the caller and is read from the environment once at boot by `lib/security/encryption.ts`, exactly as section 6 requires; this STEP does not touch `lib/env` or `.env.example`, because adapter STEPs do not own that foundation and the credential arrives through the settings input rather than a variable.

## Packages

None. `node:crypto` for the record id, `lib/security/encryption.ts` for sealing, and `fetch` for the documented read — no Stripe SDK, no new dependency.

## Behaviour Proof (acceptance checklist)

- **A provider cannot be enabled on a failing test** — activation refuses an unknown configuration, a retired or superseded one, one that is already active, one with no test, one whose last test did not pass, one whose test ran in another environment, one whose test ran on another API version, and one with no webhook signing secret. Each refusal was exercised, and the in-memory store refuses the same transition at the storage boundary, so a caller that skipped the service cannot activate a key either.
- **Keys are sealed and bound** — the secret key and signing secret are AES-256-GCM envelopes (`kd1.…`) that do not contain the plaintext; opening them requires the same company, the same provider and the same field, so a sealed key copied into another company's row, or into the signing-secret slot, fails to open; a foreign keyring cannot open them and a rotated keyring still can.
- **The full key is never shown again** — the view carries the mask only (family prefix plus the last four characters, with the body hidden), the publishable key in full because it is public by design, the pinned version and the bookkeeping. No result, view or audit entry in the gate's fixtures contains the secret key or either signing secret.
- **The mode is validated before sealing** — a publishable key in the secret field, an organization key, a live key in a sandbox configuration, a sandbox key in a live one, a publishable key of another mode, an unshaped signing secret and a floating or preview-on-live version are each refused with a message that names the problem.
- **The connection test proves exactly what it says** — one recorded read of `GET /v1/accounts?limit=1` with the opened key and the stored version; `2XX` + a Stripe list ⇒ `connected` with the listed count; `401` ⇒ `rejected`; `403` ⇒ `not_permitted` (permissions, not the key); `400` ⇒ `failed` naming the version; `3xx`/`404`/`418` ⇒ `failed`; `408`/`425`/`429`/`5xx`/a throw ⇒ `unreachable`; a `200` that is not a list ⇒ `failed`. The outcome is recorded on the configuration and audited, and the result never carries the key.
- **Rotation is a procedure, not a hope** — a tested replacement activates and names the key it superseded; the previous key becomes `superseded`, cannot be re-activated and cannot be rolled; it is retired only after the replacement is active, and the active key itself cannot be retired. Activation and rotation each write their audit entry, once.
- **The signing-secret roll keeps its documented overlap** — a roll to the same value or to an unshaped value is refused; a successful roll keeps the previous secret for 24 hours and audits `provider_webhook_secret.rolled`; `stripeWebhookSecretsFor` returns both secrets inside the window and only the new one from the expiry instant onward, which is what STEP 164's receiver will need.
- **The two decisions STEP 161 deferred are made and recorded** — Accounts v2 (with its reason and path) and the API version as configuration with a live-preview refusal.
- **UI** — not applicable: no screen is added by this STEP, so no desktop or mobile width was checked; the settings screen is STEP 183's, and it consumes `stripeKeyViewOf` and the masked view above.
- **Security** — validation happens before sealing; the sealed scopes are per company, per provider and per field; the transport allowlists a single URL, refuses redirects and bounds both time and answer size; no credential reaches a result, an audit entry or a view; and the pre-existing shared guards, RLS and permission middleware were not touched.

## Verification

- `npx tsc --noEmit` — clean.
- `npx eslint lib/payments/adapters/stripe-client.ts lib/payments/adapters/stripe-client-verify.ts` — clean.
- `node lib/payments/adapters/stripe-client-verify.ts` and `node --experimental-strip-types lib/payments/adapters/stripe-client-verify.ts` — both pass, as does STEP 161's `stripe-verify.ts`. The verdict line:

  `payments Stripe Connect key gate passed: 269 checks (the Accounts v2 surface decision, sealed keys bound to company and field, the publishable key kept public on purpose, validated modes and API versions, the accounts read against an allowlisted endpoint, an activation that refuses without a passing test and a signing secret, a rotation that supersedes and retires, a signing-secret roll with its documented overlap, and no result that carries a credential)`

- `npm run verify` — green end to end (every earlier gate, then `check:payments-adapters-stripe-client`, `typecheck`, `lint`, `build`, ending `✓ Compiled successfully`).
- No network call was made to Stripe and no real credential was used.

## Next

- STEP 163 — connected account creation after KYC approval: `POST /v2/core/accounts` on the surface decided here, with the profile fields STEP 096's approval provides, an idempotent one-account-per-company record, and `acct_` persisted; it consumes `STRIPE_ACCOUNT_SURFACE`, the active configuration and `stripeConnectionEndpoint`'s neighbour for account reads.
- STEP 164 — charges with the platform fee split, payouts, and the signature-verified idempotent webhook receiver: it consumes `stripeWebhookSecretsFor` for the roll overlap and `verifyStripeWebhookSignature` from STEP 161 for the signature; the charge type must be chosen from `STRIPE_CHARGE_TYPE_FACTS` and recorded.
