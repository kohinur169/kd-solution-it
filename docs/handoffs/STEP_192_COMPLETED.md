# STEP 192 — Refund execution through the originating provider

Status: **complete**. One commit, `STEP 192: Refund execution through the originating provider`, on
`arena/ca936761-kd-solution-it`, branched from STEP 191's `dea97d9`. Typecheck, lint and build are clean, and the
STEP's own gate is `services/payments/refund-execution-verify.ts` at **141 checks**, mutation-checked with ten
mutations.

## STEP

From `docs/final/STEP_PLAN_250.md`:

> **STEP 192: Refund execution through the originating provider**
> Sub-step 4: the core service and logic for refund execution through the originating provider.

FEATURE_LIST §19: *"Refund interface: request, approval and status tracking."* STEP 191 built the request, the
approval and the tracking of a decision; this STEP is the sentence that was still missing from that interface -
the money actually going back, through the provider that took it - and the status that says so.

Eight sub-steps, all done. Sub-step 3 is a checked **proof that no migration is needed**, and it is short because
`0038` was written for the whole lifecycle, including the two statuses this STEP is the first to write.

## Owned paths

| Path | State | What it holds |
| --- | --- | --- |
| `services/payments/refund-execution-fields.ts` | new | The vocabulary: the one executable status, five provider outcomes, ten rules, six audit actions, the detail/provider-id/reference limits, the body ceiling, the timeout, and the amount conversion |
| `services/payments/refund-provider.ts` | new | The port: `RefundProviderTarget`, `RefundProviderOutcome`, `RefundProviderPort`, the port registry and `REFUNDING_PROVIDER_KEYS = ["nmi"]` |
| `services/payments/refund-nmi.ts` | new | NMI's refund port, built from the adapter's own request builder, answer reader, transport and endpoints |
| `services/payments/refund-execution.ts` | new | `executeRefund`: the eight checks before a row moves, the two writes around the call, and one chain entry per step |
| `services/payments/refund-execution-runtime.ts` | new | The production wiring: the sealed key from `provider_keys`, opened with the gateway runtime's cipher, and the one port this build has |
| `services/payments/refund-execution-verify.ts` | new | The gate, 141 checks, over a fixture that enforces `0037`'s and `0038`'s triggers |
| `app/api/office/refunds/[id]/execute/route.ts` | new | The desk's execution: CSRF, ceiling, session, device proof, service |
| `app/(admin)/office/refunds/refund-execution-form.tsx` | new | The one button an approved refund carries, signed by the enrolled device |
| `app/(admin)/office/refunds/page.tsx` | edited | The queue now shows the sent instant, the provider's reference and the provider's answer, and offers execution on `approved` rows |
| `services/payments/refund.ts` | edited | Four things exported, not changed (see below) |
| `lib/i18n/strings/en.ts` | edited | 17 strings: the button, the four outcomes, six refusals, three row labels |
| `lib/security/csrf.ts` | edited | The execute route added to `CSRF_PROTECTED_PATHS` |
| `lib/auth/verify.ts` | edited | One browser file and one call site added to the scan's counts |
| `app/(dashboard)/payments/refunds/refund-console.tsx` | edited | Its header comment only: it named a field that never existed, and now says where a refund's provider reference lives and why the merchant screen does not print it |

`migrations/`, `lib/payments/` and `lib/payments/adapters/` are **untouched**: `0038` already carries the
lifecycle, and NMI's request builder, answer reader, transport and endpoints are imported rather than edited.

**Four exports, no behaviour change, in `services/payments/refund.ts`:** `REFUND_ROW_COLUMNS`,
`refundRowSchema`, `RefundRow`, `viewOf`, `findRefund`, `moveRefund` and `appendTolerated` were made public so that
this STEP reuses STEP 191's tenant read, its projection and - above all - its versioned guarded write. A second
copy of that guard is exactly how one caller ends up able to move a row another caller cannot, and the gate
asserts the execution service calls `findRefund` and `moveRefund` rather than re-implementing them.

