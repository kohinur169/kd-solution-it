// path: docs/handoffs/STEP_161_COMPLETED.md
# STEP 161 — Stripe Connect documentation verification and sandbox notes recording

**Status: COMPLETED**

## STEP

- Number and title: STEP 161 — Stripe Connect documentation verification and sandbox notes recording.
- Category: Five Payment Provider Adapters (NMI, Payoneer, Rainforest, Stripe Connect, Airwallex), STEP 147-169. Stripe's first STEP: the documentation is read and the sandbox notes recorded here, the sealed key configuration and connection test are STEP 162, onboarding and payment acceptance 163-166, and the sandbox cycle and capability matrix 167-169.
- Depends on (earlier STEPs in this category and their handoff files): STEP 157 (`lib/payments/adapters/rainforest.ts` — the record-module shape this STEP mirrors: documentation sources on the provider's own host, recorded rules, open questions, status vocabularies, a five-step sandbox cycle, `calculate*Status`, `record*Verification`, `*_SESSION_CHECKS`/`_SANDBOX_NOTES`/`_STATUS`), STEP 154 (`payoneer.ts` — the second instance of the same shape), STEP 160 (`rainforest-webhook.ts` — the signature-verification discipline, which here becomes a fully documented scheme instead of a refusal), and `lib/utils/freeze.ts` for `deepFreeze`.

## Files

- Created:
  - `lib/payments/adapters/stripe.ts` — the Stripe Connect documentation record. Holds `STRIPE_PROVIDER_KEY`/`_NAME`, the documented API base and version header, the id prefixes, the seven documented key prefixes with `stripeEnvironmentOfApiKey` and the key-shape predicates, the eleven `STRIPE_DOCUMENTATION_SOURCES` on `docs.stripe.com`, `STRIPE_DOCUMENTATION_HOSTS` and `isStripeDocumentationUrl` (which reads the host literally, so a lookalike is refused), fifteen `STRIPE_RECORDED_RULES`, five `STRIPE_OPEN_QUESTIONS`, the capability status vocabulary with `stripeCapabilityAllowsActions` (only `active` allows, an unrecorded value is `null`), the requirement fields with `stripeOnboardingStateOf` (`ready`/`waiting`/`blocked`), the three charge types with `STRIPE_CHARGE_TYPE_FACTS` (funds path, merchant of record, losses, application fee), the recorded event types with `parseStripeEventType`, the five-step `STRIPE_SANDBOX_CYCLE`, `sanitizeStripeText`, `carriesStripeKeyShapedText`, the record/store/validation types, `calculateStripeStatus`, `recordStripeVerification` with an audit entry, and the session review.
  - **The documented signature verifier** in the same file: `parseStripeSignatureHeader` (reads `t`, keeps every `v1`, drops `v0` and unknown schemes, refuses a duplicated `t`, a malformed or upper-case signature), `stripeSignedPayload`, and `verifyStripeWebhookSignature` — HMAC-SHA256 over `<t>.<rawBody>` with the endpoint's `whsec_` secret, constant-time comparison, then a tolerance check that refuses `0`. Refusals carry a reason and never the secret.
  - `lib/payments/adapters/stripe-verify.ts` — the gate (360 checks, fifteen sections).
  - `docs/handoffs/STEP_161_COMPLETED.md` — this handoff.
- Modified:
  - `package.json` — added `check:payments-adapters-stripe` and spliced it into the `verify` chain after `check:payments-adapters-rainforest-webhook`, before `typecheck`.
  - `docs/final/PROVIDER_DOCS.md` — a new `## Stripe Connect (STEP 161)` section (Stripe had no section): documentation sources table, recorded rules, a "Verified for STEP 161" block, open questions, five `Not run` sandbox rows, and the capability matrix.
- Owned paths touched (must match the File Ownership Rules in STEP_PLAN_250.md): `lib/payments/adapters/` (one adapter file with its gate — the STEP 157 shape), plus the two shared files an adapter STEP may change — `package.json` (one gate entry) and `docs/final/PROVIDER_DOCS.md` (the new Stripe section only). No migration, no `app/` route, no component, no `lib/env` change, no `services/` change, and no other STEP's file edited.

## Database

None. This STEP records documentation; it writes no table, adds no migration and needs no rollback proof. The verification record lives behind the `StripeVerificationStore` interface with an in-memory reference implementation, exactly as STEPs 154 and 157 did, so the STEP that needs persistence adds its table and its rollback with the behaviour that needs it.

## Environment

None. No new variable is read: this STEP never calls Stripe. `STRIPE_KEY_PREFIXES`, `STRIPE_WEBHOOK_SECRET_PREFIX` and the key-shape predicates exist so STEP 162 can validate what a variable holds before it seals it with `lib/security/encryption.ts`; the variables themselves (`STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`) are STEP 162's to add, with its `.env.example` regeneration.

## Packages

None. The verifier uses `node:crypto` (`createHmac`, `timingSafeEqual`) and `node:crypto`'s `randomUUID` — standard library only, no Stripe SDK and no new dependency. The adapter deliberately keeps its transport hand-rolled so STEP 162 can point it at a recording transport, as every other adapter in this set does.

## Behaviour Proof (acceptance checklist)

- **Documentation read from the provider's own host** — eleven pages on `docs.stripe.com`, covering the Connect overview, Accounts v2, the legacy account types, capabilities, charge types, keys, webhooks and their signature scheme, account updates and requirements, and Connect testing. The gate asserts every source URL's host, that no topic or URL repeats, that every source states what it established, and that a page on another host is refused by both the URL check and the record validator.
- **The rule the pages changed is recorded as a rule** — new connected accounts use Accounts v2 configurations or Accounts v1 with controller properties; Standard, Express and Custom are legacy for new platforms and an account's type is immutable. The gate asserts the rule text and asserts the sources include both the v2 page and the legacy page.
- **The signature scheme is implemented, not assumed** — a fresh correct delivery is accepted and its timestamp reported; a delivery signed with another secret, a body changed by one byte, a timestamp 400 seconds old, a timestamp 400 seconds in the future, a `v0`-only delivery, a missing header, an empty body, a missing secret and an oversized body are all refused; a delivery 299 seconds old is accepted; a narrowed tolerance is honoured; a tolerance of `0` is refused rather than disabling the recency check; and a delivery carrying two `v1` signatures during a secret roll still verifies. Every refusal carries a reason and no verdict repeats the secret.
- **The vocabularies map to consequences, not strings** — only `active` allows a capability's action and an unrecorded status is `null`, never permission; `past_due` or a `disabled_reason` is `blocked`, anything due or in review is `waiting`, and only a clean hash is `ready`; each charge type names where funds land, who is merchant of record, whose balance absorbs losses and whether an application fee applies.
- **The status cannot be inflated** — pages verified with no step run is `partial`; four of five steps is `partial`; steps with no page read is `partial`; pages verified with every step failing is `partial`; nothing at all is `not_verified`; `verified` requires every page verified and all five cycle steps passed. A recording refuses a page outside the documentation host, a note carrying a key or signing secret, a repeated step, a run note with no detail, and a verifier name carrying markup; a recorded note is sanitized on the way in.
- **The record is stored and audited** — a recording reaches the store, `findLatest` returns the newest by time, a duplicate id is refused, and exactly one `provider_verification.recorded` audit entry is written carrying the calculated status, so a screen cannot show a status the record does not hold.
- **This session's review is `partial` by construction** — every page is verified as documentation, all five cycle steps are `not_tested` with the reason (`No Stripe account, sandbox key or webhook signing secret exists in this environment`), `STRIPE_SESSION_STATUS` is `partial`, and the gate asserts that the session record, and the audit entry it writes, both say `partial`.
- **UI** — not applicable: this STEP has no screen, so no desktop or mobile width was checked. The sandbox cycle and the capability matrix are 167-169's, and the screens that show them are STEP 183's.
- **Security** — no credential is read, written or transmitted by this STEP. The record refuses any text carrying a key-shaped value, `sanitizeStripeText` strips markup and control characters before storing, the verifier compares in constant time, and the documentation host is matched literally so `docs.stripe.com.evil.example` and `http://` variants are refused.

## Verification

- `npx tsc --noEmit` — clean.
- `npx eslint lib/payments/adapters/stripe.ts lib/payments/adapters/stripe-verify.ts` — clean (no `import type` or `exactOptionalPropertyTypes` findings; the optional-property rules are respected by omission).
- `node lib/payments/adapters/stripe-verify.ts` and `node --experimental-strip-types lib/payments/adapters/stripe-verify.ts` — both pass. The verdict line:

  `payments Stripe Connect documentation gate passed: 360 checks (sources on Stripe's own host, the documented Accounts v2 rule, the published Stripe-Signature scheme verified and refused, the capability and requirement vocabularies, the charge-type facts, the five step sandbox cycle, the honest partial status, and a record that cannot be inflated to verified)`

- `npm run verify` — green end to end (every earlier gate, then `check:payments-adapters-stripe`, `typecheck`, `lint`, `build`, ending `✓ Compiled successfully`).
- No network call was made by any of the above, and no credential was used.

## Next

- STEP 162 — Stripe Connect key configuration and connection test: seal `STRIPE_SECRET_KEY` (and the publishable key, which is the only key a browser may hold) with `lib/security/encryption.ts`, bind the configuration to the company and provider, test the connection with `GET /v1/accounts` against a recording transport, activate only after a passing test, and record the API version and account surface the open questions left to it.
- STEP 163 onwards — the charge type decision (destination charges are the fit for "merchant accepts, platform pays out"), connected account creation through the chosen surface, hosted onboarding through `POST /v1/account_links`, then the sandbox cycle and capability matrix, which are the first STEPs that can move `STRIPE_SESSION_STATUS` off `partial`.
