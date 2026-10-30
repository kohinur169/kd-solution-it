// path: docs/planning/STEP_002_SUBSTEP_BREAKDOWN.md
# STEP 002 - Re-divided Into Five Sub-Steps

Owner instruction for this STEP: implement STEP 002, split it into five sub-steps first,
implement the sub-steps one by one, and target Node.js 26.13.0 LTS for the whole project.

## 1. Scope Confirmed From The Source Documents

### STEP 002 as written in docs/final/STEP_PLAN_250.md
- Number and title: STEP 002 - Add TypeScript strict configuration and path aliases.
- Category: Foundation and Configuration (STEP 001-011).
- Previous handoff read: docs/handoffs/STEP_001_COMPLETED.md. It states that tsconfig.json
  was left in its smallest buildable form on purpose and that the strictness matrix, the
  path aliases and the typecheck contract belong to this STEP.

### Feature list sections that apply
- Section 1 Platform Foundations: "TypeScript strict mode", path comment on the first line
  of every file, no any types.
- Section 28 Performance and Low Load Rules: the compiler must not be the reason a heavy
  import reaches a client bundle, so aliases must resolve identically in the compiler, the
  linter and the bundler.
- Section 33 Release and Go-Live Gates: typecheck, lint and build must pass for the touched
  area.

### File ownership check (STEP_PLAN_250.md, File Ownership Rules)
- Owned here: root configuration, so tsconfig.json, the typecheck script contract and the
  root runtime declaration files (.nvmrc, package.json engines, README runtime section).
- Not owned here, therefore untouched:
  - Tailwind and design tokens: STEP 003.
  - Environment schema and .env.example: STEP 004.
  - Typed central application config: STEP 005.
  - lib/i18n/strings/en.ts: STEP 006.
  - Logging: STEP 007. Error format: STEP 008.
  - The lint rule matrix, including any type-aware lint rule: STEP 009. This STEP only
    keeps the ALIAS resolvable for the linter, it adds no rule.
  - Root layout shell, providers and theme tokens: STEP 010.
  - Job foundation: STEP 011.
  - Every migration: STEP 012 and later.

### What is missing today (measured, not assumed)
Parsing the committed tsconfig.json gives: strict true, and NOT SET for
noUncheckedIndexedAccess, exactOptionalPropertyTypes, noImplicitOverride,
noImplicitReturns, noFallthroughCasesInSwitch, noUnusedLocals, noUnusedParameters,
noPropertyAccessFromIndexSignature, verbatimModuleSyntax, moduleDetection,
allowUnreachableCode. There is no baseUrl and no paths entry, so `@/...` does not resolve
in the compiler, the linter or the bundler.

### Owner instruction that overrides the default runtime
The project must run on Node.js 26.13.0 LTS. The registry confirms 26.13.0 is the current
`latest` Node release, and the official `node-linux-x64@26.13.0` binary package is
available, so this STEP verifies against a real Node 26.13.0 runtime rather than declaring
a version it cannot run. package.json engines, .nvmrc and the README are aligned to it.

## 2. Why Five Sub-Steps

| Sub-step | Name | Proves |
| --- | --- | --- |
| 002.1 | Baseline inventory and flag matrix decision | Every flag is a decision with a stated reason, not a copy |
| 002.2 | Node.js 26.13.0 LTS runtime baseline | The declared runtime is the runtime that runs the gate |
| 002.3 | Full strict compiler matrix | No unsafe access, no implicit any path, no silent case fallthrough |
| 002.4 | Path aliases across compiler, linter and bundler | `@/...` resolves identically in tsc, ESLint and Next |
| 002.5 | Verification, proof set, handoff and commit | Typecheck, lint, build and negative tests are recorded |

## 3. Sub-Step Detail

### Sub-step 002.1 - Baseline inventory and flag matrix decision
Deliverables:
- The measured gap list above, taken from the parser rather than from reading the file.
- The flag matrix with the reason for each flag and the reason for each flag that stays
  off (checkJs, allowJs), because Next.js writes allowJs itself.
