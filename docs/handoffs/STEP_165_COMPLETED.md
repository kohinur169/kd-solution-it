// path: docs/handoffs/STEP_165_COMPLETED.md
# STEP 165 — Airwallex documentation verification and sandbox notes recording

**Status: COMPLETED**

## STEP

- Number and title: STEP 165 — Airwallex documentation verification and sandbox notes recording.
- Category: Five Payment Provider Adapters (NMI, Payoneer, Rainforest, Stripe Connect, Airwallex), STEP 147-169. Airwallex's first STEP: the documentation is read and the sandbox notes recorded here, 166 seals the key and proves it, 167 creates the connected account and syncs verification, 168 takes payments, and 169 closes the payouts, the webhooks and the capability matrix.
- Depends on (earlier STEPs in this category and their handoff files): STEP 161 (`lib/payments/adapters/stripe.ts` — the record shape this STEP mirrors: sources on the provider's own host, recorded rules, open questions, status vocabularies, a five-step sandbox cycle, `calculate*Status`, `record*Verification`, session checks, `sanitize*Text`), STEP 154 (`payoneer.ts`) and STEP 157 (`rainforest.ts`) for the same shape, STEP 160 (`rainforest-webhook.ts` — the signature-verification discipline this STEP turns into Airwallex's documented `x-timestamp` + `x-signature` scheme), STEP 127 (`money.ts` — `MONEY_SCALE`, which is what the major-unit conversion divides by), and `lib/utils/freeze.ts`.

## Files

- Created:
  - `lib/payments/adapters/airwallex.ts` — the Airwallex documentation record. Holds the two documented hosts plus the refused lookalikes (`AIRWALLEX_PRODUCTION_BASE`, `AIRWALLEX_SANDBOX_BASE`, the two file hosts, `AIRWALLEX_API_PREFIX`, `AIRWALLEX_REFUSED_HOSTS`, `airwallexEnvironmentOfBase`, `isAirwallexApiBase`), the twelve documented endpoints (`AIRWALLEX_ENDPOINTS`), the eleven `AIRWALLEX_DOCUMENTATION_SOURCES` with `AIRWALLEX_DOCUMENTATION_HOSTS`/`AIRWALLEX_REFERENCE_HOSTS` and `isAirwallexDocumentationUrl`, sixteen `AIRWALLEX_RECORDED_RULES`, seven `AIRWALLEX_OPEN_QUESTIONS`, the credential bounds with `validateAirwallexCredentials`, the date-version vocabulary (`AIRWALLEX_API_VERSION_PATTERN`, `AIRWALLEX_OBSERVED_API_VERSIONS`, `AIRWALLEX_DEFAULT_API_VERSION`, `isAirwallexApiVersion`), the token constants with `airwallexTokenExpiryMs`/`airwallexTokenNeedsRefresh`, the exact major-unit conversion (`AIRWALLEX_CURRENCY_MINOR_UNITS`, `airwallexAmountFromPlatformMinor`, `airwallexPlatformMinorFromAmount`), the payment vocabularies with `airwallexPaymentOutcomeOf`/`airwallexPaymentAttemptOutcomeOf`/`airwallexIntentHasFailureStatus`, the transfer vocabulary with `airwallexTransferOutcomeOf`/`airwallexTransferCanStillFail`, the connected-account record (`AIRWALLEX_ACCOUNT_ID_PATTERN`, `AIRWALLEX_ACCOUNT_STATUSES`, `airwallexOnboardingStateOf`, `airwallexAccountIdCollidesWithStripe`, `validateAirwallexAccountRequest`, `buildAirwallexConnectedAccountBody`), the PaymentIntent request with `buildAirwallexPaymentIntentBody` and `airwallexRequestIdFor`, the implemented signature verifier `verifyAirwallexWebhookSignature`, the event reader `parseAirwallexEvent` with `AIRWALLEX_EVENT_NAMES`, the five-step `AIRWALLEX_SANDBOX_CYCLE` with `AIRWALLEX_SANDBOX_LIMITS`, `calculateAirwallexStatus`, `recordAirwallexVerification` with its audit entry, `AIRWALLEX_SESSION_CHECKS`, `AIRWALLEX_CAPABILITY_MATRIX` and `sanitizeAirwallexText`.
  - `lib/payments/adapters/airwallex-verify.ts` — the gate (495 checks, sixteen sections).
  - `docs/handoffs/STEP_165_COMPLETED.md` — this handoff.
