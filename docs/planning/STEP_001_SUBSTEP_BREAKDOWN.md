// path: docs/planning/STEP_001_SUBSTEP_BREAKDOWN.md
# STEP 001 - Re-divided Into Five Sub-Steps

Owner request: implement STEP 001, but first re-divide STEP 001 itself into five ordered
sub-steps, implement the sub-steps of STEP 001 in this same chat, stop after the last
sub-step, and ask permission before STEP 002 starts.

## 1. Scope Confirmed From The Source Documents

### STEP 001 as written in docs/final/STEP_PLAN_250.md
- Number and title: STEP 001 - Create repository folder structure for app, lib, services,
  components, config, migrations and docs.
- Category: Foundation and Configuration (STEP 001-011).
- One chat, one STEP, one commit, one handoff file.

### Feature list sections that apply to this STEP
- Section 1 Platform Foundations: English only, path comment on the first line of every
  file, TypeScript strict mode, structured logging only, no placeholder text, deployable
  on Vercel and Netlify.
- Section 28 Performance and Low Load Rules: Server Components by default, a documented
  cache and pagination policy that the folder layout must not obstruct.
- Section 29 Production Environments and Secrets: every required environment variable is
  listed by name with no real value, the application refuses to start when one is missing
  (schema itself is STEP 004, the folder that holds it is created here).
- Section 33 Release and Go-Live Gates: a STEP is complete only when typecheck, lint and
  the production build pass for the touched area.
- MASTER_PROMPT rules 1-17, especially rule 4 (no test files, no TODO, no FIXME, no
  placeholder text) and rule 6 (path comment on every file).

### File ownership check (STEP_PLAN_250.md, File Ownership Rules)
- Owned by this STEP: root configuration, config/, and lib/ foundation files; creation of
  the app/, lib/, services/, components/, config/, migrations/ and docs/ structure;
  creation of docs/handoffs/.
- Explicitly not owned by this STEP and therefore not touched:
  - tsconfig strictness matrix, path aliases and the typecheck script contract: STEP 002.
  - Tailwind, design tokens and globals.css token layer: STEP 003.
  - Environment schema, .env.example and boot-time validation: STEP 004.
  - Central typed application config exports: STEP 005.
  - lib/i18n/strings/en.ts string catalog: STEP 006.
  - Structured logger: STEP 007.
  - Global error response format: STEP 008.
  - Lint rule matrix for strict typing and the English-only guard: STEP 009.
  - Root layout shell with providers and theme tokens: STEP 010.
  - Background job queue, worker and scheduler foundation: STEP 011.
  - Any migration file: STEP 012 and later. migrations/ here holds conventions only.

### Consequence recorded in the handoff
STEP 001 must leave a repository that builds, lints and typechecks, because the plan puts
STEP 002-011 after it. That requires a minimal but real toolchain baseline (package.json,
tsconfig.json, ESLint flat config, next.config.mjs). Each of those files is created here in
its smallest buildable form and is handed to its owning STEP for the full matrix, so no
later STEP finds its work already done. This overlap is written into the handoff file as
required by MASTER_PROMPT ("if anything in the STEP conflicts, record it").

## 2. Why Five Sub-Steps
STEP 001 is one commit, but it is not one action. Five sub-steps keep every action
independently verifiable:

| Sub-step | Name | Proves |
| --- | --- | --- |
| 001.1 | Toolchain baseline and repository hygiene | The repository can install, typecheck, lint and build at all |
| 001.2 | Canonical folder tree and ownership map | Every folder named in the STEP title exists and has a stated owner |
| 001.3 | Runnable App Router skeleton | app/ is a real Next.js App Router tree, not an empty folder |
| 001.4 | Structure and path-comment gate | The structure and rule 6 stay enforced by a command, not by memory |
| 001.5 | Full verification, handoff and commit | Typecheck, lint, build and gate all pass and are recorded |

## 3. Sub-Step Detail

### Sub-step 001.1 - Toolchain baseline and repository hygiene
Deliverables:
- package.json with pinned exact versions and the script contract: dev, build, start,
  typecheck, lint, check:structure, verify.
- .nvmrc, .npmrc (exact saves, engine strict), .editorconfig, .gitignore.
- tsconfig.json in its minimal buildable form, strict enabled because rule 5 requires it,
  with no path aliases (aliases stay with STEP 002).
