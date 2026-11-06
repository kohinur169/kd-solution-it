// path: docs/handoffs/STEP_155_COMPLETED.md
# STEP 155 — Payoneer encrypted key configuration and connection test

**Status: COMPLETED**

## STEP

- Number and title: STEP 155 — Payoneer encrypted key configuration and connection test.
- Category: Five Payment Provider Adapters (NMI, Payoneer, Rainforest, Stripe Connect, Airwallex), STEP 147-169.
- Depends on (earlier STEPs in this category and their handoff files): STEP 154 (the Payoneer documentation record, whose endpoints, rules and open questions this STEP codes against — `lib/payments/adapters/payoneer.ts` and the Payoneer section of `docs/final/PROVIDER_DOCS.md`), STEP 147/148 (the adapter file set shape and the NMI key configuration this STEP mirrors), and the platform's canonical encryption module `lib/security/encryption.ts` (security STEPs 056-067), which is reused rather than reimplemented.

## Files

- Created:
  - `lib/payments/adapters/payoneer-client.ts` — the Payoneer key configuration service: validation, sealing through the platform's encryption module with a provider-and-company bound scope, the masked view, the OAuth2 client-credentials connection test over the documented authorization hosts, the token transport, activation gated on a passing test, retirement, and the rotation procedure with audit entries.
  - `lib/payments/adapters/payoneer-client-verify.ts` — the gate (206 checks).
  - `docs/handoffs/STEP_155_COMPLETED.md` — this handoff.
- Modified:
  - `package.json` — added the `check:payments-adapters-payoneer-client` script and its place in the `verify` chain, after `check:payments-adapters-payoneer`.
  - `docs/final/PROVIDER_DOCS.md` — the Payoneer section gained a "Verified for STEP 155" block: the credential set, the token grant against both authorization hosts, what the test does and does not prove (the program id is not proven), the standard client-credentials encoding recorded as to-be-confirmed, and the sealing scope.
- Owned paths touched (must match the File Ownership Rules in STEP_PLAN_250.md): `lib/payments/adapters/` (one adapter file plus its gate, the shape every adapter STEP in 147-169 uses), plus the two shared files an adapter STEP may change — `package.json` (one gate entry) and `docs/final/PROVIDER_DOCS.md` (the Payoneer section only). No migration, no `app/` route, no component, no `lib/env` change, no `services/` change, and no file of another STEP edited — including the NMI key file, which is discussed under "Observations" below and deliberately left alone.

## Database

- Migrations added (file names): none. This STEP stores no new schema: the configuration is a value the caller stores, and the shipped `InMemoryPayoneerConfigStore` is a reference implementation of the invariants the real table must enforce — one pending key per company, one active key per company, an immutable company/environment/id, sealed credentials that never change on an existing row, and a strictly increasing `version` for optimistic locking.
- Rollback verified on clean database (yes/no, how): not applicable — no migration was added or changed.

## Environment

- Environment variables added to .env.example: none. The keyring is supplied by the caller, which reads it from the environment at boot as `lib/security/encryption.ts` requires; this file reads no environment variable and caches no key.
- Secrets handled (names only, never values): the Payoneer client id and client secret (entered by an admin), and the short-lived OAuth2 access token the connection test obtains. None of the three is stored in plaintext, logged, audited or returned: the token is read only to prove it is a token and is then dropped, and the gate scans every outcome, audit entry and stored row for both credentials and for a token (`JSON.stringify(...)` contains neither).

## Packages

- Package requests for the integrator (name, reason), or none: none. `node:crypto`'s `randomUUID` is the only direct import beyond the repository's own modules; the cipher and the keyring belong to `lib/security/encryption.ts`.

## Behaviour Proof (acceptance checklist)

The two behaviours in the STEP title, plus the rotation procedure section 29 requires, were exercised. `npm run check:payments-adapters-payoneer-client` runs all 206 checks and passes.

**Encrypted key configuration**

- A valid credential set is stored with the client id and the client secret sealed through `lib/security/encryption.ts` as `kd1.<keyId>.<iv>.<tag>.<ciphertext>` envelopes; the gate asserts the envelope prefix, that neither plaintext appears in the envelope, and that `payoneerConfigIsSealed` recognises the pair.
- The sealing scope is `gateway:<companyId>:payoneer:<client_id|client_secret>`, and the gate proves the binding by opening a stored value under a foreign keyring, under another company's scope and as the other credential — each fails instead of returning a secret. A keyring rotation (`{primary: k2, previous: k1}`) still opens what `k1` wrote, and a keyring without the writing key cannot.
- The masked view shows only the last four characters (with the mask capped at twelve), hides anything four characters or shorter entirely, and a stored key's view is built by opening and immediately masking, so the screen never receives a full credential.
- Refusals before anything is sealed or stored: an invalid company id, an unknown environment, a client id outside 8-128 characters of letters/digits/dot/dash/underscore, a client secret under 16 characters or carrying spaces or quotes, an invalid program id, the same value used as both credentials, a second key waiting for a test, and an unusable keyring (`the encryption keyring cannot seal a credential` — the reason names the keyring, never the key).
- Every configuration step writes an audit entry: `provider_key.configured`, `provider_key.tested`, `provider_key.activated`, `provider_key.rotated`, `provider_key.retired`. The entries carry the provider key, company, configuration id, environment, the outcome and the instant — and no credential.

**Connection test**