- Modified:
  - `package.json` — added `check:payments-adapters-airwallex` and spliced it into the `verify` chain after `check:payments-adapters-stripe-webhook`, before `typecheck`.
  - `docs/final/PROVIDER_DOCS.md` — a new `## Airwallex (STEP 165)` section (Airwallex had no section): the eleven documentation sources with the two recorded hosts and the two refused ones, the recorded rules, a "Verified for STEP 165" block, eight open questions, six `Not run` sandbox rows, and the capability matrix with its one documented gap.
- Owned paths touched (must match the File Ownership Rules in STEP_PLAN_250.md): `lib/payments/adapters/` (one adapter file with its gate — the STEP 154/157/161 shape), plus the two shared files an adapter STEP may change — `package.json` (one gate entry) and `docs/final/PROVIDER_DOCS.md` (the new Airwallex section only). No migration, no `app/` route, no component, no `lib/env` change, no `services/` change, and no other STEP's file edited.

## Database

None. This STEP records documentation; it writes no table, adds no migration and needs no rollback proof. The verification record lives behind the `AirwallexVerificationStore` interface with an in-memory reference implementation, exactly as STEPs 154, 157 and 161 did, so the STEP that needs persistence adds its table and its rollback with the behaviour that needs it.

## Environment

None read, none added. No new variable is read: this STEP never calls Airwallex. `AIRWALLEX_CLIENT_ID_PATTERN`, `AIRWALLEX_API_KEY_PATTERN`, the header names and `validateAirwallexCredentials` exist so STEP 166 can validate what a variable holds before sealing it with `lib/security/encryption.ts`; the variables themselves are STEP 166's to add, with its `.env.example` regeneration.

## Packages

None. `node:crypto` for the HMAC and the derived `request_id`, and `lib/utils/freeze.ts` — no Airwallex SDK, no new dependency.

## Behaviour Proof (acceptance checklist)

- **The sources are the pages, on the pages' hosts.** Eleven sources, each checked against `isAirwallexDocumentationUrl`, which accepts exactly `www.airwallex.com` and `github.com`, refuses plain HTTP, refuses a lookalike such as `www.airwallex.com.evil.example`, and refuses by name both `api-demo.airwallex.com` (named by a community specification, by no page) and `docs.airwallex.com` (a host people type, where no page lives).
- **The two API hosts are the only bases.** `airwallexEnvironmentOfBase` answers `live` for `https://api.airwallex.com`, `sandbox` for `https://api.sandbox.airwallex.com` (with or without a trailing slash) and `null` for the demo host, a lookalike and plain HTTP.
- **Credentials are validated honestly.** A good pair passes; a short client id, a client id with a space, a short API key, an undocumented base URL and a non-date version are each refused with their own reason; a JWT, a pasted `x-api-key` header, a `Bearer` value and a `client_secret` are recognised as key-shaped, and a plain client id or a business name is not.
- **Versions are dates and are pinned.** `2026-05-29` passes, `2026-5-9` and `v1` fail, the five observed versions are recorded, and the default is one of them.
- **The token rules are the page's.** The 30-minute lifetime and the 60-second skew are recorded; the documented `expires_at` shape `2021-06-18T16:30:00+0000` is read to the exact millisecond; a token 30 seconds before expiry is refreshed, one two minutes before is reused, an expired one is refreshed and an unreadable `expires_at` forces a refresh.
- **Money is converted exactly, in major units.** `1_000_000n → 100.00`, `99_900n → 9.99`, `10_000n → 1.00`, `100n → 0.01`; a fraction of a minor unit, a zero, a negative, an unsupported currency and an over-large amount are refused; the reverse conversion restores `99_900n` from `"9.99"` and from `9.99`, and refuses `"9.999"`, `"1e3"` and a negative.
- **Every status maps, and only one is paid.** Seven intent statuses with `SUCCEEDED` as the only `paid`, `PENDING`/`PENDING_REVIEW`/`REQUIRES_CAPTURE` as pending, the two customer-action statuses as such, `CANCELLED` as failed, `FAILED` recorded as a status Airwallex does not use (so it maps to `unknown`), and four documented attempt statuses.
- **Transfers carry their finality.** All eleven statuses map to an outcome, `PAID` is `paid` with `provisional: true`, `airwallexTransferCanStillFail("PAID")` is true, `SENT`/`OVERDUE`/the approval statuses are in flight, `FAILED` is failed, `CANCELLED` is cancelled and terminal, and `PAID` is deliberately **not** in the terminal list.
- **Connected accounts are the native-API page's.** The documented `acct_…` id, five statuses mapped to `ready`/`waiting`/`blocked` (an unrecorded status blocks rather than passes), an individual body carrying `legal_entity_type: INDIVIDUAL` and a business body carrying none because the business enum was not observed, both agreement flags required and sent as `true`, and an honest note that `acct_` is also Stripe's prefix.
- **The PaymentIntent body is the page's and carries no card data.** Major-unit `amount`, upper-case `currency`, `merchant_order_id`, `request_id`, optional `return_url`/`descriptor`/`metadata`, no card field and no client secret anywhere; the validators refuse a short or over-long request id, a blank or over-long merchant order id, a plain-HTTP return URL, an over-long descriptor, a bad metadata key and a credential in metadata; the derived request id is deterministic, 43 characters and differs per reference.
- **The webhook scheme is implemented, not summarised.** HMAC-SHA256 over `x-timestamp` as received plus the raw body, constant-time comparison, then a 300-second tolerance that is recorded as **this platform's choice** because the page names none; the verifier accepts a correct delivery at the boundary (`now + 299s`) and refuses a tampered body, another secret, `now + 301s`, a missing or malformed timestamp, a missing or upper-case or truncated signature, an empty body, an empty secret, a zero tolerance and an oversized delivery — and no refusal carries the secret, the signature or the body.
- **Events are read and nothing is invented.** The documented envelope fields, the ten payment intent, three payment attempt and eleven transfer event names, and **no** account event name, because that page was not read — recorded as an open question instead of guessed.
- **The sandbox gap is stated.** Five documented steps, six recorded limits including that the sandbox covers "all products … except Connected Account APIs", that testing them needs Airwallex Sales or the Simulation APIs, that `x-on-behalf-of` is how a platform calls for an account, that sandbox entity names must be "New Business Sandbox" or "Sandbox Business", and that sandbox files are deleted after 90 days.
- **The record cannot be inflated.** `calculateAirwallexStatus` says `not_run` for nothing and for a record whose only step did not run, `partial` for one verified step and for four of five, and `verified` only for all five verified; `recordAirwallexVerification` refuses an unknown step, a `verified` step with no evidence and an unusable version, writes one audit entry naming the derived status, and this session's `AIRWALLEX_SESSION_STATUS` is `partial`.
- **UI** — not applicable: this STEP adds no screen, so no desktop or mobile width was checked. The connected-account screen that will show the onboarding state is STEP 167's, and the payment page that consumes the client secret is STEP 183's.
- **Security** — credentials are validated before anything is sealed; a token or a pasted header is refused as a stored value; the documented webhook scheme is verified over the raw body before parsing, in constant time, with a tolerance that refuses `0`; the derived `request_id` carries no company name or invoice number in clear; and every record, refusal and audit entry is text-sanitised and bounded, with the pre-existing RLS and permission middleware untouched because this STEP adds no route, no job and no table.

