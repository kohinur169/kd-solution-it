// path: docs/planning/STEP_009_SUBSTEP_BREAKDOWN.md
# STEP 009 - Re-divided Into Five Sub-Steps

Owner instruction for this STEP: implement STEP 009, split it into five sub-steps first,
implement them one by one, keep the project production ready and keep Node.js 26.13.0 LTS as
the runtime that proves every gate.

## 1. Scope Confirmed From The Source Documents

### STEP 009 as written in docs/final/STEP_PLAN_250.md
- Number and title: STEP 009 - Add lint rules for strict typing and English-only source guard.
- Category: Foundation and Configuration (STEP 001-011).
- Previous handoff read: docs/handoffs/STEP_008_COMPLETED.md. It records that the error copy is
  catalog based, so an English literal outside the catalog is already a defect, and that STEP
  009 owns the lint matrix.
- Earlier handoffs read for context: STEP 002 (strict TypeScript, `@/` alias), STEP 004 (the
  environment is read only through `lib/env/`), STEP 006 (all user facing strings in the
  catalog) and STEP 007 (structured logging only).

### Feature list and master prompt requirements
- MASTER_PROMPT rule 1: English only in code, UI, comments, seeds, templates, file names and
  content strings. This is a source rule, which is exactly what a lint rule can enforce.
- MASTER_PROMPT rule 5: "TypeScript strict mode everywhere. No any types. No console.log; use
  structured logging."
- MASTER_PROMPT rule 94: no secret, key, token or credential in code, commits, logs or error
  messages. A ban on `eval`-family constructs and a reviewable rule matrix support it.
- FEATURE_LIST section 1: "TypeScript strict mode. Structured logging only."
- FEATURE_LIST section 29: application code reads configuration, not the raw environment.
- FEATURE_LIST section 33: typecheck, lint and build must pass for the touched area.

### What exists today (measured before coding)
- `eslint.config.mjs` has: `next/core-web-vitals`, then a shared layer with `no-console`,
  `no-eval`, `no-implied-eval`, `no-new-func`, `eqeqeq`, and a TypeScript layer with
  `@typescript-eslint/no-explicit-any` and `no-unused-vars`.
- No parser is configured for TypeScript, no `parserOptions.projectService`, so no rule that
  needs type information can run: a floating promise or a promise passed where a boolean is
  expected is invisible to lint today.
- Nothing enforces English-only source. A Bengali comment or a copy paste from a translated
  document passes lint and reaches the repository.
- Nothing enforces the documented rule "application code never reads `process.env` directly":
  today the only protection is review. Four files do read it legitimately (`lib/env/boot.ts`,
  `lib/env/server.ts`, `lib/env/client.ts`, `instrumentation.ts`).
- `eslint-config-next` 16.4.3 ships a `typescript` flat config (`dist/typescript.js`): the
  `@typescript-eslint` parser, the plugin and 23 recommended rules. It is already a declared
  dependency, so the parser and the plugin need no new package.
- `eslint` 9.39.5 exposes the `Linter` API, so rules can be exercised in memory without writing
  a probe file into the repository.

## 2. Design Decisions Taken Before Coding

1. **Type information is switched on.** `parserOptions.projectService` with
   `tsconfigRootDir` set to the repository lets the typed rules run against the real
   `tsconfig.json`. Without it, the rules that matter most for a payment platform — a floating
   promise, a promise in a condition, an `await` on a non thenable — cannot exist.
2. **Only the declared dependency is imported.** The parser and the plugin come from
   `eslint-config-next/typescript`, which is already in `package.json`. The config imports
   `eslint`, `eslint-config-next` and two local rule modules, so no transitive package becomes a
   hidden direct dependency and no package request is needed.
3. **Rules are grouped by intent, not by plugin.** One layer for JavaScript safety, one for
   TypeScript strictness, one for platform boundaries, one for the English guard. A reader can
   see why a rule exists from the group it is in.
4. **Every rule is an error, never a warning.** A warning in CI is a rule that is already
   ignored. The gate below refuses a matrix entry set to `warn` or `off`.
5. **The English guard is a local rule, not an external plugin.** It reads the file text once,
   allows the same typographic characters the i18n gate allows (en dash, em dash, curly quotes,
   ellipsis, bullet, middle dot) and reports every other code point above U+007E with its
   position. It covers code, comments and string literals alike, because MASTER_PROMPT rule 1
   covers all of them.
6. **The environment boundary is a local rule, not a convention.** `local/no-process-env`
   reports `process.env` anywhere except the five paths that own the environment contract. The
   rule is a rule with an explicit exemption list, so a new raw read is a lint failure instead
   of a review comment.
7. **The `any` ban stays, and its neighbours are added.** `no-explicit-any` alone does not
   describe strict typing; `no-non-null-assertion`, `consistent-type-imports`,
   `consistent-type-assertions`, `ban-ts-comment`, `no-empty-object-type`,
   `no-wrapper-object-types`, `no-namespace`, `no-unsafe-function-type` and
   `no-import-type-side-effects` close the escapes that remain inside a typed file.
