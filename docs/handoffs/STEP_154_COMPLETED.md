// path: docs/handoffs/STEP_154_COMPLETED.md
# STEP 154 — Payoneer documentation verification and sandbox notes recording

**Status: COMPLETED**

## STEP

- Number and title: STEP 154 — Payoneer documentation verification and sandbox notes recording.
- Category: Five Payment Provider Adapters (NMI, Payoneer, Rainforest, Stripe Connect, Airwallex), STEP 147-169.
- Depends on (earlier STEPs in this category and their handoff files): STEP 147 (the category's first adapter and the owner of `docs/final/PROVIDER_DOCS.md`), whose NMI section this STEP mirrors and whose file set shape (`<provider>.ts` plus `<provider>-verify.ts`) this STEP follows. STEPs 148-153 are the NMI steps and share no code with this record. Protocol content comes from Payoneer's current documentation, linked below and in `docs/final/PROVIDER_DOCS.md`.

## Files

- Created:
  - `lib/payments/adapters/payoneer.ts` — the Payoneer adapter's documentation verification and sandbox notes service: the eight documentation sources read in this session, the recorded rules, the open questions, the five step sandbox cycle, the strict status calculation, the sanitised validation of every check and note, the record, the recording function, and a reference store.
  - `lib/payments/adapters/payoneer-verify.ts` — the gate (187 checks).
  - `docs/handoffs/STEP_154_COMPLETED.md` — this handoff.
- Modified:
  - `package.json` — added the `check:payments-adapters-payoneer` script and its place in the `verify` chain, after `check:payments-adapters-nmi-submerchant`.
  - `docs/final/PROVIDER_DOCS.md` — the new Payoneer section: documentation sources with what each established, the recorded rules, the open questions, the sandbox note table and the capability matrix.
- Owned paths touched (must match the File Ownership Rules in STEP_PLAN_250.md): the adapter category owns "exactly one file each under `lib/payments/adapters/` plus their provider components"; this STEP adds `payoneer.ts` and its gate in that directory, the same pair STEPs 147-153 each added, and touches the two shared files an adapter STEP may change — `package.json` (one gate entry) and `docs/final/PROVIDER_DOCS.md` (a new provider section, no other provider's text edited). No migration, no `app/` route, no component, no `services/` change, no `lib/env` change, and no other STEP's file edited.

## Database

- Migrations added (file names): none. This STEP owns no table: the verification record is a value the caller stores, and the shipped `InMemoryPayoneerVerificationStore` is a reference implementation, not a schema. The provider row this record describes already exists in `migrations/0094_seed_payment_providers.sql` and in `lib/gateways/registry.ts`.
- Rollback verified on clean database (yes/no, how): not applicable — no migration was added or changed; reverting the two source files removes this STEP entirely.

## Environment

- Environment variables added to .env.example: none. The module reads no environment variable and performs no network call; the store, the clock and the audit writer are passed in by the caller.
- Secrets handled (names only, never values): none used. This STEP records no credential, and the gate proves it: no recorded rule, open question, audit entry or record may contain a bearer value (`JSON.stringify(...).includes("Bearer") === false`, plus a no-credential pattern check over the recorded rules).

## Packages

- Package requests for the integrator (name, reason), or none: none. `node:crypto`'s `randomUUID` is the only import beyond the repository's own `deepFreeze`; no HTTP client was needed because this STEP makes no call.

## Behaviour Proof (acceptance checklist)

The behaviour named in the STEP title — verify Payoneer's documentation, then record the sandbox notes honestly — was exercised end to end. `npm run check:payments-adapters-payoneer` runs all 187 checks and passes.

**Documentation verification**

- Eight pages were read in this session, all on Payoneer's own hosts, each recorded with the topic and what it established: the developer platform index, the Mass Payout index, submit mass payout, payee onboarding, the payout status query, the program API reference, the white-label payouts guide V4, and the sandbox/communication-security page.
- What those pages state is recorded as thirteen rules, and the gate asserts each recorded fact is really in them: the sandbox and production API bases, the two authorization hosts, the OAuth2 bearer scheme, the TLS 1.2 floor, the mass payout endpoint and its `Payments` fields, the 500 payout limit and the pre-deposited funds requirement, asynchronous processing, the registration link endpoint and `payee_id`, the prefill and `lock_type` fields, the `Active` payee requirement, the payout status endpoint with its `load_time` marker (`load_date`, present only when `Transferred`), the Admin Console webhook configuration with the notification catalogue, the five-attempt retry, and the published reason tables.
- Three open questions are recorded rather than assumed: the webhook signing scheme is **not** verified (the reference's Webhooks Security section is script-rendered and could not be read; a third-party SDK's `hmacauth` description is recorded explicitly as not first-party), the token lifetime is unstated, and no sandbox credential exists here. The gate asserts all three are present and that the webhook question names STEP 157.

**Sandbox notes recording, and the honesty rule**

- The sandbox cycle a payout provider must complete is fixed at five steps: create a registration link, read the payee status to `Active`, submit a single payout, read the payout status to `Transferred`, and receive and verify a signed IPCN. The gate asserts the order, the methods and the documented paths.
- This session's notes record all five as `not_tested`, each with the reason stated in its own words: no Payoneer sandbox credentials exist in this environment and Payoneer issues them during account setup. The gate asserts that no session step claims a pass and that every unrun step carries both the "has not been run" statement and the missing-credential reason.
- The status rule is strict on purpose: `verified` requires a verified documentation check, every check verified, at least one sandbox note, every note passed, **and** all five cycle steps present and passed. The session review therefore calculates to `partial`, and the gate asserts it can never read as `verified`. A record that verified nothing and passed nothing is `not_verified`; anything else partial. Verified by the gate: a complete cycle verifies, an unverified page, an empty note set, a missing step, an unrun step and a failed step each drop the record to `partial`, and the two all-negative shapes drop to `not_verified`.
- The caller cannot inflate a status: `recordPayoneerVerification` takes no status field and always calculates it, which the gate proves by recording an honest partial review and reading `partial` back.
- Refusals before anything is stored: no documentation check, a missing or malformed verifier, a check on any host that is not `developer.payoneer.com` or `www.payoneer.com` (including look-alikes such as `payoneer.evil.example` and another provider's `docs.nmi.com` page), an undocumented sandbox step, a duplicated step, and an unrun or failed step with no reason. Every message that reaches a record passes `sanitizePayoneerText`, which strips markup and control characters and caps the text at 500 characters.

**API checks (success, validation failure, unauthorized, cross-tenant)**: not applicable as HTTP checks — this STEP adds no route and makes no call.

**UI checks (desktop, mobile, keyboard, light and dark)**: not applicable — this STEP ships no screen.

**Money flow ledger proof (balanced debit and credit)**: not applicable — no money moves in a documentation record.

**Provider sandbox cycle and documentation URLs**: **not run, and stated plainly.** There are no Payoneer credentials in this environment and no registered callback endpoint, so no registration link, payout or IPCN was produced. `docs/final/PROVIDER_DOCS.md` carries the five `Not run` rows and the recorded reason. Documentation URLs read in this session:

- https://www.payoneer.com/developers-docs/
- https://www.payoneer.com/developers-docs/mass-payout/
- https://www.payoneer.com/developers-docs/mass-payout/mass-submit-payout/
- https://www.payoneer.com/developers-docs/mass-payout/mass-payee-onboarding/
- https://www.payoneer.com/developers-docs/business-funding/business-funding-getting-started/
- https://developer.payoneer.com/docs/mass-payouts-and-services.html
- https://developer.payoneer.com/docs/white-label-payouts-v4.html
- https://developer.payoneer.com/psd2/get-started

Sandbox URLs recorded for the later steps: `https://api.sandbox.payoneer.com` (API) and `https://login.sandbox.payoneer.com` (authorization); production `https://api.payoneer.com` and `https://login.payoneer.com`.

## Verification

- Typecheck result: `npx tsc --noEmit` — exit 0, no diagnostics.
- Lint result: `npx eslint .` — exit 0.
- Build result for the touched area: `npm run verify` — exit 0 (`check:audit`, `check:structure`, every earlier gate, then `check:payments-adapters-payoneer` with 187 checks, then `typecheck`, `lint` and `build`).
- No test file was added (MASTER_PROMPT rule 4); no `TODO`, `FIXME` or placeholder text; no `console.log`, no `any`, no `process.env` read in either file.

## Next

- Next STEP number: STEP 155 — Payoneer encrypted key configuration and connection test.
- Anything the next chat must know:
  - Reuse, do not re-implement: `sanitizePayoneerText`, `isPayoneerDocumentationUrl`, `payoneerDocumentationHostOf`, `PAYONEER_SANDBOX_API_BASE`, `PAYONEER_PRODUCTION_API_BASE`, `PAYONEER_SANDBOX_AUTH_BASE`, `PAYONEER_PRODUCTION_AUTH_BASE`, `PAYONEER_MAXIMUM_PAYOUTS_PER_CALL`, `PAYONEER_MINIMUM_TLS_VERSION`, `PAYONEER_SANDBOX_CYCLE`, `calculatePayoneerStatus`, `recordPayoneerVerification`.
  - Do not claim a verified Payoneer integration: the record is `partial` until somebody with sandbox credentials runs all five cycle steps, and `calculatePayoneerStatus` will refuse to say `verified` until then.
  - Do not implement webhook signature verification from the third-party `hmacauth` description; STEP 157 must first read the reference's Webhooks Security section. The same applies to token lifetime: treat expiry as unknown and refresh from the token answer.
  - The environment split is a base-URL and credential change only (`api.payoneer.com` / `login.payoneer.com` versus the sandbox pair); keep it that way in the client.
  - No Payoneer credential exists here. Any live result must come from a session that has one, and the `Not run` rows in `PROVIDER_DOCS.md` are what must be updated then.
