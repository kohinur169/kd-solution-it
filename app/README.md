// path: app/README.md
# app/

Next.js App Router tree. Server Components are the default; a file becomes a client
component only when it carries the "use client" directive for real interaction.

| Folder | Owner | Contents |
| --- | --- | --- |
| app/(public) | STEP 231-238 | Public website, CMS, blog, legal pages |
| app/(auth) | STEP 037-055 | Signup, login, two factor, password and lock screens |
| app/(dashboard) | STEP 079-126 | Merchant owner area |
| app/(admin) | STEP 068-078 | Office dashboards and platform settings |
| app/office | STEP 044 | Office queue for two factor reset requests |
| app/(client-portal) | STEP 181-190 | Tokenized client links i/[token] and e/[token] |
| app/api | per route | Route handlers, validated and rate limited |

Rules for this folder:
- Every page exports metadata built from the string catalog in lib/i18n/strings/en.ts.
- No handler reads a secret directly; configuration arrives through the validated
  environment schema.
- Lists are paginated and select only the columns the screen uses.
