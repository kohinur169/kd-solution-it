// path: docs/handoffs/STEP_158_COMPLETED.md
# STEP 158 — Rainforest encrypted key configuration and connection test

**Status: COMPLETED**

## STEP

- Number and title: STEP 158 — Rainforest encrypted key configuration and connection test.
- Category: Five Payment Provider Adapters (NMI, Payoneer, Rainforest, Stripe Connect, Airwallex), STEP 147-169. Rainforest's second STEP: 159 builds payment acceptance and 160 the sub-merchant onboarding with signature-verified webhooks.
- Depends on (earlier STEPs in this category and their handoff files): STEP 157 (the Rainforest documentation record — `lib/payments/adapters/rainforest.ts` and the Rainforest section of `docs/final/PROVIDER_DOCS.md` — whose documented bases, key prefixes, API version header and endpoint the test uses), STEP 155 (the Payoneer key-configuration service this STEP mirrors: same refusal order, same rotation procedure, same audit vocabulary), and the platform's canonical encryption module `lib/security/encryption.ts` (security STEPs 056-067), which is reused rather than reimplemented.

## Files

- Created:
  - `lib/payments/adapters/rainforest-client.ts` — the Rainforest key configuration service: validation that refuses an environment/key-prefix mismatch, sealing through the platform's encryption module with a company-and-provider bound scope, the masked view, the authenticated `GET /v1/api_keys` connection test over the documented API base with the `Rainforest-Api-Version` header, the transport, activation gated on a passing test, retirement, and the rotation procedure with audit entries.
  - `lib/payments/adapters/rainforest-client-verify.ts` — the gate (215 checks).
  - `docs/handoffs/STEP_158_COMPLETED.md` — this handoff.
- Modified:
  - `package.json` — added the `check:payments-adapters-rainforest-client` script and its place in the `verify` chain, after `check:payments-adapters-rainforest`.
  - `docs/final/PROVIDER_DOCS.md` — the Rainforest section gained a "Verified for STEP 158" block (the credential set, the sealed scope, the prefix rule, the masked view, the connection test and its full outcome table, the activation rule and the rotation order) and two `Not run` sandbox rows for the test and the activation.
- Owned paths touched (must match the File Ownership Rules in STEP_PLAN_250.md): `lib/payments/adapters/` (one adapter file plus its gate, the shape every adapter STEP in 147-169 uses), plus the two shared files an adapter STEP may change — `package.json` (one gate entry) and `docs/final/PROVIDER_DOCS.md` (the Rainforest section only). No migration, no `app/` route, no component, no `lib/env` change, no `services/` change, and no other STEP's file edited.

## Database

- Migrations added (file names): none. This STEP stores no new schema: the configuration is a value the caller stores, and the shipped `InMemoryRainforestConfigStore` is a reference implementation of the invariants the real table must enforce — one pending key per company, one active key per company, an immutable company/environment/id/sealed key, a strictly increasing `version` for optimistic locking, and activation refused unless a `connected` test is recorded on that key for its own environment.
- Rollback verified on clean database (yes/no, how): not applicable — no migration was added or changed.

## Environment

- Environment variables added to .env.example: none. The keyring is supplied by the caller, which reads it from the environment at boot as `lib/security/encryption.ts` requires; this file reads no environment variable and caches no key.
- Secrets handled (names only, never values): the Rainforest API key (entered by an admin). It is never stored, logged, audited or returned in plaintext: the gate scans every result, every audit entry and every stored row for it (`JSON.stringify(...).includes(<fixture key>) === false`), and the only value the screen receives is the masked form.

## Packages

- Package requests for the integrator (name, reason), or none: none. `node:crypto`'s `randomUUID` is the only direct import beyond the repository's own modules; the cipher and the keyring belong to `lib/security/encryption.ts`.

## Behaviour Proof (acceptance checklist)

The two behaviours in the STEP title, plus the rotation procedure section 29 requires, were exercised. `npm run check:payments-adapters-rainforest-client` runs all 215 checks and passes.

**Encrypted key configuration**

