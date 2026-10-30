// path: docs/handoffs/STEP_010_COMPLETED.md
# STEP 010 Completed - Handoff

## STEP
- Number and title: STEP 010 - Add root layout shell with providers and theme tokens
- Category: Foundation and Configuration (STEP 001-011)
- Depends on (earlier STEPs in this category and their handoff files): STEP 001 (which created
  the layout shell and assigned its providers here), STEP 002 (strict TypeScript and the `@/`
  alias), STEP 003 (tokens, `light-dark()` semantics and the `.light`/`.dark` hooks that this
  STEP now drives), STEP 004 (the environment contract, untouched), STEP 006 (the string catalog,
  which supplies every word on the new surfaces), STEP 008 (`app/error.tsx` and
  `app/global-error.tsx` were assigned here, and their copy follows the error rules) and STEP 009
  (the lint matrix, which decided how these client components had to be written).

## Files
- Created:
  - components/providers/theme.ts - the storage key, the three preferences, the parser, the class
    application, the external store functions and the pre-paint script text.
  - components/providers/theme-provider.tsx - the client provider, its context, `useTheme` and the
    document effect.
  - components/providers/app-providers.tsx - the single client boundary the layout mounts.
  - components/ui/theme-toggle.tsx - the three-state keyboard operable switcher.
  - components/ui/error-panel.tsx - the shared error screen body.
  - app/error.tsx and app/global-error.tsx - the segment and root error screens.
  - scripts/verify-shell.mjs - the gate behind `npm run check:shell`.
  - docs/planning/STEP_010_SUBSTEP_BREAKDOWN.md, docs/handoffs/STEP_010_COMPLETED.md.
- Modified:
  - app/layout.tsx - document attributes from the catalog, the pre-paint theme script,
    `suppressHydrationWarning`, the body class list, the skip link, the header with the brand and
    the switcher, the focusable content wrapper and the provider boundary.
  - lib/i18n/strings/en.ts - a `shell` group (6 messages) and an `errorScreen` group (5 messages);
    the catalog is now 36 messages. This is the copy STEP 006's rule 1 requires on a new surface.
  - components/README.md - the provider and ui folders, and what each owns.
  - package.json - `check:shell` added; `verify` now runs the shell gate after the lint gate.
  - README.md - an "Application shell and theming" section and the commands table.
- Owned paths touched (must match the File Ownership Rules in STEP_PLAN_250.md): the root layout,
  the two error screens, `components/providers/`, `components/ui/`, the two catalog groups, the
  shell gate, the script line and the README. Not touched: `styles/tokens.css` and
  `app/globals.css` (STEP 003, consumed as they are), the environment contract (004),
  configuration values (005), the page body and the rest of the catalog (006), the logger (007),
  the error envelope and codes (008), the lint matrix (009), the job foundation (011), every
  migration (012+) and the CSP nonce (059).

## Database
- Migrations added (file names): none.
- Rollback verified on clean database (yes/no, how): not applicable, no migration.

## Environment
- Environment variables added to .env.example: none. The theme preference is a browser
  preference, deliberately not an environment concern: a server setting must not decide what a
  merchant's device shows.
- Secrets handled (names only, never values): none. The gate additionally proves that a client
  component cannot import `lib/env/server`, `lib/env/boot`, `config/server` or the logger, and
  that no client file reads `process.env`.

## Packages
- Package requests for the integrator (name, reason), or none: none. The theme provider is plain
  React (`useSyncExternalStore`), and every other import already existed.

