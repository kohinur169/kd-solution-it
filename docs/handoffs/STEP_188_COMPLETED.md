# STEP 188 — Card and IP velocity limit enforcement on payment page

Status: **complete**. One commit, `STEP 188: Card and IP velocity limit enforcement on payment page`, on
`arena/ca936761-kd-solution-it`, branched from STEP 187's `5ec9403`. All gates green; the STEP's own gate is
`portal-velocity-verify.ts` at **204 checks**, mutation-checked.

## STEP

From `docs/final/STEP_PLAN_250.md`:

> **STEP 188 — Card and IP velocity limit enforcement on payment page**
> Count a card and an address each in a window against a limit whose defaults live in config; refuse an attempt
> over the limit on the payment page before any charge, with `429` and `retry-after`; the count survives a deploy
> and is shared across instances; the limit applied is the one frozen in the row; a counter that cannot answer
> never passes the payment.

FEATURE_LIST section 18, last clause: *"Card and IP velocity limits exist with defaults in config."*

Eight sub-steps, all done: the module, the processor seam, the service's refusal, the config defaults, the
runtime wiring, the sentences, the gate, the documentation. The database sub-step is a checked **proof that none
is needed** (`0056` and `0093`, STEP 067's), not an assumption.

## Owned paths

| Path | State | What it holds |
| --- | --- | --- |
| `app/(client-portal)/portal-velocity-fields.ts` | new | The vocabulary: subjects, defaults (from config), rules, audit action, policy schema, refusal payload |
| `app/(client-portal)/portal-velocity.ts` | new | The counting: two hits per attempt over STEP 067's `consume_velocity`, the breach entry, the STEP 066 lookup |
| `app/(client-portal)/portal-velocity-processor.ts` | new | The check the payment operation runs; the operator's policy validated once at build time |
| `app/(client-portal)/portal-velocity-verify.ts` | new | The gate, 204 checks |
| `app/(client-portal)/portal-payment-processor.ts` | edited | The `velocity` option and the second pre-charge check, before a record is opened |
| `app/(client-portal)/portal-payment.ts` | edited | `clientAddress`/`userAgent` on the request, the `refused_by_velocity` outcome, the `429` refusal and its audit entry |
| `app/(client-portal)/portal-payment-runtime.ts` | edited | Wiring `createPortalVelocityCheck` beside STEP 187's list |
| `app/(client-portal)/i/[token]/pay/charge/route.ts` | edited | The route's doc comment: the answer a limited card gets (comment only) |
| `app/(client-portal)/README.md` | edited | The STEP 188 section, and the documented order of the three pre-charge checks |
| `config/app.ts` | edited | `security.velocity` — the defaults section 18 asks for, validated against `0056`'s bounds |
| `components/payments/portal-form-refusal.ts` | edited | A `429` may now carry its own rule |
| `components/payments/portal-payment-refusal.ts` | edited | The three rules in the payment vocabulary |
| `lib/i18n/strings/en.ts` | edited | Three sentences |

`lib/security/velocity.ts`, `migrations/`, `lib/payments/`, `lib/auth/` and `lib/audit/` are untouched: STEP 067's
counter is imported and injected, never edited.

## The database sub-step: none is needed, and here is the proof

`velocity_counters` (migration `0056`, 92-table inventory) already carries everything a limit needs:

- `velocity_counters_subject_check` — `num_nonnulls(card_fingerprint, ip_address) = 1`, one subject per counter;
- `velocity_counters_fingerprint_check` — `card_fingerprint ~ '^[0-9a-f]{64}$'`, so a counter is keyed on a hash
  and never on a card;
- `velocity_counters_window_check` — `window_seconds between 1 and 2592000`, the bounds
  `portalVelocityPolicySchema` validates an operator's policy against;
- `velocity_counters_limit_check` — `limit_value >= 1`, so a limit that would allow nothing is impossible;
- `velocity_counters_platform_check` — `company_id is null`, a platform counter and not a merchant's;
- `velocity_counters_card_key` and `velocity_counters_ip_key` — one counter per subject, window start and length.

`0093` (`consume_velocity`) is the counter itself: six arguments (`p_subject`, `p_card_fingerprint`,
`p_ip_address`, `p_limit`, `p_window_seconds`, `p_now`) and six answer columns (`counter_hits`,
`counter_limit`, `counter_window_start`, `counter_window_seconds`, `counter_exceeded`, `counter_first_breach`).
It counts a hit up inside one statement, freezes the limit at the window's first hit (`velocity_counters_guard_count`
refuses a later change), and aligns the window to the epoch of `p_now`. **Nothing in this STEP writes a row or a
function.** The gate reads both migrations and asserts each of the above, plus that `0123` is still the next free
number: 122 committed migrations, the inventory the same as STEP 187 left it.

