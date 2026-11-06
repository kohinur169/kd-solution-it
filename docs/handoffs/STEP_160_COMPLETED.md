// path: docs/handoffs/STEP_160_COMPLETED.md
# STEP 160 — Rainforest sub-merchant onboarding integration with signature verified idempotent webhooks

**Status: COMPLETED**

## STEP

- Number and title: STEP 160 — Rainforest sub-merchant onboarding integration with signature verified idempotent webhooks.
- Category: Five Payment Provider Adapters (NMI, Payoneer, Rainforest, Stripe Connect, Airwallex), STEP 147-169. Rainforest's last STEP: 157 recorded the documentation, 158 configured and tested the key, 159 built payment acceptance, and this STEP completes the provider's sandbox cycle — merchant creation, onboarding, and the signatures and replays that end the flow.
- Depends on (earlier STEPs in this category and their handoff files): STEP 157 (`lib/payments/adapters/rainforest.ts` — the merchant, application and event vocabularies, `parseRainforestEventType`, `sanitizeRainforestText`), STEP 158 (`rainforest-client.ts` — the sealed key configuration and `findActiveByCompany`), STEP 159 (`rainforest-payment.ts` — the transport, the session service this STEP extends with a second purpose, `readRainforestPayin` and the audit-entry shape), STEP 153 (`nmi-submerchant.ts` — the idempotent provisioning and webhook-record pattern this STEP mirrors), STEP 156 (`payoneer-payout.ts` — "refuse every delivery while no verifier exists"), and `lib/security/encryption.ts` for `openSecret`.

## Files

- Created:
  - `lib/payments/adapters/rainforest-merchant.ts` — sub-merchant onboarding: the documented merchant path and id prefixes, the eight documented merchant types, the MCC pattern, the onboarding bundle URLs, the component tag, the non-sensitive `RainforestMerchantProfile` (and nothing else — no tax id, no owner, no SSN, no bank data), `validateRainforestMerchantProfile`, `buildRainforestMerchantBody`, the version-guarded `RainforestMerchantProvision` store with its forward-only outcome table, `provisionRainforestMerchant`, `rainforestOnboardingComponentFor`, `startRainforestOnboarding` and `rainforestOnboardingStateOf`.
  - `lib/payments/adapters/rainforest-merchant-verify.ts` — the gate (260 checks).
  - `lib/payments/adapters/rainforest-webhook.ts` — the receiver: the documented acknowledgement budget and body cap, the scheme value, `refuseRainforestWebhookVerifier`, `createRainforestHmacWebhookVerifier`, signature candidate parsing, the `{resourceId, eventType}` idempotency record and its store, `receiveRainforestWebhook` with a `readRainforestPayin`-backed payin effect and the merchant/application mappings, and `rainforestWebhookResponseOf`.
  - `lib/payments/adapters/rainforest-webhook-verify.ts` — the gate (193 checks).
  - `docs/handoffs/STEP_160_COMPLETED.md` — this handoff.