- next.config.mjs minimal: React strict mode, powered by header off.
- eslint.config.mjs flat config using eslint-config-next core-web-vitals plus the two
  rules that come straight from MASTER_PROMPT rule 5 (no console.log, no explicit any).
  The full matrix belongs to STEP 009.
- Root README.md describing the project, the commands and the document set.
Proof: npm install succeeds, npm run --silent typecheck and npm run --silent lint run.
Exit criteria: dependency install is reproducible from package-lock.json.

### Sub-step 001.2 - Canonical folder tree and ownership map
Deliverables:
- The seven folders named in the STEP title: app/, lib/, services/, components/, config/,
  migrations/, docs/.
- The App Router groups that the ownership rules already reserve: app/(public),
  app/(auth), app/(dashboard), app/(admin), app/(client-portal), app/api.
- Foundation support folders: scripts/ and docs/handoffs/.
- config/structure.json: the canonical machine-readable tree, with the owning STEP range
  and the purpose of every folder.
- One README.md inside every folder that would otherwise be empty, because Git does not
  track empty directories and a .gitkeep would be the placeholder that rule 4 forbids.
Proof: every folder exists on disk and is committed.
Exit criteria: no folder in the tree is undocumented and no folder is empty.

### Sub-step 001.3 - Runnable App Router skeleton
Deliverables:
- app/layout.tsx: the smallest real root layout (lang, metadata, body). STEP 010 owns the
  shell, providers and theme tokens and extends this file.
- app/page.tsx: a real Server Component page for the platform foundation, no placeholder
  wording, no mock data.
- app/globals.css: reset and base typography on plain CSS variables. STEP 003 replaces the
  variables with Tailwind design tokens.
- app/api/health/route.ts: a real health handler returning status, service name, uptime
  seconds and a timestamp. It serves the uptime monitoring requirement of feature list
  section 32 and gives the structure gate something end to end to build.
Proof: next build produces a static page and a dynamic health route.
Exit criteria: no server-side secret reading, no environment access before STEP 004.

### Sub-step 001.4 - Structure and path-comment gate
Deliverables:
- scripts/verify-structure.mjs: a dependency-free Node script that fails when
  (a) a directory or root file listed in config/structure.json is missing,
  (b) a source file does not start with the path comment required by rule 6,
  (c) a forbidden marker (TODO, FIXME, XXX, lorem ipsum) or console.log appears.
- Wired as npm run check:structure and as the first step of npm run verify.
Proof: the gate fails on a deliberately broken tree and passes on the real tree.
Exit criteria: the gate is deterministic, offline and has no third-party dependency.

### Sub-step 001.5 - Full verification, handoff and commit
Deliverables:
- check:structure, typecheck, lint and build all green on a clean install.
- docs/handoffs/STEP_001_COMPLETED.md filled from docs/final/HANDOFF_TEMPLATE.md with no
  field left blank.
- One commit on the working branch: "STEP 001: Create repository folder structure for app,
  lib, services, components, config, migrations and docs", pushed to the branch, with the
  handoff file inside that same commit.
Exit criteria: MASTER_PROMPT definition of done satisfied and proven in the handoff.

## 4. Decisions Taken During Analysis
1. Framework baseline is Next.js 16 App Router with React 19, pinned exactly. The feature
   list asks for "Next.js 14+" and App Router; the pinned pair is the supported current
   release and is recorded in the handoff for the integrator.
2. TypeScript is pinned to 5.9.3 rather than the newly published 7.x native compiler so
   that the build pipeline of every later STEP stays predictable. STEP 002 owns any change.
3. next-env.d.ts and .tsbuildinfo are generated artifacts and are git ignored, so the tree
   never carries machine written files.
4. CSS files cannot carry a // comment. app/globals.css starts with /* path: ... */ and
   that single documented deviation from the literal rule is written into the handoff.
5. package.json is created by this STEP because no typecheck, lint or build can exist
   without it, and the exact dependency list is written into the handoff as the package
   request section for the integrator to confirm.
6. No Tailwind, no shadcn/ui, no Supabase client, no Sentry, no test framework, no CI
   workflow: each belongs to a later STEP and adding it now would edit files owned there.
