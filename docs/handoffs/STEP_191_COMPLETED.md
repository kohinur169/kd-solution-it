# STEP 191 — Refund request and approval flow

Status: **complete**. One commit, `STEP 191: Refund request and approval flow`, on
`arena/ca936761-kd-solution-it`, branched from STEP 190's `49c2e55`. Typecheck, lint and build are clean, and the
STEP's own gate is `services/payments/refund-verify.ts` at **253 checks**, mutation-checked.

## STEP

From `docs/final/STEP_PLAN_250.md`:

> **STEP 191: Refund request and approval flow**
> Sub-step 4: the core service and logic for the refund request, its approval and its status tracking.

FEATURE_LIST §19, first line: *"Refund interface: request, approval and status tracking."* §19's last line:
*"Every refund and dispute action is audit logged."* §18's fee rule - *"Whether the platform fee is returned on a
refund is set by super_admin"* - is **STEP 193's**, so this STEP stops at the decision and never touches the fee
columns' meaning.

Eight sub-steps, all done. Sub-step 3 is a checked **proof that no migration is needed**, written out below, in the
service's header and asserted by the gate.

## Owned paths

| Path | State | What it holds |
| --- | --- | --- |
| `services/payments/refund-fields.ts` | new | The vocabulary, browser safe: six statuses, three live ones the cap counts, three open ones the queue shows, the four refundable payment statuses, the two role lists, twelve rules, four audit actions, the reason/note bounds, two body ceilings, two list ceilings, three body parsers and the headroom arithmetic |
| `services/payments/refund.ts` | new | `requestRefund`, `decideRefund`, `cancelRefund`, `readRefund`, `listRefunds`, `listRefundQueue`, `listRefundablePayments`, the guarded write, the headroom reads and the audit payloads |
| `services/payments/refund-runtime.ts` | new | The production wiring: `getAuthRuntime()`'s REST client and signing chain, plus a clock - and no provider, because this STEP moves no money |
| `services/payments/refund-verify.ts` | new | The gate, 253 checks, over a PostgREST fixture that enforces `0038`'s triggers |
| `app/api/payments/refunds/route.ts` | new | `POST` the merchant's request, `GET` the merchant's own refunds |
| `app/api/payments/refunds/[id]/cancel/route.ts` | new | The merchant's withdrawal |
| `app/api/payments/route.ts` | new | `GET` the payments that can still take a refund, with the headroom on each |
| `app/api/office/refunds/route.ts` | new | `GET` the platform's approval queue |
| `app/api/office/refunds/[id]/decision/route.ts` | new | Approve or reject, behind a device proof |
| `app/(dashboard)/payments/refunds/page.tsx` | new | The merchant desk's shell |
| `app/(dashboard)/payments/refunds/refund-console.tsx` | new | The merchant desk: pick a payment, ask, follow the status, withdraw while nobody has decided |
| `app/(admin)/office/refunds/page.tsx` | new | The finance desk's queue |
| `app/(admin)/office/refunds/refund-decision-form.tsx` | new | Two buttons and a note, signed by the enrolled device |
| `lib/i18n/strings/en.ts` | edited | 63 strings in one `refunds` group, shared by both screens |
| `lib/security/csrf.ts` | edited | Six routes added to `CSRF_PROTECTED_PATHS`: this STEP's three and the three STEP 190 left out |
| `lib/auth/verify.ts` | edited | The browser-mutation scan now counts client components only (see *Two gates were already red*) |

`migrations/`, `lib/payments/`, `lib/auth/audit.ts`, `lib/auth/rest.ts` and `lib/approvals/` are untouched: STEP
037's CSRF, STEP 111's REST client and STEP 070's approval chain are imported, never edited.

## The database sub-step: none is needed, and here is the proof

1. **`0038_refunds.sql` already carries the whole lifecycle.** It creates `public.refunds` with the six statuses -
   `requested`, `approved`, `processing`, `succeeded`, `failed`, `cancelled` - and the columns this STEP writes:
   `amount_minor`, `currency`, `reason`, `requested_by`, `approved_by`, `decided_at`, `version`. The gate reads the
   file and asserts each of the pieces it relies on, by name.
2. **The database already enforces the rules this service checks again.** `refunds_guard_amount` refuses a refund of
   money that was never captured, one in another currency, one against another merchant's payment and one that
   would take the live refunds past what was charged; `refunds_approval_check` makes `approved_by` and `decided_at`
   exist exactly on the statuses that follow a decision (and **not** on `requested`/`cancelled`);
   `refunds_processed_check` ties `processed_at` to `processing`/`succeeded`/`failed`; `refunds_provider_required_check`
   makes a `succeeded` refund name the processor's own id; `refunds_sync_payment` is the only writer of
   `payments.refunded_minor`, guarded by `pg_trigger_depth() < 2`. A migration here would be a second copy of a
   decision already made.
