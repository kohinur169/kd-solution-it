# STEP 212 — Plan creation by super_admin with price, period and services

Status: **complete**. Commit `STEP 212: Plan creation by super_admin with price, period and services` on
`arena/65533bbe-kd-solution-it`, on top of STEP 211's `2362ace`. Typecheck, lint and the production build are clean,
`npm run verify` is exit 0 over **84 gate lines**, this STEP's gate is `services/billing/plans-verify.ts` at
**233 checks**, mutation-checked with **27 mutations, 27 caught**. No migration: the two plan tables already exist.

## STEP

From `docs/final/STEP_PLAN_250.md:2704`:

> **212. Plan creation by super_admin with price, period and services**

The FEATURE_LIST sentence it serves is section 9's first line (`:114-117`):

> super_admin creates plans: name, price, period and which services each plan includes.
> Sub-merchants use only the services in their plan (invoicing, payment links, recurring invoices, public API, store
> connections, test mode). Services outside the plan are not usable by that merchant.

The first sentence is this STEP. The second and third are **STEP 213's** ("Plan entitlement checks across merchant
features") and are not implemented here - what this STEP does is leave the read side 213 needs: a plan, its services,
and a view of both that any feature can ask for.

## Owned paths

| Path | State | Why it belongs to this STEP |
| --- | --- | --- |
| `services/billing/plans-registry.ts` | new | the vocabulary: the four columns, the six service keys, the two periods, the three states, every rule word, the code slug rule |
| `services/billing/plans.ts` | new | the service: `listPlans`, `createPlan`, `parsePlanDraft`, the role check, the compensation |
| `services/billing/plans-runtime.ts` | new | the projection of `getAuthRuntime()` the screen and the route share |
| `services/billing/plans-verify.ts` | new | this STEP's gate, 233 checks |
| `app/api/office/plans/route.ts` | new | `GET` the catalogue, `POST` one plan |
| `app/(admin)/plans/page.tsx` | new | the office screen, four states |
| `app/(admin)/plans/plans-console.tsx` | new | the creation form and the catalogue beside it |
| `components/office/navigation.ts` | modified | one `OfficeSection` member, one `OFFICE_NAVIGATION` entry, one import |
| `components/public/seo.ts` | modified | `/plans` added to the private prefix list, which that file's own gate demands of every new top-level segment |
| `lib/i18n/strings/en.ts` | modified | the `officePlans` block and the two `office.sectionPlans*` sentences |
| `package.json` | modified | `check:billing-plans` and one link in `verify`, before `typecheck` |
| `docs/handoffs/STEP_212_COMPLETED.md` | new | this file |

Nothing else was touched. `migrations/0014_plans.sql` and `migrations/0015_plan_entitlements.sql` are read-only here.

## No migration, and why that is the right answer

The schema block already built this STEP's tables at STEP 018:

- `public.plans` — `code` (`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`, 2-39, globally unique through `plans_code_key`), `name`
  (1-80, trimmed), `price_minor bigint >= 0`, `currency` (`^[A-Z]{3}$`), `period in ('monthly','yearly')`,
  `status in ('draft','active','retired')`, `published_at`, `sort_order`, `version`, `company_id`, `deleted_at`.
- `public.plan_entitlements` — one row per (plan, service), live unique key, service key `^[a-z][a-z0-9_]*$`.

Every field the STEP's title names is therefore **already constrained by the database**, and both tables are
default-deny under RLS. A migration here would have been a second, weaker restatement of rules that exist, so this STEP
writes rows instead of tables. The gate proves that claim rather than asserting it: it reads `0014`'s own SQL text and
compares the registry's code pattern, name ceiling, currency pattern, periods and states against it, and reads
`0015`'s comment for the six service keys.

The migration count is unchanged at **128**, and the next free number is still **129**.

## Decisions