## Verification

- `npm run typecheck` — clean.
- `npx eslint lib/payments/adapters/airwallex.ts lib/payments/adapters/airwallex-verify.ts` — clean.
- `node lib/payments/adapters/airwallex-verify.ts` and `node --experimental-strip-types lib/payments/adapters/airwallex-verify.ts` — both pass. The verdict line:

  `payments Airwallex documentation gate passed: 495 checks (the two documented hosts with the community demo host refused, credential bounds where no prefix exists, the major-unit amount conversion in both directions, every documented payment and transfer status mapped with PAID recorded as provisional, the t-and-body webhook signature with its refusals, the documented connected-account body, and a sandbox record that stays partial because the connected-account APIs are not in the sandbox)`

- `npm run verify` — green end to end (every earlier gate, then `check:payments-adapters-airwallex`, `typecheck`, `lint`, `build`, ending `✓ Compiled successfully`).
- No network call was made to Airwallex and no credential was used.

## Next

- STEP 166 — Airwallex encrypted key configuration and connection test: it consumes `validateAirwallexCredentials`, the header names, `AIRWALLEX_DEFAULT_API_VERSION` and `airwallexTokenNeedsRefresh`, and it must confirm the version question (`2026-05-29` versus `2026-08-21`) and store the **mode** beside the sealed credential, because no key prefix exists to infer it from.
- STEP 167 — connected account creation and verification sync: `buildAirwallexConnectedAccountBody`, `airwallexOnboardingStateOf` and the `CREATED`/`SUBMITTED`/`ACTIVE`/`ACTION_REQUIRED`/`SUSPENDED` status set; the account-status webhook names are still unread.
- STEP 168 — payment acceptance: `buildAirwallexPaymentIntentBody` with `airwallexRequestIdFor` as the documented `request_id`, and the client secret handed to the page once, never stored.
- STEP 169 — payouts, webhooks and the capability matrix: `verifyAirwallexWebhookSignature` over `x-timestamp` + raw body, `parseAirwallexEvent`, and `airwallexTransferCanStillFail`, which is what stops a payout being treated as final at `PAID`.
