// path: README.md
# KD Solution IT

Enterprise multi-tenant SaaS payment facilitator platform for Asian merchants with
worldwide merchant country control. The platform runs on Next.js App Router, TypeScript
strict, Supabase PostgreSQL with row level security, and USD-only money handled as
numeric(18,4) with a decimal library.

## Documents that define this build

| Document | Purpose |
| --- | --- |
| docs/final/FEATURE_LIST.md | The single source of truth for scope |
| docs/final/MASTER_PROMPT.md | The rules every coding session must follow |
| docs/final/STEP_PLAN_250.md | The project split into 250 steps, one step per session |
| docs/final/HANDOFF_TEMPLATE.md | The template copied to docs/handoffs for every finished step |
| docs/final/PRODUCTION_CHECKLIST.md | Accounts, secrets and the go-live sequence |
| docs/handoffs/ | One completed handoff file per finished step |
| docs/planning/ | Planning notes, including the five sub-steps of STEP 001 |

## Requirements

- Node.js 26.13.0 LTS (pinned in .nvmrc, enforced by the engines field in package.json)
- npm 10.9.0 or newer

Both are enforced: .npmrc sets engine-strict, so installing on another runtime fails
immediately instead of failing later in production.

## Environment configuration

Every environment variable is declared once in `lib/env/manifest.ts`: name, scope, format,
requirement, secret flag, description and a safe placeholder. From that single file come the
zod validation, the typed accessors and the committed `.env.example`.

```bash
cp .env.example .env.local   # then replace the placeholders
npm run env:example         # regenerate .env.example after a manifest change
npm run check:env           # fails when the example file and the manifest disagree
```

- The server validates the contract at boot through `instrumentation.ts` and refuses to
  start when a required variable is missing or malformed. A production build does not need
  runtime secrets.
- Application code never reads `process.env` directly: server code uses `serverEnv()` from
  `lib/env/server.ts`, browser code uses `clientEnv` from `lib/env/client.ts`.
- Only `NEXT_PUBLIC_*` names may reach the browser. The schema rejects a client scoped
  variable without that prefix, and the client module imports types only, so the server
  schema can never leak into a client bundle.
- Validation errors name variables and rules, never values, so a boot failure is safe to
  read in a log.
- Real values live only in `.env.local` for development and in the hosting platform's
  environment settings for staging and production.

## Commands

| Command | What it does |
| --- | --- |
| npm install | Installs the pinned dependency tree from package-lock.json |
| npm run dev | Starts the development server on http://localhost:3000 |
| npm run build | Produces the production build |
| npm run start | Serves the production build |
| npm run typecheck | Runs the TypeScript compiler with strict mode and no emit |
| npm run lint | Runs ESLint over the repository |
| npm run check:structure | Verifies the canonical folder tree, path comments and forbidden markers |
| npm run check:env | Verifies that .env.example matches the environment manifest |
| npm run check:config | Verifies the typed configuration and refuses credential shaped keys |
| npm run check:i18n | Verifies the English string catalog |
| npm run check:logger | Exercises the structured logger, its redaction and its request context |
| npm run check:errors | Verifies the error code catalog and the error response format |
| npm run check:lint | Verifies the lint matrix: required rules, severities and exemptions |
| npm run check:shell | Verifies the shell contract and refuses colour outside the token file |
| npm run check:jobs | Exercises the job foundation: registration, validation, leases, retries, timeouts, scheduling and health |
| npm run check:migrations | Verifies numbering, rollback pairing, tenancy columns and the default-deny policy of every migration |
| npm run verify | Runs every gate, then typecheck, lint and build in that order |

## TypeScript configuration

The compiler runs in strict mode with the full safety matrix switched on, so an unsafe
pattern fails at typecheck time instead of at runtime in production:

