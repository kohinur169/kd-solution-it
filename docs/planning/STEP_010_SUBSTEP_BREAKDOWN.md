// path: docs/planning/STEP_010_SUBSTEP_BREAKDOWN.md
# STEP 010 - Re-divided Into Five Sub-Steps

Owner instruction for this STEP: implement STEP 010, split it into five sub-steps first,
implement them one by one, keep the project production ready and keep Node.js 26.13.0 LTS as
the runtime that proves every gate.

## 1. Scope Confirmed From The Source Documents

### STEP 010 as written in docs/final/STEP_PLAN_250.md
- Number and title: STEP 010 - Add root layout shell with providers and theme tokens.
- Category: Foundation and Configuration (STEP 001-011).
- Previous handoff read: docs/handoffs/STEP_009_COMPLETED.md (lint matrix green, English-only
  guard active, so every new string in a component must come from the catalog).
- Handoffs that assign work to this STEP, read in full:
  - STEP 001: "Root layout shell, providers and theme tokens -> STEP 010 extends app/layout.tsx."
  - STEP 003: the theme runs on `color-scheme`; STEP 010 owns the switcher, the provider and the
    persisted choice; it must set `.light` or `.dark` on `<html>` so the whole tree switches; the
    body class list arrives with STEP 010.
  - STEP 006: the shell still owns its own structure; copy stays in the catalog.
  - STEP 008: `app/error.tsx` and `app/global-error.tsx` are this STEP's, and they render the
    error envelope's message, never a raw error.
  - STEP 002, 004, 005, 006: browser based visual checks at 360, 768 and 1440 in both themes
    were deferred to this STEP because no browser existed earlier.

### Feature list and master prompt requirements
- MASTER_PROMPT rule 1: English only, and every user facing string lives in
  `lib/i18n/strings/en.ts`. A theme switcher and an error screen are user facing.
- MASTER_PROMPT rule 5: structured logging only, no `console`.
- MASTER_PROMPT rule 17 and FEATURE_LIST section 28: Server Components by default, client
  JavaScript only where interaction requires it, light runtime.
- MASTER_PROMPT stack: nonce based CSP is a later STEP (STEP 059), which constrains how the
  pre-paint theme script may be written today.
- FEATURE_LIST section 29: no secret in a client bundle; the theme script touches
  `localStorage` only.
- FEATURE_LIST section 33: typecheck, lint and build must pass for the touched area.
- STEP 003 and `styles/README.md`: colour, radius, elevation and typography live only in
  `styles/tokens.css`; a component uses semantic names and never a palette step or a literal.

### What exists today (measured before coding)
- `app/layout.tsx` is still the STEP 001 shell: `metadata` and `viewport`, `<html lang dir>` and
  a bare `<body>{children}</body>`. No provider, no class list, no skip link.
- `styles/tokens.css` already defines `.light` and `.dark` (`color-scheme`), so the switch
  mechanism exists and is unused.
- `app/globals.css` sets the body colour from tokens and honours reduced motion.
- No `components/providers/`, no `components/ui/`, no client component anywhere in the
  repository, so the client JavaScript budget is currently zero.
- No `app/error.tsx` and no `app/global-error.tsx`: an unhandled render failure shows the Next.js
  default error page, which is not English-only catalog copy and does not use the tokens.
- The catalog has 25 messages and none for the shell or the error screens.

## 2. Design Decisions Taken Before Coding

1. **No new dependency.** Theme state is `useState` plus two effects and a `matchMedia`
   subscription. A theme library would add a client bundle to a foundation STEP whose whole point
   is a light shell.
2. **Three preferences, one default.** `system` is the default and follows the operating system;
   `light` and `dark` force a theme. Storing the OS preference as a fourth state would be a
   choice the user never made.
3. **The class goes on `<html>`, never on `<body>`.** `.light` and `.dark` set `color-scheme`, and
   `color-scheme` on the root element is what makes every `light-dark()` token resolve, including
   in form controls and scrollbars. `style.colorScheme` is kept in step so native widgets follow.
4. **A tiny pre-paint script, because a flash is a defect.** The class is applied by an inline
   script in `<head>` before the first paint, reading the stored preference. It is wrapped in
   `try`/`catch` so a blocked `localStorage` cannot break the document.
5. **One source for the storage key and the allowed values.** The key, the three preference values
   and the parser live in one module. The script text is generated from them, so the script and
   the provider cannot disagree about what "dark" means or where it is stored.
6. **The provider fails fast.** `useTheme` throws when used outside the provider instead of
   silently returning a default that never updates.
7. **Server output is stable.** The server renders the `system` state; the class is added by the
   script; `<html>` carries `suppressHydrationWarning` for that one attribute. The toggle reads
   the resolved theme only after mount, so hydration matches the server markup.
8. **Cross-tab and system changes are honoured.** A `storage` event applies a preference changed
   in another tab, and a `matchMedia` listener repaints when the operating system flips while the
   preference is `system`.
9. **The shell is small on purpose.** A skip link, a slim header with the brand and the theme
   switcher, and a focusable content wrapper. No navigation to routes that do not exist yet:
   public pages arrive in STEP 231-238 and dashboards in STEP 068-079.
10. **The skip link targets a wrapper, not a second `<main>`.** `app/page.tsx` already renders
    `<main>`; the layout wraps `children` in `<div id="main-content" tabIndex={-1}>`, so the
    document keeps exactly one main landmark.
11. **Two error screens, from the same catalog copy.** `app/error.tsx` handles a failure inside a
    segment and offers a retry; `app/global-error.tsx` replaces the root layout when the layout
    itself fails, so it owns its own `<html>` and `<body>` and cannot use the shell. Both show
    the reference the router provides, never the raw message, which is the STEP 008 rule applied
    to a screen.