## The database sub-step: none is needed, and here is the proof

1. **`0038` already names the three statuses this STEP writes.** `processing` is defined by
   `refunds_status_check`; `succeeded` requires `processed_at` **and** `provider_refund_id`
   (`refunds_processed_check`, `refunds_provider_required_check`); `failed` requires `processed_at` **and**
   `failure_detail` of 1-280 trimmed characters (`refunds_failure_check`). This STEP writes exactly those
   combinations and the gate's fixture refuses anything else - which is how three of the ten mutations were
   caught by the database's rules rather than by an assertion.
2. **The payment's refunded total is the database's, not this STEP's.** `refunds_sync_payment` writes
   `payments.refunded_minor` and the `partially_refunded`/`refunded` status from the `succeeded` rows, and
   `payments_guard_refund_state` refuses any other writer. The gate proves the payment reaches
   `partially_refunded` with 20.00 and then `refunded` with the whole amount **while the service wrote no payment
   row at all** (`paymentWrites` is empty, and one mutation that added such a write failed the gate).
3. **Everything the call needs is already on the payment.** `0037` carries `provider_id`, `provider_key_id`,
   `mode`, `provider_transaction_id`, `amount_minor`, and the currency; `0029`/`0094` carry the provider keys and
   the sealed credential (`provider_keys.key_ciphertext`/`key_iv`/`key_tag`/`key_fingerprint`). No column, no
   index and no constraint is added.
4. **`0123` stays free.** The gate counts `migrations/` and asserts the highest forward file is still `0122`.

## The one act, in the order it happens

`executeRefund` refuses **before** any row moves, then writes, then calls, then records. The eight refusals:

| Guard | Rule | Why it is before the call |
| --- | --- | --- |
| `finance_ops`/`super_admin` only | `PERMISSION_DENIED` | A merchant asked for the refund; a desk sends it, exactly as a desk decided it. |
| the refund exists, platform-scoped | `refund_not_found` | The desk executes for every merchant, so the row carries the tenant rather than the caller. |
| status is `approved` | `refund_not_executable` | `requested` has no decision, `processing` is already being executed, and `succeeded`/`failed`/`cancelled` are history. |
| the payment exists in the refund's company | `payment_not_found` | Where the provider route lives. |
| the `payment_providers` row exists | `refund_provider_not_found` | The provider is the database's word, not a guess from a string. |
| this build has a port for it | `refund_provider_unsupported` | Four of the five providers are a stated gap; the refund stays `approved`, money untouched. |
| the payment names a provider transaction | `refund_provider_reference_missing` | There is nothing to refund against. |
| the amount is a whole number of cents | `refund_amount_unrepresentable` | Refused where a person can fix it, not after a rounded amount reaches a network. |

Then the row moves to `processing` **before** the call, because a call takes time: a desk that refreshes can see
the attempt, a second operator cannot re-send it, and a process that dies mid-call leaves a `processing` row
rather than an `approved` one that looks untouched. The answer is recorded by a second guarded write on
`processing` and on the version the caller read.

**The five answers, and the four statuses they land on:**

| Provider answer | Row | Written | Chain |
| --- | --- | --- | --- |
| accepted, with its own id | `succeeded` | `provider_refund_id`, `processed_at` | `refund.processing`, `refund.succeeded` |
| declined | `failed` | `failure_detail` (≤ 280, trimmed), `processed_at` | `refund.processing`, `refund.failed` |
| accepted, settles later | `processing` | its identifier, if it gave one | `refund.processing`, `refund.provider_pending` |
| never answered | `processing` | nothing | `refund.processing`, `refund.provider_unanswered` (`retry: "manual"`) |
| not sent at all | back to `approved` | nothing | `refund.processing`, `refund.execution_refused` (with the rule) |

`unanswered` is the honest middle: a call that timed out may or may not have moved money, so calling it `failed`
would invite a retry that could pay twice. `not_sent` is the honest return: no provider was asked, so the refund
goes back to the desk, who fixes the key and presses again - the same refund, the same chain, no new request.