**Why a deploy cannot reset the count, and two instances cannot disagree.** The count is a column, not a
variable: `consume_velocity` does the read and the increment in one statement under the row's lock, so two
concurrent attempts see 1 and 2 in some order and never 1 and 1. A restart, a deploy, a second replica and a
different region all read the same table. The module keeps no counter of its own — the gate asserts the service
never inserts and never holds state between calls.

## The order of the three pre-charge checks

Section 18 grew the checks one STEP at a time, so the order is stated once, in the README and here:

1. **the list** (STEP 187) is **read** — an unreadable list refuses (`503`, `card_blacklist_unavailable`) rather
   than clearing a card nobody checked;
2. **the counters** (STEP 188) are **hit** — the card first, then the address; a breach refuses (`429`, retryable)
   and an unreadable counter refuses (`503`, `velocity_unavailable`);
3. **a payment record** is opened — an idempotency replay answers what the first attempt was answered, and only
   then does the page route and ask the gateway.

STEP 187's *verdict* is applied at step 3, because a blocked card is recorded as a `failed` payment with
`card_blacklisted` (`payments_risk_reject_check` needs `status = 'failed'` for a `reject`). That has one
consequence worth naming: a card already on the list still spends one velocity hit, because it is traffic against
that card and the counter is measuring traffic. What it does not do is reach the gateway, and it is refused by
the list's rule, not by a counter — the gate asserts exactly that.

A velocity refusal is deliberately **earlier** than STEP 187's record: a limit is about traffic, not money, so
the `payments` table holds no row for an attempt the platform turned away. The counter holds the count and the
chain holds the refusal.

## The defaults, and where they live

Section 18 says *in config*, so they are in `config/app.ts`:

```ts
security: {
  velocity: {
    card: { limit: 5, windowSeconds: 3_600 },
    ip: { limit: 20, windowSeconds: 3_600 },
  },
}
```

`config/verify.ts` validates them at boot against the bounds `0056` enforces, so a limit of zero or a window of
two months fails the config gate rather than the first payment of the day. `config/app.ts` is frozen and safe to
import from a client component (no secret, no environment variable), which is why the vocabulary can read it.

STEP 067's `VELOCITY_DEFAULT_POLICY` states the same two pairs as the platform's baseline. Two statements of one
number is one statement too many, so the gate asserts they agree — a change to one without the other is a failing
gate. The page applies **config**; STEP 067's constant stays the baseline other callers read.

An operator's policy travels as the policy argument, which is the same seam `createVelocityReader` already had.
Nothing here reads a settings table this repository does not have yet.

## What a limit means in counts

STEP 067 refuses the hit that **reaches** the limit (`counter_exceeded = hits >= limit`), which is the row's own
arithmetic and is what `readCounterAnswer` checks. So the default card limit of five allows **four** charged
attempts in an hour and refuses the fifth, and the default address limit of twenty allows nineteen. The gate
drives that at five, in place of a number made up for the test.

## One attempt is two hits, and the fingerprint is STEP 187's

`consumePortalPaymentVelocity` calls `consumeVelocity` twice: the card, then the address. Both are counted even
when the attempt is refused — a refused attempt is exactly the traffic a limit measures — and the second call is
skipped when the first counter cannot answer, because the attempt is already refused and there is no reason to
spend the address's window on it.

The value passed for a card is `portalVelocityCardFingerprint(token)`, which is STEP 067's
`velocityCardFingerprint` — SHA-256 over the token, the same function STEP 187's `portalCardFingerprintOf` is,
so the list and the counter name one card by one hash. The gate asserts the two agree for the same token, and
that a value shaped like a card number (`^[0-9]{12,19}$`) is refused by STEP 067 before it is hashed: this page
never holds a card number, and a 64 hex fingerprint passes through canonicalisation unchanged.

