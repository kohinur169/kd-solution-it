// path: docs/planning/REPOSITORY_AUDIT_STEPS_001_080.md
# Repository audit - STEPs 001 to 080

Date 2026-11-02. Branch `arena/1dc51ec3-kd-solution-it`, audited from `58312e0` and repaired in the
commit that adds this file. The request was to read every STEP from 001 to 080 again and leave no
defect behind, so this file records what was checked, what was found and what was changed.

## What the repository is, in numbers

- 656 tracked files: 237 TypeScript files (88,535 lines), 103 migrations plus 103 rollbacks
  (21,849 lines), 172 documents.
- 80 handoffs (`docs/handoffs/STEP_001_COMPLETED.md` .. `STEP_080_COMPLETED.md`), one per STEP.
- 78 tables, 31 route handlers, 25 pages, 15 module gates beside the ten repository gates.
- 1,138 message strings, one locale.

## How it was checked

1. **History and state.** `git fetch`, `git hash-object` of every tracked file against the remote,
   `git status` clean, `node_modules` and `.env.local` present.
2. **Every gate, every module.** `npm run -s verify` (structure, env, config, i18n, logger, errors,
   lint, shell, jobs, migrations, typecheck, eslint, `next build`) and the fifteen module gates run
   one by one: auth, security, errors, i18n, logger, jobs, permissions, settings, audit-log,
   announcements, approvals, countries, gateways, office and onboarding.
3. **The whole migration chain, executed.** All 103 forward files applied in order to a fresh
   PostgreSQL (PGlite 0.5.14) over stubbed Supabase roles and `auth` helpers, then all 103 rollbacks
   applied in reverse. Result: 103 forward files applied, **78 tables, every one with RLS enabled and
   at least one policy, none without**; 103 rollbacks applied, **0 tables left**. This is the first
   time the chain was proved end to end rather than file by file.
4. **Seeds counted in the same database.** 250 ISO countries, 981 MCC codes, 5 payment providers,
   12 policy pages - the numbers the README and STEP 036's handoff state.
5. **Every insert and update against the live schema.** Each inline object literal passed to
   `rest.insert` / `rest.update` was parsed out of the source and compared with
   `information_schema.columns`: no unknown column, and no insert missing a `not null` column that has
   no default. (`audit_logs.chain_id` is generated and correctly absent; `business_profiles` was the
   one table whose code the audit changed, see below.)
6. **Every message call against the catalog.** Each `formatMessage("path", { ... })` was compared with
   the placeholders of that message and each `getMessage("path")` with the existence of the key:
   **0 mismatches, 0 missing keys, 0 templated message rendered without values**.
7. **Every route, twice.** All 31 route handlers enumerated: every `POST` is on `CSRF_PROTECTED_PATHS`
   and checks the token before it reads the session; the `GET`-only handlers answer `405` to a `POST`.
   All 25 pages requested against a running dev server: **no 500, no error page**; the signed-out
   states render, the eight office screens redirect (`307`) through `proxy.ts`, the merchant screens
   render their own refusals.
8. **Rule sweeps.** Path comment on the first line of every file (CSS uses `/* */`, SQL uses `--`),
   ASCII only, no `TODO`/`FIXME`/placeholder text, no `console.log`, no `any`, no committed test file,
   `package.json` and `package-lock.json` untouched since the base.
9. **Reachability.** No source file is unreferenced except the three that are referenced without an
   `import` statement: `app/global-error.tsx` (a Next.js convention), `lib/env/boot.ts`
   (`import()` inside `instrumentation.ts`) and `lib/env/generate-example.ts` (a `package.json`
   script).

## Defects found, and what was done

### 1. A check that could lose a field between two tabs (fixed, code)

`services/kyc/business-profile.ts` read the row, merged the body into it and wrote **all seven
columns** back. A second tab that had read the row a moment earlier would then put back the field the
first tab had just saved - the patch promise held for a single tab and not for two. The update now
carries only the columns the request named plus the derived `completed_at`; the insert still writes
the row whole. `checkBusinessSave` in `services/kyc/verify.ts` now asserts the exact key set of the
patch and that the field the other tab would have touched is not in it. The in-memory PostgREST the
gate uses applies patches the same way, so the test cannot pass on the old behaviour.

### 2. A lint warning left in the gate (fixed)

`services/kyc/verify.ts` carried a bare `silentAudit.entries;` expression - a leftover with no effect
that eslint reported as `no-unused-expressions`. Removed; `npm run lint` is now silent.

### 3. Five source files were not ASCII (fixed)

`lib/auth/proof-key.ts`, `lib/jobs/health.ts`, `lib/jobs/scheduler.ts`, `lib/logger/redact.ts` and
`lib/logger/serialize.ts` carried a typographic ellipsis or dash - four in comments and one in the
truncation marker the logger emits. Replaced with `...` and `--`; `lib/logger/verify.ts` now expects
`...[+1000 chars]`. Every `.ts`, `.tsx`, `.mjs`, `.js`, `.json`, `.sql` and `.css` file in the
repository is ASCII.

### 4. The merchant area's README stopped at STEP 079 (fixed)

