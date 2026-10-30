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
| npm run verify | Runs the structure gate, typecheck, lint and build in that order |

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
| docs/ | Product documents, planning notes and step handoffs |

## Build discipline

- One session implements exactly one step of docs/final/STEP_PLAN_250.md.
- Every finished step writes docs/handoffs/STEP_NNN_COMPLETED.md in the same commit.
- Every file starts with a path comment on its first line.
- English only in code, interfaces, comments, seeds and content strings.
- No test files, no TODO, no FIXME and no placeholder text anywhere.
- Migrations are append-only and are never edited after they are committed.
