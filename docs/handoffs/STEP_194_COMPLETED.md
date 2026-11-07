# STEP 194 — Dispute list and status tracking from provider webhooks

Status: **complete**. One commit, `STEP 194: Dispute list and status tracking from provider webhooks`, on
`arena/ca936761-kd-solution-it`, branched from STEP 193's `888376b`. Typecheck, lint and build are clean, and
the STEP's own gate is `services/disputes/dispute-verify.ts` at **265 checks**, mutation-checked with twelve
mutations.

## STEP

From `docs/final/STEP_PLAN_250.md`:

> **STEP 194: Dispute list and status tracking from provider webhooks**
> Sub-step 4: the core service and logic for the dispute list and its status tracking.

FEATURE_LIST §19, first line: *"Dispute interface: list, status and document upload."* §19 also fixes the
deadline (*"24 hours in the merchant own time zone; super_admin can set the deadline to 48 hours"*), the
evidence pack, and the review the compliance desk performs before a pack is sent. This STEP owns the **list**
and the **status**: the merchant's read, the office's deadline queue, and the one writer of a dispute status in
this build — a verified provider delivery. The response form is STEP 195, the warnings are STEP 196, the pack
is STEP 198, and the send is STEP 198/199; the chargeback fee of section 18 is a STEP of its own.

Eight sub-steps, all done. Sub-step 3 is a checked **proof that no migration is needed**, written out below, in
`services/disputes/dispute.ts`'s header and asserted by the gate against `0039_disputes.sql` itself.

## Owned paths

| Path | State | What it holds |
| --- | --- | --- |
| `services/disputes/dispute-fields.ts` | new | The vocabulary, browser safe: the six statuses of `0039`, the rank machine, the four statuses a provider may write, the two role lists, the two windows, the reason and note bounds, the hundredths-to-minor conversion, twenty rules and five audit actions |
| `services/disputes/dispute-events.ts` | new | The neutral `DisputeEvent` and the registry of providers this build receives dispute deliveries from — one entry, Stripe Connect — with Stripe's reader, its status mapping and its signature verdict |
| `services/disputes/dispute.ts` | new | The projection and the guarded write: `listCompanyDisputes`, `listDisputeQueue`, `findDisputePayment`, `findDisputeProvider`, `findDisputeByProcessorId`, `applyDisputeEvent`, the versioned move and the chain entries |
| `services/disputes/dispute-webhook.ts` | new | The receiver: body ceiling, signature before any database read, the event row as the idempotency claim, the payment resolution, the effect, the settled outcome, and the audit of every refusal |
| `services/disputes/dispute-runtime.ts` | new | The production wiring: `getAuthRuntime()`'s REST client, signing chain and settings reader, plus a clock |
| `services/disputes/dispute-verify.ts` | new | The gate, 265 checks, over a PostgREST fixture that enforces `0039`'s and `0032`'s triggers, plus twelve mutations |
| `app/api/webhooks/stripe/disputes/route.ts` | new | `POST` — the provider's callback, raw body, no session, no token |
| `app/api/payments/disputes/route.ts` | new | `GET` the merchant's own disputes |
| `app/api/office/disputes/route.ts` | new | `GET` the platform's deadline queue |
| `app/(dashboard)/payments/disputes/page.tsx` | new | The merchant's list |
| `app/(admin)/office/disputes/page.tsx` | new | The office deadline queue |
| `lib/i18n/strings/en.ts` | edited | 36 strings in one `disputes` group, shared by both screens |
| `lib/auth/verify.ts` | edited | The CSRF inventory learns the one documented exception: a provider callback carries a signature, not a token |
| `scripts/verify-audit.mjs` | edited | `IDENTITY_PRIMITIVES` gains `receiveDisputeWebhook`, so the machine-to-machine route's identity check is the signature verification it actually performs |

**No migration.** `0039_disputes.sql` already carries the table, the six statuses, the deadline arithmetic
(`response_due_at > opened_at` and `<= opened_at + make_interval(hours => response_window_hours)`), the evidence
rule (`submitted_at is null or evidence_ready`, and `evidence_submitted` requires it), the resolution pair
(`won`/`lost`/`closed` exactly when `resolved_at` exists, with a note), the unique index
`disputes_processor_key (company_id, processor_dispute_id)`, the deadline index and both triggers.
`0032_webhook_events.sql` already carries the delivery log: unique `(provider_id, mode, external_event_id)`, the
payload hash instead of the body, `signature_ok` tied to the states that claim the platform acted, and a
forward-only status. The gate reads both files and asserts each of those clauses, and asserts the highest
migration is still **123**.

## The one write: how a delivery moves a dispute

```
open ──▶ under_review ──▶ won | lost | closed
  └──────────────────────────▶ won | lost | closed
```