**The catalogue lives in code.** `0015`'s own comment says so ("The catalogue lives in code"), and section 9 names the
first six entries. `BILLING_PLAN_SERVICE_KEYS` is that frozen list: `invoicing`, `payment_links`, `recurring_invoices`,
`public_api`, `store_connections`, `test_mode`. A key outside it is refused by name, so an operator who types
`payments` is told that `payment_links` is the word the catalogue uses.

**A price is an integer number of minor units, and the conversion is the form's.** The service accepts `priceMinor` as
an integer and nothing else; `plans-console.tsx` turns the typed `19.99` into `1999` from the digits themselves
(`whole * 100 + fraction`), never by multiplying a float, and refuses a third decimal place instead of rounding it.
The service's ceiling - 100,000,000 minor units - is this STEP's decision, not the schema's: `0014` only forbids a
negative price.

**A code is reserved for ever.** `plans_code_key` covers withdrawn rows too, so a code that once belonged to a deleted
plan still answers `code_taken`. That is stated in the string catalog and in the form's hint rather than being left
for an operator to discover.

**A plan is never half written.** A plan and its services are two inserts; if the second fails, the plan is withdrawn
with one soft delete at the same instant, the error is rethrown, and no chain entry claims the plan exists. A plan that
included nothing would be a plan a merchant could buy and use nothing of - exactly the state section 9's second sentence
forbids.

**Entitlement removal is a soft revoke.** The live unique index frees the pair and the history stays explainable, which
is the shape STEP 213 needs when it explains *why* a merchant cannot use a service today. This STEP only reads
entitlements (`deleted_at=is.null`), so 213 inherits the convention rather than inventing a second one.

**Authorization is in the service, not the route and not the database.** Both tables are default-deny for RLS, and the
office writes with the service role, so the database cannot be the gate. `createPlan` and `listPlans` each call
`requireAnyRole(actor, BILLING_PLAN_ROLES)` beside the write they guard, and the page asks the same question again so it
can answer with a sentence instead of an empty list. A second entry point cannot reach a weaker path than the screen.

**The audit entry is awaited plainly.** If the chain cannot be written after the row exists, the operator sees a
failure for a write that happened - and a retry answers `code_taken`, which is the honest pair of facts. Swallowing the
chain failure would hide an outage, and writing the entry first would leave a false one.

## What the gate proves (233 checks)

- **No migration** — 128 forward files, the only two plan migrations are the schema block's, and `0014`/`0015` still
  contain the constraints the registry repeats.
- **The vocabulary is the schema's** — code pattern and bounds, name bounds, `price_minor >= 0`, currency pattern, the
  two periods, the three states, the service-key pattern and the six named keys.
- **The registry's decisions** — the role list, the chain action, the entity, the default currency, the price ceiling,
  the sort-order ceiling, the catalogue bound, and the seventeen rule words pinned **as words** rather than as
  constants (a renamed rule word fails the gate; that mutation was the one survivor of the first round).
- **`planCodeFrom`** — `Growth Yearly` to `growth-yearly`, trimming, a short name, a name with no usable character, and
  a one-letter name refused rather than shortened.
- **`monthlyEquivalentMinor`** — monthly is itself, yearly is divided by twelve and **floored**: `10007` answers `833`,
  not `834`, and `24000` answers `2000`.
- **Nineteen refusals** — each by value, each naming its field and its rule: a body that is not an object, five bad
  codes, a blank name, a name past eighty, a missing price, a price as a string, a price with a fraction of a minor
  unit, a negative price, a price past the ceiling, a two-letter currency, `weekly`, no services, an unknown service, a
  duplicated service, a negative sort order, a non-boolean publish.
- **Who may write** — `owner` is refused `PERMISSION_DENIED` on both the read and the create, at the service.
- **The two reads** — columns named and never starred, `deleted_at=is.null`, `order=sort_order.asc,code.asc`, the
  services fetched as one `plan_id=in.(...)` query, and an empty catalogue costing one query rather than two.
