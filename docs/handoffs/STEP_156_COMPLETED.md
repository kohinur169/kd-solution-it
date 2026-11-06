// path: docs/handoffs/STEP_156_COMPLETED.md
# STEP 156 — Payoneer automatic bank linking, payout execution and status handling

**Status: COMPLETED**

## STEP

- Number and title: STEP 156 — Payoneer automatic bank linking, payout execution and status handling.
- Category: Five Payment Provider Adapters (NMI, Payoneer, Rainforest, Stripe Connect, Airwallex), STEP 147-169. This is Payoneer's last STEP: 157 opens the Rainforest adapter.
- Depends on (earlier STEPs in this category and their handoff files): STEP 154 (the Payoneer documentation record and the five step sandbox cycle), STEP 155 (the sealed credentials, the token grant and the key rotation — the access token this STEP takes is the one that grant returns), and the payment core's ports it answers: `lib/payments/payout-bank-account.ts` (STEP 133's bank add flow and its `ProviderBankLinkingFn`) and `lib/payments/payout-execution.ts` (STEP 134's execution, its `ProviderPayoutFn` and the `PayoutStatus` vocabulary). Neither core file was edited.

## Files

- Created:
  - `lib/payments/adapters/payoneer-payout.ts` — the STEP 156 adapter service: the documented registration and payout request builders, the payee registration (the automatic bank link), the idempotent payout submission, the payout status query with its mapping, the notification mapping and its fail-closed receiver, the transport, the submission store, the audit entries, and the mappings onto the core's two ports.
  - `lib/payments/adapters/payoneer-payout-verify.ts` — the gate (257 checks).
  - `docs/handoffs/STEP_156_COMPLETED.md` — this handoff.
- Modified:
  - `package.json` — added the `check:payments-adapters-payoneer-payout` script and its place in the `verify` chain, after `check:payments-adapters-payoneer-client`.
  - `docs/final/PROVIDER_DOCS.md` — the Payoneer section gained "Verified for STEP 156" (the registration and payout endpoints and bodies, the failed-reference listing, the status rule, the notification table and the account-type decision) and four `Not run` sandbox rows for this STEP's calls.
- Owned paths touched (must match the File Ownership Rules in STEP_PLAN_250.md): `lib/payments/adapters/` (one adapter file plus its gate, the shape every adapter STEP in 147-169 uses), plus the two shared files an adapter STEP may change — `package.json` (one gate entry) and `docs/final/PROVIDER_DOCS.md` (the Payoneer section only). No migration, no `app/` route, no component, no `services/` change, no `lib/env` change, and neither core payment file edited.

## Database

- Migrations added (file names): none. The submission record is the caller's: `InMemoryPayoneerSubmissionStore` is a reference implementation of the invariants the real table must enforce — one row per `client_reference_id`, an immutable company, payee, amount and currency, a version guard on every write, and forward-only outcomes (`pending → rejected | unknown`, `unknown → rejected`, `rejected` final; nothing ever returns to pending).
- Rollback verified on clean database (yes/no, how): not applicable — no migration was added or changed.

## Environment

- Environment variables added to .env.example: none. This file reads no environment variable; the access token is obtained by STEP 155's grant and handed in per call, and the program id comes from the active key configuration.
- Secrets handled (names only, never values): the OAuth2 access token, passed in and never stored, logged, audited or returned. The gate scans every outcome, audit entry and stored row for it (`JSON.stringify(...)` with a BigInt replacer contains neither the token nor a credential-shaped value).

## Packages

- Package requests for the integrator (name, reason), or none: none. `node:crypto`'s `randomUUID` and the repository's own `deepFreeze` are the only imports beyond the types of the two core ports.

## Behaviour Proof (acceptance checklist)

The three behaviours in the STEP title were exercised with Payoneer's documented request and answer shapes, a recording transport and locally verified notifications. `npm run check:payments-adapters-payoneer-payout` runs all 257 checks and passes.

**Automatic bank linking**

- The link is the documented **Register Payee with token** call: `POST /v4/programs/{program_id}/payees/register-payee-with-token`, with the published body — `payee_id`, `payee.type: "company"`, the `company` block (`name`, `legal_type`, `incorporated_address_1/_2`, `incorporated_city`, `incorporated_state`, `incorporated_zipcode`, `incorporated_country`, optional `url`) and `payout_method { type: "BANKTRANSFER", bank_account_type: "company", country, currency }`. The gate asserts every key, the nesting, that optional fields are omitted when absent and present when not, and that no build ever sends an unvalidated value.
- A `2xx` answer naming the payee is `linked` with the provider payee id and the registration token/link kept; `400`, `409`, `422` are refusals carrying the provider's message sanitised; `401`, `403`, `404`, `429`, `5xx`, an unreadable body and a thrown transport are `unknown` with `requiresReconciliation`, because a payee may exist by then.
- The core's synchronous link port is answered by `toProviderLinkResult`: linked gives the provider bank account id, a refusal gives the reason, and an unknown never silently links.
- **STEP 155's open question is answered here**: the registration answer is a program-scope response, so `programConfirmed` is true on a `2xx` and on the documented validation answers (`400`, `409`, `422`), which the provider can only produce for a program it knows; `401`, `403`, `404`, `429` and `5xx` claim nothing.

**Payout execution**

- The submission is the documented mass payout: `POST /v4/programs/{program_id}/masspayouts` with one payment carrying `client_reference_id`, `payee_id`, `amount`, `currency`, `description` and, when the platform sends the bank details with the payment, the published `payout_method_details` block (`payee`, `payout_method` with `bank_account_type`, `currency`, `country`, `details`). Amounts are integer minor units formatted as the documented decimal string (`2020n → "20.20"`), with no floating point anywhere; a zero, negative or out-of-range amount is refused.
- Idempotency: the instruction is stored against its `client_reference_id` before the call, a replay answers from the store and makes **no** second provider call (the gate counts calls), a reference replayed with another amount, payee or currency is refused, and an in-flight duplicate is answered as unknown rather than resent.
- Money safety: an accepted instruction is `pending`, never success — the provider processes asynchronously. A refusal is only claimed for the documented validation answers or when the answer lists this `client_reference_id` among the failed instructions (the gate proves both the object and the plain-list shapes, and that a failure listed for another reference does not refuse this one). A credential, transport, redirect or unreadable answer is `unknown` with `requiresReconciliation` — and `toProviderPayoutResult` maps unknown to `pending`, so the core never emails a merchant about money that may have arrived.
- The description is sanitised before it is sent (`<b>Payout</b>\nfor June → "bPayout/b for June"`), and the documented 500-instruction limit is asserted by the body builder.

**Status handling**

- The status read is the documented `GET /v4/programs/{program_id}/payouts/{client_reference_id}/status`. The answer's `result.status` maps to success **only** for `Transferred`, and only when the documented `load_date` is present beside it; `Transferred` without its marker, any other status string, a missing status, an unwrapped object, `404`, `401`, `429`, `5xx` and a thrown transport are all `unknown` with `requiresReconciliation`.
- `toPayoutStatus` maps success to success, a failure to failed, and unknown to **pending**, so an unresolved payout is never closed as failed.
- Notifications: the six documented payout names are mapped (`Account/card loaded` → success, `Failed bank transfer` and `Payout canceled` → failed, `Request received`, `Request accepted` and `Sent to bank` → pending, because a dispatched bank transfer can still be returned). A delivery is applied **only** through the caller's verifier: with no verifier it is refused, a verifier that throws is refused, and a verifier that returns false is refused. Until the signing scheme is read from Payoneer's own documentation, this is the fail-closed answer to "webhooks are accepted only after signature verification", and the status query above is the documented path that needs no signature.

**API checks (success, validation failure, unauthorized, cross-tenant)**: no route was added in this STEP, so there are no HTTP checks. The service-level equivalents are the outcome tables above; cross-tenant safety comes from the caller's key configuration (one active key per company, STEP 155) and from the submission store's immutable company, so one company's reference can never settle another company's payout.

**UI checks (desktop, mobile, keyboard, light and dark)**: not applicable — this STEP ships no screen.

**Money flow ledger proof (balanced debit and credit)**: not applicable — this adapter instructs a provider; the ledger entries for a payout stay with STEP 132/134's posting, which this STEP neither writes nor bypasses.

**Provider sandbox cycle and documentation URLs**: **not run.** No Payoneer sandbox credential exists in this environment, so no payee was registered, no payout was instructed and no notification was received: every call was exercised against recorded answers. `docs/final/PROVIDER_DOCS.md` carries the four new `Not run` rows and the reason. Documents read in this session (all Payoneer's own):

- https://www.payoneer.com/developers-docs/white-label/
- https://www.payoneer.com/developers-docs/white-label/white-label-registration-payouts/
- https://www.payoneer.com/developers-docs/white-label/white-label-register-payee-with-token/
- https://www.payoneer.com/developers-docs/white-label/white-label-payouts/
- https://www.payoneer.com/developers-docs/mass-payout/mass-submit-payout/
- https://www.payoneer.com/developers-docs/business-funding/business-funding-getting-started/
- https://developer.payoneer.com/docs/white-label-registration-payouts-v4-getting-started.html

Sandbox endpoints used by the implementation: `https://api.sandbox.payoneer.com` (production `https://api.payoneer.com`). Sandbox result: **none**, stated plainly.

## Verification

- Typecheck result: `npx tsc --noEmit` — exit 0, no diagnostics.
- Lint result: `npx eslint .` — exit 0.
- Build result for the touched area: `npm run verify` — exit 0 (`check:audit`, `check:structure`, every earlier gate, `check:payments-adapters-payoneer-payout` with 257 checks, then `typecheck`, `lint` and `build`).
- No test file was added (MASTER_PROMPT rule 4); no `TODO`, `FIXME` or placeholder text; no `console.log`, no `any`, no `process.env` read in either file.

## Next

- Next STEP number: STEP 157 — Rainforest documentation verification and sandbox notes recording.
- Anything the next chat must know:
  - Reuse, do not reimplement, for any later Payoneer work: `registerPayoneerPayee`, `submitPayoneerPayout`, `readPayoneerPayoutStatus`, `mapPayoneerPayoutStatus`, `applyPayoneerPayoutNotification`, `payoneerPayoutStatusOfNotification`, `toProviderLinkResult`, `toProviderPayoutResult`, `toPayoutStatus`, `payoneerAmountString`, `buildPayoneerRegisterPayeeBody`, `buildPayoneerPayoutBody`, `validatePayoneerBankDetails`, `InMemoryPayoneerSubmissionStore`.
  - The two core ports are **synchronous** (`ProviderBankLinkingFn`, `ProviderPayoutFn`) while every provider call is asynchronous, so the route or job that uses this adapter must await it and then call the core with these mappings. Do not change the core signature in an adapter STEP.
  - `Transferred` is the only payout status the pages read publish. Do not add status strings to that mapping from memory: read the reference's status tables first, then extend `PAYONEER_PAYOUT_NOTIFICATIONS` and the status rule together.
  - A notification must never be applied without a verifier. Reading Payoneer's Webhooks Security section is still pending (STEP 154's open question); until then the verifier port stays unwired and the status query is the documented path.
  - A payout submission is `pending` by design: success only ever comes from a status read or a verified notification.
  - No Payoneer credential exists here; the `Not run` rows in `PROVIDER_DOCS.md` are what a credentialed session must update with real results.
