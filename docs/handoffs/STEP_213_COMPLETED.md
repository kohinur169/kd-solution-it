# STEP 213 — Plan entitlement checks across merchant features

Status: **complete**. Commit `STEP 213: Plan entitlement checks across merchant features` on
`arena/65533bbe-kd-solution-it`, on top of STEP 212's `fd9a26e`. Typecheck, lint and the production build are clean,
`npm run verify` is exit 0 over **85 gate lines**, this STEP's gate is `services/billing/entitlements-verify.ts` at
**177 checks**, mutation-checked with **28 mutations, 28 caught**. No migration: the three tables this reads
(`subscriptions`, `plans`, `plan_entitlements`) already exist.

## STEP

From `docs/final/STEP_PLAN_250.md:2718`:

> **213. Plan entitlement checks across merchant features**

The FEATURE_LIST sentences it serves are section 9's second and third (`:115-117`):

> Sub-merchants use the services included in their plan, such as invoicing, payment links, recurring invoices, public
> API and store connections, and test mode.
> Services outside the plan are not usable by that merchant.

STEP 212 built the plan and which services it includes. This STEP is the **check**: given a merchant, is this feature
usable, and if not, why not - as one authority that a feature can call and a super administrator can read.

## Owned paths

| Path | State | Why it belongs to this STEP |
| --- | --- | --- |
| `services/billing/entitlements.ts` | new | the authority: the six features, the four states, the five verdicts, the guard, the cached reader, the office read |
| `services/billing/entitlements-runtime.ts` | new | the production wiring and the one reader per process |
| `services/billing/entitlements-verify.ts` | new | this STEP's gate, 177 checks |
| `app/api/office/entitlements/route.ts` | new | `GET` one merchant's entitlements, read only |
| `app/(admin)/entitlements/page.tsx` | new | the office screen and its role answer |
| `app/(admin)/entitlements/entitlements-console.tsx` | new | the company id field and the six verdicts |
| `components/office/navigation.ts` | modified | one `OfficeSection` member, one `OFFICE_NAVIGATION` entry, one import |
| `components/public/seo.ts` | modified | `/entitlements` added to the private prefix list, which that file's own gate demands |
| `lib/i18n/strings/en.ts` | modified | the `officeEntitlements` block and the two `office.sectionEntitlements*` sentences |
| `package.json` | modified | `check:billing-entitlements` and one link in `verify`, before `typecheck` |
| `docs/handoffs/STEP_213_COMPLETED.md` | new | this file |

No file outside `services/billing/`, this STEP's own screens and the four shared files above was edited. That is the
central constraint of this STEP and the largest gap it carries - see "The six features are named, not wired".

## Where the answer comes from

Three tables the schema block already built, read in the order the question is asked:

1. `subscriptions` (0017) - which plan the company is on, its status, and when the paid period ends. One live row per
   merchant, by `subscriptions_live_key`.
2. `plans` (0014) - whether that plan is still in force. `draft` and `retired` grant nothing.
3. `plan_entitlements` (0015) - which of the six services the plan includes.

STEP 212 built the third; **STEP 214 builds the first**. This module is the read both feed, and it is written to be
correct before and after a subscription can be written at all.

## Four states, five verdicts, one grant

| Merchant state | What it means | Verdict for a service |
| --- | --- | --- |
| `granted` | a live subscription on an active plan | `granted` if the plan includes it, `plan_missing_service` if not |
| `unassigned` | no live subscription | `plan_unassigned` |
| `not_live` | `pending`, `stopped`, `cancelled`, past its paid period, or on a plan that is draft, retired or gone | `plan_not_live` |
| `unreadable` | a read that failed | `plan_unreadable` |

`past_due` is deliberately **inside** `ENTITLED_SUBSCRIPTION_STATUSES`: section 12 says warnings start seven days
before the due date and services stop only when both the balance and the card fail, so a merchant who owes money keeps
working until the platform decides otherwise. `pending` never started, `stopped` has been stopped and `cancelled` is
history.

