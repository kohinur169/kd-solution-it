// path: docs/planning/STEP_006_SUBSTEP_BREAKDOWN.md
# STEP 006 - Re-divided Into Five Sub-Steps

Owner instruction for this STEP: implement STEP 006, split it into five sub-steps first,
implement them one by one, keep the project production ready and keep Node.js 26.13.0 LTS
as the runtime that proves every gate.

## 1. Scope Confirmed From The Source Documents

### STEP 006 as written in docs/final/STEP_PLAN_250.md
- Number and title: STEP 006 - Add English string catalog structure lib/i18n/strings/en.ts.
- Category: Foundation and Configuration (STEP 001-011).
- Previous handoff read: docs/handoffs/STEP_005_COMPLETED.md. It records that `appConfig` is
  not a home for user facing text, that only the brand name is displayed from configuration,
  and that STEP 006 owns the copy still sitting in `app/layout.tsx` and `app/page.tsx`.
  STEP 002 and STEP 003 handoffs recorded the same follow-up.

### Feature list and master prompt requirements
- MASTER_PROMPT rule 1: "English only in code, UI, comments, seeds, templates, file names and
  content strings. All user facing strings live in lib/i18n/strings/en.ts."
- FEATURE_LIST section 1: English only in UI, code, comments, seeds, templates and content;
  every string in the catalog.
- FEATURE_LIST section 25: every public page is CMS editable later, so page copy must already
  be addressable by key rather than embedded in markup.
- FEATURE_LIST section 33: typecheck, lint and build must pass for the touched area.

### File ownership check (STEP_PLAN_250.md, File Ownership Rules)
- Owned here: `lib/i18n/` and the copy inside `app/layout.tsx` and `app/page.tsx`, which the
  earlier handoffs explicitly assigned to this STEP.
- Not owned here, therefore untouched:
  - Configuration values: STEP 005. The catalog holds copy, not business numbers.
  - Root layout shell, providers, theme switcher: STEP 010. This STEP only reads metadata and
    the language attribute from the catalog; it does not restructure the shell.
  - CMS storage and the blog: STEP 231-238. This STEP is the code side catalog only.
  - Email templates: STEP 221-230.
  - Error response format: STEP 008 (its messages will be keys into this catalog).
  - Structured logger: STEP 007. No copy is written into logs.
  - Every migration: STEP 012 and later.

### What exists today (measured)
- No `lib/i18n/` directory exists.
- English copy is embedded in two files: `app/layout.tsx` (metadata title and description) and
  `app/page.tsx` (eyebrow, summary, three facts, the structure gate sentence and the health
  link label). That is 11 distinct strings, one of which contains two numeric placeholders.

## 2. Design Decisions Taken Before Coding

1. English is the schema. `lib/i18n/strings/en.ts` exports the catalog as a `const` object, and
   `typeof en` is the contract every future locale must satisfy. There is no second hand
   written interface to drift from the source language.
2. Message paths are typed. A recursive `MessagePath` type is derived from the catalog, so
   `formatMessage("home.structureGate", ...)` is checked by the compiler and a typo is a build
   error instead of a blank line in the interface.
3. Two reading functions, not one. `getMessage` refuses a template that still contains a
   placeholder, and `formatMessage` requires exactly the parameters the template names: a
   missing parameter throws, and so does an unused one. A half rendered sentence is treated as
   a defect, not as acceptable output.
4. The catalog is deeply frozen and never mutated, and there is no locale switching logic in
   this STEP: `SUPPORTED_LOCALES` is `["en"]` and the platform is English only until a later
   STEP deliberately adds a language.
5. No barrel file. Consumers import `@/lib/i18n/messages` or `@/lib/i18n/strings/en`
   explicitly, matching the boundary rule established for configuration.
6. A gate defends the catalog as it grows: `npm run check:i18n` verifies that no message is
   empty or padded, that placeholders are well formed, that the locale metadata is `en` and
   `ltr`, and that no non English character slips into a content string. It runs inside
   `npm run verify`, so a stray translation or a blank label fails the pipeline instead of
   reaching a screen.

## 3. Why Five Sub-Steps

| Sub-step | Name | Proves |
| --- | --- | --- |
| 006.1 | Copy audit and key naming contract | Every existing string is inventoried and mapped to a key |
| 006.2 | Catalog module with typed contract | The catalog is the schema, frozen, with typed paths |
| 006.3 | Reading and interpolation layer | Path safety, parameter strictness, predictable rendering |
| 006.4 | Consumption and i18n gate | The two screens read only keys, and the gate defends the catalog |
| 006.5 | Verification, handoff and commit | Gates pass on Node 26, copy is unchanged for the user |

## 4. Sub-Step Detail

### Sub-step 006.1 - Copy audit and key naming contract
Deliverables:
- The inventory of the 11 strings with their current location, their new key and the reason
  for the grouping.
- The naming contract: dotted paths grouped by area (`locale`, `brand`, `home`), camelCase
  segments, one key per rendered sentence, no key containing markup.
Proof: the inventory table is reproduced in the handoff.
Exit criteria: no string remains outside the catalog in the two touched screens.

### Sub-step 006.2 - Catalog module with typed contract
Deliverables:
- `lib/i18n/strings/en.ts`: locale metadata (`code`, `name`, `direction`), brand name and
  description, and the home screen copy including the parameterised structure gate sentence.
- `TranslationCatalog` derived from the object, `DEFAULT_LOCALE` and `SUPPORTED_LOCALES`.
- Deep freeze through `lib/utils/freeze.ts`.
Proof: typecheck shows the derived literal types and no `any`.
Exit criteria: the catalog is immutable and its type is the contract.

### Sub-step 006.3 - Reading and interpolation layer
Deliverables:
- `lib/i18n/messages.ts`: `MessagePath`, `getMessage`, `formatMessage`, and the internal path
  reader that reports an unknown path or a non string leaf instead of returning `undefined`.
Proof: a wrong parameter set and an unknown path both throw with readable messages.
Exit criteria: a caller cannot render a partially substituted sentence.

### Sub-step 006.4 - Consumption and i18n gate
Deliverables:
- `app/layout.tsx` reads the title, the description, the language code and the text direction
  from the catalog.
- `app/page.tsx` reads the eyebrow, the summary, the three facts, the parameterised gate
  sentence and the health link label from the catalog, with the same visible result as before.
- `lib/i18n/verify.ts` and `npm run check:i18n`, wired into `npm run verify`.
Proof: the served page shows the same copy as before the change, and the gate rejects an empty
message, a malformed placeholder and a non English character.
Exit criteria: one source of copy and one gate that keeps it honest.

### Sub-step 006.5 - Verification, handoff and commit
Deliverables:
- `npm run verify` green on Node.js 26.13.0: structure gate, env gate, config gate, i18n gate,
  typecheck, lint and build.
- `docs/handoffs/STEP_006_COMPLETED.md` filled completely.
- One commit: "STEP 006: Add English string catalog structure lib/i18n/strings/en.ts", pushed
  to the session branch with the handoff in the same commit.
