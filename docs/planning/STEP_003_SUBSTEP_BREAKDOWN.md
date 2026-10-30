// path: docs/planning/STEP_003_SUBSTEP_BREAKDOWN.md
# STEP 003 - Re-divided Into Five Sub-Steps

Owner instruction for this STEP: implement STEP 003, split it into five sub-steps first,
implement them one by one, keep the project production ready and keep Node.js 26.13.0 LTS
as the runtime that proves every gate.

## 1. Scope Confirmed From The Source Documents

### STEP 003 as written in docs/final/STEP_PLAN_250.md
- Number and title: STEP 003 - Add Tailwind configuration with central design tokens.
- Category: Foundation and Configuration (STEP 001-011).
- Previous handoff read: docs/handoffs/STEP_002_COMPLETED.md. It records that
  app/globals.css still holds a base CSS variable palette that STEP 003 replaces with the
  Tailwind design tokens, and that the strict matrix, the `@/` alias and Node 26.13.0 are
  already in force.

### Feature list sections that apply
- Section 1 Platform Foundations: English only in the interface, path comment on every
  file, no placeholder content.
- Section 25 and 28: public surfaces and dashboards must stay readable, fast and low on
  client JavaScript; a token system is what stops one-off colours from spreading.
- Section 33 Release and Go-Live Gates: typecheck, lint and build must pass for the touched
  area.
- MASTER_PROMPT stack line: "Tailwind CSS, shadcn/ui". shadcn/ui consumes a fixed set of
  semantic colour names, so the token names are chosen to match it instead of inventing a
  private vocabulary that every later UI STEP would have to translate.

### File ownership check (STEP_PLAN_250.md, File Ownership Rules)
- Owned here: the Tailwind and PostCSS configuration, the central design token layer, the
  base stylesheet, and the one existing screen that consumes the tokens.
- Not owned here, therefore untouched:
  - Root layout shell, providers, theme provider and any toggle: STEP 010. This STEP only
    makes the tokens switchable, it builds no switcher.
  - Environment schema: STEP 004. Typed central config: STEP 005.
  - String catalog: STEP 006. The copy on the page stays as it is until then.
  - Logging (007), error format (008), lint rule matrix (009), job foundation (011).
  - Components library and shadcn/ui primitives: not this STEP either; only the token
    names they will consume exist here.
  - Every migration: STEP 012 and later.

### What exists today (measured)
- app/globals.css holds 6 ad-hoc CSS custom properties per theme (`--kd-background`, `--kd-surface`,
  `--kd-foreground`, `--kd-muted`, `--kd-border`, `--kd-accent` in a light set and a
  prefers-color-scheme dark set) plus 9 hand written classes (`.page`, `.shell`, `.eyebrow`,
  `.display`, `.lede`, `.facts`, `.fact`, `.meta`, `.link`).
- No Tailwind, no PostCSS configuration, no utility layer, no radius scale, no shadow scale
  and no typography scale exist yet.
- Nothing in the repository produces a design token, so every later UI STEP would otherwise
  invent its own colours.

### Decision taken before coding
- Tailwind CSS 4.3.3, the current line, with the CSS-first `@theme` token model and
  `@tailwindcss/postcss`. Version 3.4.x is only the vendor LTS tag and would lock the
  project to a configuration-file token model the stack no longer needs.
- Tokens are defined once in styles/tokens.css and split into two layers: a primitive
  palette that never changes per theme, and semantic tokens that do. Tailwind utilities are
  generated from the semantic layer through `@theme inline`, so a component asks for
  `bg-surface` or `text-muted-foreground` and never for a raw palette step.
- Light and dark values are declared once with the CSS `light-dark()` function, guarded by
  `color-scheme`. A `.dark` or `.light` class on any ancestor forces a theme, which gives
  STEP 010 a switch hook without this STEP shipping a switch. This avoids duplicating the
  whole dark block inside a media query, which is where most token systems drift.