## Behaviour Proof (acceptance checklist)
- Behaviours named in the STEP title, exercised manually on Node.js 26.13.0.

  **1. The served document.** A production build served by `next start` returned
  `<html lang="en" dir="ltr">` (the language and direction come from the catalog; the
  `suppressHydrationWarning` hint is React only and correctly absent from the HTML) and
  `<body class="min-h-dvh bg-background text-foreground antialiased">`.

  **2. The pre-paint script is in the document.** The served `<head>` contains
  `<script>(function(){try{var key="kd-solution-it.theme";var stored=window.localStorage.getItem(key);if(stored==="light"||stored==="dark"){var root=document.documentElement;root.classList.remove("light","dark");root.classList.add(stored);root.style.colorScheme=stored;}}catch(error){void error;}})();</script>`.
  It is 300 characters, reads the same key the provider writes and fails silently.

  **3. The script actually switches the theme.** The exact script text from the served HTML was
  executed in a sandbox with a stub document, once per stored value:
  - `dark` -> `classes=dark` and `colorScheme=dark`;
  - `light` -> `classes=light` and `colorScheme=light`;
  - nothing stored -> no class, no inline scheme (the stylesheet's `light dark` applies);
  - `system` -> no class;
  - a `localStorage` that throws -> no class, no exception.
  That is the no-flash path proven without a browser.

  **4. The provider logic.** `applyThemeClass` and the store were executed directly:
  `apply dark` -> `classes=dark colorScheme=dark`; `apply light` -> `classes=light
  colorScheme=light`; `apply system` (with a stale `dark` class present) -> `classes=` and
  `colorScheme` unset; `parseThemePreference("dark")` -> `dark`; `parseThemePreference("bogus")`
  -> `system`; `isThemePreference("system")` -> true; `isThemePreference(42)` -> false;
  `writeStoredPreference("dark")` -> stored `dark` and its listener notified once;
  `writeStoredPreference("system")` -> stored `system`, notified twice; after unsubscribe the
  listener is not called again.

  **5. The shell markup.** The served home page contains the skip link
  `<a href="#main-content" ...>Skip to content</a>`, the header with
  `<a aria-label="Go to the home page" href="/">KD Solution IT</a>`, the switcher
  `<div role="group" aria-label="Theme">` holding three `<button type="button">` elements with
  `aria-pressed="true"` on `System` and `aria-pressed="false"` on `Light` and `Dark`, and the
  wrapper `<div id="main-content" tabindex="-1" class="flex flex-1 flex-col">`. Every label comes
  from the catalog.

  **6. Theming reaches the stylesheet.** The emitted CSS contains
  `.light{--lightningcss-light:initial;--lightningcss-dark: ;color-scheme:light}` and
  `.dark{--lightningcss-light: ;--lightningcss-dark:initial;color-scheme:dark}`, and the
  utilities resolve through the semantic variables: `.bg-background{background-color:var(--kd-background)}`.

  **7. The error screens.** The shared panel was rendered by the real app through a temporary
  probe page and the served HTML contained `role="alert"`, `Something went wrong`, the
  description, `Reference: req_probe_reference_0001`, `Try again` and `Back to the home page` -
  all catalog copy, no raw error text.
  A temporary page that threw inside a segment answered `500` with the framework's error shell
  (`<html id="__next_error__">`), the document title from the catalog, and **no** occurrence of
  the thrown message; a temporary root layout failure triggered by a request header likewise
  answered `500` with the framework shell and no message. In both cases the visible screen is
  the client boundary, which paints on hydration; its content is the panel proven above, and its
  files are in the build.
  What is proven without a browser, and what is not: the boundary markup is rendered by the
  component proven in item 7, but a click on `Try again` inside a real browser remains unproven
  here, because this environment has no browser (recorded since STEP 002).

  **8. The gate.** `npm run check:shell` reports
  `shell gate passed: 96 checks, 11 files scanned, no colour literal, no palette step, theme
  script and provider agree`. It refuses a colour literal, a palette step utility, a layout
  without the skip link, the pre-paint script, the catalog driven `lang`/`dir`, the focusable
  content wrapper or the provider boundary, a theme script that drifts from the shared storage
  key, an error screen that prints the raw message, a root boundary without its own document and
  stylesheet, a client component that reads `process.env` or imports a server only module, and a
  catalog that lost any shell or error screen key.

  **9. The gate fails closed.** Six deliberate regressions, each applied, run and reverted:
  - a colour literal (`bg-[#ff0000]`) -> exit 1 with
    `components/ui/theme-toggle.tsx contains a colour literal. Colour belongs in styles/tokens.css.`;
  - a palette step (`bg-blue-600`) -> exit 1 with `uses a palette step utility. Use a semantic
    token instead.`;
  - skip link removed -> exit 1 with `the shell must offer a skip link`;
  - pre-paint script removed -> exit 1 with `the theme script must be inlined before first paint`;
  - an error screen printing `error.message` -> exit 1 with `an error screen must not print the
    raw error message`;
  - the script's key changed to a literal -> exit 1 with `the pre-paint script must use the shared
    storage key`.
  Restoring each mutation returns the green line in item 8.

  **10. The client bundle stays clean.** The theme store and the three labels are present in a
  client chunk, and no client chunk contains `ENCRYPTION_MASTER_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY` or `AUDIT_SIGNING_KEY` (0 files). The client chunks total 640 KB,
  which is the framework runtime plus this small shell.

- UI checks (desktop, mobile, keyboard, light and dark) where applicable: the responsive classes
  are in place (`px-4 sm:px-6`, `max-w-6xl`, a wrap friendly action row, `text-sm` labels) and were
  reviewed at the 360, 768 and 1440 breakpoints in the markup, the shell has one Tab stop per
  control with the global `:focus-visible` ring and a skip link, and both themes are reachable by
  the switcher and by the operating system preference. A rendered screenshot at those widths and
  a click through the switcher in a browser remain **pending**, because no browser is available
  in this environment; this is the same limitation STEP 002, 003, 004, 005 and 006 recorded, and
  it is now the only open item on this STEP.
- API checks (success, validation failure, unauthorized, cross-tenant) where applicable: not
  applicable, no route changed. `/api/health` still answers as recorded in STEP 008.
- Money flow ledger proof (balanced debit and credit) where applicable: not applicable, this STEP
  moves no money.
- Provider sandbox cycle and documentation URLs where applicable: not applicable, no provider is
  called.

## Verification
- Typecheck result: pass, `npm run typecheck` exits 0 under `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes` and `verbatimModuleSyntax`.
- Lint result: pass, `npm run lint` exits 0 with the type-aware matrix from STEP 009, including
  `react-hooks` rules for effects and the no-raw-anchor rule for internal links.
- Build result for the touched area: pass on Node.js 26.13.0. The route table is `○ /`,
  `○ /_not-found`, `ƒ /api/health`; the production server served the shell described above.
- `npm run verify` now runs nine gates plus typecheck, lint and build, and exits 0 in about 19
  seconds:
  `structure gate passed: 16 directories, 13 root files, 58 source files checked`,
  `check:env passed: .env.example matches 16 manifest variables`,
  `config gate passed: 9 sections, 22 values (5 money entries, all strings), no credential shaped
  key`,
  `i18n gate passed: 36 messages, 2 placeholders, 1 locale (en, ltr)`,
  `logger gate passed: 117 checks, 15 records parsed, 4 levels, 9 secret fragments absent`,
  `error gate passed: 196 checks, 14 codes, all statuses in 4xx or 5xx, no secret or stack in any
  envelope`,
  `lint gate passed: 77 checks, 26 rules enforced as errors, 11 failure probes fired, 1 clean
  probe stayed clean`,
  `shell gate passed: 96 checks, 11 files scanned, no colour literal, no palette step, theme
  script and provider agree`, then build.
- Runtime: Node.js 26.13.0, npm 10.9.8, engine-strict. No dependency change.

## Next
- Next STEP number: STEP 011 - Background job queue, worker and scheduler foundation with health
  check route. Not started. This chat ends here as the owner asked, and STEP 011 needs the
  owner's consent.
- Anything the next chat must know:
  1. The shell is the document and the header only. A page renders its own `<main>`; the layout
     wraps it in `<div id="main-content">`, which is the skip link target. Do not add a second
     `<main>` in the layout.
  2. Theme state lives in `components/providers/theme.ts` (key and values) and
     `theme-provider.tsx` (React). Never read `localStorage` in a component; call `useTheme()`.
     The pre-paint script must stay in step with the store, and `check:shell` enforces that.
  3. `npm run check:shell` refuses colour literals and palette steps under `app/` and
     `components/`. A new visual need starts as a semantic token in `styles/tokens.css`.
  4. Any new user facing word goes into `lib/i18n/strings/en.ts`; the shell and the error screens
     are catalog driven, and `check:shell` fails if a required key disappears.
  5. The two error screens are client components by design. They must never print
     `error.message`; the reference is the framework digest, and the cause is in the structured
     log (STEP 007) and the error envelope (STEP 008).
  6. The inline theme script needs the CSP nonce that STEP 059 introduces. That STEP adds the
     `nonce` attribute in `app/layout.tsx`; the script text does not change.
  7. `AppProviders` is the single client boundary. A new provider (toast host, query client,
     session) is added there, not in `app/layout.tsx`, and must not import a server only module.
  8. The visual check at 360, 768 and 1440 in both themes is still pending because no browser
     exists here. Whoever has a browser should confirm it and record it; nothing else on this
     STEP is open.
  9. Still open for their owners: the job foundation (011), migrations (012+), public navigation
     and footer (231-238) and the CSP nonce (059).
