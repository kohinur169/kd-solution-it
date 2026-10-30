// path: docs/handoffs/STEP_006_COMPLETED.md
# STEP 006 Completed - Handoff

## STEP
- Number and title: STEP 006 - Add English string catalog structure lib/i18n/strings/en.ts
- Category: Foundation and Configuration (STEP 001-011)
- Depends on (earlier STEPs in this category and their handoff files): STEP 001 (structure
  gate), STEP 002 (strict TypeScript, `@/` alias, Node.js 26.13.0 LTS), STEP 003 (tokens, so
  the copy moved here is unchanged visually), STEP 004 (environment contract), STEP 005
  (`appConfig`, which owns values, leaving wording to this STEP) and `lib/utils/freeze.ts`.
  The handoffs of STEP 002, 003 and 005 all recorded that the copy in `app/layout.tsx` and
  `app/page.tsx` belongs to this STEP.
- Re-divided into five sub-steps before implementation. Analysis and definitions:
  docs/planning/STEP_006_SUBSTEP_BREAKDOWN.md. All five completed in this session:
  006.1 copy audit and key naming contract, 006.2 catalog module with typed contract,
  006.3 reading and interpolation layer, 006.4 consumption and i18n gate,
  006.5 verification, handoff and commit.

## Files
- Created:
  - lib/i18n/strings/en.ts - the English catalog with locale metadata, brand copy and home
    screen copy (`TranslationCatalog` derived from it).
  - lib/i18n/messages.ts - `getMessage`, `formatMessage`, the recursive `MessagePath` type,
    `DEFAULT_LOCALE`, `SUPPORTED_LOCALES`.
  - lib/i18n/verify.ts - the catalog gate behind `npm run check:i18n`.
  - lib/i18n/README.md - owner, rules, how to add a string, how to add a language later.
  - docs/planning/STEP_006_SUBSTEP_BREAKDOWN.md, docs/handoffs/STEP_006_COMPLETED.md.
- Modified:
  - app/layout.tsx - metadata title and description, plus `lang` and `dir` on the document
    element, now read from the catalog. The shell itself is untouched; STEP 010 still owns it.
  - app/page.tsx - all six visible strings and the parameterised gate sentence read from the
    catalog. Markup, classes and structure are unchanged.
  - package.json - `check:i18n` script added; `verify` now runs the i18n gate after the config
    gate.
  - README.md - new "Strings and language" section.
- Owned paths touched (must match the File Ownership Rules in STEP_PLAN_250.md): `lib/i18n/`
  and the two screens that held literal copy, which the earlier handoffs assigned here. Not
  touched: configuration values (STEP 005), the root layout shell, providers and the theme
  switcher (STEP 010), the error response format (STEP 008), the logger (STEP 007), the CMS
  storage (STEP 231-238), email templates (STEP 221-230) and every migration (STEP 012+).

## Database
- Migrations added (file names): none.
- Rollback verified on clean database (yes/no, how): not applicable, no migration.

## Environment
- Environment variables added to .env.example: none. The environment gate still reports the
  same 16 variables.
- Secrets handled (names only, never values): none. The catalog holds copy only and is safe in
  a client bundle by construction.

## Packages
- Package requests for the integrator (name, reason), or none: none. The reader is plain
  TypeScript with no dependency; the gate runs on Node.js 26 native TypeScript.

## Copy inventory (old location, new key)
| String | Old location | New key |
| --- | --- | --- |
| KD Solution IT | app/layout.tsx metadata title, app/page.tsx h1 | brand.name |
| Enterprise multi-tenant payment facilitator platform ... | app/layout.tsx metadata description, app/page.tsx summary | brand.description |
| en (language tag) | hardcoded `lang="en"` | locale.code |
| ltr (writing direction) | not present before | locale.direction |
| English | not present before (needed by a future language picker) | locale.name |
| Foundation | app/page.tsx eyebrow | home.eyebrow |
| Amounts are held in USD only ... | app/page.tsx fact 1 | home.facts.currency |
| Every tenant record is isolated ... | app/page.tsx fact 2 | home.facts.isolation |
| Files are encrypted with AES-256-GCM ... | app/page.tsx fact 3 | home.facts.storage |
| The structure gate enforces {directories} ... | app/page.tsx sentence with two interpolated counts | home.structureGate |
| Service health | app/page.tsx link label | home.healthLink |