- Token names follow the shadcn/ui semantic vocabulary (background, foreground, card,
  muted, border, input, ring, primary, secondary, accent, destructive, success, warning),
  with `surface` kept as the KD name for the card surface.

## 2. Why Five Sub-Steps

| Sub-step | Name | Proves |
| --- | --- | --- |
| 003.1 | Token audit and naming contract | Every token name is a decision, mapped from the old CSS |
| 003.2 | Tailwind and PostCSS pipeline | Next builds CSS through Tailwind, version pinned |
| 003.3 | Central token layer | One file owns colour, radius, shadow and type scale |
| 003.4 | Token consumption in the base layer and the page | The old bespoke classes are gone, not duplicated |
| 003.5 | Verification, handoff and commit | Built CSS contains the tokens, gates pass on Node 26 |

## 3. Sub-Step Detail

### Sub-step 003.1 - Token audit and naming contract
Deliverables:
- The old 11 variables mapped to the new semantic set, with the reason for each rename.
- The primitive palette (brand steps, neutral steps) and the semantic set that maps onto
  the shadcn/ui names the stack requires.
Proof: the mapping table is reproduced in the handoff and no old class survives.
Exit criteria: every colour used by the current screen exists as a semantic token.

### Sub-step 003.2 - Tailwind and PostCSS pipeline
Deliverables:
- Dependencies requested and pinned exactly: tailwindcss 4.3.3 and @tailwindcss/postcss
  4.3.3.
- postcss.config.mjs registered and added to the structure manifest root files.
Proof: `next build` emits a CSS asset that contains Tailwind utilities.
Exit criteria: the pipeline is the only way styles are generated, no hand written CSS file
is loaded twice.

### Sub-step 003.3 - Central token layer
Deliverables:
- styles/tokens.css: `@theme` primitives, semantic variables with `light-dark()`, the
  `.light` and `.dark` overrides, `@theme inline` mapping, radius, shadow and font scales.
- styles/README.md documenting ownership and the rule that no component hardcodes a colour.
- app/globals.css reduced to Tailwind import, token import and a base layer (document
  defaults, focus ring, selection, reduced motion, font smoothing).
Proof: the built CSS contains `--color-background`, `--color-surface`, `--radius-card` and
a `light-dark(` pair.
Exit criteria: styles/tokens.css is the only file that contains a colour literal for the
interface.

### Sub-step 003.4 - Token consumption
Deliverables:
- app/page.tsx rewritten with utilities bound to tokens, responsive at mobile and desktop
  widths, with visible focus styles and readable contrast in both themes.
- Removal of the nine hand written classes from app/globals.css so no duplicate styling
  path remains.
Proof: the served HTML carries token utilities only, and the deleted classes appear nowhere.
Exit criteria: one styling path, tokens only.

### Sub-step 003.5 - Verification, handoff and commit
Deliverables:
- check:structure (with styles/ added to the manifest and to the scanned source roots),
  typecheck, lint and build green on Node.js 26.13.0.
- Production server smoke test of the page, the health route and the emitted stylesheet.
- docs/handoffs/STEP_003_COMPLETED.md filled completely.
- One commit: "STEP 003: Add Tailwind configuration with central design tokens", pushed to
  the session branch with the handoff in the same commit.

## 4. Risks Handled In The Design
1. Next.js and Turbopack must resolve a token file that lives outside app/. The import is
   verified in the emitted CSS, not assumed.
2. `light-dark()` needs `color-scheme`. It is declared on `:root` and overridden by the
   `.light` and `.dark` classes, and each token also carries a plain light fallback value so
   an older engine still renders a readable page.
3. A token system that ships unused names is dead weight. Every semantic token added here is
   either used by the current screen or is a required shadcn/ui name that STEP 068 onward
   consumes; the handoff lists which is which.
4. The page keeps its English literals until STEP 006. Rewriting the markup must not change
   the copy, so the two handoffs stay independent.