- The test posts the OAuth2 client-credentials grant to `https://login.sandbox.payoneer.com/oauth2/token` for a sandbox key and `https://login.payoneer.com/oauth2/token` for a production key, with a form body carrying `grant_type=client_credentials`, the client id and the client secret. The gate proves the endpoint, the method, the refusal of redirects, the form encoding and the two secrets sent. A production key is never tested against the sandbox host.
- Outcomes, each exercised: a `200` with `access_token` (or `token`) is `connected` with `tokenObtained: true`; `400 invalid_client`, `401`, `403` and other 4xx are `rejected` with the provider's message sanitised; `408`, `425`, `429` and any `5xx` are `unreachable`; a transport throw is `unreachable` and never leaks the thrown text; a `200` with an empty body, an array or a blank token is `failed`; a `204` and a redirect are refused.
- The test reports `programVerified: false` in every case, and the module header, the handoff and `PROVIDER_DOCS.md` all say why: the pages read in STEP 154 publish no program-level probe, so the program id is recorded by this STEP and confirmed by the first program-scope read in STEP 156.
- The outcome is written back onto the key as `lastTest {outcome, testedAtEpochMs, environment}` with a version-guarded write, so activation reads a record rather than a caller's memory.

**Activation and rotation (section 6 "a provider cannot be enabled when its connection test fails", section 29 rotation)**

- Activation refuses, in this order: an unknown id, a retired key, an already-active key, a superseded key, a key that is not waiting for activation, a key with no test (`the connection test has not been run for this key`), a key whose last test did not pass (`the last connection test did not pass, so this key cannot be activated`), and a key whose test ran against another environment. The store also refuses `pending_activation → active` unless a `connected` test is recorded on that key, so the rule survives a caller that bypasses the service.
- The full rotation runs in the documented order: add the replacement key while the old key serves traffic → test the replacement → activate it (the old key becomes `superseded`, still readable during the window, and `provider_key.rotated` names it) → retire the old key once the switch is done. The gate asserts each step, both audit entries, that a superseded key cannot be activated again, that the active key cannot be retired, that a retired key cannot be tested or retired twice, and that cancelling a pending key leaves the active key untouched.
- A superseded key stays openable through the rotation window — proven by reading its masked view after the switch — which is what makes "add new key, run connection test, activate, then remove the old key" a deploy rather than a migration.

**API checks (success, validation failure, unauthorized, cross-tenant)**: no route was added in this STEP, so there are no HTTP checks. The service-level equivalents are the refusal list above; cross-tenant safety is proven by the scope binding (another company's envelope does not open) and by the store's company immutability.

**UI checks (desktop, mobile, keyboard, light and dark)**: not applicable — this STEP ships no screen. The masked view it returns is the contract the admin gateway screen will render, and it contains no full credential.

**Money flow ledger proof (balanced debit and credit)**: not applicable — no money moves in a key configuration or a token grant.

**Provider sandbox cycle and documentation URLs**: **the connection test was not run against Payoneer.** No Payoneer sandbox credentials exist in this environment, so the grant was exercised against a recording transport only; the gate proves the request shape, not a live token. `docs/final/PROVIDER_DOCS.md` records the token grant and marks its exact encoding as to-be-confirmed on the first real sandbox call. Sources used: the STEP 154 documentation list (unchanged) plus the recorded rule that OAuth2 client-credentials over TLS 1.2 is how Payoneer authenticates.

## Verification

- Typecheck result: `npx tsc --noEmit` — exit 0, no diagnostics.
- Lint result: `npx eslint .` — exit 0.
- Build result for the touched area: `npm run verify` — exit 0 (`check:audit`, `check:structure`, every earlier gate, `check:payments-adapters-payoneer-client` with 206 checks, then `typecheck`, `lint` and `build`).
- No test file was added (MASTER_PROMPT rule 4); no `TODO`, `FIXME` or placeholder text; no `console.log`, no `any`, no `process.env` read in either file.

## Observations for the integrator (not fixed here, because the files belong to earlier STEPs)

- `lib/security/verify.ts` asserts that exactly two modules in `lib/` and `app/` call `createCipheriv|createDecipheriv` — `lib/auth/secrets.ts` and `lib/security/encryption.ts` — and that exactly four name `aes-256-gcm`. `lib/payments/adapters/nmi-client.ts` (STEP 148) calls both constructors and names the algorithm, so that assertion would fail if `check:security` were wired into `npm run verify`; it currently is not in the `verify` chain. STEP 155 deliberately avoided adding a third cipher caller by sealing through `lib/security/encryption.ts`. Somebody should either wire `check:security` in and move the NMI key service onto the canonical module, or relax the assertion in a deliberately chosen STEP — but not both silently.
- `lib/security/verify.ts` also expects a `check:security` script that `package.json` does not define.

## Next

- Next STEP number: STEP 156 — Payoneer automatic bank linking, payout execution and status handling.
- Anything the next chat must know:
  - Reuse, do not reimplement: `configurePayoneerKeys`, `testPayoneerConnection`, `activatePayoneerConfig`, `retirePayoneerConfig`, `payoneerKeyViewOf`, `payoneerTokenEndpointFor`, `parsePayoneerTokenAnswer`, `payoneerFetchTokenTransport`, `payoneerClientIdScope`, `payoneerClientSecretScope`, `maskPayoneerCredential`, `PAYONEER_MAXIMUM_PAYOUTS_PER_CALL` (STEP 154).
  - The active configuration is the only one a payout may use: `findActiveByCompany`, never "the newest row".
  - The connection test proves the credentials but **not** the program. STEP 156's first program-scope read (payout status or payee status) is what confirms the program id; record that result rather than assuming it.
  - The token is obtained by the caller for a call and never stored; treat its lifetime as unknown and refresh on the token answer (STEP 154's open question).
  - The bank-linking and payout status strings must come from the reference's published reason tables, not from invention.
  - No Payoneer credential exists in this environment; any live token, payout or bank link must be run by someone who has one, and the `Not run` rows in `PROVIDER_DOCS.md` are what get updated then.
