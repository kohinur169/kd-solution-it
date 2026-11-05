# STEP 124 — Partial payment recording with 20 USD minimum

Branch `arena/17762737-kd-solution-it`.
Previous handoff: `docs/handoffs/STEP_123_COMPLETED.md`.

## What this STEP is, in one paragraph

A merchant records money that arrived on an issued invoice. The recording is a **status move, not an
annotation**: `0022`'s `invoices_status_money_check` leaves no state in which a sent or viewed document
holds money, so the payment and the state are written in the one guarded statement the STEP 116 engine
performs — a partial leaves the document `partially_paid`, and the payment that settles it makes it
`paid` with `paid_at` in the same statement. A partial payment is accepted with a **minimum of 20 USD**,
taken from the platform's own config (`money.minimumPartialPayment`, `20.0000` at the platform's
four-decimal scale), and the minimum stops applying the moment a payment settles the document, because
the payment that pays the last remainder is not a partial payment.

## What it is not

- **It is not a processor transaction.** `0037`'s `payments` table records gateway charges with their
  provider, key, routing rule and idempotency key, and belongs to the payment core (STEPS 127-146).
  Recording a payment here is the merchant's book of money that arrived, on the invoice itself.
- **It does not need a migration.** `0022` already carries the column, the money checks and the paid
  instant; `0024` already carries the two timeline words. Sub-step 3 was "if any", and it was not.
- **It does not write the 20 USD into the database.** The database's own floor is a weaker backstop;
  see "The database floor, named" below. The service is the authority on the number the feature names.
- **It does not refund, dispute or settle through a link.** Refunds are STEPs 191-199, and the
  tokenized link that pays the remaining amount is the client portal's (STEPS 181-190).

## Sub-steps, as executed

| # | Sub-step | Deliverable | Gate |
|---|---|---|---|
| 1 | Read FEATURE_LIST §16, MASTER_PROMPT rules, STEP 123 handoff | — | — |
| 2 | Confirm owned paths | `services/invoices/*` (106-126), invoice components, the invoice payment route | — |
| 3 | Database part | **none needed** — `0022`/`0024` already carry it | migrations **3495 checks, 120 migrations** (unchanged) |
| 4 | Core service and logic | `recordInvoicePayment` in `invoice-status.ts`; engine gained the guarded-money write and the re-read that verifies what a move wrote; the graph gained the `partially_paid → partially_paid` self-loop | inside the invoice gate |
| 5 | API route | `app/api/invoices/[id]/payments/route.ts` | inside the invoice gate + auth gate |
| 6 | UI | "Record a payment" in `invoice-status-actions.tsx` (the workflow bar), the paid line in the invoice screen, i18n keys | build 0 (155 routes) |
| 7 | Security | CSRF on the route (protected list + auth gate), the `owner` role in the service, the tenant scope of every read, the two audit actions | auth **2811 checks** (was 2805) |
| 8 | typecheck, lint, build, commit, push, handoff | tsc 0, eslint 0, build 0 | `npm run verify` exit 0 |

## The rules, where each one lives

- **The 20 USD minimum** — `recordInvoicePayment` reads `appConfig.money.minimumPartialPayment`
  (`"20.0000"`) and parses it through the platform's own price parser into `200000` minor. It applies
  to a payment **that leaves the document open**, on the platform's currency, and it is on the
  **payment**, not the accumulated total: a five-dollar partial is refused whatever the document
  already holds, and a ten-dollar payment that settles a ten-dollar remainder is accepted.
- **The remaining is the ceiling** — a payment above what the document still owes is refused with
  `exceeds_remaining`, because a link paid in full no longer accepts money and a document does not owe
  more than it says on itself.
- **Money and state in one statement** — the move writes `status` and `amount_paid_minor` (and
  `paid_at` for the settling payment) in the one update the engine sends, so `0022`'s three money
  checks see a coherent row and no state can hold money it does not owe.
- **The guard carries the money** — the update's predicate carries `amount_paid_minor = eq.<what the
  service read>` beside the status, so two payments on the same document cannot both write: the loser
  matches nothing, and the re-read — which now verifies **every column the move wrote**, not only the
  status — turns the miss into a conflict. The status alone proves nothing on the self-loop, where the
  move is the state itself; the money does.
- **The self-loop** — the graph gained `partially_paid → partially_paid`, because a second partial
  payment records money on a document that is already partially paid. It is the only state that accepts
  itself; the bar reads the same table, so the button appears exactly where the move is legal.
- **The two words** — a partial writes `payment_received`, the settling payment writes `paid`, each
  with the amount in the printed form (`200.0000 USD`), and the audit entries
  (`invoice.payment_received`, `invoice.paid`) carry the money in minor units.

## The database floor, named

`0022`'s `invoices_partial_minimum_check` floors a partially paid USD document at `amount_paid_minor
>= 2000`. At the platform's four-decimal scale that is **$0.20**, not the $20 the feature and the
config name — a floor written for a two-decimal habit on a four-decimal platform. It was left exactly
as it is, for three reasons: `0022` belongs to STEP 021 and is applied; a floor can only be too weak,
never too strong (it refuses nothing the service already refuses); and the service now enforces the
number the feature names, so the backstop's weakness is a gap in the database's second line, not a hole
in the rule. A database STEP that touches `0022`'s successors should carry the floor up to `200000`.

## The gate, in one breath

`checkPayments` in `services/invoices/verify.ts`, beside the now money-checking fixture: the first
payment (money and state together, the number kept, the two entries), the second payment (the
self-loop, the accumulated amount grown), the settling payment (below the minimum, because it is not a
partial, `paid_at` in the same statement), the paid ceiling, the minimum at `19.9999` and at `20.00`,
the overpayment at `300.0001` and at the rest, the zero and the not-amounts, the draft and the voided
document, and the race — a payment that won the same instant, refused by the guard and the re-read,
with no timeline row for the payment that did not land. The fixture gained `0022`'s three money
checks and the payment's amount guard, so a row the database would refuse is one the gate refuses.

## What is genuinely unfinished, in order of consequence

1. **The `0022` floor stays at $0.20** until a database STEP carries it to the $20 the feature names;
   the service closes the gap in the meantime.
2. **The client side of the money.** A tokenized link that pays the remaining amount is the portal's
   (STEPS 181-190), refunds are STEPs 191-199, and the `payments` rows of `0037` wait for the payment
   core (127-146). None of them is blocked by this STEP; all of them build on the state it writes.
3. **No scheduler question here.** This STEP adds no job; the deployment hook named in the STEP 123
   handoff is unchanged.

## Gate inventory after this STEP

recurring 126 · recurring-service 107 · recurring-job 83 · recurring-generation 129 · **invoices 1609** ·
estimates 1583 · conversion 147 · **auth 2811** · security 2378 · jobs 110 · kyc 4142 · office 545 ·
migrations 3495 / 120 / 89 · structure 458 · i18n 2315+ · shell 774 · lint-rules 77 · config 10 · env 16 ·
tsc 0 · eslint 0 · build 0 (155 routes).

## Next

**STEP 125** — Settlement statement export CSV generation. Not started, per instruction.
