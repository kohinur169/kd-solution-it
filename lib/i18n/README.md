// path: lib/i18n/README.md
# lib/i18n/

Owner: STEP 006 (English string catalog). Later STEPs add keys; the structure and the rules
below stay.

| File | Purpose |
| --- | --- |
| strings/en.ts | The English catalog: every user facing string, frozen, with the locale metadata |
| messages.ts | `getMessage`, `formatMessage`, the typed `MessagePath`, `DEFAULT_LOCALE` and `SUPPORTED_LOCALES` |
| verify.ts | The catalog gate behind `npm run check:i18n`, also part of `npm run verify` |

## Rules

1. English is the schema. `TranslationCatalog` is derived from `lib/i18n/strings/en.ts`; a new
   locale must satisfy that shape before it can ship.
2. Copy never lives in a component, a layout, a route handler or a configuration file. A screen
   reads a key.
3. There is no barrel file. Import `@/lib/i18n/messages` for the reader and
   `@/lib/i18n/strings/en` when a list of messages must be iterated.
4. Wording lives here, values do not. Amounts, limits and timeouts come from `config/app.ts`
   and are passed in as parameters; the catalog only decides how they are worded.
5. Placeholders are `{name}` with a camelCase identifier. `getMessage` refuses a template that
   still contains one, and `formatMessage` throws on a missing or an unused parameter.
6. Keys are grouped by area and named in camelCase: `home.structureGate`, `brand.name`. A key
   is one rendered sentence or label, never a fragment that needs another fragment to make
   sense.
7. No markup, no HTML entities and no formatting inside a message. Presentation belongs to the
   component; a highlight or a bold word is a component decision.
8. `npm run check:i18n` rejects an empty or padded message, repeated whitespace, a malformed
   placeholder, a locale code that disagrees with `SUPPORTED_LOCALES`, and any character
   outside English copy. The allowed typographic characters are listed in `verify.ts`; adding
   one is a deliberate edit.

## Adding a string

1. Add the key to `lib/i18n/strings/en.ts` with its wording.
2. Read it with `getMessage` or `formatMessage` where it is displayed.
3. Run `npm run verify`. The gate and the compiler catch an empty message, a misspelled key
   and a parameter mismatch before the change can reach a screen.

## Adding a language later

Create `lib/i18n/strings/<code>.ts` typed as `TranslationCatalog`, then extend
`SUPPORTED_LOCALES` and the reader. Nothing else in the application changes, because every
screen already asks for a key rather than a sentence.
