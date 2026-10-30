// path: docs/handoffs/STEP_003_COMPLETED.md
# STEP 003 Completed - Handoff

## STEP
- Number and title: STEP 003 - Add Tailwind configuration with central design tokens
- Category: Foundation and Configuration (STEP 001-011)
- Depends on (earlier STEPs in this category and their handoff files): STEP 001 (folder
  structure and the structure gate) and STEP 002 (strict TypeScript, `@/` alias,
  Node.js 26.13.0 LTS baseline). STEP 002's handoff recorded that app/globals.css still held
  a base CSS variable palette and that STEP 003 replaces it with the token layer.
- Re-divided into five sub-steps before implementation. Analysis and definitions:
  docs/planning/STEP_003_SUBSTEP_BREAKDOWN.md. All five completed in this session:
  003.1 token audit and naming contract, 003.2 Tailwind and PostCSS pipeline, 003.3 central
  token layer, 003.4 token consumption, 003.5 verification, handoff and commit.

## Files
- Created:
  - styles/tokens.css - the central design token layer (primitives, semantics, Tailwind
    exposure).
  - styles/README.md - ownership and the rule that no component carries a colour literal.
  - postcss.config.mjs - `@tailwindcss/postcss` pipeline.
  - docs/planning/STEP_003_SUBSTEP_BREAKDOWN.md - the five sub-step analysis.
  - docs/handoffs/STEP_003_COMPLETED.md - this file.
- Modified:
  - app/globals.css - reduced to the Tailwind import, the token import and a base layer
    (document defaults, selection, focus ring, reduced motion, text wrapping). The nine hand
    written classes were deleted.
  - app/page.tsx - rewritten with token bound Tailwind utilities. The visible copy is
    unchanged, because moving strings is STEP 006.
  - config/structure.json - `styles` directory added with its owner, `postcss.config.mjs`
    added to the root files, `styles` added to the scanned source roots.
  - package.json, package-lock.json - tailwindcss 4.3.3 and @tailwindcss/postcss 4.3.3
    added as exact pinned dev dependencies.
  - README.md - new "Design system" section and `styles/` added to the structure table.
- Owned paths touched (must match the File Ownership Rules in STEP_PLAN_250.md): root
  configuration (postcss.config.mjs, package.json), the styles/ token layer, app/globals.css
  and the one existing screen that consumes the tokens. Not touched: root layout shell,
  providers, theme switcher (STEP 010), environment schema (004), typed config (005), string
  catalog (006), logging (007), error format (008), lint rule matrix (009), job foundation
  (011), every migration (012+), any shadcn/ui component.

## Database
- Migrations added (file names): none. The first migration belongs to STEP 012.
- Rollback verified on clean database (yes/no, how): not applicable, no migration in this
  STEP.

## Environment
- Environment variables added to .env.example: none. The environment schema and
  .env.example are STEP 004. The token layer and the Tailwind pipeline read no environment.
- Secrets handled (names only, never values): none.