- `strict` plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`,
  `noPropertyAccessFromIndexSignature`, `useUnknownInCatchVariables`
- `noUnusedLocals`, `noUnusedParameters`, `allowUnreachableCode: false`,
  `allowUnusedLabels: false`, `forceConsistentCasingInFileNames`
- `verbatimModuleSyntax` and `moduleDetection: force`, so a type import can never leak into
  the runtime bundle by accident
- target and lib are `ES2024`, below what Node.js 26.13.0 provides

Imports inside the repository always use the `@/` alias, which maps to the repository root
in the compiler, in ESLint and in the bundler:

```ts
import structure from "@/config/structure.json";
import { PLATFORM_SERVICE_SLUG } from "@/lib/constants/platform";
```

## Design system

Every visual decision lives in one file, styles/tokens.css, and reaches the interface
through Tailwind CSS 4 utilities. Three layers:

1. **Primitives** - raw palette steps (`--palette-ink-700`). Private to the token file.
2. **Semantics** - theme aware names (`--kd-background`, `--kd-surface`,
   `--kd-muted-foreground`, `--kd-border`, `--kd-primary`, `--kd-ring`, `--kd-destructive`,
   `--kd-success`, `--kd-warning`) defined once with the CSS `light-dark()` function.
3. **Tailwind** - `@theme inline` exposes the semantic layer, so a component writes
   `bg-surface`, `text-muted-foreground`, `border-border`, `rounded-card` or `shadow-card`
   and never a palette step or a colour literal.

The theme follows `color-scheme`: the operating system preference applies with no
JavaScript, and a `.light` or `.dark` class on any ancestor forces a theme. The token names
match the shadcn/ui vocabulary (background, surface, muted, primary, secondary, accent,
destructive, border, input, ring) so the component library added in a later STEP needs no
translation layer.

## Application configuration

Code level configuration lives in `config/` and is split by who may read it:

- `config/app.ts` - pure typed constants (money scale and minimum amounts, pagination bounds,
  login lock, payout cooling period, reconciliation deadline, dispute windows, subscription
  warning, cache lifetimes). Frozen, invariant checked at import, safe in a client bundle.
- `config/server.ts` - `getServerConfig()`: the safe subset derived from the validated
  environment (environment name and flags, application URL, storage provider, log level,
  monitoring). Server only, built lazily so a production build needs no runtime secrets.
- `config/verify.ts` - the configuration gate: re-runs the invariants and refuses a
  credential shaped key.

There is no barrel file, so every import names its side of the boundary (`@/config/app` or
`@/config/server`). Money is always a string with the numeric(18,4) scale; configuration never
introduces a JavaScript number for an amount.

## Strings and language

Every user facing string lives in `lib/i18n/strings/en.ts`. Nothing is written into a
component, a layout or a JSON file.

```ts
import { formatMessage, getMessage } from "@/lib/i18n/messages";

getMessage("home.eyebrow");                                   // no parameters
formatMessage("home.structureGate", { directories: 16, rootFiles: 13 });
```

- English is the schema: `TranslationCatalog` is derived from the catalog object, so a future
  locale must satisfy the same shape.
- Message paths are typed. A misspelled key is a compile error, not a blank label.
- Parameters are strict. A missing parameter throws and so does an unused one, which means a
  half substituted sentence can never reach a screen.
- Wording lives here, numbers do not. Amounts, limits and timeouts come from `config/app.ts`;
  the catalog only decides how a value is worded.
- `npm run check:i18n` fails on an empty or padded message, a malformed placeholder, a locale
  code that disagrees with the shipped locales, or a character outside English copy.

## Structured logging

Every server line comes from `lib/logger/logger.ts`. Writing to a stream directly is a defect.

```ts
import { logger } from "@/lib/logger/logger";

logger.info("invoice created", { invoiceId, tenantId, amount });
logger.error("provider call failed", { provider: "stripe", error });
```

- One call is one newline terminated JSON object with `level`, `time`, `message`, `service`,
  `environment`, the request context and the fields of the call. A log aggregator can parse it
  and an engineer can search it.
- `error` goes to `stderr`; `debug`, `info` and `warn` go to `stdout`. `LOG_LEVEL` filters the
  four levels before any serialization work happens.
- Redaction is the logger's job. A field named `password`, `token`, `authorization`, `cookie`,
  `apiKey`, `cardNumber` and similar is replaced by `[REDACTED]`, and every string is scanned
  for bearer tokens, JWTs, provider keys, AWS key ids, private key blocks and passwords inside
  URLs or `key=value` text. `npm run check:logger` proves a seed secret never survives.
- A request is wrapped once, and everything it calls shares one id:

  ```ts
  const requestId = request.headers.get("x-request-id");

  return runWithRequestContext(
    requestId === null ? { route } : { requestId, route },
    () => {
      logger.info("handled");
      return respond();
    },
  );
  ```

  The context lives in `AsyncLocalStorage`, so it survives `await` and timers without being
  threaded through every function. An inbound id that fails the safe alphabet is replaced by a
  generated UUID rather than rejected.
- Output is bounded: depth, collection size, string length and the whole record (16 KiB) are
  capped, a circular reference becomes `[circular]`, and a record that hits a limit carries
  `truncated: true`. A failing sink never throws into the request.
- `logger.child({ tenantId })` adds fields to every later line without losing the parent's,
  the request context, or the level.

## Error responses

Every failed API call answers with one JSON envelope, built in `lib/errors/respond.ts`.

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Some of the information sent could not be accepted. Check the highlighted fields and try again.",
    "requestId": "req_6e94639a-5564-4585-9a6a-91fbea9b6e38",
    "retryable": false,
    "details": [{ "field": "items[0].price", "rule": "invalid_type" }]
  }
}
```

