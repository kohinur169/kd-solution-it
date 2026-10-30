// path: styles/README.md
# styles/

Owner: STEP 003 (Tailwind configuration and central design tokens).

| File | Purpose |
| --- | --- |
| tokens.css | The single owner of colour, radius, elevation, typography and easing |

Rules for this folder and for every consumer:
- A component uses a semantic token name: `bg-surface`, `text-muted-foreground`,
  `border-border`, `rounded-card`, `shadow-card`. Never a palette step such as
  `bg-blue-600` and never a colour literal.
- Primitives in tokens.css are private to that file. Only the semantic layer is exposed to
  Tailwind, through `@theme inline`.
- The active theme comes from `color-scheme`. `:root` follows the operating system, and a
  `.light` or `.dark` class on an ancestor forces a theme. The switcher itself belongs to
  the application shell, not to this folder.
- New tokens are added here first and then used. A token with no consumer is a decision
  that has not been made yet.
