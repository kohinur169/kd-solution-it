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