## Behaviour Proof (acceptance checklist)
- Behaviours named in the STEP title, exercised manually on Node.js 26.13.0.
  1. The catalog is the only source of copy. A scan of the two screens for sentence literals
     returns nothing; every quoted string left in `app/page.tsx` is an import path, a class
     list or a message key (`"/api/health"`, `"brand.description"`, `"home.structureGate"`, the
     Tailwind class strings, `"next/link"`, `"react"`).
  2. The visible result is unchanged. The served page reports
     `<html lang="en" dir="ltr">` (the direction attribute is new and deliberate),
     `<title>KD Solution IT</title>`, the eyebrow `Foundation`, the three facts, the sentence
     `The structure gate enforces 16 canonical directories and 13 root files on every
     verification run.` produced by `formatMessage`, and the link label `Service health`.
  3. A misspelled key is a compile error. Changing `home.healthLink` to `home.healthlink`
     produces `error TS2345: Argument of type '"home.healthlink"' is not assignable to
     parameter of type 'MessagePath'`. Restored afterwards.
  4. Parameters are strict, verified by calling the reader directly:
     - missing parameter: `Message "home.structureGate" is missing parameters: rootFiles.`
     - unused parameter: `Message "home.structureGate" received unused parameters: extra.`
     - placeholder read through `getMessage`:
       `Message "home.structureGate" needs parameters; use formatMessage instead of
       getMessage.`
     - unknown path: `Unknown message path: "home.nope".`
     - correct call: `The structure gate enforces 16 canonical directories and 13 root files
       on every verification run.`
  5. The gate defends the catalog, each case exercised and reverted:
     - empty message: `home.healthLink must not be empty`;
     - a Bengali string pasted in: `home.healthLink contains a non English character
       (U+09B8)` and 12 further code points, exit 1;
     - malformed placeholder: `home.structureGate contains a malformed placeholder`;
     - restored: `i18n gate passed: 11 messages, 2 placeholders, 1 locale (en, ltr)`.
  6. Frozen catalog: the object is produced through `deepFreeze` from `lib/utils/freeze.ts`, so
     a later mutation attempt throws in strict mode instead of silently changing copy at
     runtime.
- UI checks (desktop, mobile, keyboard, light and dark) where applicable: this STEP changes no
  markup, no class and no token, so the responsive and focus behaviour recorded in STEP 003 is
  unchanged; the only rendered difference is the added `dir="ltr"` attribute on the document
  element. Browser based visual confirmation at 360px, 768px and 1440px in both themes is still
  pending and owned by STEP 010, as recorded in STEP 003.
- API checks (success, validation failure, unauthorized, cross-tenant) where applicable: no
  route was added or changed; `/` and `/api/health` behave as before. Those four cases still
  begin at STEP 011.
- Money flow ledger proof (balanced debit and credit) where applicable: not applicable, this
  STEP moves no money.
- Provider sandbox cycle and documentation URLs where applicable: not applicable, no provider
  is called.

## Verification
- Typecheck result: pass, `npm run typecheck` exits 0. The generated `MessagePath` union is
  what makes a wrong key a build error.
- Lint result: pass, `npm run lint` exits 0.
- Build result for the touched area: pass. `npm run build` on Node.js 26.13.0 emits the route
  table `○ /`, `○ /_not-found`, `ƒ /api/health`; the production server rendered the copy above.
- `npm run verify` now runs five gates and exits 0:
  `structure gate passed: 16 directories, 13 root files, 33 source files checked`,
  `check:env passed: .env.example matches 16 manifest variables`,
  `config gate passed: 9 sections, 22 values (5 money entries, all strings), no credential
  shaped key`,
  `i18n gate passed: 11 messages, 2 placeholders, 1 locale (en, ltr)`, then typecheck, lint and
  build.
- Runtime: Node.js 26.13.0, npm 10.9.8, engine-strict. tsconfig.json was not rewritten.

## Next
- Next STEP number: STEP 007 - Add structured logger with request context and redaction. Not
  started. This chat ends here as the owner asked, and STEP 007 needs the owner's consent.
- Anything the next chat must know:
  1. Every user facing string is a key in `lib/i18n/strings/en.ts`. A component that contains a
     sentence is a defect, and `npm run check:i18n` will not catch it - only review will, so
     the rule has to be applied while writing.
  2. Use `getMessage` for a fixed label and `formatMessage` for a parameterised sentence.
     Never build a sentence by concatenating two keys: word order differs between languages,
     so the whole sentence is one key with placeholders.
  3. Values are not copy. Amounts, days, limits and timeouts come from `config/app.ts` and are
     passed in as parameters. Dates and money are formatted by their own layer before they
     reach a message.
  4. `messages.ts` exports `DEFAULT_LOCALE` and `SUPPORTED_LOCALES` (`["en"]`). No locale
     switching exists yet; the reader takes a catalog argument, which is where a second
     language will plug in.
  5. The `MessagePath` type is recursive from the catalog, so a new group needs no change in
     `messages.ts`. If the catalog ever grows to thousands of keys and the compiler slows down,
     that type is the first place to revisit.
  6. Copy that a merchant edits at runtime (CMS pages, email templates, policy pages) is
     database content owned by STEP 221-238, not a key in this catalog. This catalog holds the
     application's own interface copy.
  7. The logger in STEP 007 must not log catalog copy into structured fields, and it must
     redact secrets. `lib/env/server.ts` and `config/server.ts` hold the values it must never
     print.
  8. Still open for their owners: logger (007), error format (008), lint matrix (009), root
     layout shell and providers (010), job foundation (011), migrations (012+).