- A route is wrapped once: `export const GET = withErrorResponse(handler)`. The wrapper opens the
  request context, catches a synchronous throw and an asynchronous rejection, writes one log
  line and returns the envelope. On success the handler's own response passes through untouched.
- `lib/errors/codes.ts` is the catalog: each code maps to an HTTP status, a message key in the
  string catalog and a retry flag. Codes are stable public identifiers and are never renamed.
- Throw `new AppError("RESOURCE_NOT_FOUND")` for a failure you understand, a `ZodError` or
  `validationError(details)` for input, and anything else becomes `INTERNAL_ERROR`.
- The raw error never leaves the server: an internal failure returns catalog copy, and the stack,
  the driver message and the cause go to the structured log only, where they are redacted.
- A validation detail carries a field path and a rule name. The rejected value is never echoed,
  because it can be a password or a card number.
- `retryable` and `retryAfterSeconds` say whether and when a retry can succeed; a delay also sets
  the `retry-after` header. Headers are always JSON, `no-store` and `nosniff`, plus
  `x-request-id` so a merchant can quote the id and an engineer can find the exact log line.
- `AUTHENTICATION_REQUIRED` is identical for an unknown account and a wrong password, so an error
  never reveals whether an account exists.

## Lint and typing rules

`npm run lint` runs ESLint over every source file, with type information from `tsconfig.json`.
The matrix lives in `eslint.config.mjs` and is grouped by intent:

| Layer | What it enforces |
| --- | --- |
| Framework | Next.js and React rules from `eslint-config-next` |
| Platform safety | No stream output outside the logger, no `eval` family, no loose equality, no `var` |
| Strict typing | No `any`, no `!` assertion, no `@ts-ignore`, type-only imports, no `require`, closed escape hatches |
| Promises | No floating promise, no promise in a condition, no `await` on a non thenable |
| Boundaries | English only source, and the environment read only through `lib/env/` |

- Every entry is an error. A warning in a gate is a rule that is already being ignored.
- `projectService` is on, so the promise rules see the same types the compiler sees. A forgotten
  `await` in a payment path is a lint failure, not a review comment.
- `local/english-only-source` scans code, comments and strings and allows only printable ASCII
  plus en dash, em dash, curly quotes, ellipsis, bullet and middle dot. A translated comment
  cannot enter the repository.
- `local/no-process-env` refuses a direct `process.env` read. The exemption list is one visible
  block in `eslint.config.mjs`: `lib/env/**`, `instrumentation.ts`, `scripts/**` and the tool
  configuration files.
- `npm run check:lint` proves the matrix itself: every required rule is present as an error, the
  local rules are registered, each failure probe fires, a clean probe stays clean, and ESLint's
  resolved configuration shows the exemptions exactly where they belong. It needs no file on
  disk, so it leaves no artefact behind.

## Application shell and theming

The document, the theme and the header are built once in `app/layout.tsx`.

- `<html>` takes its `lang` and `dir` from the string catalog and carries
  `suppressHydrationWarning`, because the theme class is applied before React hydrates.
- A small inline script in `<head>` reads the stored preference and sets `.light` or `.dark` on
  `<html>` before the first paint, so a dark preference never flashes a light page. STEP 059 adds
  the CSP nonce to that script element.
- `components/providers/` holds the client boundary (`AppProviders`) and the theme store. The
  provider uses `useSyncExternalStore`, so the stored preference and the operating system theme
  are external state rather than effects, and hydration stays deterministic. A change applies
  immediately, survives a reload, and follows a change made in another tab.
- `System` is the default and follows `prefers-color-scheme`. `Light` and `Dark` force a theme.
  The class lives on `<html>`, because `.light` and `.dark` set `color-scheme`, which is what every
  `light-dark()` token in `styles/tokens.css` reads.
- The switcher in `components/ui/` is three buttons in a labelled group with `aria-pressed`, so it
  is keyboard operable and does not rely on colour alone. Its labels come from the catalog.