12. **Copy goes into the STEP 006 catalog.** Two small groups, `shell` and `errorScreen`, are
    added for the switcher labels, the skip link and the error screen. Rule 1 leaves no
    alternative: a literal string in a component is a defect.
13. **No new token.** The shell uses the semantic set that STEP 003 already publishes
    (`bg-surface`, `text-muted-foreground`, `border-border`, `rounded-pill`, `shadow-card`, the
    focus ring). A new visual need starts in `styles/tokens.css`, not in a component.
14. **Token discipline is gated.** `npm run check:shell` refuses a colour literal and a
    palette-step utility under `app/` and `components/`, and refuses a shell that lost the skip
    link, the theme script or the catalog driven document attributes. The rule from STEP 003 is
    now a check instead of a review habit.
15. **CSP is a known follow-up.** The inline script needs the nonce that STEP 059 introduces. The
    script is one small function on purpose, so adding the attribute later is a one line change
    in `app/layout.tsx`.

## 3. Why Five Sub-Steps

| Sub-step | Concern | Wrong without it |
| --- | --- | --- |
| 010.1 | Contract and inventory | A shell with a flash, or a theme that only half the tree follows |
| 010.2 | Theme core, provider and catalog copy | A stored preference that the next page ignores, or copy in a component |
| 010.3 | Shell layout and switcher | No skip link, a broken landmark structure, a toggle that cannot be operated by keyboard |
| 010.4 | Error screens | A failure shows the framework page instead of the platform's own copy |
| 010.5 | Gate, documentation and proof | Colour creeping out of the token file, and no evidence the switch works |

## 4. The Five Sub-Steps

### 010.1 - Contract, inventory and ownership notes
- Read the FEATURE_LIST, the MASTER_PROMPT rules and the handoffs that assign work here (done
  above).
- Inventory: minimal layout, unused `.light`/`.dark`, no client component, no error screens, no
  shell copy.
- Fix the contract: preferences and storage key, where the class is applied, script and provider
  split, shell structure, error screen behaviour, catalog additions, gate rules.
- Deliverable: this document.

### 010.2 - Theme core, provider and catalog copy
- `components/providers/theme.ts`: `THEME_STORAGE_KEY`, `THEME_PREFERENCES`, the parser, the
  resolved theme type and the pre-paint script text built from those constants.
- `components/providers/theme-provider.tsx`: the client provider, the context, `useTheme`, the
  class application, the storage and `matchMedia` subscriptions.
- `lib/i18n/strings/en.ts`: `shell` and `errorScreen` groups.
- Proof: the provider and the script agree on the key and the values (gate), and the catalog gate
  resolves every new key.

### 010.3 - Shell layout and switcher
- `components/providers/app-providers.tsx`: the client boundary the layout mounts once.
- `components/ui/theme-toggle.tsx`: a keyboard operable three-state control built from the
  catalog labels, with `aria-pressed` and the shared focus ring.
- `app/layout.tsx`: document attributes from the catalog, the pre-paint script in `<head>`, the
  body class list, the skip link, the header with the brand and the switcher, the focusable
  content wrapper, and `suppressHydrationWarning` on `<html>`.
- Proof: the served HTML contains the script, the skip link, the header and three buttons whose
  labels come from the catalog.

### 010.4 - Error screens
- `app/error.tsx`: the segment boundary, catalog copy, the retry button and the reference.
- `app/global-error.tsx`: the root boundary, its own `<html>` and `<body>`, the same copy and the
  same tokens.
- Proof: a temporary page that throws renders the segment screen in the served HTML; the root
  boundary is exercised with a temporary header-triggered failure in the layout; both are then
  reverted.

### 010.5 - Shell gate, documentation and handoff
- `scripts/verify-shell.mjs`: `npm run check:shell`, added to `npm run verify`. It refuses a
  colour literal or palette-step utility outside the token file, and refuses a layout that lost
  the skip link, the theme script, the catalog driven attributes or the error screens.
- Documentation: a README section, plus the components folder notes.
- Finish with `npm run verify`, the runtime checks at three widths and both themes by inspection
  of the served markup and the emitted CSS, then one commit, push and the completed handoff.

## 5. Files This STEP Owns

| File | Status |
| --- | --- |
| components/providers/theme.ts | created in 010.2 |
| components/providers/theme-provider.tsx | created in 010.2 |
| components/providers/app-providers.tsx | created in 010.3 |
| components/ui/theme-toggle.tsx | created in 010.3 |
| components/README.md | modified in 010.5 |
| app/layout.tsx | rewritten in 010.3 |
| app/error.tsx | created in 010.4 |
| app/global-error.tsx | created in 010.4 |
| lib/i18n/strings/en.ts (the `shell` and `errorScreen` groups only) | modified in 010.2 |
| scripts/verify-shell.mjs | created in 010.5 |
| package.json (the `check:shell` script and the verify chain) | modified in 010.5 |
| README.md (shell and theming section) | modified in 010.5 |
| docs/planning/STEP_010_SUBSTEP_BREAKDOWN.md | this document |
| docs/handoffs/STEP_010_COMPLETED.md | created in 010.5 |

Not owned here, therefore untouched: `styles/tokens.css` and `app/globals.css` (STEP 003, used as
they are), the environment contract (STEP 004), configuration values (STEP 005), the rest of the
string catalog and the page body (STEP 006), the logger (STEP 007), the error envelope and code
catalog (STEP 008), the lint matrix (STEP 009), the job foundation (STEP 011), every migration
(STEP 012 and later), the public navigation and footer (STEP 231-238) and the CSP nonce
(STEP 059).