`evidence_submitted` is **not** a provider status. Section 19 gives it to the compliance desk (`compliance_kyc`
sends the pack), and `0039` refuses a submission without an evidence pack — so a delivery that says "the
processor is reviewing" moves a row to `under_review` and can never claim the pack was sent.

The five guards, in the order `applyDisputeEvent` asks them:

1. the delivery must ask for a status, and for one a provider may write;
2. it must name the processor's dispute id, because that is the idempotency key;
3. the amount must be positive whole minor units and the currency must be the payment's;
4. the row must not be decided, and must not already be at or past the status asked for;
5. the update must carry the status and version it read, and is read back afterwards — a lost race is
   `dispute_moved`, never a silent success.

## What the gate proves

| Behaviour | Evidence |
| --- | --- |
| A verified opening writes one row | `charge.dispute.created` → `200 opened`, status `open`, amount `200000` (20.00 USD at four decimals), `fee_minor` **0**, `evidence_ready` false, window 24, deadline exactly one window after `opened_at`, event row `processed` with the merchant and the instant |
| `opened_at` is the processor's instant, not the delivery's clock | the body's `created` is an hour before the delivery, and the row carries the earlier instant |
| One dispute, one row | the same delivery again is `200 duplicate` with no second dispute and no second event row; a *different* event for the same dispute finds the row |
| The status only moves forward | `updated` → `under_review` (version 2); a second `under_review` → `ignored`/`dispute_status_stale` with the version unchanged; a replayed `created` → `ignored`/`dispute_status_stale` |
| A decided dispute stays decided | `closed`/`lost` stamps `resolved_at` and an outcome note; a later `updated` → `ignored`/`dispute_resolved` and the decision stands |
| A forged body never reaches the database | `401`/`webhook_signature_invalid`, no event row; a signature an hour old is outside STEP 161's tolerance; a body past the ceiling is `413`; an empty body is `400` |
| No secret, no trust | an endpoint with no configured secret answers `503`/`webhook_secret_missing`, and the verifier never hands the secret back to its caller |
| A verified body of another type is acknowledged | `payment_intent.succeeded` → `200 ignored`, recorded, no dispute |
| A withdrawal is not a decision | `charge.dispute.funds_withdrawn` → `200 ignored`, event row `ignored`, no status change: the money is a ledger STEP's |
| A payment this database does not have yet is retryable | `500`, event row `failed` with the rule; after the payment lands the **same** event id is reprocessed (not deduplicated) and opens the dispute |
| The tenant is the payment's | a currency mismatch writes no dispute (`200 unmatched`/`dispute_currency_mismatch`); another merchant reads none of the rows |
| The read side is scoped and ordered | merchant list = own rows newest first (`owner` only); office queue = every merchant, **undecided only**, nearest deadline first, for each of the four office roles; `PERMISSION_DENIED` for the merchant role |
| Every act is in the chain | `dispute.opened`, `dispute.status_changed`, `dispute.webhook_ignored`, `dispute.webhook_rejected`; `from`/`to` on a move, the `webhook_event_id` that caused it, no person, no session, no body |
| Nothing here writes money | no `payments` write, no ledger call, `fee_minor` only ever the column's default |
| The screens are the same service | both pages call `listCompanyDisputes`/`listDisputeQueue`, neither has a client component, and every `disputes.*` key they use exists in the catalogue |
| The layout survives a phone | one column at 360, the term list becomes two columns from `sm:`, badges wrap, long processor ids `break-words`, no pixel width anywhere |

Twelve mutations were run against the gate and all twelve turned it red: forward-only made inclusive; the
resolved guard removed; the signature check replaced by `ok: true`; `failed` events deduplicated; the window
written as 48; the merchant list losing its tenant filter; the amount scale off by a hundred; `evidence_submitted`
made provider-writable; the opening instant taken from the delivery clock; the queue including decided rows; the
currency check removed; the fee column filled from the provider.

## Security

- **Validation** — the body is read as raw text (the signature is over the bytes), capped at 1 MiB, parsed by a
  zod envelope that is `looseObject` at the provider's edges and strict on the fields this platform acts on; a
  body that is not the documented envelope is `400` and writes nothing.
- **RLS** — no table is touched outside `public.disputes`, `public.webhook_events`, `public.payments` (read) and
  `public.payment_providers` (read). All four are default-deny in `0032`/`0037`/`0039`/`0029`; the service role
  is the only reader, and every statement is tenant-scoped where a tenant exists.
- **Audit** — four actions, one per kind of act, written through `appendTolerated` so a chain outage never drops
  a processor's event; the payload carries ids, statuses and rules, never the body, the signature or the secret.
- **Permissions** — `owner` for the merchant list (own company only), `ceo`/`compliance_kyc`/`finance_ops`/
  `super_admin` for the queue. The callback route has no session by design: its identity check is the HMAC over
  the raw body against a secret held in `platform_settings`, verified **before** the first database read.