- The shell is a skip link, a slim header with the brand and the switcher, and a focusable content
  wrapper. `app/page.tsx` renders the one `<main>`; navigation and footer arrive with the public
  site in STEP 231-238.
- `app/error.tsx` and `app/global-error.tsx` render the shared error panel with catalog copy and
  the framework's reference, never the raw error message. The root boundary supplies its own
  document and stylesheet because it replaces the root layout.
- Colour and palette steps live only in `styles/tokens.css`. `npm run check:shell` refuses a
  colour literal or a palette step utility under `app/` and `components/`, and refuses a layout
  that lost the script, the skip link, the catalog driven attributes or the provider boundary.

## Database schema and migrations

`migrations/` holds the append-only SQL that builds the database; `npm run check:migrations` is
the gate over it, and the STEP that adds a migration records its forward apply and rollback in its
handoff file.

- STEP 012 creates the first two tables. `public.companies` is the tenant root: `id` (UUID v7),
  `company_id` generated from `id` because the row is its own tenant, `name`, `slug`, and the
  audit columns `created_at`, `updated_at`, `deleted_at`, `version`. `public.job_queue` is the
  durable form of the `JobRecord` contract from `lib/jobs/queue.ts`, with a nullable `company_id`
  so platform wide work needs no fake tenant.
- STEP 013 adds the accounts. `public.users` is a person who can sign in, with a nullable
  `company_id` because office staff belong to no merchant company, a lowercase email that is
  unique for ever ("one person, one account"), the credential columns, and the encrypted TOTP
  secret and backup code hashes that section 22 makes mandatory. `public.role_assignments` records
  each grant of one of the seven roles with `granted_by` and `revoked_at`, so a permission change
  is history rather than an overwrite; the constraint `(role = 'owner') = (company_id is not null)`
  keeps an owner scoped to a company and a platform role out of one. A client is a tokenized link
  and never a user row.
- STEP 014 adds the office control surfaces. `public.office_permissions` delegates one dotted
  permission key (`payout.release`) to one office user, with an optional expiry and a revoke
  instant, so a temporary grant is a row rather than a role change. `public.delegations` records
  one office user handing one approval scope to another between two instants, and the delegate is
  never the delegator. `public.announcements` is a platform popup that stays a draft until
  `published_at` is set, and `public.announcement_dismissals` holds one row per person per
  announcement, which is how "a dismissed announcement does not appear again for that user" is
  enforced.
- STEP 015 adds the session layer of section 22. `public.device_proof_keys` is one enrolled device:
  the public half of a proof key, its fingerprint, and the instants that matter, first seen, trusted
  after the new-device confirmation, and revoked when the device is lost. `public.sessions` stores
  the *hash* of the rotating token, the `family_id` shared by every rotation, the parent each
  rotation replaced, the step-up instants, and a closed revocation vocabulary. The composite key
  `(user_id, device_proof_key_id)` means a session can only name a device of its own account, and
  `sessions_rotation_key` means a parent is rotated once: a replayed cookie ends the family, it does
  not open a second one.
- STEP 016 adds the lock of section 22. `public.login_attempts` records every attempt with its
  factor (`password`, `totp`), its outcome (`failed`, `succeeded`, `blocked`, `challenged`) and its
  origin address, which is what makes the failed attempt counters a query instead of a number in
  memory. `public.account_locks` is the resulting state: a two hour window the database refuses to
  extend, one open lock per account, an owner alert instant, and two mutually exclusive closures,
  an office unlock that requires the owner contact to be confirmed first, or an expiry that cannot
  be recorded before it happens. Nothing in `users` can clear a lock, which is how a password
  change fails to end one.
- STEP 017 adds the audit log of section 1. `public.audit_logs` is append-only in the strongest sense
  the database offers: a guard trigger refuses every update and every removal, whatever role asks.
  Rows are hash chained per tenant, with a generated `chain_id`, a gapless `sequence` and a
  `prev_hash` that a second guard checks against the current head before the row is written, and
  every row carries an Ed25519 signature and the id of the key that produced it. The canonical
  string the hash covers is defined once, in the migration, because a second definition would make
  every later verification meaningless. Merkle roots are computed from the chain by the export job,
  so the table stores the leaves and no roots of its own.
