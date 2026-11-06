// path: docs/handoffs/STEP_157_COMPLETED.md
# STEP 157 — Rainforest documentation verification and sandbox notes recording

**Status: COMPLETED**

## STEP

- Number and title: STEP 157 — Rainforest documentation verification and sandbox notes recording.
- Category: Five Payment Provider Adapters (NMI, Payoneer, Rainforest, Stripe Connect, Airwallex), STEP 147-169. This is Rainforest's first STEP: 158-160 build the key store, the payment acceptance and the sub-merchant onboarding.
- Depends on (earlier STEPs in this category and their handoff files): STEP 147 (the category's first adapter, which created `docs/final/PROVIDER_DOCS.md` and set the `<provider>.ts` plus `<provider>-verify.ts` shape), STEP 154 (the Payoneer documentation record this STEP mirrors, including its strict status rule), and STEP 156 (the handoff immediately before this one, which named STEP 157 as the next step). The provider row this record describes already exists in `lib/gateways/registry.ts` (`acceptance: true, payouts: false, submerchant: true`) and in `migrations/0094_seed_payment_providers.sql`; neither was edited.

## Files

- Created:
  - `lib/payments/adapters/rainforest.ts` — the Rainforest adapter's documentation verification and sandbox notes service: the fifteen documentation sources read in this session, the recorded rules, the open questions, the documented status vocabularies with their mapping functions, the event-type parser, the five step sandbox cycle, the sanitised validation of every check and note, the record, the recording function, and a reference store.
  - `lib/payments/adapters/rainforest-verify.ts` — the gate (365 checks).
  - `docs/handoffs/STEP_157_COMPLETED.md` — this handoff.
- Modified:
  - `package.json` — added the `check:payments-adapters-rainforest` script and its place in the `verify` chain, after `check:payments-adapters-payoneer-payout`.
  - `docs/final/PROVIDER_DOCS.md` — the new Rainforest section: the fifteen documentation sources with what each established, the recorded rules, the open questions, the five `Not run` sandbox notes and the capability matrix. No other provider's text was edited.
- Owned paths touched (must match the File Ownership Rules in STEP_PLAN_250.md): "Adapter STEPs 147-169 own exactly one file each under `lib/payments/adapters/` plus their provider components"; this STEP adds `rainforest.ts` and its gate in that directory — the same pair STEPs 147-156 each added — plus the two shared files an adapter STEP may change, `package.json` (one gate entry) and `docs/final/PROVIDER_DOCS.md` (a new provider section). No migration, no `app/` route, no component, no `services/` change, no `lib/env` change, and no other STEP's file edited.

## Database

- Migrations added (file names): none. This STEP owns no table: the verification record is a value the caller stores, and the shipped `InMemoryRainforestVerificationStore` is a reference implementation, not a schema.
- Rollback verified on clean database (yes/no, how): not applicable — no migration was added or changed; reverting the two source files and the two documentation entries removes this STEP entirely.

## Environment

- Environment variables added to .env.example: none. The module reads no environment variable and performs no network call; the store, the clock and the audit writer are passed in by the caller.
- Secrets handled (names only, never values): none used. This STEP records no credential, and both the validator and the gate enforce it: a note or a sandbox detail carrying a value with the documented key shape (`apikey_` / `sbx_apikey_` plus twenty or more characters) is refused, and the recorded session review is scanned for `Bearer <credential>`, `Authorization:`, `apikey_…` and `sbx_apikey_…` before the gate passes.

## Packages

- Package requests for the integrator (name, reason), or none: none. `node:crypto`'s `randomUUID` and the repository's own `deepFreeze` are the only imports.

## Behaviour Proof (acceptance checklist)

Both behaviours in the STEP title were exercised end to end. `npm run check:payments-adapters-rainforest` runs all 365 checks and passes.

**Documentation verification**

- Fifteen pages were read in this session, all on Rainforest's own documentation host `docs.rainforestpay.com` (found through its agent index `https://docs.rainforestpay.com/llms.txt`), and each is recorded with its topic and what it established. The gate asserts every source is on the allowlisted host, is https, is unique, and that the pages that matter are present: authentication, API keys, moving to production, API version upgrades, payins via API, onboarding via API, understanding payins, the payin / merchant / merchant application webhook pages, the webhook overview, the at-least-once page, the sandbox test data and going live.
- What those pages state is recorded as nineteen rules, and the gate asserts each recorded fact is really in them: the two API bases under `/v1`, the `apikey_` / `sbx_apikey_` key prefixes and the `sbx_` id prefix, the `Rainforest-Api-Version` header and the current version `2024-10-16`, the statement/group/constraint permission model, the two-call payin flow and its `method_type` values, minor-unit amounts and USD-only currency, the RSA-OAEP-SHA256 ACH encryption, the explicit Rainforest approval the direct API integration needs, the T+1 and T+4 deposit timing, the three status vocabularies and their event names, the API onboarding sequence and its `deposit_routes`, the per-endpoint signing keys, the four source addresses, the retry schedule, `message.attempt.exhausted`, and the at-least-once/idempotency duty.
- Four open questions are recorded rather than assumed, and the gate asserts all four: the **webhook signature scheme is not verified** (the Webhooks page points to a "Verify webhooks" recipe that answers *not found* at both `/recipes/verify-webhooks-1` and `/recipes/verify-webhooks` here, so the header names, signed content, digest and tolerance must be read before STEP 160 implements verification), the **direct-to-API approval is not public**, the **platform minimum API version is a portal setting** (so STEP 158 must send the header explicitly), and **no sandbox account exists in this environment**.
- The documented verdicts are encoded rather than improvised: `rainforestPayinOutcomeOf` makes `SUCCEEDED` the only success, `FAILED` / `RETURNED` / `CANCELED` failures and every other documented status pending; `rainforestMerchantBehaviourOf` makes `ACTIVE` the only status that processes; `rainforestApplicationOutcomeOf` makes `COMPLETED` the approval and `DECLINED` the refusal. Every one of them returns `null` for a value the pages do not publish, and the gate proves that with another provider's status words (`SETTLED`, `ALLOWED`, `APPROVED`) and with empty strings.
- `parseRainforestEventType` parses the documented `{resource}.{status}` envelope, keeps `message.attempt.exhausted` as the `message` resource with the `attempt.exhausted` status, refuses an undocumented resource such as `transfer.created`, and `rainforestPayinOutcomeOfEvent` maps a payin event to the same outcome the status table gives.

**Sandbox notes recording, and the honesty rule**

- The cycle an acceptance and sub-merchant provider must complete is fixed at five steps: authenticate a sandbox key (`GET /v1/api_keys`), onboard a merchant to `ACTIVE` (`POST /v1/merchants`), create a payin config (`POST /v1/payin_configs`), process a card payin with a documented sandbox test card through to `SUCCEEDED` (`POST /v1/payins`), and receive and verify a signed webhook delivery. The gate asserts the order, the methods and the documented paths.
- This session's notes record all five as `not_tested`, each with the reason in its own words: no Rainforest sandbox account or API key exists in this environment, because the sandbox keys are created in the Sandbox Platform Portal. The gate asserts that no session step claims a pass, that every unrun step carries both the "has not been run" statement and the missing-credential reason, and that the recorded review reads `partial`.
- The status rule is strict on purpose: `verified` requires a verified documentation check, every check verified, at least one sandbox note, every note passed, **and** all five cycle steps present and passed. The gate proves that an unverified page, an empty note set, a missing step, an unrun step and a failed step each drop the record to `partial`, that notes which all failed are still `partial` while the pages were verified, and that the two all-negative shapes drop to `not_verified`.
- The caller cannot inflate a status: `recordRainforestVerification` takes no status field and always calculates it, which the gate proves by recording an honest partial review and reading `partial` back, and by recording a complete review and reading `verified`.
- Refusals before anything is stored: no documentation check, a missing or malformed verifier (including markup), a check on any host that is not `docs.rainforestpay.com` (including look-alikes such as `rainforestpay.evil.example`, the marketing host `www.rainforestpay.com` and another provider's `docs.nmi.com` page), an undocumented cycle step, a duplicated step, an unrun or failed step with no reason, and a note that carries an API-key-shaped value. Every refusal leaves the store unchanged, which the gate asserts by counting the records afterwards. Every message that reaches a record passes `sanitizeRainforestText`, which strips markup and control characters and caps the text at 500 characters.

**API checks (success, validation failure, unauthorized, cross-tenant)**: not applicable as HTTP checks — this STEP adds no route and makes no call.

**UI checks (desktop, mobile, keyboard, light and dark)**: not applicable — this STEP ships no screen.

**Money flow ledger proof (balanced debit and credit)**: not applicable — no money moves in a documentation record.

**Provider sandbox cycle and documentation URLs**: **not run, and stated plainly.** There is no Rainforest sandbox account, no API key and no registered callback endpoint in this environment, so no key was authenticated, no merchant was onboarded, no payin was processed and no webhook was delivered or verified. `docs/final/PROVIDER_DOCS.md` carries the five `Not run` rows with the reason. Documentation URLs read in this session (all Rainforest's own):

- https://docs.rainforestpay.com/llms.txt
- https://docs.rainforestpay.com/docs/overview.md
- https://docs.rainforestpay.com/docs/api-keys.md
- https://docs.rainforestpay.com/reference/authentication.md
- https://docs.rainforestpay.com/docs/moving-to-production.md
- https://docs.rainforestpay.com/docs/api-version-upgrades.md
- https://docs.rainforestpay.com/docs/process-payins-via-api.md
- https://docs.rainforestpay.com/docs/onboarding-merchants-via-api.md
- https://docs.rainforestpay.com/docs/understanding-payins.md
- https://docs.rainforestpay.com/docs/payin-webhooks.md
- https://docs.rainforestpay.com/docs/merchant-webhooks.md
- https://docs.rainforestpay.com/docs/merchant-application-webhooks.md
- https://docs.rainforestpay.com/docs/webhooks-and-notifications.md
- https://docs.rainforestpay.com/docs/on-premises-webhook-integration.md
- https://docs.rainforestpay.com/docs/test-accounts-and-cards.md
- https://docs.rainforestpay.com/docs/going-live.md

Sandbox endpoints recorded for the later steps: `https://api.sandbox.rainforestpay.com/v1` (production `https://api.rainforestpay.com/v1`), with sandbox keys prefixed `sbx_apikey_` and sandbox ids prefixed `sbx_`. The Sandbox Platform Portal is `https://platform.sandbox.rainforestpay.com`. Sandbox result: **none**, stated plainly.

## Verification

- Typecheck result: `npx tsc --noEmit` — exit 0, no diagnostics.
- Lint result: `npx eslint .` — exit 0.
- Build result for the touched area: `npm run verify` — exit 0 (`check:audit`, `check:structure`, every earlier gate, then `check:payments-adapters-rainforest` with 365 checks, then `typecheck`, `lint` and `build`).
- No test file was added (MASTER_PROMPT rule 4); no `TODO`, `FIXME` or placeholder text; no `console.log`, no `any`, no `process.env` read in either file.

## Next

- Next STEP number: STEP 158 — Rainforest encrypted key configuration and connection test.
- Anything the next chat must know:
  - Reuse, do not re-implement: `sanitizeRainforestText`, `isRainforestDocumentationUrl`, `rainforestDocumentationHostOf`, `rainforestApiBaseFor`, `rainforestApiUrlFor`, `rainforestApiKeyPrefixFor`, `rainforestEnvironmentOfApiKey`, `isRainforestApiKeyShaped`, `isRainforestSandboxId`, `RAINFOREST_SANDBOX_API_BASE`, `RAINFOREST_PRODUCTION_API_BASE`, `RAINFOREST_API_VERSION`, `RAINFOREST_API_VERSION_HEADER`, `RAINFOREST_WEBHOOK_*`, the three status vocabularies with their mapping functions, `parseRainforestEventType`, `rainforestPayinOutcomeOfEvent`, `RAINFOREST_SANDBOX_CYCLE`, `calculateRainforestStatus`, `recordRainforestVerification`.
  - The connection test reads the key list (`GET /v1/api_keys`) with the sealed key and must **send the `Rainforest-Api-Version` header explicitly**; the platform minimum version is a portal setting the documentation does not expose.
  - The key is a bearer credential: seal it with the platform's single encryption module under a `gateway:<companyId>:rainforest:<field>` scope, never log it, never return it, and store only its environment plus last characters.
  - Do not claim a verified Rainforest integration: the record is `partial` until somebody with sandbox credentials runs all five cycle steps, and `calculateRainforestStatus` refuses to say `verified` until then.
  - The webhook signature scheme is still unread (the "Verify webhooks" recipe is not published at a readable URL here). STEP 160 must read it before implementing verification; until then no Rainforest signature may be trusted, and every delivery must be refused rather than applied.
  - The platform never handles a raw card number or a raw bank account number: the pages state that the direct-to-API integration needs Rainforest approval, and the components exist so sensitive data stays out of this platform's servers. Any acceptance work in STEP 159 uses the component/session path, not raw PAN data.
  - No Rainforest credential exists here. Any live result must come from a session that has one, and the `Not run` rows in `PROVIDER_DOCS.md` are what must be updated then.
