// path: docs/handoffs/STEP_009_COMPLETED.md
# STEP 009 Completed - Handoff

## STEP
- Number and title: STEP 009 - Add lint rules for strict typing and English-only source guard
- Category: Foundation and Configuration (STEP 001-011)
- Depends on (earlier STEPs in this category and their handoff files): STEP 002 (strict
  TypeScript and the `@/` alias, which the parser now type checks against), STEP 004 (the
  environment contract, whose single owner `lib/env/` becomes the exemption list of the new
  environment rule), STEP 006 (the string catalog, whose messages the English guard deliberately
  leaves to the i18n gate), STEP 007 (structured logging, the reason a `console` call is an
  error) and STEP 008 (error copy is catalog based, so an English literal in code is a defect).
- Re-divided into five sub-steps before implementation; the analysis, the inventory and the
  twelve design decisions are in docs/planning/STEP_009_SUBSTEP_BREAKDOWN.md. All five completed
  in this session: 009.1 contract and inventory, 009.2 type-aware linting and strict typing
  rules, 009.3 English-only guard, 009.4 environment boundary guard, 009.5 gate, documentation,
  proof and handoff.

## Files
- Created:
  - scripts/eslint-rules/english-only-source.mjs - the `local/english-only-source` rule, its
    allowed typographic set and its message.
  - scripts/eslint-rules/no-process-env.mjs - the `local/no-process-env` rule for `process.env`
    and `process["env"]`.
  - scripts/eslint-rules/README.md - why the rules are local, what each allows, how to add one.
  - scripts/verify-lint-rules.mjs - the gate behind `npm run check:lint`.
  - docs/planning/STEP_009_SUBSTEP_BREAKDOWN.md, docs/handoffs/STEP_009_COMPLETED.md.
- Modified:
  - eslint.config.mjs - rewritten into five commented layers: framework, platform safety,
    type-aware strict typing and promises, platform boundaries, and the environment exemption
    list.
  - package.json - `check:lint` added; `verify` now runs the lint gate after the error gate.
  - README.md - a "Lint and typing rules" section and the commands table.
- Owned paths touched (must match the File Ownership Rules in STEP_PLAN_250.md): the lint
  configuration, `scripts/` rule modules and gate, the package script line and the root README.
  No application source file was changed: the new rules were satisfied by the existing code on
  the first run, which is itself evidence that the earlier STEPs held the line.
- Not touched: the environment contract (STEP 004), configuration values (STEP 005), the string
  catalog (STEP 006), the logger (STEP 007), the error format (STEP 008), the root layout shell
  and providers (STEP 010), the job foundation (STEP 011), every migration (STEP 012 and later).

## Database
- Migrations added (file names): none.
- Rollback verified on clean database (yes/no, how): not applicable, no migration.

## Environment
- Environment variables added to .env.example: none. The environment gate still reports the same
  16 variables. The new rule narrows how they are read; it does not change what they are.
- Secrets handled (names only, never values): none read. The environment rule keeps
  `DATABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ENCRYPTION_MASTER_KEY`, `AUDIT_SIGNING_KEY` and
  the rest behind `lib/env/`, which is the layer that validates them at boot.

## Packages
- Package requests for the integrator (name, reason), or none: none. The parser and the
  `@typescript-eslint` plugin come from `eslint-config-next/typescript`, which is already a
  declared dependency, and the gate uses the `eslint` package that is already declared. No
  transitive package is imported directly, so the dependency tree is unchanged and
  package-lock.json is untouched.

## Behaviour Proof (acceptance checklist)
- Behaviours named in the STEP title, exercised manually on Node.js 26.13.0.

  **1. Strict typing with type information.** `parserOptions.projectService` reads the real
  `tsconfig.json`, so the promise rules see the same types the compiler sees. Proven with a
  throwaway file linted in place and then deleted:
  - `export function run(): void { Promise.resolve(1); }` failed with
    `Promises must be awaited, end with a call to .catch, end with a call to .then with a
    rejection handler or be explicitly marked as ignored with the \`void\` operator
    @typescript-eslint/no-floating-promises`;
  - `export const value: any = 1;` failed with `Unexpected any. Specify a different type
    @typescript-eslint/no-explicit-any`;
  - `export const forced = maybe!;` failed with `Forbidden non-null assertion
    @typescript-eslint/no-non-null-assertion`;
  - `// @ts-ignore` failed with `Use "@ts-expect-error" instead of "@ts-ignore" ...
    @typescript-eslint/ban-ts-comment`.

  **2. The English-only guard.** The same file, containing a Bengali comment and a Bengali
  string, produced one error per code point with its position, for example
  `2:4 error Source must be English only: found U+09AC at this position
  local/english-only-source`. A file containing an en dash, curly quotes and an ellipsis in an
  English sentence, plus ordinary typed code, produced no message at all, which proves the
  allowed typographic set is exactly the one the i18n gate already uses.

  **3. The environment boundary.** `export const url = process.env.DATABASE_URL;` in a file
  outside the exemption list failed with `Do not read process.env here. Import the validated
  accessor from lib/env/ instead local/no-process-env`. The exempt files stay green: the gate
  asks ESLint for the resolved configuration of `lib/env/server.ts` and of
  `scripts/verify-structure.mjs` and finds the rule off, while `lib/logger/logger.ts` and
  `app/api/health/route.ts` resolve to error.

  **4. The matrix itself is gated.** `npm run check:lint` reports
  `lint gate passed: 77 checks, 26 rules enforced as errors, 11 failure probes fired, 1 clean
  probe stayed clean`. It reads the exported configuration, refuses a missing rule, refuses a
  rule that is not an error in any layer, refuses a missing local plugin entry, refuses a missing
  project service or a wrong `tsconfigRootDir`, and then lints eleven failure snippets in memory
  (any, non-null assertion, `@ts-ignore`, console, dynamic code, `var`, loose equality, Bengali
  comment, Bengali string, `process.env`, `process["env"]`) plus one clean snippet that must stay
  clean. No file is written, so the gate leaves no artefact in the repository.

  **5. The gate fails closed.** Five deliberate regressions, each applied, run and reverted:
  - a required rule removed (`no-floating-promises`) -> exit 1 with
    `the matrix is missing @typescript-eslint/no-floating-promises`;
  - a rule downgraded (`no-console` to warn) -> exit 1 with
    `no-console must be an error in at least one layer, found warn`;
  - the English rule made unreachable -> exit 1 with
    `the local/english-only-source rule did not fire on the non English comment probe` and the
    same for the string probe;
  - the `scripts/**` exemption removed -> exit 1 with
    `a Node.js script must be exempt from the environment rule`;
  - `projectService` removed -> exit 1 with
    `type aware linting must be configured with the project service`.
  Restoring each mutation returns the green line in item 4.

  **6. The existing source satisfies the new matrix.** `npm run lint` exits 0 on all 50 source
  files in about five seconds, with type information on. No file owned by an earlier STEP needed
  a change, so the rules describe the codebase rather than forcing it into a new style.