- **Odd rows** — a plan whose stored status is outside the schema's three is skipped rather than shown as an unknown
  word; a service outside the six is not in a plan's page.
- **Creation** — the insert's exact payload (code, name, price, currency upper cased, period, `status` and
  `published_at` for a published plan, `draft` and null for an unpublished one, `sort_order`, `company_id: null`), one
  entitlement row per service in the catalogue's order, the read-back in the answer, and one chain entry naming the
  code, the price and the services.
- **The refusals around creation** — a code that already exists (`CONFLICT/code_taken`, nothing inserted), a race that
  reaches the insert's own `23505` (told the code is taken rather than that the platform broke), an entitlement write
  that fails (the plan withdrawn at the injected instant, no chain entry), an insert that answers no row
  (`INTERNAL_ERROR/not_written`), and a chain that cannot be written (the error the operator sees, and the row that
  exists beside it).
- **The screen and the route, from source** — CSRF, the eight-kilobyte ceiling, the device proof over the exact bytes,
  the service calls, the page's own role check, the price converted from digits and never rounded, the two headers, a
  label for every field, one column on a phone and two from `sm` up, a wrapping plan header, no fixed pixel width, a
  decimal keyboard for the price.
- **The screen's words** — every one of the seventeen rule words mapped to a sentence, every mapped sentence present in
  the catalog, no two rule words alike, and the three states, two periods and six services each reading differently
  from each other.

### The mutations

27 mutations, **27 killed**, in two rounds:

| Mutation | Caught by |
| --- | --- |
| roles widened to `["super_admin","owner"]` | the pinned role list |
| price ceiling 100,000,000 to 1,000,000,000 | the pinned ceiling |
| monthly figure rounded instead of floored | `10007` answering `833` (survived the first round: the first case was `10001`, which rounds to the same number - the case was fixed, not the gate loosened) |
| default currency USD to EUR | the pinned default |
| code floor from two characters to one | `planCodeFrom("a")` |
| code pattern made case-insensitive | the capitalised-code refusal |
| chain action renamed | the pinned action |
| one rule word renamed | the rule words pinned as words (survived the first round, which compared the service against its own constant - the pin was added) |
| an active plan labelled as a draft | the three labels differing |
| name ceiling from eighty to eight hundred | the long-name refusal |
| duplicated service allowed | the duplicate refusal |
| price ceiling ignored in the service | the ceiling refusal |
| currency not upper cased | the `EUR` normalisation |
| services kept in form order | the catalogue-order assertion |
| existing code not read | the taken-code conflict |
| compensation weakened (`deleted_at: null`) | the withdrawn instant |
| chain action computed | the pinned action in the entry |
| catalogue order dropped | the query assertion |
| withdrawn plans shown | the `deleted_at=is.null` assertion |
| services not read back | the read-back's services |
| every plan created active | the draft assertion |
| create's role check removed | `owner`'s refusal |
| CSRF line removed from the route | the route's source pin |
| page's role check removed | the page's source pin |
| price multiplied as a float | the digit-conversion pin |
| device proof removed | the proof pin |
| nav roles widened | the navigation pin |

## Security

| Question | Answer |
| --- | --- |
| Who may create a plan? | `super_admin`, checked in `plans.ts` beside the write, and again on the page |
| Is the write CSRF protected and device proved? | Yes - `requireCsrfToken`, then `verifySensitiveRequest` over the exact bytes, before the parse |
| Is the body bounded? | Eight kilobytes, by `content-length` and again by the decoded bytes |
| Can a merchant read another tenant's plan? | There is nothing tenant-scoped to read: a plan has `company_id: null` by construction, and the catalogue is the platform's |
| What does a refusal leak? | A field and a rule. Never the value that failed, never the row that clashed |
| What does the chain record? | The action, the account, the plan's id, the code, the name, the price, the currency, the period, the status, the sort order and the services - on the platform chain (`companyId: null`) |
| What does the log line record? | The actor and the catalogue size. Not the plan's values, not the address |
| SQL injection? | Every filter is `eq.`/`in.()` over values the service validated, and every uuid is `encodeURIComponent`-ed into the `in.()` list |
| Why can the database not enforce who writes? | Both tables are default-deny for RLS and the office holds the service role, so authorization lives in the service. That is recorded rather than pretended |

