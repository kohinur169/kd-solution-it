// path: docs/handoffs/STEP_159_COMPLETED.md
# STEP 159 — Rainforest payment acceptance integration

**Status: COMPLETED**

## STEP

- Number and title: STEP 159 — Rainforest payment acceptance integration.
- Category: Five Payment Provider Adapters (NMI, Payoneer, Rainforest, Stripe Connect, Airwallex), STEP 147-169. Rainforest's third STEP: 157 recorded the documentation, 158 configured and tested the key, 160 builds the sub-merchant onboarding with signature-verified idempotent webhooks.
- Depends on (earlier STEPs in this category and their handoff files): STEP 157 (`lib/payments/adapters/rainforest.ts` — the documented bases, paths, status vocabulary, payin outcome mapping and `sanitizeRainforestText`), STEP 158 (`lib/payments/adapters/rainforest-client.ts` — the sealed key configuration, the active-configuration lookup this STEP reads, and the audit-entry shape), STEP 158's handoff (its binding constraint: the active config only, the version header on every call, no raw card or bank account number), STEP 130 (`lib/payments/creation.ts` — the idempotency-key contract a payin record must line up with), STEP 132 (the ledger rule that only a success may post), and `lib/security/encryption.ts` for `openSecret`.

## Files

- Created:
  - `lib/payments/adapters/rainforest-payment.ts` — the acceptance service: the documented payin config path, session path and payin read path, the component bundles and CSP host, the session limits (default 3,600 s, maximum 86,400 s) and the `group#payment_component` permission group, the 23-code refusal vocabulary, the input types and validators, `buildRainforestPayinConfigBody`, the `RainforestPaymentTransport` port with `rainforestFetchPaymentTransport`, the version-guarded `RainforestPayinConfigSubmission` store with its forward-only outcome table, `createRainforestPayinConfig`, `buildRainforestSessionBody`, `createRainforestSession`, `rainforestPaymentComponentFor` and `readRainforestPayin`.
  - `lib/payments/adapters/rainforest-payment-verify.ts` — the gate (440 checks).
  - `docs/handoffs/STEP_159_COMPLETED.md` — this handoff.
- Modified:
  - `package.json` — added the `check:payments-adapters-rainforest-payment` script and its place in the `verify` chain, after `check:payments-adapters-rainforest-client` and before `typecheck`.
  - `docs/final/PROVIDER_DOCS.md` — the Rainforest section gained a "Verified for STEP 159" block (the component path and why not the direct API path, the documented-only payin config body, the validation rules, idempotency, the creation answer table, the scoped session, the published component contract, the single-success read rule and the refusal vocabulary, and what this STEP deliberately does not do) plus four `Not run` sandbox rows for the payin config, the session, the component and the payin read.
- Owned paths touched (must match the File Ownership Rules in STEP_PLAN_250.md): `lib/payments/adapters/` (one adapter file plus its gate, the shape every adapter STEP in 147-169 uses), plus the two shared files an adapter STEP may change — `package.json` (one gate entry) and `docs/final/PROVIDER_DOCS.md` (the Rainforest section only). No migration, no `app/` route, no component, no `lib/env` change, no `services/` change, and no other STEP's file edited.

## Database

- Migrations added (file names): none. The records this STEP needs are values the caller stores. `RainforestPayinConfigStore` and its shipped `InMemoryRainforestPayinConfigStore` are the reference implementation of the invariants the real table must enforce: one row per company and idempotency key, an immutable company/key/merchant/amount/currency, a strictly increasing `version` for optimistic locking, and a forward-only outcome (`pending` → `created` | `rejected` | `unknown`, `unknown` → `created` | `rejected`, `created` and `rejected` final). A `created` row must carry a provider config id, and a write that changes nothing proceeds only through the same version guard.
- Rollback verified on clean database (yes/no, how): not applicable — no migration was added or changed.

## Environment

- Environment variables added to .env.example: none. The service reads the caller's sealed configuration and the caller's keyring; it reads no environment variable itself.
- Secrets handled (names only, never values): the Rainforest API key (opened for one call through `openSecret` and never stored, logged or audited) and the **session key**, which is a short-lived browser credential. The session key is returned to the caller because the browser is where the documentation puts it, and it is never written to the submission store, an audit entry or an error message; the gate asserts that with `JSON.stringify(...).includes(<fixture key>) === false`. No card number, no CVV and no bank account number is an input, an output, a stored field or a log line anywhere in the adapter.

## Packages

- Package requests for the integrator (name, reason), or none: none. `node:crypto`'s `randomUUID` is the only direct import beyond the repository's own modules.

## Behaviour Proof (acceptance checklist)

The four behaviours this STEP adds were exercised. `npm run check:payments-adapters-rainforest-payment` runs all 440 checks and passes.