- UI checks (desktop, mobile, keyboard, light and dark) where applicable: not applicable. This
  STEP changes no component, no class and no token.
- API checks (success, validation failure, unauthorized, cross-tenant) where applicable: not
  applicable, no route changed. The health route still answers exactly as recorded in STEP 008.
- Money flow ledger proof (balanced debit and credit) where applicable: not applicable, this
  STEP moves no money.
- Provider sandbox cycle and documentation URLs where applicable: not applicable, no provider is
  called.

## Verification
- Typecheck result: pass, `npm run typecheck` exits 0, unchanged by this STEP.
- Lint result: pass, `npm run lint` exits 0 with the new matrix, type-aware, on all 50 source
  files.
- Build result for the touched area: pass. `npm run build` on Node.js 26.13.0 emits the same
  route table (`○ /`, `○ /_not-found`, `ƒ /api/health`); no application code changed.
- `npm run verify` now runs eight gates plus typecheck, lint and build, and exits 0 in about 18
  seconds:
  `structure gate passed: 16 directories, 13 root files, 50 source files checked`,
  `check:env passed: .env.example matches 16 manifest variables`,
  `config gate passed: 9 sections, 22 values (5 money entries, all strings), no credential shaped
  key`,
  `i18n gate passed: 25 messages, 2 placeholders, 1 locale (en, ltr)`,
  `logger gate passed: 117 checks, 15 records parsed, 4 levels, 9 secret fragments absent`,
  `error gate passed: 196 checks, 14 codes, all statuses in 4xx or 5xx, no secret or stack in any
  envelope`,
  `lint gate passed: 77 checks, 26 rules enforced as errors, 11 failure probes fired, 1 clean
  probe stayed clean`, then build.
- Runtime: Node.js 26.13.0, npm 10.9.8, engine-strict. No dependency change.

## Next
- Next STEP number: STEP 010 - root layout shell, providers and the visual error screens (its
  exact title is in docs/final/STEP_PLAN_250.md). Not started. This chat ends here as the owner
  asked, and STEP 010 needs the owner's consent.
- Anything the next chat must know:
  1. Every rule is an error by design. Do not introduce a warning to get past a finding; fix the
     code, or change the matrix and record why in the handoff.
  2. Type-aware linting means a new `.ts` file must be inside the `tsconfig.json` include set.
     A TypeScript config file placed outside the project surfaces as a parser error rather than
     as a rule failure.
  3. The English guard covers `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts` and `.tsx` only. Markdown, CSS
     and JSON are covered by the structure gate and the i18n gate instead. A new file type that
     can hold copy needs its own guard, not an assumption.
  4. Copy still belongs in `lib/i18n/strings/en.ts`. The guard stops a non English character, not
     an English sentence written in a component; that remains a review rule and a STEP 006 rule.
  5. `local/no-process-env` exemptions are the five entry list in `eslint.config.mjs`. A new
     module that genuinely needs the raw environment belongs in `lib/env/`, not in the list.
  6. When a rule is added, add it to `requiredRules` and to the probes in
     `scripts/verify-lint-rules.mjs`, otherwise the gate cannot notice its removal later.
  7. `void somePromise` is a deliberate, visible acknowledgement for the promise rule. Prefer a
     real `await` or a `.catch`; use `void` only where a caller genuinely cannot wait.
  8. Still open for their owners: the root layout shell and providers (010), the job foundation
     (011), every migration (012+), and the auth and tenant endpoints whose 401 and 403 paths
     STEP 008 prepared.
