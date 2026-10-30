// path: scripts/eslint-rules/README.md
# scripts/eslint-rules/

Owner: STEP 009. The two rules here are registered in `eslint.config.mjs` as `local/*` and
verified by `npm run check:lint`.

| Rule | Purpose |
| --- | --- |
| english-only-source | Refuses a character above printable ASCII that is not in the allowed typographic set |
| no-process-env | Refuses a direct `process.env` read outside the environment layer |

## Why local rules

Both rules describe this repository rather than JavaScript: the platform is English only, and the
environment is read through `lib/env/` only. An external plugin would bring a dependency and a
configuration surface for two checks with a fixed meaning here, so they are written as plain
ESLint rule objects in this folder.

## english-only-source

- Scans the whole file, so code, comments and string literals are covered.
- Allows en dash, em dash, curly quotes, ellipsis, bullet and middle dot, the same set the i18n
  gate allows inside a message.
- Reports each offending character with its code point and its exact position.
- Runs on every JavaScript and TypeScript file.

## no-process-env

- Reports `process.env` and `process["env"]`.
- Exemptions live in `eslint.config.mjs` as one visible list: `lib/env/**`, `instrumentation.ts`,
  `scripts/**` and the tool configuration files.
- A new module that reads the environment directly fails lint, so the exemption list cannot grow
  by accident.

## Adding a rule

1. Write the rule object in a new file here, with a `meta.docs.description` and one message.
2. Register it under `local` in `eslint.config.mjs` and set it to `error`.
3. Add its id to `requiredRules` in `scripts/verify-lint-rules.mjs`, and add a probe that must
   fail because of it.
4. Run `npm run check:lint` and `npm run lint`.
