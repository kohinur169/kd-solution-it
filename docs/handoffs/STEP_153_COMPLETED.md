// path: docs/handoffs/STEP_153_COMPLETED.md
# STEP 153 — NMI sub-merchant provisioning through the gateway with signature verified idempotent webhooks

**Status: COMPLETED**

## STEP

- Number and title: STEP 153 — NMI sub-merchant provisioning through the gateway with signature verified idempotent webhooks.
- Category: Five Payment Provider Adapters (NMI), STEP 147-153.
- Depends on (earlier STEPs in this category and their handoff files): STEP 147 (NMI documentation record in `docs/final/PROVIDER_DOCS.md`), STEP 148 (encrypted provider key configuration and connection test), STEP 150 (Classic API transaction types and answer parsing), STEP 151 (shared server payment module), STEP 152 (`nmi-status-sync.ts`, whose `sanitizeNmiText` rules this STEP repeats in its own vocabulary), and STEP 094 (`services/submerchant/provision-sync.ts`, the `submerchant.sync` job and the `webhook_events` constant). Protocol details follow `docs/handoffs/STEP_117_151_REVIEW.md`; the boarding and webhook contracts follow NMI's current documentation, linked in the adapter header and in `docs/final/PROVIDER_DOCS.md`.

## Files

- Created:
  - `lib/payments/adapters/nmi-submerchant.ts` — the STEP 153 adapter service: the documented Create Merchant request and answer, the validated merchant profile, the idempotent boarding service with its store port and reference store, the `Webhook-Signature` verification, the documented event catalogue, the provisioning-event mapping, and the idempotent delivery ingestion with its store port and reference store.
  - `lib/payments/adapters/nmi-submerchant-verify.ts` — the gate (286 checks).
  - `docs/handoffs/STEP_153_COMPLETED.md` — this handoff.
- Modified:
  - `package.json` — added the `check:payments-adapters-nmi-submerchant` script and its place in the `verify` chain, after `check:payments-adapters-nmi-status-sync`.
  - `docs/final/PROVIDER_DOCS.md` — NMI section extended with the STEP 153 documentation URLs, the recorded boarding and signing rules, and the two sandbox note rows (boarding, webhook signing) that state plainly that neither was run live here.
- Owned paths touched (must match the File Ownership Rules in STEP_PLAN_250.md): `lib/payments/adapters/` (one adapter file plus its gate, the shape STEPs 147-152 used), plus the two shared files an adapter STEP is allowed to change — `package.json` (one gate entry) and `docs/final/PROVIDER_DOCS.md` (NMI section only). No file of another STEP was edited. No migration, no `app/` route, no component, no `services/` change, no `lib/env` change.

## Database

- Migrations added (file names): none. This STEP owns no table. The rows it writes are the committed ones: `migrations/0054_submerchant_provisions.sql` (status walk `pending → action_required | verified | rejected`, `verified → restricted`, `provider_submerchant_id`, `master_account_ref`, `charges_enabled`/`payouts_enabled` only when `verified`, and `guard_sync()` requiring a same-provider, same-company `webhook_events` row with `signature_ok` and `status = 'processed'`) and `migrations/0032_webhook_events.sql` (unique delivery key `(provider_id, mode, external_event_id)`, `payload_hash` only, `signature_ok`, the six statuses, `processed_at`, `failure_detail`).
- The adapter deliberately does **not** write the `0054` row itself, and does not bypass `guard_sync()`. It returns the column values the caller stores (`NmiProvisionAccountUpdate`) and the normalised provisioning event STEP 094's `submerchant.sync` job consumes, so the one writer of `0054` stays the service that guard was written for. The reference stores in the adapter enforce the same invariants the tables do: one record per company, one record per provider gateway id, immutable company/mode/approval key, forward-only delivery status, and a strictly increasing `version` for optimistic locking.
- Rollback verified on clean database (yes/no, how): not applicable — no migration was added or changed. Nothing in this STEP needs a rollback beyond reverting two files; the `0054` and `0032` rollbacks are the ones their own STEPs proved.

## Environment

- Environment variables added to .env.example: none. Nothing in this STEP reads `process.env`; the v4 API key, the webhook signing key, the clock, the stores and the merchant lookup are all passed in by the caller that owns them (the gateway settings of STEP 148 and the ingestion endpoint).
- Secrets handled (names only, never values): the NMI v4 API key and the NMI webhook signing key. Neither is stored, logged, audited, put in an error, or returned. The gate proves it with value scans on the provisioning outcome, the audit entries and the delivery outcome (`JSON.stringify(...).includes(secret) === false`), and a missing key refuses the attempt instead of sending a call.

## Packages