- **Gate agreements** — `scripts/verify-audit.mjs` already exempted `app/api/webhooks/` from the CSRF rule; this
  STEP taught `lib/auth/verify.ts` the same exception and made it assert the substitute (the route must name the
  receiver and must **not** carry a token guard), so the two gates can no longer contradict each other.

## Verification

| Gate | Result at this commit |
| --- | --- |
| `services/disputes/dispute-verify.ts` | **passed, 265 checks** (twelve mutations, all red) |
| `scripts/verify-audit.mjs` | passed, 4037 checks |
| `scripts/verify-structure.mjs` | passed, 14 root files, 714 source files |
| `lib/i18n/verify.ts` | passed, 2898 messages, 298 placeholders |
| `scripts/verify-shell.mjs` | passed, 1051 checks, 336 files |
| `migrations/verify.ts` | passed, 3593 checks, 123 migrations, 92 tables |
| `services/payments/refund-verify.ts` | passed, 259 checks |
| `services/payments/refund-execution-verify.ts` | passed, 141 checks |
| `services/payments/refund-fee-verify.ts` | passed, 213 checks |
| `lib/errors/verify.ts` / `lib/logger/verify.ts` / `lib/jobs/verify.ts` / `config/verify.ts` / `lib/env` / `scripts/verify-lint-rules.mjs` | passed |
| `tsc --noEmit`, `eslint .`, `next build` | clean, compiled |
| **Pre-existing red (unchanged, proven by diffing against a worktree of `888376b`)** | `lib/auth/verify.ts` 1, `lib/security/verify.ts` 3, `components/office/verify.ts` 13 |

### Exercised on a running server

`next dev` on `0.0.0.0:3000` with the placeholder environment (no database in this sandbox):

| Request | Answer |
| --- | --- |
| `GET /payments/disputes` | `200`, the page renders, the signed-out state is a sentence rather than an empty table, and the `Refund desk` link points at `/payments/refunds` |
| `GET /office/disputes` | `307` to `/signin` from the office layout — the same answer `/office/refunds` gives, so the new screen inherits the office guard rather than weakening it |
| `GET /api/payments/disputes`, `GET /api/office/disputes` | `401` with the platform's envelope (`AUTHENTICATION_REQUIRED`) |
| `POST /api/webhooks/stripe/disputes` (empty body) | `400 {"received":false,"rule":"webhook_body_invalid"}` |
| `POST /api/webhooks/stripe/disputes` (a body, no database) | `503 {"received":false,"rule":"webhook_secret_missing"}` — the secret is read from settings and cannot be opened here |
| structured log | `dispute webhook refused` carries `rule`, `status`, `bodyBytes`, the route and the provider key only — no body, no signature header, no secret |

The happy path cannot be walked against a live server in this sandbox because there is no Supabase project;
it is exercised end to end against the fixture in the gate, which enforces `0039`'s and `0032`'s triggers.

## Carried gaps (not this STEP's, and named rather than hidden)

1. **Four providers without a dispute reader.** `DISPUTE_EVENT_SOURCES` has one entry. NMI, Payoneer, Rainforest
   and Airwallex dispute deliveries are refused with `404 webhook_provider_unsupported` — honest, and the same
   shape the refund adapters have for the providers that cannot refund. Rainforest's signature constant is still
   `RAINFOREST_WEBHOOK_SIGNATURE_CONFIRMED = false` in its own adapter, and Airwallex's dispute body is not
   described in `PROVIDER_DOCS.md`.
2. **The payment join needs `payments.provider_transaction_id`.** Nothing in this repository writes it yet (the
   capture path that does is a later STEP's, and `refund-execution.ts` reads the same column). A delivery for a
   payment that has no reference lands as `failed`/`dispute_payment_not_found` and is retried by the processor.
3. **No scheduler.** The 24-hour deadline is a column and a printed state; STEP 196's warning emails and any
   escalation job are later. Nothing re-reads a `processing` event row on a timer, so a crash in the middle of
   one delivery waits for the processor's own retry (which does re-run it).
4. **No response form and no evidence pack** — STEP 195/198. `evidence_ready` is always false on the rows this
   STEP writes, and `response_text` is always null.
5. **The chargeback fee is 0.** Section 18's fee is `super_admin`'s number (the column's own comment says so);
   filling it from the processor's `balance_transactions` would be a second writer of a money column with a
   different meaning. The ledger posting of the withdrawal is a later STEP's, so `funds_withdrawn` is recorded
   and ignored.
6. **No navigation entry** for `/payments/disputes` or `/office/disputes` — the merchant area has no shell of
   its own in this build, and the office navigation catalogue is a later STEP's. The refund screens (191-193) are
   in the same position; both new pages link to their refund counterpart so they are reachable from each other.
7. **No disputes list on the payment detail screen**, and no filter by status or date: this STEP lists the
   merchant's rows and the office's deadlines, which is what §19 asks for first.