`app/(dashboard)/README.md` listed the wizard but not the business form STEP 080 added. It now lists
`onboarding/business/`, its migration, its service, its route and the `ONBOARDING_STEP_FORMS` seam
the later forms extend.

### 5. The root README's schema section stopped at STEP 036 (fixed)

`README.md` describes the schema migration by migration up to STEP 036 and then fell silent, which
reads as "the database ends at `0079`". The 24 migrations from `0080` to `0103` are now listed in a
table beside the STEP that wrote each one, generated from the files themselves so the wording cannot
drift.

### 6. Six handoffs named commits this repository does not hold (recorded, not rewritten)

The handoffs of STEPs 021-026 name commits (`0365d62`, `28696f9`, `6d6023a`, `c456688`, `b25ff20`,
`81de8c0`) that do not exist here: STEPs 001-038 arrived in one root commit, `1dfd803`, which has no
parents. The hashes were accurate when written and the code they describe is in the tree, so the
handoffs were left as records and the explanation was added once, to `docs/handoffs/README.md`.

### 7. STEP 080's handoff numbers drifted with the repair (updated)

The business-profile gate grew from 660 to **663** checks and the catalog from 1,137 to 1,138
messages during this audit; the handoff now states both, and records the patch-only change of item 1
in its own words.

## What was checked and left alone

- **The `business_profiles_completed_check` difference.** The database refuses a completion stamp
  without six facts; the service also requires `trading_name` (Airwallex). The service is stricter, so
  no write can fail because of the difference. Loosening either side would let a profile be marked
  complete that a processor refuses, so the difference stays and is documented in the handoff.
- **`REQUIRED_BUSINESS_FIELDS` is all seven fields.** That is the union rule of section 5 working:
  drop Airwallex from the registry and `trading_name` becomes optional by computation.
- **The job runtime starts no timer and the queue is in memory.** `lib/jobs/runtime.ts` says so and
  the jobs gate asserts `store "memory"`; the STEP that owns durable background work wires the worker.
  A scheduler started now would enqueue into a store that dies with the process.
- **`GET /api/auth/csrf` answers `502` without a configured project.** The rate limiter reaches its
  store before the token is minted, so a deployment without `SUPABASE_URL` fails loudly rather than
  handing out tokens it cannot protect. With a configured project the route answers `200`; the dev
  smoke in every STEP 039+'s handoff shows it.
- **`rest.update` in most services does not send `version`.** The tables carry `version` and the
  trigger maintains it, but `RestClient.update` cannot report "0 rows matched", so a conditional
  update could not be retried honestly. The one place where the missing condition could silently lose
  a merchant's own field was fixed in item 1; the rest are single-writer paths (the office queue, the
  audit log, settings) where a lost update is a repeated action rather than a lost field.
- **Fifteen documents still hold a non-ASCII character**, and every one is a record of what a
  command printed: the two symbols a Next.js route table prints before a static and a dynamic route
  (in the handoffs of STEPs 002-014), one ellipsis written in a handoff of STEP 007, and four
  typographic dashes in two planning notes. They are quoted output, not prose, and no `.ts`, `.tsx`,
  `.mjs`, `.js`, `.json`, `.sql` or `.css` file holds one. This file names them, and holds none.

## Commands, and what they now say

| Command | Result |
| --- | --- |
| `npm run -s verify` | exit 0: 10 gates, typecheck, eslint (0 problems), `next build` |
| `npm run -s check:structure` | 17 directories, 14 root files, 261 source files |
| `npm run -s check:i18n` | 1,138 messages, 107 placeholders, 1 locale |
| `npm run -s check:migrations` | 3,006 checks, 103 migrations, 78 tables |
| `npm run -s check:shell` | 409 checks, 105 files |
| `node lib/auth/verify.ts` | 2,463 checks, 8 session keepers, 22 mutation files, 25 call sites |
| `node lib/security/verify.ts` | 2,376 checks |
| `node lib/errors/verify.ts` | 202 checks, 15 codes |
| `node lib/logger/verify.ts` | 117 checks |
| `node lib/jobs/verify.ts` | 110 checks |
| `node lib/permissions/verify.ts` | 425 checks, 16 permissions |
| `node lib/settings/verify.ts` | 551 checks |
| `node lib/audit-log/verify.ts` | 735 checks |
| `node lib/announcements/verify.ts` | 351 checks |
| `node lib/approvals/verify.ts` | 536 checks |
| `node lib/countries/verify.ts` | 467 checks |
| `node lib/gateways/verify.ts` | 467 checks, 5 providers, 0 adapters |
| `node components/office/verify.ts` | 545 checks, 12 screens |
| `node services/kyc/verify.ts` | 663 checks, 6 steps, 7 fields, 5 processors |
| migration chain (PGlite) | 103 forward, 78 tables all with RLS and a policy, 103 rollbacks, 0 tables left |
| `0103` proof (PGlite) | 12 checks including a negative control |
| dev server, 25 pages | no 5xx, no error page; 8 office screens redirect, merchant screens render refusals |

## What this audit cannot prove

That PostgREST and Supabase behave as the in-memory stand-ins do; that the migrations were applied to
the project this deployment uses; that a person can complete each flow at two widths; and that a
processor accepts the profile it is sent - those are deployment and integration facts, listed as
such in each handoff's "Deployment checks a person runs".