- Package requests for the integrator (name, reason), or none: none. Signing and hashing use `node:crypto` (`createHmac`, `createHash`, `timingSafeEqual`, `randomUUID`); the merchant profile is validated by this file's own checks so no schema package was added.

## Behaviour Proof (acceptance checklist)

The two behaviours in the STEP title were exercised with NMI's documented answers and with deliveries signed the way the documentation says the gateway signs them. `npm run check:payments-adapters-nmi-submerchant` runs all 286 checks and passes.

**Sub-merchant provisioning through the gateway**

- The documented answer `{objectType: "merchant", id: "1587", status: "pending", parentAffiliateId: "1", ...}` is read into the `0054` values: `provider_submerchant_id = "1587"`, `status = pending`, `master_account_ref = "1"`, one attempt counted, version 1, and one audit entry `submerchant_provision.nmi_attempted`. Observed: `provisioned`.
- Provisioning never enables charges or payouts: the update it returns carries `attempted` and the provider status only, and the row's status stays `pending`, which is what `0054`'s flags and `guard_sync()` require before a verified webhook.
- Idempotency: replaying the same approval key answers `already_provisioned` and makes no second call (call counter stays at 1); a second approval key for the same company is `refused`; the same company in another mode is `refused`; the store refuses a second record per company and a second record per gateway id.
- The documented 422/400 validation answer parks the row in `action_required` with the provider detail recorded (sanitised) and counted as an attempt; a corrected retry then boards the merchant, attempts 2, version 2, status `pending`.
- Ambiguity is never claimed as success or as failure: a transport throw, a 503, a 429, a `409` duplicate, a non-JSON body, an answer with no `objectType: merchant`, or a gateway id that is not `[A-Za-z0-9][A-Za-z0-9_-]{0,63}` all answer `unknown`, write nothing and ask for reconciliation. A 401/403 refuses the attempt and names the v4 key.
- Refusals before the wire: missing v4 key, disabled provider (`0054` only records an attempt against an enabled provider), invalid approval key, invalid company id, invalid affiliate reference, and every profile field the documented request requires — each refused with no call and no row.

**Signature verified idempotent webhooks**

- `Webhook-Signature: t=<nonce>,s=<hex>` is parsed strictly (both parts present, nonce bounded, signature exactly 64 lowercase hex characters); `HMAC-SHA256("<nonce>.<raw body>")` is compared in constant time over equal-length buffers. Verified: the documented signing of a delivery verifies; a wrong signature, a tampered body, another nonce, another signing key, an empty key, an empty body and an oversized body all fail.
- A delivery that does not verify is stored `rejected` with `signature_ok = false` — never `processed`, which is exactly the pair `0054.guard_sync()` demands — and applies nothing. A forged body naming an event the platform already holds is answered `rejected`, not "already received", and changes no stored outcome.
- Idempotency: the provider's `event_id` is the delivery key. A redelivery answers `duplicate` with the stored row, writes nothing and audits nothing; a rejected event id can never be replayed into a `processed` event; the store refuses a stale write, a version jump, a changed event type, a changed payload hash, a return to `pending`, and a changed outcome once finished. `t` is a nonce rather than a timestamp, so this de-duplication is the replay defence — recorded in the adapter header and in `PROVIDER_DOCS.md`.
- The documented envelope `{event_id, event_type, event_body}` is validated (id and type bounds and character set, body must be an object); a signed but unreadable body, a missing id, an invalid type and a non-object body are recorded as `failed` with nothing applied; an oversized body is refused before it is hashed.
- Provisioning mapping: a successful transaction (`sale`, `auth`, `capture`, `void`, `refund`, `credit`, `validate`) and a completed settlement batch become `submerchant.verified` for the resolved company; a failure, an unknown, a failed batch, a check-status event, a recurring event, an ACU summary and a chargeback batch are `ignored`. Every mapping key is asserted to be one of the 35 documented NMI event names.
- Tenancy and mode: the gateway merchant id in `event_body.merchant.id` is resolved by the caller's lookup, so an event about a merchant the platform never boarded is `ignored` with no company; an event whose `features.is_test_mode` disagrees with the endpoint's mode is `ignored`, so a sandbox event can never move a live row.
- The stored event keeps the payload hash and never the payload: the gate scans the stored row for the transaction id and finds none.

**Connection status (sub-step 5)** — this STEP is an adapter library, the same shape as STEPs 148-152: it adds no route and registers no job, because both callers are owned elsewhere. The boarding service is called by STEP 094's `submerchant.provision` job (approval → create merchant) and the ingestion by the webhook endpoint that owns the `0032` row. Documented contract for that endpoint, and one conflict the integrator must decide:

- `receiveNmiWebhook` returns the normalised event (`submerchant.verified` today; the vocabulary matches STEP 094's `PROVISION_SYNC_EVENT_TYPES`). STEP 094's job reads `webhook_events.event_type` and switches on those `submerchant.*` names, while `0032`'s column comment describes the same column as the provider's event name. Both cannot be true for one row. The endpoint must therefore store the provider name and enqueue the sync with the normalised name, or store the normalised name and keep the provider name in `failure_detail`'s sibling field — that choice belongs to the pipeline STEP that owns the endpoint, not to this adapter. Until it is made, the adapter hands over both names (`providerEventType` and `normalized.eventType`).

**UI checks (desktop, mobile, keyboard, light and dark)**: not applicable — this STEP ships no screen.

**API checks (success, validation failure, unauthorized, cross-tenant)**: not applicable as HTTP checks — no route was added. The equivalent service-level checks are listed above: success, every documented validation failure, a rejected key, an unknown outcome, a foreign merchant (cross-tenant), and a mode mismatch.

**Money flow ledger proof (balanced debit and credit)**: not applicable — boarding and webhook ingestion move no money; they set provisioning state, and the flags stay off until a verified webhook.

**Provider sandbox cycle and documentation URLs**: no live sandbox call was made — **there are no NMI credentials and no publicly reachable webhook endpoint in this environment**, so neither a merchant was boarded nor a signed delivery was received from NMI. That is stated plainly rather than claimed: `docs/final/PROVIDER_DOCS.md` carries two `Not run` rows for it. Everything was exercised against the documented answer shapes and against locally signed deliveries. Documentation read in this session, recorded in the adapter header and in `PROVIDER_DOCS.md`:

- https://docs.nmi.com/reference/create-merchant
- https://docs.nmi.com/reference/nmi-gateway-features
- https://docs.nmi.com/reference/get-specific-merchant-information
- https://docs.nmi.com/reference/create-merchant-key
- https://docs.nmi.com/reference/overview
- https://docs.nmi.com/reference/transaction-events
- https://docs.nmi.com/reference/settlement-events
- https://docs.nmi.com/reference/check-status
- https://docs.nmi.com/reference/recurring-events
- https://docs.nmi.com/reference/chargeback-events

Sandbox URLs used by the implementation: `https://sandbox.nmi.com/api/v4/merchants` (boarding) and the sandbox endpoint's `Webhook-Signature` header (ingestion). Production: `https://secure.nmi.com/api/v4/merchants`.

## Verification

- Typecheck result: `npx tsc --noEmit` — exit 0, no diagnostics.
- Lint result: `npx eslint .` — exit 0.
- Build result for the touched area: `npm run verify` — exit 0, `check:audit` 3099 checks, `check:structure` 17 directories / 14 root files / 533 source files, `check:payments-adapters-nmi-submerchant` 286 checks, then `typecheck`, `lint` and `build`.
- No test file was added (MASTER_PROMPT rule 4); no `TODO`, `FIXME` or placeholder text; no `console.log`, no `any`, no `process.env` read in either file.

## Next

- Next STEP number: STEP 154 — Payoneer documentation verification and sandbox notes recording.
- Anything the next chat must know:
  - Reuse, do not re-implement: `sanitizeNmiSubmerchantText`, `nmiWebhookPayloadHash`, `verifyNmiWebhookSignature`, `parseNmiWebhookSignature`, `NMI_DOCUMENTED_WEBHOOK_EVENTS`, `NMI_PROVISION_EVENT_TYPES`, `nmiProvisionEventOf`, `provisionNmiSubmerchant`, `receiveNmiWebhook`, `NMI_MERCHANT_ID_PATTERN`, `NMI_AFFILIATE_REFERENCE_PATTERN`.
  - The `submerchant.*` event vocabulary is STEP 094's; the adapter maps onto it and never writes `0054` itself. Do not "fix" that by writing the row from the adapter — `0054.guard_sync()` is the guard, and one writer keeps it meaningful.
  - `webhook_events.event_type` has a documented meaning that conflicts with STEP 094's switch (see above); the pipeline STEP that owns the endpoint must resolve it.
  - Gateway ids are validated as `[A-Za-z0-9][A-Za-z0-9_-]{0,63}` — stricter than `0054`'s own check, so a leading `-` can never be stored.
  - No NMI credential exists here. Any claim of a live boarding or a live webhook must be made only after someone with sandbox credentials runs `POST https://sandbox.nmi.com/api/v4/merchants` and registers a webhook endpoint, and the two `Not run` rows in `PROVIDER_DOCS.md` must then be updated with the real result.
  - Old NMI handoffs (STEP 149, STEP 150) contain superseded protocol details; `docs/handoffs/STEP_117_151_REVIEW.md` is the reference.
