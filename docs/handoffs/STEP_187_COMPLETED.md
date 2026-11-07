// path: docs/handoffs/STEP_187_COMPLETED.md
# STEP 187 — Card blacklist check by token and fingerprint

**Status: COMPLETED**

## STEP

- Number and title: STEP 187 — Card blacklist check by token and fingerprint.
- Category: Client Portal, Payment Pages and Payment Links (STEPs 181-190), the seventh STEP of the block. STEP
  183 built the card page, STEP 184 the bank's step, STEP 185 the fallback capture rule, STEP 186 the rejection
  on the gateway's fraud signal; STEP 187 is the list that makes that knowledge outlive the request.
- Depends on: `docs/final/FEATURE_LIST.md` section 18 line 196 ("card blacklist entries use card token or
  provider card fingerprint"); `docs/final/STEP_PLAN_250.md:2398-2409`; STEP 030's `0055_card_blacklist.sql` (the
  table, the fingerprint alphabet, the two sources, the six reasons, the unique active-block index, the release
  guard); STEP 066's `FRAUD_CARD_FINGERPRINT_PATTERN` and `FraudSignalLookups.isCardBlocked`; STEP 186's
  `PortalCardReferralQueue` and `refused_by_risk` outcome; STEP 183's `chargePortalPayment`; STEP 024's
  `payments_failure_code_check` and `payments_risk_reject_check`.

## Owned paths

Owned and used: `app/(client-portal)/`, `components/payments/`, `lib/i18n/strings/en.ts` (messages only).

- `app/(client-portal)/portal-blacklist-fields.ts` — new, 199 lines. The vocabulary, the Zod schemas and the
  rules of section 18's last clause.
- `app/(client-portal)/portal-blacklist.ts` — new, 501 lines. The fingerprint, the check, the block, the release
  and the STEP 066 lookup.
- `app/(client-portal)/portal-blacklist-processor.ts` — new, 176 lines. The pre-gateway check port and the
  durable referral queue.
- `app/(client-portal)/portal-blacklist-verify.ts` — new, 1,364 lines. The gate, **208 checks**.
- `app/(client-portal)/portal-payment-processor.ts` — edited, +45 lines: the list is asked before a record is
  opened, a blocked card is settled `failed` with `card_blacklisted`, a replayed attempt is recognised by that
  code, and an unreadable list answers `unavailable` / `blacklist`.
- `app/(client-portal)/portal-payment.ts` — edited, +45 lines: the `refused_by_blacklist` outcome, the `503` for
  an unreadable list, and the two audit entries.
- `app/(client-portal)/portal-payment-runtime.ts` — edited: the check is wired into the processor and the
  referral queue is STEP 187's.
- `app/(client-portal)/portal-fraud.ts` — edited, +10 lines: `PortalCardReferred` gains `actor_required` and
  `write_failed`, which are the two honest answers a list that needs a person can give.
- `app/(client-portal)/portal-fraud-verify.ts` — edited: two source assertions restated for the durable queue
  (see "Two previous gates" below).
- `app/(client-portal)/i/[token]/pay/charge/route.ts` — edited, documentation only: the two answers a
  blacklisted card gets.
- `components/payments/portal-payment-refusal.ts` — edited, +12 lines: the two sentences and the `blocked` rule
  added to the refusals that end the page.
- `lib/i18n/strings/en.ts` — 2 new `portal.*` keys (`ruleCardBlacklisted`, `ruleCardBlacklistUnavailable`).
- `app/(client-portal)/README.md` — the STEP 187 section.