- A valid key is stored sealed through `lib/security/encryption.ts` as a `kd1.<keyId>.<iv>.<tag>.<ciphertext>` envelope; the gate asserts the envelope prefix, that the plaintext never appears in the envelope, and that `rainforestConfigIsSealed` recognises it (and refuses a plaintext value, a truncated envelope and an empty one).
- The sealing scope is `gateway:<companyId>:rainforest:api_key`, and the gate proves the binding by opening a stored value under a foreign keyring, under another company's scope and under another provider's scope (`gateway:company:payoneer:client_secret`) — each fails instead of returning a secret. A keyring rotation (`{primary: k2, previous: [k1]}`) still opens what `k1` wrote, and a fresh envelope written under one scope does not open under a foreign scope.
- The masked view shows the documented prefix and only the last four characters, with the stars capped at twelve; anything four characters or shorter is hidden entirely, and a stored key's view is built by opening and immediately masking, so the screen never receives a full credential. A configuration whose envelope no longer opens is reported as unreadable rather than shown blank.
- Refusals before anything is sealed or stored: an invalid company id, an unknown environment, a key outside the documented `apikey_` / `sbx_apikey_` shape (no prefix, too short, a newline, over-long), a **production key in a sandbox configuration**, a **sandbox key in a production configuration**, a second key waiting for a test, and an unusable keyring (`the encryption keyring cannot seal a credential` — the reason names the keyring, never the key). A refused input stores nothing and audits nothing.
- Every configuration step writes an audit entry: `provider_key.configured`, `provider_key.tested`, `provider_key.activated`, `provider_key.rotated`, `provider_key.retired`. The entries carry the provider key, company, configuration id, environment, the outcome and the instant — and no key.

**Connection test**

- The test performs the documented authenticated read `GET https://api.sandbox.rainforestpay.com/v1/api_keys` for a sandbox key and `GET https://api.rainforestpay.com/v1/api_keys` for a production key. The gate stubs the platform's `fetch` and asserts the URL, the `GET` method, the refusal of redirects, `Authorization: Bearer <key>`, `Accept: application/json` and the explicit `Rainforest-Api-Version: 2024-10-16` header. A key is never tested against the other environment's base.
- Outcomes, each exercised through the parser and through the service: a `2XX` with a parseable body is `connected` with `apiKeyAccepted: true`, `environmentVerified: true` (the environments are separate, so the accepted key belongs to that environment) and the count of keys listed (`keysVisible`, never the keys); `401` and `403` are `rejected` with the documented `errors` message sanitised; `400` is `failed`, not rejected, because the documented cause is a refused request (an API version below the platform minimum) and the key was never judged; `404`, `409`, `415`, `422` and a redirect are `failed`; `408`, `425`, `429` and any `5xx` are `unreachable`; a transport throw is `unreachable` and the reason never repeats the thrown text; a `2XX` with an empty, unparseable, `null` or scalar body is `failed`.
- The outcome is written back onto the key as `lastTest {outcome, testedAtEpochMs, environment}` with a version-guarded write, so activation reads a record rather than a caller's memory. The test result reports the API version it sent and carries no key, which the gate proves over the result, the audit entries and the stored row.
- The test makes exactly one call per run, opens the sealed key for that call, and reports `invalid_configuration` for an unknown id, a retired key and a keyring that cannot open the key.

**Activation and rotation (section 6 "a provider cannot be enabled when its connection test fails", section 29 rotation)**

- Activation refuses, in this order: an unknown id, a retired key, an already-active key, a superseded key, a key that is not waiting for activation, a key with no test (`the connection test has not been run for this key`), a key whose last test did not pass (`the last connection test did not pass, so this key cannot be activated`), and a key whose test ran against another environment. The reference store refuses `pending_activation → active` unless a `connected` test is recorded on that key, refuses a version jump, a stale expected version, a changed company, a changed environment, a replaced sealed value, and a second active key for the company — so the rule survives a caller that bypasses the service.
- The full rotation runs in the documented order: add the replacement key while the old key serves traffic → test the replacement → activate it (the old key becomes `superseded`, still readable during the window, and `provider_key.rotated` names it) → retire the old key once the switch is done. The gate asserts each step, both audit entries, that a superseded key cannot be activated again, that the active key cannot be retired, that a retired key cannot be tested or retired twice, and that retiring a pending key cancels an aborted rotation without touching the active key.
- A superseded key stays openable through the rotation window — proven by reading its masked view after the switch — which is what makes "add new key, run connection test, activate, then remove the old key" a deploy rather than a migration.