The refusal reports the card when both are breached, because the card is counted first; both counters travel in
the payload, so an operator sees the whole picture rather than half of it.

## The refusal, and the wait

`429 RATE_LIMITED` with `retryAfterSeconds` from the row (1–86400), the field `payment`, and a rule that says
which limit was reached:

- `velocity_card_limited` — this card has been tried too often inside the window;
- `velocity_ip_limited` — this network has;
- `velocity_unavailable` — the counters could not be read, so the payment was **not attempted** (`503`, fail
  closed).

`retry-after` reaches the payer through the route's existing error writer, which already writes
`AppError.retryAfterSeconds` as that header — STEP 183 built it, and this STEP adds no new plumbing. The form
reads the rule out of the envelope: `portalRefusalOf` used to answer every `429` with the generic confirmation
sentence, and now lets a `429` that names a rule answer with that rule's sentence, keeping the old sentence when
it names none. That is the one change to a shared reader; STEP 181–187's gates are unchanged and still pass.

Two chain entries, and they are different facts:

- `security.velocity_limited` — STEP 067's, written **once per window**, on the hit that reached the limit
  (`velocityAuditEntry` returns null for every later hit, so an attack cannot fill the chain with itself);
- `portal.payment_velocity_limited` — this page's, once per refused attempt, naming the rule, the subject, the
  count, the limit, the window, the wait, the card's fingerprint and both counters.

A chain writer that fails does not turn a counted attempt into a pass: the counter has already moved, and the
audit writer has its own retry.

## The form

No new component and no new markup. The three sentences are rendered by the alert the card form already has
(`role="alert"`, `text-sm font-medium text-destructive`, a `<p>` in a single column of existing classes) — they
wrap at narrow widths and stay one paragraph at wide ones, and none of them prints a rule name, a status code or
a wait in seconds a payer cannot act on. Each is under 220 characters, asserted by the gate. `portalPaymentRefusalIsFinal`
is **false** for both limit rules: a limit is a wait, so the form stays and a payer may try again, unlike STEP
186's rejection which ends the page.

Desktop and mobile widths: the markup is the one STEP 183's form shipped and STEP 186 checked — one column,
`text-sm`, no fixed width, no truncation — so 360 px and 1440 px lay the same paragraph out at two and one lines
respectively. There is no horizontal overflow to introduce, because nothing new is a box.

## The gate

`node "app/(client-portal)/portal-velocity-verify.ts"` — **204 checks**. It drives STEP 067's real
`consumeVelocity`, its canonicalisation, its audit entry, STEP 187's real check and STEP 183–187's real charge
path; the only fake is the PL/pgSQL function, implemented to the contract `0093` documents (one row per subject
and window, hits counted up, the limit frozen at the window's first hit, the window aligned to `p_now`), with
the argument names the gate checks against the migration so the fake cannot drift.

- **the vocabulary**: two subjects, the config defaults, three distinct rules, the audit action and entity, the
  rule by subject;
- **the policy**: defaults when absent, an operator's override accepted, and six invalid policies (a limit of
  zero, a window of zero, a window past thirty days, one subject, an unknown key, a fractional limit) refused at
  build time with `INTERNAL_ERROR`;
- **the fingerprint**: the same hash STEP 187 names the card by, in the 64 hex alphabet, and a card-shaped value
  refused;
- **the two hits**: two calls per attempt, card first, address second, keyed on the fingerprint and the address,
  carrying the operator's limit, window and instant;
- **the breaches**: the card's, the address's, both at once (the card reported, both counters carried), and the
  wait, which never exceeds the window;
- **the window**: an attempt in the next window starts the count again;
- **the failures**: a card counter that cannot answer refuses and does not spend the address's window; an
  address counter that cannot answer refuses with its own reason;
- **the chain**: one breach entry for three attempts once the limit is reached, with subject, count, limit and
  fingerprint, and the payer's address on the entry; a chain that throws does not turn a breach into a pass;