3. **Nothing is added to `payments` either.** `0037`'s `refunded_minor`, `platform_fee_minor` and the
   `partially_refunded`/`refunded` statuses are what the sync writes; this STEP reads them and writes none of them,
   and the gate asserts the service names `refunded_minor` four times - three reads and one sentence of prose - and
   never in a write.
4. **`0123` stays free.** The gate counts `migrations/` and asserts the highest forward file is still `0122`, so the
   next STEP that needs a table finds the number it expects.

## The three acts

### 1. The merchant asks

`requestRefund` checks, in this order: the role (`owner`, the same role that manages an invoice and a payment
link), the tenant from the session (**never** from the body), the body (`payment_id`, `amount`, `reason`, strict and
trimmed, 2 048 bytes checked against the declared length *and* the bytes), then the payment, read company-scoped, so
another merchant's payment is `404 payment_not_found` rather than a `403` that confirms it exists.

A payment is refundable when it is `captured`, `settled` or `partially_refunded`; `refunded` answers
`nothing_to_refund` and anything else - `pending`, `authorized`, `failed` - answers `payment_not_refundable`. The
amount goes through STEP 106's `priceToMinor` (no float ever touches money), then two refusals: zero or a fraction of
a minor unit is `amount_too_small`, and anything past the headroom is `exceeds_refundable`.