## The originating provider, concretely

A refund is not routed: it goes back the way the money came. `executeRefund` therefore reads the route `0037`
recorded - `provider_id`, `provider_key_id`, `mode`, `provider_transaction_id` - and never asks the routing
engine anything. The provider key comes from `payment_providers.provider_key`; the **key** comes from
`provider_keys`, in this order:

1. `payments.provider_key_id`, the exact key that signed the original call;
2. the newest **active** key for the payment's provider and mode, when no originating key was recorded.

The sealed box is opened by `lib/gateways/runtime.ts`'s `secrets.open` - the repository's one AES-256-GCM cipher -
under the gateways service's own context formula, `provider_keys:{providerKey}:{mode}:{fingerprint}`. The gate
reads both source files and asserts the two formulas agree, so a later change to the gateways service cannot
silently break refunds. A box that will not open, or no key at all, is `refund_provider_key_missing`: nothing is
sent and the refund returns to `approved`.

**NMI only, and stated.** `REFUNDING_PROVIDER_KEYS = ["nmi"]`. NMI's classic API has a `type=refund`
transaction, so the port is a composition of four existing pieces: `buildNmiRequest` (which writes
`security_key`, `type=refund`, `transactionid` and `amount`), `executeNmiTransaction` (which reads
`response`/`response_code`/`responsetext`/`transactionid`), `nmiFetchTransport` (the adapter's real HTTP) and the
adapter's two endpoints - `secure.nmi.com` for `live`, `sandbox.nmi.com` for `test`, chosen by the **payment's**
mode. Stripe, Airwallex, Rainforest and Payoneer have no refund path in this build and refuse with
`refund_provider_unsupported` before a status moves.

## Security

| Concern | Where it is answered |
| --- | --- |
| Permission | `finance_ops` / `super_admin`, the two roles that may decide a refund; a merchant holding `owner` is refused, which the gate checks against a real merchant actor. |
| CSRF | `requireCsrfToken` first, before the body and before the session; the route is on `CSRF_PROTECTED_PATHS`; the smoke test shows an unauthenticated POST answering `422 {field: "csrf", rule: "csrf_token_invalid"}`. |
| Device proof | `verifySensitiveRequest` + `requireTrustedDevice` over the exact bytes, because this act makes money leave. Same guard as an approval and as the payout execution. |
| Validation | The route takes no field: a body over 512 bytes is `PAYLOAD_TOO_LARGE`; the amount is converted with integer arithmetic and refused when it is not a whole cent; the failure detail is cut to 280 and never empty; the provider identifier is bounded by `refunds_provider_id_check`. |
| Tenancy | The refund is read platform-scoped (a desk acts for every merchant) and the **payment** is read `company_id=eq.{refund.company_id}`, so a refund whose payment moved tenant is `payment_not_found` rather than a cross-tenant call. |
| Secrets | The provider key is opened for the length of one call and lives in no dependency object, no log line and no audit payload; the chain records the provider key's *name* and the amount, never a credential. |
| Replay and double execution | The status is the lock: `approved` moves to `processing` in one guarded write, and every later execution is `refund_not_executable`. A pending refund cannot be sent twice either (the gate proves one provider call). |
| Audit | Six actions under entity `refund`, each carrying `payment_id`, amount, currency, the provider, and the answer's own facts; written tolerantly, so a chain that is down never blocks money. |
| Failure mode | A port that throws becomes `unanswered`, not `INTERNAL_ERROR`; an unreadable provider row is `503`; a missing key is `approved` again; nothing here writes `payments.refunded_minor`, which one mutation tried and the gate caught. |
| RLS | Unchanged: no table is added or altered, and the runtime reads `provider_keys` and `payment_providers` the way the gateways service does - platform rows, default-deny for anyone else. |

## The gate

`node services/payments/refund-execution-verify.ts` - **141 checks**, in ten sections, over a PostgREST fixture
that enforces `refunds_guard_amount`, `refunds_approval_check`, `refunds_processed_check`,
`refunds_provider_required_check`, `refunds_failure_check` and `refunds_sync_payment`, and that records every
write to a payment row:

- **the vocabulary**: five outcomes, ten distinct rules, six audit actions in the column's alphabet, the 280 and
  512 limits, `["nmi"]` inside the registry's keys, and the port registry answering null for what it does not
  have;
- **the amount**: five conversions and three refusals, and four `failureDetailOf` cases (trim, fallback, the
  280 cut, the visible ellipsis);
- **the NMI port on its own**: a recording transport, the live and sandbox endpoints chosen by mode, the exact
  payload (`type=refund`, `transactionid`, `amount`, `orderid`, `security_key`, and no `payment_token`), an
  accepted answer with its id, a network refusal carrying NMI's code and words, a transport failure as
  `unanswered`, an acceptance with no id read as a refusal, no key as `not_sent`, and a request NMI's own
  validator refuses as `not_sent`;
- **who may execute**: a merchant refused, an unknown refund not found, and five statuses (`requested`,
  `processing`, `succeeded`, `failed`, `cancelled`) each refused with no provider called;
- **the route it took**: a Stripe payment refused as unsupported and left `approved`, an unknown provider key
  refused the same way, a payment with no provider transaction refused, and an amount of 12.3456 refused before
  the call;
- **a refund that succeeds**: the target's seven fields, two chain entries in order, the payment moving to
  `partially_refunded` with its total written **by the sync**, and a second refund taking it to `refunded`;
- **a decline**: `failed` with the provider's trimmed words, the instant, two entries, and the payment untouched;
- **pending and unanswered**: both left in `processing` with no `processed_at`, the pending one carrying its
  identifier, the unanswered one carrying no detail, both refusing a second execution after exactly one call;
- **not sent**: back to `approved`, the refusal rule in the chain, and no money moved;
- **the sources**: CSRF, device proof, `no-store` and the CSRF inventory on the route, the service writing no
  `refunded_minor` and no `platform_fee_returned`, the reuse of `findRefund`/`moveRefund`, the NMI port's use of
  the adapter's four pieces, the runtime's `provider_keys` read and the two matching context formulas, the queue
  offering execution only on `approved`, the form signing its bytes, and migration `122` still the highest.

**Mutation-checked, ten mutations, ten caught:**

| Mutation | What caught it |
| --- | --- |
| any status is executable | the `requested` refund test (`refund_approval` instead of `refund_not_executable`) |
| the row is not marked `processing` first | "and the refund is left in processing (expected processing, got approved)" |
| a decline is recorded as a success | `refunds_failure_check` refused the row |
| the failure detail is not cut to the column | "never longer than the column (expected 280, got 400)" |
| `not_sent` leaves the row `processing` | "the refund is approved again (expected approved, got processing)" |
| unanswered is called failed | "the refund is left in processing (expected processing, got failed)" |
| amounts are rounded to the cent | "an amount that is not a whole number of cents is refused (got 123.45)" |
| the service writes the payment total | "this STEP wrote no payment row at all (expected 0, got 1)" |
| the port always uses the live endpoint | "the sandbox endpoint in test mode" |
| the desk role is not required | "a merchant cannot execute a refund (nothing was thrown)" |

## Desktop and mobile widths

The queue row grows by three optional lines and one button, and all of them use the page's existing shapes: the
sent instant, the provider's reference and the provider's answer are `bodyClasses` paragraphs that wrap, and the
answer reuses the row's `whitespace-pre-wrap break-words` reason block, so a 280-character NMI message wraps
rather than pushing the page sideways. At 360 px the execution button sits under the reason block on its own line
with its hint text beside it (both in a `flex-wrap` row), exactly where the decision buttons sit for a `requested`
row; at 1440 px the same row is unchanged in width, because the queue is a `max-w-3xl` column at every width and
nothing new is fixed-width. The merchant console is unchanged in behaviour by this STEP - its one edit is the header comment - so its two
widths are STEP 191's.

## Verification

| Command | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npm run lint` | clean |
| `npm run build` | compiled; `/api/office/refunds/[id]/execute` is dynamic (`ƒ`) |
| `node services/payments/refund-execution-verify.ts` | **141 checks** |
| `node services/payments/refund-verify.ts` | 256 checks (256 rather than 253: the queue page's three new labels are catalog keys that gate also checks) |
| `npm run check:structure` | 695 source files (was 687) |
| `npm run check:audit` | 3918 checks (was 3869) |
| `npm run check:i18n` | 2826 messages (was 2809) |
| `npm run check:shell` | 1028 checks, 327 files |
| `npm run check:migrations` | 3572 checks, 122 migrations, 92 tables |
| `npm run check:lint` / `check:errors` | 77 / 202 checks |
| `npm run check:config` / `check:env` / `check:logger` / `check:jobs` | 10 / 16 / 117 / 110 |
| `node lib/auth/verify.ts` | 1 problem, the same pre-existing dialers equality (see below) |
| `node lib/security/verify.ts` | 3 problems, the same pre-existing three STEP 191 recorded |

### Runtime smoke, against `next dev`

| Probe | Answer |
| --- | --- |
| `POST /api/office/refunds/5f00/execute` | `422 VALIDATION_FAILED`, `{field: "csrf", rule: "csrf_token_invalid"}` - the token is the first guard |
| `POST` with a 2 000-byte body | `422` (the token is still first, then the ceiling) |
| `GET /office/refunds` | `307 → /signin`, the office shell's own refusal |
| `GET /payments/refunds` | `200`, the merchant console unchanged |

### The three gates that were red before this STEP

Unchanged and still named rather than silently absorbed: `lib/security/verify.ts` (a dotted audit-action literal
somewhere in the tree, and `nmi-client.ts` naming an encryption algorithm beside the two modules allowed to),
`lib/auth/verify.ts`'s one remaining problem (eighteen provider adapters calling `fetch(` outside the guarded
transport), and `components/office/verify.ts` (its expected screen list is still twelve while the catalog holds
thirteen). None of them is refund code and none was made worse; the auth gate's route inventory and browser counts
were updated for this STEP's route and form, and the CSRF inventory is exact again.

## What is genuinely unfinished

1. **Four providers have no refund path.** Stripe, Airwallex, Rainforest and Payoneer refunds are refused with
   `refund_provider_unsupported` and left `approved`. Each is a port factory against its own adapter - the shape
   is fixed by this STEP and nothing else changes when one lands.
2. **A `pending` refund has no reconciler.** The row stays `processing` with the provider's identifier, and
   nothing polls the provider for the answer yet. NMI's classic refund API answers in-line, so this build never
   produces a `pending` row - the shape is there for the next provider that needs it.
3. **An `unanswered` call is reconciled by hand.** The row stays `processing` and the chain says `retry:
   "manual"`. Automating that check needs a provider status query per provider, which is the same gap as (2).
4. **No retry, no queue.** Execution is the desk's click, not a worker: an approved refund waits until somebody
   sends it. A background executor is a reasonable later STEP and needs a claim on the row this one already
   models (`processing` is the claim).
5. **The platform fee on a refund is still STEP 193's.** `platform_fee_returned` stays `false` and
   `platform_fee_returned_minor` stays `0`; this STEP deliberately does not read the super administrator's
   setting.
6. **No office navigation entry for `/office/refunds`.** Unchanged from STEP 191: the navigation and its gate are
   another STEP's, and the gate is red on that list already.

## Left for the STEPs after this one

- STEP 193: the platform fee rule on a refund, read from the super administrator's setting, written to
  `platform_fee_returned` / `platform_fee_returned_minor`.
- The other four providers' refund ports, a reconciler for `processing` refunds, and §19's dispute half.