The five verdicts are the rules a refusal carries (`PERMISSION_DENIED`, 403, `field: "service"`), so a feature's
screen can answer "your plan does not include payment links" differently from "the platform could not read your plan
just now" - and neither of those is a payment error.

## Fail closed, including the merchant on no plan

The owner chose **deny by default**: a merchant with no live subscription is `unassigned`, and every gated service is
refused. That is the honest reading of section 9 - a plan is the source of services, and no plan includes nothing - and
it is the safe failure.

**The consequence is a deployment prerequisite, stated rather than hidden:** until STEP 214 can assign a plan to a
merchant, every merchant in a live system is `unassigned`, so **any feature that adopts this check is switched off for
everybody**. That is acceptable only because nothing adopts it yet (see the gap below). The order for the next STEPS
is therefore: 214 first, then adoption.

A read that fails is `unreadable`, which is also a refusal. A feature that cannot know whether it may run must not
run; the merchant sees the same sentence a smaller plan produces, and the office screen says which of the two it was.

## The six features are named, not wired - and why

`MASTER_PROMPT.md` is unambiguous: *"Work only on the files owned by that STEP. Never edit files owned by another
STEP."* The six features live in other STEPs' files - `app/api/invoices/`, `app/api/payment-links/` and
`app/(client-portal)/`, `app/api/public/v1/` with `lib/api/`, the store-connection routes, and the test-mode routes -
so this STEP ships the authority and **names the exact seam each of them adopts**, rather than editing eight to ten
files it does not own. The owner chose this option explicitly when asked at the start of the STEP.

| Feature | Service | Where the guard belongs |
| --- | --- | --- |
| Invoicing | `invoicing` | `app/api/invoices/route.ts` and the routes beside it, after `readRequestActor` and before the service call |
| Payment links | `payment_links` | `app/api/payment-links/route.ts`, and `app/(client-portal)/portal-payment-link-runtime.ts`, **replacing** the local `readPaymentLinksEntitlement` that already duplicates these two reads |
| Recurring invoices | `recurring_invoices` | `app/api/invoices/recurring/route.ts` |
| Public API | `public_api` | `lib/api/public-api.ts` inside `handlePublicApiCall`, after `authenticateApiCall` - one funnel for every `app/api/public/v1/**` route |
| Store connections | `store_connections` | the same funnel, selected by route: `app/api/public/v1/stores/woocommerce/connection` and `.../shopify/connection` |
| Test mode | `test_mode` | the same funnel: `app/api/public/v1/payments/[id]/simulate` and `.../webhook-test` |

Each is one call: `await getEntitlementReader().require({ companyId, feature: "payment_links" })`. The call throws a
`403` with the verdict and writes the chain entry; the route's existing `withErrorResponse` already renders it.

## What the gate proves (177 checks)

- **The vocabulary is section 9's** - six features in the catalogue's order, each needing exactly its own service, each
  with its own sentence, with the plan catalogue's own label key so the two screens cannot drift; an unknown word finds
  no feature, and case is not forgiven.
- **0017's statuses** - the five the schema allows are in the migration, and only `active` and `past_due` entitle.
- **No migration** - still 128 forward files; `subscriptions_live_key` and `plan_entitlements_live_key` are both
  there.
- **The verdict matrix** - granted, missing, unassigned, not live and unreadable, each by value, including "a stopped
  plan grants nothing even when its services are known" and "an unreadable answer refuses even when the caller holds
  services from elsewhere". A feature needing two services needs both.
- **The three reads** - exact query strings: columns named, tenant filtered, `deleted_at=is.null`, newest first,
  `limit=1`; the plan read; the services read. No subscription costs one query; a stopped, cancelled, pending or
  expired subscription costs one query and no plan read; a grant costs three.
- **Every state by value** - unassigned; `pending`/`stopped`/`cancelled`; an ended period; a draft, retired or missing
  plan; a stray service key filtered out and the catalogue's order kept; four malformed company ids refused before a
  query; and a failing read at each of the three steps answered as unreadable with no service carried.