**The headroom is the whole of the arithmetic this STEP owns**: the charge, less every refund that is
`approved`/`processing`/`succeeded` (the same three the database's cap counts), less every refund still
`requested`. Counting the promises is what stops two merchants - or one merchant on two tabs - from asking for the
same money twice and leaving the approval desk to discover it. The gate proves both halves: two requests that
together exceed the charge answer `exceeds_refundable` on the second, and after a *decided* refund and a *waiting*
one the screen prints the remainder once, not twice.

The row is written as `requested` with the payment's own currency and the caller's id, and the response is `201`.
One audit entry, `refund.requested`, names the payment, the amount, the currency, the status, the headroom that was
left and **the length of the reason, not the reason** - a merchant's words about their own money stay on the row.

### 2. The finance desk decides

`decideRefund` requires `finance_ops` or `super_admin`, reads the refund by id with no tenant scope (a desk decides
for every merchant, and the row carries its own `company_id`), and refuses in four ways before it writes: the refund
is not `requested` (`refund_not_pending` - somebody already decided), the caller raised it (`refund_self_decision`,
the four-eyes rule at the one desk where a person's own id can be checked), the payment is gone, and - for an
approval - **the headroom re-checked against everything except this row**, because an approval may have landed
between this request and this decision.

An approval writes `status: approved`, `approved_by` and `decided_at` in one guarded update; a rejection writes
`status: cancelled` and nothing else. That asymmetry is `0038`'s, not a shortcut: the row has no `rejected` status,
`cancelled` is where a refund refused by a person lives, and `failed` is reserved for the processor's own answer
and the instant it arrived. Two audit actions say which of the two happened: `refund.approved` and
`refund.rejected`, the latter carrying `recorded_as: "cancelled"` so a reader of the chain is never told a refund
failed when a person refused it.

### 3. The merchant withdraws

`cancelRefund` is the merchant's own act on the merchant's own row, and only while it is still `requested`: an
approved refund is money the platform has promised, and a decided one is history, so both answer
`refund_not_pending`. It writes `cancelled` and appends `refund.cancelled` with `by: "merchant"`, which is what
tells a withdrawal apart from a rejection when both end on the same status.

### The guarded write, and what it buys

Every move is `PATCH …?id=eq.{id}&status=eq.{read status}&version=eq.{read version}`, followed by a read-back that
has to show the status that was asked for, the next version, and - where the row can carry one - the caller's own
mark. An approval's mark is `approved_by` and `decided_at`. PostgREST reports a zero-row update as success, so this
is the difference between "I decided it" and "somebody else did": the loser of a race is told `refund_moved`,
writes no chain entry, and is never handed a row it did not decide. The gate reproduces the race by letting the
fixture move the row between the caller's read and its write.

A rejection and a withdrawal share `cancelled` and `0038` gives neither a column of its own, so the version is the
only mark those two paths share. The service says so in its header: if they cross, the row is `cancelled` either
way and the second chain entry records a transition its writer did not observe. It costs no money; both outcomes
return the refund to the merchant.

## The five reads

- **`GET /api/payments/refunds`** - the merchant's own refunds, newest first, ceiling 50, staff refused.
- **`GET /api/payments`** - the merchant's own payments in a state a refund starts from, each with `remainingMinor`
  computed by the same function the request will use, and payments with nothing left filtered out. This is why the
  console cannot offer an amount the service would refuse, and why a merchant never types a UUID.
- **`GET /api/office/refunds`** - the platform queue: every merchant's `requested`/`approved`/`processing` refunds,
  **oldest first**, because it is a queue and not a report; ceiling 100; `finance_ops`/`super_admin` only.
- **`readRefund`** - one row, for the merchant that owns it or the desk that decides it; a merchant's id and a
  stranger's id are the same `404`.
- Each route answers `cache-control: no-store`, reads the actor from the cookie, and never puts a free-text reason
  in a log line.

## Security

| Concern | Where it is answered |
| --- | --- |
| Validation | Both bodies are strict objects with no extra keys; the payment id is a UUID; the amount is a price parser with two bounds; the reason is 1-500 after trimming and the note ≤ 500; ceilings are 2 048 / 1 024 / 512 bytes, checked against the declared length **and** the bytes. A refusal names a field and a rule, and never echoes a value. |
| Permission | `owner` for the merchant's four acts; `finance_ops`/`super_admin` for the queue and the decision; the two lists are disjoint, which is what makes the four-eyes check possible; an actor with no company cannot raise a refund even if it holds a role. |
| Tenancy | Every merchant read and write is `company_id=eq.` the session's; another tenant's payment or refund is `404`, never `403`. The desk's reads carry no tenant filter **because** they are platform-scoped, and the row's `company_id` travels into every audit entry. |
| CSRF | `requireCsrfToken` on all three mutating routes, before the body is read; all three are on `CSRF_PROTECTED_PATHS`. The runtime smoke below shows the token is the **first** guard: an unauthenticated POST answers `422 {field: "csrf", rule: "csrf_token_invalid"}`, exactly like the baseline route. |
| Device proof | The decision route demands a signed request (`verifySensitiveRequest` + `requireTrustedDevice`) over the exact bytes, because an approval authorises money; the request and the withdrawal demand none, because they move none. The gate asserts both directions. |
| Replay and double-decision | The versioned write plus the read-back (above); a second decision on the same row answers `409 refund_not_pending`. |
| Over-refund | Three layers: the service's headroom (held **and** promised), the service's re-check at the decision, and `refunds_guard_amount` at the database. The gate exercises each and proves the database's own refusal surfaces as `exceeds_refundable`, not as a 500. |
| RLS | No table is added and none is altered. `0038`'s default-deny stays as written; the service reaches PostgREST through STEP 111's client, and the gate re-asserts that `0038` denies by default. |
| Audit | Four actions - `refund.requested`, `refund.approved`, `refund.rejected`, `refund.cancelled` - all under entity `refund`, all carrying `payment_id`, amount, currency, the status before and after, and the requester. Notes and reasons are counted, never copied. Entries are written tolerantly: a chain that is down never fails the row it records. |
| Failure mode | An unreadable row is `DEPENDENCY_FAILED` and writes nothing; a conflict becomes the rule a person reads; no path in this STEP contacts a provider. |

## The gate

`node services/payments/refund-verify.ts` - **253 checks**, over a PostgREST fixture (array store) that enforces
`0038`'s `refunds_guard_amount`, `refunds_approval_check` and `refunds_processed_check` against each write, and that
can be told to move a row between a caller's read and its write:

- **the vocabulary**: six statuses, entity `refund`, the two disjoint role lists, three live statuses, three open
  ones, two ceilings, twelve distinct rules, and every rule inside the column's own alphabet;
- **what a person types**: three amount parses, six amount refusals, two reason refusals, a strict body (unknown key,
  missing key, bad id), `approve`/`REJECT`/`maybe`, an empty note reading as no note, and the headroom arithmetic
  including the never-negative case;
- **requesting**: staff refused, a platform account with no merchant refused, an unknown payment, another merchant's
  payment, four payment statuses, three bad amounts, an empty reason - then a good request whose row says
  `requested`, carries the payment's currency, and leaves `payments.refunded_minor` at zero; its chain entry names
  the payment and the amount, carries `reason_length`, and has no `reason` key;
- **promises**: a second request past the remainder refused, the rest still askable, the screen's headroom printed
  once for held money and promised money together, and a payment with nothing left filtered out of the list;
- **deciding**: three roles refused, an unknown refund, the requester refused at the desk, an approval that lands
  (`approved_by`, `decided_at`, no `processed_at`), its entry's before/after and `note_present`, a second decision
  refused, a rejection that lands as `cancelled` with no approver and its own action, the approval re-check that
  refuses a refund the payment can no longer hold, and the **lost race** that answers `refund_moved`, writes no
  entry and leaves the winner's approver on the row;
- **withdrawing**: another merchant refused, staff refused, the withdrawal that lands, its entry's `by`, an
  approval after a withdrawal refused, a second withdrawal refused, and the headroom freed again;
- **reading**: a merchant's list tenant-scoped and newest first (a foreign row written straight into the table is
  invisible to it, unreadable by id and unwithdrawable), the desk's queue oldest first with every merchant's row and
  no decided-against one, one row read three ways;
- **the payment list**: only the merchant's own captured/settled rows are offered, with the whole amount as
  headroom, and the row disappears once the whole is asked for;
- **the sources**: CSRF + `no-store` + session on all three mutating routes, the device proof on the decision and
  only there, no gateway call and no processor-owned status in the service, `refunded_minor` read three times and
  written never, `0038`'s six constraints and functions named by the gate, the highest migration still `122`, both
  screens rendered by their pages, the console carrying a token on every write and confirming a withdrawal inline,
  every catalog key the two screens use present in the group, and the merchant
  screen inventing no processor identifier.

**Mutation-checked.** Fourteen mutations, thirteen caught, each restored afterwards:

| Mutation | Verdict |
| --- | --- |
| headroom ignores the promised refunds | **4 problems** |
| promises counted twice as held | **1 problem** |
| no four-eyes refusal | crash before the assertions (the write is refused by the fixture's approval check) |
| no re-check at the decision | **1 problem** (`refund_guard` instead of `exceeds_refundable`) |
| a rejection writes `failed` | crash: `refunds_processed_check` refuses it |
| no chain entry on a request | **7 problems** |
| the merchant list loses its tenant scope | **3 problems** |
| a withdrawal accepts any status | **1 problem** |
| the guarded write loses `status`/`version` | **1 problem** |
| the approval keeps only the version, not its own mark | **1 problem** |
| the payment list ignores the status filter | **1 problem** |
| the queue shows decided rows | **1 problem** |
| the request ignores the payment's currency | crash: `refunds_guard_amount` refuses it |
| a `fetch` smuggled into the service | refused before any assertions run (the source check would catch it too) |

## Two gates were already red, and what this STEP did about them

`node lib/auth/verify.ts`, `node lib/security/verify.ts` and `node components/office/verify.ts` were **red at
`49c2e55`**, before a line of this STEP was written - checked by running all three in a worktree of that commit. Two
of the three mattered here, so this STEP repaired what its own code depends on and left the rest named:

- **`lib/auth/verify.ts`, fixed.** `CSRF_PROTECTED_PATHS` was six routes behind (STEP 190's three payment-link
  routes and this STEP's three), so "every route that answers a POST is on the protected list" could not pass; all
  six are now listed. Its browser scan also counted *any* file containing `method: "POST"` - including
  `app/(client-portal)/portal-rate-limit.ts`, a server module whose prose contains those words - so the two
  client-side assertions had been red since the portal block landed. The scan now counts **client components**
  (`"use client"`), the counts are updated (50 files, 69 call sites, with STEP 190's console and this STEP's two
  screens named in the comment), and the gate reports **1** problem instead of 7.
- **`lib/security/verify.ts`, left red (3 problems, unchanged):** one dotted audit action literal somewhere in the
  tree that the column would refuse, and `lib/payments/adapters/nmi-client.ts` naming an encryption algorithm beside
  the two modules that are allowed to. Both predate STEP 190; neither is refund code.
- **`components/office/verify.ts`, left red (12 problems, unchanged):** the catalog has thirteen screens (STEP 096's
  provisioning queue) and the gate's expected lists still say twelve. Repairing it means restating another STEP's
  role matrix, which is that STEP's to own.
- **`lib/auth/verify.ts`'s one remaining problem** is the "no fourth module dials" equality: eighteen provider
  adapters (`lib/kyc/adapters/*`, `lib/payments/adapters/*`, `lib/tax/taxcloud-connect.ts`) call `fetch(` directly
  instead of going through `lib/auth/http.ts`'s guarded transport. That is a real architectural question about doors,
  raised by the payment and KYC STEPs, and out of scope here.

## Desktop and mobile widths

Both screens use only classes the repository already uses - a `max-w-3xl` column with `px-4 py-6 sm:px-6 sm:py-10`,
cards that are `flex-col` with `p-4 sm:p-6`, and `flex-wrap` on every row of chips and buttons - so at 360 px nothing
is clipped and nothing pushes the page sideways:

- **the merchant desk** is one column: the payment `<select>` and the amount take the full width, the reason is a
  two-row textarea, and each refund row stacks its amount and status badge, its reason (`break-words`), its two
  instants and its withdraw button. At 1440 px the same column is centred and each row's amount and badge sit at
  opposite ends of one line.
- **the finance queue** is a list of cards: at 360 px each row is a stacked badge, amount and id, then a one-column
  definition list, then the reason block, then the two decision buttons side by side. At 1440 px the definition list
  becomes `sm:grid-cols-[12rem_1fr]` and the buttons sit under the reason rather than crowding it.

No fixed width, no `truncate` and no `whitespace-nowrap` on prose is introduced; the only `whitespace-nowrap` is on
the refund id chip, which is a UUID a reader may copy.

## Verification

| Command | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npm run lint` | clean |
| `npm run build` | compiled; `/payments/refunds`, `/office/refunds` and the four API routes are dynamic (`ƒ`) |
| `node services/payments/refund-verify.ts` | **253 checks** |
| `npm run check:structure` | 687 source files (was 674) |
| `npm run check:i18n` | 2809 messages, 298 placeholders, 1 locale (was 2746) |
| `npm run check:audit` | 3869 checks (was 3785) |
| `npm run check:shell` | 1019 checks, 325 files |
| `npm run check:lint` / `check:errors` | 77 / 202 checks |
| `npm run check:migrations` | 3572 checks, 122 migrations, 92 tables |
| `npm run check:config` / `check:env` | 10 sections / 16 variables |
| `npm run check:logger` / `check:jobs` | 117 / 110 checks |
| `node lib/auth/verify.ts` | 1 problem, down from 7 (see above) |

### Runtime smoke, against `next dev` with the sandbox's seven variables

| Probe | Answer |
| --- | --- |
| `GET /api/payments` | `401 AUTHENTICATION_REQUIRED` |
| `GET /api/payments/refunds` | `401 AUTHENTICATION_REQUIRED` |
| `GET /api/office/refunds` | `401 AUTHENTICATION_REQUIRED` |
| `POST /api/payments/refunds` | `422 VALIDATION_FAILED`, `{field: "csrf", rule: "csrf_token_invalid"}` |
| `POST /api/payments/refunds/5f00/cancel` | `422`, the same CSRF refusal |
| `POST /api/office/refunds/5f00/decision` | `422`, the same CSRF refusal |
| `GET /payments/refunds` | `200`, heading "Refunds" and the loading panel rendered |
| `GET /office/refunds` | `307 → /signin`, the office shell's own refusal |

The `422` is the baseline's answer too (an unauthenticated POST meets the token before the body), which is what
makes the comparison meaningful: the token is the first guard on all three routes.

## What is genuinely unfinished

1. **Executing the refund (STEP 192).** An approval is the money *authorised*: nothing in this STEP moves a cent,
   `processing`/`succeeded`/`failed` and `provider_refund_id` are never written here, and both screens say so in
   the merchant's own words. STEP 192 adds the provider call, and `refunds_provider_required_check` is already
   waiting for the identifier it will supply.
2. **The platform fee on a refund (STEP 193).** `platform_fee_returned` stays `false` and
   `platform_fee_returned_minor` stays `0`; the rule that decides them is the super administrator's setting, which
   is STEP 193's.
3. **The queue has no office navigation entry.** `components/office/navigation.ts` and its gate are another STEP's
   (and already red, see above), so `/office/refunds` is reachable by URL only - the same carried gap STEP 190
   recorded for `/payments/links`.
4. **A merchant cannot see the desk's note.** A decision's note is written to the chain and not to the row (the
   table has no column for it), so the merchant reads *that* a decision was taken and not why. Adding a
   `decision_note` column is a migration decision for the STEP that wants it.
5. **No notification.** §19's dispute deadlines have email warnings; a refund decision has none yet, and the
   notification module is not this STEP's.

## Left for the STEPs after this one

- STEP 192: refund execution through the originating provider, which turns `approved` into `processing` and then
  `succeeded`/`failed` and lets `refunds_sync_payment` move `payments.refunded_minor`.
- STEP 193: the platform fee rule on a refund, read from the super administrator's setting.
- §19's second half - the dispute interface, its evidence pack and the 24/48-hour deadline - is still ahead.