- STEP 018 adds the plan and price catalogue of sections 9 and 14. `public.plans` holds the plan
  code, name, price in minor units, currency, billing period and status, and `public.plan_entitlements`
  holds one row per service a plan includes, so a service is data rather than a column and "which
  plans include invoicing" is an indexed query. `public.pricing_versions` is a whole price list per
  row: the five fees the public pricing page names, each with its own payer, versioned by `revision`
  inside a scope derived from `company_id`, with a check that a price announced for a later date
  cannot take effect sooner than thirty days after its announcement.
- STEP 019 adds the subscription of sections 12 and 13. `public.subscriptions` is the agreement,
  not the money: it carries the plan it follows, the current cycle as explicit start, end and
  next due instants, and five status instants for pending, active, past due, stopped and
  cancelled, while every amount stays on the charge row that took it. One merchant has one live
  agreement, enforced by a partial unique index rather than by application code, and cancelling
  sets `cancelled_at` so a closed agreement stays as history and the merchant is free again.
  Saving a card is an explicit consent, so the text, its version, the instant and the address are
  recorded together or not at all, and a warning cannot be recorded earlier than seven days
  before the due date. `public.subscription_charges` is one attempt per row, keyed by
  subscription, period and attempt number so a retry is a new row and never an edit. Because
  section 12 takes the merchant balance first and the saved card second, each charge keeps that
  split: a succeeded attempt adds up to the amount, a failed or pending one took nothing, and a
  failure names its cause from a closed vocabulary with a detail short enough that no card number
  can be written there. Two failures on the due date stop the services, and the instant is on the
  row, so login and the billing page can stay open while everything else is closed.
- STEP 020 adds the three tables a merchant works with every day. `public.clients` is the person or
  business an invoice is addressed to, tenant scoped and soft deleted, with an address that is
  all-or-nothing from the street line downwards and an email that is unique per merchant under
  `lower(email)` while the row is live, so a mistyped client can be removed and the same address
  used again. `public.products` and `public.services` are two catalogues with one money rule:
  `unit_price_minor` in minor units beside an explicit currency, never negative and never a float,
  an optional SKU or service code that is unique per merchant for the rows that are not deleted, and
  a `unit` drawn from the closed list of `item`, `unit`, `hour`, `day`, `week`, `month` and
  `project` because the invoice prints the quantity and the word together. They stay two tables
  because a product is a good and a service is work billed by time, and STEP 021's line item stores
  its own snapshot of the name and the price, so retiring a product never rewrites an invoice that
  was already sent.
- STEP 021 adds the invoice and its history. `public.invoices` is a document, not a view: it
  snapshots the client name, email and address at issue time, carries the seven statuses of section
  16 with their own instants, keeps `subtotal`, `discount`, `tax`, `total` and `amount_paid` in
  minor units, and derives the total by trigger so the four can never disagree. A number is assigned
  at issue and unique per merchant, a partially paid invoice cannot sit below the 20 USD floor, and
  a paid invoice is held shut by a trigger against every change. `public.invoice_items` is a printed
  line: a snapshot of the description, unit and price, a decimal quantity, and a generated
  `line_total_minor` so the arithmetic has one rounding rule; an item trigger keeps the parent
  subtotal equal to the sum of the live lines and refuses any line change once the invoice has left
  `draft`. `public.invoice_events` is the append only timeline that a support call and a chargeback
  evidence pack read months later, and both child tables reach their invoice through `(invoice_id,
  company_id)`, so no row can join another merchant's document.
- STEP 022 adds the quote, its signature and the repeating invoice. `public.estimates` is a document
  that ends in a decision: it snapshots its client and its lines, derives its total the same way an
  invoice does, carries its own `expires_at`, and separates the two ways section 16 ends a quote
  with `void_reason` (`declined`, `expired`, `withdrawn`). `accepted` and `void` are terminal and
  held shut by a trigger, and the invoice a quote becomes is linked once through
  `converted_invoice_id`, so a quote cannot produce two invoices. `public.estimate_signatures` is
  the evidence section 16 asks for: signer, address, the consent wording and a flag the check forces
  to true, the instant, the IP, the geo location, the device fingerprint and the SHA-256 of the
  signed document, one row per quote, append only. `public.recurring_schedules` points at a draft
  invoice as its template rather than a second catalogue of lines, states its interval, run dates,
  due offset and reminder policy as columns, and has no retry column at all, because a failed
  recurring payment is never retried automatically.
- `public.uuid_generate_v7()` is defined in `0001`, because PostgreSQL before 18 has no native
  UUID v7. Ids sort by creation time, carry version nibble 7 and the RFC 4122 variant bits, and
  take their random tail from `gen_random_uuid()`.
