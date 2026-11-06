# STEP 127 — Money value handling with decimal library and currency guard

Branch `arena/17762737-kd-solution-it`.
Previous handoff: `docs/handoffs/STEP_126_COMPLETED.md`.

## What this STEP is, in one paragraph

The payment core's money: an exact decimal value on whole minor units, a currency guard closed on
the one currency the platform carries, and the arithmetic that keeps a balance exact. Every money
value in the payment core is a `Money` - a `bigint` of minor units at the platform's four-decimal
scale plus the currency it is denominated in - and every sum, difference and comparison on it is done
on those whole minor units, never in floating point. The decimal library the master prompt names is
not a package (the platform carries four dependencies and `package.json` is integrator-owned): it is
`lib/payments/money.ts`, the discipline of doing every calculation on `1250000` where a person writes
`125.0000`, so that `0.1 + 0.2` is `0.3` and not `0.30000000000000004`. The currency guard is a
closed list with one entry - USD - and a value built in any other currency is refused at the point it
is made, before it can reach a balance.

## What it is not

- **It is not the ledger.** It does not post entries, it does not read the database, and it does not
  know that a payment and a fee are two sides of one double entry. It is the value those postings
  move: the number, the currency, and the arithmetic that proves a set of debits and credits balances.
  The ledger tables (`0040`/`0041`) are STEP 125's; the postings themselves come in later STEPs.
- **It is not a floating-point money.** There is no `number` in any money calculation here. A value
  is stored as whole minor units in a `bigint`, parsed from its decimal text and printed back to it,
  and a sum is `12 * 10^4 + 5000`, never `12.5 * 10000`. The gate proves it: `0.1 + 0.2` reads back
  as `3000` minor units, the exact `0.3`, not the floating-point sum.
- **It is not an open currency set.** The master prompt says USD only, so the guard is closed on the
  one currency the platform carries. A money value built in any other currency is refused at
  construction - `requireCurrency("EUR")` throws, and so does `moneyFromMinor(100n, "EUR")`. A
  currency added later is a change to the closed list, not a hole in the guard.
- **It does not need a migration.** It is a library, not a schema change. The ledger's `amount_minor`
  is already a `bigint` column, the scale is already four decimal places, and the ceiling is already
  the database's `numeric(18,4)`. Sub-step 3 was "if any", and it was not.
- **It does not add a dependency.** The decimal library is in-house (`lib/payments/money.ts`,
  `bigint`-based). If the integrator prefers an external decimal library (`decimal.js`,
  `bignumber.js`), that is a package request recorded below - but the in-house library satisfies the
  master prompt's "money math uses a decimal library only" rule without one.

## Sub-steps, as executed