**API checks (success, validation failure, unauthorized, cross-tenant)**: no route was added in this STEP, so there are no HTTP checks. The service-level equivalents are the refusal list and the outcome table above; cross-tenant safety is proven by the scope binding (another company's envelope does not open) and by the store's company immutability.

**UI checks (desktop, mobile, keyboard, light and dark)**: not applicable — this STEP ships no screen. The masked view it returns is the contract the admin gateway screen will render, and it contains no full credential.

**Money flow ledger proof (balanced debit and credit)**: not applicable — no money moves in a key configuration or an authenticated read.

**Provider sandbox cycle and documentation URLs**: **the connection test was not run against Rainforest.** No sandbox account or API key exists in this environment, so the read was exercised against a recording transport only; the gate proves the request shape, not a live answer. `docs/final/PROVIDER_DOCS.md` carries the two new `Not run` rows. Documents that established the facts this STEP codes against were read in the STEP 157 session and are recorded there; this STEP re-used them unchanged:

  - https://docs.rainforestpay.com/reference/authentication.md — bearer authentication, the two key prefixes, and the documented sandbox call URL.
  - https://docs.rainforestpay.com/docs/moving-to-production.md — the two base URLs and the separation of sandbox and production keys.
  - https://docs.rainforestpay.com/docs/api-version-upgrades.md — the `Rainforest-Api-Version` header, the current version and the `400` a lower-than-minimum request receives.
  - https://docs.rainforestpay.com/docs/api-keys.md — what an API key is, and that it must never reach the browser.

Sandbox endpoints used by the implementation: `GET https://api.sandbox.rainforestpay.com/v1/api_keys` (production `https://api.rainforestpay.com/v1/api_keys`). Sandbox result: **none**, stated plainly.

## Verification

- Typecheck result: `npx tsc --noEmit` — exit 0, no diagnostics.
- Lint result: `npx eslint .` — exit 0.
- Build result for the touched area: `npm run verify` — exit 0 (`check:audit`, `check:structure`, every earlier gate, `check:payments-adapters-rainforest` with 365 checks, `check:payments-adapters-rainforest-client` with 215 checks, then `typecheck`, `lint` and `build`).
- No test file was added (MASTER_PROMPT rule 4); no `TODO`, `FIXME` or placeholder text; no `console.log`, no `any`, no `process.env` read in either file; no cipher is called in either file (both seal and open through `lib/security/encryption.ts`).

## Next

- Next STEP number: STEP 159 — Rainforest payment acceptance integration.
- Anything the next chat must know:
  - Reuse, do not reimplement: `configureRainforestKeys`, `testRainforestConnection`, `activateRainforestConfig`, `retireRainforestConfig`, `rainforestKeyViewOf`, `rainforestKeyListEndpointFor`, `parseRainforestKeyListAnswer`, `rainforestFetchApiTransport`, `rainforestApiKeyScope`, `maskRainforestCredential`, `rainforestConfigIsSealed`, and STEP 157's `rainforestApiBaseFor`, `rainforestApiUrlFor`, `RAINFOREST_API_VERSION`, `RAINFOREST_API_VERSION_HEADER`, the payin and event vocabularies.
  - The active configuration is the only one a payin may use: `findActiveByCompany`, never "the newest row". A key in `pending_activation`, `superseded` or `retired` must not be used to accept money.
  - Every API call must send the `Rainforest-Api-Version` header explicitly; the platform minimum is a portal setting the documentation does not expose.
  - No raw card number and no raw bank account number may reach this platform: the docs state the direct-to-API integration needs Rainforest approval and the components exist so sensitive data stays out. STEP 159 must build the component/session path (`component session` + hosted fields), not a PAN-handling endpoint, and must never log or store a card number.
  - The webhook signature scheme is still unread (the "Verify webhooks" recipe is not published at a readable URL here). STEP 160 must read it before implementing verification; until then no Rainforest signature may be trusted and every delivery must be refused rather than applied.
  - The connection test proves the key and the environment, nothing more. It does not prove that the platform may process payments, that a merchant exists, or that underwriting works.
  - No Rainforest credential exists here. Any live result must come from a session that has one, and the `Not run` rows in `PROVIDER_DOCS.md` are what must be updated then.