## Verification

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | exit 0 |
| `npx eslint` over the touched files | exit 0 |
| `node services/billing/plans-verify.ts` | exit 0 - **233 checks** |
| `npm run verify` | exit 0 - **84 gates**, migrations 3778 / 128 / 99, i18n 3293 / 347, structure 823 source files, audit 4716, public site 162 |
| `npm run build` (inside `verify`) | compiled successfully; `/plans` and `/api/office/plans` are dynamic routes |
| Mutation round | 27 mutations, **27 caught** |
| Desktop and mobile widths | **source review only**, and honestly: the form is `grid gap-4 sm:grid-cols-2`, the plan header is `flex flex-wrap items-center`, inputs are full width, no element carries a fixed pixel width, and the price field offers a decimal keyboard. No browser rendered it - see the gaps |

## Carried gaps (named rather than hidden)

1. **Nothing was run against a database.** The gate drives a fixture that honours `limit=`, `order` and the filters the
   service writes; the rows the real PostgREST returns were never seen. A `plan_entitlements` insert that violates the
   live unique index would surface as `CONFLICT` from `RestClient`, which the compensation path treats as a failure and
   withdraws - correct, but unexercised.
2. **No browser rendered the screen.** `next start` refuses to boot in this environment (seven missing production
   variables), so `/plans` is proved to compile and to be routed, not to look right. The width review is source-level.
3. **No publish, edit, retire or delete.** This STEP creates. `0014`'s `published_at`, `status` and `version` are
   written once; a catalogue that can be created but not corrected is the smaller half, and the next STEP that needs
   the other half will find the column ready.
4. **No entitlement enforcement.** Section 9's second and third sentences are STEP 213's. Nothing in invoicing, payment
   links, the public API or a store connection consults a plan today.
5. **No subscription.** `0017_subscriptions.sql` exists and nothing writes to it; a plan is not yet sold.
6. **Sort order is typed by hand.** There is no drag-to-reorder and no automatic ordering; two plans may share one
   `sort_order` and then be ordered by code.
7. **The catalogue is one page of two hundred.** No pagination, no search, no filter by state. Past two hundred plans
   the list stops rather than paging.
8. **A currency is validated but not exercised.** Any three upper case letters is accepted, as `0014` and the invoice
   schema both allow, but nothing charges in a plan's currency yet, and `monthlyEquivalentMinor` is a floored display
   figure that must never be used to bill.
9. **No rate limiter of this route's own.** A write is CSRF protected and device proved; the platform's other limits
   (sessions, sign-in) do not cover this path. A super administrator creating plans in a loop is bounded only by the
   code's uniqueness.
10. **The chain's failure mode is visible, not silent.** A chain write that fails after the row exists leaves a plan
    with no entry and shows the operator an error; the retry answers `code_taken`. That is deliberate and recorded, but
    it means "no entry" does not prove "no plan".

## Next

**STEP 213 — Plan entitlement checks across merchant features** (`docs/final/STEP_PLAN_250.md:2718`). What it inherits
from here: `BILLING_PLAN_SERVICE_KEYS` as the canonical six, `planStatusLabelKey`/`planServiceLabelKey` for any sentence
it prints, the soft-revoke convention for entitlement removal, `PlanView.services` as the read side it enforces, and a
gate that already proves the six keys match `0015`'s comment. What it must add: a subscription or association from a
merchant to a plan, a check in front of each of the six services, and an answer a merchant can understand when a
feature is outside the plan they bought.