- **The guard** - a granted feature returns the answer and writes nothing; each of the other five services refuses
  with `403`, `field: service`, `plan_missing_service`, one chain entry each, on the **merchant's** chain, naming the
  feature, the verdict, the plan's code and never an amount, a client or the merchant's content.
- **Unassigned, stopped and unreadable** - each refusal's rule, and the payload's `plan_id`/`subscription_status`
  showing why.
- **An unknown feature** - refused as `VALIDATION_FAILED` before any query and before the chain.
- **A chain that cannot be written** - the feature is still refused, with the verdict it reached.
- **One request, three queries** - six checks through the cached reader cost three queries; a mixed request costs
  three, not nine, while each refusal is still recorded; two merchants are two reads; an unreadable answer is cached
  and not retried.
- **The office read** - six verdicts in catalogue order, no chain entry for a read, `owner` refused before a query,
  a malformed id refused to the office too.
- **The route, the screen and the words** - a `GET` with no write and therefore no CSRF token, `no-store`, the company
  id read as a parameter and encoded by the console, the page's own role check, a label for every field, a verdict row
  that becomes a row from `sm` up, no fixed pixel width, the navigation entry bound to the role list, `/entitlements`
  private to crawlers, and all five verdict and four state sentences present, distinct and wired to the console.

### The mutations

28 mutations, **28 killed**:

| Mutation | Caught by |
| --- | --- |
| `stopped` added to the entitled statuses | the stopped-subscription case |
| `past_due` removed | the past-due case |
| the read role widened to `owner` | the pinned role list |
| the refusal action renamed | the pinned action |
| the chain entity renamed | the pinned entity |
| a seventh feature dropped from the catalogue | the six-count |
| a feature needing no service | "each feature needs exactly its own service" |
| `unassigned` answered as granted | the verdict matrix |
| a missing service answered as granted | the matrix |
| a two-service feature granted on one | the two-service case |
| the ended period ignored | the expired case |
| a draft plan granting | the draft case |
| stray services granted | "a service outside the six is not granted" |
| a failed read raised instead of refused | the unreadable case |
| withdrawn subscriptions read | the pinned query |
| newest subscription not preferred | the pinned order |
| services capped at five | the fixture's six-key answer |
| the feature validated after the read | "refused before a query" |
| the refusal moved off the merchant's chain | the chain-on-merchant assertion |
| the cache removed | "six checks cost three queries" (18) |
| the refuse branch inverted, twice | the refusals themselves |
| the office role check removed | `owner`'s refusal |
| the answer made cacheable | the `no-store` pin |
| the page's role check removed | the page's source pin |
| the company id left unencoded | the console pin |
| the navigation roles widened | the navigation pin |
| the segment left public to crawlers | the SEO pin |

## Security

| Question | Answer |
| --- | --- |
| Who may read a merchant's entitlements? | `super_admin`, checked in `readOfficeEntitlements` **before** the first query, and again on the page |
| Can a feature escalate by asking twice? | No - the verdict is a pure function of three rows, and a refusal is a refusal whether it is asked once or six times in a request |
| What happens when the database is down? | `unreadable`, which refuses. Fail closed, and named as its own verdict so the merchant is not told they are on a smaller plan |
| Is the new route a write? | No - `GET` only, no body, no CSRF token, and `no-store` so no cache keeps a paying merchant's plan |
| Is the company id a filter expression? | No - validated as a uuid before any query, and `encodeURIComponent`-ed into the `eq.` filter |
| What does a refusal record? | `billing.service_refused`, the feature, its services, the verdict, the plan's id/code/status and the subscription's status and period end - on the merchant's chain, with the merchant as the entity |
| What does it never record? | An amount, a client, an invoice, a description, or anything the merchant's business contains |
| Does a failed chain write grant the feature? | No. The refusal stands; the failure is named in the handoff rather than turned into a grant |
| Can a merchant read another merchant's plan? | The office route reads any company by id, but only `super_admin` may call it; a merchant's own features pass their own `companyId` from an authenticated principal (STEP 202's for the public API, the session's for the dashboard) |
| SQL injection? | Values only: uuids validated and encoded, no user string is ever concatenated into a filter expression |