- **STEP 066's lookup**: hits and limit for either subject, one hit per read;
- **the page**: with the **default** policy, four attempts are charged and the fifth is refused `429` with
  `velocity_card_limited`, the gateway asked four times, four records, one refusal entry carrying hits 5, limit 5,
  window 3600 and the fingerprint, plus exactly one `security.velocity_limited`; with an operator's policy of
  three, the third attempt is refused and the chain shows the operator's numbers; a second card from one address
  is refused with `velocity_ip_limited`; counters that cannot answer are `503` with `velocity_unavailable`, **no
  gateway call and no record**; a listed card is refused by **the list's** rule with the list read first, no
  gateway call and no breach written;
- **the sentences**: three different sentences, each under 220 characters, none printing a rule or a code, both
  rules not final, and the form reading the right sentence out of a `429` — while a `429` with no rule keeps the
  confirmation sentence it always had;
- **the sources and the schema**: the page calls `consumeVelocity` and never inserts, the breach entry is STEP
  067's, the policy is validated at build time, the runtime wires the check, the list read is before the counters
  and the counters before the gateway, the service refuses as `RATE_LIMITED`, and every constraint, index,
  argument and answer column `0056`/`0093` provides — with no migration added.

Mutation-checked: making the card breaker be ignored **and** the processor observe a breach and carry on fails
the gate with **28 problems**, including *"the fifth attempt reaches the default card limit and is refused
(nothing was thrown)"*, *"the gateway was not asked a fifth time"* and *"no payment record exists for the attempt
the platform turned away (expected 4, got 5)"* — money moving past the limit. Both files restored; the gate back
to 204.

## What is real, and what this build cannot do

- The counter, the fingerprint, the window arithmetic, the frozen limit and the breach entry are STEP 067's,
  unmodified. This STEP is the caller: two hits, one order, one refusal.
- The gateway is never asked for a refused attempt, asserted by a call count of zero in three scenarios.
- The address is the request's own address, read by the route from the connection - a browser cannot name it in
  the body, because the charge body schema is `.strict()` and a `client_address` field is a refused field, not a
  claim.
- An operator's policy is an argument, not a database row: the settings screen that will write one belongs to a
  later STEP, and `config/app.ts` is where the default lives until then.
- The gate cannot exercise PL/pgSQL; it asserts the migration's text and implements its documented contract. The
  concurrency guarantee (two instances, one row) is the table's, not this page's.

## Verification

| Command | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npm run lint` | clean |
| `npm run build` | compiled; `/i/[token]/pay/charge` still dynamic (`ƒ`) |
| `node "app/(client-portal)/portal-velocity-verify.ts"` | **204 checks** |
| `node "app/(client-portal)/portal-blacklist-verify.ts"` | 208 checks |
| `node "app/(client-portal)/portal-fraud-verify.ts"` | 267 checks |
| `node "app/(client-portal)/portal-payment-verify.ts"` | 196 checks |
| `node "app/(client-portal)/portal-three-ds-verify.ts"` | 271 checks |
| `node "app/(client-portal)/portal-billing-match-verify.ts"` | 148 checks |
| `node "app/(client-portal)/portal-invoice-verify.ts"` / `portal-estimate-verify.ts` | 155 / 232 checks |
| `npm run check:config` | 10 sections, **32 values** (5 money entries) — was 28, the four velocity numbers are new |
| `npm run check:i18n` | 2670 messages, 294 placeholders, 1 locale — was 2667, the three sentences are new |
| `npm run check:audit` | 3673 checks |
| `npm run check:structure` | 658 source files — was 654, the four modules are new |
| `npm run check:migrations` | 3572 checks, 122 migrations, 92 tables |
| `npm run check:errors` | 202 checks, 15 codes |
| `npm run check:lint` | 77 checks, 26 rules, 11 probes |
| `npm run check:env` / `check:logger` / `check:jobs` / `check:shell` | 16 / 117 / 110 / 954 checks |

## Left for the STEPs after this one

- A settings screen for `security.velocity` so a merchant's policy is a row rather than an argument (the
  vocabulary and the policy argument are already the seam).
- A sweep job for `velocity_counters`: STEP 067's `sweepVelocityWindows` exists and no worker calls it yet; the
  retention number it takes belongs to the settings STEP.
- STEP 189 and later (`docs/final/STEP_PLAN_250.md`), which own whatever section 18 says next.