## Packages
- Package requests for the integrator (name, reason), or none:
  - tailwindcss 4.3.3 - the utility engine required by MASTER_PROMPT ("Tailwind CSS,
    shadcn/ui"). Version 4.3.3 is the current line; `v3-lts` (3.4.19) is only the vendor
    long term tag and would force a config-file token model the stack no longer needs.
  - @tailwindcss/postcss 4.3.3 - the PostCSS entry point of that same version, so the
    plugin can never drift from the engine.
  - Both are exact pinned dev dependencies, saved by .npmrc. No runtime dependency was
    added, and no component library was added: shadcn/ui primitives belong to the UI STEPs,
    this STEP only publishes the token vocabulary they consume.

## Behaviour Proof (acceptance checklist)
- Behaviours named in the STEP title, exercised manually, with observed results:
  - Tailwind is genuinely in the pipeline, not installed and idle: `next build` on
    Node.js 26.13.0 emits a single stylesheet,
    `/_next/static/chunks/2occpukdlvot7.css`, 14,145 bytes raw and 3,578 bytes gzipped, and
    the served page links it and gets 200. The served HTML carries utility classes only, for
    example `class="flex min-h-dvh items-center justify-center bg-background px-4 py-6
    text-foreground sm:px-6"` and `class="w-full max-w-3xl rounded-card border border-border
    bg-surface p-6 shadow-card sm:p-8"`.
  - Central tokens exist and reach the output: the built CSS contains `--kd-background`,
    `--kd-surface`, `--kd-ring`, the `--palette-*` primitives, the generated utilities
    `.bg-surface`, `.text-muted-foreground`, `.border-border`, `.rounded-card`,
    `.shadow-card`, and the `sm:` variants `.sm:px-`, `.sm:p-`, `.sm:text-lg`.
  - One file owns the palette. A literal audit of the token file counts 36 colour literals,
    all of them inside the primitive block, and 0 outside it: every semantic token resolves
    to a named primitive. The audit of app/ and components/ finds no hex, rgb() or hsl()
    literal at all, and no component uses a raw palette step such as `bg-blue-600` (0 hits).
  - No duplicate styling path: the nine classes STEP 001 shipped (`.page`, `.shell`,
    `.eyebrow`, `.display`, `.lede`, `.facts`, `.fact`, `.meta`, `.link`) appear 0 times in
    the built CSS, and app/globals.css no longer defines them.
  - Theming is switchable, not fixed. The built CSS contains
    `@media (prefers-color-scheme:dark)` followed, in this order, by `.light{...}` and
    `.dark{...}` (measured at byte offsets 12,651, 12,736 and 12,813), so the operating
    system preference applies by default and a class on the root element forces a theme.
    `light-dark()` is downlevelled at build time by Lightning CSS into the
    `--lightningcss-light` / `--lightningcss-dark` toggle plus that media query, which also
    gives older engines a working result. No dark value block is duplicated in the source.
  - Base layer behaviour is present in the output: `::selection`,
    `:focus-visible{outline:2px solid var(--kd-ring)`, `prefers-reduced-motion`,
    `text-wrap:balance` for headings and `text-wrap:pretty` for paragraphs (1 occurrence
    each).
- UI checks (desktop, mobile, keyboard, light and dark) where applicable: checked on the
  served HTML and CSS, not in a browser, because the execution environment has no browser
  installed. Observed: the page is a single centred column that is full width on a phone and
  capped at `max-w-3xl` on desktop, with padding and type stepping up at the `sm` breakpoint
  (`px-4` to `sm:px-6`, `p-6` to `sm:p-8`, `text-3xl` to `sm:text-4xl`); keyboard focus is
  drawn from a single global `:focus-visible` rule using the `ring` token, so the "Service
  health" link inherits a visible 2px outline with a 2px offset; light and dark values come
  from the same tokens and both themes are declared. Not observed: pixels rendered in a real
  browser at 360px, 768px and 1440px in both themes. That visual confirmation is still
  pending and is now formally owned by STEP 010, which builds the root layout shell, the
  providers and the theme switcher on top of these tokens.
- API checks (success, validation failure, unauthorized, cross-tenant) where applicable:
  GET /api/health is unchanged by this STEP and still returns 200 with
  `{"status":"ok","service":"kd-solution-it","uptimeSeconds":0,"checkedAt":"2026-10-30T16:35:36.406Z"}`
  on Node.js 26.13.0; an unknown path still returns 404. No request input, credential or
  tenant scope exists in this STEP, so the other three cases begin at STEP 011.
- Money flow ledger proof (balanced debit and credit) where applicable: not applicable, this
  STEP moves no money. The ledger is STEP 127-146.
- Provider sandbox cycle and documentation URLs where applicable: not applicable, no
  provider is called. The documentation rule first binds at STEP 147.

## Verification
- Typecheck result: pass. `npm run typecheck` exits 0 with the STEP 002 strict matrix.
- Lint result: pass. `npm run lint` exits 0.
- Build result for the touched area: pass. `npm run build` on Node.js 26.13.0 compiles,
  finishes TypeScript, generates the stylesheet above and emits the route table `○ /`,
  `○ /_not-found`, `ƒ /api/health`. `npm run verify` (structure gate, typecheck, lint,
  build) exits 0.
- Structure gate: pass, `structure gate passed: 16 directories, 11 root files, 19 source
  files checked` after styles/ and postcss.config.mjs were registered in
  config/structure.json.
- Runtime: Node.js 26.13.0 and npm 10.9.8, engine-strict. tsconfig.json md5 is unchanged
  after the build (71c59a4200330dbd165ff81a17c67cc8), so Next still leaves the compiler
  configuration alone.

## Token map (old file to new system)
| Old variable (STEP 001) | New semantic token | Utility |
| --- | --- | --- |
| --kd-background | --kd-background | bg-background |
| --kd-foreground | --kd-foreground | text-foreground |
| --kd-surface | --kd-surface | bg-surface, text-surface-foreground |
| --kd-muted (was text) | split into --kd-muted (surface) and --kd-muted-foreground (text) | bg-muted, text-muted-foreground |
| --kd-border | --kd-border and --kd-input | border-border, border-input |
| --kd-accent (was link) | split into --kd-primary (action), --kd-ring (focus), --kd-secondary (highlight), --kd-accent (hover surface) | text-primary, outline-ring, bg-secondary, bg-accent |

- Tokens consumed today: background, foreground, surface, muted-foreground, border, primary,
  ring, secondary (selection background).
- Tokens published for the vocabulary the stack requires and consumed from STEP 068 onward:
  surface-foreground, muted, input, primary-foreground, secondary-foreground, accent,
  accent-foreground, destructive and its foreground, success and its foreground, warning and
  its foreground.
- Scales: radius xs/sm/md/lg/xl/card/pill, elevation card/raised, font sans/mono, easing
  standard.

## Next
- Next STEP number: STEP 004 - Add environment variable schema with boot-time validation.
  Not started. This chat ends here as the owner asked, and STEP 004 needs the owner's
  permission.
- Anything the next chat must know:
  1. Colour never appears outside styles/tokens.css. A new visual need means a new semantic
     token first, then a utility. A palette step (`bg-ink-700`) and a hex literal are both
     rejected by review.
  2. Theming runs on `color-scheme`. `:root` declares `light dark`, so the operating system
     preference applies with no JavaScript; adding `.light` or `.dark` to the root element
     forces a theme. STEP 010 owns the switcher, the provider and the persisted choice; it
     must set the class on `<html>` so the whole tree switches.
  3. The token file is imported by app/globals.css through `@import "../styles/tokens.css"`.
     Turbopack resolves it today and the token variables are in the emitted CSS; keep the
     import above the base layer if the file is reorganised.
  4. `light-dark()` is authored in the source and downlevelled by Lightning CSS at build
     time. Do not "simplify" it into duplicated light and dark blocks: the downlevelled
     output is verified working, and the duplicated form is exactly where themes drift.
  5. styles/ is now a scanned source root in config/structure.json, so a file added there
     must start with its `/* path: ... */` comment or the structure gate fails before
     typecheck runs.
  6. shadcn/ui is not installed yet. When the UI STEPs add primitives, point the generator at
     these token names instead of letting it write its own `:root` block; a second token
     layer would defeat this STEP.
  7. The copy on app/page.tsx is still literal English and belongs to STEP 006. Only styling
     changed here.
  8. Node.js 26.13.0 LTS with engine-strict install stays in force for every later STEP.
  9. app/layout.tsx is still the minimal shell from STEP 001. The body class list, the theme
     class and the providers arrive with STEP 010.