Proof: the inventory command output is reproduced in the handoff.
Exit criteria: every strict family flag is either enabled or documented as refused.

### Sub-step 002.2 - Node.js 26.13.0 LTS runtime baseline
Deliverables:
- .nvmrc pinned to 26.13.0.
- package.json engines: node >=26.13.0 and npm >=10.9.0, with .npmrc engine-strict
  already true, so a wrong runtime fails an install instead of failing in production.
- @types/node raised to the 26.x line so the compiler sees the Node 26 API surface.
- README runtime section updated.
Proof: a real Node 26.13.0 binary runs the install, the typecheck, the lint, the build and
the server smoke test.
Exit criteria: every command in the definition of done executed by Node 26.13.0.

### Sub-step 002.3 - Full strict compiler matrix
Deliverables in tsconfig.json:
- strict true plus noUncheckedIndexedAccess, exactOptionalPropertyTypes,
  noImplicitOverride, noImplicitReturns, noFallthroughCasesInSwitch, noUnusedLocals,
  noUnusedParameters, noPropertyAccessFromIndexSignature, allowUnreachableCode false,
  allowUnusedLabels false, useUnknownInCatchVariables, forceConsistentCasingInFileNames,
  verbatimModuleSyntax, moduleDetection force.
- target and lib raised to ES2024, which Node 26 and the current TypeScript support.
- The Next.js mandated values stay exactly as Next wrote them (jsx react-jsx, allowJs true,
  the .next include entries), so a build never rewrites the file.
Proof: typecheck passes with the whole matrix on, and the production build does not print
a tsconfig reconfiguration notice.
Exit criteria: zero suppressions, no `any` escape hatch, no per-file ts-ignore.

### Sub-step 002.4 - Path aliases across compiler, linter and bundler
Deliverables:
- baseUrl "." and paths { "@/*": ["./*"] }.
- Real alias usage in two places, not a decorative example: the root page reads the
  canonical structure manifest through `@/config/structure.json`, and the health route
  reads the service slug through `@/lib/constants/platform`.
- ESLint must resolve the alias without a new rule (the import plugin of
  eslint-config-next resolves tsconfig paths already; this is verified, not assumed).
Proof: tsc resolves the alias, ESLint reports no unresolved import, and the Next build
succeeds with the alias.
Exit criteria: an intentionally wrong alias fails the typecheck, proving the alias is
actually consumed and not silently ignored.

### Sub-step 002.5 - Verification, proof set, handoff and commit
Deliverables:
- check:structure, typecheck, lint and build green under Node 26.13.0.
- Production server smoke test of the page and the health route on the new runtime.
- docs/handoffs/STEP_002_COMPLETED.md filled completely.
- One commit: "STEP 002: Add TypeScript strict configuration and path aliases", pushed to
  the session branch with the handoff in the same commit.

## 4. Decisions Taken During Analysis
1. Node.js 26.13.0 LTS is the declared and the executed runtime. nodejs.org is not
   reachable from the execution environment, so the official `node-linux-x64@26.13.0`
   package from the npm registry provides the genuine 26.13.0 binary used for every
   verification command.
2. TypeScript stays at 5.9.3. The 7.x line is a new native compiler and would change the
   error surface of every later STEP; the handoff records the decision so a later STEP can
   revisit it deliberately.
3. target and lib move to ES2024, the highest lib this TypeScript ships and well below
   what Node 26 supports, so the compiler never accepts a primitive that the runtime does
   not have.
4. exactOptionalPropertyTypes and noUncheckedIndexedAccess are enabled now, on purpose:
   they are the two flags that are painful to add after the code exists, and every later
   STEP writes its first line against them.
5. Alias scope is a single prefix `@/*` mapped to the repository root. One prefix, one
   meaning, no `@/lib/lib` ambiguity, and it matches the Next.js default convention so a
   future tool cannot disagree.
6. No type-aware lint rule is added here even though the alias now resolves; the lint rule
   matrix is STEP 009.
