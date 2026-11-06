# STEP 130 — Payment creation service with idempotency key handling

Branch `arena/17762737-kd-solution-it`.
Previous handoff: `docs/handoffs/STEP_129_COMPLETED.md`.

## What this STEP is, in one paragraph

The payment creation service: the one function that turns a payment request into a payment record, and the
idempotency key that makes it safe to try again. Every payment carries an idempotency key (FEATURE_LIST §13,
MASTER_PROMPT line 24). When a request arrives, the service asks the store whether the key has already
produced a payment for that company. If it has, the service returns the payment the key produced — no second
payment is created, no second charge is sent. If the same key arrives with different details, the service
refuses: a key is a promise, and a promise cannot be broken silently. If the key is new, the service routes
the payment through the routing engine (STEP 129), rejects the payment if no rule matches, and creates the
payment record. The double-entry ledger is not touched here — STEP 131 owns that. This STEP creates the
payment *record* and nothing else.

## What it is not

- **It is not the ledger.** This service creates a payment record. It does not post debit or credit entries,
  does not move money, and does not touch any account balance. The double-entry proof rule applies to STEPs
  that move money; this STEP creates a record, not a movement.
- **It is not the provider adapter.** It does not call any provider's API. It routes the payment to a
  provider key via the routing engine and creates the record. The adapter STEPs (147-169) drive the actual
  provider APIs.
- **It is not the database migration.** The tables `public.payments`, `public.idempotency_keys`, and
  `public.routing_rules` already exist (migrations 0037, 0033, 0031). Sub-step 3 was "if any", and it was not.
- **It is not the API route or the UI.** It is a library module. The API route and the UI are later STEPs
  that call `createPayment`.
- **It does not own the idempotency key table.** The `idempotency_keys` table and its hashing/state logic
  are the database layer's concern. This service keys on the plain idempotency key string and asks the
  store to find or insert.

## Sub-steps, as executed

| # | Sub-step | Deliverable | Gate |
|---|---|---|---|
| 1 | Read FEATURE_LIST §13, MASTER_PROMPT rules, STEP 129 handoff | — | — |
| 2 | Confirm owned paths | `lib/payments/creation.ts` — STEP 130 owns it | — |
| 3 | Database part | **none needed** — tables already exist | migrations 3495 checks, 120 migrations (unchanged) |
| 4 | Core service and logic | `lib/payments/creation.ts`: payment creation with idempotency key handling | payments-creation gate |
| 5 | API route | **none** — a library, not an endpoint | — |
| 6 | UI | **none** — a library, not a screen | build 0 (156 routes) |
| 7 | Security | the service validates amount and key; the store is the caller's (RLS/audit are the store's concern); it does not touch money or call a provider | gate + auth gate |
| 8 | typecheck, lint, build, commit, push, handoff | tsc 0, eslint 0, build 0 | `npm run verify` exit 0 |

## The types, where each one lives

- **`PaymentRequest`** — what a caller asks for: a company, an amount in minor units, a capability (from
  the registry, STEP 128), an optional method, an optional country, and the idempotency key.
- **`Payment`** — what the service creates: an id, the company, the amount, the capability, the provider
  key the routing engine chose, the idempotency key, and a status of `"created"`.
- **`PaymentStore`** — what the service reads and writes. The store is the caller's: the database
  implementation, or the in-memory store below. The service owns the decision; the store owns the storage.
- **`PaymentCreationResult`** — what the service answers: `{ status: "created", payment }` when a new
  payment was created, `{ status: "deduplicated", payment }` when the key already produced a payment, or
  `{ status: "rejected", reason }` when the payment was refused.
- **`InMemoryPaymentStore`** — the reference implementation. It keys on the compound `companyId:idempotencyKey`,
  matching the `idempotency_keys (company_id, scope, key_hash)` scoping in the database.

## The creation flow, step by step

1. **Reject non-positive amounts.** `amountMinor <= 0n` is rejected before anything else. A payment of zero
   or negative is not a payment.
2. **Check the idempotency key.** The store is asked for a payment with this company and key. If found, the
   service compares the stored payment's details with the request. If they match, the service returns
   `deduplicated` with the stored payment. If they differ, the service returns `rejected` with a reason
   naming the conflict.
3. **Route the payment.** The service calls `routePayment` from STEP 129. If no rule matches, the payment is
   rejected and no record is created.
4. **Create the payment.** A new `Payment` is built with a `randomUUID()`, the provider key from the routing
   decision, and a status of `"created"`. The store inserts it, and the service returns `created` with the
   payment.

## Verification

| Gate | Result |
|---|---|
| payments-creation (`lib/payments/creation-verify.ts`) | **24 checks PASSING** — creates a new payment, dedupes on a repeat key, refuses a conflicting key, rejects on no routing match, routes to the right provider, scopes keys to the company, balances one-payment-per-key, and rejects non-positive amounts |
| payments-routing (STEP 129) | 24 checks PASSING (unchanged) |
| payments-registry (STEP 128) | 42 checks PASSING (unchanged) |
| payments-money (STEP 127) | 66 checks PASSING (unchanged) |
| `npm run typecheck` | 0 errors |
| `npm run lint` (eslint) | 0 errors |
| `npm run build` | 0 errors, 156 routes |
| `npm run verify` | exit 0 |
| auth gate | 2811 checks PASSING (unchanged) |
| migrations gate | 3495 checks, 120 migrations (unchanged) |

## The idempotency proof, as recorded

The STEP title names the behaviour, and the gate proves it eight ways:

1. **A new key creates a payment.** A request with a key the store has never seen produces a payment with
   that key.
2. **The same key deduplicates.** A second request with the same key and the same details returns
   `deduplicated` with the original payment — no second payment is created.
3. **The same key with different details is refused.** A second request with the same key but a different
   amount returns `rejected`. A key is a promise; a broken promise is not silently honoured.
4. **A payment with no matching rule is rejected.** The service calls `routePayment`; when the decision is
   unmatched, the payment is rejected and no record is created.
5. **The payment is routed to the right provider.** The provider key on the created payment comes from the
   routing decision, not from the request.
6. **Keys are scoped to the company.** The same idempotency key used by two different companies produces two
   separate payments. The compound key `companyId:idempotencyKey` is what the store looks up.
7. **One payment per key.** After a payment is created with a key, the store's `findByIdempotencyKey` for
   that company and key always returns that payment — never a second one.
8. **A non-positive amount is rejected.** A request with `amountMinor: 0n` or a negative amount returns
   `rejected` before the key is even consulted.

## Package request

None. The payment creation service is a plain TypeScript module with no dependencies beyond the routing
engine (STEP 129), the registry types (STEP 128), and `node:crypto` for `randomUUID()`.

## What is next

STEP 131 — "Double-entry ledger account setup per merchant" — owns the ledger accounts that STEP 132 will
post to. STEP 130 creates the payment *record*; STEP 132 will post the debit and credit *entries* that
balance against that record. The payment this STEP creates is the thing the ledger reads.