8. **Promise handling is strict.** `no-floating-promises`, `no-misused-promises` and
   `await-thenable` are on. In a platform where a payment, a webhook and an email all cross an
   asynchronous boundary, a forgotten `await` is a correctness bug, not a style preference.
9. **A gate proves the matrix, not just the run.** `npm run check:lint` reads the exported
   config, refuses a missing or downgraded rule, and then lints probe snippets in memory to show
   that the local rules and the strict typing rules actually fire. Linting clean files proves
   nothing about a rule that was silently removed.
10. **No probe files on disk.** The gate uses the `Linter` API, so it adds no test file to the
    repository and leaves no artefact behind, and the structure gate never sees it.
11. **The gates stay cheap.** The typed rules run against a 46 file project; the whole `verify`
    chain stays under a minute on Node.js 26.13.0. If type-aware linting ever became the
    bottleneck, the typed layer would be the thing to tune, not the rules.
12. **No package.json change beyond one script.** The lint matrix lives in `eslint.config.mjs`;
    the only script added is `check:lint`. `package.json` is integrator-owned, so a script line
    is the smallest possible footprint.

## 3. Why Five Sub-Steps

| Sub-step | Concern | Wrong without it |
| --- | --- | --- |
| 009.1 | Contract and inventory | A matrix of rules nobody can justify, or rules that break the build |
| 009.2 | Type-aware linting and strict typing rules | A `any`, a `!` and a skipped `await` pass review |
| 009.3 | English-only source guard | A translated comment or string reaches the repository |
| 009.4 | Boundary guard for the environment | A new module reads `process.env` directly and bypasses validation |
| 009.5 | Gate, documentation and proof | A rule deleted in a later chat, and nothing to notice it |

## 4. The Five Sub-Steps

### 009.1 - Contract, inventory and ownership notes
- Read MASTER_PROMPT rules 1, 5 and 94, FEATURE_LIST sections 1, 29 and 33, the STEP 008
  handoff and the current `eslint.config.mjs` (done above).
- Inventory: no parser, no type information, no English guard, no environment guard.
- Fix the matrix: which rules, in which layer, at which severity, with which exemptions.
- Deliverable: this document.

### 009.2 - Type-aware linting and strict typing rules
- `eslint.config.mjs`: include `eslint-config-next/typescript`, set `projectService` and
  `tsconfigRootDir`, add the strict typing and promise rules.
- Keep `npm run lint` green on the existing 46 files; a rule that the current code cannot
  satisfy gets fixed at the call site only when the call site is in this STEP's own scope,
  otherwise the rule is dropped and the reason recorded.
- Proof: a deliberate `any`, a `!` assertion, a floating promise and a missing `await` each fail
  `npm run lint`; then reverted.

### 009.3 - English-only source guard
- `scripts/eslint-rules/english-only-source.mjs`: the rule, its allowed character set and its
  message.
- Wire it as `local/english-only-source` for every code file.
- Proof: a Bengali comment, a Bengali string and a curly quote pass or fail exactly as intended.

### 009.4 - Environment boundary guard
- `scripts/eslint-rules/no-process-env.mjs`: report `process.env` and `process["env"]`.
- Wire it as `local/no-process-env` with the exemption list (`lib/env/**`, `instrumentation.ts`,
  the Node scripts and the tool configuration files).
- Proof: a new raw read outside the exemption list fails lint; the exempt files stay green.

### 009.5 - Lint gate, documentation and handoff
- `scripts/verify-lint-rules.mjs`: `npm run check:lint`, added to `npm run verify`. It refuses a
  missing rule, a downgraded severity, a local rule that does not fire, and a clean snippet that
  does.
- Documentation: a README section describing the layers, and a README beside the local rules.
- Finish with `npm run verify` on Node.js 26.13.0, one commit, push and the completed handoff.

## 5. Files This STEP Owns

| File | Status |
| --- | --- |
| eslint.config.mjs | rewritten in 009.2 and 009.4 |
| scripts/eslint-rules/english-only-source.mjs | created in 009.3 |
| scripts/eslint-rules/no-process-env.mjs | created in 009.4 |
| scripts/eslint-rules/README.md | created in 009.5 |
| scripts/verify-lint-rules.mjs | created in 009.5 |
| package.json (the `check:lint` script and the verify chain) | modified in 009.5 |
| README.md (lint section) | modified in 009.5 |
| docs/planning/STEP_009_SUBSTEP_BREAKDOWN.md | this document |
| docs/handoffs/STEP_009_COMPLETED.md | created in 009.5 |

Not owned here, therefore untouched: the environment contract (STEP 004), configuration values
(STEP 005), the string catalog (STEP 006), the logger (STEP 007), the error format (STEP 008),
the root layout shell and providers (STEP 010), the job foundation (STEP 011), every migration
(STEP 012 and later) and every application source file, which stays as it is unless a new rule
finds a defect inside this STEP's own files.
