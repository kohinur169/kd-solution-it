// path: components/README.md
# components/

Owner: STEP 001 creates the folder; each later STEP owns the components it introduces.

Shared React components. Server Components by default, "use client" only where state,
events or browser APIs are genuinely required.

Folders:

| Folder | Owner | Contents |
| --- | --- | --- |
| components/providers | STEP 010 | The client provider boundary and the theme store |
| components/ui | shared | Small presentational pieces built from semantic tokens |

Conventions:
- One component per file, named export, file name in kebab-case.
- User facing text comes from the string catalog, never from a literal inside a component.
- No component performs a database query directly; data arrives from a service or page.
- Money is rendered from a numeric(18,4) string through the shared money formatter, never
  through floating point arithmetic.