1. **The payin config is documented-only and idempotent.** A minimal body carries exactly `merchant_id`, `idempotency_key`, `amount` (minor units), `currency_code` — four keys, no card or bank field and no card-number text; billing contact, amount splits and metadata are added only when supplied and valid. The submission is stored before the call, so a replay answers from the store with **zero** additional provider calls, a replay with another amount or merchant is refused as a reuse of the key, and an in-flight duplicate answers `unknown` without sending. The full answer table is exercised: `2XX` with a `cfg_`/`sbx_cfg_` id → `created`; `400`/`409`/`422` → `rejected` with the sanitised provider message (`amount: Amount is invalid`, `<script>` stripped); `401`/`403`/`404`/`405`/`415`/`302` → `failed`; `408`/`425`/`429`/`500`/`503`/thrown transport/`2XX` without a usable id → `unknown` with `requiresReconciliation` and a stored unknown submission.
2. **The session is scoped down.** The body is `{ttl, statements: [{permissions: ["group#payment_component"], constraints: {merchant: {merchant_id}}}]}`, never `group#all`; the default lifetime is 3,600 s, 86,400 s is accepted and 86,401 refused, as is anything under 60 s or fractional. A `2XX` with a `sessionkey_…` key is `created` (the provider's `expires_at` is used when it parses, otherwise the requested lifetime from the call instant), a key of the wrong shape fails, `400`/`422` are `rejected`, and every other answer fails — safely retryable because a session moves no money.
3. **The component contract is data, not a render.** `rainforestPaymentComponentFor` answers `{tag: "rainforest-payment", scriptUrl, attributes: {"session-key", "payin-config-id"}}` with the sandbox bundle for the sandbox and the production bundle for production, carries no API key, and refuses to build from a session key or config id of the wrong shape.
4. **The read has one success.** Only `SUCCEEDED` with the expected amount **and** currency is `succeeded`; `CREATED`/`PRESENTING`/`AUTHORIZED`/`PROCESSING`/`IN_REVIEW` are `pending`; `FAILED`/`RETURNED`/`CANCELED` are `failed` with `refusal_code`, `refusalCodeKnown` and the detailed-then-plain description sanitised; a different amount, a different currency, a missing amount, an undocumented status, a missing `data`, an empty body, a `404`, `400`/`401`/`403`/`409`/`429`/`500`/`503` and a thrown transport are all `unknown` with `requiresReconciliation`. A production configuration reads the production base with the production key.

## Verification

- `npx tsc --noEmit`: clean.
- `npx eslint lib/payments/adapters/rainforest-payment.ts lib/payments/adapters/rainforest-payment-verify.ts`: clean.
- `node lib/payments/adapters/rainforest-payment-verify.ts`: `payments Rainforest payment gate passed: 440 checks (a payin config body of documented fields only, an idempotent creation that never sends twice, a component session scoped to one merchant and one permission group, a component contract with no API key, and a payin read whose only success is the documented SUCCEEDED status at the amount and currency the platform asked for)`.
- `npm run verify`: passed the whole chain (audit, structure, env, config, i18n, logger, errors, lint, shell, jobs, migrations, the estimate/invoice/recurring/settlement chains, every payments gate including `check:payments-adapters-rainforest` 365, `-rainforest-client` 215 and `-rainforest-payment` 440, then typecheck, lint and build).
- Behaviours exercised without a provider: everything above, against recording transports. **No call reached Rainforest**: no sandbox account or API key exists in this environment, so no payin config, no session and no payin is real, and the four new `Not run` rows say so.

## Next

- Next STEP number: STEP 160 — Rainforest sub-merchant onboarding and signature-verified idempotent webhooks.
- Anything the next chat must know:
  - Reuse, do not reimplement: STEP 158's `configureRainforestKeys`, `testRainforestConnection`, `activateRainforestConfig`, `retireRainforestConfig`, `rainforestKeyViewOf`, `rainforestKeyListEndpointFor`, `parseRainforestKeyListAnswer`, `rainforestFetchApiTransport`, `rainforestApiKeyScope`, `maskRainforestCredential`, `rainforestConfigIsSealed`, and this STEP's `createRainforestPayinConfig`, `createRainforestSession`, `rainforestPaymentComponentFor`, `readRainforestPayin`, `rainforestFetchPaymentTransport`, `RAINFOREST_REFUSAL_CODES`, `RAINFOREST_SESSION_MAXIMUM_TTL_SECONDS`, `RAINFOREST_COMPONENT_CSP_HOSTS`, `RAINFOREST_MERCHANT_ID_PATTERN` and `RAINFOREST_PAYIN_ID_PATTERN`.
  - The active configuration is still the only one a payment may use: `findActiveByCompany`, never "the newest row".
  - The webhook receiver of STEP 160 must apply `payin.processing` and `payin.failed` (the documented `{resource}.{status}` lower-case event names) by **re-reading the payin** through `readRainforestPayin` rather than trusting the payload's amount and status; the same amount/currency equality rule and the same `unknown`-never-`failed` rule must hold. Dedupe on the resource id plus `event_type`, because delivery is at-least-once.
  - The webhook signature scheme is still unread: the "Verify webhooks" recipe is not published at a readable URL in this environment. STEP 160 must read it before implementing verification; until then every delivery must be refused rather than applied.
  - No core acceptance port exists yet. This adapter is the provider-side contract (`succeeded`/`pending`/`failed`/`unknown`); the route or job that consumes it maps `succeeded` onto STEP 130's payment and STEP 132's ledger, and no other outcome may post.
  - The payin config is single-use for one successful payin and reusable to retry after a failure. A retry must reuse the stored config id, not create a second config with a new key.
  - No Rainforest credential exists here. Any live result must come from a session that has one, and the `Not run` rows in `PROVIDER_DOCS.md` are what must be updated then.