| # | Sub-step | Deliverable | Gate |
|---|---|---|---|
| 1 | Read MASTER_PROMPT money rules, FEATURE_LIST §7, STEP 126 handoff | — | — |
| 2 | Confirm owned paths | `lib/payments/` core files (types, registry, routing, ledger, settlement) - STEPs 127-146 own these; adapter files are 147-169 | — |
| 3 | Database part | **none needed** - `0040`/`0041` already carry the money column | migrations **3495 checks, 120 migrations** (unchanged) |
| 4 | Core service and logic | `lib/payments/money.ts`: the `Money` type, the currency guard, the decimal parse/print, the arithmetic | payments-money gate |
| 5 | API route | **none** - a library, not an endpoint | — |
| 6 | UI | **none** - a library, not a screen | build 0 (156 routes) |
| 7 | Security | the currency guard (USD only, closed list), the range guard (the database's ceiling), no floating point anywhere in a money calculation | gate + auth gate |
| 8 | typecheck, lint, build, commit, push, handoff | tsc 0, eslint 0, build 0 | `npm run verify` exit 0 |

## The rules, where each one lives

- **The value** - a `Money` is `{ minor: bigint, currency: Currency }`. The `minor` field is the
  database's own representation (the `bigint` column a ledger entry carries), so a `Money` read from
  a row and a `Money` built by arithmetic are the same type and the same scale.
- **The scale** - four decimal places, matching `config/app.ts`'s `money.scale` and the database's
  `numeric(18,4)`. `MONEY_SCALE = 4`, `MINOR_PER_UNIT = 10_000n`: one major unit is ten thousand
  minor units.
- **The ceiling** - `MAXIMUM_MINOR = 10^18 - 1`, the database's own `numeric(18,4)` ceiling. A value
  past it is refused at construction (`moneyFromMinor` throws), so no `Money` ever leaves the library
  carrying a number the column could not store.
- **The currency guard** - `CURRENCY_CODES` is a closed list with one entry, `USD`. `isCurrency`
  checks membership, `requireCurrency` refuses anything else, and every construction and every
  arithmetic calls it. The guard is case-sensitive: `usd` is not `USD`.
- **The decimal library** - `moneyFromInput` parses typed major units into exact minor units on
  strings and `BigInt` (the whole part times `10^4` plus the padded fraction), and `moneyToInput`
  prints them back. `moneyAdd`, `moneySubtract`, `moneyNegate`, `moneySum`, `moneyCompare`,
  `moneyIsZero`, `moneySign` do the arithmetic on whole minor units. There is no `number` in any of
  it.
- **The balanced double-entry proof** - the gate's `checkBalanced` proves it: a posting and its
  opposite sum to zero; a payment that credits the payable `100.0000` and debits the clearing
  `-100.0000` balances; and a settled period's set of credits and debits - `125.0000` in, `-6.2500`
  fee, `-90.0000` payout, `-28.7500` reserve - sums to exactly zero.

## Verification

| Gate | Result |
|---|---|
| payments-money (`lib/payments/money-verify.ts`) | **66 checks PASSING** - currency guard, decimal exactness (`0.1 + 0.2 = 0.3`), arithmetic, round trip, balanced double-entry postings, range guard |
| `npm run typecheck` | 0 errors |
| `npm run lint` (eslint) | 0 errors |
| `npm run build` | 0 errors, 156 routes |
| `npm run verify` | exit 0 |
| auth gate (`lib/auth/verify.ts`) | 2811 checks PASSING (unchanged) |
| migrations gate | 3495 checks, 120 migrations (unchanged) |

## The balanced double-entry proof, as recorded

The master prompt requires every STEP that touches money to prove balanced double-entry ledger
postings for its flows. STEP 127's flow is the money arithmetic, and the gate proves it three ways:

1. **A posting and its opposite balance.** `moneyAdd(credit, moneyNegate(credit))` is zero: a value
   and the opposite of that value are the two sides of one entry, and they cancel.
2. **A payment is a balanced double entry.** The payable is credited `100.0000`, the clearing is
   debited `-100.0000`, and the sum of the two postings is `0` - which is what "balanced" means for
   one transaction.
3. **A settled period's book balances.** The set of postings `[+125.0000, -6.2500, -90.0000,
   -28.7500]` - the payment in, the platform fee, the payout out, the reserve and hold - sums to
   exactly `0`. Every debit has a credit somewhere in the book.

The same proof carries into the later payment core STEPs: when a payment posts, its ledger entries
are built from `Money` values and summed with `moneySum`, and the zero they read back is the zero
this gate established.

## Package request

None required. The decimal library is in-house (`lib/payments/money.ts`, `bigint`-based) and satisfies
the master prompt's "money math uses a decimal library only" rule without an external package. If the
integrator prefers an external decimal library (`decimal.js`, `bignumber.js`) for the payment core,
that would be a package request - but it is not needed for STEP 127's behaviour, and the in-house
library keeps the platform at four dependencies.

## What is next

STEP 128 - "Provider registry with capability matrix for five providers" - owns
`lib/payments/registry.ts` and builds on this file's `Money` and currency guard. The money library is
the value the registry describes, the routing STEPs move, and the ledger posts; every payment core
STEP from here reads money through `lib/payments/money.ts`.