- `public.set_row_metadata()` is a before-update trigger installed per table. It sets
  `updated_at = now()` and increments `version`, so optimistic locking cannot drift even for a
  hand written update; the application still writes `where id = $1 and version = $2`.
- Every table enables row level security and carries an explicit `<table>_default_deny` policy. A
  STEP that grants access adds a permissive policy beside it, never in place of it. The migrations
  do not force RLS, because the table owner and the service role must still be able to migrate and
  to enqueue.
- The queue's two hot queries have partial indexes: `(available_at, created_at)` for
  `pending`/`retrying` rows and `(lease_expires_at)` for `running` rows, so the store STEP's
  `for update skip locked` claim reads an index instead of the table. Idempotency is unique per
  tenant and separately unique for platform rows, with no sentinel company.
- Every migration file is one transaction, has a `.down.sql` beside it, and is validated by
  `migrations/verify.ts`: contiguous numbering, the six required columns on every table, an `id`
  default from the shared function, RLS plus a default-deny policy, and no forward file that
  drops or deletes.

## Background jobs

`lib/jobs/` is the contract every later job is written against; STEP 011 builds the foundation and
STEP 012 adds the table behind the same port.

- A job is a name, a `zod` payload schema and a handler, registered once on a `JobRegistry`. The
  payload is validated at enqueue and again before the handler runs, so a schema change after a
  deploy produces a clear `VALIDATION_FAILED` rather than a crash on a missing field.
- `enqueueJob` is the only call feature code makes. An idempotency key returns the first job with
  `deduplicated: true`, so a retried request cannot enqueue the same invoice twice, and the
  attempt ceiling comes from the definition rather than from the caller.
- `InMemoryJobQueue` is the development and gate store, and its snapshot says `memory` so nobody
  mistakes it for durable. `JobQueue` is the port; the SQL store arrives with the queue table in
  STEP 012 without a change to the worker, the scheduler or the route.
- A claim is a lease with an expiry. `releaseExpiredLeases` returns a stalled job to the queue with
  its attempt counter intact and `LEASE_EXPIRED` recorded, which is what keeps a job that kills its
  worker from looping forever.
- `JobWorker` runs one attempt at a time: a scoped log line, the job's trace id as the request id,
  an `AbortSignal` with the definition's timeout, and a retry decision taken from the error
  catalog. Retryable codes back off as `min(ceiling, base * 2^(attempt-1))` from configuration;
  `PERMISSION_DENIED` or `VALIDATION_FAILED` dies on the first attempt.
- `JobScheduler` is an interval clock, not a cron parser. Wall time is divided into slots and the
  slot index is part of the idempotency key, so two ticks in one slot enqueue one job. A schedule
  naming an unregistered job is rejected at registration.
- `app/api/jobs/health/route.ts` answers `200` while work is moving and `503` with the reasons when
  it is not: a stalled lease, a waiting job older than `stalledAfterSeconds`, or a job that died.
  `/api/health` stays the liveness endpoint.
- `npm run check:jobs` drives all of it on a controlled clock, and `getJobRuntime()` builds one
  queue, registry, scheduler and worker per process without starting a loop by itself.

## Repository structure

The canonical tree is machine readable in config/structure.json and is enforced by
scripts/verify-structure.mjs, so a missing folder or a missing path comment fails a
command instead of being discovered late.

| Folder | Contents |
| --- | --- |
| app/ | Next.js App Router: layouts, pages, route groups and route handlers |
| components/ | Shared React components, server first, client only where interactive |
| config/ | Typed application configuration and the canonical structure manifest |
| lib/ | Foundation libraries: security, logging, i18n, storage, integrations |
| migrations/ | Append-only numbered migrations with their rollback files |
| scripts/ | Repository verification and maintenance scripts |
| services/ | Domain services: clients, invoices, payments, refunds, billing, support |
| styles/ | Central design tokens: colour, radius, elevation, typography, easing |
| docs/ | Product documents, planning notes and step handoffs |

## Build discipline

- One session implements exactly one step of docs/final/STEP_PLAN_250.md.
- Every finished step writes docs/handoffs/STEP_NNN_COMPLETED.md in the same commit.
- Every file starts with a path comment on its first line.
- English only in code, interfaces, comments, seeds and content strings.
- No test files, no TODO, no FIXME and no placeholder text anywhere.
- Migrations are append-only and are never edited after they are committed.