Untouched: `migrations/`, `lib/security/` (the fingerprint pattern and the lookup contract are imported),
`lib/payments/` (the adapter is used, never edited), `app/(admin)/` (the office screen that confirms a block is
STEPs 068-078's) and `package.json`.

## The database sub-step, and why there is no migration

The list already exists, and it is the platform's:

| What section 18 needs | Where it already is |
| --- | --- |
| The list itself | `0055_card_blacklist.sql` (STEP 030) |
| A hash of a token or a provider fingerprint, and nothing else | `card_fingerprint ~ '^[0-9a-f]{64}$'` |
| Which of the two it was | `fingerprint_source in ('card_token', 'provider_fingerprint')` |
| Why the card is blocked | `reason in ('fraud', 'card_testing', 'chargeback', 'stolen_card', 'compliance', 'other')` |
| One block per card | `card_blacklist_active_key`, a unique partial index on active rows |
| A block that ends by a release, never a delete | `card_blacklist_guard_state()` |
| The platform owns the list, not a tenant | `card_blacklist_platform_check (company_id is null)` |
| The failure code a refused payment carries | `payments_failure_code_check` (any trimmed code to 64 characters) |
| The risk state it sits in | `payments_risk_reject_check` (`risk_decision <> 'reject' or status = 'failed'`) |

The gate reads both migrations and asserts each line of that table, and asserts that the next free migration
number (**0123**) is untouched. **No migration, no rollback, and no schema change of any kind.**

## The fingerprint, and the one limitation worth naming

`portalCardFingerprintOf` is SHA-256 over what the adapter returned, lowercase hex — the same column
`0055` defines. Two sources travel with it:

- **`provider_fingerprint`** — the gateway's own stable identifier for a card. Two payments on the same card
  produce the same hash, so a block made from this stops the card. The gate proves the match.
- **`card_token`** — the Collect.js token this platform holds. The gateway's tokens are single use, so its hash
  identifies *that token* and not the card behind it: a token block stops a replay of that token and nothing
  more.

Both are supported because either may be the only thing an adapter returns, and the source is stored and
reported so nobody reads a token block as a card block. **The missing half is a stable provider card
fingerprint:** `nmi-api.ts` refuses customer-vault transactions (`customer vault transactions are not
supported`), so the NMI adapter returns no card hash today. Section 18 is satisfied as written — entries use one
of the two allowed identifiers — but per-card blocking needs that identifier from the adapter STEPs 149-152 owned.
This is named here rather than papered over with a hash of something that is not the card.

## The check, and the four answers it can give

`readPortalCardBlock` is one query — `company_id=is.null`, `status=eq.active`, `deleted_at=is.null`,
`card_fingerprint=in.(…)`, the six columns a decision needs and no wildcard — and three answers:

| Answer | Meaning | What the payment page does |
| --- | --- | --- |
| `clear` | nothing in force for any of the fingerprints | the charge proceeds exactly as before |
| `blocked` | a block is in force, with its reason, source, instant and expiry | refuses **before the gateway is asked**, `422` rule `card_blacklisted` |
| `unavailable` | the list could not be read, or a row is not the shape `0055` allows | refuses, `503` rule `card_blacklist_unavailable`; nothing is charged and no record is opened |

A temporary block ends by itself: nothing sweeps `expires_at` on a schedule, so the check reads the clock rather
than trusting the status (`portalCardBlockInForce`), and the gate proves a lapsed block is not a block.

**Fail closed.** A list that cannot be read is not a list that said no, so `unavailable` refuses. The same list
in STEP 066's shape — `createPortalCardBlockLookup().isCardBlocked` — throws `DEPENDENCY_FAILED` instead of
answering `false`, which is what `fraudAuditEntry`'s caller expects.

## The record a blocked attempt leaves

The processor asks the list **before** it opens a record, and a blocked card is then settled `failed` with the
code `card_blacklisted`; `payments_risk_reject_check` puts `risk_decision = 'reject'` on exactly that state. A
replayed attempt is recognised by that code and refused with the same rule, so a payer pressing the button twice
produces one block, one refusal entry and no second gateway request. Nothing was captured in any branch: the
gate asserts a gateway call count of **zero** for every blocked attempt.

## The entry, and why it names a person

`card_blacklist.blacklisted_by` references `public.users` and the table's trigger freezes it, so an entry is a
person's decision on an immutable list. This STEP therefore splits the referral STEP 186 hands it:

- **with an officer** (`createPortalCardBlacklistQueue({ actor })`) — the referral writes the block through
  `blockPortalCard`: fingerprint, source `card_token`, reason `fraud`, the payment as `source_payment_id`, the
  gateway's code in the note, and the officer as `blacklisted_by`. `durable: true`, answer `referred`. The gate
  proves the row body and the chain entry, and proves the same card referred twice is one row.
- **without one** (the runtime today) — no row is written. A `portal.card_block_requested` entry names the
  fingerprint, the payment, the signal and the gateway's code, and the answer is `refused` /
  `actor_required`. STEP 186 reports that as `card_referred: false`, which is true: the card is not on the list.

`blockPortalCard` and `releasePortalCard` are the service the compliance screen calls. Blocking validates the
fingerprint, the source, the reason, the note (required for `other`, trimmed, at most 500) and the expiry; a
duplicate is the unique index's conflict and answers `already_blocked` rather than an error. A release carries
the version it read and **reads the row back**, so a lost race is `stale` rather than a report of a release that
never happened; another officer's release is `already_released`, and a missing row is `not_found`. Both write one
chain entry, as the person who acted.

## What is real, and what this build cannot do

**Real:** the fingerprint contract, the single platform-wide query, every answer including the failures, the
refusal before the gateway, the settled `failed` record, the chain entries, the block and release services with
their validation and optimistic locking, the durable referral under an officer, the proposal under nobody, and
the whole path through `chargePortalPayment` over the real processor and adapter.

| The missing piece | What it is | Owner |
| --- | --- | --- |
| A stable provider card fingerprint | the gateway's card identifier, which needs customer-vault support in `nmi-api.ts` | adapter STEPs 149-152 |
| A compliance officer identity for the payment page | the `actor` the runtime passes as `null` today, so a referral proposes instead of blocking | the office block's settings (STEPs 068-078 own `app/(admin)/`) |
| The blacklist screen | list, search, block and release with the person's id and note | the office block (`app/(admin)/`); the service it calls is built here |

## Two previous gates, restated rather than weakened

STEP 186's gate made two statements about sources that this STEP changes, and both are restated as the claim
they always meant:

- "the page itself never promises a retry it does not make" was `portal-payment.ts` never containing the string
  `retry_permitted`. The page now records `retry_permitted: false` when it refuses for risk, so the assertion is
  `/retry_permitted: true/` never appearing — the stronger claim it was standing in for.
- "the runtime wires the referral queue this build has" was the runtime naming the in-memory queue. It now wires
  the durable queue over `card_blacklist` with no officer, which is the same list the gate's referrals were
  always going to reach, so the assertion names `createPortalCardBlacklistQueue`.

Nothing was loosened: both assertions still fail if the behaviour they are about regresses, and the 267 checks
of STEP 186 still pass unchanged.

## What was exercised

`node "app/(client-portal)/portal-blacklist-verify.ts"` — 208 checks:

- **vocabulary against the migration**: the two sources, the six reasons, the two states, the fingerprint
  alphabet equal to STEP 066's own constant, the note bounds, the settled code, the entities, five distinct
  audit actions;
- **the fingerprint**: a known SHA-256 vector for `abc`, the alphabet, one identifier from a token, two from a
  token and a provider fingerprint, trimming, and a blank fingerprint counting as none;
- **the row shape**: a `0055` row parses, a bad fingerprint / a third source / an unknown reason do not;
- **the life of a block**: no expiry in force, a future expiry in force, a lapsed one not, a released one not;
- **the check**: one query naming the platform's rows, the active status, the soft-delete skip, the six columns
  and no wildcard; clear, blocked with its reason and instants, a lapsed block clearing, both identifiers in one
  `in.(…)`, a provider-fingerprint block matching the same card, a malformed row failing closed, a database that
  is away failing closed, and an empty token asking nothing;
- **STEP 066's lookup**: false when clear, true when blocked, `DEPENDENCY_FAILED` when unreadable;
- **the payment page**: a listed card refused with `422` / `card_blacklisted`, **zero** gateway calls, the record
  `failed` with `card_blacklisted` and no transaction, the chain entry with the fingerprint, the reason, the
  source, `retry_permitted: false` and no token; the replay refused identically with `replayed: true` and still
  no gateway call; an unreadable list refused with `503` / `card_blacklist_unavailable`, no gateway call and no
  record at all; a clear list capturing exactly as before with nothing blocked;
- **the referral**: with an officer, one row with the hash, the source, the reason, the officer, the payment and
  the gateway's code in the note, one chain entry attributed to that person, and a second referral writing no
  second row; with nobody, `refused` / `actor_required`, no row, and the proposal in the chain;
- **the referral through the payment page**: a `250` answer still rejects the payment (STEP 186) *and* puts the
  card on the list, and the next attempt is then refused by the list itself without a gateway call;
- **block and release**: the written row's body, the chain entry, `already_blocked` for a listed card with no
  new row, six validation refusals, a release at the version read, `stale`, `not_found`, `already_released`, an
  empty note and an over-long note refused, and a version of zero refused by the schema;
- **the sentences**: two distinct sentences that both say nothing was charged, no four-digit code, the page
  ending on a block and *not* on an unreadable list (that one may be tried again);
- **the sources and the schema**: SHA-256, the platform-wide read, no wildcard, no card column named, the
  referral's durability tied to the actor, the runtime wiring both halves, the check before the gateway, the
  replay recognised by the code, and every column and constraint of `0055` plus the two `0037` bounds.

Mutation-checked, twice: letting an unreadable list answer `clear`, and ignoring a `blocked` reading in the
processor, fails the gate with **23 problems** — including a listed card capturing $100 from the recording
gateway.

## Verification

| Command | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npm run lint` | clean |
| `npm run build` | compiled; the four portal payment routes are dynamic (`ƒ`) |
| `node "app/(client-portal)/portal-blacklist-verify.ts"` | **208 checks** — listed card refused before the gateway with `card_blacklisted`, unreadable list failing closed, referrals durable only under a person, no migration needed |
| `node "app/(client-portal)/portal-fraud-verify.ts"` | 267 checks |
| `node "app/(client-portal)/portal-payment-verify.ts"` | 196 checks |
| `node "app/(client-portal)/portal-three-ds-verify.ts"` | 271 checks |
| `node "app/(client-portal)/portal-billing-match-verify.ts"` | 148 checks |
| `node "app/(client-portal)/portal-invoice-verify.ts"` / `portal-estimate-verify.ts` | 155 / 232 checks |
| `npm run check:audit` | 3645 checks |
| `npm run check:structure` | 654 source files |
| `npm run check:i18n` | 2667 messages, 294 placeholders |
| `npm run check:migrations` | 3572 checks, 122 migrations, 92 tables |
| `npm run check:errors`, `check:lint`, `check:config`, `check:env` | passed (202 / 77 / 10 sections / 16 vars) |

No environment variable was added; the referral's officer is an argument, not a secret.

## Left for the STEPs after this one

- **STEP 188** adds card and IP velocity limits beside this list: the counters of STEP 067 already exist and
  `FraudSignalLookups` already takes both, so the page gains one more pre-charge check in the same place.
- **STEP 189** connects the invoice link to the partial-payment service; the check will then run once per chosen
  amount, and the refusal must name the amount it refused.
- **STEP 190** builds the general payment link over the same hosted fields and the same two checks.
- The compliance screen that blocks and releases by hand is the office block's (STEPs 068-078 own
  `app/(admin)/`); `blockPortalCard` and `releasePortalCard` are the service it calls, with the officer's id as
  the actor and the version as the lock.
- A stable provider card fingerprint needs the adapter (STEPs 149-152); when it arrives, the page passes it to
  `checkPortalCardBlacklist` and the second source starts working with no other change.