- Modified:
  - `lib/payments/adapters/rainforest-payment.ts` (STEP 159's module, additive only): `performRainforestRequest` and `rainforestTransportAllowing(extraPaths)` factored out of the transport so an adapter's allowlist is the list it wrote down; `rainforestErrorMessageOf` exported for reuse; a session `purpose` (`payment` | `onboarding`) with `rainforestSessionPermissionOf`, so a payment session cannot ask for the onboarding group and vice versa; the audit action union gained the four new actions. No payment behaviour changed.
  - `lib/payments/adapters/rainforest-payment-verify.ts` — six checks for the session purpose table (the gate is now 446 checks).
  - `package.json` — added `check:payments-adapters-rainforest-merchant` and `check:payments-adapters-rainforest-webhook`, and both in the `verify` chain after `check:payments-adapters-rainforest-payment`, before `typecheck`.
  - `docs/final/PROVIDER_DOCS.md` — the Rainforest section gained a "Verified for STEP 160" block, the signature open question was rewritten to say what this STEP did instead of guessing, and four `Not run` sandbox rows were added.
- Owned paths touched (must match the File Ownership Rules in STEP_PLAN_250.md): `lib/payments/adapters/` (two adapter files with their gates — the two-concern shape STEPs 152/153 used for NMI), plus the two shared files an adapter STEP may change — `package.json` (two gate entries) and `docs/final/PROVIDER_DOCS.md` (the Rainforest section only). No migration, no `app/` route, no component, no `lib/env` change, no `services/` change, and no other STEP's file edited.

## Database

- Migrations added (file names): none. This STEP needs two records, both caller-stored values with reference in-memory implementations of the invariants the real tables must enforce:
  - `RainforestMerchantProvisionStore` — one row per company, an immutable company and id, a version guard, forward-only outcomes (`pending` → `created` | `rejected` | `unknown`, `unknown`/`rejected` → `pending` only while no provider merchant id exists, `created` final), a `created` row must carry a provider merchant id, and a row carrying one is final.
  - `RainforestWebhookDeliveryStore` — one row per `(resource id, event type)`, a SHA-256 `payloadHash` instead of the body, `received` → `processed` | `failed` with `processed` and `failed` final, version-guarded.
- Rollback verified on clean database (yes/no, how): not applicable — no migration was added or changed.

## Environment

- Environment variables added to .env.example: none. The webhook signing key is supplied by the caller (the portal value, read where the route is wired), never by this adapter; `createRainforestHmacWebhookVerifier` takes it as an argument and holds it in a closure.
- Secrets handled (names only, never values): the Rainforest API key (opened for one call, never stored or audited — unchanged from STEP 158/159), the onboarding **session key** (returned to the browser, never stored or audited), and the **webhook signing key** (never stored, audited or echoed; the audit trail and the delivery row are asserted to carry neither the key nor the signature nor the body). No tax identifier, SSN, owner record, bank account number, routing number or card number is an input, an output, a stored field or a log line anywhere in these two files.

## Packages

- Package requests for the integrator (name, reason), or none: none. `node:crypto`'s `createHash`, `createHmac` and `timingSafeEqual` are the only direct imports beyond the repository's own modules.

## Behaviour Proof (acceptance checklist)

The two halves the STEP title names were exercised. `npm run check:payments-adapters-rainforest-merchant` runs 260 checks and `npm run check:payments-adapters-rainforest-webhook` runs 193; both pass.

1. **A merchant is created once, from documented non-sensitive fields only.** A minimal profile builds twelve documented keys and no other; the gate asserts the body and the billing contact carry no `tax_id`, `tax_id_last_4`, `encrypted_tax_id`, `owner_1..4`, `encrypted_ssn`, `ssn_last_4`, `dob`, `deposit_routes`, `deposit_method_id`, `account_number`, `routing_number`, `iban`, `card_number` or `cvv`. The answer table is exercised: `2XX` with a `sbx_mid_` id → `created` with the application id and both statuses recorded; `2XX` without an application id → `created` with `requiresReconciliation`; `2XX` without a merchant id or naming an application id as the merchant → `unknown`; `400`/`409`/`422` → `rejected` with the sanitised message (`<b>bad</b> input` → `bbad/b input`); `401`/`403` → `failed` naming the credential; `404`/`405`/`415`/`302` → `failed`; `408`/`425`/`429`/`500`/`503`/thrown → `unknown`. A second attempt answers `already_created` with **zero** provider calls, an in-flight attempt answers `in_flight` with zero calls, and a rejected attempt is reopened and retried on the same row (version 2 → 4).
2. **The onboarding component is scoped and complete.** `startRainforestOnboarding` creates one session with `group#merchant_onboarding_component` constrained to the merchant and the documented 86,400 second default, and answers `<rainforest-merchant-onboarding>` with `session-key`, `merchant-id`, `merchant-application-id` and `terms-and-conditions-url` plus the environment's merchant bundle. A company without a merchant answers `not_created` without a call; a merchant without an application id answers `failed` rather than showing half a contract; a plain-http terms URL is refused; a refused session fails the start with the session's reason. The session key appears in no audit entry.
3. **Nothing is trusted before the signature.** With no verifier configured, every delivery is refused `401` and nothing is stored; a tampered body, a signature from another key, a timestamp beyond ±300 s, a missing id/timestamp/signature header, a non-numeric timestamp and an empty body are each refused. A correctly signed delivery is accepted, and the scheme is exercised in base64 and hex, with and without the message id in the signed content, with a `whsec_` secret and with a plain UTF-8 secret.
4. **A delivery applies at most once, and only through a fresh read.** The first `payin.succeeded` delivery applies and reads the payin once at the documented endpoint; the same pair is then `duplicate` with no read, including a portal replay under a new message id. Every documented payin status maps (`PROCESSING`/`AUTHORIZED`/`IN_REVIEW` → pending, `FAILED`/`RETURNED`/`CANCELED` → failed, `SUCCEEDED` → succeeded), while an event claiming `SUCCEEDED` over a read that says `PROCESSING` is `pending`, and a read reporting another amount, an undocumented status, a `404`, an unreachable API or a payin the platform does not know are all `unknown` with the reason recorded. `merchant_application.*` maps seven statuses and `merchant.*` six, with unpublished values `unknown`; a `deposit.*` or `message.attempt.exhausted` delivery is acknowledged and ignored.

## Verification

- `npx tsc --noEmit`: clean.
- `npx eslint lib/payments/adapters/rainforest-*.ts`: clean.
- `node lib/payments/adapters/rainforest-merchant-verify.ts`: `payments Rainforest merchant gate passed: 260 checks (…)`.
- `node lib/payments/adapters/rainforest-webhook-verify.ts`: `payments Rainforest webhook gate passed: 193 checks (…)`.
- `node lib/payments/adapters/rainforest-payment-verify.ts`: `payments Rainforest payment gate passed: 446 checks (…)` — the STEP 159 module still passes after the additive changes.
- `npm run verify`: passed the whole chain, including `check:payments-adapters-rainforest` 365, `-rainforest-client` 215, `-rainforest-payment` 446, `-rainforest-merchant` 260, `-rainforest-webhook` 193, then typecheck, lint and build.
- Behaviours exercised without a provider: everything above, against recording transports and self-signed deliveries. **No call reached Rainforest and no real signature was verified**: no sandbox account, API key or portal signing key exists in this environment, and the four new `Not run` rows say so.

## Next

- Next STEP number: STEP 161 — Stripe Connect documentation verification and sandbox notes recording.
- Anything the next chat must know:
  - **The Rainforest webhook signature scheme is still unread.** The "Verify Webhooks" recipe answers *page not found* at every URL tried here. Do not assume the reference scheme is right in production: the receiver refuses every delivery until a verifier is configured, and `RAINFOREST_WEBHOOK_SIGNATURE_CONFIRMED` is `false` for a reason. The first session that has a portal signing key must read the recipe, correct `RAINFOREST_WEBHOOK_REFERENCE_SCHEME` if needed (header names, signed content, encoding, version prefix), and only then enable the endpoint.
  - Reuse, do not reimplement: `provisionRainforestMerchant`, `startRainforestOnboarding`, `rainforestOnboardingComponentFor`, `rainforestOnboardingStateOf`, `receiveRainforestWebhook`, `rainforestWebhookResponseOf`, `createRainforestHmacWebhookVerifier`, `refuseRainforestWebhookVerifier`, `rainforestPayloadHashOf`, and STEP 159's `readRainforestPayin`, `createRainforestSession` (now with `purpose: "onboarding"`), `rainforestTransportAllowing`, `rainforestErrorMessageOf`.
  - The route that mounts the receiver (STEP 183's work) must pass the **raw** body, not a re-serialised JSON object, must answer within the documented 15 seconds (`RAINFOREST_WEBHOOK_ACK_SECONDS`), and must mount `rainforestWebhookResponseOf` rather than inventing status codes: `401` for a signature failure, `400` for an unreadable envelope, `500` so Rainforest retries a delivery that could not be applied, and `200` — including for duplicates — for anything else.
  - The platform has one Rainforest merchant per company; a `created` provision is final. Do not create a second merchant to "fix" a wrong address — that is a new merchant *application*, which the documented merchant update flow owns, not this adapter.
  - The onboarding component needs the platform's terms URL (`terms-and-conditions-url`), and Rainforest's terms-of-service requirements must be reviewed with a Platform Success Manager before production.
  - No Rainforest credential exists here. Any live result must come from a session that has one, and the `Not run` rows in `PROVIDER_DOCS.md` are what must be updated then.