## Verification

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | exit 0 |
| `npx eslint` over the touched files | exit 0 |
| `node services/billing/entitlements-verify.ts` | exit 0 - **177 checks** |
| `npm run verify` | exit 0 - **85 gates**, migrations 3778 / 128 / 99, i18n 3331 / 353, structure 829 source files, audit 4751, billing plans 233, public site 162 |
| `npm run build` (inside `verify`) | compiled successfully; `/entitlements` and `/api/office/entitlements` are dynamic |
| Mutation round | 28 mutations, **28 caught** |
| Desktop and mobile widths | **source review only**: a verdict row is `sm:flex-row` with `sm:items-end` badges, the panel is `sm:p-5`, inputs are full width, no element carries a fixed pixel width. No browser rendered it - see the gaps |

## Carried gaps (named rather than hidden)

1. **The six features do not call this check yet.** This is the STEP's largest gap and it is a direct consequence of
   the ownership rule: the authority, its gate, its chain entries and its office screen are complete, and the exact
   seam for each of the six is listed above. Until those seams adopt it, section 9's "not usable" is enforced for
   **nobody** - the one existing check (`portal-payment-link-runtime.ts`, a local duplicate of two of these reads)
   remains the only working gate, and payment links is therefore the feature that already behaves.
2. **A merchant on no plan is refused everything**, by the owner's decision. In a live system that means every
   adopting feature is off until **STEP 214** assigns plans. Deployment order: 214, then adoption.
3. **No subscription can be written in this tree.** STEP 214 owns that; `0017`'s columns (`status`,
   `current_period_start`, `current_period_end`, `next_due_at`) are read here and written nowhere yet.
4. **No merchant-facing screen.** A merchant cannot see what their plan includes from their own dashboard: that
   screen belongs to the dashboard STEPs. The office screen answers the same question for staff.
5. **The office screen needs a company id typed by hand.** There is no merchant directory in this STEP's ownership, so
   there is no picker, no list and no search - and a guessed default would show somebody else's plan.
6. **The cache is not invalidated.** The reader keeps one answer per merchant for the life of the process, and the
   contract in `entitlements-runtime.ts` says a caller holds it for one request. A long-lived caller that kept it
   would answer from a stale plan after a super administrator edits one.
7. **Nothing was run against a database or a browser.** The gate drives a fixture that honours `limit`, `eq.`, and
   `is.null`; `next start` refuses to boot here (seven missing production variables), so `/entitlements` is proved to
   compile and to be routed rather than to look right.
8. **Period expiry is a clock comparison, not a billing event.** A subscription whose `current_period_end` has passed
   grants nothing, which is the right reading of section 12's "services stop", but nothing writes the stopping, the
   warning or the resume - that is STEP 14/215's billing cycle, not this STEP's.
9. **A feature needing two services is supported but not used.** The data shape allows it (a recurring job would want
   `recurring_invoices` and `invoicing`); every one of the six needs exactly one service today, and the gate proves the
   two-service case only with a synthetic feature.
10. **No grace period and no per-merchant override.** There is no "this merchant may use invoicing until Friday" and no
    super-administrator exception that bypasses the plan. Section 9 does not ask for one; if it is wanted, it belongs in
    a later STEP with its own audit trail rather than a flag on this one.

## Next

**STEP 214 — Subscription assignment and status tracking** (`docs/final/STEP_PLAN_250.md:2734`). What it inherits from
here: `readMerchantEntitlements` as the read that already consumes a live subscription, `ENTITLED_SUBSCRIPTION_STATUSES`
as the statuses that keep a plan in force, the `plans` liveness rule (only `active` grants), and a gate that proves a
merchant without a subscription is refused rather than granted. What it must add: writing `subscriptions` for a
merchant and a plan, keeping `current_period_end` current so this check does not silently stop every service, and the
status transitions section 12 describes - because from the moment a feature adopts this check, an unmaintained period
end is an outage.
